package kstunnel

import (
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
)

func TestParseTunnelSpec(t *testing.T) {
	msg := `{"type":"tunnel-spec","host":"wtqyy","tunnels":[{"slug":"ks","target":"127.0.0.1:7070"},{"slug":"/Hello","target":"http://localhost:3000/x"}]}`
	specs, ok := ParseTunnelSpec(msg)
	if !ok {
		t.Fatalf("ParseTunnelSpec = not ok")
	}
	if len(specs) != 2 {
		t.Fatalf("ParseTunnelSpec = %v, want 2 entries", specs)
	}
	if specs[0].Slug != "ks" || specs[0].Target != "127.0.0.1:7070" {
		t.Fatalf("specs[0] = %+v, unexpected", specs[0])
	}
	if specs[1].Slug != "hello" || specs[1].Target != "localhost:3000" {
		t.Fatalf("specs[1] = %+v, want normalized slug + stripped target", specs[1])
	}

	// Explicit empty list is a valid "serve nothing" spec.
	empty, ok := ParseTunnelSpec(`{"type":"tunnel-spec","host":"wtqyy","tunnels":[]}`)
	if !ok || len(empty) != 0 {
		t.Fatalf("empty spec = (%v,%v), want ([],true)", empty, ok)
	}

	// Bad entries are skipped, not fatal.
	mixed, ok := ParseTunnelSpec(`{"type":"tunnel-spec","tunnels":[{"slug":"x","target":"127.0.0.1:1"},{"slug":"ok","target":"127.0.0.1:2"},{"slug":"ok","target":"127.0.0.1:3"}]}`)
	if !ok || len(mixed) != 1 || mixed[0].Slug != "ok" || mixed[0].Target != "127.0.0.1:3" {
		t.Fatalf("mixed spec = (%v,%v), want last-wins ok->127.0.0.1:3", mixed, ok)
	}

	// Noise must not parse as a spec.
	for _, noise := range []string{
		``,
		`not json`,
		`{"type":"presence","online":true}`,
		`{"type":"decision","decision":"allowed"}`,
		`{"type":"tunnel-request","id":"r1"}`,
		`{"type":"tunnel-spec-request"}`,
	} {
		if _, ok := ParseTunnelSpec(noise); ok {
			t.Fatalf("ParseTunnelSpec(%q) = ok, want not-ok", noise)
		}
	}
}

func TestDiffTunnelSpecs(t *testing.T) {
	old := map[string]TunnelSpec{
		"keep":    {Slug: "keep", Target: "127.0.0.1:1"},
		"changed": {Slug: "changed", Target: "127.0.0.1:1"},
		"gone":    {Slug: "gone", Target: "127.0.0.1:1"},
	}
	want := map[string]TunnelSpec{
		"keep":    {Slug: "keep", Target: "127.0.0.1:1"},
		"changed": {Slug: "changed", Target: "127.0.0.1:2"},
		"new":     {Slug: "new", Target: "127.0.0.1:3"},
	}
	toStart, toStop := diffTunnelSpecs(old, want)
	sort.Strings(toStop)
	if len(toStop) != 2 || toStop[0] != "changed" || toStop[1] != "gone" {
		t.Fatalf("toStop = %v, want [changed gone]", toStop)
	}
	started := map[string]string{}
	for _, s := range toStart {
		started[s.Slug] = s.Target
	}
	if len(started) != 2 || started["changed"] != "127.0.0.1:2" || started["new"] != "127.0.0.1:3" {
		t.Fatalf("toStart = %v, want changed->:2 + new->:3", toStart)
	}

	if s, x := diffTunnelSpecs(old, old); len(s) != 0 || len(x) != 0 {
		t.Fatalf("identical specs diff = (%v,%v), want empty", s, x)
	}
}

func TestFetchDesiredTunnels(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/hosts/wtqyy/tunnels/spec" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"host":"wtqyy","tunnels":[{"slug":"ks","target":"127.0.0.1:7070"},{"slug":"other","target":"127.0.0.1:1"},{"slug":"x","target":"127.0.0.1:1"}]}`))
	}))
	defer srv.Close()

	// Note: the fake server only knows "wtqyy"; the "other"-host case is
	// covered by sanitize filtering on the worker side in production.
	specs, err := fetchDesiredTunnels(srv.URL, "wtqyy")
	if err != nil {
		t.Fatalf("fetchDesiredTunnels: %v", err)
	}
	if len(specs) != 2 || specs[0].Slug != "ks" || specs[1].Slug != "other" {
		t.Fatalf("fetchDesiredTunnels = %+v, want [ks other] (bad slug x skipped)", specs)
	}

	if _, err := fetchDesiredTunnels(srv.URL, "nope"); err == nil {
		t.Fatalf("fetchDesiredTunnels(unknown host) = nil error, want 404 error")
	}
}
