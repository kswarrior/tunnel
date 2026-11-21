package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Provider struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
}

type Agent struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Token       string     `json:"token"`
	CreatedAt   time.Time  `json:"createdAt"`
	ConnectedAt *time.Time `json:"connectedAt,omitempty"`
}

type Tunnel struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	ProviderID string    `json:"providerId"`
	AgentID    string    `json:"agentId"`
	IP         string    `json:"ip"`
	Port       int       `json:"port"`
	Type       string    `json:"type"`
	Slug       string    `json:"slug,omitempty"`
	AliasPath  string    `json:"aliasPath,omitempty"`
	PublicURL  string    `json:"publicUrl"`
	CurrentURL string    `json:"currentUrl,omitempty"`
	Status     string    `json:"status"`
	Error      string    `json:"error,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
}

type state struct {
	Providers []Provider `json:"providers"`
	Agents    []Agent    `json:"agents"`
	Tunnels   []Tunnel   `json:"tunnels"`
}

type store struct {
	mu    sync.Mutex
	path  string
	state state
}

var (
	errUnknownProvider = errors.New("provider not found")
	errUnknownAgent    = errors.New("agent not found")
	errUnknownTunnel   = errors.New("tunnel not found")
	errProviderInUse   = errors.New("provider is used by a tunnel")
	errAgentInUse      = errors.New("agent is used by a tunnel")
	errSlugInUse       = errors.New("slug is already used by another tunnel")
)

func newStore(path, baseURL string) (*store, error) {
	s := &store{path: path}

	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		if err := json.Unmarshal(data, &s.state); err != nil {
			return nil, fmt.Errorf("read data file: %w", err)
		}
		if s.state.Providers == nil {
			s.state.Providers = []Provider{}
		}
		if s.state.Agents == nil {
			s.state.Agents = []Agent{}
		}
		if s.state.Tunnels == nil {
			s.state.Tunnels = []Tunnel{}
		}

		changed := false
		for i := range s.state.Tunnels {
			tunnel := &s.state.Tunnels[i]
			if tunnel.Status == "" {
				tunnel.Status = "active"
				changed = true
			}
			if tunnel.AliasPath == "" {
				tunnel.AliasPath = "/t/" + tunnel.ID
				if tunnel.CurrentURL == "" && strings.HasPrefix(tunnel.PublicURL, "http") {
					tunnel.CurrentURL = tunnel.PublicURL
				}
				changed = true
			}
			tunnel.PublicURL = baseURL + tunnel.AliasPath
		}
		if changed {
			if err := s.saveLocked(); err != nil {
				return nil, err
			}
		}
		return s, nil
	case errors.Is(err, os.ErrNotExist):
		s.state = state{
			Providers: []Provider{{
				ID:        "cloudflare",
				Name:      "Cloudflare",
				CreatedAt: time.Now().UTC(),
			}},
			Agents:  []Agent{},
			Tunnels: []Tunnel{},
		}
		if err := s.saveLocked(); err != nil {
			return nil, err
		}
		return s, nil
	default:
		return nil, fmt.Errorf("read data file: %w", err)
	}
}

func tunnelView(tunnel Tunnel, baseURL string) Tunnel {
	view := tunnel
	if view.Slug != "" {
		view.PublicURL = baseURL + "/s/" + view.Slug
	} else if view.AliasPath != "" {
		view.PublicURL = baseURL + view.AliasPath
	}
	return view
}

func tunnelViews(tunnels []Tunnel, baseURL string) []Tunnel {
	views := make([]Tunnel, len(tunnels))
	for i, tunnel := range tunnels {
		views[i] = tunnelView(tunnel, baseURL)
	}
	return views
}

func publicBaseURL(r *http.Request) string {
	if configured := strings.TrimSpace(os.Getenv("KS_PUBLIC_URL")); configured != "" {
		return strings.TrimRight(configured, "/")
	}

	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if forwarded := r.Header.Get("X-Forwarded-Proto"); forwarded != "" {
		scheme = strings.TrimSpace(strings.Split(forwarded, ",")[0])
	}

	host := strings.TrimSpace(r.Host)
	if host == "" {
		host = "localhost:" + envOr("PORT", "8080")
	}

	return scheme + "://" + host
}

func newAliasPath() (string, error) {
	id, err := newID()
	if err != nil {
		return "", err
	}
	return "/t/" + id, nil
}

func validSlug(slug string) bool {
	if len(slug) < 2 || len(slug) > 40 {
		return false
	}

	for i, char := range slug {
		switch {
		case char >= 'a' && char <= 'z':
		case char >= '0' && char <= '9':
		case char == '-' && i > 0 && i < len(slug)-1:
		default:
			return false
		}
	}

	return true
}

func (s *store) saveLocked() error {
	data, err := json.MarshalIndent(s.state, "", "  ")
	if err != nil {
		return err
	}

	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	tempFile, err := os.CreateTemp(dir, ".ks-tunnel-*.tmp")
	if err != nil {
		return err
	}

	tempName := tempFile.Name()
	defer os.Remove(tempName)

	if _, err := tempFile.Write(data); err != nil {
		tempFile.Close()
		return err
	}

	if err := tempFile.Sync(); err != nil {
		tempFile.Close()
		return err
	}

	if err := tempFile.Close(); err != nil {
		return err
	}

	return os.Rename(tempName, s.path)
}

func (s *store) providers() []Provider {
	s.mu.Lock()
	defer s.mu.Unlock()

	result := make([]Provider, len(s.state.Providers))
	copy(result, s.state.Providers)
	return result
}

func (s *store) tunnels() []Tunnel {
	s.mu.Lock()
	defer s.mu.Unlock()

	result := make([]Tunnel, len(s.state.Tunnels))
	copy(result, s.state.Tunnels)
	return result
}

func (s *store) tunnelByID(id string) (Tunnel, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, tunnel := range s.state.Tunnels {
		if tunnel.ID == id {
			return tunnel, true
		}
	}

	return Tunnel{}, false
}

func (s *store) addProvider(name string) (Provider, error) {
	id, err := newID()
	if err != nil {
		return Provider{}, err
	}

	provider := Provider{
		ID:        id,
		Name:      name,
		CreatedAt: time.Now().UTC(),
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	s.state.Providers = append(s.state.Providers, provider)
	if err := s.saveLocked(); err != nil {
		s.state.Providers = s.state.Providers[:len(s.state.Providers)-1]
		return Provider{}, err
	}

	return provider, nil
}

func (s *store) updateProvider(id, name string) (Provider, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.state.Providers {
		provider := &s.state.Providers[i]
		if provider.ID != id {
			continue
		}

		previousName := provider.Name
		provider.Name = name

		if err := s.saveLocked(); err != nil {
			provider.Name = previousName
			return Provider{}, err
		}

		return *provider, nil
	}

	return Provider{}, errUnknownProvider
}

func (s *store) deleteProvider(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.state.Providers {
		if s.state.Providers[i].ID != id {
			continue
		}

		for _, tunnel := range s.state.Tunnels {
			if tunnel.ProviderID == id {
				return errProviderInUse
			}
		}

		previous := make([]Provider, len(s.state.Providers))
		copy(previous, s.state.Providers)

		s.state.Providers = append(s.state.Providers[:i], s.state.Providers[i+1:]...)
		if err := s.saveLocked(); err != nil {
			s.state.Providers = previous
			return err
		}

		return nil
	}

	return errUnknownProvider
}

func (s *store) addAgent(name string) (Agent, error) {
	id, err := newID()
	if err != nil {
		return Agent{}, err
	}

	token, err := newAgentToken()
	if err != nil {
		return Agent{}, err
	}

	agent := Agent{
		ID:        id,
		Name:      name,
		Token:     token,
		CreatedAt: time.Now().UTC(),
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for _, existing := range s.state.Agents {
		if existing.Token == token {
			return Agent{}, errors.New("agent token collision")
		}
	}

	s.state.Agents = append(s.state.Agents, agent)
	if err := s.saveLocked(); err != nil {
		s.state.Agents = s.state.Agents[:len(s.state.Agents)-1]
		return Agent{}, err
	}

	return agent, nil
}

func (s *store) addTunnel(tunnel Tunnel) (Tunnel, error) {
	id, err := newID()
	if err != nil {
		return Tunnel{}, err
	}

	tunnel.ID = id
	tunnel.CreatedAt = time.Now().UTC()
	tunnel.Status = "pending"
	tunnel.AliasPath = "/t/" + id
	tunnel.PublicURL = tunnel.AliasPath

	s.mu.Lock()
	defer s.mu.Unlock()

	foundProvider := false
	for _, provider := range s.state.Providers {
		if provider.ID == tunnel.ProviderID {
			foundProvider = true
			break
		}
	}

	if !foundProvider {
		return Tunnel{}, errUnknownProvider
	}

	foundAgent := false
	for _, agent := range s.state.Agents {
		if agent.ID == tunnel.AgentID {
			foundAgent = true
			break
		}
	}

	if !foundAgent {
		return Tunnel{}, errUnknownAgent
	}

	s.state.Tunnels = append(s.state.Tunnels, tunnel)
	if err := s.saveLocked(); err != nil {
		s.state.Tunnels = s.state.Tunnels[:len(s.state.Tunnels)-1]
		return Tunnel{}, err
	}

	return tunnel, nil
}

func (s *store) setTunnelResult(id, publicURL, errorMessage string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.state.Tunnels {
		if s.state.Tunnels[i].ID != id {
			continue
		}
		if s.state.Tunnels[i].Status != "pending" {
			return
		}

		if errorMessage != "" {
			s.state.Tunnels[i].Status = "error"
			s.state.Tunnels[i].Error = errorMessage
			s.state.Tunnels[i].CurrentURL = ""
		} else {
			s.state.Tunnels[i].Status = "active"
			s.state.Tunnels[i].Error = ""
			s.state.Tunnels[i].CurrentURL = publicURL
		}

		if err := s.saveLocked(); err != nil {
			log.Printf("save tunnel result: %v", err)
		}
		return
	}
}

func (s *store) failPendingTunnelsForAgent(agentID, reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	changed := false
	for i := range s.state.Tunnels {
		tunnel := &s.state.Tunnels[i]
		if tunnel.AgentID != agentID || tunnel.Status != "pending" {
			continue
		}

		tunnel.Status = "error"
		tunnel.Error = reason
		changed = true
	}

	if changed {
		if err := s.saveLocked(); err != nil {
			log.Printf("save agent disconnect: %v", err)
		}
	}
}

func (s *store) tunnelByAlias(alias string) (Tunnel, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, tunnel := range s.state.Tunnels {
		if tunnel.AliasPath == alias {
			return tunnel, true
		}
	}

	return Tunnel{}, false
}

func (s *store) tunnelBySlug(slug string) (Tunnel, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, tunnel := range s.state.Tunnels {
		if tunnel.Slug == slug {
			return tunnel, true
		}
	}

	return Tunnel{}, false
}

func (s *store) setTunnelSlug(id, slug string) (Tunnel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.state.Tunnels {
		tunnel := &s.state.Tunnels[i]
		if tunnel.ID != id {
			continue
		}

		if slug != "" {
			for _, other := range s.state.Tunnels {
				if other.ID != id && other.Slug == slug {
					return Tunnel{}, errSlugInUse
				}
			}
		}

		previous := *tunnel
		tunnel.Slug = slug
		if err := s.saveLocked(); err != nil {
			*tunnel = previous
			return Tunnel{}, err
		}

		return *tunnel, nil
	}

	return Tunnel{}, errUnknownTunnel
}

func (s *store) setTunnelStatus(id, status string) (Tunnel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.state.Tunnels {
		if s.state.Tunnels[i].ID != id {
			continue
		}

		previous := s.state.Tunnels[i]
		tunnel := previous
		tunnel.Status = status
		tunnel.Error = ""
		tunnel.CurrentURL = ""

		s.state.Tunnels[i] = tunnel
		if err := s.saveLocked(); err != nil {
			s.state.Tunnels[i] = previous
			return Tunnel{}, err
		}

		return tunnel, nil
	}

	return Tunnel{}, errUnknownTunnel
}

func (s *store) rotateTunnelAlias(id string) (Tunnel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.state.Tunnels {
		if s.state.Tunnels[i].ID != id {
			continue
		}

		aliasPath, err := newAliasPath()
		if err != nil {
			return Tunnel{}, err
		}

		previous := s.state.Tunnels[i]
		tunnel := previous
		tunnel.AliasPath = aliasPath
		tunnel.PublicURL = aliasPath
		tunnel.CurrentURL = ""
		tunnel.Status = "pending"
		tunnel.Error = ""

		s.state.Tunnels[i] = tunnel
		if err := s.saveLocked(); err != nil {
			s.state.Tunnels[i] = previous
			return Tunnel{}, err
		}

		return tunnel, nil
	}

	return Tunnel{}, errUnknownTunnel
}

func (s *store) updateTunnel(id string, update Tunnel) (Tunnel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.state.Tunnels {
		if s.state.Tunnels[i].ID != id {
			continue
		}

		previous := s.state.Tunnels[i]

		tunnel := previous
		tunnel.Name = update.Name
		tunnel.ProviderID = update.ProviderID
		tunnel.AgentID = update.AgentID
		tunnel.IP = update.IP
		tunnel.Port = update.Port
		tunnel.Type = update.Type
		tunnel.CurrentURL = ""
		tunnel.Status = "pending"
		tunnel.Error = ""

		s.state.Tunnels[i] = tunnel
		if err := s.saveLocked(); err != nil {
			s.state.Tunnels[i] = previous
			return Tunnel{}, err
		}

		return tunnel, nil
	}

	return Tunnel{}, errUnknownTunnel
}

func (s *store) deleteTunnel(id string) (Tunnel, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.state.Tunnels {
		if s.state.Tunnels[i].ID != id {
			continue
		}

		removed := s.state.Tunnels[i]

		previous := make([]Tunnel, len(s.state.Tunnels))
		copy(previous, s.state.Tunnels)

		s.state.Tunnels = append(s.state.Tunnels[:i], s.state.Tunnels[i+1:]...)
		if err := s.saveLocked(); err != nil {
			s.state.Tunnels = previous
			return Tunnel{}, false
		}

		return removed, true
	}

	return Tunnel{}, false
}

func newID() (string, error) {
	bytes := make([]byte, 8)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}

func newAgentToken() (string, error) {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	const length = 20

	buffer := make([]byte, length)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}

	for i := range buffer {
		buffer[i] = alphabet[int(buffer[i])%len(alphabet)]
	}

	return string(buffer), nil
}

type server struct {
	store *store
	hub   *agentHub
}

func (s *server) listProviders(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.store.providers())
}

type createProviderRequest struct {
	Name string `json:"name"`
}

func (s *server) createProvider(w http.ResponseWriter, r *http.Request) {
	var body createProviderRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "Provider name is required.")
		return
	}

	provider, err := s.store.addProvider(name)
	if err != nil {
		log.Printf("create provider: %v", err)
		writeError(w, http.StatusInternalServerError, "Could not create provider.")
		return
	}

	writeJSON(w, http.StatusCreated, provider)
}

func (s *server) updateProvider(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))

	var body createProviderRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "Provider name is required.")
		return
	}

	provider, err := s.store.updateProvider(id, name)
	if errors.Is(err, errUnknownProvider) {
		writeError(w, http.StatusNotFound, "Provider not found.")
		return
	}
	if err != nil {
		log.Printf("update provider: %v", err)
		writeError(w, http.StatusInternalServerError, "Could not update provider.")
		return
	}

	writeJSON(w, http.StatusOK, provider)
}

func (s *server) deleteProvider(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))

	err := s.store.deleteProvider(id)
	if errors.Is(err, errUnknownProvider) {
		writeError(w, http.StatusNotFound, "Provider not found.")
		return
	}
	if errors.Is(err, errProviderInUse) {
		writeError(w, http.StatusConflict, "Provider is used by a tunnel. Delete those tunnels first.")
		return
	}
	if err != nil {
		log.Printf("delete provider: %v", err)
		writeError(w, http.StatusInternalServerError, "Could not delete provider.")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

type createAgentRequest struct {
	Name string `json:"name"`
}

func (s *server) createAgent(w http.ResponseWriter, r *http.Request) {
	var body createAgentRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "Agent name is required.")
		return
	}

	agent, err := s.store.addAgent(name)
	if err != nil {
		log.Printf("create agent: %v", err)
		writeError(w, http.StatusInternalServerError, "Could not create agent.")
		return
	}

	writeJSON(w, http.StatusCreated, newAgentView(agent, false))
}

func (s *server) listTunnels(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, tunnelViews(s.store.tunnels(), publicBaseURL(r)))
}

type createTunnelRequest struct {
	Name       string `json:"name"`
	ProviderID string `json:"providerId"`
	AgentID    string `json:"agentId"`
	IP         string `json:"ip"`
	Port       int    `json:"port"`
	Type       string `json:"type"`
}

type tunnelInput struct {
	Name     string
	Provider Provider
	Agent    Agent
	IP       string
	Port     int
	Type     string
}

func (s *server) parseTunnelInput(w http.ResponseWriter, r *http.Request) (tunnelInput, bool) {
	var body createTunnelRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return tunnelInput{}, false
	}

	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "Tunnel name is required.")
		return tunnelInput{}, false
	}

	providerID := strings.TrimSpace(body.ProviderID)
	if providerID == "" {
		writeError(w, http.StatusBadRequest, "Provider is required.")
		return tunnelInput{}, false
	}

	agentID := strings.TrimSpace(body.AgentID)
	if agentID == "" {
		writeError(w, http.StatusBadRequest, "Agent is required.")
		return tunnelInput{}, false
	}

	agent, ok := s.store.agentByID(agentID)
	if !ok {
		writeError(w, http.StatusBadRequest, "Agent not found.")
		return tunnelInput{}, false
	}

	if !s.hub.connected(agent.Token) {
		writeError(w, http.StatusBadRequest, "Agent is offline. Start the CLI and try again.")
		return tunnelInput{}, false
	}

	provider, ok := s.store.providerByID(providerID)
	if !ok {
		writeError(w, http.StatusBadRequest, "Provider not found.")
		return tunnelInput{}, false
	}

	ip := strings.TrimSpace(body.IP)
	if ip == "" {
		ip = "localhost"
	}

	if body.Port < 1 || body.Port > 65535 {
		writeError(w, http.StatusBadRequest, "Port must be between 1 and 65535.")
		return tunnelInput{}, false
	}

	tunnelType := strings.ToLower(strings.TrimSpace(body.Type))
	switch tunnelType {
	case "https", "http", "tcp", "udp":
	default:
		writeError(w, http.StatusBadRequest, "Type must be https, http, tcp, or udp.")
		return tunnelInput{}, false
	}

	return tunnelInput{
		Name:     name,
		Provider: provider,
		Agent:    agent,
		IP:       ip,
		Port:     body.Port,
		Type:     tunnelType,
	}, true
}

func tunnelCommand(tunnel Tunnel, providerName string) createTunnelMessage {
	return createTunnelMessage{
		Type: "create_tunnel",
		Tunnel: agentTunnel{
			ID:       tunnel.ID,
			Name:     tunnel.Name,
			Provider: providerName,
			IP:       tunnel.IP,
			Port:     tunnel.Port,
			Type:     tunnel.Type,
		},
	}
}

func (s *server) createTunnel(w http.ResponseWriter, r *http.Request) {
	input, ok := s.parseTunnelInput(w, r)
	if !ok {
		return
	}

	tunnel, err := s.store.addTunnel(Tunnel{
		Name:       input.Name,
		ProviderID: input.Provider.ID,
		AgentID:    input.Agent.ID,
		IP:         input.IP,
		Port:       input.Port,
		Type:       input.Type,
	})
	if errors.Is(err, errUnknownProvider) {
		writeError(w, http.StatusBadRequest, "Provider not found.")
		return
	}
	if errors.Is(err, errUnknownAgent) {
		writeError(w, http.StatusBadRequest, "Agent not found.")
		return
	}
	if err != nil {
		log.Printf("create tunnel: %v", err)
		writeError(w, http.StatusInternalServerError, "Could not create tunnel.")
		return
	}

	if err := s.hub.send(input.Agent.Token, tunnelCommand(tunnel, input.Provider.Name)); err != nil {
		s.store.deleteTunnel(tunnel.ID)
		writeError(w, http.StatusBadGateway, "Could not reach the agent. Make sure the CLI is running.")
		return
	}

	writeJSON(w, http.StatusCreated, tunnelView(tunnel, publicBaseURL(r)))
}

func (s *server) updateTunnel(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))

	existing, ok := s.store.tunnelByID(id)
	if !ok {
		writeError(w, http.StatusNotFound, "Tunnel not found.")
		return
	}

	input, ok := s.parseTunnelInput(w, r)
	if !ok {
		return
	}

	if oldAgent, ok := s.store.agentByID(existing.AgentID); ok && s.hub.connected(oldAgent.Token) {
		action := tunnelActionMessage{Type: "delete_tunnel", TunnelID: id}
		if err := s.hub.send(oldAgent.Token, action); err != nil {
			log.Printf("stop old tunnel: %v", err)
		}
	}

	tunnel, err := s.store.updateTunnel(id, Tunnel{
		Name:       input.Name,
		ProviderID: input.Provider.ID,
		AgentID:    input.Agent.ID,
		IP:         input.IP,
		Port:       input.Port,
		Type:       input.Type,
	})
	if errors.Is(err, errUnknownTunnel) {
		writeError(w, http.StatusNotFound, "Tunnel not found.")
		return
	}
	if err != nil {
		log.Printf("update tunnel: %v", err)
		writeError(w, http.StatusInternalServerError, "Could not update tunnel.")
		return
	}

	if err := s.hub.send(input.Agent.Token, tunnelCommand(tunnel, input.Provider.Name)); err != nil {
		s.store.setTunnelResult(tunnel.ID, "", "Could not reach the agent. Make sure the CLI is running.")
		writeError(w, http.StatusBadGateway, "Could not reach the agent. Make sure the CLI is running.")
		return
	}

	writeJSON(w, http.StatusOK, tunnelView(tunnel, publicBaseURL(r)))
}

func (s *server) stopTunnel(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))

	tunnel, ok := s.store.tunnelByID(id)
	if !ok {
		writeError(w, http.StatusNotFound, "Tunnel not found.")
		return
	}

	if agent, ok := s.store.agentByID(tunnel.AgentID); ok && s.hub.connected(agent.Token) {
		action := tunnelActionMessage{Type: "delete_tunnel", TunnelID: id}
		if err := s.hub.send(agent.Token, action); err != nil {
			log.Printf("stop tunnel: %v", err)
		}
	}

	tunnel, err := s.store.setTunnelStatus(id, "stopped")
	if errors.Is(err, errUnknownTunnel) {
		writeError(w, http.StatusNotFound, "Tunnel not found.")
		return
	}
	if err != nil {
		log.Printf("stop tunnel: %v", err)
		writeError(w, http.StatusInternalServerError, "Could not stop tunnel.")
		return
	}

	writeJSON(w, http.StatusOK, tunnelView(tunnel, publicBaseURL(r)))
}

func (s *server) startTunnel(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))

	tunnel, ok := s.store.tunnelByID(id)
	if !ok {
		writeError(w, http.StatusNotFound, "Tunnel not found.")
		return
	}
	if tunnel.Status == "active" || tunnel.Status == "pending" {
		writeError(w, http.StatusConflict, "Tunnel is already running.")
		return
	}

	agent, ok := s.store.agentByID(tunnel.AgentID)
	if !ok {
		writeError(w, http.StatusBadRequest, "Agent not found.")
		return
	}
	if !s.hub.connected(agent.Token) {
		writeError(w, http.StatusBadRequest, "Agent is offline. Start the CLI and try again.")
		return
	}

	provider, ok := s.store.providerByID(tunnel.ProviderID)
	if !ok {
		writeError(w, http.StatusBadRequest, "Provider not found.")
		return
	}

	tunnel, err := s.store.setTunnelStatus(id, "pending")
	if err != nil {
		log.Printf("start tunnel: %v", err)
		writeError(w, http.StatusInternalServerError, "Could not start tunnel.")
		return
	}

	if err := s.hub.send(agent.Token, tunnelCommand(tunnel, provider.Name)); err != nil {
		s.store.setTunnelResult(tunnel.ID, "", "Could not reach the agent. Make sure the CLI is running.")
		writeError(w, http.StatusBadGateway, "Could not reach the agent. Make sure the CLI is running.")
		return
	}

	writeJSON(w, http.StatusOK, tunnelView(tunnel, publicBaseURL(r)))
}

func (s *server) reconfigureTunnelURL(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))

	tunnel, ok := s.store.tunnelByID(id)
	if !ok {
		writeError(w, http.StatusNotFound, "Tunnel not found.")
		return
	}

	agent, ok := s.store.agentByID(tunnel.AgentID)
	if !ok {
		writeError(w, http.StatusBadRequest, "Agent not found.")
		return
	}
	if !s.hub.connected(agent.Token) {
		writeError(w, http.StatusBadRequest, "Agent is offline. Start the CLI and try again.")
		return
	}

	provider, ok := s.store.providerByID(tunnel.ProviderID)
	if !ok {
		writeError(w, http.StatusBadRequest, "Provider not found.")
		return
	}

	action := tunnelActionMessage{Type: "delete_tunnel", TunnelID: id}
	if err := s.hub.send(agent.Token, action); err != nil {
		log.Printf("stop tunnel for URL reset: %v", err)
	}

	tunnel, err := s.store.rotateTunnelAlias(id)
	if err != nil {
		log.Printf("reset tunnel URL: %v", err)
		writeError(w, http.StatusInternalServerError, "Could not change tunnel URL.")
		return
	}

	if err := s.hub.send(agent.Token, tunnelCommand(tunnel, provider.Name)); err != nil {
		s.store.setTunnelResult(tunnel.ID, "", "Could not reach the agent. Make sure the CLI is running.")
		writeError(w, http.StatusBadGateway, "Could not reach the agent. Make sure the CLI is running.")
		return
	}

	writeJSON(w, http.StatusOK, tunnelView(tunnel, publicBaseURL(r)))
}

func (s *server) updateTunnelSlug(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))

	var body struct {
		Slug string `json:"slug"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	slug := strings.ToLower(strings.TrimSpace(body.Slug))
	if slug != "" && !validSlug(slug) {
		writeError(w, http.StatusBadRequest, "Slug must be 2-40 characters using lowercase letters, numbers, and hyphens.")
		return
	}

	tunnel, err := s.store.setTunnelSlug(id, slug)
	if errors.Is(err, errUnknownTunnel) {
		writeError(w, http.StatusNotFound, "Tunnel not found.")
		return
	}
	if errors.Is(err, errSlugInUse) {
		writeError(w, http.StatusConflict, "Slug is already used by another tunnel.")
		return
	}
	if err != nil {
		log.Printf("update tunnel slug: %v", err)
		writeError(w, http.StatusInternalServerError, "Could not update tunnel slug.")
		return
	}

	writeJSON(w, http.StatusOK, tunnelView(tunnel, publicBaseURL(r)))
}

