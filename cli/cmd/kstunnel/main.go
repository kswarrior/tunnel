package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"

	cli "github.com/kswarrior/tunnel/cli"
)

func usage() {
	fmt.Fprintf(os.Stderr, "Usage: %s [--help] [--version] [--config:host] [--host ID [--tunnel SLUG --target HOST:PORT]] [--worker URL]\n", os.Args[0])
	fmt.Fprintf(os.Stderr, "\n")
	fmt.Fprintf(os.Stderr, "  --config:host    Generate a random host token, print the\n")
	fmt.Fprintf(os.Stderr, "                   https://<worker>/!config?host=<random> Allow URL,\n")
	fmt.Fprintf(os.Stderr, "                   then hold the MAIN WSS presence connection open\n")
	fmt.Fprintf(os.Stderr, "                   (green dot on the web UI while connected).\n")
	fmt.Fprintf(os.Stderr, "                   Aliases: --config-host, --config_host, --config.host\n")
	fmt.Fprintf(os.Stderr, "  --host ID        Host id (the CLI token). With --config:host it reuses\n")
	fmt.Fprintf(os.Stderr, "                   the id instead of generating a random one. With --tunnel\n")
	fmt.Fprintf(os.Stderr, "                   it selects which host serves the tunnel.\n")
	fmt.Fprintf(os.Stderr, "                   Alone (no --tunnel) it runs HOST MODE: hold the main\n")
	fmt.Fprintf(os.Stderr, "                   WSS and auto-serve every tunnel users create for this\n")
	fmt.Fprintf(os.Stderr, "                   host — the worker pushes tunnel-spec over the main wss,\n")
	fmt.Fprintf(os.Stderr, "                   no per-tunnel command needed.\n")
	fmt.Fprintf(os.Stderr, "  --tunnel SLUG    Public path slug like hello for /!tunnel=hello (2-32 chars:\n")
	fmt.Fprintf(os.Stderr, "                   a-z, 0-9, hyphen). Creates ONE per-tunnel WSS for data.\n")
	fmt.Fprintf(os.Stderr, "                   Run one process per tunnel (each = one wss).\n")
	fmt.Fprintf(os.Stderr, "                   Aliases: --slug\n")
	fmt.Fprintf(os.Stderr, "  --target ADDR    Local URL like 127.0.0.1:4757 to expose at /<slug>.\n")
	fmt.Fprintf(os.Stderr, "                   Aliases: --to, --upstream, --url-target\n")
	fmt.Fprintf(os.Stderr, "  --worker URL     Worker base URL (default %s,\n", cli.DefaultWorkerBase)
	fmt.Fprintf(os.Stderr, "                   env KS_TUNNEL_URL overrides).\n")
	fmt.Fprintf(os.Stderr, "\n")
	fmt.Fprintf(os.Stderr, "Examples:\n")
	fmt.Fprintf(os.Stderr, "  # 1) register this machine (main wss = cf <-> cli control):\n")
	fmt.Fprintf(os.Stderr, "  %s --config:host\n", os.Args[0])
	fmt.Fprintf(os.Stderr, "\n")
	fmt.Fprintf(os.Stderr, "  # 2) serve local :4757 at https://<worker>/!tunnel=hello (main wss + tunnel wss):\n")
	fmt.Fprintf(os.Stderr, "  %s --host <id-from-step-1> --tunnel hello --target 127.0.0.1:4757\n", os.Args[0])
	fmt.Fprintf(os.Stderr, "  # visit /!tunnel=hello -> fullscreen 127.0.0.1:4757 via wss (cli -> workers -> you)\n")
	fmt.Fprintf(os.Stderr, "\n")
	fmt.Fprintf(os.Stderr, "  # 3) host mode: auto-serve every tunnel users create for <id>:\n")
	fmt.Fprintf(os.Stderr, "  %s --host <id-from-step-1>\n", os.Args[0])
	fmt.Fprintf(os.Stderr, "  # the worker pushes tunnel-spec over the main wss; the CLI opens\n")
	fmt.Fprintf(os.Stderr, "  # one tunnel wss per published tunnel by itself\n")
}

func isConfigHostFlag(arg string) bool {
	switch arg {
	case "--config:host", "--config-host", "--config_host", "--config.host",
		"-config:host", "-config-host",
		"config:host", "config-host":
		return true
	}
	return false
}

