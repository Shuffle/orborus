package pkg

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/shuffle/osctrl"
	"github.com/shuffle/osctrl/webview"
	shuffle "github.com/shuffle/shuffle-shared"
)

// ExecutionEntry tracks an executed prompt or command
type ExecutionEntry struct {
	ID             string                 `json:"id"`
	ConversationID string                 `json:"conversation_id,omitempty"`
	Timestamp      string                 `json:"timestamp"`
	Prompt         string                 `json:"prompt"`
	Output         string                 `json:"output"`
	Status         string                 `json:"status"` // "success", "error", "pending"
	Duration       string                 `json:"duration"`
	Error          string                 `json:"error,omitempty"`
	ErrorType      string                 `json:"error_type,omitempty"`
	FixHelp        string                 `json:"fix_help,omitempty"`
	DebugInfo         map[string]interface{}     `json:"debug_info,omitempty"`
	Turns             []ConversationTurn         `json:"turns,omitempty"`
	Steps             []ConversationStep         `json:"steps,omitempty"`
	Decisions         []shuffle.AgentDecision    `json:"decisions,omitempty"`
	Conversation      *Conversation              `json:"conversation,omitempty"`
	WorkflowExecution *shuffle.WorkflowExecution `json:"workflow_execution,omitempty"`
}

// ApprovalRequest tracks an action waiting for user permission
type ApprovalRequest struct {
	ID            string `json:"id"`
	Action        string `json:"action"`
	CommandPrefix string `json:"command_prefix"`
	Description   string `json:"description"`
	Timestamp     string `json:"timestamp"`
	Project       string `json:"project"`
}

// AgentBridge manages direct in-memory state and execution between Go and JS
type AgentBridge struct {
	cfg                     *Config
	mu                      sync.Mutex
	activeProject           string
	permissionPolicy        string // "ask_all", "safe_auto", "full_auto", "custom"
	terminalExecutionPolicy string // "sandbox", "prompt", "safe_auto", "full_auto"
	fileAccessPolicy        string // "ask", "workspace_only", "read_only", "allow_all"
	sandboxMode             bool
	queuedMessages          string // "queue" or "immediate"
	projectPermissions      map[string]ProjectPermission
	history                 []ExecutionEntry
	pendingApproval         *ApprovalRequest
	approvalCh              chan bool
	projects                []shuffle.ProjectInfo
	projectsScanned         bool
	isScanning              bool
	scanWaitCh              chan struct{}
	oauthLoggedIn           bool
	oauthToken              string
	onAuthUpdated           func(stateJSON string)
	aiApiKey                string
	aiApiUrl                string
	aiModel                 string
	approvalRules           []ApprovalRule
	pinnedConvs             []string
}

// NewAgentBridge initializes a new direct bridge
func NewAgentBridge(cfg *Config) *AgentBridge {
	if cfg == nil {
		cfg = &Config{}
	}
	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}

	saved := LoadLocalStore()

	policy := saved.PermissionPolicy
	if policy == "" {
		policy = "ask_all"
	}

	termPolicy := saved.TerminalExecutionPolicy
	if termPolicy == "" {
		termPolicy = "sandbox"
	}

	filePolicy := saved.FileAccessPolicy
	if filePolicy == "" {
		filePolicy = "ask"
	}

	queuedMsgs := saved.QueuedMessages
	if queuedMsgs == "" {
		queuedMsgs = "queue"
	}

	sandboxMode := true
	if saved.PermissionPolicy != "" {
		sandboxMode = saved.SandboxMode
	}

	projectPerms := saved.ProjectPermissions
	if projectPerms == nil {
		projectPerms = make(map[string]ProjectPermission)
	}

	activeProject := cwd
	if saved.ActiveProject != "" {
		if fi, err := os.Stat(saved.ActiveProject); err == nil && fi.IsDir() {
			activeProject = saved.ActiveProject
		}
	}

	aiUrl := os.Getenv("AI_API_URL")
	if aiUrl == "" && saved.AiApiUrl != "" {
		aiUrl = saved.AiApiUrl
		_ = os.Setenv("AI_API_URL", aiUrl)
	}
	aiKey := os.Getenv("AI_API_KEY")
	if aiKey == "" && saved.AiApiKey != "" {
		aiKey = saved.AiApiKey
		_ = os.Setenv("AI_API_KEY", aiKey)
	}
	aiModel := os.Getenv("AI_MODEL")
	if aiModel == "" && saved.AiModel != "" {
		aiModel = saved.AiModel
	}
	if aiModel == "" {
		aiModel = "gemini-3.8-flash"
	}
	_ = os.Setenv("AI_MODEL", aiModel)
	_ = os.Setenv("STANDALONE", "true")
	_ = os.Setenv("SHUFFLE_STANDALONE", "true")

	oauthLoggedIn := false
	oauthToken := ""
	if saved.OAuthToken != "" {
		oauthToken = saved.OAuthToken
		oauthLoggedIn = saved.IsLoggedIn
		if cfg.Auth == "" {
			cfg.Auth = saved.OAuthToken
		}
		if cfg.Org == "" && saved.OrgID != "" {
			cfg.Org = saved.OrgID
		}
		if (cfg.Environment == "" || cfg.Environment == "standalone") && saved.Environment != "" {
			cfg.Environment = saved.Environment
		}
		if cfg.BaseURL == "" && saved.BaseURL != "" {
			cfg.BaseURL = saved.BaseURL
		}
	}

	rules := saved.ApprovalRules
	if rules == nil {
		rules = make([]ApprovalRule, 0)
	}
	pinned := saved.PinnedConversations
	if pinned == nil {
		pinned = make([]string, 0)
	}

	if len(saved.InjectedSkills) > 0 {
		GetRuleLoaderManager().SetInjectedSkills(saved.InjectedSkills)
	}

	b := &AgentBridge{
		cfg:                     cfg,
		activeProject:           activeProject,
		permissionPolicy:        policy,
		terminalExecutionPolicy: termPolicy,
		fileAccessPolicy:        filePolicy,
		sandboxMode:             sandboxMode,
		queuedMessages:          queuedMsgs,
		projectPermissions:      projectPerms,
		history:                 make([]ExecutionEntry, 0),
		approvalCh:              make(chan bool, 1),
		projects:                make([]shuffle.ProjectInfo, 0),
		aiApiKey:                aiKey,
		aiApiUrl:                aiUrl,
		aiModel:                 aiModel,
		oauthLoggedIn:           oauthLoggedIn,
		oauthToken:              oauthToken,
		approvalRules:           rules,
		pinnedConvs:             pinned,
	}

	// Trigger code repository scan immediately on initial startup
	go b.ScanProjects()

	return b
}

func (b *AgentBridge) saveLocalStoreLocked() {
	store := &LocalAgentStore{
		PermissionPolicy:        b.permissionPolicy,
		TerminalExecutionPolicy: b.terminalExecutionPolicy,
		FileAccessPolicy:        b.fileAccessPolicy,
		SandboxMode:             b.sandboxMode,
		QueuedMessages:          b.queuedMessages,
		ProjectPermissions:      b.projectPermissions,
		AiApiUrl:                b.aiApiUrl,
		AiApiKey:                b.aiApiKey,
		AiModel:                 b.aiModel,
		ActiveProject:           b.activeProject,
		BaseURL:                 b.cfg.BaseURL,
		OrgID:                   b.cfg.Org,
		Environment:             b.cfg.Environment,
		OAuthToken:              b.oauthToken,
		IsLoggedIn:              b.oauthLoggedIn,
		ApprovalRules:           b.approvalRules,
		PinnedConversations:     b.pinnedConvs,
		InjectedSkills:          GetRuleLoaderManager().GetInjectedSkills(),
	}
	if err := SaveLocalStore(store); err != nil {
		log.Printf("[WARN] Failed to persist local agent store: %v", err)
	}
}

// isAuthBypassed checks if OrgId, Auth, Environment, custom AI, or standalone is active
func (b *AgentBridge) isAuthBypassed() bool {
	// Custom AI credentials bypass remote login
	if (b.aiApiKey != "" && b.aiApiUrl != "") || (os.Getenv("AI_API_KEY") != "" && os.Getenv("AI_API_URL") != "") {
		return true
	}
	// Standalone mode is local and does not enforce Shuffle login
	if b.cfg.IsStandalone {
		return true
	}
	if b.cfg.HasExplicitOrg || b.cfg.HasExplicitAuth || b.cfg.HasExplicitEnv {
		return true
	}
	if b.cfg.Org != "" || b.cfg.Auth != "" {
		return true
	}
	if b.cfg.Environment != "" && b.cfg.Environment != "standalone" {
		return true
	}
	return false
}

