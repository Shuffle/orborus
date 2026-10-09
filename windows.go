//go:build windows

package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
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

// LocalExecutorManager manages the lifecycle of the in-process native CUDA LLM engine.
// It complies strictly with the architecture mandate: zero Python/WSL, direct C/CUDA Go execution,
// host RAM protection with -lm none, and dynamic GPU VRAM management tailored to NVIDIA RTX 3080 Ti.
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

func sendUiProgress(phase, detail string, progressPct int) {
	windowMu.Lock()
	win := agentWindow
	windowMu.Unlock()
	if win == nil {
		return
	}
	payload, _ := json.Marshal(map[string]interface{}{
		"phase":    phase,
		"detail":   detail,
		"progress": progressPct,
	})
	js := fmt.Sprintf("if (typeof window.onAgentProgress === 'function') { window.onAgentProgress(%s); }", string(payload))
	win.EvaluateJS(js)
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
			filepath.Join(os.Getenv("USERPROFILE"), ".shuffle", "models", "gemma-4-26B-A4B-it-UD-Q3_K_M.gguf"),
			filepath.Join(os.Getenv("USERPROFILE"), "Documents", "antigravity", "delightful-mendeleev", "models", "gemma-4-26B-A4B-it-UD-Q3_K_M.gguf"),
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

	weightName := filepath.Base(modelPath)
	sendUiProgress("Starting Local LLM", fmt.Sprintf("Locating Tendon binary & model (%s)...", weightName), 20)

	log.Printf("[INFO] Initializing Tendon Native CUDA Engine v%s with model: %s", tendonVer, modelPath)
	cfg := executor.Config{
		ModelPath: modelPath,
		Driver:    executor.DriverNative,
		LoadMode:  "none", // Direct VRAM loading with zero host RAM ballooning
		MaxTokens: 2048,
	}

	sendUiProgress("Loading Model Weights", fmt.Sprintf("Loading %s directly into GPU VRAM...", weightName), 45)
	eng, err := executor.New(cfg)
	if err != nil {
		sendUiProgress("Engine Error", fmt.Sprintf("Failed to load local model: %v", err), 0)
		log.Printf("[ERROR] Failed to start native CUDA engine: %v", err)
		m.initErr = err
		return nil, err
	}

	m.engine = eng
	m.modelPath = eng.Model()
	log.Printf("[INFO] Tendon Native CUDA Engine ready on %s! Status: %+v", eng.Endpoint(), eng.Status())
	sendUiProgress("Model Ready", fmt.Sprintf("Tendon engine ready on %s", eng.Endpoint()), 75)

	// Route any internal shuffle-shared library requests to our local OpenAI-compatible endpoint
	_ = os.Setenv("AI_API_URL", eng.Endpoint()+"/v1")
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
		log.Printf("[INFO] Closing Tendon Native CUDA Engine...")
		_ = m.engine.Close()
		m.engine = nil
	}
}

