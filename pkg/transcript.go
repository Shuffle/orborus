package pkg

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	shuffle "github.com/shuffle/shuffle-shared"
)

var convFileMu sync.Mutex

// ConversationStep represents a single step within a turn (e.g. command run, thought, or tool call)
type ConversationStep struct {
	ID        string             `json:"id"`
	Name      string             `json:"name"`
	Duration  string             `json:"duration,omitempty"`
	Detail    string             `json:"detail,omitempty"`
	Type      string             `json:"type,omitempty"` // "thought", "cmd", "file", "group", "approval_pending"
	Collapsed bool               `json:"collapsed,omitempty"`
	Steps     []ConversationStep `json:"steps,omitempty"`
}

// FileChangeDetail represents a single modified, added, or deleted file
type FileChangeDetail struct {
	Path      string `json:"path"`
	Status    string `json:"status"` // "modified", "added", "deleted"
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Diff      string `json:"diff,omitempty"`
}

// ChangedFilesSummary captures changed files and line delta
type ChangedFilesSummary struct {
	TotalFiles int                `json:"total_files"`
	Additions  int                `json:"additions"`
	Deletions  int                `json:"deletions"`
	Files      []FileChangeDetail `json:"files,omitempty"`
}

// ConversationTurn represents one complete user request and the agent's corresponding output & activity
type ConversationTurn struct {
	ID                string                     `json:"id"`
	Prompt            string                     `json:"prompt"`
	Timestamp         string                     `json:"timestamp"`
	Steps             []ConversationStep         `json:"steps,omitempty"`
	Output            string                     `json:"output,omitempty"`
	Status            string                     `json:"status"` // "success" or "error"
	Duration          string                     `json:"duration,omitempty"`
	Error             string                     `json:"error,omitempty"`
	ErrorType         string                     `json:"error_type,omitempty"`
	FixHelp           string                     `json:"fix_help,omitempty"`
	DebugInfo         map[string]interface{}     `json:"debug_info,omitempty"`
	ChangedFiles      *ChangedFilesSummary       `json:"changed_files,omitempty"`
	WorkflowExecution *shuffle.WorkflowExecution `json:"workflow_execution,omitempty"`
}

// Conversation represents a persistent multi-turn chat session stored on disk
type Conversation struct {
	ID                  string             `json:"id"`
	Title               string             `json:"title"`
	ProjectID           string             `json:"project_id"`
	ProjectName         string             `json:"project_name"`
	CreatedAt           string             `json:"created_at"`
	UpdatedAt           string             `json:"updated_at"`
	Pinned              bool               `json:"pinned"`
	Archived            bool               `json:"archived"`
	Summary             string             `json:"summary,omitempty"`
	SummarizedTurnCount int                `json:"summarized_turn_count,omitempty"`
	SummaryUpdatedAt    string             `json:"summary_updated_at,omitempty"`
	Turns               []ConversationTurn `json:"turns"`
}

// GetConversationsDir returns ~/.shuffle/conversations, ensuring the directory exists
func GetConversationsDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = os.Getenv("HOME")
	}
	if home == "" {
		return ""
	}
	dir := filepath.Join(home, ".shuffle", "conversations")
	if err := os.MkdirAll(dir, 0755); err != nil {
		log.Printf("[WARNING] Failed to create conversations directory %s: %v", dir, err)
	}
	return dir
}

// getConversationFilePath returns the path to a specific conversation JSON file
func getConversationFilePath(id string) string {
	dir := GetConversationsDir()
	if dir == "" || id == "" {
		return ""
	}
	// Sanitize file name to avoid directory traversal
	cleanID := filepath.Base(id)
	cleanID = strings.ReplaceAll(cleanID, "..", "")
	cleanID = strings.ReplaceAll(cleanID, "/", "_")
	cleanID = strings.ReplaceAll(cleanID, "\\", "_")
	if !strings.HasSuffix(cleanID, ".json") {
		cleanID = cleanID + ".json"
	}
	return filepath.Join(dir, cleanID)
}

