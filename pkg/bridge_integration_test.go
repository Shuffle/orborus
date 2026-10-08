package pkg

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/shuffle/shuffle-shared"
)

// TestUiPromptToLocalLlmIntegration simulates a UI request arriving at the AgentBridge,
// verifying that it routes to the local LLM by default and completes the execution cycle.
func TestUiPromptToLocalLlmIntegration(t *testing.T) {
	// Track incoming request details at the local LLM server
	type receivedRequest struct {
		Path            string
		Method          string
		AuthHeader      string
		Model           string
		ReasoningEffort string
		PromptContent   string
	}

	receivedChan := make(chan receivedRequest, 10)

	// Spin up local OpenAI-compatible HTTP test server acting as the local LLM (Tendon/llama-server)
	mockLocalLlm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bodyBytes, _ := io.ReadAll(r.Body)

		var reqData struct {
			Stream          bool   `json:"stream"`
			Model           string `json:"model"`
			ReasoningEffort string `json:"reasoning_effort"`
			Messages        []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.Unmarshal(bodyBytes, &reqData)

		var lastUserContent string
		for _, m := range reqData.Messages {
			if m.Role == "user" {
				lastUserContent = m.Content
			}
		}

		receivedChan <- receivedRequest{
			Path:            r.URL.Path,
			Method:          r.Method,
			AuthHeader:      r.Header.Get("Authorization"),
			Model:           reqData.Model,
			ReasoningEffort: reqData.ReasoningEffort,
			PromptContent:   lastUserContent,
		}

		if reqData.Stream {
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-cache")
			w.WriteHeader(http.StatusOK)
			_, _ = fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Result: 4\"}}]}\n\n")
			_, _ = fmt.Fprintf(w, "data: [DONE]\n\n")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		respJSON := `{
			"id": "chatcmpl-test-123",
			"object": "chat.completion",
			"created": 1700000000,
			"model": "` + reqData.Model + `",
			"choices": [
				{
					"index": 0,
					"message": {
						"role": "assistant",
						"content": "Result: 4"
					},
					"finish_reason": "stop"
				}
			]
		}`
		_, _ = w.Write([]byte(respJSON))
	}))
	defer mockLocalLlm.Close()

	// Initialize AgentBridge in standalone mode
	bridge := NewAgentBridge(&Config{
		Debug:        true,
		IsStandalone: true,
	})

	bridge.mu.Lock()
	bridge.aiModel = "local"
	bridge.aiApiUrl = mockLocalLlm.URL + "/v1"
	bridge.mu.Unlock()

	// Simulate incoming UI action: { action: "runPrompt", payload: JSON }
	uiPayload := map[string]interface{}{
		"prompt":          "What is 2 + 2?",
		"conversation_id": "test-conv-backend-integration",
		"model":           "local",
		"reasoning":       "low",
		"bypass":          true,
		"ai_api_url":      mockLocalLlm.URL + "/v1",
		"ai_api_key":      "test-local-token",
	}
	payloadBytes, err := json.Marshal(uiPayload)
	if err != nil {
		t.Fatalf("Failed to marshal UI payload: %v", err)
	}

	// Dispatch UI action directly to bridge
	responseJSON := bridge.HandleAction("runPrompt", string(payloadBytes))

	// Verify the local LLM received the request with the expected parameters
	select {
	case req := <-receivedChan:
		if !strings.HasSuffix(req.Path, "/chat/completions") {
			t.Errorf("Expected path ending in /chat/completions, got: %s", req.Path)
		}
		if req.Method != http.MethodPost {
			t.Errorf("Expected POST request, got: %s", req.Method)
		}
		if !strings.Contains(req.AuthHeader, "test-local-token") {
			t.Errorf("Expected Bearer test-local-token, got: %s", req.AuthHeader)
		}
		if req.ReasoningEffort != "low" {
			t.Errorf("Expected reasoning_effort 'low', got: %s", req.ReasoningEffort)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Timed out waiting for request to reach local LLM server")
	}

	// Verify the bridge returned a success status and execution entry to the UI
	var entry ExecutionEntry
	if err := json.Unmarshal([]byte(responseJSON), &entry); err != nil {
		t.Fatalf("Failed to unmarshal bridge response: %v, raw response: %s", err, responseJSON)
	}

	if entry.Status != "success" {
		t.Errorf("Expected entry status 'success', got %q (error: %s)", entry.Status, entry.Error)
	}
	if !strings.Contains(entry.Output, "4") {
		t.Errorf("Expected output to contain '4', got: %q", entry.Output)
	}
	if entry.WorkflowExecution == nil {
		t.Fatal("Expected entry.WorkflowExecution to be non-nil")
	}
	if entry.WorkflowExecution.Status != "FINISHED" {
		t.Errorf("Expected WorkflowExecution.Status 'FINISHED', got %q", entry.WorkflowExecution.Status)
	}
}

