package pkg

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// ProjectRule represents an ingested rule or instruction file (e.g. AGENTS.md, GEMINI.md)
type ProjectRule struct {
	FileName  string `json:"file_name"`
	FilePath  string `json:"file_path"`
	Content   string `json:"content"`
	CharCount int    `json:"char_count"`
	LineCount int    `json:"line_count"`
}

// SkillDefinition represents a discovered or injected skill for workflow and agent control
type SkillDefinition struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	Path         string `json:"path,omitempty"`
	Directory    string `json:"directory,omitempty"`
	Source       string `json:"source"` // "project", "global", "injected"
	IsControl    bool   `json:"is_control"`
	Instructions string `json:"instructions"`
}

// ProjectContext aggregates all rules and skills for an active project workspace
type ProjectContext struct {
	ProjectPath string            `json:"project_path"`
	Rules       []ProjectRule     `json:"rules"`
	Skills      []SkillDefinition `json:"skills"`
}

// RuleLoaderManager handles scanning, caching, and optimizing project rules and skills
type RuleLoaderManager struct {
	mu             sync.RWMutex
	injectedSkills []SkillDefinition
	cache          map[string]ProjectContext
}

var (
	globalRuleManager     *RuleLoaderManager
	globalRuleManagerOnce sync.Once
)

// GetRuleLoaderManager returns the singleton rule manager
func GetRuleLoaderManager() *RuleLoaderManager {
	globalRuleManagerOnce.Do(func() {
		globalRuleManager = &RuleLoaderManager{
			injectedSkills: make([]SkillDefinition, 0),
			cache:          make(map[string]ProjectContext),
		}
	})
	return globalRuleManager
}

// OptimizeMarkdown cleans up whitespace, strips comment noise, and bounds size
func OptimizeMarkdown(input string, maxChars int) string {
	if maxChars <= 0 {
		maxChars = 16000
	}

	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return ""
	}

	// Normalize CRLF to LF
	content := strings.ReplaceAll(trimmed, "\r\n", "\n")

	// Collapse 3 or more consecutive newlines into 2
	reMultiNewline := regexp.MustCompile(`\n{3,}`)
	content = reMultiNewline.ReplaceAllString(content, "\n\n")

	// Strip editorial HTML comments (e.g. <!-- TODO: ... -->)
	reComments := regexp.MustCompile(`(?s)<!--.*?-->`)
	content = reComments.ReplaceAllString(content, "")

	content = strings.TrimSpace(content)

	if len(content) > maxChars {
		content = content[:maxChars] + "\n\n[... Remaining content truncated for prompt budget ...]"
	}

	return content
}

// ParseSkillMarkdown parses a SKILL.md file, extracting YAML frontmatter and instructions body
func ParseSkillMarkdown(filePath string, source string) (*SkillDefinition, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}

	raw := string(data)
	dir := filepath.Dir(filePath)
	baseDirName := filepath.Base(dir)
	fileName := filepath.Base(filePath)
	ext := filepath.Ext(fileName)
	fileBase := strings.TrimSuffix(fileName, ext)

	defaultName := baseDirName
	if !strings.EqualFold(fileName, "SKILL.md") && fileBase != "" {
		defaultName = fileBase
	}

	skill := &SkillDefinition{
		Name:      defaultName,
		Path:      filePath,
		Directory: dir,
		Source:    source,
	}

	normalized := strings.ReplaceAll(raw, "\r\n", "\n")
	trimmed := strings.TrimSpace(normalized)

	body := trimmed
	if strings.HasPrefix(trimmed, "---") {
		parts := strings.SplitN(trimmed[3:], "---", 2)
		if len(parts) == 2 {
			frontmatter := parts[0]
			body = strings.TrimSpace(parts[1])

			scanner := bufio.NewScanner(strings.NewReader(frontmatter))
			for scanner.Scan() {
				line := strings.TrimSpace(scanner.Text())
				if strings.HasPrefix(line, "name:") {
					val := strings.TrimSpace(strings.TrimPrefix(line, "name:"))
					val = strings.Trim(val, `"'`)
					if val != "" {
						skill.Name = val
					}
				} else if strings.HasPrefix(line, "description:") {
					val := strings.TrimSpace(strings.TrimPrefix(line, "description:"))
					val = strings.Trim(val, `"'`)
					if val != "" {
						skill.Description = val
					}
				} else if strings.HasPrefix(line, "control:") || strings.HasPrefix(line, "is_control:") {
					val := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(line, "is_control:"), "control:")))
					if val == "true" || val == "1" || val == "yes" {
						skill.IsControl = true
					}
				}
			}
		}
	}

	if skill.Description == "" {
		// Try to extract first paragraph or heading
		lines := strings.Split(body, "\n")
		for _, l := range lines {
			l = strings.TrimSpace(l)
			if l != "" && !strings.HasPrefix(l, "#") {
				if len(l) > 160 {
					l = l[:160] + "..."
				}
				skill.Description = l
				break
			}
		}
	}

	nameLower := strings.ToLower(skill.Name)
	if strings.Contains(nameLower, "control") || strings.Contains(nameLower, "security") || strings.Contains(nameLower, "permission") || strings.Contains(nameLower, "audit") {
		skill.IsControl = true
	}

	skill.Instructions = OptimizeMarkdown(body, 12000)
	return skill, nil
}