func (s *server) redirectTunnel(w http.ResponseWriter, r *http.Request) {
	alias := "/t/" + strings.TrimSpace(r.PathValue("alias"))

	tunnel, ok := s.store.tunnelByAlias(alias)
	if !ok {
		http.NotFound(w, r)
		return
	}

	s.serveTunnelRedirect(w, r, tunnel)
}

func (s *server) redirectSlug(w http.ResponseWriter, r *http.Request) {
	slug := strings.ToLower(strings.TrimSpace(r.PathValue("slug")))

	tunnel, ok := s.store.tunnelBySlug(slug)
	if !ok {
		http.NotFound(w, r)
		return
	}

	s.serveTunnelRedirect(w, r, tunnel)
}

func (s *server) serveTunnelRedirect(w http.ResponseWriter, r *http.Request, tunnel Tunnel) {
	w.Header().Set("Cache-Control", "no-store")
	if tunnel.Status == "active" && tunnel.CurrentURL != "" {
		http.Redirect(w, r, tunnel.CurrentURL, http.StatusFound)
		return
	}

	w.Header().Set("Retry-After", "5")
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = fmt.Fprint(w, "<!doctype html><meta http-equiv=\"refresh\" content=\"5\"><title>Tunnel starting</title><p>Tunnel is not running yet. Retrying...</p>")
}

