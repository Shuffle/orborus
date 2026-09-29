package pkg

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/shuffle/osctrl"
	"github.com/shuffle/shuffle-shared"
)

// AgentStatus represents the current state of the agent
type AgentStatus struct {
	Connected     bool
	Message       string
	LastPoll      time.Time
	JobsProcessed int
}

// StartAgentLoop runs the agent. If in standalone mode, no workers are started.
func StartAgentLoop(ctx context.Context, cfg *Config, onStatus func(AgentStatus)) error {
	if cfg.IsStandalone {
		log.Printf("[INFO] Running in full standalone mode (no base_url). No background workers started.")
		if onStatus != nil {
			onStatus(AgentStatus{
				Connected:     true,
				Message:       "Standalone (Local)",
				LastPoll:      time.Now(),
				JobsProcessed: 0,
			})
		}
		// In standalone mode, there are no background workers polling.
		// Wait until shutdown signal.
		<-ctx.Done()
		return nil
	}

	return runRemoteQueueLoop(ctx, cfg, onStatus)
}

func runRemoteQueueLoop(ctx context.Context, cfg *Config, onStatus func(AgentStatus)) error {
	fullURL := fmt.Sprintf("%s/api/v1/workflows/queue", cfg.BaseURL)
	confirmURL := fmt.Sprintf("%s/api/v1/workflows/queue/confirm", cfg.BaseURL)
	client := shuffle.GetExternalClient(cfg.BaseURL)

	log.Printf("[INFO] Starting agent queue worker targeting %s (Env: %s, Host: %s)", fullURL, cfg.Environment, cfg.Hostname)

	currentSleep := cfg.PullTime
	lastJobTime := int64(-1)
	jobsProcessed := 0

	for {
		select {
		case <-ctx.Done():
			log.Printf("[INFO] Stopping agent queue worker")
			return nil
		default:
		}

		now := time.Now().Unix()
		if currentSleep != cfg.PullTime && lastJobTime != -1 && now-lastJobTime > 60 {
			if cfg.Debug {
				log.Printf("[DEBUG] Resetting pull interval to default (%d seconds)", cfg.PullTime)
			}
			currentSleep = cfg.PullTime
		}

		statsCtx, statsCancel := context.WithTimeout(ctx, 10*time.Second)
		stats := CollectSensorStats(statsCtx, cfg)
		statsCancel()

		statsBytes, err := json.Marshal(stats)
		if err != nil {
			log.Printf("[ERROR] Failed marshalling sensor stats: %v", err)
			statsBytes = []byte("{}")
		}

		req, err := http.NewRequestWithContext(ctx, "POST", fullURL, bytes.NewBuffer(statsBytes))
		if err != nil {
			log.Printf("[ERROR] Failed creating queue request: %v", err)
			if onStatus != nil {
				onStatus(AgentStatus{
					Connected:     false,
					Message:       fmt.Sprintf("Request Error: %v", err),
					LastPoll:      time.Now(),
					JobsProcessed: jobsProcessed,
				})
			}
			time.Sleep(time.Duration(currentSleep) * time.Second)
			continue
		}

		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Org-Id", cfg.Environment)
		if cfg.Auth != "" {
			req.Header.Set("Authorization", cfg.Auth)
		}
		if cfg.Org != "" {
			req.Header.Set("Org", cfg.Org)
		}
		if cfg.OrborusLabel != "" {
			req.Header.Set("X-Orborus-Label", cfg.OrborusLabel)
		}
		req.Header.Set("X-Orborus-Runmode", "Sensor Mode")

		isDebug := cfg.Debug || strings.EqualFold(os.Getenv("DEBUG"), "true") || os.Getenv("DEBUG") == "1"
		if isDebug {
			log.Printf("[DEBUG] Sending queue poll request to %s (Env: %s, Org: %s, Hostname: %s)", fullURL, cfg.Environment, cfg.Org, cfg.Hostname)
		}

		resp, err := client.Do(req)
		if err != nil || resp == nil {
			log.Printf("[WARNING] Queue poll request failed: %v", err)
			if onStatus != nil {
				onStatus(AgentStatus{
					Connected:     false,
					Message:       "Connection Failed",
					LastPoll:      time.Now(),
					JobsProcessed: jobsProcessed,
				})
			}
			time.Sleep(time.Duration(currentSleep) * time.Second)
			continue
		}

		var body []byte
		if resp.Body != nil {
			body, _ = io.ReadAll(resp.Body)
			resp.Body.Close()
		}

		if isDebug {
			log.Printf("[DEBUG] Queue poll response: HTTP %d (Body bytes: %d)", resp.StatusCode, len(body))
		}

		if resp.StatusCode == 409 {
			log.Printf("[WARNING] Another agent or Orborus instance is already active for this environment. Retrying in 30s...")
			if onStatus != nil {
				onStatus(AgentStatus{
					Connected:     false,
					Message:       "Another Instance Active (409)",
					LastPoll:      time.Now(),
					JobsProcessed: jobsProcessed,
				})
			}
			time.Sleep(30 * time.Second)
			continue
		}

		if resp.StatusCode != 200 {
			log.Printf("[WARNING] Queue poll returned unexpected status %d: %s", resp.StatusCode, string(body))
			if onStatus != nil {
				onStatus(AgentStatus{
					Connected:     false,
					Message:       fmt.Sprintf("HTTP %d", resp.StatusCode),
					LastPoll:      time.Now(),
					JobsProcessed: jobsProcessed,
				})
			}
			time.Sleep(time.Duration(currentSleep) * time.Second)
			continue
		}

		var queueResp shuffle.ExecutionRequestWrapper
		if err := json.Unmarshal(body, &queueResp); err != nil {
			log.Printf("[ERROR] Failed to unmarshal queue response: %v", err)
			time.Sleep(time.Duration(currentSleep) * time.Second)
			continue
		}

		if isDebug {
			log.Printf("[DEBUG] Queue poll successful: %d action(s) retrieved", len(queueResp.Data))
		}

		if onStatus != nil {
			onStatus(AgentStatus{
				Connected:     true,
				Message:       "Online",
				LastPoll:      time.Now(),
				JobsProcessed: jobsProcessed,
			})
		}

		if len(queueResp.Data) > 0 {
			var toBeRemoved shuffle.ExecutionRequestWrapper

			for _, incRequest := range queueResp.Data {
				parsedHostname := incRequest.ExecutionSource
				if strings.Contains(parsedHostname, ".") {
					parsedHostname = strings.Split(parsedHostname, ".")[0]
				}

				isMatch := parsedHostname == cfg.Hostname ||
					strings.HasSuffix(incRequest.ExecutionSource, cfg.MachineID) ||
					incRequest.ExecutionSource == ""

				if !isMatch {
					continue
				}

				log.Printf("[INFO] Handling action for this host: %s (ID: %s)", incRequest.ExecutionArgument, incRequest.ExecutionId)

				go osctrl.HandleSensorResponseAction(cfg.Hostname, cfg.SensorMode, incRequest)

				toBeRemoved.Data = append(toBeRemoved.Data, incRequest)
				jobsProcessed++
				lastJobTime = time.Now().Unix()
				currentSleep = 1
			}

			if len(toBeRemoved.Data) > 0 {
				confirmBody, _ := json.Marshal(toBeRemoved)
				confirmReq, err := http.NewRequestWithContext(ctx, "POST", confirmURL, bytes.NewBuffer(confirmBody))
				if err == nil {
					confirmReq.Header.Set("Content-Type", "application/json")
					confirmReq.Header.Set("Org-Id", cfg.Environment)
					if cfg.Auth != "" {
						confirmReq.Header.Set("Authorization", cfg.Auth)
					}
					if cfg.Org != "" {
						confirmReq.Header.Set("Org", cfg.Org)
					}
					confirmResp, err := client.Do(confirmReq)
					if err == nil && confirmResp != nil && confirmResp.Body != nil {
						confirmResp.Body.Close()
					}
				}
			}
		}

		time.Sleep(time.Duration(currentSleep) * time.Second)
	}
}
