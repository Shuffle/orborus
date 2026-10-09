package orchestrator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/swarm"
	dockerclient "github.com/docker/docker/client"
	uuid "github.com/satori/go.uuid"
)

// DockerOrchestrator manages the lifecycle of OCI containers on Docker Engine and Docker Swarm.
type DockerOrchestrator struct {
	client dockerclient.CommonAPIClient
	cfg    DockerConfig
}

// NewDockerOrchestrator constructs a new Docker orchestrator instance with the supplied client and configuration.
func NewDockerOrchestrator(client dockerclient.CommonAPIClient, cfg DockerConfig) *DockerOrchestrator {
	if cfg.BaseImageName == "" {
		cfg.BaseImageName = "frikky/shuffle"
	}
	if cfg.BaseImageRegistry == "" {
		cfg.BaseImageRegistry = "docker.io"
	}
	if cfg.WorkerTimeout == 0 {
		cfg.WorkerTimeout = 600 * time.Second
	}
	if cfg.MaxConcurrency == 0 {
		cfg.MaxConcurrency = 25
	}
	if cfg.Timezone == "" {
		cfg.Timezone = "Europe/Amsterdam"
	}
	return &DockerOrchestrator{
		client: client,
		cfg:    cfg,
	}
}

// Client returns the underlying Docker CommonAPIClient.
func (d *DockerOrchestrator) Client() dockerclient.CommonAPIClient {
	return d.client
}

// Config returns the orchestrator configuration.
func (d *DockerOrchestrator) Config() DockerConfig {
	return d.cfg
}

// DeployWorker creates and starts an individual worker container.
func (d *DockerOrchestrator) DeployWorker(ctx context.Context, spec WorkerSpec) (string, error) {
	env := append([]string{}, spec.Env...)
	if spec.RegistryURL != "" {
		env = append(env, fmt.Sprintf("REGISTRY_URL=%s", spec.RegistryURL))
	}

	hostConfig := &container.HostConfig{
		LogConfig: container.LogConfig{
			Type: "json-file",
			Config: map[string]string{
				"max-size": "10m",
			},
		},
		Resources: container.Resources{},
	}

	certPath := d.cfg.CertPath
	if spec.CertPath != "" {
		certPath = spec.CertPath
	}
	if certPath == "" {
		certPath = "/certs"
	}
	if _, err := os.ReadDir(certPath); certPath != "" && err == nil {
		hostConfig.Mounts = append(hostConfig.Mounts, mount.Mount{
			Type:   mount.TypeBind,
			Source: certPath,
			Target: "/certs",
		})
	}

	dockerHost := d.cfg.DockerHost
	if spec.DockerHost != "" {
		dockerHost = spec.DockerHost
	}
	if len(dockerHost) == 0 {
		if runtime.GOOS == "windows" {
			hostConfig.Binds = []string{`\\.\pipe\docker_engine:\\.\pipe\docker_engine`}
		} else {
			hostConfig.Binds = []string{"/var/run/docker.sock:/var/run/docker.sock:rw"}
		}
	}

	if d.cfg.ContainerID != "" {
		hostConfig.NetworkMode = container.NetworkMode(fmt.Sprintf("container:%s", d.cfg.ContainerID))
	}
	if spec.NetworkMode != "" {
		hostConfig.NetworkMode = container.NetworkMode(spec.NetworkMode)
	}

	if spec.AutoRemove || d.cfg.Cleanup {
		hostConfig.AutoRemove = true
	}

	config := &container.Config{
		Image: spec.Image,
		Env:   env,
	}

	identifier := spec.Identifier
	cont, err := d.client.ContainerCreate(ctx, config, hostConfig, nil, nil, identifier)
	if err != nil {
		errStr := err.Error()
		if strings.Contains(errStr, "Conflict. The container name ") || strings.Contains(errStr, "is already in use") {
			identifier = fmt.Sprintf("%s-%s", identifier, uuid.NewV4().String())
			cont, err = d.client.ContainerCreate(ctx, config, hostConfig, nil, nil, identifier)
			if err != nil {
				return "", fmt.Errorf("container create retry error: %w", err)
			}
		} else {
			return "", fmt.Errorf("container create error: %w", err)
		}
	}

	startOptions := container.StartOptions{}
	err = d.client.ContainerStart(ctx, cont.ID, startOptions)
	if err != nil {
		errStr := err.Error()
		if strings.Contains(errStr, "cannot join network") || strings.Contains(errStr, "No such container") {
			hostConfig.NetworkMode = ""
			fallbackIdentifier := identifier + "-2"
			cont, err = d.client.ContainerCreate(ctx, config, hostConfig, nil, nil, fallbackIdentifier)
			if err != nil {
				return "", fmt.Errorf("fallback container create failed: %w", err)
			}
			err = d.client.ContainerStart(ctx, cont.ID, startOptions)
			if err != nil {
				return "", fmt.Errorf("fallback container start failed: %w", err)
			}
		} else {
			return "", fmt.Errorf("container start error: %w", err)
		}
	}

	return cont.ID, nil
}