func (s *server) deleteTunnel(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))

	tunnel, ok := s.store.tunnelByID(id)
	if !ok {
		writeError(w, http.StatusNotFound, "Tunnel not found.")
		return
	}

	if agent, ok := s.store.agentByID(tunnel.AgentID); ok && s.hub.connected(agent.Token) {
		action := tunnelActionMessage{Type: "delete_tunnel", TunnelID: id}
		if err := s.hub.send(agent.Token, action); err != nil {
			log.Printf("stop tunnel: %v", err)
		}
	}

	if _, ok := s.store.deleteTunnel(id); !ok {
		writeError(w, http.StatusNotFound, "Tunnel not found.")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)

	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(target); err != nil {
		return errors.New("Invalid request body.")
	}

	return nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)

	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("write response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")

		if isLocalOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		}

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func isLocalOrigin(origin string) bool {
	return strings.HasPrefix(origin, "http://localhost:") ||
		strings.HasPrefix(origin, "http://127.0.0.1:")
}

func spaHandler(dist string) http.Handler {
	files := http.FileServer(http.Dir(dist))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		cleanPath := filepath.Clean("/" + r.URL.Path)
		relativePath := strings.TrimPrefix(cleanPath, "/")
		filePath := filepath.Join(dist, relativePath)

		if info, err := os.Stat(filePath); err == nil && !info.IsDir() {
			files.ServeHTTP(w, r)
			return
		}

		indexPath := filepath.Join(dist, "index.html")
		if _, err := os.Stat(indexPath); err != nil {
			http.NotFound(w, r)
			return
		}

		http.ServeFile(w, r, indexPath)
	})
}

