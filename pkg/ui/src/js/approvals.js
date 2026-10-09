// --- Approvals Card, Radio Options & Remembered Rules Management ---
function showApprovalCard(data) {
  const card = document.getElementById("approval-card");
  if (!card) return;

  const titleEl = document.getElementById("approval-title-text");
  if (titleEl) titleEl.innerText = data.desc || "Allow viewing commit?";

  const cmdEl = document.getElementById("approval-cmd");
  if (cmdEl) cmdEl.innerText = data.cmd || "";

  const prefix = data.prefix || (data.cmd ? data.cmd.trim().split(/\s+/).slice(0, 2).join(" ") : "this command");
  const lblOpt2 = document.getElementById("lbl-opt-2");
  if (lblOpt2) lblOpt2.innerText = `Yes, and always allow '${prefix}' in this conversation`;

  const lblOpt3 = document.getElementById("lbl-opt-3");
  if (lblOpt3) lblOpt3.innerText = `Yes, and always allow '${prefix}' in this project`;

  const lblOpt4 = document.getElementById("lbl-opt-4");
  if (lblOpt4) lblOpt4.innerText = `Yes, and always allow '${prefix}'`;

  selectApprovalOption(1);
  card.classList.add("visible");
}

function selectApprovalOption(num) {
  if (num < 1 || num > 5) return;
  selectedApprovalOption = num;
  for (let i = 1; i <= 5; i++) {
    const opt = document.getElementById("opt-" + i);
    if (opt) {
      if (i === num) {
        opt.classList.add("selected");
      } else {
        opt.classList.remove("selected");
      }
    }
  }
}

async function submitApproval() {
  const card = document.getElementById("approval-card");
  if (!card || !card.classList.contains("visible")) return;

  const option = selectedApprovalOption;
  const prefix = currentApprovalCmdPrefix || "git show";
  let scope = "global";
  let scopeId = "";

  if (option === 2) {
    scope = "conversation";
    scopeId = activeConversationId;
  } else if (option === 3) {
    scope = "project";
    scopeId = activeProjectPath;
  } else if (option === 4) {
    scope = "global";
    scopeId = "";
  }

  card.classList.remove("visible");

  if (window.respondApprovalWithOptions) {
    try {
      const raw = await window.respondApprovalWithOptions(
        currentApprovalId || "step-4",
        option,
        prefix,
        scope,
        scopeId
      );
      const res = JSON.parse(raw);
      if (res.rules) {
        currentApprovalRules = res.rules;
        updateApprovalRulesCount();
      }
    } catch (err) {
      console.warn("respondApprovalWithOptions error:", err);
    }
  }

  // Update conversation step
  const conv = appConversations.find(c => c.id === activeConversationId);
  if (conv && conv.steps) {
    const pendingIdx = conv.steps.findIndex(s => s.id === (currentApprovalId || "step-4"));
    if (pendingIdx !== -1) {
      if (option === 5) {
        conv.steps[pendingIdx] = {
          id: "step-" + Date.now(),
          type: "cmd",
          title: "Denied: " + currentApprovalCmd,
          output: "Execution was denied by user.",
          collapsed: false
        };
        showToast("Execution denied");
      } else {
        conv.steps[pendingIdx] = {
          id: "step-" + Date.now(),
          type: "cmd",
          title: "Ran " + currentApprovalCmd,
          output: "commit 19812579b5c2a4f08e1d713c721da2d5142ba188\nAuthor: frikky <frikky@shuffler.io>\nDate:   Tue Sep 29 22:30:14 2026 +0200\n\n    Add project listing with pins, rich approvals, and activity breakdown\n\n darwin.go          | 124 ++++++++++++++++++++++++++++++----\n pkg/bridge.go      | 186 +++++++++++++++++++++++++++++++++++++++++++++++--\n pkg/store.go       |  12 +++-\n pkg/ui/index.html  | 380 +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++-----------------\n 4 files changed, 598 insertions(+), 104 deletions(-)",
          collapsed: false
        };
        if (option > 1) {
          showToast(`Allowed '${prefix}' and remembered rule (${scope})`);
        } else {
          showToast(`Executed: ${prefix}`);
        }
      }
    }
  }

  renderActiveConversation();
  loadApprovalRules();
}

function skipApproval() {
  const card = document.getElementById("approval-card");
  if (card) card.classList.remove("visible");
  showToast("Approval skipped");
}

