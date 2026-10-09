package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/registry"
	dockerclient "github.com/docker/docker/client"
	shuffle "github.com/shuffle/shuffle-shared"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const defaultImageManagerAddress = ":33334"

var imageManagerLock sync.Mutex
var queuedImageDownloads sync.Map

type imageManagerRequest struct {
	Image string `json:"image"`
}

func imageManagerEnabled() bool {
	return isKubernetes == "true" && strings.EqualFold(os.Getenv("SHUFFLE_ORBORUS_DOCKER_IMAGE_MANAGER"), "true")
}

func privateRegistryImage(source string) (string, error) {
	localRegistry := strings.TrimSuffix(strings.TrimSpace(os.Getenv("SHUFFLE_STREAM_PRIVATE_REGISTRY")), "/")
	if localRegistry == "" {
		localRegistry = strings.TrimSuffix(strings.TrimSpace(os.Getenv("REGISTRY_URL")), "/")
	}

	localRegistry = strings.TrimPrefix(strings.TrimPrefix(localRegistry, "https://"), "http://")
	if localRegistry == "" || localRegistry == "docker.io" || localRegistry == "registry.hub.docker.com" || localRegistry == "index.docker.io" {
		return "", errors.New("Kubernetes image manager requires a private app registry")
	}

	source = strings.TrimSpace(source)
	if source == "" || len(source) > 512 || strings.Contains(source, "://") || strings.Contains(source, "..") || strings.ContainsAny(source, "\r\n") {
		return "", fmt.Errorf("invalid image reference %q", source)
	}

	source = strings.TrimPrefix(source, localRegistry+"/")
	for _, publicRegistry := range []string{"docker.io/", "registry.hub.docker.com/", "index.docker.io/"} {
		source = strings.TrimPrefix(source, publicRegistry)
	}
	if !strings.Contains(source, "/") {
		source = "frikky/shuffle:" + source
	}

	return localRegistry + "/" + source, nil
}

func registryAuth(target string) (string, error) {
	host := strings.SplitN(target, "/", 2)[0]
	return registry.EncodeAuthConfig(registry.AuthConfig{
		Username:      os.Getenv("SHUFFLE_REGISTRY_USERNAME"),
		Password:      os.Getenv("SHUFFLE_REGISTRY_PASSWORD"),
		IdentityToken: os.Getenv("SHUFFLE_REGISTRY_IDENTITY_TOKEN"),
		ServerAddress: host,
	})
}

func dockerPushError(stream io.Reader) error {
	decoder := json.NewDecoder(stream)
	for {
		var message struct {
			Error       string `json:"error"`
			ErrorDetail struct {
				Message string `json:"message"`
			} `json:"errorDetail"`
		}

		if err := decoder.Decode(&message); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("decode Docker push response: %w", err)
		}

		if message.ErrorDetail.Message != "" {
			return errors.New(message.ErrorDetail.Message)
		}
		if message.Error != "" {
			return errors.New(message.Error)
		}
	}
}

func dockerLoadReference(stream io.Reader) (string, error) {
	decoder := json.NewDecoder(stream)
	loadedReference := ""
	for {
		var message struct {
			Stream      string `json:"stream"`
			Error       string `json:"error"`
			ErrorDetail struct {
				Message string `json:"message"`
			} `json:"errorDetail"`
		}

		if err := decoder.Decode(&message); err != nil {
			if errors.Is(err, io.EOF) {
				return loadedReference, nil
			}
			return "", fmt.Errorf("decode Docker load response: %w", err)
		}
		if message.ErrorDetail.Message != "" {
			return "", errors.New(message.ErrorDetail.Message)
		}
		if message.Error != "" {
			return "", errors.New(message.Error)
		}

		line := strings.TrimSpace(message.Stream)
		for _, prefix := range []string{"Loaded image: ", "Loaded image ID: "} {
			if strings.HasPrefix(line, prefix) {
				loadedReference = strings.TrimSpace(strings.TrimPrefix(line, prefix))
			}
		}
	}
}

