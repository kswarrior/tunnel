package main

import (
	"errors"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"
)

var errAgentRejected = errors.New("agent request was rejected")

type agentView struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Status      string     `json:"status"`
	Authorized  bool       `json:"authorized"`
	Connected   bool       `json:"connected"`
	CreatedAt   time.Time  `json:"createdAt"`
	ConnectedAt *time.Time `json:"connectedAt,omitempty"`
}

func newAgentView(agent Agent, connected bool) agentView {
	status := "offline"

	switch {
	case agent.Rejected:
		status = "rejected"
	case connected && agent.Authorized:
		status = "online"
	case connected:
		status = "pending"
	case agent.Authorized:
		status = "offline"
	}

	return agentView{
		ID:          agent.ID,
		Name:        agent.Name,
		Status:      status,
		Authorized:  agent.Authorized,
		Connected:   connected,
		CreatedAt:   agent.CreatedAt,
		ConnectedAt: agent.ConnectedAt,
	}
}

func (s *store) agents() []Agent {
	s.mu.Lock()
	defer s.mu.Unlock()

	result := make([]Agent, len(s.state.Agents))
	copy(result, s.state.Agents)
	return result
}

func (s *store) agentByToken(token string) (Agent, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, agent := range s.state.Agents {
		if agent.Token == token {
			return agent, true
		}
	}

	return Agent{}, false
}

func (s *store) agentByID(id string) (Agent, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, agent := range s.state.Agents {
		if agent.ID == id {
			return agent, true
		}
	}

	return Agent{}, false
}

func (s *store) providerByID(id string) (Provider, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, provider := range s.state.Providers {
		if provider.ID == id {
			return provider, true
		}
	}

	return Provider{}, false
}

func (s *store) connectAgent(token, name string) (Agent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UTC()

	for i := range s.state.Agents {
		agent := &s.state.Agents[i]
		if agent.Token != token {
			continue
		}

		if agent.Rejected {
			return Agent{}, errAgentRejected
		}

		previousName := agent.Name
		previousConnectedAt := agent.ConnectedAt

		if name != "" {
			agent.Name = name
		}
		agent.ConnectedAt = &now

		if err := s.saveLocked(); err != nil {
			agent.Name = previousName
			agent.ConnectedAt = previousConnectedAt
			return Agent{}, err
		}

		return *agent, nil
	}

	id, err := newID()
	if err != nil {
		return Agent{}, err
	}

	agent := Agent{
		ID:          id,
		Name:        name,
		Token:       token,
		CreatedAt:   now,
		ConnectedAt: &now,
	}

	s.state.Agents = append(s.state.Agents, agent)
	if err := s.saveLocked(); err != nil {
		s.state.Agents = s.state.Agents[:len(s.state.Agents)-1]
		return Agent{}, err
	}

	return agent, nil
}

func (s *store) authorizeAgent(token string) (Agent, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.state.Agents {
		agent := &s.state.Agents[i]
		if agent.Token != token {
			continue
		}

		previousAuthorized := agent.Authorized
		previousRejected := agent.Rejected

		agent.Authorized = true
		agent.Rejected = false

		if err := s.saveLocked(); err != nil {
			agent.Authorized = previousAuthorized
			agent.Rejected = previousRejected
			return Agent{}, false
		}

		return *agent, true
	}

	return Agent{}, false
}

func (s *store) deleteAgentByToken(token string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.state.Agents {
		if s.state.Agents[i].Token != token {
			continue
		}

		previous := make([]Agent, len(s.state.Agents))
		copy(previous, s.state.Agents)

		s.state.Agents = append(s.state.Agents[:i], s.state.Agents[i+1:]...)
		if err := s.saveLocked(); err != nil {
			s.state.Agents = previous
			return false
		}

		return true
	}

	return false
}

func (s *server) listAgents(w http.ResponseWriter, r *http.Request) {
	agents := s.store.agents()
	views := make([]agentView, 0, len(agents))

	for _, agent := range agents {
		views = append(views, newAgentView(agent, s.hub.connected(agent.Token)))
	}

	sort.Slice(views, func(i, j int) bool {
		return views[i].CreatedAt.After(views[j].CreatedAt)
	})

	writeJSON(w, http.StatusOK, views)
}

func (s *server) getClaim(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(r.PathValue("token"))
	if !validAgentToken(token) {
		writeError(w, http.StatusNotFound, "This agent link is invalid or has expired.")
		return
	}

	agent, ok := s.store.agentByToken(token)
	if !ok {
		writeError(w, http.StatusNotFound, "This agent link is invalid or has expired.")
		return
	}

	writeJSON(w, http.StatusOK, newAgentView(agent, s.hub.connected(token)))
}

type claimActionRequest struct {
	Action string `json:"action"`
}

func (s *server) respondClaim(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(r.PathValue("token"))
	if !validAgentToken(token) {
		writeError(w, http.StatusNotFound, "This agent link is invalid or has expired.")
		return
	}

	var body claimActionRequest
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	agent, ok := s.store.agentByToken(token)
	if !ok {
		writeError(w, http.StatusNotFound, "This agent link is invalid or has expired.")
		return
	}

	switch strings.ToLower(strings.TrimSpace(body.Action)) {
	case "allow":
		if !agent.Authorized {
			agent, ok = s.store.authorizeAgent(token)
			if !ok {
				writeError(w, http.StatusInternalServerError, "Could not approve agent.")
				return
			}
		}

		if err := s.hub.send(token, map[string]string{"type": "approved"}); err != nil {
			log.Printf("notify approved agent: %v", err)
		}

		writeJSON(w, http.StatusOK, map[string]string{"status": "approved"})
	case "cancel":
		if err := s.hub.send(token, map[string]string{"type": "rejected"}); err != nil {
			log.Printf("notify rejected agent: %v", err)
		}
		s.hub.close(token)
		s.store.deleteAgentByToken(token)
		writeJSON(w, http.StatusOK, map[string]string{"status": "cancelled"})
	default:
		writeError(w, http.StatusBadRequest, "Action must be allow or cancel.")
	}
}
