//go:build darwin

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"fyne.io/systray"
	"github.com/shuffle/osctrl"
	shuffle "github.com/shuffle/shuffle-shared"
	"orborus/pkg"
	"orborus/pkg/webview"

	"vllm-client/executor"
)

var (
	globalBridge *pkg.AgentBridge
	localExecMgr *LocalExecutorManager
	agentWindow  webview.Window
	windowMu     sync.Mutex
)

// LocalExecutorManager manages the lifecycle of the in-process native CUDA/Metal LLM engine.
// It complies strictly with the architecture mandate: zero Python/WSL, direct C/CUDA/Metal Go execution,
// host RAM protection with -lm none, and dynamic GPU VRAM management.
type LocalExecutorManager struct {
	mu           sync.Mutex
	engine       executor.Engine
	disco        *executor.SystemDiscovery
	initErr      error
	modelPath    string
	initializing bool
}

func newLocalExecutorManager() *LocalExecutorManager {
	disco, err := executor.Discover()
	if err != nil {
		log.Printf("[WARNING] Hardware discovery encountered error: %v", err)
	} else {
		log.Printf("[INFO] Local Hardware Discovered: GPU=%s (Found=%v), VRAM Total=%d MB, VRAM Free=%d MB, Acceleration=%s",
			disco.GPUName, disco.GPUFound, disco.VRAMTotalMB, disco.VRAMFreeMB, disco.AccelerationType)
	}
	return &LocalExecutorManager{
		disco: disco,
	}
}

