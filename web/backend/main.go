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

type Tunnel struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	ProviderID string    `json:"providerId"`
	IP         string    `json:"ip"`
	Port       int       `json:"port"`
	Type       string    `json:"type"`
	CreatedAt  time.Time `json:"createdAt"`
}

type state struct {
	Providers []Provider `json:"providers"`
	Tunnels   []Tunnel   `json:"tunnels"`
}

type store struct {
	mu    sync.Mutex
	path  string
	state state
}

var errUnknownProvider = errors.New("provider not found")

func newStore(path string) (*store, error) {
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
		if s.state.Tunnels == nil {
			s.state.Tunnels = []Tunnel{}
		}
		return s, nil
	case errors.Is(err, os.ErrNotExist):
		s.state = state{
			Providers: []Provider{{
				ID:        "cloudflare",
				Name:      "Cloudflare",
				CreatedAt: time.Now().UTC(),
			}},
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

func (s *store) addTunnel(tunnel Tunnel) (Tunnel, error) {
	id, err := newID()
	if err != nil {
		return Tunnel{}, err
	}

	tunnel.ID = id
	tunnel.CreatedAt = time.Now().UTC()

	s.mu.Lock()
	defer s.mu.Unlock()

	found := false
	for _, provider := range s.state.Providers {
		if provider.ID == tunnel.ProviderID {
			found = true
			break
		}
	}

	if !found {
		return Tunnel{}, errUnknownProvider
	}

	s.state.Tunnels = append(s.state.Tunnels, tunnel)
	if err := s.saveLocked(); err != nil {
		s.state.Tunnels = s.state.Tunnels[:len(s.state.Tunnels)-1]
		return Tunnel{}, err
	}

	return tunnel, nil
}

func newID() (string, error) {
	bytes := make([]byte, 8)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}

type server struct {
	store *store
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

func (s *server) listTunnels(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.store.tunnels())
}

type createTunnelRequest struct {
	Name       string `json:"name"`
	ProviderID string `json:"providerId"`
	IP         string `json:"ip"`
	Port       int    `json:"port"`
	Type       string `json:"type"`
}

func (s *server) createTunnel(w http.ResponseWriter, r *http.Request) {
	var body createTunnelRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "Tunnel name is required.")
		return
	}

	providerID := strings.TrimSpace(body.ProviderID)
	if providerID == "" {
		writeError(w, http.StatusBadRequest, "Provider is required.")
		return
	}

	ip := strings.TrimSpace(body.IP)
	if ip == "" {
		ip = "localhost"
	}

	if body.Port < 1 || body.Port > 65535 {
		writeError(w, http.StatusBadRequest, "Port must be between 1 and 65535.")
		return
	}

	tunnelType := strings.ToLower(strings.TrimSpace(body.Type))
	switch tunnelType {
	case "https", "http", "tcp", "udp":
	default:
		writeError(w, http.StatusBadRequest, "Type must be https, http, tcp, or udp.")
		return
	}

	tunnel, err := s.store.addTunnel(Tunnel{
		Name:       name,
		ProviderID: providerID,
		IP:         ip,
		Port:       body.Port,
		Type:       tunnelType,
	})
	if errors.Is(err, errUnknownProvider) {
		writeError(w, http.StatusBadRequest, "Provider not found.")
		return
	}
	if err != nil {
		log.Printf("create tunnel: %v", err)
		writeError(w, http.StatusInternalServerError, "Could not create tunnel.")
		return
	}

	writeJSON(w, http.StatusCreated, tunnel)
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
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
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
		filepath.Join("..", "dist"),
		"dist",
		filepath.Join("web", "dist"),
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

	dataStore, err := newStore(dataFile)
	if err != nil {
		log.Fatalf("load store: %v", err)
	}

	api := &server{store: dataStore}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/providers", api.listProviders)
	mux.HandleFunc("POST /api/providers", api.createProvider)
	mux.HandleFunc("GET /api/tunnels", api.listTunnels)
	mux.HandleFunc("POST /api/tunnels", api.createTunnel)
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
