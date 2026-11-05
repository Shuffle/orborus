package pkg

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/disk"
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

// LocalModelSpec defines a downloadable GGUF model weight in the Local Models catalog.
type LocalModelSpec struct {
	Key         string   `json:"key"`
	Label       string   `json:"label"`
	Family      string   `json:"family"`
	FamilyLabel string   `json:"family_label"`
	ParamSize   string   `json:"param_size"`
	Filename    string   `json:"filename"`
	Aliases     []string `json:"aliases,omitempty"`
	DownloadURL string   `json:"download_url"`
	SizeBytes   int64    `json:"size_bytes"`
	SizeGB      float64  `json:"size_gb"`
	SizeDisplay string   `json:"size_display"`
	ReqRamGB    float64  `json:"req_ram_gb"`
}

// LocalModelSafetyBufferBytes reserves 512 MB of extra disk space beyond the model weight.
const LocalModelSafetyBufferBytes int64 = 512 * 1024 * 1024

// DefaultLocalModelCatalog lists all built-in multi-choice local GGUF models (Gemma, Llama, Qwen).
var DefaultLocalModelCatalog = []LocalModelSpec{
	// Gemma family
	{
		Key:         "local-gemma-2-2b",
		Label:       "Gemma 2 2B",
		Family:      "gemma",
		FamilyLabel: "Gemma",
		ParamSize:   "2B",
		Filename:    "gemma-2-2b-it-Q4_K_M.gguf",
		Aliases:     []string{"gemma-2-2b"},
		DownloadURL: "https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-Q4_K_M.gguf",
		SizeBytes:   1708510976,
		SizeGB:      1.6,
		SizeDisplay: "1.6 GB",
		ReqRamGB:    2.5,
	},
	{
		Key:         "local-gemma-3-4b",
		Label:       "Gemma 3 4B",
		Family:      "gemma",
		FamilyLabel: "Gemma",
		ParamSize:   "4B",
		Filename:    "gemma-3-4b-it-Q4_K_M.gguf",
		Aliases:     []string{"gemma-3-4b"},
		DownloadURL: "https://huggingface.co/bartowski/google_gemma-3-4b-it-GGUF/resolve/main/google_gemma-3-4b-it-Q4_K_M.gguf",
		SizeBytes:   2684354560,
		SizeGB:      2.5,
		SizeDisplay: "2.5 GB",
		ReqRamGB:    3.5,
	},
	{
		Key:         "local-gemma-2-9b",
		Label:       "Gemma 2 9B",
		Family:      "gemma",
		FamilyLabel: "Gemma",
		ParamSize:   "9B",
		Filename:    "gemma-2-9b-it-Q4_K_M.gguf",
		Aliases:     []string{"gemma-2-9b"},
		DownloadURL: "https://huggingface.co/bartowski/gemma-2-9b-it-GGUF/resolve/main/gemma-2-9b-it-Q4_K_M.gguf",
		SizeBytes:   5765977984,
		SizeGB:      5.4,
		SizeDisplay: "5.4 GB",
		ReqRamGB:    6.5,
	},
	{
		Key:         "local-gemma-3-12b",
		Label:       "Gemma 3 12B",
		Family:      "gemma",
		FamilyLabel: "Gemma",
		ParamSize:   "12B",
		Filename:    "gemma-3-12b-it-Q4_K_M.gguf",
		Aliases:     []string{"gemma-3-12b"},
		DownloadURL: "https://huggingface.co/bartowski/google_gemma-3-12b-it-GGUF/resolve/main/google_gemma-3-12b-it-Q4_K_M.gguf",
		SizeBytes:   7838315315,
		SizeGB:      7.3,
		SizeDisplay: "7.3 GB",
		ReqRamGB:    8.5,
	},
	{
		Key:         "tendon-local",
		Label:       "Gemma 4 26B",
		Family:      "gemma",
		FamilyLabel: "Gemma",
		ParamSize:   "26B",
		Filename:    "gemma-4-26B-A4B-it-UD-Q4_K_M.gguf",
		Aliases:     []string{"gemma-4-26b", "gemma-3-27b-it-Q4_K_M.gguf"},
		DownloadURL: "https://huggingface.co/unsloth/gemma-3-27b-it-GGUF/resolve/main/gemma-3-27b-it-Q4_K_M.gguf",
		SizeBytes:   16642998272,
		SizeGB:      15.5,
		SizeDisplay: "15.5 GB",
		ReqRamGB:    16.0,
	},
	{
		Key:         "local-gemma-2-27b",
		Label:       "Gemma 2 27B",
		Family:      "gemma",
		FamilyLabel: "Gemma",
		ParamSize:   "27B",
		Filename:    "gemma-2-27b-it-Q4_K_M.gguf",
		Aliases:     []string{"gemma-2-27b"},
		DownloadURL: "https://huggingface.co/bartowski/gemma-2-27b-it-GGUF/resolve/main/gemma-2-27b-it-Q4_K_M.gguf",
		SizeBytes:   17824115712,
		SizeGB:      16.6,
		SizeDisplay: "16.6 GB",
		ReqRamGB:    18.0,
	},

	// Llama family
	{
		Key:         "local-llama-3.2-1b",
		Label:       "Llama 3.2 1B",
		Family:      "llama",
		FamilyLabel: "Llama",
		ParamSize:   "1B",
		Filename:    "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
		Aliases:     []string{"llama-3.2-1b"},
		DownloadURL: "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf",
		SizeBytes:   807657472,
		SizeGB:      0.8,
		SizeDisplay: "0.8 GB",
		ReqRamGB:    1.5,
	},
	{
		Key:         "local-llama-3.2-3b",
		Label:       "Llama 3.2 3B",
		Family:      "llama",
		FamilyLabel: "Llama",
		ParamSize:   "3B",
		Filename:    "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
		Aliases:     []string{"llama-3.2-3b"},
		DownloadURL: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
		SizeBytes:   2019377152,
		SizeGB:      1.9,
		SizeDisplay: "1.9 GB",
		ReqRamGB:    2.8,
	},
	{
		Key:         "local-llama-3.1-8b",
		Label:       "Llama 3.1 8B",
		Family:      "llama",
		FamilyLabel: "Llama",
		ParamSize:   "8B",
		Filename:    "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
		Aliases:     []string{"llama-3.1-8b", "Llama-3.1-8B-Instruct-Q4_K_M.gguf"},
		DownloadURL: "https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
		SizeBytes:   4920739840,
		SizeGB:      4.6,
		SizeDisplay: "4.6 GB",
		ReqRamGB:    5.5,
	},
	{
		Key:         "local-llama-3.3-70b",
		Label:       "Llama 3.3 70B",
		Family:      "llama",
		FamilyLabel: "Llama",
		ParamSize:   "70B",
		Filename:    "Llama-3.3-70B-Instruct-Q4_K_M.gguf",
		Aliases:     []string{"llama-3.3-70b"},
		DownloadURL: "https://huggingface.co/bartowski/Llama-3.3-70B-Instruct-GGUF/resolve/main/Llama-3.3-70B-Instruct-Q4_K_M.gguf",
		SizeBytes:   42520176230,
		SizeGB:      39.6,
		SizeDisplay: "39.6 GB",
		ReqRamGB:    42.0,
	},

	// Qwen family
	{
		Key:         "local-qwen-2.5-3b",
		Label:       "Qwen 2.5 3B",
		Family:      "qwen",
		FamilyLabel: "Qwen",
		ParamSize:   "3B",
		Filename:    "Qwen2.5-3B-Instruct-Q4_K_M.gguf",
		Aliases:     []string{"qwen-2.5-3b", "qwen2.5-3b"},
		DownloadURL: "https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf",
		SizeBytes:   2104533975,
		SizeGB:      2.0,
		SizeDisplay: "2.0 GB",
		ReqRamGB:    2.8,
	},
	{
		Key:         "local-qwen-2.5-coder-7b",
		Label:       "Qwen 2.5 Coder 7B",
		Family:      "qwen",
		FamilyLabel: "Qwen",
		ParamSize:   "7B",
		Filename:    "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
		Aliases:     []string{"qwen-2.5-coder-7b", "qwen2.5-coder-7b"},
		DownloadURL: "https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
		SizeBytes:   4683073945,
		SizeGB:      4.4,
		SizeDisplay: "4.4 GB",
		ReqRamGB:    5.5,
	},
	{
		Key:         "local-qwen-2.5-coder-14b",
		Label:       "Qwen 2.5 Coder 14B",
		Family:      "qwen",
		FamilyLabel: "Qwen",
		ParamSize:   "14B",
		Filename:    "Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf",
		Aliases:     []string{"qwen-2.5-coder-14b", "qwen2.5-coder-14b"},
		DownloadURL: "https://huggingface.co/bartowski/Qwen2.5-Coder-14B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf",
		SizeBytes:   8988116582,
		SizeGB:      8.4,
		SizeDisplay: "8.4 GB",
		ReqRamGB:    10.0,
	},
	{
		Key:         "local-qwen-2.5-coder-32b",
		Label:       "Qwen 2.5 Coder 32B",
		Family:      "qwen",
		FamilyLabel: "Qwen",
		ParamSize:   "32B",
		Filename:    "Qwen2.5-Coder-32B-Instruct-Q4_K_M.gguf",
		Aliases:     []string{"qwen-2.5-coder-32b", "qwen2.5-coder-32b"},
		DownloadURL: "https://huggingface.co/bartowski/Qwen2.5-Coder-32B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-32B-Instruct-Q4_K_M.gguf",
		SizeBytes:   19852580454,
		SizeGB:      18.5,
		SizeDisplay: "18.5 GB",
		ReqRamGB:    20.0,
	},
}