func main() {
	configHost := false
	workerBase := cli.WorkerBaseURL()
	fixedHost := ""
	tunnelSlug := ""
	tunnelTarget := ""
	tunnelName := ""

	args := os.Args[1:]
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if isConfigHostFlag(arg) {
			configHost = true
			continue
		}
		if strings.HasPrefix(arg, "--worker=") {
			workerBase = strings.TrimRight(strings.TrimPrefix(arg, "--worker="), "/")
			continue
		}
		if arg == "--worker" && i+1 < len(args) {
			i++
			workerBase = strings.TrimRight(args[i], "/")
			continue
		}
		if strings.HasPrefix(arg, "--url=") && tunnelTarget == "" {
			// Ambiguous legacy flag: treat --url= as worker unless it looks
			// like host:port. Keep worker behaviour for compat.
			workerBase = strings.TrimRight(strings.TrimPrefix(arg, "--url="), "/")
			continue
		}
		if strings.HasPrefix(arg, "--host=") {
			fixedHost = strings.TrimSpace(strings.TrimPrefix(arg, "--host="))
			continue
		}
		if arg == "--host" && i+1 < len(args) {
			i++
			fixedHost = strings.TrimSpace(args[i])
			continue
		}
		if strings.HasPrefix(arg, "--tunnel=") {
			tunnelSlug = strings.TrimSpace(strings.TrimPrefix(arg, "--tunnel="))
			continue
		}
		if arg == "--tunnel" && i+1 < len(args) {
			i++
			tunnelSlug = strings.TrimSpace(args[i])
			continue
		}
		if strings.HasPrefix(arg, "--slug=") {
			tunnelSlug = strings.TrimSpace(strings.TrimPrefix(arg, "--slug="))
			continue
		}
		if arg == "--slug" && i+1 < len(args) {
			i++
			tunnelSlug = strings.TrimSpace(args[i])
			continue
		}
		if strings.HasPrefix(arg, "--target=") {
			tunnelTarget = strings.TrimSpace(strings.TrimPrefix(arg, "--target="))
			continue
		}
		if arg == "--target" && i+1 < len(args) {
			i++
			tunnelTarget = strings.TrimSpace(args[i])
			continue
		}
		if strings.HasPrefix(arg, "--to=") {
			tunnelTarget = strings.TrimSpace(strings.TrimPrefix(arg, "--to="))
			continue
		}
		if arg == "--to" && i+1 < len(args) {
			i++
			tunnelTarget = strings.TrimSpace(args[i])
			continue
		}
		if strings.HasPrefix(arg, "--upstream=") {
			tunnelTarget = strings.TrimSpace(strings.TrimPrefix(arg, "--upstream="))
			continue
		}
		if arg == "--upstream" && i+1 < len(args) {
			i++
			tunnelTarget = strings.TrimSpace(args[i])
			continue
		}
		if strings.HasPrefix(arg, "--name=") {
			tunnelName = strings.TrimSpace(strings.TrimPrefix(arg, "--name="))
			continue
		}
		if arg == "--name" && i+1 < len(args) {
			i++
			tunnelName = strings.TrimSpace(args[i])
			continue
		}
		switch arg {
		case "-h", "--help":
			usage()
			fmt.Println(cli.Hello())
			return
		case "-v", "--version":
			fmt.Println(cli.Version)
			return
		default:
			fmt.Fprintf(os.Stderr, "error: unknown argument %q\n", arg)
			usage()
			os.Exit(2)
		}
	}

	serveTunnel := strings.TrimSpace(tunnelSlug) != "" || strings.TrimSpace(tunnelTarget) != ""
	hostMode := strings.TrimSpace(fixedHost) != "" && !serveTunnel && !configHost

	if !configHost && !serveTunnel && !hostMode {
		fmt.Println(cli.Hello())
		return
	}

	// Resolve host id: explicit --host wins, otherwise fresh random (never fixed).
	hostID := fixedHost
	if hostID == "" {
		// --tunnel mode REQUIRES --host so /<slug> maps to the right machine.
		if serveTunnel && !configHost {
			fmt.Fprintf(os.Stderr, "error: --tunnel needs --host ID (pick the host from the Hosts page)\n")
			usage()
			os.Exit(2)
		}
		id, err := cli.GenerateHostID()
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: cannot generate host id: %v\n", err)
			os.Exit(1)
		}
		hostID = id
	} else if !cli.IsValidHostID(hostID) {
		fmt.Fprintf(os.Stderr, "error: invalid --host %q (want [A-Za-z0-9_-]{5,64})\n", hostID)
		os.Exit(1)
	}

	if serveTunnel {
		tunnelSlug = cli.NormalizeSlug(tunnelSlug)
		tunnelTarget = cli.NormalizeTarget(tunnelTarget)
		if !cli.IsValidSlug(tunnelSlug) {
			fmt.Fprintf(os.Stderr, "error: invalid --tunnel %q (want slug like hello for /!tunnel=hello)\n", tunnelSlug)
			os.Exit(2)
		}
		if !cli.IsValidTarget(tunnelTarget) {
			fmt.Fprintf(os.Stderr, "error: invalid --target %q (want like 127.0.0.1:4757)\n", tunnelTarget)
			os.Exit(2)
		}
	}

	if workerBase == "" {
		workerBase = cli.DefaultWorkerBase
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	logf := func(format string, a ...any) {
		fmt.Fprintf(os.Stderr, format+"\n", a...)
	}

	// Host mode: hold the MAIN wss and auto-serve whatever tunnels users
	// create for this host (worker pushes tunnel-spec over the main wss).
	if hostMode {
		fmt.Printf("Host: %s (host mode)\n", hostID)
		fmt.Printf("Worker: %s\n", strings.TrimRight(workerBase, "/"))
		fmt.Fprintf(os.Stderr, "Watching for tunnels — create one in the web UI and it is served automatically (Ctrl+C to stop)...\n")
		if err := cli.RunHost(ctx, workerBase, hostID, logf); err != nil && err != context.Canceled {
			if errors.Is(err, cli.ErrDenied) {
				fmt.Fprintf(os.Stderr, "Canceled by browser — host %s was not saved.\n", hostID)
				os.Exit(1)
			}
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
		return
	}

	// Tunnel-serve mode: hold BOTH sockets —
	//   main wss   (/api/agent/ws)            : control, cf <-> cli talk
	//   tunnel wss (/api/tunnels/ws?slug=...) : data, one per tunnel
	if serveTunnel {
		if tunnelName == "" {
			tunnelName = tunnelSlug
		}
		fmt.Printf("Host: %s\n", hostID)
		fmt.Printf("Tunnel: /!tunnel=%s -> %s\n", tunnelSlug, tunnelTarget)
		fmt.Printf("Public: %s/!tunnel=%s (fullscreen, via wss cli -> workers -> you)\n", strings.TrimRight(workerBase, "/"), tunnelSlug)
		wsURL, _ := cli.TunnelWSURLWithTarget(workerBase, hostID, tunnelSlug, tunnelTarget)
		mainURL, _ := cli.AgentWSURL(workerBase, hostID)
		fmt.Fprintf(os.Stderr, "main wss (control)  : %s\n", mainURL)
		fmt.Fprintf(os.Stderr, "tunnel wss (data)   : %s\n", wsURL)
		fmt.Fprintf(os.Stderr, "Serving — keep this running (Ctrl+C to stop, one process per tunnel)...\n")

		var wg sync.WaitGroup
		errCh := make(chan error, 2)
		wg.Add(2)
		go func() {
			defer wg.Done()
			errCh <- cli.RunAgent(ctx, workerBase, hostID, logf)
		}()
		go func() {
			defer wg.Done()
			errCh <- cli.RunTunnel(ctx, workerBase, hostID, tunnelSlug, tunnelTarget, logf)
		}()
		go func() {
			wg.Wait()
			close(errCh)
		}()
		var firstErr error
		for err := range errCh {
			if err != nil && err != context.Canceled && firstErr == nil {
				firstErr = err
			}
			// First fatal error stops everything.
			if err != nil && err != context.Canceled {
				stop()
				break
			}
		}
		if firstErr != nil {
			if errors.Is(firstErr, cli.ErrDenied) {
				fmt.Fprintf(os.Stderr, "Canceled by browser — host %s was not saved.\n", hostID)
				os.Exit(1)
			}
			// ctx cancel during shutdown is not an error.
			if errors.Is(firstErr, context.Canceled) || errors.Is(firstErr, context.DeadlineExceeded) && ctx.Err() != nil {
				return
			}
			fmt.Fprintf(os.Stderr, "error: %v\n", firstErr)
			os.Exit(1)
		}
		return
	}

	// Presence-only mode (--config:host): main wss only, wait for Allow/Cancel.
	allowURL := cli.ConfigURL(workerBase, hostID)

	fmt.Printf("Host: %s\n", hostID)
	fmt.Printf("Open to allow: %s\n", allowURL)
	fmt.Fprintf(os.Stderr, "Waiting for approval — keep this running (Ctrl+C to stop)...\n")

	if err := cli.RunAgent(ctx, workerBase, hostID, logf); err != nil && err != context.Canceled {
		if errors.Is(err, cli.ErrDenied) {
			fmt.Fprintf(os.Stderr, "Canceled by browser — host %s was not saved.\n", hostID)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}