// TestHandleAiAgentExecutionStartOverrides verifies that HandleAiAgentExecutionStart
// parses shuffle_ai_*_override parameters from startNode and passes them cleanly to RunAiQuery.
func TestHandleAiAgentExecutionStartOverrides(t *testing.T) {
	type receivedRequest struct {
		Model           string
		AuthHeader      string
		ReasoningEffort string
	}
	receivedChan := make(chan receivedRequest, 5)

	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bodyBytes, _ := io.ReadAll(r.Body)
		var reqData struct {
			Stream          bool   `json:"stream"`
			Model           string `json:"model"`
			ReasoningEffort string `json:"reasoning_effort"`
		}
		_ = json.Unmarshal(bodyBytes, &reqData)

		receivedChan <- receivedRequest{
			Model:           reqData.Model,
			AuthHeader:      r.Header.Get("Authorization"),
			ReasoningEffort: reqData.ReasoningEffort,
		}

		if reqData.Stream {
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-cache")
			w.WriteHeader(http.StatusOK)
			chunk := `[{"tool": "finish", "action": "finish", "reason": "All tasks complete"}]`
			respChunk, _ := json.Marshal(map[string]interface{}{
				"choices": []map[string]interface{}{
					{
						"delta": map[string]string{
							"content": chunk,
						},
					},
				},
			})
			_, _ = fmt.Fprintf(w, "data: %s\n\n", string(respChunk))
			_, _ = fmt.Fprintf(w, "data: [DONE]\n\n")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		// Return valid agent JSON response format expected by HandleAiAgentExecutionStart
		_, _ = w.Write([]byte(`{
			"id": "chatcmpl-agent-test",
			"object": "chat.completion",
			"created": 1700000000,
			"model": "test-agent-model",
			"choices": [
				{
					"index": 0,
					"message": {
						"role": "assistant",
						"content": "[{\"tool\": \"finish\", \"action\": \"finish\", \"reason\": \"All tasks complete\"}]"
					},
					"finish_reason": "stop"
				}
			]
		}`))
	}))
	defer mockServer.Close()

	execID := fmt.Sprintf("test-exec-%d", time.Now().UnixNano())
	actionID := fmt.Sprintf("test-act-%d", time.Now().UnixNano())

	startNode := shuffle.Action{
		ID:      actionID,
		AppName: "shuffle-ai",
		Name:    "run_agent",
		Parameters: []shuffle.WorkflowAppActionParameter{
			{Name: "input", Value: "Run the security audit"},
			{Name: "shuffle_ai_url_override", Value: mockServer.URL + "/v1"},
			{Name: "shuffle_ai_apikey_override", Value: "test-override-key-1234"},
			{Name: "shuffle_ai_model_override", Value: "override-custom-model"},
			{Name: "shuffle_ai_reasoning_effort_override", Value: "high"},
		},
	}

	workflowExec := shuffle.WorkflowExecution{
		ExecutionId:  execID,
		Status:       "EXECUTING",
		WorkflowId:   "test-wf",
		ExecutionOrg: "test-org",
		Workflow: shuffle.Workflow{
			ID:    "test-wf",
			OrgId: "test-org",
			Actions: []shuffle.Action{
				startNode,
			},
		},
	}

	// Execute HandleAiAgentExecutionStart with the overridden startNode
	returnedAction, err := shuffle.HandleAiAgentExecutionStart(workflowExec, startNode, false, "TestHandleAiAgentExecutionStartOverrides")
	if err != nil {
		t.Logf("HandleAiAgentExecutionStart completed with: %v (returnedAction: %s)", err, returnedAction.ID)
	}

	// Verify the mock server received the request with the overridden URL, Model, Key, and Reasoning
	select {
	case req := <-receivedChan:
		if req.Model != "override-custom-model" {
			t.Errorf("Expected model 'override-custom-model', got: %s", req.Model)
		}
		if !strings.Contains(req.AuthHeader, "test-override-key-1234") {
			t.Errorf("Expected Bearer test-override-key-1234, got: %s", req.AuthHeader)
		}
		if req.ReasoningEffort != "high" {
			t.Errorf("Expected reasoning_effort 'high', got: %s", req.ReasoningEffort)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Timed out waiting for request to reach mock server via HandleAiAgentExecutionStart")
	}
}