// GetLocalModelCatalog returns a copy of the built-in local model specifications.
func GetLocalModelCatalog() []LocalModelSpec {
	out := make([]LocalModelSpec, len(DefaultLocalModelCatalog))
	copy(out, DefaultLocalModelCatalog)
	return out
}

// GetLocalModelSpec looks up a local model specification by model key or filename.
func GetLocalModelSpec(keyOrFilename string) *LocalModelSpec {
	clean := strings.TrimSpace(keyOrFilename)
	if clean == "" {
		return nil
	}
	lower := strings.ToLower(clean)
	base := strings.ToLower(filepath.Base(clean))

	for i := range DefaultLocalModelCatalog {
		spec := &DefaultLocalModelCatalog[i]
		if strings.ToLower(spec.Key) == lower || strings.ToLower(spec.Filename) == lower || strings.ToLower(spec.Filename) == base {
			copySpec := *spec
			return &copySpec
		}
		for _, alias := range spec.Aliases {
			if strings.ToLower(alias) == lower || strings.ToLower(alias) == base {
				copySpec := *spec
				return &copySpec
			}
		}
	}
	return nil
}

// IsLocalModelKey returns true if the given model identifier belongs to the local model catalog or starts with "local-".
func IsLocalModelKey(modelKey string) bool {
	m := strings.TrimSpace(strings.ToLower(modelKey))
	return m == "tendon-local" || strings.HasPrefix(m, "local-") || GetLocalModelSpec(m) != nil
}

