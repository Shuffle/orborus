//go:build !darwin

package webview

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

var (
	user32                           = syscall.NewLazyDLL("user32.dll")
	dwmapi                           = syscall.NewLazyDLL("dwmapi.dll")
	gdi32                            = syscall.NewLazyDLL("gdi32.dll")
	procEnumWindows                  = user32.NewProc("EnumWindows")
	procEnumChildWindows             = user32.NewProc("EnumChildWindows")
	procMoveWindow                   = user32.NewProc("MoveWindow")
	procGetClientRect                = user32.NewProc("GetClientRect")
	procSetWindowRgn                 = user32.NewProc("SetWindowRgn")
	procCreateRectRgn                = gdi32.NewProc("CreateRectRgn")
	procGetWindowThreadProcessId     = user32.NewProc("GetWindowThreadProcessId")
	procGetWindowLongW               = user32.NewProc("GetWindowLongW")
	procSetWindowLongW               = user32.NewProc("SetWindowLongW")
	procGetWindowLongPtrW            = user32.NewProc("GetWindowLongPtrW")
	procSetWindowLongPtrW            = user32.NewProc("SetWindowLongPtrW")
	procGetWindowRect                = user32.NewProc("GetWindowRect")
	procSetWindowPos                 = user32.NewProc("SetWindowPos")
	procSendMessageW                 = user32.NewProc("SendMessageW")
	procSetWindowTextW               = user32.NewProc("SetWindowTextW")
	procIsWindowVisible              = user32.NewProc("IsWindowVisible")
	procShowWindow                   = user32.NewProc("ShowWindow")
	procIsZoomed                     = user32.NewProc("IsZoomed")
	procReleaseCapture               = user32.NewProc("ReleaseCapture")
	procLoadImageW                   = user32.NewProc("LoadImageW")
	procFindWindowW                  = user32.NewProc("FindWindowW")
	procOpenInputDesktop             = user32.NewProc("OpenInputDesktop")
	procEnumDesktopWindows           = user32.NewProc("EnumDesktopWindows")
	procCloseDesktop                 = user32.NewProc("CloseDesktop")
	procGetWindowTextW               = user32.NewProc("GetWindowTextW")
	procGetClassNameW                = user32.NewProc("GetClassNameW")
	procDwmSetWindowAttribute        = dwmapi.NewProc("DwmSetWindowAttribute")
	procDwmExtendFrameIntoClientArea = dwmapi.NewProc("DwmExtendFrameIntoClientArea")
)

type winRect struct {
	Left, Top, Right, Bottom int32
}

func getWinLong(hwnd uintptr, index int) uintptr {
	var idx uintptr
	if index < 0 {
		idx = ^uintptr(uintptr(-index) - 1)
	} else {
		idx = uintptr(index)
	}
	if procGetWindowLongPtrW.Find() == nil {
		r, _, _ := procGetWindowLongPtrW.Call(hwnd, idx)
		if r != 0 {
			return r
		}
	}
	r, _, _ := procGetWindowLongW.Call(hwnd, idx)
	return r
}

func setWinLong(hwnd uintptr, index int, val uintptr) uintptr {
	var idx uintptr
	if index < 0 {
		idx = ^uintptr(uintptr(-index) - 1)
	} else {
		idx = uintptr(index)
	}
	if procSetWindowLongPtrW.Find() == nil {
		r, _, _ := procSetWindowLongPtrW.Call(hwnd, idx, val)
		if r != 0 {
			return r
		}
	}
	r, _, _ := procSetWindowLongW.Call(hwnd, idx, val)
	return r
}

type nonDarwinWindow struct {
	cfg        WindowConfig
	listener   net.Listener
	server     *http.Server
	port       int
	cmd        *exec.Cmd
	hwnd       uintptr
	clients    map[chan string]bool
	clientsMu  sync.Mutex
	isCreated  bool
	isVisible  bool
	mu         sync.Mutex
}

// New creates a new Window instance on non-darwin platforms (Windows / Linux).
// The webview server and application window are lazily initialized when Show() is called.
func New(cfg WindowConfig) Window {
	return &nonDarwinWindow{
		cfg:     cfg,
		clients: make(map[chan string]bool),
	}
}

func (w *nonDarwinWindow) Show() {
	w.mu.Lock()
	defer w.mu.Unlock()

	if !w.isCreated {
		if err := w.startLocalServer(); err != nil {
			log.Printf("[ERROR] Failed to start local webview server: %v", err)
			return
		}
		w.isCreated = true
	}

	w.isVisible = true
	w.launchAppWindow()
}

