package orchestrator

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

// Ensure both implementations satisfy the common Orchestrator interface
var _ Orchestrator = (*DockerOrchestrator)(nil)
var _ Orchestrator = (*K8sOrchestrator)(nil)

func TestDockerOrchestratorDefaults(t *testing.T) {
	cfg := DockerConfig{}
	orch := NewDockerOrchestrator(nil, cfg)

	if orch.Config().BaseImageName != "frikky/shuffle" {
		t.Errorf("expected default base image frikky/shuffle, got %s", orch.Config().BaseImageName)
	}
	if orch.Config().BaseImageRegistry != "docker.io" {
		t.Errorf("expected default registry docker.io, got %s", orch.Config().BaseImageRegistry)
	}
	if orch.Config().MaxConcurrency != 25 {
		t.Errorf("expected default max concurrency 25, got %d", orch.Config().MaxConcurrency)
	}
	if orch.Config().WorkerTimeout != 600*time.Second {
		t.Errorf("expected default worker timeout 600s, got %v", orch.Config().WorkerTimeout)
	}
}

func TestK8sOrchestratorDefaults(t *testing.T) {
	cfg := K8sConfig{}
	orch := NewK8sOrchestrator(nil, cfg)

	if orch.Config().Namespace != "" {
		// namespace in cfg is empty, but k.namespace defaults to default
	}
	if orch.namespace != "default" {
		t.Errorf("expected default namespace 'default', got %s", orch.namespace)
	}
	if orch.Config().BaseImageName != "frikky/shuffle" {
		t.Errorf("expected default base image frikky/shuffle, got %s", orch.Config().BaseImageName)
	}
}

func TestParseResourceUsage(t *testing.T) {
	rawStatsJSON := `{
		"read": "2026-09-30T10:00:01.000000000Z",
		"preread": "2026-09-30T10:00:00.000000000Z",
		"cpu_stats": {
			"cpu_usage": {
				"total_usage": 200000000
			}
		},
		"precpu_stats": {
			"cpu_usage": {
				"total_usage": 100000000
			}
		},
		"memory_stats": {
			"usage": 52428800,
			"limit": 104857600
		}
	}`

	cpu, mem, err := ParseResourceUsage(strings.NewReader(rawStatsJSON))
	if err != nil {
		t.Fatalf("unexpected error parsing stats: %v", err)
	}

	// 100,000,000 delta / 1,000,000,000 ns = 0.1 * 100 = 10%
	if cpu < 9.9 || cpu > 10.1 {
		t.Errorf("expected approx 10%% CPU usage, got %f", cpu)
	}

	// 52428800 / 104857600 = 50%
	if mem < 49.9 || mem > 50.1 {
		t.Errorf("expected 50%% memory usage, got %f", mem)
	}
}

func TestParseResourceUsageEmpty(t *testing.T) {
	rawStatsJSON := `{"cpu_stats":{"cpu_usage":{"total_usage":0}},"precpu_stats":{"cpu_usage":{"total_usage":0}}}`
	cpu, mem, err := ParseResourceUsage(bytes.NewBufferString(rawStatsJSON))
	if err != nil {
		t.Fatalf("unexpected error parsing empty stats: %v", err)
	}
	if cpu != 0 || mem != 0 {
		t.Errorf("expected 0 values for empty stats, got cpu=%f mem=%f", cpu, mem)
	}
}

func TestBuildEnvVars(t *testing.T) {
	envMap := map[string]string{
		"KEY1": "VALUE1",
		"KEY2": "VALUE2",
	}
	vars := buildEnvVars(envMap)
	if len(vars) != 2 {
		t.Fatalf("expected 2 env vars, got %d", len(vars))
	}
}
