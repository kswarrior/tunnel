package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/kswarrior/tunnel/cli"
)

func usage() {
	fmt.Fprintf(os.Stderr, "Usage: %s [--help] [--version] [--config:host] [--worker URL]\n", os.Args[0])
	fmt.Fprintf(os.Stderr, "\n")
	fmt.Fprintf(os.Stderr, "  --config:host    Generate a random host token, print the\n")
	fmt.Fprintf(os.Stderr, "                   https://<worker>/!config?host=<random> Allow URL,\n")
	fmt.Fprintf(os.Stderr, "                   then hold the WSS presence connection open\n")
	fmt.Fprintf(os.Stderr, "                   (green dot on the web UI while connected).\n")
	fmt.Fprintf(os.Stderr, "                   Aliases: --config-host, --config_host, --config.host\n")
	fmt.Fprintf(os.Stderr, "  --worker URL     Worker base URL (default %s,\n", kstunnel.DefaultWorkerBase)
	fmt.Fprintf(os.Stderr, "                   env KS_TUNNEL_URL overrides).\n")
	fmt.Fprintf(os.Stderr, "  --host ID        Reuse a host id instead of generating a random one.\n")
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
	workerBase := kstunnel.WorkerBaseURL()
	fixedHost := ""

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
		if strings.HasPrefix(arg, "--url=") {
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
		switch arg {
		case "-h", "--help":
			usage()
			fmt.Println(kstunnel.Hello())
			return
		case "-v", "--version":
			fmt.Println(kstunnel.Version)
			return
		default:
			fmt.Fprintf(os.Stderr, "error: unknown argument %q\n", arg)
			usage()
			os.Exit(2)
		}
	}

	if !configHost {
		fmt.Println(kstunnel.Hello())
		return
	}

	// Resolve host id: explicit --host wins, otherwise fresh random (never fixed).
	hostID := fixedHost
	if hostID == "" {
		id, err := kstunnel.GenerateHostID()
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: cannot generate host id: %v\n", err)
			os.Exit(1)
		}
		hostID = id
	} else if !kstunnel.IsValidHostID(hostID) {
		fmt.Fprintf(os.Stderr, "error: invalid --host %q (want [A-Za-z0-9_-]{5,64})\n", hostID)
		os.Exit(1)
	}

	if workerBase == "" {
		workerBase = kstunnel.DefaultWorkerBase
	}
	allowURL := kstunnel.ConfigURL(workerBase, hostID)

	fmt.Printf("Host: %s\n", hostID)
	fmt.Printf("Open to allow: %s\n", allowURL)
	fmt.Fprintf(os.Stderr, "Waiting for approval — keep this running (Ctrl+C to stop)...\n")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	logf := func(format string, a ...any) {
		fmt.Fprintf(os.Stderr, format+"\n", a...)
	}
	if err := kstunnel.RunAgent(ctx, workerBase, hostID, logf); err != nil && err != context.Canceled {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}
