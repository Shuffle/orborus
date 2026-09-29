package pkg

import (
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"

	"github.com/denisbrodbeck/machineid"
	"github.com/shuffle/shuffle-shared"
)

// Config holds runtime configuration for Orborus
type Config struct {
	BaseURL      string
	Auth         string
	Org          string
	Environment  string
	PullTime     int
	Debug        bool
	Hostname     string
	MachineID    string
	OrborusLabel string
	IsStandalone   bool
	SensorMode     shuffle.SensorMode
	HasExplicitOrg bool
	HasExplicitAuth bool
	HasExplicitEnv bool
}

// LoadConfig parses flags and environment variables.
// If no --base_url is passed, it defaults to running fully standalone locally without any workers.
func LoadConfig() *Config {
	cfg := &Config{
		Auth:            os.Getenv("AUTH"),
		Org:             os.Getenv("ORG"),
		Environment:     os.Getenv("ENVIRONMENT_NAME"),
		PullTime:        15,
		Debug:           os.Getenv("DEBUG") == "true" || os.Getenv("DEBUG") == "1",
		OrborusLabel:    os.Getenv("SHUFFLE_ORBORUS_LABEL"),
		HasExplicitOrg:  os.Getenv("ORG") != "",
		HasExplicitAuth: os.Getenv("AUTH") != "",
		HasExplicitEnv:  os.Getenv("ENVIRONMENT_NAME") != "",
	}

	hasExplicitBaseURL := false

	// Parse arguments like --base_url=... --auth=...
	for _, arg := range os.Args[1:] {
		if !strings.HasPrefix(arg, "-") {
			continue
		}

		trimmed := strings.TrimLeft(arg, "-")
		parts := strings.SplitN(trimmed, "=", 2)
		key := strings.ToLower(parts[0])
		value := ""
		if len(parts) > 1 {
			value = parts[1]
		}

		switch key {
		case "base_url":
			cfg.BaseURL = value
			hasExplicitBaseURL = true
		case "local", "standalone":
			cfg.IsStandalone = true
		case "auth":
			cfg.Auth = value
			cfg.HasExplicitAuth = value != ""
		case "org", "org_id":
			cfg.Org = value
			cfg.HasExplicitOrg = value != ""
		case "queue", "environment", "environment_name":
			cfg.Environment = value
			cfg.HasExplicitEnv = value != ""
		case "pull_time", "sleep_time":
			if val, err := strconv.Atoi(value); err == nil && val > 0 {
				cfg.PullTime = val
			}
		case "debug":
			cfg.Debug = value == "true" || value == "1" || len(parts) == 1
		}
	}

	// If no base_url was explicitly passed on the CLI, run fully standalone
	if !hasExplicitBaseURL || cfg.BaseURL == "" {
		cfg.IsStandalone = true
		cfg.BaseURL = ""
	} else {
		cfg.IsStandalone = false
	}

	if cfg.Environment == "" {
		if cfg.IsStandalone {
			cfg.Environment = "standalone"
		} else {
			cfg.Environment = "onprem"
		}
	}

	if envPull := os.Getenv("SHUFFLE_ORBORUS_PULL_TIME"); envPull != "" {
		if val, err := strconv.Atoi(envPull); err == nil && val > 0 {
			cfg.PullTime = val
		}
	}

	hostname, err := os.Hostname()
	if err != nil {
		hostname = "unknown-host"
	}

	mid, err := machineid.ID()
	if err != nil {
		log.Printf("[WARNING] Could not resolve machine ID: %v", err)
		mid = "unknown-mid"
	}
	cfg.MachineID = mid
	cfg.Hostname = fmt.Sprintf("%s|%s", hostname, mid)

	cfg.SensorMode = shuffle.SensorMode{
		Enabled:             true,
		Hostname:            cfg.Hostname,
		ProcessListEnabled:  getEnvDefault("SHUFFLE_PROCESS_LIST_ENABLED", "true"),
		SoftwareListEnabled: getEnvDefault("SHUFFLE_SOFTWARE_LIST_ENABLED", "true"),
		CodeScannerEnabled:  getEnvDefault("SHUFFLE_CODE_SCANNER_ENABLED", "true"),
		HdEncryptedCheck:    getEnvDefault("SHUFFLE_HD_ENCRYPTED_CHECK", "true"),
		ScreenlockCheck:     getEnvDefault("SHUFFLE_SCREENLOCK_CHECK", "true"),
		ResponseActions:     getEnvDefault("SHUFFLE_RESPONSE_ACTIONS", "full"),
		LogForwarding:       os.Getenv("SHUFFLE_LOG_FORWARDING"),
	}

	return cfg
}

func getEnvDefault(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}
