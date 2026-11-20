package kstunnel

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	cloudflaredURLPattern = regexp.MustCompile(`https://[A-Za-z0-9.-]+\.trycloudflare\.com`)
	localtunnelURLPattern = regexp.MustCompile(`https://[A-Za-z0-9.-]+\.loca\.lt`)
	ansiPattern           = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)
)

type tunnelRequest struct {
	ID       string
	Name     string
	Provider string
	IP       string
	Port     int
	Type     string
}

type tunnelManager struct {
	holder  *clientHolder
	mu      sync.Mutex
	tunnels map[string]*runningTunnel
}

type runningTunnel struct {
	cmd    *exec.Cmd
	cancel context.CancelFunc
}

func newTunnelManager(holder *clientHolder) *tunnelManager {
	return &tunnelManager{
		holder:  holder,
		tunnels: make(map[string]*runningTunnel),
	}
}

func (m *tunnelManager) start(request tunnelRequest) {
	m.mu.Lock()
	_, exists := m.tunnels[request.ID]
	m.mu.Unlock()

	if exists {
		return
	}

	go func() {
		publicURL, err := m.run(request)
		if err != nil {
			log.Printf("tunnel %q failed: %v", request.Name, err)
			_ = m.holder.send(map[string]string{
				"type":     "tunnel_error",
				"tunnelId": request.ID,
				"error":    err.Error(),
			})
			return
		}

		log.Printf("tunnel %q is live: %s", request.Name, publicURL)
		_ = m.holder.send(map[string]string{
			"type":     "tunnel_created",
			"tunnelId": request.ID,
			"url":      publicURL,
		})
	}()
}

func (m *tunnelManager) run(request tunnelRequest) (string, error) {
	if request.ID == "" {
		return "", errors.New("missing tunnel id")
	}
	if request.Port < 1 || request.Port > 65535 {
		return "", fmt.Errorf("invalid port %d", request.Port)
	}

	tunnelType := strings.ToLower(strings.TrimSpace(request.Type))
	if tunnelType == "tcp" || tunnelType == "udp" {
		return "", fmt.Errorf("%s tunnels are not supported by the CLI provider", strings.ToUpper(tunnelType))
	}

	ip := strings.TrimSpace(request.IP)
	if ip == "" {
		ip = "localhost"
	}

	target := fmt.Sprintf("http://%s", net.JoinHostPort(ip, strconv.Itoa(request.Port)))

	command, args, pattern, err := providerCommand(request.Provider, request.Port, target)
	if err != nil {
		return "", err
	}

	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Env = append(os.Environ(), "NO_COLOR=1")

	urlChannel := make(chan string, 1)
	output := &lineScanner{
		handle: func(line string) {
			match := pattern.FindString(line)
			if match == "" {
				return
			}

			select {
			case urlChannel <- match:
			default:
			}
		},
	}

	cmd.Stdout = output
	cmd.Stderr = output

	if err := cmd.Start(); err != nil {
		cancel()
		return "", fmt.Errorf("start %s: %w", command, err)
	}

	running := &runningTunnel{cmd: cmd, cancel: cancel}
	m.add(request.ID, running)

	success := false
	defer func() {
		if !success {
			cancel()
			m.remove(request.ID, running)
		}
	}()

	waitChannel := make(chan error, 1)
	go func() {
		waitChannel <- cmd.Wait()
		m.remove(request.ID, running)
	}()

	timeout := time.NewTimer(75 * time.Second)
	defer timeout.Stop()

	select {
	case publicURL := <-urlChannel:
		success = true
		return publicURL, nil
	case waitErr := <-waitChannel:
		if waitErr == nil {
			waitErr = errors.New("provider exited before reporting a URL")
		}
		return "", fmt.Errorf("%s: %w", command, waitErr)
	case <-timeout.C:
		return "", fmt.Errorf("%s did not report a URL within 75 seconds", command)
	}
}

func providerCommand(provider string, port int, target string) (string, []string, *regexp.Regexp, error) {
	name := strings.ToLower(strings.TrimSpace(provider))

	if strings.Contains(name, "local") {
		path, err := exec.LookPath("npx")
		if err != nil {
			return "", nil, nil, errors.New("npx is required for the localtunnel provider")
		}

		return path, localtunnelArgs(port), localtunnelURLPattern, nil
	}

	if path, err := exec.LookPath("cloudflared"); err == nil {
		return path, []string{
			"tunnel",
			"--url", target,
			"--no-autoupdate",
		}, cloudflaredURLPattern, nil
	}

	path, err := exec.LookPath("npx")
	if err != nil {
		return "", nil, nil, errors.New("cloudflared is not installed and npx is unavailable")
	}

	log.Print("cloudflared was not found; falling back to localtunnel")

	return path, localtunnelArgs(port), localtunnelURLPattern, nil
}

func localtunnelArgs(port int) []string {
	return []string{"--yes", "localtunnel", "--port", strconv.Itoa(port)}
}

func (m *tunnelManager) add(id string, tunnel *runningTunnel) {
	m.mu.Lock()
	m.tunnels[id] = tunnel
	m.mu.Unlock()
}

func (m *tunnelManager) remove(id string, tunnel *runningTunnel) {
	m.mu.Lock()
	if m.tunnels[id] == tunnel {
		delete(m.tunnels, id)
	}
	m.mu.Unlock()
}

func (m *tunnelManager) stopAll() {
	m.mu.Lock()
	tunnels := make([]*runningTunnel, 0, len(m.tunnels))
	for _, tunnel := range m.tunnels {
		tunnels = append(tunnels, tunnel)
	}
	m.tunnels = make(map[string]*runningTunnel)
	m.mu.Unlock()

	for _, tunnel := range tunnels {
		tunnel.cancel()
	}
}

type lineScanner struct {
	mu     sync.Mutex
	buffer []byte
	handle func(string)
}

func (s *lineScanner) Write(data []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.buffer = append(s.buffer, data...)

	for {
		index := bytes.IndexByte(s.buffer, '\n')
		if index < 0 {
			break
		}

		line := stripANSI(string(s.buffer[:index]))
		s.buffer = s.buffer[index+1:]

		if s.handle != nil {
			s.handle(line)
		}
	}

	if len(s.buffer) > 1<<20 {
		s.buffer = s.buffer[len(s.buffer)-(1<<20):]
	}

	return len(data), nil
}

func stripANSI(value string) string {
	return ansiPattern.ReplaceAllString(value, "")
}