// isIncompleteTurn returns true if the turn represents an unfinished optimistic placeholder turn
func isIncompleteTurn(t ConversationTurn) bool {
	if strings.TrimSpace(t.Output) != "" || strings.TrimSpace(t.Error) != "" {
		return false
	}
	st := strings.ToLower(strings.TrimSpace(t.Status))
	return st == "" || st == "running" || st == "in_progress" || st == "interrupted" || st == "pending"
}

// sanitizeConversationTurns collapses any incomplete optimistic turn that is immediately followed by a turn with the same prompt
func sanitizeConversationTurns(turns []ConversationTurn) []ConversationTurn {
	if len(turns) <= 1 {
		return turns
	}
	cleaned := make([]ConversationTurn, 0, len(turns))
	for i := 0; i < len(turns); i++ {
		cur := turns[i]
		if i+1 < len(turns) && isIncompleteTurn(cur) {
			next := turns[i+1]
			if strings.EqualFold(strings.TrimSpace(cur.Prompt), strings.TrimSpace(next.Prompt)) && strings.TrimSpace(cur.Prompt) != "" {
				continue
			}
		}
		cleaned = append(cleaned, cur)
	}
	return cleaned
}

// SaveConversation writes the conversation to ~/.shuffle/conversations/<id>.json
func SaveConversation(conv *Conversation) error {
	if conv == nil || conv.ID == "" {
		return fmt.Errorf("invalid conversation")
	}

	convFileMu.Lock()
	defer convFileMu.Unlock()

	filePath := getConversationFilePath(conv.ID)
	if filePath == "" {
		return fmt.Errorf("failed to determine conversation file path")
	}

	if conv.UpdatedAt == "" {
		conv.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	if conv.CreatedAt == "" {
		conv.CreatedAt = conv.UpdatedAt
	}
	conv.Turns = sanitizeConversationTurns(conv.Turns)

	// Preserve existing rolling summary metadata if caller (e.g. UI state save) omitted it
	if conv.Summary == "" && conv.SummarizedTurnCount == 0 {
		if existingBytes, errRead := os.ReadFile(filePath); errRead == nil {
			var existingConv Conversation
			if errUnmarshal := json.Unmarshal(existingBytes, &existingConv); errUnmarshal == nil {
				if existingConv.Summary != "" && existingConv.SummarizedTurnCount > 0 && len(conv.Turns) >= existingConv.SummarizedTurnCount {
					conv.Summary = existingConv.Summary
					conv.SummarizedTurnCount = existingConv.SummarizedTurnCount
					conv.SummaryUpdatedAt = existingConv.SummaryUpdatedAt
				}
			}
		}
	}
	if conv.SummarizedTurnCount > len(conv.Turns) {
		conv.Summary = ""
		conv.SummarizedTurnCount = 0
		conv.SummaryUpdatedAt = ""
	}

	data, err := json.MarshalIndent(conv, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to serialize conversation: %w", err)
	}

	if err := os.WriteFile(filePath, data, 0644); err != nil {
		return fmt.Errorf("failed to write conversation file: %w", err)
	}

	return nil
}

// LoadConversation reads a conversation from disk by ID
func LoadConversation(id string) (*Conversation, error) {
	if id == "" {
		return nil, fmt.Errorf("empty conversation id")
	}

	convFileMu.Lock()
	defer convFileMu.Unlock()

	filePath := getConversationFilePath(id)
	if filePath == "" {
		return nil, fmt.Errorf("invalid conversation path")
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}

	var conv Conversation
	if err := json.Unmarshal(data, &conv); err != nil {
		return nil, fmt.Errorf("failed to parse conversation file: %w", err)
	}

	if conv.Turns == nil {
		conv.Turns = []ConversationTurn{}
	} else {
		conv.Turns = sanitizeConversationTurns(conv.Turns)
	}

	return &conv, nil
}

// ListConversations reads all conversation files from ~/.shuffle/conversations
func ListConversations() ([]Conversation, error) {
	convFileMu.Lock()
	defer convFileMu.Unlock()

	dir := GetConversationsDir()
	if dir == "" {
		return []Conversation{}, nil
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return []Conversation{}, err
	}

	var list []Conversation
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}

		fullPath := filepath.Join(dir, entry.Name())
		data, err := os.ReadFile(fullPath)
		if err != nil {
			continue
		}

		var conv Conversation
		if err := json.Unmarshal(data, &conv); err != nil {
			continue
		}
		if conv.ID == "" {
			conv.ID = strings.TrimSuffix(entry.Name(), ".json")
		}
		if conv.Turns == nil {
			conv.Turns = []ConversationTurn{}
		} else {
			origLen := len(conv.Turns)
			conv.Turns = sanitizeConversationTurns(conv.Turns)
			if len(conv.Turns) != origLen {
				if cleanedData, mErr := json.MarshalIndent(conv, "", "  "); mErr == nil {
					_ = os.WriteFile(fullPath, cleanedData, 0644)
				}
			}
		}

		list = append(list, conv)
	}

	// Sort conversations: Pinned first, then by UpdatedAt descending
	sort.Slice(list, func(i, j int) bool {
		if list[i].Pinned != list[j].Pinned {
			return list[i].Pinned
		}
		return list[i].UpdatedAt > list[j].UpdatedAt
	})

	return list, nil
}

