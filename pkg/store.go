package pkg

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
)

// ApprovalRule represents a remembered permission rule
type ApprovalRule struct {
	ID        string `json:"id"`
	Command   string `json:"command"`  // Command prefix, e.g. "git show"
	Scope     string `json:"scope"`    // "conversation", "project", or "global"
	ScopeID   string `json:"scope_id"` // Conversation ID or Project path
	CreatedAt string `json:"created_at"`
}

// ProjectPermission holds security and execution settings for a specific repository / project
type ProjectPermission struct {
	PermissionPolicy        string `json:"permission_policy,omitempty"`         // "inherit", "ask_all", "safe_auto", "full_auto", "custom"
	TerminalExecutionPolicy string `json:"terminal_execution_policy,omitempty"` // "inherit", "sandbox", "prompt", "safe_auto", "full_auto"
	FileAccessPolicy        string `json:"file_access_policy,omitempty"`        // "inherit", "strict", "ask", "read_parent", "unrestricted"
	SandboxMode             *bool  `json:"sandbox_mode,omitempty"`
	AllowedCommands         string `json:"allowed_commands,omitempty"`          // comma separated command prefixes
}

// LocalAgentStore holds persisted settings, credentials, and session state
type LocalAgentStore struct {
	PermissionPolicy        string                       `json:"permission_policy,omitempty"`
	TerminalExecutionPolicy string                       `json:"terminal_execution_policy,omitempty"`
	FileAccessPolicy        string                       `json:"file_access_policy,omitempty"`
	SandboxMode             bool                         `json:"sandbox_mode"`
	QueuedMessages          string                       `json:"queued_messages,omitempty"`
	ProjectPermissions      map[string]ProjectPermission `json:"project_permissions,omitempty"`
	AiApiUrl                string                       `json:"ai_api_url,omitempty"`
	AiApiKey                string                       `json:"ai_api_key,omitempty"`
	ActiveProject           string                       `json:"active_project,omitempty"`
	BaseURL                 string                       `json:"base_url,omitempty"`
	OrgID                   string                       `json:"org_id,omitempty"`
	Environment             string                       `json:"environment,omitempty"`
	OAuthToken              string                       `json:"oauth_token,omitempty"`
	IsLoggedIn              bool                         `json:"is_logged_in,omitempty"`
	AiModel                 string                       `json:"ai_model,omitempty"`
	ApprovalRules           []ApprovalRule               `json:"approval_rules,omitempty"`
	PinnedConversations     []string                     `json:"pinned_conversations,omitempty"`
}

// GetLocalStorePath returns the path to ~/.shuffle/agent.json
func GetLocalStorePath() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = os.Getenv("HOME")
	}
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".shuffle", "agent.json")
}

// LoadLocalStore reads the local agent configuration from ~/.shuffle/agent.json
func LoadLocalStore() *LocalAgentStore {
	storePath := GetLocalStorePath()
	if storePath == "" {
		return &LocalAgentStore{}
	}
	data, err := os.ReadFile(storePath)
	if err != nil {
		return &LocalAgentStore{}
	}
	var store LocalAgentStore
	if err := json.Unmarshal(data, &store); err != nil {
		log.Printf("[WARN] Failed to parse local agent store: %v", err)
		return &LocalAgentStore{}
	}
	return &store
}

// SaveLocalStore writes the agent configuration safely to ~/.shuffle/agent.json with 0600 file permissions
func SaveLocalStore(store *LocalAgentStore) error {
	storePath := GetLocalStorePath()
	if storePath == "" {
		return fmt.Errorf("could not determine home directory")
	}
	dir := filepath.Dir(storePath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create store directory: %v", err)
	}
	data, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal local store: %v", err)
	}
	return os.WriteFile(storePath, data, 0600)
}