func imageManagerDockerClient(ctx context.Context) (*dockerclient.Client, error) {
	if dockercli != nil {
		if _, err := dockercli.Info(ctx); err == nil {
			return dockercli, nil
		}
	}

	deadline := time.Now().Add(60 * time.Second)
	var lastErr error
	for {
		client, apiVersion, err := shuffle.GetDockerClient()
		if err == nil {
			dockercli = client
			dockerApiVersion = apiVersion
			return client, nil
		}

		lastErr = err
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("Docker image manager did not become ready: %w", lastErr)
		}

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

func downloadAndLoadCloudImage(ctx context.Context, client *dockerclient.Client, source string) error {
	endpoint, err := url.Parse(strings.TrimSuffix(baseUrl, "/") + "/api/v1/get_docker_image")
	if err != nil {
		return fmt.Errorf("build cloud image URL: %w", err)
	}
	query := endpoint.Query()
	query.Set("image", strings.ReplaceAll(source, " ", "-"))
	query.Set("arch", runtime.GOARCH)
	endpoint.RawQuery = query.Encode()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return fmt.Errorf("build cloud image request: %w", err)
	}
	if auth != "" {
		request.Header.Set("Authorization", "Bearer "+auth)
	}
	if org != "" {
		request.Header.Set("Org-Id", org)
	}

	cloudClient := &http.Client{
		Timeout: imagedownloadTimeout,
		CheckRedirect: func(next *http.Request, previous []*http.Request) error {
			if len(previous) >= 10 {
				return errors.New("too many image download redirects")
			}
			if len(previous) > 0 && !strings.EqualFold(next.URL.Host, previous[0].URL.Host) {
				next.Header.Del("Authorization")
				next.Header.Del("Org-Id")
			}
			return nil
		},
	}
	response, err := cloudClient.Do(request)
	if err != nil {
		return fmt.Errorf("download %s: %w", source, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1024*1024))
		return fmt.Errorf("download %s returned %s: %s", source, response.Status, strings.TrimSpace(string(body)))
	}

	existingImages := map[string]bool{}
	if images, listErr := client.ImageList(ctx, image.ListOptions{All: true}); listErr == nil {
		for _, current := range images {
			existingImages[current.ID] = true
		}
	} else {
		log.Printf("[WARNING] Failed listing Docker images before loading %s: %s", source, listErr)
	}

	loadResponse, err := client.ImageLoad(ctx, response.Body)
	if err != nil {
		return fmt.Errorf("load %s: %w", source, err)
	}
	defer loadResponse.Body.Close()
	loadedReference, err := dockerLoadReference(loadResponse.Body)
	if err != nil {
		return fmt.Errorf("load %s: %w", source, err)
	}

	if _, _, err := client.ImageInspectWithRaw(ctx, source); err == nil {
		return nil
	}
	if loadedReference != "" {
		if err := client.ImageTag(ctx, loadedReference, source); err == nil {
			return nil
		}
	}

	images, err := client.ImageList(ctx, image.ListOptions{All: true})
	if err != nil {
		return fmt.Errorf("find loaded image for %s: %w", source, err)
	}
	for _, current := range images {
		if !existingImages[current.ID] {
			if err := client.ImageTag(ctx, current.ID, source); err != nil {
				return fmt.Errorf("tag loaded image %s as %s: %w", current.ID, source, err)
			}
			return nil
		}
	}

	return fmt.Errorf("Docker loaded the archive but did not expose image %s", source)
}

func pushImageToPrivateRegistry(ctx context.Context, source string) (string, error) {
	client, err := imageManagerDockerClient(ctx)
	if err != nil {
		return "", err
	}

	target, err := privateRegistryImage(source)
	if err != nil {
		return "", err
	}

	if _, _, err := client.ImageInspectWithRaw(ctx, source); err != nil {
		return "", fmt.Errorf("inspect downloaded image %s: %w", source, err)
	}
	if err := client.ImageTag(ctx, source, target); err != nil {
		return "", fmt.Errorf("tag %s as %s: %w", source, target, err)
	}

	auth, err := registryAuth(target)
	if err != nil {
		return "", fmt.Errorf("encode registry authentication: %w", err)
	}

	stream, err := client.ImagePush(ctx, target, image.PushOptions{RegistryAuth: auth})
	if err != nil {
		return "", fmt.Errorf("push %s: %w", target, err)
	}
	defer stream.Close()
	if err := dockerPushError(stream); err != nil {
		return "", fmt.Errorf("push %s: %w", target, err)
	}

	distribution, err := client.DistributionInspect(ctx, target, auth)
	if err != nil {
		return "", fmt.Errorf("verify pushed image %s: %w", target, err)
	}
	log.Printf("[INFO] Verified hybrid image %s with digest %s", target, distribution.Descriptor.Digest)

	return target, nil
}