// DiscoverProjectRules scans project directory for GEMINI.md, AGENTS.md, .agentrules, etc.
func DiscoverProjectRules(projectPath string) []ProjectRule {
	if projectPath == "" || projectPath == "." {
		cwd, err := os.Getwd()
		if err == nil && cwd != "" {
			projectPath = cwd
		} else {
			return nil
		}
	}

	targetFiles := []string{
		"GEMINI.md",
		"AGENTS.md",
		".agentrules",
		"CLAUDE.md",
		filepath.Join(".gemini", "rules.md"),
		filepath.Join(".agents", "rules.md"),
	}

	var rules []ProjectRule
	seen := make(map[string]bool)

	// Check current directory and up to git root or parent
	current := projectPath
	for depth := 0; depth < 3; depth++ {
		for _, rel := range targetFiles {
			fullPath := filepath.Join(current, rel)
			if seen[fullPath] {
				continue
			}

			fi, err := os.Stat(fullPath)
			if err == nil && !fi.IsDir() {
				data, err := os.ReadFile(fullPath)
				if err == nil && len(data) > 0 {
					seen[fullPath] = true
					optimized := OptimizeMarkdown(string(data), 14000)
					lineCount := strings.Count(optimized, "\n") + 1
					rules = append(rules, ProjectRule{
						FileName:  filepath.Base(fullPath),
						FilePath:  fullPath,
						Content:   optimized,
						CharCount: len(optimized),
						LineCount: lineCount,
					})
				}
			}
		}

		// Stop ascending if we reached git root or root filesystem
		if _, err := os.Stat(filepath.Join(current, ".git")); err == nil {
			break
		}
		parent := filepath.Dir(current)
		if parent == current || parent == "" || parent == "/" {
			break
		}
		current = parent
	}

	return rules
}

// DiscoverSkills searches project directories and global paths for SKILL.md files
func DiscoverSkills(projectPath string) []SkillDefinition {
	var skills []SkillDefinition
	seen := make(map[string]bool)

	searchRoots := []struct {
		dir    string
		source string
	}{
		{filepath.Join(projectPath, ".gemini", "skills"), "project"},
		{filepath.Join(projectPath, ".agents", "skills"), "project"},
		{filepath.Join(projectPath, "skills"), "project"},
		{filepath.Join(projectPath, ".skills"), "project"},
	}

	// Add home directory global skills if present
	home, err := os.UserHomeDir()
	if err == nil && home != "" {
		searchRoots = append(searchRoots,
			struct {
				dir    string
				source string
			}{filepath.Join(home, ".shuffle", "skills"), "global"},
			struct {
				dir    string
				source string
			}{filepath.Join(home, ".gemini", "antigravity", "builtin", "skills"), "global"},
		)
	}

	for _, sr := range searchRoots {
		if fi, err := os.Stat(sr.dir); err != nil || !fi.IsDir() {
			continue
		}

		// Walk skill subdirectories
		entries, err := os.ReadDir(sr.dir)
		if err != nil {
			continue
		}

		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			skillMdPath := filepath.Join(sr.dir, e.Name(), "SKILL.md")
			if seen[skillMdPath] {
				continue
			}

			if _, err := os.Stat(skillMdPath); err == nil {
				skill, err := ParseSkillMarkdown(skillMdPath, sr.source)
				if err == nil && skill != nil {
					seen[skillMdPath] = true
					skills = append(skills, *skill)
				}
			}
		}
	}

	return skills
}

// LoadProjectContext gathers optimized rules and skills for the target project
func (m *RuleLoaderManager) LoadProjectContext(projectPath string) ProjectContext {
	m.mu.Lock()
	defer m.mu.Unlock()

	cleanPath := filepath.Clean(projectPath)
	if cleanPath == "" || cleanPath == "." {
		if cwd, err := os.Getwd(); err == nil {
			cleanPath = cwd
		}
	}

	rules := DiscoverProjectRules(cleanPath)
	skills := DiscoverSkills(cleanPath)

	// Merge with runtime injected control skills
	for _, inj := range m.injectedSkills {
		skills = append(skills, inj)
	}

	ctx := ProjectContext{
		ProjectPath: cleanPath,
		Rules:       rules,
		Skills:      skills,
	}

	m.cache[cleanPath] = ctx
	return ctx
}

// LoadSkillFromFile parses a skill file from any path and returns its definition
func LoadSkillFromFile(filePath string) (*SkillDefinition, error) {
	return ParseSkillMarkdown(filePath, "injected")
}

// GetInjectedSkills returns a copy of currently injected skills
func (m *RuleLoaderManager) GetInjectedSkills() []SkillDefinition {
	m.mu.RLock()
	defer m.mu.RUnlock()
	res := make([]SkillDefinition, len(m.injectedSkills))
	copy(res, m.injectedSkills)
	return res
}

