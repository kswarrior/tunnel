package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

const (
	defaultConnectionURL = "https://raw.githubusercontent.com/kswarrior/tunnel/refs/heads/main/connection.json"
	defaultServer        = "https://tunnel-jn0j.onrender.com"
	readWait             = 75 * time.Second
)

var errRejected = errors.New("agent request rejected")

type connectionConfig struct {
	URL    string `json:"url"`
	Server string `json:"server"`
}

type serverMessage struct {
	Type   string `json:"type"`
	Tunnel struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Provider string `json:"provider"`
		IP       string `json:"ip"`
		Port     int    `json:"port"`
		Type     string `json:"type"`
	} `json:"tunnel"`
}

type wsClient struct {
	conn    *websocket.Conn
	writeMu sync.Mutex
}

func (c *wsClient) writeJSON(value any) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	if err := c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return err
	}

	return c.conn.WriteJSON(value)
}

type clientHolder struct {
	mu     sync.Mutex
	client *wsClient
}

func (h *clientHolder) set(client *wsClient) {
	h.mu.Lock()
	h.client = client
	h.mu.Unlock()
}

func (h *clientHolder) clear(client *wsClient) {
	h.mu.Lock()
	if h.client == client {
		h.client = nil
	}
	h.mu.Unlock()
}

func (h *clientHolder) send(value any) error {
	h.mu.Lock()
	client := h.client
	h.mu.Unlock()

	if client == nil {
		return errors.New("not connected")
	}

	return client.writeJSON(value)
}

func main() {
	var (
		serverFlag     string
		nameFlag       string
		connectionFlag string
	)

	flag.StringVar(&serverFlag, "server", "", "Base URL of the KS Tunnel web app")
	flag.StringVar(&nameFlag, "name", "", "Agent name (defaults to the hostname)")
	flag.StringVar(&connectionFlag, "connection", defaultConnectionURL, "URL of connection.json")
	flag.Parse()

	log.SetFlags(0)
	log.SetPrefix("[kstunnel] ")

	base := resolveServer(serverFlag, connectionFlag)

	token, err := newToken(10)
	if err != nil {
		log.Fatalf("generate token: %v", err)
	}

	name := strings.TrimSpace(nameFlag)
	if name == "" {
		host, err := os.Hostname()
		if err != nil || strings.TrimSpace(host) == "" {
			host = "agent"
		}
		name = host
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	holder := &clientHolder{}
	manager := newTunnelManager(holder)
	defer manager.stopAll()

	backoff := time.Second

	for {
		if ctx.Err() != nil {
			return
		}

		err := runAgent(ctx, base, token, name, holder, manager)
		if errors.Is(err, errRejected) {
			log.Print("agent request was cancelled in the web app")
			return
		}
		if ctx.Err() != nil {
			return
		}

		log.Printf("disconnected: %v; reconnecting in %s", err, backoff)

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}

		backoff *= 2
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
}

func resolveServer(serverFlag, connectionURL string) string {
	if value := strings.TrimSpace(serverFlag); value != "" {
		return normalizeServer(value)
	}

	if value := strings.TrimSpace(os.Getenv("KS_TUNNEL_SERVER")); value != "" {
		return normalizeServer(value)
	}

	client := &http.Client{Timeout: 15 * time.Second}
	response, err := client.Get(connectionURL)
	if err == nil {
		defer response.Body.Close()

		if response.StatusCode == http.StatusOK {
			data, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20))
			if readErr == nil {
				var config connectionConfig
				if json.Unmarshal(data, &config) == nil {
					candidate := strings.TrimSpace(config.URL)
					if candidate == "" {
						candidate = strings.TrimSpace(config.Server)
					}
					if candidate != "" {
						return normalizeServer(candidate)
					}
				}
			}
		}
	}

	log.Printf("could not read %s, using %s", connectionURL, defaultServer)
	return defaultServer
}

func normalizeServer(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return defaultServer
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	return strings.TrimRight(raw, "/")
}

func newToken(length int) (string, error) {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

	buffer := make([]byte, length)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}

	for i := range buffer {
		buffer[i] = alphabet[int(buffer[i])%len(alphabet)]
	}

	return string(buffer), nil
}

func runAgent(ctx context.Context, base, token, name string, holder *clientHolder, manager *tunnelManager) error {
	wsURL, err := buildWebSocketURL(base, token, name)
	if err != nil {
		return err
	}

	dialer := websocket.Dialer{
		HandshakeTimeout: 15 * time.Second,
		Proxy:            http.ProxyFromEnvironment,
	}

	conn, response, err := dialer.DialContext(ctx, wsURL, nil)
	if err != nil {
		if response != nil {
			response.Body.Close()
		}
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.Close()

	claimURL := strings.TrimRight(base, "/") + "/token=" + token
	fmt.Printf("\nConnected to %s\n", base)
	fmt.Printf("Open this link to approve this agent:\n\n  %s\n\nWaiting for approval...\n\n", claimURL)

	client := &wsClient{conn: conn}
	holder.set(client)
	defer holder.clear(client)

	_ = conn.SetReadDeadline(time.Now().Add(readWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(readWait))
	})
	conn.SetPingHandler(func(data string) error {
		_ = conn.SetReadDeadline(time.Now().Add(readWait))
		return conn.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(10*time.Second))
	})

	done := make(chan error, 1)
	go func() {
		done <- client.readLoop(manager)
	}()

	select {
	case <-ctx.Done():
		_ = conn.Close()
		return ctx.Err()
	case err := <-done:
		return err
	}
}

func (c *wsClient) readLoop(manager *tunnelManager) error {
	for {
		var message serverMessage
		if err := c.conn.ReadJSON(&message); err != nil {
			return err
		}

		switch message.Type {
		case "pending":
			log.Print("waiting for approval in the web app")
		case "approved":
			log.Print("agent approved; ready to create tunnels")
		case "rejected":
			return errRejected
		case "create_tunnel":
			manager.start(tunnelRequest{
				ID:       message.Tunnel.ID,
				Name:     message.Tunnel.Name,
				Provider: message.Tunnel.Provider,
				IP:       message.Tunnel.IP,
				Port:     message.Tunnel.Port,
				Type:     message.Tunnel.Type,
			})
		}
	}
}

func buildWebSocketURL(base, token, name string) (string, error) {
	parsed, err := url.Parse(base)
	if err != nil {
		return "", err
	}

	switch parsed.Scheme {
	case "http":
		parsed.Scheme = "ws"
	case "https":
		parsed.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", fmt.Errorf("unsupported server scheme %q", parsed.Scheme)
	}

	parsed.Path = path.Join(strings.TrimRight(parsed.Path, "/"), "/ws/agent")

	query := parsed.Query()
	query.Set("token", token)
	query.Set("name", name)
	parsed.RawQuery = query.Encode()

	return parsed.String(), nil
}
