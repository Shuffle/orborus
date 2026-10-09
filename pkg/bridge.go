package pkg

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	openai "github.com/sashabaranov/go-openai"
	"github.com/shuffle/osctrl"
	"orborus/pkg/webview"
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
	ChangedFiles      *ChangedFilesSummary       `json:"changed_files,omitempty"`
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

// LocalAiExecutorFunc defines a pluggable local AI prompt execution handler (e.g. Tendon Native CUDA runtime)
type LocalAiExecutorFunc func(ctx context.Context, prompt, execID, model, reasoning string, b *AgentBridge) (output string, exec *shuffle.WorkflowExecution, handled bool, err error)

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
	onChunk                 func(execID, chunk string)
	aiApiKey                string
	aiApiUrl                string
	aiModel                 string
	approvalRules           []ApprovalRule
	pinnedConvs             []string
	localAiExecutor         LocalAiExecutorFunc
	localModelsDir          string
	localModelPath          string
	activeExecutionMode     string
}

// GetActiveExecutionMode returns the current active AI execution mode ("shuffle", "orborus", "direct", "local")
func (b *AgentBridge) GetActiveExecutionMode() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.activeExecutionMode
}

// SetActiveExecutionMode updates the active AI execution mode
func (b *AgentBridge) SetActiveExecutionMode(mode string) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	cleanMode := strings.TrimSpace(strings.ToLower(mode))
	if cleanMode != "" {
		b.activeExecutionMode = cleanMode
		_ = os.Setenv("ORBORUS_ACTIVE_EXECUTION_MODE", cleanMode)
		if cleanMode == "local" {
			b.aiModel = "tendon-local"
			_ = os.Setenv("AI_MODEL", "tendon-local")
		} else if cleanMode == "shuffle" || cleanMode == "orborus" {
			if b.aiModel == "tendon-local" || b.aiModel == "" {
				b.aiModel = "gemini-3.8-flash"
				_ = os.Setenv("AI_MODEL", "gemini-3.8-flash")
			}
		}
		b.saveLocalStoreLocked()
	}
	return b.activeExecutionMode
}

// SetLocalAiExecutor registers a local engine prompt runner (e.g. Tendon Native CUDA runtime)
func (b *AgentBridge) SetLocalAiExecutor(fn LocalAiExecutorFunc) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.localAiExecutor = fn
}

// GetLocalAiExecutor returns the registered local engine prompt runner
func (b *AgentBridge) GetLocalAiExecutor() LocalAiExecutorFunc {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.localAiExecutor
}

// GetLocalModelsDir returns the configured local models directory
func (b *AgentBridge) GetLocalModelsDir() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.localModelsDir
}

// SetLocalModelsDir updates the configured local models directory
func (b *AgentBridge) SetLocalModelsDir(dir string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.localModelsDir = strings.TrimSpace(dir)
	_ = os.Setenv("LOCAL_MODELS_DIR", b.localModelsDir)
	b.saveLocalStoreLocked()
}

// GetLocalModelPath returns the active local model filepath
func (b *AgentBridge) GetLocalModelPath() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.localModelPath
}