// DiskSpaceInfo represents the available and total disk space for a target directory.
type DiskSpaceInfo struct {
	Path        string  `json:"path"`
	FreeBytes   uint64  `json:"free_bytes"`
	TotalBytes  uint64  `json:"total_bytes"`
	FreeGB      float64 `json:"free_gb"`
	TotalGB     float64 `json:"total_gb"`
	FreeDisplay string  `json:"free_display"`
}

// GetDiskSpaceInfo returns the free and total disk space for the filesystem hosting dir.
func GetDiskSpaceInfo(dir string) DiskSpaceInfo {
	target := strings.TrimSpace(dir)
	if target == "" {
		target = "./models"
	}
	abs, err := filepath.Abs(target)
	if err == nil {
		target = abs
	}

	// Walk up to an existing parent directory so disk.Usage succeeds even if models/ isn't created yet.
	probe := target
	for {
		if fi, err := os.Stat(probe); err == nil && fi != nil {
			if !fi.IsDir() {
				probe = filepath.Dir(probe)
			}
			break
		}
		parent := filepath.Dir(probe)
		if parent == probe || parent == "" {
			probe = "."
			break
		}
		probe = parent
	}

	usage, err := disk.Usage(probe)
	if err != nil || usage == nil {
		return DiskSpaceInfo{
			Path:        target,
			FreeBytes:   0,
			TotalBytes:  0,
			FreeGB:      0,
			TotalGB:     0,
			FreeDisplay: "Unknown",
		}
	}

	freeGB := math.Round((float64(usage.Free)/(1024*1024*1024))*10) / 10
	totalGB := math.Round((float64(usage.Total)/(1024*1024*1024))*10) / 10
	return DiskSpaceInfo{
		Path:        target,
		FreeBytes:   usage.Free,
		TotalBytes:  usage.Total,
		FreeGB:      freeGB,
		TotalGB:     totalGB,
		FreeDisplay: fmt.Sprintf("%.1f GB", freeGB),
	}
}