// StopWorker terminates and removes a container by name or ID.
func (d *DockerOrchestrator) StopWorker(ctx context.Context, identifier string) error {
	var stopOptions container.StopOptions
	if err := d.client.ContainerStop(ctx, identifier, stopOptions); err != nil {
		log.Printf("[WARNING] Unable to stop container %s (attempting removal anyway): %v", identifier, err)
	}

	removeOptions := container.RemoveOptions{
		RemoveVolumes: true,
		Force:         true,
	}
	if err := d.client.ContainerRemove(ctx, identifier, removeOptions); err != nil {
		return fmt.Errorf("container removal failed: %w", err)
	}

	return nil
}

// GetRunningWorkers returns the count of running Shuffle worker containers.
func (d *DockerOrchestrator) GetRunningWorkers(ctx context.Context, timeout time.Duration) (int, error) {
	containers, err := d.client.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return 0, fmt.Errorf("failed listing containers: %w", err)
	}

	counter := 0
	currentTime := time.Now().Unix()
	timeoutSec := int64(timeout.Seconds())

	for _, c := range containers {
		isShuffle := strings.Contains(c.Image, d.cfg.BaseImageName)
		if !isShuffle {
			for _, label := range c.Labels {
				if label == "shuffle" {
					isShuffle = true
					break
				}
			}
		}
		if !isShuffle {
			continue
		}

		for _, name := range c.Names {
			if !strings.HasPrefix(name, "/worker") {
				continue
			}
			if c.State == "running" && (currentTime-c.Created < timeoutSec || timeoutSec <= 0) {
				counter++
				break
			}
		}
	}

	return counter, nil
}

// Cleanup identifies and deletes expired or non-running worker containers.
func (d *DockerOrchestrator) Cleanup(ctx context.Context, timeout time.Duration) error {
	containers, err := d.client.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return fmt.Errorf("failed listing containers for cleanup: %w", err)
	}

	currentTime := time.Now().Unix()
	timeoutSec := int64(timeout.Seconds())

	var stopContainers []string
	var removeContainers []string

	for _, c := range containers {
		isShuffle := strings.Contains(c.Image, d.cfg.BaseImageName) ||
			strings.Contains(c.Command, "python app.py") ||
			strings.Contains(c.Command, "walkoff") ||
			c.Command == "./worker"

		if !isShuffle {
			for _, label := range c.Labels {
				if label == "shuffle" {
					isShuffle = true
					break
				}
			}
		}
		if !isShuffle {
			continue
		}

		for _, name := range c.Names {
			if strings.HasPrefix(name, "/shuffle") && !strings.HasPrefix(name, "/shuffle-subflow") {
				continue
			}

			age := currentTime - c.Created
			if c.State != "running" && age > timeoutSec {
				removeContainers = append(removeContainers, c.ID)
			} else if c.State == "running" && age > timeoutSec {
				stopContainers = append(stopContainers, c.ID)
			}
		}
	}

	var stopOptions container.StopOptions
	for _, id := range stopContainers {
		_ = d.client.ContainerStop(ctx, id, stopOptions)
		removeContainers = append(removeContainers, id)
	}

	removeOptions := container.RemoveOptions{
		RemoveVolumes: true,
		Force:         true,
	}
	for _, id := range removeContainers {
		_ = d.client.ContainerRemove(ctx, id, removeOptions)
	}

	return nil
}

