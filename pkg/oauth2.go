package pkg

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"sync/atomic"
	"time"
)

// DynamicOAuthSession holds the in-flight OAuth2 PKCE state
type DynamicOAuthSession struct {
	ClientID     string
	CodeVerifier string
	State        string
	RedirectURI  string
	Resource     string
	Scope        string
	Server       *http.Server
	Listener     net.Listener
	AuthURL      string
}

// GeneratePKCE generates a code_verifier and code_challenge using SHA-256 (S256)
func GeneratePKCE() (verifier string, challenge string, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", "", err
	}
	verifier = base64.RawURLEncoding.EncodeToString(b)
	h := sha256.Sum256([]byte(verifier))
	challenge = base64.RawURLEncoding.EncodeToString(h[:])
	return verifier, challenge, nil
}

// generateRandomHex generates a random hex string of given length
func generateRandomHex(byteCount int) string {
	b := make([]byte, byteCount)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// openBrowser opens the specified URL in the user's default browser cross-platform
func openBrowser(targetURL string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", targetURL).Start()
	case "windows":
		// url.dll,FileProtocolHandler silently fails or truncates URLs longer than ~256 chars (MAX_PATH).
		// For short clean URLs (such as our local http://127.0.0.1:<port>/login redirector), rundll32 works
		// without flashing a console window. For long URLs with query parameters, use PowerShell Start-Process.
		if len(targetURL) < 200 && !strings.Contains(targetURL, "&") {
			if err := exec.Command("rundll32", "url.dll,FileProtocolHandler", targetURL).Start(); err == nil {
				return nil
			}
			if err := exec.Command("cmd", "/c", "start", "", targetURL).Start(); err == nil {
				return nil
			}
		}
		escaped := strings.ReplaceAll(targetURL, "'", "''")
		psCmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", fmt.Sprintf("Start-Process '%s'", escaped))
		if err := psCmd.Start(); err == nil {
			return nil
		}
		escapedCmd := strings.ReplaceAll(targetURL, "&", "^&")
		return exec.Command("cmd", "/c", "start", "", escapedCmd).Start()
	default:
		return exec.Command("xdg-open", targetURL).Start()
	}
}