// CheckDiskSpaceForModel verifies that the target directory has enough free disk space for requiredBytes + safety buffer.
func CheckDiskSpaceForModel(dir string, requiredBytes int64) (DiskSpaceInfo, error) {
	info := GetDiskSpaceInfo(dir)
	needed := requiredBytes + LocalModelSafetyBufferBytes
	if info.FreeBytes > 0 && int64(info.FreeBytes) < needed {
		neededGB := float64(needed) / (1024 * 1024 * 1024)
		return info, fmt.Errorf("insufficient disk space in %s: %.1f GB required (including 512 MB buffer), only %.1f GB available", info.Path, neededGB, info.FreeGB)
	}
	return info, nil
}

// CandidateModelDirectories returns the ordered list of directories searched for local GGUF weights.
func CandidateModelDirectories(primaryDir string) []string {
	var dirs []string
	seen := make(map[string]bool)
	addDir := func(d string) {
		d = strings.TrimSpace(d)
		if d == "" {
			return
		}
		if abs, err := filepath.Abs(d); err == nil {
			d = abs
		}
		key := strings.ToLower(d)
		if !seen[key] {
			seen[key] = true
			dirs = append(dirs, d)
		}
	}

	addDir(primaryDir)
	addDir("./models")
	if exe, err := os.Executable(); err == nil {
		addDir(filepath.Join(filepath.Dir(exe), "models"))
	}
	userProfile := os.Getenv("USERPROFILE")
	if userProfile == "" {
		userProfile, _ = os.UserHomeDir()
	}
	if userProfile != "" {
		addDir(filepath.Join(userProfile, ".shuffle", "models"))
		addDir(filepath.Join(userProfile, "Documents", "antigravity", "delightful-mendeleev", "models"))
		addDir(filepath.Join(userProfile, "delightful-mendeleev", "models"))
		addDir(filepath.Join(userProfile, ".gemini", "antigravity", "scratch", "delightful-mendeleev", "models"))
	}
	addDir(filepath.Join("..", "delightful-mendeleev", "models"))
	return dirs
}

// ResolveOrFindLocalModelFile checks whether a model weight matching modelKey exists on disk.
// Returns (absoluteFilePath, true) if found and non-empty, or ("", false) if not installed.
func ResolveOrFindLocalModelFile(modelKey string, primaryDir string, explicitModelPath string) (string, bool) {
	spec := GetLocalModelSpec(modelKey)
	dirs := CandidateModelDirectories(primaryDir)

	// 1. If an explicit file path is provided and matches the requested spec (or modelKey is tendon-local/empty), check it first.
	if explicitModelPath != "" {
		if fi, err := os.Stat(explicitModelPath); err == nil && !fi.IsDir() && fi.Size() > 1024*1024 {
			if spec == nil {
				if abs, err := filepath.Abs(explicitModelPath); err == nil {
					return abs, true
				}
				return explicitModelPath, true
			}
			baseLower := strings.ToLower(filepath.Base(explicitModelPath))
			if baseLower == strings.ToLower(spec.Filename) {
				if abs, err := filepath.Abs(explicitModelPath); err == nil {
					return abs, true
				}
				return explicitModelPath, true
			}
			for _, alias := range spec.Aliases {
				if strings.Contains(baseLower, strings.ToLower(alias)) {
					if abs, err := filepath.Abs(explicitModelPath); err == nil {
						return abs, true
					}
					return explicitModelPath, true
				}
			}
		}
	}

	if spec == nil {
		return "", false
	}

	// 2. Check exact filename match across candidate directories
	for _, dir := range dirs {
		cand := filepath.Join(dir, spec.Filename)
		if fi, err := os.Stat(cand); err == nil && !fi.IsDir() && fi.Size() > 1024*1024 {
			if abs, err := filepath.Abs(cand); err == nil {
				return abs, true
			}
			return cand, true
		}
	}

	// 3. Check fuzzy/alias match across .gguf files in candidate directories
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			name := entry.Name()
			lower := strings.ToLower(name)
			if !strings.HasSuffix(lower, ".gguf") || strings.HasSuffix(lower, ".part") {
				continue
			}
			for _, alias := range spec.Aliases {
				if strings.Contains(lower, strings.ToLower(alias)) {
					full := filepath.Join(dir, name)
					if fi, err := entry.Info(); err == nil && fi.Size() > 1024*1024 {
						if abs, err := filepath.Abs(full); err == nil {
							return abs, true
						}
						return full, true
					}
				}
			}
		}
	}

	return "", false
}

