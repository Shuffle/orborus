package orchestrator

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/kubernetes"
)

// K8sOrchestrator manages the lifecycle of Shuffle worker pods and deployments in a Kubernetes cluster.
type K8sOrchestrator struct {
	client    kubernetes.Interface
	cfg       K8sConfig
	namespace string
}

// NewK8sOrchestrator creates a new instance of K8sOrchestrator.
func NewK8sOrchestrator(client kubernetes.Interface, cfg K8sConfig) *K8sOrchestrator {
	ns := cfg.Namespace
	if ns == "" {
		ns = "default"
	}
	if cfg.BaseImageName == "" {
		cfg.BaseImageName = "frikky/shuffle"
	}
	if cfg.Replicas <= 0 {
		cfg.Replicas = 1
	}
	return &K8sOrchestrator{
		client:    client,
		cfg:       cfg,
		namespace: ns,
	}
}

// Client returns the underlying Kubernetes client interface.
func (k *K8sOrchestrator) Client() kubernetes.Interface {
	return k.client
}

// Config returns the Kubernetes orchestrator configuration.
func (k *K8sOrchestrator) Config() K8sConfig {
	return k.cfg
}

// DeployWorker provisions a Kubernetes Deployment and ClusterIP Service for a worker.
func (k *K8sOrchestrator) DeployWorker(ctx context.Context, spec WorkerSpec) (string, error) {
	identifier := spec.Identifier
	if identifier == "" {
		identifier = "shuffle-workers"
	}

	envMap := make(map[string]string)
	for _, envStr := range spec.Env {
		parts := strings.SplitN(envStr, "=", 2)
		if len(parts) == 2 {
			envMap[parts[0]] = parts[1]
		}
	}

	envMap["IS_KUBERNETES"] = "true"
	envMap["KUBERNETES_NAMESPACE"] = k.namespace

	workerImage := spec.Image
	if workerImage == "" {
		workerImage = k.cfg.WorkerImage
	}

	var podSecurityContext *corev1.PodSecurityContext
	if len(k.cfg.WorkerPodSecurityContext) > 0 {
		podSecurityContext = &corev1.PodSecurityContext{}
		if err := json.Unmarshal([]byte(k.cfg.WorkerPodSecurityContext), podSecurityContext); err != nil {
			return "", fmt.Errorf("failed to unmarshal pod security context: %w", err)
		}
	}

	var containerSecurityContext *corev1.SecurityContext
	if len(k.cfg.WorkerContainerSecurityContext) > 0 {
		containerSecurityContext = &corev1.SecurityContext{}
		if err := json.Unmarshal([]byte(k.cfg.WorkerContainerSecurityContext), containerSecurityContext); err != nil {
			return "", fmt.Errorf("failed to unmarshal container security context: %w", err)
		}
	}

	containerAttachment := corev1.Container{
		Name:            identifier,
		Image:           workerImage,
		Env:             buildEnvVars(envMap),
		SecurityContext: containerSecurityContext,
		Resources:       buildResourcesFromEnv(),
		ImagePullPolicy: corev1.PullIfNotPresent,
	}

	if spec.RegistryURL != "" && k.cfg.BaseImageName != "" {
		containerAttachment.ImagePullPolicy = corev1.PullAlways
	}

	replicas := int32(k.cfg.Replicas)
	if spec.Replicas > 0 {
		replicas = int32(spec.Replicas)
	}

	labels := map[string]string{
		"app.kubernetes.io/name":       "shuffle-worker",
		"app.kubernetes.io/instance":   identifier,
		"app.kubernetes.io/part-of":    "shuffle",
		"app.kubernetes.io/managed-by": "shuffle-orborus",
		"container":                    "shuffle-worker",
	}

	matchLabels := map[string]string{
		"app.kubernetes.io/name":     "shuffle-worker",
		"app.kubernetes.io/instance": identifier,
	}

	automountToken := true
	deployment := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      identifier,
			Namespace: k.namespace,
			Labels:    labels,
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{
				MatchLabels: matchLabels,
			},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: labels,
				},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{
						containerAttachment,
					},
					DNSPolicy:                    corev1.DNSClusterFirst,
					ServiceAccountName:           k.cfg.WorkerServiceAccountName,
					AutomountServiceAccountToken: &automountToken,
					SecurityContext:              podSecurityContext,
				},
			},
		},
	}

	_, err := k.client.AppsV1().Deployments(k.namespace).Create(ctx, deployment, metav1.CreateOptions{})
	if err != nil && !strings.Contains(strings.ToLower(err.Error()), "already exists") {
		return "", fmt.Errorf("failed creating deployment: %w", err)
	}

	svcAppProtocol := "http"
	service := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      identifier,
			Namespace: k.namespace,
			Labels:    labels,
		},
		Spec: corev1.ServiceSpec{
			Selector: matchLabels,
			Ports: []corev1.ServicePort{
				{
					Protocol:    corev1.ProtocolTCP,
					AppProtocol: &svcAppProtocol,
					Port:        33333,
					TargetPort:  intstr.FromInt(33333),
				},
			},
			Type: corev1.ServiceTypeClusterIP,
		},
	}

	_, err = k.client.CoreV1().Services(k.namespace).Create(ctx, service, metav1.CreateOptions{})
	if err != nil && !strings.Contains(strings.ToLower(err.Error()), "already exists") {
		return "", fmt.Errorf("failed creating service: %w", err)
	}

	return identifier, nil
}

