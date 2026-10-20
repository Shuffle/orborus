//go:build windows

package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
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
	"github.com/shirou/gopsutil/v3/mem"
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
	modelActive := phase == "Model Active" || phase == "Model Ready" || phase == "Native GPU Inference" || phase == "Processing" || phase == "Generating Response"
	payload, _ := json.Marshal(map[string]interface{}{
		"phase":        phase,
		"detail":       detail,
		"progress":     progressPct,
		"model_active": modelActive,
	})
	js := fmt.Sprintf("if (typeof window.onAgentProgress === 'function') { window.onAgentProgress(%s); }", string(payload))
	win.EvaluateJS(js)
}

func findModelFile(modelPath, tendonVer string) (string, error) {
	if modelPath == "" {
		modelPath = "gemma-4-26B-A4B-it-UD-Q3_K_M.gguf"
	}

	// 1. Exact path as provided
	if fi, err := os.Stat(modelPath); err == nil && !fi.IsDir() {
		return modelPath, nil
	}
	if fi, err := os.Stat(modelPath + ".gguf"); err == nil && !fi.IsDir() {
		return modelPath + ".gguf", nil
	}

	base := filepath.Base(modelPath)
	dirs := []string{
		"models",
		filepath.Join(pkg.GetTendonDir(tendonVer), "models"),
		filepath.Join(os.Getenv("USERPROFILE"), ".shuffle", "models"),
		filepath.Join(os.Getenv("USERPROFILE"), "Documents", "antigravity", "delightful-mendeleev", "models"),
		filepath.Join("..", "delightful-mendeleev", "models"),
	}
	if globalBridge != nil && globalBridge.GetLocalModelsDir() != "" {
		dirs = append([]string{globalBridge.GetLocalModelsDir()}, dirs...)
	}

	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		// Direct file matches
		try1 := filepath.Join(dir, base)
		if fi, err := os.Stat(try1); err == nil && !fi.IsDir() {
			return try1, nil
		}
		try2 := filepath.Join(dir, base+".gguf")
		if fi, err := os.Stat(try2); err == nil && !fi.IsDir() {
			return try2, nil
		}

		// Search directory for matching quantized .gguf weights
		entries, err := os.ReadDir(dir)
		if err == nil {
			cleanBase := strings.TrimSuffix(base, ".gguf")
			for _, entry := range entries {
				if entry.IsDir() {
					continue
				}
				name := entry.Name()
				if strings.HasSuffix(strings.ToLower(name), ".gguf") {
					if strings.Contains(strings.ToLower(name), strings.ToLower(cleanBase)) {
						return filepath.Join(dir, name), nil
					}
				}
			}
		}
	}

	return "", fmt.Errorf("local model weight file '%s' not found on disk", base)
}