// GetResourceUsage reads and calculates CPU and memory percentages for a container.
func (d *DockerOrchestrator) GetResourceUsage(ctx context.Context, identifier string) (*ResourceUsage, error) {
	stats, err := d.client.ContainerStats(ctx, identifier, false)
	if err != nil {
		return nil, fmt.Errorf("failed getting container stats: %w", err)
	}
	defer stats.Body.Close()

	cpuUsage, memUsage, err := ParseResourceUsage(stats.Body)
	if err != nil {
		return nil, err
	}

	return &ResourceUsage{
		CPUPercent:    cpuUsage,
		MemoryPercent: memUsage,
	}, nil
}

// ParseResourceUsage decodes stats stream and computes CPU and memory utilization.
func ParseResourceUsage(body io.Reader) (float64, float64, error) {
	var stats container.Stats
	decoder := json.NewDecoder(body)
	if err := decoder.Decode(&stats); err != nil {
		return 0, 0, err
	}

	if stats.CPUStats.CPUUsage.TotalUsage == 0 || stats.PreCPUStats.CPUUsage.TotalUsage == 0 {
		return 0, 0, nil
	}

	timeDelta := float64(stats.Read.Sub(stats.PreRead).Nanoseconds())
	if timeDelta <= 0 {
		return 0, 0, nil
	}

	cpuDelta := float64(stats.CPUStats.CPUUsage.TotalUsage - stats.PreCPUStats.CPUUsage.TotalUsage)
	cpuUsage := (cpuDelta / timeDelta) * 100.0

	var memoryUsage float64
	if stats.MemoryStats.Limit > 0 {
		memoryUsage = (float64(stats.MemoryStats.Usage) / float64(stats.MemoryStats.Limit)) * 100.0
	}

	return cpuUsage, memoryUsage, nil
}

// PullImage pulls an OCI image from the registry.
func (d *DockerOrchestrator) PullImage(ctx context.Context, imageName string) error {
	pullOptions := image.PullOptions{}
	reader, err := d.client.ImagePull(ctx, imageName, pullOptions)
	if err != nil {
		return fmt.Errorf("failed pulling image %s: %w", imageName, err)
	}
	defer reader.Close()
	_, _ = io.Copy(io.Discard, reader)
	return nil
}

// CheckSwarmService initializes or verifies manager state in Docker Swarm.
func (d *DockerOrchestrator) CheckSwarmService(ctx context.Context) error {
	info, err := d.client.Info(ctx)
	if err != nil {
		return fmt.Errorf("failed getting docker info: %w", err)
	}

	if info.Swarm.ControlAvailable {
		return nil
	}

	localIP := getLocalIP()
	req := swarm.InitRequest{
		ListenAddr:    "0.0.0.0:2377",
		AdvertiseAddr: fmt.Sprintf("%s:2377", localIP),
	}

	_, err = d.client.SwarmInit(ctx, req)
	if err != nil {
		candidates, cErr := getLocalIPs()
		if cErr == nil && len(candidates) > 0 {
			for i, cand := range candidates {
				if i > 5 {
					break
				}
				req.AdvertiseAddr = fmt.Sprintf("%s:2377", cand)
				if _, sErr := d.client.SwarmInit(ctx, req); sErr == nil {
					return nil
				}
			}
		}
		return fmt.Errorf("swarm init failed: %w", err)
	}

	return nil
}