// SetInjectedSkills replaces all injected skills (e.g. from local store)
func (m *RuleLoaderManager) SetInjectedSkills(skills []SkillDefinition) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.injectedSkills = make([]SkillDefinition, len(skills))
	copy(m.injectedSkills, skills)
	m.cache = make(map[string]ProjectContext)
}

// InjectSkill registers a runtime skill (capability or control)
func (m *RuleLoaderManager) InjectSkill(skill SkillDefinition) {
	m.mu.Lock()
	defer m.mu.Unlock()

	skill.Source = "injected"
	if skill.Instructions != "" {
		skill.Instructions = OptimizeMarkdown(skill.Instructions, 8000)
	}

	replaced := false
	for i, existing := range m.injectedSkills {
		if strings.EqualFold(existing.Name, skill.Name) {
			m.injectedSkills[i] = skill
			replaced = true
			break
		}
	}
	if !replaced {
		m.injectedSkills = append(m.injectedSkills, skill)
	}

	m.cache = make(map[string]ProjectContext)
	log.Printf("[INFO] Injected skill %q into agent runtime (is_control=%v, total injected: %d)", skill.Name, skill.IsControl, len(m.injectedSkills))
}

// InjectControlSkill registers an in-memory or programmatic control skill
func (m *RuleLoaderManager) InjectControlSkill(skill SkillDefinition) {
	skill.IsControl = true
	m.InjectSkill(skill)
}

// RemoveInjectedSkill removes an injected skill by name
func (m *RuleLoaderManager) RemoveInjectedSkill(name string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()

	found := false
	newSkills := make([]SkillDefinition, 0, len(m.injectedSkills))
	for _, s := range m.injectedSkills {
		if strings.EqualFold(s.Name, name) {
			found = true
			continue
		}
		newSkills = append(newSkills, s)
	}
	if found {
		m.injectedSkills = newSkills
		m.cache = make(map[string]ProjectContext)
		log.Printf("[INFO] Removed injected skill %q (remaining: %d)", name, len(m.injectedSkills))
	}
	return found
}

// ClearInjectedSkills resets dynamically injected skills
func (m *RuleLoaderManager) ClearInjectedSkills() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.injectedSkills = make([]SkillDefinition, 0)
	m.cache = make(map[string]ProjectContext)
}

// FormatRulesSummary renders active project rules into a markdown block for system prompt
func (pc *ProjectContext) FormatRulesSummary() string {
	if len(pc.Rules) == 0 {
		return ""
	}

	var sb strings.Builder
	sb.WriteString("\n\n### ACTIVE WORKSPACE RULES\n")
	sb.WriteString("The following project-specific guidelines and style rules are mandatory for this workspace:\n\n")

	for _, r := range pc.Rules {
		sb.WriteString(fmt.Sprintf("#### Rules from %s:\n```\n%s\n```\n\n", r.FileName, r.Content))
	}

	return sb.String()
}

// FormatSkillsSummary renders active and control skills into a markdown block
func (pc *ProjectContext) FormatSkillsSummary() string {
	if len(pc.Skills) == 0 {
		return ""
	}

	var sb strings.Builder
	sb.WriteString("\n\n### AVAILABLE WORKSPACE SKILLS & CONTROL PROCEDURES\n")
	sb.WriteString("Use these specialized skills and control routines when applicable:\n\n")

	for _, s := range pc.Skills {
		controlTag := ""
		if s.IsControl {
			controlTag = " [CONTROL]"
		}
		desc := s.Description
		if desc == "" {
			desc = "No description provided."
		}
		sb.WriteString(fmt.Sprintf("- **%s**%s (%s): %s\n", s.Name, controlTag, s.Source, desc))
		if s.IsControl && len(s.Instructions) > 0 {
			sb.WriteString(fmt.Sprintf("  Instructions:\n  %s\n\n", strings.ReplaceAll(s.Instructions, "\n", "\n  ")))
		}
	}

	return sb.String()
}

// BuildInjectedSystemPrompt constructs a complete system prompt including workspace rules, skills, and thought/decision output format
func BuildInjectedSystemPrompt(projectPath string) string {
	mgr := GetRuleLoaderManager()
	pContext := mgr.LoadProjectContext(projectPath)

	base := fmt.Sprintf("You are the Shuffle AI Agent assistant running inside Orborus.\nActive workspace: %s.\n\nFormatting & Execution Instructions:\n- Internal Reasoning: Before answering complex requests, wrap your concise internal thought process in <thought>...</thought> tags. The UI will extract these into a collapsible reasoning step.\n- Terminal Commands: Whenever suggesting or executing shell commands, wrap them in ```bash ... ``` code blocks.\n- Tone & Style: Be concise, clear, and actionable. Absolute prohibition of emojis everywhere.\n\n", pContext.ProjectPath)
	rulesBlock := pContext.FormatRulesSummary()
	skillsBlock := pContext.FormatSkillsSummary()

	return base + rulesBlock + skillsBlock
}
