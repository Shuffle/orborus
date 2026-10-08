package pkg

import (
	_ "embed"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"orborus/pkg/uivalidate"
)

//go:embed ui/index.html
var EmbeddedAgentHTML string

// GetAgentHTML returns the UI HTML.
// In development mode (if pkg/ui/src/index.html exists), it dynamically compiles
// the modular CSS and JS from disk on the fly, enabling instant iteration without rebuilding Go.
// In production or packaged releases, it returns the compiled EmbeddedAgentHTML.
func GetAgentHTML() string {
	candidateDirs := []string{
		"pkg/ui/src",
		"ui/src",
	}

	for _, dir := range candidateDirs {
		if fi, err := os.Stat(filepath.Join(dir, "index.html")); err == nil && !fi.IsDir() {
			if html, err := AssembleUI(dir); err == nil && len(html) > 0 {
				return html
			}
		}
	}

	// Also check if pkg/ui/index.html exists directly on disk
	candidateFiles := []string{
		"pkg/ui/index.html",
		"ui/index.html",
	}
	for _, f := range candidateFiles {
		if fi, err := os.Stat(f); err == nil && !fi.IsDir() {
			if content, err := os.ReadFile(f); err == nil && len(content) > 0 {
				return string(content)
			}
		}
	}

	return EmbeddedAgentHTML
}

// AssembleUI combines index.html, modular css/*.css, and modular js/*.js
func AssembleUI(srcDir string) (string, error) {
	// Validate UI integrity to catch syntax errors, unclosed delimiters, and missing button handlers early
	valErrs := uivalidate.ValidateEntireUI(srcDir)
	if len(valErrs) > 0 {
		for _, vErr := range valErrs {
			log.Printf("[UI-VALIDATION-ERROR] %s", vErr)
		}
	}

	skeletonRaw, err := os.ReadFile(filepath.Join(srcDir, "index.html"))
	if err != nil {
		return "", err
	}
	skeleton := string(skeletonRaw)

	// Defined CSS load order
	cssFiles := []string{
		"variables.css",
		"base.css",
		"sidebar.css",
		"chat.css",
		"modals.css",
	}

	var cssBuilder strings.Builder
	for _, f := range cssFiles {
		p := filepath.Join(srcDir, "css", f)
		c, err := os.ReadFile(p)
		if err != nil {
			return "", fmt.Errorf("failed to read css %s: %w", p, err)
		}
		cssBuilder.WriteString(fmt.Sprintf("\n/* --- %s --- */\n", f))
		cssBuilder.Write(c)
		cssBuilder.WriteString("\n")
	}

	// Defined JS load order
	jsFiles := []string{
		"state.js",
		"titlebar.js",
		"sidebar.js",
		"settings.js",
		"history.js",
		"chat.js",
		"approvals.js",
		"app.js",
	}

	var jsBuilder strings.Builder
	for _, f := range jsFiles {
		p := filepath.Join(srcDir, "js", f)
		c, err := os.ReadFile(p)
		if err != nil {
			return "", fmt.Errorf("failed to read js %s: %w", p, err)
		}
		jsBuilder.WriteString(fmt.Sprintf("\n// --- %s ---\n", f))
		jsBuilder.Write(c)
		jsBuilder.WriteString("\n")
	}

	out := strings.Replace(skeleton, "/* {{INLINE_CSS}} */", cssBuilder.String(), 1)
	out = strings.Replace(out, "// {{INLINE_JS}}", jsBuilder.String(), 1)

	return out, nil
}
