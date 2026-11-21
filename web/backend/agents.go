package main

import (
	"net/http"
	"sort"
	"time"
)

type agentView struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Token       string     `json:"token"`
	Status      string     `json:"status"`
	Connected   bool       `json:"connected"`
	CreatedAt   time.Time  `json:"createdAt"`
	ConnectedAt *time.Time `json:"connectedAt,omitempty"`
}

func newAgentView(agent Agent, connected bool) agentView {
	status := "offline"
	if connected {
		status = "online"
	}

	return agentView{
		ID:          agent.ID,
		Name:        agent.Name,
		Token:       agent.Token,
		Status:      status,
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

	return Agent{}, errUnknownAgent
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