// DeleteConversation deletes the conversation file for the given ID
func DeleteConversation(id string) error {
	if id == "" {
		return fmt.Errorf("empty conversation id")
	}

	convFileMu.Lock()
	defer convFileMu.Unlock()

	filePath := getConversationFilePath(id)
	if filePath == "" {
		return fmt.Errorf("invalid conversation path")
	}

	if err := os.Remove(filePath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to remove conversation file: %w", err)
	}

	return nil
}

// ClearAllConversations removes all stored conversations
func ClearAllConversations() error {
	convFileMu.Lock()
	defer convFileMu.Unlock()

	dir := GetConversationsDir()
	if dir == "" {
		return nil
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			_ = os.Remove(filepath.Join(dir, entry.Name()))
		}
	}

	return nil
}

// AppendTurnToConversation appends a turn to an existing or new conversation and persists it to disk
func AppendTurnToConversation(convID string, turn ConversationTurn, projectID, projectName string) (*Conversation, error) {
	if convID == "" {
		convID = fmt.Sprintf("conv-%d", time.Now().UnixMilli())
	}

	// Try loading existing conversation, or create new
	conv, err := LoadConversation(convID)
	if err != nil || conv == nil {
		nowStr := time.Now().UTC().Format(time.RFC3339)
		title := turn.Prompt
		firstLine := strings.Split(strings.TrimSpace(title), "\n")[0]
		if len(firstLine) > 40 {
			firstLine = strings.TrimSpace(firstLine[:40]) + "..."
		}
		if firstLine == "" {
			firstLine = "Conversation"
		}

		pName := projectName
		if pName == "" && projectID != "" {
			pName = filepath.Base(projectID)
		}
		if pName == "" || pName == "." {
			pName = "Local Workspace"
		}

		conv = &Conversation{
			ID:          convID,
			Title:       firstLine,
			ProjectID:   projectID,
			ProjectName: pName,
			CreatedAt:   nowStr,
			UpdatedAt:   nowStr,
			Pinned:      false,
			Turns:       []ConversationTurn{},
		}
	}

	// Update metadata
	conv.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	if projectID != "" && (conv.ProjectID == "" || conv.ProjectID == ".") {
		conv.ProjectID = projectID
		if projectName != "" {
			conv.ProjectName = projectName
		}
	}

	// If title is default and this is the first turn, derive a clean title
	if (conv.Title == "" || conv.Title == "New Conversation" || conv.Title == "Conversation") && turn.Prompt != "" {
		firstLine := strings.Split(strings.TrimSpace(turn.Prompt), "\n")[0]
		if len(firstLine) > 40 {
			firstLine = strings.TrimSpace(firstLine[:40]) + "..."
		}
		conv.Title = firstLine
	}

	// Replace trailing incomplete optimistic turn with the same prompt instead of duplicating it
	if len(conv.Turns) > 0 {
		lastIdx := len(conv.Turns) - 1
		lastTurn := conv.Turns[lastIdx]
		if isIncompleteTurn(lastTurn) && strings.EqualFold(strings.TrimSpace(lastTurn.Prompt), strings.TrimSpace(turn.Prompt)) {
			conv.Turns[lastIdx] = turn
		} else {
			conv.Turns = append(conv.Turns, turn)
		}
	} else {
		conv.Turns = append(conv.Turns, turn)
	}
	conv.Turns = sanitizeConversationTurns(conv.Turns)

	if err := SaveConversation(conv); err != nil {
		log.Printf("[ERROR] Failed to save conversation %s to disk: %v", convID, err)
		return conv, err
	}

	log.Printf("[INFO] Saved conversation %s (turns: %d) to %s", convID, len(conv.Turns), getConversationFilePath(convID))
	return conv, nil
}