func (w *nonDarwinWindow) startLocalServer() error {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	w.listener = listener
	w.port = listener.Addr().(*net.TCPAddr).Port

	mux := http.NewServeMux()

	// Favicon handlers for browser / web surface
	mux.HandleFunc("/favicon.ico", func(rw http.ResponseWriter, r *http.Request) {
		ico := w.cfg.IconICO
		if len(ico) == 0 && len(w.cfg.IconPNG) > 0 {
			ico = ensureICO(w.cfg.IconPNG)
		}
		if len(ico) > 0 {
			rw.Header().Set("Content-Type", "image/x-icon")
			rw.Write(ico)
			return
		}
		http.NotFound(rw, r)
	})
	mux.HandleFunc("/favicon.png", func(rw http.ResponseWriter, r *http.Request) {
		if len(w.cfg.IconPNG) > 0 {
			rw.Header().Set("Content-Type", "image/png")
			rw.Write(w.cfg.IconPNG)
			return
		}
		http.NotFound(rw, r)
	})

	// Serve the embedded HTML with injected bridge polyfill
	mux.HandleFunc("/", func(rw http.ResponseWriter, r *http.Request) {
		rw.Header().Set("Content-Type", "text/html; charset=utf-8")
		bridgeScript := fmt.Sprintf(`
<script>
window.bridgeCall = async function(action, payload) {
    try {
        const res = await fetch('/api/bridge', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({action: action, payload: payload})
        });
        return await res.text();
    } catch (e) {
        console.error('bridge error', e);
        return JSON.stringify({error: e.message});
    }
};
window.onerror = function(msg, url, line, col, error) {
    try {
        fetch('/api/bridge', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({action: 'clientLog', payload: JSON.stringify({type: 'error', message: msg, filename: url, lineno: line, colno: col, stack: error ? (error.stack || error.message) : ''})})
        });
    } catch(e) {}
};
window.addEventListener('unhandledrejection', function(e) {
    try {
        fetch('/api/bridge', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({action: 'clientLog', payload: JSON.stringify({type: 'unhandledrejection', reason: e.reason ? (e.reason.stack || e.reason.message || String(e.reason)) : ''})})
        });
    } catch(err) {}
});
window.startWindowDrag = function() {
    if (typeof window.windowAction === 'function') {
        window.windowAction('drag');
    }
};
window.setTitlebarNoDragWidth = function() {};
window.setModalActive = function() {};
window.getInitialState = function() { return window.bridgeCall('getInitialState', ''); };
window.listProjects = function() { return window.bridgeCall('listProjects', ''); };
window.selectProject = function(path) { return window.bridgeCall('selectProject', path); };
window.setPermissionPolicy = function(policy) { return window.bridgeCall('setPermissionPolicy', policy); };
window.runPrompt = function(prompt, bypass, convId) { return window.bridgeCall('runPrompt', JSON.stringify({prompt: prompt, bypass: bypass, conversation_id: convId || ''})); };
window.respondApproval = function(id, approved) { return window.bridgeCall('respondApproval', JSON.stringify({id: id, approved: approved})); };
window.respondApprovalWithOptions = function(id, option, commandPrefix, scope, scopeId) { return window.bridgeCall('respondApprovalWithOptions', JSON.stringify({id: id, option: option, commandPrefix: commandPrefix, scope: scope, scopeId: scopeId})); };
window.getApprovalRules = function() { return window.bridgeCall('getApprovalRules', ''); };
window.addApprovalRule = function(rule) { return window.bridgeCall('addApprovalRule', typeof rule === 'string' ? rule : JSON.stringify(rule)); };
window.revokeApprovalRule = function(id) { return window.bridgeCall('revokeApprovalRule', id); };
window.clearApprovalRules = function() { return window.bridgeCall('clearApprovalRules', ''); };
window.setPinnedConversations = function(pinned) { return window.bridgeCall('setPinnedConversations', typeof pinned === 'string' ? pinned : JSON.stringify(pinned)); };
window.listConversations = function() { return window.bridgeCall('listConversations', ''); };
window.getConversation = function(id) { return window.bridgeCall('getConversation', id); };
window.saveConversation = function(conv) { return window.bridgeCall('saveConversation', typeof conv === 'string' ? conv : JSON.stringify(conv)); };
window.deleteConversation = function(id) { return window.bridgeCall('deleteConversation', id); };
window.archiveConversationBackend = function(id) { return window.bridgeCall('archiveConversation', id); };
window.unarchiveConversationBackend = function(id) { return window.bridgeCall('unarchiveConversation', id); };
window.getRightSidebarData = function() { return window.bridgeCall('getRightSidebarData', ''); };
window.listLocalModels = function(dir) { return window.bridgeCall('listLocalModels', JSON.stringify({directory: dir || ''})); };
window.setLocalModel = function(path, dir) { return window.bridgeCall('setLocalModel', JSON.stringify({path: path || '', directory: dir || ''})); };
window.getLocalExecutorStatus = function() { return window.bridgeCall('getLocalExecutorStatus', ''); };
window.setActiveExecutionMode = function(mode) { return window.bridgeCall('setActiveExecutionMode', mode); };
window.takeScreenshot = function() { return window.bridgeCall('takeScreenshot', ''); };
window.inspectUI = function() { return window.bridgeCall('inspectUI', ''); };
window.requestOSPermission = function(perm) { return window.bridgeCall('requestOSPermission', perm); };
window.updateAuth = function(authData) { return window.bridgeCall('updateAuth', typeof authData === 'string' ? authData : JSON.stringify(authData)); };
window.setAiConfig = function(url, key, policy, model) { return window.bridgeCall('setAiConfig', JSON.stringify({url: url, key: key, permission_policy: policy || '', model: model || ''})); };
window.startOAuthLogin = function(url) { return window.bridgeCall('startOAuthLogin', url || ''); };
window.setOAuthToken = function(token, org, env) { return window.bridgeCall('setOAuthToken', JSON.stringify({token: token, org: org, env: env})); };
window.windowAction = function(act) { return window.bridgeCall('windowAction', act); };
window.chooseDirectory = function() { return window.bridgeCall('chooseDirectory', ''); };
window.chooseFile = function() { return window.bridgeCall('chooseFile', ''); };
window.clearHistory = function() { return window.bridgeCall('clearHistory', ''); };
window.saveAllSettings = function(settings) { return window.bridgeCall('saveAllSettings', typeof settings === 'string' ? settings : JSON.stringify(settings)); };
window.setProjectPermissions = function(project, perms) { return window.bridgeCall('setProjectPermissions', JSON.stringify({project: project, permissions: perms})); };
window.listSkills = function(proj) { return window.bridgeCall('listSkills', proj || ''); };
window.injectSkillFile = function(path) { return window.bridgeCall('injectSkillFile', JSON.stringify({path: path || ''})); };
window.injectSkill = function(skill) { return window.bridgeCall('injectSkill', typeof skill === 'string' ? skill : JSON.stringify(skill)); };
window.removeInjectedSkill = function(name) { return window.bridgeCall('removeInjectedSkill', JSON.stringify({name: name})); };
window.clearInjectedSkills = function() { return window.bridgeCall('clearInjectedSkills', ''); };
window.getProjectContext = function(proj) { return window.bridgeCall('getProjectContext', proj || ''); };

// SSE channel for push events from EvaluateJS
const evtSource = new EventSource('/api/events');
evtSource.onmessage = function(e) {
    try {
        eval(e.data);
    } catch(err) {
        console.error('eval error', err);
    }
};
</script>
`)

		html := w.cfg.HTML
		headInjection := `<head>
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="icon" type="image/png" href="/favicon.png">
<title>Shuffle Tendon</title>
` + bridgeScript
		if strings.Contains(html, "<head>") {
			html = strings.Replace(html, "<head>", headInjection, 1)
		} else {
			html = headInjection + html
		}
		io.WriteString(rw, html)
	})

	// Bridge API endpoint
	mux.HandleFunc("/api/bridge", func(rw http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(rw, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Action  string `json:"action"`
			Payload string `json:"payload"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			log.Printf("[WEBVIEW-HTTP] Failed to decode bridge request: %v", err)
			http.Error(rw, err.Error(), http.StatusBadRequest)
			return
		}
		if req.Action == "clientLog" {
			log.Printf("[UI-CLIENT-LOG] %s", req.Payload)
			rw.Header().Set("Content-Type", "text/plain; charset=utf-8")
			io.WriteString(rw, `{"status":"ok"}`)
			return
		}

		if req.Action == "windowAction" {
			switch req.Payload {
			case "close":
				go func() {
					time.Sleep(50 * time.Millisecond)
					w.Close()
				}()
				rw.Header().Set("Content-Type", "text/plain; charset=utf-8")
				io.WriteString(rw, `{"status":"ok"}`)
				return
			case "minimize":
				w.Minimize()
				rw.Header().Set("Content-Type", "text/plain; charset=utf-8")
				io.WriteString(rw, `{"status":"ok"}`)
				return
			case "maximize":
				w.Maximize()
				rw.Header().Set("Content-Type", "text/plain; charset=utf-8")
				io.WriteString(rw, `{"status":"ok"}`)
				return
			case "drag":
				if runtime.GOOS == "windows" {
					w.mu.Lock()
					h := w.hwnd
					w.mu.Unlock()
					if h != 0 {
						procReleaseCapture.Call()
						procSendMessageW.Call(h, 0x00A1, 2, 0) // WM_NCLBUTTONDOWN, HTCAPTION
					}
				}
				rw.Header().Set("Content-Type", "text/plain; charset=utf-8")
				io.WriteString(rw, `{"status":"ok"}`)
				return
			}
		}

		resp := ""
		if w.cfg.BridgeHandler != nil {
			resp = w.cfg.BridgeHandler(req.Action, req.Payload)
		}
		rw.Header().Set("Content-Type", "text/plain; charset=utf-8")
		io.WriteString(rw, resp)
	})

	// SSE endpoint for server-to-client evaluations
	mux.HandleFunc("/api/events", func(rw http.ResponseWriter, r *http.Request) {
		flusher, ok := rw.(http.Flusher)
		if !ok {
			http.Error(rw, "Streaming unsupported", http.StatusInternalServerError)
			return
		}

		rw.Header().Set("Content-Type", "text/event-stream")
		rw.Header().Set("Cache-Control", "no-cache")
		rw.Header().Set("Connection", "keep-alive")

		msgChan := make(chan string, 16)
		w.clientsMu.Lock()
		w.clients[msgChan] = true
		w.clientsMu.Unlock()

		defer func() {
			w.clientsMu.Lock()
			delete(w.clients, msgChan)
			close(msgChan)
			w.clientsMu.Unlock()
		}()

		notify := r.Context().Done()
		for {
			select {
			case <-notify:
				return
			case msg, ok := <-msgChan:
				if !ok {
					return
				}
				fmt.Fprintf(rw, "data: %s\n\n", msg)
				flusher.Flush()
			}
		}
	})

	server := &http.Server{Handler: mux}
	w.server = server

	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Printf("[ERROR] Webview HTTP server stopped: %v", err)
		}
	}()

	return nil
}

func (w *nonDarwinWindow) launchAppWindow() {
	url := fmt.Sprintf("http://127.0.0.1:%d", w.port)
	appArg := fmt.Sprintf("--app=%s", url)
	width := w.cfg.Width
	if width <= 0 {
		width = 1200
	}
	height := w.cfg.Height
	if height <= 0 {
		height = 800
	}
	sizeArg := fmt.Sprintf("--window-size=%d,%d", width, height)

	go func() {
		if runtime.GOOS == "windows" {
			profileDir := filepath.Join(os.Getenv("LOCALAPPDATA"), "Shuffle", "Tendon", "app_profile")
			defaultDir := filepath.Join(profileDir, "Default")
			_ = os.MkdirAll(defaultDir, 0755)

			// Pre-configure Preferences to disable native frames, panels, and browser chrome
			prefFile := filepath.Join(defaultDir, "Preferences")
			var prefMap map[string]interface{}
			if data, err := os.ReadFile(prefFile); err == nil {
				_ = json.Unmarshal(data, &prefMap)
			}
			if prefMap == nil {
				prefMap = make(map[string]interface{})
			}

			browserMap, _ := prefMap["browser"].(map[string]interface{})
			if browserMap == nil {
				browserMap = make(map[string]interface{})
				prefMap["browser"] = browserMap
			}
			browserMap["custom_chrome_frame"] = false

			vivaldiMap, _ := prefMap["vivaldi"].(map[string]interface{})
			if vivaldiMap == nil {
				vivaldiMap = make(map[string]interface{})
				prefMap["vivaldi"] = vivaldiMap
			}
			vivaldiMap["windows"] = map[string]interface{}{"native_window": true}
			vivaldiMap["tabs"] = map[string]interface{}{"visible": false}
			vivaldiMap["address_bar"] = map[string]interface{}{"visible": false}
			vivaldiMap["status_bar"] = map[string]interface{}{"visible": false}
			vivaldiMap["panels"] = map[string]interface{}{"visible": false, "show_toggle": false}

			// Vivaldi layouts system explicitly controls the UI elements: "off" removes them completely
			layoutsMap, _ := vivaldiMap["layouts"].(map[string]interface{})
			if layoutsMap == nil {
				layoutsMap = make(map[string]interface{})
				vivaldiMap["layouts"] = layoutsMap
			}
			savedList, _ := layoutsMap["saved"].([]interface{})
			if len(savedList) == 0 {
				savedList = []interface{}{
					map[string]interface{}{
						"tabBar":     "off",
						"panel":      "off",
						"statusBar":  "off",
						"addressBar": "off",
					},
				}
			} else {
				for _, item := range savedList {
					if entry, ok := item.(map[string]interface{}); ok {
						entry["tabBar"] = "off"
						entry["panel"] = "off"
						entry["statusBar"] = "off"
						entry["addressBar"] = "off"
					}
				}
			}
			layoutsMap["saved"] = savedList

			if updated, err := json.MarshalIndent(prefMap, "", "  "); err == nil {
				_ = os.WriteFile(prefFile, updated, 0644)
			}

			profileArg := fmt.Sprintf("--user-data-dir=%s", profileDir)
			appIdArg := "--app-id=ShuffleTendon"

			// Try Edge, Chrome, Brave, Vivaldi app mode, then default browser
			candidates := []string{
				`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
				`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
				filepath.Join(os.Getenv("LOCALAPPDATA"), `Microsoft\Edge\Application\msedge.exe`),
				"msedge.exe",
				`C:\Program Files\Google\Chrome\Application\chrome.exe`,
				`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
				filepath.Join(os.Getenv("LOCALAPPDATA"), `Google\Chrome\Application\chrome.exe`),
				"chrome.exe",
				filepath.Join(os.Getenv("LOCALAPPDATA"), `Vivaldi\Application\vivaldi.exe`),
				`C:\Program Files\Vivaldi\Application\vivaldi.exe`,
				"vivaldi.exe",
				`C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe`,
				filepath.Join(os.Getenv("LOCALAPPDATA"), `BraveSoftware\Brave-Browser\Application\brave.exe`),
				"brave.exe",
			}
			for _, bin := range candidates {
				if bin == "" {
					continue
				}
				cmd := exec.Command(bin,
					appArg,
					sizeArg,
					profileArg,
					appIdArg,
					"--no-first-run",
					"--no-default-browser-check",
					"--force-dark-mode",
					"--disable-features=SidePanel,CustomizeChromeSidePanel",
				)
				if err := cmd.Start(); err == nil {
					w.cmd = cmd
					go w.configureWindowsWindow(cmd)
					return
				}
			}
			// Fallback: default browser
			_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
		} else {
			// Linux: try Chrome / Chromium in app mode, then xdg-open
			browsers := []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser"}
			for _, bin := range browsers {
				if _, err := exec.LookPath(bin); err == nil {
					cmd := exec.Command(bin, appArg, sizeArg)
					if err := cmd.Start(); err == nil {
						w.cmd = cmd
						return
					}
				}
			}
			// Fallback: xdg-open
			_ = exec.Command("xdg-open", url).Start()
		}
	}()
}

