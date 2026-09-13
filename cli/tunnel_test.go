package kstunnel

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNormalizeSlug(t *testing.T) {
	cases := map[string]string{
		"/hello":       "hello",
		"///hello":      "hello",
		" Hello ":       "hello",
		"/HELLO":        "hello",
		"hi-there":      "hi-there",
		"!tunnel=hello": "hello",
		"/!tunnel=hello": "hello",
		"/!TUNNEL=Hello": "hello",
	}
	for in, want := range cases {
		if got := NormalizeSlug(in); got != want {
			t.Fatalf("NormalizeSlug(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIsValidSlug(t *testing.T) {
	for _, ok := range []string{"hello", "/hello", "hi-1", "ab", strings.Repeat("a", 32)} {
		if !IsValidSlug(ok) {
			t.Fatalf("IsValidSlug(%q) = false, want true", ok)
		}
	}
	for _, bad := range []string{"", "/", "a", "has space", "UPPER_OK?", "a/b", "toolong" + strings.Repeat("a", 30), "under_score"} {
		// note: UPPER becomes lower so "UPPER_OK?" fails on ? and _ — good
		if IsValidSlug(bad) {
			t.Fatalf("IsValidSlug(%q) = true, want false", bad)
		}
	}
}

func TestIsValidTarget(t *testing.T) {
	for _, ok := range []string{"127.0.0.1:4757", "localhost:3000", "http://127.0.0.1:4757", "https://app:80/path"} {
		if !IsValidTarget(ok) {
			t.Fatalf("IsValidTarget(%q) = false, want true", ok)
		}
	}
	for _, bad := range []string{"", "noport", "127.0.0.1", "127.0.0.1:abc", "has space:80", "host:port:extra"} {
		if IsValidTarget(bad) {
			t.Fatalf("IsValidTarget(%q) = true, want false", bad)
		}
	}
}

func TestTunnelWSURLShape(t *testing.T) {
	got, err := TunnelWSURLWithTarget("https://tunnel.kswarriorpro.workers.dev", "abcde", "hello", "127.0.0.1:4757")
	if err != nil {
		t.Fatalf("TunnelWSURL error: %v", err)
	}
	if !strings.HasPrefix(got, "wss://tunnel.kswarriorpro.workers.dev/api/tunnels/ws?") {
		t.Fatalf("TunnelWSURL = %q, want wss prefix", got)
	}
	for _, want := range []string{"host=abcde", "slug=hello", "target=127.0.0.1%3A4757"} {
		if !strings.Contains(got, want) {
			t.Fatalf("TunnelWSURL = %q, want it to contain %q", got, want)
		}
	}
}

func TestParseTunnelRequest(t *testing.T) {
	msg := `{"type":"tunnel-request","id":"r1","method":"GET","path":"/foo?x=1","headers":{"accept":"text/html"},"bodyBase64":"","slug":"hello"}`
	req, ok := ParseTunnelRequest(msg)
	if !ok {
		t.Fatalf("ParseTunnelRequest = not ok")
	}
	if req.ID != "r1" || req.Method != "GET" || req.Path != "/foo?x=1" || req.Slug != "hello" {
		t.Fatalf("ParseTunnelRequest = %+v, unexpected", req)
	}
	if _, ok := ParseTunnelRequest(`{"type":"presence","online":true}`); ok {
		t.Fatalf("presence must not parse as tunnel-request")
	}
	if _, ok := ParseTunnelRequest(`not json`); ok {
		t.Fatalf("garbage must not parse as tunnel-request")
	}
}

func TestFetchLocalProxiesStatusHeadersBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/hello-path" {
			w.Header().Set("content-type", "text/html; charset=utf-8")
			w.Header().Set("x-custom", "yes")
			w.WriteHeader(201)
			fmt.Fprint(w, "<h1>hello from local</h1>")
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	target := strings.TrimPrefix(srv.URL, "http://")
	status, headers, body, err := fetchLocal(target, "GET", "/hello-path", map[string]string{}, nil)
	if err != nil {
		t.Fatalf("fetchLocal error: %v", err)
	}
	if status != 201 {
		t.Fatalf("fetchLocal status = %d, want 201", status)
	}
	if !strings.Contains(string(body), "hello from local") {
		t.Fatalf("fetchLocal body = %q, want hello", body)
	}
	if headers["X-Custom"] != "yes" && headers["x-custom"] != "yes" {
		t.Fatalf("fetchLocal headers = %v, want x-custom", headers)
	}
}

// Data-plane encode path: proves cli -> workers bridging keeps local bytes.
func TestTunnelRoundtripOverWSS(t *testing.T) {
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/plain; charset=utf-8")
		fmt.Fprintf(w, "port-bytes for %s", r.URL.RequestURI())
	}))
	defer local.Close()
	localTarget := strings.TrimPrefix(local.URL, "http://")

	req := TunnelRequest{Type: "tunnel-request", ID: "r-e2e", Method: "GET", Path: "/hello", Headers: map[string]string{}, Slug: "hello"}
	var body []byte
	status, headers, respBody, err := fetchLocal(localTarget, req.Method, req.Path, req.Headers, body)
	if err != nil {
		t.Fatalf("fetchLocal: %v", err)
	}
	enc := base64.StdEncoding.EncodeToString(respBody)
	payload, _ := json.Marshal(TunnelResponse{Type: "tunnel-response", ID: req.ID, Status: status, Headers: headers, BodyBase64: enc})
	var decoded TunnelResponse
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("response roundtrip: %v", err)
	}
	raw, _ := base64.StdEncoding.DecodeString(decoded.BodyBase64)
	if decoded.Status != 200 || !strings.Contains(string(raw), "port-bytes for /hello") {
		t.Fatalf("roundtrip = (%d %q), want 200 + port bytes", decoded.Status, raw)
	}
}

