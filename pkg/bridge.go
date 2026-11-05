package pkg

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/debug"
	"sort"
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

// ApprovalRequest tracks an action or question waiting for user permission or answer
type ApprovalRequest struct {
	ID             string   `json:"id"`
	ExecID         string   `json:"exec_id,omitempty"`
	ConversationID string   `json:"conversation_id,omitempty"`
	Action         string   `json:"action"`
	CommandPrefix  string   `json:"command_prefix"`
	Category       string   `json:"category,omitempty"`
	Source         string   `json:"source,omitempty"`
	Description    string   `json:"description"`
	Warning        string   `json:"warning,omitempty"`
	Timestamp      string   `json:"timestamp"`
	Project        string   `json:"project"`
	Kind           string   `json:"kind,omitempty"`      // "approval" or "question"
	Questions      []string `json:"questions,omitempty"` // Questions asked by the agent when Kind == "question"
	Options        []string `json:"options,omitempty"`   // Predefined clickable options when Kind == "question"
}

// LocalAiExecutorFunc defines a pluggable local AI prompt execution handler (e.g. Tendon Native CUDA runtime)
type LocalAiExecutorFunc func(ctx context.Context, prompt, execID, model, reasoning string, b *AgentBridge) (output string, exec *shuffle.WorkflowExecution, handled bool, err error)

// ShuffleAttachedTool represents an authenticated Shuffle app attached as an agent tool in chat
type ShuffleAttachedTool struct {
	AuthID       string `json:"auth_id"`
	Label        string `json:"label"`
	AppID        string `json:"app_id"`
	AppName      string `json:"app_name"`
	AppVersion   string `json:"app_version"`
	LargeImage   string `json:"large_image,omitempty"`
	ActionsCount int    `json:"actions_count,omitempty"`
	Created       int64    `json:"created,omitempty"`
	Valid         bool     `json:"valid"`
	Authenticated bool     `json:"authenticated"`
	Description   string   `json:"description,omitempty"`
	Categories    []string `json:"categories,omitempty"`
	Verified      bool     `json:"verified,omitempty"`
	AuthType      string   `json:"auth_type,omitempty"`
}

// ShuffleAppAuthFieldSchema describes an input field required to authenticate a Shuffle app
type ShuffleAppAuthFieldSchema struct {
	Name        string   `json:"name"`
	Label       string   `json:"label"`
	Description string   `json:"description,omitempty"`
	Example     string   `json:"example,omitempty"`
	DefaultVal  string   `json:"default_value,omitempty"`
	Required    bool     `json:"required"`
	Multiline   bool     `json:"multiline,omitempty"`
	Secret      bool     `json:"secret"`
	Options     []string `json:"options,omitempty"`
}

// ShuffleSharedSkill represents a predefined skill from shuffle-shared that attaches a template and required tools
type ShuffleSharedSkill struct {
	ID           string                `json:"id"`
	Template     string                `json:"template"`
	Name         string                `json:"name"`
	Category     string                `json:"category"`
	Description  string                `json:"description"`
	RequiredApps []string              `json:"required_apps"`
	Tools        []ShuffleAttachedTool `json:"tools"`
	Attached     bool                  `json:"attached"`
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
	pendingApprovals        []ApprovalRequest
	approvalCh              chan bool
	activeApprovalCh        chan bool
	approvalChs             map[string]chan bool
	approvalAnswers         map[string]string
	onApprovalRequest       func(reqJSON string)
	projects                []shuffle.ProjectInfo
	projectsScanned         bool
	isScanning              bool
	scanWaitCh              chan struct{}
	oauthLoggedIn           bool
	oauthToken              string
	orgName                 string
	shuffleOrgs             []ShuffleOrg
	onAuthUpdated           func(stateJSON string)
	onChunk                 func(execID, chunk string)
	onChunkWithReasoning    func(execID, chunk string, isReasoning bool)
	aiApiKey                string
	aiApiUrl                string
	aiModel                 string
	approvalRules           []ApprovalRule
	pinnedConvs             []string
	localAiExecutor         LocalAiExecutorFunc
	localModelsDir          string
	localModelPath          string
	activeExecutionMode     string
	activeOAuthSession      *DynamicOAuthSession
	projectBaselineSnap     map[string]*WorkingTreeSnapshot
	directProjectChanges    map[string]*ChangedFilesSummary
	activeCancelMu          sync.Mutex
	activeCancel            context.CancelFunc
	activeCancelID          string
	activeExecCtx           map[string]context.Context
	activeExecCancel        map[string]context.CancelFunc
	activeUserCancelCh      map[string]chan struct{}
	shuffleToolsMu          sync.RWMutex
	convShuffleTools        map[string][]ShuffleAttachedTool
	defaultShuffleTools     []ShuffleAttachedTool
	convShuffleSkills       map[string][]string
	defaultShuffleSkills    []string
	cachedShuffleApps       map[string]shuffle.WorkflowApp
	cachedShuffleAuths      []ShuffleAttachedTool
	cachedShuffleAuthsAt    time.Time
	cachedAlgoliaQueries    map[string][]shuffle.AlgoliaSearchApp
	cachedAlgoliaQueriesAt  map[string]time.Time
	execApprovalDecisions   map[string]map[string]execApprovalDecision
}

type execApprovalDecision struct {
	approved bool
	feedback string
}

var installShuffleRoundTripperOnce sync.Once

type shuffleTenantRoundTripper struct {
	base http.RoundTripper
}

func (rt *shuffleTenantRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	base := rt.base
	if base == nil {
		base = http.DefaultTransport
	}
	if req != nil {
		// If a request context expired or has <120s left (e.g. after pausing for user approval),
		// recreate a fresh context so follow-up turns never fail with context deadline exceeded.
		needFreshCtx := req.Context().Err() == context.DeadlineExceeded
		if !needFreshCtx {
			if dl, ok := req.Context().Deadline(); ok && time.Until(dl) < 120*time.Second {
				needFreshCtx = true
			}
		}
		if needFreshCtx {
			freshCtx, cancel := context.WithTimeout(context.Background(), 300*time.Second)
			time.AfterFunc(300*time.Second, cancel)
			req = req.Clone(freshCtx)
		}
	}
	if req != nil && req.URL != nil && strings.Contains(strings.ToLower(req.URL.Host), "shuffler.io") {
		orgID := strings.TrimSpace(os.Getenv("SHUFFLE_ORG_ID"))
		if orgID == "" {
			orgID = strings.TrimSpace(os.Getenv("ORG"))
		}
		if orgID != "" {
			reqCopy := req.Clone(req.Context())
			if reqCopy.Header.Get("Org") == "" {
				reqCopy.Header.Set("Org", orgID)
			}
			if reqCopy.Header.Get("X-Shuffle-Org-Id") == "" {
				reqCopy.Header.Set("X-Shuffle-Org-Id", orgID)
			}
			if !strings.Contains(reqCopy.URL.Path, "/workflows/queue") {
				reqCopy.Header.Set("Org-Id", orgID)
			} else if reqCopy.Header.Get("Org-Id") == "" {
				reqCopy.Header.Set("Org-Id", orgID)
			}
			req = reqCopy
		}
	}
	return base.RoundTrip(req)
}

func ensureShuffleTenantRoundTripper() {
	installShuffleRoundTripperOnce.Do(func() {
		if _, ok := http.DefaultTransport.(*shuffleTenantRoundTripper); !ok {
			http.DefaultTransport = &shuffleTenantRoundTripper{base: http.DefaultTransport}
		}
		if http.DefaultClient != nil {
			if _, ok := http.DefaultClient.Transport.(*shuffleTenantRoundTripper); !ok {
				http.DefaultClient.Transport = &shuffleTenantRoundTripper{base: http.DefaultClient.Transport}
			}
		}
	})
}

// RegisterCancel associates an active context cancellation func with an execution ID
func (b *AgentBridge) RegisterCancel(execID string, cancel context.CancelFunc) {
	b.activeCancelMu.Lock()
	defer b.activeCancelMu.Unlock()
	b.activeCancelID = execID
	b.activeCancel = cancel
	if b.activeUserCancelCh == nil {
		b.activeUserCancelCh = make(map[string]chan struct{})
	}
	if _, exists := b.activeUserCancelCh[execID]; !exists {
		b.activeUserCancelCh[execID] = make(chan struct{})
	}
}

// RefreshExecutionContext creates or recreates a fresh timeout context for execID (e.g. after waiting for user approval)
func (b *AgentBridge) RefreshExecutionContext(execID string, timeout time.Duration) (context.Context, context.CancelFunc) {
	if timeout <= 0 {
		timeout = 600 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	b.activeCancelMu.Lock()
	defer b.activeCancelMu.Unlock()
	if b.activeExecCtx == nil {
		b.activeExecCtx = make(map[string]context.Context)
	}
	if b.activeExecCancel == nil {
		b.activeExecCancel = make(map[string]context.CancelFunc)
	}
	if b.activeUserCancelCh == nil {
		b.activeUserCancelCh = make(map[string]chan struct{})
	}
	if _, exists := b.activeUserCancelCh[execID]; !exists {
		b.activeUserCancelCh[execID] = make(chan struct{})
	}
	b.activeExecCtx[execID] = ctx
	b.activeExecCancel[execID] = cancel
	b.activeCancelID = execID
	b.activeCancel = cancel
	return ctx, cancel
}

// GetExecutionContext returns the latest active (or refreshed) context for execID
func (b *AgentBridge) GetExecutionContext(execID string, fallback context.Context) context.Context {
	b.activeCancelMu.Lock()
	defer b.activeCancelMu.Unlock()
	if b.activeExecCtx != nil {
		if c, ok := b.activeExecCtx[execID]; ok && c != nil && c.Err() == nil {
			return c
		}
	}
	if fallback != nil && fallback.Err() == nil {
		return fallback
	}
	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Second)
	if b.activeExecCtx == nil {
		b.activeExecCtx = make(map[string]context.Context)
	}
	if b.activeExecCancel == nil {
		b.activeExecCancel = make(map[string]context.CancelFunc)
	}
	b.activeExecCtx[execID] = ctx
	b.activeExecCancel[execID] = cancel
	b.activeCancelID = execID
	b.activeCancel = cancel
	return ctx
}

// UserCancelChan returns a channel closed only when the user explicitly cancels execution
func (b *AgentBridge) UserCancelChan(execID string) <-chan struct{} {
	b.activeCancelMu.Lock()
	defer b.activeCancelMu.Unlock()
	if b.activeUserCancelCh == nil {
		b.activeUserCancelCh = make(map[string]chan struct{})
	}
	ch, ok := b.activeUserCancelCh[execID]
	if !ok {
		ch = make(chan struct{})
		b.activeUserCancelCh[execID] = ch
	}
	return ch
}

// UnregisterCancel cleans up the active cancellation func
func (b *AgentBridge) UnregisterCancel(execID string) {
	b.activeCancelMu.Lock()
	defer b.activeCancelMu.Unlock()
	if b.activeCancelID == execID {
		b.activeCancel = nil
		b.activeCancelID = ""
	}
	if b.activeExecCancel != nil {
		if c, ok := b.activeExecCancel[execID]; ok && c != nil {
			c()
		}
		delete(b.activeExecCancel, execID)
	}
	if b.activeExecCtx != nil {
		delete(b.activeExecCtx, execID)
	}
	if b.activeUserCancelCh != nil {
		delete(b.activeUserCancelCh, execID)
	}
}

// CancelCurrentExecution cancels the currently running AI generation, if any
func (b *AgentBridge) CancelCurrentExecution() bool {
	b.activeCancelMu.Lock()
	cancel := b.activeCancel
	execID := b.activeCancelID
	b.activeCancel = nil
	b.activeCancelID = ""
	for id, uCh := range b.activeUserCancelCh {
		if uCh != nil {
			select {
			case <-uCh:
			default:
				close(uCh)
			}
		}
		delete(b.activeUserCancelCh, id)
	}
	for id, cFn := range b.activeExecCancel {
		if cFn != nil {
			cFn()
		}
		delete(b.activeExecCancel, id)
	}
	b.activeCancelMu.Unlock()

	b.mu.Lock()
	if b.activeApprovalCh != nil {
		select {
		case b.activeApprovalCh <- false:
		default:
		}
		b.activeApprovalCh = nil
	}
	for id, ch := range b.approvalChs {
		if ch != nil {
			select {
			case ch <- false:
			default:
			}
		}
		delete(b.approvalChs, id)
	}
	b.pendingApprovals = nil
	b.pendingApproval = nil
	b.mu.Unlock()

	b.EmitApprovalQueueSync()

	if cancel != nil {
		log.Printf("[INFO][%s] Cancelling active prompt execution on request", execID)
		cancel()
		return true
	}
	return false
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
			if b.aiModel == "" || b.aiModel == "shuffle-ai" || b.aiModel == "shuffle" || b.aiModel == "gemini-3.8-flash" {
				b.aiModel = "tendon-local"
				_ = os.Setenv("AI_MODEL", "tendon-local")
			}
		} else if cleanMode == "shuffle" || cleanMode == "orborus" {
			b.aiModel = "shuffle-ai"
			_ = os.Setenv("AI_MODEL", "shuffle-ai")
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

// inferLastModelFromConversations inspects conversation turns (newest conversation and newest turn first)
// and returns the UI model identifier and execution mode used by the last AI message.
func inferLastModelFromConversations(convs []Conversation) (string, string) {
	for _, c := range convs {
		for i := len(c.Turns) - 1; i >= 0; i-- {
			t := c.Turns[i]
			if t.DebugInfo == nil {
				continue
			}
			uiModel := ""
			if v, ok := t.DebugInfo["ui_model"].(string); ok {
				uiModel = strings.TrimSpace(v)
			}
			rawModel := ""
			if v, ok := t.DebugInfo["model"].(string); ok {
				rawModel = strings.TrimSpace(v)
			}
			if uiModel == "local_shell" || (uiModel == "" && rawModel == "local_shell") {
				continue
			}
			target := ""
			if v, ok := t.DebugInfo["target"].(string); ok {
				target = strings.ToLower(strings.TrimSpace(v))
			}
			isShuffle, _ := t.DebugInfo["is_shuffle"].(bool)
			isAuth, _ := t.DebugInfo["is_auth"].(bool)

			if uiModel == "shuffle-ai" || uiModel == "shuffle" ||
				rawModel == "shuffle-ai" || rawModel == "shuffle" ||
				isShuffle || strings.Contains(target, "shuffler.io") ||
				((rawModel == "gemini-3.8-flash" || rawModel == "gemini-3.8-pro") && isAuth) {
				return "shuffle-ai", "shuffle"
			}

			chosen := uiModel
			if chosen == "" {
				chosen = rawModel
			}
			if chosen != "" && chosen != "local_shell" {
				if strings.HasPrefix(chosen, "tendon") || strings.HasPrefix(chosen, "local") {
					return chosen, "local"
				}
				return chosen, "direct"
			}
		}
	}
	return "", ""
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
	if policy != "ask_all" && policy != "safe_auto" && policy != "full_auto" {
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
	if saved.PermissionPolicy == "ask_all" || saved.PermissionPolicy == "safe_auto" || saved.PermissionPolicy == "full_auto" {
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
		if saved.IsLoggedIn || (!strings.Contains(saved.AiApiUrl, "shuffler.io") && !strings.Contains(saved.AiApiUrl, "shuffle")) {
			aiUrl = saved.AiApiUrl
			_ = os.Setenv("AI_API_URL", aiUrl)
		}
	}
	aiKey := os.Getenv("AI_API_KEY")
	if aiKey == "" && saved.AiApiKey != "" {
		if saved.IsLoggedIn || !strings.HasPrefix(saved.AiApiKey, "shfl_") {
			aiKey = saved.AiApiKey
			_ = os.Setenv("AI_API_KEY", aiKey)
		}
	}
	aiModel := os.Getenv("AI_MODEL")
	if aiModel == "" && saved.AiModel != "" {
		switch strings.ToLower(strings.TrimSpace(saved.AiModel)) {
		case "low", "medium", "high", "minimal", "off":
			// Ignore reasoning effort values accidentally persisted as model
		case "shuffle-ai", "shuffle":
			aiModel = "shuffle-ai"
		default:
			if saved.ActiveExecutionMode == "shuffle" && saved.AiModel == "gemini-3.8-flash" {
				aiModel = "shuffle-ai"
			} else {
				aiModel = saved.AiModel
			}
		}
	}
	if aiModel == "" {
		aiModel = "tendon-local"
	}
	_ = os.Setenv("AI_MODEL", aiModel)
	_ = os.Setenv("STANDALONE", "true")
	_ = os.Setenv("SHUFFLE_STANDALONE", "true")

	ensureShuffleTenantRoundTripper()

	oauthLoggedIn := false
	oauthToken := ""
	orgName := ""
	var shuffleOrgs []ShuffleOrg
	if saved.IsLoggedIn && saved.OAuthToken != "" {
		oauthToken = saved.OAuthToken
		oauthLoggedIn = true
		orgName = saved.OrgName
		if len(saved.ShuffleOrgs) > 0 {
			shuffleOrgs = saved.ShuffleOrgs
		}
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
	if cfg.Org != "" {
		_ = os.Setenv("ORG", cfg.Org)
		_ = os.Setenv("ORG_ID", cfg.Org)
		_ = os.Setenv("SHUFFLE_ORG_ID", cfg.Org)
	}
	if cfg.BaseURL != "" {
		_ = os.Setenv("SHUFFLE_BASE_URL", cfg.BaseURL)
		_ = os.Setenv("BASE_URL", cfg.BaseURL)
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
			"../delightful-mendeleev/models",
		}
		if home, errHome := os.UserHomeDir(); errHome == nil && home != "" {
			candidates = append(candidates, filepath.Join(home, ".shuffle", "models"))
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
		if aiModel == "shuffle-ai" || aiModel == "shuffle" {
			activeMode = "shuffle"
		} else if strings.HasPrefix(aiModel, "tendon") || strings.HasPrefix(aiModel, "local") {
			activeMode = "local"
		} else if aiModel != "" {
			activeMode = "direct"
		} else if modelPath != "" {
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
		if os.Getenv("AI_MODEL") == "" {
			if lastModel, lastMode := inferLastModelFromConversations(convs); lastModel != "" {
				aiModel = lastModel
				activeMode = lastMode
				_ = os.Setenv("AI_MODEL", aiModel)
				_ = os.Setenv("ORBORUS_ACTIVE_EXECUTION_MODE", activeMode)
			}
		}
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
		orgName:                 orgName,
		shuffleOrgs:             shuffleOrgs,
		approvalRules:           rules,
		pinnedConvs:             pinned,
		localModelsDir:          modelsDir,
		localModelPath:          modelPath,
		activeExecutionMode:     activeMode,
		convShuffleTools:        make(map[string][]ShuffleAttachedTool),
		defaultShuffleTools:     make([]ShuffleAttachedTool, 0),
		cachedShuffleApps:       make(map[string]shuffle.WorkflowApp),
	}

	if saved != nil && (saved.PermissionPolicy != policy || saved.AiModel != aiModel || saved.ActiveExecutionMode != activeMode || (!oauthLoggedIn && (saved.IsLoggedIn || saved.OAuthToken != ""))) {
		b.saveLocalStoreLocked()
	}

	// Trigger code repository scan immediately on initial startup
	go b.ScanProjects()

	// Refresh available Shuffle tenants in background if logged in
	if oauthLoggedIn && oauthToken != "" {
		go func() {
			_, _ = b.FetchShuffleOrgs()
		}()
	}

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

	savedAiUrl := b.aiApiUrl
	savedAiKey := b.aiApiKey
	savedOAuthToken := b.oauthToken
	savedBaseURL := b.cfg.BaseURL
	savedOrgID := b.cfg.Org
	savedOrgName := b.orgName
	savedShuffleOrgs := b.shuffleOrgs
	savedEnv := b.cfg.Environment
	if !b.oauthLoggedIn {
		savedOAuthToken = ""
		if strings.HasPrefix(savedAiKey, "shfl_") {
			savedAiKey = ""
		}
		if strings.Contains(savedAiUrl, "shuffler.io") || strings.Contains(savedAiUrl, "shuffle") {
			savedAiUrl = ""
		}
		savedBaseURL = ""
		savedOrgID = ""
		savedOrgName = ""
		savedShuffleOrgs = nil
		savedEnv = "standalone"
	}

	store := &LocalAgentStore{
		PermissionPolicy:        b.permissionPolicy,
		TerminalExecutionPolicy: b.terminalExecutionPolicy,
		FileAccessPolicy:        b.fileAccessPolicy,
		SandboxMode:             b.sandboxMode,
		QueuedMessages:          b.queuedMessages,
		ProjectPermissions:      b.projectPermissions,
		Projects:                storedProjects,
		AiApiUrl:                savedAiUrl,
		AiApiKey:                savedAiKey,
		AiModel:                 b.aiModel,
		ActiveProject:           activeProj,
		BaseURL:                 savedBaseURL,
		OrgID:                   savedOrgID,
		OrgName:                 savedOrgName,
		ShuffleOrgs:             savedShuffleOrgs,
		Environment:             savedEnv,
		OAuthToken:              savedOAuthToken,
		IsLoggedIn:              b.oauthLoggedIn && savedOAuthToken != "",
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

// isShuffleAuthenticatedLocked returns true only when an active Shuffle OAuth2 session or explicit Shuffle token is configured
func (b *AgentBridge) isShuffleAuthenticatedLocked() bool {
	if b.oauthLoggedIn && b.oauthToken != "" {
		return true
	}
	if b.cfg != nil && b.cfg.HasExplicitAuth && b.cfg.Auth != "" {
		return true
	}
	return false
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
			select {
			case <-waitCh:
			case <-time.After(2 * time.Second):
			}
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

	return b.getInitialStateLocked()
}

// SetAiConfig configures local AI credentials and updates process environment
func (b *AgentBridge) SetAiConfig(apiUrl, apiKey, model string) string {
	b.mu.Lock()

	b.aiApiUrl = strings.TrimSpace(apiUrl)
	b.aiApiKey = strings.TrimSpace(apiKey)
	if !b.oauthLoggedIn {
		if strings.HasPrefix(b.aiApiKey, "shfl_") {
			b.aiApiKey = ""
		}
		if strings.Contains(b.aiApiUrl, "shuffler.io") || strings.Contains(b.aiApiUrl, "shuffle") {
			b.aiApiUrl = ""
		}
	}
	if trimmedModel := strings.TrimSpace(model); trimmedModel != "" {
		switch strings.ToLower(trimmedModel) {
		case "low", "medium", "high", "minimal", "off":
			// Ignore reasoning effort values passed in model slot
		case "shuffle-ai", "shuffle":
			b.aiModel = "shuffle-ai"
			b.activeExecutionMode = "shuffle"
		default:
			b.aiModel = trimmedModel
			if strings.HasPrefix(trimmedModel, "tendon") || strings.HasPrefix(trimmedModel, "local") {
				b.activeExecutionMode = "local"
			} else {
				b.activeExecutionMode = "direct"
			}
		}
	}

	if b.aiApiUrl != "" {
		_ = os.Setenv("AI_API_URL", b.aiApiUrl)
		if b.oauthLoggedIn && (strings.Contains(b.aiApiUrl, "shuffler.io") || strings.Contains(b.aiApiUrl, "shuffle")) {
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
		if b.oauthLoggedIn && (strings.HasPrefix(b.aiApiKey, "shfl_") || strings.Contains(b.aiApiUrl, "shuffler.io") || strings.Contains(b.aiApiUrl, "shuffle")) {
			_ = os.Setenv("SHUFFLE_AUTHORIZATION", b.aiApiKey)
			_ = os.Setenv("SHUFFLE_SESSION_TOKEN", b.aiApiKey)
			if b.cfg != nil {
				b.cfg.Auth = b.aiApiKey
			}
		}
	} else {
		_ = os.Unsetenv("AI_API_KEY")
	}

	if b.aiModel != "" {
		_ = os.Setenv("AI_MODEL", b.aiModel)
	}

	b.saveLocalStoreLocked()

	isBypassed := b.isAuthBypassed()
	isLoggedIn := b.isShuffleAuthenticatedLocked()

	resp, _ := json.Marshal(map[string]interface{}{
		"status":            "ok",
		"ai_api_url":        b.aiApiUrl,
		"ai_api_key":        b.aiApiKey,
		"ai_model":          b.aiModel,
		"permission_policy": b.permissionPolicy,
		"is_logged_in":      isLoggedIn,
		"oauth_logged_in":   b.oauthLoggedIn && b.oauthToken != "",
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

// resolveShuffleRegion extracts the Shuffle cloud region from a URL, region name, or environment variable, defaulting to "uk".
func resolveShuffleRegion(raw string) string {
	val := strings.TrimSpace(strings.ToLower(raw))
	if val != "" {
		// Check if raw is already a bare region code
		switch val {
		case "uk", "us", "us-1", "us-2", "eu", "eu-1", "eu-2", "ca", "jp", "in", "au", "sg", "de":
			return val
		}
		// Extract subdomain from https://{region}.shuffler.io
		if idx := strings.Index(val, ".shuffler.io"); idx > 0 {
			prefix := val[:idx]
			if slashIdx := strings.LastIndex(prefix, "/"); slashIdx >= 0 {
				prefix = prefix[slashIdx+1:]
			}
			prefix = strings.TrimSpace(prefix)
			if prefix != "" && prefix != "www" && prefix != "shuffler" {
				return prefix
			}
		}
	}
	for _, envKey := range []string{"SHUFFLE_REGION", "SHUFFLE_CLOUD_REGION"} {
		if envRegion := strings.TrimSpace(strings.ToLower(os.Getenv(envKey))); envRegion != "" {
			return envRegion
		}
	}
	return "uk"
}

// resolveShuffleAiBaseURL resolves the Shuffle backend base URL (without /api/v1) for Shuffle AI requests.
// Defaults to https://uk.shuffler.io unless another region or custom Shuffle host is configured.
func resolveShuffleAiBaseURL(rawURL string) string {
	trimmed := strings.TrimSpace(rawURL)
	if trimmed == "" || strings.EqualFold(trimmed, "shuffle") {
		for _, envKey := range []string{"SHUFFLE_BASE_URL", "SHUFFLE_BACKEND", "SHUFFLE_URL"} {
			if envVal := strings.TrimSpace(os.Getenv(envKey)); envVal != "" && !strings.Contains(strings.ToLower(envVal), "shuffle.security") {
				trimmed = envVal
				break
			}
		}
	}

	lower := strings.ToLower(trimmed)
	if trimmed == "" ||
		strings.EqualFold(trimmed, "shuffle") ||
		strings.Contains(lower, "shuffle.security") ||
		lower == "https://shuffler.io" ||
		lower == "http://shuffler.io" ||
		lower == "https://www.shuffler.io" ||
		!strings.HasPrefix(lower, "http") {
		region := resolveShuffleRegion(trimmed)
		return fmt.Sprintf("https://%s.shuffler.io", region)
	}

	// Strip trailing /chat/completions and /api/v1 so callers get a clean base URL
	clean := strings.TrimRight(trimmed, "/")
	if idx := strings.Index(strings.ToLower(clean), "/api/v1"); idx > 0 {
		clean = clean[:idx]
	} else if idx := strings.Index(strings.ToLower(clean), "/chat/completions"); idx > 0 {
		clean = clean[:idx]
	}
	return strings.TrimRight(clean, "/")
}

// resolveShuffleAiApiURL resolves the Shuffle AI OpenAI-compatible base URL (https://{region}.shuffler.io/api/v1).
// The go-openai client appends /chat/completions to this URL, yielding https://{region}.shuffler.io/api/v1/chat/completions.
func resolveShuffleAiApiURL(rawURL string) string {
	return resolveShuffleAiBaseURL(rawURL) + "/api/v1"
}

// TestAiConfig tests whether the provided AI configuration credentials are valid by running a lightweight test query with shuffle.RunAiQuery directly.
func (b *AgentBridge) TestAiConfig(apiUrl, apiKey, model string) string {
	targetUrl := strings.TrimSpace(apiUrl)
	targetKey := strings.TrimSpace(apiKey)
	targetModel := strings.TrimSpace(model)

	b.mu.Lock()
	savedModel := b.aiModel
	savedKey := b.aiApiKey
	oauthLoggedIn := b.oauthLoggedIn
	oauthToken := b.oauthToken
	activeMode := b.activeExecutionMode
	cfgBaseURL := ""
	cfgAuth := ""
	orgID := ""
	if b.cfg != nil {
		cfgBaseURL = b.cfg.BaseURL
		cfgAuth = b.cfg.Auth
		orgID = b.cfg.Org
	}
	b.mu.Unlock()

	isShuffleTest := strings.EqualFold(targetUrl, "shuffle") ||
		strings.Contains(strings.ToLower(targetUrl), "shuffle.security") ||
		strings.Contains(strings.ToLower(targetUrl), "shuffler.io") ||
		strings.HasPrefix(targetKey, "shfl_") ||
		targetModel == "shuffle-ai" ||
		targetModel == "shuffle" ||
		(targetUrl == "" && targetKey == "" && (oauthLoggedIn || activeMode == "shuffle"))

	if targetModel == "" {
		targetModel = savedModel
	}
	if isShuffleTest {
		if targetModel == "" || targetModel == "shuffle-ai" || targetModel == "shuffle" {
			targetModel = "shuffle-ai"
		}
	} else if targetModel == "" || targetModel == "shuffle" {
		targetModel = "shuffle-ai"
	}

	// Endpoint & credential resolution
	if isShuffleTest {
		sourceURL := targetUrl
		if sourceURL == "" || strings.EqualFold(sourceURL, "shuffle") || strings.Contains(strings.ToLower(sourceURL), "shuffle.security") {
			sourceURL = cfgBaseURL
		}
		targetUrl = resolveShuffleAiApiURL(sourceURL)

		if targetKey == "" {
			if oauthLoggedIn && oauthToken != "" {
				targetKey = oauthToken
			} else if cfgAuth != "" {
				targetKey = cfgAuth
			} else if k := os.Getenv("SHUFFLE_AUTHORIZATION"); k != "" {
				targetKey = k
			} else if k := os.Getenv("SHUFFLE_SESSION_TOKEN"); k != "" {
				targetKey = k
			} else if strings.HasPrefix(savedKey, "shfl_") {
				targetKey = savedKey
			}
		}

		if targetKey == "" {
			resp, _ := json.Marshal(map[string]interface{}{
				"status":  "error",
				"message": "Not connected to Shuffle AI. Please connect your Shuffle account first.",
			})
			return string(resp)
		}
	} else if targetUrl == "" || strings.HasPrefix(targetUrl, "local://") || strings.Contains(targetUrl, "tendon") {
		modelLower := strings.ToLower(targetModel)
		if strings.HasPrefix(modelLower, "gemini") {
			targetUrl = "https://generativelanguage.googleapis.com/v1beta/openai"
		} else if strings.HasPrefix(modelLower, "claude") {
			targetUrl = "https://api.anthropic.com/v1"
		} else if strings.HasPrefix(modelLower, "deepseek") {
			targetUrl = "https://api.deepseek.com/v1"
		} else if strings.HasPrefix(modelLower, "llama") || strings.HasPrefix(modelLower, "mixtral") {
			targetUrl = "https://api.groq.com/openai/v1"
		} else if strings.HasPrefix(modelLower, "ollama") {
			targetUrl = "http://localhost:11434/v1"
		} else if strings.HasPrefix(modelLower, "tendon") || strings.Contains(modelLower, "local") || strings.HasPrefix(targetUrl, "local://") || strings.Contains(targetUrl, "tendon") {
			if envURL := os.Getenv("AI_API_URL"); envURL != "" && strings.HasPrefix(envURL, "http") {
				targetUrl = envURL
			} else {
				targetUrl = "http://127.0.0.1:8000/v1"
			}
		} else {
			targetUrl = "https://api.openai.com/v1"
		}
	}

	// Normalize Gemini endpoint if missing /openai suffix
	if strings.Contains(targetUrl, "generativelanguage.googleapis.com") && !strings.Contains(targetUrl, "openai") {
		targetUrl = strings.TrimRight(targetUrl, "/") + "/openai"
	}

	// Sanitize any remaining local:// protocol scheme
	if strings.HasPrefix(targetUrl, "local://") {
		if envURL := os.Getenv("AI_API_URL"); envURL != "" && strings.HasPrefix(envURL, "http") {
			targetUrl = envURL
		} else {
			targetUrl = "http://127.0.0.1:8000/v1"
		}
	}

	// Check API key requirement for non-Shuffle providers
	isLocal := strings.Contains(targetUrl, "localhost") || strings.Contains(targetUrl, "127.0.0.1") || strings.Contains(targetUrl, "0.0.0.0") || strings.HasPrefix(targetUrl, "local://")
	if targetKey == "" {
		modelLower := strings.ToLower(targetModel)
		if strings.HasPrefix(modelLower, "gemini") {
			if k := os.Getenv("GEMINI_API_KEY"); k != "" {
				targetKey = k
			} else if k := os.Getenv("GOOGLE_API_KEY"); k != "" {
				targetKey = k
			}
		} else if strings.HasPrefix(modelLower, "claude") {
			if k := os.Getenv("ANTHROPIC_API_KEY"); k != "" {
				targetKey = k
			}
		} else if strings.HasPrefix(modelLower, "gpt") || strings.HasPrefix(modelLower, "o1") || strings.HasPrefix(modelLower, "o3") {
			if k := os.Getenv("OPENAI_API_KEY"); k != "" {
				targetKey = k
			}
		}
		if targetKey == "" && savedKey != "" && !strings.HasPrefix(savedKey, "shfl_") {
			targetKey = savedKey
		}
		if targetKey == "" {
			if k := os.Getenv("AI_API_KEY"); k != "" && !strings.HasPrefix(k, "shfl_") {
				targetKey = k
			}
		}
		if targetKey == "" && !isLocal {
			resp, _ := json.Marshal(map[string]interface{}{
				"status":  "error",
				"message": "AI_API_KEY is required for remote provider",
			})
			return string(resp)
		}
		if targetKey == "" && isLocal {
			targetKey = "local-tendon"
		}
	}

	if strings.HasPrefix(targetKey, "shfl_") && (targetUrl == "" || strings.Contains(strings.ToLower(targetUrl), "api.openai.com")) {
		targetUrl = resolveShuffleAiApiURL(cfgBaseURL)
	}

	execID := fmt.Sprintf("test-auth-%d", time.Now().UnixNano())

	callInfo := shuffle.AiCallInfo{
		Caller:          "orborus-auth-test",
		OrgID:           orgID,
		ExecutionId:     execID,
		Url:             targetUrl,
		Model:           targetModel,
		ApiKey:          targetKey,
		ReasoningEffort: "low",
	}

	testPrompt := "Respond with 'OK'."
	incomingReq := openai.ChatCompletionRequest{
		Model:  targetModel,
		Stream: false,
		Messages: []openai.ChatCompletionMessage{
			{
				Role:    openai.ChatMessageRoleUser,
				Content: testPrompt,
			},
		},
		MaxTokens: 10,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	startTime := time.Now()
	log.Printf("[INFO][%s] Testing AI config with shuffle.RunAiQuery: url=%s, model=%s, shuffle=%v", execID, targetUrl, targetModel, isShuffleTest)

	type aiQueryResult struct {
		resp string
		err  error
	}
	resCh := make(chan aiQueryResult, 1)
	go func() {
		r, e := shuffle.RunAiQuery(ctx, callInfo, "", testPrompt, incomingReq)
		resCh <- aiQueryResult{resp: r, err: e}
	}()

	var respStr string
	var err error
	select {
	case res := <-resCh:
		respStr = res.resp
		err = res.err
	case <-ctx.Done():
		err = fmt.Errorf("request timed out after 10s contacting %s", targetUrl)
	}

	durationMs := time.Since(startTime).Milliseconds()
	if err != nil {
		log.Printf("[WARN][%s] AI config test failed (%dms): %v", execID, durationMs, err)
		resp, _ := json.Marshal(map[string]interface{}{
			"status":      "error",
			"message":     err.Error(),
			"model":       targetModel,
			"url":         targetUrl,
			"duration_ms": durationMs,
		})
		return string(resp)
	}

	trimmedSample := strings.TrimSpace(respStr)
	log.Printf("[INFO][%s] AI config test succeeded (%dms): %q", execID, durationMs, trimmedSample)
	resp, _ := json.Marshal(map[string]interface{}{
		"status":      "ok",
		"message":     fmt.Sprintf("Verified %s (%dms)", targetModel, durationMs),
		"sample":      trimmedSample,
		"model":       targetModel,
		"url":         targetUrl,
		"duration_ms": durationMs,
	})
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

// SetOnChunkWithReasoning registers a listener for real-time streamed LLM tokens and reasoning chunks
func (b *AgentBridge) SetOnChunkWithReasoning(fn func(execID, chunk string, isReasoning bool)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onChunkWithReasoning = fn
}

// SetOnApprovalRequest registers a listener for real-time in-flight approval requests
func (b *AgentBridge) SetOnApprovalRequest(fn func(reqJSON string)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onApprovalRequest = fn
}

// EmitApprovalRequest notifies the frontend that an in-flight tool or command requires approval
func (b *AgentBridge) EmitApprovalRequest(req ApprovalRequest) {
	if b == nil {
		return
	}
	b.mu.Lock()
	cb := b.onApprovalRequest
	b.mu.Unlock()
	if cb != nil {
		if data, err := json.Marshal(req); err == nil {
			cb(string(data))
		}
	}
}

// EmitApprovalQueueSync notifies the frontend with the authoritative pending_approvals slice so all UI components stay synchronized
func (b *AgentBridge) EmitApprovalQueueSync() {
	if b == nil {
		return
	}
	b.mu.Lock()
	cb := b.onApprovalRequest
	queueCopy := make([]ApprovalRequest, len(b.pendingApprovals))
	copy(queueCopy, b.pendingApprovals)
	b.mu.Unlock()
	if cb != nil {
		payload := map[string]interface{}{
			"sync_queue":        true,
			"pending_approvals": queueCopy,
		}
		if data, err := json.Marshal(payload); err == nil {
			cb(string(data))
		}
	}
}

// StreamChunk forwards a real-time streamed token or chunk to registered callbacks
func (b *AgentBridge) StreamChunk(execID, chunk string, isReasoning ...bool) {
	if b == nil || chunk == "" {
		return
	}
	b.mu.Lock()
	cbReason := b.onChunkWithReasoning
	cb := b.onChunk
	b.mu.Unlock()

	reasoning := false
	if len(isReasoning) > 0 && isReasoning[0] {
		reasoning = true
	}

	if cbReason != nil {
		cbReason(execID, chunk, reasoning)
	} else if cb != nil {
		cb(execID, chunk)
	}
}

// StartOAuthLogin opens the Shuffle OAuth2 login flow with dynamic auth matching ChatGPT MCP logins
func (b *AgentBridge) StartOAuthLogin(customBaseURL string) string {
	targetURL := strings.TrimSpace(customBaseURL)
	if strings.HasPrefix(targetURL, "{") {
		var req struct {
			BaseURL string `json:"base_url"`
		}
		if err := json.Unmarshal([]byte(targetURL), &req); err == nil && req.BaseURL != "" {
			targetURL = req.BaseURL
		} else {
			targetURL = ""
		}
	} else if strings.HasPrefix(targetURL, "\"") && strings.HasSuffix(targetURL, "\"") {
		var s string
		if err := json.Unmarshal([]byte(targetURL), &s); err == nil {
			targetURL = s
		}
	}
	if targetURL == "" {
		targetURL = b.cfg.BaseURL
	}
	if targetURL == "" || strings.Contains(targetURL, "shuffler.io") {
		targetURL = "https://shuffle.security"
	}

	authURL, err := b.StartDynamicOAuth2Flow(targetURL, func(token, orgID, env string) {
		log.Printf("[INFO] Dynamic OAuth2 authorization complete for org: %s", orgID)
		go func() {
			_, _ = b.FetchShuffleOrgs()
		}()
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

	b.oauthLoggedIn = true
	b.oauthToken = token
	if orgID != "" {
		b.cfg.Org = orgID
		_ = os.Setenv("ORG", orgID)
		_ = os.Setenv("ORG_ID", orgID)
		_ = os.Setenv("SHUFFLE_ORG_ID", orgID)
	}
	if env != "" {
		b.cfg.Environment = env
	}
	if token != "" {
		b.cfg.Auth = token
		_ = os.Setenv("SHUFFLE_AUTHORIZATION", token)
		_ = os.Setenv("SHUFFLE_SESSION_TOKEN", token)
	}
	b.cfg.BaseURL = resolveShuffleAiBaseURL(b.cfg.BaseURL)
	_ = os.Setenv("SHUFFLE_BASE_URL", b.cfg.BaseURL)
	_ = os.Setenv("BASE_URL", b.cfg.BaseURL)
	b.activeExecutionMode = "shuffle"
	if b.aiModel == "" || b.aiModel == "shuffle" || strings.HasPrefix(b.aiModel, "tendon") || b.aiModel == "local" {
		b.aiModel = "shuffle-ai"
		_ = os.Setenv("AI_MODEL", b.aiModel)
	}

	b.saveLocalStoreLocked()

	resp, _ := json.Marshal(map[string]interface{}{
		"status":                "ok",
		"is_logged_in":          true,
		"oauth_logged_in":       true,
		"oauth_token":           b.oauthToken,
		"active_execution_mode": b.activeExecutionMode,
		"ai_model":              b.aiModel,
		"base_url":              b.cfg.BaseURL,
		"org_id":                b.cfg.Org,
		"org_name":              b.orgName,
		"shuffle_orgs":          b.shuffleOrgs,
		"environment":           b.cfg.Environment,
	})
	b.mu.Unlock()

	go func() {
		_, _ = b.FetchShuffleOrgs()
	}()

	return string(resp)
}

// FetchShuffleOrgs queries GET https://uk.shuffler.io/api/v1/getinfo (with fallback to current BaseURL)
// to retrieve the list of available tenants ("orgs") for the authenticated Shuffle user.
func (b *AgentBridge) FetchShuffleOrgs() ([]ShuffleOrg, error) {
	b.mu.Lock()
	token := strings.TrimSpace(b.oauthToken)
	if token == "" && b.cfg != nil {
		token = strings.TrimSpace(b.cfg.Auth)
	}
	if token == "" && (strings.HasPrefix(strings.TrimSpace(b.aiApiKey), "shfl_") || b.oauthLoggedIn) {
		token = strings.TrimSpace(b.aiApiKey)
	}
	if token == "" {
		token = strings.TrimSpace(os.Getenv("SHUFFLE_AUTHORIZATION"))
	}
	if token == "" {
		token = strings.TrimSpace(os.Getenv("SHUFFLE_SESSION_TOKEN"))
	}
	currentBaseURL := ""
	if b.cfg != nil {
		currentBaseURL = strings.TrimSpace(b.cfg.BaseURL)
	}
	b.mu.Unlock()

	if token == "" {
		return nil, fmt.Errorf("not logged in to Shuffle")
	}

	endpoints := []string{"https://uk.shuffler.io/api/v1/getinfo"}
	if currentBaseURL != "" {
		cleanBase := resolveShuffleAiBaseURL(currentBaseURL)
		altEndpoint := strings.TrimRight(cleanBase, "/") + "/api/v1/getinfo"
		if !strings.EqualFold(altEndpoint, endpoints[0]) {
			endpoints = append(endpoints, altEndpoint)
		}
	}
	defaultFallback := "https://shuffler.io/api/v1/getinfo"
	hasDefault := false
	for _, ep := range endpoints {
		if strings.EqualFold(ep, defaultFallback) {
			hasDefault = true
			break
		}
	}
	if !hasDefault {
		endpoints = append(endpoints, defaultFallback)
	}

	type getInfoResponse struct {
		Success   bool         `json:"success"`
		Orgs      []ShuffleOrg `json:"orgs"`
		ActiveOrg ShuffleOrg   `json:"active_org"`
	}

	var parsed getInfoResponse
	var lastErr error
	client := &http.Client{Timeout: 30 * time.Second}

	for _, endpoint := range endpoints {
		req, err := http.NewRequest("GET", endpoint, nil)
		if err != nil {
			lastErr = err
			continue
		}
		authHeader := token
		if !strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
			authHeader = "Bearer " + authHeader
		}
		req.Header.Set("Authorization", authHeader)
		req.Header.Set("Accept", "application/json")

		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode != 200 {
			lastErr = fmt.Errorf("getinfo %s returned HTTP %d", endpoint, resp.StatusCode)
			continue
		}

		var candidate getInfoResponse
		if err := json.Unmarshal(body, &candidate); err != nil {
			lastErr = err
			continue
		}
		if len(candidate.Orgs) > 0 || candidate.ActiveOrg.ID != "" {
			parsed = candidate
			lastErr = nil
			break
		}
	}

	if lastErr != nil && len(parsed.Orgs) == 0 && parsed.ActiveOrg.ID == "" {
		log.Printf("[WARN] Failed to fetch Shuffle tenants via getinfo: %v", lastErr)
		return nil, lastErr
	}

	orgs := make([]ShuffleOrg, 0, len(parsed.Orgs))
	seen := make(map[string]bool)
	for _, o := range parsed.Orgs {
		id := strings.TrimSpace(o.ID)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		regionURL := strings.TrimSpace(o.RegionURL)
		if regionURL != "" {
			regionURL = resolveShuffleAiBaseURL(regionURL)
		} else {
			regionURL = "https://uk.shuffler.io"
		}
		orgs = append(orgs, ShuffleOrg{
			ID:         id,
			Name:       strings.TrimSpace(o.Name),
			RegionURL:  regionURL,
			CreatorOrg: strings.TrimSpace(o.CreatorOrg),
		})
	}
	if len(orgs) == 0 && strings.TrimSpace(parsed.ActiveOrg.ID) != "" {
		id := strings.TrimSpace(parsed.ActiveOrg.ID)
		regionURL := strings.TrimSpace(parsed.ActiveOrg.RegionURL)
		if regionURL != "" {
			regionURL = resolveShuffleAiBaseURL(regionURL)
		} else {
			regionURL = "https://uk.shuffler.io"
		}
		orgs = append(orgs, ShuffleOrg{
			ID:         id,
			Name:       strings.TrimSpace(parsed.ActiveOrg.Name),
			RegionURL:  regionURL,
			CreatorOrg: strings.TrimSpace(parsed.ActiveOrg.CreatorOrg),
		})
	}

	b.mu.Lock()
	if len(orgs) > 0 {
		b.shuffleOrgs = orgs
	}

	currentOrgID := ""
	if b.cfg != nil {
		currentOrgID = strings.TrimSpace(b.cfg.Org)
	}

	var selected *ShuffleOrg
	for i := range b.shuffleOrgs {
		if b.shuffleOrgs[i].ID == currentOrgID {
			selected = &b.shuffleOrgs[i]
			break
		}
	}
	if selected == nil && parsed.ActiveOrg.ID != "" {
		for i := range b.shuffleOrgs {
			if b.shuffleOrgs[i].ID == strings.TrimSpace(parsed.ActiveOrg.ID) {
				selected = &b.shuffleOrgs[i]
				break
			}
		}
	}
	if selected == nil && len(b.shuffleOrgs) > 0 {
		selected = &b.shuffleOrgs[0]
	}

	if selected != nil {
		b.applyShuffleTenantLocked(*selected)
	}
	b.saveLocalStoreLocked()
	cb := b.onAuthUpdated
	resultOrgs := make([]ShuffleOrg, len(b.shuffleOrgs))
	copy(resultOrgs, b.shuffleOrgs)
	b.mu.Unlock()

	if cb != nil {
		cb(b.GetInitialState())
	}

	return resultOrgs, nil
}

// applyShuffleTenantLocked updates active org ID, org name, and regional base URLs while b.mu is held.
func (b *AgentBridge) applyShuffleTenantLocked(org ShuffleOrg) {
	orgID := strings.TrimSpace(org.ID)
	orgName := strings.TrimSpace(org.Name)
	baseURL := resolveShuffleAiBaseURL(org.RegionURL)

	if b.cfg != nil {
		if orgID != "" {
			b.cfg.Org = orgID
		}
		if baseURL != "" {
			b.cfg.BaseURL = baseURL
		}
	}
	if orgName != "" {
		b.orgName = orgName
	}
	if orgID != "" {
		_ = os.Setenv("ORG", orgID)
		_ = os.Setenv("ORG_ID", orgID)
		_ = os.Setenv("SHUFFLE_ORG_ID", orgID)
	}
	if baseURL != "" {
		_ = os.Setenv("SHUFFLE_BASE_URL", baseURL)
		_ = os.Setenv("BASE_URL", baseURL)
		if b.activeExecutionMode == "shuffle" || strings.Contains(strings.ToLower(b.aiApiUrl), "shuffler.io") || strings.Contains(strings.ToLower(b.aiApiUrl), "shuffle") {
			b.aiApiUrl = resolveShuffleAiApiURL(baseURL)
			_ = os.Setenv("AI_API_URL", b.aiApiUrl)
		}
	}
}

// GetShuffleTenants returns the cached or freshly fetched list of Shuffle tenants and active tenant metadata.
func (b *AgentBridge) GetShuffleTenants(refresh bool) string {
	b.mu.Lock()
	hasCached := len(b.shuffleOrgs) > 0
	b.mu.Unlock()

	var fetchErr error
	if refresh || !hasCached {
		_, fetchErr = b.FetchShuffleOrgs()
	}

	b.mu.Lock()
	orgID := ""
	baseURL := ""
	if b.cfg != nil {
		orgID = b.cfg.Org
		baseURL = b.cfg.BaseURL
	}
	respMap := map[string]interface{}{
		"status":       "ok",
		"org_id":       orgID,
		"org_name":     b.orgName,
		"base_url":     baseURL,
		"shuffle_orgs": b.shuffleOrgs,
	}
	if fetchErr != nil && len(b.shuffleOrgs) == 0 {
		respMap["status"] = "error"
		respMap["error"] = fetchErr.Error()
	}
	b.mu.Unlock()

	data, _ := json.Marshal(respMap)
	return string(data)
}

// SelectShuffleTenant switches the active Shuffle tenant (org ID and regional base URL) for all Shuffle API calls.
func (b *AgentBridge) SelectShuffleTenant(payload string) string {
	trimmed := strings.TrimSpace(payload)
	var req struct {
		OrgID     string `json:"org_id"`
		ID        string `json:"id"`
		Name      string `json:"name"`
		RegionURL string `json:"region_url"`
	}
	if strings.HasPrefix(trimmed, "{") {
		_ = json.Unmarshal([]byte(trimmed), &req)
	} else {
		req.OrgID = strings.Trim(trimmed, "\"")
	}

	targetID := strings.TrimSpace(req.OrgID)
	if targetID == "" {
		targetID = strings.TrimSpace(req.ID)
	}
	if targetID == "" {
		return `{"status":"error","error":"missing tenant id"}`
	}

	b.mu.Lock()
	var chosen ShuffleOrg
	found := false
	for _, o := range b.shuffleOrgs {
		if o.ID == targetID {
			chosen = o
			found = true
			break
		}
	}
	if !found {
		chosen = ShuffleOrg{
			ID:        targetID,
			Name:      strings.TrimSpace(req.Name),
			RegionURL: strings.TrimSpace(req.RegionURL),
		}
	}
	if req.RegionURL != "" && chosen.RegionURL == "" {
		chosen.RegionURL = strings.TrimSpace(req.RegionURL)
	}
	if req.Name != "" && chosen.Name == "" {
		chosen.Name = strings.TrimSpace(req.Name)
	}

	b.applyShuffleTenantLocked(chosen)
	b.saveLocalStoreLocked()

	orgID := ""
	baseURL := ""
	if b.cfg != nil {
		orgID = b.cfg.Org
		baseURL = b.cfg.BaseURL
	}
	orgName := b.orgName
	orgs := b.shuffleOrgs
	cb := b.onAuthUpdated
	b.mu.Unlock()

	log.Printf("[INFO] Switched active Shuffle tenant to %q (%s) at %s", orgName, orgID, baseURL)

	if cb != nil {
		go func() {
			cb(b.GetInitialState())
		}()
	}

	resp, _ := json.Marshal(map[string]interface{}{
		"status":       "ok",
		"org_id":       orgID,
		"org_name":     orgName,
		"base_url":     baseURL,
		"shuffle_orgs": orgs,
	})
	return string(resp)
}

// CancelOAuthLogin aborts any pending OAuth2 login flow
func (b *AgentBridge) CancelOAuthLogin() string {
	b.mu.Lock()
	if b.activeOAuthSession != nil {
		if b.activeOAuthSession.Server != nil {
			_ = b.activeOAuthSession.Server.Close()
		}
		b.activeOAuthSession = nil
	}
	b.mu.Unlock()
	return `{"status": "cancelled"}`
}

// LogoutShuffle resets Shuffle OAuth credentials and session
func (b *AgentBridge) LogoutShuffle() string {
	b.mu.Lock()
	if b.activeOAuthSession != nil {
		if b.activeOAuthSession.Server != nil {
			_ = b.activeOAuthSession.Server.Close()
		}
		b.activeOAuthSession = nil
	}
	oldToken := b.oauthToken
	oldAuth := ""
	if b.cfg != nil {
		oldAuth = b.cfg.Auth
	}

	b.oauthLoggedIn = false
	b.oauthToken = ""
	b.orgName = ""
	b.shuffleOrgs = nil
	if b.cfg != nil {
		b.cfg.Auth = ""
		b.cfg.Org = ""
		b.cfg.BaseURL = ""
		b.cfg.IsStandalone = true
		b.cfg.HasExplicitAuth = false
		b.cfg.HasExplicitOrg = false
		b.cfg.Environment = "standalone"
	}
	_ = os.Unsetenv("SHUFFLE_AUTHORIZATION")
	_ = os.Unsetenv("SHUFFLE_SESSION_TOKEN")
	_ = os.Unsetenv("SHUFFLE_BASE_URL")
	_ = os.Unsetenv("BASE_URL")
	_ = os.Unsetenv("AUTH")
	_ = os.Unsetenv("ORG")
	_ = os.Unsetenv("ORG_ID")
	_ = os.Unsetenv("SHUFFLE_ORG_ID")

	if strings.Contains(b.aiApiUrl, "shuffler.io") || strings.Contains(b.aiApiUrl, "shuffle") {
		b.aiApiUrl = ""
		_ = os.Unsetenv("AI_API_URL")
	}
	if strings.HasPrefix(b.aiApiKey, "shfl_") || (oldToken != "" && b.aiApiKey == oldToken) || (oldAuth != "" && b.aiApiKey == oldAuth) || b.aiApiUrl == "" {
		if strings.HasPrefix(b.aiApiKey, "shfl_") || (oldToken != "" && b.aiApiKey == oldToken) || (oldAuth != "" && b.aiApiKey == oldAuth) {
			b.aiApiKey = ""
			_ = os.Unsetenv("AI_API_KEY")
		}
	}

	if b.activeExecutionMode == "shuffle" || b.activeExecutionMode == "cloud" {
		if b.localModelPath != "" {
			b.activeExecutionMode = "local"
			b.aiModel = "tendon-local"
		} else if b.aiApiKey != "" {
			b.activeExecutionMode = "direct"
			b.aiModel = "gpt-4o"
		} else {
			b.activeExecutionMode = "local"
			b.aiModel = "tendon-local"
		}
	} else if b.aiModel == "shuffle-ai" || b.aiModel == "shuffle" {
		if b.localModelPath != "" {
			b.aiModel = "tendon-local"
		} else if b.aiApiKey != "" {
			b.aiModel = "gpt-4o"
		} else {
			b.aiModel = "tendon-local"
		}
	}
	_ = os.Setenv("ORBORUS_ACTIVE_EXECUTION_MODE", b.activeExecutionMode)
	_ = os.Setenv("AI_MODEL", b.aiModel)

	b.saveLocalStoreLocked()
	stateJSON := b.getInitialStateLocked()
	b.mu.Unlock()

	resp, _ := json.Marshal(map[string]interface{}{
		"status":                "ok",
		"message":               "Logged out of Shuffle successfully",
		"is_logged_in":          false,
		"oauth_logged_in":       false,
		"active_execution_mode": b.activeExecutionMode,
		"ai_model":              b.aiModel,
		"state":                 json.RawMessage(stateJSON),
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

	if req.BaseURL != "" || req.OrgID != "" {
		chosen := ShuffleOrg{
			ID:        strings.TrimSpace(req.OrgID),
			RegionURL: strings.TrimSpace(req.BaseURL),
		}
		if chosen.ID != "" {
			for _, o := range b.shuffleOrgs {
				if o.ID == chosen.ID {
					if chosen.Name == "" {
						chosen.Name = o.Name
					}
					if chosen.RegionURL == "" {
						chosen.RegionURL = o.RegionURL
					}
					break
				}
			}
		}
		b.applyShuffleTenantLocked(chosen)
	}
	if req.Auth != "" {
		b.cfg.Auth = req.Auth
		if strings.HasPrefix(req.Auth, "shfl_") {
			b.oauthLoggedIn = true
		}
	}
	if req.Environment != "" {
		b.cfg.Environment = req.Environment
	}

	isBypassed := b.isAuthBypassed()
	isLoggedIn := b.isShuffleAuthenticatedLocked()
	if isLoggedIn {
		b.cfg.IsStandalone = false
	}

	b.saveLocalStoreLocked()

	resp, _ := json.Marshal(map[string]interface{}{
		"status":          "ok",
		"is_logged_in":    isLoggedIn,
		"oauth_logged_in": isLoggedIn,
		"is_bypassed":     isBypassed,
		"org_id":          b.cfg.Org,
		"org_name":        b.orgName,
		"environment":     b.cfg.Environment,
		"base_url":        b.cfg.BaseURL,
	})
	return string(resp)
}

// ListProjects returns detected code repositories on the machine
func (b *AgentBridge) ListProjects() string {
	b.mu.Lock()
	if b.activeProject != "" && b.activeProject != "." {
		activeClean := strings.ToLower(filepath.Clean(b.activeProject))
		hasActive := false
		for _, p := range b.projects {
			if strings.ToLower(filepath.Clean(p.Path)) == activeClean {
				hasActive = true
				break
			}
		}
		if !hasActive {
			b.projects = append([]shuffle.ProjectInfo{{Path: b.activeProject}}, b.projects...)
		}
	}

	currentProjects := b.projects
	needsScan := len(b.projects) == 0 && !b.isScanning && !b.projectsScanned
	b.mu.Unlock()

	if needsScan {
		go func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("[ERROR] Recovered from panic in background ScanProjects: %v", r)
				}
			}()
			b.ScanProjects()
		}()
	}

	data, _ := json.Marshal(currentProjects)
	return string(data)
}

// SelectProject changes the working directory and ensures the directory exists
func (b *AgentBridge) SelectProject(path string) string {
	cleanPath := strings.TrimSpace(path)
	if cleanPath == "" || cleanPath == "none" || cleanPath == "No project" || cleanPath == "__NONE__" {
		b.mu.Lock()
		b.activeProject = ""
		projects := b.projects
		b.mu.Unlock()

		go func() {
			b.mu.Lock()
			b.saveLocalStoreLocked()
			b.mu.Unlock()
		}()

		resp, _ := json.Marshal(map[string]interface{}{
			"status":         "ok",
			"active_project": "",
			"project_name":   "No project",
			"projects":       projects,
		})
		return string(resp)
	}

	cleanPath = filepath.Clean(cleanPath)

	projName := filepath.Base(cleanPath)
	if projName == "." || projName == "/" || projName == "\\" || projName == "" {
		projName = "Project"
	}

	b.mu.Lock()
	b.activeProject = cleanPath

	// Add to projects list if not already present (preserve existing order)
	cleanNorm := strings.ToLower(cleanPath)
	foundExisting := false
	updatedProjects := make([]shuffle.ProjectInfo, 0, len(b.projects)+1)
	for _, p := range b.projects {
		if p.Path == "." || p.Path == "" {
			continue
		}
		if strings.ToLower(filepath.Clean(p.Path)) == cleanNorm {
			foundExisting = true
		}
		updatedProjects = append(updatedProjects, p)
	}
	if !foundExisting {
		updatedProjects = append([]shuffle.ProjectInfo{{Path: cleanPath}}, updatedProjects...)
	}
	b.projects = updatedProjects
	b.mu.Unlock()

	// Ensure directory exists and persist store asynchronously off the hot path
	go func(targetPath string, ensureDir bool) {
		if ensureDir && targetPath != "." {
			if _, err := os.Stat(targetPath); os.IsNotExist(err) {
				if err := os.MkdirAll(targetPath, 0755); err != nil {
					log.Printf("[WARNING] SelectProject: Failed to ensure directory %s: %v", targetPath, err)
				}
			}
		}
		b.mu.Lock()
		b.saveLocalStoreLocked()
		b.mu.Unlock()
	}(cleanPath, !foundExisting)

	resp, _ := json.Marshal(map[string]interface{}{
		"status":         "ok",
		"active_project": cleanPath,
		"project_name":   projName,
		"projects":       updatedProjects,
	})
	return string(resp)
}

// QuickStartProject creates a new folder with a semi-random name in the default project location and selects it.
func (b *AgentBridge) QuickStartProject(customBaseDir ...string) string {
	baseDir := ""
	if len(customBaseDir) > 0 && strings.TrimSpace(customBaseDir[0]) != "" {
		raw := strings.TrimSpace(customBaseDir[0])
		if strings.HasPrefix(raw, "{") {
			var parsed struct {
				BaseDir string `json:"base_dir"`
				Path    string `json:"path"`
			}
			if err := json.Unmarshal([]byte(raw), &parsed); err == nil {
				if strings.TrimSpace(parsed.BaseDir) != "" {
					baseDir = strings.TrimSpace(parsed.BaseDir)
				} else if strings.TrimSpace(parsed.Path) != "" {
					baseDir = strings.TrimSpace(parsed.Path)
				}
			}
		} else if raw != "{}" && raw != "null" && raw != "undefined" {
			baseDir = raw
		}
	}
	if baseDir == "" {
		b.mu.Lock()
		active := strings.TrimSpace(b.activeProject)
		var firstProj string
		for _, p := range b.projects {
			if p.Path != "" && p.Path != "." {
				firstProj = p.Path
				break
			}
		}
		b.mu.Unlock()

		if active != "" && active != "." {
			parent := filepath.Dir(filepath.Clean(active))
			if parent != "" && parent != "." && parent != active {
				baseDir = parent
			}
		}
		if baseDir == "" && firstProj != "" {
			parent := filepath.Dir(filepath.Clean(firstProj))
			if parent != "" && parent != "." && parent != firstProj {
				baseDir = parent
			}
		}
		if baseDir == "" {
			if homeDir, err := os.UserHomeDir(); err == nil && homeDir != "" {
				baseDir = filepath.Join(homeDir, "Projects")
			} else if cwd, err := os.Getwd(); err == nil && cwd != "" {
				baseDir = filepath.Dir(cwd)
			}
		}
	}

	adjectives := []string{
		"swift", "calm", "bright", "keen", "bold", "lunar",
		"solar", "rapid", "amber", "cobalt", "ember", "frost",
		"silent", "vivid", "noble", "prime", "clear", "crisp",
	}
	nouns := []string{
		"falcon", "orbit", "beacon", "vertex", "nexus", "prism",
		"atlas", "comet", "spark", "haven", "pulse", "ridge",
		"harbor", "summit", "forge", "vector", "anchor", "quasar",
	}

	seed := time.Now().UnixNano()
	var folderName, targetPath string
	for attempt := 0; attempt < 20; attempt++ {
		h := sha256.Sum256([]byte(fmt.Sprintf("%d-%d", seed, attempt)))
		adj := adjectives[int(h[0])%len(adjectives)]
		noun := nouns[int(h[1])%len(nouns)]
		num := 100 + (int(h[2])*256+int(h[3]))%900
		folderName = fmt.Sprintf("%s-%s-%d", adj, noun, num)
		targetPath = filepath.Clean(filepath.Join(baseDir, folderName))
		if _, err := os.Stat(targetPath); os.IsNotExist(err) {
			break
		}
	}

	if _, err := osctrl.CreateDirectory(targetPath, ""); err != nil {
		resp, _ := json.Marshal(map[string]interface{}{
			"status":  "error",
			"message": fmt.Sprintf("Failed to create quick start folder: %v", err),
		})
		return string(resp)
	}

	_ = b.SelectProject(targetPath)
	b.mu.Lock()
	projects := b.projects
	b.mu.Unlock()

	resp, _ := json.Marshal(map[string]interface{}{
		"status":         "ok",
		"path":           targetPath,
		"active_project": targetPath,
		"project_name":   folderName,
		"projects":       projects,
	})
	return string(resp)
}

// SetPermissionPolicy updates the security mode
func (b *AgentBridge) SetPermissionPolicy(policy string) string {
	b.mu.Lock()
	defer b.mu.Unlock()

	if policy == "ask_all" || policy == "safe_auto" || policy == "full_auto" {
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

	if req.PermissionPolicy == "ask_all" || req.PermissionPolicy == "safe_auto" || req.PermissionPolicy == "full_auto" || req.PermissionPolicy == "custom" {
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
			cleanKey := filepath.Clean(strings.TrimSpace(k))
			for existingKey := range b.projectPermissions {
				if strings.EqualFold(filepath.Clean(existingKey), cleanKey) && existingKey != cleanKey {
					delete(b.projectPermissions, existingKey)
				}
			}
			v.AttachedFolders = sanitizeAttachedFolders(cleanKey, v.AttachedFolders)
			b.projectPermissions[cleanKey] = v
		}
	}
	if req.AiApiUrl != "" {
		trimmedUrl := strings.TrimSpace(req.AiApiUrl)
		if !b.oauthLoggedIn && (strings.Contains(trimmedUrl, "shuffler.io") || strings.Contains(trimmedUrl, "shuffle")) {
			b.aiApiUrl = ""
			_ = os.Unsetenv("AI_API_URL")
		} else {
			b.aiApiUrl = trimmedUrl
			_ = os.Setenv("AI_API_URL", b.aiApiUrl)
			if b.oauthLoggedIn && (strings.Contains(b.aiApiUrl, "shuffler.io") || strings.Contains(b.aiApiUrl, "shuffle")) {
				cleanUrl := strings.TrimRight(strings.TrimSuffix(b.aiApiUrl, "/api/v1"), "/")
				_ = os.Setenv("SHUFFLE_BASE_URL", cleanUrl)
				_ = os.Setenv("BASE_URL", cleanUrl)
				if b.cfg != nil {
					b.cfg.BaseURL = cleanUrl
				}
			}
		}
	} else if strings.Contains(payload, `"ai_api_url"`) {
		b.aiApiUrl = ""
		_ = os.Unsetenv("AI_API_URL")
	}

	if req.AiApiKey != "" {
		trimmedKey := strings.TrimSpace(req.AiApiKey)
		if !b.oauthLoggedIn && strings.HasPrefix(trimmedKey, "shfl_") {
			b.aiApiKey = ""
			_ = os.Unsetenv("AI_API_KEY")
		} else {
			b.aiApiKey = trimmedKey
			_ = os.Setenv("AI_API_KEY", b.aiApiKey)
			if b.oauthLoggedIn && strings.HasPrefix(b.aiApiKey, "shfl_") && b.aiApiKey != "local-tendon" {
				_ = os.Setenv("SHUFFLE_AUTHORIZATION", b.aiApiKey)
				_ = os.Setenv("SHUFFLE_SESSION_TOKEN", b.aiApiKey)
				if b.cfg != nil {
					b.cfg.Auth = b.aiApiKey
				}
			}
		}
	} else if strings.Contains(payload, `"ai_api_key"`) {
		b.aiApiKey = ""
		_ = os.Unsetenv("AI_API_KEY")
	}

	if req.AiModel != "" {
		trimmedModel := strings.TrimSpace(req.AiModel)
		if !b.oauthLoggedIn && (trimmedModel == "shuffle-ai" || trimmedModel == "shuffle") {
			b.aiModel = "tendon-local"
		} else {
			b.aiModel = trimmedModel
		}
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
	b.mu.Unlock()

	return stateStr
}

// MaxProjectFolders is the maximum total number of primary folders that can be attached to a project (including the root path)
const MaxProjectFolders = 5

// sanitizeAttachedFolders normalizes, deduplicates, and caps additional attached folders so total folders (root + attached) <= MaxProjectFolders
func sanitizeAttachedFolders(primaryPath string, attached []string) []string {
	cleanPrimary := filepath.Clean(strings.TrimSpace(primaryPath))
	seen := make(map[string]bool)
	if cleanPrimary != "" && cleanPrimary != "." && cleanPrimary != "__NONE__" {
		seen[strings.ToLower(cleanPrimary)] = true
	}
	var out []string
	maxAdditional := MaxProjectFolders - 1
	if maxAdditional < 0 {
		maxAdditional = 0
	}
	for _, raw := range attached {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" || trimmed == "." || trimmed == "__NONE__" {
			continue
		}
		clean := filepath.Clean(trimmed)
		key := strings.ToLower(clean)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, clean)
		if len(out) >= maxAdditional {
			break
		}
	}
	return out
}

// getProjectFoldersLocked returns all primary folders attached to a project (primary root first, followed by up to 4 additional attached folders, max 5 total)
func (b *AgentBridge) getProjectFoldersLocked(projectPath string) []string {
	trimmed := strings.TrimSpace(projectPath)
	if trimmed == "" || trimmed == "." || trimmed == "__NONE__" {
		return nil
	}
	cleanPrimary := filepath.Clean(trimmed)
	folders := []string{cleanPrimary}
	if perms, ok := b.getProjectPermissionLocked(cleanPrimary); ok && len(perms.AttachedFolders) > 0 {
		extra := sanitizeAttachedFolders(cleanPrimary, perms.AttachedFolders)
		folders = append(folders, extra...)
	}
	if len(folders) > MaxProjectFolders {
		folders = folders[:MaxProjectFolders]
	}
	return folders
}

// GetProjectFolders returns all primary folders attached to a project (up to MaxProjectFolders)
func (b *AgentBridge) GetProjectFolders(projectPath string) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.getProjectFoldersLocked(projectPath)
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
	perms.AttachedFolders = sanitizeAttachedFolders(cleanKey, perms.AttachedFolders)
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
	isShuffleAuth := b.isShuffleAuthenticatedLocked()
	isLoggedIn := isShuffleAuth

	projCtx := GetRuleLoaderManager().LoadProjectContext(b.activeProject)

	hostname := ""
	machineID := ""
	isStandalone := true
	baseURL := ""
	orgID := ""
	auth := ""
	env := ""
	oauthToken := ""
	if b.cfg != nil {
		hostname = b.cfg.Hostname
		machineID = b.cfg.MachineID
		isStandalone = b.cfg.IsStandalone
		baseURL = b.cfg.BaseURL
		orgID = b.cfg.Org
		if isShuffleAuth {
			auth = b.cfg.Auth
			oauthToken = b.oauthToken
		}
		env = b.cfg.Environment
	}

	modelsDir := b.localModelsDir
	if modelsDir == "" {
		modelsDir = os.Getenv("LOCAL_MODELS_DIR")
	}
	if modelsDir == "" {
		modelsDir = "models"
	}

	modelPath := b.localModelPath
	if modelPath == "" {
		modelPath = os.Getenv("LOCAL_MODEL_PATH")
	}

	catalogStatus, diskInfo := BuildLocalModelCatalogStatus(modelsDir, modelPath)

	approvalQueueSnapshot := make([]ApprovalRequest, len(b.pendingApprovals))
	copy(approvalQueueSnapshot, b.pendingApprovals)
	if len(b.pendingApprovals) > 0 {
		first := b.pendingApprovals[0]
		b.pendingApproval = &first
	} else {
		b.pendingApproval = nil
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
		"approval_queue":            approvalQueueSnapshot,
		"projects":                  b.projects,
		"projects_scanned":          b.projectsScanned,
		"is_logged_in":              isLoggedIn,
		"oauth_logged_in":           isShuffleAuth,
		"oauth_token":               oauthToken,
		"is_bypassed":               isBypassed,
		"org_id":                    orgID,
		"org_name":                  b.orgName,
		"shuffle_orgs":              b.shuffleOrgs,
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
		"local_models_dir":          modelsDir,
		"local_model_path":          modelPath,
		"local_models_catalog":      catalogStatus,
		"local_disk_free_bytes":     diskInfo.FreeBytes,
		"local_disk_free_gb":        diskInfo.FreeGB,
		"local_disk_free_display":   diskInfo.FreeDisplay,
		"local_download_state":      GlobalModelDownloader.GetState(),
		"active_execution_mode":     b.activeExecutionMode,
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

// hasShellChaining returns true if a command string contains shell command chaining, redirection, or substitution operators
func hasShellChaining(cmd string) bool {
	return strings.Contains(cmd, ";") ||
		strings.Contains(cmd, "|") ||
		strings.Contains(cmd, "&") ||
		strings.Contains(cmd, ">") ||
		strings.Contains(cmd, "<") ||
		strings.Contains(cmd, "`") ||
		strings.Contains(cmd, "$(") ||
		strings.Contains(cmd, "\n") ||
		strings.Contains(cmd, "\r")
}

// inferApprovalCategory categorizes a command, path, URL, or MCP tool string
func inferApprovalCategory(target string) string {
	trimmed := strings.TrimSpace(target)
	lower := strings.ToLower(trimmed)
	if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") || strings.HasPrefix(lower, "curl ") || strings.HasPrefix(lower, "wget ") || strings.HasPrefix(lower, "invoke-webrequest") {
		return "network"
	}
	if strings.HasPrefix(lower, "mcp_") || strings.HasPrefix(lower, "mcp:") || strings.HasPrefix(lower, "mcp ") {
		return "mcp"
	}
	if strings.HasPrefix(trimmed, "/") || strings.HasPrefix(trimmed, "~/") || strings.HasPrefix(trimmed, "./") || strings.HasPrefix(trimmed, "../") || (len(trimmed) >= 3 && trimmed[1] == ':' && (trimmed[2] == '\\' || trimmed[2] == '/')) {
		return "file_read"
	}
	return "terminal"
}

// EffectivePermissions represents the resolved security configuration for a given project
type EffectivePermissions struct {
	PermissionPolicy        string
	FileAccessPolicy        string
	TerminalExecutionPolicy string
	SandboxMode             bool
	AllowedCommands         string
}

// getEffectivePermissionsLocked resolves global + per-project security settings under lock
func (b *AgentBridge) getEffectivePermissionsLocked(projectPath string) EffectivePermissions {
	eff := EffectivePermissions{
		PermissionPolicy:        b.permissionPolicy,
		FileAccessPolicy:        b.fileAccessPolicy,
		TerminalExecutionPolicy: b.terminalExecutionPolicy,
		SandboxMode:             b.sandboxMode,
	}
	if eff.PermissionPolicy == "" {
		eff.PermissionPolicy = "safe_auto"
	}
	if eff.FileAccessPolicy == "" {
		eff.FileAccessPolicy = "ask"
	}
	if eff.TerminalExecutionPolicy == "" {
		eff.TerminalExecutionPolicy = "safe_auto"
	}

	targetProj := strings.TrimSpace(projectPath)
	if targetProj == "" {
		targetProj = b.activeProject
	}
	if pPerm, ok := b.getProjectPermissionLocked(targetProj); ok {
		if pPerm.PermissionPolicy != "" && pPerm.PermissionPolicy != "inherit" {
			eff.PermissionPolicy = pPerm.PermissionPolicy
			switch pPerm.PermissionPolicy {
			case "ask_all":
				eff.TerminalExecutionPolicy = "prompt"
				eff.FileAccessPolicy = "strict"
				eff.SandboxMode = true
			case "safe_auto":
				eff.TerminalExecutionPolicy = "safe_auto"
				eff.FileAccessPolicy = "ask"
			case "full_auto":
				eff.TerminalExecutionPolicy = "full_auto"
				eff.FileAccessPolicy = "allow_all"
				eff.SandboxMode = false
			}
		}
		if pPerm.FileAccessPolicy != "" && pPerm.FileAccessPolicy != "inherit" {
			eff.FileAccessPolicy = pPerm.FileAccessPolicy
		}
		if pPerm.TerminalExecutionPolicy != "" && pPerm.TerminalExecutionPolicy != "inherit" {
			eff.TerminalExecutionPolicy = pPerm.TerminalExecutionPolicy
		}
		if pPerm.SandboxMode != nil {
			eff.SandboxMode = *pPerm.SandboxMode
		}
		eff.AllowedCommands = pPerm.AllowedCommands
	}

	if eff.FileAccessPolicy == "workspace_only" {
		eff.FileAccessPolicy = "strict"
	}
	return eff
}

// evalSymlinksWithFallback resolves symlinks on a path or its deepest existing parent directory
func evalSymlinksWithFallback(p string) string {
	cleaned := filepath.Clean(p)
	if resolved, err := filepath.EvalSymlinks(cleaned); err == nil {
		return filepath.Clean(resolved)
	}
	cur := cleaned
	var tail []string
	for i := 0; i < 32; i++ {
		parent := filepath.Dir(cur)
		base := filepath.Base(cur)
		if parent == cur {
			break
		}
		tail = append([]string{base}, tail...)
		if resolvedParent, err := filepath.EvalSymlinks(parent); err == nil {
			parts := append([]string{resolvedParent}, tail...)
			return filepath.Clean(filepath.Join(parts...))
		}
		cur = parent
	}
	return cleaned
}

// checkMultiWorkspacePathBoundary checks if rawPath is inside any of the project's attached primary folders
func checkMultiWorkspacePathBoundary(rawPath string, projectFolders []string) (string, bool) {
	if len(projectFolders) == 0 {
		return checkWorkspacePathBoundary(rawPath, "")
	}
	var firstResolved string
	trimmed := strings.TrimSpace(strings.Trim(strings.TrimSpace(rawPath), `"'`))
	isRel := trimmed != "" && !strings.HasPrefix(trimmed, "~") && !filepath.IsAbs(trimmed)
	for i, folder := range projectFolders {
		if isRel && i > 0 {
			candidate := filepath.Join(folder, trimmed)
			if _, err := os.Stat(candidate); err == nil {
				if resolved, inside := checkWorkspacePathBoundary(candidate, folder); inside {
					return resolved, true
				}
			}
			continue
		}
		resolved, inside := checkWorkspacePathBoundary(rawPath, folder)
		if i == 0 {
			firstResolved = resolved
		}
		if inside {
			return resolved, true
		}
	}
	return firstResolved, false
}

// extractCommandOutsidePathsMulti inspects a shell command for path arguments that resolve outside all of the project's primary folders
func extractCommandOutsidePathsMulti(cmd string, projectFolders []string) []string {
	if len(projectFolders) == 0 {
		return nil
	}
	primaryOutside := extractCommandOutsidePaths(cmd, projectFolders[0])
	if len(primaryOutside) == 0 || len(projectFolders) == 1 {
		return primaryOutside
	}
	var outside []string
	for _, p := range primaryOutside {
		insideAny := false
		for _, folder := range projectFolders[1:] {
			if _, inside := checkWorkspacePathBoundary(p, folder); inside {
				insideAny = true
				break
			}
		}
		if !insideAny {
			outside = append(outside, p)
		}
	}
	return outside
}

// checkWorkspacePathBoundary resolves rawPath relative to projectRoot and checks if it stays strictly inside projectRoot
func checkWorkspacePathBoundary(rawPath, projectRoot string) (string, bool) {
	trimmed := strings.TrimSpace(rawPath)
	trimmed = strings.Trim(trimmed, `"'`)
	if trimmed == "" {
		return "", true
	}
	if strings.HasPrefix(trimmed, "~") {
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			if trimmed == "~" {
				trimmed = home
			} else if strings.HasPrefix(trimmed, "~/") || strings.HasPrefix(trimmed, `~\`) {
				trimmed = filepath.Join(home, trimmed[2:])
			}
		}
	}

	proj := strings.TrimSpace(projectRoot)
	if proj == "" || proj == "." || proj == "__NONE__" {
		if cwd, err := os.Getwd(); err == nil && cwd != "" {
			proj = cwd
		}
	}
	if proj == "" || proj == "__NONE__" {
		return filepath.Clean(trimmed), true
	}

	absProj, errP := filepath.Abs(proj)
	if errP != nil {
		return filepath.Clean(trimmed), true
	}
	realProj := evalSymlinksWithFallback(absProj)

	target := trimmed
	if !filepath.IsAbs(target) {
		target = filepath.Join(realProj, target)
	}
	absTarget, errT := filepath.Abs(target)
	if errT != nil {
		return filepath.Clean(target), false
	}
	realTarget := evalSymlinksWithFallback(absTarget)

	volProj := strings.ToLower(filepath.VolumeName(realProj))
	volTarget := strings.ToLower(filepath.VolumeName(realTarget))
	if volProj != "" && volTarget != "" && volProj != volTarget {
		return realTarget, false
	}

	rel, errRel := filepath.Rel(strings.ToLower(filepath.Clean(realProj)), strings.ToLower(filepath.Clean(realTarget)))
	if errRel != nil {
		return realTarget, false
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || strings.HasPrefix(rel, "../") || strings.HasPrefix(rel, `..\`) {
		return realTarget, false
	}
	return realTarget, true
}

// extractCommandOutsidePaths inspects a shell command for path arguments that resolve outside projectRoot
func extractCommandOutsidePaths(cmd, projectRoot string) []string {
	if strings.TrimSpace(projectRoot) == "" || projectRoot == "__NONE__" {
		return nil
	}
	var outside []string
	seen := make(map[string]bool)
	tokens := strings.Fields(cmd)
	for idx, rawTok := range tokens {
		tok := strings.Trim(rawTok, `"'`+"`"+`;|&()<>`)
		if tok == "" {
			continue
		}
		if strings.Contains(tok, "=") && !strings.HasPrefix(tok, "=") {
			parts := strings.SplitN(tok, "=", 2)
			if len(parts) == 2 && parts[1] != "" {
				tok = strings.Trim(parts[1], `"'`)
			}
		}
		if strings.HasPrefix(tok, "-") || strings.Contains(tok, "://") {
			continue
		}
		looksLikePath := strings.HasPrefix(tok, "~/") || strings.HasPrefix(tok, `~\`) || tok == "~" ||
			strings.HasPrefix(tok, "../") || strings.HasPrefix(tok, `..\`) || tok == ".." ||
			strings.Contains(tok, "/../") || strings.Contains(tok, `\..\`) ||
			strings.HasPrefix(tok, "/") || strings.HasPrefix(tok, `\`) ||
			(len(tok) >= 3 && ((tok[0] >= 'A' && tok[0] <= 'Z') || (tok[0] >= 'a' && tok[0] <= 'z')) && tok[1] == ':' && (tok[2] == '\\' || tok[2] == '/'))

		if !looksLikePath && idx > 0 && (strings.Contains(tok, "/") || strings.Contains(tok, `\`)) {
			if !strings.HasPrefix(tok, "origin/") && !strings.HasPrefix(tok, "HEAD") && !strings.HasPrefix(tok, "refs/") {
				looksLikePath = true
			}
		}
		if !looksLikePath {
			continue
		}
		if strings.HasPrefix(tok, "/dev/") || tok == "/dev/null" {
			continue
		}
		resolved, inside := checkWorkspacePathBoundary(tok, projectRoot)
		if !inside && !seen[resolved] {
			seen[resolved] = true
			outside = append(outside, resolved)
		}
	}
	return outside
}

// hasUnsafeRedirectionOrSub returns true if a command contains redirection or subshell expansion
func hasUnsafeRedirectionOrSub(cmd string) bool {
	return strings.Contains(cmd, ">") ||
		strings.Contains(cmd, "<") ||
		strings.Contains(cmd, "`") ||
		strings.Contains(cmd, "$(")
}

// splitChainedSubcommands splits a command on &&, ||, ;, |, and newlines while respecting quotes
func splitChainedSubcommands(cmd string) []string {
	var parts []string
	var cur strings.Builder
	inSingle := false
	inDouble := false
	runes := []rune(cmd)
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		if r == '\'' && !inDouble {
			inSingle = !inSingle
			cur.WriteRune(r)
			continue
		}
		if r == '"' && !inSingle {
			inDouble = !inDouble
			cur.WriteRune(r)
			continue
		}
		if !inSingle && !inDouble {
			if (r == '&' && i+1 < len(runes) && runes[i+1] == '&') ||
				(r == '|' && i+1 < len(runes) && runes[i+1] == '|') {
				if s := strings.TrimSpace(cur.String()); s != "" {
					parts = append(parts, s)
				}
				cur.Reset()
				i++
				continue
			}
			if r == ';' || r == '|' || r == '\n' || r == '\r' || r == '&' {
				if s := strings.TrimSpace(cur.String()); s != "" {
					parts = append(parts, s)
				}
				cur.Reset()
				continue
			}
		}
		cur.WriteRune(r)
	}
	if s := strings.TrimSpace(cur.String()); s != "" {
		parts = append(parts, s)
	}
	return parts
}

// checkRulesDecisionLocked returns (matched, allowed) for a command or native tool identifier against remembered approval rules
func (b *AgentBridge) checkRulesDecisionLocked(cmd, convID string, projectPath ...string) (bool, bool) {
	trimmed := strings.TrimSpace(cmd)
	if trimmed == "" {
		return false, false
	}
	targetProj := b.activeProject
	if len(projectPath) > 0 && strings.TrimSpace(projectPath[0]) != "" {
		targetProj = strings.TrimSpace(projectPath[0])
	}
	cleanTargetProj := filepath.Clean(targetProj)

	matchedAllow := false
	for _, rule := range b.approvalRules {
		rCmd := strings.TrimSpace(rule.Command)
		if rCmd == "" {
			continue
		}
		exactMatch := strings.EqualFold(trimmed, rCmd)
		prefixMatch := (strings.HasPrefix(strings.ToLower(trimmed), strings.ToLower(rCmd)+" ") ||
			strings.HasPrefix(strings.ToLower(trimmed), strings.ToLower(rCmd)+":")) && !hasShellChaining(trimmed)
		if !exactMatch && !prefixMatch {
			continue
		}
		inScope := false
		switch rule.Scope {
		case "global", "":
			inScope = true
		case "project":
			if rule.ScopeID == "" || strings.EqualFold(filepath.Clean(rule.ScopeID), cleanTargetProj) || strings.EqualFold(filepath.Clean(rule.ScopeID), filepath.Clean(b.activeProject)) {
				inScope = true
			}
		case "conversation":
			if convID != "" && rule.ScopeID == convID {
				inScope = true
			}
		}
		if !inScope {
			continue
		}
		if strings.EqualFold(rule.Action, "deny") {
			return true, false
		}
		matchedAllow = true
	}
	if matchedAllow {
		return true, true
	}
	return false, false
}

// isApprovedByRulesLocked checks if a command is covered by any remembered approval rules
func (b *AgentBridge) isApprovedByRulesLocked(cmd, convID string) bool {
	matched, allowed := b.checkRulesDecisionLocked(cmd, convID, b.activeProject)
	return matched && allowed
}

// isSingleCommandAllowedLocked checks a single unchained command against rules and project AllowedCommands
func (b *AgentBridge) isSingleCommandAllowedLocked(cmd, convID, projectPath string) (matched bool, allowed bool) {
	trimmed := strings.TrimSpace(cmd)
	if trimmed == "" {
		return true, true
	}
	if m, a := b.checkRulesDecisionLocked(trimmed, convID, projectPath); m {
		return true, a
	}
	if pPerm, ok := b.getProjectPermissionLocked(projectPath); ok && pPerm.AllowedCommands != "" {
		cmds := strings.FieldsFunc(pPerm.AllowedCommands, func(r rune) bool {
			return r == ',' || r == '\n' || r == ';'
		})
		for _, allowedEntry := range cmds {
			allowedEntry = strings.TrimSpace(allowedEntry)
			if allowedEntry == "" {
				continue
			}
			if strings.EqualFold(trimmed, allowedEntry) ||
				(strings.HasPrefix(strings.ToLower(trimmed), strings.ToLower(allowedEntry)+" ") && !hasShellChaining(trimmed)) {
				return true, true
			}
		}
	}
	return false, false
}

// isCommandAllowedLocked checks if a command (including chained subcommands) is permitted by remembered rules or project-specific allowed commands
func (b *AgentBridge) isCommandAllowedLocked(cmd, convID, projectPath string) bool {
	trimmed := strings.TrimSpace(cmd)
	if trimmed == "" {
		return true
	}
	// Exact match for the full command string takes precedence
	if m, a := b.checkRulesDecisionLocked(trimmed, convID, projectPath); m {
		return a
	}
	if hasUnsafeRedirectionOrSub(trimmed) {
		return false
	}
	subs := splitChainedSubcommands(trimmed)
	if len(subs) == 0 {
		return false
	}
	for _, sub := range subs {
		m, a := b.isSingleCommandAllowedLocked(sub, convID, projectPath)
		if !m || !a {
			return false
		}
	}
	return true
}

// isSafeSingleCommand returns true for a single non-destructive read-only command
func isSafeSingleCommand(cmd string) bool {
	trimmed := strings.TrimSpace(cmd)
	if hasShellChaining(trimmed) {
		return false
	}
	parts := strings.Fields(trimmed)
	if len(parts) == 0 {
		return true
	}
	bin := strings.ToLower(filepath.Base(parts[0]))
	bin = strings.TrimSuffix(bin, ".exe")
	safeBins := map[string]bool{
		"ls": true, "dir": true, "cat": true, "type": true, "pwd": true, "echo": true, "head": true,
		"tail": true, "grep": true, "rg": true, "find": true, "which": true, "where": true, "whoami": true,
		"hostname": true, "date": true, "uptime": true, "uname": true, "df": true, "du": true, "wc": true,
		"sort": true, "uniq": true, "cut": true, "tr": true, "stat": true, "file": true, "tree": true,
		"get-childitem": true, "get-content": true, "get-location": true, "select-string": true,
		"get-item": true, "test-path": true, "write-output": true,
	}
	if bin == "git" && len(parts) > 1 {
		safeGit := map[string]bool{
			"status": true, "log": true, "diff": true, "branch": true, "show": true,
			"rev-parse": true, "remote": true, "tag": true, "describe": true, "shortlog": true,
		}
		return safeGit[strings.ToLower(parts[1])]
	}
	if bin == "go" && len(parts) > 1 {
		safeGo := map[string]bool{
			"version": true, "env": true, "list": true, "vet": true, "doc": true,
		}
		return safeGo[strings.ToLower(parts[1])]
	}
	if (bin == "node" || bin == "npm" || bin == "python" || bin == "python3" || bin == "cargo" || bin == "rustc") && len(parts) == 2 {
		if parts[1] == "-v" || parts[1] == "--version" || parts[1] == "-V" {
			return true
		}
	}
	return safeBins[bin]
}

// isSafeCommand returns true for non-destructive read operations (or chains consisting purely of safe read operations without redirection)
func isSafeCommand(cmd string) bool {
	trimmed := strings.TrimSpace(cmd)
	if trimmed == "" {
		return true
	}
	if hasUnsafeRedirectionOrSub(trimmed) {
		return false
	}
	subs := splitChainedSubcommands(trimmed)
	if len(subs) == 0 {
		return true
	}
	for _, sub := range subs {
		if !isSafeSingleCommand(sub) {
			return false
		}
	}
	return true
}

// evaluateNativeToolSecurity checks workspace boundary, file access policy, security preset, remembered rules, and agent approval_required flag for a native osctrl action
func (b *AgentBridge) evaluateNativeToolSecurity(actLower string, fieldsMap map[string]string, project, convID string, agentApprovalReq ...bool) (needsApproval bool, explicitlyDenied bool, cmdPrefix, description, warning string) {
	b.mu.Lock()
	defer b.mu.Unlock()

	eff := b.getEffectivePermissionsLocked(project)
	toolRuleKey := "osctrl:" + actLower
	flaggedByAgent := len(agentApprovalReq) > 0 && agentApprovalReq[0]

	// Check if there is an explicit rule for this tool or specific target
	pathKeys := []string{
		"path", "file", "filepath", "file_path", "target", "target_path",
		"source", "source_path", "src", "dest", "destination", "directory", "dir", "folder", "cwd", "working_directory",
	}
	var extractedPaths []string
	for _, pk := range pathKeys {
		for k, v := range fieldsMap {
			if strings.EqualFold(k, pk) && strings.TrimSpace(v) != "" {
				extractedPaths = append(extractedPaths, strings.TrimSpace(v))
			}
		}
	}

	primaryTarget := ""
	if len(extractedPaths) > 0 {
		primaryTarget = extractedPaths[0]
	}
	actionSignature := toolRuleKey
	if primaryTarget != "" {
		actionSignature = fmt.Sprintf("%s %s", toolRuleKey, primaryTarget)
	}

	if matched, allowed := b.checkRulesDecisionLocked(actionSignature, convID, project); matched {
		if !allowed {
			return false, true, toolRuleKey, "", "Blocked by saved approval rule."
		}
		return false, false, toolRuleKey, "", ""
	}

	// Classify native action
	writeActions := map[string]bool{
		"write_file": true, "create_file": true, "edit_file": true, "replace_in_file": true,
		"append_file": true, "delete_file": true, "remove_file": true, "move_file": true,
		"rename_file": true, "copy_file": true, "create_dir": true, "mkdir": true,
		"chmod": true, "chown": true, "patch_file": true,
	}
	destructiveActions := map[string]bool{
		"delete_file": true, "remove_file": true, "kill_process": true,
	}
	guiOrSystemActions := map[string]bool{
		"click": true, "double_click": true, "right_click": true, "move_mouse": true,
		"type_text": true, "key_press": true, "hotkey": true, "scroll": true,
		"open_app": true, "launch_app": true, "kill_process": true, "set_clipboard": true,
	}

	isWrite := writeActions[actLower]
	isDestructive := destructiveActions[actLower]
	isGUI := guiOrSystemActions[actLower]

	// 1. Check Workspace File Boundary for all path arguments
	var outsidePaths []string
	for _, rawP := range extractedPaths {
		resolved, inside := checkMultiWorkspacePathBoundary(rawP, b.getProjectFoldersLocked(project))
		if !inside {
			outsidePaths = append(outsidePaths, resolved)
		}
	}

	if len(outsidePaths) > 0 {
		outsideSample := outsidePaths[0]
		specificPrefix := fmt.Sprintf("%s %s", toolRuleKey, outsideSample)
		desc := fmt.Sprintf("Allow '%s' outside project workspace?", actLower)
		switch eff.FileAccessPolicy {
		case "strict":
			return true, false, specificPrefix, desc, fmt.Sprintf("Blocked by Workspace File Boundary (Restricted to Project Only): %s", outsideSample)
		case "read_only":
			if isWrite || isDestructive {
				return true, false, specificPrefix, desc, fmt.Sprintf("File modification outside workspace blocked by Read-Only policy: %s", outsideSample)
			}
			if eff.SandboxMode || eff.PermissionPolicy == "ask_all" {
				return true, false, specificPrefix, desc, fmt.Sprintf("Accessing file outside active project workspace: %s", outsideSample)
			}
		case "ask":
			return true, false, specificPrefix, desc, fmt.Sprintf("This action accesses a path outside the active project workspace: %s", outsideSample)
		case "allow_all":
			if eff.SandboxMode {
				return true, false, specificPrefix, desc, fmt.Sprintf("Sandbox Mode: accessing path outside workspace (%s)", outsideSample)
			}
		}
	}

	// 2. Check Read-Only File Access Policy inside workspace
	if eff.FileAccessPolicy == "read_only" && (isWrite || isDestructive) {
		return true, false, toolRuleKey, fmt.Sprintf("Allow modifying file via '%s'?", actLower), "Workspace File Boundary is set to Read-Only."
	}

	// 3. Check Security Preset & Sandbox Mode for inside-workspace actions
	if eff.PermissionPolicy == "ask_all" {
		if isWrite || isDestructive || isGUI {
			return true, false, toolRuleKey, fmt.Sprintf("Allow running OS tool '%s'?", actLower), "Security Preset is set to Ask Every Time."
		}
	} else if eff.PermissionPolicy == "safe_auto" || eff.SandboxMode {
		if isDestructive {
			return true, false, toolRuleKey, fmt.Sprintf("Allow destructive action '%s'?", actLower), "Destructive OS action requires confirmation."
		}
		if isGUI {
			return true, false, toolRuleKey, fmt.Sprintf("Allow OS control action '%s'?", actLower), "OS desktop/system control action requires confirmation."
		}
	}

	// 4. Honor explicit approval_required=true from the AI Agent decision
	if flaggedByAgent {
		return true, false, toolRuleKey, fmt.Sprintf("Allow agent action '%s'?", actLower), "Agent flagged this action as requiring approval (approval_required=true)."
	}

	return false, false, toolRuleKey, "", ""
}

// evaluateCommandSecurity checks workspace path boundary, file access policy, terminal execution policy, sandbox mode, allowed commands, and agent approval_required flag for a shell command
func (b *AgentBridge) evaluateCommandSecurity(cleanCmd, project, convID string, agentApprovalReq ...bool) (needsApproval bool, explicitlyDenied bool, cmdPrefix, description, warning string) {
	b.mu.Lock()
	defer b.mu.Unlock()

	eff := b.getEffectivePermissionsLocked(project)
	prefix := extractCommandPrefix(cleanCmd)
	desc := generateApprovalDescription(cleanCmd)
	flaggedByAgent := len(agentApprovalReq) > 0 && agentApprovalReq[0]

	// Check if explicitly denied by a saved rule
	if matched, allowed := b.checkRulesDecisionLocked(cleanCmd, convID, project); matched && !allowed {
		return false, true, prefix, desc, "Blocked by saved approval rule."
	}
	for _, sub := range splitChainedSubcommands(cleanCmd) {
		if matched, allowed := b.checkRulesDecisionLocked(sub, convID, project); matched && !allowed {
			return false, true, extractCommandPrefix(sub), generateApprovalDescription(sub), "Blocked by saved approval rule."
		}
	}

	isPreAllowed := b.isCommandAllowedLocked(cleanCmd, convID, project)
	isSafe := isSafeCommand(cleanCmd)

	// 1. Check Workspace File Boundary for paths referenced in the command
	outsidePaths := extractCommandOutsidePathsMulti(cleanCmd, b.getProjectFoldersLocked(project))
	if len(outsidePaths) > 0 {
		outsideSample := outsidePaths[0]
		// Only bypass outside-path prompt if the exact command string was already explicitly approved
		exactApproved := false
		if m, a := b.checkRulesDecisionLocked(cleanCmd, convID, project); m && a {
			exactApproved = true
		}
		if !exactApproved {
			switch eff.FileAccessPolicy {
			case "strict":
				return true, false, cleanCmd, fmt.Sprintf("Allow command accessing outside path (%s)?", filepath.Base(outsideSample)),
					fmt.Sprintf("Blocked by Workspace File Boundary (Restricted to Project Only): command references %s", outsideSample)
			case "read_only":
				if !isSafe {
					return true, false, cleanCmd, fmt.Sprintf("Allow command modifying outside path (%s)?", filepath.Base(outsideSample)),
						fmt.Sprintf("Read-Only policy: command may modify outside path %s", outsideSample)
				}
			case "ask":
				return true, false, cleanCmd, fmt.Sprintf("Allow command accessing outside path (%s)?", filepath.Base(outsideSample)),
					fmt.Sprintf("Command accesses a path outside the active project workspace: %s", outsideSample)
			}
			if eff.SandboxMode {
				return true, false, cleanCmd, fmt.Sprintf("Allow sandboxed command accessing %s?", filepath.Base(outsideSample)),
					fmt.Sprintf("Sandbox Mode: command accesses path outside workspace (%s)", outsideSample)
			}
		}
	}

	// 2. Check Read-Only File Access Policy for non-safe commands
	if eff.FileAccessPolicy == "read_only" && !isSafe && !isPreAllowed {
		return true, false, prefix, desc, "File access policy is Read-Only, and this command may modify files or system state."
	}

	// 3. Check Terminal Execution Policy, Security Preset, and Sandbox Mode
	if isPreAllowed {
		return false, false, prefix, desc, ""
	}

	if eff.PermissionPolicy == "ask_all" || eff.TerminalExecutionPolicy == "prompt" {
		return true, false, prefix, desc, "Terminal policy requires approval before running commands."
	}

	if eff.TerminalExecutionPolicy == "sandbox" || eff.SandboxMode {
		if !isSafe {
			return true, false, prefix, desc, "Sandbox Mode is active. Approve to allow this non-read-only command to execute."
		}
		if flaggedByAgent {
			return true, false, prefix, desc, "Agent flagged this command as requiring approval (approval_required=true)."
		}
		return false, false, prefix, desc, ""
	}

	if eff.PermissionPolicy == "safe_auto" || eff.TerminalExecutionPolicy == "safe_auto" {
		if !isSafe {
			return true, false, prefix, desc, "Safe Auto policy requires approval for non-read-only or chained commands."
		}
		if flaggedByAgent {
			return true, false, prefix, desc, "Agent flagged this command as requiring approval (approval_required=true)."
		}
		return false, false, prefix, desc, ""
	}

	// full_auto (still honors explicit approval_required=true from the agent unless pre-allowed by a saved rule)
	if flaggedByAgent {
		return true, false, prefix, desc, "Agent flagged this command as requiring approval (approval_required=true)."
	}
	return false, false, prefix, desc, ""
}

// requestInFlightApproval pauses execution, emits an ApprovalRequest to the frontend UI, and waits for user approval or denial
func (b *AgentBridge) requestInFlightApproval(ctx context.Context, execID, convID, project, action, cmdPrefix, description, warning string) (bool, error) {
	approved, _, err := b.requestInFlightApprovalWithFeedback(ctx, execID, convID, project, action, cmdPrefix, description, warning)
	return approved, err
}

// requestInFlightApprovalWithFeedback pauses execution for user approval or denial and also returns any optional user instruction/feedback
func (b *AgentBridge) requestInFlightApprovalWithFeedback(ctx context.Context, execID, convID, project, action, cmdPrefix, description, warning string) (bool, string, error) {
	normAction := strings.TrimSpace(action)
	if execID != "" && normAction != "" {
		b.mu.Lock()
		if b.execApprovalDecisions != nil {
			if execMap, ok := b.execApprovalDecisions[execID]; ok {
				if prev, exists := execMap[normAction]; exists {
					b.mu.Unlock()
					if prev.approved {
						log.Printf("[INFO][%s] Auto-approving repeat action %q within same execution (already approved in this run)", execID, action)
						return true, prev.feedback, nil
					}
					log.Printf("[INFO][%s] Auto-denying repeat action %q within same execution (already denied/skipped by user in this run)", execID, action)
					return false, prev.feedback, nil
				}
			}
		}
		b.mu.Unlock()
	}

	if cmdPrefix == "" {
		cmdPrefix = extractCommandPrefix(action)
	}
	if description == "" {
		description = generateApprovalDescription(action)
	}
	if warning == "" {
		warning = "This action requires your approval based on active project security settings."
	}

	cat := inferApprovalCategory(cmdPrefix)
	src := "terminal"
	if strings.HasPrefix(strings.ToLower(cmdPrefix), "osctrl:") {
		src = "osctrl"
	} else if cat == "mcp" {
		src = "mcp"
	}

	reqID := fmt.Sprintf("appr-%d", time.Now().UnixNano())
	req := ApprovalRequest{
		ID:             reqID,
		ExecID:         execID,
		ConversationID: convID,
		Action:         action,
		CommandPrefix:  cmdPrefix,
		Category:       cat,
		Source:         src,
		Description:    description,
		Warning:        warning,
		Timestamp:      time.Now().Format("15:04:05"),
		Project:        project,
		Kind:           "approval",
	}

	ch := make(chan bool, 1)
	b.mu.Lock()
	if b.approvalChs == nil {
		b.approvalChs = make(map[string]chan bool)
	}
	if b.approvalAnswers == nil {
		b.approvalAnswers = make(map[string]string)
	}
	b.pendingApprovals = append(b.pendingApprovals, req)
	b.approvalChs[reqID] = ch
	if b.pendingApproval == nil {
		first := b.pendingApprovals[0]
		b.pendingApproval = &first
		b.activeApprovalCh = b.approvalChs[first.ID]
	}
	b.mu.Unlock()

	defer func() {
		b.mu.Lock()
		delete(b.approvalChs, reqID)
		delete(b.approvalAnswers, reqID)
		filtered := make([]ApprovalRequest, 0, len(b.pendingApprovals))
		for _, item := range b.pendingApprovals {
			if item.ID != reqID {
				filtered = append(filtered, item)
			}
		}
		b.pendingApprovals = filtered
		if len(b.pendingApprovals) > 0 {
			first := b.pendingApprovals[0]
			b.pendingApproval = &first
			b.activeApprovalCh = b.approvalChs[first.ID]
		} else {
			b.pendingApproval = nil
			b.activeApprovalCh = nil
		}
		b.mu.Unlock()
		b.EmitApprovalQueueSync()
	}()

	log.Printf("[INFO][%s] Pausing for user approval (%s): action=%q warning=%q", execID, reqID, action, warning)
	b.StreamChunk(execID, fmt.Sprintf("Waiting for approval: `%s` — %s\n", action, warning), true)
	b.EmitApprovalRequest(req)

	userCancelCh := b.UserCancelChan(execID)
	select {
	case approved := <-ch:
		b.mu.Lock()
		feedback := strings.TrimSpace(b.approvalAnswers[reqID])
		delete(b.approvalAnswers, reqID)
		if execID != "" && normAction != "" {
			if b.execApprovalDecisions == nil {
				b.execApprovalDecisions = make(map[string]map[string]execApprovalDecision)
			}
			if b.execApprovalDecisions[execID] == nil {
				b.execApprovalDecisions[execID] = make(map[string]execApprovalDecision)
			}
			b.execApprovalDecisions[execID][normAction] = execApprovalDecision{
				approved: approved,
				feedback: feedback,
			}
		}
		b.mu.Unlock()
		// Recreate a fresh execution context after waiting for human approval so deadlines never expire during user pause
		b.RefreshExecutionContext(execID, 600*time.Second)
		if approved {
			log.Printf("[INFO][%s] Approval granted by user for %q (recreated execution context)", execID, action)
			b.StreamChunk(execID, fmt.Sprintf("Approved by user: `%s`\n", action), true)
			return true, feedback, nil
		}
		log.Printf("[INFO][%s] Approval denied by user for %q (feedback=%q)", execID, action, feedback)
		if feedback != "" {
			b.StreamChunk(execID, fmt.Sprintf("Denied by user: `%s` (Instruction: %s)\n", action, feedback), true)
		} else {
			b.StreamChunk(execID, fmt.Sprintf("Denied by user: `%s`\n", action), true)
		}
		return false, feedback, nil
	case <-userCancelCh:
		return false, "", context.Canceled
	}
}

// requestInFlightQuestion pauses execution when the agent asks a question, emits an ApprovalRequest with Kind="question" to the UI, and waits for the user's answer
func (b *AgentBridge) requestInFlightQuestion(ctx context.Context, execID, convID, project, reason string, questions, options []string) (string, bool, error) {
	cleanedQuestions := make([]string, 0, len(questions))
	for _, q := range questions {
		if trimmed := strings.TrimSpace(q); trimmed != "" {
			cleanedQuestions = append(cleanedQuestions, trimmed)
		}
	}
	if len(cleanedQuestions) == 0 && strings.TrimSpace(reason) != "" {
		cleanedQuestions = append(cleanedQuestions, strings.TrimSpace(reason))
	}
	if len(cleanedQuestions) == 0 {
		cleanedQuestions = append(cleanedQuestions, "How would you like to proceed?")
	}

	actionText := strings.Join(cleanedQuestions, "\n\n")
	desc := strings.TrimSpace(reason)
	if desc == "" || desc == actionText {
		if len(cleanedQuestions) > 1 {
			desc = fmt.Sprintf("Agent is asking %d questions", len(cleanedQuestions))
		} else {
			desc = "Question from Agent"
		}
	}

	cleanedOptions := normalizeAndGenerateQuestionOptions(cleanedQuestions, options)
	if desc == "Question from Agent" && len(cleanedQuestions) == 1 && strings.TrimSpace(reason) == "" {
		desc = "Answer Required"
	}

	reqID := fmt.Sprintf("question-%d", time.Now().UnixNano())
	req := ApprovalRequest{
		ID:             reqID,
		ExecID:         execID,
		ConversationID: convID,
		Action:         actionText,
		CommandPrefix:  "",
		Category:       "question",
		Source:         "agent",
		Description:    desc,
		Warning:        "Select an option below or type your answer to continue.",
		Timestamp:      time.Now().Format("15:04:05"),
		Project:        project,
		Kind:           "question",
		Questions:      cleanedQuestions,
		Options:        cleanedOptions,
	}

	ch := make(chan bool, 1)
	b.mu.Lock()
	if b.approvalChs == nil {
		b.approvalChs = make(map[string]chan bool)
	}
	if b.approvalAnswers == nil {
		b.approvalAnswers = make(map[string]string)
	}
	b.pendingApprovals = append(b.pendingApprovals, req)
	b.approvalChs[reqID] = ch
	if b.pendingApproval == nil {
		first := b.pendingApprovals[0]
		b.pendingApproval = &first
		b.activeApprovalCh = b.approvalChs[first.ID]
	}
	b.mu.Unlock()

	defer func() {
		b.mu.Lock()
		delete(b.approvalChs, reqID)
		delete(b.approvalAnswers, reqID)
		filtered := make([]ApprovalRequest, 0, len(b.pendingApprovals))
		for _, item := range b.pendingApprovals {
			if item.ID != reqID {
				filtered = append(filtered, item)
			}
		}
		b.pendingApprovals = filtered
		if len(b.pendingApprovals) > 0 {
			first := b.pendingApprovals[0]
			b.pendingApproval = &first
			b.activeApprovalCh = b.approvalChs[first.ID]
		} else {
			b.pendingApproval = nil
			b.activeApprovalCh = nil
		}
		b.mu.Unlock()
		b.EmitApprovalQueueSync()
	}()

	log.Printf("[INFO][%s] Pausing for user answer to agent question (%s): %q (options=%d)", execID, reqID, actionText, len(cleanedOptions))
	b.StreamChunk(execID, fmt.Sprintf("Waiting for your answer: %s\n", strings.ReplaceAll(actionText, "\n", " ")), true)
	b.EmitApprovalRequest(req)

	userCancelCh := b.UserCancelChan(execID)
	select {
	case answered := <-ch:
		b.mu.Lock()
		answerText := strings.TrimSpace(b.approvalAnswers[reqID])
		delete(b.approvalAnswers, reqID)
		b.mu.Unlock()
		// Recreate a fresh execution context after waiting for human answer so deadlines never expire during user pause
		b.RefreshExecutionContext(execID, 600*time.Second)
		if answered && answerText != "" {
			log.Printf("[INFO][%s] User answered agent question (%s): %q", execID, reqID, answerText)
			b.StreamChunk(execID, fmt.Sprintf("Answered: %s\n", answerText), true)
			return answerText, true, nil
		}
		log.Printf("[INFO][%s] User skipped agent question (%s)", execID, reqID)
		b.StreamChunk(execID, "Question skipped by user\n", true)
		if answerText == "" {
			answerText = "No, skip this (User skipped the question — do not ask any further questions)"
		}
		return answerText, false, nil
	case <-userCancelCh:
		return "", false, context.Canceled
	}
}

// getEffectiveAiUrlLocked infers the LLM endpoint based on custom URL, model selection, or environment
func (b *AgentBridge) getEffectiveAiUrlLocked() string {
	key := b.getEffectiveAiKeyLocked()
	isShuffleMode := b.activeExecutionMode == "shuffle" ||
		b.aiModel == "shuffle-ai" ||
		b.aiModel == "shuffle" ||
		strings.HasPrefix(key, "shfl_") ||
		(b.oauthLoggedIn && (b.aiModel == "gemini-3.8-flash" || b.aiModel == "gemini-3.8-pro" || b.aiApiKey == "" || strings.HasPrefix(b.aiApiKey, "shfl_")))

	cfgBaseURL := ""
	if b.cfg != nil {
		cfgBaseURL = b.cfg.BaseURL
	}

	if isShuffleMode {
		if b.aiApiUrl != "" && strings.Contains(strings.ToLower(b.aiApiUrl), "shuffler.io") {
			return resolveShuffleAiApiURL(b.aiApiUrl)
		}
		if envUrl := os.Getenv("SHUFFLE_BACKEND"); envUrl != "" {
			return resolveShuffleAiApiURL(envUrl)
		}
		if envUrl := os.Getenv("SHUFFLE_URL"); envUrl != "" {
			return resolveShuffleAiApiURL(envUrl)
		}
		return resolveShuffleAiApiURL(cfgBaseURL)
	}

	if b.aiApiUrl != "" {
		lowerUrl := strings.ToLower(b.aiApiUrl)
		if strings.EqualFold(b.aiApiUrl, "shuffle") || strings.Contains(lowerUrl, "shuffle.security") || strings.Contains(lowerUrl, "shuffler.io") {
			return resolveShuffleAiApiURL(b.aiApiUrl)
		}
		return b.aiApiUrl
	}
	if envUrl := os.Getenv("AI_API_URL"); envUrl != "" {
		lowerUrl := strings.ToLower(envUrl)
		if strings.EqualFold(envUrl, "shuffle") || strings.Contains(lowerUrl, "shuffle.security") || strings.Contains(lowerUrl, "shuffler.io") {
			return resolveShuffleAiApiURL(envUrl)
		}
		return envUrl
	}
	if envUrl := os.Getenv("SHUFFLE_BACKEND"); envUrl != "" {
		return resolveShuffleAiApiURL(envUrl)
	}
	if envUrl := os.Getenv("SHUFFLE_URL"); envUrl != "" {
		return resolveShuffleAiApiURL(envUrl)
	}

	if b.cfg != nil && b.cfg.BaseURL != "" && b.cfg.Auth != "" {
		return resolveShuffleAiApiURL(b.cfg.BaseURL)
	}

	model := strings.ToLower(b.aiModel)
	if model == "" {
		model = "gemini-3.8-flash"
	}

	// If API key is present or local Ollama is selected, infer the provider endpoint
	if key != "" && !strings.HasPrefix(key, "shfl_") {
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
	isShuffleMode := b.activeExecutionMode == "shuffle" ||
		b.aiModel == "shuffle-ai" ||
		b.aiModel == "shuffle" ||
		(b.oauthLoggedIn && (b.aiModel == "gemini-3.8-flash" || b.aiModel == "gemini-3.8-pro" || b.aiApiKey == "" || strings.HasPrefix(b.aiApiKey, "shfl_")))

	if isShuffleMode {
		if b.oauthLoggedIn && b.oauthToken != "" {
			return b.oauthToken
		}
		if b.cfg != nil && b.cfg.Auth != "" {
			return b.cfg.Auth
		}
		if k := os.Getenv("SHUFFLE_AUTHORIZATION"); k != "" {
			return k
		}
		if k := os.Getenv("SHUFFLE_SESSION_TOKEN"); k != "" {
			return k
		}
		if strings.HasPrefix(b.aiApiKey, "shfl_") {
			return b.aiApiKey
		}
	}
	if b.aiApiKey != "" && (!strings.HasPrefix(b.aiApiKey, "shfl_") || isShuffleMode) {
		return b.aiApiKey
	}
	if k := os.Getenv("AI_API_KEY"); k != "" && (!strings.HasPrefix(k, "shfl_") || isShuffleMode) {
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
	if b.aiApiKey != "" {
		return b.aiApiKey
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

// AttachmentInput represents an image or file attached to a user prompt
type AttachmentInput struct {
	Name     string `json:"name"`
	Path     string `json:"path,omitempty"`
	MimeType string `json:"mime_type,omitempty"`
	DataURL  string `json:"data_url,omitempty"`
	Content  string `json:"content,omitempty"`
	IsImage  bool   `json:"is_image"`
	Size     int64  `json:"size,omitempty"`
}

func inferImageMimeFromExt(ext string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(ext)) {
	case ".png":
		return "image/png", true
	case ".jpg", ".jpeg":
		return "image/jpeg", true
	case ".gif":
		return "image/gif", true
	case ".webp":
		return "image/webp", true
	case ".bmp":
		return "image/bmp", true
	case ".svg":
		return "image/svg+xml", true
	case ".ico":
		return "image/x-icon", true
	default:
		return "", false
	}
}

// extractAndResolveAttachments separates attached images and files from the user prompt text,
// returning:
// 1. cleanPrompt: user's prompt text without raw @filepath tokens
// 2. imageURIs: data:image/...;base64,... URIs to inject into startNode.Parameters as {Name: "image", Value: uri}
// 3. fileContextBlock: structured file contents injected into the agent system/context block rather than user prompt text
// 4. cleanMeta: metadata stored in turn.DebugInfo["attachments"] for UI rendering
func extractAndResolveAttachments(prompt string, explicit []AttachmentInput, project string) (cleanPrompt string, imageURIs []string, fileContextBlock string, cleanMeta []map[string]interface{}) {
	allAttachments := make([]AttachmentInput, 0, len(explicit)+2)
	seenKeys := make(map[string]bool)

	addUnique := func(att AttachmentInput) {
		key := strings.TrimSpace(att.Path)
		if key == "" {
			key = strings.TrimSpace(att.Name) + ":" + fmt.Sprintf("%d", len(att.DataURL)+len(att.Content))
		}
		if key != "" && seenKeys[key] {
			return
		}
		if key != "" {
			seenKeys[key] = true
		}
		allAttachments = append(allAttachments, att)
	}

	for _, att := range explicit {
		addUnique(att)
	}

	// Also detect and strip any raw @filepath tokens in prompt that point to real files on disk
	cleanPrompt = prompt
	if strings.Contains(prompt, "@") {
		reAt := regexp.MustCompile(`(?:^|\s)@([^\s]+)`)
		matches := reAt.FindAllStringSubmatch(prompt, -1)
		for _, m := range matches {
			if len(m) < 2 {
				continue
			}
			candidate := strings.TrimSpace(m[1])
			if candidate == "" {
				continue
			}
			resolved := candidate
			if !filepath.IsAbs(resolved) {
				if project != "" && project != "__NONE__" {
					resolved = filepath.Join(project, resolved)
				} else if cwd, err := os.Getwd(); err == nil {
					resolved = filepath.Join(cwd, resolved)
				}
			}
			resolved = filepath.Clean(resolved)
			if info, err := os.Stat(resolved); err == nil && !info.IsDir() {
				addUnique(AttachmentInput{
					Name: filepath.Base(resolved),
					Path: resolved,
					Size: info.Size(),
				})
				cleanPrompt = strings.Replace(cleanPrompt, "@"+candidate, "", 1)
			}
		}
		cleanPrompt = strings.TrimSpace(cleanPrompt)
	}

	var fileBuilder strings.Builder

	for _, att := range allAttachments {
		name := strings.TrimSpace(att.Name)
		pathStr := strings.TrimSpace(att.Path)
		if name == "" && pathStr != "" {
			name = filepath.Base(pathStr)
		}
		if name == "" {
			name = "attachment"
		}

		targetPath := pathStr
		if targetPath != "" && !filepath.IsAbs(targetPath) {
			if project != "" && project != "__NONE__" {
				targetPath = filepath.Join(project, targetPath)
			} else if cwd, err := os.Getwd(); err == nil {
				targetPath = filepath.Join(cwd, targetPath)
			}
			targetPath = filepath.Clean(targetPath)
		}

		ext := strings.ToLower(filepath.Ext(name))
		if ext == "" && targetPath != "" {
			ext = strings.ToLower(filepath.Ext(targetPath))
		}
		extMime, isExtImg := inferImageMimeFromExt(ext)
		mime := strings.TrimSpace(att.MimeType)
		if mime == "" && isExtImg {
			mime = extMime
		}

		isImg := att.IsImage || isExtImg || strings.HasPrefix(strings.ToLower(mime), "image/") || strings.HasPrefix(strings.ToLower(att.DataURL), "data:image/")

		if isImg {
			dataURI := strings.TrimSpace(att.DataURL)
			size := att.Size
			if dataURI == "" && targetPath != "" {
				if rawBytes, err := os.ReadFile(targetPath); err == nil {
					size = int64(len(rawBytes))
					if mime == "" {
						mime = "image/png"
					}
					dataURI = fmt.Sprintf("data:%s;base64,%s", mime, base64.StdEncoding.EncodeToString(rawBytes))
				}
			} else if dataURI != "" && !strings.HasPrefix(strings.ToLower(dataURI), "data:image") && !strings.HasPrefix(strings.ToLower(dataURI), "http") {
				if mime == "" {
					mime = "image/png"
				}
				dataURI = fmt.Sprintf("data:%s;base64,%s", mime, dataURI)
			}

			if dataURI != "" {
				imageURIs = append(imageURIs, dataURI)
				cleanMeta = append(cleanMeta, map[string]interface{}{
					"name":      name,
					"path":      pathStr,
					"mime_type": mime,
					"is_image":  true,
					"size":      size,
					"data_url":  dataURI,
				})
			}
			continue
		}

		// Non-image file attachment
		contentStr := att.Content
		size := att.Size
		if contentStr == "" && targetPath != "" {
			if rawBytes, err := os.ReadFile(targetPath); err == nil {
				size = int64(len(rawBytes))
				if len(rawBytes) > 256*1024 {
					rawBytes = rawBytes[:256*1024]
					contentStr = string(rawBytes) + "\n... [file content truncated at 256KB]"
				} else {
					contentStr = string(rawBytes)
				}
			}
		} else if contentStr == "" && strings.Contains(att.DataURL, "base64,") {
			parts := strings.SplitN(att.DataURL, "base64,", 2)
			if len(parts) == 2 {
				if decoded, err := base64.StdEncoding.DecodeString(parts[1]); err == nil {
					size = int64(len(decoded))
					if len(decoded) > 256*1024 {
						decoded = decoded[:256*1024]
					}
					contentStr = string(decoded)
				}
			}
		}

		if contentStr != "" || pathStr != "" {
			lang := strings.TrimPrefix(ext, ".")
			displayLoc := name
			if pathStr != "" && pathStr != name {
				displayLoc = fmt.Sprintf("%s (%s)", name, pathStr)
			}
			fileBuilder.WriteString(fmt.Sprintf("--- Attached File: %s ---\n", displayLoc))
			if contentStr != "" {
				fileBuilder.WriteString(fmt.Sprintf("```%s\n%s\n```\n\n", lang, contentStr))
			} else {
				fileBuilder.WriteString(fmt.Sprintf("(File path: %s)\n\n", targetPath))
			}
			cleanMeta = append(cleanMeta, map[string]interface{}{
				"name":      name,
				"path":      pathStr,
				"mime_type": mime,
				"is_image":  false,
				"size":      size,
			})
		}
	}

	return cleanPrompt, imageURIs, strings.TrimSpace(fileBuilder.String()), cleanMeta
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
	return b.RunPromptWithAttachments(prompt, forceApprove, cID, reqModel, reqReasoning, nil, reqUrlAndKey...)
}

// RunPromptWithAttachments executes an agent action with custom model, reasoning, and native multimodal/file attachments
func (b *AgentBridge) RunPromptWithAttachments(prompt string, forceApprove bool, cID, reqModel, reqReasoning string, attachments []AttachmentInput, reqUrlAndKey ...string) string {
	start := time.Now()
	execID := fmt.Sprintf("exec-%d", time.Now().UnixNano())
	cID = strings.TrimSpace(cID)
	if cID == "" {
		cID = fmt.Sprintf("conv-%d", time.Now().UnixMilli())
	}

	b.mu.Lock()
	effectiveKey := b.getEffectiveAiKeyLocked()
	isShufflePrompt := reqModel == "shuffle-ai" ||
		reqModel == "shuffle" ||
		b.activeExecutionMode == "shuffle" ||
		strings.HasPrefix(effectiveKey, "shfl_") ||
		(b.oauthLoggedIn && (reqModel == "gemini-3.8-flash" || reqModel == "gemini-3.8-pro" || b.aiApiKey == "" || strings.HasPrefix(b.aiApiKey, "shfl_")))
	effectiveUrl := b.getEffectiveAiUrlLocked()
	if len(reqUrlAndKey) > 0 && reqUrlAndKey[0] != "" {
		reqUrl := strings.TrimSpace(reqUrlAndKey[0])
		if !isShufflePrompt || strings.Contains(strings.ToLower(reqUrl), "shuffler.io") {
			effectiveUrl = reqUrl
		}
	}
	if len(reqUrlAndKey) > 1 && reqUrlAndKey[1] != "" {
		reqKey := strings.TrimSpace(reqUrlAndKey[1])
		if !isShufflePrompt || strings.HasPrefix(reqKey, "shfl_") || effectiveKey == "" {
			effectiveKey = reqKey
		}
		if strings.HasPrefix(effectiveKey, "shfl_") {
			isShufflePrompt = true
		}
	}
	if isShufflePrompt {
		cfgBase := ""
		if b.cfg != nil {
			cfgBase = b.cfg.BaseURL
		}
		if cfgBase != "" {
			effectiveUrl = resolveShuffleAiApiURL(cfgBase)
		} else if strings.Contains(strings.ToLower(effectiveUrl), "shuffler.io") {
			effectiveUrl = resolveShuffleAiApiURL(effectiveUrl)
		} else {
			effectiveUrl = resolveShuffleAiApiURL(cfgBase)
		}
	}
	hasAiEndpoint := effectiveUrl != "" && (effectiveKey != "" || strings.Contains(effectiveUrl, "localhost") || strings.Contains(effectiveUrl, "127.0.0.1"))
	uiModel := strings.TrimSpace(reqModel)
	if uiModel == "" {
		uiModel = strings.TrimSpace(b.aiModel)
	}
	if isShufflePrompt && (uiModel == "" || uiModel == "shuffle" || uiModel == "shuffle-ai" || (uiModel == "gemini-3.8-flash" && b.activeExecutionMode == "shuffle")) {
		uiModel = "shuffle-ai"
	} else if uiModel == "shuffle" {
		uiModel = "shuffle-ai"
	}
	activeModel := uiModel
	if activeModel == "" || activeModel == "shuffle" {
		activeModel = "shuffle-ai"
	}
	if uiModel == "" {
		uiModel = activeModel
	}
	if uiModel != "" && uiModel != "local_shell" {
		b.aiModel = uiModel
		if uiModel == "shuffle-ai" || isShufflePrompt {
			b.activeExecutionMode = "shuffle"
		} else if strings.HasPrefix(uiModel, "tendon") || strings.HasPrefix(uiModel, "local") {
			b.activeExecutionMode = "local"
		} else {
			b.activeExecutionMode = "direct"
		}
		b.saveLocalStoreLocked()
	}
	activeReasoning := strings.ToLower(strings.TrimSpace(reqReasoning))
	if activeReasoning == "" {
		activeReasoning = "low"
	} else if activeReasoning == "minimal" || activeReasoning == "none" {
		activeReasoning = "off"
	}
	activeUrl := effectiveUrl
	project := b.activeProject
	b.mu.Unlock()

	cleanPrompt, imageURIs, fileContextBlock, attachmentMeta := extractAndResolveAttachments(prompt, attachments, project)
	prompt = cleanPrompt

	maskedKey := "none"
	if len(effectiveKey) > 8 {
		maskedKey = effectiveKey[:4] + "..." + effectiveKey[len(effectiveKey)-4:]
	} else if effectiveKey != "" {
		maskedKey = "***"
	}

	log.Printf("[INFO][%s] AgentBridge RunPrompt: prompt=%q, attachments=%d (images=%d), convID=%q, model=%q, reasoning=%q, project=%q, url=%q, key=%s, hasAiEndpoint=%v",
		execID, prompt, len(attachmentMeta), len(imageURIs), cID, activeModel, activeReasoning, project, activeUrl, maskedKey, hasAiEndpoint)

	var output string
	var err error
	var debugInfo map[string]interface{}
	var workflowExec *shuffle.WorkflowExecution

	// Snapshot workspace before prompt execution to diff before and after
	treeSnapshot := b.captureWorkingTreeSnapshot(project)

	trimmedDirect := strings.TrimSpace(prompt)
	if strings.HasPrefix(trimmedDirect, "$ ") || strings.HasPrefix(trimmedDirect, "> ") {
		ctx, cancel := context.WithCancel(context.Background())
		b.RegisterCancel(execID, cancel)
		defer func() {
			cancel()
			b.UnregisterCancel(execID)
		}()
		rawCmd := strings.TrimSpace(trimmedDirect[2:])
		if forceApprove {
			streamedStep := false
			output, err = osctrl.RunCommandInDir(rawCmd, project, 60*time.Second, func(chunk string) {
				if !streamedStep {
					streamedStep = true
					b.StreamChunk(execID, fmt.Sprintf("Running `$ %s` in `%s`...\n", rawCmd, project), true)
				}
				b.StreamChunk(execID, chunk, false)
			})
		} else {
			output, err = b.executeAgentToolCommand(ctx, rawCmd, project, execID, cID)
		}
		debugInfo = map[string]interface{}{
			"mode":    "direct_shell_command",
			"command": rawCmd,
			"project": project,
		}
	} else {
		log.Printf("[INFO][%s] RunPrompt routing decision: executing full AI Agent loop via shuffle.HandleAiAgentExecutionStart (model=%s, reasoning=%s, url=%s, convID=%s, images=%d)", execID, activeModel, activeReasoning, activeUrl, cID, len(imageURIs))
		output, workflowExec, err = b.executeAiRequestWithAttachments(prompt, execID, imageURIs, fileContextBlock, activeModel, activeReasoning, activeUrl, effectiveKey, cID)
		debugInfo = map[string]interface{}{
			"mode":           "shuffle_agent_loop",
			"target":         activeUrl,
			"model":          uiModel,
			"ui_model":       uiModel,
			"resolved_model": activeModel,
			"is_shuffle":     isShufflePrompt,
			"reasoning":      activeReasoning,
			"project":        project,
			"has_url":        activeUrl != "",
			"has_key":        effectiveKey != "",
			"is_auth":        b.oauthLoggedIn,
			"engine":         "shuffle.HandleAiAgentExecutionStart",
		}
	}
	if len(attachmentMeta) > 0 {
		debugInfo["attachments"] = attachmentMeta
	}

	status := "success"
	errStr := ""
	errorType := ""
	fixHelp := ""
	if err != nil {
		isUserCancel := errors.Is(err, context.Canceled) ||
			strings.Contains(strings.ToLower(err.Error()), "context canceled") ||
			strings.Contains(strings.ToLower(err.Error()), "user_cancelled") ||
			strings.Contains(strings.ToLower(err.Error()), "stopped by user")

		if isUserCancel {
			status = "interrupted"
			errStr = "Generation stopped by user"
			errorType = "user_cancelled"
			fixHelp = "Generation was stopped by the user."
		} else {
			status = "error"
			errStr = err.Error()

			errLower := strings.ToLower(errStr)
			if strings.Contains(errLower, "no llm apikey") || strings.Contains(errLower, "apikey") || strings.Contains(errLower, "unauthorized") || strings.Contains(errLower, "custom ai app authentication") || strings.Contains(errLower, "no organization-specific key") {
				errorType = "missing_credentials"
				if b.oauthLoggedIn || strings.HasPrefix(b.getEffectiveAiKeyLocked(), "shfl_") {
					fixHelp = "Shuffle AI authentication expired or rejected. Click 'Re-authenticate Shuffle AI' or 'Disconnect & Reset' in Settings."
				} else {
					fixHelp = "No AI model credentials found. Configure your API key (Gemini, OpenAI, Anthropic) in Settings > AI & Models."
				}
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
	}

	duration := time.Since(start).Round(time.Millisecond).String()

	rawAgentOutput := output
	cleanOutput, extractedDecisions, extractedSteps := parseModelResponseStepsAndDecisionsWithExec(output, duration, activeModel, workflowExec)
	output = cleanOutput
	generatedImages := extractGeneratedImagesFromDecisions(extractedDecisions)
	if debugInfo != nil {
		if rawAgentOutput != "" {
			debugInfo["raw_agent_output"] = rawAgentOutput
		}
		if len(extractedDecisions) > 0 {
			debugInfo["decisions"] = extractedDecisions
		}
		if len(generatedImages) > 0 {
			debugInfo["generated_images"] = generatedImages
		}
		if workflowExec != nil && len(workflowExec.Results) > 0 {
			for _, ar := range workflowExec.Results {
				if strings.TrimSpace(ar.Result) != "" {
					var parsedAgentJson map[string]interface{}
					if errJson := json.Unmarshal([]byte(ar.Result), &parsedAgentJson); errJson == nil {
						debugInfo["raw_agent_json"] = parsedAgentJson
						break
					}
				}
			}
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

	changedFiles := b.diffWorkingTreeSnapshot(project, treeSnapshot)

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
	cleanedApprovals := false
	if len(b.pendingApprovals) > 0 {
		filtered := make([]ApprovalRequest, 0, len(b.pendingApprovals))
		for _, item := range b.pendingApprovals {
			if item.ExecID == execID {
				delete(b.approvalChs, item.ID)
				cleanedApprovals = true
				continue
			}
			filtered = append(filtered, item)
		}
		b.pendingApprovals = filtered
	}
	if len(b.pendingApprovals) > 0 {
		first := b.pendingApprovals[0]
		b.pendingApproval = &first
		b.activeApprovalCh = b.approvalChs[first.ID]
	} else {
		b.pendingApproval = nil
		b.activeApprovalCh = nil
	}
	b.mu.Unlock()
	if cleanedApprovals {
		b.EmitApprovalQueueSync()
	}

	resp, _ := json.Marshal(entry)
	return string(resp)
}

// GetApprovalQueue returns the current global approval queue and active rules as JSON
func (b *AgentBridge) GetApprovalQueue() string {
	b.mu.Lock()
	defer b.mu.Unlock()

	queueSnapshot := make([]ApprovalRequest, len(b.pendingApprovals))
	copy(queueSnapshot, b.pendingApprovals)
	rulesSnapshot := make([]ApprovalRule, len(b.approvalRules))
	copy(rulesSnapshot, b.approvalRules)

	var firstPtr *ApprovalRequest
	if len(queueSnapshot) > 0 {
		first := queueSnapshot[0]
		firstPtr = &first
	}

	resp, _ := json.Marshal(map[string]interface{}{
		"status":           "ok",
		"approval_queue":   queueSnapshot,
		"pending_approval": firstPtr,
		"approval_rules":   rulesSnapshot,
	})
	return string(resp)
}

// RespondAllApprovals approves or denies all currently pending items in the global approval queue
func (b *AgentBridge) RespondAllApprovals(approved bool) string {
	b.mu.Lock()
	channelsToSignal := make([]chan bool, 0, len(b.pendingApprovals))
	resolvedIDs := make([]string, 0, len(b.pendingApprovals))

	for _, item := range b.pendingApprovals {
		resolvedIDs = append(resolvedIDs, item.ID)
		if ch, ok := b.approvalChs[item.ID]; ok && ch != nil {
			channelsToSignal = append(channelsToSignal, ch)
		}
		delete(b.approvalChs, item.ID)
	}
	if len(channelsToSignal) == 0 && b.activeApprovalCh != nil {
		channelsToSignal = append(channelsToSignal, b.activeApprovalCh)
	}

	b.pendingApprovals = nil
	b.pendingApproval = nil
	b.activeApprovalCh = nil

	rulesSnapshot := make([]ApprovalRule, len(b.approvalRules))
	copy(rulesSnapshot, b.approvalRules)
	b.mu.Unlock()

	for _, ch := range channelsToSignal {
		select {
		case ch <- approved:
		default:
		}
	}

	statusStr := "approved_all"
	if !approved {
		statusStr = "denied_all"
	}
	resp, _ := json.Marshal(map[string]interface{}{
		"status":           statusStr,
		"resolved_ids":     resolvedIDs,
		"approval_queue":   []ApprovalRequest{},
		"pending_approval": nil,
		"approval_rules":   rulesSnapshot,
	})
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
	return b.RespondApprovalWithAnswer(execID, option, commandPrefix, scope, scopeID, "")
}

// RespondApprovalWithAnswer handles user decision or question answer from the UI
func (b *AgentBridge) RespondApprovalWithAnswer(execID string, option int, commandPrefix, scope, scopeID, answer string) string {
	b.mu.Lock()
	var req *ApprovalRequest
	var inFlightCh chan bool
	matchIdx := -1

	for i := range b.pendingApprovals {
		item := b.pendingApprovals[i]
		if execID == "" || item.ID == execID || item.ExecID == execID {
			matched := item
			req = &matched
			matchIdx = i
			inFlightCh = b.approvalChs[item.ID]
			break
		}
	}
	if req == nil && b.pendingApproval != nil && (execID == "" || b.pendingApproval.ID == execID || b.pendingApproval.ExecID == execID) {
		req = b.pendingApproval
		inFlightCh = b.activeApprovalCh
	}
	if req == nil {
		b.mu.Unlock()
		return `{"status": "not_found"}`
	}

	prompt := req.Action
	reqProject := req.Project
	if reqProject == "" {
		reqProject = b.activeProject
	}
	reqConvID := scopeID
	if reqConvID == "" {
		reqConvID = req.ConversationID
	}

	isQuestion := strings.EqualFold(req.Kind, "question") || strings.EqualFold(req.Category, "question")
	resolvedAnswer := strings.TrimSpace(answer)
	if isQuestion && resolvedAnswer == "" && option >= 1 && option != 5 && option <= len(req.Options) {
		resolvedAnswer = strings.TrimSpace(req.Options[option-1])
	}
	if b.approvalAnswers == nil {
		b.approvalAnswers = make(map[string]string)
	}
	if resolvedAnswer != "" {
		b.approvalAnswers[req.ID] = resolvedAnswer
	}

	// Remove resolved item from queue
	if matchIdx >= 0 && matchIdx < len(b.pendingApprovals) {
		delete(b.approvalChs, req.ID)
		b.pendingApprovals = append(b.pendingApprovals[:matchIdx], b.pendingApprovals[matchIdx+1:]...)
	}

	cmdToRemember := strings.TrimSpace(commandPrefix)
	if cmdToRemember == "" {
		cmdToRemember = strings.TrimSpace(req.CommandPrefix)
	}
	if cmdToRemember == "" && !isQuestion {
		cmdToRemember = extractCommandPrefix(prompt)
	}
	cat := inferApprovalCategory(cmdToRemember)

	ruleAdded := false
	if !isQuestion {
		if option == 2 && cmdToRemember != "" {
			rule := ApprovalRule{
				ID:        fmt.Sprintf("rule-%d", time.Now().UnixNano()),
				Command:   cmdToRemember,
				Category:  cat,
				Action:    "allow",
				Scope:     "conversation",
				ScopeID:   reqConvID,
				CreatedAt: time.Now().Format("2006-01-02 15:04"),
			}
			b.approvalRules = append(b.approvalRules, rule)
			b.saveLocalStoreLocked()
			ruleAdded = true
		} else if option == 3 && cmdToRemember != "" {
			cleanProj := filepath.Clean(strings.TrimSpace(reqProject))
			rule := ApprovalRule{
				ID:        fmt.Sprintf("rule-%d", time.Now().UnixNano()),
				Command:   cmdToRemember,
				Category:  cat,
				Action:    "allow",
				Scope:     "project",
				ScopeID:   cleanProj,
				CreatedAt: time.Now().Format("2006-01-02 15:04"),
			}
			b.approvalRules = append(b.approvalRules, rule)
			b.saveLocalStoreLocked()
			ruleAdded = true
		} else if option == 4 && cmdToRemember != "" {
			rule := ApprovalRule{
				ID:        fmt.Sprintf("rule-%d", time.Now().UnixNano()),
				Command:   cmdToRemember,
				Category:  cat,
				Action:    "allow",
				Scope:     "global",
				ScopeID:   "",
				CreatedAt: time.Now().Format("2006-01-02 15:04"),
			}
			b.approvalRules = append(b.approvalRules, rule)
			b.saveLocalStoreLocked()
			ruleAdded = true
		}
	}

	// If a new allow rule was added, or if duplicate requests for the exact same action exist in the queue, resolve them too
	var extraApprovedChs []chan bool
	var extraDeniedChs []chan bool
	var autoResolvedIDs []string
	if len(b.pendingApprovals) > 0 {
		remaining := make([]ApprovalRequest, 0, len(b.pendingApprovals))
		resolvedAct := strings.TrimSpace(req.Action)
		for _, item := range b.pendingApprovals {
			if resolvedAct != "" && strings.TrimSpace(item.Action) == resolvedAct && (item.ExecID == req.ExecID || (item.ConversationID != "" && item.ConversationID == req.ConversationID)) {
				if resolvedAnswer != "" && b.approvalAnswers != nil {
					b.approvalAnswers[item.ID] = resolvedAnswer
				}
				if ch, ok := b.approvalChs[item.ID]; ok && ch != nil {
					if option == 5 && (!isQuestion || resolvedAnswer == "") {
						extraDeniedChs = append(extraDeniedChs, ch)
					} else {
						extraApprovedChs = append(extraApprovedChs, ch)
					}
				}
				delete(b.approvalChs, item.ID)
				autoResolvedIDs = append(autoResolvedIDs, item.ID)
				continue
			}
			if !ruleAdded || strings.EqualFold(item.Kind, "question") || strings.EqualFold(item.Category, "question") {
				remaining = append(remaining, item)
				continue
			}
			checkTarget := item.CommandPrefix
			if checkTarget == "" {
				checkTarget = item.Action
			}
			if b.isCommandAllowedLocked(checkTarget, item.ConversationID, item.Project) {
				if ch, ok := b.approvalChs[item.ID]; ok && ch != nil {
					extraApprovedChs = append(extraApprovedChs, ch)
				}
				delete(b.approvalChs, item.ID)
				autoResolvedIDs = append(autoResolvedIDs, item.ID)
			} else {
				remaining = append(remaining, item)
			}
		}
		b.pendingApprovals = remaining
	}

	// Sync legacy pointer to head of remaining queue
	if len(b.pendingApprovals) > 0 {
		first := b.pendingApprovals[0]
		b.pendingApproval = &first
		b.activeApprovalCh = b.approvalChs[first.ID]
	} else {
		b.pendingApproval = nil
		b.activeApprovalCh = nil
	}

	queueSnapshot := make([]ApprovalRequest, len(b.pendingApprovals))
	copy(queueSnapshot, b.pendingApprovals)
	var nextPending *ApprovalRequest
	if len(queueSnapshot) > 0 {
		first := queueSnapshot[0]
		nextPending = &first
	}

	// If this is an in-flight tool, command approval, or question during an active turn, signal the waiting goroutine directly
	if inFlightCh != nil {
		approved := option != 5
		if isQuestion {
			approved = resolvedAnswer != "" || (option >= 1 && option != 5)
		}
		rulesSnapshot := make([]ApprovalRule, len(b.approvalRules))
		copy(rulesSnapshot, b.approvalRules)
		b.mu.Unlock()

		select {
		case inFlightCh <- approved:
		default:
		}
		for _, ch := range extraApprovedChs {
			select {
			case ch <- true:
			default:
			}
		}
		for _, ch := range extraDeniedChs {
			select {
			case ch <- false:
			default:
			}
		}

		statusStr := "approved"
		if isQuestion {
			if approved {
				statusStr = "answered"
			} else {
				statusStr = "skipped"
			}
		} else if !approved {
			statusStr = "denied"
		}
		resp, _ := json.Marshal(map[string]interface{}{
			"status":            statusStr,
			"in_flight":         true,
			"id":                req.ID,
			"exec_id":           req.ExecID,
			"kind":              req.Kind,
			"answer":            resolvedAnswer,
			"auto_resolved_ids": autoResolvedIDs,
			"approval_queue":    queueSnapshot,
			"pending_approval":  nextPending,
			"approval_rules":    rulesSnapshot,
		})
		return string(resp)
	}

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
	b.mu.Unlock()

	// Legacy top-level approval fallback: run with forceApprove=true
	return b.RunPrompt(prompt, true, reqConvID)
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
	if rule.Action == "" {
		rule.Action = "allow"
	}
	if rule.Category == "" {
		rule.Category = inferApprovalCategory(rule.Command)
	}
	if rule.CreatedAt == "" {
		rule.CreatedAt = time.Now().Format("2006-01-02 15:04")
	}
	updated := false
	for i := range b.approvalRules {
		if b.approvalRules[i].ID == rule.ID {
			b.approvalRules[i] = rule
			updated = true
			break
		}
	}
	if !updated {
		b.approvalRules = append(b.approvalRules, rule)
	}
	b.saveLocalStoreLocked()
	data, _ := json.Marshal(b.approvalRules)
	return string(data)
}

// UpdateApprovalRule updates an existing approval rule in-place (or adds it if not found)
func (b *AgentBridge) UpdateApprovalRule(ruleJSON string) string {
	return b.AddApprovalRule(ruleJSON)
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
		return fmt.Sprintf(`{"error": %q}`, err.Error())
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
	elements, err := osctrl.FetchFocusedElement(1, 4)
	if err != nil {
		return fmt.Sprintf(`{"error": %q}`, err.Error())
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
	cleanCmd = strings.TrimSpace(cleanCmd)
	if cleanCmd == "" {
		return "", nil
	}

	b.mu.Lock()
	proj := b.activeProject
	b.mu.Unlock()

	return osctrl.RunCommandInDir(cleanCmd, proj, 30*time.Second, nil)
}

type streamChunkPayload struct {
	Choices []struct {
		Delta struct {
			Content          string `json:"content"`
			ReasoningContent string `json:"reasoning_content"`
			Reasoning        string `json:"reasoning"`
		} `json:"delta"`
	} `json:"choices"`
}

type streamBridgeWriter struct {
	header         http.Header
	onChunk        func(chunk string)
	inReasoning    bool
	execID         string
	model          string
	url            string
	startTime      time.Time
	firstChunkTime time.Time
	lastLogTime    time.Time
	chunkCount     int
	contentChars   int
	reasoningChars int
	statusCode     int
	recentSnippet  string
}

func (w *streamBridgeWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}

func (w *streamBridgeWriter) WriteHeader(statusCode int) {
	w.statusCode = statusCode
	if statusCode >= 400 {
		log.Printf("[ERROR][%s] LLM stream upstream HTTP status %d from %s (model=%s)", w.execID, statusCode, w.url, w.model)
	} else {
		log.Printf("[INFO][%s] LLM stream upstream HTTP status %d from %s (model=%s)", w.execID, statusCode, w.url, w.model)
	}
}

func (w *streamBridgeWriter) Flush() {}

func (w *streamBridgeWriter) Write(p []byte) (int, error) {
	now := time.Now()
	if w.startTime.IsZero() {
		w.startTime = now
	}

	trimmed := bytes.TrimSpace(p)
	if bytes.HasPrefix(trimmed, []byte("data: ")) {
		trimmed = bytes.TrimPrefix(trimmed, []byte("data: "))
		trimmed = bytes.TrimSpace(trimmed)
	}
	if len(trimmed) == 0 {
		return len(p), nil
	}
	if string(trimmed) == "[DONE]" {
		if w.inReasoning && w.onChunk != nil {
			log.Printf("[INFO][%s] LLM stream closing reasoning block on [DONE] (%d reasoning chars)", w.execID, w.reasoningChars)
			w.onChunk("</thought>\n\n")
			w.inReasoning = false
		}
		log.Printf("[INFO][%s] LLM SSE stream [DONE] received in %v (chunks=%d, content_chars=%d, reasoning_chars=%d)",
			w.execID, now.Sub(w.startTime).Round(time.Millisecond), w.chunkCount, w.contentChars, w.reasoningChars)
		return len(p), nil
	}
	var payload streamChunkPayload
	if err := json.Unmarshal(trimmed, &payload); err == nil && len(payload.Choices) > 0 {
		content := payload.Choices[0].Delta.Content
		reasoning := payload.Choices[0].Delta.ReasoningContent
		if reasoning == "" {
			reasoning = payload.Choices[0].Delta.Reasoning
		}

		if content != "" || reasoning != "" {
			w.chunkCount++
			if w.firstChunkTime.IsZero() {
				w.firstChunkTime = now
				w.lastLogTime = now
				log.Printf("[INFO][%s] LLM stream first token received in %v (TTFT) from %s (model=%s)",
					w.execID, now.Sub(w.startTime).Round(time.Millisecond), w.url, w.model)
			}
		}

		if reasoning != "" {
			if !w.inReasoning && strings.TrimSpace(reasoning) == "" {
				// Wait for actual non-whitespace reasoning text before opening <thought>
			} else {
				w.reasoningChars += len(reasoning)
				w.recentSnippet += reasoning
				if len(w.recentSnippet) > 120 {
					w.recentSnippet = w.recentSnippet[len(w.recentSnippet)-120:]
				}
				var out string
				if !w.inReasoning {
					w.inReasoning = true
					log.Printf("[INFO][%s] LLM stream entered <thought> reasoning phase (model=%s)", w.execID, w.model)
					out = "<thought>" + reasoning
				} else {
					out = reasoning
				}
				if w.onChunk != nil {
					w.onChunk(out)
				}
			}
		} else if content != "" {
			w.contentChars += len(content)
			w.recentSnippet += content
			if len(w.recentSnippet) > 120 {
				w.recentSnippet = w.recentSnippet[len(w.recentSnippet)-120:]
			}
			var out string
			if w.inReasoning {
				w.inReasoning = false
				log.Printf("[INFO][%s] LLM stream finished <thought> reasoning phase (%d reasoning chars), transitioning to content output", w.execID, w.reasoningChars)
				out = "</thought>\n\n" + content
			} else {
				out = content
			}
			if w.onChunk != nil {
				w.onChunk(out)
			}
		}

		if (content != "" || reasoning != "") && now.Sub(w.lastLogTime) >= time.Second {
			w.lastLogTime = now
			elapsed := now.Sub(w.startTime).Round(time.Millisecond)
			snippetClean := strings.ReplaceAll(strings.ReplaceAll(w.recentSnippet, "\n", " "), "\r", "")
			if len(snippetClean) > 80 {
				snippetClean = "..." + snippetClean[len(snippetClean)-80:]
			}
			log.Printf("[INFO][%s] LLM streaming (%s): %d chunks, %d content chars, %d reasoning chars (%v elapsed) | snippet: %q",
				w.execID, w.model, w.chunkCount, w.contentChars, w.reasoningChars, elapsed, snippetClean)
		}
	} else {
		rawPreview := string(trimmed)
		if len(rawPreview) > 300 {
			rawPreview = rawPreview[:300] + "..."
		}
		log.Printf("[WARN][%s] LLM stream received non-delta payload (%d bytes) from %s: %s", w.execID, len(trimmed), w.url, rawPreview)
	}
	return len(p), nil
}

// extractScreenshotsFromToolOutput parses a take_screenshot tool output JSON (or truncated output)
// and reads the saved PNG files from disk as base64 data URIs so they can be shown to the user and LLM.
func extractScreenshotsFromToolOutput(rawResp string) []map[string]interface{} {
	trimmed := strings.TrimSpace(rawResp)
	if trimmed == "" {
		return nil
	}
	type screenEntry struct {
		ID        int    `json:"id"`
		DisplayID int    `json:"display_id"`
		Width     int    `json:"width"`
		Height    int    `json:"height"`
		FilePath  string `json:"file_path"`
	}
	var entries []screenEntry
	if err := json.Unmarshal([]byte(trimmed), &entries); err != nil || len(entries) == 0 {
		var parsed struct {
			Screens []screenEntry `json:"screens"`
		}
		if errObj := json.Unmarshal([]byte(trimmed), &parsed); errObj == nil && len(parsed.Screens) > 0 {
			entries = parsed.Screens
		}
	}
	if len(entries) == 0 {
		// Fallback regex if ElementTree caused the 16KB tool output cap to truncate the JSON tail
		reScreen := regexp.MustCompile(`"(?:display_id|id)"\s*:\s*(\d+)\s*,\s*"width"\s*:\s*(\d+)\s*,\s*"height"\s*:\s*(\d+)\s*,\s*"file_path"\s*:\s*"([^"]+)"`)
		for _, m := range reScreen.FindAllStringSubmatch(trimmed, -1) {
			var id, w, h int
			_, _ = fmt.Sscanf(m[1], "%d", &id)
			_, _ = fmt.Sscanf(m[2], "%d", &w)
			_, _ = fmt.Sscanf(m[3], "%d", &h)
			fp := strings.ReplaceAll(m[4], `\\`, `\`)
			entries = append(entries, screenEntry{
				ID:        id,
				DisplayID: id,
				Width:     w,
				Height:    h,
				FilePath:  fp,
			})
		}
		if len(entries) == 0 {
			rePath := regexp.MustCompile(`"file_path"\s*:\s*"([^"]+)"`)
			for idx, m := range rePath.FindAllStringSubmatch(trimmed, -1) {
				fp := strings.ReplaceAll(m[1], `\\`, `\`)
				entries = append(entries, screenEntry{
					ID:        idx + 1,
					DisplayID: idx + 1,
					FilePath:  fp,
				})
			}
		}
	}

	var results []map[string]interface{}
	seenPaths := map[string]bool{}
	for idx, sc := range entries {
		fp := strings.TrimSpace(sc.FilePath)
		if fp == "" || seenPaths[fp] {
			continue
		}
		seenPaths[fp] = true
		data, err := os.ReadFile(fp)
		if err != nil || len(data) == 0 {
			continue
		}
		b64 := base64.StdEncoding.EncodeToString(data)
		displayID := sc.DisplayID
		if displayID <= 0 {
			displayID = sc.ID
		}
		if displayID <= 0 {
			displayID = idx + 1
		}
		label := fmt.Sprintf("Display %d", displayID)
		if sc.Width > 0 && sc.Height > 0 {
			label = fmt.Sprintf("Display %d (%d×%d)", displayID, sc.Width, sc.Height)
		}
		results = append(results, map[string]interface{}{
			"name":       filepath.Base(fp),
			"label":      label,
			"path":       filepath.ToSlash(fp),
			"mime_type":  "image/png",
			"size":       len(data),
			"width":      sc.Width,
			"height":     sc.Height,
			"display_id": displayID,
			"data_uri":   "data:image/png;base64," + b64,
		})
	}
	return results
}

func extractGeneratedImagesFromDecisions(decisions []shuffle.AgentDecision) []map[string]interface{} {
	var allImages []map[string]interface{}
	seenPaths := map[string]bool{}
	for _, dec := range decisions {
		actLower := strings.ToLower(strings.TrimSpace(dec.Action))
		if actLower != "take_screenshot" && actLower != "screenshot" && !strings.Contains(dec.RunDetails.RawResponse, `"file_path"`) {
			continue
		}
		imgs := extractScreenshotsFromToolOutput(dec.RunDetails.RawResponse)
		for _, img := range imgs {
			p, _ := img["path"].(string)
			if p != "" && seenPaths[p] {
				continue
			}
			if p != "" {
				seenPaths[p] = true
			}
			allImages = append(allImages, img)
		}
	}
	return allImages
}

// parseModelResponseStepsAndDecisions extracts decisions, thought steps, commands, and cleans output
func parseModelResponseStepsAndDecisions(rawOutput, duration, model string) (string, []shuffle.AgentDecision, []ConversationStep) {
	return parseModelResponseStepsAndDecisionsWithExec(rawOutput, duration, model, nil)
}

// IsGenericPlaceholderOutput returns true if the given output string is empty or a generic completion placeholder
// (such as "Completed.", "Done.", "Finished.") rather than a substantive answer.
func IsGenericPlaceholderOutput(s string) bool {
	cleaned := strings.ToLower(strings.TrimSpace(s))
	cleaned = strings.TrimRight(cleaned, ".! ")
	switch cleaned {
	case "", "completed", "done", "finished", "task completed", "completed with no output", "ok", "success", "agent completed", "ai agent completed":
		return true
	}
	return false
}

// ExtractAnswerFromReasoning cleans a raw thought or reasoning block so it can be presented as the user-facing response
// when the model placed its entire answer inside the thought/reasoning stream.
func ExtractAnswerFromReasoning(reasoning string) string {
	s := strings.TrimSpace(reasoning)
	if s == "" {
		return ""
	}
	reOpenTag := regexp.MustCompile(`(?i)</?(?:thought|thinking)>`)
	s = strings.TrimSpace(reOpenTag.ReplaceAllString(s, ""))

	lines := strings.Split(s, "\n")
	if len(lines) == 1 && strings.HasPrefix(strings.TrimSpace(lines[0]), "• ") {
		s = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(lines[0]), "• "))
	}
	return strings.TrimSpace(s)
}

// parseModelResponseStepsAndDecisionsWithExec extracts decisions and steps from both WorkflowExecution and rawOutput
func parseModelResponseStepsAndDecisionsWithExec(rawOutput, duration, model string, workflowExec *shuffle.WorkflowExecution) (string, []shuffle.AgentDecision, []ConversationStep) {
	var extractedDecisions []shuffle.AgentDecision
	var extractedSteps []ConversationStep

	cleanOutput := rawOutput

	// 0. Extract decisions from workflowExec.Results if available
	if workflowExec != nil {
		for _, res := range workflowExec.Results {
			if strings.TrimSpace(res.Result) == "" {
				continue
			}
			var wfAgentOut shuffle.AgentOutput
			if err := json.Unmarshal([]byte(res.Result), &wfAgentOut); err == nil && (len(wfAgentOut.Decisions) > 0 || wfAgentOut.Output != "" || wfAgentOut.DecisionString != "") {
				extractedDecisions = append(extractedDecisions, wfAgentOut.Decisions...)
				if IsGenericPlaceholderOutput(cleanOutput) {
					if !IsGenericPlaceholderOutput(wfAgentOut.Output) {
						cleanOutput = wfAgentOut.Output
					} else if !IsGenericPlaceholderOutput(wfAgentOut.DecisionString) {
						cleanOutput = wfAgentOut.DecisionString
					}
				}
			} else {
				var directDecs []shuffle.AgentDecision
				if errArr := json.Unmarshal([]byte(res.Result), &directDecs); errArr == nil && len(directDecs) > 0 {
					extractedDecisions = append(extractedDecisions, directDecs...)
				}
			}
		}
	}

	// 1. Check if rawOutput itself is a JSON-encoded AgentOutput or list of decisions
	var agentOut shuffle.AgentOutput
	if jsonErr := json.Unmarshal([]byte(rawOutput), &agentOut); jsonErr == nil && (len(agentOut.Decisions) > 0 || agentOut.Output != "" || agentOut.DecisionString != "") {
		if len(extractedDecisions) == 0 && len(agentOut.Decisions) > 0 {
			extractedDecisions = append(extractedDecisions, agentOut.Decisions...)
		}
		if !IsGenericPlaceholderOutput(agentOut.Output) {
			cleanOutput = agentOut.Output
		} else if !IsGenericPlaceholderOutput(agentOut.DecisionString) {
			cleanOutput = agentOut.DecisionString
		} else if strings.TrimSpace(cleanOutput) == "" {
			cleanOutput = agentOut.Output
		}
	} else if len(extractedDecisions) == 0 {
		var directDecs []shuffle.AgentDecision
		if jsonErr2 := json.Unmarshal([]byte(rawOutput), &directDecs); jsonErr2 == nil && len(directDecs) > 0 {
			extractedDecisions = append(extractedDecisions, directDecs...)
		}
	}

	for idx, dec := range extractedDecisions {
		if strings.EqualFold(dec.Tool, "local_model") && len(extractedDecisions) > 1 {
			continue
		}
		stepName := dec.Action
		if stepName == "" {
			stepName = dec.Tool
		}
		if stepName == "" {
			stepName = fmt.Sprintf("Agent Step %d", idx+1)
		}
		stepType := "thought"
		if dec.Tool != "" && dec.Tool != "thought" {
			stepType = "cmd"
		}

		cmdExecuted := extractCommandFromDecision(dec)
		detailParts := make([]string, 0, 3)
		if strings.TrimSpace(dec.Reason) != "" {
			detailParts = append(detailParts, strings.TrimSpace(dec.Reason))
		}
		if cmdExecuted != "" {
			stepType = "cmd"
			firstLine := strings.Split(strings.TrimSpace(cmdExecuted), "\n")[0]
			if len(firstLine) > 50 {
				firstLine = firstLine[:47] + "..."
			}
			stepName = fmt.Sprintf("Command: %s", firstLine)
			detailParts = append(detailParts, fmt.Sprintf("$ %s", cmdExecuted))
		}
		if strings.TrimSpace(dec.RunDetails.RawResponse) != "" && dec.RunDetails.RawResponse != dec.Reason {
			detailParts = append(detailParts, strings.TrimSpace(dec.RunDetails.RawResponse))
		}
		detailText := strings.Join(detailParts, "\n\n")

		toolLower := strings.ToLower(dec.Tool)
		actionLower := strings.ToLower(dec.Action)
		if strings.Contains(actionLower, "screenshot") || strings.Contains(toolLower, "screenshot") {
			stepType = "cmd"
			imgs := extractScreenshotsFromToolOutput(dec.RunDetails.RawResponse)
			if len(imgs) > 1 {
				stepName = fmt.Sprintf("Captured %d display screenshots", len(imgs))
			} else if len(imgs) == 1 {
				stepName = "Captured display screenshot"
			} else {
				stepName = "Captured screenshot"
			}
		} else if cmdExecuted == "" && (strings.Contains(toolLower, "file") || strings.Contains(actionLower, "file") || strings.Contains(actionLower, "read") || strings.Contains(actionLower, "analyz")) {
			stepType = "file"
			filePath := ""
			if len(dec.Fields) > 0 {
				for _, f := range dec.Fields {
					fLower := strings.ToLower(f.Key)
					if strings.Contains(fLower, "path") || strings.Contains(fLower, "file") {
						filePath = fmt.Sprintf("%v", f.Value)
						break
					}
				}
			}
			if filePath != "" {
				stepName = fmt.Sprintf("Analyzed %s", filePath)
			} else if !strings.HasPrefix(strings.ToLower(stepName), "analyz") {
				stepName = fmt.Sprintf("Analyzed %s", stepName)
			}
		}

		dur := duration
		if dec.RunDetails.StartedAt > 0 && dec.RunDetails.CompletedAt >= dec.RunDetails.StartedAt {
			diff := dec.RunDetails.CompletedAt - dec.RunDetails.StartedAt
			var stepDur time.Duration
			if dec.RunDetails.StartedAt < 1e11 {
				stepDur = time.Duration(diff) * time.Second
			} else {
				stepDur = time.Duration(diff) * time.Millisecond
			}
			if stepDur > 0 {
				dur = stepDur.Round(time.Millisecond).String()
			}
		}
		if dur == "" {
			dur = "<1s"
		}
		if stepType == "thought" && (strings.EqualFold(stepName, "Tendon CUDA Reasoning") || strings.EqualFold(stepName, "thought") || strings.EqualFold(stepName, "finish")) {
			stepName = fmt.Sprintf("Thought for %s", dur)
		}
		stepID := dec.RunDetails.Id
		if stepID == "" {
			stepID = fmt.Sprintf("step-%d", idx+1)
		}
		extractedSteps = append(extractedSteps, ConversationStep{
			ID:        stepID,
			Name:      stepName,
			Detail:    detailText,
			Type:      stepType,
			Duration:  dur,
			Collapsed: true,
		})
	}

	// 2. Parse <thought>...</thought> or <thinking>...</thinking> tags (including unclosed trailing tags) from markdown output
	reThought := regexp.MustCompile(`(?is)<(?:thought|thinking)>(.*?)</(?:thought|thinking)>`)
	matches := reThought.FindAllStringSubmatch(cleanOutput, -1)
	for i, m := range matches {
		thoughtText := strings.TrimSpace(m[1])
		if thoughtText != "" {
			dur := duration
			if dur == "" {
				dur = "5s"
			}
			extractedSteps = append(extractedSteps, ConversationStep{
				ID:        fmt.Sprintf("thought-%d", i+1),
				Name:      fmt.Sprintf("Thought for %s", dur),
				Detail:    thoughtText,
				Type:      "thought",
				Duration:  dur,
				Collapsed: true,
			})
		}
	}
	cleanOutput = strings.TrimSpace(reThought.ReplaceAllString(cleanOutput, ""))

	// Also handle unclosed <thought> or <thinking> tag at the end of cleanOutput
	reUnclosedThought := regexp.MustCompile(`(?is)<(?:thought|thinking)>(.*)$`)
	if unclosedMatch := reUnclosedThought.FindStringSubmatch(cleanOutput); len(unclosedMatch) > 1 {
		thoughtText := strings.TrimSpace(unclosedMatch[1])
		if thoughtText != "" {
			dur := duration
			if dur == "" {
				dur = "5s"
			}
			extractedSteps = append(extractedSteps, ConversationStep{
				ID:        fmt.Sprintf("thought-unclosed-%d", len(extractedSteps)+1),
				Name:      fmt.Sprintf("Thought for %s", dur),
				Detail:    thoughtText,
				Type:      "thought",
				Duration:  dur,
				Collapsed: true,
			})
		}
		cleanOutput = strings.TrimSpace(reUnclosedThought.ReplaceAllString(cleanOutput, ""))
	}

	// If cleanOutput is empty or a generic placeholder ("Completed.", "Done.", etc.) after stripping thoughts,
	// recover the substantive answer from the thought steps or decisions so the user gets the actual answer.
	if IsGenericPlaceholderOutput(cleanOutput) {
		for i := len(extractedSteps) - 1; i >= 0; i-- {
			st := extractedSteps[i]
			if st.Type == "thought" && !IsGenericPlaceholderOutput(st.Detail) && !strings.HasPrefix(st.Detail, "Computed directly on GPU") {
				recovered := ExtractAnswerFromReasoning(st.Detail)
				if !IsGenericPlaceholderOutput(recovered) {
					cleanOutput = recovered
					break
				}
			}
		}
		if IsGenericPlaceholderOutput(cleanOutput) {
			for i := len(extractedDecisions) - 1; i >= 0; i-- {
				dec := extractedDecisions[i]
				if !IsGenericPlaceholderOutput(dec.Reason) && !strings.HasPrefix(dec.Reason, "Computed directly on GPU") {
					recovered := ExtractAnswerFromReasoning(dec.Reason)
					if !IsGenericPlaceholderOutput(recovered) {
						cleanOutput = recovered
						break
					}
				}
			}
		}
	}

	// 3. Parse bash / shell command blocks if no agent decisions were recorded
	if len(extractedDecisions) == 0 {
		reCmd := regexp.MustCompile("(?s)```(?:bash|sh|shell|zsh)\n(.*?)```")
		cmdMatches := reCmd.FindAllStringSubmatch(cleanOutput, -1)
		for i, m := range cmdMatches {
			cmdText := strings.TrimSpace(m[1])
			firstLine := strings.Split(cmdText, "\n")[0]
			if len(firstLine) > 40 {
				firstLine = firstLine[:37] + "..."
			}
			dur := duration
			if dur == "" {
				dur = "<1s"
			}
			extractedSteps = append(extractedSteps, ConversationStep{
				ID:        fmt.Sprintf("cmd-%d", i+1),
				Name:      fmt.Sprintf("Command: %s", firstLine),
				Detail:    cmdText,
				Type:      "cmd",
				Duration:  dur,
				Collapsed: true,
			})
		}
	}

	// 4. Default step if no structured steps were extracted
	if len(extractedSteps) == 0 {
		extractedSteps = append(extractedSteps, ConversationStep{
			ID:        "step-exec",
			Name:      "AI Agent Completed",
			Detail:    "Executed AI Agent loop",
			Type:      "cmd",
			Duration:  duration,
			Collapsed: true,
		})
	}

	return cleanOutput, extractedDecisions, extractedSteps
}

// isDecisionApprovalRequired returns true if the agent explicitly flagged the decision with approval_required: true
// either on the top-level AgentDecision.ApprovalRequired struct field or inside dec.Fields.
func isDecisionApprovalRequired(dec shuffle.AgentDecision) bool {
	if dec.ApprovalRequired {
		return true
	}
	for _, f := range dec.Fields {
		if strings.EqualFold(strings.TrimSpace(f.Key), "approval_required") {
			val := strings.ToLower(strings.TrimSpace(fmt.Sprintf("%v", f.Value)))
			if val == "true" || val == "1" || val == "yes" {
				return true
			}
		}
	}
	return false
}

// extractCommandFromDecision inspects an AgentDecision's Fields and Action to extract an executable command string
func extractCommandFromDecision(dec shuffle.AgentDecision) string {
	actLower := strings.ToLower(strings.TrimSpace(dec.Action))
	catLower := strings.ToLower(strings.TrimSpace(dec.Category))
	toolLower := strings.ToLower(strings.TrimSpace(dec.Tool))
	if actLower == "finish" || catLower == "finish" || toolLower == "finish" ||
		actLower == "ask" || actLower == "question" || catLower == "ask" || toolLower == "ask" {
		return ""
	}
	if osctrl.IsNativeAgentAction(actLower) {
		return ""
	}

	priorityKeys := []string{
		"cmd", "command", "commands", "script", "code", "shell", "powershell", "bash", "input", "body", "query", "expression",
	}
	for _, pk := range priorityKeys {
		for _, f := range dec.Fields {
			if strings.EqualFold(strings.TrimSpace(f.Key), pk) {
				valStr := strings.TrimSpace(fmt.Sprintf("%v", f.Value))
				if valStr != "" && valStr != "<nil>" {
					return valStr
				}
			}
		}
	}

	// If there is exactly one non-metadata field with a non-empty string value, use it
	var candidateVal string
	nonMetaCount := 0
	for _, f := range dec.Fields {
		kLower := strings.ToLower(strings.TrimSpace(f.Key))
		if kLower == "approval_required" {
			continue
		}
		nonMetaCount++
		candidateVal = strings.TrimSpace(fmt.Sprintf("%v", f.Value))
	}
	if nonMetaCount == 1 && candidateVal != "" && candidateVal != "<nil>" {
		return candidateVal
	}

	return ""
}

// extractQuestionsAndOptionsFromDecision extracts all questions, any predefined options/choices, and the reason from an ask/question decision.
func extractQuestionsAndOptionsFromDecision(dec shuffle.AgentDecision, agentOutput shuffle.AgentOutput) (questions []string, options []string, reason string) {
	seenQ := make(map[string]bool)
	addQ := func(q string) {
		q = strings.TrimSpace(q)
		if q != "" && q != "<nil>" && !IsGenericPlaceholderOutput(q) && !seenQ[q] {
			seenQ[q] = true
			questions = append(questions, q)
		}
	}
	var rawOptions []string
	addRawOpt := func(o string) {
		o = strings.TrimSpace(o)
		if o != "" && o != "<nil>" {
			rawOptions = append(rawOptions, o)
		}
	}

	for _, f := range dec.Fields {
		kLower := strings.ToLower(strings.TrimSpace(f.Key))
		valStr := strings.TrimSpace(f.Value)
		if valStr == "" {
			continue
		}
		switch kLower {
		case "question", "questions", "ask", "prompt", "query":
			var arr []string
			if strings.HasPrefix(valStr, "[") && json.Unmarshal([]byte(valStr), &arr) == nil {
				for _, item := range arr {
					addQ(item)
				}
			} else {
				addQ(valStr)
			}
		case "options", "choices", "suggestions", "answers", "predefined_answers", "option", "choice":
			var arr []string
			if strings.HasPrefix(valStr, "[") && json.Unmarshal([]byte(valStr), &arr) == nil {
				for _, item := range arr {
					addRawOpt(item)
				}
			} else if strings.Contains(valStr, "|") {
				for _, part := range strings.Split(valStr, "|") {
					addRawOpt(part)
				}
			} else if strings.Contains(valStr, "\n") {
				for _, part := range strings.Split(valStr, "\n") {
					addRawOpt(part)
				}
			} else if strings.Contains(valStr, ";") {
				for _, part := range strings.Split(valStr, ";") {
					addRawOpt(part)
				}
			} else {
				addRawOpt(valStr)
			}
		}
	}

	reason = strings.TrimSpace(dec.Reason)
	if len(questions) == 0 {
		ans := extractDecisionAnswerText(dec, agentOutput)
		if ans != "" {
			addQ(ans)
		} else if reason != "" {
			addQ(reason)
		}
	}
	options = normalizeAndGenerateQuestionOptions(questions, rawOptions)
	return questions, options, reason
}

func isGenericOrCustomOptionLabel(s string) bool {
	lower := strings.ToLower(strings.TrimSpace(s))
	lower = strings.TrimSuffix(lower, ".")
	switch lower {
	case "", "<nil>", "null", "none", "n/a",
		"yes, proceed", "use recommended defaults", "no, skip this",
		"type custom answer below", "custom", "custom...", "other", "other...",
		"skip", "cancel", "deny":
		return true
	}
	return false
}

// isStopOrSkipQuestionResponse returns true when the user skipped the question or answered with a skip/stop/decline phrase.
func isStopOrSkipQuestionResponse(answer string, answered bool) bool {
	if !answered {
		return true
	}
	cleaned := strings.ToLower(strings.TrimSpace(answer))
	cleaned = strings.Trim(cleaned, ".!?,;:\"'` ")
	switch cleaned {
	case "", "skip", "no, skip this", "no skip this", "skip this",
		"no", "nope", "none", "nothing", "cancel", "stop", "enough",
		"pass", "n/a", "nevermind", "never mind",
		"don't ask", "dont ask", "no questions", "no more questions",
		"stop asking", "stop asking questions", "stop asking me questions":
		return true
	}
	for _, phrase := range []string{
		"stop asking", "no more question", "don't ask", "dont ask",
		"skip this", "user skipped the question", "do not ask",
		"enough question", "stop question",
	} {
		if strings.Contains(cleaned, phrase) {
			return true
		}
	}
	return false
}

// isHardStopQuestionCommand returns true when the user explicitly commands the agent to stop asking questions immediately.
func isHardStopQuestionCommand(answer string) bool {
	cleaned := strings.ToLower(strings.TrimSpace(answer))
	cleaned = strings.Trim(cleaned, ".!?,;:\"'` ")
	switch cleaned {
	case "stop", "stop asking", "stop asking questions", "stop asking me questions",
		"no more questions", "don't ask", "dont ask", "don't ask questions", "dont ask questions",
		"do not ask questions", "do not ask any more questions", "enough", "enough questions":
		return true
	}
	for _, phrase := range []string{
		"stop asking", "no more question", "don't ask", "dont ask", "do not ask",
	} {
		if strings.Contains(cleaned, phrase) {
			return true
		}
	}
	return false
}

// userRequestedAnotherQuestion returns true only when the user's answer explicitly asks the agent to ask another question.
func userRequestedAnotherQuestion(answer string) bool {
	cleaned := strings.ToLower(strings.TrimSpace(answer))
	for _, phrase := range []string{
		"another question", "next question", "ask me another", "ask another",
		"more questions", "keep asking", "quiz me",
	} {
		if strings.Contains(cleaned, phrase) {
			return true
		}
	}
	return false
}

// updateAgentNodeAfterQuestion updates startNode and exec parameters with the Q&A transcript and disables further questions when appropriate.
func updateAgentNodeAfterQuestion(startNode *shuffle.Action, exec *shuffle.WorkflowExecution, questions []string, userAnswer string, disableFurtherQuestions bool, userStopped bool) {
	if startNode == nil {
		return
	}
	qText := strings.TrimSpace(strings.Join(questions, " "))
	if qText == "" {
		qText = "(Agent question)"
	}
	ansText := strings.TrimSpace(userAnswer)
	if ansText == "" {
		ansText = "(Skipped by user)"
	}

	var qaNote strings.Builder
	qaNote.WriteString("\n\n[Interactive Question & Answer Completed in This Turn]\n")
	qaNote.WriteString(fmt.Sprintf("- Question you asked the user: %s\n", qText))
	qaNote.WriteString(fmt.Sprintf("- User's answer: %s\n", ansText))
	if userStopped {
		qaNote.WriteString("CRITICAL DIRECTIVE: The user explicitly declined or asked to stop asking questions. Do NOT use the `ask` or `question` action again under any circumstances. Immediately conclude your response using the `finish` action.")
	} else if disableFurtherQuestions {
		qaNote.WriteString("CRITICAL DIRECTIVE: You have already asked a question and received the user's answer above. Do NOT use the `ask` or `question` action again in this turn (even if the initial prompt asked you to ask a question, that instruction is now FULFILLED). Address the user's answer directly or complete the task, and conclude with the `finish` action.")
	}
	qaBlock := qaNote.String()

	oldRule := "IMPORTANT QUESTION RULE: Whenever you use the `ask` or `question` action to ask the user a question, you MUST also populate the `options` field with 1 to 3 short, concrete, directly applicable suggested answers tailored to your exact question (formatted as a JSON array or `|`-separated list). Never use generic filler like 'Yes, proceed'; the UI automatically provides a 'Custom...' answer option."
	disabledRule := "IMPORTANT QUESTION RULE: You have already asked your interactive question in this turn. Questions (`ask` / `question` actions) are now DISABLED for the rest of this turn. Do NOT ask another question; respond to the user's answer and use the `finish` action."

	updateParams := func(params []shuffle.WorkflowAppActionParameter) {
		for idx := range params {
			switch params[idx].Name {
			case "input":
				updatedInput := params[idx].Value
				if disableFurtherQuestions {
					updatedInput = strings.Replace(updatedInput, oldRule, disabledRule, 1)
				}
				updatedInput += qaBlock
				params[idx].Value = updatedInput
			case "enable_questions":
				if disableFurtherQuestions {
					params[idx].Value = "false"
				}
			}
		}
	}

	updateParams(startNode.Parameters)
	if exec != nil {
		for aIdx := range exec.Workflow.Actions {
			if exec.Workflow.Actions[aIdx].ID == startNode.ID {
				updateParams(exec.Workflow.Actions[aIdx].Parameters)
			}
		}
		exec.ExecutionArgument = strings.TrimSpace(exec.ExecutionArgument) + qaBlock
	}
}

// updateAgentNodeAfterCommandDenial updates startNode and exec parameters with a command denial directive so the LLM does not retry the denied command on the next turn.
func updateAgentNodeAfterCommandDenial(startNode *shuffle.Action, exec *shuffle.WorkflowExecution, cmdText, errText string) {
	if startNode == nil {
		return
	}
	cleanCmd := strings.TrimSpace(cmdText)
	if cleanCmd == "" {
		cleanCmd = "(tool action)"
	}
	var denialNote strings.Builder
	denialNote.WriteString("\n\n[User Denied Command/Tool Execution in This Turn]\n")
	denialNote.WriteString(fmt.Sprintf("- Denied command/action: %s\n", cleanCmd))
	denialNote.WriteString(fmt.Sprintf("- Result: %s\n", strings.TrimSpace(errText)))
	denialNote.WriteString(fmt.Sprintf("CRITICAL DIRECTIVE: The user explicitly denied or skipped running %q. Do NOT attempt to execute %q again in this turn. Either follow the user's instruction above (if provided) or explain how to proceed and conclude with the `finish` action.", cleanCmd, cleanCmd))
	denialBlock := denialNote.String()

	updateParams := func(params []shuffle.WorkflowAppActionParameter) {
		for idx := range params {
			if params[idx].Name == "input" {
				params[idx].Value += denialBlock
			}
		}
	}
	updateParams(startNode.Parameters)
	if exec != nil {
		for aIdx := range exec.Workflow.Actions {
			if exec.Workflow.Actions[aIdx].ID == startNode.ID {
				updateParams(exec.Workflow.Actions[aIdx].Parameters)
			}
		}
		exec.ExecutionArgument = strings.TrimSpace(exec.ExecutionArgument) + denialBlock
	}
}

func cleanCandidateOptionText(s string) string {
	s = strings.TrimSpace(s)
	// Strip leading bullet or numbering such as "1.", "1)", "(a)", "- ", "* ", "• "
	for _, prefix := range []string{"- ", "* ", "• ", "– "} {
		if strings.HasPrefix(s, prefix) {
			s = strings.TrimSpace(strings.TrimPrefix(s, prefix))
		}
	}
	if len(s) >= 3 && ((s[0] >= '1' && s[0] <= '9') || (s[0] >= 'a' && s[0] <= 'z') || (s[0] >= 'A' && s[0] <= 'Z')) && (s[1] == '.' || s[1] == ')') && s[2] == ' ' {
		s = strings.TrimSpace(s[3:])
	}
	s = strings.Trim(s, "`\"'")
	s = strings.TrimRight(s, "?;")
	s = strings.TrimSpace(s)
	if len(s) > 90 {
		return ""
	}
	return s
}

func normalizeAndGenerateQuestionOptions(questions []string, rawOptions []string) []string {
	var cleaned []string
	seen := make(map[string]bool)
	addOpt := func(candidate string) {
		if len(cleaned) >= 3 {
			return
		}
		c := cleanCandidateOptionText(candidate)
		if c == "" || isGenericOrCustomOptionLabel(c) {
			return
		}
		key := strings.ToLower(c)
		if seen[key] {
			return
		}
		seen[key] = true
		cleaned = append(cleaned, c)
	}

	for _, raw := range rawOptions {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			continue
		}
		var arr []string
		if strings.HasPrefix(trimmed, "[") && json.Unmarshal([]byte(trimmed), &arr) == nil {
			for _, item := range arr {
				addOpt(item)
			}
			continue
		}
		if strings.Contains(trimmed, "|") {
			for _, p := range strings.Split(trimmed, "|") {
				addOpt(p)
			}
			continue
		}
		if strings.Contains(trimmed, "\n") {
			for _, p := range strings.Split(trimmed, "\n") {
				addOpt(p)
			}
			continue
		}
		addOpt(trimmed)
	}

	fullQ := strings.TrimSpace(strings.Join(questions, "\n"))
	if len(cleaned) == 0 && fullQ != "" {
		for _, ext := range extractOptionsFromQuestionText(fullQ) {
			addOpt(ext)
		}
	}

	if len(cleaned) == 0 {
		for _, syn := range synthesizeContextualQuestionOptions(fullQ) {
			addOpt(syn)
		}
	}

	if len(cleaned) > 3 {
		cleaned = cleaned[:3]
	}
	return cleaned
}

func extractOptionsFromQuestionText(qText string) []string {
	var results []string
	lines := strings.Split(qText, "\n")

	// 1. Check for bulleted or numbered list items inside the question text
	for _, line := range lines {
		t := strings.TrimSpace(line)
		isBullet := strings.HasPrefix(t, "- ") || strings.HasPrefix(t, "* ") || strings.HasPrefix(t, "• ")
		isNumbered := len(t) >= 3 && ((t[0] >= '1' && t[0] <= '9') || (t[0] >= 'a' && t[0] <= 'd') || (t[0] >= 'A' && t[0] <= 'D')) && (t[1] == '.' || t[1] == ')') && t[2] == ' '
		if isBullet || isNumbered {
			if c := cleanCandidateOptionText(t); c != "" && !strings.HasSuffix(c, ":") {
				results = append(results, c)
			}
		}
	}
	if len(results) >= 2 {
		if len(results) > 3 {
			return results[:3]
		}
		return results
	}
	results = nil

	// 2. Check for parenthetical examples: "(e.g., X, Y, or Z)", "(such as X, Y)", "(for example X or Y)"
	lowerQ := strings.ToLower(qText)
	for _, marker := range []string{"(e.g.,", "(e.g.", "(for example,", "(for example:", "(such as ", "(like ", "e.g., ", "such as "} {
		idx := strings.Index(lowerQ, marker)
		if idx >= 0 {
			sub := qText[idx+len(marker):]
			if endIdx := strings.IndexAny(sub, ").\n?"); endIdx >= 0 {
				sub = sub[:endIdx]
			}
			sub = strings.ReplaceAll(sub, ", or ", "|")
			sub = strings.ReplaceAll(sub, " or ", "|")
			sub = strings.ReplaceAll(sub, ",", "|")
			for _, part := range strings.Split(sub, "|") {
				if c := cleanCandidateOptionText(part); c != "" && len(c) <= 60 {
					results = append(results, c)
				}
			}
			if len(results) >= 1 {
				if len(results) > 3 {
					return results[:3]
				}
				return results
			}
		}
	}

	// 3. Check for explicit "X or Y" alternatives in the last sentence of the question
	lastLine := strings.TrimSpace(lines[len(lines)-1])
	lastLine = strings.TrimSuffix(lastLine, "?")
	if strings.Contains(strings.ToLower(lastLine), " or ") {
		// Trim common question lead-ins
		leadIns := []string{
			"would you like to use ", "would you like ", "should i use ", "should i ",
			"do you prefer ", "do you want to use ", "do you want ", "would you prefer ",
			"are you using ", "is this for ", "shall we use ", "choose between ",
		}
		candidateClause := lastLine
		lowerClause := strings.ToLower(candidateClause)
		for _, lead := range leadIns {
			if pos := strings.Index(lowerClause, lead); pos >= 0 {
				candidateClause = strings.TrimSpace(candidateClause[pos+len(lead):])
				lowerClause = strings.ToLower(candidateClause)
				break
			}
		}
		if strings.Contains(lowerClause, " or ") && len(candidateClause) <= 120 {
			normalized := strings.ReplaceAll(candidateClause, ", or ", "|")
			normalized = strings.ReplaceAll(normalized, " or ", "|")
			normalized = strings.ReplaceAll(normalized, ", ", "|")
			parts := strings.Split(normalized, "|")
			if len(parts) >= 2 && len(parts) <= 4 {
				for _, p := range parts {
					if c := cleanCandidateOptionText(p); c != "" && len(c) <= 50 {
						results = append(results, c)
					}
				}
				if len(results) >= 2 {
					if len(results) > 3 {
						return results[:3]
					}
					return results
				}
			}
		}
	}

	return nil
}

func synthesizeContextualQuestionOptions(qText string) []string {
	lower := strings.ToLower(strings.TrimSpace(qText))
	if lower == "" {
		return []string{"Use recommended defaults", "Keep changes minimal"}
	}

	// Domain-aware contextual suggestions (1-3 concrete choices)
	switch {
	case strings.Contains(lower, "database") || strings.Contains(lower, "storage") || strings.Contains(lower, "persistence"):
		return []string{"SQLite (local file)", "PostgreSQL", "In-memory storage"}
	case strings.Contains(lower, "environment") || strings.Contains(lower, "deploy") || strings.Contains(lower, "target env"):
		return []string{"Local development", "Staging", "Production"}
	case strings.Contains(lower, "auth") || strings.Contains(lower, "token") || strings.Contains(lower, "api key") || strings.Contains(lower, "credential"):
		return []string{"Use environment variables (.env)", "Use existing config / session"}
	case strings.Contains(lower, "test") || strings.Contains(lower, "verify") || strings.Contains(lower, "validation"):
		return []string{"Run targeted tests only", "Run full test suite", "Skip tests for now"}
	case strings.Contains(lower, "directory") || strings.Contains(lower, "folder") || strings.Contains(lower, "path") || strings.Contains(lower, "where should"):
		return []string{"Current workspace root", "Use existing project structure"}
	case strings.Contains(lower, "format") || strings.Contains(lower, "output") || strings.Contains(lower, "report"):
		return []string{"Concise summary", "Detailed step-by-step output", "JSON / structured format"}
	case strings.Contains(lower, "overwrite") || strings.Contains(lower, "replace") || strings.Contains(lower, "existing file"):
		return []string{"Update existing file in-place", "Create a new file alongside it", "Keep existing file unchanged"}
	case strings.Contains(lower, "port") || strings.Contains(lower, "host") || strings.Contains(lower, "server"):
		return []string{"Use default local port", "Auto-select available port"}
	case strings.HasPrefix(lower, "should ") || strings.HasPrefix(lower, "would you like") || strings.HasPrefix(lower, "do you want") || strings.HasPrefix(lower, "can i ") || strings.HasPrefix(lower, "shall "):
		return []string{"Yes, go ahead with this", "Use a minimal, non-breaking approach", "No, hold off on this step"}
	default:
		return []string{"Use recommended defaults for this workspace", "Take the simplest minimal approach"}
	}
}

// extractDecisionAnswerText extracts the user-facing answer or question from a finish/ask decision or AgentOutput.
// If the explicit output field is empty or a generic placeholder like "Completed.", it falls back to the substantive reasoning.
func extractDecisionAnswerText(dec shuffle.AgentDecision, agentOutput shuffle.AgentOutput) string {
	var genericFallback string

	if strings.TrimSpace(agentOutput.Output) != "" {
		cand := strings.TrimSpace(agentOutput.Output)
		if !IsGenericPlaceholderOutput(cand) {
			return cand
		}
		genericFallback = cand
	}

	// If there are multiple "question" fields in dec.Fields, join them cleanly.
	var multiQuestions []string
	for _, f := range dec.Fields {
		if strings.EqualFold(strings.TrimSpace(f.Key), "question") {
			valStr := strings.TrimSpace(fmt.Sprintf("%v", f.Value))
			if valStr != "" && valStr != "<nil>" && !IsGenericPlaceholderOutput(valStr) {
				multiQuestions = append(multiQuestions, valStr)
			}
		}
	}
	if len(multiQuestions) > 1 {
		return strings.Join(multiQuestions, "\n\n")
	}

	answerKeys := []string{
		"output", "answer", "response", "result", "body", "message", "text", "question", "input", "content",
	}
	for _, ak := range answerKeys {
		for _, f := range dec.Fields {
			if strings.EqualFold(strings.TrimSpace(f.Key), ak) {
				valStr := strings.TrimSpace(fmt.Sprintf("%v", f.Value))
				if valStr != "" && valStr != "<nil>" {
					if !IsGenericPlaceholderOutput(valStr) {
						return valStr
					}
					if genericFallback == "" {
						genericFallback = valStr
					}
				}
			}
		}
	}
	if strings.TrimSpace(dec.RunDetails.RawResponse) != "" {
		cand := strings.TrimSpace(dec.RunDetails.RawResponse)
		if !IsGenericPlaceholderOutput(cand) {
			return cand
		}
		if genericFallback == "" {
			genericFallback = cand
		}
	}
	if strings.TrimSpace(dec.Reason) != "" {
		cand := strings.TrimSpace(dec.Reason)
		if !IsGenericPlaceholderOutput(cand) {
			return cand
		}
		if genericFallback == "" {
			genericFallback = cand
		}
	}
	if strings.TrimSpace(agentOutput.DecisionString) != "" {
		cand := strings.TrimSpace(agentOutput.DecisionString)
		if !IsGenericPlaceholderOutput(cand) {
			return cand
		}
		if genericFallback == "" {
			genericFallback = cand
		}
	}
	return genericFallback
}

// executeAgentToolCommand runs an agent tool command locally in the active project workspace via osctrl after enforcing security policies
func (b *AgentBridge) executeAgentToolCommand(ctx context.Context, rawCmd, project, execID string, convIDs ...string) (string, error) {
	convID := ""
	if len(convIDs) > 0 {
		convID = convIDs[0]
	}
	out, _, err := b.executeAgentToolCommandWithApprovalFlag(ctx, rawCmd, project, execID, convID, false, "")
	return out, err
}

func (b *AgentBridge) executeAgentToolCommandWithApprovalFlag(ctx context.Context, rawCmd, project, execID, convID string, agentApprovalReq bool, agentReason string) (string, bool, error) {
	ctx = b.GetExecutionContext(execID, ctx)
	cleanCmd := strings.TrimSpace(rawCmd)
	cleanCmd = strings.TrimPrefix(cleanCmd, "$ ")
	cleanCmd = strings.TrimPrefix(cleanCmd, "> ")
	cleanCmd = strings.TrimSpace(cleanCmd)
	if cleanCmd == "" {
		return "", false, nil
	}

	needsApproval, explicitlyDenied, cmdPrefix, desc, warning := b.evaluateCommandSecurity(cleanCmd, project, convID, agentApprovalReq)
	if explicitlyDenied {
		return "", false, fmt.Errorf("command %q blocked by saved security rule (%s): do not retry this blocked command; ask the user how to proceed", cleanCmd, warning)
	}
	if needsApproval {
		if agentApprovalReq && strings.HasPrefix(warning, "Agent flagged") && strings.TrimSpace(agentReason) != "" {
			warning = fmt.Sprintf("Agent flagged this command as requiring approval: %s", strings.TrimSpace(agentReason))
		}
		approved, feedback, apprErr := b.requestInFlightApprovalWithFeedback(ctx, execID, convID, project, cleanCmd, cmdPrefix, desc, warning)
		if apprErr != nil {
			return "", true, apprErr
		}
		if !approved {
			if strings.TrimSpace(feedback) != "" {
				return "", true, fmt.Errorf("command execution denied by user for %q. User instruction on what to do instead: %s", cleanCmd, strings.TrimSpace(feedback))
			}
			return "", true, fmt.Errorf("command execution denied by user for %q (%s): do not retry this blocked command; ask the user how to proceed", cleanCmd, warning)
		}
		// Refresh context after waiting for approval
		ctx = b.GetExecutionContext(execID, ctx)
	}

	b.mu.Lock()
	eff := b.getEffectivePermissionsLocked(project)
	b.mu.Unlock()

	if eff.SandboxMode || eff.TerminalExecutionPolicy == "sandbox" {
		_ = os.Setenv("ORBORUS_SANDBOX", "1")
		_ = os.Setenv("ORBORUS_WORKSPACE", project)
	} else {
		_ = os.Unsetenv("ORBORUS_SANDBOX")
	}

	log.Printf("[INFO][%s] Agent Tool Executing command via osctrl in %q (sandbox=%v, agent_approval_req=%v): %s", execID, project, eff.SandboxMode, agentApprovalReq, cleanCmd)
	out, err := osctrl.RunCommandInDir(cleanCmd, project, 180*time.Second, nil)
	if len(out) > 16000 {
		out = out[:16000] + "\n... [output truncated]"
	}
	return out, needsApproval, err
}

// executeAgentDecision dispatches an AgentDecision to osctrl (native OS actions or shell command execution) after enforcing security policies
func (b *AgentBridge) executeAgentDecision(ctx context.Context, dec *shuffle.AgentDecision, project, execID string, convIDs ...string) (label string, output string, executed bool, err error) {
	if dec == nil {
		return "", "", false, nil
	}
	ctx = b.GetExecutionContext(execID, ctx)

	convID := ""
	if len(convIDs) > 0 {
		convID = convIDs[0]
	}

	agentApprovalReq := isDecisionApprovalRequired(*dec)
	if agentApprovalReq {
		dec.ApprovalRequired = true
	}

	actLower := strings.ToLower(strings.TrimSpace(dec.Action))
	if idx := strings.LastIndex(actLower, ":"); idx >= 0 && idx+1 < len(actLower) {
		actLower = actLower[idx+1:]
	}
	if !osctrl.IsNativeAgentAction(actLower) && strings.TrimSpace(dec.Tool) != "" {
		toolCandidate := strings.ToLower(strings.TrimSpace(dec.Tool))
		if idx := strings.LastIndex(toolCandidate, ":"); idx >= 0 && idx+1 < len(toolCandidate) {
			toolCandidate = toolCandidate[idx+1:]
		}
		if osctrl.IsNativeAgentAction(toolCandidate) {
			actLower = toolCandidate
		}
	}

	fieldsMap := make(map[string]string, len(dec.Fields))
	for _, f := range dec.Fields {
		k := strings.TrimSpace(f.Key)
		v := fmt.Sprintf("%v", f.Value)
		if k != "" && !strings.EqualFold(k, "approval_required") && strings.TrimSpace(v) != "" && strings.TrimSpace(v) != "<nil>" {
			fieldsMap[k] = v
		}
	}

	// Check if this decision targets an attached remote Shuffle app tool
	if matchedTool, wfApp, matchedAct, resolvedActName := b.matchAttachedShuffleTool(convID, dec); matchedTool != nil {
		label = fmt.Sprintf("%s:%s", matchedTool.AppName, resolvedActName)
		dec.Category = "subflow"
		dec.Tool = matchedTool.AppName
		dec.Action = resolvedActName
		if agentApprovalReq {
			dec.ApprovalRequired = true
			cmdPrefix := fmt.Sprintf("shuffle:%s:%s", strings.ToLower(matchedTool.AppName), strings.ToLower(resolvedActName))
			desc := fmt.Sprintf("Allow running Shuffle app %s action '%s'?", matchedTool.AppName, resolvedActName)
			warning := "Remote Shuffle app action flagged as requiring approval."
			if strings.TrimSpace(dec.Reason) != "" {
				warning = fmt.Sprintf("Agent flagged this remote Shuffle action as requiring approval: %s", strings.TrimSpace(dec.Reason))
			}
			approved, feedback, apprErr := b.requestInFlightApprovalWithFeedback(ctx, execID, convID, project, label, cmdPrefix, desc, warning)
			if apprErr != nil {
				return label, "", true, apprErr
			}
			if !approved {
				if strings.TrimSpace(feedback) != "" {
					return label, "", true, fmt.Errorf("Shuffle app action denied by user for %q. User instruction on what to do instead: %s", label, strings.TrimSpace(feedback))
				}
				return label, "", true, fmt.Errorf("Shuffle app action denied by user for %q: do not retry this blocked action; ask the user how to proceed", label)
			}
			ctx = b.GetExecutionContext(execID, ctx)
		}

		log.Printf("[INFO][%s] Agent Tool Executing remote Shuffle app action %q (appID=%s, authID=%s)", execID, label, matchedTool.AppID, matchedTool.AuthID)
		out, runErr := b.executeRemoteShuffleAppAction(ctx, *matchedTool, wfApp, matchedAct, resolvedActName, fieldsMap, execID)
		if len(out) > 16000 {
			out = out[:16000] + "\n... [output truncated]"
		}
		return label, out, true, runErr
	}

	if osctrl.IsNativeAgentAction(actLower) {
		target := strings.TrimSpace(fieldsMap["path"])
		if target == "" {
			target = strings.TrimSpace(fieldsMap["file"])
		}
		if target == "" {
			target = strings.TrimSpace(fieldsMap["filepath"])
		}
		if target == "" {
			target = strings.TrimSpace(fieldsMap["file_path"])
		}
		if target == "" {
			target = strings.TrimSpace(fieldsMap["directory"])
		}
		if target == "" {
			target = strings.TrimSpace(fieldsMap["dir"])
		}
		if target == "" {
			target = strings.TrimSpace(fieldsMap["query"])
		}
		if target == "" {
			target = strings.TrimSpace(fieldsMap["pattern"])
		}
		if target != "" {
			label = fmt.Sprintf("%s (%s)", actLower, target)
		} else {
			label = actLower
		}

		needsApproval, explicitlyDenied, cmdPrefix, desc, warning := b.evaluateNativeToolSecurity(actLower, fieldsMap, project, convID, agentApprovalReq)
		if explicitlyDenied {
			return label, "", true, fmt.Errorf("OS action %q blocked by saved security rule (%s): do not retry this blocked action; ask the user how to proceed", label, warning)
		}
		if needsApproval {
			dec.ApprovalRequired = true
			if agentApprovalReq && strings.HasPrefix(warning, "Agent flagged") && strings.TrimSpace(dec.Reason) != "" {
				warning = fmt.Sprintf("Agent flagged this action as requiring approval: %s", strings.TrimSpace(dec.Reason))
			}
			approved, feedback, apprErr := b.requestInFlightApprovalWithFeedback(ctx, execID, convID, project, label, cmdPrefix, desc, warning)
			if apprErr != nil {
				return label, "", true, apprErr
			}
			if !approved {
				if strings.TrimSpace(feedback) != "" {
					return label, "", true, fmt.Errorf("OS action execution denied by user for %q. User instruction on what to do instead: %s", label, strings.TrimSpace(feedback))
				}
				return label, "", true, fmt.Errorf("OS action execution denied by user for %q (%s): do not retry this blocked action; ask the user how to proceed", label, warning)
			}
			ctx = b.GetExecutionContext(execID, ctx)
		}

		b.mu.Lock()
		eff := b.getEffectivePermissionsLocked(project)
		b.mu.Unlock()

		if eff.SandboxMode {
			_ = os.Setenv("ORBORUS_SANDBOX", "1")
			_ = os.Setenv("ORBORUS_WORKSPACE", project)
		} else {
			_ = os.Unsetenv("ORBORUS_SANDBOX")
		}

		log.Printf("[INFO][%s] Agent Tool Executing native osctrl action %q in %q (agent_approval_req=%v)", execID, label, project, agentApprovalReq)
		out, toolErr := osctrl.ExecuteAgentTool(actLower, fieldsMap, project, 180*time.Second, nil)
		if len(out) > 16000 {
			out = out[:16000] + "\n... [output truncated]"
		}
		return label, out, true, toolErr
	}

	cmdToRun := extractCommandFromDecision(*dec)
	if cmdToRun != "" {
		firstLine := strings.Split(strings.TrimSpace(cmdToRun), "\n")[0]
		if len(firstLine) > 80 {
			firstLine = firstLine[:77] + "..."
		}
		out, neededApproval, cmdErr := b.executeAgentToolCommandWithApprovalFlag(ctx, cmdToRun, project, execID, convID, agentApprovalReq, dec.Reason)
		if neededApproval {
			dec.ApprovalRequired = true
		}
		return firstLine, out, true, cmdErr
	}

	return "", "", false, nil
}

// makeAgentUUID generates a valid 5-segment UUID v4 string required by shuffle.Fixexecution
func makeAgentUUID(seed uint64) string {
	now := uint64(time.Now().UnixNano()) ^ (seed * 0x9e3779b97f4a7c15)
	return fmt.Sprintf("%08x-%04x-4%03x-8%03x-%012x",
		uint32(now>>32),
		uint16(now>>16),
		uint16(now)&0x0fff,
		uint16(now>>8)&0x0fff,
		now&0xffffffffffff,
	)
}

// summarizeConversationBatchOpenAI performs an incremental rolling summary of newly aged conversation turns
// using an OpenAI-compatible chat completions endpoint with a bounded 10s timeout.
func summarizeConversationBatchOpenAI(apiURL, apiKey, model, existingSummary, batchTranscript string) (string, error) {
	endpoint := strings.TrimRight(strings.TrimSpace(apiURL), "/")
	if endpoint == "" {
		return "", fmt.Errorf("empty apiURL")
	}
	if !strings.HasSuffix(endpoint, "/chat/completions") {
		endpoint += "/chat/completions"
	}

	var userContent strings.Builder
	if strings.TrimSpace(existingSummary) != "" {
		userContent.WriteString("Existing rolling summary of earlier turns:\n")
		userContent.WriteString(strings.TrimSpace(existingSummary))
		userContent.WriteString("\n\n")
	}
	userContent.WriteString("New conversation turns to fold into the rolling summary:\n")
	userContent.WriteString(strings.TrimSpace(batchTranscript))
	userContent.WriteString("\n\nProduce an updated, concise rolling summary (under 450 words) that preserves all key user goals, decisions, file paths, commands/tools executed, outputs, and unresolved issues from both the existing summary and the new turns.")

	reqPayload := map[string]interface{}{
		"model": model,
		"messages": []map[string]string{
			{
				"role":    "system",
				"content": "You compress earlier conversation turns into a dense, accurate rolling technical summary. Preserve specific file names, commands, findings, decisions, and outcomes. Output only the summary text.",
			},
			{
				"role":    "user",
				"content": userContent.String(),
			},
		},
		"temperature": 0.2,
		"max_tokens":  700,
	}

	rawBody, err := json.Marshal(reqPayload)
	if err != nil {
		return "", err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(rawBody))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if strings.TrimSpace(apiKey) != "" {
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(apiKey))
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("summarizer HTTP %d", resp.StatusCode)
	}

	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return "", err
	}
	if len(parsed.Choices) == 0 {
		return "", fmt.Errorf("empty choices from summarizer")
	}
	summary := strings.TrimSpace(parsed.Choices[0].Message.Content)
	if summary == "" {
		return "", fmt.Errorf("blank summary from summarizer")
	}
	return summary, nil
}

// executeAiRequest runs the multi-turn Shuffle AI Agent loop from start to finish using shuffle.HandleAiAgentExecutionStart.
// Note: Direct single-shot shuffle.RunAiQuery is reserved strictly for TestAiConfig.
func (b *AgentBridge) executeAiRequest(prompt, execID string, reqModelAndReasoning ...string) (string, *shuffle.WorkflowExecution, error) {
	return b.executeAiRequestWithAttachments(prompt, execID, nil, "", reqModelAndReasoning...)
}

func (b *AgentBridge) executeAiRequestWithAttachments(prompt, execID string, imageURIs []string, fileContextBlock string, reqModelAndReasoning ...string) (string, *shuffle.WorkflowExecution, error) {
	reqStart := time.Now()
	b.mu.Lock()
	apiURL := b.getEffectiveAiUrlLocked()
	apiKey := b.getEffectiveAiKeyLocked()
	requestedModel := b.aiModel
	if len(reqModelAndReasoning) > 0 && reqModelAndReasoning[0] != "" {
		requestedModel = reqModelAndReasoning[0]
	}
	model := requestedModel
	if model == "" || model == "shuffle" {
		model = "shuffle-ai"
	}
	reasoning := "low"
	if len(reqModelAndReasoning) > 1 && reqModelAndReasoning[1] != "" {
		reasoning = strings.ToLower(strings.TrimSpace(reqModelAndReasoning[1]))
		if reasoning == "minimal" || reasoning == "none" {
			reasoning = "off"
		}
	}
	if len(reqModelAndReasoning) > 2 && reqModelAndReasoning[2] != "" {
		apiURL = reqModelAndReasoning[2]
	}
	if len(reqModelAndReasoning) > 3 && reqModelAndReasoning[3] != "" {
		apiKey = reqModelAndReasoning[3]
	}
	convID := ""
	if len(reqModelAndReasoning) > 4 && reqModelAndReasoning[4] != "" {
		convID = reqModelAndReasoning[4]
	}
	project := b.activeProject
	activeMode := b.activeExecutionMode
	orgID := ""
	if b.cfg != nil {
		orgID = b.cfg.Org
	}
	localExec := b.localAiExecutor
	oauthActive := b.oauthLoggedIn || b.activeExecutionMode == "shuffle"
	oauthToken := b.oauthToken
	cfgBaseURL := ""
	cfgAuth := ""
	if b.cfg != nil {
		cfgBaseURL = b.cfg.BaseURL
		cfgAuth = b.cfg.Auth
	}
	b.mu.Unlock()

	ctx, cancel := b.RefreshExecutionContext(execID, 600*time.Second)
	defer func() {
		b.UnregisterCancel(execID)
		cancel()
	}()

	modelLower := strings.ToLower(model)
	isCloudModel := strings.HasPrefix(modelLower, "gemini") ||
		strings.HasPrefix(modelLower, "gpt") ||
		strings.HasPrefix(modelLower, "claude") ||
		strings.HasPrefix(modelLower, "groq") ||
		strings.HasPrefix(modelLower, "anthropic")

	isLocalRequest := localExec != nil && !isCloudModel && (strings.HasPrefix(modelLower, "tendon") ||
		modelLower == "local" ||
		strings.HasPrefix(modelLower, "local/") ||
		strings.HasPrefix(modelLower, "local-") ||
		strings.HasPrefix(apiURL, "local://") ||
		apiKey == "local-tendon")

	// Start a lightweight in-process loopback server to:
	// 1. Handle Shuffle agent internal stream/workflow callbacks (/api/v1/streams, /api/v1/workflows) locally in <1ms
	// 2. Expose an OpenAI-compatible /v1/chat/completions adapter when running with the native local GPU executor (localExec)
	var loopbackURL string
	if ln, lnErr := net.Listen("tcp", "127.0.0.1:0"); lnErr == nil {
		loopbackURL = "http://" + ln.Addr().String()
		mux := http.NewServeMux()
		mux.HandleFunc("/api/v1/streams", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"success":true}`))
		})
		mux.HandleFunc("/api/v1/workflows/", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"success":true}`))
		})
		if isLocalRequest && localExec != nil {
			mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
				var chatReq openai.ChatCompletionRequest
				bodyBytes, _ := io.ReadAll(r.Body)
				_ = json.Unmarshal(bodyBytes, &chatReq)
				var promptParts []string
				for _, m := range chatReq.Messages {
					if strings.TrimSpace(m.Content) != "" {
						promptParts = append(promptParts, fmt.Sprintf("[%s]\n%s", strings.ToUpper(m.Role), m.Content))
					} else if len(m.MultiContent) > 0 {
						for _, part := range m.MultiContent {
							if part.Type == openai.ChatMessagePartTypeText && strings.TrimSpace(part.Text) != "" {
								promptParts = append(promptParts, fmt.Sprintf("[%s]\n%s", strings.ToUpper(m.Role), part.Text))
							}
						}
					}
				}
				combinedPrompt := strings.Join(promptParts, "\n\n")
				if combinedPrompt == "" {
					combinedPrompt = prompt
				}
				outText, _, _, locErr := localExec(r.Context(), combinedPrompt, execID, model, reasoning, b)
				if locErr != nil {
					http.Error(w, locErr.Error(), http.StatusInternalServerError)
					return
				}
				respObj := openai.ChatCompletionResponse{
					ID:      fmt.Sprintf("chatcmpl-%d", time.Now().UnixNano()),
					Object:  "chat.completion",
					Created: time.Now().Unix(),
					Model:   model,
					Choices: []openai.ChatCompletionChoice{
						{
							Index: 0,
							Message: openai.ChatCompletionMessage{
								Role:    openai.ChatMessageRoleAssistant,
								Content: outText,
							},
							FinishReason: openai.FinishReasonStop,
						},
					},
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(respObj)
			})
		}
		srv := &http.Server{Handler: mux}
		go func() {
			_ = srv.Serve(ln)
		}()
		defer func() {
			_ = srv.Close()
			_ = ln.Close()
		}()
	}

	lowerURL := strings.ToLower(apiURL)
	isShuffleKey := !isLocalRequest && (strings.HasPrefix(apiKey, "shfl_") ||
		oauthActive ||
		requestedModel == "shuffle-ai" ||
		requestedModel == "shuffle" ||
		model == "shuffle-ai" ||
		model == "shuffle" ||
		strings.Contains(lowerURL, "shuffler.io") ||
		strings.Contains(lowerURL, "shuffle.security"))

	providerMode := "byok_agent_loop"
	authSource := "byok_key"

	if isLocalRequest && loopbackURL != "" {
		providerMode = "local_tendon_agent_loop"
		authSource = "local_tendon"
		apiURL = loopbackURL + "/v1"
		apiKey = "local-tendon"
	} else if isShuffleKey {
		providerMode = "shuffler.io_agent_loop"
		if model == "" || model == "shuffle" {
			model = "shuffle-ai"
		}
		if apiKey == "" || (!strings.HasPrefix(apiKey, "shfl_") && (oauthToken != "" || cfgAuth != "")) {
			if oauthToken != "" {
				apiKey = oauthToken
				authSource = "shuffle_oauth_token"
			} else if cfgAuth != "" {
				apiKey = cfgAuth
				authSource = "shuffle_cfg_auth"
			}
		} else if strings.HasPrefix(apiKey, "shfl_") {
			authSource = "shuffle_api_token"
		}

		isThirdPartyURL := strings.Contains(lowerURL, "api.openai.com") ||
			strings.Contains(lowerURL, "generativelanguage.googleapis.com") ||
			strings.Contains(lowerURL, "api.anthropic.com") ||
			strings.Contains(lowerURL, "api.groq.com")

		if cfgBaseURL != "" || apiURL == "" || isThirdPartyURL || strings.Contains(lowerURL, "shuffle.security") || strings.HasPrefix(lowerURL, "local://") || strings.Contains(lowerURL, "tendon") {
			apiURL = resolveShuffleAiApiURL(cfgBaseURL)
			log.Printf("[INFO][%s] Routed Shuffle AI Agent session to shuffler.io API: %s (from cfgBaseURL=%q, org=%q)", execID, apiURL, cfgBaseURL, orgID)
		} else {
			apiURL = resolveShuffleAiApiURL(apiURL)
		}
	} else {
		if apiURL == "" || strings.HasPrefix(apiURL, "local://") || strings.Contains(apiURL, "tendon") {
			if strings.HasPrefix(strings.ToLower(model), "gemini") {
				apiURL = "https://generativelanguage.googleapis.com/v1beta/openai"
			} else if strings.HasPrefix(strings.ToLower(model), "tendon") || strings.Contains(strings.ToLower(model), "local") || strings.HasPrefix(apiURL, "local://") || strings.Contains(apiURL, "tendon") {
				providerMode = "local_http_agent_loop"
				if envURL := os.Getenv("AI_API_URL"); envURL != "" && strings.HasPrefix(envURL, "http") {
					apiURL = envURL
				} else {
					apiURL = "http://127.0.0.1:8000/v1"
				}
			} else {
				apiURL = "https://api.openai.com/v1"
			}
		}
	}

	if apiKey == "" && strings.HasPrefix(strings.ToLower(model), "gemini") {
		if k := os.Getenv("GEMINI_API_KEY"); k != "" {
			apiKey = k
			authSource = "env:GEMINI_API_KEY"
		} else if k := os.Getenv("GOOGLE_API_KEY"); k != "" {
			apiKey = k
			authSource = "env:GOOGLE_API_KEY"
		}
	}

	if strings.HasPrefix(apiURL, "local://") {
		providerMode = "local_http_agent_loop"
		if envURL := os.Getenv("AI_API_URL"); envURL != "" && strings.HasPrefix(envURL, "http") {
			apiURL = envURL
		} else {
			apiURL = "http://127.0.0.1:8000/v1"
		}
	}

	if apiKey == "" && (strings.Contains(apiURL, "localhost") || strings.Contains(apiURL, "127.0.0.1") || strings.Contains(apiURL, "0.0.0.0")) {
		apiKey = "local-tendon"
		authSource = "local_placeholder"
	}
	if apiKey == "" {
		authSource = "none"
	}

	if strings.Contains(apiURL, "shuffler.io") || strings.Contains(apiURL, "shuffle") {
		cleanUrl := resolveShuffleAiBaseURL(apiURL)
		b.mu.Lock()
		if b.cfg != nil {
			b.cfg.BaseURL = cleanUrl
			if apiKey != "" {
				b.cfg.Auth = apiKey
			}
		}
		b.mu.Unlock()
	}

	if orgID != "" {
		_ = os.Setenv("ORG", orgID)
		_ = os.Setenv("ORG_ID", orgID)
		_ = os.Setenv("SHUFFLE_ORG_ID", orgID)
	}

	// Point SHUFFLE_BASE_URL to local loopback during standalone agent execution so internal /api/v1/streams callbacks return in <1ms
	prevShuffleBaseURL := os.Getenv("SHUFFLE_BASE_URL")
	if loopbackURL != "" {
		_ = os.Setenv("SHUFFLE_BASE_URL", loopbackURL)
		defer func() {
			if prevShuffleBaseURL != "" {
				_ = os.Setenv("SHUFFLE_BASE_URL", prevShuffleBaseURL)
			} else {
				_ = os.Unsetenv("SHUFFLE_BASE_URL")
			}
		}()
	}

	maskedKey := "none"
	if len(apiKey) > 8 {
		maskedKey = apiKey[:4] + "..." + apiKey[len(apiKey)-4:]
	} else if apiKey != "" {
		maskedKey = "***"
	}

	sysPrompt := BuildInjectedSystemPrompt(project)

	var historyBlock string
	historyCount := 0
	summarizedCount := 0
	reusedSummary := false
	updatedSummary := false
	if convID != "" {
		if existingConv, errConv := LoadConversation(convID); errConv == nil && existingConv != nil {
			var llmSummarizer func(existingSummary, batchTranscript string) (string, error)
			if !isLocalRequest && !isShuffleKey && apiURL != "" && apiKey != "" && apiKey != "local-tendon" &&
				!strings.Contains(apiURL, "shuffler.io") && !strings.Contains(apiURL, "anthropic.com") {
				llmSummarizer = func(existingSummary, batchTranscript string) (string, error) {
					return summarizeConversationBatchOpenAI(apiURL, apiKey, model, existingSummary, batchTranscript)
				}
			}
			historyBlock, historyCount, summarizedCount, reusedSummary, updatedSummary = BuildConversationHistoryContext(existingConv, llmSummarizer)
			if updatedSummary {
				log.Printf("[INFO][%s] Updated rolling conversation summary for %s (summarized_turns=%d, summary_chars=%d)",
					execID, convID, summarizedCount, len(existingConv.Summary))
			} else if reusedSummary {
				log.Printf("[INFO][%s] Reused cached conversation summary for %s (summarized_turns=%d, recent_turns=%d)",
					execID, convID, summarizedCount, historyCount)
			}
		}
	}

	var fullAgentInput strings.Builder
	fullAgentInput.WriteString(sysPrompt)
	projectFolders := b.GetProjectFolders(project)
	if len(projectFolders) > 0 {
		fullAgentInput.WriteString(fmt.Sprintf("\n\nPRIMARY PROJECT FOLDERS (Active Workspace Paths - %d/%d attached):\n", len(projectFolders), MaxProjectFolders))
		for idx, folderPath := range projectFolders {
			roleLabel := "Attached Primary Folder"
			if idx == 0 {
				roleLabel = "Primary Project Root / Working Directory"
			}
			fullAgentInput.WriteString(fmt.Sprintf("%d. %s (%s)\n", idx+1, folderPath, roleLabel))
		}
		if len(projectFolders) > 1 {
			fullAgentInput.WriteString("You are working in a multi-folder project. All of the folders listed above are your primary workspace paths that you should work within.\n")
			for _, extraFolder := range projectFolders[1:] {
				if extraPrompt := BuildInjectedSystemPrompt(extraFolder); strings.TrimSpace(extraPrompt) != "" && extraPrompt != sysPrompt {
					fullAgentInput.WriteString(fmt.Sprintf("\n<!-- PROJECT RULES FROM ATTACHED FOLDER: %s -->\n%s\n", extraFolder, extraPrompt))
				}
			}
		}
	}
	fullAgentInput.WriteString("\n\nIMPORTANT QUESTION RULE: Whenever you use the `ask` or `question` action to ask the user a question, you MUST also populate the `options` field with 1 to 3 short, concrete, directly applicable suggested answers tailored to your exact question (formatted as a JSON array or `|`-separated list). Never use generic filler like 'Yes, proceed'; the UI automatically provides a 'Custom...' answer option.\n\n")
	if strings.TrimSpace(historyBlock) != "" {
		fullAgentInput.WriteString("Previous conversation context:\n")
		fullAgentInput.WriteString(historyBlock)
		fullAgentInput.WriteString("\n")
	}
	if strings.TrimSpace(fileContextBlock) != "" {
		fullAgentInput.WriteString("Attached File Context:\n")
		fullAgentInput.WriteString(fileContextBlock)
		fullAgentInput.WriteString("\n\n")
	}
	fullAgentInput.WriteString("User Request:\n")
	effectiveUserPrompt := strings.TrimSpace(prompt)
	if effectiveUserPrompt == "" && (len(imageURIs) > 0 || strings.TrimSpace(fileContextBlock) != "") {
		effectiveUserPrompt = "Please examine and respond to the attached content."
	}
	fullAgentInput.WriteString(effectiveUserPrompt)
	agentInputStr := fullAgentInput.String()

	log.Printf("[INFO][%s] AI Agent Loop Dispatch Summary:\n"+
		"  -> Provider Mode    : %s (activeExecutionMode=%q, oauthLoggedIn=%v)\n"+
		"  -> Model Resolution : requested=%q -> resolved=%q (reasoning=%q)\n"+
		"  -> Endpoint URL     : %s\n"+
		"  -> Auth Credential  : source=%s, key=%s, org=%q\n"+
		"  -> Payload Metrics  : system_prompt=%d chars, user_prompt=%d chars, images=%d, file_context=%d chars, history_turns=%d (summarized_turns=%d, reused_summary=%v, updated_summary=%v), conv_id=%q, project=%q",
		execID, providerMode, activeMode, oauthActive,
		requestedModel, model, reasoning,
		apiURL,
		authSource, maskedKey, orgID,
		len(sysPrompt), len(prompt), len(imageURIs), len(fileContextBlock), historyCount, summarizedCount, reusedSummary, updatedSummary, convID, project)

	agentExecUUID := makeAgentUUID(1)
	actionUUID := makeAgentUUID(2)

	nodeParams := []shuffle.WorkflowAppActionParameter{
		{Name: "input", Value: agentInputStr},
		{Name: "action", Value: "subflow:osctrl"},
		{Name: "execution_mode", Value: "direct"},
		{Name: "enable_questions", Value: "true"},
		{Name: "shuffle_ai_url_override", Value: apiURL},
		{Name: "shuffle_ai_apikey_override", Value: apiKey},
		{Name: "shuffle_ai_model_override", Value: model},
		{Name: "shuffle_ai_reasoning_effort_override", Value: reasoning},
	}
	if orgID != "" {
		nodeParams = append(nodeParams,
			shuffle.WorkflowAppActionParameter{Name: "org_id", Value: orgID},
			shuffle.WorkflowAppActionParameter{Name: "shuffle_org_id", Value: orgID},
		)
	}
	for _, imgURI := range imageURIs {
		if strings.TrimSpace(imgURI) != "" {
			nodeParams = append(nodeParams, shuffle.WorkflowAppActionParameter{
				Name:  "image",
				Value: strings.TrimSpace(imgURI),
			})
		}
	}

	startNode := shuffle.Action{
		ID:         actionUUID,
		AppName:    "AI Agent",
		Name:       "agent",
		Label:      "agent",
		Parameters: nodeParams,
	}

	exec := shuffle.WorkflowExecution{
		Type:              "AGENT",
		Start:             startNode.ID,
		Status:            "EXECUTING",
		ExecutionId:       agentExecUUID,
		WorkflowId:        agentExecUUID,
		Authorization:     "standalone-agent-auth",
		ExecutionOrg:      orgID,
		StartedAt:         time.Now().Unix(),
		ExecutionArgument: prompt,
		Workflow: shuffle.Workflow{
			ID:      agentExecUUID,
			Name:    "Orborus Agent Loop",
			Start:   startNode.ID,
			OrgId:   orgID,
			Actions: []shuffle.Action{startNode},
		},
	}

	actionCacheId := fmt.Sprintf("%s_%s_result", exec.ExecutionId, startNode.ID)
	const maxAgentTurns = 15
	processedDecisions := make(map[string]bool)
	questionsDisabled := false
	userStoppedQuestions := false
	var finalOutput string
	var cumulativeOutput strings.Builder
	var lastAgentOutput shuffle.AgentOutput
	defer func() {
		if execID != "" {
			b.mu.Lock()
			if b.execApprovalDecisions != nil {
				delete(b.execApprovalDecisions, execID)
			}
			b.mu.Unlock()
		}
	}()

	for turn := 0; turn < maxAgentTurns; turn++ {
		ctx = b.GetExecutionContext(execID, ctx)
		select {
		case <-b.UserCancelChan(execID):
			exec.Status = "ABORTED"
			exec.CompletedAt = time.Now().Unix()
			return finalOutput, &exec, context.Canceled
		default:
		}
		if err := ctx.Err(); err != nil {
			ctx, _ = b.RefreshExecutionContext(execID, 600*time.Second)
		}

		// Sync any attached Shuffle remote tools for this conversation on every turn
		// so tools attached/detached while the agent is running take effect immediately.
		b.syncTurnShuffleTools(ctx, convID, &startNode, &exec)

		createNextActions := turn > 0
		log.Printf("[INFO][%s] AI Agent Loop Turn %d/%d invoking shuffle.HandleAiAgentExecutionStart (createNextActions=%v, execUUID=%s)",
			execID, turn+1, maxAgentTurns, createNextActions, exec.ExecutionId)

		if turn > 0 {
			b.StreamChunk(execID, fmt.Sprintf("\nAnalyzing step results (Turn %d)...\n", turn+1), true)
		}

		// Run HandleAiAgentExecutionStart in a goroutine with periodic progress heartbeats,
		// context cancellation support, and a per-turn timeout so it never hangs silently.
		type agentStepResult struct {
			err error
		}
		turnEmittedReasoning := turn > 0
		stepDone := make(chan agentStepResult, 1)
		stepStart := time.Now()
		go func(turnExec shuffle.WorkflowExecution, turnNode shuffle.Action, nextActs bool) {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("[ERROR][%s] Panic recovered in HandleAiAgentExecutionStart: %v\n%s", execID, r, string(debug.Stack()))
					stepDone <- agentStepResult{err: fmt.Errorf("agent step runtime error: %v", r)}
				}
			}()
			_, err := shuffle.HandleAiAgentExecutionStart(turnExec, turnNode, nextActs, "orborus-agent-loop")
			stepDone <- agentStepResult{err: err}
		}(exec, startNode, createNextActions)

		var agentErr error
		heartbeatTicker := time.NewTicker(2 * time.Second)
		turnTimeout := time.NewTimer(180 * time.Second)
	waitAgentStep:
		for {
			select {
			case res := <-stepDone:
				agentErr = res.err
				break waitAgentStep
			case <-b.UserCancelChan(execID):
				heartbeatTicker.Stop()
				turnTimeout.Stop()
				exec.Status = "ABORTED"
				exec.CompletedAt = time.Now().Unix()
				return finalOutput, &exec, context.Canceled
			case <-ctx.Done():
				heartbeatTicker.Stop()
				turnTimeout.Stop()
				exec.Status = "ABORTED"
				exec.CompletedAt = time.Now().Unix()
				return finalOutput, &exec, ctx.Err()
			case <-turnTimeout.C:
				heartbeatTicker.Stop()
				agentErr = fmt.Errorf("AI backend timed out after 180s on turn %d (no response from provider %s / model %s)", turn+1, providerMode, model)
				break waitAgentStep
			case <-heartbeatTicker.C:
				elapsedSec := int(time.Since(stepStart).Seconds())
				if elapsedSec > 0 && elapsedSec%10 == 0 {
					log.Printf("[INFO][%s] AI Agent Loop Turn %d/%d waiting on %s / %s (%ds elapsed)...",
						execID, turn+1, maxAgentTurns, providerMode, model, elapsedSec)
				}
			}
		}
		heartbeatTicker.Stop()
		turnTimeout.Stop()

		// Retrieve the AgentOutput written by HandleAiAgentExecutionStart into shuffle cache
		var turnAgentOutput shuffle.AgentOutput
		hasOutput := false
		if cachedRaw, cacheErr := shuffle.GetCache(ctx, actionCacheId); cacheErr == nil && cachedRaw != nil {
			var rawBytes []byte
			switch v := cachedRaw.(type) {
			case []byte:
				rawBytes = v
			case string:
				rawBytes = []byte(v)
			}
			if len(rawBytes) > 0 {
				if jsonErr := json.Unmarshal(rawBytes, &turnAgentOutput); jsonErr == nil {
					if len(turnAgentOutput.Decisions) > 0 || strings.TrimSpace(turnAgentOutput.Output) != "" || turnAgentOutput.Status != "" {
						hasOutput = true
					}
				}
			}
		}

		if !hasOutput && len(exec.Results) > 0 {
			for _, r := range exec.Results {
				if r.Action.ID == startNode.ID && strings.TrimSpace(r.Result) != "" {
					if jsonErr := json.Unmarshal([]byte(r.Result), &turnAgentOutput); jsonErr == nil {
						if len(turnAgentOutput.Decisions) > 0 || strings.TrimSpace(turnAgentOutput.Output) != "" {
							hasOutput = true
						}
					}
				}
			}
		}

		if !hasOutput {
			if agentErr != nil {
				exec.Status = "FAILURE"
				exec.CompletedAt = time.Now().Unix()
				exec.Result = agentErr.Error()
				log.Printf("[ERROR][%s] AI Agent Loop failed on turn %d: %v", execID, turn+1, agentErr)
				return finalOutput, &exec, agentErr
			}
			if turn == 0 && strings.TrimSpace(finalOutput) == "" {
				emptyErr := fmt.Errorf("AI backend (%s / %s) returned an empty response or disconnected before completing", providerMode, model)
				exec.Status = "FAILURE"
				exec.CompletedAt = time.Now().Unix()
				exec.Result = emptyErr.Error()
				log.Printf("[ERROR][%s] %v", execID, emptyErr)
				return "", &exec, emptyErr
			}
			break
		}

		lastAgentOutput = turnAgentOutput
		log.Printf("[INFO][%s] AI Agent Loop Turn %d produced status=%q, decisions=%d, output_len=%d",
			execID, turn+1, lastAgentOutput.Status, len(lastAgentOutput.Decisions), len(lastAgentOutput.Output))

		finished := false
		toolsRunInTurn := 0

		for i := range lastAgentOutput.Decisions {
			dec := &lastAgentOutput.Decisions[i]
			if strings.EqualFold(dec.RunDetails.Status, "FINISHED") || dec.RunDetails.CompletedAt > 0 {
				if dec.RunDetails.Id != "" {
					processedDecisions[dec.RunDetails.Id] = true
				}
				continue
			}
			decKey := dec.RunDetails.Id
			if decKey == "" {
				decKey = fmt.Sprintf("dec-idx-%d-%s-%d", i, strings.ToLower(strings.TrimSpace(dec.Action)), len(strings.TrimSpace(dec.Reason)))
				dec.RunDetails.Id = decKey
			}
			if processedDecisions[decKey] {
				continue
			}
			processedDecisions[decKey] = true

			actLower := strings.ToLower(strings.TrimSpace(dec.Action))
			catLower := strings.ToLower(strings.TrimSpace(dec.Category))
			toolLower := strings.ToLower(strings.TrimSpace(dec.Tool))
			isAskDecision := actLower == "ask" || actLower == "question" || catLower == "ask" || toolLower == "ask"

			// Circuit breaker: if questions were already asked/disabled in this turn (or user stopped/skipped questions),
			// never pause or prompt the user with another question loop.
			if isAskDecision && questionsDisabled {
				log.Printf("[INFO][%s] Suppressing repeat ask decision on turn %d (questionsDisabled=true, userStoppedQuestions=%v)",
					execID, turn+1, userStoppedQuestions)
				nowMs := time.Now().UnixMilli()
				if dec.RunDetails.StartedAt == 0 {
					dec.RunDetails.StartedAt = nowMs
				}
				dec.RunDetails.CompletedAt = nowMs
				dec.RunDetails.Status = "FINISHED"
				dec.RunDetails.RawResponse = "Questions disabled for remainder of turn."
				if finalOutput == "" || IsGenericPlaceholderOutput(finalOutput) {
					if userStoppedQuestions {
						finalOutput = "Understood — I'll stop asking questions. Let me know how you'd like to proceed."
					}
				}
				finished = true
				break
			}

			if strings.TrimSpace(dec.Reason) != "" {
				b.StreamChunk(execID, fmt.Sprintf("• %s\n", strings.TrimSpace(dec.Reason)), true)
				turnEmittedReasoning = true
			}

			// Check if the agent decided to ask the user a question interactively
			if isAskDecision {
				stepStartMs := time.Now().UnixMilli()
				if dec.RunDetails.StartedAt == 0 {
					dec.RunDetails.StartedAt = stepStartMs
				}
				questions, options, qReason := extractQuestionsAndOptionsFromDecision(*dec, lastAgentOutput)
				userAnswer, answered, qErr := b.requestInFlightQuestion(ctx, execID, convID, project, qReason, questions, options)
				ctx = b.GetExecutionContext(execID, ctx)
				if qErr != nil {
					if errors.Is(qErr, context.Canceled) {
						exec.Status = "ABORTED"
						exec.CompletedAt = time.Now().Unix()
						return finalOutput, &exec, context.Canceled
					}
					userAnswer = fmt.Sprintf("(User did not provide an answer: %v)", qErr)
				}
				if !answered && strings.TrimSpace(userAnswer) == "" {
					userAnswer = "No, skip this (User skipped the question — do not ask any further questions)"
				}

				updatedQuestionField := false
				for fi := range dec.Fields {
					fk := strings.ToLower(strings.TrimSpace(dec.Fields[fi].Key))
					if fk == "question" || fk == "questions" || fk == "ask" || fk == "prompt" || fk == "query" {
						dec.Fields[fi].Answer = userAnswer
						updatedQuestionField = true
					}
				}
				if !updatedQuestionField {
					if len(dec.Fields) == 0 {
						_ = json.Unmarshal([]byte(`[{}]`), &dec.Fields)
					}
					if len(dec.Fields) > 0 {
						if strings.TrimSpace(dec.Fields[0].Key) == "" {
							dec.Fields[0].Key = "question"
						}
						if strings.TrimSpace(dec.Fields[0].Value) == "" {
							dec.Fields[0].Value = strings.Join(questions, "\n")
						}
						dec.Fields[0].Answer = userAnswer
					}
				}

				nowMs := time.Now().UnixMilli()
				dec.RunDetails.CompletedAt = nowMs
				dec.RunDetails.Status = "FINISHED"
				dec.RunDetails.RawResponse = fmt.Sprintf("Question asked: %s\nUser Answer: %s", strings.Join(questions, " "), userAnswer)

				if isStopOrSkipQuestionResponse(userAnswer, answered) {
					userStoppedQuestions = true
					questionsDisabled = true
				} else if !userRequestedAnotherQuestion(userAnswer) {
					questionsDisabled = true
				}

				updateAgentNodeAfterQuestion(&startNode, &exec, questions, userAnswer, questionsDisabled, userStoppedQuestions)

				if dec.RunDetails.Id != "" {
					if decBytes, mErr := json.Marshal(*dec); mErr == nil {
						perDecCacheKey := fmt.Sprintf("agent-%s-%s", exec.ExecutionId, dec.RunDetails.Id)
						_ = shuffle.SetCache(ctx, perDecCacheKey, decBytes, 3600)
					}
				}

				// If the user explicitly commanded to stop asking questions (e.g. "stop asking questions", "STOP!"),
				// conclude immediately instead of running another LLM turn.
				if isHardStopQuestionCommand(userAnswer) {
					log.Printf("[INFO][%s] User issued hard stop for questions (%q); concluding agent loop immediately", execID, userAnswer)
					if finalOutput == "" || IsGenericPlaceholderOutput(finalOutput) {
						finalOutput = "Understood — I'll stop asking questions. Let me know what you'd like to do next."
					}
					finished = true
					break
				}

				toolsRunInTurn++
				continue
			}

			// Check if the agent decided to finish
			if actLower == "finish" || catLower == "finish" || toolLower == "finish" {
				ans := extractDecisionAnswerText(*dec, lastAgentOutput)
				if ans != "" && !IsGenericPlaceholderOutput(ans) {
					finalOutput = ans
				} else if strings.TrimSpace(dec.Reason) != "" && !IsGenericPlaceholderOutput(dec.Reason) {
					finalOutput = strings.TrimSpace(dec.Reason)
				} else if ans != "" && finalOutput == "" {
					finalOutput = ans
				}
				nowMs := time.Now().UnixMilli()
				if dec.RunDetails.StartedAt == 0 {
					dec.RunDetails.StartedAt = nowMs
				}
				dec.RunDetails.CompletedAt = nowMs
				dec.RunDetails.Status = "FINISHED"
				if dec.RunDetails.RawResponse == "" {
					dec.RunDetails.RawResponse = finalOutput
				}
				finished = true
				break
			}

			// Execute remote Shuffle app tool, native OS tool, or shell command via osctrl
			stepStartMs := time.Now().UnixMilli()
			dec.RunDetails.StartedAt = stepStartMs

			if matchedTool, _, _, resolvedActName := b.matchAttachedShuffleTool(convID, dec); matchedTool != nil {
				b.StreamChunk(execID, fmt.Sprintf("Running Shuffle app `%s`: `%s`\n", matchedTool.AppName, resolvedActName), true)
			} else {
				cmdPreview := extractCommandFromDecision(*dec)
				if cmdPreview != "" {
					firstLine := strings.Split(strings.TrimSpace(cmdPreview), "\n")[0]
					if len(firstLine) > 80 {
						firstLine = firstLine[:77] + "..."
					}
					b.StreamChunk(execID, fmt.Sprintf("Running command: `%s`\n", firstLine), true)
				} else if strings.TrimSpace(dec.Action) != "" {
					b.StreamChunk(execID, fmt.Sprintf("Running OS action: `%s`\n", strings.TrimSpace(dec.Action)), true)
				}
			}

			decLabel, cmdOut, executed, cmdErr := b.executeAgentDecision(ctx, dec, project, execID, convID)
			// Retrieve recreated context in case executeAgentDecision paused for user approval
			ctx = b.GetExecutionContext(execID, ctx)
			if executed {
				rawResp := strings.TrimSpace(cmdOut)
				if cmdErr != nil {
					if rawResp == "" {
						rawResp = fmt.Sprintf("Command failed with error: %v", cmdErr)
					} else {
						rawResp = fmt.Sprintf("%s\n[Exit error: %v]", rawResp, cmdErr)
					}
					if strings.Contains(strings.ToLower(cmdErr.Error()), "denied by user") {
						deniedTarget := strings.TrimSpace(extractCommandFromDecision(*dec))
						if deniedTarget == "" {
							deniedTarget = strings.TrimSpace(decLabel)
						}
						if deniedTarget == "" {
							deniedTarget = strings.TrimSpace(dec.Action)
						}
						updateAgentNodeAfterCommandDenial(&startNode, &exec, deniedTarget, cmdErr.Error())
					}
				}
				if rawResp == "" {
					rawResp = "(Command completed successfully with no stdout output)"
				}

				preview := strings.ReplaceAll(strings.ReplaceAll(rawResp, "\n", " "), "\r", "")
				if len(preview) > 120 {
					preview = preview[:120] + "..."
				}
				b.StreamChunk(execID, fmt.Sprintf("Output: %s\n", preview), true)

				dec.RunDetails.CompletedAt = time.Now().UnixMilli()
				dec.RunDetails.Status = "FINISHED"
				dec.RunDetails.RawResponse = rawResp
				toolsRunInTurn++

				// If the agent just took a screenshot, inject the captured image(s) as image parameters
				// on startNode so the LLM can visually inspect the screenshot(s) in the next turn.
				if actLower == "take_screenshot" || actLower == "screenshot" {
					capturedImgs := extractScreenshotsFromToolOutput(rawResp)
					if len(capturedImgs) > 0 {
						for _, img := range capturedImgs {
							dataURI, _ := img["data_uri"].(string)
							if dataURI != "" {
								imgParam := shuffle.WorkflowAppActionParameter{
									Name:  "image",
									Value: dataURI,
								}
								startNode.Parameters = append(startNode.Parameters, imgParam)
								if len(exec.Workflow.Actions) > 0 {
									exec.Workflow.Actions[0].Parameters = append(exec.Workflow.Actions[0].Parameters, imgParam)
								}
							}
						}
					}
				}
			} else {
				// Non-command reasoning/analysis decision
				dec.RunDetails.CompletedAt = time.Now().UnixMilli()
				dec.RunDetails.Status = "FINISHED"
				if dec.RunDetails.RawResponse == "" {
					dec.RunDetails.RawResponse = dec.Reason
				}
				if strings.TrimSpace(dec.Reason) != "" && !IsGenericPlaceholderOutput(dec.Reason) {
					if cumulativeOutput.Len() > 0 {
						cumulativeOutput.WriteString("\n\n")
					}
					cumulativeOutput.WriteString(strings.TrimSpace(dec.Reason))
				}
			}

			if dec.RunDetails.Id != "" {
				if decBytes, mErr := json.Marshal(*dec); mErr == nil {
					_ = shuffle.SetCache(ctx, fmt.Sprintf("agent-%s-%s", exec.ExecutionId, dec.RunDetails.Id), decBytes, 3600)
				}
			}
		}

		turnOnlyAskedQuestion := false
		if len(lastAgentOutput.Decisions) > 0 {
			allAsk := true
			for _, d := range lastAgentOutput.Decisions {
				al := strings.ToLower(strings.TrimSpace(d.Action))
				cl := strings.ToLower(strings.TrimSpace(d.Category))
				tl := strings.ToLower(strings.TrimSpace(d.Tool))
				if al != "ask" && al != "question" && cl != "ask" && tl != "ask" {
					allAsk = false
					break
				}
			}
			turnOnlyAskedQuestion = allAsk
		}

		if !turnOnlyAskedQuestion && strings.TrimSpace(lastAgentOutput.Output) != "" && !IsGenericPlaceholderOutput(lastAgentOutput.Output) && (finalOutput == "" || IsGenericPlaceholderOutput(finalOutput)) {
			finalOutput = strings.TrimSpace(lastAgentOutput.Output)
		}

		// Persist updated AgentOutput into exec.Results and cache for the next turn
		if finished || (lastAgentOutput.Status == "FINISHED" && toolsRunInTurn == 0) {
			lastAgentOutput.Status = "FINISHED"
		} else if toolsRunInTurn > 0 {
			lastAgentOutput.Status = "WAITING"
		}

		if turnEmittedReasoning || toolsRunInTurn > 0 {
			turnDurSec := time.Since(stepStart).Seconds()
			if turnDurSec < 0.1 {
				turnDurSec = 0.1
			}
			b.StreamChunk(execID, fmt.Sprintf("[Turn %d completed in %.1fs]\n", turn+1, turnDurSec), true)
		}

		updatedAgentBytes, _ := json.Marshal(lastAgentOutput)
		_ = shuffle.SetCache(ctx, actionCacheId, updatedAgentBytes, 3600)

		actionResult := shuffle.ActionResult{
			Action:      startNode,
			ExecutionId: exec.ExecutionId,
			Result:      string(updatedAgentBytes),
			Status:      lastAgentOutput.Status,
		}
		if len(exec.Results) == 0 {
			exec.Results = []shuffle.ActionResult{actionResult}
		} else {
			replaced := false
			for idx := range exec.Results {
				if exec.Results[idx].Action.ID == startNode.ID {
					exec.Results[idx] = actionResult
					replaced = true
					break
				}
			}
			if !replaced {
				exec.Results = append(exec.Results, actionResult)
			}
		}

		if finished || toolsRunInTurn == 0 {
			break
		}
	}

	if IsGenericPlaceholderOutput(finalOutput) {
		if strings.TrimSpace(lastAgentOutput.Output) != "" && !IsGenericPlaceholderOutput(lastAgentOutput.Output) && !userStoppedQuestions {
			finalOutput = strings.TrimSpace(lastAgentOutput.Output)
		} else if cumulativeOutput.Len() > 0 && !IsGenericPlaceholderOutput(cumulativeOutput.String()) {
			finalOutput = cumulativeOutput.String()
		} else if len(lastAgentOutput.Decisions) > 0 {
			// Search non-ask decisions in reverse order for a substantive answer or reason
			for idx := len(lastAgentOutput.Decisions) - 1; idx >= 0; idx-- {
				d := lastAgentOutput.Decisions[idx]
				al := strings.ToLower(strings.TrimSpace(d.Action))
				cl := strings.ToLower(strings.TrimSpace(d.Category))
				tl := strings.ToLower(strings.TrimSpace(d.Tool))
				if al == "ask" || al == "question" || cl == "ask" || tl == "ask" {
					continue
				}
				candidate := extractDecisionAnswerText(d, lastAgentOutput)
				if candidate != "" && !IsGenericPlaceholderOutput(candidate) {
					finalOutput = candidate
					break
				}
				if r := strings.TrimSpace(d.Reason); r != "" && !IsGenericPlaceholderOutput(r) {
					finalOutput = r
					break
				}
			}
			if strings.TrimSpace(finalOutput) == "" {
				if userStoppedQuestions {
					finalOutput = "Understood — I'll stop asking questions. Let me know how you'd like to proceed."
				} else {
					lastDec := lastAgentOutput.Decisions[len(lastAgentOutput.Decisions)-1]
					finalOutput = extractDecisionAnswerText(lastDec, lastAgentOutput)
				}
			}
		}
	}

	if strings.TrimSpace(finalOutput) != "" {
		b.StreamChunk(execID, finalOutput, false)
	}

	lastAgentOutput.Status = "FINISHED"
	if lastAgentOutput.Output == "" || IsGenericPlaceholderOutput(lastAgentOutput.Output) {
		lastAgentOutput.Output = finalOutput
	}
	finalAgentBytes, _ := json.Marshal(lastAgentOutput)

	exec.CompletedAt = time.Now().Unix()
	exec.Status = "FINISHED"
	exec.Result = finalOutput
	finalActionResult := shuffle.ActionResult{
		Action:      startNode,
		ExecutionId: exec.ExecutionId,
		Result:      string(finalAgentBytes),
		Status:      "SUCCESS",
	}
	if len(exec.Results) == 0 {
		exec.Results = []shuffle.ActionResult{finalActionResult}
	} else {
		exec.Results[0] = finalActionResult
	}

	totalElapsed := time.Since(reqStart).Round(time.Millisecond)
	respPreview := strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(finalOutput), "\n", " "), "\r", "")
	if len(respPreview) > 120 {
		respPreview = respPreview[:120] + "..."
	}
	log.Printf("[INFO][%s] AI Agent Loop Completed in %v (provider=%s, model=%s, decisions=%d, total_output_bytes=%d) | preview: %q",
		execID, totalElapsed, providerMode, model, len(lastAgentOutput.Decisions), len(finalOutput), respPreview)

	return finalOutput, &exec, nil
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

	catalogStatus, diskInfo := BuildLocalModelCatalogStatus(absDir, activePath)

	resp, _ := json.Marshal(map[string]interface{}{
		"status":            "ok",
		"directory":         absDir,
		"active_model_path": activePath,
		"models":            models,
		"count":             len(models),
		"catalog":           catalogStatus,
		"free_disk_bytes":   diskInfo.FreeBytes,
		"free_disk_gb":      diskInfo.FreeGB,
		"free_disk_display": diskInfo.FreeDisplay,
		"download_state":    GlobalModelDownloader.GetState(),
	})
	return string(resp)
}

// GetLocalModelCatalogStatus returns the built-in local models catalog with disk installation & free space status.
func (b *AgentBridge) GetLocalModelCatalogStatus(directory string) string {
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

	catalogStatus, diskInfo := BuildLocalModelCatalogStatus(targetDir, activePath)
	resp, _ := json.Marshal(map[string]interface{}{
		"status":            "ok",
		"directory":         diskInfo.Path,
		"active_model_path": activePath,
		"catalog":           catalogStatus,
		"free_disk_bytes":   diskInfo.FreeBytes,
		"free_disk_gb":      diskInfo.FreeGB,
		"free_disk_display": diskInfo.FreeDisplay,
		"download_state":    GlobalModelDownloader.GetState(),
	})
	return string(resp)
}

// StartLocalModelDownload begins downloading a catalog model into the models directory after verifying disk space.
func (b *AgentBridge) StartLocalModelDownload(modelKey string, directory string) string {
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
	b.mu.Unlock()

	st, err := GlobalModelDownloader.StartDownload(modelKey, targetDir)
	if err != nil {
		resp, _ := json.Marshal(map[string]interface{}{
			"status":         "error",
			"error":          err.Error(),
			"download_state": st,
		})
		return string(resp)
	}

	// If already completed on disk, update active localModelPath
	if st.Status == "completed" && st.TargetPath != "" {
		b.SetLocalModelPath(st.TargetPath)
	}

	resp, _ := json.Marshal(map[string]interface{}{
		"status":         "ok",
		"download_state": st,
	})
	return string(resp)
}

// CancelLocalModelDownload cancels any active GGUF model download.
func (b *AgentBridge) CancelLocalModelDownload() string {
	st := GlobalModelDownloader.CancelDownload()
	resp, _ := json.Marshal(map[string]interface{}{
		"status":         "ok",
		"download_state": st,
	})
	return string(resp)
}

// GetLocalDownloadStatus returns the current GGUF download state and disk space info.
func (b *AgentBridge) GetLocalDownloadStatus() string {
	b.mu.Lock()
	targetDir := b.localModelsDir
	activePath := b.localModelPath
	b.mu.Unlock()
	if targetDir == "" {
		targetDir = "models"
	}
	catalogStatus, diskInfo := BuildLocalModelCatalogStatus(targetDir, activePath)
	resp, _ := json.Marshal(map[string]interface{}{
		"status":            "ok",
		"download_state":    GlobalModelDownloader.GetState(),
		"catalog":           catalogStatus,
		"free_disk_bytes":   diskInfo.FreeBytes,
		"free_disk_gb":      diskInfo.FreeGB,
		"free_disk_display": diskInfo.FreeDisplay,
	})
	return string(resp)
}

// HandleAction dispatches incoming actions from the WebKit/UI bridge
func (b *AgentBridge) HandleAction(action string, payload string) (res string) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[ERROR] Recovered from panic in AgentBridge.HandleAction: %v\n%s", r, string(debug.Stack()))
			res = fmt.Sprintf(`{"status":"error","error":%q,"error_type":"execution_error","fix_help":"Internal runtime panic: %v"}`, fmt.Sprintf("Internal runtime error: %v", r), r)
		}
	}()

	isDebug := strings.EqualFold(os.Getenv("DEBUG"), "true") || os.Getenv("DEBUG") == "1" ||
		(b != nil && b.GetConfig() != nil && b.GetConfig().Debug)
	if isDebug {
		log.Printf("[DEBUG] HandleAction: %s (payload: %s)", action, payload)
	}

	action = strings.TrimSpace(action)

	switch action {
	case "getInitialState", "getState":
		return b.GetInitialState()

	case "listProjects":
		return b.ListProjects()

	case "selectProject", "openOrSelectDirectory":
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

	case "quickStartProject":
		var req struct {
			BaseDir string `json:"base_dir"`
			Path    string `json:"path"`
		}
		_ = json.Unmarshal([]byte(payload), &req)
		baseDir := strings.TrimSpace(req.BaseDir)
		if baseDir == "" {
			baseDir = strings.TrimSpace(req.Path)
		}
		if baseDir == "" && strings.TrimSpace(payload) != "" && !strings.HasPrefix(strings.TrimSpace(payload), "{") {
			baseDir = strings.TrimSpace(payload)
		}
		return b.QuickStartProject(baseDir)

	case "setPermissionPolicy":
		return b.SetPermissionPolicy(payload)

	case "runPrompt":
		var req struct {
			Prompt         string                `json:"prompt"`
			Bypass         bool                  `json:"bypass"`
			ConversationID string                `json:"conversation_id"`
			Model          string                `json:"model"`
			Reasoning      string                `json:"reasoning"`
			Attachments    []AttachmentInput     `json:"attachments"`
			ShuffleTools   []ShuffleAttachedTool `json:"shuffle_tools"`
			HasToolsField  *bool                 `json:"has_shuffle_tools"`
			ShuffleSkills  []string              `json:"shuffle_skills"`
			HasSkillsField *bool                 `json:"has_shuffle_skills"`
			AiApiKey       string                `json:"ai_api_key"`
			AiApiUrl       string                `json:"ai_api_url"`
		}
		if err := json.Unmarshal([]byte(payload), &req); err != nil {
			req.Prompt = payload
		}
		if req.ShuffleTools != nil || (req.HasToolsField != nil && *req.HasToolsField) {
			b.SetConversationShuffleToolsList(req.ConversationID, req.ShuffleTools)
		}
		if req.ShuffleSkills != nil || (req.HasSkillsField != nil && *req.HasSkillsField) {
			b.SetConversationShuffleSkillsList(req.ConversationID, req.ShuffleSkills)
		}
		log.Printf("[INFO] AgentBridge.HandleAction \"runPrompt\": prompt=%q, model=%q, reasoning=%q, convID=%q, attachments=%d, shuffleTools=%d, shuffleSkills=%d, keyPresent=%v, url=%q",
			req.Prompt, req.Model, req.Reasoning, req.ConversationID, len(req.Attachments), len(req.ShuffleTools), len(req.ShuffleSkills), req.AiApiKey != "", req.AiApiUrl)
		b.mu.Lock()
		isShuffleRun := req.Model == "shuffle-ai" || req.Model == "shuffle" || b.activeExecutionMode == "shuffle"
		if req.AiApiKey != "" {
			trimmedKey := strings.TrimSpace(req.AiApiKey)
			if !isShuffleRun || strings.HasPrefix(trimmedKey, "shfl_") {
				b.aiApiKey = trimmedKey
				if b.cfg != nil && (strings.Contains(b.aiApiUrl, "shuffler.io") || strings.Contains(b.aiApiUrl, "shuffle") || isShuffleRun) {
					b.cfg.Auth = b.aiApiKey
				}
			}
		}
		if req.AiApiUrl != "" {
			trimmedUrl := strings.TrimSpace(req.AiApiUrl)
			if !isShuffleRun || strings.Contains(strings.ToLower(trimmedUrl), "shuffler.io") {
				b.aiApiUrl = trimmedUrl
				if strings.Contains(strings.ToLower(b.aiApiUrl), "shuffler.io") || strings.Contains(strings.ToLower(b.aiApiUrl), "shuffle") {
					cleanUrl := resolveShuffleAiBaseURL(b.aiApiUrl)
					if b.cfg != nil {
						b.cfg.BaseURL = cleanUrl
					}
				}
			} else {
				req.AiApiUrl = ""
			}
		}
		b.mu.Unlock()
		res = b.RunPromptWithAttachments(req.Prompt, req.Bypass, req.ConversationID, req.Model, req.Reasoning, req.Attachments, req.AiApiUrl, req.AiApiKey)
		log.Printf("[INFO] AgentBridge.HandleAction \"runPrompt\" completed for convID=%q (response bytes: %d)", req.ConversationID, len(res))
		return res

	case "getShuffleAuthenticatedApps", "listShuffleApps":
		return b.GetShuffleAuthenticatedApps(payload)

	case "searchShuffleApps", "searchShuffleCatalogApps":
		return b.SearchShuffleApps(payload)

	case "getShuffleAppAuthConfig", "getShuffleAppAuthSchema":
		return b.GetShuffleAppAuthConfig(payload)

	case "authenticateShuffleApp", "addShuffleAppAuth":
		return b.AuthenticateShuffleApp(payload)

	case "setConversationShuffleTools", "setAttachedShuffleTools":
		return b.SetConversationShuffleTools(payload)

	case "getConversationShuffleTools", "getAttachedShuffleTools":
		return b.GetConversationShuffleTools(payload)

	case "getShuffleSharedSkills", "listShuffleSharedSkills":
		return b.GetShuffleSharedSkills(payload)

	case "setConversationShuffleSkills", "setAttachedShuffleSkills":
		return b.SetConversationShuffleSkills(payload)

	case "getConversationShuffleSkills", "getAttachedShuffleSkills":
		return b.GetConversationShuffleSkills(payload)

	case "stopExecution", "cancelPrompt":
		cancelled := b.CancelCurrentExecution()
		log.Printf("[INFO] AgentBridge.HandleAction \"stopExecution\": cancelled=%v", cancelled)
		resp, _ := json.Marshal(map[string]interface{}{
			"status":    "stopped",
			"cancelled": cancelled,
		})
		return string(resp)

	case "respondApproval", "resolveApproval":
		var req struct {
			ID                string `json:"id"`
			Approved          bool   `json:"approved"`
			Option            int    `json:"option"`
			CommandPrefix     string `json:"command_prefix"`
			CommandPrefixCml  string `json:"commandPrefix"`
			Scope             string `json:"scope"`
			ScopeID           string `json:"scope_id"`
			ScopeIDCml        string `json:"scopeId"`
			Answer            string `json:"answer"`
		}
		if err := json.Unmarshal([]byte(payload), &req); err == nil {
			cmdPrefix := req.CommandPrefix
			if cmdPrefix == "" {
				cmdPrefix = req.CommandPrefixCml
			}
			scopeID := req.ScopeID
			if scopeID == "" {
				scopeID = req.ScopeIDCml
			}
			if req.Option > 0 || strings.TrimSpace(req.Answer) != "" {
				return b.RespondApprovalWithAnswer(req.ID, req.Option, cmdPrefix, req.Scope, scopeID, req.Answer)
			}
			return b.RespondApproval(req.ID, req.Approved)
		}
		return `{"error": "invalid payload"}`

	case "respondApprovalWithOptions":
		var req struct {
			ID                string `json:"id"`
			Option            int    `json:"option"`
			CommandPrefix     string `json:"command_prefix"`
			CommandPrefixCml  string `json:"commandPrefix"`
			Scope             string `json:"scope"`
			ScopeID           string `json:"scope_id"`
			ScopeIDCml        string `json:"scopeId"`
			Answer            string `json:"answer"`
		}
		if err := json.Unmarshal([]byte(payload), &req); err == nil {
			cmdPrefix := req.CommandPrefix
			if cmdPrefix == "" {
				cmdPrefix = req.CommandPrefixCml
			}
			scopeID := req.ScopeID
			if scopeID == "" {
				scopeID = req.ScopeIDCml
			}
			return b.RespondApprovalWithAnswer(req.ID, req.Option, cmdPrefix, req.Scope, scopeID, req.Answer)
		}
		return `{"error": "invalid payload"}`

	case "getApprovalQueue":
		return b.GetApprovalQueue()

	case "respondAllApprovals":
		var req struct {
			Approved bool `json:"approved"`
		}
		_ = json.Unmarshal([]byte(payload), &req)
		return b.RespondAllApprovals(req.Approved)

	case "getApprovalRules":
		return b.GetApprovalRules()

	case "addApprovalRule", "updateApprovalRule":
		return b.AddApprovalRule(payload)

	case "revokeApprovalRule", "removeApprovalRule":
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

	case "cancelOAuthLogin":
		return b.CancelOAuthLogin()

	case "setOAuthToken":
		var req struct {
			Token string `json:"token"`
			Org   string `json:"org"`
			Env   string `json:"env"`
		}
		_ = json.Unmarshal([]byte(payload), &req)
		return b.SetOAuthToken(req.Token, req.Org, req.Env)

	case "logoutShuffle":
		return b.LogoutShuffle()

	case "getShuffleTenants":
		var req struct {
			Refresh bool `json:"refresh"`
		}
		_ = json.Unmarshal([]byte(payload), &req)
		return b.GetShuffleTenants(req.Refresh)

	case "refreshShuffleTenants":
		return b.GetShuffleTenants(true)

	case "selectShuffleTenant":
		return b.SelectShuffleTenant(payload)

	case "testAiConfig":
		var req struct {
			URL   string `json:"url"`
			Key   string `json:"key"`
			Model string `json:"model"`
		}
		_ = json.Unmarshal([]byte(payload), &req)
		return b.TestAiConfig(req.URL, req.Key, req.Model)

	case "setAiConfig":
		var req struct {
			URL              string `json:"url"`
			Key              string `json:"key"`
			Model            string `json:"model"`
			PermissionPolicy string `json:"permission_policy"`
			Test             bool   `json:"test"`
		}
		_ = json.Unmarshal([]byte(payload), &req)
		if req.PermissionPolicy != "" {
			b.SetPermissionPolicy(req.PermissionPolicy)
		}
		if req.Test {
			testResult := b.TestAiConfig(req.URL, req.Key, req.Model)
			var testMap map[string]interface{}
			if err := json.Unmarshal([]byte(testResult), &testMap); err == nil {
				if testMap["status"] != "ok" {
					return testResult
				}
			}
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

	case "getLocalModelCatalog":
		var req struct {
			Directory string `json:"directory"`
		}
		_ = json.Unmarshal([]byte(payload), &req)
		return b.GetLocalModelCatalogStatus(req.Directory)

	case "downloadLocalModel":
		var req struct {
			Model     string `json:"model"`
			ModelKey  string `json:"model_key"`
			Directory string `json:"directory"`
		}
		_ = json.Unmarshal([]byte(payload), &req)
		key := req.Model
		if key == "" {
			key = req.ModelKey
		}
		if key == "" && strings.TrimSpace(payload) != "" && !strings.HasPrefix(strings.TrimSpace(payload), "{") {
			key = strings.TrimSpace(payload)
		}
		return b.StartLocalModelDownload(key, req.Directory)

	case "cancelLocalModelDownload":
		return b.CancelLocalModelDownload()

	case "getLocalDownloadStatus":
		return b.GetLocalDownloadStatus()

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
			Path          string `json:"path"`
			ForAttachment bool   `json:"for_attachment"`
		}
		_ = json.Unmarshal([]byte(payload), &req)
		if req.Path == "" {
			req.Path = strings.TrimSpace(payload)
		}
		return b.ReadFilePreviewOpts(req.Path, req.ForAttachment)

	case "getChangedFiles":
		var req struct {
			Project string `json:"project"`
		}
		_ = json.Unmarshal([]byte(payload), &req)
		proj := req.Project
		if proj == "" {
			b.mu.Lock()
			proj = b.activeProject
			b.mu.Unlock()
		}
		changes := b.getProjectGitChangesLocked(proj)
		if changes == nil {
			return `{"total_files": 0, "additions": 0, "deletions": 0, "files": []}`
		}
		data, _ := json.Marshal(changes)
		return string(data)

	case "getRecentLogs":
		logs := GetRecentLogs()
		resp, _ := json.Marshal(map[string]interface{}{
			"status": "ok",
			"logs":   logs,
		})
		return string(resp)

	case "getRightSidebarData":
		return b.GetRightSidebarData()

	case "getLocalExecutorStatus":
		modelPath := b.GetLocalModelPath()
		modelsDir := b.GetLocalModelsDir()
		resp, _ := json.Marshal(map[string]interface{}{
			"available":          modelPath != "",
			"active_model_path":  modelPath,
			"active_model_name":  filepath.Base(modelPath),
			"models_dir":         modelsDir,
			"default_models_dir": modelsDir,
		})
		return string(resp)

	case "windowAction", "windowMinimize", "windowMaximize", "windowClose", "windowStartDrag", "drag", "setTitlebarNoDragWidth", "setModalActive", "clientLog":
		return `{"status": "ok"}`

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
		seenSkillNames := make(map[string]bool)
		for _, folder := range b.GetProjectFolders(projectPath) {
			for _, sk := range DiscoverSkills(folder) {
				key := strings.ToLower(strings.TrimSpace(sk.Name))
				if key != "" && !seenSkillNames[key] {
					seenSkillNames[key] = true
					skills = append(skills, sk)
				}
			}
		}
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

func isBinaryFilePath(filePath string) bool {
	ext := strings.ToLower(filepath.Ext(filePath))
	switch ext {
	case ".exe", ".dll", ".so", ".dylib", ".bin", ".gguf", ".iso", ".zip", ".tar",
		".gz", ".7z", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".mp4",
		".mov", ".avi", ".pdf", ".node", ".pyc", ".wasm", ".db", ".sqlite", ".obj", ".o", ".a", ".lib":
		return true
	}
	return false
}

func isBinaryContent(data []byte) bool {
	limit := 1024
	if len(data) < limit {
		limit = len(data)
	}
	for i := 0; i < limit; i++ {
		if data[i] == 0 {
			return true
		}
	}
	return false
}

func streamHashFile(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	h := sha256.New()
	buf := make([]byte, 64*1024)
	if _, err := io.CopyBuffer(h, f, buf); err != nil {
		return ""
	}
	return hex.EncodeToString(h.Sum(nil))
}

func shouldSkipSnapshotDir(name string) bool {
	switch strings.ToLower(name) {
	case ".git", "node_modules", "vendor", ".gemini", "obj", "bin", "__pycache__", ".venv", ".next", "target":
		return true
	}
	return false
}

func (b *AgentBridge) captureWorkingTreeSnapshot(projectPath string) *WorkingTreeSnapshot {
	if projectPath == "" {
		b.mu.Lock()
		projectPath = b.activeProject
		b.mu.Unlock()
	}
	if projectPath == "." {
		if abs, err := filepath.Abs(projectPath); err == nil {
			projectPath = abs
		}
	}
	if projectPath == "" || projectPath == "__NONE__" {
		return nil
	}
	cleanProj := filepath.Clean(projectPath)

	snap := &WorkingTreeSnapshot{
		ProjectPath: cleanProj,
		Files:       make(map[string]FileSnap),
	}

	// Always walk workspace files directly from disk so before/after diffs are computed
	// 100% in-memory per turn without requiring git or commits between changes.
	_ = filepath.Walk(cleanProj, func(path string, info os.FileInfo, err error) error {
		if err != nil || info == nil {
			return nil
		}
		rel, err := filepath.Rel(cleanProj, path)
		if err != nil || rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if info.IsDir() {
			if shouldSkipSnapshotDir(info.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if info.Size() > 2*1024*1024 || isBinaryFilePath(rel) {
			var fileHash string
			if info.Size() > 10*1024*1024 {
				fileHash = fmt.Sprintf("size:%d:mtime:%d", info.Size(), info.ModTime().UnixNano())
			} else {
				fileHash = streamHashFile(path)
			}
			snap.Files[rel] = FileSnap{
				Path:    rel,
				Status:  "existing",
				Hash:    fileHash,
				Size:    info.Size(),
				Content: "",
			}
			return nil
		}
		if data, err := os.ReadFile(path); err == nil {
			h := sha256.Sum256(data)
			hashHex := hex.EncodeToString(h[:])
			if isBinaryContent(data) {
				snap.Files[rel] = FileSnap{
					Path:    rel,
					Status:  "existing",
					Hash:    hashHex,
					Size:    info.Size(),
					Content: "",
				}
				return nil
			}
			snap.Files[rel] = FileSnap{
				Path:    rel,
				Status:  "existing",
				Hash:    hashHex,
				Size:    info.Size(),
				Content: string(data),
			}
		}
		return nil
	})

	b.mu.Lock()
	if b.projectBaselineSnap == nil {
		b.projectBaselineSnap = make(map[string]*WorkingTreeSnapshot)
	}
	if _, exists := b.projectBaselineSnap[cleanProj]; !exists {
		baseCopy := &WorkingTreeSnapshot{
			ProjectPath: cleanProj,
			Files:       make(map[string]FileSnap, len(snap.Files)),
		}
		for k, v := range snap.Files {
			baseCopy.Files[k] = v
		}
		b.projectBaselineSnap[cleanProj] = baseCopy
	}
	b.mu.Unlock()

	return snap
}

type unifiedDiffOp struct {
	kind    byte // ' ', '-', '+'
	text    string
	oldLine int
	newLine int
}

func computeUnifiedDiff(filePath, oldContent, newContent string) (string, int, int) {
	if oldContent == newContent {
		return "", 0, 0
	}
	if isBinaryFilePath(filePath) {
		return "[Binary file: diff suppressed]", 0, 0
	}
	if len(oldContent) > 2*1024*1024 || len(newContent) > 2*1024*1024 {
		return "[File exceeds 2MB: diff suppressed]", 0, 0
	}
	oldLines := strings.Split(strings.ReplaceAll(oldContent, "\r\n", "\n"), "\n")
	newLines := strings.Split(strings.ReplaceAll(newContent, "\r\n", "\n"), "\n")
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

	prefix := 0
	for prefix < len(oldLines) && prefix < len(newLines) && oldLines[prefix] == newLines[prefix] {
		prefix++
	}
	suffix := 0
	for (len(oldLines)-1-suffix) >= prefix && (len(newLines)-1-suffix) >= prefix &&
		oldLines[len(oldLines)-1-suffix] == newLines[len(newLines)-1-suffix] {
		suffix++
	}

	const ctxLines = 3
	ctxStart := prefix - ctxLines
	if ctxStart < 0 {
		ctxStart = 0
	}
	ctxSuffix := suffix - ctxLines
	if ctxSuffix < 0 {
		ctxSuffix = 0
	}

	A := oldLines[ctxStart : len(oldLines)-ctxSuffix]
	B := newLines[ctxStart : len(newLines)-ctxSuffix]
	baseLine := ctxStart + 1

	var ops []unifiedDiffOp
	i, j := 0, 0
	const maxWin = 160
	for i < len(A) || j < len(B) {
		if i < len(A) && j < len(B) && A[i] == B[j] {
			ops = append(ops, unifiedDiffOp{kind: ' ', text: A[i], oldLine: baseLine + i, newLine: baseLine + j})
			i++
			j++
			continue
		}
		bestDi, bestDj := -1, -1
		bestCost := maxWin*2 + 1
		limI := len(A) - i
		if limI > maxWin {
			limI = maxWin
		}
		limJ := len(B) - j
		if limJ > maxWin {
			limJ = maxWin
		}
		for di := 0; di <= limI; di++ {
			if di >= bestCost {
				break
			}
			for dj := 0; dj <= limJ; dj++ {
				if di == 0 && dj == 0 {
					continue
				}
				cost := di + dj
				if cost >= bestCost {
					break
				}
				if i+di < len(A) && j+dj < len(B) && A[i+di] == B[j+dj] {
					twoMatch := (i+di+1 < len(A) && j+dj+1 < len(B) && A[i+di+1] == B[j+dj+1]) ||
						(i+di+1 == len(A) && j+dj+1 == len(B))
					nearNonEmpty := cost <= 12 && strings.TrimSpace(A[i+di]) != ""
					if twoMatch || nearNonEmpty {
						bestCost = cost
						bestDi = di
						bestDj = dj
						break
					}
				}
			}
		}

		if bestDi >= 0 && bestDj >= 0 {
			for k := 0; k < bestDi; k++ {
				ops = append(ops, unifiedDiffOp{kind: '-', text: A[i], oldLine: baseLine + i, newLine: baseLine + j})
				i++
			}
			for k := 0; k < bestDj; k++ {
				ops = append(ops, unifiedDiffOp{kind: '+', text: B[j], oldLine: baseLine + i, newLine: baseLine + j})
				j++
			}
		} else {
			if i < len(A) {
				ops = append(ops, unifiedDiffOp{kind: '-', text: A[i], oldLine: baseLine + i, newLine: baseLine + j})
				i++
			}
			if j < len(B) {
				ops = append(ops, unifiedDiffOp{kind: '+', text: B[j], oldLine: baseLine + i, newLine: baseLine + j})
				j++
			}
		}
	}

	// Normalize contiguous edit runs so '-' precedes '+' within each change cluster
	for idx := 0; idx < len(ops); {
		if ops[idx].kind == ' ' {
			idx++
			continue
		}
		end := idx
		for end < len(ops) && ops[end].kind != ' ' {
			end++
		}
		var dels, adds []unifiedDiffOp
		for k := idx; k < end; k++ {
			if ops[k].kind == '-' {
				dels = append(dels, ops[k])
			} else {
				adds = append(adds, ops[k])
			}
		}
		copy(ops[idx:idx+len(dels)], dels)
		copy(ops[idx+len(dels):end], adds)
		idx = end
	}

	addCount := 0
	delCount := 0
	for _, op := range ops {
		if op.kind == '+' {
			addCount++
		} else if op.kind == '-' {
			delCount++
		}
	}
	if addCount == 0 && delCount == 0 {
		return "", 0, 0
	}

	type hunkRange struct {
		start int
		end   int
	}
	var hunks []hunkRange
	for idx := 0; idx < len(ops); idx++ {
		if ops[idx].kind != ' ' {
			hStart := idx - ctxLines
			if hStart < 0 {
				hStart = 0
			}
			for idx < len(ops) && ops[idx].kind != ' ' {
				idx++
			}
			hEnd := idx + ctxLines
			if hEnd > len(ops) {
				hEnd = len(ops)
			}
			if len(hunks) > 0 && hStart <= hunks[len(hunks)-1].end {
				if hEnd > hunks[len(hunks)-1].end {
					hunks[len(hunks)-1].end = hEnd
				}
			} else {
				hunks = append(hunks, hunkRange{start: hStart, end: hEnd})
			}
		}
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("diff --git a/%s b/%s\n--- a/%s\n+++ b/%s\n", filePath, filePath, filePath, filePath))
	for _, h := range hunks {
		oldStart := ops[h.start].oldLine
		newStart := ops[h.start].newLine
		oldLen, newLen := 0, 0
		for k := h.start; k < h.end; k++ {
			switch ops[k].kind {
			case ' ':
				oldLen++
				newLen++
			case '-':
				oldLen++
			case '+':
				newLen++
			}
		}
		sb.WriteString(fmt.Sprintf("@@ -%d,%d +%d,%d @@\n", oldStart, oldLen, newStart, newLen))
		for k := h.start; k < h.end; k++ {
			sb.WriteByte(ops[k].kind)
			sb.WriteString(ops[k].text)
			sb.WriteByte('\n')
		}
	}

	return sb.String(), addCount, delCount
}

func computeDirectSnapshotDiff(before, after *WorkingTreeSnapshot) *ChangedFilesSummary {
	if before == nil || after == nil {
		return nil
	}
	summary := &ChangedFilesSummary{
		Files: []FileChangeDetail{},
	}

	for filePath, afterSnap := range after.Files {
		beforeSnap, existedBefore := before.Files[filePath]
		if !existedBefore {
			var diffText string
			var addCount, delCount int
			if isBinaryFilePath(filePath) {
				diffText = "[Binary file]"
			} else if afterSnap.Content != "" {
				diffText, addCount, delCount = computeUnifiedDiff(filePath, "", afterSnap.Content)
			}
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
			var diffText string
			var addCount, delCount int
			if isBinaryFilePath(filePath) {
				diffText = "[Binary file]"
			} else {
				diffText, addCount, delCount = computeUnifiedDiff(filePath, beforeSnap.Content, afterSnap.Content)
			}
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
			var diffText string
			var addCount, delCount int
			if isBinaryFilePath(filePath) {
				diffText = "[Binary file]"
			} else if beforeSnap.Content != "" {
				diffText, addCount, delCount = computeUnifiedDiff(filePath, beforeSnap.Content, "")
			}
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

	if len(summary.Files) == 0 {
		return nil
	}

	sort.Slice(summary.Files, func(i, j int) bool {
		return summary.Files[i].Path < summary.Files[j].Path
	})
	summary.TotalFiles = len(summary.Files)
	return summary
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

	turnSummary := computeDirectSnapshotDiff(before, after)

	// Also update cumulative direct session changes from initial project baseline
	cleanProj := filepath.Clean(after.ProjectPath)
	b.mu.Lock()
	baseline := b.projectBaselineSnap[cleanProj]
	b.mu.Unlock()
	if baseline != nil {
		sessionSummary := computeDirectSnapshotDiff(baseline, after)
		b.mu.Lock()
		if b.directProjectChanges == nil {
			b.directProjectChanges = make(map[string]*ChangedFilesSummary)
		}
		if sessionSummary != nil {
			b.directProjectChanges[cleanProj] = sessionSummary
		} else {
			delete(b.directProjectChanges, cleanProj)
		}
		b.mu.Unlock()
	}

	return turnSummary
}

func (b *AgentBridge) getProjectGitChangesLocked(projectPath string) *ChangedFilesSummary {
	if projectPath == "" {
		projectPath = b.activeProject
	}
	if projectPath == "." {
		if abs, err := filepath.Abs(projectPath); err == nil {
			projectPath = abs
		}
	}
	if projectPath == "" || projectPath == "__NONE__" {
		return nil
	}

	cleanProj := filepath.Clean(projectPath)
	b.mu.Lock()
	var directSummary *ChangedFilesSummary
	if b.directProjectChanges != nil {
		directSummary = b.directProjectChanges[cleanProj]
	}
	b.mu.Unlock()

	cmdStatus := exec.Command("git", "status", "--porcelain=v1", "-uall")
	cmdStatus.Dir = projectPath
	outStatus, err := cmdStatus.Output()
	if err != nil {
		return directSummary
	}
	rawStatus := strings.TrimSpace(string(outStatus))
	if rawStatus == "" {
		return directSummary
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
		filePath = strings.Trim(filePath, "\"")
		filePath = filepath.ToSlash(filePath)
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
				fPath := filepath.ToSlash(strings.Trim(fields[2], "\""))
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
			if isBinaryFilePath(f.Path) {
				summary.Files[i].Diff = "[Binary file]"
				continue
			}
			marker := fmt.Sprintf("diff --git a/%s b/%s", f.Path, f.Path)
			if idx := strings.Index(rawDiff, marker); idx != -1 {
				rem := rawDiff[idx+len(marker):]
				nextIdx := strings.Index(rem, "diff --git ")
				var diffPart string
				if nextIdx != -1 {
					diffPart = rawDiff[idx : idx+len(marker)+nextIdx]
				} else {
					diffPart = rawDiff[idx:]
				}
				if len(diffPart) > 256*1024 {
					diffPart = diffPart[:256*1024] + "\n... [diff truncated: exceeds 256KB]"
				}
				summary.Files[i].Diff = diffPart
			}
		}
	}

	// Merge direct in-memory diffs for any files missing git diff HEAD (e.g. unborn HEAD, untracked/ignored files)
	if directSummary != nil {
		directByPath := make(map[string]FileChangeDetail, len(directSummary.Files))
		for _, df := range directSummary.Files {
			directByPath[df.Path] = df
		}
		seenPaths := make(map[string]bool, len(summary.Files))
		for i, f := range summary.Files {
			seenPaths[f.Path] = true
			if summary.Files[i].Diff == "" {
				if df, ok := directByPath[f.Path]; ok && df.Diff != "" {
					summary.Files[i].Diff = df.Diff
					if summary.Files[i].Additions == 0 && summary.Files[i].Deletions == 0 {
						summary.Files[i].Additions = df.Additions
						summary.Files[i].Deletions = df.Deletions
						summary.Additions += df.Additions
						summary.Deletions += df.Deletions
					}
				}
			}
		}
		for _, df := range directSummary.Files {
			if !seenPaths[df.Path] {
				summary.Files = append(summary.Files, df)
				summary.Additions += df.Additions
				summary.Deletions += df.Deletions
			}
		}
		summary.TotalFiles = len(summary.Files)
	}

	// For added files not in git diff HEAD, safely populate additions and diff directly from disk
	for i, f := range summary.Files {
		if f.Status == "added" && summary.Files[i].Additions == 0 {
			if isBinaryFilePath(f.Path) {
				summary.Files[i].Diff = "[Binary file]"
				continue
			}
			fullPath := filepath.Join(projectPath, f.Path)
			if fi, err := os.Stat(fullPath); err == nil {
				if fi.Size() > 2*1024*1024 {
					summary.Files[i].Diff = fmt.Sprintf("[File too large to preview: %d bytes]", fi.Size())
					continue
				}
				if data, err := os.ReadFile(fullPath); err == nil {
					if isBinaryContent(data) {
						summary.Files[i].Diff = "[Binary file]"
						continue
					}
					lines := strings.Split(string(data), "\n")
					summary.Files[i].Additions = len(lines)
					summary.Additions += len(lines)
					if summary.Files[i].Diff == "" {
						summary.Files[i].Diff, _, _ = computeUnifiedDiff(f.Path, "", string(data))
					}
				}
			}
		}
	}

	return summary
}

// ReadFilePreview returns file content or base64 image data for the preview sidebar
func (b *AgentBridge) ReadFilePreview(pathStr string) string {
	return b.ReadFilePreviewOpts(pathStr, false)
}

// ReadFilePreviewOpts returns file content or base64 image data, optionally allowing user-selected files outside workspace boundaries.
func (b *AgentBridge) ReadFilePreviewOpts(pathStr string, allowExternal bool) string {
	pathStr = strings.TrimSpace(pathStr)
	if pathStr == "" {
		return `{"error": "empty file path"}`
	}

	b.mu.Lock()
	proj := b.activeProject
	eff := b.getEffectivePermissionsLocked(proj)
	accessPolicy := eff.FileAccessPolicy
	b.mu.Unlock()

	targetPath := pathStr
	if !filepath.IsAbs(targetPath) {
		if proj != "" && proj != "__NONE__" {
			targetPath = filepath.Join(proj, targetPath)
		} else {
			cwd, _ := os.Getwd()
			targetPath = filepath.Join(cwd, targetPath)
		}
	}
	targetPath = filepath.Clean(targetPath)

	screenshotDir := filepath.Clean(filepath.Join(os.TempDir(), "orborus-screenshots"))
	_, inScreenshotDir := checkWorkspacePathBoundary(targetPath, screenshotDir)
	if !allowExternal && !inScreenshotDir && (accessPolicy == "workspace_only" || accessPolicy == "strict") && proj != "" && proj != "__NONE__" {
	if _, inside := checkMultiWorkspacePathBoundary(targetPath, b.GetProjectFolders(proj)); !inside {
			return fmt.Sprintf(`{"error": %q}`, "access denied: file is outside active workspace ("+filepath.Base(pathStr)+")")
		}
	}

	info, err := os.Stat(targetPath)
	if err != nil {
		return fmt.Sprintf(`{"error": %q}`, "file not found: "+filepath.Base(pathStr))
	}
	if info.IsDir() {
		return fmt.Sprintf(`{"error": %q}`, filepath.Base(pathStr)+" is a directory")
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
			return fmt.Sprintf(`{"error": %q}`, "failed to read image: "+err.Error())
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
		return fmt.Sprintf(`{"error": %q}`, "failed to read file: "+err.Error())
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
	b.mu.Unlock()
	changes := b.getProjectGitChangesLocked(proj)

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

// resolveShuffleCloudCredentials returns the active Shuffle base URL, bearer token, and org ID when authenticated to Shuffle.
func (b *AgentBridge) resolveShuffleCloudCredentials() (baseURL, authToken, orgID string, ok bool) {
	b.mu.Lock()
	defer b.mu.Unlock()

	authToken = strings.TrimSpace(b.oauthToken)
	if authToken == "" && b.cfg != nil {
		authToken = strings.TrimSpace(b.cfg.Auth)
	}
	if authToken == "" && (b.oauthLoggedIn || strings.HasPrefix(strings.TrimSpace(b.aiApiKey), "shfl_")) {
		authToken = strings.TrimSpace(b.aiApiKey)
	}
	if authToken == "" {
		authToken = strings.TrimSpace(os.Getenv("SHUFFLE_AUTHORIZATION"))
	}
	if authToken == "" {
		return "", "", "", false
	}

	if b.cfg != nil {
		orgID = strings.TrimSpace(b.cfg.Org)
		baseURL = strings.TrimSpace(b.cfg.BaseURL)
	}
	if orgID == "" {
		orgID = strings.TrimSpace(os.Getenv("SHUFFLE_ORG_ID"))
		if orgID == "" {
			orgID = strings.TrimSpace(os.Getenv("ORG"))
		}
	}
	if baseURL != "" {
		baseURL = resolveShuffleAiBaseURL(baseURL)
	}
	if baseURL == "" && (strings.Contains(strings.ToLower(b.aiApiUrl), "shuffler.io") || strings.Contains(strings.ToLower(b.aiApiUrl), "shuffle")) {
		baseURL = resolveShuffleAiBaseURL(b.aiApiUrl)
	}
	if baseURL == "" {
		baseURL = strings.TrimSpace(os.Getenv("SHUFFLE_BASE_URL"))
	}
	if baseURL == "" {
		baseURL = "https://shuffler.io"
	}
	baseURL = resolveShuffleAiBaseURL(baseURL)

	if strings.Contains(baseURL, "127.0.0.1") || strings.Contains(baseURL, "localhost") {
		baseURL = "https://shuffler.io"
		if b.cfg != nil && strings.TrimSpace(b.cfg.BaseURL) != "" && !strings.Contains(b.cfg.BaseURL, "127.0.0.1") && !strings.Contains(b.cfg.BaseURL, "localhost") {
			baseURL = resolveShuffleAiBaseURL(b.cfg.BaseURL)
		}
	}
	_ = os.Setenv("SHUFFLE_CLOUDRUN_URL", baseURL)
	if curBase := os.Getenv("SHUFFLE_BASE_URL"); !strings.Contains(curBase, "127.0.0.1") && !strings.Contains(curBase, "localhost") {
		_ = os.Setenv("BASE_URL", baseURL)
		_ = os.Setenv("SHUFFLE_BASE_URL", baseURL)
	}
	if orgID != "" {
		_ = os.Setenv("SHUFFLE_ORG_ID", orgID)
		_ = os.Setenv("ORG", orgID)
	}
	return baseURL, authToken, orgID, true
}

func (b *AgentBridge) unusedResolveShufflePlaceholder() (string, string, string, bool) {
	var baseURL, authToken, orgID string
	_ = os.Setenv("BASE_URL", baseURL)
	_ = os.Setenv("SHUFFLE_BASE_URL", baseURL)
	if orgID != "" {
		_ = os.Setenv("SHUFFLE_ORG_ID", orgID)
		_ = os.Setenv("ORG", orgID)
	}
	return baseURL, authToken, orgID, true
}

// GetShuffleAuthenticatedApps fetches the authenticated apps in the active Shuffle tenant via GET /api/v1/apps/authentication
// and cross-correlates them with the full Shuffle app catalog via Algolia (appsearch).
func (b *AgentBridge) GetShuffleAuthenticatedApps(optionalPayload ...string) string {
	var reqPayload struct {
		Query        string `json:"query"`
		ForceRefresh bool   `json:"force_refresh"`
	}
	if len(optionalPayload) > 0 && strings.TrimSpace(optionalPayload[0]) != "" {
		raw := strings.TrimSpace(optionalPayload[0])
		if strings.HasPrefix(raw, "{") {
			_ = json.Unmarshal([]byte(raw), &reqPayload)
		} else {
			reqPayload.Query = raw
		}
	}
	query := strings.TrimSpace(reqPayload.Query)

	baseURL, authToken, orgID, ok := b.resolveShuffleCloudCredentials()
	if !ok {
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		defer cancel()
		algoliaHits, _ := b.searchShuffleAppsViaAlgolia(ctx, query, 60)
		catalog := make([]ShuffleAttachedTool, 0, len(algoliaHits))
		for _, hit := range algoliaHits {
			if hit.Invalid || (strings.TrimSpace(hit.ObjectID) == "" && strings.TrimSpace(hit.Name) == "") {
				continue
			}
			catalog = append(catalog, ShuffleAttachedTool{
				AuthID:        "",
				Label:         strings.ReplaceAll(strings.TrimSpace(hit.Name), "_", " "),
				AppID:         strings.TrimSpace(hit.ObjectID),
				AppName:       strings.TrimSpace(hit.Name),
				AppVersion:    strings.TrimSpace(hit.AppVersion),
				LargeImage:    normalizeShuffleAppImage(hit.ImageUrl, "", "https://shuffler.io"),
				ActionsCount:  hit.Actions,
				Authenticated: false,
				Valid:         false,
				Description:   strings.TrimSpace(hit.Description),
				Categories:    hit.Categories,
				Verified:      hit.Verified,
			})
		}
		resp, _ := json.Marshal(map[string]interface{}{
			"status":   "unauthenticated",
			"apps":     []ShuffleAttachedTool{},
			"catalog":  catalog,
			"query":    query,
			"attached": b.GetConversationShuffleToolsList(""),
			"error":    "Not authenticated to Shuffle AI",
		})
		return string(resp)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	var (
		tools       []ShuffleAttachedTool
		authFetchEr error
		algoliaHits []shuffle.AlgoliaSearchApp
		wg          sync.WaitGroup
	)

	wg.Add(2)
	go func() {
		defer wg.Done()
		tools, authFetchEr = b.fetchShuffleTenantAuthentications(ctx, baseURL, authToken, orgID, reqPayload.ForceRefresh)
	}()
	go func() {
		defer wg.Done()
		algoliaHits, _ = b.searchShuffleAppsViaAlgolia(ctx, query, 60)
	}()
	wg.Wait()

	if authFetchEr != nil && len(tools) == 0 && len(algoliaHits) == 0 {
		resp, _ := json.Marshal(map[string]interface{}{
			"status":  "error",
			"apps":    []ShuffleAttachedTool{},
			"catalog": []ShuffleAttachedTool{},
			"error":   authFetchEr.Error(),
		})
		return string(resp)
	}

	// Build lookup maps to cross-correlate Algolia apps with tenant authentications
	algoliaByID := make(map[string]shuffle.AlgoliaSearchApp, len(algoliaHits))
	algoliaByName := make(map[string]shuffle.AlgoliaSearchApp, len(algoliaHits))
	for _, hit := range algoliaHits {
		if hit.Invalid {
			continue
		}
		if id := strings.ToLower(strings.TrimSpace(hit.ObjectID)); id != "" {
			algoliaByID[id] = hit
		}
		if n := normalizeShuffleIdentifier(hit.Name); n != "" {
			if _, exists := algoliaByName[n]; !exists {
				algoliaByName[n] = hit
			}
		}
	}

	// Also check cached default ("") Algolia hits to enrich authenticated app icons/metadata even when a search query is active
	b.shuffleToolsMu.RLock()
	defaultAlgoliaHits := b.cachedAlgoliaQueries[""]
	b.shuffleToolsMu.RUnlock()
	for _, hit := range defaultAlgoliaHits {
		if hit.Invalid {
			continue
		}
		if id := strings.ToLower(strings.TrimSpace(hit.ObjectID)); id != "" {
			if _, exists := algoliaByID[id]; !exists {
				algoliaByID[id] = hit
			}
		}
		if n := normalizeShuffleIdentifier(hit.Name); n != "" {
			if _, exists := algoliaByName[n]; !exists {
				algoliaByName[n] = hit
			}
		}
	}

	authByAppID := make(map[string]ShuffleAttachedTool, len(tools))
	authByAppName := make(map[string]ShuffleAttachedTool, len(tools))
	for i := range tools {
		tools[i].Authenticated = true
		idLower := strings.ToLower(strings.TrimSpace(tools[i].AppID))
		nameNorm := normalizeShuffleIdentifier(tools[i].AppName)

		// Enrich authenticated tool metadata from Algolia if missing
		var matchedHit *shuffle.AlgoliaSearchApp
		if idLower != "" {
			if h, ok := algoliaByID[idLower]; ok {
				matchedHit = &h
			}
		}
		if matchedHit == nil && nameNorm != "" {
			if h, ok := algoliaByName[nameNorm]; ok {
				matchedHit = &h
			}
		}
		if matchedHit != nil {
			if tools[i].LargeImage == "" && matchedHit.ImageUrl != "" {
				tools[i].LargeImage = normalizeShuffleAppImage(matchedHit.ImageUrl, "", baseURL)
			}
			if tools[i].ActionsCount == 0 && matchedHit.Actions > 0 {
				tools[i].ActionsCount = matchedHit.Actions
			}
			if tools[i].Description == "" && matchedHit.Description != "" {
				tools[i].Description = strings.TrimSpace(matchedHit.Description)
			}
			if len(tools[i].Categories) == 0 && len(matchedHit.Categories) > 0 {
				tools[i].Categories = matchedHit.Categories
			}
			if matchedHit.Verified {
				tools[i].Verified = true
			}
		}

		// Record primary (first in sorted order: newest created & valid) auth for each app
		if idLower != "" {
			if _, exists := authByAppID[idLower]; !exists {
				authByAppID[idLower] = tools[i]
			}
		}
		if nameNorm != "" {
			if _, exists := authByAppName[nameNorm]; !exists {
				authByAppName[nameNorm] = tools[i]
			}
		}
	}

	// Build cross-correlated Algolia catalog list
	catalog := make([]ShuffleAttachedTool, 0, len(algoliaHits))
	seenCatalog := make(map[string]bool, len(algoliaHits))
	for _, hit := range algoliaHits {
		if hit.Invalid {
			continue
		}
		hitID := strings.TrimSpace(hit.ObjectID)
		hitName := strings.TrimSpace(hit.Name)
		if hitID == "" && hitName == "" {
			continue
		}
		idLower := strings.ToLower(hitID)
		nameNorm := normalizeShuffleIdentifier(hitName)
		dedupKey := idLower
		if dedupKey == "" {
			dedupKey = nameNorm
		}
		if seenCatalog[dedupKey] {
			continue
		}
		seenCatalog[dedupKey] = true

		var matchedAuth *ShuffleAttachedTool
		if idLower != "" {
			if a, ok := authByAppID[idLower]; ok {
				matchedAuth = &a
			}
		}
		if matchedAuth == nil && nameNorm != "" {
			if a, ok := authByAppName[nameNorm]; ok {
				matchedAuth = &a
			}
		}

		img := normalizeShuffleAppImage(hit.ImageUrl, "", baseURL)
		if img == "" {
			img = b.resolveShuffleAppImage(shuffle.WorkflowApp{ID: hitID, Name: hitName}, baseURL)
		}

		if matchedAuth != nil {
			catEntry := *matchedAuth
			catEntry.Authenticated = true
			if catEntry.LargeImage == "" {
				catEntry.LargeImage = img
			}
			if catEntry.ActionsCount == 0 {
				catEntry.ActionsCount = hit.Actions
			}
			if catEntry.Description == "" {
				catEntry.Description = strings.TrimSpace(hit.Description)
			}
			if len(catEntry.Categories) == 0 {
				catEntry.Categories = hit.Categories
			}
			catEntry.Verified = hit.Verified
			catalog = append(catalog, catEntry)
		} else {
			catalog = append(catalog, ShuffleAttachedTool{
				AuthID:        "",
				Label:         strings.ReplaceAll(hitName, "_", " "),
				AppID:         hitID,
				AppName:       hitName,
				AppVersion:    strings.TrimSpace(hit.AppVersion),
				LargeImage:    img,
				ActionsCount:  hit.Actions,
				Authenticated: false,
				Valid:         false,
				Description:   strings.TrimSpace(hit.Description),
				Categories:    hit.Categories,
				Verified:      hit.Verified,
			})
		}
	}

	resp, _ := json.Marshal(map[string]interface{}{
		"status":   "ok",
		"apps":     tools,
		"catalog":  catalog,
		"query":    query,
		"org_id":   orgID,
		"base_url": baseURL,
		"attached": b.GetConversationShuffleToolsList(""),
	})
	return string(resp)
}

// SearchShuffleApps searches all Shuffle apps via Algolia and cross-correlates them with the active tenant's authentications
func (b *AgentBridge) SearchShuffleApps(payload string) string {
	return b.GetShuffleAuthenticatedApps(payload)
}

func (b *AgentBridge) fetchShuffleTenantAuthentications(ctx context.Context, baseURL, authToken, orgID string, forceRefresh bool) ([]ShuffleAttachedTool, error) {
	if !forceRefresh {
		b.shuffleToolsMu.RLock()
		if len(b.cachedShuffleAuths) > 0 && time.Since(b.cachedShuffleAuthsAt) < 15*time.Second {
			cached := make([]ShuffleAttachedTool, len(b.cachedShuffleAuths))
			copy(cached, b.cachedShuffleAuths)
			b.shuffleToolsMu.RUnlock()
			return cached, nil
		}
		b.shuffleToolsMu.RUnlock()
	}

	endpoint := strings.TrimRight(baseURL, "/") + "/api/v1/apps/authentication"
	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+authToken)
	req.Header.Set("Content-Type", "application/json")
	if orgID != "" {
		req.Header.Set("Org-Id", orgID)
		req.Header.Set("Org", orgID)
		req.Header.Set("X-Shuffle-Org-Id", orgID)
	}

	client := &http.Client{Timeout: 20 * time.Second}
	httpResp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer httpResp.Body.Close()

	bodyBytes, _ := io.ReadAll(httpResp.Body)
	if httpResp.StatusCode < 200 || httpResp.StatusCode >= 300 {
		return nil, fmt.Errorf("Shuffle API returned HTTP %d: %s", httpResp.StatusCode, strings.TrimSpace(string(bodyBytes)))
	}

	var rawList []shuffle.AppAuthenticationStorage
	if err := json.Unmarshal(bodyBytes, &rawList); err != nil {
		var wrapper struct {
			Success         bool                               `json:"success"`
			Data            []shuffle.AppAuthenticationStorage `json:"data"`
			Apps            []shuffle.AppAuthenticationStorage `json:"apps"`
			Authentications []shuffle.AppAuthenticationStorage `json:"authentications"`
		}
		if errW := json.Unmarshal(bodyBytes, &wrapper); errW == nil {
			if len(wrapper.Data) > 0 {
				rawList = wrapper.Data
			} else if len(wrapper.Apps) > 0 {
				rawList = wrapper.Apps
			} else if len(wrapper.Authentications) > 0 {
				rawList = wrapper.Authentications
			}
		}
	}

	type rawAuthMeta struct {
		ID         string `json:"id"`
		Label      string `json:"label"`
		Created    int64  `json:"created"`
		Edited     int64  `json:"edited"`
		ValidTop   *bool  `json:"valid"`
		Validation struct {
			Valid     bool  `json:"valid"`
			UpdatedAt int64 `json:"updated_at"`
			LastValid int64 `json:"last_valid"`
		} `json:"validation"`
		App struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"app"`
	}
	var rawMetaList []rawAuthMeta
	if errM := json.Unmarshal(bodyBytes, &rawMetaList); errM != nil {
		var metaWrap struct {
			Data            []rawAuthMeta `json:"data"`
			Apps            []rawAuthMeta `json:"apps"`
			Authentications []rawAuthMeta `json:"authentications"`
		}
		if json.Unmarshal(bodyBytes, &metaWrap) == nil {
			if len(metaWrap.Data) > 0 {
				rawMetaList = metaWrap.Data
			} else if len(metaWrap.Apps) > 0 {
				rawMetaList = metaWrap.Apps
			} else if len(metaWrap.Authentications) > 0 {
				rawMetaList = metaWrap.Authentications
			}
		}
	}
	type resolvedAuthMeta struct {
		Created int64
		Valid   bool
	}
	metaByKey := make(map[string]resolvedAuthMeta, len(rawMetaList)*2)
	for _, m := range rawMetaList {
		cTs := m.Created
		if cTs == 0 {
			cTs = m.Edited
		}
		isValid := m.Validation.Valid
		if !isValid && m.Validation.UpdatedAt == 0 && m.Validation.LastValid == 0 && m.ValidTop != nil && *m.ValidTop {
			isValid = true
		}
		rm := resolvedAuthMeta{Created: cTs, Valid: isValid}
		if id := strings.TrimSpace(m.ID); id != "" {
			metaByKey[id] = rm
		}
		compKey := strings.TrimSpace(m.App.ID) + ":" + strings.TrimSpace(m.App.Name)
		if existing, exists := metaByKey[compKey]; !exists || rm.Created > existing.Created || (rm.Valid && !existing.Valid) {
			metaByKey[compKey] = rm
		}
	}
	lookupMeta := func(item shuffle.AppAuthenticationStorage) resolvedAuthMeta {
		if id := strings.TrimSpace(item.Id); id != "" {
			if m, ok := metaByKey[id]; ok {
				return m
			}
		}
		compKey := strings.TrimSpace(item.App.ID) + ":" + strings.TrimSpace(item.App.Name)
		return metaByKey[compKey]
	}
	sort.SliceStable(rawList, func(i, j int) bool {
		mi := lookupMeta(rawList[i])
		mj := lookupMeta(rawList[j])
		if mi.Created != mj.Created {
			return mi.Created > mj.Created
		}
		if mi.Valid != mj.Valid {
			return mi.Valid
		}
		return strings.ToLower(rawList[i].App.Name) < strings.ToLower(rawList[j].App.Name)
	})

	tools := make([]ShuffleAttachedTool, 0, len(rawList))
	seenAuth := make(map[string]bool)
	for _, item := range rawList {
		appID := strings.TrimSpace(item.App.ID)
		appName := strings.TrimSpace(item.App.Name)
		authID := strings.TrimSpace(item.Id)
		if appName == "" && appID == "" {
			continue
		}
		dedupKey := authID
		if dedupKey == "" {
			dedupKey = appID + ":" + appName
		}
		if seenAuth[dedupKey] {
			continue
		}
		seenAuth[dedupKey] = true

		label := strings.TrimSpace(item.Label)
		if label == "" {
			label = appName
		}
		meta := lookupMeta(item)
		t := ShuffleAttachedTool{
			AuthID:        authID,
			Label:         label,
			AppID:         appID,
			AppName:       appName,
			AppVersion:    strings.TrimSpace(item.App.AppVersion),
			LargeImage:    b.resolveShuffleAppImage(item.App, baseURL),
			ActionsCount:  len(item.App.Actions),
			Created:       meta.Created,
			Valid:         meta.Valid,
			Authenticated: true,
			AuthType:      strings.TrimSpace(item.Type),
		}
		tools = append(tools, t)

		if len(item.App.Actions) > 0 {
			b.cacheWorkflowAppToDiskAndMemory(item.App)
		}
	}

	b.shuffleToolsMu.Lock()
	b.cachedShuffleAuths = make([]ShuffleAttachedTool, len(tools))
	copy(b.cachedShuffleAuths, tools)
	b.cachedShuffleAuthsAt = time.Now()
	b.shuffleToolsMu.Unlock()

	return tools, nil
}

// searchShuffleAppsViaAlgolia queries Shuffle's Algolia "appsearch" index for all apps matching query
func (b *AgentBridge) searchShuffleAppsViaAlgolia(ctx context.Context, query string, hitsPerPage int) ([]shuffle.AlgoliaSearchApp, error) {
	qKey := strings.ToLower(strings.TrimSpace(query))
	if hitsPerPage <= 0 {
		hitsPerPage = 60
	}

	b.shuffleToolsMu.RLock()
	if b.cachedAlgoliaQueries != nil && b.cachedAlgoliaQueriesAt != nil {
		if hits, ok := b.cachedAlgoliaQueries[qKey]; ok && time.Since(b.cachedAlgoliaQueriesAt[qKey]) < 60*time.Second {
			out := make([]shuffle.AlgoliaSearchApp, len(hits))
			copy(out, hits)
			b.shuffleToolsMu.RUnlock()
			return out, nil
		}
	}
	b.shuffleToolsMu.RUnlock()

	algoliaAppID := strings.TrimSpace(os.Getenv("ALGOLIA_CLIENT"))
	if algoliaAppID == "" {
		algoliaAppID = "JNSS5CFDZZ"
	}
	algoliaKey := strings.TrimSpace(os.Getenv("ALGOLIA_PUBLICKEY"))
	if algoliaKey == "" {
		algoliaKey = strings.TrimSpace(os.Getenv("ALGOLIA_SECRET"))
	}
	if algoliaKey == "" {
		algoliaKey = "db08e40265e2941b9a7d8f644b6e5240"
	}

	reqBody, _ := json.Marshal(map[string]interface{}{
		"query":       strings.TrimSpace(query),
		"hitsPerPage": hitsPerPage,
	})

	endpoints := []string{
		fmt.Sprintf("https://%s-dsn.algolia.net/1/indexes/appsearch/query", algoliaAppID),
		fmt.Sprintf("https://%s.algolia.net/1/indexes/appsearch/query", algoliaAppID),
	}

	client := &http.Client{Timeout: 10 * time.Second}
	var lastErr error
	for _, ep := range endpoints {
		req, err := http.NewRequestWithContext(ctx, "POST", ep, bytes.NewReader(reqBody))
		if err != nil {
			lastErr = err
			continue
		}
		req.Header.Set("X-Algolia-Application-Id", algoliaAppID)
		req.Header.Set("X-Algolia-API-Key", algoliaKey)
		req.Header.Set("Content-Type", "application/json")

		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		bodyBytes, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			lastErr = fmt.Errorf("Algolia returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(bodyBytes)))
			continue
		}

		var parsed struct {
			Hits []shuffle.AlgoliaSearchApp `json:"hits"`
		}
		if errU := json.Unmarshal(bodyBytes, &parsed); errU != nil {
			lastErr = errU
			continue
		}

		validHits := make([]shuffle.AlgoliaSearchApp, 0, len(parsed.Hits))
		for _, h := range parsed.Hits {
			if h.Invalid {
				continue
			}
			validHits = append(validHits, h)
		}

		b.shuffleToolsMu.Lock()
		if b.cachedAlgoliaQueries == nil {
			b.cachedAlgoliaQueries = make(map[string][]shuffle.AlgoliaSearchApp)
		}
		if b.cachedAlgoliaQueriesAt == nil {
			b.cachedAlgoliaQueriesAt = make(map[string]time.Time)
		}
		b.cachedAlgoliaQueries[qKey] = validHits
		b.cachedAlgoliaQueriesAt[qKey] = time.Now()
		b.shuffleToolsMu.Unlock()

		return validHits, nil
	}

	return nil, lastErr
}

func formatShuffleAuthParamLabel(rawName string) string {
	trimmed := strings.TrimSpace(rawName)
	lower := strings.ToLower(trimmed)
	switch lower {
	case "url", "base_url", "baseurl":
		return "URL"
	case "apikey", "api_key", "api-key":
		return "API Key"
	case "username_basic", "username", "basic_username":
		return "Username"
	case "password_basic", "password", "basic_password":
		return "Password"
	case "token", "bearer_token", "access_token", "auth_token":
		return "API / Bearer Token"
	case "client_id", "clientid":
		return "Client ID"
	case "client_secret", "clientsecret":
		return "Client Secret"
	case "tenant_id", "tenantid":
		return "Tenant ID"
	}
	clean := strings.ReplaceAll(trimmed, "_", " ")
	clean = strings.ReplaceAll(clean, "-", " ")
	words := strings.Fields(clean)
	for i, w := range words {
		if len(w) > 0 {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	if len(words) > 0 {
		return strings.Join(words, " ")
	}
	return trimmed
}

func isShuffleAuthParamSecret(rawName string) bool {
	lower := strings.ToLower(strings.TrimSpace(rawName))
	if lower == "url" || lower == "base_url" || lower == "username" || lower == "username_basic" ||
		lower == "domain" || lower == "host" || lower == "port" || lower == "verify" || lower == "ssl" ||
		lower == "org_id" || lower == "tenant_id" || lower == "client_id" || lower == "project_id" {
		return false
	}
	return strings.Contains(lower, "key") || strings.Contains(lower, "token") ||
		strings.Contains(lower, "pass") || strings.Contains(lower, "secret") ||
		strings.Contains(lower, "credential") || strings.Contains(lower, "private")
}

// GetShuffleAppAuthConfig returns the required authentication parameters for a Shuffle app via GET /api/v1/apps/{id}/config
func (b *AgentBridge) GetShuffleAppAuthConfig(payload string) string {
	var req struct {
		AppID      string `json:"app_id"`
		AppName    string `json:"app_name"`
		AppVersion string `json:"app_version"`
		LargeImage string `json:"large_image"`
	}
	if err := json.Unmarshal([]byte(payload), &req); err != nil {
		resp, _ := json.Marshal(map[string]interface{}{
			"status": "error",
			"error":  "Invalid request payload: " + err.Error(),
		})
		return string(resp)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	tool := ShuffleAttachedTool{
		AppID:      strings.TrimSpace(req.AppID),
		AppName:    strings.TrimSpace(req.AppName),
		AppVersion: strings.TrimSpace(req.AppVersion),
		LargeImage: strings.TrimSpace(req.LargeImage),
	}

	wfApp, err := b.ensureShuffleAppCached(ctx, tool)
	if err != nil || wfApp == nil {
		errMsg := "Failed to load app configuration from Shuffle"
		if err != nil {
			errMsg = err.Error()
		}
		resp, _ := json.Marshal(map[string]interface{}{
			"status": "error",
			"error":  errMsg,
		})
		return string(resp)
	}

	baseURL, _, _, _ := b.resolveShuffleCloudCredentials()
	fields := make([]ShuffleAppAuthFieldSchema, 0, len(wfApp.Authentication.Parameters)+4)
	seenField := make(map[string]bool)

	addField := func(name, desc, example, val string, required, multiline bool, options []string) {
		trimmed := strings.TrimSpace(name)
		if trimmed == "" {
			return
		}
		keyLower := strings.ToLower(trimmed)
		if seenField[keyLower] {
			return
		}
		seenField[keyLower] = true

		if keyLower == "url" && example == "" {
			if strings.TrimSpace(wfApp.Authentication.RedirectUri) != "" {
				example = strings.TrimSpace(wfApp.Authentication.RedirectUri)
			} else if strings.TrimSpace(wfApp.Link) != "" {
				example = strings.TrimSpace(wfApp.Link)
			} else {
				example = "https://api.example.com"
			}
		}

		fields = append(fields, ShuffleAppAuthFieldSchema{
			Name:        trimmed,
			Label:       formatShuffleAuthParamLabel(trimmed),
			Description: strings.TrimSpace(desc),
			Example:     strings.TrimSpace(example),
			DefaultVal:  strings.TrimSpace(val),
			Required:    required,
			Multiline:   multiline,
			Secret:      isShuffleAuthParamSecret(trimmed),
			Options:     options,
		})
	}

	for _, p := range wfApp.Authentication.Parameters {
		reqFlag := p.Required
		if !reqFlag && wfApp.Authentication.Required {
			reqFlag = true
		}
		addField(p.Name, p.Description, p.Example, p.Value, reqFlag, p.Multiline, nil)
	}

	// Also check action parameters marked Configuration == true (used by OpenAPI/custom apps)
	for _, act := range wfApp.Actions {
		for _, p := range act.Parameters {
			if p.Configuration {
				addField(p.Name, p.Description, p.Example, p.Value, true, p.Multiline, p.Options)
			}
		}
	}

	authType := strings.TrimSpace(wfApp.Authentication.Type)
	authRequired := wfApp.Authentication.Required || len(fields) > 0

	// Provide standard fallback fields if authType specifies credentials but Parameters was empty
	if len(fields) == 0 && authRequired {
		switch strings.ToLower(authType) {
		case "basic":
			addField("username_basic", "Username for HTTP Basic authentication", "", "", true, false, nil)
			addField("password_basic", "Password or API token for HTTP Basic authentication", "", "", true, false, nil)
			addField("url", "Base URL of the service", "https://api.example.com", "", true, false, nil)
		case "bearer", "apikey", "api_key", "header", "query":
			addField("apikey", "API Key or Bearer Token", "", "", true, false, nil)
			addField("url", "Base URL of the service", "https://api.example.com", "", true, false, nil)
		case "oauth2", "oauth2-app":
			addField("client_id", "OAuth2 Client ID", "", "", true, false, nil)
			addField("client_secret", "OAuth2 Client Secret", "", "", true, false, nil)
			addField("url", "Base URL of the service", "https://api.example.com", "", false, false, nil)
		}
	}

	img := b.resolveShuffleAppImage(*wfApp, baseURL)
	if img == "" && req.LargeImage != "" {
		img = normalizeShuffleAppImage(req.LargeImage, "", baseURL)
	}

	resp, _ := json.Marshal(map[string]interface{}{
		"status":        "ok",
		"app_id":        wfApp.ID,
		"app_name":      wfApp.Name,
		"app_version":   wfApp.AppVersion,
		"large_image":   img,
		"description":   strings.TrimSpace(wfApp.Description),
		"actions_count": len(wfApp.Actions),
		"auth_required": authRequired,
		"auth_type":     authType,
		"redirect_uri":  strings.TrimSpace(wfApp.Authentication.RedirectUri),
		"fields":        fields,
	})
	return string(resp)
}

// AuthenticateShuffleApp creates/updates an app authentication in Shuffle via PUT /api/v1/apps/authentication
func (b *AgentBridge) AuthenticateShuffleApp(payload string) string {
	var req struct {
		AppID          string `json:"app_id"`
		AppName        string `json:"app_name"`
		AppVersion     string `json:"app_version"`
		LargeImage     string `json:"large_image"`
		Label          string `json:"label"`
		AutoDistribute *bool  `json:"auto_distribute"`
		Fields         []struct {
			Key   string `json:"key"`
			Value string `json:"value"`
		} `json:"fields"`
	}
	if err := json.Unmarshal([]byte(payload), &req); err != nil {
		resp, _ := json.Marshal(map[string]interface{}{
			"status": "error",
			"error":  "Invalid request payload: " + err.Error(),
		})
		return string(resp)
	}

	baseURL, authToken, orgID, ok := b.resolveShuffleCloudCredentials()
	if !ok {
		resp, _ := json.Marshal(map[string]interface{}{
			"status": "error",
			"error":  "Not authenticated to Shuffle AI. Please sign in first.",
		})
		return string(resp)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()

	wfApp, err := b.ensureShuffleAppCached(ctx, ShuffleAttachedTool{
		AppID:      strings.TrimSpace(req.AppID),
		AppName:    strings.TrimSpace(req.AppName),
		AppVersion: strings.TrimSpace(req.AppVersion),
		LargeImage: strings.TrimSpace(req.LargeImage),
	})

	canonicalID := strings.TrimSpace(req.AppID)
	canonicalName := strings.TrimSpace(req.AppName)
	canonicalVer := strings.TrimSpace(req.AppVersion)
	canonicalImg := strings.TrimSpace(req.LargeImage)
	authType := "apikey"

	if wfApp != nil {
		if strings.TrimSpace(wfApp.ID) != "" {
			canonicalID = strings.TrimSpace(wfApp.ID)
		}
		if strings.TrimSpace(wfApp.Name) != "" {
			canonicalName = strings.TrimSpace(wfApp.Name)
		}
		if strings.TrimSpace(wfApp.AppVersion) != "" {
			canonicalVer = strings.TrimSpace(wfApp.AppVersion)
		}
		if resolved := b.resolveShuffleAppImage(*wfApp, baseURL); resolved != "" {
			canonicalImg = resolved
		}
		if strings.TrimSpace(wfApp.Authentication.Type) != "" {
			authType = strings.TrimSpace(wfApp.Authentication.Type)
		}
	} else if err != nil && (canonicalID == "" || canonicalName == "") {
		resp, _ := json.Marshal(map[string]interface{}{
			"status": "error",
			"error":  "Failed to load app configuration: " + err.Error(),
		})
		return string(resp)
	}

	if canonicalVer == "" {
		canonicalVer = "1.0.0"
	}

	label := strings.TrimSpace(req.Label)
	if label == "" {
		displayApp := strings.ReplaceAll(canonicalName, "_", " ")
		if displayApp == "" {
			displayApp = "App"
		}
		label = displayApp + " Auth"
	}

	storeFields := make([]shuffle.AuthenticationStore, 0, len(req.Fields))
	for _, f := range req.Fields {
		k := strings.TrimSpace(f.Key)
		v := strings.TrimSpace(f.Value)
		if k == "" {
			continue
		}
		// Shuffle's AddAppAuthentication requires "url" to start with http(s):// and NOT end with "/"
		if strings.EqualFold(k, "url") && v != "" {
			if !strings.Contains(v, "://") {
				v = "https://" + v
			}
			v = strings.TrimRight(v, "/")
		}
		storeFields = append(storeFields, shuffle.AuthenticationStore{
			Key:   k,
			Value: v,
		})
	}

	autoDist := true
	if req.AutoDistribute != nil {
		autoDist = *req.AutoDistribute
	}

	nowTs := time.Now().Unix()
	authStorage := shuffle.AppAuthenticationStorage{
		Active:         true,
		Defined:        true,
		Label:          label,
		Type:           authType,
		AutoDistribute: autoDist,
		Created:        nowTs,
		Edited:         nowTs,
		App: shuffle.WorkflowApp{
			ID:         canonicalID,
			Name:       canonicalName,
			AppVersion: canonicalVer,
		},
		Fields: storeFields,
	}

	bodyBytes, err := json.Marshal(authStorage)
	if err != nil {
		resp, _ := json.Marshal(map[string]interface{}{
			"status": "error",
			"error":  err.Error(),
		})
		return string(resp)
	}

	endpoint := strings.TrimRight(baseURL, "/") + "/api/v1/apps/authentication"
	httpReq, err := http.NewRequestWithContext(ctx, "PUT", endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		resp, _ := json.Marshal(map[string]interface{}{
			"status": "error",
			"error":  err.Error(),
		})
		return string(resp)
	}
	httpReq.Header.Set("Authorization", "Bearer "+authToken)
	httpReq.Header.Set("Content-Type", "application/json")
	if orgID != "" {
		httpReq.Header.Set("Org-Id", orgID)
		httpReq.Header.Set("Org", orgID)
		httpReq.Header.Set("X-Shuffle-Org-Id", orgID)
	}

	client := &http.Client{Timeout: 25 * time.Second}
	httpResp, err := client.Do(httpReq)
	if err != nil {
		resp, _ := json.Marshal(map[string]interface{}{
			"status": "error",
			"error":  "Failed to contact Shuffle API: " + err.Error(),
		})
		return string(resp)
	}
	defer httpResp.Body.Close()

	respBytes, _ := io.ReadAll(httpResp.Body)
	var apiRes struct {
		Success bool   `json:"success"`
		ID      string `json:"id"`
		Reason  string `json:"reason"`
		Details string `json:"details"`
	}
	_ = json.Unmarshal(respBytes, &apiRes)

	if httpResp.StatusCode < 200 || httpResp.StatusCode >= 300 || !apiRes.Success {
		reason := strings.TrimSpace(apiRes.Reason)
		if apiRes.Details != "" {
			if reason != "" {
				reason += ": " + strings.TrimSpace(apiRes.Details)
			} else {
				reason = strings.TrimSpace(apiRes.Details)
			}
		}
		if reason == "" {
			reason = fmt.Sprintf("Shuffle API returned HTTP %d: %s", httpResp.StatusCode, strings.TrimSpace(string(respBytes)))
		}
		resp, _ := json.Marshal(map[string]interface{}{
			"status": "error",
			"error":  reason,
		})
		return string(resp)
	}

	// Invalidate tenant auth cache so the subsequent refresh includes the newly created authentication immediately
	b.shuffleToolsMu.Lock()
	b.cachedShuffleAuthsAt = time.Time{}
	b.shuffleToolsMu.Unlock()

	actionsCount := 0
	if wfApp != nil {
		actionsCount = len(wfApp.Actions)
	}

	newTool := ShuffleAttachedTool{
		AuthID:        strings.TrimSpace(apiRes.ID),
		Label:         label,
		AppID:         canonicalID,
		AppName:       canonicalName,
		AppVersion:    canonicalVer,
		LargeImage:    normalizeShuffleAppImage(canonicalImg, "", baseURL),
		ActionsCount:  actionsCount,
		Created:       nowTs,
		Valid:         true,
		Authenticated: true,
		AuthType:      authType,
	}

	resp, _ := json.Marshal(map[string]interface{}{
		"status":  "ok",
		"auth_id": newTool.AuthID,
		"tool":    newTool,
	})
	return string(resp)
}

// normalizeShuffleAppImage cleans and normalizes Shuffle app icon values (large_image / small_image).
// Shuffle apps may store large_image as:
//  1. A full data URI ("data:image/png;base64,...", sometimes with embedded whitespace/newlines or duplicate prefixes)
//  2. Raw base64 bytes without a "data:image/...;base64," header (e.g. "iVBOR...", "/9j/...", "PHN2Zy...")
//  3. An absolute http(s) URL
//  4. A relative path ("/api/v1/..." or "/images/...") requiring baseURL prefixing
func normalizeShuffleAppImage(largeImg, smallImg, baseURL string) string {
	raw := strings.TrimSpace(largeImg)
	if raw == "" {
		raw = strings.TrimSpace(smallImg)
	}
	raw = strings.Trim(raw, "\"'`")
	if raw == "" || raw == "null" || raw == "undefined" {
		return ""
	}

	lower := strings.ToLower(raw)
	if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
		return raw
	}

	if strings.HasPrefix(raw, "/") && !strings.HasPrefix(raw, "/9j/") {
		base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
		if base == "" {
			base = "https://shuffler.io"
		}
		return base + raw
	}

	// Collapse whitespace/newlines inside data URIs or raw base64 payloads
	cleaned := strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' || r == ' ' {
			return -1
		}
		return r
	}, raw)
	lowerCleaned := strings.ToLower(cleaned)

	if strings.HasPrefix(lowerCleaned, "data:image") {
		// Handle accidental duplicate data:image prefixes (e.g. "data:image/png;base64,data:image/jpeg;base64,...")
		if idx := strings.Index(lowerCleaned[10:], "data:image"); idx != -1 {
			cleaned = cleaned[10+idx:]
			lowerCleaned = strings.ToLower(cleaned)
		}
		// Fix malformed "data:image;base64," missing subtype
		if strings.HasPrefix(lowerCleaned, "data:image;base64,") {
			cleaned = "data:image/png;base64," + cleaned[len("data:image;base64,"):]
		}
		return cleaned
	}

	// Detect raw base64-encoded image payloads lacking a data URI prefix
	mime := ""
	switch {
	case strings.HasPrefix(cleaned, "iVBOR"):
		mime = "image/png"
	case strings.HasPrefix(cleaned, "/9j/"):
		mime = "image/jpeg"
	case strings.HasPrefix(cleaned, "R0lGOD"):
		mime = "image/gif"
	case strings.HasPrefix(cleaned, "UklGR"):
		mime = "image/webp"
	case strings.HasPrefix(cleaned, "PHN2Zy") || strings.HasPrefix(cleaned, "PD94bW"):
		mime = "image/svg+xml"
	case len(cleaned) > 64 && !strings.ContainsAny(cleaned, "<>{}[]\"'\\"):
		mime = "image/png"
	}
	if mime != "" {
		return "data:" + mime + ";base64," + cleaned
	}

	return raw
}

func (b *AgentBridge) resolveShuffleAppImage(app shuffle.WorkflowApp, baseURL string) string {
	if img := normalizeShuffleAppImage(app.LargeImage, app.SmallImage, baseURL); img != "" {
		return img
	}
	appID := strings.TrimSpace(app.ID)
	appName := strings.TrimSpace(app.Name)

	b.shuffleToolsMu.RLock()
	if b.cachedShuffleApps != nil {
		if appID != "" {
			if cached, ok := b.cachedShuffleApps[appID]; ok {
				if img := normalizeShuffleAppImage(cached.LargeImage, cached.SmallImage, baseURL); img != "" {
					b.shuffleToolsMu.RUnlock()
					return img
				}
			}
		}
		if appName != "" {
			if cached, ok := b.cachedShuffleApps[strings.ToLower(appName)]; ok {
				if img := normalizeShuffleAppImage(cached.LargeImage, cached.SmallImage, baseURL); img != "" {
					b.shuffleToolsMu.RUnlock()
					return img
				}
			}
		}
	}
	b.shuffleToolsMu.RUnlock()

	appsDir := filepath.Join("files", "apps")
	candidates := []string{}
	if appID != "" {
		candidates = append(candidates, filepath.Join(appsDir, appID+".json"))
	}
	if appName != "" {
		candidates = append(candidates, filepath.Join(appsDir, normalizeShuffleAppFilename(appName)+".json"))
	}
	for _, cand := range candidates {
		if data, err := os.ReadFile(cand); err == nil && len(data) > 0 {
			var wfApp shuffle.WorkflowApp
			if errU := json.Unmarshal(data, &wfApp); errU == nil {
				if img := normalizeShuffleAppImage(wfApp.LargeImage, wfApp.SmallImage, baseURL); img != "" {
					return img
				}
			}
		}
	}
	return ""
}

func normalizeShuffleAppFilename(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	s = strings.ReplaceAll(s, " ", "-")
	s = strings.ReplaceAll(s, "_", "-")
	return s
}

func (b *AgentBridge) cacheWorkflowAppToDiskAndMemory(app shuffle.WorkflowApp) {
	if strings.TrimSpace(app.Name) == "" && strings.TrimSpace(app.ID) == "" {
		return
	}
	b.shuffleToolsMu.Lock()
	if b.cachedShuffleApps == nil {
		b.cachedShuffleApps = make(map[string]shuffle.WorkflowApp)
	}
	if app.ID != "" {
		b.cachedShuffleApps[app.ID] = app
	}
	if app.Name != "" {
		b.cachedShuffleApps[strings.ToLower(strings.TrimSpace(app.Name))] = app
		b.cachedShuffleApps[normalizeShuffleAppFilename(app.Name)] = app
	}
	b.shuffleToolsMu.Unlock()

	rawBytes, err := json.Marshal(app)
	if err != nil || len(rawBytes) == 0 {
		return
	}
	appsDir := filepath.Join("files", "apps")
	_ = os.MkdirAll(appsDir, 0755)
	if strings.TrimSpace(app.ID) != "" {
		_ = os.WriteFile(filepath.Join(appsDir, strings.TrimSpace(app.ID)+".json"), rawBytes, 0644)
	}
	if strings.TrimSpace(app.Name) != "" {
		normName := normalizeShuffleAppFilename(app.Name)
		if normName != "" {
			_ = os.WriteFile(filepath.Join(appsDir, normName+".json"), rawBytes, 0644)
		}
	}
}

// ensureShuffleAppCached guarantees that the WorkflowApp specification (including Actions) for tool is cached in memory and ./files/apps/
func (b *AgentBridge) ensureShuffleAppCached(ctx context.Context, tool ShuffleAttachedTool) (*shuffle.WorkflowApp, error) {
	appID := strings.TrimSpace(tool.AppID)
	appName := strings.TrimSpace(tool.AppName)

	b.shuffleToolsMu.RLock()
	if b.cachedShuffleApps != nil {
		if appID != "" {
			if existing, ok := b.cachedShuffleApps[appID]; ok && len(existing.Actions) > 0 {
				b.shuffleToolsMu.RUnlock()
				return &existing, nil
			}
		}
		if appName != "" {
			if existing, ok := b.cachedShuffleApps[strings.ToLower(appName)]; ok && len(existing.Actions) > 0 {
				b.shuffleToolsMu.RUnlock()
				return &existing, nil
			}
		}
	}
	b.shuffleToolsMu.RUnlock()

	// Check local ./files/apps/ cache
	appsDir := filepath.Join("files", "apps")
	candidates := []string{}
	if appID != "" {
		candidates = append(candidates, filepath.Join(appsDir, appID+".json"))
	}
	if appName != "" {
		candidates = append(candidates, filepath.Join(appsDir, normalizeShuffleAppFilename(appName)+".json"))
	}
	for _, cand := range candidates {
		if data, err := os.ReadFile(cand); err == nil && len(data) > 0 {
			var wfApp shuffle.WorkflowApp
			if errU := json.Unmarshal(data, &wfApp); errU == nil && len(wfApp.Actions) > 0 {
				b.cacheWorkflowAppToDiskAndMemory(wfApp)
				return &wfApp, nil
			}
		}
	}

	baseURL, authToken, orgID, ok := b.resolveShuffleCloudCredentials()
	if !ok {
		if fallbackApp := getBuiltinShuffleSkillWorkflowApp(appID, appName); fallbackApp != nil {
			b.cacheWorkflowAppToDiskAndMemory(*fallbackApp)
			return fallbackApp, nil
		}
		return nil, fmt.Errorf("not authenticated to Shuffle AI")
	}

	targetID := appID
	if targetID == "" {
		targetID = normalizeShuffleAppFilename(appName)
	}
	if targetID == "" {
		return nil, fmt.Errorf("missing Shuffle app ID and name")
	}

	reqCtx := ctx
	if reqCtx == nil || reqCtx.Err() != nil {
		var cancel context.CancelFunc
		reqCtx, cancel = context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
	}

	configURL := fmt.Sprintf("%s/api/v1/apps/%s/config", strings.TrimRight(baseURL, "/"), targetID)
	req, err := http.NewRequestWithContext(reqCtx, "GET", configURL, nil)
	if err != nil {
		if fallbackApp := getBuiltinShuffleSkillWorkflowApp(appID, appName); fallbackApp != nil {
			b.cacheWorkflowAppToDiskAndMemory(*fallbackApp)
			return fallbackApp, nil
		}
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+authToken)
	req.Header.Set("Content-Type", "application/json")
	if orgID != "" {
		req.Header.Set("Org-Id", orgID)
		req.Header.Set("Org", orgID)
		req.Header.Set("X-Shuffle-Org-Id", orgID)
	}

	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		if fallbackApp := getBuiltinShuffleSkillWorkflowApp(appID, appName); fallbackApp != nil {
			b.cacheWorkflowAppToDiskAndMemory(*fallbackApp)
			return fallbackApp, nil
		}
		return nil, err
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if fallbackApp := getBuiltinShuffleSkillWorkflowApp(appID, appName); fallbackApp != nil {
			b.cacheWorkflowAppToDiskAndMemory(*fallbackApp)
			return fallbackApp, nil
		}
		return nil, fmt.Errorf("GET /api/v1/apps/%s/config returned HTTP %d", targetID, resp.StatusCode)
	}

	var wfApp shuffle.WorkflowApp
	var parsedConfig shuffle.AppParser
	if errP := json.Unmarshal(bodyBytes, &parsedConfig); errP == nil && len(parsedConfig.App) > 0 {
		_ = json.Unmarshal(parsedConfig.App, &wfApp)
	}
	if len(wfApp.Actions) == 0 && wfApp.Name == "" {
		_ = json.Unmarshal(bodyBytes, &wfApp)
	}
	if wfApp.ID == "" {
		wfApp.ID = appID
	}
	if wfApp.Name == "" {
		wfApp.Name = appName
	}
	if wfApp.AppVersion == "" {
		wfApp.AppVersion = tool.AppVersion
	}
	if normImg := normalizeShuffleAppImage(wfApp.LargeImage, wfApp.SmallImage, baseURL); normImg != "" {
		wfApp.LargeImage = normImg
	} else if tool.LargeImage != "" {
		wfApp.LargeImage = normalizeShuffleAppImage(tool.LargeImage, "", baseURL)
	}
	b.cacheWorkflowAppToDiskAndMemory(wfApp)
	return &wfApp, nil
}

// SetConversationShuffleToolsList updates the attached Shuffle tools for a conversation (and default tools list)
func (b *AgentBridge) SetConversationShuffleToolsList(convID string, tools []ShuffleAttachedTool) {
	cleaned := make([]ShuffleAttachedTool, 0, len(tools))
	seen := make(map[string]bool)
	for _, t := range tools {
		key := strings.TrimSpace(t.AuthID)
		if key == "" {
			key = strings.TrimSpace(t.AppID) + ":" + strings.TrimSpace(t.AppName)
		}
		if key == ":" || seen[key] {
			continue
		}
		seen[key] = true
		t.LargeImage = normalizeShuffleAppImage(t.LargeImage, "", "")
		if t.LargeImage == "" {
			t.LargeImage = b.resolveShuffleAppImage(shuffle.WorkflowApp{ID: t.AppID, Name: t.AppName}, "")
		}
		cleaned = append(cleaned, t)
	}

	b.shuffleToolsMu.Lock()
	if b.convShuffleTools == nil {
		b.convShuffleTools = make(map[string][]ShuffleAttachedTool)
	}
	b.defaultShuffleTools = cleaned
	if strings.TrimSpace(convID) != "" {
		b.convShuffleTools[strings.TrimSpace(convID)] = cleaned
	}
	b.shuffleToolsMu.Unlock()

	// Pre-cache app configs in background so they are ready on disk immediately
	if len(cleaned) > 0 {
		go func(items []ShuffleAttachedTool) {
			ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
			defer cancel()
			for _, item := range items {
				_, _ = b.ensureShuffleAppCached(ctx, item)
			}
		}(cleaned)
	}
}

// GetConversationShuffleToolsList returns the attached Shuffle tools for convID (or defaultShuffleTools)
func (b *AgentBridge) GetConversationShuffleToolsList(convID string) []ShuffleAttachedTool {
	b.shuffleToolsMu.RLock()
	defer b.shuffleToolsMu.RUnlock()

	trimmed := strings.TrimSpace(convID)
	if trimmed != "" && b.convShuffleTools != nil {
		if list, ok := b.convShuffleTools[trimmed]; ok {
			out := make([]ShuffleAttachedTool, len(list))
			copy(out, list)
			return out
		}
	}
	out := make([]ShuffleAttachedTool, len(b.defaultShuffleTools))
	copy(out, b.defaultShuffleTools)
	return out
}

// SetConversationShuffleTools handles the JS bridge action to set attached Shuffle tools (even while an execution is running)
func (b *AgentBridge) SetConversationShuffleTools(payload string) string {
	var req struct {
		ConversationID string                `json:"conversation_id"`
		Tools          []ShuffleAttachedTool `json:"tools"`
	}
	if err := json.Unmarshal([]byte(payload), &req); err != nil {
		var directList []ShuffleAttachedTool
		if err2 := json.Unmarshal([]byte(payload), &directList); err2 == nil {
			req.Tools = directList
		}
	}
	b.SetConversationShuffleToolsList(req.ConversationID, req.Tools)
	attached := b.GetConversationShuffleToolsList(req.ConversationID)
	resp, _ := json.Marshal(map[string]interface{}{
		"status":          "ok",
		"conversation_id": req.ConversationID,
		"tools":           attached,
	})
	return string(resp)
}

// GetConversationShuffleTools handles the JS bridge action to read attached Shuffle tools for a conversation
func (b *AgentBridge) GetConversationShuffleTools(payload string) string {
	convID := strings.TrimSpace(payload)
	var req struct {
		ConversationID string `json:"conversation_id"`
	}
	if strings.HasPrefix(convID, "{") {
		if err := json.Unmarshal([]byte(payload), &req); err == nil {
			convID = strings.TrimSpace(req.ConversationID)
		}
	}
	attached := b.GetConversationShuffleToolsList(convID)
	resp, _ := json.Marshal(map[string]interface{}{
		"status":          "ok",
		"conversation_id": convID,
		"tools":           attached,
	})
	return string(resp)
}

// syncTurnShuffleTools updates startNode and exec action parameters with all currently attached Shuffle tools and shuffle-shared skills for convID
func (b *AgentBridge) syncTurnShuffleTools(ctx context.Context, convID string, startNode *shuffle.Action, exec *shuffle.WorkflowExecution) {
	if startNode == nil {
		return
	}
	attachedSkills := b.GetConversationShuffleSkillsList(convID)
	attached := b.GetEffectiveConversationShuffleToolsList(convID)
	const startMarker = "\n<!-- SHUFFLE_ATTACHED_TOOLS_START -->\n"
	const endMarker = "\n<!-- SHUFFLE_ATTACHED_TOOLS_END -->\n"

	primaryTemplate := ""
	actionParts := []string{"subflow:osctrl"}
	seenActionParts := map[string]bool{"subflow:osctrl": true}
	for _, sk := range attachedSkills {
		if primaryTemplate == "" && strings.TrimSpace(sk.Template) != "" {
			primaryTemplate = strings.TrimSpace(sk.Template)
		}
		for _, reqApp := range sk.RequiredApps {
			trimmedApp := strings.TrimSpace(reqApp)
			if trimmedApp != "" && !seenActionParts[trimmedApp] {
				seenActionParts[trimmedApp] = true
				actionParts = append(actionParts, trimmedApp)
			}
		}
	}
	combinedActionValue := strings.Join(actionParts, ",")

	var toolsBlock string
	if len(attached) > 0 || len(attachedSkills) > 0 {
		var sb strings.Builder
		sb.WriteString(startMarker)
		if len(attachedSkills) > 0 {
			sb.WriteString("ATTACHED SHUFFLE SHARED SKILLS (Predefined Templates & Tools):\n")
			for idx, sk := range attachedSkills {
				var toolNames []string
				for _, t := range sk.Tools {
					if strings.TrimSpace(t.AppName) != "" {
						toolNames = append(toolNames, t.AppName)
					}
				}
				sb.WriteString(fmt.Sprintf("%d. Skill: %q (Template: %q, Category: %q) — %s [Predefined Tools: %s]\n",
					idx+1, sk.Name, sk.Template, sk.Category, sk.Description, strings.Join(toolNames, ", ")))
			}
			sb.WriteString("\n")
		}
		if len(attached) > 0 {
			sb.WriteString("ATTACHED SHUFFLE CLOUD APP TOOLS (Authenticated & Ready for Remote Execution):\n")
			sb.WriteString("The user has attached the following Shuffle apps/tools to this conversation. You can execute their actions directly via Shuffle Cloud (/api/v1/apps/{id}/run).\n")
			sb.WriteString("HOW TO EXECUTE AN ATTACHED SHUFFLE APP ACTION:\n")
			sb.WriteString("- Output a tool decision with \"category\": \"subflow\", \"tool\": \"<AppName>\", \"action\": \"<action_name>\", and \"fields\": [{\"key\": \"<param_name>\", \"value\": \"<value>\"}].\n")
			sb.WriteString("- Authentication parameters (url, apikey, token, basic_auth, configuration fields) are automatically injected by Shuffle Cloud — do NOT ask the user for API keys or credentials for these attached apps.\n\n")

			for idx, t := range attached {
				appName := strings.TrimSpace(t.AppName)
				appID := strings.TrimSpace(t.AppID)
				if appName == "" && appID == "" {
					continue
				}
				wfApp, _ := b.ensureShuffleAppCached(ctx, t)
				displayLabel := strings.TrimSpace(t.Label)
				if displayLabel == "" {
					displayLabel = appName
				}
				sb.WriteString(fmt.Sprintf("%d. App Tool: %q (Label: %q, App ID: %q, Auth ID: %q, Valid: %v)\n",
					idx+1, appName, displayLabel, appID, t.AuthID, t.Valid))
				if wfApp != nil && len(wfApp.Actions) > 0 {
					sb.WriteString("   Available Actions:\n")
					maxActs := len(wfApp.Actions)
					if maxActs > 60 {
						maxActs = 60
					}
					for aIdx := 0; aIdx < maxActs; aIdx++ {
						act := wfApp.Actions[aIdx]
						actDesc := strings.TrimSpace(act.Description)
						if len(actDesc) > 160 {
							actDesc = actDesc[:157] + "..."
						}
						var paramDescs []string
						for _, p := range act.Parameters {
							pNameLower := strings.ToLower(strings.TrimSpace(p.Name))
							if p.Configuration || pNameLower == "url" || pNameLower == "apikey" || pNameLower == "api_key" || pNameLower == "token" || pNameLower == "basic_auth" {
								continue
							}
							reqTag := "optional"
							if p.Required {
								reqTag = "required"
							}
							paramDescs = append(paramDescs, fmt.Sprintf("%s (%s)", p.Name, reqTag))
						}
						paramStr := "no non-auth parameters"
						if len(paramDescs) > 0 {
							paramStr = "params: " + strings.Join(paramDescs, ", ")
						}
						if actDesc != "" {
							sb.WriteString(fmt.Sprintf("   - action=%q (label=%q): %s [%s]\n", act.Name, act.Label, actDesc, paramStr))
						} else {
							sb.WriteString(fmt.Sprintf("   - action=%q (label=%q) [%s]\n", act.Name, act.Label, paramStr))
						}
					}
				}
			}
		}
		sb.WriteString(endMarker)
		toolsBlock = sb.String()
	}

	injectIntoInput := func(rawInput string) string {
		cleaned := rawInput
		if sIdx := strings.Index(cleaned, startMarker); sIdx >= 0 {
			if eIdx := strings.Index(cleaned[sIdx:], endMarker); eIdx >= 0 {
				cleaned = cleaned[:sIdx] + cleaned[sIdx+eIdx+len(endMarker):]
			}
		}
		if toolsBlock == "" {
			return cleaned
		}
		if uIdx := strings.LastIndex(cleaned, "\nUser Request:\n"); uIdx >= 0 {
			return cleaned[:uIdx] + toolsBlock + cleaned[uIdx:]
		}
		return cleaned + toolsBlock
	}

	updateNodeParams := func(params []shuffle.WorkflowAppActionParameter) []shuffle.WorkflowAppActionParameter {
		foundTemplate := false
		for idx := range params {
			if params[idx].Name == "action" {
				params[idx].Value = combinedActionValue
			} else if params[idx].Name == "input" {
				params[idx].Value = injectIntoInput(params[idx].Value)
			} else if params[idx].Name == "template" {
				params[idx].Value = primaryTemplate
				foundTemplate = true
			}
		}
		if !foundTemplate && primaryTemplate != "" {
			params = append(params, shuffle.WorkflowAppActionParameter{
				Name:  "template",
				Value: primaryTemplate,
			})
		}
		return params
	}

	startNode.Parameters = updateNodeParams(startNode.Parameters)
	if exec != nil {
		for aIdx := range exec.Workflow.Actions {
			if exec.Workflow.Actions[aIdx].ID == startNode.ID {
				exec.Workflow.Actions[aIdx].Parameters = updateNodeParams(exec.Workflow.Actions[aIdx].Parameters)
			}
		}
	}
}
func (b *AgentBridge) unusedSyncTurnShuffleToolsStub(convID string, startNode *shuffle.Action) {
	if false {
		if false {
			_ = convID
			_ = startNode
		}
	}
	if true {
		return
	}
	if startNode == nil {
		return
	}
	attached := b.GetConversationShuffleToolsList(convID)
	var ctx context.Context
	var exec *shuffle.WorkflowExecution
	actionParts := []string{"subflow:osctrl"}
	for _, t := range attached {
		appName := strings.TrimSpace(t.AppName)
		appID := strings.TrimSpace(t.AppID)
		if appName == "" && appID == "" {
			continue
		}
		_, _ = b.ensureShuffleAppCached(ctx, t)
		if (len(appID) == 32 || len(appID) == 36) && appName != "" {
			actionParts = append(actionParts, fmt.Sprintf("app:%s:%s", appID, appName))
		} else if appName != "" {
			actionParts = append(actionParts, fmt.Sprintf("app:%s", appName))
		} else {
			actionParts = append(actionParts, fmt.Sprintf("app:%s", appID))
		}
	}
	combinedActions := strings.Join(actionParts, ",")

	updateParams := func(params []shuffle.WorkflowAppActionParameter) {
		for idx := range params {
			if params[idx].Name == "action" {
				params[idx].Value = combinedActions
				return
			}
		}
	}
	updateParams(startNode.Parameters)
	if exec != nil {
		for aIdx := range exec.Workflow.Actions {
			if exec.Workflow.Actions[aIdx].ID == startNode.ID {
				updateParams(exec.Workflow.Actions[aIdx].Parameters)
			}
		}
	}
}

func normalizeShuffleIdentifier(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.TrimPrefix(s, "app:")
	s = strings.ReplaceAll(s, " ", "_")
	s = strings.ReplaceAll(s, "-", "_")
	return s
}

// matchAttachedShuffleTool checks if an AgentDecision invokes one of the conversation's attached Shuffle tools
func (b *AgentBridge) matchAttachedShuffleTool(convID string, dec *shuffle.AgentDecision) (*ShuffleAttachedTool, *shuffle.WorkflowApp, *shuffle.WorkflowAppAction, string) {
	if dec == nil {
		return nil, nil, nil, ""
	}
	attached := b.GetEffectiveConversationShuffleToolsList(convID)
	if len(attached) == 0 {
		return nil, nil, nil, ""
	}

	rawTool := strings.TrimSpace(dec.Tool)
	rawAction := strings.TrimSpace(dec.Action)
	rawCat := strings.TrimSpace(dec.Category)

	// Do not intercept finish or interactive ask decisions
	actLower := strings.ToLower(rawAction)
	toolLower := strings.ToLower(rawTool)
	catLower := strings.ToLower(rawCat)
	if actLower == "finish" || toolLower == "finish" || catLower == "finish" ||
		actLower == "ask" || actLower == "question" || toolLower == "ask" || catLower == "ask" {
		return nil, nil, nil, ""
	}

	// Extract possible tool prefix from Action if formatted like "Jira:create_issue" or "app:Jira:create_issue"
	actionToolPrefix := ""
	cleanActionName := rawAction
	if strings.Contains(rawAction, ":") {
		parts := strings.Split(rawAction, ":")
		if len(parts) >= 2 {
			actionToolPrefix = parts[len(parts)-2]
			cleanActionName = parts[len(parts)-1]
		}
	}

	normTool := normalizeShuffleIdentifier(rawTool)
	if idx := strings.LastIndex(normTool, ":"); idx >= 0 && idx+1 < len(normTool) {
		normTool = normTool[idx+1:]
	}
	normPrefix := normalizeShuffleIdentifier(actionToolPrefix)
	normCat := normalizeShuffleIdentifier(rawCat)
	normAct := normalizeShuffleIdentifier(cleanActionName)

	// 1. Direct match by Tool name, Action prefix, or Category matching an attached Shuffle app
	for i := range attached {
		t := &attached[i]
		tNameNorm := normalizeShuffleIdentifier(t.AppName)
		tLabelNorm := normalizeShuffleIdentifier(t.Label)
		tIDNorm := strings.ToLower(strings.TrimSpace(t.AppID))

		toolMatches := (normTool != "" && normTool != "osctrl" && (normTool == tNameNorm || normTool == tLabelNorm || normTool == tIDNorm)) ||
			(normPrefix != "" && normPrefix != "osctrl" && (normPrefix == tNameNorm || normPrefix == tLabelNorm || normPrefix == tIDNorm)) ||
			(normCat != "" && normCat != "osctrl" && (normCat == tNameNorm || normCat == tLabelNorm))

		if toolMatches {
			wfApp, _ := b.ensureShuffleAppCached(context.Background(), *t)
			var matchedAct *shuffle.WorkflowAppAction
			resolvedActName := cleanActionName
			if wfApp != nil {
				for aIdx := range wfApp.Actions {
					cand := &wfApp.Actions[aIdx]
					if normalizeShuffleIdentifier(cand.Name) == normAct || normalizeShuffleIdentifier(cand.Label) == normAct {
						matchedAct = cand
						resolvedActName = cand.Name
						break
					}
				}
			}
			return t, wfApp, matchedAct, resolvedActName
		}
	}

	// 2. If the action is not a native osctrl action and not a shell command, check if normAct uniquely matches an action in an attached Shuffle app
	if !osctrl.IsNativeAgentAction(normAct) && normTool != "osctrl" {
		for i := range attached {
			t := &attached[i]
			wfApp, _ := b.ensureShuffleAppCached(context.Background(), *t)
			if wfApp == nil {
				continue
			}
			for aIdx := range wfApp.Actions {
				cand := &wfApp.Actions[aIdx]
				if normalizeShuffleIdentifier(cand.Name) == normAct || normalizeShuffleIdentifier(cand.Label) == normAct {
					return t, wfApp, cand, cand.Name
				}
			}
		}
	}

	return nil, nil, nil, ""
}

// executeRemoteShuffleAppAction executes an attached Shuffle app action remotely via POST {baseURL}/api/v1/apps/{appID}/run
func (b *AgentBridge) executeRemoteShuffleAppAction(ctx context.Context, tool ShuffleAttachedTool, wfApp *shuffle.WorkflowApp, matchedAction *shuffle.WorkflowAppAction, actionName string, fieldsMap map[string]string, execID string) (string, error) {
	baseURL, authToken, orgID, ok := b.resolveShuffleCloudCredentials()
	if !ok {
		return "", fmt.Errorf("cannot run Shuffle app %q: not authenticated to Shuffle AI", tool.AppName)
	}

	appID := strings.TrimSpace(tool.AppID)
	appName := strings.TrimSpace(tool.AppName)
	appVersion := strings.TrimSpace(tool.AppVersion)
	if wfApp != nil {
		if appID == "" {
			appID = strings.TrimSpace(wfApp.ID)
		}
		if appName == "" {
			appName = strings.TrimSpace(wfApp.Name)
		}
		if appVersion == "" {
			appVersion = strings.TrimSpace(wfApp.AppVersion)
		}
	}
	if appID == "" {
		return "", fmt.Errorf("cannot run Shuffle app %q: missing app ID", appName)
	}

	resolvedActionName := strings.TrimSpace(actionName)
	resolvedActionLabel := resolvedActionName
	var parameters []shuffle.WorkflowAppActionParameter
	usedFields := make(map[string]bool)

	if matchedAction != nil {
		if strings.TrimSpace(matchedAction.Name) != "" {
			resolvedActionName = strings.TrimSpace(matchedAction.Name)
		}
		if strings.TrimSpace(matchedAction.Label) != "" {
			resolvedActionLabel = strings.TrimSpace(matchedAction.Label)
		}
		for _, p := range matchedAction.Parameters {
			paramCopy := p
			pNorm := normalizeShuffleIdentifier(p.Name)
			for fk, fv := range fieldsMap {
				if strings.EqualFold(fk, p.Name) || normalizeShuffleIdentifier(fk) == pNorm {
					paramCopy.Value = fv
					usedFields[fk] = true
					break
				}
			}
			parameters = append(parameters, paramCopy)
		}
	}

	for fk, fv := range fieldsMap {
		if usedFields[fk] {
			continue
		}
		parameters = append(parameters, shuffle.WorkflowAppActionParameter{
			Name:  fk,
			Value: fv,
		})
	}

	authIDForRun := strings.TrimSpace(tool.AuthID)
	if strings.HasPrefix(authIDForRun, "skill-tool:") || strings.HasPrefix(authIDForRun, "noauth:") {
		authIDForRun = ""
	}

	runPayload := shuffle.Action{
		Name:             resolvedActionName,
		Label:            resolvedActionLabel,
		AppName:          appName,
		AppVersion:       appVersion,
		AppID:            appID,
		Environment:      "cloud",
		AuthenticationId: authIDForRun,
		Parameters:       parameters,
	}

	bodyBytes, err := json.Marshal(runPayload)
	if err != nil {
		return "", err
	}

	runURL := fmt.Sprintf("%s/api/v1/apps/%s/run", strings.TrimRight(baseURL, "/"), appID)
	reqCtx := ctx
	if reqCtx == nil || reqCtx.Err() != nil {
		var cancel context.CancelFunc
		reqCtx, cancel = context.WithTimeout(context.Background(), 120*time.Second)
		defer cancel()
	}

	req, err := http.NewRequestWithContext(reqCtx, "POST", runURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+authToken)
	req.Header.Set("Content-Type", "application/json")
	if orgID != "" {
		req.Header.Set("Org-Id", orgID)
		req.Header.Set("Org", orgID)
		req.Header.Set("X-Shuffle-Org-Id", orgID)
	}

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("Shuffle remote app execution request failed: %w", err)
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	respStr := strings.TrimSpace(string(respBytes))

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return respStr, fmt.Errorf("Shuffle app %s (%s) returned HTTP %d: %s", appName, resolvedActionName, resp.StatusCode, respStr)
	}

	var parsedResp struct {
		Success bool        `json:"success"`
		Result  interface{} `json:"result"`
		Reason  string      `json:"reason"`
		Details string      `json:"details"`
	}
	if errU := json.Unmarshal(respBytes, &parsedResp); errU == nil {
		if parsedResp.Result != nil {
			switch v := parsedResp.Result.(type) {
			case string:
				if strings.TrimSpace(v) != "" {
					if !parsedResp.Success && parsedResp.Reason != "" {
						return v, fmt.Errorf("%s", parsedResp.Reason)
					}
					return v, nil
				}
			default:
				if resJSON, errM := json.Marshal(v); errM == nil {
					if !parsedResp.Success && parsedResp.Reason != "" {
						return string(resJSON), fmt.Errorf("%s", parsedResp.Reason)
					}
					return string(resJSON), nil
				}
			}
		}
		if !parsedResp.Success && strings.TrimSpace(parsedResp.Reason) != "" {
			return respStr, fmt.Errorf("Shuffle app %s failed: %s", appName, parsedResp.Reason)
		}
	}

	return respStr, nil
}

// GetPredefinedShuffleSharedSkills returns the catalog of predefined skills/templates and required tools from shuffle-shared
func GetPredefinedShuffleSharedSkills() []ShuffleSharedSkill {
	return []ShuffleSharedSkill{
		{
			ID:          "build-workflows",
			Template:    "build-workflows",
			Name:        "Workflow Builder",
			Category:    "shuffle-security_workflows",
			Description: "Autonomous workflow-building agent that designs, creates, inspects, and updates Shuffle workflows.",
			RequiredApps: []string{
				"app:7db43ccd25261967b095cfbd467a75cc:shuffle_apps",
				"app:de4ef2287bd41b9d5563e39989643ee6:shuffle_workflows_builder",
			},
			Tools: []ShuffleAttachedTool{
				{
					AuthID:       "skill-tool:build-workflows:shuffle_apps",
					Label:        "Shuffle Apps",
					AppID:        "7db43ccd25261967b095cfbd467a75cc",
					AppName:      "shuffle_apps",
					AppVersion:   "1.0.0",
					ActionsCount: 1,
					Valid:        true,
				},
				{
					AuthID:       "skill-tool:build-workflows:shuffle_workflows_builder",
					Label:        "Shuffle Workflows Builder",
					AppID:        "de4ef2287bd41b9d5563e39989643ee6",
					AppName:      "shuffle_workflows_builder",
					AppVersion:   "1.0.0",
					ActionsCount: 3,
					Valid:        true,
				},
			},
		},
		{
			ID:          "host-monitor-control",
			Template:    "host-monitor-control",
			Name:        "Host Monitor & Computer Use",
			Category:    "shuffle-security_monitors",
			Description: "Autonomous computer-using agent for interacting with desktop, browser, and host monitor environments.",
			RequiredApps: []string{
				"app:48a954b9440b3913b8a2620e57b94a75:shuffle_host_monitors",
			},
			Tools: []ShuffleAttachedTool{
				{
					AuthID:       "skill-tool:host-monitor-control:shuffle_host_monitors",
					Label:        "Shuffle Host Monitors",
					AppID:        "48a954b9440b3913b8a2620e57b94a75",
					AppName:      "shuffle_host_monitors",
					AppVersion:   "1.0.0",
					ActionsCount: 3,
					Valid:        true,
				},
			},
		},
		{
			ID:          "incident-handler",
			Template:    "incident-handler",
			Name:        "Incident Handler",
			Category:    "shuffle-security_incidents",
			Description: "Incident response co-pilot for triaging, investigating, containing, and responding to security incidents.",
			RequiredApps: []string{
				"app:shuffle_incidents",
			},
			Tools: []ShuffleAttachedTool{
				{
					AuthID:       "skill-tool:incident-handler:shuffle_incidents",
					Label:        "Shuffle Incidents",
					AppID:        "shuffle_incidents",
					AppName:      "shuffle_incidents",
					AppVersion:   "1.0.0",
					ActionsCount: 4,
					Valid:        true,
				},
			},
		},
		{
			ID:          "vulnerability",
			Template:    "vulnerability",
			Name:        "Vulnerability Management",
			Category:    "shuffle-security_vulns",
			Description: "Vulnerability management specialist for CVE analysis, CISA KEV/EPSS risk prioritization, and remediation.",
			RequiredApps: []string{
				"app:shuffle_vulnerabilities",
			},
			Tools: []ShuffleAttachedTool{
				{
					AuthID:       "skill-tool:vulnerability:shuffle_vulnerabilities",
					Label:        "Shuffle Vulnerabilities",
					AppID:        "shuffle_vulnerabilities",
					AppName:      "shuffle_vulnerabilities",
					AppVersion:   "1.0.0",
					ActionsCount: 3,
					Valid:        true,
				},
			},
		},
	}
}

func normalizeShuffleSharedSkillID(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "build-workflows", "workflow-builder", "workflow-edit", "edit-workflow":
		return "build-workflows"
	case "host-monitor-control", "computer-use":
		return "host-monitor-control"
	case "incident-handler", "incident-response":
		return "incident-handler"
	case "vulnerability", "vulnerability-management", "vulnerability-agent":
		return "vulnerability"
	default:
		return ""
	}
}

func getBuiltinShuffleSkillWorkflowApp(appID, appName string) *shuffle.WorkflowApp {
	normName := normalizeShuffleIdentifier(appName)
	normID := strings.ToLower(strings.TrimSpace(appID))
	switch {
	case normID == "7db43ccd25261967b095cfbd467a75cc" || normName == "shuffle_apps":
		return &shuffle.WorkflowApp{
			ID:         "7db43ccd25261967b095cfbd467a75cc",
			Name:       "shuffle_apps",
			AppVersion: "1.0.0",
			Actions: []shuffle.WorkflowAppAction{
				{
					Name:        "post_get_app_actions_summary",
					Label:       "Get App Actions Summary",
					Description: "Fetch available actions and required parameters for one or more Shuffle apps before building or updating a workflow.",
					Parameters: []shuffle.WorkflowAppActionParameter{
						{Name: "apps", Description: "Comma-separated or JSON array of app names/IDs", Required: true},
					},
				},
			},
		}
	case normID == "de4ef2287bd41b9d5563e39989643ee6" || normName == "shuffle_workflows_builder":
		return &shuffle.WorkflowApp{
			ID:         "de4ef2287bd41b9d5563e39989643ee6",
			Name:       "shuffle_workflows_builder",
			AppVersion: "1.0.0",
			Actions: []shuffle.WorkflowAppAction{
				{
					Name:        "get_minimal_workflow",
					Label:       "Get Minimal Workflow",
					Description: "Inspect an existing workflow's actions, branches, triggers, and variables.",
					Parameters: []shuffle.WorkflowAppActionParameter{
						{Name: "workflow_id", Description: "Target workflow ID", Required: true},
					},
				},
				{
					Name:        "post_create_workflow",
					Label:       "Create Workflow",
					Description: "Create a new Shuffle workflow and return its workflow_id.",
					Parameters: []shuffle.WorkflowAppActionParameter{
						{Name: "name", Description: "Workflow name", Required: true},
						{Name: "description", Description: "Workflow description", Required: false},
					},
				},
				{
					Name:        "put_agent_update",
					Label:       "Agent Update Workflow",
					Description: "Update a Shuffle workflow's actions, branches, and triggers.",
					Parameters: []shuffle.WorkflowAppActionParameter{
						{Name: "workflow_id", Description: "Target workflow ID", Required: true},
						{Name: "body", Description: "JSON payload of workflow actions, branches, and start node", Required: true},
					},
				},
			},
		}
	case normID == "48a954b9440b3913b8a2620e57b94a75" || normName == "shuffle_host_monitors":
		return &shuffle.WorkflowApp{
			ID:         "48a954b9440b3913b8a2620e57b94a75",
			Name:       "shuffle_host_monitors",
			AppVersion: "1.0.0",
			Actions: []shuffle.WorkflowAppAction{
				{
					Name:        "post_take_screenshot",
					Label:       "Take Screenshot",
					Description: "Capture a screenshot of the monitored host or desktop environment.",
					Parameters: []shuffle.WorkflowAppActionParameter{
						{Name: "environment", Description: "Target host/environment name", Required: false},
					},
				},
				{
					Name:        "post_control_mouse_and_keyboard",
					Label:       "Control Mouse and Keyboard",
					Description: "Perform mouse clicks, movement, key presses, or text input on the monitored host.",
					Parameters: []shuffle.WorkflowAppActionParameter{
						{Name: "action", Description: "Action type (left_click, double_click, type, key, move, scroll)", Required: true},
						{Name: "x", Description: "X coordinate", Required: false},
						{Name: "y", Description: "Y coordinate", Required: false},
						{Name: "text", Description: "Text to type or key to press", Required: false},
					},
				},
				{
					Name:        "post_execute_bash",
					Label:       "Execute Bash Command",
					Description: "Execute a command on the monitored host.",
					Parameters: []shuffle.WorkflowAppActionParameter{
						{Name: "command", Description: "Shell command to execute", Required: true},
						{Name: "environment", Description: "Target host/environment name", Required: false},
					},
				},
			},
		}
	case normName == "shuffle_incidents":
		return &shuffle.WorkflowApp{
			ID:         "shuffle_incidents",
			Name:       "shuffle_incidents",
			AppVersion: "1.0.0",
			Actions: []shuffle.WorkflowAppAction{
				{
					Name:        "get_incidents",
					Label:       "Get Incidents",
					Description: "List security incidents from Shuffle Incidents datastore.",
					Parameters: []shuffle.WorkflowAppActionParameter{
						{Name: "status", Description: "Filter by status (open, investigating, contained, closed)", Required: false},
						{Name: "severity", Description: "Filter by severity (critical, high, medium, low)", Required: false},
					},
				},
				{
					Name:        "get_incident",
					Label:       "Get Incident Details",
					Description: "Retrieve full details, timeline, and artifacts for a specific incident.",
					Parameters: []shuffle.WorkflowAppActionParameter{
						{Name: "incident_id", Description: "Incident ID", Required: true},
					},
				},
				{
					Name:        "update_incident",
					Label:       "Update Incident",
					Description: "Update incident status, severity, assignee, or investigation notes.",
					Parameters: []shuffle.WorkflowAppActionParameter{
						{Name: "incident_id", Description: "Incident ID", Required: true},
						{Name: "status", Description: "Updated status", Required: false},
						{Name: "severity", Description: "Updated severity", Required: false},
						{Name: "notes", Description: "Investigation or containment notes", Required: false},
					},
				},
				{
					Name:        "create_incident_alert",
					Label:       "Create Incident Alert",
					Description: "Create a new security incident or alert entry.",
					Parameters: []shuffle.WorkflowAppActionParameter{
						{Name: "title", Description: "Incident title", Required: true},
						{Name: "description", Description: "Incident summary and findings", Required: false},
						{Name: "severity", Description: "Severity level", Required: false},
					},
				},
			},
		}
	case normName == "shuffle_vulnerabilities":
		return &shuffle.WorkflowApp{
			ID:         "shuffle_vulnerabilities",
			Name:       "shuffle_vulnerabilities",
			AppVersion: "1.0.0",
			Actions: []shuffle.WorkflowAppAction{
				{
					Name:        "get_vulnerabilities",
					Label:       "Get Vulnerabilities",
					Description: "Query tracked CVEs and vulnerability findings from Shuffle Vulnerabilities.",
					Parameters: []shuffle.WorkflowAppActionParameter{
						{Name: "severity", Description: "Filter by severity", Required: false},
						{Name: "status", Description: "Filter by status", Required: false},
						{Name: "cve", Description: "Filter by CVE ID", Required: false},
					},
				},
				{
					Name:        "get_cve_details",
					Label:       "Get CVE Details",
					Description: "Fetch CVE details, CVSS, EPSS, and CISA KEV status.",
					Parameters: []shuffle.WorkflowAppActionParameter{
						{Name: "cve_id", Description: "CVE identifier (e.g. CVE-2024-1234)", Required: true},
					},
				},
				{
					Name:        "update_vulnerability",
					Label:       "Update Vulnerability",
					Description: "Update remediation status, priority, or notes for a vulnerability finding.",
					Parameters: []shuffle.WorkflowAppActionParameter{
						{Name: "vulnerability_id", Description: "Vulnerability record ID or CVE ID", Required: true},
						{Name: "status", Description: "Remediation status (open, mitigated, patched, accepted)", Required: false},
						{Name: "notes", Description: "Remediation guidance or verification notes", Required: false},
					},
				},
			},
		}
	default:
		return nil
	}
}

// SetConversationShuffleSkillsList updates the attached shuffle-shared skill IDs for a conversation (and default skills list)
func (b *AgentBridge) SetConversationShuffleSkillsList(convID string, skillIDs []string) {
	cleaned := make([]string, 0, len(skillIDs))
	seen := make(map[string]bool)
	for _, raw := range skillIDs {
		norm := normalizeShuffleSharedSkillID(raw)
		if norm == "" || seen[norm] {
			continue
		}
		seen[norm] = true
		cleaned = append(cleaned, norm)
	}

	b.shuffleToolsMu.Lock()
	if b.convShuffleSkills == nil {
		b.convShuffleSkills = make(map[string][]string)
	}
	b.defaultShuffleSkills = cleaned
	if strings.TrimSpace(convID) != "" {
		b.convShuffleSkills[strings.TrimSpace(convID)] = cleaned
	}
	b.shuffleToolsMu.Unlock()
}

// GetConversationShuffleSkillIDs returns the attached shuffle-shared skill IDs for convID (or defaultShuffleSkills)
func (b *AgentBridge) GetConversationShuffleSkillIDs(convID string) []string {
	b.shuffleToolsMu.RLock()
	defer b.shuffleToolsMu.RUnlock()

	trimmed := strings.TrimSpace(convID)
	if trimmed != "" && b.convShuffleSkills != nil {
		if list, ok := b.convShuffleSkills[trimmed]; ok {
			out := make([]string, len(list))
			copy(out, list)
			return out
		}
	}
	out := make([]string, len(b.defaultShuffleSkills))
	copy(out, b.defaultShuffleSkills)
	return out
}

// GetShuffleSharedSkillsCatalog returns all predefined shuffle-shared skills with Attached status for convID
func (b *AgentBridge) GetShuffleSharedSkillsCatalog(convID string) []ShuffleSharedSkill {
	catalog := GetPredefinedShuffleSharedSkills()
	attachedIDs := b.GetConversationShuffleSkillIDs(convID)
	attachedSet := make(map[string]bool, len(attachedIDs))
	for _, id := range attachedIDs {
		attachedSet[id] = true
	}
	for i := range catalog {
		catalog[i].Attached = attachedSet[catalog[i].ID]
		for tIdx := range catalog[i].Tools {
			t := &catalog[i].Tools[tIdx]
			if t.LargeImage == "" {
				t.LargeImage = b.resolveShuffleAppImage(shuffle.WorkflowApp{ID: t.AppID, Name: t.AppName}, "")
			}
		}
	}
	return catalog
}

// GetConversationShuffleSkillsList returns the full ShuffleSharedSkill structs currently attached to convID
func (b *AgentBridge) GetConversationShuffleSkillsList(convID string) []ShuffleSharedSkill {
	catalog := b.GetShuffleSharedSkillsCatalog(convID)
	out := make([]ShuffleSharedSkill, 0, len(catalog))
	for _, sk := range catalog {
		if sk.Attached {
			out = append(out, sk)
		}
	}
	return out
}

// GetEffectiveConversationShuffleToolsList returns explicitly attached tools plus predefined tools from attached shuffle-shared skills
func (b *AgentBridge) GetEffectiveConversationShuffleToolsList(convID string) []ShuffleAttachedTool {
	explicit := b.GetConversationShuffleToolsList(convID)
	attachedSkills := b.GetConversationShuffleSkillsList(convID)
	if len(attachedSkills) == 0 {
		return explicit
	}
	out := make([]ShuffleAttachedTool, 0, len(explicit)+4)
	seenApp := make(map[string]bool)
	addTool := func(t ShuffleAttachedTool) {
		kID := strings.ToLower(strings.TrimSpace(t.AppID))
		kName := normalizeShuffleIdentifier(t.AppName)
		if (kID != "" && seenApp["id:"+kID]) || (kName != "" && seenApp["name:"+kName]) {
			return
		}
		if kID != "" {
			seenApp["id:"+kID] = true
		}
		if kName != "" {
			seenApp["name:"+kName] = true
		}
		out = append(out, t)
	}
	for _, t := range explicit {
		addTool(t)
	}
	for _, sk := range attachedSkills {
		for _, t := range sk.Tools {
			addTool(t)
		}
	}
	return out
}

// GetShuffleSharedSkills handles the JS bridge action to list predefined shuffle-shared skills and their attachment state
func (b *AgentBridge) GetShuffleSharedSkills(payload string) string {
	convID := strings.TrimSpace(payload)
	var req struct {
		ConversationID string `json:"conversation_id"`
	}
	if strings.HasPrefix(convID, "{") {
		if err := json.Unmarshal([]byte(payload), &req); err == nil {
			convID = strings.TrimSpace(req.ConversationID)
		}
	}
	catalog := b.GetShuffleSharedSkillsCatalog(convID)
	attachedIDs := b.GetConversationShuffleSkillIDs(convID)
	resp, _ := json.Marshal(map[string]interface{}{
		"status":          "ok",
		"conversation_id": convID,
		"skills":          catalog,
		"attached_skills": attachedIDs,
	})
	return string(resp)
}

// SetConversationShuffleSkills handles the JS bridge action to update attached shuffle-shared skills for a conversation
func (b *AgentBridge) SetConversationShuffleSkills(payload string) string {
	var req struct {
		ConversationID string   `json:"conversation_id"`
		Skills         []string `json:"skills"`
	}
	if err := json.Unmarshal([]byte(payload), &req); err != nil {
		var directList []string
		if err2 := json.Unmarshal([]byte(payload), &directList); err2 == nil {
			req.Skills = directList
		}
	}
	b.SetConversationShuffleSkillsList(req.ConversationID, req.Skills)
	catalog := b.GetShuffleSharedSkillsCatalog(req.ConversationID)
	attachedIDs := b.GetConversationShuffleSkillIDs(req.ConversationID)
	effectiveTools := b.GetEffectiveConversationShuffleToolsList(req.ConversationID)
	resp, _ := json.Marshal(map[string]interface{}{
		"status":          "ok",
		"conversation_id": req.ConversationID,
		"skills":          catalog,
		"attached_skills": attachedIDs,
		"effective_tools": effectiveTools,
	})
	return string(resp)
}

// GetConversationShuffleSkills handles the JS bridge action to read attached shuffle-shared skills for a conversation
func (b *AgentBridge) GetConversationShuffleSkills(payload string) string {
	return b.GetShuffleSharedSkills(payload)
}




