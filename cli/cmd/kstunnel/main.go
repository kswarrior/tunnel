package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	kstunnel "github.com/kswarrior/tunnel/cli"
)

func main() {
	var (
		serverFlag     string
		nameFlag       string
		connectionFlag string
		versionFlag    bool
	)

	flag.StringVar(&serverFlag, "server", "", "Base URL of the KS Tunnel web app")
	flag.StringVar(&nameFlag, "name", "", "Agent name (defaults to the hostname)")
	flag.StringVar(&connectionFlag, "connection", kstunnel.DefaultConnectionURL, "URL of connection.json")
	flag.BoolVar(&versionFlag, "version", false, "Print the kstunnel version")
	flag.Parse()

	if versionFlag {
		fmt.Printf("kstunnel %s\n", kstunnel.Version)
		return
	}

	log.SetFlags(0)
	log.SetPrefix("[kstunnel] ")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	err := kstunnel.Run(ctx, kstunnel.Options{
		Server:        serverFlag,
		Name:          nameFlag,
		ConnectionURL: connectionFlag,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "kstunnel: %v\n", err)
		os.Exit(1)
	}
}