func writeServerText(c net.Conn, payload string) {
	b := []byte(payload)
	if len(b) < 126 {
		c.Write([]byte{0x81, byte(len(b))})
	} else if len(b) < 65536 {
		c.Write([]byte{0x81, 126, byte(len(b) >> 8), byte(len(b))})
	} else {
		n := len(b)
		c.Write([]byte{0x81, 127, 0, 0, 0, 0, byte(n >> 24), byte(n >> 16), byte(n >> 8), byte(n)})
	}
	c.Write(b)
}

func readClientFrame(r *bufio.Reader) (string, byte, error) {
	hdr := make([]byte, 2)
	if _, err := io.ReadFull(r, hdr); err != nil {
		return "", 0, err
	}
	opcode := hdr[0] & 0x0F
	length := int64(hdr[1] & 0x7F)
	if length == 126 {
		ext := make([]byte, 2)
		if _, err := io.ReadFull(r, ext); err != nil {
			return "", 0, err
		}
		length = int64(ext[0])<<8 | int64(ext[1])
	} else if length == 127 {
		ext := make([]byte, 8)
		if _, err := io.ReadFull(r, ext); err != nil {
			return "", 0, err
		}
		length = 0
		for _, b := range ext {
			length = length<<8 | int64(b)
		}
	}
	masked := hdr[1]&0x80 != 0
	var mask []byte
	if masked {
		mask = make([]byte, 4)
		if _, err := io.ReadFull(r, mask); err != nil {
			return "", 0, err
		}
	}
	payloadBytes := make([]byte, length)
	if _, err := io.ReadFull(r, payloadBytes); err != nil {
		return "", 0, err
	}
	if masked {
		for i := range payloadBytes {
			payloadBytes[i] ^= mask[i%4]
		}
	}
	return string(payloadBytes), opcode, nil
}

// RunTunnel end-to-end against a fake Worker that speaks the real WS framing.
func TestRunTunnelServesLocalPort(t *testing.T) {
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/html; charset=utf-8")
		fmt.Fprint(w, "<h1>served from local :PORT</h1>")
	}))
	defer local.Close()
	localTarget := strings.TrimPrefix(local.URL, "http://")

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	workerBase := "http://" + ln.Addr().String()

	respCh := make(chan TunnelResponse, 1)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			br := bufio.NewReader(conn)
			reqLine, err := br.ReadString('\n')
			if err != nil {
				conn.Close()
				continue
			}
			// RegisterTunnel POST /api/tunnels -> answer 200 and keep listening
			// for the real tunnel-wss GET.
			if strings.HasPrefix(reqLine, "POST ") {
				for {
					line, err := br.ReadString('\n')
					if err != nil || strings.TrimSpace(line) == "" {
						break
					}
				}
				body := `{"slug":"hello","host":"abcde","target":"x","name":"hello","tunnelType":"HTTP"}`
				fmt.Fprintf(conn, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", len(body), body)
				conn.Close()
				continue
			}
			// Tunnel-wss GET -> WS handshake + one visitor request.
			go func(c net.Conn, r *bufio.Reader) {
				defer c.Close()
				var key string
				for {
					line, err := r.ReadString('\n')
					if err != nil {
						return
					}
					trimmed := strings.TrimSpace(line)
					if strings.HasPrefix(strings.ToLower(trimmed), "sec-websocket-key:") {
						key = strings.TrimSpace(trimmed[len("sec-websocket-key:"):])
					}
					if trimmed == "" {
						break
					}
				}
				accept := base64.StdEncoding.EncodeToString(sha1Sum(key + wsGUID))
				fmt.Fprintf(c, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", accept)
				// Ask the CLI for /hello like a visitor would.
				payload := `{"type":"tunnel-request","id":"visit-1","method":"GET","path":"/","headers":{"accept":"text/html"},"bodyBase64":"","slug":"hello"}`
				writeServerText(c, payload)
				// Read masked client frames until the tunnel-response arrives
				// (the CLI's immediate {"type":"ping"} hello must be skipped).
				c.SetReadDeadline(time.Now().Add(10 * time.Second))
				for {
					msg, opcode, err := readClientFrame(r)
					if err != nil {
						return
					}
					if opcode == 0x8 {
						return
					}
					if opcode == 0x9 {
						// ping -> pong (unmasked server->client)
						c.Write([]byte{0x8A, 0x00})
						continue
					}
					var tr TunnelResponse
					if err := json.Unmarshal([]byte(msg), &tr); err != nil {
						continue
					}
					if tr.Type != "tunnel-response" || tr.ID == "" {
						continue // ping/presence noise
					}
					respCh <- tr
					break
				}
				time.Sleep(500 * time.Millisecond)
			}(conn, br)
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- RunTunnel(ctx, workerBase, "abcde", "hello", localTarget, func(string, ...any) {})
	}()
	select {
	case tr := <-respCh:
		raw, _ := base64.StdEncoding.DecodeString(tr.BodyBase64)
		if tr.Status != 200 || !strings.Contains(string(raw), "served from local") {
			t.Fatalf("tunnel-response = (%d %q), want 200 + local bytes", tr.Status, raw)
		}
	case <-time.After(7 * time.Second):
		t.Fatalf("timed out waiting for CLI tunnel-response")
	}
	cancel()
	<-done
}
