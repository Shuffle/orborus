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
	shuffle "github.com/shuffle/shuffle-shared"
)

// ExecutionEntry tracks an executed prompt or command
type ExecutionEntry struct {
	ID        string `json:"id"`
	Timestamp string `json:"timestamp"`
	Prompt    string `json:"prompt"`
	Output    string `json:"output"`
	Status    string `json:"status"` // "success", "error", "pending"
	Duration  string `json:"duration"`
}

// ApprovalRequest tracks an action waiting for user permission
type ApprovalRequest struct {
	ID          string `json:"id"`
	Action      string `json:"action"`
	Description string `json:"description"`
	Timestamp   string `json:"timestamp"`
}

// AgentBridge manages direct in-memory state and execution between Go and JS
type AgentBridge struct {
	cfg              *Config
	mu               sync.Mutex
	activeProject    string
	permissionPolicy string // "ask_all", "safe_auto", "full_auto"
	history          []ExecutionEntry
	pendingApproval  *ApprovalRequest
	approvalCh       chan bool
	projects         []shuffle.ProjectInfo
	projectsScanned  bool
	oauthLoggedIn    bool
	oauthToken       string
}

// NewAgentBridge initializes a new direct bridge
func NewAgentBridge(cfg *Config) *AgentBridge {
	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}

	b := &AgentBridge{
		cfg:              cfg,
		activeProject:    cwd,
		permissionPolicy: "ask_all",
		history:          make([]ExecutionEntry, 0),
		approvalCh:       make(chan bool, 1),
		projects:         make([]shuffle.ProjectInfo, 0),
	}

	// Trigger code repository scan immediately on initial startup
	go b.ScanProjects()

	return b
}

// isAuthBypassed checks if OrgId, Auth, or Environment was provided by default
func (b *AgentBridge) isAuthBypassed() bool {
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

	state := map[string]interface{}{
		"hostname":          b.cfg.Hostname,
		"machine_id":        b.cfg.MachineID,
		"os":                runtime.GOOS,
		"arch":              runtime.GOARCH,
		"is_standalone":     b.cfg.IsStandalone,
		"base_url":          b.cfg.BaseURL,
		"active_project":    b.activeProject,
		"permission_policy": b.permissionPolicy,
		"history":           b.history,
		"pending_approval":  b.pendingApproval,
		"projects":          b.projects,
		"projects_scanned":  b.projectsScanned,
		"is_logged_in":      isLoggedIn,
		"is_bypassed":       isBypassed,
		"org_id":            b.cfg.Org,
		"auth":              b.cfg.Auth,
		"environment":       b.cfg.Environment,
	}

	data, _ := json.Marshal(state)
	return string(data)
}