const (
	// HistoryRecentTurnsKeep is the number of most recent completed turns kept verbatim when summarizing.
	HistoryRecentTurnsKeep = 6
	// HistoryResummarizeTurnThreshold is the number of unsummarized turns allowed before triggering a summary update.
	// Because HistoryRecentTurnsKeep is 6, a cached summary is reused across at least 4 subsequent turns (7..10) before re-summarizing.
	HistoryResummarizeTurnThreshold = 10
	// HistoryMinBatchTurnsToSummarize is the minimum number of newly aged turns required before re-summarizing on character volume.
	HistoryMinBatchTurnsToSummarize = 3
	// HistoryResummarizeCharThreshold triggers summarization when unsummarized turn text exceeds this character budget.
	HistoryResummarizeCharThreshold = 12000
	// HistoryRecentTurnOutputMaxChars is the maximum characters included per recent verbatim assistant turn (using head+tail preservation).
	HistoryRecentTurnOutputMaxChars = 2400
	// HistorySummaryMaxChars caps the total stored rolling summary size so long conversations remain bounded.
	HistorySummaryMaxChars = 3200
)

// truncateHeadTail preserves both the beginning and the conclusion of a string when truncating.
func truncateHeadTail(s string, maxChars int) string {
	s = strings.TrimSpace(s)
	if maxChars <= 0 || len(s) <= maxChars {
		return s
	}
	headLen := (maxChars * 3) / 5
	tailLen := maxChars - headLen - 32
	if tailLen < 120 {
		return s[:maxChars] + "..."
	}
	return strings.TrimSpace(s[:headLen]) + "\n... [middle omitted] ...\n" + strings.TrimSpace(s[len(s)-tailLen:])
}

// summarizeTurnActivity extracts a concise one-line summary of tools/commands run and files changed in a turn.
func summarizeTurnActivity(t ConversationTurn) string {
	var actions []string
	var collectSteps func(steps []ConversationStep)
	collectSteps = func(steps []ConversationStep) {
		for _, st := range steps {
			if st.Type == "thought" {
				continue
			}
			name := strings.TrimSpace(st.Name)
			if name != "" && len(actions) < 6 {
				actions = append(actions, name)
			}
			if len(st.Steps) > 0 {
				collectSteps(st.Steps)
			}
		}
	}
	collectSteps(t.Steps)

	var files []string
	if t.ChangedFiles != nil {
		for _, f := range t.ChangedFiles.Files {
			if strings.TrimSpace(f.Path) != "" && len(files) < 6 {
				files = append(files, fmt.Sprintf("%s (%s)", f.Path, f.Status))
			}
		}
	}

	var parts []string
	if len(actions) > 0 {
		parts = append(parts, "Actions: "+strings.Join(actions, ", "))
	}
	if len(files) > 0 {
		parts = append(parts, "Changed files: "+strings.Join(files, ", "))
	}
	return strings.Join(parts, " | ")
}

// FormatTurnsForSummaryInput formats a slice of turns into a compact transcript for LLM or deterministic summarization.
func FormatTurnsForSummaryInput(turns []ConversationTurn, startTurnIdx int) string {
	var sb strings.Builder
	for i, t := range turns {
		turnNum := startTurnIdx + i + 1
		prompt := strings.TrimSpace(t.Prompt)
		if prompt == "" {
			continue
		}
		sb.WriteString(fmt.Sprintf("Turn %d:\n- User: %s\n", turnNum, truncateHeadTail(prompt, 500)))
		if act := summarizeTurnActivity(t); act != "" {
			sb.WriteString(fmt.Sprintf("- %s\n", act))
		}
		out := strings.TrimSpace(t.Output)
		if out != "" {
			sb.WriteString(fmt.Sprintf("- Assistant Outcome: %s\n", truncateHeadTail(out, 700)))
		} else if strings.TrimSpace(t.Error) != "" {
			sb.WriteString(fmt.Sprintf("- Error: %s\n", truncateHeadTail(t.Error, 300)))
		}
		sb.WriteString("\n")
	}
	return strings.TrimSpace(sb.String())
}

