// Package kstunnel is the library for KS Tunnel.
package kstunnel

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/url"
	"os"
	"strings"
	"time"
)

// Version is the library/binary version.
// Declared as var (not const) so release builds can override it via:
//
//	go build -ldflags "-X github.com/kswarrior/tunnel/cli.Version=<ver>"
var Version = "0.1.0"

// DefaultWorkerBase is the public web UI (Cloudflare Worker).
const DefaultWorkerBase = "https://tunnel.kswarriorpro.workers.dev"

// wsGUID is the RFC 6455 magic GUID.
const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const hostAlphabet = "abcdefghijklmnopqrstuvwxyz"

// hostIDLength is the number of random chars in `?host=` tokens.
const hostIDLength = 5

// Hello returns a hello-world string. Placeholder until tunnel agent lands.
func Hello() string {
	return "Hello World from kstunnel v" + Version
}

// WorkerBaseURL resolves the Worker base URL.
// Env override: KS_TUNNEL_URL (fallback KS_WORKER_URL). Defaults to DefaultWorkerBase.
func WorkerBaseURL() string {
	for _, key := range []string{"KS_TUNNEL_URL", "KS_WORKER_URL", "KSTUNNEL_WORKER"} {
		if v := strings.TrimSpace(os.Getenv(key)); v != "" {
			return strings.TrimRight(v, "/")
		}
	}
	return DefaultWorkerBase
}

// IsValidHostID reports whether s is a valid `?host=` token ([A-Za-z0-9_-]{5,64}).
func IsValidHostID(s string) bool {
	if len(s) < 5 || len(s) > 64 {
		return false
	}
	for _, c := range s {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' {
			continue
		}
		return false
	}
	return true
}

// GenerateHostID creates a fresh random host token (5x [a-z]).
// It is random on every call — never fixed — so each
// `./kstunnel --config:host` run yields a new `!config?host=` URL.
func GenerateHostID() (string, error) {
	out := make([]byte, hostIDLength)
	max := big.NewInt(int64(len(hostAlphabet)))
	for i := range out {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		out[i] = hostAlphabet[n.Int64()]
	}
	return string(out), nil
}

// ConfigURL builds the Allow URL printed by the CLI:
// https://<worker>/!config?host=<random>
func ConfigURL(workerBase, hostID string) string {
	base := strings.TrimRight(strings.TrimSpace(workerBase), "/")
	if base == "" {
		base = DefaultWorkerBase
	}
	return base + "/!config?host=" + url.QueryEscape(hostID)
}

// Config-decision handshake (mirrors cf/src/index.ts + presence.ts).
//
// The CLI prints /!config?host=<token> and holds the agent WSS open while the
// decision is "pending" (missing/unknown counts as pending = OK, keep waiting).
// The browser's Allow/Cancel page sends {"type":"decision","decision":...}
// through the same Durable Object, which broadcasts it to every socket:
//   - "allowed" -> CLI logs it and stays connected (alive).
//   - "denied"  -> CLI stops (RunAgent returns ErrDenied).
type Decision string

const (
	DecisionPending Decision = "pending"
	DecisionAllowed Decision = "allowed"
	DecisionDenied  Decision = "denied"
)

// ErrDenied is returned by RunAgent when the browser clicks Cancel/Decline.
// main maps it to a friendly "Canceled — not saved" message and a non-zero exit.
var ErrDenied = errors.New("host denied/canceled by browser")

func normalizeDecision(s string) (Decision, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "allowed", "allow", "approve", "approved", "accept":
		return DecisionAllowed, true
	case "denied", "deny", "decline", "declined", "cancel", "canceled", "cancelled", "reject", "rejected":
		return DecisionDenied, true
	case "pending", "reset", "wait", "waiting":
		return DecisionPending, true
	}
	return "", false
}

// ParseDecisionMessage extracts a config decision from an inbound WS text frame.
// It understands {"type":"decision","decision":"allowed"|"denied"},
// {"type":"allow"|"deny"|"cancel"|...}, {"type":"presence","decision":...},
// and bare strings. Presence frames without a decision report ok=false.
func ParseDecisionMessage(msg string) (Decision, bool) {
	trimmed := strings.TrimSpace(msg)
	if trimmed == "" {
		return "", false
	}
	var v any
	if err := json.Unmarshal([]byte(trimmed), &v); err != nil {
		if d, ok := normalizeDecision(trimmed); ok {
			return d, true
		}
		return "", false
	}
	switch t := v.(type) {
	case string:
		return normalizeDecision(t)
	case map[string]any:
		if typ, _ := t["type"].(string); typ != "" && typ != "decision" && typ != "presence" {
			if d, ok := normalizeDecision(typ); ok && d != DecisionPending {
				return d, true
			}
			if strings.EqualFold(strings.TrimSpace(typ), "reset") {
				return DecisionPending, true
			}
		}
		for _, key := range []string{"decision", "action", "approved"} {
			if s, _ := t[key].(string); s != "" {
				if d, ok := normalizeDecision(s); ok {
					return d, true
				}
			}
		}
		if b, _ := t["allow"].(bool); b {
			return DecisionAllowed, true
		}
		if b, _ := t["approved"].(bool); b {
			return DecisionAllowed, true
		}
		for _, key := range []string{"deny", "decline", "cancel"} {
			if b, _ := t[key].(bool); b {
				return DecisionDenied, true
			}
		}
		if typ, _ := t["type"].(string); typ == "presence" || typ == "decision" {
			if s, _ := t["decision"].(string); s != "" {
				return normalizeDecision(s)
			}
		}
	}
	return "", false
}

