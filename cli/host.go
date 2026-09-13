// Host mode: the CLI serves whatever tunnels users create, with no
// per-tunnel command. Run `kstunnel --host <id>` and keep it running:
//
//   - It holds the MAIN wss open (presence + allow/deny, like RunAgent).
//   - The Worker pushes {"type":"tunnel-spec","tunnels":[{slug,target}...]}
//     down that socket whenever a tunnel is created/edited/deleted.
//   - RunHost opens one per-tunnel data WSS per entry (same as RunTunnel)
//     and closes sockets for removed entries. A registry HTTP poll every
//     30s heals anything the push missed.
package kstunnel

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// TunnelSpec is one desired tunnel: serve local Target at public /Slug.
type TunnelSpec struct {
	Slug   string `json:"slug"`
	Target string `json:"target"`
}

// sanitizeSpecEntry normalizes one spec entry; ok=false when the slug is
// unusable or the target is empty (callers log and skip those).
func sanitizeSpecEntry(slug, target string) (TunnelSpec, bool) {
	s := NormalizeSlug(slug)
	t := NormalizeTarget(strings.TrimSpace(target))
	if !IsValidSlug(s) || t == "" {
		return TunnelSpec{}, false
	}
	return TunnelSpec{Slug: s, Target: t}, true
}

// ParseTunnelSpec extracts the desired-tunnel list from a main-wss message:
//
//	{"type":"tunnel-spec","tunnels":[{"slug":"ks","target":"127.0.0.1:7070"}]}
//
// ok=false for anything else (presence/decision/ping noise). Duplicated
// slugs resolve last-wins.
func ParseTunnelSpec(msg string) ([]TunnelSpec, bool) {
	var raw map[string]any
	if err := json.Unmarshal([]byte(msg), &raw); err != nil {
		return nil, false
	}
	if typ, _ := raw["type"].(string); typ != "tunnel-spec" {
		return nil, false
	}
	bySlug := map[string]TunnelSpec{}
	order := []string{}
	arr, _ := raw["tunnels"].([]any)
	for _, item := range arr {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		slug, _ := m["slug"].(string)
		target, _ := m["target"].(string)
		spec, ok := sanitizeSpecEntry(slug, target)
		if !ok {
			continue
		}
		if _, seen := bySlug[spec.Slug]; !seen {
			order = append(order, spec.Slug)
		}
		bySlug[spec.Slug] = spec
	}
	out := make([]TunnelSpec, 0, len(order))
	for _, slug := range order {
		out = append(out, bySlug[slug])
	}
	return out, true
}

// diffTunnelSpecs compares the running set against the desired set.
// toStart holds new or target-changed entries; toStop holds removed or
// target-changed slugs (restart = stop + start).
func diffTunnelSpecs(old, want map[string]TunnelSpec) (toStart []TunnelSpec, toStop []string) {
	for slug, cur := range old {
		next, ok := want[slug]
		if !ok || next.Target != cur.Target {
			toStop = append(toStop, slug)
		}
	}
	for slug, next := range want {
		cur, ok := old[slug]
		if !ok || cur.Target != next.Target {
			toStart = append(toStart, next)
		}
	}
	return toStart, toStop
}

var hostHTTPClient = &http.Client{Timeout: 10 * time.Second}

