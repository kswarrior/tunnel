// Tunnel data-plane: per-tunnel WSS (cli -> workers -> users).
//
//   main wss   : wss://<worker>/api/agent/ws?host=<id>            (control:
//                presence + allow/deny + pings; see RunAgent in kstunnel.go)
//   tunnel wss : wss://<worker>/api/tunnels/ws?host=<id>&slug=<slug>
//                (data: ONE socket PER TUNNEL. Run one CLI process per tunnel,
//                each holding its own tunnel wss plus the shared main wss.)
//
// Visitor flow: GET https://<worker>/!tunnel=<slug>/... -> Worker resolves
// slug -> HostPresence DO -> tunnel-request over tunnel wss -> CLI fetches
// http://<target><path> locally -> tunnel-response -> Worker returns the
// bytes verbatim (fullscreen, no KS wrapper — only the wss of that port).
// Legacy /<slug> URLs proxy the same way.
package kstunnel

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// TunnelRequest is one visitor HTTP request bridged over the tunnel wss.
type TunnelRequest struct {
	Type       string            `json:"type"`
	ID         string            `json:"id"`
	Method     string            `json:"method"`
	Path       string            `json:"path"`
	Headers    map[string]string `json:"headers"`
	BodyBase64 string            `json:"bodyBase64"`
	Slug       string            `json:"slug"`
}

// TunnelResponse answers a TunnelRequest (same ID).
type TunnelResponse struct {
	Type       string            `json:"type"`
	ID         string            `json:"id"`
	Status     int               `json:"status"`
	Headers    map[string]string `json:"headers"`
	BodyBase64 string            `json:"bodyBase64"`
}

// NormalizeSlug strips leading slashes and lowercases (" /Hello " -> "hello").
func NormalizeSlug(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimLeft(s, "/")
	return strings.ToLower(strings.TrimSpace(s))
}

// IsValidSlug reports whether s is a storable slug ([a-z0-9-]{2,32}).
func IsValidSlug(s string) bool {
	s = NormalizeSlug(s)
	if len(s) < 2 || len(s) > 32 {
		return false
	}
	for _, c := range s {
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' {
			continue
		}
		return false
	}
	return true
}

// IsValidTarget reports whether s looks like host:port (e.g. 127.0.0.1:4757).
// The port must be numeric and in range 1-65535 (port 0 can never serve, and
// would publish a bogus registry entry whose /<slug> can't show the port).
func IsValidTarget(s string) bool {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	if i := strings.Index(s, "/"); i >= 0 {
		s = s[:i]
	}
	host, port, ok := strings.Cut(s, ":")
	if !ok || host == "" || port == "" {
		return false
	}
	for _, c := range host {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_' {
			continue
		}
		return false
	}
	for _, c := range port {
		if c < '0' || c > '9' {
			return false
		}
	}
	if len(port) > 5 {
		return false
	}
	n := 0
	for _, c := range port {
		n = n*10 + int(c-'0')
	}
	return n >= 1 && n <= 65535
}

// NormalizeTarget strips scheme/path, returning host:port.
func NormalizeTarget(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	if i := strings.Index(s, "/"); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

// TunnelWSURL builds the per-tunnel data WSS endpoint:
// wss://<worker>/api/tunnels/ws?host=<id>&slug=<slug>
func TunnelWSURL(workerBase, hostID, slug string) (string, error) {
	return TunnelWSURLWithTarget(workerBase, hostID, slug, "")
}

// TunnelWSURLWithTarget includes &target= so the Worker can auto-register
// /<slug> even if the browser form never POSTed.
func TunnelWSURLWithTarget(workerBase, hostID, slug, target string) (string, error) {
	base := strings.TrimSpace(workerBase)
	if base == "" {
		base = DefaultWorkerBase
	}
	if !strings.Contains(base, "://") {
		base = "https://" + base
	}
	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	case "wss", "ws":
	default:
		u.Scheme = "wss"
	}
	u.Path = "/api/tunnels/ws"
	q := url.Values{"host": []string{hostID}, "slug": []string{NormalizeSlug(slug)}}
	if strings.TrimSpace(target) != "" {
		q.Set("target", NormalizeTarget(target))
	}
	u.RawQuery = q.Encode()
	u.Fragment = ""
	return u.String(), nil
}