// DeployServiceWorkers provisions worker tasks in Docker Swarm as replicated services.
func (d *DockerOrchestrator) DeployServiceWorkers(ctx context.Context, image string, replicas uint64, extraEnv []string) error {
	networkName := "shuffle_swarm_executions"
	if d.cfg.SwarmNetworkName != "" {
		networkName = d.cfg.SwarmNetworkName
	}

	serviceName := "shuffle-workers"
	networkID := networkName

	networks, err := d.client.NetworkList(ctx, network.ListOptions{})
	if err == nil {
		for _, netw := range networks {
			if netw.Name == networkName && netw.Scope == "swarm" {
				networkID = netw.ID
				break
			}
		}
	}

	spec := swarm.ServiceSpec{
		Annotations: swarm.Annotations{
			Name: serviceName,
		},
		Mode: swarm.ServiceMode{
			Replicated: &swarm.ReplicatedService{
				Replicas: &replicas,
			},
		},
		Networks: []swarm.NetworkAttachmentConfig{
			{Target: networkID},
		},
		EndpointSpec: &swarm.EndpointSpec{
			Mode: "vip",
			Ports: []swarm.PortConfig{
				{
					Protocol:      swarm.PortConfigProtocolTCP,
					PublishMode:   swarm.PortConfigPublishModeIngress,
					Name:          "worker-port",
					PublishedPort: 33333,
					TargetPort:    33333,
				},
			},
		},
		TaskTemplate: swarm.TaskSpec{
			LogDriver: &swarm.Driver{
				Name: "json-file",
				Options: map[string]string{
					"max-size": "10m",
				},
			},
			ContainerSpec: &swarm.ContainerSpec{
				Image: image,
				Env:   append([]string{fmt.Sprintf("SHUFFLE_SWARM_NETWORK_NAME=%s", networkName)}, extraEnv...),
			},
			RestartPolicy: &swarm.RestartPolicy{
				Condition: swarm.RestartPolicyConditionOnFailure,
			},
		},
	}

	if d.cfg.DockerHost == "" {
		if runtime.GOOS == "windows" {
			spec.TaskTemplate.ContainerSpec.Mounts = []mount.Mount{
				{
					Source: `\\.\pipe\docker_engine`,
					Target: `\\.\pipe\docker_engine`,
					Type:   mount.TypeBind,
				},
			}
		} else {
			spec.TaskTemplate.ContainerSpec.Mounts = []mount.Mount{
				{
					Source: "/var/run/docker.sock",
					Target: "/var/run/docker.sock",
					Type:   mount.TypeBind,
				},
			}
		}
	}

	_, err = d.client.ServiceCreate(ctx, spec, types.ServiceCreateOptions{})
	if err != nil {
		if strings.Contains(err.Error(), "Already Exists") || strings.Contains(err.Error(), "is already in use by service") {
			return nil
		}
		return fmt.Errorf("service create error: %w", err)
	}

	return nil
}

// ScaleService scales a swarm service to the target replica count.
func (d *DockerOrchestrator) ScaleService(ctx context.Context, serviceName string, replicas uint64) error {
	svc, _, err := d.client.ServiceInspectWithRaw(ctx, serviceName, types.ServiceInspectOptions{})
	if err != nil {
		return fmt.Errorf("service inspect error: %w", err)
	}

	if svc.Spec.Mode.Replicated == nil {
		return errors.New("service is not in replicated mode")
	}

	svc.Spec.Mode.Replicated.Replicas = &replicas
	_, err = d.client.ServiceUpdate(ctx, svc.ID, svc.Version, svc.Spec, types.ServiceUpdateOptions{})
	if err != nil {
		return fmt.Errorf("service update error: %w", err)
	}

	return nil
}

// RestartSwarmWorkers triggers a rolling restart for swarm workers.
func (d *DockerOrchestrator) RestartSwarmWorkers(ctx context.Context, serviceName, memcachedAddress string) error {
	svc, _, err := d.client.ServiceInspectWithRaw(ctx, serviceName, types.ServiceInspectOptions{})
	if err != nil {
		return fmt.Errorf("service inspect error: %w", err)
	}

	if svc.Spec.TaskTemplate.ContainerSpec == nil {
		return errors.New("service has no container spec")
	}

	if memcachedAddress != "" {
		targetEnv := "SHUFFLE_MEMCACHED=" + memcachedAddress
		found := false
		for idx, env := range svc.Spec.TaskTemplate.ContainerSpec.Env {
			if strings.HasPrefix(env, "SHUFFLE_MEMCACHED=") {
				svc.Spec.TaskTemplate.ContainerSpec.Env[idx] = targetEnv
				found = true
				break
			}
		}
		if !found {
			svc.Spec.TaskTemplate.ContainerSpec.Env = append(svc.Spec.TaskTemplate.ContainerSpec.Env, targetEnv)
		}
	}

	svc.Spec.TaskTemplate.ForceUpdate++
	_, err = d.client.ServiceUpdate(ctx, svc.ID, svc.Version, svc.Spec, types.ServiceUpdateOptions{})
	if err != nil {
		return fmt.Errorf("service update error: %w", err)
	}

	return nil
}

func getLocalIP() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "127.0.0.1"
	}
	for _, address := range addrs {
		if ipnet, ok := address.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
			if ipnet.IP.To4() != nil {
				return ipnet.IP.String()
			}
		}
	}
	return "127.0.0.1"
}

func getLocalIPs() ([]string, error) {
	var ips []string
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, address := range addrs {
			if ipnet, ok := address.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
				if ip4 := ipnet.IP.To4(); ip4 != nil {
					ips = append(ips, ip4.String())
				}
			}
		}
	}
	return ips, nil
}