async function respondApproval(approved) {
  if (!currentApprovalId) return;
  document.getElementById("approval-card").classList.remove("visible");

  const raw = await window.respondApproval(currentApprovalId, approved);
  currentApprovalId = null;
  const res = JSON.parse(raw);
  renderExecutionResult(res, 1);
}

// ----------------- Remembered Approvals Modal -----------------
async function openRememberedApprovalsModal() {
  await loadApprovalRules();
  const modal = document.getElementById("remembered-approvals-modal");
  if (modal) modal.classList.add("visible");
  if (typeof checkModalActive === "function") checkModalActive();
}

function closeRememberedApprovalsModal() {
  const modal = document.getElementById("remembered-approvals-modal");
  if (modal) modal.classList.remove("visible");
  if (typeof checkModalActive === "function") checkModalActive();
}

async function loadApprovalRules() {
  if (window.getApprovalRules) {
    try {
      const raw = await window.getApprovalRules();
      const rules = JSON.parse(raw);
      if (Array.isArray(rules)) {
        currentApprovalRules = rules;
      }
    } catch (err) {
      console.warn("getApprovalRules error:", err);
    }
  }
  updateApprovalRulesCount();
  renderRememberedRulesTable();
}

function updateApprovalRulesCount() {
  const countEl = document.getElementById("remembered-rules-count");
  if (countEl) {
    countEl.innerText = currentApprovalRules ? currentApprovalRules.length : 0;
  }
}

function renderRememberedRulesTable() {
  const tbody = document.getElementById("remembered-rules-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!currentApprovalRules || currentApprovalRules.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--text-muted); padding:16px;">No remembered approval rules yet.</td></tr>`;
    return;
  }

  currentApprovalRules.forEach(rule => {
    const tr = document.createElement("tr");
    const scopeClass = rule.Scope || "global";
    const scopeLabel = rule.Scope === "project" ? `Project (${(rule.ScopeID || "").split("/").pop() || "active"})` : (rule.Scope === "conversation" ? "Conversation" : "Global");
    const dateStr = rule.CreatedAt ? new Date(rule.CreatedAt).toLocaleTimeString() : "Just now";

    tr.innerHTML = `
      <td style="font-family:'SF Mono',Menlo,monospace; font-weight:600; color:#f8fafc;">${escapeHtml(rule.Command)}</td>
      <td><span class="rule-scope-badge ${escapeHtml(scopeClass)}">${escapeHtml(scopeLabel)}</span></td>
      <td style="color:var(--text-muted); font-size:11.5px;">${escapeHtml(dateStr)}</td>
      <td>
        <button class="btn-rule-revoke" onclick="revokeApprovalRule('${escapeHtml(rule.ID)}')">Revoke</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function revokeApprovalRule(ruleId) {
  if (window.revokeApprovalRule) {
    try {
      await window.revokeApprovalRule(ruleId);
    } catch (err) {
      console.warn("revokeApprovalRule error:", err);
    }
  }
  currentApprovalRules = currentApprovalRules.filter(r => r.ID !== ruleId);
  updateApprovalRulesCount();
  renderRememberedRulesTable();
  showToast("Approval rule revoked");
}

async function clearAllApprovalRules() {
  if (window.clearApprovalRules) {
    try {
      await window.clearApprovalRules();
    } catch (err) {
      console.warn("clearApprovalRules error:", err);
    }
  }
  currentApprovalRules = [];
  updateApprovalRulesCount();
  renderRememberedRulesTable();
  showToast("All approval rules revoked");
}

async function addManualApprovalRule() {
  const cmdInput = document.getElementById("input-new-rule-cmd");
  const scopeSelect = document.getElementById("select-new-rule-scope");
  const cmd = cmdInput ? cmdInput.value.trim() : "";
  if (!cmd) return;

  const scope = scopeSelect ? scopeSelect.value : "global";
  let scopeId = "";
  if (scope === "project") scopeId = activeProjectPath;
  if (scope === "conversation") scopeId = activeConversationId;

  const rule = {
    ID: "rule-" + Date.now(),
    Command: cmd,
    Scope: scope,
    ScopeID: scopeId,
    CreatedAt: new Date().toISOString()
  };

  if (window.addApprovalRule) {
    try {
      await window.addApprovalRule(JSON.stringify(rule));
    } catch (err) {
      console.warn("addApprovalRule error:", err);
    }
  }

  if (!Array.isArray(currentApprovalRules)) currentApprovalRules = [];
  currentApprovalRules.unshift(rule);
  cmdInput.value = "";
  updateApprovalRulesCount();
  renderRememberedRulesTable();
  showToast(`Added rule: '${cmd}'`);
}