func findWebDir() string {
	if dir := strings.TrimSpace(os.Getenv("KS_WEB_DIR")); dir != "" {
		return dir
	}

	for _, dir := range []string{
		filepath.Join("..", "frontend", "dist"),
		filepath.Join("frontend", "dist"),
		filepath.Join("web", "frontend", "dist"),
	} {
		if _, err := os.Stat(filepath.Join(dir, "index.html")); err == nil {
			return dir
		}
	}

	return ""
}

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func main() {
	port := envOr("PORT", "8080")
	dataFile := envOr("KS_DATA_FILE", "data.json")

	dataStore, err := newStore(dataFile, strings.TrimRight(envOr("KS_PUBLIC_URL", "http://localhost:"+port), "/"))
	if err != nil {
		log.Fatalf("load store: %v", err)
	}

	api := &server{store: dataStore, hub: newAgentHub()}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/providers", api.listProviders)
	mux.HandleFunc("POST /api/providers", api.createProvider)
	mux.HandleFunc("PATCH /api/providers/{id}", api.updateProvider)
	mux.HandleFunc("DELETE /api/providers/{id}", api.deleteProvider)
	mux.HandleFunc("GET /api/agents", api.listAgents)
	mux.HandleFunc("POST /api/agents", api.createAgent)
	mux.HandleFunc("PATCH /api/agents/{id}", api.updateAgent)
	mux.HandleFunc("DELETE /api/agents/{id}", api.deleteAgent)
	mux.HandleFunc("POST /api/agents/{id}/reconnect", api.reconnectAgent)
	mux.HandleFunc("GET /api/tunnels", api.listTunnels)
	mux.HandleFunc("POST /api/tunnels", api.createTunnel)
	mux.HandleFunc("PATCH /api/tunnels/{id}", api.updateTunnel)
	mux.HandleFunc("DELETE /api/tunnels/{id}", api.deleteTunnel)
	mux.HandleFunc("POST /api/tunnels/{id}/start", api.startTunnel)
	mux.HandleFunc("POST /api/tunnels/{id}/stop", api.stopTunnel)
	mux.HandleFunc("POST /api/tunnels/{id}/reconfigure-url", api.reconfigureTunnelURL)
	mux.HandleFunc("PUT /api/tunnels/{id}/slug", api.updateTunnelSlug)
	mux.HandleFunc("GET /t/{alias}", api.redirectTunnel)
	mux.HandleFunc("HEAD /t/{alias}", api.redirectTunnel)
	mux.HandleFunc("GET /s/{slug}", api.redirectSlug)
	mux.HandleFunc("HEAD /s/{slug}", api.redirectSlug)
	mux.HandleFunc("/ws/agent", api.agentSocket)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "Not found.")
	})

	if webDir := findWebDir(); webDir != "" {
		mux.Handle("/", spaHandler(webDir))
		log.Printf("Serving web app from %s", webDir)
	} else {
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/" {
				http.NotFound(w, r)
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"name": "KS Tunnel"})
		})
	}

	log.Printf("KS Tunnel API listening on http://localhost:%s", port)
	if err := http.ListenAndServe(":"+port, withCORS(mux)); err != nil {
		log.Fatal(err)
	}
}