func (m *LocalExecutorManager) GetOrInitEngineForModel(ctx context.Context, modelKey string) (executor.Engine, error) {
	modelsDir := "models"
	explicitPath := os.Getenv("LOCAL_MODEL_PATH")
	if globalBridge != nil {
		if d := globalBridge.GetLocalModelsDir(); d != "" {
			modelsDir = d
		}
		if p := globalBridge.GetLocalModelPath(); p != "" {
			explicitPath = p
		}
	}

	if spec := pkg.GetLocalModelSpec(modelKey); spec != nil {
		resolved, ok := pkg.ResolveOrFindLocalModelFile(spec.Key, modelsDir, explicitPath)
		if !ok {
			sendUiProgress("Checking Disk Space", fmt.Sprintf("Preparing to download %s (~%s)...", spec.Label, spec.SizeDisplay), 5)
			downloadedPath, errDl := pkg.GlobalModelDownloader.EnsureModelDownloaded(ctx, spec.Key, modelsDir, explicitPath)
			if errDl != nil {
				sendUiProgress("Download Error", fmt.Sprintf("Failed to download %s: %v", spec.Label, errDl), 0)
				return nil, errDl
			}
			resolved = downloadedPath
		}
		if resolved != "" {
			m.mu.Lock()
			needSwitch := m.modelPath != "" && !strings.EqualFold(filepath.Clean(m.modelPath), filepath.Clean(resolved))
			m.mu.Unlock()
			if needSwitch {
				_ = m.SwitchModel(resolved)
			} else {
				m.mu.Lock()
				m.modelPath = resolved
				m.mu.Unlock()
			}
			if globalBridge != nil {
				globalBridge.SetLocalModelPath(resolved)
			}
		}
	}

	return m.GetOrInitEngine()
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

	rawPath := m.modelPath
	if rawPath == "" {
		rawPath = os.Getenv("LOCAL_MODEL_PATH")
	}
	if rawPath == "" && globalBridge != nil && globalBridge.GetLocalModelPath() != "" {
		rawPath = globalBridge.GetLocalModelPath()
	}

	resolvedModelPath, errFind := findModelFile(rawPath, tendonVer)
	if errFind != nil {
		log.Printf("[ERROR] Model file resolution failed: %v", errFind)
		sendUiProgress("Model Not Found", fmt.Sprintf("GGUF weight not found for %s. Place file in models/ directory.", filepath.Base(rawPath)), 0)
		m.initErr = errFind
		return nil, errFind
	}

	weightName := filepath.Base(resolvedModelPath)
	sendUiProgress("Initializing GPU Engine", fmt.Sprintf("Binding %s", weightName), 20)

	log.Printf("[INFO] Initializing Tendon Native CUDA Engine v%s with model: %s", tendonVer, resolvedModelPath)
	cfg := executor.Config{
		ModelPath: resolvedModelPath,
		Driver:    executor.DriverNative,
		LoadMode:  "none", // Direct VRAM loading with zero host RAM ballooning
		MaxTokens: 4096,
	}

	sendUiProgress("Transferring Weights", fmt.Sprintf("%s into GPU VRAM...", weightName), 45)

	doneCh := make(chan struct {
		eng executor.Engine
		err error
	}, 1)
	startTime := time.Now()

	go func() {
		eng, err := executor.New(cfg)
		doneCh <- struct {
			eng executor.Engine
			err error
		}{eng: eng, err: err}
	}()

	ticker := time.NewTicker(1500 * time.Millisecond)
	defer ticker.Stop()

	progressPct := 45
	var eng executor.Engine
	var initErr error

engineWaitLoop:
	for {
		select {
		case res := <-doneCh:
			eng = res.eng
			initErr = res.err
			break engineWaitLoop
		case <-ticker.C:
			elapsed := int(time.Since(startTime).Seconds())
			if progressPct < 85 {
				progressPct += 5
			}
			sendUiProgress("Transferring Weights", fmt.Sprintf("%s into GPU VRAM (%ds elapsed)...", weightName, elapsed), progressPct)
		}
	}

	if initErr != nil {
		sendUiProgress("Engine Error", fmt.Sprintf("Failed to load local model: %v", initErr), 0)
		log.Printf("[ERROR] Failed to start native CUDA engine: %v", initErr)
		m.initErr = initErr
		return nil, initErr
	}

	m.engine = eng
	m.modelPath = eng.Model()
	log.Printf("[INFO] Tendon Native CUDA Engine ready on %s! Status: %+v", eng.Endpoint(), eng.Status())
	sendUiProgress("Model Ready", fmt.Sprintf("Tendon engine online on %s", eng.Endpoint()), 100)

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
	if spec := pkg.GetLocalModelSpec(model); spec != nil {
		weightName = spec.Label
	} else if m.modelPath != "" {
		weightName = filepath.Base(m.modelPath)
	}
	sendUiProgress("Native GPU Engine", fmt.Sprintf("Target weight: %s", weightName), 15)

	eng, err := m.GetOrInitEngineForModel(ctx, model)
	if err != nil {
		sendUiProgress("Engine Error", fmt.Sprintf("Local engine failed to initialize: %v", err), 0)
		log.Printf("[ERROR][%s] Local executor unavailable: %v", execID, err)
		return "", nil, true, fmt.Errorf("local CUDA engine failed to initialize: %w", err)
	}
	if m.modelPath != "" {
		weightName = filepath.Base(m.modelPath)
	}

	sendUiProgress("Native GPU Inference", fmt.Sprintf("Generating response with %s...", weightName), 75)

	// Dynamic reasoning control
	if rLevel, errParse := executor.ParseReasoningLevel(reasoning); errParse == nil {
		eng.SetReasoning(rLevel)
		log.Printf("[INFO][%s] Tendon engine reasoning level set to: %s", execID, rLevel)
	}

	// Ensure generous inference context so cold-start model load does not eat generation time
	genCtx, genCancel := context.WithTimeout(context.Background(), 600*time.Second)
	defer genCancel()

	// If parent context is cancelled (e.g. user stops execution), cancel generation context
	go func() {
		select {
		case <-ctx.Done():
			genCancel()
		case <-genCtx.Done():
		}
	}()

	start := time.Now()
	log.Printf("[INFO][%s] Initiating generation stream from local engine (model=%s, reasoning=%s, prompt_len=%d)...",
		execID, weightName, reasoning, len(prompt))
	streamChan, errStream := eng.Stream(genCtx, prompt)
	if errStream != nil {
		log.Printf("[WARNING][%s] Stream initiation failed (%v), falling back to non-streaming Generate...", execID, errStream)
		sendUiProgress("Generating Response", "Executing non-streaming fallback on GPU...", 85)
		out, errGen := eng.Generate(genCtx, prompt)
		if errGen != nil {
			sendUiProgress("Generation Error", fmt.Sprintf("Local generation failed: %v", errGen), 0)
			log.Printf("[ERROR][%s] Local generation fallback failed: %v", execID, errGen)
			return "", nil, true, fmt.Errorf("local generation failed: %w", errGen)
		}
		duration := time.Since(start)
		sendUiProgress("Completed", fmt.Sprintf("Generation finished in %v", duration.Round(time.Millisecond)), 100)
		log.Printf("[INFO][%s] Tendon CUDA non-streaming generation finished in %v (output chars: %d)",
			execID, duration.Round(time.Millisecond), len(out))
		return m.buildExecutionResult(execID, prompt, out, "", duration)
	}

	var replyBuilder strings.Builder
	var reasoningBuilder strings.Builder
	tokenCount := 0
	var firstTokenTime time.Duration
	var streamErr error
	lastLog := time.Now()
	gpuName := "GPU"
	if m.disco != nil && m.disco.GPUName != "" {
		gpuName = m.disco.GPUName
	}

	for delta := range streamChan {
		if delta.Err != nil {
			streamErr = delta.Err
			log.Printf("[ERROR][%s] Stream error from local engine after %d tokens (%v elapsed): %v",
				execID, tokenCount, time.Since(start).Round(time.Millisecond), delta.Err)
			break
		}

		if tokenCount == 0 {
			firstTokenTime = time.Since(start)
			log.Printf("[INFO][%s] Tendon CUDA first token received in %v (TTFT)", execID, firstTokenTime.Round(time.Millisecond))
		}

		if delta.IsReasoning {
			if delta.Reasoning != "" {
				reasoningBuilder.WriteString(delta.Reasoning)
				if b != nil && strings.TrimSpace(reasoningBuilder.String()) != "" {
					b.StreamChunk(execID, delta.Reasoning, true)
				}
			}
		} else if delta.Text != "" {
			replyBuilder.WriteString(delta.Text)
			if b != nil {
				b.StreamChunk(execID, delta.Text, false)
			}
		}
		tokenCount++

		if time.Since(lastLog) >= 1*time.Second {
			elapsed := time.Since(start).Round(time.Millisecond)
			tokSec := float64(tokenCount) / time.Since(start).Seconds()
			recentSnippet := delta.Text
			if recentSnippet == "" {
				recentSnippet = delta.Reasoning
			}
			recentSnippet = strings.ReplaceAll(recentSnippet, "\n", " ")
			if len(recentSnippet) > 30 {
				recentSnippet = recentSnippet[:30] + "..."
			}
			log.Printf("[INFO][%s] Tendon CUDA generating: %d tokens streamed (%0.1f tok/s, %s elapsed) | snippet: %q",
				execID, tokenCount, tokSec, elapsed, recentSnippet)
			sendUiProgress("Generating Response", fmt.Sprintf("Generating on %s (%d tokens, %0.1f tok/s, %s)...", gpuName, tokenCount, tokSec, elapsed), 90)
			lastLog = time.Now()
		}
	}

	duration := time.Since(start)
	outText := replyBuilder.String()
	reasoningText := reasoningBuilder.String()

	if streamErr != nil {
		isUserCancel := errors.Is(streamErr, context.Canceled) ||
			errors.Is(ctx.Err(), context.Canceled) ||
			errors.Is(genCtx.Err(), context.Canceled) ||
			strings.Contains(strings.ToLower(streamErr.Error()), "cancel")

		if isUserCancel {
			sendUiProgress("Stopped", "Generation stopped by user", 100)
			log.Printf("[INFO][%s] Local Tendon CUDA engine cleanly stopped by user after %d tokens (%v). Preserving %d characters of partial output.",
				execID, tokenCount, duration.Round(time.Millisecond), len(outText))
		} else if len(outText) == 0 && len(reasoningText) == 0 {
			sendUiProgress("Generation Error", fmt.Sprintf("Local generation failed: %v", streamErr), 0)
			log.Printf("[ERROR][%s] Local Tendon CUDA engine generation failed with 0 tokens after %v: %v",
				execID, duration.Round(time.Millisecond), streamErr)
			return "", nil, true, fmt.Errorf("local model generation failed after %v: %w", duration.Round(time.Millisecond), streamErr)
		} else {
			log.Printf("[WARNING][%s] Local Tendon CUDA engine interrupted after %d tokens (%v): %v. Preserving %d characters of partial output.",
				execID, tokenCount, duration.Round(time.Millisecond), streamErr, len(outText))
			outText += fmt.Sprintf("\n\n[Generation stopped: %v]", streamErr)
		}
	} else {
		tokSec := 0.0
		if duration.Seconds() > 0 {
			tokSec = float64(tokenCount) / duration.Seconds()
		}
		log.Printf("[INFO][%s] Local Tendon CUDA engine completed in %v (%d tokens, %0.1f tok/s, TTFT: %v, output: %d chars, reasoning: %d chars)",
			execID, duration.Round(time.Millisecond), tokenCount, tokSec, firstTokenTime.Round(time.Millisecond), len(outText), len(reasoningText))
		sendUiProgress("Completed", fmt.Sprintf("Generated %d tokens (%0.1f tok/s) in %v", tokenCount, tokSec, duration.Round(time.Millisecond)), 100)
	}

	return m.buildExecutionResult(execID, prompt, outText, reasoningText, duration)
}

