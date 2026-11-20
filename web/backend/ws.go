package main

import (
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 70 * time.Second
	pingPeriod     = 25 * time.Second
	maxMessageSize = 1 << 20
)

var errAgentOffline = errors.New("agent is offline")

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type agentHub struct {
	mu    sync.Mutex
	conns map[string]*agentConn
}

func newAgentHub() *agentHub {
	return &agentHub{conns: make(map[string]*agentConn)}
}

func (h *agentHub) set(token string, conn *agentConn) *agentConn {
	h.mu.Lock()
	previous := h.conns[token]
	h.conns[token] = conn
	h.mu.Unlock()

	return previous
}

func (h *agentHub) remove(token string, conn *agentConn) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.conns[token] != conn {
		return false
	}

	delete(h.conns, token)
	return true
}

func (h *agentHub) connected(token string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	conn, ok := h.conns[token]
	return ok && !conn.closed.Load()
}

func (h *agentHub) send(token string, message any) error {
	h.mu.Lock()
	conn := h.conns[token]
	h.mu.Unlock()

	if conn == nil || conn.closed.Load() {
		return errAgentOffline
	}

	return conn.writeJSON(message)
}

func (h *agentHub) close(token string) {
	h.mu.Lock()
	conn := h.conns[token]
	h.mu.Unlock()

	if conn != nil {
		conn.close()
	}
}

type agentConn struct {
	ws        *websocket.Conn
	writeMu   sync.Mutex
	done      chan struct{}
	closeOnce sync.Once
	closed    atomic.Bool
}

func newAgentConn(ws *websocket.Conn) *agentConn {
	return &agentConn{
		ws:   ws,
		done: make(chan struct{}),
	}
}

func (c *agentConn) writeJSON(value any) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	if err := c.ws.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
		return err
	}

	return c.ws.WriteJSON(value)
}

func (c *agentConn) writeControl(messageType int, data []byte, deadline time.Time) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	return c.ws.WriteControl(messageType, data, deadline)
}

func (c *agentConn) close() {
	c.closeOnce.Do(func() {
		c.closed.Store(true)
		close(c.done)

		_ = c.writeControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
			time.Now().Add(time.Second),
		)
		_ = c.ws.Close()
	})
}

type agentMessage struct {
	Type     string `json:"type"`
	TunnelID string `json:"tunnelId"`
	URL      string `json:"url"`
	Error    string `json:"error"`
}

type agentTunnel struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Provider string `json:"provider"`
	IP       string `json:"ip"`
	Port     int    `json:"port"`
	Type     string `json:"type"`
}

type createTunnelMessage struct {
	Type   string      `json:"type"`
	Tunnel agentTunnel `json:"tunnel"`
}

func validAgentToken(token string) bool {
	if len(token) < 6 || len(token) > 64 {
		return false
	}

	for _, char := range token {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') {
			return false
		}
	}

	return true
}

func (s *server) agentSocket(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if !validAgentToken(token) {
		writeError(w, http.StatusBadRequest, "Invalid agent token.")
		return
	}

	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if len(name) > 64 {
		name = name[:64]
	}
	if name == "" {
		name = "agent-" + token[:6]
	}

	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade agent connection: %v", err)
		return
	}

	agent, err := s.store.connectAgent(token, name)
	if errors.Is(err, errAgentRejected) {
		_ = ws.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "Agent request rejected"),
			time.Now().Add(time.Second),
		)
		_ = ws.Close()
		return
	}
	if err != nil {
		log.Printf("connect agent: %v", err)
		_ = ws.Close()
		return
	}

	conn := newAgentConn(ws)
	if previous := s.hub.set(token, conn); previous != nil {
		previous.close()
	}

	log.Printf("agent connected: %s (%s)", agent.Name, agent.ID)

	if agent.Authorized {
		if err := conn.writeJSON(map[string]string{"type": "approved"}); err != nil {
			log.Printf("notify agent: %v", err)
		}
	} else {
		if err := conn.writeJSON(map[string]string{"type": "pending"}); err != nil {
			log.Printf("notify agent: %v", err)
		}
	}

	go s.readAgent(conn, agent)
	go s.pingAgent(conn)
}

func (s *server) readAgent(conn *agentConn, agent Agent) {
	defer func() {
		if s.hub.remove(agent.Token, conn) {
			log.Printf("agent disconnected: %s (%s)", agent.Name, agent.ID)
			s.store.failPendingTunnelsForAgent(agent.ID, "Agent disconnected.")
		}
		conn.close()
	}()

	conn.ws.SetReadLimit(maxMessageSize)
	_ = conn.ws.SetReadDeadline(time.Now().Add(pongWait))
	conn.ws.SetPongHandler(func(string) error {
		return conn.ws.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		var message agentMessage
		if err := conn.ws.ReadJSON(&message); err != nil {
			return
		}

		switch message.Type {
		case "tunnel_created":
			if message.TunnelID == "" || message.URL == "" {
				continue
			}
			s.store.setTunnelResult(message.TunnelID, message.URL, "")
		case "tunnel_error":
			if message.TunnelID == "" {
				continue
			}
			s.store.setTunnelResult(message.TunnelID, "", message.Error)
		}
	}
}

func (s *server) pingAgent(conn *agentConn) {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()

	for {
		select {
		case <-conn.done:
			return
		case <-ticker.C:
			if err := conn.writeControl(websocket.PingMessage, nil, time.Now().Add(writeWait)); err != nil {
				conn.close()
				return
			}
		}
	}
}