// StartOAuthLogin opens the Shuffle OAuth2 login flow
func (b *AgentBridge) StartOAuthLogin(customBaseURL string) string {
	baseURL := "https://shuffler.io"
	if customBaseURL != "" {
		baseURL = customBaseURL
	} else if b.cfg.BaseURL != "" {
		baseURL = b.cfg.BaseURL
	}

	loginURL := fmt.Sprintf("%s/login", strings.TrimRight(baseURL, "/"))
	log.Printf("[INFO] Opening Shuffle OAuth2 login: %s", loginURL)
	if runtime.GOOS == "darwin" {
		_ = exec.Command("open", loginURL).Start()
	}

	resp, _ := json.Marshal(map[string]interface{}{
		"status": "opened",
		"url":    loginURL,
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
	return b.activeProject
}

// SetPermissionPolicy updates the security mode
func (b *AgentBridge) SetPermissionPolicy(policy string) string {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.permissionPolicy = policy
	return b.permissionPolicy
}

// RunPrompt executes an agent action directly in-memory using osctrl
func (b *AgentBridge) RunPrompt(prompt string, forceApprove bool) string {
	start := time.Now()
	execID := fmt.Sprintf("exec-%d", time.Now().UnixNano())

	b.mu.Lock()
	isBypassed := b.isAuthBypassed()
	isLoggedIn := isBypassed || b.oauthLoggedIn
	b.mu.Unlock()

	if !isLoggedIn {
		entry := ExecutionEntry{
			ID:        execID,
			Timestamp: time.Now().Format("15:04:05"),
			Prompt:    prompt,
			Output:    "Shuffle OAuth2 Login Required: Please authenticate with Shuffle OAuth2 in the bottom-left sidebar, or provide OrgId, Auth, or Environment by default to bypass.",
			Status:    "error",
			Duration:  "0ms",
		}
		b.mu.Lock()
		b.history = append([]ExecutionEntry{entry}, b.history...)
		b.mu.Unlock()

		resp, _ := json.Marshal(map[string]interface{}{
			"id":          execID,
			"status":      "error",
			"error":       entry.Output,
			"needs_login": true,
			"prompt":      prompt,
			"duration":    "0ms",
		})
		return string(resp)
	}

	b.mu.Lock()
	needsApproval := b.permissionPolicy == "ask_all" && !forceApprove
	if needsApproval {
		b.pendingApproval = &ApprovalRequest{
			ID:          execID,
			Action:      prompt,
			Description: fmt.Sprintf("Execute command in '%s'", b.activeProject),
			Timestamp:   time.Now().Format("15:04:05"),
		}
		b.mu.Unlock()

		// Return pending approval notification
		resp, _ := json.Marshal(map[string]interface{}{
			"id":             execID,
			"status":         "pending_approval",
			"needs_approval": true,
			"prompt":         prompt,
		})
		return string(resp)
	}
	b.mu.Unlock()

	// Execute command via osctrl directly
	log.Printf("[INFO] Direct In-Memory Execution: %s", prompt)
	output, err := b.executeDirect(prompt)

	status := "success"
	if err != nil {
		status = "error"
		output = fmt.Sprintf("Error: %v\nOutput: %s", err, output)
	}

	duration := time.Since(start).Round(time.Millisecond).String()

	entry := ExecutionEntry{
		ID:        execID,
		Timestamp: time.Now().Format("15:04:05"),
		Prompt:    prompt,
		Output:    output,
		Status:    status,
		Duration:  duration,
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

// RespondApproval handles user decision from the UI
func (b *AgentBridge) RespondApproval(execID string, approved bool) string {
	b.mu.Lock()
	req := b.pendingApproval
	if req == nil || req.ID != execID {
		b.mu.Unlock()
		return `{"status": "not_found"}`
	}
	prompt := req.Action
	b.pendingApproval = nil
	b.mu.Unlock()

	if !approved {
		entry := ExecutionEntry{
			ID:        execID,
			Timestamp: time.Now().Format("15:04:05"),
			Prompt:    prompt,
			Output:    "[Denied by user]",
			Status:    "denied",
			Duration:  "0ms",
		}
		b.mu.Lock()
		b.history = append([]ExecutionEntry{entry}, b.history...)
		b.mu.Unlock()
		resp, _ := json.Marshal(entry)
		return string(resp)
	}

	// User approved: run with forceApprove=true
	return b.RunPrompt(prompt, true)
}

// TakeScreenshot captures displays and returns base64 PNGs directly
func (b *AgentBridge) TakeScreenshot() string {
	if runtime.GOOS == "darwin" {
		screens, err := osctrl.ScreenshotAllDisplaysMacos()
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

	screens, err := osctrl.Screenshot()
	if err != nil {
		return fmt.Sprintf(`{"error": "%s"}`, err.Error())
	}
	data, _ := json.Marshal(screens)
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
	fullCmd := cmd
	if b.activeProject != "" && b.activeProject != "." {
		fullCmd = fmt.Sprintf("cd %s && %s", b.activeProject, cmd)
	}
	return osctrl.RunCommandString(fullCmd, 30*time.Second, nil)
}
