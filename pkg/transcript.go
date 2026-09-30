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
	ID        string `json:"id"`
	Name      string `json:"name"`
	Duration  string `json:"duration,omitempty"`
	Detail    string `json:"detail,omitempty"`
	Type      string `json:"type,omitempty"` // "thought", "cmd", "file", "approval_pending"
	Collapsed bool   `json:"collapsed,omitempty"`
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
	WorkflowExecution *shuffle.WorkflowExecution `json:"workflow_execution,omitempty"`
}

// Conversation represents a persistent multi-turn chat session stored on disk
type Conversation struct {
	ID          string             `json:"id"`
	Title       string             `json:"title"`
	ProjectID   string             `json:"project_id"`
	ProjectName string             `json:"project_name"`
	CreatedAt   string             `json:"created_at"`
	UpdatedAt   string             `json:"updated_at"`
	Pinned      bool               `json:"pinned"`
	Turns       []ConversationTurn `json:"turns"`
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

	conv.Turns = append(conv.Turns, turn)

	if err := SaveConversation(conv); err != nil {
		log.Printf("[ERROR] Failed to save conversation %s to disk: %v", convID, err)
		return conv, err
	}

	log.Printf("[INFO] Saved conversation %s (turns: %d) to %s", convID, len(conv.Turns), getConversationFilePath(convID))
	return conv, nil
}
