package pkg

import (
	"os"
	"testing"
	"time"

	"github.com/shuffle/shuffle-shared"
)

func TestAgentLoopNilPointer(t *testing.T) {
	_ = os.Setenv("STANDALONE", "true")
	_ = os.Setenv("SHUFFLE_STANDALONE", "true")
	startNode := shuffle.Action{
		ID:      "00000000-0000-0000-0000-000000000002",
		AppName: "AI Agent",
		Name:    "agent",
		Label:   "agent",
		Parameters: []shuffle.WorkflowAppActionParameter{
			{Name: "input", Value: "test"},
			{Name: "action", Value: "subflow:osctrl"},
			{Name: "execution_mode", Value: "direct"},
			{Name: "shuffle_ai_url_override", Value: "http://127.0.0.1:1/v1"},
			{Name: "shuffle_ai_apikey_override", Value: "test-key"},
			{Name: "shuffle_ai_model_override", Value: "shuffle-ai"},
			{Name: "shuffle_ai_reasoning_effort_override", Value: "low"},
		},
	}

	exec := shuffle.WorkflowExecution{
		Type:              "AGENT",
		Start:             startNode.ID,
		Status:            "EXECUTING",
		ExecutionId:       "00000000-0000-0000-0000-000000000001",
		WorkflowId:        "00000000-0000-0000-0000-000000000001",
		Authorization:     "standalone-agent-auth",
		ExecutionOrg:      "test-org",
		StartedAt:         time.Now().Unix(),
		ExecutionArgument: "test",
		Workflow: shuffle.Workflow{
			ID:      "00000000-0000-0000-0000-000000000001",
			Name:    "Orborus Agent Loop",
			Start:   startNode.ID,
			OrgId:   "test-org",
			Actions: []shuffle.Action{startNode},
		},
	}

	_, _ = shuffle.HandleAiAgentExecutionStart(exec, startNode, false, "orborus-agent-loop")
}