// BuildStructuredConversationSummary deterministically folds newly aged turns into an existing rolling summary.
// It preserves key user requests, executed actions/files, and assistant conclusions while keeping total size bounded.
func BuildStructuredConversationSummary(existingSummary string, newTurns []ConversationTurn, startTurnIdx int) string {
	var sb strings.Builder
	existingTrim := strings.TrimSpace(existingSummary)
	if existingTrim != "" {
		sb.WriteString(existingTrim)
		sb.WriteString("\n")
	}

	for i, t := range newTurns {
		turnNum := startTurnIdx + i + 1
		prompt := strings.TrimSpace(t.Prompt)
		if prompt == "" && strings.TrimSpace(t.Output) == "" {
			continue
		}
		oneLinePrompt := strings.ReplaceAll(truncateHeadTail(prompt, 220), "\n", " ")
		sb.WriteString(fmt.Sprintf("- Turn %d Request: %s\n", turnNum, oneLinePrompt))
		if act := summarizeTurnActivity(t); act != "" {
			sb.WriteString(fmt.Sprintf("  %s\n", act))
		}
		out := strings.TrimSpace(t.Output)
		if out != "" {
			oneLineOut := strings.ReplaceAll(truncateHeadTail(out, 380), "\n", " ")
			sb.WriteString(fmt.Sprintf("  Outcome: %s\n", oneLineOut))
		} else if strings.TrimSpace(t.Error) != "" {
			sb.WriteString(fmt.Sprintf("  Error: %s\n", strings.ReplaceAll(truncateHeadTail(t.Error, 200), "\n", " ")))
		}
	}

	res := strings.TrimSpace(sb.String())
	if len(res) > HistorySummaryMaxChars {
		res = truncateHeadTail(res, HistorySummaryMaxChars)
	}
	return res
}

// ShouldSummarizeConversation determines whether a conversation needs initial summarization or re-summarization,
// or whether an existing rolling summary should be reused as-is.
func ShouldSummarizeConversation(completedTurns []ConversationTurn, existingSummary string, summarizedTurnCount int) (shouldSummarize bool, targetCutoff int, unsummarizedChars int) {
	totalCompleted := len(completedTurns)
	if summarizedTurnCount < 0 || summarizedTurnCount > totalCompleted || strings.TrimSpace(existingSummary) == "" {
		summarizedTurnCount = 0
	}

	unsummarizedTurns := completedTurns[summarizedTurnCount:]
	for _, t := range unsummarizedTurns {
		unsummarizedChars += len(t.Prompt) + len(t.Output) + len(t.Error)
	}

	if totalCompleted <= HistoryRecentTurnsKeep {
		return false, summarizedTurnCount, unsummarizedChars
	}

	targetCutoff = totalCompleted - HistoryRecentTurnsKeep
	newlyEligibleTurns := targetCutoff - summarizedTurnCount
	if newlyEligibleTurns <= 0 {
		return false, summarizedTurnCount, unsummarizedChars
	}

	unsummarizedCount := len(unsummarizedTurns)
	if summarizedTurnCount == 0 {
		// Initial summarization: trigger when turns > 10 or when turns > 6 and character volume is high
		if unsummarizedCount > HistoryResummarizeTurnThreshold || unsummarizedChars > HistoryResummarizeCharThreshold {
			return true, targetCutoff, unsummarizedChars
		}
		return false, 0, unsummarizedChars
	}

	// Re-summarization with hysteresis: reuse the existing summary until > 10 unsummarized turns accumulate,
	// or at least HistoryMinBatchTurnsToSummarize (3) new turns are ready to roll in and char threshold is exceeded.
	if unsummarizedCount > HistoryResummarizeTurnThreshold {
		return true, targetCutoff, unsummarizedChars
	}
	if newlyEligibleTurns >= HistoryMinBatchTurnsToSummarize && unsummarizedChars > HistoryResummarizeCharThreshold {
		return true, targetCutoff, unsummarizedChars
	}

	return false, summarizedTurnCount, unsummarizedChars
}