// ScanProjects scans the machine for repositories in background
func (b *AgentBridge) ScanProjects() []shuffle.ProjectInfo {
	b.mu.Lock()
	if b.projectsScanned && len(b.projects) > 0 {
		projs := b.projects
		b.mu.Unlock()
		return projs
	}

	if b.isScanning {
		waitCh := b.scanWaitCh
		b.mu.Unlock()
		if waitCh != nil {
			<-waitCh
		}
		b.mu.Lock()
		projs := b.projects
		b.mu.Unlock()
		return projs
	}

	b.isScanning = true
	waitCh := make(chan struct{})
	b.scanWaitCh = waitCh
	b.mu.Unlock()

	var closeOnce sync.Once
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[ERROR] Recovered from panic during repository scan: %v", r)
		}
		b.mu.Lock()
		b.isScanning = false
		b.mu.Unlock()
		closeOnce.Do(func() {
			close(waitCh)
		})
	}()

	log.Printf("[INFO] Starting initial code repository scan...")
	projs := osctrl.ListCodeScannerProjects()
	b.mu.Lock()
	b.projects = projs
	b.projectsScanned = true
	b.mu.Unlock()
	log.Printf("[INFO] Code repository scan complete. Discovered %d projects.", len(projs))
	return projs
}

// GetInitialState returns all current agent state to the frontend in one call
func (b *AgentBridge) GetInitialState() string {
	b.mu.Lock()
	defer b.mu.Unlock()

	isBypassed := b.isAuthBypassed()
	isLoggedIn := isBypassed || b.oauthLoggedIn

	projCtx := GetRuleLoaderManager().LoadProjectContext(b.activeProject)

	state := map[string]interface{}{
		"hostname":                  b.cfg.Hostname,
		"machine_id":                b.cfg.MachineID,
		"os":                        runtime.GOOS,
		"arch":                      runtime.GOARCH,
		"is_standalone":             b.cfg.IsStandalone,
		"base_url":                  b.cfg.BaseURL,
		"active_project":            b.activeProject,
		"permission_policy":         b.permissionPolicy,
		"terminal_execution_policy": b.terminalExecutionPolicy,
		"file_access_policy":        b.fileAccessPolicy,
		"sandbox_mode":              b.sandboxMode,
		"queued_messages":           b.queuedMessages,
		"project_permissions":       b.projectPermissions,
		"history":                   b.history,
		"pending_approval":          b.pendingApproval,
		"projects":                  b.projects,
		"projects_scanned":          b.projectsScanned,
		"is_logged_in":              isLoggedIn,
		"is_bypassed":               isBypassed,
		"org_id":                    b.cfg.Org,
		"auth":                      b.cfg.Auth,
		"environment":               b.cfg.Environment,
		"ai_api_url":                b.aiApiUrl,
		"ai_api_key":                b.aiApiKey,
		"ai_model":                  b.aiModel,
		"approval_rules":            b.approvalRules,
		"pinned_conversations":      b.pinnedConvs,
		"project_rules":             projCtx.Rules,
		"project_skills":            projCtx.Skills,
		"injected_skills":           GetRuleLoaderManager().GetInjectedSkills(),
		"active_rules_count":        len(projCtx.Rules),
		"active_skills_count":       len(projCtx.Skills),
		"debug":                     (b.cfg != nil && b.cfg.Debug) || os.Getenv("DEBUG") == "true" || os.Getenv("DEBUG") == "1",
	}

	data, _ := json.Marshal(state)
	return string(data)
}

// SetAiConfig configures local AI credentials and updates process environment
func (b *AgentBridge) SetAiConfig(apiUrl, apiKey, model string) string {
	b.mu.Lock()

	b.aiApiUrl = strings.TrimSpace(apiUrl)
	b.aiApiKey = strings.TrimSpace(apiKey)
	if trimmedModel := strings.TrimSpace(model); trimmedModel != "" {
		b.aiModel = trimmedModel
	}

	if b.aiApiUrl != "" {
		_ = os.Setenv("AI_API_URL", b.aiApiUrl)
		if strings.Contains(b.aiApiUrl, "shuffler.io") || strings.Contains(b.aiApiUrl, "shuffle") {
			cleanUrl := strings.TrimRight(strings.TrimSuffix(b.aiApiUrl, "/api/v1"), "/")
			_ = os.Setenv("SHUFFLE_BASE_URL", cleanUrl)
			_ = os.Setenv("BASE_URL", cleanUrl)
			if b.cfg != nil {
				b.cfg.BaseURL = cleanUrl
			}
		}
	} else {
		_ = os.Unsetenv("AI_API_URL")
	}

	if b.aiApiKey != "" {
		_ = os.Setenv("AI_API_KEY", b.aiApiKey)
		_ = os.Setenv("SHUFFLE_AUTHORIZATION", b.aiApiKey)
		_ = os.Setenv("SHUFFLE_SESSION_TOKEN", b.aiApiKey)
		if b.cfg != nil && (strings.Contains(b.aiApiUrl, "shuffler.io") || strings.Contains(b.aiApiUrl, "shuffle")) {
			b.cfg.Auth = b.aiApiKey
		}
	} else {
		_ = os.Unsetenv("AI_API_KEY")
	}

	if b.aiModel != "" {
		_ = os.Setenv("AI_MODEL", b.aiModel)
	}

	b.saveLocalStoreLocked()

	isBypassed := b.isAuthBypassed()
	isLoggedIn := isBypassed || b.oauthLoggedIn

	resp, _ := json.Marshal(map[string]interface{}{
		"status":            "ok",
		"ai_api_url":        b.aiApiUrl,
		"ai_api_key":        b.aiApiKey,
		"ai_model":          b.aiModel,
		"permission_policy": b.permissionPolicy,
		"is_logged_in":      isLoggedIn,
		"is_bypassed":       isBypassed,
		"org_id":            b.cfg.Org,
		"environment":       b.cfg.Environment,
	})

	cb := b.onAuthUpdated
	b.mu.Unlock()

	if cb != nil {
		go func() {
			cb(b.GetInitialState())
		}()
	}

	return string(resp)
}

// GetConfig returns the underlying runtime configuration
func (b *AgentBridge) GetConfig() *Config {
	return b.cfg
}

// SetOnAuthUpdated registers a listener for auth state changes
func (b *AgentBridge) SetOnAuthUpdated(fn func(string)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onAuthUpdated = fn
}

// StartOAuthLogin opens the Shuffle OAuth2 login flow with dynamic auth matching ChatGPT MCP logins
func (b *AgentBridge) StartOAuthLogin(customBaseURL string) string {
	targetURL := customBaseURL
	if targetURL == "" {
		targetURL = b.cfg.BaseURL
	}
	if targetURL == "" || strings.Contains(targetURL, "shuffler.io") {
		targetURL = "https://shuffle.security"
	}

	authURL, err := b.StartDynamicOAuth2Flow(targetURL, func(token, orgID, env string) {
		log.Printf("[INFO] Dynamic OAuth2 authorization complete for org: %s", orgID)
		b.mu.Lock()
		cb := b.onAuthUpdated
		b.mu.Unlock()
		if cb != nil {
			cb(b.GetInitialState())
		}
	})
	if err != nil {
		log.Printf("[ERROR] Failed to start dynamic OAuth2 flow: %v", err)
		return fmt.Sprintf(`{"status": "error", "error": %q}`, err.Error())
	}

	resp, _ := json.Marshal(map[string]interface{}{
		"status": "opened",
		"url":    authURL,
	})
	return string(resp)
}

// SetOAuthToken records an authenticated OAuth2 session
func (b *AgentBridge) SetOAuthToken(token, orgID, env string) string {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.oauthLoggedIn = true
	b.oauthToken = token
	if orgID != "" {
		b.cfg.Org = orgID
	}
	if env != "" {
		b.cfg.Environment = env
	}
	if token != "" {
		b.cfg.Auth = token
	}

	b.saveLocalStoreLocked()

	resp, _ := json.Marshal(map[string]interface{}{
		"status":       "ok",
		"is_logged_in": true,
		"org_id":       b.cfg.Org,
		"environment":  b.cfg.Environment,
	})
	return string(resp)
}

// UpdateAuth updates Shuffle credentials and login status
func (b *AgentBridge) UpdateAuth(payload string) string {
	b.mu.Lock()
	defer b.mu.Unlock()

	var req struct {
		BaseURL     string `json:"base_url"`
		OrgID       string `json:"org_id"`
		Auth        string `json:"auth"`
		Environment string `json:"environment"`
	}
	if err := json.Unmarshal([]byte(payload), &req); err != nil {
		return `{"error": "invalid payload"}`
	}

	if req.BaseURL != "" {
		b.cfg.BaseURL = req.BaseURL
	}
	if req.OrgID != "" {
		b.cfg.Org = req.OrgID
	}
	if req.Auth != "" {
		b.cfg.Auth = req.Auth
	}
	if req.Environment != "" {
		b.cfg.Environment = req.Environment
	}

	isBypassed := b.isAuthBypassed()
	isLoggedIn := isBypassed || b.oauthLoggedIn
	if isLoggedIn {
		b.cfg.IsStandalone = false
	}

	b.saveLocalStoreLocked()

	resp, _ := json.Marshal(map[string]interface{}{
		"status":       "ok",
		"is_logged_in": isLoggedIn,
		"is_bypassed":  isBypassed,
		"org_id":       b.cfg.Org,
		"environment":  b.cfg.Environment,
		"base_url":     b.cfg.BaseURL,
	})
	return string(resp)
}