// AgentWSURL builds the WSS endpoint the CLI holds open for presence:
// wss://<worker>/api/agent/ws?host=<random>
func AgentWSURL(workerBase, hostID string) (string, error) {
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
		// keep
	default:
		u.Scheme = "wss"
	}
	u.Path = "/api/agent/ws"
	u.RawQuery = url.Values{"host": []string{hostID}}.Encode()
	u.Fragment = ""
	return u.String(), nil
}

// ---------------------------------------------------------------------------
// Minimal stdlib-only WebSocket client (RFC 6455, text frames + ping/pong).
// Avoids third-party deps so `go build` works offline.
// ---------------------------------------------------------------------------

func wsDial(rawURL string) (net.Conn, *bufio.Reader, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, nil, err
	}
	secure := u.Scheme == "wss"
	host := u.Host
	if host == "" {
		return nil, nil, fmt.Errorf("websocket: missing host in %q", rawURL)
	}
	if _, _, err := net.SplitHostPort(host); err != nil {
		if secure {
			host = net.JoinHostPort(host, "443")
		} else {
			host = net.JoinHostPort(host, "80")
		}
	}
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	raw, err := dialer.Dial("tcp", host)
	if err != nil {
		return nil, nil, err
	}
	var conn net.Conn = raw
	if secure {
		serverName, _, _ := net.SplitHostPort(host)
		tlsConn := tls.Client(raw, &tls.Config{ServerName: serverName})
		if err := tlsConn.Handshake(); err != nil {
			raw.Close()
			return nil, nil, err
		}
		conn = tlsConn
	}

	keyBytes := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, keyBytes); err != nil {
		conn.Close()
		return nil, nil, err
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)

	reqPath := u.RequestURI()
	originScheme := "https"
	if !secure {
		originScheme = "http"
	}
	fmt.Fprintf(conn, "GET %s HTTP/1.1\r\n", reqPath)
	fmt.Fprintf(conn, "Host: %s\r\n", u.Host)
	fmt.Fprintf(conn, "Upgrade: websocket\r\nConnection: Upgrade\r\n")
	fmt.Fprintf(conn, "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n", key)
	fmt.Fprintf(conn, "Origin: %s://%s\r\n", originScheme, u.Host)
	fmt.Fprintf(conn, "User-Agent: kstunnel/%s\r\n\r\n", Version)

	br := bufio.NewReader(conn)
	if err := conn.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
		conn.Close()
		return nil, nil, err
	}
	status, err := br.ReadString('\n')
	if err != nil {
		conn.Close()
		return nil, nil, err
	}
	if !strings.Contains(status, "101") {
		conn.Close()
		return nil, nil, fmt.Errorf("websocket: unexpected status %q", strings.TrimSpace(status))
	}
	acceptWant := base64.StdEncoding.EncodeToString(sha1Sum(key + wsGUID))
	acceptGot := ""
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			conn.Close()
			return nil, nil, err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			break
		}
		if idx := strings.Index(line, ":"); idx >= 0 {
			name := strings.ToLower(strings.TrimSpace(line[:idx]))
			val := strings.TrimSpace(line[idx+1:])
			if name == "sec-websocket-accept" {
				acceptGot = val
			}
		}
	}
	if acceptGot != acceptWant {
		conn.Close()
		return nil, nil, fmt.Errorf("websocket: bad accept key")
	}
	_ = conn.SetReadDeadline(time.Time{})
	return conn, br, nil
}

func sha1Sum(s string) []byte {
	h := sha1.New()
	h.Write([]byte(s))
	return h.Sum(nil)
}