func (m *LocalExecutorManager) ExecutePrompt(ctx context.Context, prompt, execID, model, reasoning string, b *pkg.AgentBridge) (string, *shuffle.WorkflowExecution, bool, error) {
	modelLower := strings.ToLower(model)

	// Explicit cloud/BYOK models (Gemini, GPT, Claude, Groq, Anthropic) must NEVER trigger local engine execution
	if strings.HasPrefix(modelLower, "gemini") ||
		strings.HasPrefix(modelLower, "gpt") ||
		strings.HasPrefix(modelLower, "claude") ||
		strings.HasPrefix(modelLower, "groq") ||
		strings.HasPrefix(modelLower, "anthropic") {
		return "", nil, false, nil
	}

	apiKey := ""
	apiURL := ""
	if b != nil {
		apiKey = b.GetEffectiveAiKey()
		apiURL = b.GetEffectiveAiUrl()
	}

	isLocal := strings.HasPrefix(modelLower, "tendon") ||
		modelLower == "local" ||
		strings.HasPrefix(modelLower, "local/") ||
		strings.HasPrefix(modelLower, "local-") ||
		strings.HasPrefix(apiURL, "local://") ||
		apiKey == "local-tendon"

	if !isLocal {
		return "", nil, false, nil
	}

	log.Printf("[INFO][%s] Routing prompt to local Tendon CUDA Engine (model=%s, reasoning=%s, prompt_len=%d)",
		execID, model, reasoning, len(prompt))

	weightName := "Gemma-4 26B"
	if m.modelPath != "" {
		weightName = filepath.Base(m.modelPath)
	}
	sendUiProgress("Starting Local LLM", fmt.Sprintf("Preparing GPU engine with %s...", weightName), 20)

	eng, err := m.GetOrInitEngine()
	if err != nil {
		sendUiProgress("Engine Error", fmt.Sprintf("Local engine failed to initialize: %v", err), 0)
		log.Printf("[ERROR][%s] Local executor unavailable: %v", execID, err)
		return "", nil, true, fmt.Errorf("local CUDA engine failed to initialize: %w", err)
	}

	sendUiProgress("Native GPU Inference", fmt.Sprintf("Beginning generation on %s...", weightName), 75)

	// Dynamic reasoning control
	if rLevel, errParse := executor.ParseReasoningLevel(reasoning); errParse == nil {
		eng.SetReasoning(rLevel)
	}

	start := time.Now()
	streamChan, errStream := eng.Stream(ctx, prompt)
	if errStream != nil {
		sendUiProgress("Generating Response", "Executing non-streaming fallback on GPU...", 85)
		out, errGen := eng.Generate(ctx, prompt)
		if errGen != nil {
			sendUiProgress("Generation Error", fmt.Sprintf("Local generation failed: %v", errGen), 0)
			return "", nil, true, fmt.Errorf("local generation failed: %w", errGen)
		}
		duration := time.Since(start)
		sendUiProgress("Completed", fmt.Sprintf("Generation finished in %v", duration.Round(time.Millisecond)), 100)
		return m.buildExecutionResult(execID, prompt, out, "", duration)
	}

	var replyBuilder strings.Builder
	var reasoningBuilder strings.Builder
	tokenCount := 0
	lastLog := time.Now()
	gpuName := "GPU"
	if m.disco != nil && m.disco.GPUName != "" {
		gpuName = m.disco.GPUName
	}

	for delta := range streamChan {
		if delta.Err != nil {
			log.Printf("[WARNING][%s] Stream error from local engine: %v", execID, delta.Err)
			break
		}
		if delta.IsReasoning {
			reasoningBuilder.WriteString(delta.Reasoning)
		} else if delta.Text != "" {
			replyBuilder.WriteString(delta.Text)
		}
		tokenCount++
		if time.Since(lastLog) >= 1*time.Second {
			elapsed := time.Since(start).Round(time.Millisecond)
			log.Printf("[INFO][%s] Tendon CUDA generating: %d tokens streamed so far (%s elapsed)...",
				execID, tokenCount, elapsed)
			sendUiProgress("Generating Response", fmt.Sprintf("Generating on %s (%d tokens, %s)...", gpuName, tokenCount, elapsed), 90)
			lastLog = time.Now()
		}
	}

	outText := replyBuilder.String()
	reasoningText := reasoningBuilder.String()
	duration := time.Since(start)

	log.Printf("[INFO][%s] Local Tendon CUDA engine completed in %v (output: %d chars, reasoning: %d chars)",
		execID, duration.Round(time.Millisecond), len(outText), len(reasoningText))
	sendUiProgress("Completed", fmt.Sprintf("Generated %d tokens in %v", tokenCount, duration.Round(time.Millisecond)), 100)

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
		Reason: "Computed directly on GPU via local CUDA runtime",
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
					AppName: "Tendon Native CUDA Engine",
				},
				ExecutionId: execID,
				Result:      string(decisionsJSON),
				Status:      "SUCCESS",
			},
		},
	}

	return outText, exec, true, nil
}

func main() {
	cleanupLog := pkg.SetupLogging("shuffle-agent.log")
	defer cleanupLog()

	appConfig := pkg.LoadConfig()
	log.Printf("[INFO] Starting Shuffle Agent Runner (Windows Native Starter)")

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
	log.Printf("[INFO] Windows Accessibility / Privileges: %v", isAccessTrusted)
	log.Printf("[INFO] Windows Screen Recording Access: %v", hasScreenAccess)

	// Initialize AgentBridge and LocalExecutorManager immediately
	globalBridge = pkg.NewAgentBridge(appConfig)
	localExecMgr = newLocalExecutorManager()
	globalBridge.SetLocalAiExecutor(localExecMgr.ExecutePrompt)

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

	// Launch dashboard window
	log.Println("[INFO] Standalone mode: opening dashboard window")
	win := getOrCreateAgentWindow(appConfig)
	win.Show()

	// Launch Systray in background
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[WARNING] Systray recovered: %v", r)
			}
		}()
		runtime.LockOSThread()
		systray.Run(func() {
			onReady(appConfig)
		}, onExit)
	}()

	// Keep application running until OS termination
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	<-sigChan
	log.Println("[INFO] Terminating Shuffle Agent...")
	onExit()
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
		Title:       "Shuffle Tendon",
		Width:       1200,
		Height:      800,
		HTML:        pkg.GetAgentHTML(),
		IconPNG:     iconBytes,
		IconICO:     pkg.ShuffleIconICO,
		ProcessName: "Shuffle Tendon",
		BridgeHandler: func(action, payload string) string {
			if globalBridge == nil {
				return `{"error": "bridge not initialized"}`
			}
			log.Printf("[DEBUG] [UI-BRIDGE] Action: %s (payload len: %d)", action, len(payload))

			switch action {
			case "getLocalExecutorStatus":
				if localExecMgr == nil {
					return `{"status": "unavailable", "error": "local executor manager not initialized"}`
				}
				tendonVer := pkg.GetTendonVersion()
				localExecMgr.mu.Lock()
				eng := localExecMgr.engine
				disco := localExecMgr.disco
				localExecMgr.mu.Unlock()

				gpuName := ""
				vramTotal := 0
				vramFree := 0
				if disco != nil {
					gpuName = disco.GPUName
					vramTotal = disco.VRAMTotalMB
					vramFree = disco.VRAMFreeMB
				}

				if eng == nil {
					data, _ := json.Marshal(map[string]interface{}{
						"status":             "stopped",
						"gpu_name":           gpuName,
						"vram_total_mb":      vramTotal,
						"vram_free_mb":       vramFree,
						"models_dir":         globalBridge.GetLocalModelsDir(),
						"model_path":         globalBridge.GetLocalModelPath(),
						"tendon_version":     tendonVer,
						"tendon_release_url": pkg.GetTendonReleaseURL(tendonVer),
					})
					return string(data)
				}
				st := eng.Status()
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
					merged, errMerge := json.Marshal(stateMap)
					if errMerge == nil {
						return string(merged)
					}
				}
				return baseState

			default:
				log.Printf("[DEBUG] [UI-BRIDGE] Delegating action %q to global bridge", action)
				res := globalBridge.HandleAction(action, payload)
				log.Printf("[DEBUG] [UI-BRIDGE] Completed action %q (response len: %d)", action, len(res))
				return res
			}
		},
	})

	globalBridge.SetOnAuthUpdated(func(stateJSON string) {
		js := fmt.Sprintf("if (window.onAuthUpdated) { window.onAuthUpdated(%s); }", stateJSON)
		win.EvaluateJS(js)
	})

	agentWindow = win
	return win
}