func (m *LocalExecutorManager) buildExecutionResult(execID, prompt, outText, reasoningText string, duration time.Duration) (string, *shuffle.WorkflowExecution, bool, error) {
	actionID := fmt.Sprintf("act-%d", time.Now().UnixNano())
	now := time.Now().Unix()

	if pkg.IsGenericPlaceholderOutput(outText) && strings.TrimSpace(reasoningText) != "" {
		extracted := pkg.ExtractAnswerFromReasoning(reasoningText)
		if extracted != "" {
			outText = extracted
		} else {
			outText = strings.TrimSpace(reasoningText)
		}
	}

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

	agentOut := shuffle.AgentOutput{
		Status:    "FINISHED",
		Output:    outText,
		Decisions: decisions,
	}
	agentOutJSON, _ := json.Marshal(agentOut)

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
				Result:      string(agentOutJSON),
				Status:      "SUCCESS",
			},
		},
	}

	return outText, exec, true, nil
}

func hideConsoleWindow() {
	if strings.EqualFold(os.Getenv("SHOW_CONSOLE"), "true") || os.Getenv("SHOW_CONSOLE") == "1" {
		return
	}
	for _, arg := range os.Args[1:] {
		if arg == "--console" || arg == "-console" {
			return
		}
	}
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	user32 := syscall.NewLazyDLL("user32.dll")
	getConsoleWindow := kernel32.NewProc("GetConsoleWindow")
	showWindow := user32.NewProc("ShowWindow")
	if getConsoleWindow.Find() == nil && showWindow.Find() == nil {
		hwnd, _, _ := getConsoleWindow.Call()
		if hwnd != 0 {
			const swHide = 0
			_, _, _ = showWindow.Call(hwnd, uintptr(swHide))
		}
	}
}

