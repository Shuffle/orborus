package uivalidate

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type ButtonTestResult struct {
	TestedButtons   int           `json:"testedButtons"`
	TestedFunctions int           `json:"testedFunctions"`
	TotalTested     int           `json:"totalTested"`
	Errors          []ErrorRecord `json:"errors"`
}

type ErrorRecord struct {
	Type    string `json:"type"`
	Target  string `json:"target"`
	Message string `json:"message"`
	Stack   string `json:"stack"`
}

// RunButtonTests launches Vivaldi headless, navigates to the bundled index.html,
// simulates clicks and executions of every button, tab, and handler, and returns errors.
func RunButtonTests(htmlPath string) (*ButtonTestResult, error) {
	rawHtml, err := os.ReadFile(htmlPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read %s: %w", htmlPath, err)
	}

	vivaldiPath := findVivaldiPath()
	if vivaldiPath == "" {
		return nil, fmt.Errorf("vivaldi executable not found")
	}

	instrumented := injectTestHarness(string(rawHtml))

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("failed to bind local test server: %w", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port

	resultChan := make(chan ButtonTestResult, 1)

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(instrumented))
	})
	mux.HandleFunc("/__test_report", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			var res ButtonTestResult
			if err := json.NewDecoder(r.Body).Decode(&res); err == nil {
				resultChan <- res
			}
			w.WriteHeader(http.StatusOK)
		}
	})

	server := &http.Server{Handler: mux}
	go server.Serve(listener)
	defer server.Close()

	testUrl := fmt.Sprintf("http://127.0.0.1:%d/", port)

	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, vivaldiPath,
		"--headless=new",
		"--disable-gpu",
		"--disable-extensions",
		"--no-sandbox",
		"--disable-dev-shm-usage",
		testUrl,
	)

	var cmdErrBuf bytes.Buffer
	cmd.Stderr = &cmdErrBuf

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start Vivaldi: %w", err)
	}

	select {
	case res := <-resultChan:
		_ = cmd.Process.Kill()
		return &res, nil

	case <-time.After(10 * time.Second):
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("timeout waiting for Vivaldi button tests (stderr: %s)", cmdErrBuf.String())
	}
}

func findVivaldiPath() string {
	candidates := []string{
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Vivaldi", "Application", "vivaldi.exe"),
		filepath.Join(os.Getenv("PROGRAMFILES"), "Vivaldi", "Application", "vivaldi.exe"),
		filepath.Join(os.Getenv("PROGRAMFILES(X86)"), "Vivaldi", "Application", "vivaldi.exe"),
		"vivaldi",
	}
	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			return c
		}
	}
	return ""
}