// LocalModelCatalogEntryStatus enriches LocalModelSpec with live on-disk and hardware status.
type LocalModelCatalogEntryStatus struct {
	LocalModelSpec
	Installed       bool   `json:"installed"`
	InstalledPath   string `json:"installed_path,omitempty"`
	InstalledBytes  int64  `json:"installed_bytes,omitempty"`
	HasPartial      bool   `json:"has_partial,omitempty"`
	PartialBytes    int64  `json:"partial_bytes,omitempty"`
	FitsDiskSpace   bool   `json:"fits_disk_space"`
	IsDownloading   bool   `json:"is_downloading,omitempty"`
	DownloadPercent int    `json:"download_percent,omitempty"`
}

// BuildLocalModelCatalogStatus returns the full catalog with installation and disk-fit status for each model.
func BuildLocalModelCatalogStatus(primaryDir string, explicitModelPath string) ([]LocalModelCatalogEntryStatus, DiskSpaceInfo) {
	diskInfo := GetDiskSpaceInfo(primaryDir)
	dlState := GlobalModelDownloader.GetState()

	targetDir := strings.TrimSpace(primaryDir)
	if targetDir == "" {
		targetDir = "./models"
	}
	if abs, err := filepath.Abs(targetDir); err == nil {
		targetDir = abs
	}

	out := make([]LocalModelCatalogEntryStatus, 0, len(DefaultLocalModelCatalog))
	for _, spec := range DefaultLocalModelCatalog {
		entry := LocalModelCatalogEntryStatus{
			LocalModelSpec: spec,
			FitsDiskSpace:  diskInfo.FreeBytes == 0 || int64(diskInfo.FreeBytes) >= (spec.SizeBytes+LocalModelSafetyBufferBytes),
		}
		if path, ok := ResolveOrFindLocalModelFile(spec.Key, primaryDir, explicitModelPath); ok {
			entry.Installed = true
			entry.InstalledPath = path
			if fi, err := os.Stat(path); err == nil {
				entry.InstalledBytes = fi.Size()
			}
			entry.FitsDiskSpace = true
		} else {
			partPath := filepath.Join(targetDir, spec.Filename+".part")
			if fi, err := os.Stat(partPath); err == nil && !fi.IsDir() && fi.Size() > 0 {
				entry.HasPartial = true
				entry.PartialBytes = fi.Size()
			}
		}
		if dlState.Status == "downloading" && dlState.ModelKey == spec.Key {
			entry.IsDownloading = true
			entry.DownloadPercent = dlState.ProgressPct
		}
		out = append(out, entry)
	}
	return out, diskInfo
}

// LocalModelDownloadState represents the live progress state of an active or recent GGUF download.
type LocalModelDownloadState struct {
	Status          string  `json:"status"` // "idle", "downloading", "completed", "cancelled", "error"
	ModelKey        string  `json:"model_key"`
	Label           string  `json:"label"`
	Filename        string  `json:"filename"`
	TargetPath      string  `json:"target_path"`
	DownloadURL     string  `json:"download_url"`
	DownloadedBytes int64   `json:"downloaded_bytes"`
	TotalBytes      int64   `json:"total_bytes"`
	ProgressPct     int     `json:"progress_pct"`
	SpeedMBps       float64 `json:"speed_mbps"`
	FreeDiskBytes   uint64  `json:"free_disk_bytes"`
	FreeDiskGB      float64 `json:"free_disk_gb"`
	Error           string  `json:"error,omitempty"`
	UpdatedAt       int64   `json:"updated_at"`
}

// LocalModelDownloader coordinates GGUF model downloads with progress callbacks and cancellation.
type LocalModelDownloader struct {
	mu         sync.Mutex
	state      LocalModelDownloadState
	cancelFunc context.CancelFunc
	doneCh     chan struct{}
	onProgress func(LocalModelDownloadState)
}

// GlobalModelDownloader is the singleton manager for local GGUF model downloads.
var GlobalModelDownloader = &LocalModelDownloader{
	state: LocalModelDownloadState{Status: "idle"},
}

// SetProgressCallback registers a listener invoked whenever download state or progress changes.
func (d *LocalModelDownloader) SetProgressCallback(cb func(LocalModelDownloadState)) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.onProgress = cb
}

// GetState returns a snapshot of the current download state.
func (d *LocalModelDownloader) GetState() LocalModelDownloadState {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.state
}