// StartDynamicOAuth2Flow initializes the dynamic auth flow matching ChatGPT MCP logins
func (b *AgentBridge) StartDynamicOAuth2Flow(customBaseURL string, onAuthComplete func(token, orgID, env string)) (string, error) {
	verifier, challenge, err := GeneratePKCE()
	if err != nil {
		return "", fmt.Errorf("failed to generate PKCE: %v", err)
	}

	state := fmt.Sprintf("oauth_s_%s", generateRandomHex(16))
	clientID := fmt.Sprintf("shuffle_client_%s", generateRandomHex(16))
	scope := "workflow:edit mcp:execute"
	resource := "https://tunnel.schemaless.org/api/v1/agent/workflow-edit"

	// Start local loopback listener on random available port
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", fmt.Errorf("failed to bind loopback listener: %v", err)
	}
	tcpAddr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		listener.Close()
		return "", fmt.Errorf("unexpected listener address type: %T", listener.Addr())
	}
	port := tcpAddr.Port
	redirectURI := fmt.Sprintf("http://127.0.0.1:%d/callback", port)
	log.Printf("[INFO] Started local OAuth2 loopback callback server on %s", redirectURI)

	// Determine OAuth endpoint: default to https://shuffle.security
	oauthHost := "https://shuffle.security"
	if customBaseURL != "" && !strings.Contains(customBaseURL, "shuffler.io") {
		oauthHost = strings.TrimRight(customBaseURL, "/")
	}

	authEndpoint := fmt.Sprintf("%s/oauth2/authorize", oauthHost)

	// Construct dynamic auth URL matching ChatGPT MCP login specification
	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", clientID)
	q.Set("client_name", "Shuffle Agent")
	q.Set("app_name", "Shuffle Agent")
	q.Set("redirect_uri", redirectURI)
	q.Set("scope", scope)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	q.Set("resource", resource)
	q.Set("state", state)
	q.Set("ui_locales", "en-US")

	fullAuthURL := fmt.Sprintf("%s?%s", authEndpoint, q.Encode())
	log.Printf("[INFO] Initiating Shuffle OAuth2 dynamic auth redirect: %s", fullAuthURL)

	session := &DynamicOAuthSession{
		ClientID:     clientID,
		CodeVerifier: verifier,
		State:        state,
		RedirectURI:  redirectURI,
		Resource:     resource,
		Scope:        scope,
		Listener:     listener,
		AuthURL:      fullAuthURL,
	}

	mux := http.NewServeMux()
	server := &http.Server{
		Handler:      mux,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
	}
	session.Server = server

	b.mu.Lock()
	if b.activeOAuthSession != nil && b.activeOAuthSession.Server != nil {
		_ = b.activeOAuthSession.Server.Close()
	}
	b.activeOAuthSession = session
	b.mu.Unlock()

	var loginConnected int32
	loginRedirectURI := fmt.Sprintf("http://127.0.0.1:%d/login", port)
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		atomic.StoreInt32(&loginConnected, 1)
		log.Printf("[INFO] Browser connected to local OAuth2 /login redirector, redirecting to Shuffle OAuth2")
		http.Redirect(w, r, fullAuthURL, http.StatusFound)
	})

	mux.HandleFunc("/done", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"ok"}`)

		// Bring the runner window to foreground
		b.mu.Lock()
		cb := b.onAuthUpdated
		b.mu.Unlock()
		if cb != nil {
			cb(b.GetInitialState())
		}

		go func() {
			time.Sleep(3 * time.Second)
			_ = server.Shutdown(context.Background())
		}()
	})

	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		retState := q.Get("state")
		errParam := q.Get("error")
		errDesc := q.Get("error_description")

		if errParam != "" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusUnauthorized)
			fmt.Fprintf(w, `<html><body style="font-family:system-ui; background:#0f172a; color:#f87171; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; margin:0;">
				<h2 style="margin-bottom:8px;">Authentication Denied</h2>
				<p style="color:#94a3b8;">%s</p>
			</body></html>`, errDesc)
			go func() {
				time.Sleep(1 * time.Second)
				_ = server.Shutdown(context.Background())
			}()
			return
		}

		if retState != session.State {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, "Invalid OAuth state parameter")
			return
		}

		code := q.Get("code")
		if code == "" {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, "Missing authorization code")
			return
		}

		log.Printf("[INFO] Received OAuth2 authorization code: %s", code)

		// Exchange code for token with backend
		token, orgID, envName := exchangeCodeForToken(oauthHost, code, session.ClientID, session.RedirectURI, session.CodeVerifier)

		if token == "" {
			// Fallback: use authorization code directly if exchange endpoint is waiting
			token = code
		}

		b.mu.Lock()
		if b.cfg != nil {
			b.cfg.BaseURL = resolveShuffleAiBaseURL(b.cfg.BaseURL)
		}
		b.mu.Unlock()
		b.SetOAuthToken(token, orgID, envName)

		if onAuthComplete != nil {
			onAuthComplete(token, orgID, envName)
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Authentication Successful — Shuffle</title></head>
<body style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background:#0b0f17; color:#e2e8f0; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; margin:0; padding:20px; box-sizing:border-box;">
	<div style="background:#12161f; border:1px solid rgba(255,255,255,0.08); border-radius:14px; padding:36px; max-width:440px; width:100%; text-align:center; box-shadow:0 18px 36px rgba(0,0,0,0.45);">
		<div style="width:44px; height:44px; margin:0 auto 16px auto; border-radius:50%; background:rgba(34, 197, 94, 0.1); border:1px solid rgba(34, 197, 94, 0.25); display:flex; align-items:center; justify-content:center;">
			<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
				<polyline points="20 6 9 17 4 12"/>
			</svg>
		</div>
		<h2 style="margin:0 0 10px 0; font-size:19px; font-weight:600; color:#f8fafc; letter-spacing:-0.01em;">Authentication Successful</h2>
		<p style="color:#94a3b8; font-size:13px; line-height:1.55; margin:0 0 20px 0;">
			Your Shuffle OAuth2 session has been transferred to the Shuffle Agent Runner window. Shuffle AI models and cloud sync are now active.
		</p>
		<button id="btn-close" onclick="tryClose()" style="background:#2563eb; border:none; color:white; padding:9px 24px; border-radius:7px; font-size:13px; font-weight:500; cursor:pointer; transition:all 0.15s ease;">Close Window</button>
		<div id="close-guide" style="display:none; margin-top:16px; padding:10px 14px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:8px; font-size:12px; color:#94a3b8; line-height:1.45;">
			Shuffle Tendon is ready. You can safely close this tab or press <kbd id="shortcut-key" style="background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.15); border-radius:4px; padding:2px 6px; font-family:inherit; color:#f8fafc; font-size:11px;">Ctrl+W</kbd>.
		</div>
		<p id="close-note" style="color:#64748b; font-size:11px; margin:14px 0 0 0; line-height:1.4;">
			If your browser prevents closing this tab automatically, you can safely close it and switch back to the runner window.
		</p>
	</div>
	<script>
		var closedState = false;
		var isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform || '');
		var shortcut = isMac ? '⌘+W' : 'Ctrl+W';
		var kbd = document.getElementById('shortcut-key');
		if (kbd) kbd.innerText = shortcut;

		function tryClose() {
			try {
				fetch('/done', { method: 'POST', mode: 'no-cors' }).catch(function(){});
			} catch(e) {}

			try { window.close(); } catch(e) {}
			try { self.close(); } catch(e) {}
			try { window.top.close(); } catch(e) {}
			try {
				if (window.opener) { window.opener = null; }
				window.open('', '_self', '');
				window.close();
			} catch(e) {}

			if (closedState) {
				try { window.location.replace("about:blank"); } catch(e) {}
				return;
			}
			closedState = true;

			var btn = document.getElementById('btn-close');
			if (btn) {
				btn.innerHTML = '&#10003; All Set &mdash; Close Tab (' + shortcut + ')';
				btn.style.background = 'rgba(255, 255, 255, 0.08)';
				btn.style.color = '#cbd5e1';
				btn.style.border = '1px solid rgba(255, 255, 255, 0.15)';
			}
			var guide = document.getElementById('close-guide');
			if (guide) guide.style.display = 'block';
			var note = document.getElementById('close-note');
			if (note) note.style.display = 'none';
		}

		// Attempt auto-close after 1.5 seconds if browser allows
		setTimeout(function() {
			try { window.close(); } catch(e) {}
		}, 1500);
	</script>
</body></html>`)

		go func() {
			// Keep server alive for 60 seconds to allow user interaction with the page and /done callback
			time.Sleep(60 * time.Second)
			_ = server.Shutdown(context.Background())
		}()
	})

	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Printf("[WARN] OAuth2 callback server error: %v", err)
		}
	}()

	// Open user's default browser via short local redirect URI (avoids Windows MAX_PATH truncation & query escaping issues)
	if err := openBrowser(loginRedirectURI); err != nil {
		log.Printf("[WARN] Failed to open browser automatically via primary launcher: %v", err)
	}

	if runtime.GOOS == "windows" {
		go func(redirectURL string) {
			time.Sleep(900 * time.Millisecond)
			if atomic.LoadInt32(&loginConnected) == 0 {
				log.Printf("[INFO] Browser has not hit /login after 900ms; attempting Windows cmd start fallback for %s", redirectURL)
				_ = exec.Command("cmd", "/c", "start", "", redirectURL).Start()
			}
			time.Sleep(1100 * time.Millisecond)
			if atomic.LoadInt32(&loginConnected) == 0 {
				log.Printf("[INFO] Browser has not hit /login after 2000ms; attempting PowerShell Start-Process fallback for %s", redirectURL)
				_ = exec.Command("powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", fmt.Sprintf("Start-Process '%s'", redirectURL)).Start()
			}
		}(loginRedirectURI)
	}

	return fullAuthURL, nil
}