func (w *nonDarwinWindow) configureWindowsWindow(cmd *exec.Cmd) {
	var pid uint32
	if cmd != nil && cmd.Process != nil {
		pid = uint32(cmd.Process.Pid)
	}

	// Prepare Shuffle Icon file
	iconPath := ""
	icoBytes := w.cfg.IconICO
	if len(icoBytes) == 0 && len(w.cfg.IconPNG) > 0 {
		icoBytes = ensureICO(w.cfg.IconPNG)
	}
	if len(icoBytes) > 0 {
		tmp := filepath.Join(os.TempDir(), "shuffle_tendon.ico")
		if err := os.WriteFile(tmp, icoBytes, 0644); err == nil {
			iconPath = tmp
		}
	}

	log.Printf("[INFO] [WEBVIEW] Polling for application window (target PID: %d)...", pid)

	// Poll for window HWND (up to 12 seconds)
	var hwnd uintptr
	for i := 0; i < 60; i++ {
		time.Sleep(200 * time.Millisecond)
		hwnd = findAppWindow(pid)
		if hwnd != 0 {
			break
		}
	}

	if hwnd == 0 {
		log.Printf("[WARNING] [WEBVIEW] Could not acquire window handle for PID %d", pid)
		return
	}

	log.Printf("[INFO] [WEBVIEW] Successfully acquired window HWND=0x%X", hwnd)

	w.mu.Lock()
	w.hwnd = hwnd
	w.mu.Unlock()

	// Apply frameless styling repeatedly during startup while the browser finishes loading
	for i := 0; i < 40; i++ {
		styleWindowFrameless(hwnd, iconPath)
		time.Sleep(250 * time.Millisecond)
	}
}

