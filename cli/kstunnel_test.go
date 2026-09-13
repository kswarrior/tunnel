package kstunnel

import (
	"strings"
	"testing"
)

func TestHelloContainsVersion(t *testing.T) {
	got := Hello()
	if !strings.Contains(got, Version) {
		t.Fatalf("Hello() = %q, want it to contain Version %q", got, Version)
	}
	if !strings.HasPrefix(got, "Hello World from kstunnel v") {
		t.Fatalf("Hello() = %q, want prefix %q", got, "Hello World from kstunnel v")
	}
}

func TestConfigURLShape(t *testing.T) {
	got := ConfigURL("https://tunnel.kswarriorpro.workers.dev", "abc123xyz456def0")
	want := "https://tunnel.kswarriorpro.workers.dev/!config?host=abc123xyz456def0"
	if got != want {
		t.Fatalf("ConfigURL() = %q, want %q", got, want)
	}
}

func TestAgentWSURLShape(t *testing.T) {
	got, err := AgentWSURL("https://tunnel.kswarriorpro.workers.dev", "abc123xyz456def0")
	if err != nil {
		t.Fatalf("AgentWSURL() error: %v", err)
	}
	want := "wss://tunnel.kswarriorpro.workers.dev/api/agent/ws?host=abc123xyz456def0"
	if got != want {
		t.Fatalf("AgentWSURL() = %q, want %q", got, want)
	}

	httpGot, err := AgentWSURL("http://127.0.0.1:8787/", "abc123xyz456def0")
	if err != nil {
		t.Fatalf("AgentWSURL() error: %v", err)
	}
	if !strings.HasPrefix(httpGot, "ws://127.0.0.1:8787/api/agent/ws?host=") {
		t.Fatalf("AgentWSURL() = %q, want ws:// prefix", httpGot)
	}
}

func TestGenerateHostID(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 20; i++ {
		id, err := GenerateHostID()
		if err != nil {
			t.Fatalf("GenerateHostID() error: %v", err)
		}
		if len(id) != 16 {
			t.Fatalf("GenerateHostID() = %q, want 16 chars", id)
		}
		if !IsValidHostID(id) {
			t.Fatalf("GenerateHostID() = %q, not a valid host id", id)
		}
		if seen[id] {
			t.Fatalf("GenerateHostID() duplicate %q (should be random)", id)
		}
		seen[id] = true
	}
}

func TestIsValidHostID(t *testing.T) {
	for _, ok := range []string{"abc123", "aB3-x_yZ09", strings.Repeat("a", 64)} {
		if !IsValidHostID(ok) {
			t.Fatalf("IsValidHostID(%q) = false, want true", ok)
		}
	}
	for _, bad := range []string{"", "ab", "has space", "semi;colon", "slash/a", strings.Repeat("a", 65)} {
		if IsValidHostID(bad) {
			t.Fatalf("IsValidHostID(%q) = true, want false", bad)
		}
	}
}
