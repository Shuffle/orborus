package pkg

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDiscoverProjectRules(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "orborus-rules-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	geminiContent := "# Test Rules\n\n- Do not use emojis.\n- Use Shuffle Orange #f85f38.\n\n<!-- TODO: Internal note -->\n"
	err = os.WriteFile(filepath.Join(tmpDir, "GEMINI.md"), []byte(geminiContent), 0644)
	if err != nil {
		t.Fatalf("Failed to write GEMINI.md: %v", err)
	}

	rules := DiscoverProjectRules(tmpDir)
	if len(rules) != 1 {
		t.Fatalf("Expected 1 rule file, found %d", len(rules))
	}

	rule := rules[0]
	if rule.FileName != "GEMINI.md" {
		t.Errorf("Expected FileName GEMINI.md, got %s", rule.FileName)
	}
	if strings.Contains(rule.Content, "<!-- TODO") {
		t.Errorf("Expected HTML comments to be stripped, got: %s", rule.Content)
	}
	if !strings.Contains(rule.Content, "Do not use emojis") {
		t.Errorf("Expected rule content to be preserved, got: %s", rule.Content)
	}
}

func TestSkillParsingAndInjection(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "orborus-skills-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	skillDir := filepath.Join(tmpDir, ".gemini", "skills", "security-audit")
	err = os.MkdirAll(skillDir, 0755)
	if err != nil {
		t.Fatalf("Failed to create skill dir: %v", err)
	}

	skillContent := `---
name: security-audit
description: Audits code for security vulnerabilities and secrets.
is_control: true
---
# Security Audit Procedure
1. Check credentials
2. Verify endpoints
`
	err = os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(skillContent), 0644)
	if err != nil {
		t.Fatalf("Failed to write SKILL.md: %v", err)
	}

	skills := DiscoverSkills(tmpDir)
	var s *SkillDefinition
	for i := range skills {
		if skills[i].Name == "security-audit" {
			s = &skills[i]
			break
		}
	}
	if s == nil {
		t.Fatalf("Expected to find skill 'security-audit' among %d discovered skills", len(skills))
	}

	if s.Name != "security-audit" {
		t.Errorf("Expected skill name 'security-audit', got %q", s.Name)
	}
	if !s.IsControl {
		t.Errorf("Expected skill to be marked as control")
	}
	if !strings.Contains(s.Instructions, "Check credentials") {
		t.Errorf("Expected instructions to contain 'Check credentials', got %q", s.Instructions)
	}

	// Test dynamic injection
	mgr := GetRuleLoaderManager()
	mgr.ClearInjectedSkills()

	injSkill := SkillDefinition{
		Name:         "runtime-control",
		Description:  "Controls runtime execution bounds",
		Instructions: "Strictly enforce approval policies",
		IsControl:    true,
	}
	mgr.InjectControlSkill(injSkill)

	pCtx := mgr.LoadProjectContext(tmpDir)
	foundInjected := false
	for _, sk := range pCtx.Skills {
		if sk.Name == "runtime-control" {
			foundInjected = true
			if !sk.IsControl {
				t.Errorf("Expected injected skill to be control")
			}
			break
		}
	}
	if !foundInjected {
		t.Errorf("Expected injected control skill to be present in project context")
	}

	rulesSummary := pCtx.FormatRulesSummary()
	skillsSummary := pCtx.FormatSkillsSummary()
	if !strings.Contains(skillsSummary, "runtime-control") {
		t.Errorf("Expected skillsSummary to contain runtime-control, got: %s", skillsSummary)
	}
	_ = rulesSummary
}

func TestSkillFileLoadingAndRemoval(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "orborus-skill-file-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	skillPath := filepath.Join(tmpDir, "k8s-debug.md")
	content := `---
name: k8s-debugger
description: Debugs k8s pods and ingress controllers
control: true
---
# Kubernetes Debugging
Inspect pod logs and resource usage before restarting.
`
	err = os.WriteFile(skillPath, []byte(content), 0644)
	if err != nil {
		t.Fatalf("Failed to write skill file: %v", err)
	}

	skill, err := LoadSkillFromFile(skillPath)
	if err != nil {
		t.Fatalf("Failed to load skill from file: %v", err)
	}

	if skill.Name != "k8s-debugger" {
		t.Errorf("Expected name k8s-debugger, got %q", skill.Name)
	}
	if !skill.IsControl {
		t.Errorf("Expected is_control true")
	}
	if !strings.Contains(skill.Instructions, "Inspect pod logs") {
		t.Errorf("Expected instructions to contain 'Inspect pod logs', got %q", skill.Instructions)
	}

	mgr := GetRuleLoaderManager()
	mgr.ClearInjectedSkills()

	mgr.InjectSkill(*skill)
	injected := mgr.GetInjectedSkills()
	if len(injected) != 1 {
		t.Fatalf("Expected 1 injected skill, got %d", len(injected))
	}
	if injected[0].Name != "k8s-debugger" {
		t.Errorf("Expected injected skill name k8s-debugger, got %s", injected[0].Name)
	}

	// Test removal
	removed := mgr.RemoveInjectedSkill("k8s-debugger")
	if !removed {
		t.Errorf("Expected RemoveInjectedSkill to return true")
	}
	if len(mgr.GetInjectedSkills()) != 0 {
		t.Errorf("Expected 0 injected skills after removal, got %d", len(mgr.GetInjectedSkills()))
	}
}