func findAppWindow(targetPID uint32) uintptr {
	// First pass: match targetPID strictly
	if targetPID != 0 {
		var found uintptr
		cb := syscall.NewCallback(func(hwnd uintptr, lparam uintptr) uintptr {
			vis, _, _ := procIsWindowVisible.Call(hwnd)
			if vis == 0 {
				return 1
			}
			var pid uint32
			procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
			if pid != targetPID {
				return 1
			}
			var classBuf [256]uint16
			procGetClassNameW.Call(hwnd, uintptr(unsafe.Pointer(&classBuf[0])), 256)
			className := syscall.UTF16ToString(classBuf[:])
			if className == "Chrome_WidgetWin_1" {
				var r winRect
				procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
				if (r.Right-r.Left > 300) && (r.Bottom-r.Top > 200) {
					found = hwnd
					return 0
				}
			}
			return 1
		})

		hDesk, _, _ := procOpenInputDesktop.Call(0, 0, 0x10000000)
		if hDesk != 0 {
			procEnumDesktopWindows.Call(hDesk, cb, 0)
			procCloseDesktop.Call(hDesk)
		} else {
			procEnumWindows.Call(cb, 0)
		}
		if found != 0 {
			return found
		}
	}

	// Second pass: match title "Shuffle Tendon" on Chrome_WidgetWin_1 with size > 300x200
	var found uintptr
	cb := syscall.NewCallback(func(hwnd uintptr, lparam uintptr) uintptr {
		vis, _, _ := procIsWindowVisible.Call(hwnd)
		if vis == 0 {
			return 1
		}
		var classBuf [256]uint16
		procGetClassNameW.Call(hwnd, uintptr(unsafe.Pointer(&classBuf[0])), 256)
		className := syscall.UTF16ToString(classBuf[:])
		if className != "Chrome_WidgetWin_1" {
			return 1
		}
		var titleBuf [256]uint16
		procGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&titleBuf[0])), 256)
		title := syscall.UTF16ToString(titleBuf[:])
		if strings.Contains(title, "Shuffle Tendon") {
			var r winRect
			procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
			if (r.Right-r.Left > 300) && (r.Bottom-r.Top > 200) {
				found = hwnd
				return 0
			}
		}
		return 1
	})

	hDesk, _, _ := procOpenInputDesktop.Call(0, 0, 0x10000000)
	if hDesk != 0 {
		procEnumDesktopWindows.Call(hDesk, cb, 0)
		procCloseDesktop.Call(hDesk)
	} else {
		procEnumWindows.Call(cb, 0)
	}
	return found
}

