package orchestrator

import (
	"context"
	"time"
)

// Orchestrator defines the generic interface for deploying and managing Shuffle worker execution nodes.
// Both Docker (standalone / swarm) and Kubernetes orchestrate standard OCI workloads.
type Orchestrator interface {
	// DeployWorker spawns a worker to execute tasks.
	DeployWorker(ctx context.Context, spec WorkerSpec) (string, error)

	// StopWorker terminates a running worker by identifier or container name.
	StopWorker(ctx context.Context, identifier string) error

	// GetRunningWorkers returns the count of currently active workers.
	GetRunningWorkers(ctx context.Context, timeout time.Duration) (int, error)

	// Cleanup sweeps terminated or stalled workers beyond the timeout duration.
	Cleanup(ctx context.Context, timeout time.Duration) error

	// GetResourceUsage retrieves current CPU and memory utilization for a given worker/container.
	GetResourceUsage(ctx context.Context, identifier string) (*ResourceUsage, error)
}

// WorkerSpec contains all necessary parameters to spawn a worker container or pod.
type WorkerSpec struct {
	Identifier      string
	Image           string
	Env             []string
	ExecutionID     string
	AutoRemove      bool
	CertPath        string
	DockerHost      string
	Replicas        int
	NetworkMode     string
	RegistryURL     string
}

// ResourceUsage details the CPU and memory utilization metrics.
type ResourceUsage struct {
	CPUPercent    float64
	MemoryPercent float64
	RawCPU        uint64
	RawMemory     uint64
}

// DockerConfig contains runtime configuration options for the Docker orchestrator.
type DockerConfig struct {
	ContainerID                string
	ContainerName              string
	BaseImageName              string
	BaseImageRegistry          string
	WorkerImage                string
	WorkerVersion              string
	SwarmConfig                string // "run", "swarm", or ""
	SwarmNetworkName           string
	DockerSwarmBridgeMTU       string
	DockerSwarmBridgeInterface string
	DockerAPIVersion           string
	DockerHost                 string
	CertPath                   string
	Cleanup                    bool
	MaxConcurrency             int
	WorkerTimeout              time.Duration
	Timezone                   string
	MemcachedAddress           string
}

// K8sConfig contains runtime configuration options for the Kubernetes orchestrator.
type K8sConfig struct {
	Namespace                      string
	WorkerServiceAccountName       string
	WorkerPodSecurityContext       string
	WorkerContainerSecurityContext string
	AppServiceAccountName          string
	AppPodSecurityContext          string
	AppContainerSecurityContext    string
	BaseImageName                  string
	BaseImageRegistry              string
	WorkerImage                    string
	Replicas                       int
}
