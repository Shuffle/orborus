//go:build darwin

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"runtime"
	"strings"
	"sync"

	"fyne.io/systray"
	"github.com/shuffle/osctrl"
	"github.com/shuffle/osctrl/webview"
	"orborus/pkg"
)

var (
	globalBridge *pkg.AgentBridge
	agentWindow  webview.Window
	windowMu     sync.Mutex
)

func init() {
	runtime.LockOSThread()
}

func main() {
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
			return globalBridge.HandleAction(action, payload)
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
}