// ListProjects returns detected code repositories on the machine
func (b *AgentBridge) ListProjects() string {
	b.mu.Lock()
	if b.projectsScanned && len(b.projects) > 0 {
		data, _ := json.Marshal(b.projects)
		b.mu.Unlock()
		return string(data)
	}
	b.mu.Unlock()

	projs := b.ScanProjects()
	data, _ := json.Marshal(projs)
	return string(data)
}

// SelectProject changes the working directory
func (b *AgentBridge) SelectProject(path string) string {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.activeProject = path
	b.saveLocalStoreLocked()
	return b.activeProject
}

// SetPermissionPolicy updates the security mode
func (b *AgentBridge) SetPermissionPolicy(policy string) string {
	b.mu.Lock()
	defer b.mu.Unlock()

	if policy != "" {
		b.permissionPolicy = policy
		b.saveLocalStoreLocked()
	}
	return b.permissionPolicy
}

// SaveAllSettings updates global settings, AI configuration, and project permissions
func (b *AgentBridge) SaveAllSettings(payload string) string {
	b.mu.Lock()

	var req struct {
		PermissionPolicy        string                       `json:"permission_policy"`
		TerminalExecutionPolicy string                       `json:"terminal_execution_policy"`
		FileAccessPolicy        string                       `json:"file_access_policy"`
		SandboxMode             *bool                        `json:"sandbox_mode"`
		QueuedMessages          string                       `json:"queued_messages"`
		ProjectPermissions      map[string]ProjectPermission `json:"project_permissions"`
		AiApiUrl                string                       `json:"ai_api_url"`
		AiApiKey                string                       `json:"ai_api_key"`
		AiModel                 string                       `json:"ai_model"`
	}

	if err := json.Unmarshal([]byte(payload), &req); err != nil {
		b.mu.Unlock()
		log.Printf("[WARN] Failed to unmarshal SaveAllSettings: %v", err)
		return `{"status": "error", "error": "invalid json payload"}`
	}

	if req.PermissionPolicy != "" {
		b.permissionPolicy = req.PermissionPolicy
	}
	if req.TerminalExecutionPolicy != "" {
		b.terminalExecutionPolicy = req.TerminalExecutionPolicy
	}
	if req.FileAccessPolicy != "" {
		b.fileAccessPolicy = req.FileAccessPolicy
	}
	if req.SandboxMode != nil {
		b.sandboxMode = *req.SandboxMode
	}
	if req.QueuedMessages != "" {
		b.queuedMessages = req.QueuedMessages
	}
	if req.ProjectPermissions != nil {
		if b.projectPermissions == nil {
			b.projectPermissions = make(map[string]ProjectPermission)
		}
		for k, v := range req.ProjectPermissions {
			b.projectPermissions[k] = v
		}
	}
	if req.AiApiUrl != "" {
		b.aiApiUrl = strings.TrimSpace(req.AiApiUrl)
		_ = os.Setenv("AI_API_URL", b.aiApiUrl)
		if strings.Contains(b.aiApiUrl, "shuffler.io") || strings.Contains(b.aiApiUrl, "shuffle") {
			cleanUrl := strings.TrimRight(strings.TrimSuffix(b.aiApiUrl, "/api/v1"), "/")
			_ = os.Setenv("SHUFFLE_BASE_URL", cleanUrl)
			_ = os.Setenv("BASE_URL", cleanUrl)
			if b.cfg != nil {
				b.cfg.BaseURL = cleanUrl
			}
		}
	} else if strings.Contains(payload, `"ai_api_url"`) {
		b.aiApiUrl = ""
		_ = os.Unsetenv("AI_API_URL")
	}

	if req.AiApiKey != "" {
		b.aiApiKey = strings.TrimSpace(req.AiApiKey)
		_ = os.Setenv("AI_API_KEY", b.aiApiKey)
		_ = os.Setenv("SHUFFLE_AUTHORIZATION", b.aiApiKey)
		_ = os.Setenv("SHUFFLE_SESSION_TOKEN", b.aiApiKey)
		if b.cfg != nil && (strings.Contains(b.aiApiUrl, "shuffler.io") || strings.Contains(b.aiApiUrl, "shuffle")) {
			b.cfg.Auth = b.aiApiKey
		}
	} else if strings.Contains(payload, `"ai_api_key"`) {
		b.aiApiKey = ""
		_ = os.Unsetenv("AI_API_KEY")
	}

	if req.AiModel != "" {
		b.aiModel = strings.TrimSpace(req.AiModel)
		_ = os.Setenv("AI_MODEL", b.aiModel)
	}

	b.saveLocalStoreLocked()

	stateStr := b.getInitialStateLocked()
	cb := b.onAuthUpdated
	b.mu.Unlock()

	if cb != nil {
		cb(stateStr)
	}
	return stateStr
}

// SetProjectPermissions saves permissions for a specific project
func (b *AgentBridge) SetProjectPermissions(projectPath string, perms ProjectPermission) string {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.projectPermissions == nil {
		b.projectPermissions = make(map[string]ProjectPermission)
	}
	b.projectPermissions[projectPath] = perms
	b.saveLocalStoreLocked()

	resp, _ := json.Marshal(map[string]interface{}{
		"status":      "ok",
		"project":     projectPath,
		"permissions": perms,
	})
	return string(resp)
}

func (b *AgentBridge) getInitialStateLocked() string {
	isBypassed := b.isAuthBypassed()
	isLoggedIn := isBypassed || b.oauthLoggedIn

	projCtx := GetRuleLoaderManager().LoadProjectContext(b.activeProject)

	hostname := ""
	machineID := ""
	isStandalone := true
	baseURL := ""
	orgID := ""
	auth := ""
	env := ""
	if b.cfg != nil {
		hostname = b.cfg.Hostname
		machineID = b.cfg.MachineID
		isStandalone = b.cfg.IsStandalone
		baseURL = b.cfg.BaseURL
		orgID = b.cfg.Org
		auth = b.cfg.Auth
		env = b.cfg.Environment
	}

	state := map[string]interface{}{
		"hostname":                  hostname,
		"machine_id":                machineID,
		"os":                        runtime.GOOS,
		"arch":                      runtime.GOARCH,
		"is_standalone":             isStandalone,
		"base_url":                  baseURL,
		"active_project":            b.activeProject,
		"permission_policy":         b.permissionPolicy,
		"terminal_execution_policy": b.terminalExecutionPolicy,
		"file_access_policy":        b.fileAccessPolicy,
		"sandbox_mode":              b.sandboxMode,
		"queued_messages":           b.queuedMessages,
		"project_permissions":       b.projectPermissions,
		"history":                   b.history,
		"pending_approval":          b.pendingApproval,
		"projects":                  b.projects,
		"projects_scanned":          b.projectsScanned,
		"is_logged_in":              isLoggedIn,
		"is_bypassed":               isBypassed,
		"org_id":                    orgID,
		"auth":                      auth,
		"environment":               env,
		"ai_api_url":                b.aiApiUrl,
		"ai_api_key":                b.aiApiKey,
		"ai_model":                  b.aiModel,
		"approval_rules":            b.approvalRules,
		"pinned_conversations":      b.pinnedConvs,
		"project_rules":             projCtx.Rules,
		"project_skills":            projCtx.Skills,
		"injected_skills":           GetRuleLoaderManager().GetInjectedSkills(),
		"active_rules_count":        len(projCtx.Rules),
		"active_skills_count":       len(projCtx.Skills),
		"debug":                     (b.cfg != nil && b.cfg.Debug) || os.Getenv("DEBUG") == "true" || os.Getenv("DEBUG") == "1",
	}

	data, _ := json.Marshal(state)
	return string(data)
}

// ClearHistory wipes in-memory execution history
func (b *AgentBridge) ClearHistory() string {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.history = make([]ExecutionEntry, 0)
	return `{"status": "ok"}`
}

// extractCommandPrefix extracts the primary command prefix (e.g. "git show", "docker ps", "npm")
func extractCommandPrefix(cmd string) string {
	trimmed := strings.TrimSpace(cmd)
	parts := strings.Fields(trimmed)
	if len(parts) == 0 {
		return ""
	}
	if len(parts) > 1 && (parts[0] == "git" || parts[0] == "docker" || parts[0] == "kubectl" || parts[0] == "cargo") {
		return parts[0] + " " + parts[1]
	}
	return parts[0]
}

// generateApprovalDescription creates a clear, user-facing summary of what is being approved
func generateApprovalDescription(cmd string) string {
	trimmed := strings.TrimSpace(cmd)
	parts := strings.Fields(trimmed)
	if len(parts) >= 2 && parts[0] == "git" {
		switch parts[1] {
		case "show":
			if len(parts) >= 3 && !strings.HasPrefix(parts[2], "-") {
				return fmt.Sprintf("Allow viewing commit %s?", parts[2])
			}
			return "Allow viewing commit details?"
		case "diff":
			return "Allow viewing git diff?"
		case "log":
			return "Allow viewing commit history?"
		case "status":
			return "Allow viewing git status?"
		case "checkout", "switch":
			return "Allow switching git branch?"
		case "pull":
			return "Allow pulling git changes?"
		case "push":
			return "Allow pushing git commits?"
		}
	}
	prefix := extractCommandPrefix(cmd)
	if prefix != "" {
		return fmt.Sprintf("Allow running '%s'?", prefix)
	}
	return "Allow running command?"
}