func (d *LocalModelDownloader) emit(st LocalModelDownloadState) {
	st.UpdatedAt = time.Now().UnixMilli()
	d.mu.Lock()
	d.state = st
	cb := d.onProgress
	d.mu.Unlock()
	if cb != nil {
		cb(st)
	}
}

// CancelDownload aborts any currently running GGUF download.
func (d *LocalModelDownloader) CancelDownload() LocalModelDownloadState {
	d.mu.Lock()
	cancel := d.cancelFunc
	cur := d.state
	d.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if cur.Status == "downloading" {
		cur.Status = "cancelled"
		cur.Error = "Download cancelled by user"
		d.emit(cur)
	}
	return d.GetState()
}

// StartDownload initiates an asynchronous download for modelKey into targetDir.
// If the same model is already downloading, it returns the current state.
func (d *LocalModelDownloader) StartDownload(modelKey string, targetDir string) (LocalModelDownloadState, error) {
	spec := GetLocalModelSpec(modelKey)
	if spec == nil {
		return d.GetState(), fmt.Errorf("unknown local model %q", modelKey)
	}

	if targetDir == "" {
		targetDir = "./models"
	}
	if abs, err := filepath.Abs(targetDir); err == nil {
		targetDir = abs
	}

	// If already installed on disk, mark completed immediately
	if existingPath, ok := ResolveOrFindLocalModelFile(spec.Key, targetDir, ""); ok {
		diskInfo := GetDiskSpaceInfo(targetDir)
		var sz int64 = spec.SizeBytes
		if fi, err := os.Stat(existingPath); err == nil {
			sz = fi.Size()
		}
		st := LocalModelDownloadState{
			Status:          "completed",
			ModelKey:        spec.Key,
			Label:           spec.Label,
			Filename:         filepath.Base(existingPath),
			TargetPath:      existingPath,
			DownloadURL:     spec.DownloadURL,
			DownloadedBytes: sz,
			TotalBytes:      sz,
			ProgressPct:     100,
			FreeDiskBytes:   diskInfo.FreeBytes,
			FreeDiskGB:      diskInfo.FreeGB,
		}
		d.emit(st)
		return st, nil
	}

	d.mu.Lock()
	if d.state.Status == "downloading" {
		if d.state.ModelKey == spec.Key {
			st := d.state
			d.mu.Unlock()
			return st, nil
		}
		// Cancel previous model download if switching to a new one
		if d.cancelFunc != nil {
			d.cancelFunc()
		}
	}
	d.mu.Unlock()

	// Check available disk space before starting (accounting for any partial download already on disk)
	partPath := filepath.Join(targetDir, spec.Filename+".part")
	var resumeBytes int64
	if fi, err := os.Stat(partPath); err == nil && !fi.IsDir() {
		resumeBytes = fi.Size()
	}
	remainingBytes := spec.SizeBytes - resumeBytes
	if remainingBytes < 0 {
		remainingBytes = spec.SizeBytes
	}

	diskInfo, errDisk := CheckDiskSpaceForModel(targetDir, remainingBytes)
	if errDisk != nil {
		st := LocalModelDownloadState{
			Status:        "error",
			ModelKey:      spec.Key,
			Label:         spec.Label,
			Filename:      spec.Filename,
			TargetPath:    filepath.Join(targetDir, spec.Filename),
			DownloadURL:   spec.DownloadURL,
			TotalBytes:    spec.SizeBytes,
			FreeDiskBytes: diskInfo.FreeBytes,
			FreeDiskGB:    diskInfo.FreeGB,
			Error:         errDisk.Error(),
		}
		d.emit(st)
		return st, errDisk
	}

	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return d.GetState(), fmt.Errorf("failed to create models directory %s: %w", targetDir, err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	doneCh := make(chan struct{})

	initialPct := 0
	if spec.SizeBytes > 0 && resumeBytes > 0 {
		initialPct = int((resumeBytes * 100) / spec.SizeBytes)
		if initialPct > 99 {
			initialPct = 99
		}
	}

	initialState := LocalModelDownloadState{
		Status:          "downloading",
		ModelKey:        spec.Key,
		Label:           spec.Label,
		Filename:        spec.Filename,
		TargetPath:      filepath.Join(targetDir, spec.Filename),
		DownloadURL:     spec.DownloadURL,
		DownloadedBytes: resumeBytes,
		TotalBytes:      spec.SizeBytes,
		ProgressPct:     initialPct,
		SpeedMBps:       0,
		FreeDiskBytes:   diskInfo.FreeBytes,
		FreeDiskGB:      diskInfo.FreeGB,
	}

	d.mu.Lock()
	d.cancelFunc = cancel
	d.doneCh = doneCh
	d.state = initialState
	d.mu.Unlock()

	d.emit(initialState)

	go d.runDownloadLoop(ctx, doneCh, *spec, targetDir, partPath, resumeBytes)

	return initialState, nil
}

// EnsureModelDownloaded blocks until modelKey is present on disk (or downloaded) or ctx is cancelled.
func (d *LocalModelDownloader) EnsureModelDownloaded(ctx context.Context, modelKey string, targetDir string, explicitModelPath string) (string, error) {
	if existing, ok := ResolveOrFindLocalModelFile(modelKey, targetDir, explicitModelPath); ok {
		return existing, nil
	}

	st, err := d.StartDownload(modelKey, targetDir)
	if err != nil {
		return "", err
	}
	if st.Status == "completed" && st.TargetPath != "" {
		return st.TargetPath, nil
	}

	d.mu.Lock()
	doneCh := d.doneCh
	d.mu.Unlock()

	if doneCh != nil {
		select {
		case <-ctx.Done():
			d.CancelDownload()
			return "", ctx.Err()
		case <-doneCh:
		}
	}

	finalState := d.GetState()
	if finalState.Status == "completed" && finalState.TargetPath != "" {
		return finalState.TargetPath, nil
	}
	if finalState.Error != "" {
		return "", fmt.Errorf("%s", finalState.Error)
	}
	return "", fmt.Errorf("download of %s did not complete (status: %s)", modelKey, finalState.Status)
}

func (d *LocalModelDownloader) runDownloadLoop(ctx context.Context, doneCh chan struct{}, spec LocalModelSpec, targetDir string, partPath string, resumeBytes int64) {
	defer close(doneCh)

	destPath := filepath.Join(targetDir, spec.Filename)
	req, err := http.NewRequestWithContext(ctx, "GET", spec.DownloadURL, nil)
	if err != nil {
		d.failDownload(spec, destPath, fmt.Sprintf("Failed to create download request: %v", err))
		return
	}
	req.Header.Set("User-Agent", "Shuffle-Orborus-Agent/1.0")
	if resumeBytes > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", resumeBytes))
	}

	client := &http.Client{
		Timeout: 0, // Streaming large multi-GB weight files
	}
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			d.markCancelled(spec, destPath, resumeBytes)
			return
		}
		d.failDownload(spec, destPath, fmt.Sprintf("Network error downloading %s: %v", spec.Label, err))
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		d.failDownload(spec, destPath, fmt.Sprintf("HuggingFace server returned HTTP %d for %s", resp.StatusCode, spec.Filename))
		return
	}

	// If server did not honor Range header (returned 200 OK instead of 206), restart from 0
	openFlags := os.O_CREATE | os.O_WRONLY
	var totalBytes int64 = spec.SizeBytes
	var downloaded int64 = resumeBytes

	if resp.StatusCode == http.StatusPartialContent {
		openFlags |= os.O_APPEND
		if resp.ContentLength > 0 {
			totalBytes = resumeBytes + resp.ContentLength
		}
	} else {
		openFlags |= os.O_TRUNC
		downloaded = 0
		if resp.ContentLength > 0 {
			totalBytes = resp.ContentLength
		}
	}

	// Verify disk space again with exact ContentLength from server
	remainingNeeded := totalBytes - downloaded
	if remainingNeeded < 0 {
		remainingNeeded = 0
	}
	if _, errDisk := CheckDiskSpaceForModel(targetDir, remainingNeeded); errDisk != nil {
		d.failDownload(spec, destPath, errDisk.Error())
		return
	}

	outFile, err := os.OpenFile(partPath, openFlags, 0644)
	if err != nil {
		d.failDownload(spec, destPath, fmt.Sprintf("Failed to open file %s: %v", partPath, err))
		return
	}

	buf := make([]byte, 256*1024) // 256 KB buffer
	lastEmit := time.Now()
	speedWindowStart := time.Now()
	var bytesInWindow int64
	var currentSpeedMBps float64

	for {
		select {
		case <-ctx.Done():
			outFile.Close()
			d.markCancelled(spec, destPath, downloaded)
			return
		default:
		}

		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := outFile.Write(buf[:n]); writeErr != nil {
				outFile.Close()
				d.failDownload(spec, destPath, fmt.Sprintf("Disk write error while downloading %s: %v", spec.Label, writeErr))
				return
			}
			downloaded += int64(n)
			bytesInWindow += int64(n)

			now := time.Now()
			if now.Sub(lastEmit) >= 250*time.Millisecond {
				elapsed := now.Sub(speedWindowStart).Seconds()
				if elapsed > 0 {
					currentSpeedMBps = math.Round((float64(bytesInWindow)/(1024*1024)/elapsed)*10) / 10
				}
				if now.Sub(speedWindowStart) >= 2*time.Second {
					speedWindowStart = now
					bytesInWindow = 0
				}
				lastEmit = now

				pct := 0
				if totalBytes > 0 {
					pct = int((downloaded * 100) / totalBytes)
					if pct > 99 {
						pct = 99
					}
				}
				di := GetDiskSpaceInfo(targetDir)
				d.emit(LocalModelDownloadState{
					Status:          "downloading",
					ModelKey:        spec.Key,
					Label:           spec.Label,
					Filename:        spec.Filename,
					TargetPath:      destPath,
					DownloadURL:     spec.DownloadURL,
					DownloadedBytes: downloaded,
					TotalBytes:      totalBytes,
					ProgressPct:     pct,
					SpeedMBps:       currentSpeedMBps,
					FreeDiskBytes:   di.FreeBytes,
					FreeDiskGB:      di.FreeGB,
				})
			}
		}

		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			outFile.Close()
			if ctx.Err() != nil {
				d.markCancelled(spec, destPath, downloaded)
				return
			}
			d.failDownload(spec, destPath, fmt.Sprintf("Stream interrupted while downloading %s: %v", spec.Label, readErr))
			return
		}
	}

	if err := outFile.Sync(); err != nil {
		log.Printf("[WARNING] Failed to sync downloaded model file %s: %v", partPath, err)
	}
	outFile.Close()

	// Rename .part file to final .gguf path
	_ = os.Remove(destPath)
	if err := os.Rename(partPath, destPath); err != nil {
		d.failDownload(spec, destPath, fmt.Sprintf("Failed to finalize model file %s: %v", destPath, err))
		return
	}

	finalDisk := GetDiskSpaceInfo(targetDir)
	d.emit(LocalModelDownloadState{
		Status:          "completed",
		ModelKey:        spec.Key,
		Label:           spec.Label,
		Filename:        spec.Filename,
		TargetPath:      destPath,
		DownloadURL:     spec.DownloadURL,
		DownloadedBytes: downloaded,
		TotalBytes:      downloaded,
		ProgressPct:     100,
		SpeedMBps:       currentSpeedMBps,
		FreeDiskBytes:   finalDisk.FreeBytes,
		FreeDiskGB:      finalDisk.FreeGB,
	})
	log.Printf("[INFO] Local model %s (%s) downloaded successfully to %s", spec.Label, spec.Key, destPath)
}