// exchangeCodeForToken executes the standard OAuth2 authorization_code token exchange
func exchangeCodeForToken(oauthHost, code, clientID, redirectURI, codeVerifier string) (string, string, string) {
	endpoints := []string{
		fmt.Sprintf("%s/api/v1/oauth2/token", oauthHost),
		fmt.Sprintf("%s/oauth2/token", oauthHost),
	}

	formData := url.Values{}
	formData.Set("grant_type", "authorization_code")
	formData.Set("code", code)
	formData.Set("client_id", clientID)
	formData.Set("redirect_uri", redirectURI)
	formData.Set("code_verifier", codeVerifier)

	client := &http.Client{Timeout: 30 * time.Second}

	for _, tokenURL := range endpoints {
		log.Printf("[INFO] Exchanging OAuth2 code with %s", tokenURL)
		req, err := http.NewRequest("POST", tokenURL, strings.NewReader(formData.Encode()))
		if err != nil {
			continue
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

		resp, err := client.Do(req)
		if err != nil {
			log.Printf("[DEBUG] Token exchange request failed: %v", err)
			continue
		}
		defer resp.Body.Close()

		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode == http.StatusOK {
			var parsed struct {
				AccessToken  string `json:"access_token"`
				RefreshToken string `json:"refresh_token"`
				OrgID        string `json:"org_id"`
				Org          string `json:"org"`
				Environment  string `json:"environment"`
			}
			if err := json.Unmarshal(body, &parsed); err == nil && parsed.AccessToken != "" {
				org := parsed.OrgID
				if org == "" {
					org = parsed.Org
				}
				log.Printf("[INFO] OAuth2 token exchange successful! Token prefix: %s", parsed.AccessToken[:min(len(parsed.AccessToken), 12)])
				return parsed.AccessToken, org, parsed.Environment
			}
		} else {
			log.Printf("[DEBUG] Token exchange returned %d: %s", resp.StatusCode, string(body))
		}
	}

	return "", "", ""
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