// isApprovedByRulesLocked checks if a command is covered by any remembered approval rules
func (b *AgentBridge) isApprovedByRulesLocked(cmd, convID string) bool {
	trimmed := strings.TrimSpace(cmd)
	for _, rule := range b.approvalRules {
		rCmd := strings.TrimSpace(rule.Command)
		if rCmd == "" {
			continue
		}
		matches := trimmed == rCmd || strings.HasPrefix(trimmed, rCmd+" ") || strings.HasPrefix(trimmed, rCmd)
		if !matches {
			continue
		}
		switch rule.Scope {
		case "global":
			return true
		case "project":
			if rule.ScopeID == b.activeProject || rule.ScopeID == "" {
				return true
			}
		case "conversation":
			if convID != "" && rule.ScopeID == convID {
				return true
			}
		}
	}
	return false
}

// isCommandAllowedLocked checks if a command is permitted by remembered rules or project-specific allowed commands
func (b *AgentBridge) isCommandAllowedLocked(cmd, convID, projectPath string) bool {
	if b.isApprovedByRulesLocked(cmd, convID) {
		return true
	}
	if projectPath != "" && b.projectPermissions != nil {
		if pPerm, ok := b.projectPermissions[projectPath]; ok && pPerm.AllowedCommands != "" {
			trimmed := strings.TrimSpace(cmd)
			cmds := strings.FieldsFunc(pPerm.AllowedCommands, func(r rune) bool {
				return r == ',' || r == '\n' || r == ';'
			})
			for _, allowed := range cmds {
				allowed = strings.TrimSpace(allowed)
				if allowed != "" && (trimmed == allowed || strings.HasPrefix(trimmed, allowed+" ") || strings.HasPrefix(trimmed, allowed)) {
					return true
				}
			}
		}
	}
	return false
}

// isSafeCommand returns true for non-destructive read operations
func isSafeCommand(cmd string) bool {
	trimmed := strings.TrimSpace(cmd)
	if strings.Contains(trimmed, ">") || strings.Contains(trimmed, "|") || strings.Contains(trimmed, ";") || strings.Contains(trimmed, "&") {
		return false
	}
	parts := strings.Fields(trimmed)
	if len(parts) == 0 {
		return true
	}
	safeBins := map[string]bool{
		"ls": true, "cat": true, "pwd": true, "echo": true, "head": true,
		"tail": true, "grep": true, "find": true, "which": true, "whoami": true,
		"date": true, "uptime": true, "uname": true, "df": true, "du": true,
	}
	if parts[0] == "git" && len(parts) > 1 {
		safeGit := map[string]bool{
			"status": true, "log": true, "diff": true, "branch": true, "show": true,
		}
		return safeGit[parts[1]]
	}
	return safeBins[parts[0]]
}

// getEffectiveAiUrlLocked infers the LLM endpoint based on custom URL, model selection, or environment
func (b *AgentBridge) getEffectiveAiUrlLocked() string {
	if b.aiApiUrl != "" {
		return b.aiApiUrl
	}
	if envUrl := os.Getenv("AI_API_URL"); envUrl != "" {
		return envUrl
	}
	if envUrl := os.Getenv("SHUFFLE_BACKEND"); envUrl != "" {
		return strings.TrimRight(envUrl, "/") + "/api/v1"
	}
	if envUrl := os.Getenv("SHUFFLE_URL"); envUrl != "" {
		return strings.TrimRight(envUrl, "/") + "/api/v1"
	}
	if b.cfg != nil && b.cfg.BaseURL != "" && (b.oauthLoggedIn || b.cfg.Auth != "") {
		return strings.TrimRight(b.cfg.BaseURL, "/") + "/api/v1"
	}

	key := b.getEffectiveAiKeyLocked()
	model := strings.ToLower(b.aiModel)
	if model == "" {
		model = "gemini-3.8-flash"
	}

	// If API key is present or local Ollama is selected, infer the provider endpoint
	if key != "" {
		if strings.HasPrefix(model, "gemini") {
			return "https://generativelanguage.googleapis.com/v1beta/openai"
		}
		if strings.HasPrefix(model, "gpt") {
			return "https://api.openai.com/v1"
		}
	}
	if strings.HasPrefix(model, "ollama") {
		return "http://localhost:11434/v1"
	}

	return ""
}

// getEffectiveAiKeyLocked retrieves the active AI credential from local store, env, or Shuffle session
func (b *AgentBridge) getEffectiveAiKeyLocked() string {
	if b.aiApiKey != "" {
		return b.aiApiKey
	}
	if k := os.Getenv("AI_API_KEY"); k != "" {
		return k
	}
	if k := os.Getenv("GEMINI_API_KEY"); k != "" {
		return k
	}
	if k := os.Getenv("OPENAI_API_KEY"); k != "" {
		return k
	}
	if k := os.Getenv("SHUFFLE_AUTHORIZATION"); k != "" {
		return k
	}
	if k := os.Getenv("SHUFFLE_SESSION_TOKEN"); k != "" {
		return k
	}
	if b.oauthLoggedIn && b.oauthToken != "" {
		return b.oauthToken
	}
	if b.cfg != nil && b.cfg.Auth != "" {
		return b.cfg.Auth
	}
	return ""
}

// isLikelyShellCommand determines whether an input string is an executable command vs natural language prompt
func isLikelyShellCommand(cmd string) bool {
	trimmed := strings.TrimSpace(cmd)
	if trimmed == "" {
		return false
	}
	if strings.HasPrefix(trimmed, "$ ") || strings.HasPrefix(trimmed, "> ") {
		return true
	}
	if strings.Contains(trimmed, " | ") || strings.Contains(trimmed, " && ") || strings.Contains(trimmed, " || ") || strings.Contains(trimmed, " > ") || strings.Contains(trimmed, " ; ") {
		return true
	}
	parts := strings.Fields(trimmed)
	if len(parts) == 0 {
		return false
	}
	bin := parts[0]
	if strings.HasPrefix(bin, "./") || strings.HasPrefix(bin, "../") || strings.HasPrefix(bin, "/") || strings.HasPrefix(bin, "~/") {
		return true
	}
	builtins := map[string]bool{
		"cd": true, "pwd": true, "export": true, "set": true, "alias": true,
		"echo": true, "cat": true, "clear": true, "source": true, "exit": true,
		"history": true, "type": true, "kill": true, "which": true, "make": true,
		"brew": true, "curl": true, "wget": true, "git": true, "docker": true,
		"npm": true, "yarn": true, "pnpm": true, "go": true, "python": true,
		"python3": true, "node": true, "sh": true, "bash": true, "zsh": true,
	}
	if builtins[bin] {
		return true
	}
	if _, err := exec.LookPath(bin); err == nil {
		return true
	}
	return false
}

// RunPrompt executes an agent action directly in-memory using osctrl or via LLM endpoint
func (b *AgentBridge) RunPrompt(prompt string, forceApprove bool, convID ...string) string {
	cID := ""
	if len(convID) > 0 {
		cID = convID[0]
	}
	return b.RunPromptWithOpts(prompt, forceApprove, cID, "", "")
}

