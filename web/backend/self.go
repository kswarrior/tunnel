package main

import (
	"encoding/json"
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
	defaultConnectionURL = "https://raw.githubusercontent.com/kswarrior/tunnel/refs/heads/main/connection.json"
	defaultSelfServer    = "https://tunnel-jn0j.onrender.com"
	selfAgentID          = "self"
	selfAgentName        = "web"
	selfReadWait         = 75 * time.Second
	selfPingPeriod       = 25 * time.Second
)

type connectionConfig struct {
	URL    string `json:"url"`
	Server string `json:"server"`
	WSS    string `json:"wss"`
}

func (s *store) ensureSelfAgent() (Agent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, agent := range s.state.Agents {
		if agent.ID == selfAgentID {
			return agent, nil
		}
	}

	token, err := newAgentToken()
	if err != nil {
		return Agent{}, err
	}

	agent := Agent{
		ID:        selfAgentID,
		Name:      selfAgentName,
		Token:     token,
		CreatedAt: time.Now().UTC(),
	}

	s.state.Agents = append(s.state.Agents, agent)
	if err := s.saveLocked(); err != nil {
		s.state.Agents = s.state.Agents[:len(s.state.Agents)-1]
		return Agent{}, err
	}

	return agent, nil
}

func loadConnectionConfig() connectionConfig {
	connectionURL := strings.TrimSpace(os.Getenv("KS_CONNECTION_URL"))
	if connectionURL == "" {
		connectionURL = defaultConnectionURL
	}

	client := &http.Client{Timeout: 10 * time.Second}
	response, err := client.Get(connectionURL)
	if err == nil {
		defer response.Body.Close()

		if response.StatusCode == http.StatusOK {
			data, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20))
			if readErr == nil {
				var config connectionConfig
				if json.Unmarshal(data, &config) == nil {
					return config
				}
			}
		}
	}

	log.Printf("self agent: could not read %s", connectionURL)
	return connectionConfig{}
}

func selfWebSocketURL(config connectionConfig, token, name string) (string, error) {
	if raw := strings.TrimSpace(os.Getenv("KS_SELF_WSS")); raw != "" {
		return buildAgentWebSocketURL(raw, token, name)
	}

	if raw := strings.TrimSpace(config.WSS); raw != "" {
		return buildAgentWebSocketURL(raw, token, name)
	}

	base := strings.TrimSpace(os.Getenv("KS_SELF_URL"))
	if base == "" {
		base = strings.TrimSpace(os.Getenv("KS_PUBLIC_URL"))
	}
	if base == "" {
		base = strings.TrimSpace(config.URL)
	}
	if base == "" {
		base = strings.TrimSpace(config.Server)
	}
	if base == "" {
		base = defaultSelfServer
	}

	return buildAgentWebSocketURL(base, token, name)
}

func buildAgentWebSocketURL(base, token, name string) (string, error) {
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

	if !strings.HasSuffix(strings.TrimRight(parsed.Path, "/"), "/ws/agent") {
		parsed.Path = path.Join(strings.TrimRight(parsed.Path, "/"), "/ws/agent")
	}

	query := parsed.Query()
	query.Set("token", token)
	if name != "" {
		query.Set("name", name)
	}
	parsed.RawQuery = query.Encode()

	return parsed.String(), nil
}

func selfLogURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	return parsed.Scheme + "://" + parsed.Host + parsed.Path
}

func startSelfAgent(dataStore *store) {
	go func() {
		config := loadConnectionConfig()
		backoff := time.Second

		for {
			agent, err := dataStore.ensureSelfAgent()
			if err != nil {
				log.Printf("self agent: %v", err)
				time.Sleep(backoff)
				backoff = nextSelfBackoff(backoff)
				continue
			}

			wsURL, err := selfWebSocketURL(config, agent.Token, agent.Name)
			if err != nil {
				log.Printf("self agent: %v", err)
				time.Sleep(backoff)
				backoff = nextSelfBackoff(backoff)
				continue
			}

			dialer := websocket.Dialer{
				HandshakeTimeout: 15 * time.Second,
				Proxy:            http.ProxyFromEnvironment,
			}

			conn, _, err := dialer.Dial(wsURL, nil)
			if err != nil {
				log.Printf("self agent: connect %s: %v", selfLogURL(wsURL), err)
				time.Sleep(backoff)
				backoff = nextSelfBackoff(backoff)
				continue
			}

			backoff = time.Second
			log.Printf("self agent: connected to %s", selfLogURL(wsURL))

			err = runSelfAgent(conn, agent)
			_ = conn.Close()

			if err != nil {
				log.Printf("self agent: disconnected: %v", err)
			}

			time.Sleep(time.Second)
		}
	}()
}

func runSelfAgent(conn *websocket.Conn, agent Agent) error {
	_ = conn.SetReadDeadline(time.Now().Add(selfReadWait))
	conn.SetPingHandler(func(data string) error {
		_ = conn.SetReadDeadline(time.Now().Add(selfReadWait))
		return conn.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(writeWait))
	})
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(selfReadWait))
	})

	var writeMu sync.Mutex
	writeJSON := func(value any) error {
		writeMu.Lock()
		defer writeMu.Unlock()

		_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
		return conn.WriteJSON(value)
	}

	if err := writeJSON(map[string]string{
		"type":    "online",
		"agentId": agent.ID,
		"name":    agent.Name,
	}); err != nil {
		return err
	}

	done := make(chan struct{})
	defer close(done)

	go func() {
		ticker := time.NewTicker(selfPingPeriod)
		defer ticker.Stop()

		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				writeMu.Lock()
				err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait))
				writeMu.Unlock()
				if err != nil {
					_ = conn.Close()
					return
				}
			}
		}
	}()

	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return err
		}
		_ = conn.SetReadDeadline(time.Now().Add(selfReadWait))
	}
}

func nextSelfBackoff(current time.Duration) time.Duration {
	current *= 2
	if current > 30*time.Second {
		return 30 * time.Second
	}
	return current
}
