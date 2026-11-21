package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"

	kstunnel "github.com/kswarrior/tunnel/cli"
)

func usage() {
	out := flag.CommandLine.Output()
	fmt.Fprintf(out, `kstunnel %s

Connect a machine to KS Tunnel.

Create an agent on the Agents page in the web app to get a token, then run:

  kstunnel --token <token>

Usage:
  kstunnel --token <token> [options]

Options:
`, kstunnel.Version)
	flag.PrintDefaults()
}

func main() {
	var (
		tokenFlag      string
		serverFlag     string
		nameFlag       string
		connectionFlag string
		versionFlag    bool
	)

	flag.Usage = usage
	flag.StringVar(&tokenFlag, "token", "", "Agent token from the web app (required)")
	flag.StringVar(&serverFlag, "server", "", "Base URL of the KS Tunnel web app")
	flag.StringVar(&nameFlag, "name", "", "Agent name (defaults to the name from the web app)")
	flag.StringVar(&connectionFlag, "connection", kstunnel.DefaultConnectionURL, "URL of connection.json")
	flag.BoolVar(&versionFlag, "version", false, "Print the kstunnel version")
	flag.Parse()

	if flag.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "kstunnel: unexpected argument %q\n\n", flag.Arg(0))
		usage()
		os.Exit(1)
	}

	if versionFlag {
		fmt.Printf("kstunnel %s\n", kstunnel.Version)
		return
	}

	if len(os.Args) == 1 {
		usage()
		return
	}

	token := strings.TrimSpace(tokenFlag)
	if token == "" {
		fmt.Fprintln(os.Stderr, "kstunnel: --token is required.")
		fmt.Fprintln(os.Stderr)
		usage()
		os.Exit(1)
	}

	log.SetFlags(0)
	log.SetPrefix("[kstunnel] ")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	err := kstunnel.Run(ctx, kstunnel.Options{
		Token:         token,
		Server:        serverFlag,
		Name:          nameFlag,
		ConnectionURL: connectionFlag,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "kstunnel: %v\n", err)
		os.Exit(1)
	}
}
