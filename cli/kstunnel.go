// Package kstunnel is the library behind the KS Tunnel agent CLI.
//
// The command in cmd/kstunnel is a thin wrapper around this package.
package kstunnel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// Version is the library and CLI version.
	Version = "0.2.0"

	// DefaultConnectionURL points at the shared connection.json file.
	DefaultConnectionURL = "https://raw.githubusercontent.com/kswarrior/tunnel/refs/heads/main/connection.json"

	// DefaultServer is used when connection.json cannot be loaded.
	DefaultServer = "https://tunnel-jn0j.onrender.com"

	readWait = 75 * time.Second
)

// Options configures a KS Tunnel agent session.
type Options struct {
	// Token is the agent token created in the web app.
	Token string
	// Server overrides the web app URL from connection.json.
	Server string
	// Name optionally overrides the agent name from the web app.
	Name string
	// ConnectionURL is the connection.json location.
	ConnectionURL string
}

var errInvalidToken = errors.New("invalid agent token")

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

// Run connects the agent to the web app and serves tunnel requests until the
// context is cancelled.
func Run(ctx context.Context, options Options) error {
	connectionURL := strings.TrimSpace(options.ConnectionURL)
	if connectionURL == "" {
		connectionURL = DefaultConnectionURL
	}

	base := resolveServer(options.Server, connectionURL)

	token := strings.TrimSpace(options.Token)
	if token == "" {
		return errors.New("agent token is required")
	}

	name := strings.TrimSpace(options.Name)

	holder := &clientHolder{}
	manager := newTunnelManager(holder)
	defer manager.stopAll()

	backoff := time.Second

	for {
		if ctx.Err() != nil {
			return nil
		}

		err := runAgent(ctx, base, token, name, holder, manager)
		if errors.Is(err, errInvalidToken) {
			return err
		}
		if ctx.Err() != nil {
			return nil
		}

		log.Printf("disconnected: %v; reconnecting in %s", err, backoff)

		select {
		case <-ctx.Done():
			return nil
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

	log.Printf("could not read %s, using %s", connectionURL, DefaultServer)
	return DefaultServer
}

func normalizeServer(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return DefaultServer
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	return strings.TrimRight(raw, "/")
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
			switch response.StatusCode {
			case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound:
				return fmt.Errorf("%w: create an agent in the web app to get a valid token", errInvalidToken)
			}
		}
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.Close()

	fmt.Printf("\nConnected to %s\n\n", base)

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
	if name != "" {
		query.Set("name", name)
	}
	parsed.RawQuery = query.Encode()

	return parsed.String(), nil
}