// RunPromptWithOpts executes an agent action with custom model and reasoning options
func (b *AgentBridge) RunPromptWithOpts(prompt string, forceApprove bool, cID, reqModel, reqReasoning string) string {
	start := time.Now()
	execID := fmt.Sprintf("exec-%d", time.Now().UnixNano())

	b.mu.Lock()
	effectiveUrl := b.getEffectiveAiUrlLocked()
	effectiveKey := b.getEffectiveAiKeyLocked()
	hasAiEndpoint := effectiveUrl != "" && (effectiveKey != "" || strings.Contains(effectiveUrl, "localhost") || strings.Contains(effectiveUrl, "127.0.0.1"))
	activeModel := reqModel
	if activeModel == "" {
		activeModel = b.aiModel
	}
	if activeModel == "" {
		activeModel = "gemini-3.8-flash"
	}
	activeReasoning := reqReasoning
	if activeReasoning == "" {
		activeReasoning = "medium"
	}
	activeUrl := effectiveUrl
	project := b.activeProject
	isShellCmd := isLikelyShellCommand(prompt)
	isDebug := (b.cfg != nil && b.cfg.Debug) || os.Getenv("DEBUG") == "true" || os.Getenv("DEBUG") == "1"
	b.mu.Unlock()

	maskedKey := "none"
	if len(effectiveKey) > 8 {
		maskedKey = effectiveKey[:4] + "..." + effectiveKey[len(effectiveKey)-4:]
	} else if effectiveKey != "" {
		maskedKey = "***"
	}

	// Prompts sent to the agent always start the AI Agent unless explicitly formatted as a shell command ($ or >)
	trimmedPrompt := strings.TrimSpace(prompt)
	isExplicitShell := strings.HasPrefix(trimmedPrompt, "$ ") || strings.HasPrefix(trimmedPrompt, "> ")
	shouldRunAi := !isExplicitShell
	log.Printf("[INFO][%s] AgentBridge RunPrompt: prompt=%q, convID=%q, model=%q, reasoning=%q, project=%q, url=%q, key=%s, hasAiEndpoint=%v, isShellCmd=%v, shouldRunAi=%v",
		execID, prompt, cID, activeModel, activeReasoning, project, activeUrl, maskedKey, hasAiEndpoint, isShellCmd, shouldRunAi)

	b.mu.Lock()
	needsApproval := false
	if !forceApprove && !shouldRunAi {
		if b.isCommandAllowedLocked(prompt, cID, b.activeProject) {
			needsApproval = false
		} else {
			policyToUse := b.permissionPolicy
			termPolicyToUse := b.terminalExecutionPolicy
			if termPolicyToUse == "" {
				termPolicyToUse = "sandbox"
			}

			if b.activeProject != "" && b.projectPermissions != nil {
				if pPerm, ok := b.projectPermissions[b.activeProject]; ok {
					if pPerm.PermissionPolicy != "" && pPerm.PermissionPolicy != "inherit" {
						policyToUse = pPerm.PermissionPolicy
					}
					if pPerm.TerminalExecutionPolicy != "" && pPerm.TerminalExecutionPolicy != "inherit" {
						termPolicyToUse = pPerm.TerminalExecutionPolicy
					}
				}
			}

			if policyToUse == "full_auto" || termPolicyToUse == "full_auto" {
				needsApproval = false
			} else if policyToUse == "ask_all" || policyToUse == "" || termPolicyToUse == "prompt" {
				needsApproval = true
			} else if policyToUse == "safe_auto" || termPolicyToUse == "safe_auto" {
				needsApproval = !isSafeCommand(prompt)
			} else {
				needsApproval = !isSafeCommand(prompt)
			}
		}
	}
	if needsApproval {
		prefix := extractCommandPrefix(prompt)
		desc := generateApprovalDescription(prompt)
		b.pendingApproval = &ApprovalRequest{
			ID:            execID,
			Action:        prompt,
			CommandPrefix: prefix,
			Description:   desc,
			Timestamp:     time.Now().Format("15:04:05"),
			Project:       b.activeProject,
		}
		b.mu.Unlock()

		if isDebug {
			log.Printf("[DEBUG] RunPrompt requires approval: ID=%s, command=%q, prefix=%q (stopping until user responds)", execID, prompt, prefix)
		}

		// Return pending approval notification with rich options metadata
		resp, _ := json.Marshal(map[string]interface{}{
			"id":              execID,
			"status":          "pending_approval",
			"needs_approval":  true,
			"prompt":          prompt,
			"command_prefix":  prefix,
			"description":     desc,
			"project":         b.activeProject,
			"conversation_id": cID,
		})
		return string(resp)
	}
	b.mu.Unlock()

	var output string
	var err error
	var debugInfo map[string]interface{}
	var workflowExec *shuffle.WorkflowExecution

	if shouldRunAi {
		log.Printf("[INFO] RunPrompt routing decision: executing AI request directly via shuffle.RunAiQuery (model=%s, reasoning=%s, url=%s, execID=%s)", activeModel, activeReasoning, activeUrl, execID)
		output, workflowExec, err = b.executeAiRequest(prompt, execID, activeModel, activeReasoning)
		debugInfo = map[string]interface{}{
			"mode":      "shuffle_agent_direct",
			"target":    activeUrl,
			"model":     activeModel,
			"reasoning": activeReasoning,
			"project":   project,
			"has_url":   activeUrl != "",
			"has_key":   effectiveKey != "",
			"is_auth":   b.oauthLoggedIn,
			"engine":    "shuffle.RunAiQuery",
		}
	} else {
		log.Printf("[INFO] RunPrompt routing decision: explicit shell command %q dispatched to osctrl direct execution in %s", prompt, project)
		output, err = b.executeDirect(prompt)
		debugInfo = map[string]interface{}{
			"mode":    "osctrl_direct_exec",
			"target":  project,
			"model":   "local_shell",
			"project": project,
			"engine":  "osctrl.RunCommandString",
		}
		workflowExec = &shuffle.WorkflowExecution{
			Type:              "DIRECT_SHELL",
			ExecutionId:       execID,
			StartedAt:         start.Unix(),
			CompletedAt:       time.Now().Unix(),
			ExecutionArgument: prompt,
			Result:            output,
			Results: []shuffle.ActionResult{
				{
					ExecutionId: execID,
					Result:      output,
					Status:      "SUCCESS",
				},
			},
		}
	}

	status := "success"
	errStr := ""
	errorType := ""
	fixHelp := ""
	if err != nil {
		status = "error"
		errStr = err.Error()

		errLower := strings.ToLower(errStr)
		if strings.Contains(errLower, "no llm apikey") || strings.Contains(errLower, "apikey") || strings.Contains(errLower, "unauthorized") || strings.Contains(errLower, "custom ai app authentication") || strings.Contains(errLower, "no organization-specific key") {
			errorType = "missing_credentials"
			fixHelp = "No AI model credentials found. Configure your API key (Gemini, OpenAI, Anthropic, or Ollama) in Settings > AI & Models, or log in with your Shuffle account in Settings > Shuffle Account."
		} else if strings.Contains(errLower, "connection refused") || strings.Contains(errLower, "dial tcp") || strings.Contains(errLower, "no such host") {
			errorType = "network_unreachable"
			fixHelp = "Could not connect to the AI endpoint or Shuffle backend. Check your network connection and verify AI API URL in Settings > AI & Models."
		} else if strings.Contains(errLower, "rate limit") || strings.Contains(errLower, "quota") || strings.Contains(errLower, "429") || strings.Contains(errLower, "resource_exhausted") || strings.Contains(errLower, "too many requests") {
			errorType = "rate_limited"
			fixHelp = "AI model rate limit or quota exceeded (HTTP 429). Check your provider quota or switch to another model in Settings > AI & Models."
		} else if strings.Contains(errLower, "127") || strings.Contains(errLower, "command not found") {
			errorType = "command_not_found"
			fixHelp = "Command was not found on your system PATH."
		} else {
			errorType = "execution_error"
			fixHelp = "Agent execution stopped with an error. Review the error details below."
		}

		if output == "" {
			output = errStr
		}
	}

	duration := time.Since(start).Round(time.Millisecond).String()

	var extractedDecisions []shuffle.AgentDecision
	var extractedSteps []ConversationStep
	if workflowExec != nil {
		for _, actionRes := range workflowExec.Results {
			if actionRes.Result == "" {
				continue
			}
			var agentOut shuffle.AgentOutput
			if jsonErr := json.Unmarshal([]byte(actionRes.Result), &agentOut); jsonErr == nil && len(agentOut.Decisions) > 0 {
				extractedDecisions = append(extractedDecisions, agentOut.Decisions...)
			} else {
				var directDecs []shuffle.AgentDecision
				if jsonErr2 := json.Unmarshal([]byte(actionRes.Result), &directDecs); jsonErr2 == nil && len(directDecs) > 0 {
					extractedDecisions = append(extractedDecisions, directDecs...)
				}
			}
		}

		for _, dec := range extractedDecisions {
			stepName := dec.Action
			if stepName == "" {
				stepName = dec.Tool
			}
			if stepName == "" {
				stepName = "Agent Step"
			}
			stepType := "thought"
			if dec.Tool != "" && dec.Tool != "thought" {
				stepType = "cmd"
			}
			stepDur := ""
			if dec.RunDetails.CompletedAt > 0 && dec.RunDetails.StartedAt > 0 {
				diff := dec.RunDetails.CompletedAt - dec.RunDetails.StartedAt
				if diff > 1000 {
					stepDur = fmt.Sprintf("%.1fs", float64(diff)/1000.0)
				} else {
					stepDur = fmt.Sprintf("%dms", diff)
				}
			}
			detailText := dec.Reason
			if detailText == "" {
				detailText = dec.RunDetails.RawResponse
			}
			extractedSteps = append(extractedSteps, ConversationStep{
				ID:        fmt.Sprintf("step-%d", dec.I),
				Name:      stepName,
				Detail:    detailText,
				Type:      stepType,
				Duration:  stepDur,
				Collapsed: true,
			})
		}
	}

	if err != nil {
		log.Printf("[ERROR][%s] RunPrompt completed with error: %v (type=%s, duration=%s)", execID, err, errorType, duration)
	} else {
		log.Printf("[INFO][%s] RunPrompt completed successfully in %s (decisions=%d, steps=%d, output bytes=%d)", execID, duration, len(extractedDecisions), len(extractedSteps), len(output))
	}

	if cID == "" {
		cID = fmt.Sprintf("conv-%d", time.Now().UnixMilli())
	}

	turn := ConversationTurn{
		ID:                execID,
		Prompt:            prompt,
		Timestamp:         time.Now().Format("15:04:05"),
		Steps:             extractedSteps,
		Output:            output,
		Status:            status,
		Duration:          duration,
		Error:             errStr,
		ErrorType:         errorType,
		FixHelp:           fixHelp,
		DebugInfo:         debugInfo,
		WorkflowExecution: workflowExec,
	}

	savedConv, errSave := AppendTurnToConversation(cID, turn, project, "")
	if errSave != nil {
		log.Printf("[WARNING] Failed to append turn to conversation %s: %v", cID, errSave)
	}

	entry := ExecutionEntry{
		ID:                execID,
		ConversationID:    cID,
		Timestamp:         time.Now().Format("15:04:05"),
		Prompt:            prompt,
		Output:            output,
		Status:            status,
		Duration:          duration,
		Error:             errStr,
		ErrorType:         errorType,
		FixHelp:           fixHelp,
		DebugInfo:         debugInfo,
		Steps:             extractedSteps,
		Decisions:         extractedDecisions,
		Conversation:      savedConv,
		WorkflowExecution: workflowExec,
	}
	if savedConv != nil {
		entry.Turns = savedConv.Turns
	}

	b.mu.Lock()
	b.history = append([]ExecutionEntry{entry}, b.history...)
	if len(b.history) > 50 {
		b.history = b.history[:50]
	}
	b.pendingApproval = nil
	b.mu.Unlock()

	resp, _ := json.Marshal(entry)
	return string(resp)
}