// BuildConversationHistoryContext assembles the conversation history block for an AI request.
// It reuses the persisted rolling summary across multiple turns and only summarizes newly aged turns when thresholds are crossed.
func BuildConversationHistoryContext(
	conv *Conversation,
	llmSummarizeFn func(existingSummary, batchTranscript string) (string, error),
) (historyBlock string, recentTurnCount int, summarizedTurnCount int, reusedSummary bool, updatedSummary bool) {
	if conv == nil || len(conv.Turns) == 0 {
		return "", 0, 0, false, false
	}

	// Collect completed turns (excluding any trailing optimistic placeholder turn for the in-flight request)
	completedTurns := make([]ConversationTurn, 0, len(conv.Turns))
	for _, t := range conv.Turns {
		if isIncompleteTurn(t) {
			continue
		}
		completedTurns = append(completedTurns, t)
	}
	if len(completedTurns) == 0 {
		return "", 0, 0, false, false
	}

	sumCount := conv.SummarizedTurnCount
	sumText := strings.TrimSpace(conv.Summary)
	if sumCount < 0 || sumCount > len(completedTurns) || sumText == "" {
		sumCount = 0
		sumText = ""
	}

	needSummarize, targetCutoff, _ := ShouldSummarizeConversation(completedTurns, sumText, sumCount)
	if needSummarize && targetCutoff > sumCount {
		newBatch := completedTurns[sumCount:targetCutoff]
		var updatedText string
		if llmSummarizeFn != nil {
			batchTranscript := FormatTurnsForSummaryInput(newBatch, sumCount)
			if batchTranscript != "" {
				if llmOut, err := llmSummarizeFn(sumText, batchTranscript); err == nil && strings.TrimSpace(llmOut) != "" {
					updatedText = strings.TrimSpace(llmOut)
					if len(updatedText) > HistorySummaryMaxChars {
						updatedText = truncateHeadTail(updatedText, HistorySummaryMaxChars)
					}
				}
			}
		}
		if updatedText == "" {
			updatedText = BuildStructuredConversationSummary(sumText, newBatch, sumCount)
		}
		if updatedText != "" {
			sumText = updatedText
			sumCount = targetCutoff
			conv.Summary = sumText
			conv.SummarizedTurnCount = sumCount
			conv.SummaryUpdatedAt = time.Now().UTC().Format(time.RFC3339)
			updatedSummary = true
			if conv.ID != "" {
				_ = SaveConversation(conv)
			}
		}
	} else if sumText != "" && sumCount > 0 {
		reusedSummary = true
	}

	var sb strings.Builder
	if sumText != "" && sumCount > 0 {
		sb.WriteString(fmt.Sprintf("Summary of earlier conversation (turns 1–%d):\n%s\n\n", sumCount, sumText))
		sb.WriteString("Recent conversation turns:\n")
	}

	recentSlice := completedTurns[sumCount:]
	for _, t := range recentSlice {
		prompt := strings.TrimSpace(t.Prompt)
		if prompt != "" {
			sb.WriteString(fmt.Sprintf("User: %s\n", prompt))
			recentTurnCount++
		}
		if act := summarizeTurnActivity(t); act != "" {
			sb.WriteString(fmt.Sprintf("Assistant Activity: %s\n", act))
		}
		if strings.TrimSpace(t.Output) != "" {
			outTrim := truncateHeadTail(t.Output, HistoryRecentTurnOutputMaxChars)
			sb.WriteString(fmt.Sprintf("Assistant: %s\n\n", outTrim))
		} else if t.Status == "error" && strings.TrimSpace(t.Error) != "" {
			sb.WriteString(fmt.Sprintf("Assistant Error: %s\n\n", truncateHeadTail(t.Error, 400)))
		}
	}

	return strings.TrimSpace(sb.String()), recentTurnCount, sumCount, reusedSummary, updatedSummary
}