// StopWorker deletes the service and deployment corresponding to the worker identifier.
func (k *K8sOrchestrator) StopWorker(ctx context.Context, identifier string) error {
	_ = k.client.CoreV1().Services(k.namespace).Delete(ctx, identifier, metav1.DeleteOptions{})
	_ = k.client.AppsV1().Deployments(k.namespace).Delete(ctx, identifier, metav1.DeleteOptions{})
	return nil
}

// GetRunningWorkers returns the number of running worker pods within the timeout threshold.
func (k *K8sOrchestrator) GetRunningWorkers(ctx context.Context, timeout time.Duration) (int, error) {
	thresholdTime := time.Now().Add(-timeout)

	pods, err := k.client.CoreV1().Pods(k.namespace).List(ctx, metav1.ListOptions{
		LabelSelector: "app.kubernetes.io/name=shuffle-worker",
	})
	if err != nil {
		return 0, fmt.Errorf("failed listing pods: %w", err)
	}

	counter := 0
	for _, pod := range pods.Items {
		if pod.Status.Phase == corev1.PodRunning {
			if timeout <= 0 || pod.CreationTimestamp.Time.After(thresholdTime) {
				counter++
			}
		}
	}

	return counter, nil
}

// Cleanup removes all worker services and deployments managed by shuffle-orborus in the namespace.
func (k *K8sOrchestrator) Cleanup(ctx context.Context, timeout time.Duration) error {
	labelSelector := "app.kubernetes.io/name in (shuffle-worker, shuffle-app),app.kubernetes.io/managed-by in (shuffle-orborus, shuffle-worker)"

	services, err := k.client.CoreV1().Services(k.namespace).List(ctx, metav1.ListOptions{
		LabelSelector: labelSelector,
	})
	if err == nil {
		for _, svc := range services.Items {
			_ = k.client.CoreV1().Services(k.namespace).Delete(ctx, svc.Name, metav1.DeleteOptions{})
		}
	}

	deployments, err := k.client.AppsV1().Deployments(k.namespace).List(ctx, metav1.ListOptions{
		LabelSelector: labelSelector,
	})
	if err == nil {
		for _, dep := range deployments.Items {
			_ = k.client.AppsV1().Deployments(k.namespace).Delete(ctx, dep.Name, metav1.DeleteOptions{})
		}
	}

	return nil
}