func registryImageExists(ctx context.Context, source string) (bool, error) {
	client, err := imageManagerDockerClient(ctx)
	if err != nil {
		return false, err
	}
	target, err := privateRegistryImage(source)
	if err != nil {
		return false, err
	}
	auth, err := registryAuth(target)
	if err != nil {
		return false, err
	}
	_, err = client.DistributionInspect(ctx, target, auth)
	if err != nil {
		if dockerclient.IsErrNotFound(err) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func ensureImage(ctx context.Context, source string, force bool) error {
	imageManagerLock.Lock()
	defer imageManagerLock.Unlock()

	if !imageManagerEnabled() {
		return shuffle.DownloadDockerImageBackend(&http.Client{Timeout: imagedownloadTimeout}, source)
	}

	if !force {
		exists, err := registryImageExists(ctx, source)
		if err == nil && exists {
			log.Printf("[DEBUG] Hybrid image %s already exists in the private registry", source)
			target, _ := privateRegistryImage(source)
			if err := restartKubernetesAppsUsingImage(ctx, target); err != nil {
				return fmt.Errorf("restart apps using %s: %w", target, err)
			}
			return nil
		}
		if err != nil {
			log.Printf("[WARNING] Failed checking private registry for %s; refreshing it: %s", source, err)
		}
	}

	client, err := imageManagerDockerClient(ctx)
	if err != nil {
		return err
	}
	if err := downloadAndLoadCloudImage(ctx, client, source); err != nil {
		return fmt.Errorf("download and load %s: %w", source, err)
	}

	target, err := pushImageToPrivateRegistry(ctx, source)
	if err != nil {
		return err
	}

	if err := restartKubernetesAppsUsingImage(ctx, target); err != nil {
		return fmt.Errorf("image %s was pushed but app deployments were not restarted: %w", target, err)
	}
	return nil
}

func restartKubernetesAppsUsingImage(ctx context.Context, target string) error {
	clientset, _, err := shuffle.GetKubernetesClient()
	if err != nil {
		return err
	}

	deployments, err := clientset.AppsV1().Deployments(kubernetesNamespace).List(ctx, metav1.ListOptions{
		LabelSelector: "app.kubernetes.io/name=shuffle-app",
	})
	if err != nil {
		return err
	}

	for _, deployment := range deployments.Items {
		matched := false
		for index := range deployment.Spec.Template.Spec.Containers {
			container := &deployment.Spec.Template.Spec.Containers[index]
			if container.Image == target {
				container.ImagePullPolicy = "Always"
				matched = true
			}
		}
		if !matched {
			continue
		}

		if deployment.Spec.Template.Annotations == nil {
			deployment.Spec.Template.Annotations = map[string]string{}
		}
		deployment.Spec.Template.Annotations["shuffle.sh/image-refreshed-at"] = time.Now().UTC().Format(time.RFC3339Nano)
		if _, err := clientset.AppsV1().Deployments(kubernetesNamespace).Update(ctx, &deployment, metav1.UpdateOptions{}); err != nil {
			return fmt.Errorf("restart deployment %s: %w", deployment.Name, err)
		}
	}
	return nil
}

func imageManagerHandler(resp http.ResponseWriter, request *http.Request) {
	resp.Header().Set("Content-Type", "application/json")
	if request.Method == http.MethodGet && request.URL.Path == "/api/v1/images/health" {
		resp.WriteHeader(http.StatusOK)
		resp.Write([]byte(`{"success":true}`))
		return
	}
	if request.Method != http.MethodPost {
		resp.WriteHeader(http.StatusMethodNotAllowed)
		resp.Write([]byte(`{"success":false,"reason":"method not allowed"}`))
		return
	}

	request.Body = http.MaxBytesReader(resp, request.Body, 4096)
	var input imageManagerRequest
	if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
		resp.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(resp).Encode(map[string]any{"success": false, "reason": err.Error()})
		return
	}
	if _, err := privateRegistryImage(input.Image); err != nil {
		resp.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(resp).Encode(map[string]any{"success": false, "reason": err.Error()})
		return
	}

	if err := ensureImage(request.Context(), input.Image, false); err != nil {
		resp.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(resp).Encode(map[string]any{"success": false, "reason": err.Error()})
		return
	}

	target, _ := privateRegistryImage(input.Image)
	json.NewEncoder(resp).Encode(map[string]any{"success": true, "image": target})
}

func startImageManagerServer() {
	if !imageManagerEnabled() {
		return
	}

	address := strings.TrimSpace(os.Getenv("SHUFFLE_ORBORUS_IMAGE_MANAGER_ADDRESS"))
	if address == "" {
		address = defaultImageManagerAddress
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/images/ensure", imageManagerHandler)
	mux.HandleFunc("/api/v1/images/health", imageManagerHandler)

	go func() {
		server := &http.Server{Addr: address, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
		log.Printf("[INFO] Hybrid image manager listening on %s", address)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("[ERROR] Hybrid image manager stopped: %s", err)
		}
	}()
}

func startQueuedImageDownload(ctx context.Context, client *http.Client, request shuffle.ExecutionRequest) {
	key := request.ExecutionId
	if key == "" {
		key = request.ExecutionArgument
	}
	if _, loaded := queuedImageDownloads.LoadOrStore(key, struct{}{}); loaded {
		return
	}

	go func() {
		if err := handleBackendImageDownload(ctx, request.ExecutionArgument); err != nil {
			log.Printf("[ERROR] Hybrid image request %s failed and will remain queued: %s", key, err)
			time.AfterFunc(10*time.Second, func() { queuedImageDownloads.Delete(key) })
			return
		}

		remove := shuffle.ExecutionRequestWrapper{Data: []shuffle.ExecutionRequest{request}}
		if err := sendRemoveRequest(client, remove, baseUrl, environment, auth, org, sleepTime); err != nil {
			log.Printf("[ERROR] Image %s is ready, but its queue request could not be confirmed: %s", request.ExecutionArgument, err)
		}
		queuedImageDownloads.Delete(key)
	}()
}
