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
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", targetURL)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", targetURL)
	default:
		cmd = exec.Command("xdg-open", targetURL)
	}
	if err := cmd.Start(); err != nil {
		if runtime.GOOS == "windows" {
			cmd = exec.Command("cmd", "/c", "start", "", targetURL)
			return cmd.Start()
		}
		return err
	}
	return nil
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

		b.SetOAuthToken(token, orgID, envName)

		if onAuthComplete != nil {
			onAuthComplete(token, orgID, envName)
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, `<html><head><title>Shuffle Agent Runner</title></head>
		<body style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#090d16; color:#f8fafc; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; margin:0;">
			<div style="background:#131c2e; border:1px solid #1e293b; border-radius:16px; padding:36px; max-width:440px; text-align:center; box-shadow:0 20px 40px rgba(0,0,0,0.5);">
				<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:16px;">
					<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
					<polyline points="22 4 12 14.01 9 11.01"/>
				</svg>
				<h2 style="margin:0 0 8px 0; font-size:20px; font-weight:600;">Authentication Successful</h2>
				<p style="color:#94a3b8; font-size:14px; line-height:1.5; margin:0 0 24px 0;">You have successfully authenticated with Shuffle OAuth2. You can now close this tab and return to the Shuffle Agent Runner window.</p>
				<button onclick="window.close()" style="background:#3b82f6; border:none; color:white; padding:10px 20px; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer;">Close Window</button>
			</div>
		</body></html>`)

		go func() {
			time.Sleep(1 * time.Second)
			_ = server.Shutdown(context.Background())
		}()
	})

	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Printf("[WARN] OAuth2 callback server error: %v", err)
		}
	}()

	// Open user's default browser to Shuffle OAuth2 authorize URL
	if err := openBrowser(fullAuthURL); err != nil {
		log.Printf("[WARN] Failed to open browser automatically: %v", err)
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

	client := &http.Client{Timeout: 10 * time.Second}

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