// RespondApproval handles basic boolean user decision from the UI
func (b *AgentBridge) RespondApproval(execID string, approved bool) string {
	if !approved {
		return b.RespondApprovalWithOptions(execID, 5, "", "", "")
	}
	return b.RespondApprovalWithOptions(execID, 1, "", "", "")
}

// RespondApprovalWithOptions handles user decision from the UI with remembered rule scope
func (b *AgentBridge) RespondApprovalWithOptions(execID string, option int, commandPrefix, scope, scopeID string) string {
	b.mu.Lock()
	req := b.pendingApproval
	if req == nil || req.ID != execID {
		b.mu.Unlock()
		return `{"status": "not_found"}`
	}
	prompt := req.Action
	b.pendingApproval = nil

	if option == 5 {
		b.mu.Unlock()
		entry := ExecutionEntry{
			ID:        execID,
			Timestamp: time.Now().Format("15:04:05"),
			Prompt:    prompt,
			Output:    "[Denied by user: Tell the agent what to do instead]",
			Status:    "denied",
			Duration:  "0ms",
		}
		b.mu.Lock()
		b.history = append([]ExecutionEntry{entry}, b.history...)
		b.mu.Unlock()
		resp, _ := json.Marshal(entry)
		return string(resp)
	}

	cmdToRemember := commandPrefix
	if cmdToRemember == "" {
		cmdToRemember = extractCommandPrefix(prompt)
	}

	if option == 2 && cmdToRemember != "" {
		rule := ApprovalRule{
			ID:        fmt.Sprintf("rule-%d", time.Now().UnixNano()),
			Command:   cmdToRemember,
			Scope:     "conversation",
			ScopeID:   scopeID,
			CreatedAt: time.Now().Format("2006-01-02 15:04"),
		}
		b.approvalRules = append(b.approvalRules, rule)
		b.saveLocalStoreLocked()
	} else if option == 3 && cmdToRemember != "" {
		rule := ApprovalRule{
			ID:        fmt.Sprintf("rule-%d", time.Now().UnixNano()),
			Command:   cmdToRemember,
			Scope:     "project",
			ScopeID:   b.activeProject,
			CreatedAt: time.Now().Format("2006-01-02 15:04"),
		}
		b.approvalRules = append(b.approvalRules, rule)
		b.saveLocalStoreLocked()
	} else if option == 4 && cmdToRemember != "" {
		rule := ApprovalRule{
			ID:        fmt.Sprintf("rule-%d", time.Now().UnixNano()),
			Command:   cmdToRemember,
			Scope:     "global",
			ScopeID:   "",
			CreatedAt: time.Now().Format("2006-01-02 15:04"),
		}
		b.approvalRules = append(b.approvalRules, rule)
		b.saveLocalStoreLocked()
	}
	b.mu.Unlock()

	// User approved: run with forceApprove=true
	return b.RunPrompt(prompt, true, scopeID)
}

// GetApprovalRules returns remembered approval rules as JSON
func (b *AgentBridge) GetApprovalRules() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	data, _ := json.Marshal(b.approvalRules)
	return string(data)
}

// AddApprovalRule stores a remembered approval rule
func (b *AgentBridge) AddApprovalRule(ruleJSON string) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	var rule ApprovalRule
	if err := json.Unmarshal([]byte(ruleJSON), &rule); err != nil {
		return `{"error": "invalid rule payload"}`
	}
	if rule.ID == "" {
		rule.ID = fmt.Sprintf("rule-%d", time.Now().UnixNano())
	}
	if rule.CreatedAt == "" {
		rule.CreatedAt = time.Now().Format("2006-01-02 15:04")
	}
	b.approvalRules = append(b.approvalRules, rule)
	b.saveLocalStoreLocked()
	data, _ := json.Marshal(b.approvalRules)
	return string(data)
}

// RevokeApprovalRule removes a remembered approval rule by ID
func (b *AgentBridge) RevokeApprovalRule(ruleID string) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	newRules := make([]ApprovalRule, 0)
	for _, r := range b.approvalRules {
		if r.ID != ruleID {
			newRules = append(newRules, r)
		}
	}
	b.approvalRules = newRules
	b.saveLocalStoreLocked()
	data, _ := json.Marshal(b.approvalRules)
	return string(data)
}

// ClearApprovalRules removes all remembered approval rules
func (b *AgentBridge) ClearApprovalRules() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.approvalRules = make([]ApprovalRule, 0)
	b.saveLocalStoreLocked()
	return `{"status": "ok"}`
}

// SetPinnedConversations updates the pinned conversations list
func (b *AgentBridge) SetPinnedConversations(pinnedJSON string) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	var pinned []string
	if err := json.Unmarshal([]byte(pinnedJSON), &pinned); err == nil {
		b.pinnedConvs = pinned
		b.saveLocalStoreLocked()
	}
	data, _ := json.Marshal(b.pinnedConvs)
	return string(data)
}

// TakeScreenshot captures displays and returns base64 PNGs directly
func (b *AgentBridge) TakeScreenshot() string {
	screens, err := osctrl.Screenshot()
	if err != nil {
		return fmt.Sprintf(`{"error": "%s"}`, err.Error())
	}

	type ScreenDTO struct {
		Index       int    `json:"index"`
		ImageBase64 string `json:"image_base64"`
	}
	result := make([]ScreenDTO, len(screens))
	for i, scr := range screens {
		result[i] = ScreenDTO{
			Index:       i,
			ImageBase64: fmt.Sprintf("data:image/png;base64,%s", base64.StdEncoding.EncodeToString(scr.Image)),
		}
	}
	data, _ := json.Marshal(result)
	return string(data)
}

// InspectUI elements on the main display via osctrl
func (b *AgentBridge) InspectUI() string {
	if runtime.GOOS != "darwin" {
		return `{"error": "UI inspection is supported on macOS"}`
	}

	elements, err := osctrl.FetchFocusedElement(1, 4)
	if err != nil {
		return fmt.Sprintf(`{"error": "%s"}`, err.Error())
	}

	data, _ := json.Marshal(elements)
	return string(data)
}

// GetHostTelemetry returns compliance & machine specs
func (b *AgentBridge) GetHostTelemetry() string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	stats := CollectSensorStats(ctx, b.cfg)
	data, _ := json.Marshal(stats)
	return string(data)
}

func (b *AgentBridge) executeDirect(cmd string) (string, error) {
	cleanCmd := strings.TrimPrefix(strings.TrimSpace(cmd), "$ ")
	cleanCmd = strings.TrimPrefix(cleanCmd, "> ")
	cleanCmd = osctrl.RCECleanup(cleanCmd)
	fullCmd := cleanCmd
	if b.activeProject != "" && b.activeProject != "." {
		fullCmd = fmt.Sprintf("cd %s && %s", b.activeProject, cleanCmd)
	}
	return osctrl.RunCommandString(fullCmd, 30*time.Second, nil)
}