func wsWriteFrame(conn net.Conn, opcode byte, payload []byte) error {
	mask := make([]byte, 4)
	if _, err := io.ReadFull(rand.Reader, mask); err != nil {
		return err
	}
	var header []byte
	header = append(header, 0x80|opcode) // FIN + opcode
	n := len(payload)
	switch {
	case n < 126:
		header = append(header, 0x80|byte(n))
	case n < 65536:
		header = append(header, 0x80|126, byte(n>>8), byte(n))
	default:
		header = append(header, 0x80|127,
			0, 0, 0, 0,
			byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
	}
	header = append(header, mask...)
	masked := make([]byte, n)
	for i := range payload {
		masked[i] = payload[i] ^ mask[i%4]
	}
	header = append(header, masked...)
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_, err := conn.Write(header)
	return err
}

func wsWriteText(conn net.Conn, text string) error {
	return wsWriteFrame(conn, 0x1, []byte(text))
}

// wsServe reads frames until close/error. Ping -> Pong, text -> onText.
func wsServe(conn net.Conn, br *bufio.Reader, onText func(string)) error {
	var frag []byte
	var fragOpcode byte
	for {
		_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		hdr := make([]byte, 2)
		if _, err := io.ReadFull(br, hdr); err != nil {
			return err
		}
		fin := hdr[0]&0x80 != 0
		opcode := hdr[0] & 0x0F
		masked := hdr[1]&0x80 != 0
		length := int64(hdr[1] & 0x7F)
		switch length {
		case 126:
			ext := make([]byte, 2)
			if _, err := io.ReadFull(br, ext); err != nil {
				return err
			}
			length = int64(ext[0])<<8 | int64(ext[1])
		case 127:
			ext := make([]byte, 8)
			if _, err := io.ReadFull(br, ext); err != nil {
				return err
			}
			length = 0
			for _, b := range ext {
				length = length<<8 | int64(b)
			}
		}
		if length > 8<<20 {
			return fmt.Errorf("websocket: frame too large (%d)", length)
		}
		var maskKey []byte
		if masked {
			maskKey = make([]byte, 4)
			if _, err := io.ReadFull(br, maskKey); err != nil {
				return err
			}
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(br, payload); err != nil {
			return err
		}
		if masked {
			for i := range payload {
				payload[i] ^= maskKey[i%4]
			}
		}
		switch opcode {
		case 0x8: // close
			_ = wsWriteFrame(conn, 0x8, []byte{})
			return io.EOF
		case 0x9: // ping
			_ = wsWriteFrame(conn, 0xA, payload)
		case 0xA: // pong
			// ignore
		case 0x1, 0x2: // text/binary
			if !fin {
				if frag == nil {
					fragOpcode = opcode
				}
				frag = append(frag, payload...)
				continue
			}
			var full []byte
			if frag != nil {
				full = append(frag, payload...)
				frag = nil
			} else {
				full = payload
			}
			if fragOpcode == 0x2 && opcode == 0x1 {
				fragOpcode = opcode
			}
			if onText != nil && (opcode == 0x1 || fragOpcode == 0x1 || len(full) > 0) {
				onText(string(full))
			}
			fragOpcode = 0
		case 0x0: // continuation
			frag = append(frag, payload...)
			if fin {
				if onText != nil {
					onText(string(frag))
				}
				frag = nil
				fragOpcode = 0
			}
		default:
			// ignore control extensions
		}
	}
}

// RunAgent holds the presence WSS connection open for hostID until ctx ends.
// It dials AgentWSURL(workerBase, hostID), heartbeats with {"type":"ping"},
// and reconnects with backoff. Log lines go to logf (nil = discard).
func RunAgent(ctx context.Context, workerBase, hostID string, logf func(string, ...any)) error {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	if !IsValidHostID(hostID) {
		return fmt.Errorf("invalid host id %q", hostID)
	}
	wsURL, err := AgentWSURL(workerBase, hostID)
	if err != nil {
		return err
	}
	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		logf("connecting %s ...", wsURL)
		conn, br, err := wsDial(wsURL)
		if err != nil {
			logf("connect failed: %v (retry in %s)", err, backoff)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(backoff):
			}
			backoff = minDuration(30*time.Second, backoff*2)
			continue
		}
		logf("wss connected (host %s) — green dot should show on the web UI", hostID)
		backoff = time.Second

		done := make(chan error, 1)
		go func() {
			done <- wsServe(conn, br, func(msg string) {
				// Presence broadcasts land here; keep quiet unless useful.
				_ = msg
			})
		}()

		ticker := time.NewTicker(25 * time.Second)
		// Immediate hello ping so the DO sees traffic through proxies.
		_ = wsWriteText(conn, `{"type":"ping"}`)
		alive := true
		for alive {
			select {
			case <-ctx.Done():
				_ = wsWriteFrame(conn, 0x8, []byte{})
				conn.Close()
				ticker.Stop()
				return ctx.Err()
			case err := <-done:
				if err != nil && err != io.EOF {
					logf("connection lost: %v (reconnecting...)", err)
				} else {
					logf("connection closed (reconnecting...)")
				}
				alive = false
			case <-ticker.C:
				if err := wsWriteText(conn, `{"type":"ping"}`); err != nil {
					logf("heartbeat failed: %v (reconnecting...)", err)
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

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
