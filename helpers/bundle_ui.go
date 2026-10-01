package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	srcDir := "pkg/ui/src"
	destFile := "pkg/ui/index.html"

	assembled, err := AssembleUI(srcDir)
	if err != nil {
		log.Fatalf("AssembleUI failed: %v", err)
	}

	if err := os.WriteFile(destFile, []byte(assembled), 0644); err != nil {
		log.Fatalf("Failed to write %s: %v", destFile, err)
	}

	fmt.Printf("Successfully bundled %s into %s (%d bytes)\n", srcDir, destFile, len(assembled))
}

// AssembleUI combines src/index.html, src/css/*.css, and src/js/*.js
func AssembleUI(srcDir string) (string, error) {
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