// ParseTunnelRequest extracts a tunnel-request from an inbound WS text frame.
// Returns ok=false for presence/decision/ping noise.
func ParseTunnelRequest(msg string) (TunnelRequest, bool) {
	var raw map[string]any
	if err := json.Unmarshal([]byte(msg), &raw); err != nil {
		return TunnelRequest{}, false
	}
	if typ, _ := raw["type"].(string); typ != "tunnel-request" {
		return TunnelRequest{}, false
	}
	id, _ := raw["id"].(string)
	if id == "" {
		return TunnelRequest{}, false
	}
	method, _ := raw["method"].(string)
	if method == "" {
		method = "GET"
	}
	path, _ := raw["path"].(string)
	if path == "" {
		path = "/"
	}
	headers := map[string]string{}
	if h, ok := raw["headers"].(map[string]any); ok {
		for k, v := range h {
			if s, ok := v.(string); ok {
				headers[k] = s
			}
		}
	}
	bodyB64, _ := raw["bodyBase64"].(string)
	slug, _ := raw["slug"].(string)
	return TunnelRequest{Type: "tunnel-request", ID: id, Method: method, Path: path, Headers: headers, BodyBase64: bodyB64, Slug: slug}, true
}

// RegisterTunnel POSTs slug->host/target to the Worker registry so visitors
// hitting /<slug> resolve even before the tunnel wss connects.
// Best-effort: logs on failure, never fatal.
func RegisterTunnel(workerBase, hostID, slug, target, name string, logf func(string, ...any)) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	base := strings.TrimSpace(workerBase)
	if base == "" {
		base = DefaultWorkerBase
	}
	base = strings.TrimRight(base, "/")
	body, _ := json.Marshal(map[string]string{
		"slug":       NormalizeSlug(slug),
		"host":       strings.TrimSpace(hostID),
		"target":     NormalizeTarget(target),
		"name":       strings.TrimSpace(name),
		"tunnelType": "HTTP",
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", base+"/api/tunnels", bytes.NewReader(body))
	if err != nil {
		logf("register tunnel: %v", err)
		return
	}
	req.Header.Set("content-type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		logf("register tunnel: %v", err)
		return
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode >= 300 {
		logf("register tunnel: HTTP %d", resp.StatusCode)
	}
}

var tunnelHTTPClient = &http.Client{Timeout: 25 * time.Second}

// fetchLocal performs the local HTTP request against target (host:port).
func fetchLocal(target, method, path string, headers map[string]string, body []byte) (int, map[string]string, []byte, error) {
	target = NormalizeTarget(target)
	if target == "" {
		return 0, nil, nil, fmt.Errorf("empty target")
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	upstream := "http://" + target + path
	var bodyReader io.Reader
	if len(body) > 0 {
		bodyReader = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, upstream, bodyReader)
	if err != nil {
		return 0, nil, nil, err
	}
	for k, v := range headers {
		lk := strings.ToLower(k)
		if lk == "host" || lk == "content-length" || lk == "connection" || lk == "transfer-encoding" {
			continue
		}
		if strings.HasPrefix(lk, "cf-") {
			continue
		}
		req.Header.Set(k, v)
	}
	req.Header.Set("X-Forwarded-By", "kstunnel")
	resp, err := tunnelHTTPClient.Do(req)
	if err != nil {
		return 0, nil, nil, err
	}
	defer resp.Body.Close()
	const maxBody = 10 << 20
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return 0, nil, nil, err
	}
	if len(b) > maxBody {
		return 0, nil, nil, fmt.Errorf("upstream body too large")
	}
	out := map[string]string{}
	for k, vv := range resp.Header {
		lk := strings.ToLower(k)
		if lk == "content-length" || lk == "transfer-encoding" || lk == "connection" {
			continue
		}
		if len(vv) == 1 {
			out[k] = vv[0]
		} else if len(vv) > 1 {
			out[k] = strings.Join(vv, ", ")
		}
	}
	status := resp.StatusCode
	if status == 0 {
		status = 200
	}
	return status, out, b, nil
}

func handleTunnelRequest(mu *sync.Mutex, send func(string) error, target string, req TunnelRequest, logf func(string, ...any)) {
	var body []byte
	if req.BodyBase64 != "" {
		b, err := base64.StdEncoding.DecodeString(req.BodyBase64)
		if err != nil {
			respondTunnel(mu, send, req.ID, 400, map[string]string{"content-type": "text/plain; charset=utf-8"}, []byte("bad request body"))
			return
		}
		body = b
	}
	status, headers, respBody, err := fetchLocal(target, req.Method, req.Path, req.Headers, body)
	if err != nil {
		logf("tunnel %s %s %s -> local error: %v", req.Slug, req.Method, req.Path, err)
		respondTunnel(mu, send, req.ID, 502, map[string]string{"content-type": "text/plain; charset=utf-8"}, []byte("tunnel upstream error: "+err.Error()))
		return
	}
	if headers == nil {
		headers = map[string]string{}
	}
	respondTunnel(mu, send, req.ID, status, headers, respBody)
}

func respondTunnel(mu *sync.Mutex, send func(string) error, id string, status int, headers map[string]string, body []byte) {
	if headers == nil {
		headers = map[string]string{}
	}
	payload, _ := json.Marshal(TunnelResponse{
		Type:       "tunnel-response",
		ID:         id,
		Status:     status,
		Headers:    headers,
		BodyBase64: base64.StdEncoding.EncodeToString(body),
	})
	mu.Lock()
	defer mu.Unlock()
	_ = send(string(payload))
}

// RunTunnel holds ONE per-tunnel data WSS open for (hostID, slug) and proxies
// every tunnel-request to the local target (e.g. 127.0.0.1:4757).
//
// Run it alongside RunAgent (the MAIN wss, cf<->cli control): one process per
// tunnel, each with its own tunnel wss + the shared main wss:
//
//	kstunnel --host <id> --tunnel hello --target 127.0.0.1:4757
//
// Visitors then get fullscreen upstream bytes at https://<worker>/!tunnel=hello.
func RunTunnel(ctx context.Context, workerBase, hostID, slug, target string, logf func(string, ...any)) error {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	hostID = strings.TrimSpace(hostID)
	slug = NormalizeSlug(slug)
	target = NormalizeTarget(target)
	if !IsValidHostID(hostID) {
		return fmt.Errorf("invalid host id %q", hostID)
	}
	if !IsValidSlug(slug) {
		return fmt.Errorf("invalid tunnel slug %q (want slug like hello for /!tunnel=hello)", slug)
	}
	if !IsValidTarget(target) {
		return fmt.Errorf("invalid target %q (want like 127.0.0.1:4757)", target)
	}
	wsURL, err := TunnelWSURLWithTarget(workerBase, hostID, slug, target)
	if err != nil {
		return err
	}
	// Best-effort registry publish so /!tunnel=<slug> resolves immediately.
	go RegisterTunnel(workerBase, hostID, slug, target, slug, logf)

	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		logf("connecting tunnel wss %s ...", wsURL)
		conn, br, err := wsDial(wsURL)
		if err != nil {
			logf("tunnel connect failed: %v (retry in %s)", err, backoff)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(backoff):
			}
			backoff = minDuration(30*time.Second, backoff*2)
			continue
		}
		logf("tunnel wss connected (host %s slug /%s -> %s)", hostID, slug, target)
		backoff = time.Second

		var mu sync.Mutex
		send := func(text string) error { return wsWriteText(conn, text) }
		done := make(chan error, 1)
		go func(t string) {
			done <- wsServe(conn, br, func(msg string) {
				req, ok := ParseTunnelRequest(msg)
				if !ok {
					return // presence/decision/pong noise — main wss owns control
				}
				go handleTunnelRequest(&mu, send, t, req, logf)
			})
		}(target)

		ticker := time.NewTicker(25 * time.Second)
		mu.Lock()
		_ = wsWriteText(conn, `{"type":"ping"}`)
		mu.Unlock()
		alive := true
		for alive {
			select {
			case <-ctx.Done():
				mu.Lock()
				_ = wsWriteFrame(conn, 0x8, []byte{})
				mu.Unlock()
				conn.Close()
				ticker.Stop()
				return ctx.Err()
			case err := <-done:
				if err != nil && err != io.EOF {
					logf("tunnel connection lost: %v (reconnecting...)", err)
				} else {
					logf("tunnel connection closed (reconnecting...)")
				}
				alive = false
			case <-ticker.C:
				mu.Lock()
				werr := wsWriteText(conn, `{"type":"ping"}`)
				mu.Unlock()
				if werr != nil {
					logf("tunnel heartbeat failed: %v (reconnecting...)", werr)
					alive = false
				}
			}
		}
		ticker.Stop()
		conn.Close()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		backoff = minDuration(30*time.Second, backoff*2)
	}
}
