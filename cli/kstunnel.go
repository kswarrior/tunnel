// Package kstunnel is the library for KS Tunnel.
//
// The CLI in cmd/kstunnel is a thin wrapper around this library.
package kstunnel

// Version is the library/binary version.
// Declared as var (not const) so release builds can override it via:
//
//	go build -ldflags "-X github.com/kswarrior/tunnel/cli.Version=<ver>"
var Version = "0.1.0"

// Hello returns a hello-world string. Placeholder until tunnel agent lands.
func Hello() string {
	return "Hello World from kstunnel v" + Version
}