// GetResourceUsage returns empty metrics for K8s (typically gathered via Metrics Server).
func (k *K8sOrchestrator) GetResourceUsage(ctx context.Context, identifier string) (*ResourceUsage, error) {
	return &ResourceUsage{}, nil
}

// EnsureRoles creates or verifies the necessary Role and RoleBinding for worker management.
func (k *K8sOrchestrator) EnsureRoles(ctx context.Context, serviceAccountName string) error {
	if serviceAccountName == "" {
		serviceAccountName = "default"
	}
	roleBindingName := "creator-all"

	role := &rbacv1.Role{
		ObjectMeta: metav1.ObjectMeta{
			Name:      roleBindingName,
			Namespace: k.namespace,
		},
		Rules: []rbacv1.PolicyRule{
			{
				APIGroups: []string{"", "apps"},
				Resources: []string{"services", "pods", "deployments"},
				Verbs:     []string{"create", "list", "get", "delete", "watch"},
			},
		},
	}

	_, err := k.client.RbacV1().Roles(k.namespace).Create(ctx, role, metav1.CreateOptions{})
	if err != nil && !strings.Contains(err.Error(), "already exists") {
		log.Printf("[WARNING] Role creation warning: %v", err)
	}

	roleBinding := &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{
			Name:      roleBindingName,
			Namespace: k.namespace,
		},
		Subjects: []rbacv1.Subject{
			{
				Kind:      "ServiceAccount",
				Name:      serviceAccountName,
				Namespace: k.namespace,
			},
		},
		RoleRef: rbacv1.RoleRef{
			Kind: "Role",
			Name: roleBindingName,
		},
	}

	_, err = k.client.RbacV1().RoleBindings(k.namespace).Create(ctx, roleBinding, metav1.CreateOptions{})
	if err != nil && !strings.Contains(err.Error(), "already exists") {
		log.Printf("[WARNING] RoleBinding creation warning: %v", err)
	}

	return nil
}

func buildEnvVars(envMap map[string]string) []corev1.EnvVar {
	var envVars []corev1.EnvVar
	for key, value := range envMap {
		envVars = append(envVars, corev1.EnvVar{Name: key, Value: value})
	}
	return envVars
}

func buildResourcesFromEnv() corev1.ResourceRequirements {
	requests := corev1.ResourceList{}
	limits := corev1.ResourceList{}

	items := []struct {
		env          string
		resourceName corev1.ResourceName
		resourceList corev1.ResourceList
	}{
		{env: "SHUFFLE_WORKER_CPU_REQUEST", resourceName: corev1.ResourceCPU, resourceList: requests},
		{env: "SHUFFLE_WORKER_MEMORY_REQUEST", resourceName: corev1.ResourceMemory, resourceList: requests},
		{env: "SHUFFLE_WORKER_EPHEMERAL_STORAGE_REQUEST", resourceName: corev1.ResourceEphemeralStorage, resourceList: requests},
		{env: "SHUFFLE_WORKER_CPU_LIMIT", resourceName: corev1.ResourceCPU, resourceList: limits},
		{env: "SHUFFLE_WORKER_MEMORY_LIMIT", resourceName: corev1.ResourceMemory, resourceList: limits},
		{env: "SHUFFLE_WORKER_EPHEMERAL_STORAGE_LIMIT", resourceName: corev1.ResourceEphemeralStorage, resourceList: limits},
	}

	for _, it := range items {
		if value := strings.TrimSpace(os.Getenv(it.env)); value != "" {
			if quantity, err := resource.ParseQuantity(value); err == nil {
				it.resourceList[it.resourceName] = quantity
			}
		}
	}

	rr := corev1.ResourceRequirements{}
	if len(requests) > 0 {
		rr.Requests = requests
	}
	if len(limits) > 0 {
		rr.Limits = limits
	}
	return rr
}