func main() {
	hideConsoleWindow()

	cleanupLog := pkg.SetupLogging("shuffle-agent.log")
	defer cleanupLog()

	appConfig := pkg.LoadConfig()
	log.Printf("[INFO] Starting Shuffle Tendon (Windows Native Starter)")

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

	// Launch dashboard window automatically on startup (unless TRAY_ONLY is set)
	if !strings.EqualFold(os.Getenv("TRAY_ONLY"), "true") && os.Getenv("TRAY_ONLY") != "1" {
		log.Println("[INFO] Auto-launching Shuffle Tendon UI window")
		win := getOrCreateAgentWindow(appConfig)
		win.Show()
	}

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
	if agentWindow != nil {
		w := agentWindow
		windowMu.Unlock()
		return w
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
			isQuietAction := action == "getRightSidebarData" ||
				action == "getRecentLogs" ||
				action == "getLocalExecutorStatus" ||
				action == "getLocalDownloadStatus" ||
				action == "getApprovalQueue" ||
				action == "setTitlebarNoDragWidth" ||
				action == "setModalActive" ||
				action == "clientLog"
			if cfg != nil && cfg.Debug && !isQuietAction {
				log.Printf("[DEBUG] [UI-BRIDGE] Action: %s (payload len: %d)", action, len(payload))
			}

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
				sysRamTotal := uint64(0)
				sysRamFree := uint64(0)
				if vMem, errMem := mem.VirtualMemory(); errMem == nil && vMem != nil {
					sysRamTotal = vMem.Total / (1024 * 1024)
					sysRamFree = vMem.Available / (1024 * 1024)
				}

				modelsDir := globalBridge.GetLocalModelsDir()
				diskInfo := pkg.GetDiskSpaceInfo(modelsDir)
				dlState := pkg.GlobalModelDownloader.GetState()

				if eng == nil {
					data, _ := json.Marshal(map[string]interface{}{
						"status":              "stopped",
						"gpu_name":            gpuName,
						"vram_total_mb":       vramTotal,
						"vram_free_mb":        vramFree,
						"system_ram_total_mb": sysRamTotal,
						"system_ram_free_mb":  sysRamFree,
						"models_dir":          modelsDir,
						"model_path":          globalBridge.GetLocalModelPath(),
						"tendon_version":      tendonVer,
						"tendon_release_url":  pkg.GetTendonReleaseURL(tendonVer),
						"free_disk_bytes":     diskInfo.FreeBytes,
						"free_disk_gb":        diskInfo.FreeGB,
						"free_disk_display":   diskInfo.FreeDisplay,
						"download_state":      dlState,
					})
					return string(data)
				}
				st := eng.Status()
				data, _ := json.Marshal(map[string]interface{}{
					"status":              "ready",
					"engine":              st,
					"gpu_name":            st.GPUName,
					"vram_total_mb":       st.VRAMTotalMB,
					"vram_free_mb":        st.VRAMFreeMB,
					"system_ram_total_mb": sysRamTotal,
					"system_ram_free_mb":  sysRamFree,
					"driver":              st.Driver,
					"model":               st.Model,
					"context_size":        st.ContextSize,
					"models_dir":          modelsDir,
					"model_path":          globalBridge.GetLocalModelPath(),
					"tendon_version":      tendonVer,
					"tendon_release_url":  pkg.GetTendonReleaseURL(tendonVer),
					"free_disk_bytes":     diskInfo.FreeBytes,
					"free_disk_gb":        diskInfo.FreeGB,
					"free_disk_display":   diskInfo.FreeDisplay,
					"download_state":      dlState,
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
					if vMem, errMem := mem.VirtualMemory(); errMem == nil && vMem != nil {
						stateMap["system_ram_total_mb"] = vMem.Total / (1024 * 1024)
						stateMap["system_ram_free_mb"] = vMem.Available / (1024 * 1024)
					}
					merged, errMerge := json.Marshal(stateMap)
					if errMerge == nil {
						return string(merged)
					}
				}
				return baseState

			case "logoutShuffle":
				return globalBridge.LogoutShuffle()

			default:
				if cfg != nil && cfg.Debug && !isQuietAction {
					log.Printf("[DEBUG] [UI-BRIDGE] Delegating action %q to global bridge", action)
				}
				res := globalBridge.HandleAction(action, payload)
				if cfg != nil && cfg.Debug && !isQuietAction {
					log.Printf("[DEBUG] [UI-BRIDGE] Completed action %q (response len: %d)", action, len(res))
				}
				return res
			}
		},
	})

	agentWindow = win
	windowMu.Unlock()

	globalBridge.SetOnAuthUpdated(func(stateJSON string) {
		windowMu.Lock()
		w := agentWindow
		windowMu.Unlock()
		if w != nil {
			js := fmt.Sprintf("if (typeof window.onAuthUpdated === 'function') { window.onAuthUpdated(%s); }", stateJSON)
			w.EvaluateJS(js)
			w.Show()
		}
	})

	globalBridge.SetOnChunkWithReasoning(func(execID, chunk string, isReasoning bool) {
		chunkJSON, err := json.Marshal(chunk)
		if err == nil {
			windowMu.Lock()
			w := agentWindow
			windowMu.Unlock()
			if w != nil {
				js := fmt.Sprintf("if (typeof window.onAgentChunk === 'function') { window.onAgentChunk(%q, %s, %t); }", execID, string(chunkJSON), isReasoning)
				w.EvaluateJS(js)
			}
		}
	})

	globalBridge.SetOnApprovalRequest(func(reqJSON string) {
		windowMu.Lock()
		w := agentWindow
		windowMu.Unlock()
		if w != nil {
			js := fmt.Sprintf("if (typeof window.onApprovalRequest === 'function') { window.onApprovalRequest(%s); }", reqJSON)
			w.EvaluateJS(js)
			if !strings.Contains(reqJSON, `"sync_queue":true`) {
				w.Show()
			}
		}
	})

	pkg.GlobalModelDownloader.SetProgressCallback(func(st pkg.LocalModelDownloadState) {
		if st.Status == "completed" && st.TargetPath != "" {
			if globalBridge != nil {
				globalBridge.SetLocalModelPath(st.TargetPath)
			}
			if localExecMgr != nil {
				_ = localExecMgr.SwitchModel(st.TargetPath)
			}
		}
		if st.Status == "downloading" {
			dlGB := float64(st.DownloadedBytes) / (1024 * 1024 * 1024)
			totGB := float64(st.TotalBytes) / (1024 * 1024 * 1024)
			detail := fmt.Sprintf("%s · %d%% (%.2f / %.2f GB · %.1f MB/s)", st.Label, st.ProgressPct, dlGB, totGB, st.SpeedMBps)
			sendUiProgress("Downloading Model", detail, st.ProgressPct)
		}
		windowMu.Lock()
		w := agentWindow
		windowMu.Unlock()
		if w != nil {
			if stJSON, err := json.Marshal(st); err == nil {
				js := fmt.Sprintf("if (typeof window.onLocalModelDownloadProgress === 'function') { window.onLocalModelDownloadProgress(%s); }", string(stJSON))
				w.EvaluateJS(js)
			}
		}
	})

	pkg.RegisterLogListener(func(line string) {
		windowMu.Lock()
		w := agentWindow
		windowMu.Unlock()
		if w != nil {
			lineJSON, err := json.Marshal(line)
			if err == nil {
				js := fmt.Sprintf("if (typeof window.onBackendLog === 'function') { window.onBackendLog(%s); }", string(lineJSON))
				w.EvaluateJS(js)
			}
		}
	})

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
