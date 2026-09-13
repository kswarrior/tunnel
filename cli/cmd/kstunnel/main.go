package main

import (
	"fmt"
	"os"

	"github.com/kswarrior/tunnel/cli"
)

func usage() {
	fmt.Fprintf(os.Stderr, "Usage: %s [--help] [--version]\n", os.Args[0])
}

func main() {
	for _, arg := range os.Args[1:] {
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
	fmt.Println(kstunnel.Hello())
}