// ensureICO ensures that the image bytes are wrapped in a valid Windows .ico container.
// Windows LoadImageW strictly requires .ico format and fails with ERROR_SUCCESS on raw PNG.
func ensureICO(data []byte) []byte {
	if len(data) == 0 {
		return nil
	}
	// Check if already an ICO (reserved: 0x0000, type: 0x0001)
	if len(data) >= 4 && data[0] == 0 && data[1] == 0 && data[2] == 1 && data[3] == 0 {
		return data
	}

	w, h := 32, 32
	var buf bytes.Buffer
	_ = binary.Write(&buf, binary.LittleEndian, uint16(0)) // reserved
	_ = binary.Write(&buf, binary.LittleEndian, uint16(1)) // type: 1 = ICO
	_ = binary.Write(&buf, binary.LittleEndian, uint16(1)) // count: 1

	bW := byte(w)
	if w >= 256 {
		bW = 0
	}
	bH := byte(h)
	if h >= 256 {
		bH = 0
	}
	_ = binary.Write(&buf, binary.LittleEndian, bW)
	_ = binary.Write(&buf, binary.LittleEndian, bH)
	_ = binary.Write(&buf, binary.LittleEndian, byte(0)) // color count
	_ = binary.Write(&buf, binary.LittleEndian, byte(0)) // reserved
	_ = binary.Write(&buf, binary.LittleEndian, uint16(1)) // color planes
	_ = binary.Write(&buf, binary.LittleEndian, uint16(32)) // bpp
	_ = binary.Write(&buf, binary.LittleEndian, uint32(len(data))) // image size
	_ = binary.Write(&buf, binary.LittleEndian, uint32(22)) // offset: 6 + 16 = 22
	buf.Write(data)

	return buf.Bytes()
}

func onReady(cfg *pkg.Config) {
	log.Println("[INFO] Systray event loop initialized on Windows")

	// Configure system tray icon and tooltip in taskbar notification area
	systray.SetTooltip("Shuffle Agent")
	if len(pkg.ShuffleIconICO) > 0 {
		systray.SetIcon(pkg.ShuffleIconICO)
	} else if len(pkg.ShuffleIconPNG) > 0 {
		systray.SetIcon(ensureICO(pkg.ShuffleIconPNG))
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

	engineTitle := fmt.Sprintf("Local Engine: Tendon CUDA v%s (RTX 3080 Ti)", pkg.GetTendonVersion())
	if localExecMgr != nil && localExecMgr.disco != nil && localExecMgr.disco.GPUName != "" {
		engineTitle = fmt.Sprintf("Local Engine: Tendon v%s - %s (%s)", pkg.GetTendonVersion(), localExecMgr.disco.GPUName, localExecMgr.disco.AccelerationType)
	}
	mEngine := systray.AddMenuItem(engineTitle, "Native GPU execution runtime")
	mEngine.Disable()

	systray.AddSeparator()

	// On-Demand Window Tool
	mOpenWindow := systray.AddMenuItem("Open Window", "Launch the desktop dashboard")

	systray.AddSeparator()

	mQuit := systray.AddMenuItem("Quit Shuffle Agent", "Exit the agent runner")

	// Handle Menu Events
	go func() {
		for {
			select {
			case <-mOpenWindow.ClickedCh:
				log.Println("[INFO] Taskbar clicked: Open Window")
				win := getOrCreateAgentWindow(cfg)
				win.Show()

			case <-mQuit.ClickedCh:
				log.Println("[INFO] Taskbar clicked: Quit")
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
