package kstunnel

// Live handshake test: fake minimal WS server mimicking the Worker DO,
// verifying the CLI agent reacts to allowed (stay alive) vs denied (stop).

import (
	"bufio"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"
)

// startFakeAgentServer accepts ONE agent connection, performs the WS upgrade,
// sends firstFrames (each as one server->client text frame), then holds the
// socket open reading (and discarding) client frames until ctx ends.
// It returns the ws:// base URL to pass as workerBase to RunAgent.
func startFakeAgentServer(t *testing.T, ctx context.Context, firstFrames []string) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() {
		defer ln.Close()
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		br := bufio.NewReader(conn)
		// Read HTTP upgrade request headers.
		var key string
		for {
			line, err := br.ReadString('\n')
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
		fmt.Fprintf(conn, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", accept)
		// Send scripted server->client text frames (unmasked).
		for _, payload := range firstFrames {
			b := []byte(payload)
			if len(b) >= 126 {
				t.Errorf("test payload too large")
				return
			}
			if _, err := conn.Write([]byte{0x81, byte(len(b))}); err != nil {
				return
			}
			if _, err := conn.Write(b); err != nil {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		// Hold open: discard client frames until test ctx ends.
		_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
		buf := make([]byte, 4096)
		for ctx.Err() == nil {
			_ = conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
			_, err := conn.Read(buf)
			if err != nil {
				if ne, ok := err.(net.Error); ok && ne.Timeout() {
					continue
				}
				return
			}
		}
	}()
	return "http://" + ln.Addr().String()
}

func runAgentCapture(hostID, workerBase string, timeout time.Duration) (error, []string) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var logs []string
	logf := func(f string, a ...any) { logs = append(logs, fmt.Sprintf(f, a...)) }
	err := RunAgent(ctx, workerBase, hostID, logf)
	return err, logs
}

func TestHandshakeDeniedStops(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	base := startFakeAgentServer(t, ctx, []string{
		`{"type":"presence","host":"abcde","online":true,"agents":1,"decision":"pending"}`,
		`{"type":"decision","host":"abcde","decision":"denied","timestamp":"2026-01-01T00:00:00Z"}`,
	})
	err, logs := runAgentCapture("abcde", base, 8*time.Second)
	if err != ErrDenied {
		t.Fatalf("RunAgent on denied = %v (logs %q), want ErrDenied", err, logs)
	}
	found := false
	for _, l := range logs {
		if strings.Contains(strings.ToLower(l), "cancel") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected cancel log line, got %q", logs)
	}
}

func TestHandshakeAllowedStaysAlive(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	base := startFakeAgentServer(t, ctx, []string{
		`{"type":"presence","host":"abcde","online":true,"agents":1,"decision":"pending"}`,
		`{"type":"decision","host":"abcde","decision":"allowed","timestamp":"2026-01-01T00:00:00Z"}`,
	})
	// 2.5s is plenty for the allowed frame to arrive, but RunAgent must NOT
	// return on its own — only via ctx timeout (context.DeadlineExceeded).
	err, logs := runAgentCapture("abcde", base, 2500*time.Millisecond)
	if err != context.DeadlineExceeded {
		t.Fatalf("RunAgent on allowed returned %v (logs %q), want to stay alive until ctx timeout", err, logs)
	}
	found := false
	for _, l := range logs {
		if strings.Contains(strings.ToLower(l), "allowed") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected allowed log line, got %q", logs)
	}
}

func TestHandshakePendingKeepsWaiting(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	base := startFakeAgentServer(t, ctx, []string{
		`{"type":"presence","host":"abcde","online":true,"agents":1,"decision":"pending"}`,
	})
	// Pending (== not found / not decided yet) is OK: keep waiting, no error.
	err, _ := runAgentCapture("abcde", base, 1500*time.Millisecond)
	if err != context.DeadlineExceeded {
		t.Fatalf("RunAgent on pending returned %v, want to keep waiting (ctx timeout)", err)
	}
}

var _ = sha1.New // keep import if unused in future edits