// executeAiRequest directly executes the AI prompt using shuffle-shared/ai.go RunAiQuery
func (b *AgentBridge) executeAiRequest(prompt, execID string, reqModelAndReasoning ...string) (string, *shuffle.WorkflowExecution, error) {
	b.mu.Lock()
	apiURL := b.getEffectiveAiUrlLocked()
	apiKey := b.getEffectiveAiKeyLocked()
	model := b.aiModel
	if len(reqModelAndReasoning) > 0 && reqModelAndReasoning[0] != "" {
		model = reqModelAndReasoning[0]
	}
	if model == "" {
		model = "gemini-3.8-flash"
	}
	reasoning := "medium"
	if len(reqModelAndReasoning) > 1 && reqModelAndReasoning[1] != "" {
		reasoning = reqModelAndReasoning[1]
	}
	project := b.activeProject
	orgID := ""
	if b.cfg != nil {
		orgID = b.cfg.Org
	}
	isDebug := (b.cfg != nil && b.cfg.Debug) || os.Getenv("DEBUG") == "true" || os.Getenv("DEBUG") == "1"
	b.mu.Unlock()

	// Default endpoint resolution for Gemini or OpenAI if URL is not explicitly configured
	if apiURL == "" {
		if strings.HasPrefix(strings.ToLower(model), "gemini") {
			apiURL = "https://generativelanguage.googleapis.com/v1beta/openai"
		} else {
			apiURL = "https://api.openai.com/v1"
		}
	}

	// Export credentials and settings into environment for shuffle-shared/ai.go
	if apiKey != "" {
		os.Setenv("AI_API_KEY", apiKey)
		os.Setenv("SHUFFLE_AUTHORIZATION", apiKey)
		os.Setenv("SHUFFLE_SESSION_TOKEN", apiKey)
	}
	if apiURL != "" {
		os.Setenv("AI_API_URL", apiURL)
		if strings.Contains(apiURL, "shuffler.io") || strings.Contains(apiURL, "shuffle") {
			cleanUrl := strings.TrimRight(strings.TrimSuffix(apiURL, "/api/v1"), "/")
			os.Setenv("SHUFFLE_BASE_URL", cleanUrl)
			os.Setenv("BASE_URL", cleanUrl)
			b.mu.Lock()
			if b.cfg != nil {
				b.cfg.BaseURL = cleanUrl
				if apiKey != "" {
					b.cfg.Auth = apiKey
				}
			}
			b.mu.Unlock()
		}
	}
	if model != "" {
		os.Setenv("AI_MODEL", model)
		os.Setenv("SHUFFLE_AI_MODEL", model)
	}
	os.Setenv("AI_REASONING_EFFORT", reasoning)
	os.Setenv("AI_AGENT_REASONING_EFFORT", reasoning)
	os.Setenv("SHUFFLE_REASONING_EFFORT", reasoning)
	os.Setenv("STANDALONE", "true")
	os.Setenv("SHUFFLE_STANDALONE", "true")

	maskedKey := "none"
	if len(apiKey) > 8 {
		maskedKey = apiKey[:4] + "..." + apiKey[len(apiKey)-4:]
	} else if apiKey != "" {
		maskedKey = "***"
	}

	log.Printf("[INFO][%s] AI Agent: Executing direct prompt query with shuffle.RunAiQuery (model=%s, reasoning=%s, url=%s, key=%s, prompt_len=%d)",
		execID, model, reasoning, apiURL, maskedKey, len(prompt))

	sysPrompt := BuildInjectedSystemPrompt(project)
	callInfo := shuffle.AiCallInfo{
		Caller:      "orborus",
		OrgID:       orgID,
		ExecutionId: execID,
	}

	actionID := fmt.Sprintf("act-%d", time.Now().UnixNano())
	exec := shuffle.WorkflowExecution{
		Type:              "AGENT",
		Start:             actionID,
		Status:            "EXECUTING",
		ExecutionId:       execID,
		ExecutionOrg:      orgID,
		StartedAt:         time.Now().Unix(),
		ExecutionArgument: prompt,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	respStr, err := shuffle.RunAiQuery(ctx, callInfo, sysPrompt, prompt)
	exec.CompletedAt = time.Now().Unix()
	if err != nil {
		exec.Status = "FAILURE"
		exec.Result = err.Error()
		log.Printf("[ERROR][%s] AI Agent: shuffle.RunAiQuery returned error: %v", execID, err)
		return respStr, &exec, err
	}

	exec.Status = "FINISHED"
	exec.Result = respStr
	exec.Results = append(exec.Results, shuffle.ActionResult{
		Action: shuffle.Action{
			ID:      actionID,
			Name:    "AgentQuery",
			AppName: "Shuffle Agent",
		},
		ExecutionId: execID,
		Result:      respStr,
		Status:      "SUCCESS",
	})

	if isDebug {
		log.Printf("[DEBUG][%s] AI Agent: shuffle.RunAiQuery completed successfully (output chars: %d)", execID, len(respStr))
	} else {
		log.Printf("[INFO][%s] AI Agent: shuffle.RunAiQuery completed successfully (output chars: %d)", execID, len(respStr))
	}

	return respStr, &exec, nil
}

// HandleAction dispatches incoming actions from the WebKit/UI bridge
func (b *AgentBridge) HandleAction(action string, payload string) (res string) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[ERROR] Recovered from panic in AgentBridge.HandleAction: %v", r)
			res = fmt.Sprintf(`{"status":"error","error":%q,"error_type":"execution_error","fix_help":"Internal runtime panic: %v"}`, fmt.Sprintf("Internal runtime error: %v", r), r)
		}
	}()

	isDebug := strings.EqualFold(os.Getenv("DEBUG"), "true") || os.Getenv("DEBUG") == "1" ||
		(b != nil && b.GetConfig() != nil && b.GetConfig().Debug)
	if isDebug {
		log.Printf("[DEBUG] HandleAction: %s (payload: %s)", action, payload)
	}

	switch action {
	case "getInitialState":
		return b.GetInitialState()

	case "listProjects":
		return b.ListProjects()

	case "selectProject":
		return b.SelectProject(payload)

	case "setPermissionPolicy":
		return b.SetPermissionPolicy(payload)

	case "runPrompt":
		var req struct {
			Prompt         string `json:"prompt"`
			Bypass         bool   `json:"bypass"`
			ConversationID string `json:"conversation_id"`
			Model          string `json:"model"`
			Reasoning      string `json:"reasoning"`
			AiApiKey       string `json:"ai_api_key"`
			AiApiUrl       string `json:"ai_api_url"`
		}
		if err := json.Unmarshal([]byte(payload), &req); err != nil {
			req.Prompt = payload
		}
		log.Printf("[INFO] AgentBridge.HandleAction \"runPrompt\": prompt=%q, model=%q, reasoning=%q, convID=%q, keyPresent=%v, url=%q",
			req.Prompt, req.Model, req.Reasoning, req.ConversationID, req.AiApiKey != "", req.AiApiUrl)
		if req.AiApiKey != "" {
			b.mu.Lock()
			b.aiApiKey = strings.TrimSpace(req.AiApiKey)
			_ = os.Setenv("AI_API_KEY", b.aiApiKey)
			_ = os.Setenv("SHUFFLE_AUTHORIZATION", b.aiApiKey)
			_ = os.Setenv("SHUFFLE_SESSION_TOKEN", b.aiApiKey)
			if b.cfg != nil && (strings.Contains(b.aiApiUrl, "shuffler.io") || strings.Contains(b.aiApiUrl, "shuffle")) {
				b.cfg.Auth = b.aiApiKey
			}
			b.mu.Unlock()
		}
		if req.AiApiUrl != "" {
			b.mu.Lock()
			b.aiApiUrl = strings.TrimSpace(req.AiApiUrl)
			_ = os.Setenv("AI_API_URL", b.aiApiUrl)
			if strings.Contains(b.aiApiUrl, "shuffler.io") || strings.Contains(b.aiApiUrl, "shuffle") {
				cleanUrl := strings.TrimRight(strings.TrimSuffix(b.aiApiUrl, "/api/v1"), "/")
				_ = os.Setenv("SHUFFLE_BASE_URL", cleanUrl)
				_ = os.Setenv("BASE_URL", cleanUrl)
				if b.cfg != nil {
					b.cfg.BaseURL = cleanUrl
				}
			}
			b.mu.Unlock()
		}
		res = b.RunPromptWithOpts(req.Prompt, req.Bypass, req.ConversationID, req.Model, req.Reasoning)
		log.Printf("[INFO] AgentBridge.HandleAction \"runPrompt\" completed for convID=%q (response bytes: %d)", req.ConversationID, len(res))
		return res

	case "respondApproval":
		var req struct {
			ID            string `json:"id"`
			Approved      bool   `json:"approved"`
			Option        int    `json:"option"`
			CommandPrefix string `json:"command_prefix"`
			Scope         string `json:"scope"`
			ScopeID       string `json:"scope_id"`
		}
		if err := json.Unmarshal([]byte(payload), &req); err == nil {
			if req.Option > 0 {
				return b.RespondApprovalWithOptions(req.ID, req.Option, req.CommandPrefix, req.Scope, req.ScopeID)
			}
			return b.RespondApproval(req.ID, req.Approved)
		}
		return `{"error": "invalid payload"}`

	case "respondApprovalWithOptions":
		var req struct {
			ID            string `json:"id"`
			Option        int    `json:"option"`
			CommandPrefix string `json:"command_prefix"`
			Scope         string `json:"scope"`
			ScopeID       string `json:"scope_id"`
		}
		if err := json.Unmarshal([]byte(payload), &req); err == nil {
			return b.RespondApprovalWithOptions(req.ID, req.Option, req.CommandPrefix, req.Scope, req.ScopeID)
		}
		return `{"error": "invalid payload"}`

	case "getApprovalRules":
		return b.GetApprovalRules()

	case "addApprovalRule":
		return b.AddApprovalRule(payload)

	case "revokeApprovalRule":
		return b.RevokeApprovalRule(payload)

	case "clearApprovalRules":
		return b.ClearApprovalRules()

	case "setPinnedConversations":
		return b.SetPinnedConversations(payload)

	case "takeScreenshot":
		return b.TakeScreenshot()

	case "inspectUI":
		return b.InspectUI()

	case "requestOSPermission":
		if payload == "accessibility" {
			osctrl.PromptAccessibility()
		} else if payload == "screen" {
			osctrl.PromptScreenRecording()
		}
		return `{"status": "ok"}`

	case "updateAuth":
		return b.UpdateAuth(payload)

	case "startOAuthLogin":
		return b.StartOAuthLogin(payload)

	case "setOAuthToken":
		var req struct {
			Token string `json:"token"`
			Org   string `json:"org"`
			Env   string `json:"env"`
		}
		_ = json.Unmarshal([]byte(payload), &req)
		return b.SetOAuthToken(req.Token, req.Org, req.Env)

	case "setAiConfig":
		var req struct {
			URL              string `json:"url"`
			Key              string `json:"key"`
			Model            string `json:"model"`
			PermissionPolicy string `json:"permission_policy"`
		}
		_ = json.Unmarshal([]byte(payload), &req)
		if req.PermissionPolicy != "" {
			b.SetPermissionPolicy(req.PermissionPolicy)
		}
		return b.SetAiConfig(req.URL, req.Key, req.Model)

	case "chooseDirectory":
		path, err := webview.ChooseFolder("Select Project Directory", "Select")
		if err == nil && path != "" {
			resp, _ := json.Marshal(map[string]interface{}{"status": "ok", "path": path})
			return string(resp)
		}
		return `{"status": "cancelled", "path": ""}`

	case "chooseFile":
		path, err := webview.ChooseFile("Select File to Attach", "Select")
		if err == nil && path != "" {
			resp, _ := json.Marshal(map[string]interface{}{"status": "ok", "path": path})
			return string(resp)
		}
		return `{"status": "cancelled", "path": ""}`

	case "listConversations":
		convs, err := ListConversations()
		if err != nil {
			log.Printf("[ERROR] ListConversations error: %v", err)
			return `[]`
		}
		resp, _ := json.Marshal(convs)
		return string(resp)

	case "getConversation":
		conv, err := LoadConversation(strings.TrimSpace(payload))
		if err != nil || conv == nil {
			return `{"error": "not found"}`
		}
		resp, _ := json.Marshal(conv)
		return string(resp)

	case "saveConversation":
		var conv Conversation
		if err := json.Unmarshal([]byte(payload), &conv); err == nil && conv.ID != "" {
			if err := SaveConversation(&conv); err != nil {
				return fmt.Sprintf(`{"error": %q}`, err.Error())
			}
			return `{"status": "ok"}`
		}
		return `{"error": "invalid payload"}`

	case "deleteConversation":
		if err := DeleteConversation(strings.TrimSpace(payload)); err != nil {
			return fmt.Sprintf(`{"error": %q}`, err.Error())
		}
		return `{"status": "ok"}`

	case "clearHistory":
		_ = ClearAllConversations()
		return b.ClearHistory()

	case "saveAllSettings":
		return b.SaveAllSettings(payload)

	case "setProjectPermissions":
		var req struct {
			Project     string            `json:"project"`
			Permissions ProjectPermission `json:"permissions"`
		}
		if err := json.Unmarshal([]byte(payload), &req); err == nil {
			return b.SetProjectPermissions(req.Project, req.Permissions)
		}
		return `{"error": "invalid payload"}`

	case "getProjectContext":
		return b.GetProjectContext(payload)

	case "injectControlSkill":
		return b.InjectControlSkill(payload)

	case "injectSkillFile":
		var req struct {
			Path string `json:"path"`
		}
		_ = json.Unmarshal([]byte(payload), &req)
		return b.InjectSkillFile(req.Path)

	case "injectSkill":
		return b.InjectSkill(payload)

	case "removeInjectedSkill":
		var req struct {
			Name string `json:"name"`
		}
		_ = json.Unmarshal([]byte(payload), &req)
		if req.Name == "" {
			req.Name = payload
		}
		return b.RemoveInjectedSkill(req.Name)

	case "listInjectedSkills":
		return b.ListInjectedSkills()

	case "listSkills":
		return b.ListSkills(payload)

	case "clearInjectedSkills":
		return b.ClearInjectedSkills()

	default:
		log.Printf("[WARN] Unknown bridge action: %s", action)
		return `{"error": "unknown action"}`
	}
}

