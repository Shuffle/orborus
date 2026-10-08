package pkg

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	// DefaultTendonVersion is the initial default release version for Tendon.
	DefaultTendonVersion = "0.0.1"

	// TendonGitHubRepo is the upstream repository hosting Tendon releases.
	TendonGitHubRepo = "Shuffle/tendon"
)

// TendonReleaseAsset represents a GitHub release asset metadata.
type TendonReleaseAsset struct {
	Name               string `json:"name"`
	Size               int64  `json:"size"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

// TendonReleaseInfo represents a GitHub release payload.
type TendonReleaseInfo struct {
	TagName string               `json:"tag_name"`
	Name    string               `json:"name"`
	HTMLURL string               `json:"html_url"`
	Assets  []TendonReleaseAsset `json:"assets"`
}

// GetTendonVersion returns the active or default Tendon version (e.g. "0.0.1").
func GetTendonVersion() string {
	if v := strings.TrimSpace(os.Getenv("SHUFFLE_TENDON_VERSION")); v != "" {
		return strings.TrimPrefix(v, "v")
	}
	if v := strings.TrimSpace(os.Getenv("TENDON_VERSION")); v != "" {
		return strings.TrimPrefix(v, "v")
	}
	return DefaultTendonVersion
}

// GetTendonReleaseTag returns the release tag format for GitHub (e.g. "v0.0.1").
func GetTendonReleaseTag(version string) string {
	v := strings.TrimSpace(version)
	if v == "" {
		v = GetTendonVersion()
	}
	v = strings.TrimPrefix(v, "v")
	return "v" + v
}

// GetTendonReleaseURL returns the web URL to the GitHub release page.
func GetTendonReleaseURL(version string) string {
	tag := GetTendonReleaseTag(version)
	return fmt.Sprintf("https://github.com/%s/releases/tag/%s", TendonGitHubRepo, tag)
}

// GetTendonDownloadBaseURL returns the direct asset download base URL.
func GetTendonDownloadBaseURL(version string) string {
	tag := GetTendonReleaseTag(version)
	return fmt.Sprintf("https://github.com/%s/releases/download/%s", TendonGitHubRepo, tag)
}

// GetTendonDir returns the local cache directory for Tendon binaries and assets.
func GetTendonDir(version string) string {
	tag := GetTendonReleaseTag(version)
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = "."
	}
	return filepath.Join(home, ".shuffle", "tendon", tag)
}

// GetTendonBinaryName returns the expected binary filename for the current platform.
func GetTendonBinaryName() string {
	if runtime.GOOS == "windows" {
		return "llama-server.exe"
	}
	return "llama-server"
}

// FindOrFetchTendonBinary locates the local Tendon engine binary (e.g. llama-server.exe)
// or attempts to download it from the specified release.
func FindOrFetchTendonBinary(version string) (string, error) {
	if version == "" {
		version = GetTendonVersion()
	}

	// 1. Direct explicit environment override
	if env := os.Getenv("TENDON_CUDA_PATH"); env != "" {
		if fi, err := os.Stat(env); err == nil && !fi.IsDir() {
			return env, nil
		}
	}
	if env := os.Getenv("LOCAL_EXECUTOR_BIN"); env != "" {
		if fi, err := os.Stat(env); err == nil && !fi.IsDir() {
			_ = os.Setenv("TENDON_CUDA_PATH", env)
			return env, nil
		}
	}

	binName := GetTendonBinaryName()
	cacheDir := GetTendonDir(version)

	// 2. Local candidate search paths
	candidates := []string{
		filepath.Join("bin", "cuda", binName),
		filepath.Join("bin", "tendon", binName),
		filepath.Join(cacheDir, binName),
		binName,
	}

	// Executable relative path
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(exeDir, "bin", "cuda", binName),
			filepath.Join(exeDir, "bin", "tendon", binName),
			filepath.Join(exeDir, binName),
		)
	}

	// User workspace / well-known paths
	userProfile := os.Getenv("USERPROFILE")
	if userProfile == "" {
		userProfile, _ = os.UserHomeDir()
	}
	if userProfile != "" {
		candidates = append(candidates,
			filepath.Join(userProfile, ".shuffle", "tendon", GetTendonReleaseTag(version), binName),
			filepath.Join(userProfile, ".shuffle", "bin", binName),
			filepath.Join(userProfile, "Documents", "antigravity", "delightful-mendeleev", "bin", "cuda", binName),
			filepath.Join(userProfile, "delightful-mendeleev", "bin", "cuda", binName),
			filepath.Join(userProfile, ".gemini", "antigravity", "scratch", "delightful-mendeleev", "bin", "cuda", binName),
			filepath.Join("..", "delightful-mendeleev", "bin", "cuda", binName),
		)
	}

	for _, cand := range candidates {
		if cand == "" {
			continue
		}
		if fi, err := os.Stat(cand); err == nil && !fi.IsDir() {
			abs, errAbs := filepath.Abs(cand)
			if errAbs == nil {
				cand = abs
			}
			log.Printf("[INFO] Discovered Tendon engine binary at: %s (version: %s)", cand, version)
			_ = os.Setenv("TENDON_CUDA_PATH", cand)
			return cand, nil
		}
	}

	// 3. Attempt to download from GitHub release if not found locally
	tag := GetTendonReleaseTag(version)
	log.Printf("[INFO] Tendon engine binary not found locally. Checking GitHub release %s...", tag)
	downloadedPath, err := fetchTendonReleaseAsset(version, cacheDir, binName)
	if err == nil && downloadedPath != "" {
		log.Printf("[INFO] Successfully fetched Tendon %s binary: %s", tag, downloadedPath)
		_ = os.Setenv("TENDON_CUDA_PATH", downloadedPath)
		return downloadedPath, nil
	}

	releaseURL := GetTendonReleaseURL(version)
	log.Printf("[WARNING] Tendon binary could not be automatically downloaded from %s (%v). Please ensure a native binary is placed in bin/cuda/%s or set TENDON_CUDA_PATH.", releaseURL, err, binName)

	return "", fmt.Errorf("tendon binary %s not found locally and release %s has no compatible binary asset: %w", binName, releaseURL, err)
}

// fetchTendonReleaseAsset queries the GitHub release API and downloads any matching platform asset.
func fetchTendonReleaseAsset(version, targetDir, binName string) (string, error) {
	tag := GetTendonReleaseTag(version)
	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/releases/tags/%s", TendonGitHubRepo, tag)

	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequest("GET", apiURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Shuffle-Orborus-Agent")
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to reach GitHub release API: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GitHub release API returned status %d for %s", resp.StatusCode, tag)
	}

	var rel TendonReleaseInfo
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return "", fmt.Errorf("failed to parse release info: %w", err)
	}

	if len(rel.Assets) == 0 {
		return "", fmt.Errorf("release %s has no uploaded binary assets yet", tag)
	}

	// Match asset for platform
	osName := runtime.GOOS
	archName := runtime.GOARCH

	var matchingAsset *TendonReleaseAsset
	for _, asset := range rel.Assets {
		lower := strings.ToLower(asset.Name)
		if strings.Contains(lower, osName) && (strings.Contains(lower, archName) || strings.Contains(lower, "x64") || strings.Contains(lower, "64")) {
			matchingAsset = &asset
			break
		}
	}

	// Fallback to any zip or tar.gz if only 1 asset exists
	if matchingAsset == nil && len(rel.Assets) == 1 {
		matchingAsset = &rel.Assets[0]
	}

	if matchingAsset == nil {
		return "", fmt.Errorf("no asset matching OS %s and arch %s in release %s", osName, archName, tag)
	}

	_ = os.MkdirAll(targetDir, 0755)
	tmpFile := filepath.Join(targetDir, matchingAsset.Name)

	log.Printf("[INFO] Downloading Tendon asset %s from %s...", matchingAsset.Name, matchingAsset.BrowserDownloadURL)
	downReq, _ := http.NewRequest("GET", matchingAsset.BrowserDownloadURL, nil)
	downReq.Header.Set("User-Agent", "Shuffle-Orborus-Agent")
	downResp, err := client.Do(downReq)
	if err != nil {
		return "", fmt.Errorf("failed to download asset: %w", err)
	}
	defer downResp.Body.Close()

	out, err := os.Create(tmpFile)
	if err != nil {
		return "", err
	}
	_, err = io.Copy(out, downResp.Body)
	out.Close()
	if err != nil {
		return "", err
	}

	// If zip, extract binary
	if strings.HasSuffix(strings.ToLower(tmpFile), ".zip") {
		extracted, errExtract := extractZipBinary(tmpFile, targetDir, binName)
		if errExtract == nil && extracted != "" {
			_ = os.Remove(tmpFile)
			return extracted, nil
		}
	}

	// If direct binary executable
	if strings.EqualFold(filepath.Base(tmpFile), binName) {
		_ = os.Chmod(tmpFile, 0755)
		return tmpFile, nil
	}

	targetPath := filepath.Join(targetDir, binName)
	if _, err := os.Stat(targetPath); err == nil {
		return targetPath, nil
	}

	return tmpFile, nil
}

func extractZipBinary(zipPath, destDir, targetName string) (string, error) {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return "", err
	}
	defer r.Close()

	for _, f := range r.File {
		if strings.EqualFold(filepath.Base(f.Name), targetName) {
			rc, err := f.Open()
			if err != nil {
				return "", err
			}
			defer rc.Close()

			destPath := filepath.Join(destDir, targetName)
			outFile, err := os.OpenFile(destPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0755)
			if err != nil {
				return "", err
			}
			defer outFile.Close()

			if _, err := io.Copy(outFile, rc); err != nil {
				return "", err
			}
			return destPath, nil
		}
	}
	return "", fmt.Errorf("binary %s not found inside %s", targetName, zipPath)
}