func styleWindowFrameless(hwnd uintptr, iconPath string) {
	if hwnd == 0 {
		return
	}

	// Immersive Dark Mode for DWM (Windows 10 20H1+ / Windows 11)
	var darkMode uint32 = 1
	procDwmSetWindowAttribute.Call(hwnd, 20, uintptr(unsafe.Pointer(&darkMode)), 4) // DWMWA_USE_IMMERSIVE_DARK_MODE
	procDwmSetWindowAttribute.Call(hwnd, 19, uintptr(unsafe.Pointer(&darkMode)), 4) // DWMWA_USE_IMMERSIVE_DARK_MODE (older Win10)

	// Set window icon if provided
	if iconPath != "" {
		iconPathW, _ := syscall.UTF16PtrFromString(iconPath)
		hIcon, _, _ := procLoadImageW.Call(
			0,
			uintptr(unsafe.Pointer(iconPathW)),
			1, // IMAGE_ICON
			0, 0,
			0x00000010|0x00008000, // LR_LOADFROMFILE | LR_SHARED
		)
		if hIcon != 0 {
			procSendMessageW.Call(hwnd, 0x0080, 0, hIcon) // WM_SETICON, ICON_SMALL
			procSendMessageW.Call(hwnd, 0x0080, 1, hIcon) // WM_SETICON, ICON_BIG
		}
	}
}