// SetLocalModelPath updates the active local model filepath
func (b *AgentBridge) SetLocalModelPath(path string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.localModelPath = strings.TrimSpace(path)
	_ = os.Setenv("LOCAL_MODEL_PATH", b.localModelPath)
	b.saveLocalStoreLocked()
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

	os.Setenv("STANDALONE", "true")
	os.Setenv("SHUFFLE_STANDALONE", "true")

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
	if saved.ActiveProject == "__NONE__" || saved.ActiveProject == "none" {
		activeProject = ""
	} else if saved.ActiveProject != "" {
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

	modelsDir := os.Getenv("LOCAL_MODELS_DIR")
	if modelsDir == "" && saved != nil {
		modelsDir = saved.LocalModelsDir
	}
	if modelsDir == "" {
		candidates := []string{
			"models",
			"C:/Users/Fredr/Documents/antigravity/delightful-mendeleev/models",
			"../delightful-mendeleev/models",
		}
		for _, c := range candidates {
			if info, err := os.Stat(c); err == nil && info.IsDir() {
				if abs, errAbs := filepath.Abs(c); errAbs == nil {
					modelsDir = abs
				} else {
					modelsDir = c
				}
				break
			}
		}
		if modelsDir == "" {
			modelsDir = "models"
		}
	}

	modelPath := os.Getenv("LOCAL_MODEL_PATH")
	if modelPath == "" && saved != nil {
		modelPath = saved.LocalModelPath
	}
	if modelPath == "" {
		candidates := []string{
			filepath.Join(modelsDir, "gemma-4-26B-A4B-it-UD-Q3_K_M.gguf"),
			"models/gemma-4-26B-A4B-it-UD-Q3_K_M.gguf",
			"C:/Users/Fredr/Documents/antigravity/delightful-mendeleev/models/gemma-4-26B-A4B-it-UD-Q3_K_M.gguf",
		}
		for _, c := range candidates {
			if _, err := os.Stat(c); err == nil {
				modelPath = c
				break
			}
		}
		if modelPath == "" {
			modelPath = "models/gemma-4-26B-A4B-it-UD-Q3_K_M.gguf"
		}
	}

	activeMode := os.Getenv("ORBORUS_ACTIVE_EXECUTION_MODE")
	if activeMode == "" && saved != nil {
		activeMode = saved.ActiveExecutionMode
	}
	if activeMode == "" {
		if modelPath != "" {
			activeMode = "local"
		} else if oauthLoggedIn {
			activeMode = "shuffle"
		} else if aiKey != "" {
			activeMode = "direct"
		} else {
			activeMode = "local"
		}
	}

	// Initialize known projects from saved store, active project, and existing saved conversations
	initialProjects := make([]shuffle.ProjectInfo, 0)
	knownPaths := make(map[string]bool)
	if saved != nil && len(saved.Projects) > 0 {
		for _, sp := range saved.Projects {
			cPath := strings.TrimSpace(sp.Path)
			if cPath == "" || cPath == "." {
				continue
			}
			cleanNorm := strings.ToLower(filepath.Clean(cPath))
			if !knownPaths[cleanNorm] {
				knownPaths[cleanNorm] = true
				initialProjects = append(initialProjects, shuffle.ProjectInfo{
					Path: cPath,
				})
			}
		}
	}
	if activeProject != "" && activeProject != "." {
		cleanNorm := strings.ToLower(filepath.Clean(activeProject))
		if !knownPaths[cleanNorm] {
			knownPaths[cleanNorm] = true
			initialProjects = append([]shuffle.ProjectInfo{{
				Path: activeProject,
			}}, initialProjects...)
		}
	}
	if convs, err := ListConversations(); err == nil {
		for _, c := range convs {
			pID := strings.TrimSpace(c.ProjectID)
			if pID == "" || pID == "." {
				continue
			}
			cleanPath := strings.ToLower(filepath.Clean(pID))
			if !knownPaths[cleanPath] {
				knownPaths[cleanPath] = true
				initialProjects = append(initialProjects, shuffle.ProjectInfo{
					Path: pID,
				})
			}
		}
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
		projects:                initialProjects,
		aiApiKey:                aiKey,
		aiApiUrl:                aiUrl,
		aiModel:                 aiModel,
		oauthLoggedIn:           oauthLoggedIn,
		oauthToken:              oauthToken,
		approvalRules:           rules,
		pinnedConvs:             pinned,
		localModelsDir:          modelsDir,
		localModelPath:          modelPath,
		activeExecutionMode:     activeMode,
	}

	// Trigger code repository scan immediately on initial startup
	go b.ScanProjects()

	return b
}

func (b *AgentBridge) saveLocalStoreLocked() {
	activeProj := b.activeProject
	if activeProj == "" {
		activeProj = "__NONE__"
	}

	storedProjects := make([]StoredProject, 0, len(b.projects))
	for _, p := range b.projects {
		if p.Path != "" && p.Path != "." {
			pName := filepath.Base(filepath.Clean(p.Path))
			if pName == "" || pName == "." || pName == "/" || pName == "\\" {
				pName = "Project"
			}
			storedProjects = append(storedProjects, StoredProject{
				Name: pName,
				Path: p.Path,
			})
		}
	}

	store := &LocalAgentStore{
		PermissionPolicy:        b.permissionPolicy,
		TerminalExecutionPolicy: b.terminalExecutionPolicy,
		FileAccessPolicy:        b.fileAccessPolicy,
		SandboxMode:             b.sandboxMode,
		QueuedMessages:          b.queuedMessages,
		ProjectPermissions:      b.projectPermissions,
		Projects:                storedProjects,
		AiApiUrl:                b.aiApiUrl,
		AiApiKey:                b.aiApiKey,
		AiModel:                 b.aiModel,
		ActiveProject:           activeProj,
		BaseURL:                 b.cfg.BaseURL,
		OrgID:                   b.cfg.Org,
		Environment:             b.cfg.Environment,
		OAuthToken:              b.oauthToken,
		IsLoggedIn:              b.oauthLoggedIn,
		ApprovalRules:           b.approvalRules,
		PinnedConversations:     b.pinnedConvs,
		InjectedSkills:          GetRuleLoaderManager().GetInjectedSkills(),
		LocalModelsDir:          b.localModelsDir,
		LocalModelPath:          b.localModelPath,
		ActiveExecutionMode:     b.activeExecutionMode,
	}
	if err := SaveLocalStore(store); err != nil {
		log.Printf("[WARNING] Failed to persist local agent store: %v", err)
	}
}

// isAuthBypassed checks if OrgId, Auth, Environment, custom AI, or standalone is active
func (b *AgentBridge) isAuthBypassed() bool {
	// Local AI executor bypasses remote login requirements
	if b.localAiExecutor != nil {
		return true
	}
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
	pathSet := make(map[string]bool)
	for _, p := range b.projects {
		pathSet[strings.ToLower(filepath.Clean(p.Path))] = true
	}
	for _, p := range projs {
		clean := strings.ToLower(filepath.Clean(p.Path))
		if !pathSet[clean] {
			pathSet[clean] = true
			b.projects = append(b.projects, p)
		}
	}
	if len(b.projects) == 0 && b.activeProject != "" && b.activeProject != "." {
		b.projects = append(b.projects, shuffle.ProjectInfo{
			Path: b.activeProject,
		})
	}
	b.projectsScanned = true
	b.mu.Unlock()
	log.Printf("[INFO] Code repository scan complete. Total projects: %d.", len(b.projects))
	return b.projects
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
		"local_models_dir":          b.localModelsDir,
		"local_model_path":          b.localModelPath,
		"active_execution_mode":     b.activeExecutionMode,
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

// SetOnChunk registers a listener for real-time streamed LLM tokens
func (b *AgentBridge) SetOnChunk(fn func(execID, chunk string)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onChunk = fn
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
	if len(b.projects) > 0 {
		data, _ := json.Marshal(b.projects)
		b.mu.Unlock()
		return string(data)
	}
	if b.isScanning {
		data, _ := json.Marshal(b.projects)
		b.mu.Unlock()
		return string(data)
	}
	b.mu.Unlock()

	projs := b.ScanProjects()
	data, _ := json.Marshal(projs)
	return string(data)
}

// SelectProject changes the working directory and ensures the directory exists
func (b *AgentBridge) SelectProject(path string) string {
	b.mu.Lock()

	cleanPath := strings.TrimSpace(path)
	if cleanPath == "" || cleanPath == "none" || cleanPath == "No project" || cleanPath == "__NONE__" {
		b.activeProject = ""
		b.saveLocalStoreLocked()
		projects := b.projects
		b.mu.Unlock()

		resp, _ := json.Marshal(map[string]interface{}{
			"status":         "ok",
			"active_project": "",
			"project_name":   "No project",
			"projects":       projects,
		})
		return string(resp)
	}

	cleanPath = filepath.Clean(cleanPath)

	// Ensure directory exists on disk for newly created projects
	if cleanPath != "." {
		if err := os.MkdirAll(cleanPath, 0755); err != nil {
			log.Printf("[WARNING] SelectProject: Failed to ensure directory %s: %v", cleanPath, err)
		}
	}

	b.activeProject = cleanPath
	projName := filepath.Base(cleanPath)
	if projName == "." || projName == "/" || projName == "\\" || projName == "" {
		projName = "Project"
	}

	// Move or add to top of projects list
	cleanNorm := strings.ToLower(cleanPath)
	updatedProjects := make([]shuffle.ProjectInfo, 0, len(b.projects)+1)
	updatedProjects = append(updatedProjects, shuffle.ProjectInfo{
		Path: cleanPath,
	})
	for _, p := range b.projects {
		if strings.ToLower(filepath.Clean(p.Path)) != cleanNorm && p.Path != "." && p.Path != "" {
			updatedProjects = append(updatedProjects, p)
		}
	}
	b.projects = updatedProjects

	b.saveLocalStoreLocked()
	stateStr := b.getInitialStateLocked()
	cb := b.onAuthUpdated
	b.mu.Unlock()

	if cb != nil {
		cb(stateStr)
	}

	resp, _ := json.Marshal(map[string]interface{}{
		"status":         "ok",
		"active_project": cleanPath,
		"project_name":   projName,
		"projects":       updatedProjects,
	})
	return string(resp)
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
		LocalModelsDir          string                       `json:"local_models_dir"`
		LocalModelPath          string                       `json:"local_model_path"`
		ActiveExecutionMode     string                       `json:"active_execution_mode"`
	}

	if err := json.Unmarshal([]byte(payload), &req); err != nil {
		b.mu.Unlock()
		log.Printf("[WARNING] Failed to unmarshal SaveAllSettings: %v", err)
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

	if req.LocalModelsDir != "" {
		b.localModelsDir = strings.TrimSpace(req.LocalModelsDir)
		_ = os.Setenv("LOCAL_MODELS_DIR", b.localModelsDir)
	}

	if req.LocalModelPath != "" {
		b.localModelPath = strings.TrimSpace(req.LocalModelPath)
		_ = os.Setenv("LOCAL_MODEL_PATH", b.localModelPath)
	}

	if req.ActiveExecutionMode != "" {
		cleanMode := strings.TrimSpace(strings.ToLower(req.ActiveExecutionMode))
		b.activeExecutionMode = cleanMode
		_ = os.Setenv("ORBORUS_ACTIVE_EXECUTION_MODE", cleanMode)
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

// getProjectPermissionLocked returns the project permission with path normalization and case insensitivity
func (b *AgentBridge) getProjectPermissionLocked(path string) (ProjectPermission, bool) {
	if b.projectPermissions == nil || path == "" {
		return ProjectPermission{}, false
	}
	if p, ok := b.projectPermissions[path]; ok {
		return p, true
	}
	clean := filepath.Clean(path)
	if p, ok := b.projectPermissions[clean]; ok {
		return p, true
	}
	for k, v := range b.projectPermissions {
		if strings.EqualFold(filepath.Clean(k), clean) {
			return v, true
		}
	}
	return ProjectPermission{}, false
}

// SetProjectPermissions saves permissions for a specific project
func (b *AgentBridge) SetProjectPermissions(projectPath string, perms ProjectPermission) string {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.projectPermissions == nil {
		b.projectPermissions = make(map[string]ProjectPermission)
	}
	cleanKey := filepath.Clean(strings.TrimSpace(projectPath))
	b.projectPermissions[cleanKey] = perms
	b.saveLocalStoreLocked()

	resp, _ := json.Marshal(map[string]interface{}{
		"status":      "ok",
		"project":     cleanKey,
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
		"tendon_version":            GetTendonVersion(),
		"tendon_release_url":        GetTendonReleaseURL(GetTendonVersion()),
		"local_executor_available":  true,
		"local_models_dir":          b.GetLocalModelsDir(),
		"local_model_path":          b.GetLocalModelPath(),
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

	if strings.HasPrefix(model, "tendon") || strings.HasPrefix(model, "local") {
		if envURL := os.Getenv("AI_API_URL"); envURL != "" && strings.HasPrefix(envURL, "http") {
			return envURL
		}
		return "http://127.0.0.1:8000/v1"
	}
	if strings.HasPrefix(model, "ollama") {
		return "http://localhost:11434/v1"
	}

	return ""
}

func (b *AgentBridge) GetEffectiveAiUrl() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.getEffectiveAiUrlLocked()
}

func (b *AgentBridge) GetEffectiveAiKey() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.getEffectiveAiKeyLocked()
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
func (b *AgentBridge) RunPromptWithOpts(prompt string, forceApprove bool, cID, reqModel, reqReasoning string, reqUrlAndKey ...string) string {
	start := time.Now()
	execID := fmt.Sprintf("exec-%d", time.Now().UnixNano())

	b.mu.Lock()
	effectiveUrl := b.getEffectiveAiUrlLocked()
	effectiveKey := b.getEffectiveAiKeyLocked()
	if len(reqUrlAndKey) > 0 && reqUrlAndKey[0] != "" {
		effectiveUrl = reqUrlAndKey[0]
	}
	if len(reqUrlAndKey) > 1 && reqUrlAndKey[1] != "" {
		effectiveKey = reqUrlAndKey[1]
	}
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

			if b.activeProject != "" {
				if pPerm, ok := b.getProjectPermissionLocked(b.activeProject); ok {
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

	// Snapshot workspace before prompt execution to diff before and after
	treeSnapshot := b.captureWorkingTreeSnapshot(project)

	if shouldRunAi {
		log.Printf("[INFO] RunPrompt routing decision: executing AI request directly via shuffle.RunAiQuery (model=%s, reasoning=%s, url=%s, execID=%s)", activeModel, activeReasoning, activeUrl, execID)
		output, workflowExec, err = b.executeAiRequest(prompt, execID, activeModel, activeReasoning, activeUrl, effectiveKey)
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
			fixHelp = "No AI model credentials found. Configure your API key (Gemini, OpenAI, Anthropic) or switch to Local GPU Engine in Settings."
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

	cleanOutput, extractedDecisions, extractedSteps := parseModelResponseStepsAndDecisions(output, duration, activeModel)
	output = cleanOutput

	if err != nil {
		log.Printf("[ERROR][%s] RunPrompt completed with error: %v (type=%s, duration=%s)", execID, err, errorType, duration)
	} else {
		log.Printf("[INFO][%s] RunPrompt completed successfully in %s (decisions=%d, steps=%d, output bytes=%d)", execID, duration, len(extractedDecisions), len(extractedSteps), len(output))
	}

	if cID == "" {
		cID = fmt.Sprintf("conv-%d", time.Now().UnixMilli())
	}

	b.mu.Lock()
	changedFiles := b.diffWorkingTreeSnapshot(project, treeSnapshot)
	b.mu.Unlock()

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
		ChangedFiles:      changedFiles,
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
		ChangedFiles:      changedFiles,
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

type streamChunkPayload struct {
	Choices []struct {
		Delta struct {
			Content          string `json:"content"`
			ReasoningContent string `json:"reasoning_content"`
		} `json:"delta"`
	} `json:"choices"`
}

type streamBridgeWriter struct {
	header  http.Header
	onChunk func(chunk string)
}

func (w *streamBridgeWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}

func (w *streamBridgeWriter) WriteHeader(statusCode int) {}

func (w *streamBridgeWriter) Flush() {}

func (w *streamBridgeWriter) Write(p []byte) (int, error) {
	trimmed := bytes.TrimSpace(p)
	if bytes.HasPrefix(trimmed, []byte("data: ")) {
		trimmed = bytes.TrimPrefix(trimmed, []byte("data: "))
		trimmed = bytes.TrimSpace(trimmed)
	}
	if len(trimmed) == 0 || string(trimmed) == "[DONE]" {
		return len(p), nil
	}
	var payload streamChunkPayload
	if err := json.Unmarshal(trimmed, &payload); err == nil && len(payload.Choices) > 0 {
		content := payload.Choices[0].Delta.Content
		if content == "" {
			content = payload.Choices[0].Delta.ReasoningContent
		}
		if content != "" && w.onChunk != nil {
			w.onChunk(content)
		}
	}
	return len(p), nil
}

// parseModelResponseStepsAndDecisions extracts decisions, thought steps, commands, and cleans output
func parseModelResponseStepsAndDecisions(rawOutput, duration, model string) (string, []shuffle.AgentDecision, []ConversationStep) {
	var extractedDecisions []shuffle.AgentDecision
	var extractedSteps []ConversationStep

	cleanOutput := rawOutput

	// 1. Check if rawOutput is a JSON-encoded AgentOutput or list of decisions
	var agentOut shuffle.AgentOutput
	if jsonErr := json.Unmarshal([]byte(rawOutput), &agentOut); jsonErr == nil && len(agentOut.Decisions) > 0 {
		extractedDecisions = append(extractedDecisions, agentOut.Decisions...)
		if agentOut.DecisionString != "" {
			cleanOutput = agentOut.DecisionString
		}
	} else {
		var directDecs []shuffle.AgentDecision
		if jsonErr2 := json.Unmarshal([]byte(rawOutput), &directDecs); jsonErr2 == nil && len(directDecs) > 0 {
			extractedDecisions = append(extractedDecisions, directDecs...)
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
		detailText := dec.Reason
		if detailText == "" {
			detailText = dec.RunDetails.RawResponse
		}
		extractedSteps = append(extractedSteps, ConversationStep{
			ID:        fmt.Sprintf("step-%d", dec.I),
			Name:      stepName,
			Detail:    detailText,
			Type:      stepType,
			Duration:  duration,
			Collapsed: true,
		})
	}

	// 2. Parse <thought>...</thought> or <thinking>...</thinking> tags from markdown output
	reThought := regexp.MustCompile(`(?s)<(?:thought|thinking)>(.*?)</(?:thought|thinking)>`)
	matches := reThought.FindAllStringSubmatch(cleanOutput, -1)
	for i, m := range matches {
		thoughtText := strings.TrimSpace(m[1])
		if thoughtText != "" {
			extractedSteps = append(extractedSteps, ConversationStep{
				ID:        fmt.Sprintf("thought-%d", i+1),
				Name:      "Thought Process",
				Detail:    thoughtText,
				Type:      "thought",
				Duration:  "<1s",
				Collapsed: true,
			})
		}
	}
	cleanOutput = strings.TrimSpace(reThought.ReplaceAllString(cleanOutput, ""))

	// 3. Parse bash / shell command blocks: ```bash ... ``` or ```sh ... ```
	reCmd := regexp.MustCompile("(?s)```(?:bash|sh|shell|zsh)\n(.*?)```")
	cmdMatches := reCmd.FindAllStringSubmatch(cleanOutput, -1)
	for i, m := range cmdMatches {
		cmdText := strings.TrimSpace(m[1])
		firstLine := strings.Split(cmdText, "\n")[0]
		if len(firstLine) > 40 {
			firstLine = firstLine[:37] + "..."
		}
		extractedSteps = append(extractedSteps, ConversationStep{
			ID:        fmt.Sprintf("cmd-%d", i+1),
			Name:      fmt.Sprintf("Command: %s", firstLine),
			Detail:    cmdText,
			Type:      "cmd",
			Duration:  duration,
			Collapsed: true,
		})
	}

	// 4. Default step if no structured steps were extracted
	if len(extractedSteps) == 0 {
		extractedSteps = append(extractedSteps, ConversationStep{
			ID:        "step-exec",
			Name:      "AI Query Completed",
			Detail:    fmt.Sprintf("Executed directly with %s", model),
			Type:      "cmd",
			Duration:  duration,
			Collapsed: true,
		})
	}

	return cleanOutput, extractedDecisions, extractedSteps
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
	if len(reqModelAndReasoning) > 2 && reqModelAndReasoning[2] != "" {
		apiURL = reqModelAndReasoning[2]
	}
	if len(reqModelAndReasoning) > 3 && reqModelAndReasoning[3] != "" {
		apiKey = reqModelAndReasoning[3]
	}
	project := b.activeProject
	orgID := ""
	if b.cfg != nil {
		orgID = b.cfg.Org
	}
	isDebug := (b.cfg != nil && b.cfg.Debug) || os.Getenv("DEBUG") == "true" || os.Getenv("DEBUG") == "1"
	chunkCb := b.onChunk
	localExec := b.localAiExecutor
	b.mu.Unlock()

	// 1. If a local AI executor is registered (e.g. Tendon Native CUDA in Windows Webview), check if it should handle this query
	if localExec != nil {
		modelLower := strings.ToLower(model)
		isCloudModel := strings.HasPrefix(modelLower, "gemini") ||
			strings.HasPrefix(modelLower, "gpt") ||
			strings.HasPrefix(modelLower, "claude") ||
			strings.HasPrefix(modelLower, "groq") ||
			strings.HasPrefix(modelLower, "anthropic")

		isLocalRequest := !isCloudModel && (strings.HasPrefix(modelLower, "tendon") ||
			modelLower == "local" ||
			strings.HasPrefix(modelLower, "local/") ||
			strings.HasPrefix(modelLower, "local-") ||
			strings.HasPrefix(apiURL, "local://") ||
			apiKey == "local-tendon")

		if isLocalRequest {
			ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
			defer cancel()
			out, exec, handled, err := localExec(ctx, prompt, execID, model, reasoning, b)
			if handled {
				return out, exec, err
			}
		}
	}

	// Default endpoint resolution for Gemini, Tendon local, or OpenAI if URL is not explicitly configured
	if apiURL == "" || strings.HasPrefix(apiURL, "local://") || strings.Contains(apiURL, "tendon") {
		if strings.HasPrefix(strings.ToLower(model), "gemini") {
			apiURL = "https://generativelanguage.googleapis.com/v1beta/openai"
		} else if strings.HasPrefix(strings.ToLower(model), "tendon") || strings.Contains(strings.ToLower(model), "local") || strings.HasPrefix(apiURL, "local://") || strings.Contains(apiURL, "tendon") {
			if envURL := os.Getenv("AI_API_URL"); envURL != "" && strings.HasPrefix(envURL, "http") {
				apiURL = envURL
			} else {
				apiURL = "http://127.0.0.1:8000/v1"
			}
		} else {
			apiURL = "https://api.openai.com/v1"
		}
	}

	if apiKey == "" && strings.HasPrefix(strings.ToLower(model), "gemini") {
		if k := os.Getenv("GEMINI_API_KEY"); k != "" {
			apiKey = k
		} else if k := os.Getenv("GOOGLE_API_KEY"); k != "" {
			apiKey = k
		}
	}

	// Sanitize any remaining local:// protocol scheme to prevent net/http unsupported protocol error
	if strings.HasPrefix(apiURL, "local://") {
		if envURL := os.Getenv("AI_API_URL"); envURL != "" && strings.HasPrefix(envURL, "http") {
			apiURL = envURL
		} else {
			apiURL = "http://127.0.0.1:8000/v1"
		}
	}

	// For local endpoints, an API key is not strictly required,
	// but SDK clients may require a placeholder token string to avoid client-side validation errors.
	if apiKey == "" && (strings.Contains(apiURL, "localhost") || strings.Contains(apiURL, "127.0.0.1") || strings.Contains(apiURL, "0.0.0.0") || strings.HasPrefix(apiURL, "local://")) {
		apiKey = "local-tendon"
	}

	// Pass request-scoped details via shuffle.AiCallInfo without mutating global process environment
	if strings.Contains(apiURL, "shuffler.io") || strings.Contains(apiURL, "shuffle") {
		cleanUrl := strings.TrimRight(strings.TrimSuffix(apiURL, "/api/v1"), "/")
		b.mu.Lock()
		if b.cfg != nil {
			b.cfg.BaseURL = cleanUrl
			if apiKey != "" {
				b.cfg.Auth = apiKey
			}
		}
		b.mu.Unlock()
	}

	maskedKey := "none"
	if len(apiKey) > 8 {
		maskedKey = apiKey[:4] + "..." + apiKey[len(apiKey)-4:]
	} else if apiKey != "" {
		maskedKey = "***"
	}

	log.Printf("[INFO][%s] AI Agent: Executing direct prompt query with shuffle.RunAiQuery (model=%s, reasoning=%s, url=%s, key=%s, prompt_len=%d)",
		execID, model, reasoning, apiURL, maskedKey, len(prompt))

	var streamWriter *streamBridgeWriter
	if chunkCb != nil {
		streamWriter = &streamBridgeWriter{
			onChunk: func(chunk string) {
				chunkCb(execID, chunk)
			},
		}
	}

	sysPrompt := BuildInjectedSystemPrompt(project)
	callInfo := shuffle.AiCallInfo{
		Caller:          "orborus",
		OrgID:           orgID,
		ExecutionId:     execID,
		Resp:            streamWriter,
		Url:             apiURL,
		Model:           model,
		ApiKey:          apiKey,
		ReasoningEffort: reasoning,
	}

	incomingReq := openai.ChatCompletionRequest{
		Model:  model,
		Stream: true,
		Messages: []openai.ChatCompletionMessage{
			{
				Role:    openai.ChatMessageRoleSystem,
				Content: sysPrompt,
			},
			{
				Role:    openai.ChatMessageRoleUser,
				Content: prompt,
			},
		},
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

	respStr, err := shuffle.RunAiQuery(ctx, callInfo, sysPrompt, prompt, incomingReq)
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

// ListLocalModels scans the given directory (or default localModelsDir) for .gguf model weights
func (b *AgentBridge) ListLocalModels(directory string) string {
	b.mu.Lock()
	targetDir := strings.TrimSpace(directory)
	if targetDir == "" {
		targetDir = b.localModelsDir
	}
	if targetDir == "" {
		targetDir = os.Getenv("LOCAL_MODELS_DIR")
	}
	if targetDir == "" {
		targetDir = "models"
	}
	activePath := b.localModelPath
	b.mu.Unlock()

	absDir, err := filepath.Abs(targetDir)
	if err != nil {
		absDir = targetDir
	}

	type ModelItem struct {
		Name        string `json:"name"`
		Path        string `json:"path"`
		SizeBytes   int64  `json:"size_bytes"`
		SizeDisplay string `json:"size_display"`
		ModTime     string `json:"mod_time"`
		IsActive    bool   `json:"is_active"`
		Quant       string `json:"quant,omitempty"`
	}

	var models []ModelItem

	entries, errRead := os.ReadDir(absDir)
	if errRead == nil {
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			name := entry.Name()
			if strings.HasSuffix(strings.ToLower(name), ".gguf") {
				info, errInfo := entry.Info()
				var sizeBytes int64
				var modTime string
				if errInfo == nil {
					sizeBytes = info.Size()
					modTime = info.ModTime().Format("2006-01-02 15:04:05")
				}
				sizeGB := float64(sizeBytes) / (1024 * 1024 * 1024)
				sizeDisplay := fmt.Sprintf("%.2f GB", sizeGB)
				if sizeGB < 1.0 {
					sizeDisplay = fmt.Sprintf("%.1f MB", float64(sizeBytes)/(1024*1024))
				}
				fullPath := filepath.Join(absDir, name)
				isActive := (strings.EqualFold(filepath.Clean(fullPath), filepath.Clean(activePath)) ||
					strings.EqualFold(name, filepath.Base(activePath)))

				quant := ""
				parts := strings.Split(name, "-")
				for _, p := range parts {
					pClean := strings.TrimSuffix(p, ".gguf")
					if strings.HasPrefix(strings.ToUpper(pClean), "Q") || strings.HasPrefix(strings.ToUpper(pClean), "IQ") {
						quant = pClean
						break
					}
				}

				models = append(models, ModelItem{
					Name:        name,
					Path:        fullPath,
					SizeBytes:   sizeBytes,
					SizeDisplay: sizeDisplay,
					ModTime:     modTime,
					IsActive:    isActive,
					Quant:       quant,
				})
			}
		}
	}

	if models == nil {
		models = make([]ModelItem, 0)
	}

	resp, _ := json.Marshal(map[string]interface{}{
		"status":            "ok",
		"directory":         absDir,
		"active_model_path": activePath,
		"models":            models,
		"count":             len(models),
	})
	return string(resp)
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
		targetPath := strings.TrimSpace(payload)
		var req struct {
			Path    string `json:"path"`
			Project string `json:"project"`
		}
		if err := json.Unmarshal([]byte(payload), &req); err == nil {
			if req.Path != "" {
				targetPath = req.Path
			} else if req.Project != "" {
				targetPath = req.Project
			}
		}
		return b.SelectProject(targetPath)

	case "createProject":
		var req struct {
			Path string `json:"path"`
		}
		targetPath := strings.TrimSpace(payload)
		if err := json.Unmarshal([]byte(payload), &req); err == nil && req.Path != "" {
			targetPath = req.Path
		}
		proj := b.SelectProject(targetPath)
		resp, _ := json.Marshal(map[string]interface{}{"status": "ok", "project": proj})
		return string(resp)

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
			if b.cfg != nil && (strings.Contains(b.aiApiUrl, "shuffler.io") || strings.Contains(b.aiApiUrl, "shuffle")) {
				b.cfg.Auth = b.aiApiKey
			}
			b.mu.Unlock()
		}
		if req.AiApiUrl != "" {
			b.mu.Lock()
			b.aiApiUrl = strings.TrimSpace(req.AiApiUrl)
			if strings.Contains(b.aiApiUrl, "shuffler.io") || strings.Contains(b.aiApiUrl, "shuffle") {
				cleanUrl := strings.TrimRight(strings.TrimSuffix(b.aiApiUrl, "/api/v1"), "/")
				if b.cfg != nil {
					b.cfg.BaseURL = cleanUrl
				}
			}
			b.mu.Unlock()
		}
		res = b.RunPromptWithOpts(req.Prompt, req.Bypass, req.ConversationID, req.Model, req.Reasoning, req.AiApiUrl, req.AiApiKey)
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

	case "listLocalModels":
		var req struct {
			Directory string `json:"directory"`
		}
		_ = json.Unmarshal([]byte(payload), &req)
		dir := req.Directory
		if dir == "" {
			dir = strings.TrimSpace(payload)
		}
		return b.ListLocalModels(dir)

	case "setLocalModel":
		var req struct {
			Path      string `json:"path"`
			Directory string `json:"directory"`
		}
		_ = json.Unmarshal([]byte(payload), &req)
		if req.Path != "" {
			b.SetLocalModelPath(req.Path)
		}
		if req.Directory != "" {
			b.SetLocalModelsDir(req.Directory)
		}
		resp, _ := json.Marshal(map[string]interface{}{
			"status":            "ok",
			"active_model_path": b.GetLocalModelPath(),
			"models_dir":        b.GetLocalModelsDir(),
		})
		return string(resp)

	case "setActiveExecutionMode":
		var req struct {
			Mode string `json:"mode"`
		}
		_ = json.Unmarshal([]byte(payload), &req)
		mode := req.Mode
		if mode == "" && strings.TrimSpace(payload) != "" && !strings.HasPrefix(strings.TrimSpace(payload), "{") {
			mode = strings.TrimSpace(payload)
		}
		active := b.SetActiveExecutionMode(mode)
		return fmt.Sprintf(`{"status":"ok","active_execution_mode":%q}`, active)

	case "chooseDirectory":
		var req struct {
			Title string `json:"title"`
		}
		title := "Select Directory"
		if err := json.Unmarshal([]byte(payload), &req); err == nil && req.Title != "" {
			title = req.Title
		} else if strings.TrimSpace(payload) != "" && !strings.HasPrefix(strings.TrimSpace(payload), "{") {
			title = strings.TrimSpace(payload)
		}
		path, err := webview.ChooseFolder(title, "Select")
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

	case "archiveConversation":
		convID := strings.TrimSpace(payload)
		conv, err := LoadConversation(convID)
		if err == nil && conv != nil {
			conv.Archived = true
			if err := SaveConversation(conv); err != nil {
				return fmt.Sprintf(`{"error": %q}`, err.Error())
			}
			return `{"status": "ok"}`
		}
		return `{"error": "not found"}`

	case "unarchiveConversation":
		convID := strings.TrimSpace(payload)
		conv, err := LoadConversation(convID)
		if err == nil && conv != nil {
			conv.Archived = false
			if err := SaveConversation(conv); err != nil {
				return fmt.Sprintf(`{"error": %q}`, err.Error())
			}
			return `{"status": "ok"}`
		}
		return `{"error": "not found"}`

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

	case "readFilePreview":
		var req struct {
			Path string `json:"path"`
		}
		_ = json.Unmarshal([]byte(payload), &req)
		if req.Path == "" {
			req.Path = strings.TrimSpace(payload)
		}
		return b.ReadFilePreview(req.Path)

	case "getChangedFiles":
		var req struct {
			Project string `json:"project"`
		}
		_ = json.Unmarshal([]byte(payload), &req)
		proj := req.Project
		b.mu.Lock()
		if proj == "" {
			proj = b.activeProject
		}
		changes := b.getProjectGitChangesLocked(proj)
		b.mu.Unlock()
		if changes == nil {
			return `{"total_files": 0, "additions": 0, "deletions": 0, "files": []}`
		}
		data, _ := json.Marshal(changes)
		return string(data)

	case "getRightSidebarData":
		return b.GetRightSidebarData()

	default:
		log.Printf("[WARNING] Unknown bridge action: %s", action)
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

	if projectPath == "" || projectPath == "__NONE__" {
		return `{"rules":[],"skills":[]}`
	}

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
		log.Printf("[WARNING] Failed to load skill file %s: %v", filePath, err)
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

	var skills []SkillDefinition
	if projectPath != "" && projectPath != "__NONE__" {
		skills = DiscoverSkills(projectPath)
	}
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

// FileSnap records snapshot state of a file before execution
type FileSnap struct {
	Path    string
	Status  string
	Hash    string
	Size    int64
	Content string
}

// WorkingTreeSnapshot captures the state of working tree before a prompt or command runs
type WorkingTreeSnapshot struct {
	ProjectPath string
	IsGit       bool
	Files       map[string]FileSnap
}

func (b *AgentBridge) captureWorkingTreeSnapshot(projectPath string) *WorkingTreeSnapshot {
	if projectPath == "" {
		b.mu.Lock()
		projectPath = b.activeProject
		b.mu.Unlock()
	}
	if projectPath == "" || projectPath == "__NONE__" {
		return nil
	}

	snap := &WorkingTreeSnapshot{
		ProjectPath: projectPath,
		Files:       make(map[string]FileSnap),
	}

	cmdGit := exec.Command("git", "rev-parse", "--is-inside-work-tree")
	cmdGit.Dir = projectPath
	if out, err := cmdGit.Output(); err == nil && strings.TrimSpace(string(out)) == "true" {
		snap.IsGit = true
		cmdStatus := exec.Command("git", "status", "--porcelain=v1", "-uall")
		cmdStatus.Dir = projectPath
		if outStatus, err := cmdStatus.Output(); err == nil {
			lines := strings.Split(strings.TrimSpace(string(outStatus)), "\n")
			for _, line := range lines {
				line = strings.TrimRight(line, "\r")
				if len(line) < 3 {
					continue
				}
				statusCode := strings.TrimSpace(line[:2])
				filePath := strings.TrimSpace(line[3:])
				if strings.Contains(filePath, " -> ") {
					parts := strings.Split(filePath, " -> ")
					filePath = parts[len(parts)-1]
				}
				filePath = strings.Trim(filePath, "\"")
				filePath = filepath.ToSlash(filePath)
				fullPath := filepath.Join(projectPath, filePath)
				var fileHash string
				var size int64
				var content string
				if fi, err := os.Stat(fullPath); err == nil && !fi.IsDir() {
					size = fi.Size()
					if data, err := os.ReadFile(fullPath); err == nil {
						h := sha256.Sum256(data)
						fileHash = hex.EncodeToString(h[:])
						if size < 512*1024 {
							content = string(data)
						}
					}
				}
				snap.Files[filePath] = FileSnap{
					Path:    filePath,
					Status:  statusCode,
					Hash:    fileHash,
					Size:    size,
					Content: content,
				}
			}
		}
	} else {
		// Non-git directory: walk files
		_ = filepath.Walk(projectPath, func(path string, info os.FileInfo, err error) error {
			if err != nil || info == nil {
				return nil
			}
			rel, err := filepath.Rel(projectPath, path)
			if err != nil || rel == "." {
				return nil
			}
			rel = filepath.ToSlash(rel)
			if info.IsDir() {
				base := info.Name()
				if base == ".git" || base == "node_modules" || base == "vendor" || base == ".gemini" || base == "obj" || base == "bin" {
					return filepath.SkipDir
				}
				return nil
			}
			if info.Size() > 1024*1024 {
				return nil
			}
			if data, err := os.ReadFile(path); err == nil {
				h := sha256.Sum256(data)
				snap.Files[rel] = FileSnap{
					Path:    rel,
					Status:  "existing",
					Hash:    hex.EncodeToString(h[:]),
					Size:    info.Size(),
					Content: string(data),
				}
			}
			return nil
		})
	}

	return snap
}

func computeUnifiedDiff(filePath, oldContent, newContent string) (string, int, int) {
	if oldContent == newContent {
		return "", 0, 0
	}
	oldLines := strings.Split(oldContent, "\n")
	newLines := strings.Split(newContent, "\n")
	if len(oldLines) > 0 && oldLines[len(oldLines)-1] == "" {
		oldLines = oldLines[:len(oldLines)-1]
	}
	if len(newLines) > 0 && newLines[len(newLines)-1] == "" {
		newLines = newLines[:len(newLines)-1]
	}

	if oldContent == "" {
		var sb strings.Builder
		sb.WriteString(fmt.Sprintf("diff --git a/%s b/%s\nnew file\n--- /dev/null\n+++ b/%s\n@@ -0,0 +1,%d @@\n", filePath, filePath, filePath, len(newLines)))
		for _, l := range newLines {
			sb.WriteString("+" + l + "\n")
		}
		return sb.String(), len(newLines), 0
	}

	if newContent == "" {
		var sb strings.Builder
		sb.WriteString(fmt.Sprintf("diff --git a/%s b/%s\ndeleted file\n--- a/%s\n+++ /dev/null\n@@ -1,%d +0,0 @@\n", filePath, filePath, filePath, len(oldLines)))
		for _, l := range oldLines {
			sb.WriteString("-" + l + "\n")
		}
		return sb.String(), 0, len(oldLines)
	}

	start := 0
	for start < len(oldLines) && start < len(newLines) && oldLines[start] == newLines[start] {
		start++
	}

	oldEnd := len(oldLines) - 1
	newEnd := len(newLines) - 1
	for oldEnd >= start && newEnd >= start && oldLines[oldEnd] == newLines[newEnd] {
		oldEnd--
		newEnd--
	}

	addCount := newEnd + 1 - start
	delCount := oldEnd + 1 - start
	if addCount < 0 {
		addCount = 0
	}
	if delCount < 0 {
		delCount = 0
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("diff --git a/%s b/%s\n--- a/%s\n+++ b/%s\n@@ -%d,%d +%d,%d @@\n",
		filePath, filePath, filePath, filePath, start+1, delCount, start+1, addCount))

	for i := start; i <= oldEnd; i++ {
		sb.WriteString("-" + oldLines[i] + "\n")
	}
	for i := start; i <= newEnd; i++ {
		sb.WriteString("+" + newLines[i] + "\n")
	}

	return sb.String(), addCount, delCount
}

func (b *AgentBridge) diffWorkingTreeSnapshot(projectPath string, before *WorkingTreeSnapshot) *ChangedFilesSummary {
	if before == nil {
		return nil
	}
	if projectPath == "" {
		projectPath = before.ProjectPath
	}
	if projectPath == "" {
		b.mu.Lock()
		projectPath = b.activeProject
		b.mu.Unlock()
	}
	if projectPath == "" || projectPath == "__NONE__" {
		return nil
	}

	after := b.captureWorkingTreeSnapshot(projectPath)
	if after == nil {
		return nil
	}

	summary := &ChangedFilesSummary{
		Files: []FileChangeDetail{},
	}

	if before.IsGit {
		for filePath, afterSnap := range after.Files {
			beforeSnap, existedBefore := before.Files[filePath]
			if !existedBefore {
				// File was not dirty before this turn!
				status := "modified"
				if strings.Contains(afterSnap.Status, "?") || strings.Contains(afterSnap.Status, "A") {
					status = "added"
				} else if strings.Contains(afterSnap.Status, "D") {
					status = "deleted"
				}

				var diffText string
				var addCount, delCount int

				if status == "added" {
					diffText, addCount, delCount = computeUnifiedDiff(filePath, "", afterSnap.Content)
				} else {
					cmdDiff := exec.Command("git", "diff", "HEAD", "--", filePath)
					cmdDiff.Dir = projectPath
					if outDiff, err := cmdDiff.Output(); err == nil && len(outDiff) > 0 {
						diffText = string(outDiff)
					}
					cmdNum := exec.Command("git", "diff", "--numstat", "HEAD", "--", filePath)
					cmdNum.Dir = projectPath
					if outNum, err := cmdNum.Output(); err == nil {
						fields := strings.Fields(string(outNum))
						if len(fields) >= 2 {
							fmt.Sscanf(fields[0], "%d", &addCount)
							fmt.Sscanf(fields[1], "%d", &delCount)
						}
					}
					if diffText == "" && afterSnap.Content != "" {
						diffText, addCount, delCount = computeUnifiedDiff(filePath, "", afterSnap.Content)
					}
				}

				summary.Files = append(summary.Files, FileChangeDetail{
					Path:      filePath,
					Status:    status,
					Additions: addCount,
					Deletions: delCount,
					Diff:      diffText,
				})
				summary.Additions += addCount
				summary.Deletions += delCount
			} else {
				// File was already dirty before this prompt. Check if hash changed!
				if afterSnap.Hash != beforeSnap.Hash {
					diffText, addCount, delCount := computeUnifiedDiff(filePath, beforeSnap.Content, afterSnap.Content)
					summary.Files = append(summary.Files, FileChangeDetail{
						Path:      filePath,
						Status:    "modified",
						Additions: addCount,
						Deletions: delCount,
						Diff:      diffText,
					})
					summary.Additions += addCount
					summary.Deletions += delCount
				}
			}
		}

		// Check for files deleted during this turn
		for filePath, beforeSnap := range before.Files {
			if _, existsAfter := after.Files[filePath]; !existsAfter {
				fullPath := filepath.Join(projectPath, filePath)
				if _, err := os.Stat(fullPath); os.IsNotExist(err) {
					diffText, addCount, delCount := computeUnifiedDiff(filePath, beforeSnap.Content, "")
					summary.Files = append(summary.Files, FileChangeDetail{
						Path:      filePath,
						Status:    "deleted",
						Additions: addCount,
						Deletions: delCount,
						Diff:      diffText,
					})
					summary.Additions += addCount
					summary.Deletions += delCount
				}
			}
		}
	} else {
		// Non-git diffing
		for filePath, afterSnap := range after.Files {
			beforeSnap, existedBefore := before.Files[filePath]
			if !existedBefore {
				diffText, addCount, delCount := computeUnifiedDiff(filePath, "", afterSnap.Content)
				summary.Files = append(summary.Files, FileChangeDetail{
					Path:      filePath,
					Status:    "added",
					Additions: addCount,
					Deletions: delCount,
					Diff:      diffText,
				})
				summary.Additions += addCount
				summary.Deletions += delCount
			} else if afterSnap.Hash != beforeSnap.Hash {
				diffText, addCount, delCount := computeUnifiedDiff(filePath, beforeSnap.Content, afterSnap.Content)
				summary.Files = append(summary.Files, FileChangeDetail{
					Path:      filePath,
					Status:    "modified",
					Additions: addCount,
					Deletions: delCount,
					Diff:      diffText,
				})
				summary.Additions += addCount
				summary.Deletions += delCount
			}
		}
		for filePath, beforeSnap := range before.Files {
			if _, existsAfter := after.Files[filePath]; !existsAfter {
				diffText, addCount, delCount := computeUnifiedDiff(filePath, beforeSnap.Content, "")
				summary.Files = append(summary.Files, FileChangeDetail{
					Path:      filePath,
					Status:    "deleted",
					Additions: addCount,
					Deletions: delCount,
					Diff:      diffText,
				})
				summary.Additions += addCount
				summary.Deletions += delCount
			}
		}
	}

	summary.TotalFiles = len(summary.Files)
	if summary.TotalFiles == 0 {
		return nil
	}
	return summary
}

func (b *AgentBridge) getProjectGitChangesLocked(projectPath string) *ChangedFilesSummary {
	if projectPath == "" {
		projectPath = b.activeProject
	}
	if projectPath == "" || projectPath == "__NONE__" {
		return nil
	}

	cmdStatus := exec.Command("git", "status", "--porcelain=v1")
	cmdStatus.Dir = projectPath
	outStatus, err := cmdStatus.Output()
	if err != nil {
		return nil
	}
	rawStatus := strings.TrimSpace(string(outStatus))
	if rawStatus == "" {
		return nil
	}

	summary := &ChangedFilesSummary{
		Files: []FileChangeDetail{},
	}

	statusLines := strings.Split(rawStatus, "\n")
	for _, line := range statusLines {
		line = strings.TrimRight(line, "\r")
		if len(line) < 3 {
			continue
		}
		statusCode := strings.TrimSpace(line[:2])
		filePath := strings.TrimSpace(line[3:])
		if strings.Contains(filePath, " -> ") {
			parts := strings.Split(filePath, " -> ")
			filePath = parts[len(parts)-1]
		}
		statusClean := "modified"
		if strings.Contains(statusCode, "?") || strings.Contains(statusCode, "A") {
			statusClean = "added"
		} else if strings.Contains(statusCode, "D") {
			statusClean = "deleted"
		}
		summary.Files = append(summary.Files, FileChangeDetail{
			Path:   filePath,
			Status: statusClean,
		})
	}
	summary.TotalFiles = len(summary.Files)

	// Fetch numstat for additions/deletions
	cmdNumstat := exec.Command("git", "diff", "--numstat", "HEAD")
	cmdNumstat.Dir = projectPath
	if outNumstat, err := cmdNumstat.Output(); err == nil {
		statLines := strings.Split(strings.TrimSpace(string(outNumstat)), "\n")
		fileStats := make(map[string][2]int)
		for _, sline := range statLines {
			sline = strings.TrimRight(sline, "\r")
			fields := strings.Fields(sline)
			if len(fields) >= 3 {
				var add, del int
				fmt.Sscanf(fields[0], "%d", &add)
				fmt.Sscanf(fields[1], "%d", &del)
				fPath := fields[2]
				fileStats[fPath] = [2]int{add, del}
				summary.Additions += add
				summary.Deletions += del
			}
		}
		for i, f := range summary.Files {
			if st, ok := fileStats[f.Path]; ok {
				summary.Files[i].Additions = st[0]
				summary.Files[i].Deletions = st[1]
			}
		}
	}

	// Fetch diff for review preview
	cmdDiff := exec.Command("git", "diff", "HEAD")
	cmdDiff.Dir = projectPath
	if outDiff, err := cmdDiff.Output(); err == nil {
		rawDiff := string(outDiff)
		for i, f := range summary.Files {
			marker := fmt.Sprintf("diff --git a/%s b/%s", f.Path, f.Path)
			if idx := strings.Index(rawDiff, marker); idx != -1 {
				rem := rawDiff[idx+len(marker):]
				nextIdx := strings.Index(rem, "diff --git ")
				if nextIdx != -1 {
					summary.Files[i].Diff = rawDiff[idx : idx+len(marker)+nextIdx]
				} else {
					summary.Files[i].Diff = rawDiff[idx:]
				}
			}
		}
	}

	// For added files not in git diff HEAD, populate additions and diff
	for i, f := range summary.Files {
		if f.Status == "added" && summary.Files[i].Additions == 0 {
			fullPath := filepath.Join(projectPath, f.Path)
			if data, err := os.ReadFile(fullPath); err == nil {
				lines := strings.Split(string(data), "\n")
				summary.Files[i].Additions = len(lines)
				summary.Additions += len(lines)
				if summary.Files[i].Diff == "" {
					summary.Files[i].Diff, _, _ = computeUnifiedDiff(f.Path, "", string(data))
				}
			}
		}
	}

	return summary
}

// ReadFilePreview returns file content or base64 image data for the preview sidebar
func (b *AgentBridge) ReadFilePreview(pathStr string) string {
	pathStr = strings.TrimSpace(pathStr)
	if pathStr == "" {
		return `{"error": "empty file path"}`
	}

	b.mu.Lock()
	proj := b.activeProject
	b.mu.Unlock()

	targetPath := pathStr
	if !filepath.IsAbs(targetPath) {
		if proj != "" {
			targetPath = filepath.Join(proj, targetPath)
		} else {
			cwd, _ := os.Getwd()
			targetPath = filepath.Join(cwd, targetPath)
		}
	}

	info, err := os.Stat(targetPath)
	if err != nil {
		return fmt.Sprintf(`{"error": "file not found: %s"}`, filepath.Base(pathStr))
	}
	if info.IsDir() {
		return fmt.Sprintf(`{"error": "%s is a directory"}`, filepath.Base(pathStr))
	}

	ext := strings.ToLower(filepath.Ext(targetPath))
	imageExts := map[string]string{
		".png":  "image/png",
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".gif":  "image/gif",
		".svg":  "image/svg+xml",
		".webp": "image/webp",
		".ico":  "image/x-icon",
		".bmp":  "image/bmp",
	}

	if mime, isImg := imageExts[ext]; isImg {
		data, err := os.ReadFile(targetPath)
		if err != nil {
			return fmt.Sprintf(`{"error": "failed to read image: %v"}`, err)
		}
		b64 := base64.StdEncoding.EncodeToString(data)
		resp, _ := json.Marshal(map[string]interface{}{
			"is_image":  true,
			"path":      pathStr,
			"name":      filepath.Base(pathStr),
			"mime":      mime,
			"data":      b64,
			"size":      len(data),
			"full_path": targetPath,
		})
		return string(resp)
	}

	data, err := os.ReadFile(targetPath)
	if err != nil {
		return fmt.Sprintf(`{"error": "failed to read file: %v"}`, err)
	}

	isTruncated := false
	if len(data) > 1024*1024 {
		data = data[:1024*1024]
		isTruncated = true
	}

	contentStr := string(data)
	lines := strings.Count(contentStr, "\n") + 1

	resp, _ := json.Marshal(map[string]interface{}{
		"is_image":  false,
		"path":      pathStr,
		"name":      filepath.Base(pathStr),
		"content":   contentStr,
		"lines":     lines,
		"size":      info.Size(),
		"truncated": isTruncated,
		"full_path": targetPath,
	})
	return string(resp)
}

// GetRightSidebarData returns a combined snapshot of git changes, active terminal, background tasks, and uploads
func (b *AgentBridge) GetRightSidebarData() string {
	b.mu.Lock()
	proj := b.activeProject
	changes := b.getProjectGitChangesLocked(proj)
	b.mu.Unlock()

	data := map[string]interface{}{
		"git_changes":      changes,
		"subagents":        []map[string]interface{}{},
		"artifacts":        []map[string]interface{}{},
		"uploads":          []map[string]interface{}{},
		"background_tasks": []map[string]interface{}{},
		"terminals":        []map[string]interface{}{},
	}
	resp, _ := json.Marshal(data)
	return string(resp)
}


