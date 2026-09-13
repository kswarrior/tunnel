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