// fetchDesiredTunnels reads the worker-side desired spec for hostID:
// GET <worker>/api/hosts/<id>/tunnels/spec -> {tunnels:[{slug,target}]}.
func fetchDesiredTunnels(workerBase, hostID string) ([]TunnelSpec, error) {
	base := strings.TrimSpace(workerBase)
	if base == "" {
		base = DefaultWorkerBase
	}
	base = strings.TrimRight(base, "/")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", base+"/api/hosts/"+hostID+"/tunnels/spec", nil)
	if err != nil {
		return nil, err
	}
	resp, err := hostHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("spec poll: HTTP %d", resp.StatusCode)
	}
	var data struct {
		Tunnels []struct {
			Slug   string `json:"slug"`
			Target string `json:"target"`
		} `json:"tunnels"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&data); err != nil {
		return nil, err
	}
	out := []TunnelSpec{}
	for _, e := range data.Tunnels {
		if spec, ok := sanitizeSpecEntry(e.Slug, e.Target); ok {
			out = append(out, spec)
		}
	}
	return out, nil
}

// RunHost runs a host agent with DYNAMIC tunnels (host mode):
//
//	kstunnel --host <id>
//
// It holds the MAIN wss open (presence + allow/deny, like RunAgent) and
// serves whatever the worker's tunnel-spec says: opening one per-tunnel
// data WSS per entry and closing removed ones. Log lines go to logf
// (nil = discard). Browser Cancel still stops everything (ErrDenied).
func RunHost(ctx context.Context, workerBase, hostID string, logf func(string, ...any)) error {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	hostID = strings.TrimSpace(hostID)
	if !IsValidHostID(hostID) {
		return fmt.Errorf("invalid host id %q", hostID)
	}
	wsURL, err := AgentWSURL(workerBase, hostID)
	if err != nil {
		return err
	}

	var mu sync.Mutex
	active := map[string]context.CancelFunc{}
	have := map[string]TunnelSpec{}

	applySpec := func(specs []TunnelSpec, source string) {
		want := map[string]TunnelSpec{}
		for _, s := range specs {
			want[s.Slug] = s
		}
		mu.Lock()
		defer mu.Unlock()
		toStart, toStop := diffTunnelSpecs(have, want)
		for _, slug := range toStop {
			if cancel, ok := active[slug]; ok {
				cancel()
				delete(active, slug)
			}
			delete(have, slug)
			logf("tunnel /%s stopped (%s)", slug, source)
		}
		for _, spec := range toStart {
			if !IsValidTarget(spec.Target) {
				logf("tunnel /%s has invalid target %q — skipping (fix it in the web UI)", spec.Slug, spec.Target)
				continue
			}
			tctx, cancel := context.WithCancel(ctx)
			active[spec.Slug] = cancel
			have[spec.Slug] = spec
			logf("tunnel /%s -> %s serving (%s)", spec.Slug, spec.Target, source)
			go func(sp TunnelSpec) {
				rerr := RunTunnel(tctx, workerBase, hostID, sp.Slug, sp.Target, logf)
				if rerr != nil && rerr != context.Canceled && tctx.Err() == nil {
					logf("tunnel /%s exited: %v", sp.Slug, rerr)
				}
				mu.Lock()
				// Forget only if this generation is still current.
				if cur, ok := have[sp.Slug]; ok && cur.Target == sp.Target {
					delete(have, sp.Slug)
					delete(active, sp.Slug)
				}
				mu.Unlock()
			}(spec)
		}
	}

	// Initial desired state from the worker (pushes update it live after).
	if specs, err := fetchDesiredTunnels(workerBase, hostID); err != nil {
		logf("tunnel list unavailable: %v (waiting for worker push...)", err)
	} else if len(specs) > 0 {
		applySpec(specs, "registry")
	} else {
		logf("no tunnels yet — create one in the web UI and it will be served automatically")
	}

	backoff := time.Second
	allowedLogged := false
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
		logf("wss connected (host %s) — watching for tunnels to serve", hostID)
		backoff = time.Second

		denyCh := make(chan struct{}, 1)
		allowCh := make(chan struct{}, 4)
		specCh := make(chan []TunnelSpec, 4)
		done := make(chan error, 1)
		go func() {
			done <- wsServe(conn, br, func(msg string) {
				if decision, ok := ParseDecisionMessage(msg); ok {
					switch decision {
					case DecisionDenied:
						select {
						case denyCh <- struct{}{}:
						default:
						}
					case DecisionAllowed:
						select {
						case allowCh <- struct{}{}:
						default:
						}
					default:
						// pending = not decided yet = OK, keep waiting.
					}
					return
				}
				if specs, ok := ParseTunnelSpec(msg); ok {
					select {
					case specCh <- specs:
					default:
						// full — drop it, the registry poll heals shortly.
					}
				}
			})
		}()

		ticker := time.NewTicker(25 * time.Second)
		poll := time.NewTicker(30 * time.Second)
		// Immediate hello ping + spec pull so a fresh agent learns the
		// current desired list even if it missed the connect-time push.
		_ = wsWriteText(conn, `{"type":"ping"}`)
		_ = wsWriteText(conn, `{"type":"get-tunnels"}`)
		alive := true
		for alive {
			select {
			case <-ctx.Done():
				_ = wsWriteFrame(conn, 0x8, []byte{})
				conn.Close()
				ticker.Stop()
				poll.Stop()
				return ctx.Err()
			case <-denyCh:
				ticker.Stop()
				poll.Stop()
				_ = wsWriteFrame(conn, 0x8, []byte{})
				conn.Close()
				logf("canceled by browser — not saved (host %s)", hostID)
				return ErrDenied
			case <-allowCh:
				if !allowedLogged {
					allowedLogged = true
					logf("allowed by browser — host %s saved, watching for tunnels (Ctrl+C to stop)...", hostID)
				}
			case specs := <-specCh:
				applySpec(specs, "worker push")
			case <-poll.C:
				if specs, err := fetchDesiredTunnels(workerBase, hostID); err != nil {
					logf("tunnel poll failed: %v", err)
				} else {
					applySpec(specs, "registry poll")
				}
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
		poll.Stop()
		conn.Close()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		backoff = minDuration(30*time.Second, backoff*2)
	}
}