func (m *LocalExecutorManager) GetOrInitEngine() (executor.Engine, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.engine != nil {
		return m.engine, nil
	}

	tendonVer := pkg.GetTendonVersion()
	tendonReleaseURL := pkg.GetTendonReleaseURL(tendonVer)
	log.Printf("[INFO] Tendon engine version: %s (Release: %s)", tendonVer, tendonReleaseURL)

	if tendonBin, errBin := pkg.FindOrFetchTendonBinary(tendonVer); errBin != nil {
		log.Printf("[WARNING] Tendon binary lookup warning: %v", errBin)
	} else {
		log.Printf("[INFO] Using Tendon binary: %s", tendonBin)
	}

	modelPath := os.Getenv("LOCAL_MODEL_PATH")
	if modelPath == "" && globalBridge != nil && globalBridge.GetLocalModelPath() != "" {
		modelPath = globalBridge.GetLocalModelPath()
	}
	if modelPath == "" {
		candidates := []string{
			"models/gemma-4-26B-A4B-it-UD-Q3_K_M.gguf",
			filepath.Join(pkg.GetTendonDir(tendonVer), "models", "gemma-4-26B-A4B-it-UD-Q3_K_M.gguf"),
			filepath.Join(os.Getenv("HOME"), ".shuffle", "models", "gemma-4-26B-A4B-it-UD-Q3_K_M.gguf"),
			"../delightful-mendeleev/models/gemma-4-26B-A4B-it-UD-Q3_K_M.gguf",
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

	log.Printf("[INFO] Initializing Tendon Native Engine v%s with model: %s", tendonVer, modelPath)
	cfg := executor.Config{
		ModelPath: modelPath,
		Driver:    executor.DriverNative,
		LoadMode:  "none", // Direct VRAM loading with zero host RAM ballooning
		MaxTokens: 2048,
	}

	eng, err := executor.New(cfg)
	if err != nil {
		log.Printf("[ERROR] Failed to start native engine: %v", err)
		m.initErr = err
		return nil, err
	}

	m.engine = eng
	m.modelPath = eng.Model()
	log.Printf("[INFO] Tendon Native Engine ready on %s! Status: %+v", eng.Endpoint(), eng.Status())

	// Route any internal shuffle-shared library requests to our local OpenAI-compatible endpoint
	_ = os.Setenv("AI_API_URL", eng.Endpoint())
	if os.Getenv("AI_API_KEY") == "" {
		_ = os.Setenv("AI_API_KEY", "local-tendon")
	}
	return eng, nil
}

func (m *LocalExecutorManager) SwitchModel(newPath string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.engine != nil {
		log.Printf("[INFO] Closing engine to switch model to: %s", newPath)
		_ = m.engine.Close()
		m.engine = nil
	}
	m.modelPath = newPath
	_ = os.Setenv("LOCAL_MODEL_PATH", newPath)
	return nil
}

func (m *LocalExecutorManager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.engine != nil {
		log.Printf("[INFO] Closing Tendon Native Engine...")
		_ = m.engine.Close()
		m.engine = nil
	}
}

func (m *LocalExecutorManager) ExecutePrompt(ctx context.Context, prompt, execID, model, reasoning string, b *pkg.AgentBridge) (string, *shuffle.WorkflowExecution, bool, error) {
	modelLower := strings.ToLower(model)
	isLocal := strings.HasPrefix(modelLower, "tendon") ||
		strings.HasPrefix(modelLower, "local") ||
		strings.Contains(modelLower, "gemma") ||
		strings.Contains(modelLower, "native") ||
		strings.Contains(modelLower, "cuda") ||
		strings.EqualFold(modelLower, "qwen")

	if !isLocal {
		hasCloudPrefix := strings.HasPrefix(modelLower, "gemini") ||
			strings.HasPrefix(modelLower, "gpt") ||
			strings.HasPrefix(modelLower, "claude")
		if !hasCloudPrefix && os.Getenv("AI_API_KEY") == "" {
			isLocal = true
		}
	}

	if !isLocal {
		return "", nil, false, nil
	}

	log.Printf("[INFO][%s] Routing prompt to local Tendon Engine (model=%s, reasoning=%s, prompt_len=%d)",
		execID, model, reasoning, len(prompt))

	eng, err := m.GetOrInitEngine()
	if err != nil {
		log.Printf("[ERROR][%s] Local executor unavailable: %v", execID, err)
		return "", nil, true, fmt.Errorf("local engine failed to initialize: %w", err)
	}

	// Dynamic reasoning control
	if rLevel, errParse := executor.ParseReasoningLevel(reasoning); errParse == nil {
		eng.SetReasoning(rLevel)
	}

	start := time.Now()
	streamChan, errStream := eng.Stream(ctx, prompt)
	if errStream != nil {
		out, errGen := eng.Generate(ctx, prompt)
		if errGen != nil {
			return "", nil, true, fmt.Errorf("local generation failed: %w", errGen)
		}
		duration := time.Since(start)
		return m.buildExecutionResult(execID, prompt, out, "", duration)
	}

	var replyBuilder strings.Builder
	var reasoningBuilder strings.Builder
	for delta := range streamChan {
		if delta.Err != nil {
			log.Printf("[WARN][%s] Stream error from local engine: %v", execID, delta.Err)
			break
		}
		if delta.IsReasoning {
			reasoningBuilder.WriteString(delta.Reasoning)
		} else if delta.Text != "" {
			replyBuilder.WriteString(delta.Text)
		}
	}

	outText := replyBuilder.String()
	reasoningText := reasoningBuilder.String()
	duration := time.Since(start)

	log.Printf("[INFO][%s] Local Tendon engine completed in %v (output: %d chars, reasoning: %d chars)",
		execID, duration.Round(time.Millisecond), len(outText), len(reasoningText))

	return m.buildExecutionResult(execID, prompt, outText, reasoningText, duration)
}

func (m *LocalExecutorManager) buildExecutionResult(execID, prompt, outText, reasoningText string, duration time.Duration) (string, *shuffle.WorkflowExecution, bool, error) {
	actionID := fmt.Sprintf("act-%d", time.Now().UnixNano())
	now := time.Now().Unix()

	var decisions []shuffle.AgentDecision
	if reasoningText != "" {
		decisions = append(decisions, shuffle.AgentDecision{
			I:      1,
			Action: "Tendon CUDA Reasoning",
			Tool:   "thought",
			Reason: reasoningText,
			RunDetails: shuffle.AgentDecisionRunDetails{
				StartedAt:   now - int64(duration.Seconds()),
				CompletedAt: now,
				RawResponse: reasoningText,
			},
		})
	}

	decisions = append(decisions, shuffle.AgentDecision{
		I:      len(decisions) + 1,
		Action: "Native Inference",
		Tool:   "local_model",
		Reason: "Computed directly on GPU via local runtime",
		RunDetails: shuffle.AgentDecisionRunDetails{
			StartedAt:   now - int64(duration.Seconds()),
			CompletedAt: now,
			RawResponse: outText,
		},
	})

	decisionsJSON, _ := json.Marshal(decisions)

	exec := &shuffle.WorkflowExecution{
		Type:              "LOCAL_TENDON_AGENT",
		Start:             actionID,
		Status:            "FINISHED",
		ExecutionId:       execID,
		StartedAt:         now - int64(duration.Seconds()),
		CompletedAt:       now,
		ExecutionArgument: prompt,
		Result:            outText,
		Results: []shuffle.ActionResult{
			{
				Action: shuffle.Action{
					ID:      actionID,
					Name:    "LocalTendonInference",
					AppName: "Tendon Native Engine",
				},
				ExecutionId: execID,
				Result:      string(decisionsJSON),
				Status:      "SUCCESS",
			},
		},
	}

	return outText, exec, true, nil
}

func init() {
	runtime.LockOSThread()
}

func main() {
	cleanupLog := pkg.SetupLogging("shuffle-agent.log")
	defer cleanupLog()

	appConfig := pkg.LoadConfig()
	log.Printf("[INFO] Starting Shuffle Agent Runner (Darwin Native Starter)")

	isDebugStartup := strings.EqualFold(os.Getenv("DEBUG"), "true") || os.Getenv("DEBUG") == "1" || appConfig.Debug
	if isDebugStartup {
		log.Printf("[DEBUG] Verbose debug logging enabled via DEBUG=true (Standalone: %v, BaseURL: %s, Environment: %s)", appConfig.IsStandalone, appConfig.BaseURL, appConfig.Environment)
	}

	if appConfig.IsStandalone {
		log.Printf("[INFO] Running in FULL STANDALONE mode (no base_url). No background workers started.")
	} else {
		log.Printf("[INFO] Running in REMOTE mode (BaseURL: %s)", appConfig.BaseURL)
	}
	log.Printf("[INFO] Hostname: %s|%s", appConfig.Hostname, appConfig.MachineID)

	isAccessTrusted := osctrl.CheckAccessibilityTrusted()
	hasScreenAccess := osctrl.CheckScreenRecordingPermission()
	log.Printf("[INFO] macOS Accessibility Trust: %v", isAccessTrusted)
	log.Printf("[INFO] macOS Screen Recording Access: %v", hasScreenAccess)

	// Background execution is separated from the UI starter
	if !appConfig.IsStandalone {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		go func() {
			err := pkg.StartAgentLoop(ctx, appConfig, nil)
			if err != nil && ctx.Err() == nil {
				log.Printf("[ERROR] Remote queue worker failed: %v", err)
			}
		}()
	}

	systray.Run(func() {
		onReady(appConfig)
	}, onExit)
}

func getOrCreateAgentWindow(cfg *pkg.Config) webview.Window {
	windowMu.Lock()
	defer windowMu.Unlock()

	if agentWindow != nil {
		return agentWindow
	}

	iconBytes := pkg.AppIconPNG
	if len(iconBytes) == 0 {
		iconBytes = pkg.ShuffleIconPNG
	}

	win := webview.New(webview.WindowConfig{
		Title:       "Shuffle Agent",
		Width:       950,
		Height:      700,
		HTML:        pkg.GetAgentHTML(),
		IconPNG:     iconBytes,
		ProcessName: "Shuffle Agent",
		BridgeHandler: func(action, payload string) string {
			if globalBridge == nil {
				return `{"error": "bridge not initialized"}`
			}

			switch action {
			case "getLocalExecutorStatus":
				if localExecMgr == nil {
					return `{"status": "unavailable", "error": "local executor manager not initialized"}`
				}
				eng, err := localExecMgr.GetOrInitEngine()
				if err != nil {
					return fmt.Sprintf(`{"status": "error", "error": %q}`, err.Error())
				}
				st := eng.Status()
				tendonVer := pkg.GetTendonVersion()
				data, _ := json.Marshal(map[string]interface{}{
					"status":             "ready",
					"engine":             st,
					"gpu_name":           st.GPUName,
					"vram_total_mb":      st.VRAMTotalMB,
					"vram_free_mb":       st.VRAMFreeMB,
					"driver":             st.Driver,
					"model":              st.Model,
					"context_size":       st.ContextSize,
					"models_dir":         globalBridge.GetLocalModelsDir(),
					"model_path":         globalBridge.GetLocalModelPath(),
					"tendon_version":     tendonVer,
					"tendon_release_url": pkg.GetTendonReleaseURL(tendonVer),
				})
				return string(data)

			case "setLocalModel":
				var req struct {
					Path      string `json:"path"`
					Directory string `json:"directory"`
				}
				_ = json.Unmarshal([]byte(payload), &req)
				if req.Path != "" {
					globalBridge.SetLocalModelPath(req.Path)
					if localExecMgr != nil {
						_ = localExecMgr.SwitchModel(req.Path)
					}
				}
				if req.Directory != "" {
					globalBridge.SetLocalModelsDir(req.Directory)
				}
				resp, _ := json.Marshal(map[string]interface{}{
					"status":            "ok",
					"active_model_path": globalBridge.GetLocalModelPath(),
					"models_dir":        globalBridge.GetLocalModelsDir(),
				})
				return string(resp)

			case "getInitialState":
				baseState := globalBridge.GetInitialState()
				var stateMap map[string]interface{}
				if err := json.Unmarshal([]byte(baseState), &stateMap); err == nil {
					stateMap["local_executor_available"] = true
					stateMap["local_models_dir"] = globalBridge.GetLocalModelsDir()
					stateMap["local_model_path"] = globalBridge.GetLocalModelPath()
					tendonVer := pkg.GetTendonVersion()
					stateMap["tendon_version"] = tendonVer
					stateMap["tendon_release_url"] = pkg.GetTendonReleaseURL(tendonVer)
					if localExecMgr != nil && localExecMgr.disco != nil {
						stateMap["local_gpu_name"] = localExecMgr.disco.GPUName
						stateMap["local_vram_total"] = localExecMgr.disco.VRAMTotalMB
						stateMap["local_vram_free"] = localExecMgr.disco.VRAMFreeMB
					}
					// Default to Tendon Native if no cloud key configured
					if stateMap["ai_api_key"] == "" && (stateMap["ai_model"] == "" || stateMap["ai_model"] == "gemini-3.8-flash") {
						stateMap["ai_model"] = "tendon-local"
					}
					merged, errMerge := json.Marshal(stateMap)
					if errMerge == nil {
						return string(merged)
					}
				}
				return baseState

			default:
				return globalBridge.HandleAction(action, payload)
			}
		},
	})

	globalBridge.SetOnAuthUpdated(func(stateJSON string) {
		js := fmt.Sprintf("if (window.onAuthUpdated) { window.onAuthUpdated(%s); }", stateJSON)
		win.EvaluateJS(js)
	})

	globalBridge.SetOnChunk(func(execID, chunk string) {
		chunkJSON, err := json.Marshal(chunk)
		if err == nil {
			js := fmt.Sprintf("if (window.onAgentChunk) { window.onAgentChunk(%q, %s); }", execID, string(chunkJSON))
			win.EvaluateJS(js)
		}
	})

	agentWindow = win
	return win
}

func onReady(cfg *pkg.Config) {
	log.Println("[INFO] Systray event loop initialized on main thread")

	globalBridge = pkg.NewAgentBridge(cfg)
	localExecMgr = newLocalExecutorManager()
	globalBridge.SetLocalAiExecutor(localExecMgr.ExecutePrompt)

	// Configure top menu bar icon and tooltip
	systray.SetTooltip("Shuffle Agent")
	if len(pkg.ShuffleIconPNG) > 0 {
		systray.SetIcon(pkg.ShuffleIconPNG)
	}

	// Status line
	statusTitle := "Status: Standalone (Local)"
	if !cfg.IsStandalone {
		statusTitle = "Status: Connected to " + cfg.BaseURL
	}
	mStatus := systray.AddMenuItem(statusTitle, "Agent status")
	mStatus.Disable()

	modeTitle := "Mode: Full Standalone (Zero Ports)"
	if !cfg.IsStandalone {
		modeTitle = "Mode: Remote Queue Worker"
	}
	mMode := systray.AddMenuItem(modeTitle, "Execution mode")
	mMode.Disable()

	engineTitle := fmt.Sprintf("Local Engine: Tendon Native v%s", pkg.GetTendonVersion())
	if localExecMgr.disco != nil && localExecMgr.disco.GPUName != "" {
		engineTitle = fmt.Sprintf("Local Engine: Tendon v%s - %s (%s)", pkg.GetTendonVersion(), localExecMgr.disco.GPUName, localExecMgr.disco.AccelerationType)
	}
	mEngine := systray.AddMenuItem(engineTitle, "Native GPU execution runtime")
	mEngine.Disable()

	systray.AddSeparator()

	// On-Demand Window Tool
	mOpenWindow := systray.AddMenuItem("Open Window", "Launch the desktop dashboard")

	systray.AddSeparator()

	mQuit := systray.AddMenuItem("Quit Shuffle Agent", "Exit the agent runner")

	// Pre-initialize and pre-warm WebView window so it is ready on demand
	win := getOrCreateAgentWindow(cfg)
	win.Prewarm()
	shouldOpenWindow := os.Getenv("OPEN_WINDOW") == "true" || os.Getenv("OPEN_WINDOW") == "1" || os.Getenv("WINDOW") == "true"
	for _, arg := range os.Args[1:] {
		if arg == "--window" || arg == "-w" || arg == "window" || arg == "ui" {
			shouldOpenWindow = true
			break
		}
	}
	if cfg.IsStandalone && os.Getenv("TRAY_ONLY") != "true" && os.Getenv("TRAY_ONLY") != "1" {
		shouldOpenWindow = true
	}
	if shouldOpenWindow {
		log.Println("[INFO] Opening dashboard window on boot")
		win.Show()
	}

	// Handle Menu Events
	go func() {
		for {
			select {
			case <-mOpenWindow.ClickedCh:
				log.Println("[INFO] Top bar clicked: Open Window")
				win := getOrCreateAgentWindow(cfg)
				win.Show()

			case <-mQuit.ClickedCh:
				log.Println("[INFO] Top bar clicked: Quit")
				systray.Quit()
				return
			}
		}
	}()
}

func onExit() {
	log.Println("[INFO] Exiting Shuffle Agent Runner")
	if localExecMgr != nil {
		localExecMgr.Close()
	}
}