// GetProjectContext returns discovered rules and skills for the given or active project
func (b *AgentBridge) GetProjectContext(projectPath string) string {
	b.mu.Lock()
	if projectPath == "" {
		projectPath = b.activeProject
	}
	b.mu.Unlock()

	ctx := GetRuleLoaderManager().LoadProjectContext(projectPath)
	data, _ := json.Marshal(ctx)
	return string(data)
}

// InjectSkillFile reads a SKILL.md file, parses frontmatter and markdown body, and registers it
func (b *AgentBridge) InjectSkillFile(filePath string) string {
	if strings.TrimSpace(filePath) == "" {
		chosen, err := webview.ChooseFile("Select Skill File (SKILL.md)", "Open")
		if err != nil || strings.TrimSpace(chosen) == "" {
			return `{"status": "cancelled", "path": ""}`
		}
		filePath = chosen
	}

	skill, err := LoadSkillFromFile(filePath)
	if err != nil {
		log.Printf("[WARN] Failed to load skill file %s: %v", filePath, err)
		resp, _ := json.Marshal(map[string]interface{}{
			"status": "error",
			"error":  fmt.Sprintf("Failed to load skill file: %v", err),
		})
		return string(resp)
	}

	GetRuleLoaderManager().InjectSkill(*skill)
	b.mu.Lock()
	b.saveLocalStoreLocked()
	b.mu.Unlock()

	resp, _ := json.Marshal(map[string]interface{}{
		"status":          "ok",
		"skill":           skill,
		"injected_skills": GetRuleLoaderManager().GetInjectedSkills(),
	})
	return string(resp)
}

// InjectSkill registers a runtime skill (capability or control) and persists it
func (b *AgentBridge) InjectSkill(payload string) string {
	var skill SkillDefinition
	if err := json.Unmarshal([]byte(payload), &skill); err != nil {
		return `{"status": "error", "error": "invalid json payload"}`
	}
	skill.Name = strings.TrimSpace(skill.Name)
	if skill.Name == "" {
		return `{"status": "error", "error": "skill name is required"}`
	}
	GetRuleLoaderManager().InjectSkill(skill)

	b.mu.Lock()
	b.saveLocalStoreLocked()
	b.mu.Unlock()

	resp, _ := json.Marshal(map[string]interface{}{
		"status":          "ok",
		"skill":           skill,
		"injected_skills": GetRuleLoaderManager().GetInjectedSkills(),
	})
	return string(resp)
}

// InjectControlSkill registers a dynamic skill into runtime for agent control
func (b *AgentBridge) InjectControlSkill(payload string) string {
	var skill SkillDefinition
	if err := json.Unmarshal([]byte(payload), &skill); err != nil {
		return `{"status": "error", "error": "invalid json payload"}`
	}
	if skill.Name == "" {
		return `{"status": "error", "error": "skill name is required"}`
	}
	GetRuleLoaderManager().InjectControlSkill(skill)

	b.mu.Lock()
	b.saveLocalStoreLocked()
	b.mu.Unlock()

	resp, _ := json.Marshal(map[string]interface{}{
		"status":          "ok",
		"skill":           skill,
		"injected_skills": GetRuleLoaderManager().GetInjectedSkills(),
	})
	return string(resp)
}

// RemoveInjectedSkill removes an injected skill by name and updates local store
func (b *AgentBridge) RemoveInjectedSkill(name string) string {
	name = strings.TrimSpace(name)
	removed := GetRuleLoaderManager().RemoveInjectedSkill(name)

	b.mu.Lock()
	b.saveLocalStoreLocked()
	b.mu.Unlock()

	resp, _ := json.Marshal(map[string]interface{}{
		"status":          "ok",
		"removed":         removed,
		"injected_skills": GetRuleLoaderManager().GetInjectedSkills(),
	})
	return string(resp)
}

// ListInjectedSkills returns all currently injected skills
func (b *AgentBridge) ListInjectedSkills() string {
	resp, _ := json.Marshal(map[string]interface{}{
		"status":          "ok",
		"injected_skills": GetRuleLoaderManager().GetInjectedSkills(),
	})
	return string(resp)
}

// ListSkills returns all available project, global, and injected skills
func (b *AgentBridge) ListSkills(projectPath string) string {
	b.mu.Lock()
	if projectPath == "" {
		projectPath = b.activeProject
	}
	b.mu.Unlock()

	skills := DiscoverSkills(projectPath)
	injected := GetRuleLoaderManager().GetInjectedSkills()
	for _, inj := range injected {
		skills = append(skills, inj)
	}
	data, _ := json.Marshal(skills)
	return string(data)
}

// ClearInjectedSkills wipes dynamically injected skills
func (b *AgentBridge) ClearInjectedSkills() string {
	GetRuleLoaderManager().ClearInjectedSkills()
	b.mu.Lock()
	b.saveLocalStoreLocked()
	b.mu.Unlock()
	return `{"status": "ok", "injected_skills": []}`
}

