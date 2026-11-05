package pkg

import (
	"fmt"
	"strings"
	"testing"
)

func TestRollingConversationSummaryAndReuse(t *testing.T) {
	conv := &Conversation{
		ID:    "", // empty ID avoids writing to ~/.shuffle/conversations during unit test
		Title: "Rolling Summary Test",
	}

	summarizeCalls := 0
	mockSummarizer := func(existingSummary, batchTranscript string) (string, error) {
		summarizeCalls++
		if existingSummary != "" {
			return existingSummary + "\n---\n" + batchTranscript, nil
		}
		return batchTranscript, nil
	}

	// 1. Add 10 turns (within HistoryResummarizeTurnThreshold = 10 and under char threshold)
	for i := 1; i <= 10; i++ {
		conv.Turns = append(conv.Turns, ConversationTurn{
			ID:     fmt.Sprintf("turn-%d", i),
			Prompt: fmt.Sprintf("User question %d", i),
			Output: fmt.Sprintf("Assistant answer %d", i),
			Status: "success",
		})
	}

	block, recentCount, sumCount, reused, updated := BuildConversationHistoryContext(conv, mockSummarizer)
	if updated || reused || sumCount != 0 || recentCount != 10 || summarizeCalls != 0 {
		t.Fatalf("expected 10 turns to stay unsummarized: recent=%d sum=%d reused=%v updated=%v calls=%d",
			recentCount, sumCount, reused, updated, summarizeCalls)
	}
	if !strings.Contains(block, "User question 1") || !strings.Contains(block, "User question 10") {
		t.Fatalf("expected all 10 turns in history block")
	}

	// 2. Add Turn 11 -> crosses HistoryResummarizeTurnThreshold (11 > 10).
	// Should summarize turns 1..5 (leaving HistoryRecentTurnsKeep = 6 verbatim: turns 6..11).
	conv.Turns = append(conv.Turns, ConversationTurn{
		ID:     "turn-11",
		Prompt: "User question 11",
		Output: "Assistant answer 11",
		Status: "success",
	})

	block, recentCount, sumCount, reused, updated = BuildConversationHistoryContext(conv, mockSummarizer)
	if !updated || reused || sumCount != 5 || recentCount != 6 || summarizeCalls != 1 {
		t.Fatalf("expected turn 11 to summarize first 5 turns: recent=%d sum=%d reused=%v updated=%v calls=%d",
			recentCount, sumCount, reused, updated, summarizeCalls)
	}
	if !strings.Contains(block, "Summary of earlier conversation (turns 1–5):") {
		t.Fatalf("expected summary header for turns 1-5, got:\n%s", block)
	}
	if !strings.Contains(block, "User question 1") || !strings.Contains(block, "User question 11") {
		t.Fatalf("expected both summarized turn 1 and recent turn 11 to be present in context")
	}

	// 3. Turns 12, 13, 14, 15 -> should REUSE the summary of turns 1..5 without calling mockSummarizer again!
	for i := 12; i <= 15; i++ {
		conv.Turns = append(conv.Turns, ConversationTurn{
			ID:     fmt.Sprintf("turn-%d", i),
			Prompt: fmt.Sprintf("User question %d", i),
			Output: fmt.Sprintf("Assistant answer %d", i),
			Status: "success",
		})
		block, recentCount, sumCount, reused, updated = BuildConversationHistoryContext(conv, mockSummarizer)
		expectedRecent := i - 5
		if updated || !reused || sumCount != 5 || recentCount != expectedRecent || summarizeCalls != 1 {
			t.Fatalf("turn %d expected summary reuse: recent=%d (want %d) sum=%d reused=%v updated=%v calls=%d",
				i, recentCount, expectedRecent, sumCount, reused, updated, summarizeCalls)
		}
	}

	// 4. Turn 16 -> unsummarized turns = 16 - 5 = 11 (> 10).
	// Should trigger incremental re-summarization of turns 6..10, advancing SummarizedTurnCount to 10
	// and keeping turns 11..16 (6 turns) verbatim.
	conv.Turns = append(conv.Turns, ConversationTurn{
		ID:     "turn-16",
		Prompt: "User question 16",
		Output: "Assistant answer 16",
		Status: "success",
	})

	block, recentCount, sumCount, reused, updated = BuildConversationHistoryContext(conv, mockSummarizer)
	if !updated || reused || sumCount != 10 || recentCount != 6 || summarizeCalls != 2 {
		t.Fatalf("turn 16 expected incremental resummarization to 10 turns: recent=%d sum=%d reused=%v updated=%v calls=%d",
			recentCount, sumCount, reused, updated, summarizeCalls)
	}
	if !strings.Contains(block, "Summary of earlier conversation (turns 1–10):") {
		t.Fatalf("expected summary header for turns 1-10, got:\n%s", block)
	}
	if !strings.Contains(block, "User question 1") || !strings.Contains(block, "User question 8") || !strings.Contains(block, "User question 16") {
		t.Fatalf("expected rolling summary to retain turns 1 and 8 alongside recent turn 16")
	}
}

func TestStructuredFallbackSummaryOnCharThreshold(t *testing.T) {
	conv := &Conversation{
		ID:    "",
		Title: "Char Threshold Fallback Test",
	}

	// Add 9 turns with large outputs (>12,000 chars total across unsummarized turns)
	largeChunk := strings.Repeat("detailed log line with important metrics ", 50) // ~2050 chars per turn
	for i := 1; i <= 9; i++ {
		conv.Turns = append(conv.Turns, ConversationTurn{
			ID:     fmt.Sprintf("turn-%d", i),
			Prompt: fmt.Sprintf("Analyze service %d", i),
			Output: fmt.Sprintf("Service %d findings: %s", i, largeChunk),
			Status: "success",
			Steps: []ConversationStep{
				{Name: "Ran healthcheck", Type: "cmd"},
			},
		})
	}

	// Pass nil llmSummarizeFn to verify deterministic structured fallback
	block, recentCount, sumCount, reused, updated := BuildConversationHistoryContext(conv, nil)
	if !updated || reused || sumCount != 3 || recentCount != 6 {
		t.Fatalf("expected char threshold to summarize first 3 turns and keep 6: recent=%d sum=%d reused=%v updated=%v",
			recentCount, sumCount, reused, updated)
	}
	if !strings.Contains(block, "Summary of earlier conversation (turns 1–3):") {
		t.Fatalf("expected summary header for turns 1-3")
	}
	if !strings.Contains(block, "Turn 1 — User: Analyze service 1") {
		t.Fatalf("expected structured summary to include Turn 1 user prompt")
	}
}