func ensureICO(data []byte) []byte {
	if len(data) == 0 {
		return nil
	}
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

func (w *nonDarwinWindow) Hide() {
	w.isVisible = false
}

func (w *nonDarwinWindow) Close() {
	w.mu.Lock()
	defer w.mu.Unlock()

	w.isVisible = false
	if w.server != nil {
		_ = w.server.Close()
		w.server = nil
	}
	if w.cmd != nil && w.cmd.Process != nil {
		_ = w.cmd.Process.Kill()
		w.cmd = nil
	}
	w.isCreated = false
}

func (w *nonDarwinWindow) Minimize() {
	if runtime.GOOS == "windows" {
		w.mu.Lock()
		h := w.hwnd
		w.mu.Unlock()
		if h != 0 {
			procShowWindow.Call(h, 6) // SW_MINIMIZE
		}
	}
}

func (w *nonDarwinWindow) Maximize() {
	if runtime.GOOS == "windows" {
		w.mu.Lock()
		h := w.hwnd
		w.mu.Unlock()
		if h != 0 {
			zoomed, _, _ := procIsZoomed.Call(h)
			if zoomed != 0 {
				procShowWindow.Call(h, 9) // SW_RESTORE
			} else {
				procShowWindow.Call(h, 3) // SW_MAXIMIZE
			}
		}
	}
}

func (w *nonDarwinWindow) EvaluateJS(js string) {
	if js == "" {
		return
	}
	w.clientsMu.Lock()
	defer w.clientsMu.Unlock()

	for ch := range w.clients {
		select {
		case ch <- js:
		default:
		}
	}
}

func (w *nonDarwinWindow) IsVisible() bool {
	return w.isVisible
}

func (w *nonDarwinWindow) IsCreated() bool {
	return w.isCreated
}

func (w *nonDarwinWindow) Prewarm() {
	w.mu.Lock()
	defer w.mu.Unlock()

	if !w.isCreated {
		if err := w.startLocalServer(); err != nil {
			log.Printf("[ERROR] Failed to prewarm local webview server: %v", err)
			return
		}
		w.isCreated = true
	}
}

func runEncodedPowershell(script string) (string, error) {
	encoded := utf16.Encode([]rune(script))
	buf := make([]byte, len(encoded)*2)
	for i, v := range encoded {
		binary.LittleEndian.PutUint16(buf[i*2:], v)
	}
	b64 := base64.StdEncoding.EncodeToString(buf)
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Sta", "-EncodedCommand", b64).Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// ChooseFolder presents a modern Windows Explorer directory chooser dialog on Windows and native dialogs on Linux.
func ChooseFolder(title, prompt string) (string, error) {
	if runtime.GOOS == "windows" {
		psScript := fmt.Sprintf(`
try {
    if (-not ([System.Management.Automation.PSTypeName]'ModernFolderPicker').Type) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class WinWrapper : IWin32Window {
    private IntPtr _hwnd;
    public WinWrapper(IntPtr handle) { _hwnd = handle; }
    public IntPtr Handle { get { return _hwnd; } }
}

public class ModernFolderPicker {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7"), ClassInterface(ClassInterfaceType.None)]
    private class FileOpenDialogRCW { }

    [ComImport, Guid("42F85136-DB7E-439C-85F1-E40F45D35B38"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes();
        void SetFileTypeIndex();
        void GetFileTypeIndex();
        void Advise();
        void Unadvise();
        void SetOptions(uint fos);
        void GetOptions(out uint fos);
        void SetDefaultFolder(object psi);
        void SetFolder(object psi);
        void GetFolder(out object ppsi);
        void GetCurrentSelection(out object ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult([MarshalAs(UnmanagedType.Interface)] out IShellItem ppsi);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem {
        void BindToHandler();
        void GetParent();
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes();
        void Compare();
    }

    public static string Pick(string title) {
        IntPtr hwnd = GetForegroundWindow();
        var dialog = (IFileOpenDialog)new FileOpenDialogRCW();
        // FOS_PICKFOLDERS (0x20) | FOS_FORCEFILESYSTEM (0x40)
        dialog.SetOptions(0x00000020 | 0x00000040);
        if (!string.IsNullOrEmpty(title)) {
            dialog.SetTitle(title);
        }
        int hr = dialog.Show(hwnd);
        if (hr == 0) {
            IShellItem item;
            dialog.GetResult(out item);
            string path;
            item.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
            return path;
        }
        return null;
    }
}
"@ -ReferencedAssemblies "System.Windows.Forms" -ErrorAction Stop
    }
    $res = [ModernFolderPicker]::Pick(%q)
    if ($res) {
        Write-Output $res
        exit 0
    }
    exit 0
} catch {}

try {
    Add-Type -AssemblyName System.Windows.Forms
    $f = New-Object System.Windows.Forms.FolderBrowserDialog
    $f.Description = %q
    $hwnd = [ModernFolderPicker]::GetForegroundWindow()
    $owner = if ($hwnd -ne [IntPtr]::Zero) { New-Object WinWrapper($hwnd) } else { $null }
    if ($f.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
        Write-Output $f.SelectedPath
    }
} catch {}
`, title, title)

		out, err := runEncodedPowershell(psScript)
		if err == nil {
			return out, nil
		}
		return "", err
	}

	return chooseFolderLinux(title)
}

func chooseFolderLinux(title string) (string, error) {
	isKDE := strings.Contains(strings.ToUpper(os.Getenv("XDG_CURRENT_DESKTOP")), "KDE") || os.Getenv("KDE_FULL_SESSION") != ""

	tryKdialog := func() (string, bool) {
		if _, err := exec.LookPath("kdialog"); err == nil {
			out, err := exec.Command("kdialog", "--getexistingdirectory", "--title", title).Output()
			if err == nil {
				return strings.TrimSpace(string(out)), true
			}
		}
		return "", false
	}

	tryZenity := func() (string, bool) {
		if _, err := exec.LookPath("zenity"); err == nil {
			out, err := exec.Command("zenity", "--file-selection", "--directory", "--title="+title).Output()
			if err == nil {
				return strings.TrimSpace(string(out)), true
			}
		}
		return "", false
	}

	tryYad := func() (string, bool) {
		if _, err := exec.LookPath("yad"); err == nil {
			out, err := exec.Command("yad", "--file", "--directory", "--title="+title).Output()
			if err == nil {
				return strings.TrimSpace(string(out)), true
			}
		}
		return "", false
	}

	tryPython := func() (string, bool) {
		if _, err := exec.LookPath("python3"); err == nil {
			pyCmd := fmt.Sprintf("import tkinter as tk, tkinter.filedialog as fd; root = tk.Tk(); root.withdraw(); path = fd.askdirectory(title=%q); print(path if path else '')", title)
			out, err := exec.Command("python3", "-c", pyCmd).Output()
			if err == nil && len(strings.TrimSpace(string(out))) > 0 {
				return strings.TrimSpace(string(out)), true
			}
		}
		return "", false
	}

	var checks []func() (string, bool)
	if isKDE {
		checks = []func() (string, bool){tryKdialog, tryZenity, tryYad, tryPython}
	} else {
		checks = []func() (string, bool){tryZenity, tryKdialog, tryYad, tryPython}
	}

	for _, check := range checks {
		if res, ok := check(); ok {
			return res, nil
		}
	}

	return "", fmt.Errorf("no dialog utility (kdialog, zenity, yad, or python3) found")
}

// ChooseFile presents a file chooser dialog on Windows and Linux.
func ChooseFile(title, prompt string) (string, error) {
	if runtime.GOOS == "windows" {
		psScript := fmt.Sprintf(`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class FileWinWrapper : IWin32Window {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    private IntPtr _hwnd;
    public FileWinWrapper(IntPtr handle) { _hwnd = handle; }
    public IntPtr Handle { get { return _hwnd; } }
}
"@ -ReferencedAssemblies "System.Windows.Forms" -ErrorAction SilentlyContinue

$f = New-Object System.Windows.Forms.OpenFileDialog
$f.Title = %q
$hwnd = [FileWinWrapper]::GetForegroundWindow()
$owner = if ($hwnd -ne [IntPtr]::Zero) { New-Object FileWinWrapper($hwnd) } else { $null }
if ($f.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $f.FileName
}
`, title)
		out, err := runEncodedPowershell(psScript)
		if err == nil {
			return out, nil
		}
		return "", err
	}

	return chooseFileLinux(title)
}

func chooseFileLinux(title string) (string, error) {
	isKDE := strings.Contains(strings.ToUpper(os.Getenv("XDG_CURRENT_DESKTOP")), "KDE") || os.Getenv("KDE_FULL_SESSION") != ""

	tryKdialog := func() (string, bool) {
		if _, err := exec.LookPath("kdialog"); err == nil {
			out, err := exec.Command("kdialog", "--getopenfilename", "--title", title).Output()
			if err == nil {
				return strings.TrimSpace(string(out)), true
			}
		}
		return "", false
	}

	tryZenity := func() (string, bool) {
		if _, err := exec.LookPath("zenity"); err == nil {
			out, err := exec.Command("zenity", "--file-selection", "--title="+title).Output()
			if err == nil {
				return strings.TrimSpace(string(out)), true
			}
		}
		return "", false
	}

	tryYad := func() (string, bool) {
		if _, err := exec.LookPath("yad"); err == nil {
			out, err := exec.Command("yad", "--file", "--title="+title).Output()
			if err == nil {
				return strings.TrimSpace(string(out)), true
			}
		}
		return "", false
	}

	tryPython := func() (string, bool) {
		if _, err := exec.LookPath("python3"); err == nil {
			pyCmd := fmt.Sprintf("import tkinter as tk, tkinter.filedialog as fd; root = tk.Tk(); root.withdraw(); path = fd.askopenfilename(title=%q); print(path if path else '')", title)
			out, err := exec.Command("python3", "-c", pyCmd).Output()
			if err == nil && len(strings.TrimSpace(string(out))) > 0 {
				return strings.TrimSpace(string(out)), true
			}
		}
		return "", false
	}

	var checks []func() (string, bool)
	if isKDE {
		checks = []func() (string, bool){tryKdialog, tryZenity, tryYad, tryPython}
	} else {
		checks = []func() (string, bool){tryZenity, tryKdialog, tryYad, tryPython}
	}

	for _, check := range checks {
		if res, ok := check(); ok {
			return res, nil
		}
	}

	return "", fmt.Errorf("no dialog utility (kdialog, zenity, yad, or python3) found")
}