func (d *LocalModelDownloader) failDownload(spec LocalModelSpec, destPath string, errMsg string) {
	log.Printf("[ERROR] Local model download failed (%s): %s", spec.Key, errMsg)
	di := GetDiskSpaceInfo(filepath.Dir(destPath))
	d.emit(LocalModelDownloadState{
		Status:        "error",
		ModelKey:      spec.Key,
		Label:         spec.Label,
		Filename:      spec.Filename,
		TargetPath:    destPath,
		DownloadURL:   spec.DownloadURL,
		TotalBytes:    spec.SizeBytes,
		FreeDiskBytes: di.FreeBytes,
		FreeDiskGB:    di.FreeGB,
		Error:         errMsg,
	})
}

func (d *LocalModelDownloader) markCancelled(spec LocalModelSpec, destPath string, downloaded int64) {
	log.Printf("[INFO] Local model download cancelled (%s) at %d bytes", spec.Key, downloaded)
	di := GetDiskSpaceInfo(filepath.Dir(destPath))
	pct := 0
	if spec.SizeBytes > 0 {
		pct = int((downloaded * 100) / spec.SizeBytes)
	}
	d.emit(LocalModelDownloadState{
		Status:          "cancelled",
		ModelKey:        spec.Key,
		Label:           spec.Label,
		Filename:        spec.Filename,
		TargetPath:      destPath,
		DownloadURL:     spec.DownloadURL,
		DownloadedBytes: downloaded,
		TotalBytes:      spec.SizeBytes,
		ProgressPct:     pct,
		FreeDiskBytes:   di.FreeBytes,
		FreeDiskGB:      di.FreeGB,
		Error:           "Download cancelled",
	})
}

