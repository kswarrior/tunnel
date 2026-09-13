package kstunnel

import (
	"strings"
	"testing"
)

func TestNormalizeSlug(t *testing.T) {
	cases := map[string]string{
		"/hello":   "hello",
		"///hello": "hello",
		" Hello ":  "hello",
		"/HELLO":   "hello",
		"hi-there": "hi-there",
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