func injectTestHarness(html string) string {
	headScript := `
<script>
window.__capturedErrors = [];

window.addEventListener('error', function(e) {
  window.__capturedErrors.push({
    type: 'UncaughtError',
    target: (e.filename || 'window') + ':' + (e.lineno || 0) + ':' + (e.colno || 0),
    message: e.message || String(e),
    stack: e.error ? e.error.stack : ''
  });
});

window.addEventListener('unhandledrejection', function(e) {
  window.__capturedErrors.push({
    type: 'UnhandledRejection',
    target: 'Promise',
    message: String(e.reason),
    stack: (e.reason && e.reason.stack) ? e.reason.stack : ''
  });
});

// Mock all backend bridge calls before any UI script evaluates
window.bridgeCall = async function(action, payload) {
  return JSON.stringify({ status: "ok" });
};
window.agentBridge = {
  handleAction: async function(action, payload) {
    return JSON.stringify({ status: "ok" });
  }
};
window.listSkills = async function() { return JSON.stringify([]); };
window.injectSkillFile = async function() { return JSON.stringify({ status: "ok" }); };
window.getInitialState = function() { return JSON.stringify({}); };
window.setAiConfig = function() {};
window.setActiveExecutionMode = async function() {};
window.getLocalExecutorStatus = async function() {};
</script>
`

	bodyScript := `
<script>
(function() {
  async function runAllButtonTests() {
    const capturedErrors = window.__capturedErrors || [];

    let testedButtons = 0;
    let testedFunctions = 0;

    // 1. Gather all interactive DOM elements
    const elementsToClick = Array.from(document.querySelectorAll(
      'button, a[onclick], [onclick], input[type="button"], .settings-nav-item, .byok-chip-btn, .approval-option-item, .model-picker-pill'
    ));

    for (const el of elementsToClick) {
      testedButtons++;
      const idOrClass = el.id || el.className || el.innerText || 'unnamed-element';
      try {
        if (typeof el.onclick === 'function') {
          el.onclick.call(el, new MouseEvent('click', { bubbles: true, cancelable: true }));
        } else if (typeof el.click === 'function') {
          el.click();
        }
      } catch (err) {
        capturedErrors.push({
          type: 'ButtonClickHandlerError',
          target: idOrClass,
          message: err.message || String(err),
          stack: err.stack || ''
        });
      }
    }

    // 2. Programmatically invoke key handlers
    const functionsToTest = [
      () => window.toggleModelDropdown && window.toggleModelDropdown(new Event('click')),
      () => window.toggleReasoningDropdown && window.toggleReasoningDropdown(new Event('click')),
      () => window.toggleProjectDropdown && window.toggleProjectDropdown(new Event('click')),
      () => window.toggleRunningTasks && window.toggleRunningTasks(),
      () => window.toggleActiveSteps && window.toggleActiveSteps(),
      () => window.toggleSidebar && window.toggleSidebar(),
      () => window.toggleRightSidebar && window.toggleRightSidebar(),
      () => window.toggleHistoryModal && window.toggleHistoryModal(),
      () => window.closeHistoryModal && window.closeHistoryModal(),
      () => window.startNewSession && window.startNewSession(),
      () => window.openSettingsModal && window.openSettingsModal(),
      () => window.closeSettingsModal && window.closeSettingsModal(),
      () => window.switchSettingsTab && window.switchSettingsTab('general'),
      () => window.switchSettingsTab && window.switchSettingsTab('skills'),
      () => window.switchSettingsTab && window.switchSettingsTab('mode-shuffle'),
      () => window.switchSettingsTab && window.switchSettingsTab('mode-orborus'),
      () => window.switchSettingsTab && window.switchSettingsTab('mode-direct'),
      () => window.switchSettingsTab && window.switchSettingsTab('mode-local'),
      () => window.selectAiModel && window.selectAiModel('gemini-3.8-flash', 'Gemini 3.8 Flash'),
      () => window.selectReasoningEffort && window.selectReasoningEffort('low'),
      () => window.submitPrompt && window.submitPrompt('test prompt execution'),
      () => window.stopExecution && window.stopExecution(),
      () => window.addCurrentByokModel && window.addCurrentByokModel(),
      () => window.saveDirectLlmSettings && window.saveDirectLlmSettings(),
      () => window.saveSettings && window.saveSettings(),
      () => window.loginWithOAuth && window.loginWithOAuth(),
      () => window.submitOAuthToken && window.submitOAuthToken(),
      () => window.submitOrborusAuth && window.submitOrborusAuth(),
      () => window.selectApprovalOption && window.selectApprovalOption(1),
      () => window.skipApproval && window.skipApproval(),
      () => window.submitApproval && window.submitApproval(),
      () => window.setQueuedMessageMode && window.setQueuedMessageMode('queue'),
      () => window.toggleCustomSkillForm && window.toggleCustomSkillForm(),
      () => window.rescanLocalModels && window.rescanLocalModels(),
      () => window.scanRepositories && window.scanRepositories()
    ];

    for (let i = 0; i < functionsToTest.length; i++) {
      testedFunctions++;
      try {
        await Promise.resolve(functionsToTest[i]());
      } catch (err) {
        capturedErrors.push({
          type: 'FunctionInvocationError',
          target: 'function[' + i + ']',
          message: err.message || String(err),
          stack: err.stack || ''
        });
      }
    }

    // Brief tick for async reactions
    await new Promise(r => setTimeout(r, 150));

    const totalTested = testedButtons + testedFunctions;
    fetch('/__test_report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testedButtons: testedButtons,
        testedFunctions: testedFunctions,
        totalTested: totalTested,
        errors: capturedErrors
      })
    }).catch(() => {});
  }

  if (document.readyState === 'complete') {
    setTimeout(runAllButtonTests, 100);
  } else {
    window.addEventListener('load', () => setTimeout(runAllButtonTests, 100));
  }
})();
</script>
`

	withHead := strings.Replace(html, "<head>", "<head>"+headScript, 1)
	return strings.Replace(withHead, "</body>", bodyScript+"</body>", 1)
}
