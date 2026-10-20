// --- Real-time Streamed Chunk Handler & Activity Steps Formatting ---
function parseStreamingTurnContent(rawText) {
  if (!rawText) return { cleanText: "", activeThought: "", completedThoughts: [] };
  const thoughtRegex = /<(?:thought|thinking)>([\s\S]*?)<\/(?:thought|thinking)>/gi;
  let cleanText = rawText;
  const completedThoughts = [];
  let match;
  while ((match = thoughtRegex.exec(rawText)) !== null) {
    if (match[1].trim()) {
      completedThoughts.push(match[1].trim());
    }
  }
  cleanText = cleanText.replace(/<(?:thought|thinking)>[\s\S]*?<\/(?:thought|thinking)>/gi, "");

  let activeThought = "";
  const lowerClean = cleanText.toLowerCase();
  const openThoughtIdx = lowerClean.indexOf("<thought>");
  const openThinkingIdx = lowerClean.indexOf("<thinking>");
  if (openThoughtIdx !== -1) {
    activeThought = cleanText.substring(openThoughtIdx + 9).replace(/<\/(?:thought|thinking)>\s*$/i, "").trim();
    cleanText = cleanText.substring(0, openThoughtIdx).trim();
  } else if (openThinkingIdx !== -1) {
    activeThought = cleanText.substring(openThinkingIdx + 10).replace(/<\/(?:thought|thinking)>\s*$/i, "").trim();
    cleanText = cleanText.substring(0, openThinkingIdx).trim();
  }
  return { cleanText: cleanText.trim(), activeThought, completedThoughts };
}

function isGenericPlaceholderText(text) {
  const t = String(text || "")
    .replace(/<(?:thought|thinking)>[\s\S]*?<\/(?:thought|thinking)>/gi, "")
    .replace(/<(?:thought|thinking)>[\s\S]*$/gi, "")
    .trim()
    .toLowerCase();
  if (!t) return true;
  const placeholders = new Set([
    "completed",
    "completed.",
    "done",
    "done.",
    "finished",
    "finished.",
    "completed with no output",
    "completed with no output.",
    "task completed",
    "task completed.",
    "action completed",
    "action completed.",
    "execution completed",
    "execution completed.",
    "ok",
    "ok.",
    "success",
    "success."
  ]);
  return placeholders.has(t);
}

function extractSubstantiveTextFromReasoning(reasoning) {
  const r = String(reasoning || "").trim();
  if (!r || isGenericPlaceholderText(r)) return "";

  const lines = r.split("\n");
  const filteredLines = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (
      /^Analyzing (?:step results|request) \(Turn \d+\)\.\.\.$/i.test(trimmed) ||
      /^\[Turn \d+ completed in [\d.]+s\]$/i.test(trimmed) ||
      /^Running Shuffle app\s+`.*`:\s*`.*`$/i.test(trimmed) ||
      /^Running command:\s*`.*`$/i.test(trimmed) ||
      /^Running OS action:\s*`.*`$/i.test(trimmed)
    ) {
      continue;
    }
    filteredLines.push(lines[i]);
  }
  let cleaned = filteredLines.join("\n").trim() || r;

  // Strip leading bullet "• " if all non-empty lines are bulleted
  const cLines = cleaned.split("\n");
  const nonEmpty = cLines.filter(l => l.trim().length > 0);
  if (nonEmpty.length > 0 && nonEmpty.every(l => l.trim().startsWith("• "))) {
    cleaned = cLines
      .map(l => {
        const tl = l.trim();
        return tl.startsWith("• ") ? tl.slice(2).trim() : l;
      })
      .join("\n")
      .trim();
  }

  // Check for explicit answer markers
  const markers = ["final answer:", "answer:", "conclusion:", "summary:", "response:"];
  const lowerCleaned = cleaned.toLowerCase();
  for (const m of markers) {
    const idx = lowerCleaned.lastIndexOf(m);
    if (idx !== -1) {
      const after = cleaned.slice(idx + m.length).trim();
      if (after.length > 10 && !isGenericPlaceholderText(after)) {
        return after;
      }
    }
  }

  return cleaned;
}

function extractFallbackAnswerFromTurn(turn) {
  if (!turn) return "";

  // 1. Check thought steps in reverse order for substantive content
  if (Array.isArray(turn.steps)) {
    for (let i = turn.steps.length - 1; i >= 0; i--) {
      const step = turn.steps[i];
      if (!step) continue;
      if (step.type === "thought" && step.detail) {
        const extracted = extractSubstantiveTextFromReasoning(step.detail);
        if (extracted && !isGenericPlaceholderText(extracted)) {
          return extracted;
        }
      }
    }
  }

  // 2. Check <thought> blocks in turn.raw_output or turn.output or turn.activeThought
  const rawSource = turn.raw_output || turn.output || "";
  if (rawSource) {
    const parsed = parseStreamingTurnContent(rawSource);
    if (parsed.cleanText && !isGenericPlaceholderText(parsed.cleanText)) {
      return parsed.cleanText;
    }
    if (parsed.activeThought) {
      const extracted = extractSubstantiveTextFromReasoning(parsed.activeThought);
      if (extracted && !isGenericPlaceholderText(extracted)) {
        return extracted;
      }
    }
    if (Array.isArray(parsed.completedThoughts) && parsed.completedThoughts.length > 0) {
      for (let i = parsed.completedThoughts.length - 1; i >= 0; i--) {
        const extracted = extractSubstantiveTextFromReasoning(parsed.completedThoughts[i]);
        if (extracted && !isGenericPlaceholderText(extracted)) {
          return extracted;
        }
      }
    }
  }

  if (turn.activeThought) {
    const extracted = extractSubstantiveTextFromReasoning(turn.activeThought);
    if (extracted && !isGenericPlaceholderText(extracted)) {
      return extracted;
    }
  }

  // 3. Check decisions for substantive reason or raw_response
  const decisions = turn.decisions || (turn.workflow_execution && turn.workflow_execution.decisions) || [];
  if (Array.isArray(decisions) && decisions.length > 0) {
    for (let i = decisions.length - 1; i >= 0; i--) {
      const d = decisions[i];
      if (!d) continue;
      const reason = String(d.reason || d.Reason || "").trim();
      if (reason && !isGenericPlaceholderText(reason) && reason !== "Computed directly on GPU via local CUDA runtime" && reason !== "Computed directly on GPU via local runtime") {
        const extracted = extractSubstantiveTextFromReasoning(reason);
        if (extracted && !isGenericPlaceholderText(extracted)) {
          return extracted;
        }
      }
      const rd = d.run_details || d.RunDetails || {};
      const rawResp = String(rd.raw_response || rd.RawResponse || "").trim();
      if (rawResp && !isGenericPlaceholderText(rawResp)) {
        return rawResp;
      }
    }
  }

  return "";
}

function updateTurnThoughtTimings(turn, chunkText, isFinalizing) {
  if (!turn) return {};
  const nowMs = Date.now();
  if (!turn.thoughtTurnTimings || typeof turn.thoughtTurnTimings !== "object") {
    turn.thoughtTurnTimings = {};
  }
  const timings = turn.thoughtTurnTimings;
  if (!timings[1]) {
    timings[1] = {
      startedAt: turn.startedAt || nowMs
    };
  }
  if (chunkText) {
    const startMatches = String(chunkText).matchAll(/Analyzing\s+(?:step\s+results|request)\s*\(Turn\s+(\d+)\)/gi);
    for (const m of startMatches) {
      const tNum = parseInt(m[1], 10);
      if (tNum > 1) {
        for (let prev = 1; prev < tNum; prev++) {
          if (timings[prev] && !timings[prev].completedAt) {
            timings[prev].completedAt = nowMs;
          }
        }
      }
      if (!timings[tNum]) {
        timings[tNum] = { startedAt: nowMs };
      }
    }
    const compMatches = String(chunkText).matchAll(/\[Turn\s+(\d+)\s+completed\s+in\s+([\d.]+s)\]/gi);
    for (const m of compMatches) {
      const tNum = parseInt(m[1], 10);
      const tDur = m[2];
      if (!timings[tNum]) {
        timings[tNum] = { startedAt: nowMs, completedAt: nowMs, duration: tDur };
      } else {
        timings[tNum].completedAt = nowMs;
        timings[tNum].duration = tDur;
      }
    }
  }
  if (isFinalizing) {
    Object.keys(timings).forEach(k => {
      if (timings[k] && !timings[k].completedAt) {
        timings[k].completedAt = nowMs;
      }
    });
  }
  return timings;
}

function finalizeTurnLiveThoughts(turn, customLabel) {
  if (!turn) return;
  if (!Array.isArray(turn.steps)) {
    turn.steps = [];
  }
  const timings = updateTurnThoughtTimings(turn, turn.activeThought || "", true);
  const durLabel = customLabel || `Thought for ${turn.duration || "a few seconds"}`;

  if (turn.activeThought && String(turn.activeThought).trim().length > 0) {
    const trimmed = String(turn.activeThought).trim();
    const existingLive = turn.steps.find(s => s && s.id === "live-thought");
    if (existingLive) {
      existingLive.detail = trimmed;
    } else {
      turn.steps.push({
        id: `thought-${Date.now()}`,
        name: durLabel,
        detail: trimmed,
        type: "thought",
        collapsed: true
      });
    }
    turn.activeThought = "";
  }

  for (let i = turn.steps.length - 1; i >= 0; i--) {
    const st = turn.steps[i];
    if (!st) continue;
    const isLiveThought = st.id === "live-thought" || (st.type === "thought" && /^Thinking\b/i.test(String(st.name || "")));
    if (isLiveThought) {
      if (String(st.detail || "").trim().length > 0) {
        st.id = st.id === "live-thought" ? `thought-${Date.now()}-${i}` : st.id;
        st.turnTimings = st.turnTimings || timings;
        st.name = durLabel;
        st.collapsed = true;
      } else {
        turn.steps.splice(i, 1);
      }
    }
  }
}

let streamRenderRaf = null;
window.onAgentChunk = function(execId, chunk, isReasoning) {
  if (!chunk) return;
  if (!Array.isArray(appConversations)) return;
  const targetConvId = (typeof runningConversationId !== "undefined" && runningConversationId) ? runningConversationId : activeConversationId;
  const curConv = appConversations.find(c => c.id === targetConvId);
  if (!curConv || !Array.isArray(curConv.turns) || curConv.turns.length === 0) return;
  const targetTurn = curConv.turns[curConv.turns.length - 1];
  if (targetTurn && targetTurn.status === "running") {
    targetTurn.modelActive = true;
    targetTurn.lastChunkAt = Date.now();
    targetTurn.lastActivityAt = Date.now();

    if (activeConversationId === targetConvId) {
      const turnKey = targetTurn.id || (curConv.turns.length - 1);
      const statusEl = document.getElementById("cmd-status-" + turnKey);
      if (statusEl) {
        const selectedModel = targetTurn.model || activeAiModel || "gemini-3.8-flash";
        const modelDisplayName = resolveModelDisplayName(selectedModel);
        statusEl.innerText = `Processing with ${modelDisplayName}`;
      }
      const phaseEl = document.getElementById("live-phase-" + turnKey);
      if (phaseEl) {
        const phaseLabel = isReasoning ? "Streaming reasoning thoughts..." : "Streaming response...";
        phaseEl.innerText = phaseLabel;
        phaseEl.setAttribute("data-backend-driven", "true");
        phaseEl.setAttribute("data-backend-driven-at", String(Date.now()));
      }
    }

    if (!Array.isArray(targetTurn.steps)) {
      targetTurn.steps = [];
    }

    const durSuffix = targetTurn.duration ? ` (${targetTurn.duration})` : "";

    if (isReasoning === true) {
      const timings = updateTurnThoughtTimings(targetTurn, chunk, false);
      targetTurn.activeThought = (targetTurn.activeThought || "") + chunk;
      const trimmedThought = targetTurn.activeThought.trim();
      if (trimmedThought.length > 0) {
        let liveStep = targetTurn.steps.find(s => s.id === "live-thought");
        if (!liveStep) {
          liveStep = {
            id: "live-thought",
            startedAt: targetTurn.startedAt || Date.now(),
            turnTimings: targetTurn.thoughtTurnTimings,
            name: `Thinking${durSuffix}...`,
            detail: trimmedThought,
            type: "thought",
            collapsed: false
          };
          targetTurn.steps.push(liveStep);
        } else {
          liveStep.name = `Thinking${durSuffix}...`;
          liveStep.detail = trimmedThought;
          liveStep.startedAt = liveStep.startedAt || targetTurn.startedAt || Date.now();
          liveStep.turnTimings = targetTurn.thoughtTurnTimings;
          liveStep.collapsed = false;
        }
      }
    } else {
      // Transition from reasoning to normal output: finalize live thought step
      if (targetTurn.activeThought !== undefined && targetTurn.activeThought !== "") {
        const trimmedThought = String(targetTurn.activeThought).trim();
        let liveStepIdx = targetTurn.steps.findIndex(s => s.id === "live-thought");
        if (liveStepIdx !== -1) {
          if (trimmedThought.length > 0) {
            const liveStep = targetTurn.steps[liveStepIdx];
            liveStep.turnTimings = updateTurnThoughtTimings(targetTurn, "", true);
            liveStep.id = `thought-${Date.now()}`;
            liveStep.name = `Thought for ${targetTurn.duration || "a few seconds"}`;
            liveStep.detail = trimmedThought;
          liveStep.startedAt = liveStep.startedAt || targetTurn.startedAt || Date.now();
          liveStep.turnTimings = targetTurn.thoughtTurnTimings;
            liveStep.collapsed = true;
          } else {
            targetTurn.steps.splice(liveStepIdx, 1);
          }
        }
        targetTurn.activeThought = "";
      }

      targetTurn.output = (targetTurn.output || "") + chunk;

      // Parse thoughts tags and clean content in real-time
      const parsed = parseStreamingTurnContent(targetTurn.output);
      targetTurn.displayOutput = parsed.cleanText;

      // Populate completed thought steps
      parsed.completedThoughts.forEach((ct, idx) => {
        let st = targetTurn.steps.find(s => s.id === `thought-${idx + 1}`);
        if (!st) {
          st = {
            id: `thought-${idx + 1}`,
            name: `Thought for ${targetTurn.duration || "a few seconds"}`,
            detail: ct,
            type: "thought",
            collapsed: true
          };
          targetTurn.steps.push(st);
        } else {
          st.detail = ct;
        }
      });

      // Populate or update active live thought step only when non-empty thinking output exists
      let liveStepIdx = targetTurn.steps.findIndex(s => s.id === "live-thought");
      const activeThoughtText = (parsed.activeThought || "").trim();
      if (activeThoughtText.length > 0) {
        if (liveStepIdx === -1) {
          targetTurn.steps.push({
            id: "live-thought",
            startedAt: targetTurn.startedAt || Date.now(),
            turnTimings: targetTurn.thoughtTurnTimings,
            name: `Thinking${durSuffix}...`,
            detail: activeThoughtText,
            type: "thought",
            collapsed: false
          });
        } else {
          targetTurn.steps[liveStepIdx].name = `Thinking${durSuffix}...`;
          targetTurn.steps[liveStepIdx].detail = activeThoughtText;
          targetTurn.steps[liveStepIdx].collapsed = false;
        }
      } else if (liveStepIdx !== -1) {
        targetTurn.steps.splice(liveStepIdx, 1);
      }
    }

    if (activeConversationId === targetConvId) {
      if (!streamRenderRaf) {
        streamRenderRaf = requestAnimationFrame(() => {
          streamRenderRaf = null;
          renderActiveConversation();
        });
      }
    }
  }
};

window.onAgentProgress = function(data) {
  if (!data) return;
  const phase = data.phase || "Processing";
  let detail = data.detail || "";
  const pct = typeof data.progress === "number" ? data.progress : null;

  // Deduplicate repetitive prefixes when phase already specifies the action
  const phaseLower = phase.toLowerCase();
  const detailLower = detail.toLowerCase();
  if (detailLower.startsWith("loading ") && (phaseLower.includes("load") || phaseLower.includes("transfer") || phaseLower.includes("enabl"))) {
    detail = detail.substring(8).trim();
  } else if (detailLower.startsWith("enabling local model") && phaseLower.includes("enabl")) {
    detail = detail.substring(20).trim().replace(/^[:\s-]+/, "");
  }

  const text = pct !== null ? (detail ? `${phase} (${pct}%): ${detail}` : `${phase} (${pct}%)`) : (detail ? `${phase}: ${detail}` : phase);
  const isWaitingForApprovalPhase = phaseLower.startsWith("waiting for approval") || text.toLowerCase().startsWith("waiting for approval");

  if (!Array.isArray(appConversations)) return;
  const targetConvId = (typeof runningConversationId !== "undefined" && runningConversationId) ? runningConversationId : activeConversationId;
  const curConv = appConversations.find(c => c.id === targetConvId);
  if (!curConv || !Array.isArray(curConv.turns) || curConv.turns.length === 0) return;
  const targetTurn = curConv.turns[curConv.turns.length - 1];
  if (targetTurn && targetTurn.status === "running") {
    targetTurn.phase = text;
    targetTurn.lastProgressAt = Date.now();
    targetTurn.lastActivityAt = Date.now();

    if (isWaitingForApprovalPhase && typeof showApprovalCard === "function") {
      if (Array.isArray(globalApprovalQueue) && globalApprovalQueue.length > 0) {
        showApprovalCard(globalApprovalQueue[0]);
      }
      if (typeof renderProjectTree === "function") {
        renderProjectTree();
      }
    }

    const isNowActive = data.model_active === true ||
      data.phase === "Model Active" ||
      data.phase === "Model Ready" ||
      data.phase === "Processing" ||
      data.phase === "Native GPU Inference" ||
      data.phase === "Generating Response" ||
      phaseLower === "thinking";

    if (isNowActive) {
      targetTurn.modelActive = true;
    }

    if (activeConversationId === targetConvId) {
      const turnKey = targetTurn.id || (curConv.turns.length - 1);
      const statusEl = document.getElementById("cmd-status-" + turnKey);
      if (statusEl) {
        const hasPendingAppr = isWaitingForApprovalPhase || (Array.isArray(globalApprovalQueue) && globalApprovalQueue.some(q => !q.conversation_id || q.conversation_id === targetConvId));
        if (hasPendingAppr) {
          statusEl.innerText = "Waiting for approval";
        } else {
          const selectedModel = targetTurn.model || activeAiModel || "gemini-3.8-flash";
          const modelDisplayName = resolveModelDisplayName(selectedModel);
          const isLocal = typeof isSelfHostedModel === "function" ? isSelfHostedModel(selectedModel) : false;
          if (targetTurn.modelActive || !isLocal) {
            statusEl.innerText = `Processing with ${modelDisplayName}`;
          } else {
            statusEl.innerText = `Local GPU: ${modelDisplayName}`;
          }
        }
      }

      const phaseEl = document.getElementById("live-phase-" + turnKey);
      if (phaseEl && text) {
        phaseEl.setAttribute("data-backend-driven", "true");
        phaseEl.setAttribute("data-backend-driven-at", String(Date.now()));
        phaseEl.innerText = text;
        phaseEl.title = text;
      }
    }
  }
};

window.backendLogs = [];
window.structuredLogs = [];
window.execIdToConvMap = {};
window.clearedConvLogTimestamps = {};
var terminalAutoScroll = true;
var activeTerminalLogArea = "all";
var terminalLogScope = "conversation"; // "conversation" | "all"
var terminalShowDebugLogs = false;

function formatLogTimeShort(ts) {
  if (!ts) {
    const now = new Date();
    return now.toTimeString().slice(0, 8);
  }
  if (typeof ts === "string") {
    const m = ts.match(/(\d{2}:\d{2}:\d{2})/);
    if (m) return m[1];
    const d = new Date(ts);
    if (!isNaN(d.getTime())) return d.toTimeString().slice(0, 8);
  } else if (typeof ts === "number") {
    const d = new Date(ts);
    if (!isNaN(d.getTime())) return d.toTimeString().slice(0, 8);
  }
  return "";
}

function parseRawBackendLogLine(rawLine, fallbackConvId) {
  if (!rawLine || typeof rawLine !== "string") return null;
  const trimmed = rawLine.trim();
  if (!trimmed) return null;

  // Extract optional timestamp at start: "2026/10/19 15:04:05 " or ISO
  let rest = trimmed;
  let timeStr = "";
  const tsMatch = rest.match(/^(?:\d{4}[\/\-]\d{2}[\/\-]\d{2}\s+)?(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(.*)$/);
  if (tsMatch) {
    timeStr = tsMatch[1].slice(0, 8);
    rest = tsMatch[2];
  } else {
    timeStr = formatLogTimeShort();
  }

  // Extract severity level: [INFO], [DEBUG], [WARNING], [WARN], [ERROR]
  let level = "INFO";
  const lvlMatch = rest.match(/^\[(INFO|DEBUG|WARNING|WARN|ERROR)\]\s*(.*)$/i);
  if (lvlMatch) {
    level = lvlMatch[1].toUpperCase();
    if (level === "WARN") level = "WARNING";
    rest = lvlMatch[2];
  }

  // Extract optional [exec-...] tag
  let execId = "";
  const execMatch = rest.match(/^\[(exec-[^\]]+)\]\s*(.*)$/);
  if (execMatch) {
    execId = execMatch[1];
    rest = execMatch[2];
  }

  // Check if line explicitly mentions convID="..."
  let convId = "";
  const convMatch = rest.match(/convID="([^"]*)"/);
  if (convMatch && convMatch[1]) {
    convId = convMatch[1];
    if (execId) {
      window.execIdToConvMap[execId] = convId;
    }
  } else if (execId && window.execIdToConvMap[execId]) {
    convId = window.execIdToConvMap[execId];
  }

  // Detect noisy internal bridge polling actions
  const isPollingNoise =
    rest.includes("[UI-BRIDGE]") &&
    (rest.includes("getRightSidebarData") ||
      rest.includes("getRecentLogs") ||
      rest.includes("getLocalExecutorStatus") ||
      rest.includes("getLocalDownloadStatus") ||
      rest.includes("getApprovalQueue") ||
      rest.includes("setTitlebarNoDragWidth") ||
      rest.includes("setModalActive") ||
      rest.includes("clientLog") ||
      rest.includes("getInitialState") ||
      rest.includes("listConversations"));

  if (isPollingNoise) {
    return {
      raw: trimmed,
      time: timeStr,
      level: "DEBUG",
      area: "system",
      convId: convId || "",
      execId: execId,
      isDebug: true,
      isPollingNoise: true,
      summary: rest.replace(/^\[UI-BRIDGE\]\s*/, "UI Bridge: "),
      detail: ""
    };
  }

  let isDebug = level === "DEBUG" || rest.startsWith("[UI-BRIDGE]") || rest.startsWith("[DEBUG]");
  let area = "system";
  let summary = rest;
  let detail = "";

  // Humanize known backend patterns and classify into functional areas:
  // 1. AgentBridge RunPrompt start
  if (rest.includes("AgentBridge RunPrompt:")) {
    area = "agent";
    const modelM = rest.match(/model="([^"]*)"/);
    const reasM = rest.match(/reasoning="([^"]*)"/);
    const attM = rest.match(/attachments=(\d+)/);
    const lenM = rest.match(/prompt length=(\d+)/);
    const mName = (modelM && modelM[1]) ? modelM[1] : "active model";
    const rName = (reasM && reasM[1]) ? reasM[1] : "low";
    summary = `Started agent run with ${mName}`;
    const parts = [`Reasoning: ${rName}`];
    if (lenM && lenM[1]) parts.push(`Prompt: ${lenM[1]} chars`);
    if (attM && attM[1] && attM[1] !== "0") parts.push(`Attachments: ${attM[1]}`);
    detail = parts.join(" · ");
    isDebug = false;
  } else if (rest.includes("Executing Shuffle Cloud") || rest.includes("Shuffle AI request") || rest.includes("Calling LLM") || rest.includes("Sending request to")) {
    area = "model";
    summary = rest.replace(/^\[[^\]]+\]\s*/, "");
    isDebug = false;
  } else if (/local executor|tendon|gguf|vram|gpu|llama|model loaded|switching model|download/i.test(rest)) {
    area = "model";
    summary = rest
      .replace(/^\[LOCAL-EXEC\]\s*/i, "")
      .replace(/^\[TENDON\]\s*/i, "")
      .replace(/^\[MODEL\]\s*/i, "");
    if (/^\[UI-BRIDGE\]/i.test(rest)) {
      isDebug = true;
    }
  } else if (/tool|command|shell|bash|powershell|exec|read_file|write_file|edit_file|replace_file|search|mcp|approval/i.test(rest) && !rest.includes("[UI-BRIDGE]")) {
    area = "tools";
    summary = rest
      .replace(/^\[TOOL\]\s*/i, "")
      .replace(/^\[SHELL\]\s*/i, "")
      .replace(/^\[EXEC\]\s*/i, "");
  } else if (execId || /agent|turn|prompt|reasoning|subagent|conversation|response|completed|step/i.test(rest)) {
    if (!rest.includes("[UI-BRIDGE]")) {
      area = "agent";
    }
  }

  // Humanize UI-BRIDGE actions when Debug is toggled ON
  if (rest.startsWith("[UI-BRIDGE]")) {
    isDebug = true;
    const actM = rest.match(/Action:\s*([^\s(]+)\s*\(payload len:\s*(\d+)\)/);
    const delM = rest.match(/Delegating action "([^"]+)"/);
    const cmpM = rest.match(/Completed action "([^"]+)"\s*\(response len:\s*(\d+)\)/);
    if (actM) {
      summary = `Bridge call: ${actM[1]}`;
      detail = `Payload: ${actM[2]} B`;
    } else if (delM) {
      summary = `Bridge dispatch: ${delM[1]}`;
    } else if (cmpM) {
      summary = `Bridge completed: ${cmpM[1]}`;
      detail = `Response: ${cmpM[2]} B`;
    } else {
      summary = rest.replace(/^\[UI-BRIDGE\]\s*/, "");
    }
  }

  // Fallback conversation attribution for active execution logs
  if (!convId && fallbackConvId && (area === "agent" || area === "tools" || area === "model" || execId)) {
    convId = fallbackConvId;
  }

  return {
    raw: trimmed,
    time: timeStr,
    timestampMs: Date.now(),
    level: level,
    area: area,
    convId: convId || "",
    execId: execId,
    isDebug: isDebug,
    isPollingNoise: false,
    summary: summary,
    detail: detail
  };
}

function getSynthesizedConversationLogs(convId) {
  if (!convId || !Array.isArray(appConversations)) return [];
  const conv = appConversations.find(c => c && c.id === convId);
  if (!conv || !Array.isArray(conv.turns) || conv.turns.length === 0) return [];

  const clearAfter = window.clearedConvLogTimestamps[convId] || 0;
  const entries = [];
  const baseTime = conv.updated_at ? formatLogTimeShort(conv.updated_at) : formatLogTimeShort();

  conv.turns.forEach((turn, idx) => {
    if (!turn) return;
    const turnTs = turn.timestamp ? new Date(turn.timestamp).getTime() : 0;
    if (clearAfter && turnTs && turnTs < clearAfter) return;

    const tTime = turn.timestamp ? formatLogTimeShort(turn.timestamp) : baseTime;
    const promptText = (turn.prompt || "").trim();
    const isShell = promptText.startsWith("$ ") || promptText.startsWith("> ");

    if (isShell) {
      entries.push({
        time: tTime,
        level: "INFO",
        area: "tools",
        convId: convId,
        isDebug: false,
        summary: `Executed shell command`,
        detail: promptText.length > 120 ? promptText.slice(0, 117) + "..." : promptText
      });
    } else if (promptText) {
      entries.push({
        time: tTime,
        level: "INFO",
        area: "agent",
        convId: convId,
        isDebug: false,
        summary: `Turn #${idx + 1} started`,
        detail: promptText.length > 100 ? promptText.slice(0, 97) + "..." : promptText
      });
    }

    const usedModel = turn.model || conv.model || conv.ai_model || "";
    const usedReasoning = turn.reasoning || conv.reasoning || "low";
    if (usedModel && !isShell) {
      entries.push({
        time: tTime,
        level: "INFO",
        area: "model",
        convId: convId,
        isDebug: false,
        summary: `Model invoked: ${usedModel}`,
        detail: `Reasoning effort: ${usedReasoning}`
      });
    }

    // Extract tool calls / steps if recorded on the turn
    const steps = Array.isArray(turn.steps) ? turn.steps : (Array.isArray(turn.tool_calls) ? turn.tool_calls : []);
    steps.forEach(step => {
      if (!step) return;
      const toolName = step.tool || step.name || step.action || step.type || "tool";
      const toolDetail = step.summary || step.command || step.path || step.file || step.description || "";
      entries.push({
        time: step.time ? formatLogTimeShort(step.time) : tTime,
        level: step.error ? "ERROR" : "INFO",
        area: "tools",
        convId: convId,
        isDebug: false,
        summary: `Tool action: ${toolName}`,
        detail: typeof toolDetail === "string" && toolDetail.length > 120 ? toolDetail.slice(0, 117) + "..." : String(toolDetail || "")
      });
    });

    // If the turn modified files, list them under tools
    if (Array.isArray(turn.files) && turn.files.length > 0) {
      const fileNames = turn.files.map(f => (typeof f === "string" ? f : (f.path || f.name || ""))).filter(Boolean);
      if (fileNames.length > 0) {
        entries.push({
          time: tTime,
          level: "INFO",
          area: "tools",
          convId: convId,
          isDebug: false,
          summary: `Touched ${fileNames.length} file${fileNames.length === 1 ? "" : "s"}`,
          detail: fileNames.slice(0, 4).join(", ") + (fileNames.length > 4 ? ` (+${fileNames.length - 4} more)` : "")
        });
      }
    }

    if (turn.status === "running") {
      entries.push({
        time: formatLogTimeShort(),
        level: "INFO",
        area: "agent",
        convId: convId,
        isDebug: false,
        summary: `Agent is actively processing turn #${idx + 1}...`,
        detail: ""
      });
    } else if (turn.status === "error" || turn.isError || turn.error) {
      const errMsg = turn.error || (turn.info && turn.info.error) || turn.rawOutput || "Execution failed";
      entries.push({
        time: tTime,
        level: "ERROR",
        area: "agent",
        convId: convId,
        isDebug: false,
        summary: `Turn #${idx + 1} encountered an error`,
        detail: String(errMsg).slice(0, 160)
      });
    } else if (turn.rawOutput || turn.status === "done" || turn.status === "completed") {
      const outLen = typeof turn.rawOutput === "string" ? turn.rawOutput.length : 0;
      const dur = turn.duration || (turn.info && turn.info.duration) || "";
      entries.push({
        time: tTime,
        level: "INFO",
        area: "agent",
        convId: convId,
        isDebug: false,
        summary: `Turn #${idx + 1} completed${dur ? ` in ${dur}` : ""}`,
        detail: outLen > 0 ? `Output: ${outLen} chars` : ""
      });
    }
  });

  return entries;
}

function getFilteredTerminalLogEntries() {
  const targetConvId = activeConversationId || ((typeof runningConversationId !== "undefined" && runningConversationId) ? runningConversationId : "");
  const clearAfter = (terminalLogScope === "conversation" && targetConvId)
    ? (window.clearedConvLogTimestamps[targetConvId] || 0)
    : (window.clearedConvLogTimestamps["__all__"] || 0);

  // Gather live structured logs matching scope
  const liveMatching = window.structuredLogs.filter(item => {
    if (!item) return false;
    if (clearAfter && item.timestampMs && item.timestampMs < clearAfter) return false;
    if (!terminalShowDebugLogs && (item.isDebug || item.isPollingNoise)) return false;
    if (terminalShowDebugLogs && item.isPollingNoise) return false; // never flood with 2s polling unless needed
    if (terminalLogScope === "conversation") {
      if (!targetConvId) return false;
      return item.convId === targetConvId;
    }
    return true;
  });

  let combined = [];
  if (terminalLogScope === "conversation") {
    const synth = getSynthesizedConversationLogs(targetConvId);
    // Combine synthesized turn milestones with live runner events for this conversation
    combined = synth.concat(liveMatching);
  } else {
    combined = liveMatching.slice();
  }

  // Update area counts on filter buttons before filtering by activeTerminalLogArea
  const counts = { all: combined.length, agent: 0, tools: 0, model: 0, system: 0 };
  combined.forEach(item => {
    if (counts[item.area] !== undefined) counts[item.area]++;
  });

  ["all", "agent", "tools", "model", "system"].forEach(areaKey => {
    const btn = document.getElementById("btn-log-area-" + areaKey);
    if (!btn) return;
    const labels = { all: "All", agent: "Agent", tools: "Tools", model: "Model", system: "System" };
    const c = counts[areaKey] || 0;
    btn.innerHTML = c > 0
      ? `${labels[areaKey]} <span class="rs-log-area-count">${c}</span>`
      : labels[areaKey];
    btn.classList.toggle("active", activeTerminalLogArea === areaKey);
  });

  if (activeTerminalLogArea !== "all") {
    combined = combined.filter(item => item.area === activeTerminalLogArea);
  }

  return combined;
}

function renderTerminalLogs() {
  const out = document.getElementById("rs-terminal-output");
  if (!out) return;

  // Update scope & debug button states
  const scopeBtn = document.getElementById("btn-log-scope");
  if (scopeBtn) {
    const isConvScope = terminalLogScope === "conversation";
    scopeBtn.innerText = isConvScope ? "This Chat" : "All Chats";
    scopeBtn.classList.toggle("active", isConvScope);
  }
  const dbgBtn = document.getElementById("btn-log-debug");
  if (dbgBtn) {
    dbgBtn.innerText = terminalShowDebugLogs ? "Debug: ON" : "Debug: OFF";
    dbgBtn.classList.toggle("active", terminalShowDebugLogs);
  }

  // Update header title to reflect scope
  const shellTitleEl = document.getElementById("rs-terminal-shell-title");
  if (shellTitleEl) {
    if (terminalLogScope === "conversation" && activeConversationId && Array.isArray(appConversations)) {
      const c = appConversations.find(x => x && x.id === activeConversationId);
      const cTitle = (c && c.title) ? c.title : "Current Chat";
      shellTitleEl.innerText = cTitle.length > 26 ? cTitle.slice(0, 24) + "…" : cTitle;
    } else if (terminalLogScope === "conversation") {
      shellTitleEl.innerText = "This Chat";
    } else {
      shellTitleEl.innerText = "All Runner Activity";
    }
  }

  const entries = getFilteredTerminalLogEntries();
  if (entries.length === 0) {
    const areaLabel = activeTerminalLogArea === "all" ? "" : ` in ${activeTerminalLogArea.toUpperCase()}`;
    if (terminalLogScope === "conversation" && !activeConversationId) {
      out.innerHTML = `
        <div class="rs-log-empty">
          No active conversation selected.
          <div class="rs-log-empty-sub">Start a prompt to see per-conversation activity logs, or switch to <strong>All Chats</strong>.</div>
        </div>
      `;
    } else {
      out.innerHTML = `
        <div class="rs-log-empty">
          No activity logs${areaLabel} for ${terminalLogScope === "conversation" ? "this conversation" : "the runner"} yet.
          <div class="rs-log-empty-sub">${!terminalShowDebugLogs ? "Low-level debug logs are hidden. Toggle Debug: ON if inspecting bridge internals." : "Run a prompt or tool action to record activity."}</div>
        </div>
      `;
    }
    return;
  }

  const areaBadges = {
    agent: "Agent",
    tools: "Tools",
    model: "Model",
    system: "System"
  };

  out.innerHTML = entries.map(item => {
    const badgeLabel = item.level === "ERROR" ? "Error" : (areaBadges[item.area] || "Log");
    const rowClasses = [
      "rs-log-row",
      item.isDebug ? "is-debug" : "",
      item.level === "ERROR" ? "is-error" : ""
    ].filter(Boolean).join(" ");
    const detailHtml = item.detail
      ? `<div class="rs-log-detail">${escapeHtml(item.detail)}</div>`
      : "";
    return `
      <div class="${rowClasses}">
        <span class="rs-log-time">${escapeHtml(item.time || "")}</span>
        <span class="rs-log-badge">${escapeHtml(badgeLabel)}</span>
        <div class="rs-log-body">
          <div class="rs-log-summary">${escapeHtml(item.summary || "")}</div>
          ${detailHtml}
        </div>
      </div>
    `;
  }).join("");

  if (terminalAutoScroll) {
    out.scrollTop = out.scrollHeight;
  }
}
window.renderTerminalLogs = renderTerminalLogs;

function filterTerminalLogsByArea(area) {
  activeTerminalLogArea = area || "all";
  renderTerminalLogs();
}
window.filterTerminalLogsByArea = filterTerminalLogsByArea;

function toggleTerminalLogScope() {
  terminalLogScope = terminalLogScope === "conversation" ? "all" : "conversation";
  renderTerminalLogs();
}
window.toggleTerminalLogScope = toggleTerminalLogScope;

function toggleTerminalDebugLogs() {
  terminalShowDebugLogs = !terminalShowDebugLogs;
  renderTerminalLogs();
}
window.toggleTerminalDebugLogs = toggleTerminalDebugLogs;

window.onBackendLog = function(logLine) {
  if (!logLine) return;
  window.backendLogs.push(logLine);
  if (window.backendLogs.length > 1000) {
    window.backendLogs.shift();
  }

  const targetConvId = (typeof runningConversationId !== "undefined" && runningConversationId) ? runningConversationId : activeConversationId;
  const parsed = parseRawBackendLogLine(logLine, targetConvId);
  if (parsed) {
    window.structuredLogs.push(parsed);
    if (window.structuredLogs.length > 1000) {
      window.structuredLogs.shift();
    }
  }

  // 1. Re-render structured terminal panel if visible
  renderTerminalLogs();

  // 2. Update active status indicator
  const statusEl = document.getElementById("rs-terminal-status-text");
  if (statusEl && parsed && !parsed.isPollingNoise) {
    statusEl.innerText = "Active";
  }

  // 3. Update active turn's live log indicator only with non-debug, human-readable activity
  if (parsed && !parsed.isDebug && !parsed.isPollingNoise && activeConversationId === targetConvId && targetConvId && Array.isArray(appConversations)) {
    const curConv = appConversations.find(c => c.id === targetConvId);
    if (curConv && curConv.turns && curConv.turns.length > 0) {
      const activeTurn = curConv.turns[curConv.turns.length - 1];
      if (activeTurn && activeTurn.status === "running") {
        const turnKey = activeTurn.id || (curConv.turns.length - 1);
        const liveLogEl = document.getElementById("live-log-" + turnKey);
        if (liveLogEl) {
          let cleanSnippet = parsed.summary || "";
          if (cleanSnippet.length > 55) cleanSnippet = cleanSnippet.slice(0, 52) + "...";
          liveLogEl.innerText = cleanSnippet;
          liveLogEl.title = parsed.detail ? `${parsed.summary} — ${parsed.detail}` : parsed.summary;
        }
      }
    }
  }
};

async function loadBackendLogs() {
  const out = document.getElementById("rs-terminal-output");
  if (!out) return;
  try {
    const raw = await callGo("getRecentLogs", "");
    if (raw) {
      const res = JSON.parse(raw);
      if (res && Array.isArray(res.logs) && res.logs.length > 0) {
        window.backendLogs = res.logs;
        const targetConvId = (typeof runningConversationId !== "undefined" && runningConversationId) ? runningConversationId : activeConversationId;
        window.structuredLogs = res.logs
          .map(line => parseRawBackendLogLine(line, targetConvId))
          .filter(Boolean);
      }
    }
  } catch (e) {
    console.warn("Failed to load backend logs:", e);
  }
  renderTerminalLogs();
}
window.loadBackendLogs = loadBackendLogs;

function copyTerminalLogs() {
  const entries = getFilteredTerminalLogEntries();
  const text = entries.map(e => {
    const prefix = `[${e.time || ""}] [${(e.area || "log").toUpperCase()}] `;
    return prefix + (e.summary || "") + (e.detail ? ` — ${e.detail}` : "");
  }).join("\n");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast("Activity logs copied");
    }).catch(() => {
      showToast("Copied");
    });
  } else {
    showToast("Copied");
  }
}
window.copyTerminalLogs = copyTerminalLogs;

function toggleTerminalAutoScroll() {
  terminalAutoScroll = !terminalAutoScroll;
  const btn = document.getElementById("btn-scroll-terminal");
  if (btn) {
    btn.innerText = terminalAutoScroll ? "Auto-scroll: ON" : "Auto-scroll: OFF";
  }
}
window.toggleTerminalAutoScroll = toggleTerminalAutoScroll;

function openTerminalLogsTab() {
  const sb = document.getElementById("preview-sidebar") || document.getElementById("right-sidebar");
  if (sb && sb.style.display === "none") {
    sb.style.display = "flex";
    const btn = document.getElementById("btn-toggle-right-sidebar");
    if (btn) btn.classList.add("active");
  }
  switchRightSidebarTab("terminal");
}
window.openTerminalLogsTab = openTerminalLogsTab;

function extractRunningTasksFromDecisions(decisions) {
  if (!Array.isArray(decisions) || decisions.length === 0) return [];
  const tasks = [];
  decisions.forEach(d => {
    if (!d) return;
    const rd = d.run_details || {};
    const st = String(rd.status || d.status || "").toUpperCase();
    const runs = String(d.runs || "").toLowerCase();
    if (st === "RUNNING" || st === "WAITING" || runs === "background") {
      const taskName = d.action || d.tool || rd.action_name || (d.fields && d.fields[0] ? d.fields[0].value : "") || "Background Task";
      tasks.push({
        id: rd.id || ("task-" + (d.i || Math.random())),
        name: taskName,
        status: st || "RUNNING"
      });
    }
  });
  return tasks;
}

function renderRunningTasks() {
  const panel = document.getElementById("running-tasks-panel");
  const countLabel = document.getElementById("running-tasks-count-label");
  const listEl = document.getElementById("running-tasks-list");
  if (!panel || !countLabel || !listEl) return;

  if (!activeRunningTasks || activeRunningTasks.length === 0) {
    panel.style.display = "none";
    listEl.innerHTML = "";
    return;
  }

  panel.style.display = "flex";
  const count = activeRunningTasks.length;
  countLabel.innerText = `${count} task${count === 1 ? "" : "s"} running`;

  listEl.innerHTML = "";
  activeRunningTasks.forEach(task => {
    const item = document.createElement("div");
    item.className = "running-task-item";
    item.innerHTML = `
      <svg class="running-task-spinner" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <circle cx="12" cy="12" r="9" stroke-dasharray="28 28"/>
      </svg>
      <span class="running-task-cmd">${escapeHtml(task.name || task.cmd || "Task")}</span>
    `;
    listEl.appendChild(item);
  });
}

function toggleRunningTasks() {
  const panel = document.getElementById("running-tasks-panel");
  if (panel) {
    panel.classList.toggle("collapsed");
  }
}

function resolveModelDisplayName(rawModelKey) {
  const curModel = (rawModelKey || (typeof window !== "undefined" && window.activeAiModel) || activeAiModel || localStorage.getItem("orborus_ai_model") || "").trim();
  const savedCustomModel = (localStorage.getItem("orborus_custom_model") || "").trim();

  if (curModel === "shuffle-ai" || curModel === "shuffle") {
    return "Shuffle AI";
  }

  // 1. Predefined models (Local Models, Gemini, Claude, GPT, etc.)
  if (curModel && curModel !== "custom") {
    const predefined = AVAILABLE_AI_MODELS.find(m => m.key === curModel && m.key !== "custom");
    if (predefined) {
      if (predefined.key === "tendon-local" && window.localModelPath) {
        return typeof formatEasyModelName === "function" ? formatEasyModelName(window.localModelPath) : "Gemma 4 26B";
      }
      return predefined.label;
    }
  }

  // 2. If tendon / local GPU engine: format cleanly
  if (curModel === "tendon-local" || curModel.startsWith("tendon") || curModel.startsWith("local") || curModel.includes("gemma")) {
    if (window.localModelPath) {
      return typeof formatEasyModelName === "function" ? formatEasyModelName(window.localModelPath) : "Gemma 4 26B";
    }
    return "Gemma 4 26B";
  }

  // 3. Custom model - just show the model name directly
  const customName = (curModel && curModel !== "custom") ? curModel : savedCustomModel;
  if (customName) {
    return customName;
  }

  // If no custom name was configured, default to Local model if available
  const isLocalAvail = (window.localExecutorAvailable !== false);
  if (isLocalAvail) {
    if (window.localModelPath) {
      return typeof formatEasyModelName === "function" ? formatEasyModelName(window.localModelPath) : "Gemma 4 26B";
    }
    return "Gemma 4 26B";
  }

  return "Shuffle AI";
}

async function refreshLocalModelCatalog() {
  try {
    let raw = null;
    if (typeof window.bridgeCall === "function") {
      raw = await window.bridgeCall("getLocalModelCatalog", "{}");
    } else if (typeof callGo === "function") {
      raw = await callGo("getLocalModelCatalog", "{}");
    }
    if (!raw) return null;
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (data && typeof updateLocalModelCatalogState === "function") {
      updateLocalModelCatalogState(
        data.catalog,
        data.free_disk_bytes,
        data.free_disk_gb,
        data.free_disk_display,
        data.download_state
      );
    }
    if (typeof updateActiveModelLabel === "function") {
      updateActiveModelLabel();
    }
    return data;
  } catch (e) {
    console.warn("refreshLocalModelCatalog error:", e);
    return null;
  }
}

async function startLocalModelDownload(modelKey) {
  const targetKey = (modelKey || activeAiModel || (typeof window !== "undefined" && window.activeAiModel) || "").trim();
  if (!targetKey) return;

  const status = (typeof getModelConfigStatus === "function") ? getModelConfigStatus(targetKey) : {};
  if (status.isOutsideRange) {
    if (typeof showToast === "function") {
      showToast(status.reason || "Model exceeds hardware RAM/VRAM range.");
    }
    return;
  }
  if (status.isLowDisk) {
    if (typeof showToast === "function") {
      showToast(status.reason || "Insufficient free disk space to download this model.");
    }
    if (typeof openSettingsModal === "function") {
      openSettingsModal("mode-local");
    }
    return;
  }

  const def = (typeof AVAILABLE_AI_MODELS !== "undefined" && AVAILABLE_AI_MODELS.find(m => m.key === targetKey)) || { key: targetKey, label: targetKey };
  if (typeof window !== "undefined") {
    window.localModelDownloadState = {
      status: "downloading",
      model_key: targetKey,
      label: def.cleanName || def.label || targetKey,
      filename: def.filename || "",
      downloaded_bytes: 0,
      total_bytes: def.sizeBytes || 0,
      progress_pct: 0,
      speed_mbps: 0
    };
  }
  updateActiveModelLabel();
  const menu = document.getElementById("model-dropdown-menu");
  if (menu && menu.classList.contains("visible")) {
    renderModelDropdown();
  }
  if (typeof showToast === "function") {
    showToast(`Starting download: ${def.cleanName || def.label} (${def.sizeDisplay || "GGUF"})...`);
  }

  try {
    const payload = JSON.stringify({ model_key: targetKey, directory: (typeof window !== "undefined" && window.localModelsDir) || "" });
    let raw = null;
    if (typeof window.bridgeCall === "function") {
      raw = await window.bridgeCall("downloadLocalModel", payload);
    } else if (typeof callGo === "function") {
      raw = await callGo("downloadLocalModel", payload);
    }
    if (raw) {
      const res = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (res && res.status === "error") {
        if (typeof window !== "undefined") {
          window.localModelDownloadState = {
            status: "error",
            model_key: targetKey,
            label: def.cleanName || def.label || targetKey,
            error: res.error || "Download failed"
          };
        }
        updateActiveModelLabel();
        if (typeof showToast === "function") {
          showToast(res.error || "Failed to start model download");
        }
      } else if (res && res.download_state) {
        if (typeof window !== "undefined") {
          window.localModelDownloadState = res.download_state;
        }
        updateActiveModelLabel();
      }
    }
  } catch (err) {
    console.error("startLocalModelDownload error:", err);
    if (typeof showToast === "function") {
      showToast("Download error: " + (err.message || err));
    }
  }
}

async function cancelLocalModelDownload() {
  try {
    if (typeof window.bridgeCall === "function") {
      await window.bridgeCall("cancelLocalModelDownload", "{}");
    } else if (typeof callGo === "function") {
      await callGo("cancelLocalModelDownload", "{}");
    }
  } catch (e) {
    console.warn("cancelLocalModelDownload error:", e);
  }
  if (typeof window !== "undefined" && window.localModelDownloadState) {
    window.localModelDownloadState.status = "cancelled";
  }
  updateActiveModelLabel();
  const menu = document.getElementById("model-dropdown-menu");
  if (menu && menu.classList.contains("visible")) {
    renderModelDropdown();
  }
  if (typeof showToast === "function") {
    showToast("Model download cancelled");
  }
  await refreshLocalModelCatalog();
}

window.onLocalModelDownloadProgress = function(st) {
  if (!st) return;
  if (typeof st === "string") {
    try { st = JSON.parse(st); } catch (_) { return; }
  }
  window.localModelDownloadState = st;
  if (typeof st.free_disk_gb === "number" && st.free_disk_gb > 0) {
    window.localDiskFreeGB = st.free_disk_gb;
    window.localDiskFreeBytes = Math.round(st.free_disk_gb * 1024 * 1024 * 1024);
    window.localDiskFreeDisplay = `${st.free_disk_gb.toFixed(1)} GB`;
  }

  if (st.status === "completed" && st.model_key) {
    if (!window.localModelsCatalog) window.localModelsCatalog = {};
    if (!window.localModelsCatalog[st.model_key]) {
      window.localModelsCatalog[st.model_key] = { key: st.model_key };
    }
    window.localModelsCatalog[st.model_key].installed = true;
    window.localModelsCatalog[st.model_key].installed_path = st.target_path || "";
    window.localModelsCatalog[st.model_key].is_downloading = false;
    if (st.target_path) {
      window.localModelPath = st.target_path;
      try { localStorage.setItem("orborus_local_model_path", st.target_path); } catch (_) {}
    }
    if (typeof showToast === "function") {
      showToast(`Model ready: ${st.label || st.model_key}`);
    }
    refreshLocalModelCatalog();
    if (typeof activeSettingsTab !== "undefined" && activeSettingsTab === "mode-local" && typeof scanLocalModels === "function") {
      scanLocalModels();
    }
  } else if (st.status === "error" && st.error) {
    if (typeof showToast === "function") {
      showToast(`Download error (${st.label || st.model_key}): ${st.error}`);
    }
  }

  updateActiveModelLabel();

  // Live-update open flyout badge in place without closing the flyout
  if (st.model_key) {
    const flyoutBadge = document.querySelector(`[data-dl-badge="${st.model_key}"]`);
    if (flyoutBadge) {
      if (st.status === "downloading") {
        flyoutBadge.textContent = `Downloading ${st.progress_pct || 0}%`;
      } else if (st.status === "completed") {
        flyoutBadge.textContent = "On Disk";
      }
    }
  }
  const menu = document.getElementById("model-dropdown-menu");
  if (menu && menu.classList.contains("visible") && !activeSubmenuFlyout) {
    renderModelDropdown();
  }
};

if (typeof window !== "undefined") {
  window.refreshLocalModelCatalog = refreshLocalModelCatalog;
  window.startLocalModelDownload = startLocalModelDownload;
  window.cancelLocalModelDownload = cancelLocalModelDownload;
}

function updateActiveModelLabel() {
  const nameEl = document.getElementById("lbl-active-model-name");
  const pickerBtn = document.getElementById("btn-model-picker");
  const curModel = activeAiModel || (typeof window !== "undefined" && window.activeAiModel) || (typeof localStorage !== "undefined" && localStorage.getItem("orborus_ai_model")) || "tendon-local";
  const display = resolveModelDisplayName(curModel);
  const queueCount = (promptMessageQueue && promptMessageQueue.length > 0) ? `<span class="queue-pill-counter">${promptMessageQueue.length} queued</span>` : "";
  const safeText = (typeof escapeHtml === "function") ? escapeHtml(display) : display;

  const status = (typeof getModelConfigStatus === "function") ? getModelConfigStatus(curModel) : { configured: true };
  const dlState = (typeof window !== "undefined" && window.localModelDownloadState) || null;
  const isThisDownloading = !!(status.isDownloading || (dlState && dlState.status === "downloading" && dlState.model_key === curModel));
  const dlPct = isThisDownloading ? (typeof status.progressPct === "number" ? status.progressPct : (dlState ? dlState.progress_pct || 0 : 0)) : 0;
  const dlChip = isThisDownloading ? `<span class="queue-pill-counter" style="margin-left:6px;">Downloading ${dlPct}%</span>` : "";

  if (nameEl) {
    nameEl.innerHTML = `<span>${safeText}</span>${dlChip}${queueCount}`;
    if (isThisDownloading) {
      nameEl.title = status.reason || `Downloading ${display} (${dlPct}%)`;
    } else if (!status.configured) {
      nameEl.title = `Active Model: ${display} (${status.reason || "Not configured"})`;
    } else if (status.needsDownload) {
      nameEl.title = `Active Model: ${display} — ${status.reason}`;
    } else {
      nameEl.title = `Active Model: ${display}`;
    }
  }

  if (pickerBtn) {
    pickerBtn.classList.remove("unconfigured");
  }

  // Update in-card non-intrusive reminder
  updateModelConfigReminder(curModel, display, status);
}

function updateModelConfigReminder(modelKey, display, status) {
  const reminderEl = document.getElementById("model-config-reminder");
  const textEl = document.getElementById("model-config-reminder-text");
  const actionBtn = document.getElementById("btn-model-reminder-action");
  const localBtn = document.getElementById("btn-model-reminder-local");

  if (!reminderEl) return;

  const dlState = (typeof window !== "undefined" && window.localModelDownloadState) || null;
  const anyDownloading = !!(dlState && dlState.status === "downloading");

  // 1. Active download in progress (either for the selected model or a background local model)
  if ((status && status.isDownloading) || anyDownloading) {
    reminderEl.style.display = "flex";
    const pct = typeof dlState.progress_pct === "number" ? dlState.progress_pct : (status.progressPct || 0);
    const dlGB = ((dlState.downloaded_bytes || 0) / (1024 * 1024 * 1024)).toFixed(2);
    const totGB = ((dlState.total_bytes || 1) / (1024 * 1024 * 1024)).toFixed(2);
    const speedStr = dlState.speed_mbps ? ` · ${dlState.speed_mbps} MB/s` : "";
    const freeStr = window.localDiskFreeDisplay ? ` · ${window.localDiskFreeDisplay} free` : "";
    if (textEl) {
      textEl.innerText = `Downloading ${dlState.label || display} · ${pct}% (${dlGB} / ${totGB} GB${speedStr}${freeStr})`;
    }
    if (actionBtn) {
      actionBtn.innerText = "Cancel";
      actionBtn.setAttribute("data-action-type", "cancel_download");
      actionBtn.setAttribute("data-model-key", dlState.model_key || modelKey);
    }
    if (localBtn) {
      localBtn.style.display = "none";
    }
    return;
  }

  // 2. Local model selected that is not yet on disk (but fits in RAM/VRAM and disk space)
  if (status && status.needsDownload) {
    reminderEl.style.display = "flex";
    if (textEl) {
      textEl.innerText = status.reason || `${display} (${status.sizeDisplay || "GGUF"}) is not on disk yet. Will download automatically on run.`;
    }
    if (actionBtn) {
      actionBtn.innerText = status.actionText || `Download (${status.sizeDisplay || "GGUF"})`;
      actionBtn.setAttribute("data-action-type", "download_model");
      actionBtn.setAttribute("data-model-key", modelKey);
    }
    if (localBtn) {
      localBtn.style.display = "none";
    }
    return;
  }

  if (!status || status.configured) {
    reminderEl.style.display = "none";
    return;
  }

  reminderEl.style.display = "flex";
  if (textEl) {
    if (status.category === "Shuffle AI") {
      textEl.innerText = `${display} requires Shuffle Cloud login. Prompts will fail until connected.`;
    } else if (status.category === "BYOK Models") {
      textEl.innerText = `${display} is not configured: ${status.reason || "API key needed"}.`;
    } else if (status.isOutsideRange) {
      textEl.innerText = `${display} exceeds hardware capacity (${status.estimatedRam || "RAM limit"}). Prompts cannot run.`;
    } else if (status.isLowDisk) {
      textEl.innerText = status.reason || `${display} cannot be downloaded: insufficient disk space.`;
    } else {
      textEl.innerText = `${display} is unavailable: ${status.reason || "Not configured"}.`;
    }
  }

  if (actionBtn) {
    actionBtn.innerText = status.actionText || "Configure";
    actionBtn.setAttribute("data-action-type", status.actionType || "byok");
    actionBtn.setAttribute("data-model-key", modelKey || "");
  }

  if (localBtn) {
    const hasLocal = (typeof window !== "undefined" && window.localExecutorAvailable !== false);
    const isAlreadyLocal = modelKey === "tendon-local" || modelKey.startsWith("tendon") || modelKey.startsWith("local");
    if (hasLocal && !isAlreadyLocal) {
      localBtn.style.display = "inline-flex";
    } else {
      localBtn.style.display = "none";
    }
  }
}

function handleReminderAction() {
  const actionBtn = document.getElementById("btn-model-reminder-action");
  const actionType = actionBtn ? actionBtn.getAttribute("data-action-type") : "byok";
  const modelKey = actionBtn ? actionBtn.getAttribute("data-model-key") : "";
  if (actionType === "download_model") {
    startLocalModelDownload(modelKey || activeAiModel);
  } else if (actionType === "cancel_download") {
    cancelLocalModelDownload();
  } else if (actionType === "storage_settings" || actionType === "hardware" || actionType === "hardware_limit") {
    openSettingsModal("mode-local");
  } else if (actionType === "auth" || modelKey === "shuffle-ai" || modelKey === "shuffle") {
    openSettingsModal("mode-shuffle");
    if (typeof loginWithOAuth === "function") {
      loginWithOAuth();
    }
  } else {
    if (typeof openSettingsForModel === "function") {
      openSettingsForModel(modelKey || activeAiModel, "key");
    } else {
      openSettingsModal("mode-direct", "key");
    }
  }
}

function handleReminderUseLocal() {
  selectAiModel("tendon-local", "Gemma 4 26B");
}

if (typeof window !== "undefined") {
  window.handleReminderAction = handleReminderAction;
  window.handleReminderUseLocal = handleReminderUseLocal;
  window.updateModelConfigReminder = updateModelConfigReminder;
}

function updateActiveReasoningLabel() {
  const lbl = document.getElementById("lbl-active-reasoning");
  if (!lbl) return;
  const current = activeReasoningEffort || localStorage.getItem("orborus_ai_reasoning") || "low";
  let display = "Low";
  if (current === "high") display = "High";
  else if (current === "medium") display = "Medium";
  else if (current === "minimal" || current === "off" || current === "none") display = "Off";
  else display = "Low";
  lbl.textContent = `Reasoning: ${display}`;
}

function positionDropdownUpOrDown(btn, menu) {
  if (!btn || !menu) return;
  const isChat = document.querySelector(".chat-mode") || document.querySelector(".center-container.chat-mode") || document.querySelector(".main-workspace.chat-mode");
  const rect = btn.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  // When text field is at the bottom of the screen (chat-mode) or space below is less than 350px, grow upwards
  if (isChat || spaceBelow < 350) {
    menu.classList.add("grow-up");
    menu.classList.remove("grow-down");
  } else {
    menu.classList.add("grow-down");
    menu.classList.remove("grow-up");
  }
}

let activeSubmenuFlyout = null;
let activeFamilyRow = null;
let submenuHideTimer = null;

function hideLocalModelSubmenu(immediate = false) {
  if (submenuHideTimer) {
    clearTimeout(submenuHideTimer);
    submenuHideTimer = null;
  }
  const doHide = () => {
    if (activeSubmenuFlyout && activeSubmenuFlyout.parentNode) {
      activeSubmenuFlyout.parentNode.removeChild(activeSubmenuFlyout);
    }
    activeSubmenuFlyout = null;
    if (activeFamilyRow) {
      activeFamilyRow.classList.remove("submenu-open");
      activeFamilyRow = null;
    }
  };
  if (immediate) {
    doHide();
  } else {
    submenuHideTimer = setTimeout(doHide, 180);
  }
}

function parseModelSizeNum(m) {
  if (!m) return 0;
  const str = `${m.sizeLabel || ""} ${m.cleanName || ""} ${m.label || ""} ${m.key || ""}`;
  const matchB = str.match(/(\d+(?:\.\d+)?)\s*[bB]\b/);
  if (matchB) {
    return parseFloat(matchB[1]);
  }
  const matchM = str.match(/(\d+(?:\.\d+)?)\s*[mM]\b/);
  if (matchM) {
    return parseFloat(matchM[1]) / 1000;
  }
  const matchRam = String(m.estimatedRam || "").match(/(\d+(?:\.\d+)?)\s*GB/i);
  if (matchRam) {
    return parseFloat(matchRam[1]);
  }
  return 999;
}

function showLocalModelSubmenu(familyRow, familyName, models) {
  if (submenuHideTimer) {
    clearTimeout(submenuHideTimer);
    submenuHideTimer = null;
  }
  if (activeFamilyRow === familyRow && activeSubmenuFlyout) {
    return;
  }
  hideLocalModelSubmenu(true);

  activeFamilyRow = familyRow;
  familyRow.classList.add("submenu-open");

  const flyout = document.createElement("div");
  flyout.className = "model-submenu-flyout";
  flyout.id = "active-model-submenu-flyout";

  flyout.addEventListener("mouseenter", () => {
    if (submenuHideTimer) {
      clearTimeout(submenuHideTimer);
      submenuHideTimer = null;
    }
  });
  flyout.addEventListener("mouseleave", () => {
    hideLocalModelSubmenu(false);
  });

  const freeBadgeText = (typeof window !== "undefined" && window.localDiskFreeDisplay)
    ? `${models.length} sizes · ${window.localDiskFreeDisplay} free`
    : `${models.length} sizes`;
  const header = document.createElement("div");
  header.className = "model-submenu-header";
  header.innerHTML = `<span>${escapeHtml(familyName)} Models</span><span class="cat-status-badge ready">${escapeHtml(freeBadgeText)}</span>`;
  flyout.appendChild(header);

  const curModel = activeAiModel || (typeof window !== "undefined" && window.activeAiModel) || (typeof localStorage !== "undefined" && localStorage.getItem("orborus_ai_model")) || "gemini-3.8-flash";

  const sortedModels = (Array.isArray(models) ? models.slice() : []).sort((a, b) => {
    const sizeA = parseModelSizeNum(a);
    const sizeB = parseModelSizeNum(b);
    if (sizeA !== sizeB) return sizeA - sizeB;
    return (a.label || "").localeCompare(b.label || "");
  });

  sortedModels.forEach(m => {
    const status = (typeof getModelConfigStatus === "function") ? getModelConfigStatus(m.key) : { configured: true, badge: "Ready" };
    const isSelected = (typeof m.isSelected === "boolean") ? m.isSelected : (m.key === curModel);
    const isOutsideRange = !!status.isOutsideRange;
    const isLowDisk = !!status.isLowDisk;

    const item = document.createElement("div");
    item.setAttribute("data-model-key", m.key);
    let itemClass = "model-option-item compact submenu-model-item" + (isSelected ? " selected" : "");
    if (isOutsideRange || isLowDisk) {
      itemClass += " unavailable disabled-range";
      item.title = status.tooltip || status.reason;
    } else if (status.tooltip) {
      item.title = status.tooltip;
    }
    item.className = itemClass;

    item.onclick = (e) => {
      e.stopPropagation();
      if (isOutsideRange) {
        if (typeof showToast === "function") {
          showToast(status.reason || "Model unavailable: exceeds your system RAM & VRAM range.", "warning");
        }
        return;
      }
      if (isLowDisk) {
        if (typeof showToast === "function") {
          showToast(status.reason || "Insufficient disk space for this model.", "warning");
        }
        return;
      }
      hideLocalModelSubmenu(true);
      const menu = document.getElementById("model-dropdown-menu");
      if (menu) menu.classList.remove("visible");
      selectAiModel(m.key, m.label);
    };

    let metaHtml = "";
    const ramBadge = m.estimatedRam ? `<span class="model-ram-badge${(isOutsideRange || isLowDisk) ? " outside-range" : ""}" title="${escapeHtml(status.tooltip || status.reason || "")}">${escapeHtml(m.estimatedRam)}</span>` : "";
    if (isOutsideRange) {
      metaHtml = `${ramBadge}<span class="model-badge unavailable" title="${escapeHtml(status.tooltip || status.reason)}">Exceeds Range</span>`;
    } else if (isLowDisk) {
      metaHtml = `${ramBadge}<span class="model-badge unavailable" title="${escapeHtml(status.tooltip || status.reason)}">Low Disk Space</span>`;
    } else if (status.isDownloading) {
      metaHtml = `${ramBadge}<span class="model-badge ready" data-dl-badge="${escapeHtml(m.key)}">Downloading ${status.progressPct || 0}%</span>`;
    } else if (status.isInstalled) {
      metaHtml = `${ramBadge}<span class="model-badge ready" data-dl-badge="${escapeHtml(m.key)}">On Disk</span>`;
    } else {
      const dlSize = status.sizeDisplay || m.sizeDisplay || "";
      metaHtml = `${ramBadge}<span class="model-badge" data-dl-badge="${escapeHtml(m.key)}" title="Not on disk yet (${escapeHtml(dlSize)}). Will download from HuggingFace on run or click Download.">Download${dlSize ? " · " + escapeHtml(dlSize) : ""}</span>`;
    }

    const displayName = m.sizeLabel || m.cleanName || m.label;
    const safeLabel = (typeof escapeHtml === "function") ? escapeHtml(displayName) : displayName;
    const subnoteText = (m.subnote && m.sizeLabel) ? m.subnote : (m.desc || "");
    const subnoteHtml = subnoteText
      ? `<span class="model-option-subnote" style="margin-left: 6px; font-size: 10px; opacity: 0.65;">${escapeHtml(subnoteText)}</span>`
      : "";

    item.innerHTML = `
      <div class="model-option-title">
        <div class="model-option-label-group">
          <span class="model-option-label" style="font-weight: 500;">${safeLabel}</span>
          ${subnoteHtml}
        </div>
        <div class="model-option-meta">
          ${metaHtml}
          ${isSelected ? `<svg class="active-check-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>` : `<span style="width:13px; display:inline-block;"></span>`}
        </div>
      </div>
    `;
    flyout.appendChild(item);
  });

  document.body.appendChild(flyout);
  activeSubmenuFlyout = flyout;

  const rect = familyRow.getBoundingClientRect();
  const flyoutRect = flyout.getBoundingClientRect();
  let top = rect.top;
  let left = rect.right + 4;

  if (left + flyoutRect.width > window.innerWidth - 8) {
    left = Math.max(8, rect.left - flyoutRect.width - 4);
  }
  if (top + flyoutRect.height > window.innerHeight - 8) {
    top = Math.max(8, window.innerHeight - flyoutRect.height - 8);
  }

  flyout.style.top = `${top}px`;
  flyout.style.left = `${left}px`;
}

if (typeof window !== "undefined") {
  window.showLocalModelSubmenu = showLocalModelSubmenu;
  window.hideLocalModelSubmenu = hideLocalModelSubmenu;
}

function renderModelDropdown() {
  const menu = document.getElementById("model-dropdown-menu");
  if (!menu) return;
  menu.innerHTML = "";

  const curModel = activeAiModel || (typeof window !== "undefined" && window.activeAiModel) || (typeof localStorage !== "undefined" && localStorage.getItem("orborus_ai_model")) || "gemini-3.8-flash";
  const savedCustomModel = ((typeof localStorage !== "undefined" && localStorage.getItem("orborus_custom_model")) || "").trim();
  const isPredefined = AVAILABLE_AI_MODELS.some(m => m.key === curModel && m.key !== "custom");
  const activeCustomName = (!isPredefined && curModel !== "custom") ? curModel : savedCustomModel;

  // Organize cleanly into: Shuffle AI, BYOK Models, Local Models (per AGENTS.md Rule 2)
  const categories = {
    "Shuffle AI": [],
    "BYOK Models": [],
    "Local Models": []
  };

  AVAILABLE_AI_MODELS.forEach(m => {
    if (m.key === "custom") return; // Rendered dynamically below
    if (m.category === "Shuffle AI" || m.category === "Shuffle Cloud AI") {
      categories["Shuffle AI"].push(m);
    } else if (m.category === "Local Models" || m.category === "Local GPU Engine") {
      const copy = Object.assign({}, m);
      if (m.key === "tendon-local" && window.localModelPath) {
        copy.label = typeof formatEasyModelName === "function" ? formatEasyModelName(window.localModelPath) : copy.label;
      }
      categories["Local Models"].push(copy);
    } else {
      categories["BYOK Models"].push(m);
    }
  });

  // If a custom model is configured or active, add it under BYOK Models if not already present
  if (activeCustomName && !categories["BYOK Models"].some(m => m.key.toLowerCase() === activeCustomName.toLowerCase())) {
    const isCustomSelected = (curModel === activeCustomName || curModel === "custom" || !isPredefined);
    categories["BYOK Models"].push({
      key: activeCustomName,
      label: activeCustomName,
      desc: currentAiUrl || "Custom Endpoint",
      category: "BYOK Models",
      provider: "custom",
      isSelected: isCustomSelected,
      isConfiguredCustom: true
    });
  }

  // Always provide the action to configure / add custom model
  categories["BYOK Models"].push({
    key: "custom",
    label: "+ Add / Type BYOK Model...",
    desc: "Type any model ID or set custom endpoint",
    category: "BYOK Models",
    provider: "custom",
    isSelected: !activeCustomName && (curModel === "custom" || !isPredefined),
    isConfigAction: true
  });

  const displayGroups = [];
  if (categories["Shuffle AI"].length > 0) {
    displayGroups.push({ title: "Shuffle AI", models: categories["Shuffle AI"] });
  }
  if (categories["Local Models"].length > 0) {
    displayGroups.push({ title: "Local Models", models: categories["Local Models"] });
  }
  if (categories["BYOK Models"].length > 0) {
    displayGroups.push({ title: "BYOK Models", models: categories["BYOK Models"] });
  }

  displayGroups.forEach(group => {
    const catHeader = document.createElement("div");
    catHeader.className = "model-category-header";

    // Category status summary pill in header
    let headerBadgeHtml = "";
    if (group.title === "Shuffle AI") {
      const shuffleStatus = (typeof getModelConfigStatus === "function") ? getModelConfigStatus("shuffle-ai") : { configured: false };
      if (!shuffleStatus.configured) {
        headerBadgeHtml = `<span class="cat-status-badge unconfigured">Login needed</span>`;
      } else {
        headerBadgeHtml = `<span class="cat-status-badge ready">Connected</span>`;
      }
    } else if (group.title === "BYOK Models") {
      const anyByokConfigured = group.models.some(m => !m.isConfigAction && typeof getModelConfigStatus === "function" && getModelConfigStatus(m.key).configured);
      if (!anyByokConfigured) {
        headerBadgeHtml = `<span class="cat-status-badge unconfigured">API key needed</span>`;
      }
    } else if (group.title === "Local Models") {
      const dlState = (typeof window !== "undefined" && window.localModelDownloadState) || null;
      const anyLocalReady = group.models.some(m => (typeof getModelConfigStatus === "function") ? getModelConfigStatus(m.key).configured : true);
      if (dlState && dlState.status === "downloading") {
        headerBadgeHtml = `<span class="cat-status-badge ready">Downloading ${dlState.progress_pct || 0}%</span>`;
      } else if (anyLocalReady) {
        const freeTxt = (typeof window !== "undefined" && window.localDiskFreeDisplay) ? ` · ${window.localDiskFreeDisplay} free` : "";
        headerBadgeHtml = `<span class="cat-status-badge ready">Ready${escapeHtml(freeTxt)}</span>`;
      } else {
        headerBadgeHtml = `<span class="cat-status-badge unconfigured">Unavailable</span>`;
      }
    }

    catHeader.innerHTML = `<span>${escapeHtml(group.title)}</span>${headerBadgeHtml}`;
    catHeader.addEventListener("mouseenter", () => {
      hideLocalModelSubmenu(true);
    });
    menu.appendChild(catHeader);

    if (group.title === "Local Models" && group.models.some(m => m.family)) {
      const families = {};
      group.models.forEach(m => {
        const fam = m.family || "Other";
        if (!families[fam]) families[fam] = [];
        families[fam].push(m);
      });

      Object.keys(families).forEach(fam => {
        const fModels = (families[fam] || []).slice().sort((a, b) => {
          const sizeA = parseModelSizeNum(a);
          const sizeB = parseModelSizeNum(b);
          if (sizeA !== sizeB) return sizeA - sizeB;
          return (a.label || "").localeCompare(b.label || "");
        });
        const selectedInFam = fModels.find(m => (typeof m.isSelected === "boolean" ? m.isSelected : m.key === curModel));
        const dlInFam = fModels.find(m => {
          const st = (typeof getModelConfigStatus === "function") ? getModelConfigStatus(m.key) : {};
          return !!st.isDownloading;
        });
        const installedCount = fModels.filter(m => {
          const st = (typeof getModelConfigStatus === "function") ? getModelConfigStatus(m.key) : {};
          return !!st.isInstalled;
        }).length;

        const familyRow = document.createElement("div");
        familyRow.className = "model-option-item compact model-family-row" + (selectedInFam ? " selected" : "");
        familyRow.setAttribute("data-family", fam);

        let activeChip = "";
        if (dlInFam) {
          const dlSt = (typeof getModelConfigStatus === "function") ? getModelConfigStatus(dlInFam.key) : {};
          activeChip = `<span class="model-badge ready active-family-badge">Downloading ${dlSt.progressPct || 0}%</span>`;
        } else if (selectedInFam) {
          const selSt = (typeof getModelConfigStatus === "function") ? getModelConfigStatus(selectedInFam.key) : {};
          const activeLabel = selectedInFam.sizeLabel || selectedInFam.cleanName || selectedInFam.label;
          const diskNote = selSt.needsDownload ? " · DL" : "";
          activeChip = `<span class="model-badge ready active-family-badge" title="Active: ${escapeHtml(selectedInFam.label)}">${escapeHtml(activeLabel + diskNote)}</span>`;
        }

        const subnoteCount = installedCount > 0 ? `${fModels.length} models · ${installedCount} on disk` : `${fModels.length} models`;

        familyRow.innerHTML = `
          <div class="model-option-title">
            <div class="model-option-label-group">
              <span class="model-option-label" style="font-weight: 500;">${escapeHtml(fam)}</span>
              <span class="model-option-subnote" style="font-size: 10.5px; opacity: 0.65;">${escapeHtml(subnoteCount)}</span>
            </div>
            <div class="model-option-meta">
              ${activeChip}
              <svg class="submenu-arrow-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
          </div>
        `;

        familyRow.addEventListener("mouseenter", () => {
          showLocalModelSubmenu(familyRow, fam, fModels);
        });
        familyRow.addEventListener("mouseleave", () => {
          hideLocalModelSubmenu(false);
        });
        familyRow.onclick = (e) => {
          e.stopPropagation();
          if (activeFamilyRow === familyRow && activeSubmenuFlyout) {
            hideLocalModelSubmenu(true);
          } else {
            showLocalModelSubmenu(familyRow, fam, fModels);
          }
        };

        menu.appendChild(familyRow);
      });
      return;
    }

    group.models.forEach(m => {
      const status = (typeof getModelConfigStatus === "function") ? getModelConfigStatus(m.key) : { configured: true, badge: "Ready" };
      const isSelected = (typeof m.isSelected === "boolean") ? m.isSelected : (m.key === curModel);
      const isOutsideRange = !!status.isOutsideRange;
      const item = document.createElement("div");
      let itemClass = "model-option-item compact" + (isSelected ? " selected" : "");
      if (m.isConfigAction) {
        itemClass += " available";
      } else if (isOutsideRange) {
        itemClass += " unavailable disabled-range";
      } else if (status.configured) {
        itemClass += " available";
      } else {
        itemClass += " unconfigured";
      }
      item.className = itemClass;

      item.addEventListener("mouseenter", () => {
        hideLocalModelSubmenu(true);
      });

      if (isOutsideRange) {
        item.title = status.tooltip || status.reason;
      } else if (!status.configured && !m.isConfigAction) {
        item.title = `${status.reason} (prompts will fail until configured)`;
      } else if (status.tooltip) {
        item.title = status.tooltip;
      }

      if (m.isConfigAction) {
        item.onclick = (e) => {
          e.stopPropagation();
          hideLocalModelSubmenu(true);
          openSettingsModal("mode-direct", "model");
          menu.classList.remove("visible");
        };
      } else {
        item.onclick = (e) => {
          e.stopPropagation();
          hideLocalModelSubmenu(true);
          if (isOutsideRange) {
            if (typeof showToast === "function") {
              showToast(status.reason || "Model unavailable: exceeds your system RAM & VRAM range.", "warning");
            }
            return;
          }
          selectAiModel(m.key, m.label);
        };
      }

      let metaHtml = "";
      if (m.isConfigAction) {
        metaHtml = `<span class="model-badge">Settings</span>`;
      } else if (isOutsideRange) {
        const ramBadge = m.estimatedRam ? `<span class="model-ram-badge outside-range" title="${escapeHtml(status.tooltip || status.reason)}">${escapeHtml(m.estimatedRam)}</span>` : "";
        metaHtml = `${ramBadge}<span class="model-badge unavailable" title="${escapeHtml(status.tooltip || status.reason)}">Exceeds Range</span>`;
      } else if (m.estimatedRam) {
        metaHtml = `<span class="model-ram-badge">${escapeHtml(m.estimatedRam)}</span>`;
      }

      const safeLabel = (typeof escapeHtml === "function") ? escapeHtml(m.label) : m.label;

      item.innerHTML = `
        <div class="model-option-title">
          <div class="model-option-label-group">
            <span class="model-option-label">${safeLabel}</span>
          </div>
          <div class="model-option-meta">
            ${metaHtml}
            ${isSelected ? `<svg class="active-check-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>` : `<span style="width:13px; display:inline-block;"></span>`}
          </div>
        </div>
      `;
      menu.appendChild(item);
    });
  });
}

function toggleModelDropdown(event) {
  if (event) event.stopPropagation();
  hideLocalModelSubmenu(true);
  const reasoningMenu = document.getElementById("reasoning-dropdown-menu");
  if (reasoningMenu) reasoningMenu.classList.remove("visible");

  const menu = document.getElementById("model-dropdown-menu");
  if (!menu) return;
  renderModelDropdown();
  const btn = document.getElementById("btn-model-picker");
  positionDropdownUpOrDown(btn, menu);
  menu.classList.toggle("visible");
}

function renderReasoningDropdown() {
  const menu = document.getElementById("reasoning-dropdown-menu");
  if (!menu) return;
  menu.innerHTML = "";

  const current = activeReasoningEffort || localStorage.getItem("orborus_ai_reasoning") || "low";
  const options = [
    { key: "low", label: "Low", note: "Default" },
    { key: "medium", label: "Medium", note: "Balanced" },
    { key: "high", label: "High", note: "Deep" },
    { key: "off", label: "Off", note: "None" }
  ];

  const header = document.createElement("div");
  header.className = "model-category-header";
  header.textContent = "Reasoning Effort";
  menu.appendChild(header);

  options.forEach(opt => {
    const isSelected = (current === opt.key) || (opt.key === "off" && (current === "minimal" || current === "none"));
    const item = document.createElement("div");
    item.className = "model-option-item compact" + (isSelected ? " selected" : "");
    item.onclick = (e) => {
      e.stopPropagation();
      selectReasoningEffort(opt.key);
    };

    item.innerHTML = `
      <div class="model-option-title">
        <span class="model-option-label">${escapeHtml(opt.label)}</span>
        <div class="model-option-meta">
          <span class="model-sublabel">${escapeHtml(opt.note)}</span>
          ${isSelected ? `<svg class="active-check-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>` : `<span style="width:13px; display:inline-block;"></span>`}
        </div>
      </div>
    `;
    menu.appendChild(item);
  });
}

function toggleReasoningDropdown(event) {
  if (event) event.stopPropagation();
  hideLocalModelSubmenu(true);
  const modelMenu = document.getElementById("model-dropdown-menu");
  if (modelMenu) modelMenu.classList.remove("visible");

  const menu = document.getElementById("reasoning-dropdown-menu");
  if (!menu) return;
  renderReasoningDropdown();
  const btn = document.getElementById("btn-reasoning-picker");
  positionDropdownUpOrDown(btn, menu);
  menu.classList.toggle("visible");
}

function selectReasoningEffort(key) {
  activeReasoningEffort = key || "low";
  localStorage.setItem("orborus_ai_reasoning", activeReasoningEffort);
  if (typeof saveRememberedReasoningForType === "function") {
    saveRememberedReasoningForType(activeProjectPath, activeReasoningEffort);
  }
  if (activeConversationId && Array.isArray(appConversations)) {
    const curConv = appConversations.find(c => c && c.id === activeConversationId);
    if (curConv) {
      curConv.reasoning = activeReasoningEffort;
      if (typeof saveStoredConversations === "function") {
        saveStoredConversations();
      }
    }
  }
  updateActiveReasoningLabel();

  const footerReasoning = document.getElementById("select-footer-reasoning");
  if (footerReasoning) {
    footerReasoning.value = activeReasoningEffort;
  }

  const menu = document.getElementById("reasoning-dropdown-menu");
  if (menu) menu.classList.remove("visible");

  if (typeof window.bridgeCall === "function") {
    window.bridgeCall("setAiConfig", JSON.stringify({
      url: currentAiUrl || "",
      key: currentAiKey || "",
      model: activeAiModel || "tendon-local",
      reasoning: activeReasoningEffort,
      permission_policy: currentPermissionPolicy || "ask_all"
    })).catch(() => {});
  } else if (typeof window.setAiConfig === "function") {
    try {
      window.setAiConfig(currentAiUrl, currentAiKey, currentPermissionPolicy || "ask_all", activeAiModel);
    } catch (e) {}
  }

  const display = key === "minimal" || key === "off" ? "Off" : (key.charAt(0).toUpperCase() + key.slice(1));
  showToast(`Reasoning effort set to ${display}`);
}

function selectAiModel(key, label) {
  hideLocalModelSubmenu(true);
  if (key === "custom") {
    openSettingsModal("mode-direct", "model");
    const menu = document.getElementById("model-dropdown-menu");
    if (menu) menu.classList.remove("visible");
    return;
  }

  const memCheckStatus = (typeof getModelConfigStatus === "function") ? getModelConfigStatus(key) : { configured: true };
  if (memCheckStatus && memCheckStatus.isOutsideRange) {
    if (typeof showToast === "function") {
      showToast(memCheckStatus.reason || "Model unavailable: exceeds your system RAM & VRAM range.", "warning");
    }
    const menu = document.getElementById("model-dropdown-menu");
    if (menu) menu.classList.remove("visible");
    return;
  }
  if (memCheckStatus && memCheckStatus.isLowDisk) {
    if (typeof showToast === "function") {
      showToast(memCheckStatus.reason || "Insufficient free disk space to download this model.", "warning");
    }
  }

  const isShuffleCategory = key === "shuffle-ai" || key === "shuffle" || key === "default";
  const hasShuffleAuth = !!((typeof window !== "undefined" && window.oauthLoggedIn === true) && (typeof localStorage !== "undefined" && localStorage.getItem("orborus_oauth_logged_in") === "true"));

  const isPredefined = AVAILABLE_AI_MODELS.some(m => m.key === key && m.key !== "custom");
  const avail = checkModelAvailability(key);

  activeAiModel = key;
  if (typeof window !== "undefined") {
    window.activeAiModel = key;
  }
  localStorage.setItem("orborus_ai_model", key);
  if (!isPredefined) {
    localStorage.setItem("orborus_custom_model", key);
  }
  if (typeof saveRememberedModelForType === "function") {
    saveRememberedModelForType(activeProjectPath, key);
  }
  if (activeConversationId && Array.isArray(appConversations)) {
    const curConv = appConversations.find(c => c && c.id === activeConversationId);
    if (curConv) {
      curConv.model = key;
      if (typeof saveStoredConversations === "function") {
        saveStoredConversations();
      }
    }
  }

  // Set default endpoint URLs and execution mode based on model provider
  const isLocalCategory = key === "tendon-local" || key.startsWith("local");
  let targetMode = "direct";

  if (isLocalCategory) {
    targetMode = "local";
    currentAiUrl = "";
    activeExecutionMode = "local";
    const catEntry = (typeof window !== "undefined" && window.localModelsCatalog) ? window.localModelsCatalog[key] : null;
    if (catEntry && catEntry.installed && catEntry.installed_path) {
      window.localModelPath = catEntry.installed_path;
      localStorage.setItem("orborus_local_model_path", catEntry.installed_path);
      if (typeof window.setLocalModel === "function") {
        window.setLocalModel(catEntry.installed_path).catch(() => {});
      } else if (typeof window.bridgeCall === "function") {
        window.bridgeCall("setLocalModel", JSON.stringify({ path: catEntry.installed_path })).catch(() => {});
      }
    }
    if (typeof window.getLocalExecutorStatus === "function") {
      window.getLocalExecutorStatus().catch(() => {});
    }
    if (typeof refreshLocalModelCatalog === "function") {
      refreshLocalModelCatalog().catch(() => {});
    }
  } else if (isShuffleCategory) {
    targetMode = "shuffle";
    activeExecutionMode = "shuffle";
  } else {
    targetMode = "direct";
    activeExecutionMode = "direct";
    if (key.startsWith("gpt")) {
      if (!currentAiUrl || currentAiUrl.startsWith("local://") || currentAiUrl.includes("127.0.0.1:8000") || currentAiUrl.includes("localhost:8000")) {
        currentAiUrl = "https://api.openai.com/v1";
      }
    } else if (key.startsWith("claude")) {
      if (!currentAiUrl || currentAiUrl.startsWith("local://") || currentAiUrl.includes("127.0.0.1:8000") || currentAiUrl.includes("localhost:8000")) {
        currentAiUrl = "https://api.anthropic.com/v1";
      }
    } else if (key.startsWith("gemini")) {
      if (!currentAiUrl || currentAiUrl.startsWith("local://") || currentAiUrl.includes("127.0.0.1:8000") || currentAiUrl.includes("localhost:8000")) {
        currentAiUrl = "https://generativelanguage.googleapis.com/v1beta/openai";
      }
    }
  }

  if (typeof window !== "undefined") {
    window.activeExecutionMode = targetMode;
  }
  localStorage.setItem("orborus_active_execution_mode", targetMode);
  if (currentAiUrl && !isShuffleCategory && !isLocalCategory) {
    localStorage.setItem("orborus_ai_url", currentAiUrl);
  }
  if (typeof window.setActiveExecutionMode === "function") {
    window.setActiveExecutionMode(targetMode).catch(() => {});
  }
  if (typeof window.bridgeCall === "function") {
    window.bridgeCall("setActiveExecutionMode", JSON.stringify({ mode: targetMode })).catch(() => {});
  }
  if (typeof updateModesDisplay === "function") {
    updateModesDisplay();
  }

  // Preserve user's reasoning choice independently
  updateActiveModelLabel();

  // Sync to settings modal dropdown
  const selectSettings = document.getElementById("select-ai-model");
  const customModelInput = document.getElementById("input-settings-custom-model");
  if (selectSettings) {
    if (isPredefined) {
      selectSettings.value = key;
      if (customModelInput) customModelInput.style.display = "none";
    } else {
      selectSettings.value = "custom";
      if (customModelInput) {
        customModelInput.style.display = "block";
        customModelInput.value = key;
      }
    }
  }

  const menu = document.getElementById("model-dropdown-menu");
  if (menu) menu.classList.remove("visible");

  const cfgUrl = isShuffleCategory
    ? ((hasShuffleAuth && currentAiUrl && currentAiUrl.toLowerCase().includes("shuffler.io")) ? currentAiUrl : "")
    : (currentAiUrl || "");
  const cfgKey = isShuffleCategory
    ? ((hasShuffleAuth && currentAiKey && currentAiKey.startsWith("shfl_")) ? currentAiKey : "")
    : (currentAiKey || "");

  if (typeof window.bridgeCall === "function") {
    window.bridgeCall("setAiConfig", JSON.stringify({
      url: cfgUrl,
      key: cfgKey,
      model: activeAiModel || "tendon-local",
      reasoning: activeReasoningEffort || "low",
      permission_policy: currentPermissionPolicy || "ask_all"
    })).catch(() => {});
  } else if (typeof window.setAiConfig === "function") {
    try {
      window.setAiConfig(cfgUrl, cfgKey, currentPermissionPolicy || "ask_all", activeAiModel);
    } catch (e) {
      console.warn("setAiConfig failed:", e);
    }
  }

  const status = (typeof getModelConfigStatus === "function") ? getModelConfigStatus(key) : { configured: true };
  if (status.isDownloading) {
    showToast(`Switched to ${label || key} (${status.badge || "Downloading..."})`);
  } else if (status.needsDownload) {
    showToast(`Switched to ${label || key} (${status.sizeDisplay || "not on disk"} — click Download or send a message to auto-download)`);
  } else if (!status.configured) {
    showToast(`Switched to ${label || key} (${status.reason})`);
  } else {
    showToast(`Switched model to ${label || key}`);
  }
}

document.addEventListener("click", (e) => {
  const modelMenu = document.getElementById("model-dropdown-menu");
  const modelBtn = document.getElementById("btn-model-picker");
  const activeFlyout = document.getElementById("active-model-submenu-flyout");

  if (activeFlyout && !activeFlyout.contains(e.target) && (!modelMenu || !modelMenu.contains(e.target))) {
    hideLocalModelSubmenu(true);
  }

  if (modelMenu && modelMenu.classList.contains("visible")) {
    if (!modelMenu.contains(e.target) && !modelBtn.contains(e.target) && (!activeFlyout || !activeFlyout.contains(e.target))) {
      modelMenu.classList.remove("visible");
      hideLocalModelSubmenu(true);
    }
  }

  const reasoningMenu = document.getElementById("reasoning-dropdown-menu");
  const reasoningBtn = document.getElementById("btn-reasoning-picker");
  if (reasoningMenu && reasoningMenu.classList.contains("visible")) {
    if (!reasoningMenu.contains(e.target) && !reasoningBtn.contains(e.target)) {
      reasoningMenu.classList.remove("visible");
    }
  }
});

function toggleVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showToast("Voice input not supported in this environment");
    return;
  }
  const btnMic = document.getElementById("btn-mic");
  if (isListeningVoice) {
    if (speechRecognitionInstance) {
      try { speechRecognitionInstance.stop(); } catch (e) {}
    }
    isListeningVoice = false;
    if (btnMic) btnMic.style.color = "";
    showToast("Voice input stopped");
    return;
  }

  try {
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      isListeningVoice = true;
      if (btnMic) btnMic.style.color = "var(--text-primary)";
      showToast("Listening...");
    };

    recognition.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      const input = document.getElementById("prompt-input");
      if (input && transcript) {
        input.value = (input.value ? input.value + " " : "") + transcript;
        handleInput(input);
      }
    };

    recognition.onend = () => {
      isListeningVoice = false;
      if (btnMic) btnMic.style.color = "";
    };

    recognition.onerror = (e) => {
      isListeningVoice = false;
      if (btnMic) btnMic.style.color = "";
      console.warn("Speech recognition error:", e);
    };

    speechRecognitionInstance = recognition;
    recognition.start();
  } catch (err) {
    console.warn("SpeechRecognition start failed:", err);
    showToast("Could not access microphone");
  }
}

var isPromptExecuting = false;
var runningConversationId = null;
var promptMessageQueue = [];
if (typeof window !== "undefined") {
  window.isPromptExecuting = false;
  window.runningConversationId = null;
}

function renderPromptQueueShelf() {
  const shelf = document.getElementById("prompt-queue-shelf");
  const list = document.getElementById("prompt-queue-list");
  const dock = document.querySelector(".chat-dock-container");
  if (!shelf || !list) return;

  const relevantQueue = (promptMessageQueue || []).filter(q => !q.conversationId || q.conversationId === activeConversationId);
  if (!relevantQueue || relevantQueue.length === 0) {
    shelf.style.display = "none";
    if (dock) dock.classList.remove("has-queue-shelf");
    list.innerHTML = "";
    return;
  }

  shelf.style.display = "block";
  if (dock) dock.classList.add("has-queue-shelf");

  let html = "";
  relevantQueue.forEach((item, idx) => {
    const isEditing = !!item.editing;
    const safeIdAttr = escapeJsAttr(item.id);
    if (isEditing) {
      html += `
        <div class="queue-item-row editing" id="queue-row-${escapeHtml(item.id)}">
          <div class="queue-inline-edit-form">
            <span class="queue-order-badge">#${idx + 1}</span>
            <input type="text" class="queue-inline-input" id="queue-edit-input-${escapeHtml(item.id)}" value="${escapeHtml(item.prompt)}" onkeydown="handleQueueInputKey(event, '${safeIdAttr}')" placeholder="Edit prompt..." />
            <div class="queue-item-actions">
              <button class="btn-queue-action save" type="button" onclick="saveEditQueuedPrompt('${safeIdAttr}')" title="Save changes (Enter)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              </button>
              <button class="btn-queue-action" type="button" onclick="cancelEditQueuedPrompt('${safeIdAttr}')" title="Cancel edit (Esc)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>
        </div>
      `;
    } else {
      const cleanPrompt = item.prompt || "";
      const firstLine = cleanPrompt.split("\n")[0];
      html += `
        <div class="queue-item-row" id="queue-row-${escapeHtml(item.id)}">
          <div class="queue-item-left">
            <span class="queue-order-badge">#${idx + 1}</span>
            <span class="queue-item-text" title="${escapeHtml(cleanPrompt)}">${escapeHtml(firstLine)}</span>
            <span class="queue-subtle-hint">Queued</span>
          </div>
          <div class="queue-item-actions">
            <button class="btn-queue-action" type="button" onclick="popQueuedPromptToInput('${safeIdAttr}')" title="Move to input box">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
            </button>
            <button class="btn-queue-action btn-queue-edit" type="button" onclick="startEditQueuedPrompt('${safeIdAttr}')" title="Edit request">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="btn-queue-action btn-queue-remove" type="button" onclick="cancelQueuedPrompt('${safeIdAttr}')" title="Remove from queue">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
      `;
    }
  });

  list.innerHTML = html;

  // Auto-focus any inline input if currently editing
  const editingItem = promptMessageQueue.find(q => q.editing);
  if (editingItem) {
    const inputEl = document.getElementById("queue-edit-input-" + editingItem.id);
    if (inputEl) {
      inputEl.focus();
      inputEl.select();
    }
  }
}

function enqueuePrompt(promptText, attachments) {
  const clean = (promptText || "").trim();
  const attList = Array.isArray(attachments) ? attachments : [];
  if (!clean && attList.length === 0) return;
  const queueId = "queue-" + Date.now() + "-" + Math.random().toString(36).substr(2, 4);
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  promptMessageQueue.push({
    id: queueId,
    prompt: clean,
    attachments: attList,
    timestamp: timeStr,
    conversationId: activeConversationId,
    editing: false
  });
  renderPromptQueueShelf();
  updateActiveModelLabel();
  showToast(`Request queued (#${promptMessageQueue.length})`);
}

function startEditQueuedPrompt(queueId) {
  promptMessageQueue.forEach(q => {
    q.editing = (q.id === queueId);
  });
  renderPromptQueueShelf();
}

function saveEditQueuedPrompt(queueId) {
  const item = promptMessageQueue.find(q => q.id === queueId);
  if (!item) return;
  const inputEl = document.getElementById("queue-edit-input-" + queueId);
  const newText = inputEl ? inputEl.value.trim() : "";
  if (!newText && (!item.attachments || item.attachments.length === 0)) {
    cancelQueuedPrompt(queueId);
    return;
  }
  item.prompt = newText;
  item.editing = false;
  renderPromptQueueShelf();
  showToast("Updated queued request");
}

function cancelEditQueuedPrompt(queueId) {
  const item = promptMessageQueue.find(q => q.id === queueId);
  if (item) {
    item.editing = false;
  }
  renderPromptQueueShelf();
}

function handleQueueInputKey(event, queueId) {
  if (event.key === "Enter") {
    event.preventDefault();
    saveEditQueuedPrompt(queueId);
  } else if (event.key === "Escape") {
    event.preventDefault();
    cancelEditQueuedPrompt(queueId);
  }
}

function popQueuedPromptToInput(queueId) {
  const idx = promptMessageQueue.findIndex(q => q.id === queueId);
  if (idx === -1) return;
  const item = promptMessageQueue[idx];
  promptMessageQueue.splice(idx, 1);
  renderPromptQueueShelf();

  if (Array.isArray(item.attachments) && item.attachments.length > 0 && typeof addPendingAttachmentObject === "function") {
    item.attachments.forEach(att => addPendingAttachmentObject(att));
  }

  const textarea = document.getElementById("prompt-input");
  if (textarea) {
    textarea.value = item.prompt;
    handleInput(textarea);
    textarea.focus();
  }
}

function cancelQueuedPrompt(queueId) {
  const idx = promptMessageQueue.findIndex(q => q.id === queueId);
  if (idx !== -1) {
    promptMessageQueue.splice(idx, 1);
    renderPromptQueueShelf();
    updateActiveModelLabel();
    showToast("Removed from queue");
  }
}

function processNextInQueue() {
  if (promptMessageQueue.length === 0) {
    renderPromptQueueShelf();
    return;
  }
  const next = promptMessageQueue.shift();
  renderPromptQueueShelf();
  updateActiveModelLabel();
  if (next.conversationId && next.conversationId !== activeConversationId && typeof selectConversation === "function") {
    selectConversation(next.conversationId);
  }
  submitPrompt(next.prompt, next.attachments || []);
}

// Expose handlers globally
if (typeof window !== "undefined") {
  window.renderPromptQueueShelf = renderPromptQueueShelf;
  window.enqueuePrompt = enqueuePrompt;
  window.startEditQueuedPrompt = startEditQueuedPrompt;
  window.saveEditQueuedPrompt = saveEditQueuedPrompt;
  window.cancelEditQueuedPrompt = cancelEditQueuedPrompt;
  window.handleQueueInputKey = handleQueueInputKey;
  window.popQueuedPromptToInput = popQueuedPromptToInput;
  window.cancelQueuedPrompt = cancelQueuedPrompt;
  window.processNextInQueue = processNextInQueue;
}

function formatStepTitleHtml(step) {
  const rawTitle = (step.title || step.name || "").trim();
  if (!rawTitle) return "Task";

  // Check for Analyzed file pattern: Analyzed </> filename #Llines
  const isFileStep = step.type === "file" || rawTitle.toLowerCase().startsWith("analyzed") || rawTitle.toLowerCase().startsWith("read file") || /\.(go|html|js|ts|py|json|md)\b/.test(rawTitle);

  if (isFileStep) {
    const clean = rawTitle.replace(/^Analyzed\s+(?:<\/>\s*)?/i, "").replace(/^(?:Read\s+file|View)\s+/i, "");
    const parts = clean.split(/\s+#L|\s+#/);
    const filePath = parts[0] ? parts[0].trim() : "file";
    const lineRange = parts[1] ? `#L${parts[1].trim()}` : (step.detail && step.detail.match(/#L[\d\-]+/i) ? step.detail.match(/#L[\d\-]+/i)[0] : "");
    return `Analyzed <span class="step-filepath" onclick="event.stopPropagation(); previewFileInSidebar('${escapeJsAttr(filePath)}')" title="Open ${escapeHtml(filePath)}">${escapeHtml(filePath)}</span> ${lineRange ? `<span class="step-line-range">${escapeHtml(lineRange)}</span>` : ""}`;
  }

  // Check for thought pattern: "Thought for 3s" or "Thought for <1s"
  if (step.type === "thought" || rawTitle.toLowerCase().startsWith("thought")) {
    const durMatch = rawTitle.match(/thought(?:\s+for\s+([^\s]+))?/i);
    const dur = (durMatch && durMatch[1]) || step.duration || "<1s";
    return `Thought for ${escapeHtml(dur)}`;
  }

  // Check for command pattern: "Ran git status"
  if (step.type === "cmd" || rawTitle.toLowerCase().startsWith("ran ") || rawTitle.toLowerCase().startsWith("run ")) {
    return escapeHtml(rawTitle);
  }

  return escapeHtml(rawTitle);
}

function computeStepsSummary(steps) {
  if (!steps || !steps.length) return "Completed execution";
  let fileCount = 0;
  let taskCount = 0;
  let cmdCount = 0;

  steps.forEach(s => {
    const text = (s.name || s.title || "").toLowerCase();
    const isFile = s.type === "file" || text.includes("analyzed") || text.includes("read_file") || text.includes("view_file") || /\.(go|html|js|ts|py|json|md)\b/.test(text);
    const isCmd = s.type === "cmd" || text.startsWith("ran ") || text.startsWith("run ");
    const isTask = text.includes("task") || text.includes("grep") || text.includes("search") || text.includes("worker") || s.type === "task";

    if (isFile) fileCount++;
    else if (isCmd) cmdCount++;
    else if (isTask) taskCount++;
  });

  const parts = [];
  if (fileCount > 0) parts.push(`Exploring ${fileCount} file${fileCount > 1 ? "s" : ""}`);
  if (taskCount > 0) parts.push(`${taskCount} task${taskCount > 1 ? "s" : ""}`);
  if (cmdCount > 0) parts.push(`running ${cmdCount} command${cmdCount > 1 ? "s" : ""}`);

  if (parts.length > 0) {
    return parts.join(", ");
  }
  return `${steps.length} step${steps.length > 1 ? "s" : ""} completed`;
}

function toggleTurnSteps(turnId) {
  const container = document.getElementById("turn-steps-" + turnId);
  const banner = document.getElementById("summary-banner-" + turnId);
  if (container) {
    container.classList.toggle("collapsed");
  }
  if (banner) {
    banner.classList.toggle("collapsed");
  }
}

function toggleActiveSteps() {
  const container = document.getElementById("activity-steps-container");
  const banner = document.getElementById("activity-summary-banner");
  if (container) {
    container.classList.toggle("collapsed");
  }
  if (banner) {
    banner.classList.toggle("collapsed");
  }
}

function toggleWorktreeNode(headerEl) {
  if (!headerEl) return;
  const chevron = headerEl.querySelector(".worktree-chevron");
  const node = headerEl.closest(".worktree-node");
  if (!node) return;
  const detail = node.querySelector(".worktree-detail");
  const children = node.querySelector(".worktree-children");

  let isCollapsed = false;
  if (chevron) {
    isCollapsed = chevron.classList.toggle("collapsed");
  }
  if (detail) {
    detail.classList.toggle("collapsed", isCollapsed);
  }
  if (children) {
    children.classList.toggle("collapsed", isCollapsed);
  }

  // Persist collapsed state to active turn step in memory
  const stepId = node.getAttribute("data-step-id");
  if (stepId && activeConversationId && Array.isArray(appConversations)) {
    const curConv = appConversations.find(c => c && c.id === activeConversationId);
    if (curConv && Array.isArray(curConv.turns)) {
      const matchStep = (steps) => {
        for (const s of steps) {
          if (String(s.id || "") === String(stepId)) return s;
          if (Array.isArray(s.steps)) {
            const found = matchStep(s.steps);
            if (found) return found;
          }
        }
        return null;
      };
      for (const t of curConv.turns) {
        if (Array.isArray(t.steps)) {
          const matched = matchStep(t.steps);
          if (matched) {
            matched.collapsed = isCollapsed;
            break;
          }
        }
      }
    }
  }
}
window.toggleWorktreeNode = toggleWorktreeNode;

function toggleWorktreeRoot(rootHeaderEl) {
  if (!rootHeaderEl) return;
  const root = rootHeaderEl.closest(".worktree-root");
  if (!root) return;
  const chevron = rootHeaderEl.querySelector(".worktree-chevron");
  const container = root.querySelector(".worktree-container");

  let isCollapsed = false;
  if (chevron) {
    isCollapsed = chevron.classList.toggle("collapsed");
  }
  if (container) {
    container.classList.toggle("collapsed", isCollapsed);
  }

  // Persist collapsed state to the turn object in memory
  const turnEl = root.closest(".transcript-turn");
  if (turnEl && turnEl.id && activeConversationId && Array.isArray(appConversations)) {
    const turnKey = turnEl.id.replace("transcript-turn-", "");
    const curConv = appConversations.find(c => c && c.id === activeConversationId);
    if (curConv && Array.isArray(curConv.turns)) {
      const matchedTurn = curConv.turns.find((t, idx) => String(t.id || idx) === String(turnKey));
      if (matchedTurn) {
        matchedTurn.worktreeCollapsed = isCollapsed;
      }
    }
  }
}
window.toggleWorktreeRoot = toggleWorktreeRoot;

function formatTurnDurationSec(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 10) return `${Math.round(n)}s`;
  return `${n.toFixed(1).replace(/\.0$/, "")}s`;
}

function parseThinkingTurns(detailText, step) {
  const raw = String(detailText || "").trim();
  if (!raw) return { turns: [], useSubsections: false };

  const timings = (step && step.turnTimings && typeof step.turnTimings === "object") ? step.turnTimings : {};
  const isLiveStep = Boolean(step && (step.id === "live-thought" || /^Thinking\b/i.test(String(step.name || ""))));
  const lines = raw.split(/\r?\n/);

  const turns = [];
  let currentTurn = null;
  let hasExplicitMarkers = false;

  function ensureTurn(turnNum, subtitle, explicit) {
    if (explicit) hasExplicitMarkers = true;
    let existing = turns.find(t => t.turnNum === turnNum);
    if (!existing) {
      existing = {
        turnNum: turnNum,
        subtitle: subtitle || "",
        bodyLines: [],
        duration: "",
        completed: false,
        explicit: Boolean(explicit)
      };
      turns.push(existing);
    } else if (subtitle && !existing.subtitle) {
      existing.subtitle = subtitle;
    }
    if (explicit) existing.explicit = true;
    return existing;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const compMatch = trimmed.match(/^\[Turn\s+(\d+)\s+completed\s+in\s+([\d.]+s)\]$/i);
    if (compMatch) {
      const tNum = parseInt(compMatch[1], 10);
      const tDur = compMatch[2];
      const tObj = ensureTurn(tNum, "", true);
      tObj.duration = tDur;
      tObj.completed = true;
      continue;
    }

    const hdrMatch = trimmed.match(/^(Analyzing\s+(?:step\s+results|request))\s*\(Turn\s+(\d+)\)\.{0,3}$/i);
    if (hdrMatch) {
      const phaseText = hdrMatch[1].trim();
      const tNum = parseInt(hdrMatch[2], 10);
      turns.forEach(t => {
        if (t.turnNum < tNum) t.completed = true;
      });
      currentTurn = ensureTurn(tNum, phaseText, true);
      continue;
    }

    if (!currentTurn) {
      currentTurn = ensureTurn(1, "", false);
    }
    currentTurn.bodyLines.push(line);
  }

  const nowMs = Date.now();
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const isLastTurn = i === turns.length - 1;
    if (!isLastTurn || !isLiveStep) {
      t.completed = true;
    }
    const timingEntry = timings[t.turnNum];
    if (!t.duration && timingEntry) {
      if (timingEntry.duration) {
        t.duration = timingEntry.duration;
      } else if (timingEntry.startedAt && timingEntry.completedAt && timingEntry.completedAt >= timingEntry.startedAt) {
        t.duration = formatTurnDurationSec((timingEntry.completedAt - timingEntry.startedAt) / 1000);
      }
    }
    if (!t.duration && t.completed && turns.length === 1 && step) {
      const nameDurMatch = String(step.name || "").match(/Thought for\s+([\d.]+s)/i);
      if (nameDurMatch) {
        t.duration = nameDurMatch[1];
      } else if (step.duration) {
        t.duration = String(step.duration);
      }
    }
    t.startedAt = (timingEntry && timingEntry.startedAt) || (t.turnNum === 1 && step && step.startedAt) || (isLastTurn && isLiveStep ? nowMs : 0);
    t.body = t.bodyLines.join("\n").trim();

    if (t.turnNum === 1) {
      t.displaySubtitle = t.completed ? "Initial analysis & actions" : "Analyzing & running actions...";
    } else {
      t.displaySubtitle = t.completed ? "Analyzed step results" : "Analyzing step results...";
    }
  }

  return {
    turns: turns,
    useSubsections: hasExplicitMarkers || turns.length > 1 || isLiveStep
  };
}

function renderThinkingDetailHtml(detailText, step) {
  const parsed = parseThinkingTurns(detailText, step);
  if (!parsed.useSubsections || parsed.turns.length === 0) {
    return renderMarkdown(detailText);
  }

  const nowMs = Date.now();
  const sectionsHtml = parsed.turns.map((t, idx) => {
    const isCurrentActive = !t.completed && idx === parsed.turns.length - 1;
    let durText = t.duration || "";
    if (!durText && isCurrentActive && t.startedAt > 0) {
      const liveSec = Math.max(1, Math.round((nowMs - t.startedAt) / 1000));
      durText = `${liveSec}s`;
    }
    const bodyHtml = t.body
      ? `<div class="thinking-turn-body">${renderMarkdown(t.body)}</div>`
      : (isCurrentActive
          ? `<div class="thinking-turn-waiting">Waiting for model stream...</div>`
          : "");

    return `
      <div class="thinking-turn-section ${isCurrentActive ? 'is-active' : 'is-completed'}" data-turn-num="${t.turnNum}">
        <div class="thinking-turn-header">
          <span class="thinking-turn-title">
            <span class="thinking-turn-badge">Turn ${t.turnNum}</span>
            <span class="thinking-turn-subtitle">${escapeHtml(t.displaySubtitle)}</span>
          </span>
          ${durText || isCurrentActive ? `<span class="thinking-turn-duration ${isCurrentActive ? 'is-live' : ''}" ${isCurrentActive && t.startedAt > 0 ? `data-turn-start="${t.startedAt}"` : ""}>${escapeHtml(durText || "1s")}</span>` : ""}
        </div>
        ${bodyHtml}
      </div>
    `;
  }).join("");

  return `<div class="thinking-turns-list">${sectionsHtml}</div>`;
}

function renderWorktreeNodes(steps, parentEl, depth) {
  if (!Array.isArray(steps) || !parentEl) return;

  // At top-level, group consecutive file operations into "Explored files" if multiple
  let nodesToRender = steps;
  if (depth === 0) {
    const fileSteps = [];
    steps.forEach(s => {
      const isFile = s.type === "file" || (s.name && s.name.toLowerCase().startsWith("analyzed"));
      if (isFile) {
        fileSteps.push(s);
      }
    });

    if (fileSteps.length > 1 && !steps.some(s => s.type === "group" || s.name === "Explored files")) {
      const exploredGroup = {
        name: "Explored files",
        type: "group",
        collapsed: false,
        steps: fileSteps
      };
      const firstFileIdx = steps.findIndex(s => s.type === "file" || (s.name && s.name.toLowerCase().startsWith("analyzed")));
      nodesToRender = [
        ...steps.slice(0, firstFileIdx),
        exploredGroup,
        ...steps.slice(firstFileIdx).filter(s => s.type !== "file" && !(s.name && s.name.toLowerCase().startsWith("analyzed")))
      ];
    }
  }

  nodesToRender.forEach(step => {
    if (step.type === "approval_pending") return;

    const nodeEl = document.createElement("div");
    nodeEl.className = "worktree-node";
    nodeEl.setAttribute("data-depth", Math.min(depth, 3));
    if (step.id) {
      nodeEl.setAttribute("data-step-id", step.id);
    }

    const isGroup = step.type === "group" || (Array.isArray(step.steps) && step.steps.length > 0);
    const isThought = step.type === "thought" || (step.name && step.name.toLowerCase().startsWith("thought")) || (step.name && step.name.toLowerCase().startsWith("thinking"));
    const isFile = step.type === "file" || (step.name && step.name.toLowerCase().startsWith("analyzed"));
    const detailText = String(step.detail || step.output || "").trim();
    const hasDetail = detailText.length > 0;
    const detailHtml = hasDetail ? (isThought ? renderThinkingDetailHtml(detailText, step) : renderMarkdown(detailText)) : "";

    // Never render a "Thinking..." or thought step before there is actual thinking output
    if (isThought && !hasDetail) return;

    if (isGroup) {
      const isCollapsed = step.collapsed === true;
      nodeEl.innerHTML = `
        <div class="worktree-header interactive" onclick="toggleWorktreeNode(this)">
          <span class="worktree-label">${escapeHtml(step.name || "Explored files")}</span>
          <span class="worktree-chevron ${isCollapsed ? 'collapsed' : ''}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg></span>
        </div>
        <div class="worktree-children ${isCollapsed ? 'collapsed' : ''}"></div>
      `;
      const childrenContainer = nodeEl.querySelector(".worktree-children");
      renderWorktreeNodes(step.steps || [], childrenContainer, depth + 1);
    } else if (isFile) {
      const rawTitle = (step.title || step.name || "").trim();
      const clean = rawTitle.replace(/^Analyzed\s+(?:<\/>\s*)?/i, "").replace(/^(?:Read\s+file|View)\s+/i, "");
      const parts = clean.split(/\s+#L|\s+#/);
      const filePath = parts[0] ? parts[0].trim() : "file";
      const lineRange = parts[1] ? `#L${parts[1].trim()}` : (step.detail && step.detail.match(/#L[\d\-]+/i) ? step.detail.match(/#L[\d\-]+/i)[0] : "");

      nodeEl.innerHTML = `
        <div class="worktree-header">
          <div class="worktree-file-action" onclick="previewFileInSidebar('${escapeJsAttr(filePath)}')">
            <span>Analyzed</span>
            <span class="step-filepath">${escapeHtml(filePath)}</span>
            ${lineRange ? `<span class="step-line-range">${escapeHtml(lineRange)}</span>` : ""}
          </div>
        </div>
      `;
    } else if (isThought) {
      const isCollapsed = step.collapsed !== false;
      const stepTitle = step.name || (step.duration ? `Thought for ${step.duration}` : "Thought");
      nodeEl.innerHTML = `
        <div class="worktree-header ${hasDetail ? 'interactive' : ''}" ${hasDetail ? 'onclick="toggleWorktreeNode(this)"' : ''}>
          <span class="worktree-label">${escapeHtml(stepTitle)}</span>
          ${hasDetail ? `<span class="worktree-chevron ${isCollapsed ? 'collapsed' : ''}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg></span>` : ""}
        </div>
        ${hasDetail ? `<div class="worktree-detail ${isCollapsed ? 'collapsed' : ''}">${detailHtml}</div>` : ""}
      `;
    } else {
      const isCollapsed = step.collapsed !== false;
      const stepTitle = step.name || step.title || "Step";
      nodeEl.innerHTML = `
        <div class="worktree-header ${hasDetail ? 'interactive' : ''}" ${hasDetail ? 'onclick="toggleWorktreeNode(this)"' : ''}>
          <span class="worktree-label">${escapeHtml(stepTitle)}</span>
          ${hasDetail ? `<span class="worktree-chevron ${isCollapsed ? 'collapsed' : ''}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg></span>` : ""}
        </div>
        ${hasDetail ? `<div class="worktree-detail ${isCollapsed ? 'collapsed' : ''}">${detailHtml}</div>` : ""}
      `;
    }

    parentEl.appendChild(nodeEl);
  });
}


// --- Footer Model & Reasoning Controls ---
// ----------------- Model & Reasoning State -----------------
const AVAILABLE_MODELS = [
  { id: "gemini-3.8-flash", name: "Gemini-3.8-Flash", note: "Default" },
  { id: "gemini-3.8-pro", name: "Gemini 3.8 Pro", note: "Reasoning" },
  { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet", note: "Anthropic" },
  { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", note: "Anthropic" },
  { id: "gpt-4o", name: "GPT-4o", note: "OpenAI" },
  { id: "tendon-local", name: "Tendon CUDA", note: "Local GPU" },
  { id: "ollama", name: "Ollama", note: "Local LLM" },
];

function selectModel(modelId) {
  activeAiModel = modelId;
  localStorage.setItem("orborus_ai_model", modelId);
  const sel = document.getElementById("select-ai-model");
  if (sel) sel.value = modelId;
  const footerModelSelect = document.getElementById("select-footer-model");
  const customInput = document.getElementById("input-custom-model");
  if (footerModelSelect) {
    if (modelId === "gemini-3.8-flash") {
      footerModelSelect.value = "gemini-3.8-flash";
      if (customInput) customInput.style.display = "none";
    } else {
      footerModelSelect.value = "custom";
      if (customInput) {
        customInput.style.display = "inline-block";
        customInput.value = modelId;
      }
    }
  }
}

function initFooterControls() {
  const footerModelSelect = document.getElementById("select-footer-model");
  const customInput = document.getElementById("input-custom-model");
  const footerReasoningSelect = document.getElementById("select-footer-reasoning");

  // Reasoning setup (defaults to low)
  activeReasoningEffort = localStorage.getItem("orborus_ai_reasoning") || "low";
  if (footerReasoningSelect) {
    footerReasoningSelect.value = activeReasoningEffort;
  }
  updateActiveReasoningLabel();

  // Model setup
  const savedModel = localStorage.getItem("orborus_ai_model") || "gemini-3.8-flash";
  activeAiModel = savedModel;

  if (!savedModel || savedModel === "gemini-3.8-flash") {
    activeAiModel = "gemini-3.8-flash";
    localStorage.setItem("orborus_ai_model", "gemini-3.8-flash");
    if (footerModelSelect) footerModelSelect.value = "gemini-3.8-flash";
    if (customInput) customInput.style.display = "none";
  } else {
    if (footerModelSelect) footerModelSelect.value = "custom";
    if (customInput) {
      customInput.style.display = "inline-block";
      customInput.value = savedModel;
    }
  }
  updateActiveModelLabel();
}

function handleFooterModelChange(val) {
  const customInput = document.getElementById("input-custom-model");
  if (val === "custom") {
    if (customInput) {
      customInput.style.display = "inline-block";
      const savedCustom = localStorage.getItem("orborus_custom_model") || "";
      if (savedCustom) {
        customInput.value = savedCustom;
        activeAiModel = savedCustom;
      } else if (activeAiModel && activeAiModel !== "gemini-3.8-flash") {
        customInput.value = activeAiModel;
      } else {
        customInput.value = "";
      }
      customInput.focus();
      if (customInput.value.trim()) {
        syncModelSettings(customInput.value.trim());
      }
    }
  } else {
    if (customInput) {
      customInput.style.display = "none";
    }
    activeAiModel = "gemini-3.8-flash";
    localStorage.setItem("orborus_ai_model", "gemini-3.8-flash");
    syncModelSettings("gemini-3.8-flash");
  }
}

function handleCustomModelInput(val) {
  const trimmed = val.trim();
  if (trimmed) {
    activeAiModel = trimmed;
    localStorage.setItem("orborus_ai_model", trimmed);
    localStorage.setItem("orborus_custom_model", trimmed);
    syncModelSettings(trimmed);
  }
}

function handleFooterReasoningChange(val) {
  activeReasoningEffort = val || "low";
  localStorage.setItem("orborus_ai_reasoning", activeReasoningEffort);
  updateActiveReasoningLabel();
  if (window.isDebug) {
    console.log("[DEBUG] Reasoning effort changed to:", activeReasoningEffort);
  }
}

function syncModelSettings(model) {
  const modelSelect = document.getElementById("select-ai-model");
  if (modelSelect) {
    let found = false;
    for (let i = 0; i < modelSelect.options.length; i++) {
      if (modelSelect.options[i].value === model) {
        modelSelect.value = model;
        found = true;
        break;
      }
    }
    if (!found && model) {
      const opt = document.createElement("option");
      opt.value = model;
      opt.innerText = `${model} (Custom)`;
      modelSelect.appendChild(opt);
      modelSelect.value = model;
    }
  }
  updateEnvDisplayInModal();
}


// --- Prompt Execution, Turn Rendering, Stream & Activity Steps ---
// ----------------- Session & Execution -----------------
function startNewSession() {
  if (activeConversationId && typeof saveCurrentConversationScrollState === "function") {
    saveCurrentConversationScrollState(activeConversationId);
  }
  activeConversationId = null;
  localStorage.removeItem("orborus_active_conv_id");
  setChatMode(false);
  if (typeof updateScrollToBottomButton === "function") {
    updateScrollToBottomButton();
  }
  activeRunningTasks = [];
  renderRunningTasks();

  const turnsContainer = document.getElementById("conversation-turns-container");
  if (turnsContainer) turnsContainer.innerHTML = "";
  const promptCard = document.getElementById("active-user-prompt-card");
  if (promptCard) {
    promptCard.innerText = "";
    promptCard.style.display = "none";
  }
  const summaryBanner = document.getElementById("activity-summary-banner");
  if (summaryBanner) summaryBanner.style.display = "none";
  const stepsContainer = document.getElementById("activity-steps-container");
  if (stepsContainer) stepsContainer.innerHTML = "";
  const container = document.getElementById("execution-cards-container");
  if (container) container.innerHTML = "";
  const approvalCard = document.getElementById("approval-card");
  if (approvalCard) approvalCard.classList.remove("visible");
  const dockContainer = document.getElementById("chat-dock-container");
  if (dockContainer) dockContainer.classList.remove("has-approval-card");
  currentApprovalId = null;

  const btnStop = document.getElementById("btn-stop-execution");
  const btnSend = document.getElementById("btn-send");
  if (btnStop) btnStop.style.display = "none";
  if (btnSend) {
    btnSend.style.display = "flex";
    btnSend.classList.remove("active");
  }

  const topbarConv = document.getElementById("topbar-conv-title");
  if (topbarConv) topbarConv.innerText = "New Conversation";
  const topbarProj = document.getElementById("topbar-project-name");
  if (topbarProj) {
    const activeProjectEl = document.getElementById("active-project-name");
    const activeDisplay = activeProjectEl ? activeProjectEl.innerText : "";
    topbarProj.innerText = activeDisplay || (activeProjectPath ? (activeProjectPath.split(/[/\\]/).filter(Boolean).pop() || "Project") : "No project");
  }
  const archiveBtn = document.getElementById("btn-archive-active-chat");
  if (archiveBtn) archiveBtn.style.display = "none";

  const archivedBanner = document.getElementById("archived-chat-banner");
  if (archivedBanner) archivedBanner.style.display = "none";

  const mainContainer = document.getElementById("main-container");
  if (mainContainer) mainContainer.classList.remove("has-history");

  const inputCard = document.querySelector(".input-card");
  if (inputCard) inputCard.classList.remove("archived-readonly");

  const input = document.getElementById("prompt-input");
  if (input) {
    input.disabled = false;
    input.placeholder = "Ask anything, @ to mention, / for actions";
    input.value = "";
    input.style.height = "auto";
    setTimeout(() => input.focus(), 50);
  }

  // Restore model from the last message or remembered model for this chat type
  const lastConvModel = typeof getLastMessageModelFromAnyConv === "function"
    ? getLastMessageModelFromAnyConv(appConversations, activeConversationId)
    : "";
  const rememberedModel = typeof getRememberedModelForType === "function"
    ? getRememberedModelForType(activeProjectPath)
    : "";
  const nextModel = lastConvModel || rememberedModel || activeAiModel || localStorage.getItem("orborus_ai_model") || "tendon-local";
  if (nextModel) {
    activeAiModel = nextModel;
    if (typeof window !== "undefined") window.activeAiModel = nextModel;
    localStorage.setItem("orborus_ai_model", nextModel);
  }
  if (typeof getRememberedReasoningForType === "function") {
    activeReasoningEffort = getRememberedReasoningForType(activeProjectPath) || "low";
    if (typeof window !== "undefined") window.activeReasoningEffort = activeReasoningEffort;
    localStorage.setItem("orborus_ai_reasoning", activeReasoningEffort);
  }
  if (typeof updateActiveModelLabel === "function") updateActiveModelLabel();
  if (typeof updateActiveReasoningLabel === "function") updateActiveReasoningLabel();

  renderProjectTree();
  if (typeof renderTerminalLogs === "function") renderTerminalLogs();
  showToast("Started new conversation session");
}

function handleInput(el) {
  const btn = document.getElementById("btn-send");
  const hasAtt = typeof window !== "undefined" && Array.isArray(window.pendingAttachments) && window.pendingAttachments.length > 0;
  if ((el && el.value.trim().length > 0) || hasAtt) {
    if (btn) btn.classList.add("active");
  } else {
    if (btn) btn.classList.remove("active");
  }

  if (el) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  }
}

function handleKeyDown(event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitPrompt();
  }
}

let currentPromptAbortController = null;
let currentPromptExecutingTurn = null;

async function submitPrompt(forcedPrompt, forcedAttachments) {
  // Prevent sending new prompts into an archived conversation until it is unarchived
  if (activeConversationId && Array.isArray(appConversations)) {
    const activeConvObj = appConversations.find(c => c && c.id === activeConversationId);
    if (activeConvObj && (activeConvObj.archived || activeConvObj.is_archived)) {
      showToast("This conversation is archived. Unarchive it first to continue chatting.");
      return;
    }
  }

  const textarea = document.getElementById("prompt-input");
  const prompt = (typeof forcedPrompt === "string" ? forcedPrompt : (textarea ? textarea.value : "")).trim();
  const attachmentsToSend = Array.isArray(forcedAttachments)
    ? forcedAttachments.slice()
    : (typeof forcedPrompt !== "string" && typeof window !== "undefined" && Array.isArray(window.pendingAttachments)
        ? window.pendingAttachments.slice()
        : []);
  if (!prompt && attachmentsToSend.length === 0) return;

  // If an attached question or "No (with comment)" approval card is visible, submitting text in the main input answers it directly
  const activeApprovalCard = document.getElementById("approval-card");
  if (
    typeof forcedPrompt !== "string" &&
    prompt &&
    attachmentsToSend.length === 0 &&
    activeApprovalCard &&
    activeApprovalCard.classList.contains("visible") &&
    (window.currentApprovalKind === "question" || (typeof selectedApprovalOption !== "undefined" && selectedApprovalOption === 5)) &&
    typeof submitApproval === "function"
  ) {
    await submitApproval();
    const btn = document.getElementById("btn-send");
    if (btn) btn.classList.remove("active");
    return;
  }

  // Pre-flight check: If model is not configured or unavailable, prevent execution
  const curModel = activeAiModel || (typeof window !== "undefined" && window.activeAiModel) || (typeof localStorage !== "undefined" && localStorage.getItem("orborus_ai_model")) || "gemini-3.8-flash";
  const modelStatus = (typeof getModelConfigStatus === "function") ? getModelConfigStatus(curModel) : { configured: true };
  if (!modelStatus.configured) {
    const reminderBox = document.getElementById("model-config-reminder");
    if (reminderBox) {
      reminderBox.classList.remove("shake-reminder");
      void reminderBox.offsetWidth; // Force DOM reflow to replay shake animation
      reminderBox.classList.add("shake-reminder");
    }
    const reasonText = modelStatus.reason || "Model is not configured";
    const actionText = modelStatus.actionText ? ` (${modelStatus.actionText})` : "";
    showToast(`Cannot run: ${reasonText}${actionText}`);
    return;
  }

  // Queue prompt if another execution is already in flight
  if (isPromptExecuting) {
    enqueuePrompt(prompt, attachmentsToSend);
    if (textarea && typeof forcedPrompt !== "string") {
      textarea.value = "";
      textarea.style.height = "auto";
      if (typeof clearPendingAttachments === "function") {
        clearPendingAttachments();
      }
      const btn = document.getElementById("btn-send");
      if (btn) btn.classList.remove("active");
    }
    return;
  }

  isPromptExecuting = true;
  setChatMode(true);

  if (textarea && typeof forcedPrompt !== "string") {
    textarea.value = "";
    textarea.style.height = "auto";
    if (typeof clearPendingAttachments === "function") {
      clearPendingAttachments();
    }
  }
  const btnSend = document.getElementById("btn-send");
  const btnStop = document.getElementById("btn-stop-execution");
  if (btnSend) {
    btnSend.classList.remove("active");
    btnSend.style.display = "none";
  }
  if (btnStop) btnStop.style.display = "flex";

  document.getElementById("main-container").classList.add("has-history");

  const promptCard = document.getElementById("active-user-prompt-card");
  if (promptCard) {
    promptCard.innerText = "";
    promptCard.style.display = "none";
  }

  // Only tasks reported by the agent as actively running background tasks should appear.
  activeRunningTasks = [];
  renderRunningTasks();

  const summaryBanner = document.getElementById("activity-summary-banner");
  if (summaryBanner) {
    summaryBanner.style.display = "none";
  }

  // 1. Create immediate optimistic turn in running state with initial progress steps
  const turnId = "turn-" + Date.now();
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const selectedModel = activeAiModel || "tendon-local";
  const modelDisplayName = resolveModelDisplayName(selectedModel);
  const isLocal = typeof isSelfHostedModel === "function" ? isSelfHostedModel(selectedModel) : false;
  const initialPhase = isLocal ? "Initializing GPU engine..." : `Connecting to ${modelDisplayName}...`;

  const displayAttachments = attachmentsToSend.map(a => ({
    name: a.name || "attachment",
    path: a.path || "",
    mime: a.mime || "",
    is_image: Boolean(a.is_image),
    data_uri: a.is_image ? (a.data_uri || "") : "",
    size: a.size || 0
  }));

  const optimisticTurn = {
    id: turnId,
    prompt: prompt,
    attachments: displayAttachments,
    timestamp: timeStr,
    steps: [],
    output: "",
    status: "running",
    duration: "",
    phase: initialPhase,
    model: selectedModel,
    debug_info: { ui_model: selectedModel, turn_model: selectedModel, model: selectedModel },
    modelActive: !isLocal
  };

  const rawTitleSource = prompt || (displayAttachments.length > 0 ? `Attached ${displayAttachments[0].name}` : "New conversation");
  const firstLine = rawTitleSource.split("\n")[0].substring(0, 36);
  const activeProjectEl = document.getElementById("active-project-name");
  const activeDisplay = activeProjectEl ? activeProjectEl.innerText : "";
  const effectiveProjName = activeDisplay || (activeProjectPath ? (activeProjectPath.split(/[/\\]/).filter(Boolean).pop() || "Project") : "No project");

  if (!activeConversationId) {
    activeConversationId = "conv-" + Date.now();
    localStorage.setItem("orborus_active_conv_id", activeConversationId);
    const newConv = {
      id: activeConversationId,
      projectId: activeProjectPath,
      project_id: activeProjectPath,
      projectName: effectiveProjName,
      project_name: effectiveProjName,
      title: firstLine,
      model: selectedModel,
      reasoning: activeReasoningEffort || "low",
      pinned: false,
      turns: [optimisticTurn]
    };
    if (!Array.isArray(appConversations)) appConversations = [];
    appConversations.unshift(newConv);
    if (typeof conversationOrderIds !== "undefined" && Array.isArray(conversationOrderIds)) {
      conversationOrderIds = [newConv.id, ...conversationOrderIds.filter(id => id !== newConv.id)];
      if (typeof saveConversationOrder === "function") saveConversationOrder(conversationOrderIds);
    }
    const topbarConv = document.getElementById("topbar-conv-title");
    if (topbarConv) topbarConv.innerText = firstLine;
  } else {
    if (!Array.isArray(appConversations)) appConversations = [];
    let curConv = appConversations.find(c => c.id === activeConversationId);
    if (!curConv) {
      curConv = {
        id: activeConversationId,
        projectId: activeProjectPath,
        project_id: activeProjectPath,
        projectName: effectiveProjName,
        project_name: effectiveProjName,
        title: firstLine,
        model: selectedModel,
        reasoning: activeReasoningEffort || "low",
        pinned: false,
        turns: []
      };
      appConversations.unshift(curConv);
      if (typeof conversationOrderIds !== "undefined" && Array.isArray(conversationOrderIds)) {
        conversationOrderIds = [curConv.id, ...conversationOrderIds.filter(id => id !== curConv.id)];
        if (typeof saveConversationOrder === "function") saveConversationOrder(conversationOrderIds);
      }
    } else {
      curConv.model = selectedModel;
      curConv.reasoning = activeReasoningEffort || "low";
    }
    if (!curConv.turns) curConv.turns = [];
    curConv.turns.push(optimisticTurn);
    curConv.updated_at = new Date().toISOString();
  }

  if (typeof saveRememberedModelForType === "function") {
    saveRememberedModelForType(activeProjectPath, selectedModel);
  }
  if (typeof saveRememberedReasoningForType === "function") {
    saveRememberedReasoningForType(activeProjectPath, activeReasoningEffort || "low");
  }

  const executingConvId = activeConversationId;
  runningConversationId = executingConvId;
  if (typeof markConversationRead === "function") {
    markConversationRead(executingConvId);
  }
  if (typeof window !== "undefined") {
    window.isPromptExecuting = true;
    window.runningConversationId = executingConvId;
  }
  currentPromptAbortController = new AbortController();
  currentPromptExecutingTurn = optimisticTurn;

  if (executingConvId && typeof conversationScrollState !== "undefined") {
    conversationScrollState[executingConvId] = { scrollTop: 0, isAtBottom: true };
  }

  // Paint optimistic state immediately (0ms delay)
  renderProjectTree();
  renderActiveConversation();
  if (typeof scheduleLocalConversationsSave === "function") {
    scheduleLocalConversationsSave();
  }

  if (typeof scrollToBottomOfStream === "function") {
    scrollToBottomOfStream(false);
  }

  // Live duration & phase update timer
  const startTime = Date.now();
  optimisticTurn.startedAt = startTime;
  function getWaitingPhaseText(elapsedSec) {
    if (isLocal) {
      if (!optimisticTurn.modelActive) {
        if (elapsedSec < 3) return "Initializing GPU engine...";
        if (elapsedSec < 8) return `Transferring weights into VRAM (${elapsedSec}s)...`;
        return `Preparing engine context (${elapsedSec}s)...`;
      }
      return `Processing with ${modelDisplayName} (${elapsedSec}s)...`;
    } else {
      if (elapsedSec < 2) return `Connecting to ${modelDisplayName}...`;
      if (elapsedSec < 6) return "Analyzing prompt and workspace context...";
      return `Waiting for response & agent decisions (${elapsedSec}s)...`;
    }
  }

  const liveTimer = setInterval(() => {
    const now = Date.now();
    const elapsedSec = Math.max(1, Math.round((now - startTime) / 1000));
    optimisticTurn.duration = `${elapsedSec}s`;
    const lastAct = optimisticTurn.lastActivityAt || optimisticTurn.lastChunkAt || optimisticTurn.lastProgressAt || startTime;
    const idleSec = Math.max(0, Math.round((now - lastAct) / 1000));

    if (activeConversationId === executingConvId) {
      const hasPendingAppr = Array.isArray(globalApprovalQueue) && globalApprovalQueue.some(q => !q.conversation_id || q.conversation_id === executingConvId);
      const durEl = document.getElementById("live-dur-" + turnId);
      if (durEl) {
        durEl.innerText = `${elapsedSec}s`;
      }
      const phaseEl = document.getElementById("live-phase-" + turnId);
      if (phaseEl) {
        if (hasPendingAppr) {
          const firstItem = globalApprovalQueue.find(q => !q.conversation_id || q.conversation_id === executingConvId) || globalApprovalQueue[0];
          const cmdSnippet = firstItem && firstItem.action ? firstItem.action : "command";
          phaseEl.innerText = `Waiting for approval: ${cmdSnippet}`;
          const card = document.getElementById("approval-card");
          if (card && !card.classList.contains("visible") && typeof showApprovalCard === "function" && firstItem) {
            showApprovalCard(firstItem);
          }
        } else {
          const backendDrivenAt = parseInt(phaseEl.getAttribute("data-backend-driven-at") || "0", 10);
          const backendStale = backendDrivenAt > 0 && (now - backendDrivenAt) > 4000;
          if (!phaseEl.getAttribute("data-backend-driven") || backendStale) {
            if (idleSec >= 15) {
              phaseEl.innerText = `Waiting for ${modelDisplayName} response (${elapsedSec}s)...`;
            } else {
              phaseEl.innerText = getWaitingPhaseText(elapsedSec);
            }
          }
        }
      }
      const statusEl = document.getElementById("cmd-status-" + turnId);
      if (statusEl) {
        if (hasPendingAppr) {
          statusEl.innerText = "Waiting for approval";
        } else if (optimisticTurn.modelActive || !isLocal) {
          statusEl.innerText = `Processing with ${modelDisplayName}`;
        } else {
          statusEl.innerText = `Enabling local model ${modelDisplayName}`;
        }
      }
      if (Array.isArray(optimisticTurn.steps)) {
        const liveStep = optimisticTurn.steps.find(s => s && s.id === "live-thought");
        if (liveStep) {
          const thoughtElapsed = liveStep.startedAt
            ? Math.max(1, Math.round((now - liveStep.startedAt) / 1000))
            : elapsedSec;
          liveStep.name = hasPendingAppr
            ? "Waiting for approval..."
            : (idleSec >= 12
                ? `Thinking (${thoughtElapsed}s — waiting for stream...)`
                : `Thinking (${thoughtElapsed}s)...`);
          const stepRow = document.getElementById("step-row-live-thought") || document.querySelector('.worktree-node[data-step-id="live-thought"]');
          if (stepRow) {
            const titleEl = stepRow.querySelector(".worktree-step-title, :scope > .worktree-header .worktree-label");
            if (titleEl) titleEl.innerText = liveStep.name;
            const liveTurnDurEls = stepRow.querySelectorAll(".thinking-turn-duration.is-live[data-turn-start]");
            liveTurnDurEls.forEach(el => {
              const tStart = parseInt(el.getAttribute("data-turn-start") || "0", 10);
              if (tStart > 0) {
                const tSec = Math.max(1, Math.round((now - tStart) / 1000));
                el.innerText = `${tSec}s`;
              }
            });
          }
          if (stepRow) {
            const titleEl = stepRow.querySelector(".worktree-step-title");
            if (titleEl) titleEl.innerText = liveStep.name;
          }
        }
      }
    }
  }, 1000);

  try {
    let raw;
    const rawKey = currentAiKey || localStorage.getItem("orborus_ai_key") || "";
    const rawUrl = currentAiUrl || localStorage.getItem("orborus_ai_url") || "";
    const curMode = (typeof window !== "undefined" && window.activeExecutionMode) || activeExecutionMode || localStorage.getItem("orborus_active_execution_mode") || "";
    const isShuffleModePrompt =
      activeAiModel === "shuffle-ai" ||
      activeAiModel === "shuffle" ||
      curMode === "shuffle" ||
      rawKey.startsWith("shfl_") ||
      (window.oauthLoggedIn && (activeAiModel === "gemini-3.8-flash" || activeAiModel === "gemini-3.8-pro" || !rawKey));
    const effectiveKey = isShuffleModePrompt
      ? (rawKey.startsWith("shfl_") ? rawKey : "")
      : rawKey;
    const effectiveUrl = isShuffleModePrompt
      ? (rawUrl.toLowerCase().includes("shuffler.io") ? rawUrl : "")
      : rawUrl;
    if (effectiveKey || effectiveUrl || isShuffleModePrompt) {
      dismissAuthErrorsIfConfigured();
    }

    const promptPayload = JSON.stringify({
      prompt: prompt,
      bypass: false,
      conversation_id: executingConvId || "",
      model: activeAiModel || "gemini-3.8-flash",
      reasoning: activeReasoningEffort || "low",
      ai_api_key: effectiveKey,
      ai_api_url: effectiveUrl,
      shuffle_tools: Array.isArray(window.attachedShuffleTools) ? window.attachedShuffleTools : [],
      shuffle_skills: Array.isArray(window.attachedShuffleSkills) ? window.attachedShuffleSkills : [],
      has_shuffle_skills: true,
      attachments: attachmentsToSend.map(a => ({
        name: a.name || "attachment",
        path: a.path || "",
        mime: a.mime || "",
        data_uri: a.data_uri || "",
        content: a.content || "",
        is_image: Boolean(a.is_image),
        size: a.size || 0
      }))
    });

    console.log("[Shuffle Agent] Submitting prompt to backend:", {
      prompt: prompt,
      attachments_count: attachmentsToSend.length,
      model: activeAiModel || "gemini-3.8-flash",
      reasoning: activeReasoningEffort || "low",
      conversation_id: executingConvId,
      has_key: Boolean(effectiveKey),
      has_url: Boolean(effectiveUrl)
    });

    if (typeof window.bridgeCall === "function") {
      raw = await window.bridgeCall("runPrompt", promptPayload, currentPromptAbortController.signal);
    } else if (typeof window.runPrompt === "function") {
      raw = await window.runPrompt(prompt, false, executingConvId || "");
    } else {
      console.warn("[Shuffle Agent] Native agent bridge not found");
      await new Promise(r => setTimeout(r, 400));
      raw = JSON.stringify({
        prompt: prompt,
        output: "Native agent bridge is not available. Please connect to a running backend or runner.",
        error: "Native agent bridge not connected",
        steps: []
      });
    }

    console.log("[Shuffle Agent] Bridge response received:", raw);
    clearInterval(liveTimer);

    let res = null;
    if (typeof raw === "object" && raw !== null) {
      res = raw;
    } else if (typeof raw === "string" && raw.trim().length > 0) {
      try {
        res = JSON.parse(raw);
      } catch (parseErr) {
        console.warn("Failed to parse bridge response as JSON:", raw, parseErr);
        res = {
          status: "error",
          error: raw || "Execution failed",
          error_type: "execution_error",
          fix_help: "Backend returned non-JSON output. Check application logs."
        };
      }
    } else {
      res = {
        status: "error",
        error: "Internal error: Backend returned an empty response",
        error_type: "execution_error",
        fix_help: "Check backend terminal logs for detailed traces."
      };
    }

    if (activeConversationId === executingConvId) {
      activeRunningTasks = [];
      renderRunningTasks();
      if (btnStop) btnStop.style.display = "none";
      if (btnSend) btnSend.style.display = "flex";
    }

    const elapsed = Math.max(1, Math.round((Date.now() - startTime) / 1000));
    optimisticTurn.duration = res.duration || `${elapsed}s`;

    // 1. Check if stopped by user while waiting or aborted
    const wasStoppedByUser = optimisticTurn.status === "interrupted" ||
      optimisticTurn.wasUserStopped ||
      !isPromptExecuting ||
      res.status === "interrupted" ||
      res.error_type === "user_cancelled" ||
      (res.error && res.error.toLowerCase().includes("stopped by user"));

    if (wasStoppedByUser) {
      optimisticTurn.status = "interrupted";
      optimisticTurn.phase = "Stopped by user";
      optimisticTurn.error = "Generation stopped by user";
      optimisticTurn.error_type = "user_cancelled";
      if (res.output && res.output.length > (optimisticTurn.output || "").length && !res.output.toLowerCase().includes("failed to fetch")) {
        optimisticTurn.output = res.output;
      }
      if (res.steps && Array.isArray(res.steps) && res.steps.length > 0) {
        optimisticTurn.steps = res.steps;
      }
      finalizeTurnLiveThoughts(optimisticTurn, "Thought (stopped)");
      renderProjectTree();
      await saveStoredConversations();
      if (activeConversationId === executingConvId) {
        renderActiveConversation();
      }
      return;
    }

    if (res.needs_approval) {
      optimisticTurn.status = "needs_approval";
      finalizeTurnLiveThoughts(optimisticTurn);
      currentApprovalId = res.id;
      currentApprovalCmd = res.prompt;
      currentApprovalCmdPrefix = res.command_prefix || res.prompt.trim().split(/\s+/).slice(0, 2).join(" ");
      currentApprovalDesc = res.description || "Confirm the command is safe to run outside of the sandbox with full network and disk access.";
      currentApprovalProject = res.project || activeProjectPath;

      if (activeConversationId === executingConvId) {
        showApprovalCard({
          id: res.id,
          cmd: res.prompt,
          prefix: currentApprovalCmdPrefix,
          desc: currentApprovalDesc,
          project: currentApprovalProject
        });
        renderActiveConversation();
      }
      renderProjectTree();
      await saveStoredConversations();
      return;
    }

    if (res.needs_login) {
      optimisticTurn.status = "error";
      optimisticTurn.error = res.error || "Authentication required. Please log in.";
      optimisticTurn.error_type = "auth_error";
      finalizeTurnLiveThoughts(optimisticTurn);
      loginWithOAuth();
      renderProjectTree();
      await saveStoredConversations();
      if (activeConversationId === executingConvId) {
        renderActiveConversation();
      }
      return;
    }

    if (res.needs_ai_config) {
      optimisticTurn.status = "error";
      optimisticTurn.error = res.error || res.output || "No LLM apikey supplied AND no organization-specific key found. Please create a custom AI app authentication.";
      optimisticTurn.error_type = "missing_credentials";
      optimisticTurn.debug_info = Object.assign({}, res.debug_info || res, {
        ui_model: selectedModel,
        turn_model: selectedModel
      });
      finalizeTurnLiveThoughts(optimisticTurn);
      renderProjectTree();
      await saveStoredConversations();
      if (activeConversationId === executingConvId) {
        renderActiveConversation();
      }
      return;
    }

    let errorMsg = res.error || (res.output && res.output.startsWith("Error:") ? res.output : "");
    if (errorMsg.includes("Failed to fetch")) {
      errorMsg = "Connection to agent bridge was lost (failed to fetch). Ensure Shuffle Agent is running.";
    }

    const isError = res.status === "error" || (res.output && res.output.startsWith("Error:")) || !!res.error;
    optimisticTurn.status = isError ? "error" : "success";

    // CRITICAL: NEVER wipe out existing streamed output with an error message!
    const streamedRawOutput = optimisticTurn.output || "";
    const hadExistingOutput = !!(streamedRawOutput && streamedRawOutput.trim().length > 0);
    if (res.output && !res.output.startsWith("Error:")) {
      // Preserve raw streamed output if it contained <thought> tags that backend stripped
      if (streamedRawOutput.includes("<thought>") && !res.output.includes("<thought>")) {
        optimisticTurn.raw_output = streamedRawOutput;
      } else {
        optimisticTurn.raw_output = res.raw_output || res.output;
      }
      // If res.output is just a generic placeholder like "Completed." while streamedRawOutput has a real answer, prefer the real answer
      if (isGenericPlaceholderText(res.output) && hadExistingOutput && !isGenericPlaceholderText(streamedRawOutput)) {
        optimisticTurn.output = streamedRawOutput;
      } else {
        optimisticTurn.output = res.output;
      }
    } else if (!hadExistingOutput && errorMsg) {
      optimisticTurn.output = errorMsg;
      optimisticTurn.raw_output = res.raw_output || res.output || errorMsg;
    } else {
      optimisticTurn.raw_output = streamedRawOutput;
    }
    optimisticTurn.error = errorMsg;
    optimisticTurn.error_type = res.error_type || (isError ? "execution_error" : "");
    optimisticTurn.fix_help = res.fix_help || "";
    optimisticTurn.changed_files = res.changed_files || null;
    if (res.workflow_execution) {
      optimisticTurn.workflow_execution = res.workflow_execution;
    }
    if (res.debug_info) {
      optimisticTurn.debug_info = Object.assign({}, res.debug_info, {
        ui_model: selectedModel,
        turn_model: selectedModel
      });
    }
    const rawPayloadCopy = Object.assign({}, res);
    delete rawPayloadCopy.conversation;
    const prevThoughtSteps = Array.isArray(optimisticTurn.steps)
      ? optimisticTurn.steps.filter(s => s && (s.type === "thought" || s.id === "live-thought"))
      : [];
    delete rawPayloadCopy.turns;
    optimisticTurn.raw_json = rawPayloadCopy;

    if (res.steps && Array.isArray(res.steps) && res.steps.length > 0) {
      optimisticTurn.steps = res.steps;
    } else if (!Array.isArray(optimisticTurn.steps)) {
      optimisticTurn.steps = [];
    }

    const rawDecisions = res.decisions || (res.workflow_execution && res.workflow_execution.decisions) || [];
    if (rawDecisions.length > 0) {
      optimisticTurn.decisions = rawDecisions;
    }

    // Finalize any remaining live-thought steps into completed "Thought for Xs" steps
    if (prevThoughtSteps.length > 0 && Array.isArray(optimisticTurn.steps)) {
      const bestPrev = prevThoughtSteps[prevThoughtSteps.length - 1];
      const existingThought = optimisticTurn.steps.find(s => s && (s.type === "thought" || s.id === "live-thought"));
      if (existingThought) {
        if (bestPrev.detail && bestPrev.detail.includes("[Turn ") && !String(existingThought.detail || "").includes("[Turn ")) {
          existingThought.detail = bestPrev.detail;
        }
        existingThought.turnTimings = existingThought.turnTimings || bestPrev.turnTimings || optimisticTurn.thoughtTurnTimings;
      } else if (bestPrev.detail) {
        optimisticTurn.steps.unshift(bestPrev);
      }
    }
    finalizeTurnLiveThoughts(optimisticTurn);
    finalizeTurnLiveThoughts(optimisticTurn);

    // If the final output is empty or a generic placeholder ("Completed."), recover the substantive answer from thought steps or decision reasons
    if (!isError && isGenericPlaceholderText(optimisticTurn.output)) {
      const recoveredAnswer = extractFallbackAnswerFromTurn(optimisticTurn);
      if (recoveredAnswer) {
        optimisticTurn.output = recoveredAnswer;
      }
    }

    if (activeConversationId === executingConvId) {
      activeRunningTasks = extractRunningTasksFromDecisions(rawDecisions);
      renderRunningTasks();

      const summaryBanner = document.getElementById("activity-summary-banner");
      const summaryText = document.getElementById("activity-summary-text");
      if (summaryBanner && summaryText) {
        if (activeRunningTasks.length > 0) {
          summaryBanner.style.display = "flex";
          summaryText.innerText = `Running task: ${activeRunningTasks[0].name}`;
        } else {
          summaryBanner.style.display = "none";
        }
      }
    }

    // If backend returned updated full conversation, adopt it without wiping locally streamed steps or output
    if (res.conversation && Array.isArray(res.conversation.turns) && res.conversation.turns.length > 0) {
      const curConv = appConversations.find(c => c.id === executingConvId);
      if (curConv) {
        const lastBackendTurn = res.conversation.turns[res.conversation.turns.length - 1];
        if (lastBackendTurn && optimisticTurn) {
          if ((!lastBackendTurn.output || isGenericPlaceholderText(lastBackendTurn.output)) && optimisticTurn.output && !isGenericPlaceholderText(optimisticTurn.output)) {
            lastBackendTurn.output = optimisticTurn.output;
          } else if (!lastBackendTurn.output && optimisticTurn.output) {
            lastBackendTurn.output = optimisticTurn.output;
          }
          if (optimisticTurn.raw_output && !lastBackendTurn.raw_output) {
            lastBackendTurn.raw_output = optimisticTurn.raw_output;
          }
          if (optimisticTurn.raw_json && !lastBackendTurn.raw_json) {
            lastBackendTurn.raw_json = optimisticTurn.raw_json;
          }
          if (optimisticTurn.decisions && (!lastBackendTurn.decisions || lastBackendTurn.decisions.length === 0)) {
            lastBackendTurn.decisions = optimisticTurn.decisions;
          }
          if (optimisticTurn.workflow_execution && !lastBackendTurn.workflow_execution) {
            lastBackendTurn.workflow_execution = optimisticTurn.workflow_execution;
          }
          if ((!lastBackendTurn.steps || lastBackendTurn.steps.length === 0) && (optimisticTurn.steps && optimisticTurn.steps.length > 0)) {
            lastBackendTurn.steps = optimisticTurn.steps;
          }
          if (optimisticTurn.changed_files && (!lastBackendTurn.changed_files || !lastBackendTurn.changed_files.total_files)) {
            lastBackendTurn.changed_files = optimisticTurn.changed_files;
          }
          if (optimisticTurn.thoughtTurnTimings) {
            lastBackendTurn.thoughtTurnTimings = optimisticTurn.thoughtTurnTimings;
          }
          if (Array.isArray(lastBackendTurn.steps) && Array.isArray(optimisticTurn.steps)) {
            const optThought = optimisticTurn.steps.find(s => s && s.type === "thought");
            const backThought = lastBackendTurn.steps.find(s => s && s.type === "thought");
            if (optThought && backThought) {
              if (optThought.detail && optThought.detail.includes("[Turn ") && !String(backThought.detail || "").includes("[Turn ")) {
                backThought.detail = optThought.detail;
              }
              backThought.turnTimings = backThought.turnTimings || optThought.turnTimings;
            } else if (optThought && !backThought) {
              lastBackendTurn.steps.unshift(optThought);
            }
          }
          finalizeTurnLiveThoughts(lastBackendTurn);
          if (isGenericPlaceholderText(lastBackendTurn.output)) {
            const recoveredBackendAnswer = extractFallbackAnswerFromTurn(lastBackendTurn);
            if (recoveredBackendAnswer) {
              lastBackendTurn.output = recoveredBackendAnswer;
            }
          }
          if (optimisticTurn.status === "interrupted") {
            lastBackendTurn.status = "interrupted";
            lastBackendTurn.error_type = "user_cancelled";
          }
          if (selectedModel) {
            lastBackendTurn.model = selectedModel;
            if (lastBackendTurn.debug_info && typeof lastBackendTurn.debug_info === "object") {
              lastBackendTurn.debug_info.ui_model = selectedModel;
            }
          }
        }
        const incomingTurns = typeof deduplicateConversationTurns === "function"
          ? deduplicateConversationTurns(res.conversation.turns)
          : res.conversation.turns;
        curConv.turns = incomingTurns;
        if (selectedModel) curConv.model = selectedModel;
        if (res.conversation.title) curConv.title = res.conversation.title;
      }
    }

    if (activeConversationId !== executingConvId && typeof markConversationUnread === "function") {
      markConversationUnread(executingConvId);
    }

    renderProjectTree();
    await saveStoredConversations();
    if (activeConversationId === executingConvId) {
      renderActiveConversation();
    }
    if (typeof loadRightSidebarOverview === "function") {
      loadRightSidebarOverview();
    }

    const curConvObj = appConversations.find(c => c.id === executingConvId);
    addExecutionHistory({
      prompt: optimisticTurn.prompt,
      output: optimisticTurn.output,
      timestamp: optimisticTurn.timestamp,
      duration: optimisticTurn.duration,
      status: optimisticTurn.status,
      conversation_id: executingConvId,
      conversation_title: curConvObj ? curConvObj.title : (optimisticTurn.prompt.split("\n")[0].substring(0, 36))
    });
  } catch (err) {
    clearInterval(liveTimer);
    if (activeConversationId === executingConvId) {
      activeRunningTasks = [];
      renderRunningTasks();
      if (btnStop) btnStop.style.display = "none";
      if (btnSend) btnSend.style.display = "flex";
    }

    const elapsed = Math.max(1, Math.round((Date.now() - startTime) / 1000));
    optimisticTurn.duration = `${elapsed}s`;

    const isUserStopped = optimisticTurn.status === "interrupted" ||
      optimisticTurn.wasUserStopped ||
      (err && (err.name === "AbortError" || (err.message && err.message.toLowerCase().includes("abort")))) ||
      !isPromptExecuting;

    if (isUserStopped) {
      optimisticTurn.status = "interrupted";
      optimisticTurn.error = "Generation stopped by user";
      optimisticTurn.error_type = "user_cancelled";
      optimisticTurn.phase = "Stopped by user";
      finalizeTurnLiveThoughts(optimisticTurn, "Thought (stopped)");
    } else {
      let rawMsg = (err && (err.message || err.toString())) || "Execution error";
      if (rawMsg.includes("Failed to fetch")) {
        rawMsg = "Connection to agent bridge was lost (failed to fetch). Ensure Shuffle Agent is running.";
      }
      optimisticTurn.status = "error";
      optimisticTurn.error = rawMsg;
      optimisticTurn.error_type = "execution_error";
      finalizeTurnLiveThoughts(optimisticTurn);
    }

    renderProjectTree();
    await saveStoredConversations();
    if (activeConversationId === executingConvId) {
      renderActiveConversation();
    }
    if (typeof loadRightSidebarOverview === "function") {
      loadRightSidebarOverview();
    }

    const curConvObj = appConversations.find(c => c.id === executingConvId);
    addExecutionHistory({
      prompt: optimisticTurn.prompt,
      output: optimisticTurn.output,
      timestamp: optimisticTurn.timestamp,
      duration: optimisticTurn.duration,
      status: optimisticTurn.status,
      conversation_id: executingConvId,
      conversation_title: curConvObj ? curConvObj.title : (optimisticTurn.prompt.split("\n")[0].substring(0, 36))
    });
  } finally {
    isPromptExecuting = false;
    runningConversationId = null;
    if (typeof window !== "undefined") {
      window.isPromptExecuting = false;
      window.runningConversationId = null;
    }
    currentPromptAbortController = null;
    currentPromptExecutingTurn = null;
    clearInterval(liveTimer);
    activeRunningTasks = [];
    if (Array.isArray(globalApprovalQueue) && globalApprovalQueue.length > 0) {
      globalApprovalQueue = globalApprovalQueue.filter(q => q.conversation_id && q.conversation_id !== executingConvId);
      if (typeof syncGlobalApprovalQueueUI === "function") {
        syncGlobalApprovalQueueUI();
      }
    }
    renderRunningTasks();
    renderProjectTree();
    if (typeof renderActiveConversation === "function") {
      renderActiveConversation();
    }

    if (promptMessageQueue.length > 0) {
      setTimeout(() => {
        processNextInQueue();
      }, 350);
    }
  }
}

function stopExecution(targetConvId) {
  const convIdToStop = targetConvId || runningConversationId || activeConversationId;
  if (targetConvId && runningConversationId && targetConvId !== runningConversationId) {
    return;
  }
  if (!isPromptExecuting && !currentPromptExecutingTurn) return;
  isPromptExecuting = false;
  runningConversationId = null;
  if (typeof window !== "undefined") {
    window.isPromptExecuting = false;
    window.runningConversationId = null;
  }

  if (currentPromptAbortController) {
    try {
      currentPromptAbortController.abort();
    } catch (e) {}
    currentPromptAbortController = null;
  }

  // Immediately signal backend to cancel active prompt generation
  if (typeof callGo === "function") {
    try {
      callGo("stopExecution", JSON.stringify({ conversation_id: convIdToStop || "" }));
    } catch (e) {}
  } else if (typeof window.bridgeCall === "function") {
    try {
      window.bridgeCall("stopExecution", JSON.stringify({ conversation_id: convIdToStop || "" }));
    } catch (e) {}
  }

  if (currentPromptExecutingTurn) {
    const turn = currentPromptExecutingTurn;
    turn.wasUserStopped = true;
    turn.status = "interrupted";
    turn.error = "Generation stopped by user";
    turn.error_type = "user_cancelled";
    turn.phase = "Stopped by user";
    finalizeTurnLiveThoughts(turn, "Thought (stopped)");
  }

  if (Array.isArray(globalApprovalQueue) && globalApprovalQueue.length > 0) {
    globalApprovalQueue = globalApprovalQueue.filter(q => q.conversation_id && q.conversation_id !== convIdToStop);
    if (typeof syncGlobalApprovalQueueUI === "function") {
      syncGlobalApprovalQueueUI();
    }
  }

  const curBtnStop = document.getElementById("btn-stop-execution");
  const curBtnSend = document.getElementById("btn-send");
  if (curBtnStop) curBtnStop.style.display = "none";
  if (curBtnSend) curBtnSend.style.display = "flex";

  renderProjectTree();
  renderActiveConversation();
  saveStoredConversations();
  showToast("Execution stopped");
}

function toggleResultCard(pillEl) {
  pillEl.classList.toggle("collapsed");
  const wrapper = pillEl.parentElement;
  if (!wrapper) return;
  const card = wrapper.querySelector(".exec-card");
  if (card) {
    card.classList.toggle("collapsed");
  }
}

async function copyCardOutput(btnEl) {
  const card = btnEl.closest(".exec-card");
  if (!card) return;
  const body = card.querySelector(".exec-body");
  if (!body) return;
  try {
    await navigator.clipboard.writeText(body.innerText);
    showToast("Copied output to clipboard");
  } catch (err) {
    console.error("Copy failed:", err);
  }
}

function retryPrompt(promptText) {
  if (!promptText) return;
  const textarea = document.getElementById("prompt-input");
  if (textarea) {
    textarea.value = promptText;
    handleInput(textarea);
    textarea.focus();
  }
  submitPrompt();
}

function retryCardPrompt(btnEl) {
  const card = btnEl.closest(".exec-card") || btnEl.closest(".transcript-turn");
  let promptText = "";
  if (card) {
    const promptEl = card.querySelector(".user-command-text") || card.querySelector(".exec-prompt") || card.querySelector(".user-turn-bubble");
    if (promptEl) {
      promptText = promptEl.innerText.replace(/^\$\s*/, "").trim();
    }
  }
  if (!promptText && activeConversationId) {
    const conv = appConversations.find(c => c.id === activeConversationId);
    if (conv && conv.turns && conv.turns.length > 0) {
      promptText = conv.turns[conv.turns.length - 1].prompt;
    }
  }
  if (promptText) {
    retryPrompt(promptText);
  }
}

function renderMarkdown(raw) {
  if (!raw) return '<div class="md-p">Completed with no output.</div>';

  // Normalize CRLF/CR line endings first so block and list parsing is consistent across OSes
  let processed = String(raw).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // 1. Extract fenced code blocks first so inner content is preserved and not altered
  const codeBlocks = [];
  processed = processed.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: (lang || "").trim(), code: code.trim() });
    return `\n@@CODEBLOCK:${idx}@@\n`;
  });

  // Helper to format inline markdown safely
  function renderInline(text) {
    let str = escapeHtml(text);

    // Handle markdown links pointing to files before inline code extraction if label is wrapped in backticks: [`file.go`](file:///...)
    const inlineCodes = [];
    str = str.replace(/\[`?([^\]`\n]+)`?\]\((?:file:\/\/\/?([^)\s]+)|([a-zA-Z0-9_\-./\\]+?\.[a-zA-Z0-9_\-]{1,16}(?:#L[\d\-]+)?))\)/g, (match, label, fileUriPath, relFilePath) => {
      const idx = inlineCodes.length;
      const rawTarget = (fileUriPath || relFilePath || label || "").replace(/#L[\d\-]+$/i, "").trim();
      const cleanLabel = label.trim();
      inlineCodes.push(`<span class="md-file-pill" onclick="previewFileInSidebar('${escapeJsAttr(rawTarget)}')" title="Open ${rawTarget}">${cleanLabel}</span>`);
      return `@@INLINECODE:${idx}@@`;
    });

    // Extract inline code spans first so underscores/asterisks inside backticks are never mangled
    str = str.replace(/`([^`\n]+)`/g, (match, code) => {
      const idx = inlineCodes.length;
      const trimmed = code.trim();
      let replacement = "";

      // Shell commands: starts with $ 
      if (trimmed.startsWith("$ ")) {
        const cmdText = trimmed.replace(/^\$\s*/, "");
        replacement = `<code class="md-cmd-pill" onclick="copySnippetText(this)" title="Click to copy command"><span class="md-cmd-prefix">$</span><span class="md-cmd-name">${cmdText}</span></code>`;
      } else {
        // Language prefix + file path: e.g. `js pkg/ui/src/js/chat.js` or `</> pkg/ui/index.html`
        const langBadgeMatch = trimmed.match(/^(js|html|css|go|py|ts|sh|json|md|&lt;\/&gt;|<\/>)\s+([a-zA-Z0-9_\-\./\\]+)$/i);
        if (langBadgeMatch) {
          const filePath = langBadgeMatch[2];
          replacement = `<span class="md-file-pill" onclick="previewFileInSidebar('${escapeJsAttr(filePath)}')" title="Open ${filePath}">${filePath}</span>`;
        } else {
          // Standalone file paths:
          // 1) Standard files with extensions (e.g. ai.go, go.mod, pkg/ui/src/js/chat.js, .github/workflows/ci.yml)
          // 2) Dotfiles (e.g. .gitignore, .env, .dockerignore, .editorconfig, .gitattributes)
          // 3) Standard extensionless files (e.g. LICENSE, Makefile, Dockerfile, README, CHANGELOG, CODEOWNERS)
          const isDirectory = trimmed.endsWith("/") || trimmed.endsWith("\\") || trimmed === "." || trimmed === "..";
          const extFileMatch = !isDirectory && trimmed.match(/^((?:[a-zA-Z]:[/\\])?[a-zA-Z0-9_\-./\\]+?\.([a-zA-Z0-9_\-]{1,16}))(?::\d+(?::\d+)?)?$/);
          const dotFileMatch = !isDirectory && trimmed.match(/^((?:[a-zA-Z]:[/\\])?(?:[a-zA-Z0-9_\-./\\]*[/\\])?\.([a-zA-Z0-9_\-][a-zA-Z0-9_\-.]*))(?::\d+(?::\d+)?)?$/);
          const noExtFileMatch = !isDirectory && trimmed.match(/^((?:[a-zA-Z]:[/\\])?(?:[a-zA-Z0-9_\-./\\]*[/\\])?(LICENSE(?:-[A-Z0-9_\-]+)?|COPYING|NOTICE|PATENTS|README|CHANGELOG|CHANGES|HISTORY|CONTRIBUTING|AUTHORS|CONTRIBUTORS|CODEOWNERS|OWNERS|MAINTAINERS|SECURITY|SUPPORT|VERSION|TODO|Makefile|GNUmakefile|makefile|Dockerfile|Containerfile|Procfile|Vagrantfile|Jenkinsfile|Justfile|Caddyfile|Rakefile|Gemfile|Brewfile|Podfile|Fastfile|Appfile|WORKSPACE|BUILD|CNAME|Doxyfile|Kbuild|Kconfig|SConstruct|SConscript))(?::\d+(?::\d+)?)?$/);
          const matchedFilePath = (extFileMatch && extFileMatch[1]) || (dotFileMatch && dotFileMatch[1]) || (noExtFileMatch && noExtFileMatch[1]);
          if (matchedFilePath && !/^\.+$/.test(matchedFilePath)) {
            replacement = `<span class="md-file-pill" onclick="previewFileInSidebar('${escapeJsAttr(matchedFilePath)}')" title="Open ${matchedFilePath}">${trimmed}</span>`;
          } else {
            replacement = `<code class="md-inline-code">${code}</code>`;
          }
        }
      }

      inlineCodes.push(replacement);
      return `@@INLINECODE:${idx}@@`;
    });

    // Markdown image syntax: ![alt](url)
    str = str.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
      const cleanUrl = url.trim();
      if (/^(javascript|vbscript):/i.test(cleanUrl)) {
        return "";
      }
      const cleanAlt = (alt || cleanUrl).trim();
      return `<div class="md-inline-image-card" onclick="previewFileInSidebar('${escapeJsAttr(cleanUrl)}')" title="Click to view image in preview sidebar"><img src="${cleanUrl}" alt="${cleanAlt}" onerror="this.style.display='none'"/><span class="md-image-caption">${cleanAlt}</span></div>`;
    });

    // Bold & Italics
    str = str.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>');
    str = str.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    str = str.replace(/__(.*?)__/g, '<strong>$1</strong>');
    str = str.replace(/\*([^\*\n]+)\*/g, '<em>$1</em>');

    // Restore inline code spans
    inlineCodes.forEach((htmlSnippet, idx) => {
      str = str.replace(`@@INLINECODE:${idx}@@`, () => htmlSnippet);
    });

    return str;
  }

  // 2. Line-by-line block parser (properly groups tight & loose lists without <br> gaps)
  const lines = processed.split("\n");
  const blocks = [];
  let paraLines = [];
  let listType = null; // "ul" | "ol"
  let listItems = [];
  let blockquoteLines = [];

  function flushPara() {
    if (paraLines.length > 0) {
      blocks.push(`<p class="md-p">${paraLines.join("<br>")}</p>`);
      paraLines = [];
    }
  }

  function flushList() {
    if (listType && listItems.length > 0) {
      const cls = listType === "ol" ? "md-ol" : "md-ul";
      blocks.push(`<${listType} class="${cls}">${listItems.join("")}</${listType}>`);
      listType = null;
      listItems = [];
    }
  }

  function flushBlockquote() {
    if (blockquoteLines.length > 0) {
      blocks.push(`<blockquote class="md-blockquote">${blockquoteLines.join("<br>")}</blockquote>`);
      blockquoteLines = [];
    }
  }

  function peekNextNonEmptyLine(fromIdx) {
    for (let j = fromIdx + 1; j < lines.length; j++) {
      if (lines[j].trim() !== "") return lines[j];
    }
    return "";
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      flushPara();
      flushBlockquote();
      if (listType) {
        const nextLine = peekNextNonEmptyLine(i);
        const nextIsUl = /^\s*[-*+•]\s+/.test(nextLine);
        const nextIsOl = /^\s*\d+[\.\)]\s+/.test(nextLine);
        if (!((listType === "ul" && nextIsUl) || (listType === "ol" && nextIsOl))) {
          flushList();
        }
      }
      continue;
    }

    // Fenced code block placeholder
    if (/^@@CODEBLOCK:\d+@@$/.test(trimmed)) {
      flushPara();
      flushList();
      flushBlockquote();
      blocks.push(trimmed);
      continue;
    }

    // Horizontal rule
    if (/^(?:---|\*\*\*|___)\s*$/.test(trimmed)) {
      flushPara();
      flushList();
      flushBlockquote();
      blocks.push('<hr class="md-split-line">');
      continue;
    }

    // Markdown headings (#, ##, ###, ####)
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      flushPara();
      flushList();
      flushBlockquote();
      const level = headingMatch[1].length;
      const content = renderInline(headingMatch[2]);
      if (level === 1) {
        blocks.push(`<h1 class="md-h1">${content}</h1>`);
      } else if (level === 2) {
        blocks.push(`<h2 class="md-h2">${content}</h2>`);
      } else {
        blocks.push(`<h3 class="md-h3">${content}</h3>`);
      }
      continue;
    }

    // Blockquotes
    const bqMatch = trimmed.match(/^>\s?(.*)$/);
    if (bqMatch) {
      flushPara();
      flushList();
      blockquoteLines.push(renderInline(bqMatch[1]));
      continue;
    }

    // Unordered list items (-, *, +, •)
    const ulMatch = rawLine.match(/^(\s*)[-*+•]\s+(.*)$/);
    if (ulMatch) {
      flushPara();
      flushBlockquote();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      const isNested = ulMatch[1].replace(/\t/g, "  ").length >= 2;
      listItems.push(`<li class="md-li${isNested ? " md-li-nested" : ""}">${renderInline(ulMatch[2])}</li>`);
      continue;
    }

    // Ordered list items (1. or 1))
    const olMatch = rawLine.match(/^(\s*)(\d+)[\.\)]\s+(.*)$/);
    if (olMatch) {
      flushPara();
      flushBlockquote();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      const isNested = olMatch[1].replace(/\t/g, "  ").length >= 2;
      listItems.push(`<li class="md-oli${isNested ? " md-li-nested" : ""}" value="${olMatch[2]}">${renderInline(olMatch[3])}</li>`);
      continue;
    }

    // Indented continuation of previous list item
    if (listType && listItems.length > 0 && /^\s{2,}\S/.test(rawLine)) {
      const lastIdx = listItems.length - 1;
      listItems[lastIdx] = listItems[lastIdx].replace(/<\/li>$/, ` ${renderInline(trimmed)}</li>`);
      continue;
    }

    // Regular paragraph text
    flushList();
    flushBlockquote();
    paraLines.push(renderInline(trimmed));
  }

  flushPara();
  flushList();
  flushBlockquote();

  let html = blocks.join("\n");

  // 3. Re-inject fenced code blocks
  codeBlocks.forEach((b, idx) => {
    const langLower = String(b.lang || "").toLowerCase();
    const isPlainBlock = !langLower || langLower === "text" || langLower === "plaintext" || langLower === "txt" || langLower === "code" || langLower === "output";
    const isJsonSnippet = langLower === "json" || langLower === "jsonc";
    const highlightedCode = String(b.code || "")
      .split("\n")
      .map(line => highlightCodeLine(line, langLower, isJsonSnippet, null))
      .join("\n");
    const displayLang = isPlainBlock ? "" : b.lang;
    const blockHtml = `
      <div class="code-block-box">
        <div class="code-block-bar">
          <span class="code-block-lang">${escapeHtml(displayLang)}</span>
          <button type="button" class="btn-copy-code" onclick="copyCodeSnippet(this)" title="Copy Code">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            <span>Copy</span>
          </button>
        </div>
        <pre class="code-block-pre"><code>${highlightedCode}</code></pre>
      </div>
    `;
    html = html.replace(`@@CODEBLOCK:${idx}@@`, () => blockHtml);
  });

  return `<div class="markdown-rendered-body">${html}</div>`;
}

async function copyCodeSnippet(btn) {
  const box = btn.closest(".code-block-box");
  if (!box) return;
  const codeEl = box.querySelector("code");
  if (!codeEl) return;
  try {
    await navigator.clipboard.writeText(codeEl.innerText);
    const span = btn.querySelector("span");
    if (span) {
      const orig = span.innerText;
      span.innerText = "Copied!";
      setTimeout(() => { span.innerText = orig; }, 2000);
    }
  } catch (err) {
    console.error("Failed to copy code snippet:", err);
  }
}

let currentPreviewPath = "";
let currentPreviewContentText = "";
let currentRightTab = "overview";
let rsFilesExpanded = false;
let rsFilesCache = [];

// Built-in File & JSON Editor State
let builtinEditorWrapLines = true;
let builtinEditorDeepParseJson = true;
let activeRawOutputMode = "json"; // "json" | "stream" | "steps"
let builtinEditorInstances = {};

function detectLanguageFromPath(filePath, rawContent) {
  const clean = String(filePath || "").toLowerCase();
  const ext = (clean.split(".").pop() || "").trim();
  const map = {
    json: "json",
    jsonl: "json",
    go: "go",
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    ps1: "powershell",
    html: "html",
    htm: "html",
    css: "css",
    md: "markdown",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sql: "sql",
    rs: "rust",
    c: "c",
    h: "c",
    cpp: "cpp"
  };
  if (map[ext]) return map[ext];
  const trimmed = String(rawContent || "").trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch (e) {}
  }
  return ext || "text";
}

function deepParseEmbeddedJson(val, depth) {
  const curDepth = typeof depth === "number" ? depth : 0;
  if (curDepth > 6 || val === null || val === undefined) return val;
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") {
          return deepParseEmbeddedJson(parsed, curDepth + 1);
        }
      } catch (e) {}
    }
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(item => deepParseEmbeddedJson(item, curDepth + 1));
  }
  if (typeof val === "object") {
    const out = {};
    for (const k of Object.keys(val)) {
      out[k] = deepParseEmbeddedJson(val[k], curDepth + 1);
    }
    return out;
  }
  return val;
}

function tryFormatAndParseJsonContent(rawContent, deepParse) {
  const str = String(rawContent || "").trim();
  if (!str) return { isJson: false, text: String(rawContent || "") };
  try {
    let parsed = JSON.parse(str);
    if (deepParse) {
      parsed = deepParseEmbeddedJson(parsed, 0);
    }
    return {
      isJson: true,
      parsed: parsed,
      text: JSON.stringify(parsed, null, 2)
    };
  } catch (e) {
    const rawLines = str.split("\n").map(l => l.trim()).filter(Boolean);
    if (rawLines.length > 1 && rawLines.every(l => l.startsWith("{") && l.endsWith("}"))) {
      try {
        const arr = rawLines.map(l => {
          const p = JSON.parse(l);
          return deepParse ? deepParseEmbeddedJson(p, 0) : p;
        });
        return {
          isJson: true,
          parsed: arr,
          text: JSON.stringify(arr, null, 2)
        };
      } catch (err2) {}
    }
    return { isJson: false, text: String(rawContent || "") };
  }
}

function computeEditorFoldMap(lines, isJson) {
  const foldMap = {};
  const stack = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let inStr = false;
    let strChar = "";
    let escaped = false;

    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        if (inStr) escaped = true;
        continue;
      }
      if (inStr) {
        if (ch === strChar) inStr = false;
        continue;
      }
      if (!isJson && ch === "/" && line[c + 1] === "/") {
        break;
      }
      if (ch === '"' || (!isJson && (ch === "'" || ch === "`"))) {
        inStr = true;
        strChar = ch;
        continue;
      }
      if (ch === "{" || ch === "[") {
        stack.push({ char: ch, line: i, childCount: 0, hasContent: false });
      } else if (ch === "}" || ch === "]") {
        const expected = ch === "}" ? "{" : "[";
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s].char === expected) {
            const top = stack.splice(s, 1)[0];
            if (i > top.line) {
              const spanLines = i - top.line - 1;
              let label = "";
              if (isJson) {
                const count = top.childCount > 0 ? top.childCount : (top.hasContent ? 1 : 0);
                if (top.char === "{") {
                  label = `⋯ ${count} ${count === 1 ? "key" : "keys"} }`;
                } else {
                  label = `⋯ ${count} ${count === 1 ? "item" : "items"} ]`;
                }
              } else {
                label = `⋯ ${spanLines} ${spanLines === 1 ? "line" : "lines"} ${ch}`;
              }
              foldMap[top.line] = {
                startLine: top.line,
                endLine: i,
                openChar: top.char,
                closeChar: ch,
                label: label
              };
            }
            if (stack.length > 0) {
              stack[stack.length - 1].hasContent = true;
            }
            break;
          }
        }
      } else if (stack.length > 0) {
        const curTop = stack[stack.length - 1];
        if (ch === "," && i >= curTop.line) {
          curTop.childCount++;
        } else if (ch !== " " && ch !== "\t" && ch !== "\r") {
          curTop.hasContent = true;
        }
      }
    }
  }

  if (isJson) {
    for (const k of Object.keys(foldMap)) {
      const entry = foldMap[k];
      let directEntries = 0;
      const baseIndentMatch = lines[entry.startLine].match(/^(\s*)/);
      const childIndentLen = (baseIndentMatch ? baseIndentMatch[1].length : 0) + 2;
      for (let l = entry.startLine + 1; l < entry.endLine; l++) {
        const ln = lines[l];
        const m = ln.match(/^(\s*)(\S)/);
        if (m && m[1].length === childIndentLen && m[2] !== "}" && m[2] !== "]") {
          directEntries++;
        }
      }
      if (directEntries > 0) {
        if (entry.openChar === "{") {
          entry.label = `⋯ ${directEntries} ${directEntries === 1 ? "key" : "keys"} }`;
        } else {
          entry.label = `⋯ ${directEntries} ${directEntries === 1 ? "item" : "items"} ]`;
        }
      }
    }
  }

  return foldMap;
}

const CODE_KEYWORDS_SET = new Set([
  "func", "package", "import", "return", "var", "const", "let", "type", "struct",
  "interface", "if", "else", "for", "range", "switch", "case", "default", "break",
  "continue", "go", "defer", "select", "chan", "map", "fallthrough", "function",
  "async", "await", "class", "extends", "new", "try", "catch", "finally", "throw",
  "typeof", "instanceof", "in", "of", "export", "from", "def", "elif", "except",
  "lambda", "with", "as", "pass", "yield", "raise", "pub", "fn", "impl", "use",
  "mod", "match", "mut", "where", "trait", "enum"
]);

const CODE_LITERALS_SET = new Set([
  "true", "false", "null", "nil", "undefined", "None", "True", "False", "iota"
]);

const CODE_TYPES_SET = new Set([
  "string", "int", "int64", "int32", "uint", "uint64", "float64", "float32",
  "bool", "byte", "rune", "error", "any", "void", "number", "boolean", "object",
  "Promise", "Array", "Map", "Set", "Context"
]);

function highlightJsonLine(line, multilineStore, editorId, lineIdx) {
  const keyMatch = line.match(/^(\s*)("(?:[^"\\]|\\.)*")(\s*:\s*)(.*)$/);
  if (keyMatch) {
    const indent = escapeHtml(keyMatch[1]);
    const keyHtml = `<span class="tok-key">${escapeHtml(keyMatch[2])}</span>`;
    const colonHtml = `<span class="tok-punc">${escapeHtml(keyMatch[3])}</span>`;
    const valHtml = highlightJsonValuePart(keyMatch[4], multilineStore, editorId, lineIdx);
    return `${indent}${keyHtml}${colonHtml}${valHtml}`;
  }
  const indentMatch = line.match(/^(\s*)(.*)$/);
  const indent = escapeHtml(indentMatch ? indentMatch[1] : "");
  const rest = indentMatch ? indentMatch[2] : line;
  return `${indent}${highlightJsonValuePart(rest, multilineStore, editorId, lineIdx)}`;
}

function highlightJsonValuePart(rest, multilineStore, editorId, lineIdx) {
  if (!rest) return "";
  const trimmed = rest.trim();
  if (!trimmed) return escapeHtml(rest);

  if (/^[{\[\]},]+$/.test(trimmed)) {
    return `<span class="tok-punc">${escapeHtml(rest)}</span>`;
  }

  const strMatch = rest.match(/^("(?:[^"\\]|\\.)*")(\s*,?\s*)$/);
  if (strMatch) {
    const rawLiteral = strMatch[1];
    const trailing = strMatch[2] || "";
    let expandBtnHtml = "";
    let expandBoxHtml = "";

    if (multilineStore && editorId && (rawLiteral.includes("\\n") || rawLiteral.length > 180)) {
      try {
        const decoded = JSON.parse(rawLiteral);
        if (typeof decoded === "string" && (decoded.includes("\n") || decoded.length > 180)) {
          const mlId = `${editorId}-ml-${lineIdx}`;
          const lineCount = decoded.split("\n").length;
          const badgeText = lineCount > 1 ? `⤢ ${lineCount} lines` : `⤢ ${decoded.length} chars`;
          expandBtnHtml = `<span class="code-str-expand-btn" onclick="toggleEditorMultilineString('${mlId}', this, event)" title="Expand formatted text">${badgeText}</span>`;
          expandBoxHtml = `<div id="${mlId}" class="code-multiline-str-box">${escapeHtml(decoded)}</div>`;
        }
      } catch (e) {}
    }

    const displayLiteral = rawLiteral.length > 260 && expandBtnHtml
      ? escapeHtml(rawLiteral.slice(0, 260) + '..."')
      : escapeHtml(rawLiteral);

    return `<span class="tok-str">${displayLiteral}</span>${trailing ? `<span class="tok-punc">${escapeHtml(trailing)}</span>` : ""}${expandBtnHtml}${expandBoxHtml}`;
  }

  const numMatch = rest.match(/^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(\s*,?\s*)$/);
  if (numMatch) {
    return `<span class="tok-num">${escapeHtml(numMatch[1])}</span>${numMatch[2] ? `<span class="tok-punc">${escapeHtml(numMatch[2])}</span>` : ""}`;
  }

  const litMatch = rest.match(/^(true|false|null)(\s*,?\s*)$/);
  if (litMatch) {
    const cls = litMatch[1] === "null" ? "tok-null" : "tok-bool";
    return `<span class="${cls}">${escapeHtml(litMatch[1])}</span>${litMatch[2] ? `<span class="tok-punc">${escapeHtml(litMatch[2])}</span>` : ""}`;
  }

  return escapeHtml(rest);
}

function highlightCodeLine(line, lang, isJson, multilineContext) {
  if (!line) return "";
  const normLang = String(lang || "").trim().toLowerCase();
  if (isJson || normLang === "json" || normLang === "jsonl") {
    return highlightJsonLine(
      line,
      multilineContext ? multilineContext.store : null,
      multilineContext ? multilineContext.editorId : null,
      multilineContext ? multilineContext.lineIdx : 0
    );
  }

  if (
    !normLang ||
    normLang === "text" ||
    normLang === "txt" ||
    normLang === "plaintext" ||
    normLang === "plain" ||
    normLang === "output" ||
    normLang === "log" ||
    normLang === "logs" ||
    normLang === "markdown" ||
    normLang === "md" ||
    normLang === "raw" ||
    normLang === "quote" ||
    normLang === "code"
  ) {
    return escapeHtml(line);
  }

  const isShell =
    normLang === "bash" ||
    normLang === "sh" ||
    normLang === "zsh" ||
    normLang === "shell" ||
    normLang === "console" ||
    normLang === "terminal" ||
    normLang === "powershell" ||
    normLang === "ps1" ||
    normLang === "pwsh" ||
    normLang === "cmd" ||
    normLang === "bat" ||
    normLang === "batch";

  let out = "";
  let i = 0;
  const n = line.length;

  while (i < n) {
    const ch = line[i];

    if (
      (!isShell && ch === "/" && line[i + 1] === "/") ||
      (ch === "#" &&
        (i === 0 || /\s/.test(line[i - 1])) &&
        (isShell || normLang === "python" || normLang === "py" || normLang === "yaml" || normLang === "yml" || normLang === "toml"))
    ) {
      out += `<span class="tok-comment">${escapeHtml(line.slice(i))}</span>`;
      break;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      // Avoid treating apostrophes inside words (e.g. don't, user's) as string literals
      const isMidWordApostrophe = ch === "'" && i > 0 && /[a-zA-Z0-9]/.test(line[i - 1]);
      if (!isMidWordApostrophe) {
        const quote = ch;
        let j = i + 1;
        let closed = false;
        while (j < n) {
          if (line[j] === "\\") {
            j += 2;
            continue;
          }
          if (line[j] === quote) {
            j++;
            closed = true;
            break;
          }
          j++;
        }
        if (closed) {
          out += `<span class="tok-str">${escapeHtml(line.slice(i, j))}</span>`;
          i = j;
          continue;
        }
      }
    }

    if (!isShell && /[0-9]/.test(ch) && (i === 0 || !/[a-zA-Z0-9_$]/.test(line[i - 1]))) {
      let j = i;
      while (j < n && /[0-9a-fA-FxXoObB._]/.test(line[j])) j++;
      out += `<span class="tok-num">${escapeHtml(line.slice(i, j))}</span>`;
      i = j;
      continue;
    }

    if (/[a-zA-Z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_$]/.test(line[j])) j++;
      const word = line.slice(i, j);
      const nextChar = line[j] || "";
      if (!isShell) {
        if (CODE_KEYWORDS_SET.has(word)) {
          out += `<span class="tok-kw">${escapeHtml(word)}</span>`;
        } else if (CODE_LITERALS_SET.has(word)) {
          out += `<span class="tok-bool">${escapeHtml(word)}</span>`;
        } else if (CODE_TYPES_SET.has(word)) {
          out += `<span class="tok-type">${escapeHtml(word)}</span>`;
        } else if (nextChar === "(") {
          out += `<span class="tok-fn">${escapeHtml(word)}</span>`;
        } else {
          out += escapeHtml(word);
        }
      } else {
        out += escapeHtml(word);
      }
      i = j;
      continue;
    }

    if (!isShell && /[{}[\]().,:;]/.test(ch)) {
      out += `<span class="tok-punc">${escapeHtml(ch)}</span>`;
      i++;
      continue;
    }

    out += escapeHtml(ch);
    i++;
  }

  return out;
}

function renderBuiltinCodeEditor(rawContent, opts) {
  const options = opts || {};
  const editorId = options.editorId || "builtin-main-editor";
  const filePath = options.filePath || "";
  const detectedLang = options.lang || detectLanguageFromPath(filePath, rawContent);

  let isJson = detectedLang === "json" || detectedLang === "jsonl" || Boolean(options.forceJson);
  let displayContent = String(rawContent || "");

  if (isJson || detectedLang === "text") {
    const parsedAttempt = tryFormatAndParseJsonContent(displayContent, builtinEditorDeepParseJson);
    if (parsedAttempt.isJson) {
      isJson = true;
      displayContent = parsedAttempt.text;
    } else if (options.forceJson) {
      isJson = false;
    }
  }

  const lines = displayContent.split("\n");
  const foldMap = computeEditorFoldMap(lines, isJson);
  const hasFoldableBlocks = Object.keys(foldMap).length > 0;

  builtinEditorInstances[editorId] = {
    editorId: editorId,
    rawContent: String(rawContent || ""),
    displayContent: displayContent,
    filePath: filePath,
    lang: isJson ? "json" : detectedLang,
    isJson: isJson,
    lines: lines,
    foldMap: foldMap,
    foldedStarts: new Set(),
    options: options
  };

  if (!options.keepCopyBuffer) {
    currentPreviewContentText = displayContent;
  }

  const multilineStore = {};
  let linesHtml = "";
  for (let i = 0; i < lines.length; i++) {
    const foldInfo = foldMap[i];
    const gutterBtn = foldInfo
      ? `<span class="code-fold-btn" data-fold-btn="${i}" onclick="toggleEditorFold('${editorId}', ${i}, event)" title="Fold/Unfold block">▾</span>`
      : `<span class="code-fold-spacer"></span>`;
    const placeholderHtml = foldInfo
      ? `<span class="code-fold-placeholder" onclick="toggleEditorFold('${editorId}', ${i}, event)" title="Click to expand">${escapeHtml(foldInfo.label)}</span>`
      : "";
    const codeHtml = highlightCodeLine(lines[i], isJson ? "json" : detectedLang, isJson, {
      store: multilineStore,
      editorId: editorId,
      lineIdx: i
    });

    linesHtml += `<div class="code-editor-line" data-line="${i}"><div class="code-line-gutter"><span class="code-line-num">${i + 1}</span>${gutterBtn}</div><div class="code-line-code">${codeHtml}${placeholderHtml}</div></div>`;
  }

  const langLabel = isJson ? "JSON" : (detectedLang || "TEXT").toUpperCase();
  const deepParseBtn = isJson
    ? `<button type="button" class="builtin-editor-tool-btn${builtinEditorDeepParseJson ? " active" : ""}" onclick="toggleEditorDeepParse('${editorId}')" title="Automatically unpack nested JSON strings">${builtinEditorDeepParseJson ? "✓ Deep Parse" : "Deep Parse"}</button>`
    : "";
  const foldBtns = hasFoldableBlocks
    ? `
      <button type="button" class="builtin-editor-tool-btn" onclick="expandAllEditorFolds('${editorId}')" title="Expand all blocks">Expand All</button>
      <button type="button" class="builtin-editor-tool-btn" onclick="collapseAllEditorFolds('${editorId}')" title="Collapse top-level blocks">Collapse All</button>
    `
    : "";

  return `
    <div id="${editorId}" class="builtin-editor-container${builtinEditorWrapLines ? " wrap-lines" : ""}">
      <div class="builtin-editor-toolbar">
        <div class="builtin-editor-toolbar-left">
          <span class="builtin-editor-lang-tag">${escapeHtml(langLabel)}</span>
          <span>• ${lines.length} ${lines.length === 1 ? "line" : "lines"}</span>
          ${deepParseBtn}
        </div>
        <div class="builtin-editor-toolbar-right">
          ${foldBtns}
          <button type="button" class="builtin-editor-tool-btn${builtinEditorWrapLines ? " active" : ""}" onclick="toggleEditorWordWrap('${editorId}')" title="Toggle word wrap">Wrap</button>
        </div>
      </div>
      <div class="builtin-editor-lines">${linesHtml}</div>
    </div>
  `;
}

function applyEditorFoldVisibility(editorId) {
  const inst = builtinEditorInstances[editorId];
  if (!inst) return;
  const container = document.getElementById(editorId);
  if (!container) return;

  const hiddenLines = new Set();
  inst.foldedStarts.forEach(startLine => {
    const info = inst.foldMap[startLine];
    if (info) {
      for (let l = info.startLine + 1; l <= info.endLine; l++) {
        hiddenLines.add(l);
      }
    }
  });

  const lineEls = container.querySelectorAll(".code-editor-line");
  lineEls.forEach(el => {
    const lineIdx = parseInt(el.getAttribute("data-line"), 10);
    const isFoldRoot = inst.foldedStarts.has(lineIdx);
    el.classList.toggle("is-folded", isFoldRoot);
    const btn = el.querySelector(".code-fold-btn");
    if (btn) {
      btn.textContent = isFoldRoot ? "▸" : "▾";
    }
    if (hiddenLines.has(lineIdx)) {
      el.style.display = "none";
    } else {
      el.style.display = "flex";
    }
  });
}

function toggleEditorFold(editorId, startLine, event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  const inst = builtinEditorInstances[editorId];
  if (!inst || !inst.foldMap[startLine]) return;
  if (inst.foldedStarts.has(startLine)) {
    inst.foldedStarts.delete(startLine);
  } else {
    inst.foldedStarts.add(startLine);
  }
  applyEditorFoldVisibility(editorId);
}

function expandAllEditorFolds(editorId) {
  const inst = builtinEditorInstances[editorId];
  if (!inst) return;
  inst.foldedStarts.clear();
  applyEditorFoldVisibility(editorId);
}

function collapseAllEditorFolds(editorId) {
  const inst = builtinEditorInstances[editorId];
  if (!inst) return;
  inst.foldedStarts.clear();
  const foldKeys = Object.keys(inst.foldMap).map(k => parseInt(k, 10)).sort((a, b) => a - b);
  foldKeys.forEach(lineIdx => {
    if (lineIdx > 0 || foldKeys.length === 1) {
      inst.foldedStarts.add(lineIdx);
    }
  });
  applyEditorFoldVisibility(editorId);
}

function toggleEditorWordWrap(editorId) {
  builtinEditorWrapLines = !builtinEditorWrapLines;
  const container = document.getElementById(editorId);
  if (container) {
    container.classList.toggle("wrap-lines", builtinEditorWrapLines);
    const btns = container.querySelectorAll(".builtin-editor-tool-btn");
    btns.forEach(b => {
      if (b.textContent.trim() === "Wrap") {
        b.classList.toggle("active", builtinEditorWrapLines);
      }
    });
  }
}

function toggleEditorDeepParse(editorId) {
  builtinEditorDeepParseJson = !builtinEditorDeepParseJson;
  const inst = builtinEditorInstances[editorId];
  if (!inst) return;
  const container = document.getElementById(editorId);
  if (!container || !container.parentElement) return;
  container.outerHTML = renderBuiltinCodeEditor(inst.rawContent, inst.options);
}

function toggleEditorMultilineString(mlId, btnEl, event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  const box = document.getElementById(mlId);
  if (!box) return;
  const isOpen = box.classList.toggle("open");
  if (btnEl) {
    const cur = btnEl.textContent || "";
    btnEl.textContent = isOpen ? cur.replace("⤢", "⤡") : cur.replace("⤡", "⤢");
  }
}

function switchRawOutputViewMode(mode) {
  activeRawOutputMode = mode || "json";
  if (activeRawOutputTurnIndex !== null) {
    const curConv = (typeof activeConversationId !== "undefined" && activeConversationId && Array.isArray(appConversations))
      ? appConversations.find(c => c.id === activeConversationId)
      : null;
    const turns = (curConv && Array.isArray(curConv.turns)) ? curConv.turns : [];
    const turn = turns[activeRawOutputTurnIndex];
    if (turn) {
      renderTurnRawOutputPanel(turn, activeRawOutputTurnIndex, turns.length);
    }
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

async function previewFileInSidebar(filePath, optionalLabel) {
  if (!filePath) return;
  const sidebar = document.getElementById("preview-sidebar");
  if (!sidebar) return;

  const rawStr = String(filePath).trim();
  const isDataUri = /^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(rawStr);
  const cleanPath = isDataUri
    ? rawStr
    : rawStr.replace(/^[<> ]+/, "").split(/\s+#L|\s+#|#L/)[0].replace(/:\d+(?::\d+)?$/, "").trim();
  const fileName = isDataUri
    ? (optionalLabel || "Captured Screenshot")
    : (cleanPath.split(/[/\\]/).pop() || cleanPath);

  switchRightSidebarTab('review');
  const titleEl = document.getElementById("preview-title");
  const badgeEl = document.getElementById("preview-badge");
  const contentEl = document.getElementById("preview-sidebar-content");
  const copyBtn = document.getElementById("btn-copy-preview");

  currentPreviewPath = isDataUri ? "" : cleanPath;
  sidebar.style.display = "flex";
  const btnTopbar = document.getElementById("btn-toggle-right-sidebar");
  if (btnTopbar) {
    btnTopbar.classList.add("active");
    btnTopbar.setAttribute("title", "Contract Right Sidebar");
  }
  if (titleEl) {
    titleEl.style.display = "inline-block";
    titleEl.innerText = fileName;
  }
  if (isDataUri) {
    if (badgeEl) {
      badgeEl.style.display = "inline-block";
      badgeEl.innerText = "image/png";
    }
    if (copyBtn) copyBtn.style.display = "none";
    if (contentEl) {
      contentEl.innerHTML = `
        <div class="preview-image-wrap">
          <img class="preview-image-img" src="${cleanPath}" alt="${escapeHtml(fileName)}" />
          <div class="preview-image-meta">${escapeHtml(fileName)}</div>
        </div>
      `;
    }
    return;
  }
  if (badgeEl) {
    badgeEl.style.display = "inline-block";
    badgeEl.innerText = "Loading...";
  }
  if (contentEl) {
    contentEl.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:200px; color:var(--text-muted); font-size:12px; gap:8px;"><div class="spinner"></div> Reading ${escapeHtml(fileName)}...</div>`;
  }

  try {
    let raw = "";
    const reqPayload = JSON.stringify({ path: cleanPath, project: typeof activeProjectPath !== "undefined" ? activeProjectPath : "" });
    if (window.agentBridge && window.agentBridge.handleAction) {
      raw = await window.agentBridge.handleAction("readFilePreview", reqPayload);
    } else {
      raw = await callGo("readFilePreview", reqPayload);
    }
    const res = typeof raw === "string" ? JSON.parse(raw) : raw;

    if (res.error) {
      if (badgeEl) badgeEl.innerText = "Error";
      if (contentEl) {
        contentEl.innerHTML = `<div style="padding:24px; color:#f87171; font-size:12px; font-family:ui-monospace,monospace;">${escapeHtml(res.error)}</div>`;
      }
      return;
    }

    if (res.is_image) {
      if (badgeEl) badgeEl.innerText = `${res.mime || 'image'} • ${formatBytes(res.size)}`;
      if (copyBtn) copyBtn.style.display = "none";
      if (contentEl) {
        contentEl.innerHTML = `
          <div class="preview-image-wrap">
            <img class="preview-image-img" src="data:${res.mime};base64,${res.data}" alt="${escapeHtml(res.name)}" />
            <div class="preview-image-meta">${escapeHtml(res.full_path || res.path)}</div>
          </div>
        `;
      }
    } else {
      currentPreviewContentText = res.content || "";
      if (copyBtn) copyBtn.style.display = "inline-flex";
      if (badgeEl) badgeEl.innerText = `${res.lines || 1} lines • ${formatBytes(res.size)}`;

      if (contentEl) {
        contentEl.innerHTML = renderBuiltinCodeEditor(res.content || "", {
          editorId: "file-preview-editor",
          filePath: cleanPath
        });
      }
    }
  } catch (err) {
    if (badgeEl) badgeEl.innerText = "Error";
    if (contentEl) {
      contentEl.innerHTML = `<div style="padding:24px; color:#f87171; font-size:12px;">Failed to preview file: ${escapeHtml(err.message || String(err))}</div>`;
    }
  }
}

function closePreviewSidebar() {
  if (typeof setRightSidebarFullscreen === "function") {
    setRightSidebarFullscreen(false);
  }
  const sidebar = document.getElementById("preview-sidebar");
  if (sidebar) sidebar.style.display = "none";
  const btn = document.getElementById("btn-toggle-right-sidebar");
  if (btn) {
    btn.classList.remove("active");
    btn.setAttribute("title", "Expand Right Sidebar");
  }
}

async function copyPreviewContent() {
  if (!currentPreviewContentText) return;
  try {
    await navigator.clipboard.writeText(currentPreviewContentText);
    const btn = document.getElementById("btn-copy-preview");
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
      setTimeout(() => { btn.innerHTML = orig; }, 1500);
    }
  } catch (e) {}
}

async function copySnippetText(el) {
  if (!el) return;
  const text = el.innerText.replace(/^\$\s*/, "").trim();
  try {
    await navigator.clipboard.writeText(text);
    const origBorder = el.style.borderColor;
    el.style.borderColor = "#4ade80";
    setTimeout(() => { el.style.borderColor = origBorder; }, 1200);
  } catch (e) {}
}

// Review drawer for changed files
async function openReviewSidebar(turnIndex, focusFilePath) {
  const sidebar = document.getElementById("preview-sidebar");
  if (!sidebar) return;

  const titleEl = document.getElementById("preview-title");
  const badgeEl = document.getElementById("preview-badge");
  const contentEl = document.getElementById("preview-sidebar-content");
  const copyBtn = document.getElementById("btn-copy-preview");

  try {
    switchRightSidebarTab('review');
    if (copyBtn) copyBtn.style.display = "none";
    sidebar.style.display = "flex";
    const btnTopbar = document.getElementById("btn-toggle-right-sidebar");
    if (btnTopbar) {
      btnTopbar.classList.add("active");
      btnTopbar.setAttribute("title", "Contract Right Sidebar");
    }
    const isTurnReview = typeof turnIndex === "number";
    if (titleEl) {
      titleEl.style.display = "inline-block";
      titleEl.innerText = isTurnReview ? "Review Turn Changes" : "Review Changes";
    }
    if (badgeEl) {
      badgeEl.style.display = "inline-block";
      badgeEl.innerText = isTurnReview ? "Inspecting turn diff..." : "Loading git diff...";
    }
    if (contentEl) {
      contentEl.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:200px; color:var(--text-muted); font-size:12px; gap:8px;"><div class="spinner"></div> Checking changed files...</div>`;
    }

    let res = null;
    if (isTurnReview) {
      if (activeConversationId && Array.isArray(appConversations)) {
        const curConv = appConversations.find(c => c.id === activeConversationId);
        if (curConv && curConv.turns && curConv.turns[turnIndex]) {
          res = curConv.turns[turnIndex].changed_files;
        }
      }
    } else {
      try {
        let raw = "";
        if (window.agentBridge && window.agentBridge.handleAction) {
          raw = await window.agentBridge.handleAction("getChangedFiles", "{}");
        } else {
          raw = await callGo("getChangedFiles", "{}");
        }
        res = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch (err) {
        if (badgeEl) badgeEl.innerText = "Error";
        if (contentEl) {
          contentEl.innerHTML = `<div style="padding:24px; color:#f87171; font-size:12px;">Failed to inspect changed files: ${escapeHtml(err.message || String(err))}</div>`;
        }
        return;
      }
    }

    const files = (res && res.files) || [];
    if (files.length === 0) {
      updateReviewChangesTabVisibility();
      if (badgeEl) badgeEl.innerText = isTurnReview ? "No changes in turn" : "Working tree clean";
      if (contentEl) {
        contentEl.innerHTML = `<div style="padding:28px 20px; text-align:center; color:var(--text-muted); font-size:12px;">${isTurnReview ? "No file changes were made during this turn." : "No uncommitted git changes detected in active repository."}</div>`;
      }
      return;
    }

    const reviewBtn = document.getElementById("btn-rs-tab-review");
    if (reviewBtn) reviewBtn.style.display = "";

    if (badgeEl) {
      badgeEl.innerText = `${res.total_files} file${res.total_files > 1 ? 's' : ''} (+${res.additions || 0} -${res.deletions || 0})`;
    }

    let focusCardIdx = -1;
    let filesHtml = `<div class="review-changes-list">`;
    files.forEach((f, i) => {
      const statusClass = f.status === "added" ? "status-added" : f.status === "deleted" ? "status-deleted" : "status-modified";
      const statusText = f.status === "added" ? "A" : f.status === "deleted" ? "D" : "M";
      const langBadge = typeof getTurnFileLangBadge === "function" ? getTurnFileLangBadge(f.path) : "";
      if (focusFilePath && String(f.path) === String(focusFilePath)) {
        focusCardIdx = i;
      }

      const diffLinesHtml = typeof formatUnifiedDiffLinesHtml === "function"
        ? formatUnifiedDiffLinesHtml(f.diff || "", true)
        : "";

      filesHtml += `
        <div id="review-file-card-${i}" class="review-file-card" data-filepath="${escapeHtml(f.path || '')}">
          <div class="review-file-header" onclick="toggleFileDiff(${i})">
            <div class="review-file-left">
              <span class="review-file-status-badge ${statusClass}">${statusText}</span>
              ${langBadge ? `<span class="turn-file-lang-badge">${escapeHtml(langBadge)}</span>` : ""}
              <span class="review-file-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
            </div>
            <div class="review-file-stats">
              <span style="color:#4ade80;">+${f.additions || 0}</span>
              <span style="color:#f87171;">-${f.deletions || 0}</span>
              ${f.status !== "deleted" ? `<button type="button" class="btn-review-open-file" onclick="event.stopPropagation(); previewFileInSidebar('${escapeJsAttr(f.path)}')" title="Open full file preview">File</button>` : ""}
            </div>
          </div>
          ${f.diff ? `<div id="diff-body-${i}" class="review-diff-body" style="display:block;">${diffLinesHtml}</div>` : ""}
        </div>
      `;
    });
    filesHtml += `</div>`;

    if (contentEl) {
      contentEl.innerHTML = filesHtml;
      if (focusCardIdx >= 0) {
        setTimeout(() => {
          const cardEl = document.getElementById(`review-file-card-${focusCardIdx}`);
          const bodyEl = document.getElementById(`diff-body-${focusCardIdx}`);
          if (bodyEl) bodyEl.style.display = "block";
          if (cardEl) {
            cardEl.scrollIntoView({ behavior: "smooth", block: "start" });
            cardEl.classList.add("focused-card");
            setTimeout(() => cardEl.classList.remove("focused-card"), 1600);
          }
        }, 40);
      }
    }
  } catch (err) {
    if (badgeEl) badgeEl.innerText = "Error";
    if (contentEl) {
      contentEl.innerHTML = `<div style="padding:24px; color:#f87171; font-size:12px;">Failed to load changed files: ${escapeHtml(err.message || String(err))}</div>`;
    }
  }
}

function hasReviewableChanges() {
  if (Array.isArray(rsFilesCache) && rsFilesCache.length > 0) {
    return true;
  }
  if (typeof activeConversationId !== "undefined" && activeConversationId && Array.isArray(appConversations)) {
    const curConv = appConversations.find(c => c.id === activeConversationId);
    if (curConv && Array.isArray(curConv.turns)) {
      for (let i = 0; i < curConv.turns.length; i++) {
        const cf = curConv.turns[i] && curConv.turns[i].changed_files;
        if (cf && (cf.total_files > 0 || (Array.isArray(cf.files) && cf.files.length > 0))) {
          return true;
        }
      }
    }
  }
  return false;
}

function updateReviewChangesTabVisibility() {
  const reviewBtn = document.getElementById("btn-rs-tab-review");
  const hasChanges = hasReviewableChanges();
  if (reviewBtn) {
    reviewBtn.style.display = hasChanges ? "" : "none";
  }
  if (!hasChanges && currentRightTab === "review" && activeRawOutputTurnIndex === null && !currentPreviewPath) {
    const titleEl = document.getElementById("preview-title");
    const titleText = titleEl ? (titleEl.innerText || "") : "";
    if (!titleText || titleText === "Review Changes" || titleText === "Review Turn Changes" || titleText === "File Preview") {
      switchRightSidebarTab("overview");
    }
  }
}

function toggleFileDiff(index) {
  const el = document.getElementById("diff-body-" + index);
  if (el) {
    el.style.display = el.style.display === "none" ? "block" : "none";
  }
}

function switchRightSidebarTab(tabName) {
  currentRightTab = tabName;
  const tabs = ["overview", "review", "terminal"];
  tabs.forEach(t => {
    const btn = document.getElementById(`btn-rs-tab-${t}`);
    const panel = document.getElementById(`rs-panel-${t}`);
    if (btn) btn.classList.toggle("active", t === tabName);
    if (panel) panel.classList.toggle("active", t === tabName);
  });

  const titleEl = document.getElementById("preview-title");
  const badgeEl = document.getElementById("preview-badge");
  const copyBtn = document.getElementById("btn-copy-preview");

  if (tabName === "overview") {
    if (titleEl) titleEl.style.display = "none";
    if (badgeEl) badgeEl.style.display = "none";
    if (copyBtn) copyBtn.style.display = "none";
    loadRightSidebarOverview();
  } else if (tabName === "review") {
    if (titleEl) titleEl.style.display = "inline-block";
    const content = document.getElementById("preview-sidebar-content");
    if (content && (!content.innerHTML || content.innerHTML.trim() === "")) {
      openReviewSidebar();
    }
  } else if (tabName === "terminal") {
    if (titleEl) {
      titleEl.style.display = "inline-block";
      titleEl.innerText = "Runner Activity";
    }
    if (badgeEl) badgeEl.style.display = "none";
    if (copyBtn) copyBtn.style.display = "none";
    loadBackendLogs();
  }
  if (tabName !== "review") {
    activeRawOutputTurnIndex = null;
    currentPreviewPath = "";
  }
  updateReviewChangesTabVisibility();
}

let activeRawOutputTurnIndex = null;
let activeRawOutputConvId = null;

function getTurnRawJsonString(turn) {
  if (!turn) return "";
  try {
    let agentOutputJson = null;

    if (turn.debug_info && turn.debug_info.raw_agent_json && typeof turn.debug_info.raw_agent_json === "object") {
      agentOutputJson = turn.debug_info.raw_agent_json;
    }

    const wfExec = turn.workflow_execution || (turn.raw_json && turn.raw_json.workflow_execution) || null;
    if (!agentOutputJson && wfExec && Array.isArray(wfExec.results)) {
      for (let i = 0; i < wfExec.results.length; i++) {
        const r = wfExec.results[i];
        if (r && typeof r.result === "string" && r.result.trim().startsWith("{")) {
          try {
            agentOutputJson = JSON.parse(r.result);
            break;
          } catch (e) {}
        } else if (r && r.result && typeof r.result === "object") {
          agentOutputJson = r.result;
          break;
        }
      }
    }

    if (!agentOutputJson) {
      const candidateStr = (turn.debug_info && typeof turn.debug_info.raw_agent_output === "string" && turn.debug_info.raw_agent_output.trim())
        || (typeof turn.raw_output === "string" && turn.raw_output.trim())
        || "";
      if (candidateStr.startsWith("{") || candidateStr.startsWith("[")) {
        try {
          agentOutputJson = JSON.parse(candidateStr);
        } catch (e) {}
      }
    }

    const decisions = turn.decisions
      || (turn.raw_json && turn.raw_json.decisions)
      || (turn.debug_info && turn.debug_info.decisions)
      || (agentOutputJson && agentOutputJson.decisions)
      || null;

    // If we have the direct AgentOutput JSON from the agent, present it cleanly alongside execution context
    if (agentOutputJson) {
      const payload = Object.assign({}, agentOutputJson);
      if (decisions && !payload.decisions) {
        payload.decisions = decisions;
      }
      if (wfExec) {
        const cleanWf = Object.assign({}, wfExec);
        if (Array.isArray(cleanWf.results)) {
          cleanWf.results = cleanWf.results.map(item => {
            const copy = Object.assign({}, item);
            if (typeof copy.result === "string" && copy.result.trim().startsWith("{")) {
              try {
                copy.result = JSON.parse(copy.result);
              } catch (e) {}
            }
            return copy;
          });
        }
        payload._workflow_execution = cleanWf;
      }
      return JSON.stringify(payload, null, 2);
    }

    // Fallback: if raw_json or workflow_execution or decisions exist on the turn
    if (turn.raw_json || wfExec || (Array.isArray(decisions) && decisions.length > 0)) {
      const baseObj = Object.assign({}, turn.raw_json || turn);
      delete baseObj.conversation;
      delete baseObj.turns;
      if (baseObj.workflow_execution && Array.isArray(baseObj.workflow_execution.results)) {
        baseObj.workflow_execution = Object.assign({}, baseObj.workflow_execution);
        baseObj.workflow_execution.results = baseObj.workflow_execution.results.map(item => {
          const copy = Object.assign({}, item);
          if (typeof copy.result === "string" && copy.result.trim().startsWith("{")) {
            try {
              copy.result = JSON.parse(copy.result);
            } catch (e) {}
          }
          return copy;
        });
      }
      return JSON.stringify(baseObj, null, 2);
    }

    // Final fallback: serialize the turn object itself so raw JSON is always inspectable
    const turnCopy = Object.assign({}, turn);
    return JSON.stringify(turnCopy, null, 2);
  } catch (err) {
    return "";
  }
}

function getTurnRawText(turn) {
  if (!turn) return "";
  const unparsedFromDebug = (turn.debug_info && typeof turn.debug_info.raw_agent_output === "string")
    ? turn.debug_info.raw_agent_output
    : "";
  const rawMain = (turn.raw_output !== undefined && turn.raw_output !== "")
    ? turn.raw_output
    : (unparsedFromDebug || turn.output || "");
  let combined = rawMain;
  if (turn.activeThought && !combined.includes(turn.activeThought)) {
    combined = `<thought>\n${turn.activeThought}\n</thought>\n` + combined;
  }
  if (!combined && turn.error) {
    combined = turn.error;
  }
  return combined;
}

function buildTurnFullRawCopyText(turn, idx) {
  if (!turn) return "";
  const parts = [];
  parts.push(`=== PROMPT #${idx + 1} ===\n${turn.prompt || ""}`);
  const rawJson = getTurnRawJsonString(turn);
  if (rawJson) {
    parts.push(`=== RAW AGENT JSON ===\n${rawJson}`);
  }
  if (Array.isArray(turn.steps) && turn.steps.length > 0) {
    const stepsDump = turn.steps.map((s, sIdx) => {
      const header = `[Step ${sIdx + 1}] ${s.type || "step"}: ${s.name || ""}`;
      const body = s.detail || s.output || s.cmd || "";
      return body ? `${header}\n${body}` : header;
    }).join("\n\n");
    parts.push(`=== STEPS / THOUGHTS (${turn.steps.length}) ===\n${stepsDump}`);
  }
  const rawOut = getTurnRawText(turn);
  if (rawOut) {
    parts.push(`=== RAW STREAM / TEXT OUTPUT ===\n${rawOut}`);
  }
  return parts.join("\n\n");
}

function renderRightSidebarRawOutputList() {
  const listEl = document.getElementById("rs-raw-output-list");
  const countEl = document.getElementById("rs-count-raw-output");
  if (!listEl) return;

  const curConv = (typeof activeConversationId !== "undefined" && activeConversationId && Array.isArray(appConversations))
    ? appConversations.find(c => c.id === activeConversationId)
    : null;
  const turns = (curConv && Array.isArray(curConv.turns)) ? curConv.turns : [];

  if (countEl) countEl.innerText = String(turns.length);

  if (turns.length === 0) {
    listEl.innerHTML = `<div class="rs-empty-hint">No prompts in active conversation</div>`;
    return;
  }

  let html = "";
  turns.forEach((turn, idx) => {
    const cleanPrompt = String(turn.prompt || "Prompt").replace(/\s+/g, " ").trim();
    const rawJsonStr = getTurnRawJsonString(turn);
    const rawStr = rawJsonStr || getTurnRawText(turn);
    const isRunning = turn.status === "running" || turn.status === "in_progress";
    const metaLabel = isRunning
      ? "running..."
      : (rawStr ? formatBytes(new Blob([rawStr]).size) : (turn.duration || "0 B"));
    const isActive = (activeRawOutputConvId === (curConv && curConv.id) && activeRawOutputTurnIndex === idx && currentRightTab === "review");

    html += `
      <div class="rs-raw-turn-row${isActive ? " active" : ""}" onclick="openTurnRawOutput(${idx}, event)" title="${escapeHtml(cleanPrompt)}">
        <div class="rs-raw-turn-left">
          <span class="rs-raw-turn-idx">#${idx + 1}</span>
          <span class="rs-raw-turn-prompt">${escapeHtml(cleanPrompt)}</span>
        </div>
        <span class="rs-raw-turn-meta">${escapeHtml(metaLabel)}</span>
      </div>
    `;
  });

  listEl.innerHTML = html;
}

function openTurnRawOutput(turnIndex, event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  const sidebar = document.getElementById("preview-sidebar");
  if (!sidebar) return;

  const curConv = (typeof activeConversationId !== "undefined" && activeConversationId && Array.isArray(appConversations))
    ? appConversations.find(c => c.id === activeConversationId)
    : null;
  const turns = (curConv && Array.isArray(curConv.turns)) ? curConv.turns : [];
  const idx = (typeof turnIndex === "number" && turnIndex >= 0) ? turnIndex : Math.max(0, turns.length - 1);
  const turn = turns[idx] || null;

  activeRawOutputConvId = curConv ? curConv.id : null;
  activeRawOutputTurnIndex = idx;

  sidebar.style.display = "flex";
  const btnTopbar = document.getElementById("btn-toggle-right-sidebar");
  if (btnTopbar) {
    btnTopbar.classList.add("active");
    btnTopbar.setAttribute("title", "Contract Right Sidebar");
  }

  // Switch right sidebar to review/preview panel without auto-loading git diff
  currentRightTab = "review";
  ["overview", "review", "terminal"].forEach(t => {
    const btn = document.getElementById(`btn-rs-tab-${t}`);
    const panel = document.getElementById(`rs-panel-${t}`);
    if (btn) btn.classList.toggle("active", t === "review");
    if (panel) panel.classList.toggle("active", t === "review");
  });

  renderTurnRawOutputPanel(turn, idx, turns.length);
  renderRightSidebarRawOutputList();
}

function renderTurnRawOutputPanel(turn, idx, totalTurns) {
  const titleEl = document.getElementById("preview-title");
  const badgeEl = document.getElementById("preview-badge");
  const contentEl = document.getElementById("preview-sidebar-content");
  const copyBtn = document.getElementById("btn-copy-preview");

  if (!turn) {
    if (titleEl) {
      titleEl.style.display = "inline-block";
      titleEl.innerText = "Raw Output";
    }
    if (badgeEl) {
      badgeEl.style.display = "none";
    }
    if (copyBtn) copyBtn.style.display = "none";
    if (contentEl) {
      contentEl.innerHTML = `<div style="padding:28px 20px; text-align:center; color:var(--text-muted); font-size:12px;">No prompt output available yet.</div>`;
    }
    return;
  }

  const rawJson = getTurnRawJsonString(turn);
  const rawText = getTurnRawText(turn);
  const stepsArr = Array.isArray(turn.steps) ? turn.steps : [];

  const primaryPayloadForSize = rawJson || rawText || "";
  const byteSize = formatBytes(new Blob([primaryPayloadForSize]).size);
  const rawTextByteSize = formatBytes(new Blob([rawText || ""]).size);
  const isRunning = turn.status === "running" || turn.status === "in_progress";
  const modelName = turn.model || (turn.debug_info && turn.debug_info.model) || activeAiModel || "";

  if (titleEl) {
    titleEl.style.display = "inline-block";
    titleEl.innerText = `Raw Output • Prompt #${idx + 1}`;
  }
  if (badgeEl) {
    badgeEl.style.display = "inline-block";
    badgeEl.innerText = `${isRunning ? "Streaming" : (turn.duration || "Done")} • ${byteSize}`;
  }
  if (copyBtn) {
    copyBtn.style.display = "inline-flex";
  }

  if (!contentEl) return;

  const hasPrev = idx > 0;
  const hasNext = typeof totalTurns === "number" && idx < totalTurns - 1;

  const effectiveMode = (activeRawOutputMode === "steps" && stepsArr.length === 0)
    ? "json"
    : activeRawOutputMode;

  let editorPayload = "";
  let editorLang = "json";
  let forceJson = false;

  if (effectiveMode === "stream") {
    editorPayload = rawText || (isRunning ? "Waiting for raw stream..." : "(No raw text output)");
    editorLang = detectLanguageFromPath("", editorPayload);
  } else if (effectiveMode === "steps") {
    editorPayload = JSON.stringify(stepsArr, null, 2);
    editorLang = "json";
    forceJson = true;
  } else {
    editorPayload = rawJson || rawText || "{}";
    editorLang = "json";
    forceJson = true;
  }

  const builtInEditorHtml = renderBuiltinCodeEditor(editorPayload, {
    editorId: "raw-output-builtin-editor",
    lang: editorLang,
    forceJson: forceJson
  });

  contentEl.innerHTML = `
    <div class="rs-raw-viewer">
      <div class="rs-raw-viewer-toolbar">
        <button type="button" class="rs-raw-nav-btn" onclick="switchRightSidebarTab('overview')">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          <span>All Prompts (${totalTurns || 1})</span>
        </button>
        <div style="display:inline-flex; align-items:center; gap:4px;">
          <button type="button" class="rs-raw-nav-btn" ${hasPrev ? `onclick="openTurnRawOutput(${idx - 1}, event)"` : "disabled"} title="Previous Prompt">Prev</button>
          <span style="color:#52525b;">/</span>
          <button type="button" class="rs-raw-nav-btn" ${hasNext ? `onclick="openTurnRawOutput(${idx + 1}, event)"` : "disabled"} title="Next Prompt">Next</button>
        </div>
      </div>
      <div class="rs-raw-section">
        <div class="rs-raw-section-label">
          <span>Prompt #${idx + 1}</span>
          <span>${escapeHtml(modelName)}</span>
        </div>
        <pre class="rs-raw-pre">${escapeHtml(turn.prompt || "")}</pre>
      </div>
      <div class="rs-raw-mode-tabs">
        <button type="button" class="rs-raw-mode-tab${effectiveMode === "json" ? " active" : ""}" onclick="switchRawOutputViewMode('json')">Agent JSON (${escapeHtml(byteSize)})</button>
        <button type="button" class="rs-raw-mode-tab${effectiveMode === "stream" ? " active" : ""}" onclick="switchRawOutputViewMode('stream')">Raw Stream (${escapeHtml(rawTextByteSize)})</button>
        ${stepsArr.length > 0 ? `<button type="button" class="rs-raw-mode-tab${effectiveMode === "steps" ? " active" : ""}" onclick="switchRawOutputViewMode('steps')">Steps (${stepsArr.length})</button>` : ""}
      </div>
      ${builtInEditorHtml}
    </div>
  `;
}

function refreshActiveTurnRawOutputView() {
  if (currentRightTab !== "review" || activeRawOutputTurnIndex === null) return;
  const curConv = (typeof activeConversationId !== "undefined" && activeConversationId && Array.isArray(appConversations))
    ? appConversations.find(c => c.id === activeConversationId)
    : null;
  if (!curConv || curConv.id !== activeRawOutputConvId) return;
  const turns = Array.isArray(curConv.turns) ? curConv.turns : [];
  const turn = turns[activeRawOutputTurnIndex];
  if (turn) {
    renderTurnRawOutputPanel(turn, activeRawOutputTurnIndex, turns.length);
  }
}

function getFileTypeIcon(filePath) {
  const ext = (filePath.split(".").pop() || "").toLowerCase();
  if (filePath.endsWith("go.mod") || filePath.endsWith("go.sum")) {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;
  }
  if (ext === "go") {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M4 12h5m6 0h5"/><path d="M12 4v5m0 6v5"/></svg>`;
  }
  if (ext === "js" || ext === "jsx" || ext === "json") {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
  }
  if (ext === "ts" || ext === "tsx") {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
  }
  if (ext === "py") {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`;
  }
  if (ext === "html" || ext === "htm") {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;
  }
  if (ext === "css") {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"><path d="M4 4l2 16 6 2 6-2 2-16z"/></svg>`;
  }
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
}

async function loadRightSidebarOverview() {
  renderRightSidebarRawOutputList();
  updateReviewChangesTabVisibility();
  try {
    let raw = "";
    if (window.agentBridge && window.agentBridge.handleAction) {
      raw = await window.agentBridge.handleAction("getRightSidebarData", "{}");
    } else {
      raw = await callGo("getRightSidebarData", "{}");
    }
    const res = typeof raw === "string" ? JSON.parse(raw) : raw;

    // Files Changed
    const changes = res.git_changes || { total_files: 0, files: [] };
    const files = changes.files || [];
    rsFilesCache = files;
    const countFilesEl = document.getElementById("rs-count-files");
    if (countFilesEl) countFilesEl.innerText = files.length;

    renderRightSidebarFilesList();
    updateReviewChangesTabVisibility();

    // Terminals
    const terminals = res.terminals || [];
    const countTerminalsEl = document.getElementById("rs-count-terminals");
    const bodyTerminalsEl = document.getElementById("rs-body-terminals");
    if (countTerminalsEl) countTerminalsEl.innerText = terminals.length;
    if (bodyTerminalsEl) {
      if (terminals.length === 0) {
        bodyTerminalsEl.innerHTML = `<div class="rs-empty-hint">No active terminals</div>`;
      } else {
        bodyTerminalsEl.innerHTML = terminals.map(term => `
          <div class="rs-item-row" onclick="switchRightSidebarTab('terminal')">
            <svg class="rs-item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
            <span class="rs-item-name">${escapeHtml(term.name || "terminal")}</span>
            <span class="rs-item-meta">PID ${escapeHtml(String(term.pid || ""))}</span>
          </div>
        `).join("");
      }
    }

    // Uploads
    const uploads = res.uploads || [];
    const countUploadsEl = document.getElementById("rs-count-uploads");
    const bodyUploadsEl = document.getElementById("rs-body-uploads");
    if (countUploadsEl) countUploadsEl.innerText = uploads.length;
    if (bodyUploadsEl) {
      if (uploads.length === 0) {
        bodyUploadsEl.innerHTML = `<div class="rs-empty-hint">No uploads yet</div>`;
      } else {
        bodyUploadsEl.innerHTML = uploads.map(u => `
          <div class="rs-item-row" onclick="previewUploadedMedia()">
            <svg class="rs-item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            <span class="rs-item-name">${escapeHtml(u.name || "Media")}</span>
          </div>
        `).join("");
      }
    }

    // Background Tasks
    const countTasksEl = document.getElementById("rs-count-tasks");
    const tasksCount = (typeof activeRunningTasks !== "undefined" && Array.isArray(activeRunningTasks)) ? activeRunningTasks.length : 0;
    if (countTasksEl) countTasksEl.innerText = tasksCount;

    // Subagents
    const countSubagentsEl = document.getElementById("rs-count-subagents");
    if (countSubagentsEl) countSubagentsEl.innerText = "0";

    // Artifacts
    const countArtifactsEl = document.getElementById("rs-count-artifacts");
    if (countArtifactsEl) countArtifactsEl.innerText = "0";
  } catch (err) {
    console.warn("loadRightSidebarOverview error:", err);
    updateReviewChangesTabVisibility();
  }
}

function renderRightSidebarFilesList() {
  updateReviewChangesTabVisibility();
  const container = document.getElementById("rs-files-list");
  const seeAllBtn = document.getElementById("btn-see-all-files");
  const seeAllCount = document.getElementById("rs-see-all-count");
  if (!container) return;

  if (!rsFilesCache || rsFilesCache.length === 0) {
    container.innerHTML = `<div class="rs-empty-hint">Working tree clean</div>`;
    if (seeAllBtn) seeAllBtn.style.display = "none";
    return;
  }

  const total = rsFilesCache.length;
  const visibleFiles = (rsFilesExpanded || total <= 5) ? rsFilesCache : rsFilesCache.slice(0, 5);

  let html = "";
  visibleFiles.forEach(f => {
    const rawPath = f.path || "";
    const parts = rawPath.split(/[/\\]/);
    const fileName = parts.pop() || rawPath;
    const dir = parts.join("/");
    const icon = getFileTypeIcon(fileName);

    html += `
      <div class="rs-file-item" onclick="previewFileInSidebar('${escapeJsAttr(rawPath)}')">
        <div class="rs-file-left">
          <span class="rs-file-icon">${icon}</span>
          <span class="rs-file-name" title="${escapeHtml(rawPath)}">${escapeHtml(fileName)}</span>
        </div>
        ${dir ? `<span class="rs-file-dir">${escapeHtml(dir)}</span>` : ""}
      </div>
    `;
  });

  container.innerHTML = html;

  if (seeAllBtn) {
    if (total > 5) {
      seeAllBtn.style.display = "block";
      if (seeAllCount) seeAllCount.innerText = total;
      seeAllBtn.innerText = rsFilesExpanded ? "Show less" : `See all (${total})`;
    } else {
      seeAllBtn.style.display = "none";
    }
  }
}

function toggleSeeAllFiles() {
  rsFilesExpanded = !rsFilesExpanded;
  renderRightSidebarFilesList();
}

function toggleRightSidebarSection(sectionId) {
  const sec = document.getElementById(sectionId);
  if (sec) {
    const isExpanded = sec.classList.toggle("expanded");
    const body = sec.querySelector(".rs-section-body");
    if (body && isExpanded && body.style.display === "none") {
      body.style.display = "";
    }
  }
}

function previewUploadedMedia() {
  const uploadTitle = document.getElementById("rs-upload-title");
  const name = uploadTitle ? uploadTitle.innerText : "Media";
  switchRightSidebarTab('review');
  const titleEl = document.getElementById("preview-title");
  const badgeEl = document.getElementById("preview-badge");
  const contentEl = document.getElementById("preview-sidebar-content");
  if (titleEl) {
    titleEl.style.display = "inline-block";
    titleEl.innerText = name;
  }
  if (badgeEl) {
    badgeEl.style.display = "inline-block";
    badgeEl.innerText = "image • session asset";
  }
  if (contentEl) {
    contentEl.innerHTML = `
      <div class="preview-image-wrap">
        <div style="font-size:12px; color:var(--text-secondary); text-align:center; padding:20px;">
          Uploaded session media asset.<br><span style="color:var(--text-muted); font-size:11px;">Attached to conversation turns for vision and reference.</span>
        </div>
      </div>
    `;
  }
}

function triggerRightSidebarAction() {
  const input = document.getElementById("prompt-input") || document.getElementById("chat-input");
  if (input) {
    input.focus();
    input.scrollIntoView({ behavior: "smooth" });
  }
}

function clearTerminalView() {
  const now = Date.now();
  if (terminalLogScope === "conversation" && activeConversationId) {
    window.clearedConvLogTimestamps[activeConversationId] = now;
  } else {
    window.clearedConvLogTimestamps["__all__"] = now;
    window.structuredLogs = [];
  }
  renderTerminalLogs();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closePreviewSidebar();
  }
});

function buildErrorArea(isError, errText, info, prompt, rawOutput) {
  if (!isError) {
    const isShellCmd = prompt && (prompt.startsWith("$ ") || prompt.startsWith("> "));
    if (isShellCmd) {
      return `<div style="white-space:pre-wrap; word-break:break-word; font-family:ui-monospace,Menlo,monospace; font-size:12px; line-height:1.45;">${escapeHtml(rawOutput || "Completed with no output.")}</div>`;
    }
    return renderMarkdown(rawOutput || "Completed with no output.");
  }

  const isAiConfigError = (info && info.needs_ai_config) ||
    (info && (info.error_type === "missing_credentials" || info.error_type === "missing_ai_config")) ||
    errText.includes("no llm apikey") ||
    errText.includes("apikey") ||
    errText.includes("no organization-specific key") ||
    errText.includes("custom ai app authentication") ||
    errText.includes("ai provider not configured") ||
    errText.includes("ai configuration");

  const isRateLimitError = (info && info.error_type === "rate_limited") ||
    errText.includes("rate limit") ||
    errText.includes("quota") ||
    errText.includes("429") ||
    errText.includes("resource_exhausted") ||
    errText.includes("too many requests");

  const isNetworkError = (info && info.error_type === "network_unreachable") ||
    errText.includes("failed to fetch") ||
    errText.includes("connection refused") ||
    errText.includes("dial tcp") ||
    errText.includes("no such host");

  let displayMessage = rawOutput || (info && info.error) || errText || "An error occurred during execution.";
  if (displayMessage.toLowerCase().includes("failed to fetch")) {
    displayMessage = "Connection to agent runner lost (failed to fetch). Ensure Shuffle Agent is running.";
  }

  let actionsHtml = "";
  const curModel = (info && (info.ui_model || info.turn_model)) ||
    (typeof extractModelFromTurn === "function" && info ? extractModelFromTurn({ model: info.ui_model || info.turn_model, debug_info: info }) : "") ||
    (info && info.model) ||
    (info && info.debug_info && (info.debug_info.ui_model || info.debug_info.model)) ||
    activeAiModel ||
    (typeof window !== "undefined" && window.activeAiModel) ||
    (typeof localStorage !== "undefined" && localStorage.getItem("orborus_ai_model")) ||
    "tendon-local";
  const targetSettingsTab = (typeof getSettingsTabForModel === "function")
    ? getSettingsTabForModel(curModel, info)
    : ((curModel === "shuffle-ai" || curModel === "shuffle" || curModel === "default")
        ? "mode-shuffle"
        : ((curModel === "tendon-local" || String(curModel).startsWith("tendon") || String(curModel).startsWith("local"))
            ? "mode-local"
            : "mode-direct"));
  const escapedModel = escapeJsAttr(curModel);
  if (isAiConfigError) {

    const status = (typeof getModelConfigStatus === "function") ? getModelConfigStatus(curModel) : { actionType: "auth" };
    const hasLocal = (typeof window !== "undefined" && window.localExecutorAvailable !== false);
    const isAlreadyLocal = curModel === "tendon-local" || curModel.startsWith("tendon") || curModel.startsWith("local");

    const isShuffleAi = curModel === "shuffle-ai" || curModel === "shuffle" || curModel === "default" ||
      targetSettingsTab === "mode-shuffle" ||
      errText.includes("no organization-specific key") ||
      errText.includes("custom ai app authentication") ||
      status.actionType === "auth";

    if (isShuffleAi) {
      actionsHtml = `
        <button type="button" class="btn-error-cta" onclick="openSettingsForModel('shuffle-ai')">Re-authenticate Shuffle AI</button>
        <button type="button" class="btn-error-secondary" onclick="logoutShuffle()">Log Out • Reset Config</button>
        <button type="button" class="btn-error-secondary" onclick="openSettingsForModel('shuffle-ai')">Settings</button>
      `;
    } else {
      actionsHtml = `
        <button type="button" class="btn-error-cta" onclick="openSettingsForModel('${escapedModel}', 'key')">${targetSettingsTab === "mode-local" ? "Configure Local GPU in Settings" : "Configure in Settings"}</button>
        ${(hasLocal && !isAlreadyLocal) ? `<button type="button" class="btn-error-secondary" onclick="handleReminderUseLocal()">Switch to Local GPU</button>` : ""}
      `;
    }
  } else if (isRateLimitError) {
    actionsHtml = `
      <button type="button" class="btn-error-cta" onclick="retryCardPrompt(this)">Retry</button>
      <button type="button" class="btn-error-secondary" onclick="openSettingsForModel('${escapedModel}', 'model')">Switch Model</button>
      <button type="button" class="btn-error-secondary" onclick="openSettingsForModel('${escapedModel}')">Settings</button>
    `;
  } else if (isNetworkError) {
    actionsHtml = `
      <button type="button" class="btn-error-cta" onclick="retryCardPrompt(this)">Retry</button>
      <button type="button" class="btn-error-secondary" onclick="openTerminalLogsTab()">View Logs</button>
      <button type="button" class="btn-error-secondary" onclick="openSettingsForModel('${escapedModel}', 'url')">Settings</button>

    `;
  } else {
    actionsHtml = `
      <button type="button" class="btn-error-cta" onclick="retryCardPrompt(this)">Retry</button>
      <button type="button" class="btn-error-secondary" onclick="openTerminalLogsTab()">View Logs</button>
      <button type="button" class="btn-error-secondary" onclick="openSettingsForModel('${escapedModel}', 'url')">Settings</button>
    `;
  }

  return `
    <div class="compact-error-area">
      <div class="compact-error-message">${escapeHtml(displayMessage)}</div>
      <div class="compact-error-actions">
        ${actionsHtml}
      </div>
    </div>
  `;
}

function toggleCommandExpansion(id, event) {
  if (event) event.stopPropagation();
  const textEl = document.getElementById("cmd-text-" + id);
  const btnEl = document.getElementById("cmd-exp-" + id);
  if (!textEl) return;
  const isExp = textEl.classList.toggle("expanded");
  if (btnEl) {
    btnEl.classList.toggle("expanded", isExp);
  }
}

function checkCommandClamping(id) {
  const textEl = document.getElementById("cmd-text-" + id);
  const btnEl = document.getElementById("cmd-exp-" + id);
  if (textEl && btnEl) {
    const isMultiLine = (textEl.innerText || "").split("\n").length > 3;
    const isOverflowing = textEl.scrollHeight > textEl.clientHeight + 2;
    if (isMultiLine || isOverflowing) {
      btnEl.style.display = "inline-flex";
      textEl.style.cursor = "pointer";
      textEl.title = "Click to expand / collapse full prompt";
    } else {
      btnEl.style.display = "none";
    }
  }
}

function previewAttachmentInSidebar(el, event) {
  if (event) event.stopPropagation();
  if (!el) return;
  const filePath = el.getAttribute("data-path") || "";
  if (filePath) {
    previewFileInSidebar(filePath);
    return;
  }
  const imgEl = el.querySelector("img.user-turn-attachment-img");
  const name = el.getAttribute("data-name") || "Attachment";
  if (imgEl && imgEl.src) {
    const sidebar = document.getElementById("preview-sidebar");
    if (!sidebar) return;
    switchRightSidebarTab('review');
    sidebar.style.display = "flex";
    const titleEl = document.getElementById("preview-title");
    const badgeEl = document.getElementById("preview-badge");
    const contentEl = document.getElementById("preview-sidebar-content");
    const copyBtn = document.getElementById("btn-copy-preview");
    if (titleEl) {
      titleEl.style.display = "inline-block";
      titleEl.innerText = name;
    }
    if (badgeEl) {
      badgeEl.style.display = "inline-block";
      badgeEl.innerText = "Attached Image";
    }
    if (copyBtn) copyBtn.style.display = "none";
    if (contentEl) {
      contentEl.innerHTML = `
        <div class="preview-image-wrap">
          <img class="preview-image-img" src="${escapeHtml(imgEl.src)}" alt="${escapeHtml(name)}" />
          <div class="preview-image-meta">${escapeHtml(name)}</div>
        </div>
      `;
    }
  }
}
if (typeof window !== "undefined") {
  window.previewAttachmentInSidebar = previewAttachmentInSidebar;
}

function buildGeneratedImagesHtml(generatedImages) {
  if (!Array.isArray(generatedImages) || generatedImages.length === 0) return "";
  const cardsHtml = generatedImages.map((img, idx) => {
    const dataUri = img.data_uri || "";
    const filePath = img.path || "";
    const name = img.name || `screenshot_${idx + 1}.png`;
    const label = img.label || `Display ${img.display_id || (idx + 1)}`;
    const sizeText = img.size ? formatBytes(img.size) : "";
    const previewTarget = filePath || dataUri;
    const escapedTarget = escapeJsAttr(previewTarget);
    const escapedLabel = escapeJsAttr(label);
    return `
      <div class="turn-generated-image-item">
        <div class="turn-generated-image-header">
          <span class="turn-generated-image-label">${escapeHtml(label)}</span>
          ${filePath ? `<span class="md-file-pill" onclick="previewFileInSidebar('${escapeJsAttr(filePath)}')" title="Open ${escapeHtml(filePath)}">${escapeHtml(name)}</span>` : `<span class="turn-generated-image-meta">${escapeHtml(name)}</span>`}
          ${sizeText ? `<span class="turn-generated-image-meta">${escapeHtml(sizeText)}</span>` : ""}
        </div>
        ${dataUri ? `
          <div class="turn-generated-image-frame" onclick="previewFileInSidebar('${escapedTarget}', '${escapedLabel}')" title="Click to inspect full image in sidebar">
            <img src="${dataUri}" alt="${escapeHtml(label)}" loading="lazy" />
          </div>
        ` : ""}
      </div>
    `;
  }).join("");
  return `<div class="turn-generated-images-grid">${cardsHtml}</div>`;
}

function renderTurnElement(turn, index, convId = activeConversationId) {
  const turnEl = document.createElement("div");
  turnEl.className = "transcript-turn";
  turnEl.id = "transcript-turn-" + (turn.id || index);
  turnEl.style.display = "flex";
  turnEl.style.flexDirection = "column";
  turnEl.style.gap = "8px";

  // 1. User Prompt (full width, max 3 rows unless expanded, sticky at the top, includes running status if active)
  const isActuallyRunning = (typeof isPromptExecuting !== "undefined" && isPromptExecuting) &&
    (typeof runningConversationId !== "undefined" && runningConversationId !== null && convId === runningConversationId);
  const isRunning = (turn.status === "running" || turn.status === "in_progress") && isActuallyRunning;

  if ((turn.status === "running" || turn.status === "in_progress") && !isActuallyRunning) {
    turn.status = turn.output ? "success" : "interrupted";
  }
  if (!isRunning) {
    finalizeTurnLiveThoughts(turn);
  }

  const turnAttachments = Array.isArray(turn.attachments) && turn.attachments.length > 0
    ? turn.attachments
    : (turn.debug_info && Array.isArray(turn.debug_info.attachments) ? turn.debug_info.attachments : []);

  if (turn.prompt || turnAttachments.length > 0) {
    const currentModelName = turn.model || (typeof window !== "undefined" && window.activeAiModel) || activeAiModel || "gemini-3.8-flash";
    const modelDisplay = resolveModelDisplayName(currentModelName);
    const isLocal = typeof isSelfHostedModel === "function" ? isSelfHostedModel(currentModelName) : false;
    const isModelActive = turn.modelActive || !isLocal;
    const isWaitingApproval = isRunning && (
      (Array.isArray(globalApprovalQueue) && globalApprovalQueue.some(q => !q.conversation_id || q.conversation_id === convId)) ||
      (turn.phase && String(turn.phase).toLowerCase().startsWith("waiting for approval"))
    );
    const statusText = isWaitingApproval
      ? "Waiting for approval"
      : (isModelActive ? `Processing with ${modelDisplay}` : `Local GPU: ${modelDisplay}`);
    const initialPhase = turn.phase || (isWaitingApproval ? "Action requires your approval below" : (isLocal ? "Initializing GPU engine..." : "Querying AI Model..."));

    const promptRow = document.createElement("div");
    promptRow.className = "user-turn-row sticky-turn-command" + (isRunning ? " is-running" : "");
    promptRow.id = `turn-prompt-${turn.id || index}`;

    let attachmentsHtml = "";
    if (turnAttachments.length > 0) {
      const itemsHtml = turnAttachments.map(att => {
        const name = escapeHtml(att.name || "attachment");
        const rawPath = att.path || "";
        const dataAttrs = `data-path="${escapeHtml(rawPath)}" data-name="${name}" onclick="previewAttachmentInSidebar(this, event)"`;
        if (att.is_image && att.data_uri) {
          return `<div class="user-turn-attachment-item" ${dataAttrs} title="${escapeHtml(rawPath || att.name || '')}">
            <img class="user-turn-attachment-img" src="${escapeHtml(att.data_uri)}" alt="${name}" />
            <span class="user-turn-attachment-label">${name}</span>
          </div>`;
        }
        return `<div class="user-turn-attachment-item" ${dataAttrs} title="${escapeHtml(rawPath || att.name || '')}">
          <span class="prompt-attachment-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>
          <span class="user-turn-attachment-label">${name}</span>
        </div>`;
      }).join("");
      attachmentsHtml = `<div class="user-turn-attachments">${itemsHtml}</div>`;
    }

    promptRow.innerHTML = `
      <div class="user-command-box">
        <div class="user-command-main">
          <div style="flex:1;min-width:0;">
            ${turn.prompt ? `<div class="user-command-text" id="cmd-text-${turn.id || index}" onclick="toggleCommandExpansion('${turn.id || index}', event)">${escapeHtml(turn.prompt)}</div>` : ""}
            ${attachmentsHtml}
          </div>
          <div class="user-command-actions">
            <button type="button" class="btn-command-raw" title="View raw agent output for this prompt" onclick="openTurnRawOutput(${index}, event)">Raw</button>
            <button type="button" class="btn-command-expand" id="cmd-exp-${turn.id || index}" title="Expand / collapse full prompt" onclick="toggleCommandExpansion('${turn.id || index}', event)">
              <svg class="cmd-expand-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
          </div>
        </div>
        ${isRunning ? `
          <div class="user-command-meta-bar" id="cmd-meta-${turn.id || index}">
            <div class="user-command-meta-left">
              <svg class="running-task-spinner" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <circle cx="12" cy="12" r="9" stroke-dasharray="28 28"/>
              </svg>
              <span class="cmd-meta-status" id="cmd-status-${turn.id || index}">${escapeHtml(statusText)}</span>
              <span id="live-phase-${turn.id || index}" class="cmd-meta-phase">${escapeHtml(initialPhase)}</span>
              <span id="live-log-${turn.id || index}" class="cmd-meta-log" onclick="openTerminalLogsTab()" title="Click to view backend logs"></span>
              <span id="live-dur-${turn.id || index}" class="cmd-meta-dur">${escapeHtml(turn.duration && turn.duration !== "0s" ? turn.duration : "")}</span>
            </div>
            <div class="user-command-meta-right">
              <button class="btn-command-logs" type="button" onclick="openTurnRawOutput(${index}, event)" title="View raw agent output for this prompt">
                Raw
              </button>
              <button class="btn-command-logs" type="button" onclick="openTerminalLogsTab()" title="View backend runner logs">
                Logs
              </button>
              <button class="btn-command-stop" type="button" onclick="stopExecution('${convId || ""}')" title="Stop prompt execution">
                Stop
              </button>
            </div>
          </div>
        ` : ""}
      </div>
    `;
    turnEl.appendChild(promptRow);

    // Check if prompt exceeds 3 lines to reveal expansion button
    setTimeout(() => {
      checkCommandClamping(turn.id || index);
    }, 10);
  }

  // 2. Middle: Dynamic Agent Progress breakdown (Antigravity-style Hierarchical Work Tree)
  if (turn.steps && Array.isArray(turn.steps) && turn.steps.length > 0) {
    const isRunning = turn.status === "running" || turn.status === "in_progress";
    const rawDur = (turn.duration && turn.duration !== "0s") ? turn.duration : (turn.elapsed ? `${turn.elapsed}s` : "");
    const durationText = rawDur || "1s";
    const isInterrupted = turn.status === "interrupted" || turn.error_type === "user_cancelled";
    const hasReturnedSomething = !isRunning && Boolean(
      (turn.output && String(turn.output).trim().length > 0) ||
      (turn.steps && turn.steps.length > 0) ||
      turn.error
    );

    const isRootCollapsed = !isRunning && (turn.worktreeCollapsed !== false);
    const worktreeRoot = document.createElement("div");
    worktreeRoot.className = "worktree-root";
    worktreeRoot.id = "worktree-root-" + (turn.id || index);

    if (hasReturnedSomething) {
      const rootLabel = isInterrupted ? `Worked for ${durationText} (stopped)` : `Worked for ${durationText}`;
      const rootHeader = document.createElement("div");
      rootHeader.className = "worktree-root-header";
      rootHeader.onclick = () => toggleWorktreeRoot(rootHeader);
      rootHeader.innerHTML = `
        <span>${escapeHtml(rootLabel)}</span>
        <span class="worktree-chevron ${isRootCollapsed ? 'collapsed' : ''}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg></span>
      `;
      worktreeRoot.appendChild(rootHeader);
    }

    const worktreeContainer = document.createElement("div");
    worktreeContainer.className = "worktree-container" + (isRootCollapsed ? " collapsed" : "");
    worktreeContainer.id = "worktree-container-" + (turn.id || index);

    renderWorktreeNodes(turn.steps, worktreeContainer, 0);
    if (worktreeContainer.children.length > 0) {
      worktreeRoot.appendChild(worktreeContainer);
      turnEl.appendChild(worktreeRoot);
    }
  }

  // 3. Assistant Output Stream (no raw thought tags in markdown stream)
  if (turn.status === "running") {
    const rawOut = turn.displayOutput !== undefined ? turn.displayOutput : turn.output;
    const cleanOut = (rawOut || "")
      .replace(/<(?:thought|thinking)>[\s\S]*?<\/(?:thought|thinking)>/gi, "")
      .replace(/<(?:thought|thinking)>[\s\S]*$/gi, "")
      .trim();
    if (cleanOut.length > 0) {
      const assistantTurn = document.createElement("div");
      assistantTurn.className = "assistant-turn-content";
      assistantTurn.innerHTML = `
        <div class="assistant-markdown-stream">
          ${renderMarkdown(cleanOut)}<span class="streaming-cursor"></span>
        </div>
      `;
      turnEl.appendChild(assistantTurn);
    }
  } else if (turn.output || turn.error || (turn.status && turn.status !== "running")) {
    const isCancelled = turn.error_type === "user_cancelled" ||
      turn.status === "interrupted" ||
      turn.status === "cancelled" ||
      (turn.error && (turn.error.toLowerCase().includes("cancelled") || turn.error.toLowerCase().includes("stopped")));

    if (isCancelled) {
      const rawText = turn.output || "";
      const cleanText = rawText
        .replace(/<(?:thought|thinking)>[\s\S]*?<\/(?:thought|thinking)>/gi, "")
        .replace(/<(?:thought|thinking)>[\s\S]*$/gi, "")
        .trim();
      const assistantTurn = document.createElement("div");
      assistantTurn.className = "assistant-turn-content cancelled";

      let outHtml = "";
      if (cleanText.length > 0 && cleanText !== turn.error) {
        outHtml = `<div class="assistant-markdown-stream">${renderMarkdown(cleanText)}</div>`;
      }

      const cancelRowHtml = `
        <div class="cancellation-badge-row">
          <span class="cancellation-badge-text">Generation stopped</span>
          <button type="button" class="btn-clean-retry" onclick="retryCardPrompt(this)">Retry</button>
        </div>
      `;
      assistantTurn.innerHTML = outHtml + cancelRowHtml;
      turnEl.appendChild(assistantTurn);
    } else {
      const isError = turn.status === "error" || (turn.output && turn.output.startsWith("Error:")) || !!turn.error;
      const errText = (turn.error || turn.output || "").toLowerCase();
      const turnModel = (typeof extractModelFromTurn === "function" && extractModelFromTurn(turn)) || turn.model || "";
      const info = Object.assign(
        {},
        turn.debug_info || {},
        turnModel ? { ui_model: turnModel, turn_model: turnModel } : {}
      );

      let curProjPath = turn.project_path || "";
      if (!curProjPath && activeConversationId && Array.isArray(appConversations)) {
        const curConv = appConversations.find(c => c.id === activeConversationId);
        if (curConv && curConv.project_path) curProjPath = curConv.project_path;
      }
      const diffFooter = buildTurnChangesHtml(turn.changed_files, index, curProjPath);

      const rawText = turn.output || "";
      let cleanText = rawText
        .replace(/<(?:thought|thinking)>[\s\S]*?<\/(?:thought|thinking)>/gi, "")
        .replace(/<(?:thought|thinking)>[\s\S]*$/gi, "")
        .trim();
      if (!isError && isGenericPlaceholderText(cleanText)) {
        const fallbackAnswer = extractFallbackAnswerFromTurn(turn);
        if (fallbackAnswer) {
          cleanText = fallbackAnswer;
          if (isGenericPlaceholderText(turn.output)) {
            turn.output = fallbackAnswer;
          }
        }
      }
      const generatedImagesHtml = buildGeneratedImagesHtml(info.generated_images);
      const assistantTurn = document.createElement("div");
      assistantTurn.className = isError ? "assistant-turn-content error" : "assistant-turn-content";

      if (isError) {
        let outHtml = "";
        if (cleanText.length > 0 && cleanText !== turn.error && !cleanText.startsWith("Error:")) {
          outHtml = `<div class="assistant-markdown-stream">${renderMarkdown(cleanText)}</div>`;
        }
        const errorAreaHtml = buildErrorArea(true, errText, info, turn.prompt, turn.error || cleanText || "An error occurred.");
        assistantTurn.innerHTML = outHtml + generatedImagesHtml + errorAreaHtml + diffFooter;
      } else {
        assistantTurn.innerHTML = `
          <div class="assistant-markdown-stream">
            ${buildErrorArea(false, "", info, turn.prompt, cleanText || "Completed.")}
          </div>
          ${generatedImagesHtml}
          ${diffFooter}
        `;
      }
      turnEl.appendChild(assistantTurn);
    }
  }

  return turnEl;
}

function getTurnFileLangBadge(filePath) {
  const p = String(filePath || "").replace(/\\/g, "/").trim();
  const base = (p.split("/").pop() || "").toLowerCase();
  if (!base) return "FILE";
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "DOCKER";
  if (base === "makefile") return "MAKE";
  if (base === "go.mod" || base === "go.sum") return "GO";
  const dotIdx = base.lastIndexOf(".");
  if (dotIdx === -1 || dotIdx === base.length - 1) return "FILE";
  const ext = base.slice(dotIdx + 1);
  const map = {
    go: "GO",
    js: "JS",
    mjs: "JS",
    cjs: "JS",
    jsx: "JSX",
    ts: "TS",
    tsx: "TSX",
    css: "CSS",
    scss: "SCSS",
    less: "LESS",
    html: "HTML",
    htm: "HTML",
    json: "JSON",
    md: "MD",
    markdown: "MD",
    py: "PY",
    rs: "RS",
    rb: "RB",
    java: "JAVA",
    kt: "KT",
    c: "C",
    h: "H",
    cpp: "CPP",
    cc: "CPP",
    hpp: "HPP",
    cs: "CS",
    php: "PHP",
    sh: "SH",
    bash: "SH",
    zsh: "SH",
    ps1: "PS1",
    yml: "YML",
    yaml: "YAML",
    toml: "TOML",
    xml: "XML",
    sql: "SQL",
    svg: "SVG",
    txt: "TXT",
    env: "ENV",
    vue: "VUE",
    svelte: "SVELTE"
  };
  return map[ext] || ext.toUpperCase().slice(0, 6);
}
window.getTurnFileLangBadge = getTurnFileLangBadge;

function resolveTurnFileDisplayParts(filePath, projectPath) {
  const raw = String(filePath || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = raw.split("/").filter(Boolean);
  const basename = parts.length > 0 ? parts[parts.length - 1] : raw;
  const relDir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";

  let baseProj = String(projectPath || "").trim();
  if (!baseProj || baseProj === ".") {
    if (typeof activeProjectPath === "string" && activeProjectPath && activeProjectPath !== ".") {
      baseProj = activeProjectPath;
    } else if (Array.isArray(allProjects) && allProjects.length > 0) {
      const found = allProjects.find(p => (p.Path || p.path) && (p.Path || p.path) !== ".");
      if (found) baseProj = found.Path || found.path || "";
    }
  }
  baseProj = baseProj.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[a-zA-Z]:\//.test(baseProj)) {
    baseProj = "/" + baseProj[0].toLowerCase() + baseProj.slice(1);
  }

  let dirDisplay = "";
  if (/^[a-zA-Z]:\//.test(raw) || raw.startsWith("/")) {
    let absDir = parts.slice(0, -1).join("/");
    if (/^[a-zA-Z]:\//.test(absDir)) {
      absDir = "/" + absDir[0].toLowerCase() + absDir.slice(1);
    } else if (absDir && !absDir.startsWith("/")) {
      absDir = "/" + absDir;
    }
    dirDisplay = absDir;
  } else if (baseProj && baseProj !== ".") {
    dirDisplay = relDir ? `${baseProj}/${relDir}` : baseProj;
  } else {
    dirDisplay = relDir ? `/${relDir}` : "";
  }

  return { basename, dirDisplay, relDir };
}

function formatUnifiedDiffLinesHtml(diffText, skipHeaders) {
  const raw = String(diffText || "");
  if (!raw.trim()) return "";
  return raw
    .split("\n")
    .map(line => {
      if (line.startsWith("+++") || line.startsWith("---")) {
        return skipHeaders ? "" : `<span class="diff-line-info">${escapeHtml(line)}</span>`;
      }
      if (line.startsWith("+")) {
        return `<span class="diff-line-add">${escapeHtml(line)}</span>`;
      }
      if (line.startsWith("-")) {
        return `<span class="diff-line-del">${escapeHtml(line)}</span>`;
      }
      if (line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ")) {
        return `<span class="diff-line-info">${escapeHtml(line)}</span>`;
      }
      return `<span style="display:block; color:#cbd5e1;">${escapeHtml(line)}</span>`;
    })
    .join("");
}
window.formatUnifiedDiffLinesHtml = formatUnifiedDiffLinesHtml;

function toggleTurnChangesList(footerEl) {
  if (!footerEl) return;
  const container = footerEl.closest(".turn-changes-container");
  if (!container) return;
  container.classList.toggle("collapsed");
}
window.toggleTurnChangesList = toggleTurnChangesList;

function toggleTurnFileInlineDiff(rowEl) {
  if (!rowEl) return;
  const item = rowEl.closest(".turn-changes-file-item");
  if (!item) return;
  item.classList.toggle("expanded");
}
window.toggleTurnFileInlineDiff = toggleTurnFileInlineDiff;

function buildTurnChangesHtml(changed, turnIndex, projectPath) {
  if (!changed || !changed.total_files || changed.total_files <= 0) return "";
  const files = Array.isArray(changed.files) ? changed.files : [];
  const hasTurnIndex = typeof turnIndex === "number" && !Number.isNaN(turnIndex);
  const reviewArg = hasTurnIndex ? String(turnIndex) : "";

  let fileRowsHtml = "";
  files.forEach((f) => {
    const filePath = f.path || "";
    const badge = getTurnFileLangBadge(filePath);
    const { basename, dirDisplay } = resolveTurnFileDisplayParts(filePath, projectPath);
    const addCount = f.additions || 0;
    const delCount = f.deletions || 0;
    const diffHtml = formatUnifiedDiffLinesHtml(f.diff || "", true);
    const reviewFileCall = hasTurnIndex
      ? `openReviewSidebar(${turnIndex}, '${escapeJsAttr(filePath)}')`
      : `openReviewSidebar(undefined, '${escapeJsAttr(filePath)}')`;

    fileRowsHtml += `
      <div class="turn-changes-file-item">
        <div class="turn-changes-file-row" onclick="toggleTurnFileInlineDiff(this)" title="Click to inspect changes in ${escapeHtml(filePath)}">
          <div class="turn-file-left">
            <span class="turn-file-lang-badge">${escapeHtml(badge)}</span>
            <span class="turn-file-basename">${escapeHtml(basename)}</span>
            ${dirDisplay ? `<span class="turn-file-dirpath" title="${escapeHtml(dirDisplay)}">${escapeHtml(dirDisplay)}</span>` : ""}
          </div>
          <div class="turn-file-right">
            <span class="turn-file-add">+${addCount}</span>
            <span class="turn-file-del">-${delCount}</span>
            <svg class="turn-file-row-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="9 18 15 12 9 6"/></svg>
          </div>
        </div>
        <div class="turn-file-inline-diff">
          <div class="turn-file-inline-toolbar">
            <span class="turn-file-inline-path">${escapeHtml(filePath)}</span>
            <div class="turn-file-inline-actions">
              ${f.status !== "deleted" ? `<button type="button" class="btn-turn-file-action" onclick="event.stopPropagation(); previewFileInSidebar('${escapeJsAttr(filePath)}')">Open File</button>` : ""}
              <button type="button" class="btn-turn-file-action" onclick="event.stopPropagation(); ${reviewFileCall}">Open in Review</button>
            </div>
          </div>
          <div class="turn-file-inline-diff-body">${diffHtml || `<span class="diff-line-info">File ${escapeHtml(f.status || "modified")} (+${addCount} -${delCount})</span>`}</div>
        </div>
      </div>
    `;
  });

  return `
    <div class="turn-changes-container">
      <div class="turn-changes-footer" onclick="toggleTurnChangesList(this)">
        <div class="turn-changes-left">
          <span class="turn-changes-count">${changed.total_files} file${changed.total_files > 1 ? "s" : ""} changed</span>
          <span class="turn-changes-add">+${changed.additions || 0}</span>
          <span class="turn-changes-del">-${changed.deletions || 0}</span>
          <svg class="turn-changes-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <button type="button" class="btn-review-changes" onclick="event.stopPropagation(); openReviewSidebar(${reviewArg})">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          <span>Review</span>
        </button>
      </div>
      ${fileRowsHtml ? `<div class="turn-changes-file-list">${fileRowsHtml}</div>` : ""}
    </div>
  `;
}
window.buildTurnChangesHtml = buildTurnChangesHtml;

function renderExecutionResult(item, elapsedSec) {
  const container = document.getElementById("execution-cards-container");
  if (!container) return;

  const isError = item.status === "error" || (item.output && item.output.startsWith("Error:")) || !!item.error;
  const errText = (item.error || item.output || "").toLowerCase();
  const itemModel = (typeof extractModelFromTurn === "function" && extractModelFromTurn(item)) || item.model || "";
  const info = Object.assign(
    {},
    item.debug_info || {},
    itemModel ? { ui_model: itemModel, turn_model: itemModel } : {}
  );

  const isAiConfigError = item.needs_ai_config || 
    (item.error_type === "missing_credentials") ||
    (item.error_type === "missing_ai_config") || 
    errText.includes("no llm apikey") || 
    errText.includes("apikey") || 
    errText.includes("no organization-specific key") || 
    errText.includes("custom ai app authentication") || 
    errText.includes("ai provider not configured") || 
    errText.includes("ai configuration");

  const isNetworkError = (item.error_type === "network_unreachable") ||
    errText.includes("connection refused") ||
    errText.includes("dial tcp") ||
    errText.includes("no such host");

  const isRateLimitError = (item.error_type === "rate_limited") ||
    errText.includes("rate limit") ||
    errText.includes("quota") ||
    errText.includes("429");

  const isCommandNotFound = (item.error_type === "command_not_found") ||
    (item.output && item.output.includes("command not found")) || 
    (item.error && item.error.includes("command not found"));

  const entry = {
    prompt: item.prompt,
    output: item.output || item.error || "Completed with no output.",
    timestamp: item.timestamp || new Date().toLocaleTimeString(),
    duration: item.duration || `${elapsedSec}s`,
    status: isError ? "error" : "success"
  };
  addExecutionHistory(entry);

  const wrapper = document.createElement("div");
  wrapper.style.display = "flex";
  wrapper.style.flexDirection = "column";
  wrapper.style.gap = "8px";

  const status = document.createElement("div");
  status.className = isError ? "status-pill status-pill-error" : "status-pill";
  status.title = "Click to toggle output";
  status.onclick = () => toggleResultCard(status);
  const statusLabel = isError 
    ? `Failed in ${elapsedSec}s (${item.duration || "0ms"})`
    : `Worked for ${elapsedSec}s (${item.duration || "0ms"})`;
  status.innerHTML = `
    <span>${escapeHtml(statusLabel)}</span>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  `;


  let debugBar = "";
  if (window.isDebug && item.debug_info) {
    const currentModelName = (typeof window !== "undefined" && window.activeAiModel) || activeAiModel || "tendon-local";
    debugBar = `
      <div style="padding:4px 10px; background:rgba(255,255,255,0.03); border-bottom:1px solid var(--border-subtle); font-size:11px; color:var(--text-muted); font-family:ui-monospace,Menlo,Monaco,monospace; display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <span style="color:${isError ? '#f87171' : '#94a3b8'}; font-weight:600;">${isError ? 'ERROR' : 'DEBUG'}</span>
        <span>Target: ${escapeHtml(info.target || "local")}</span>
        <span>Model: ${escapeHtml(info.model || currentModelName)}</span>
        ${info.reasoning ? `<span>Reasoning: ${escapeHtml(info.reasoning)}</span>` : ""}
        <span>Engine: ${escapeHtml(info.engine || info.mode || "shuffle.HandleAiAgentExecutionStart")}</span>
      </div>
    `;
  }

  const diffFooter = buildTurnChangesHtml(item.changed_files, undefined, item.project_path || activeProjectPath);

  const generatedImagesHtml = buildGeneratedImagesHtml(info.generated_images);
  const card = document.createElement("div");
  card.className = isError ? "assistant-turn-content error" : "assistant-turn-content";
  card.innerHTML = `
    <div class="assistant-markdown-stream">
      ${buildErrorArea(isError, errText, info, item.prompt, item.output || item.error)}
    </div>
    ${generatedImagesHtml}
    ${diffFooter}
  `;

  container.prepend(card);
}

function renderErrorResult(prompt, err, meta) {
  const container = document.getElementById("execution-cards-container");
  if (!container) return;

  if (window.isDebug) {
    console.error("[DEBUG] Prompt error:", { prompt, err, meta });
  }

  const errText = (err || "").toLowerCase();
  const entry = {
    prompt: prompt,
    error: err,
    timestamp: new Date().toLocaleTimeString(),
    status: "error"
  };
  addExecutionHistory(entry);

  const info = meta || {};

  const card = document.createElement("div");
  card.className = "assistant-turn-content error";
  card.innerHTML = `
    <div class="assistant-markdown-stream">
      ${buildErrorArea(true, errText, info, prompt, err)}
    </div>
  `;

  container.prepend(card);
}

function renderActiveConversation() {
  const turnsContainer = document.getElementById("conversation-turns-container");
  const promptCard = document.getElementById("active-user-prompt-card");
  const stepsContainer = document.getElementById("activity-steps-container");
  const approvalCard = document.getElementById("approval-card");
  const topbarConv = document.getElementById("topbar-conv-title");
  const topbarProj = document.getElementById("topbar-project-name");
  const mainContainer = document.getElementById("main-container");
  const curBtnStop = document.getElementById("btn-stop-execution");
  const curBtnSend = document.getElementById("btn-send");

  const isThisConvExecuting = !!(typeof isPromptExecuting !== "undefined" && isPromptExecuting &&
                                 typeof runningConversationId !== "undefined" && runningConversationId !== null &&
                                 activeConversationId === runningConversationId);

  if (curBtnStop && curBtnSend) {
    if (isThisConvExecuting) {
      curBtnStop.style.display = "flex";
      curBtnSend.style.display = "none";
    } else {
      curBtnStop.style.display = "none";
      curBtnSend.style.display = "flex";
    }
  }

  if (!activeConversationId) {
    setChatMode(false);
    if (turnsContainer) turnsContainer.innerHTML = "";
    if (promptCard) {
      promptCard.innerText = "";
      promptCard.style.display = "none";
    }
    const summaryBanner = document.getElementById("activity-summary-banner");
    if (summaryBanner) summaryBanner.style.display = "none";
    if (stepsContainer) stepsContainer.innerHTML = "";
    if (approvalCard) approvalCard.classList.remove("visible");
    const dockContainer = document.getElementById("chat-dock-container");
    if (dockContainer) dockContainer.classList.remove("has-approval-card");
    if (topbarConv) topbarConv.innerText = "New Conversation";
    const archiveBtn = document.getElementById("btn-archive-active-chat");
    if (archiveBtn) archiveBtn.style.display = "none";
    const archivedBanner = document.getElementById("archived-chat-banner");
    if (archivedBanner) archivedBanner.style.display = "none";
    const inputCard = document.querySelector(".input-card");
    if (inputCard) inputCard.classList.remove("archived-readonly");
    const promptInput = document.getElementById("prompt-input");
    if (promptInput) {
      promptInput.disabled = false;
      promptInput.placeholder = "Ask anything, @ to mention, / for actions";
    }
    if (mainContainer) mainContainer.classList.remove("has-history");
    if (topbarProj) {
      const activeProjectEl = document.getElementById("active-project-name");
      const activeDisplay = activeProjectEl ? activeProjectEl.innerText : "";
      topbarProj.innerText = activeDisplay || (activeProjectPath ? (activeProjectPath.split(/[/\\]/).filter(Boolean).pop() || "Project") : "No project");
    }
    renderRightSidebarRawOutputList();
    updateReviewChangesTabVisibility();
    if (typeof updateScrollToBottomButton === "function") {
      updateScrollToBottomButton();
    }
    return;
  }

  const conv = appConversations.find(c => c.id === activeConversationId);
  if (!conv) return;

  if (!isThisConvExecuting) {
    const lastTurnModel = typeof getLastMessageModelFromConv === "function"
      ? getLastMessageModelFromConv(conv)
      : (conv.model || conv.ai_model || "");
    if (lastTurnModel) {
      conv.model = lastTurnModel;
      if (activeAiModel !== lastTurnModel) {
        if (typeof applyModelSelectionFromHistory === "function") {
          applyModelSelectionFromHistory(lastTurnModel, conv.projectId || conv.project_id || activeProjectPath);
        } else {
          activeAiModel = lastTurnModel;
          if (typeof window !== "undefined") window.activeAiModel = lastTurnModel;
          localStorage.setItem("orborus_ai_model", lastTurnModel);
          if (typeof updateActiveModelLabel === "function") updateActiveModelLabel();
        }
      }
    }
  }

  setChatMode(true);
  if (mainContainer) mainContainer.classList.add("has-history");
  const activeProjName = conv.projectName || conv.project_name || (conv.projectId === "" || conv.project_id === "" ? "No project" : "Orborus Agent Runner");
  if (topbarProj) topbarProj.innerText = activeProjName;
  if (topbarConv) topbarConv.innerText = conv.title || "Conversation";

  const isConvArchived = !!(conv.archived || conv.is_archived);
  const archivedBanner = document.getElementById("archived-chat-banner");
  if (archivedBanner) {
    archivedBanner.style.display = isConvArchived ? "flex" : "none";
  }
  const inputCard = document.querySelector(".input-card");
  if (inputCard) {
    inputCard.classList.toggle("archived-readonly", isConvArchived);
  }
  const promptInput = document.getElementById("prompt-input");
  if (promptInput) {
    promptInput.disabled = isConvArchived;
    promptInput.placeholder = isConvArchived
      ? "Unarchive this conversation to continue chatting..."
      : "Ask anything, @ to mention, / for actions";
  }

  const archiveBtn = document.getElementById("btn-archive-active-chat");
  if (archiveBtn) {
    archiveBtn.style.display = "inline-flex";
    if (isConvArchived) {
      archiveBtn.classList.add("is-archived-pill");
      archiveBtn.title = "Unarchive conversation and restore to left sidebar";
      archiveBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="21 8 21 21 3 21 3 8"/>
          <rect x="1" y="3" width="22" height="5"/>
          <line x1="12" y1="16" x2="12" y2="11"/>
          <polyline points="9 13 12 10 15 13"/>
        </svg>
        <span style="margin-left:4px; font-size:11px; font-weight:500;">Unarchive</span>
      `;
      archiveBtn.onclick = (e) => unarchiveConversation(conv.id, e);
    } else {
      archiveBtn.classList.remove("is-archived-pill");
      archiveBtn.title = "Archive conversation (moves to Conversation History)";
      archiveBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="21 8 21 21 3 21 3 8"/>
          <rect x="1" y="3" width="22" height="5"/>
          <line x1="10" y1="12" x2="14" y2="12"/>
        </svg>
      `;
      archiveBtn.onclick = (e) => archiveConversation(conv.id, e);
    }
  }

  // Normalize legacy conversation structure to turns if needed
  if ((!conv.turns || conv.turns.length === 0) && conv.prompt) {
    conv.turns = [{
      id: conv.id + "-1",
      prompt: conv.prompt,
      timestamp: conv.created_at || "",
      steps: conv.steps || [],
      output: conv.output || "",
      status: "success"
    }];
  }

  if (Array.isArray(conv.turns) && typeof deduplicateConversationTurns === "function") {
    conv.turns = deduplicateConversationTurns(conv.turns);
  }

  // Preserve current scroll state for already-visited conversations before clearing DOM
  if (typeof conversationScrollState !== "undefined" && conversationScrollState[activeConversationId] && !_isRestoringScroll) {
    if (typeof saveCurrentConversationScrollState === "function") {
      saveCurrentConversationScrollState(activeConversationId);
    }
  }
  _isRestoringScroll = true;

  // Render all conversation turns sequentially in the stream
  if (turnsContainer) {
    turnsContainer.innerHTML = "";
    (conv.turns || []).forEach((turn, idx) => {
      const turnEl = renderTurnElement(turn, idx, conv.id);
      turnsContainer.appendChild(turnEl);
    });
  }

  renderRightSidebarRawOutputList();
  refreshActiveTurnRawOutputView();
  updateReviewChangesTabVisibility();

  // Render connected queue shelf at bottom (kept out of active conversation turns stream)
  renderPromptQueueShelf();

  // Clean in-flight active turn elements if not executing in this conversation
  if (promptCard && (!stepsContainer || stepsContainer.children.length === 0 || !isThisConvExecuting)) {
    promptCard.style.display = "none";
    promptCard.innerText = "";
  }
  const summaryBanner = document.getElementById("activity-summary-banner");
  if (summaryBanner && (!stepsContainer || stepsContainer.children.length === 0 || !isThisConvExecuting)) {
    summaryBanner.style.display = "none";
  }

  // Extract running tasks strictly from decisions of in-flight turns of the running conversation
  let runningTasksFound = [];
  if (isThisConvExecuting) {
    (conv.turns || []).forEach(turn => {
      if (turn.status === "running") {
        const turnDecisions = turn.decisions || (turn.workflow_execution && turn.workflow_execution.decisions) || [];
        const extracted = extractRunningTasksFromDecisions(turnDecisions);
        if (extracted.length > 0) {
          runningTasksFound.push(...extracted);
        }
      }
    });
  }
  activeRunningTasks = runningTasksFound;
  renderRunningTasks();

  // Check if any step in any turn or the live globalApprovalQueue has a pending approval
  let hasPendingApproval = false;
  (conv.turns || []).forEach(turn => {
    (turn.steps || []).forEach(step => {
      if (step.type === "approval_pending") {
        hasPendingApproval = true;
        currentApprovalId = step.id;
        currentApprovalCmd = step.cmd || "~/git/orborus $ git show 1981257 --stat";
        currentApprovalCmdPrefix = step.cmdPrefix || "git show";
        currentApprovalDesc = step.desc || "Allow viewing commit 1981257?";
        currentApprovalProject = conv.projectName || conv.project_name;

        showApprovalCard({
          id: step.id,
          cmd: currentApprovalCmd,
          prefix: currentApprovalCmdPrefix,
          desc: currentApprovalDesc,
          project: currentApprovalProject
        });
      }
    });
  });

  if (!hasPendingApproval && Array.isArray(globalApprovalQueue) && globalApprovalQueue.length > 0) {
    const queueMatch = globalApprovalQueue.find(q => !q.conversation_id || q.conversation_id === conv.id) || (isThisConvExecuting ? globalApprovalQueue[0] : null);
    if (queueMatch) {
      hasPendingApproval = true;
      if (typeof showApprovalCard === "function") {
        showApprovalCard(queueMatch);
      }
    }
  }

  if (!hasPendingApproval && approvalCard) {
    approvalCard.classList.remove("visible");
    const dockContainer = document.getElementById("chat-dock-container");
    if (dockContainer) dockContainer.classList.remove("has-approval-card");
  }

  // Restore saved scroll position for this conversation (or scroll 100% to bottom on first open / when bottom-locked)
  if (typeof applyConversationScrollState === "function") {
    applyConversationScrollState(activeConversationId);
  }
}

function toggleStep(stepId) {
  const row = document.getElementById("step-row-" + stepId);
  if (!row) return;
  row.classList.toggle("expanded");
  const isExpanded = row.classList.contains("expanded");
  const conv = appConversations.find(c => c.id === activeConversationId);
  if (!conv) return;
  if (conv.steps) {
    const s = conv.steps.find(st => st.id === stepId);
    if (s) s.collapsed = !isExpanded;
  }
  if (conv.turns) {
    conv.turns.forEach(t => {
      if (t.steps) {
        const s = t.steps.find(st => st.id === stepId);
        if (s) s.collapsed = !isExpanded;
      }
    });
  }
  if (typeof updateScrollToBottomButton === "function") {
    setTimeout(updateScrollToBottomButton, 20);
  }
}


// Initialize controls and right sidebar overview on page load
document.addEventListener("DOMContentLoaded", () => {
  if (typeof updateActiveModelLabel === "function") {
    updateActiveModelLabel();
  }
  if (typeof updateActiveReasoningLabel === "function") {
    updateActiveReasoningLabel();
  }
  if (typeof loadRightSidebarOverview === "function") {
    loadRightSidebarOverview();
  }

  const executionStream = document.getElementById("execution-stream");
  if (executionStream) {
    const cancelProgrammaticScroll = () => {
      if (typeof clearPendingScrollRestoreTimers === "function") {
        clearPendingScrollRestoreTimers();
      }
      _isRestoringScroll = false;
    };
    executionStream.addEventListener("wheel", cancelProgrammaticScroll, { passive: true });
    executionStream.addEventListener("touchstart", cancelProgrammaticScroll, { passive: true });
    executionStream.addEventListener("mousedown", (e) => {
      // If user clicks near the scrollbar thumb/track, cancel programmatic scroll timers
      if (e.offsetX >= executionStream.clientWidth - 16) {
        cancelProgrammaticScroll();
      }
    });
    executionStream.addEventListener("scroll", () => {
      if (!_isRestoringScroll && typeof saveCurrentConversationScrollState === "function") {
        saveCurrentConversationScrollState();
      }
      if (typeof updateScrollToBottomButton === "function") {
        updateScrollToBottomButton();
      }
    }, { passive: true });
  }

  const promptInput = document.getElementById("prompt-input");
  if (promptInput) {
    promptInput.addEventListener("paste", async (e) => {
      if (!e.clipboardData || !e.clipboardData.files || e.clipboardData.files.length === 0) return;
      e.preventDefault();
      const files = Array.from(e.clipboardData.files);
      for (const file of files) {
        if (typeof readBrowserFileAsAttachment === "function") {
          const att = await readBrowserFileAsAttachment(file);
          if (att && typeof addPendingAttachmentObject === "function") {
            addPendingAttachmentObject(att);
          }
        }
      }
    });
  }

  const inputCard = document.querySelector(".input-card");
  if (inputCard) {
    inputCard.addEventListener("dragover", (e) => {
      e.preventDefault();
    });
    inputCard.addEventListener("drop", async (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files);
      for (const file of files) {
        if (typeof readBrowserFileAsAttachment === "function") {
          const att = await readBrowserFileAsAttachment(file);
          if (att && typeof addPendingAttachmentObject === "function") {
            addPendingAttachmentObject(att);
          }
        }
      }
    });
  }

  if (typeof updateShuffleToolsButtonVisibility === "function") {
    updateShuffleToolsButtonVisibility();
  }
});

// ==========================================
// SHUFFLE APP TOOLS ATTACHMENT (LIVE & PRE-RUN)
// ==========================================

window.DEFAULT_SHUFFLE_SHARED_SKILLS = [
  {
    id: "build-workflows",
    name: "Workflow Builder",
    description: "Create, update, debug, and run Shuffle workflows using shuffle_apps and shuffle_workflows_builder.",
    template: "build-workflows",
    required_apps: ["shuffle_apps", "shuffle_workflows_builder"],
    tools: [
      { app_name: "shuffle_apps", app_id: "7db43ccd25261967b095cfbd467a75cc", label: "Shuffle Apps" },
      { app_name: "shuffle_workflows_builder", app_id: "de4ef2287bd41b9d5563e39989643ee6", label: "Shuffle Workflows Builder" }
    ],
    instructions: "Use shuffle_apps to inspect apps and actions, and shuffle_workflows_builder to create, update, debug, and execute Shuffle workflows."
  },
  {
    id: "host-monitor-control",
    name: "Host Monitor & Computer Use",
    description: "Control and monitor target endpoints, VMs, and browsers using shuffle_host_monitors.",
    template: "host-monitor-control",
    required_apps: ["shuffle_host_monitors"],
    tools: [
      { app_name: "shuffle_host_monitors", app_id: "48a954b9440b3913b8a2620e57b94a75", label: "Shuffle Host Monitors" }
    ],
    instructions: "Use shuffle_host_monitors to list monitors, inspect status, take screenshots, and execute commands or UI actions on monitored hosts."
  },
  {
    id: "incident-handler",
    name: "Incident Handler",
    description: "Investigate, triage, document, and resolve security incidents using shuffle_incidents.",
    template: "incident-handler",
    required_apps: ["shuffle_incidents"],
    tools: [
      { app_name: "shuffle_incidents", app_id: "shuffle_incidents", label: "Shuffle Incidents" }
    ],
    instructions: "Use shuffle_incidents to list, inspect, update, and add notes or tasks to incidents during investigation and response."
  },
  {
    id: "vulnerability",
    name: "Vulnerability Management",
    description: "Discover, prioritize, track, and remediate vulnerabilities using shuffle_vulnerabilities.",
    template: "vulnerability",
    required_apps: ["shuffle_vulnerabilities"],
    tools: [
      { app_name: "shuffle_vulnerabilities", app_id: "shuffle_vulnerabilities", label: "Shuffle Vulnerabilities" }
    ],
    instructions: "Use shuffle_vulnerabilities to search, filter, update severity/status, and manage vulnerability remediation workflows."
  }
];
window.shuffleSharedSkillsCatalog = Array.isArray(window.shuffleSharedSkillsCatalog) && window.shuffleSharedSkillsCatalog.length > 0
  ? window.shuffleSharedSkillsCatalog
  : window.DEFAULT_SHUFFLE_SHARED_SKILLS.slice();
window.attachedShuffleSkills = Array.isArray(window.attachedShuffleSkills) ? window.attachedShuffleSkills : [];
window.shuffleAuthenticatedApps = Array.isArray(window.shuffleAuthenticatedApps) ? window.shuffleAuthenticatedApps : [];
window.attachedShuffleTools = Array.isArray(window.attachedShuffleTools) ? window.attachedShuffleTools : [];
window.shuffleToolsLoading = false;
window.shuffleToolsSearchQuery = "";

try {
  const savedAttached = localStorage.getItem("orborus_attached_shuffle_tools");
  const savedAttachedSkills = localStorage.getItem("orborus_attached_shuffle_skills");
  if (savedAttachedSkills) {
    const parsedSkills = JSON.parse(savedAttachedSkills);
    if (Array.isArray(parsedSkills)) {
      window.attachedShuffleSkills = parsedSkills.filter(Boolean);
    }
  }
  if (savedAttached) {
    const parsed = JSON.parse(savedAttached);
    if (Array.isArray(parsed)) {
      window.attachedShuffleTools = parsed;
    }
  }
} catch (_) {}

function isShuffleAiAuthenticated() {
  const rawKey = (typeof savedAiApiKey !== "undefined" && savedAiApiKey ? savedAiApiKey : (localStorage.getItem("orborus_ai_api_key") || "")).trim();
  const hasShflKey = rawKey.startsWith("shfl_");
  return Boolean(window.oauthLoggedIn || (typeof isLoggedIn !== "undefined" && isLoggedIn) || hasShflKey);
}

function updateShuffleToolsButtonVisibility() {
  const wrapper = document.getElementById("shuffle-tools-picker-wrapper");
  const lbl = document.getElementById("lbl-active-shuffle-tools");
  const authed = isShuffleAiAuthenticated();
  if (wrapper) {
    wrapper.style.display = "inline-flex";
  }
  const count = Array.isArray(window.attachedShuffleTools) ? window.attachedShuffleTools.length : 0;
  if (lbl) {
    lbl.innerText = count > 0 ? `Tools (${count})` : "Tools";
  }
  if (wrapper) {
    wrapper.style.display = authed ? "inline-flex" : "none";
  }
  const skillCount = Array.isArray(window.attachedShuffleSkills) ? window.attachedShuffleSkills.length : 0;
  const btnPlus = document.getElementById("btn-prompt-plus");
  if (btnPlus) {
    btnPlus.classList.toggle("has-attached-skills", skillCount > 0);
    btnPlus.title = skillCount > 0
      ? `Add File, Context, or Shuffle Skill (${skillCount} attached)`
      : "Add File, Context, or Shuffle Skill";
  }
  if (typeof renderPromptPlusMenu === "function") {
    if (true) {
      renderPromptPlusMenu();
    }
  }
  const btnPicker = document.getElementById("btn-shuffle-tools-picker");
  if (btnPicker) {
    const hasValid = Array.isArray(window.attachedShuffleTools) && window.attachedShuffleTools.some(t => Boolean(t && (t.valid || (t.validation && t.validation.valid))));
    btnPicker.classList.toggle("has-valid-tool", hasValid);
  }
  renderAttachedShuffleToolsBar();
}

function normalizeShuffleToolImageSrc(raw) {
  if (!raw || typeof raw !== "string") return "";
  let s = raw.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!s || s === "null" || s === "undefined") return "";
  const lower = s.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    return s;
  }
  if (s.startsWith("/") && !s.startsWith("/9j/")) {
    return "https://shuffler.io" + s;
  }
  const cleaned = s.replace(/\s+/g, "");
  const lowerCleaned = cleaned.toLowerCase();
  if (lowerCleaned.startsWith("data:image")) {
    const dupIdx = lowerCleaned.indexOf("data:image", 10);
    const deduped = dupIdx !== -1 ? cleaned.slice(dupIdx) : cleaned;
    if (deduped.toLowerCase().startsWith("data:image;base64,")) {
      return "data:image/png;base64," + deduped.slice("data:image;base64,".length);
    }
    return deduped;
  }
  if (cleaned.startsWith("iVBOR")) return "data:image/png;base64," + cleaned;
  if (cleaned.startsWith("/9j/")) return "data:image/jpeg;base64," + cleaned;
  if (cleaned.startsWith("R0lGOD")) return "data:image/gif;base64," + cleaned;
  if (cleaned.startsWith("UklGR")) return "data:image/webp;base64," + cleaned;
  if (cleaned.startsWith("PHN2Zy") || cleaned.startsWith("PD94bW")) return "data:image/svg+xml;base64," + cleaned;
  if (cleaned.length > 64 && !/[<>{}[\]"'\\]/.test(cleaned)) {
    return "data:image/png;base64," + cleaned;
  }
  return "";
}

function renderShuffleToolIconHtml(tool, sizeClass = "item-icon") {
  const src = normalizeShuffleToolImageSrc(tool && (tool.large_image || tool.small_image || ""));
  const isValid = Boolean(tool && (tool.valid || (tool.validation && tool.validation.valid)));
  const validClass = isValid ? " valid" : "";
  const validDot = isValid ? `<span class="shuffle-tool-valid-dot" title="Valid authentication"></span>` : "";
  const fallbackSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect></svg>`;
  if (!src) {
    return `<span class="shuffle-tool-icon-wrap ${sizeClass}${validClass}"><span class="shuffle-tool-icon-fallback">${fallbackSvg}</span>${validDot}</span>`;
  }
  return `<span class="shuffle-tool-icon-wrap ${sizeClass}${validClass}"><img class="shuffle-tool-icon" src="${escapeHtml(src)}" alt="" loading="lazy" onerror="this.style.display='none';if(this.nextElementSibling)this.nextElementSibling.style.display='inline-flex';" /><span class="shuffle-tool-icon-fallback" style="display:none;">${fallbackSvg}</span>${validDot}</span>`;
}
function unusedRenderShuffleToolIconHtmlOld(tool, sizeClass = "item-icon") {
  const src = normalizeShuffleToolImageSrc(tool && (tool.large_image || tool.small_image || ""));
  const fallbackSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect></svg>`;
  if (!src) {
    return `<span class="shuffle-tool-icon-wrap ${sizeClass}"><span class="shuffle-tool-icon-fallback">${fallbackSvg}</span></span>`;
  }
  return `<span class="shuffle-tool-icon-wrap ${sizeClass}"><img class="shuffle-tool-icon" src="${escapeHtml(src)}" alt="" loading="lazy" onerror="this.style.display='none';if(this.nextElementSibling)this.nextElementSibling.style.display='inline-flex';" /><span class="shuffle-tool-icon-fallback" style="display:none;">${fallbackSvg}</span></span>`;
}

function renderAttachedShuffleToolsBar() {
  const bar = document.getElementById("shuffle-attached-tools-bar");
  if (!bar) return;
  const authed = isShuffleAiAuthenticated();
  const tools = Array.isArray(window.attachedShuffleTools) ? window.attachedShuffleTools : [];
  const skillIds = Array.isArray(window.attachedShuffleSkills) ? window.attachedShuffleSkills : [];
  const catalog = Array.isArray(window.shuffleSharedSkillsCatalog) && window.shuffleSharedSkillsCatalog.length > 0
    ? window.shuffleSharedSkillsCatalog
    : (window.DEFAULT_SHUFFLE_SHARED_SKILLS || []);
  const attachedSkills = skillIds.map(id => catalog.find(s => s && s.id === id) || { id: id, name: id, template: id, required_apps: [] });
  if (attachedSkills.length === 0 && (!authed || tools.length === 0)) {
    bar.style.display = "none";
    bar.innerHTML = "";
    return;
  }
  bar.style.display = "flex";
  const skillChipsHtml = attachedSkills.map(skill => {
    const safeSkillId = escapeHtml(skill.id || "");
    const skillName = skill.name || skill.id || "Skill";
    const reqApps = Array.isArray(skill.required_apps) && skill.required_apps.length > 0
      ? skill.required_apps.join(", ")
      : (Array.isArray(skill.tools) ? skill.tools.map(t => t.app_name).filter(Boolean).join(", ") : "");
    const titleText = `${skillName} (Template: ${skill.template || skill.id}${reqApps ? " · Tools: " + reqApps : ""})`;
    return `
      <div class="shuffle-tool-chip" title="${escapeHtml(titleText)}">
        <span class="shuffle-tool-icon-wrap chip-icon"><span class="shuffle-tool-icon-fallback"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg></span></span>
        <span>${escapeHtml(skillName)}</span>
        ${reqApps ? `<span class="shuffle-skill-tag">${escapeHtml(reqApps)}</span>` : ""}
        <button type="button" class="shuffle-tool-chip-remove" onclick="removeAttachedShuffleSkill('${safeSkillId}', event)" title="Detach skill template &amp; tools">&times;</button>
      </div>
    `;
  }).join("");
  const toolChipsHtml = (authed ? tools : []).map(tool => {
    const appName = (tool.app_name || "App").replace(/_/g, " ");
    const label = tool.label && tool.label !== tool.app_name ? ` (${tool.label})` : "";
    const safeId = escapeHtml(tool.auth_id || tool.app_id || "");
    return `
      <div class="shuffle-tool-chip" title="${escapeHtml(appName + label + (tool.app_version ? " v" + tool.app_version : ""))}">
        ${renderShuffleToolIconHtml(tool, "chip-icon")}
        <span>${escapeHtml(appName)}${escapeHtml(label)}</span>
        <button type="button" class="shuffle-tool-chip-remove" onclick="removeAttachedShuffleTool('${safeId}', event)" title="Detach tool">&times;</button>
      </div>
    `;
  }).join("");
  bar.innerHTML = skillChipsHtml + toolChipsHtml;
}

function unusedRenderAttachedShuffleToolsBarLegacy() {
  const bar = document.getElementById("shuffle-attached-tools-bar");
  if (!bar) return;
  const authed = isShuffleAiAuthenticated();
  const tools = Array.isArray(window.attachedShuffleTools) ? window.attachedShuffleTools : [];
  if (!authed || tools.length === 0) {
    bar.style.display = "none";
    bar.innerHTML = "";
    return;
  }
  bar.style.display = "flex";
  bar.innerHTML = tools.map(tool => {
    const appName = (tool.app_name || "App").replace(/_/g, " ");
    const label = tool.label && tool.label !== tool.app_name ? ` (${tool.label})` : "";
    const safeId = escapeHtml(tool.auth_id || tool.app_id || "");
    return `
      <div class="shuffle-tool-chip" title="${escapeHtml(appName + label + (tool.app_version ? " v" + tool.app_version : ""))}">
        ${renderShuffleToolIconHtml(tool, "chip-icon")}
        <span>${escapeHtml(appName)}${escapeHtml(label)}</span>
        <button type="button" class="shuffle-tool-chip-remove" onclick="removeAttachedShuffleTool('${safeId}', event)" title="Detach tool">&times;</button>
      </div>
    `;
  }).join("");
}

async function toggleShuffleToolsDropdown(event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  const menu = document.getElementById("shuffle-tools-dropdown-menu");
  if (!menu) return;

  const modelMenu = document.getElementById("model-dropdown-menu");
  if (modelMenu) modelMenu.classList.remove("visible");
  const reasoningMenu = document.getElementById("reasoning-dropdown-menu");
  if (reasoningMenu) reasoningMenu.classList.remove("visible");

  const isVisible = menu.classList.contains("visible");
  if (typeof closeAllDropdowns === "function") {
    closeAllDropdowns(["shuffle-tools-dropdown-menu"]);
  }
  if (isVisible) {
    menu.classList.remove("visible");
    window.shuffleAuthSetupState = null;
    return;
  }

  menu.classList.add("visible");
  renderShuffleToolsDropdown();

  if (
    !window.shuffleAuthenticatedApps ||
    window.shuffleAuthenticatedApps.length === 0 ||
    !window.shuffleCatalogApps ||
    window.shuffleCatalogApps.length === 0
  ) {
    await refreshShuffleAuthenticatedApps();
  }
}

async function refreshShuffleAuthenticatedApps(event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  if (typeof callGo !== "function") return;
  window.shuffleToolsLoading = true;
  renderShuffleToolsDropdown(true);
  try {
    const reqPayload = JSON.stringify({
      query: String(window.shuffleToolsSearchQuery || "").trim(),
      force_refresh: Boolean(event)
    });
    const raw = await callGo("getShuffleAuthenticatedApps", reqPayload);
    const parsed = raw ? JSON.parse(raw) : {};
    if (Array.isArray(parsed.apps)) {
      window.shuffleAuthenticatedApps = parsed.apps;
    } else if (Array.isArray(parsed)) {
      window.shuffleAuthenticatedApps = parsed;
    } else {
      window.shuffleAuthenticatedApps = [];
    }
    if (Array.isArray(parsed.catalog)) {
      window.shuffleCatalogApps = parsed.catalog;
    }
  } catch (err) {
    console.warn("[Shuffle Tools] Failed to fetch authenticated & catalog apps:", err);
  } finally {
    window.shuffleToolsLoading = false;
    renderShuffleToolsDropdown(true);
  }
}

async function searchShuffleAppsCatalog(query) {
  if (typeof callGo !== "function") return;
  const trimmed = String(query || "").trim();
  window.shuffleCatalogSearching = true;
  renderShuffleToolsDropdown(true);
  try {
    const raw = await callGo("searchShuffleApps", JSON.stringify({
      query: trimmed,
      force_refresh: false
    }));
    const parsed = raw ? JSON.parse(raw) : {};
    if (String(window.shuffleToolsSearchQuery || "").trim() !== trimmed) {
      return;
    }
    if (Array.isArray(parsed.apps)) {
      window.shuffleAuthenticatedApps = parsed.apps;
    }
    if (Array.isArray(parsed.catalog)) {
      window.shuffleCatalogApps = parsed.catalog;
    }
  } catch (err) {
    console.warn("[Shuffle Tools] Algolia app search failed:", err);
  } finally {
    if (String(window.shuffleToolsSearchQuery || "").trim() === trimmed) {
      window.shuffleCatalogSearching = false;
      renderShuffleToolsDropdown(true);
    }
  }
}

function toggleShuffleToolsValidFilter(event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  window.shuffleToolsOnlyValid = !window.shuffleToolsOnlyValid;
  renderShuffleToolsDropdown();
}

function filterShuffleToolsList(query) {
  window.shuffleToolsSearchQuery = String(query || "");
  renderShuffleToolsDropdown(true);
  if (window._shuffleToolsSearchTimer) {
    clearTimeout(window._shuffleToolsSearchTimer);
  }
  window._shuffleToolsSearchTimer = setTimeout(() => {
    searchShuffleAppsCatalog(window.shuffleToolsSearchQuery);
  }, 180);
}

function togglePromptPlusMenu(event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  const menu = document.getElementById("prompt-plus-menu");
  if (!menu) return;

  const modelMenu = document.getElementById("model-dropdown-menu");
  if (modelMenu) modelMenu.classList.remove("visible");
  const reasoningMenu = document.getElementById("reasoning-dropdown-menu");
  if (reasoningMenu) reasoningMenu.classList.remove("visible");
  const toolsMenu = document.getElementById("shuffle-tools-dropdown-menu");
  if (toolsMenu) toolsMenu.classList.remove("visible");

  const isVisible = menu.classList.contains("visible");
  if (typeof closeAllDropdowns === "function") {
    closeAllDropdowns(["prompt-plus-menu"]);
  }
  if (isVisible) {
    menu.classList.remove("visible");
    window.promptPlusSkillsSubmenuOpen = false;
    return;
  }

  window.promptPlusSkillsSubmenuOpen = false;
  menu.classList.add("visible");
  renderPromptPlusMenu();
}

function togglePromptPlusSkillsSubmenu(event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  window.promptPlusSkillsSubmenuOpen = !window.promptPlusSkillsSubmenuOpen;
  const wrap = document.getElementById("prompt-plus-skills-wrap");
  if (wrap) {
    wrap.classList.toggle("open", Boolean(window.promptPlusSkillsSubmenuOpen));
  }
}

function triggerAddFileFromPlusMenu(event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  window.promptPlusSkillsSubmenuOpen = false;
  const menu = document.getElementById("prompt-plus-menu");
  if (menu) menu.classList.remove("visible");
  if (typeof addFileContext === "function") {
    addFileContext();
  }
}

async function clearAttachedShuffleSkills(event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  window.attachedShuffleSkills = [];
  try {
    localStorage.setItem("orborus_attached_shuffle_skills", "[]");
  } catch (_) {}
  updateShuffleToolsButtonVisibility();
  renderPromptPlusMenu();
  if (typeof renderSkillsView === "function") {
    renderSkillsView();
  }
  await syncAttachedShuffleSkillsToBackend(null, false);
}

function renderPromptPlusMenu() {
  const menu = document.getElementById("prompt-plus-menu");
  if (!menu) return;

  const catalog = Array.isArray(window.shuffleSharedSkillsCatalog) && window.shuffleSharedSkillsCatalog.length > 0
    ? window.shuffleSharedSkillsCatalog
    : (window.DEFAULT_SHUFFLE_SHARED_SKILLS || []);
  const attachedSkillIds = new Set(Array.isArray(window.attachedShuffleSkills) ? window.attachedShuffleSkills : []);

  const skillsHtml = catalog.map(skill => {
    const sid = String(skill.id || "");
    const isSkillAttached = attachedSkillIds.has(sid);
    const reqApps = Array.isArray(skill.required_apps) && skill.required_apps.length > 0
      ? skill.required_apps.join(", ")
      : (Array.isArray(skill.tools) ? skill.tools.map(t => t.app_name).filter(Boolean).join(", ") : "");
    const metaParts = [];
    if (reqApps) metaParts.push("Tools: " + reqApps);
    if (skill.description) metaParts.push(skill.description);
    const metaText = metaParts.join(" · ");
    return `
      <div class="shuffle-tool-item ${isSkillAttached ? "attached" : ""}" onclick="window.promptPlusSkillsSubmenuOpen=true;toggleAttachShuffleSkill('${escapeHtml(sid)}', event)">
        <span class="shuffle-tool-icon-wrap item-icon"><span class="shuffle-tool-icon-fallback"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg></span></span>
        <div class="shuffle-tool-info">
          <div class="shuffle-tool-name">${escapeHtml(skill.name || sid)}<span class="shuffle-skill-tag">${escapeHtml(skill.template || sid)}</span></div>
          <div class="shuffle-tool-meta" title="${escapeHtml(metaText)}">${escapeHtml(metaText)}</div>
        </div>
        <div class="shuffle-tool-check">${isSkillAttached ? "✓" : ""}</div>
      </div>
    `;
  }).join("");

  const isSubmenuOpen = Boolean(window.promptPlusSkillsSubmenuOpen);

  menu.innerHTML = `
    <div class="prompt-plus-action-item" onmouseenter="window.promptPlusSkillsSubmenuOpen=false;const w=document.getElementById('prompt-plus-skills-wrap');if(w)w.classList.remove('open');" onclick="triggerAddFileFromPlusMenu(event)">
      <span class="prompt-plus-action-left">
        <span class="prompt-plus-action-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>
        </span>
        <span>Add File or Image...</span>
      </span>
    </div>
    <div class="prompt-plus-divider"></div>
    <div id="prompt-plus-skills-wrap" class="prompt-plus-submenu-wrap ${isSubmenuOpen ? "open" : ""}">
      <div class="prompt-plus-action-item" onclick="togglePromptPlusSkillsSubmenu(event)">
        <span class="prompt-plus-action-left">
          <span class="prompt-plus-action-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
          </span>
          <span>Skills</span>
        </span>
        <span class="prompt-plus-action-right">
          ${attachedSkillIds.size > 0 ? `<span class="shuffle-skill-tag">${attachedSkillIds.size}</span>` : ""}
          <svg class="prompt-plus-submenu-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </span>
      </div>
      <div id="prompt-plus-skills-submenu" class="prompt-plus-submenu" onclick="event.stopPropagation()">
        <div class="prompt-plus-section-header">
          <span class="prompt-plus-section-label">Shuffle Skills (Template &amp; Tools)</span>
          ${attachedSkillIds.size > 0 ? `<button type="button" class="shuffle-tools-action-btn" onclick="clearAttachedShuffleSkills(event)">Clear</button>` : ""}
        </div>
        <div class="shuffle-tools-list">
          ${skillsHtml}
        </div>
      </div>
    </div>
  `;
}

function renderShuffleToolsDropdown(preserveSearchFocus = false) {
  const menu = document.getElementById("shuffle-tools-dropdown-menu");
  if (!menu) return;

  // If the user is currently in the inline App Authentication setup view, render that view
  if (window.shuffleAuthSetupState && window.shuffleAuthSetupState.appId) {
    renderShuffleAppAuthSetupView(menu, window.shuffleAuthSetupState);
    return;
  }

  const apps = Array.isArray(window.shuffleAuthenticatedApps) ? window.shuffleAuthenticatedApps : [];
  const allApps = Array.isArray(window.shuffleAllCatalogApps) ? window.shuffleAllCatalogApps : [];
  const attached = Array.isArray(window.attachedShuffleTools) ? window.attachedShuffleTools : [];
  const attachedIds = new Set(attached.map(t => t.auth_id || t.app_id));
  const q = (window.shuffleToolsSearchQuery || "").trim().toLowerCase();

  const sortedApps = [...apps].sort((a, b) => {
    const ca = Number(a && a.created) || 0;
    const cb = Number(b && b.created) || 0;
    if (cb !== ca) return cb - ca;
    const va = Boolean(a && (a.valid || (a.validation && a.validation.valid))) ? 1 : 0;
    const vb = Boolean(b && (b.valid || (b.validation && b.validation.valid))) ? 1 : 0;
    if (vb !== va) return vb - va;
    return String((a && a.app_name) || "").localeCompare(String((b && b.app_name) || ""));
  });
  const filteredAuthApps = sortedApps.filter(app => {
    const isValid = Boolean(app && (app.valid || (app.validation && app.validation.valid)));
    if (window.shuffleToolsOnlyValid && !isValid) return false;
    if (!q) return true;
    const name = String(app.app_name || "").toLowerCase();
    const label = String(app.label || "").toLowerCase();
    const desc = String(app.description || "").toLowerCase();
    return name.includes(q) || label.includes(q) || desc.includes(q);
  });

  // Deduplicate catalog apps that are NOT already shown in filteredAuthApps
  const shownAuthKeys = new Set(filteredAuthApps.map(a => a.auth_id || a.app_id));
  const shownAppIds = new Set(filteredAuthApps.map(a => a.app_id).filter(Boolean));
  const shownNormNames = new Set(filteredAuthApps.map(a => String(a.app_name || "").toLowerCase().replace(/[\s_-]+/g, "")).filter(Boolean));

  const unauthenticatedCatalogApps = [];
  for (const catApp of allApps) {
    if (!catApp || !catApp.app_id) continue;
    const key = catApp.auth_id || catApp.app_id;
    const normName = String(catApp.app_name || "").toLowerCase().replace(/[\s_-]+/g, "");
    if (shownAuthKeys.has(key) || shownAppIds.has(catApp.app_id) || (normName && shownNormNames.has(normName))) {
      continue;
    }
    if (window.shuffleToolsOnlyValid) {
      const isValid = Boolean(catApp.valid || (catApp.validation && catApp.validation.valid));
      if (!isValid) continue;
    }
    unauthenticatedCatalogApps.push(catApp);
    shownAppIds.add(catApp.app_id);
    if (normName) shownNormNames.add(normName);
  }

  const renderAppRow = (app, isCatalogUnauth = false) => {
    const key = app.auth_id || app.app_id || "";
    const isAttached = attachedIds.has(key) || attachedIds.has("noauth:" + app.app_id) || attachedIds.has(app.app_id);
    const displayApp = (app.app_name || "Unknown App").replace(/_/g, " ");
    const isAuthenticated = Boolean(app.authenticated || app.auth_id);
    const isValid = Boolean(app && (app.valid || (app.validation && app.validation.valid)));
    const metaParts = [];
    if (isAuthenticated) {
      if (isValid) metaParts.push("Valid");
      if (app.label && app.label !== app.app_name) metaParts.push(app.label);
      if (app.app_version) metaParts.push("v" + app.app_version);
      if (app.actions_count > 0) metaParts.push(app.actions_count + " actions");
    } else {
      metaParts.push("Not authenticated");
      if (app.actions_count > 0) metaParts.push(app.actions_count + " actions");
      if (Array.isArray(app.categories) && app.categories.length > 0) metaParts.push(app.categories[0]);
      else if (app.description) metaParts.push(String(app.description).slice(0, 46));
    }
    const metaText = metaParts.join(" · ") || (isAuthenticated ? "Authenticated" : "Available via Algolia");

    if (!isAuthenticated && isCatalogUnauth) {
      return `
        <div class="shuffle-tool-item ${isAttached ? "attached" : ""}" onclick="openShuffleAppAuthSetup('${escapeHtml(app.app_id)}', event)">
          ${renderShuffleToolIconHtml(app, "item-icon")}
          <div class="shuffle-tool-info">
            <div class="shuffle-tool-name">${escapeHtml(displayApp)}</div>
            <div class="shuffle-tool-meta">${escapeHtml(metaText)}</div>
          </div>
          <div class="shuffle-tool-right">
            <button type="button" class="shuffle-tool-auth-pill" onclick="openShuffleAppAuthSetup('${escapeHtml(app.app_id)}', event)" title="Configure authentication for ${escapeHtml(displayApp)}">Authenticate</button>
            ${isAttached ? `<div class="shuffle-tool-check">✓</div>` : ""}
          </div>
        </div>
      `;
    }

    return `
      <div class="shuffle-tool-item ${isAttached ? "attached" : ""}" onclick="toggleAttachShuffleTool('${escapeHtml(key)}', event)">
        ${renderShuffleToolIconHtml(app, "item-icon")}
        <div class="shuffle-tool-info">
          <div class="shuffle-tool-name">${escapeHtml(displayApp)}</div>
          <div class="shuffle-tool-meta">${escapeHtml(metaText)}</div>
        </div>
        <div class="shuffle-tool-right">
          ${app.app_id ? `<button type="button" class="shuffle-tool-auth-pill" onclick="openShuffleAppAuthSetup('${escapeHtml(app.app_id)}', event)" title="Add new authentication for ${escapeHtml(displayApp)}">+ Auth</button>` : ""}
          <div class="shuffle-tool-check">${isAttached ? "✓" : ""}</div>
        </div>
      </div>
    `;
  };

  let listHtml = "";
  if (window.shuffleToolsLoading && filteredAuthApps.length === 0 && unauthenticatedCatalogApps.length === 0) {
    listHtml = `<div class="shuffle-tools-empty">Loading apps from Shuffle...</div>`;
  } else {
    if (filteredAuthApps.length > 0) {
      listHtml += `<div class="shuffle-tools-section-label">Authenticated in Tenant (${filteredAuthApps.length})</div>`;
      listHtml += filteredAuthApps.map(app => renderAppRow(app, false)).join("");
    }
    if (!window.shuffleToolsOnlyValid) {
      if (unauthenticatedCatalogApps.length > 0) {
        listHtml += `<div class="shuffle-tools-section-label">${q ? `All Apps Matching "${escapeHtml(window.shuffleToolsSearchQuery)}"` : "Discover & Authenticate Apps"} (${unauthenticatedCatalogApps.length})</div>`;
        listHtml += unauthenticatedCatalogApps.map(app => renderAppRow(app, true)).join("");
      } else if (window.shuffleToolsAlgoliaLoading) {
        listHtml += `<div class="shuffle-tools-empty">Searching Shuffle app catalog...</div>`;
      }
    }
    if (!listHtml) {
      if (q) {
        listHtml = `<div class="shuffle-tools-empty">No matching apps for "${escapeHtml(window.shuffleToolsSearchQuery)}".</div>`;
      } else if (window.shuffleToolsOnlyValid) {
        listHtml = `<div class="shuffle-tools-empty">No valid authenticated apps found.<br/>Disable the "Valid" filter to browse and authenticate apps.</div>`;
      } else {
        listHtml = `<div class="shuffle-tools-empty">No apps found. Try searching for an app above.</div>`;
      }
    }
  }

  if (preserveSearchFocus && menu.querySelector(".shuffle-tools-list")) {
    const listEl = menu.querySelector(".shuffle-tools-list");
    if (listEl) listEl.innerHTML = listHtml;
    return;
  }

  menu.innerHTML = `
    <div class="shuffle-tools-header" onclick="event.stopPropagation()">
      <span class="shuffle-tools-title">Shuffle App Tools (${attached.length} attached)</span>
      <div class="shuffle-tools-actions">
        ${attached.length > 0 ? `<button type="button" class="shuffle-tools-action-btn" onclick="clearAllAttachedShuffleTools(event)">Clear</button>` : ""}
        <button type="button" class="shuffle-tools-action-btn ${window.shuffleToolsOnlyValid ? "active" : ""}" onclick="toggleShuffleToolsValidFilter(event)" title="Filter to valid authentications only">Valid</button>
        <button type="button" class="shuffle-tools-action-btn" onclick="refreshShuffleAuthenticatedApps(event)">Refresh</button>
      </div>
    </div>
    <div class="shuffle-tools-search-wrap" onclick="event.stopPropagation()">
      <input type="text" class="shuffle-tools-search-input" placeholder="Search all Shuffle apps (Algolia)..." value="${escapeHtml(window.shuffleToolsSearchQuery || "")}" oninput="filterShuffleToolsList(this.value)" />
    </div>
    <div class="shuffle-tools-list" onclick="event.stopPropagation()">
      ${listHtml}
    </div>
  `;
}

function renderShuffleAppAuthSetupView(menu, state) {
  const displayApp = (state.appName || "App").replace(/_/g, " ");
  const iconHtml = renderShuffleToolIconHtml({
    app_name: state.appName,
    large_image: state.largeImage,
    valid: false
  }, "item-icon");

  let bodyHtml = "";
  if (state.loading) {
    bodyHtml = `<div class="shuffle-tools-empty">Loading authentication configuration for ${escapeHtml(displayApp)}...</div>`;
  } else if (state.error && (!Array.isArray(state.fields) || state.fields.length === 0) && state.authNotRequired !== true) {
    bodyHtml = `
      <div class="shuffle-auth-setup-body">
        <div class="shuffle-auth-status-msg error">${escapeHtml(state.error)}</div>
      </div>
    `;
  } else if (state.authNotRequired) {
    bodyHtml = `
      <div class="shuffle-auth-setup-body">
        <div class="shuffle-auth-status-msg">This app does not require authentication (${escapeHtml(state.authType || "no-auth")}). You can attach it directly or save a named profile.</div>
        <div class="shuffle-auth-field">
          <div class="shuffle-auth-field-label"><span>Label (optional)</span></div>
          <input type="text" class="shuffle-auth-field-input" id="shuffle-auth-setup-label" placeholder="${escapeHtml(displayApp)} Default" value="${escapeHtml(state.label || (displayApp + " Auth"))}" />
        </div>
      </div>
      <div class="shuffle-auth-setup-footer">
        <button type="button" class="shuffle-tools-action-btn" onclick="closeShuffleAppAuthSetup(event)">Cancel</button>
        <button type="button" class="shuffle-auth-submit-btn" onclick="attachShuffleAppWithoutAuth('${escapeHtml(state.appId)}', event)">Attach Without Auth</button>
      </div>
    `;
  } else {
    const fields = Array.isArray(state.fields) ? state.fields : [];
    const fieldsHtml = fields.map((f, idx) => {
      const fname = String(f.name || "");
      const flabel = String(f.label || fname).replace(/_/g, " ");
      const isSecret = Boolean(f.secret) || /key|token|secret|password|passwd|bearer/i.test(fname);
      const placeholder = f.example ? String(f.example) : (fname === "url" ? "https://api.example.com" : `Enter ${flabel}...`);
      const savedVal = (state.values && state.values[fname] !== undefined) ? state.values[fname] : (f.value || "");
      return `
        <div class="shuffle-auth-field">
          <div class="shuffle-auth-field-label">
            <span>${escapeHtml(flabel)}</span>
            ${f.required !== false ? `<span class="shuffle-auth-field-req">Required</span>` : ""}
          </div>
          ${f.description ? `<div class="shuffle-auth-field-desc">${escapeHtml(f.description)}</div>` : ""}
          <input
            type="${isSecret ? "password" : "text"}"
            class="shuffle-auth-field-input shuffle-auth-param-input"
            data-param-name="${escapeHtml(fname)}"
            data-param-idx="${idx}"
            placeholder="${escapeHtml(placeholder)}"
            value="${escapeHtml(savedVal)}"
          />
        </div>
      `;
    }).join("");

    bodyHtml = `
      <div class="shuffle-auth-setup-body">
        ${state.error ? `<div class="shuffle-auth-status-msg error">${escapeHtml(state.error)}</div>` : ""}
        <div class="shuffle-auth-field">
          <div class="shuffle-auth-field-label">
            <span>Authentication Label</span>
            <span class="shuffle-auth-field-req">Required</span>
          </div>
          <input type="text" class="shuffle-auth-field-input" id="shuffle-auth-setup-label" placeholder="e.g. Production ${escapeHtml(displayApp)}" value="${escapeHtml(state.label || (displayApp + " Auth"))}" />
        </div>
        ${fieldsHtml}
      </div>
      <div class="shuffle-auth-setup-footer">
        <button type="button" class="shuffle-tools-action-btn" onclick="closeShuffleAppAuthSetup(event)">Cancel</button>
        <button type="button" class="shuffle-auth-submit-btn" ${state.submitting ? "disabled" : ""} onclick="submitShuffleAppAuthSetup(event)">
          ${state.submitting ? "Authenticating..." : "Save & Attach"}
        </button>
      </div>
    `;
  }

  menu.innerHTML = `
    <div class="shuffle-auth-setup-header" onclick="event.stopPropagation()">
      <div class="shuffle-tool-info" style="display:flex;align-items:center;gap:8px;">
        ${iconHtml}
        <div>
          <div class="shuffle-tool-name">Authenticate ${escapeHtml(displayApp)}</div>
          <div class="shuffle-tool-meta">${escapeHtml(state.appVersion ? "v" + state.appVersion : "App Authentication")}</div>
        </div>
      </div>
      <button type="button" class="shuffle-auth-back-btn" onclick="closeShuffleAppAuthSetup(event)">← Back</button>
    </div>
    <div onclick="event.stopPropagation()">
      ${bodyHtml}
    </div>
  `;
}

async function openShuffleAppAuthSetup(appId, event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  const id = String(appId || "").trim();
  if (!id || typeof callGo !== "function") return;

  const allApps = [
    ...(Array.isArray(window.shuffleAuthenticatedApps) ? window.shuffleAuthenticatedApps : []),
    ...(Array.isArray(window.shuffleAllCatalogApps) ? window.shuffleAllCatalogApps : [])
  ];
  const known = allApps.find(a => a && a.app_id === id) || {};

  window.shuffleAuthSetupState = {
    appId: id,
    appName: known.app_name || "App",
    appVersion: known.app_version || "",
    largeImage: known.large_image || "",
    loading: true,
    submitting: false,
    error: "",
    fields: [],
    values: {},
    label: ((known.app_name || "App").replace(/_/g, " ")) + " Auth"
  };
  renderShuffleToolsDropdown();

  try {
    const raw = await callGo("getShuffleAppAuthConfig", JSON.stringify({ app_id: id }));
    const parsed = raw ? JSON.parse(raw) : {};
    if (!window.shuffleAuthSetupState || window.shuffleAuthSetupState.appId !== id) return;
    if (parsed.error) {
      window.shuffleAuthSetupState.loading = false;
      window.shuffleAuthSetupState.error = parsed.error;
    } else {
      window.shuffleAuthSetupState.loading = false;
      window.shuffleAuthSetupState.appName = parsed.app_name || window.shuffleAuthSetupState.appName;
      window.shuffleAuthSetupState.appVersion = parsed.app_version || window.shuffleAuthSetupState.appVersion;
      window.shuffleAuthSetupState.largeImage = parsed.large_image || window.shuffleAuthSetupState.largeImage;
      window.shuffleAuthSetupState.fields = Array.isArray(parsed.fields) ? parsed.fields : [];
      window.shuffleAuthSetupState.authNotRequired = parsed.authentication_required === false || window.shuffleAuthSetupState.fields.length === 0;
      window.shuffleAuthSetupState.authType = parsed.auth_type || "";
      const cleanName = (window.shuffleAuthSetupState.appName || "App").replace(/_/g, " ");
      window.shuffleAuthSetupState.label = cleanName + " Auth";
      const defaultVals = {};
      for (const f of window.shuffleAuthSetupState.fields) {
        if (f && f.name && f.value) {
          defaultVals[f.name] = f.value;
        }
      }
      window.shuffleAuthSetupState.values = defaultVals;
    }
  } catch (err) {
    if (window.shuffleAuthSetupState && window.shuffleAuthSetupState.appId === id) {
      window.shuffleAuthSetupState.loading = false;
      window.shuffleAuthSetupState.error = String(err && err.message ? err.message : err);
    }
  }
  renderShuffleToolsDropdown();
}

function closeShuffleAppAuthSetup(event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  window.shuffleAuthSetupState = null;
  renderShuffleToolsDropdown();
}

async function attachShuffleAppWithoutAuth(appId, event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  const id = String(appId || "").trim();
  if (!id) return;
  const state = window.shuffleAuthSetupState || {};
  const allApps = [
    ...(Array.isArray(window.shuffleAuthenticatedApps) ? window.shuffleAuthenticatedApps : []),
    ...(Array.isArray(window.shuffleAllCatalogApps) ? window.shuffleAllCatalogApps : [])
  ];
  const known = allApps.find(a => a && a.app_id === id) || {};
  const tool = {
    auth_id: "noauth:" + id,
    label: state.label || known.label || known.app_name || "No-Auth App",
    app_id: id,
    app_name: state.appName || known.app_name || "",
    app_version: state.appVersion || known.app_version || "",
    large_image: state.largeImage || known.large_image || "",
    actions_count: known.actions_count || 0,
    created: Math.floor(Date.now() / 1000),
    valid: true,
    authenticated: true
  };
  if (!Array.isArray(window.attachedShuffleTools)) {
    window.attachedShuffleTools = [];
  }
  const existingIdx = window.attachedShuffleTools.findIndex(t => t.app_id === id || t.auth_id === tool.auth_id);
  if (existingIdx >= 0) {
    window.attachedShuffleTools[existingIdx] = tool;
  } else {
    window.attachedShuffleTools.push(tool);
  }
  try {
    localStorage.setItem("orborus_attached_shuffle_tools", JSON.stringify(window.attachedShuffleTools));
  } catch (_) {}
  window.shuffleAuthSetupState = null;
  updateShuffleToolsButtonVisibility();
  renderShuffleToolsDropdown();
  await syncAttachedShuffleToolsToBackend(tool, true);
}

async function submitShuffleAppAuthSetup(event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  const state = window.shuffleAuthSetupState;
  if (!state || !state.appId || state.submitting || typeof callGo !== "function") return;

  const labelEl = document.getElementById("shuffle-auth-setup-label");
  const label = labelEl ? String(labelEl.value || "").trim() : state.label;
  const paramInputs = document.querySelectorAll(".shuffle-auth-param-input");
  const fieldsMap = {};
  paramInputs.forEach(inp => {
    const pname = inp.getAttribute("data-param-name");
    if (pname) {
      fieldsMap[pname] = String(inp.value || "").trim();
    }
  });
  state.label = label;
  state.values = fieldsMap;

  // Validate required fields
  const reqFields = Array.isArray(state.fields) ? state.fields : [];
  for (const f of reqFields) {
    if (f && f.name && f.required !== false && !fieldsMap[f.name]) {
      state.error = `Please provide a value for "${(f.label || f.name).replace(/_/g, " ")}".`;
      renderShuffleToolsDropdown();
      return;
    }
  }

  state.submitting = true;
  state.error = "";
  renderShuffleToolsDropdown();

  try {
    const raw = await callGo("authenticateShuffleApp", JSON.stringify({
      app_id: state.appId,
      app_name: state.appName,
      app_version: state.appVersion,
      large_image: state.largeImage,
      label: label,
      fields: fieldsMap
    }));
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed.error || !parsed.success) {
      state.submitting = false;
      state.error = parsed.error || "Failed to save authentication.";
      renderShuffleToolsDropdown();
      return;
    }

    const newTool = parsed.tool;
    window.shuffleAuthSetupState = null;
    await refreshShuffleAuthenticatedApps();

    if (newTool && (newTool.auth_id || newTool.app_id)) {
      if (!Array.isArray(window.attachedShuffleTools)) {
        window.attachedShuffleTools = [];
      }
      const key = newTool.auth_id || newTool.app_id;
      const existingIdx = window.attachedShuffleTools.findIndex(t => (t.auth_id || t.app_id) === key);
      if (existingIdx >= 0) {
        window.attachedShuffleTools[existingIdx] = newTool;
      } else {
        window.attachedShuffleTools.push(newTool);
      }
      try {
        localStorage.setItem("orborus_attached_shuffle_tools", JSON.stringify(window.attachedShuffleTools));
      } catch (_) {}
      updateShuffleToolsButtonVisibility();
      renderShuffleToolsDropdown();
      await syncAttachedShuffleToolsToBackend(newTool, true);
      if (typeof showToast === "function") {
        const display = (newTool.app_name || "App").replace(/_/g, " ");
        showToast(`Authenticated & attached ${display}`);
      }
    }
  } catch (err) {
    state.submitting = false;
    state.error = String(err && err.message ? err.message : err);
    renderShuffleToolsDropdown();
  }
}

window.openShuffleAppAuthSetup = openShuffleAppAuthSetup;
window.closeShuffleAppAuthSetup = closeShuffleAppAuthSetup;
window.attachShuffleAppWithoutAuth = attachShuffleAppWithoutAuth;
window.submitShuffleAppAuthSetup = submitShuffleAppAuthSetup;

function unusedRenderShuffleToolsDropdownLegacy(preserveSearchFocus = false) {
  const menu = document.getElementById("shuffle-tools-dropdown-menu");
  if (!menu) return;

  const apps = Array.isArray(window.shuffleAuthenticatedApps) ? window.shuffleAuthenticatedApps : [];
  const attached = Array.isArray(window.attachedShuffleTools) ? window.attachedShuffleTools : [];
  const attachedIds = new Set(attached.map(t => t.auth_id || t.app_id));
  const q = (window.shuffleToolsSearchQuery || "").trim().toLowerCase();

  const sortedApps = [...apps].sort((a, b) => {
    const ca = Number(a && a.created) || 0;
    const cb = Number(b && b.created) || 0;
    if (cb !== ca) return cb - ca;
    const va = Boolean(a && (a.valid || (a.validation && a.validation.valid))) ? 1 : 0;
    const vb = Boolean(b && (b.valid || (b.validation && b.validation.valid))) ? 1 : 0;
    if (vb !== va) return vb - va;
    return String((a && a.app_name) || "").localeCompare(String((b && b.app_name) || ""));
  });
  const filtered = sortedApps.filter(app => {
    const isValid = Boolean(app && (app.valid || (app.validation && app.validation.valid)));
    if (window.shuffleToolsOnlyValid && !isValid) return false;
    if (!q) return true;
    const name = String(app.app_name || "").toLowerCase();
    const label = String(app.label || "").toLowerCase();
    return name.includes(q) || label.includes(q);
  });

  let listHtml = "";
  if (window.shuffleToolsLoading) {
    listHtml = `<div class="shuffle-tools-empty">Loading authenticated apps from Shuffle...</div>`;
  } else if (apps.length === 0) {
    listHtml = `<div class="shuffle-tools-empty">No authenticated apps found in this tenant.<br/>Authenticate apps in Shuffle to attach them here.</div>`;
  } else if (filtered.length === 0) {
    listHtml = `<div class="shuffle-tools-empty">No matching apps for "${escapeHtml(window.shuffleToolsSearchQuery)}".</div>`;
  } else {
    listHtml = filtered.map(app => {
      const key = app.auth_id || app.app_id || "";
      const isAttached = attachedIds.has(key);
      const displayApp = (app.app_name || "Unknown App").replace(/_/g, " ");
      const metaParts = [];
      const isValid = Boolean(app && (app.valid || (app.validation && app.validation.valid)));
      if (isValid) metaParts.push("Valid");
      if (app.label && app.label !== app.app_name) metaParts.push(app.label);
      if (app.app_version) metaParts.push("v" + app.app_version);
      if (app.actions_count > 0) metaParts.push(app.actions_count + " actions");
      const metaText = metaParts.join(" · ") || "Authenticated";
      return `
        <div class="shuffle-tool-item ${isAttached ? "attached" : ""}" onclick="toggleAttachShuffleTool('${escapeHtml(key)}', event)">
          ${renderShuffleToolIconHtml(app, "item-icon")}
          <div class="shuffle-tool-info">
            <div class="shuffle-tool-name">${escapeHtml(displayApp)}</div>
            <div class="shuffle-tool-meta">${escapeHtml(metaText)}</div>
          </div>
          <div class="shuffle-tool-check">${isAttached ? "✓" : ""}</div>
        </div>
      `;
    }).join("");
  }

  if (preserveSearchFocus && menu.querySelector(".shuffle-tools-list")) {
    const listEl = menu.querySelector(".shuffle-tools-list");
    if (listEl) listEl.innerHTML = listHtml;
    return;
  }

  menu.innerHTML = `
    <div class="shuffle-tools-header" onclick="event.stopPropagation()">
      <span class="shuffle-tools-title">Shuffle App Tools (${attached.length} attached)</span>
      <div class="shuffle-tools-actions">
        ${attached.length > 0 ? `<button type="button" class="shuffle-tools-action-btn" onclick="clearAllAttachedShuffleTools(event)">Clear</button>` : ""}
        <button type="button" class="shuffle-tools-action-btn ${window.shuffleToolsOnlyValid ? "active" : ""}" onclick="toggleShuffleToolsValidFilter(event)" title="Filter to valid authentications only">Valid</button>
        <button type="button" class="shuffle-tools-action-btn" onclick="refreshShuffleAuthenticatedApps(event)">Refresh</button>
      </div>
    </div>
    <div class="shuffle-tools-search-wrap" onclick="event.stopPropagation()">
      <input type="text" class="shuffle-tools-search-input" placeholder="Filter authenticated apps..." value="${escapeHtml(window.shuffleToolsSearchQuery || "")}" oninput="filterShuffleToolsList(this.value)" />
    </div>
    <div class="shuffle-tools-list" onclick="event.stopPropagation()">
      ${listHtml}
    </div>
  `;
}

async function toggleAttachShuffleTool(authOrAppId, event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  const key = String(authOrAppId || "").trim();
  if (!key) return;

  if (!Array.isArray(window.attachedShuffleTools)) {
    window.attachedShuffleTools = [];
  }

  const existingIdx = window.attachedShuffleTools.findIndex(t => (t.auth_id || t.app_id) === key);
  let attachedNow = false;
  let targetTool = null;

  if (existingIdx >= 0) {
    targetTool = window.attachedShuffleTools[existingIdx];
    window.attachedShuffleTools.splice(existingIdx, 1);
  } else {
    const apps = [
      ...(Array.isArray(window.shuffleAuthenticatedApps) ? window.shuffleAuthenticatedApps : []),
      ...(Array.isArray(window.shuffleAllCatalogApps) ? window.shuffleAllCatalogApps : [])
    ];
    const found = apps.find(a => (a.auth_id || a.app_id) === key);
    if (found) {
      if (!found.authenticated && !found.auth_id) {
        openShuffleAppAuthSetup(found.app_id, event);
        return;
      }
      targetTool = {
        auth_id: found.auth_id || "",
        label: found.label || found.app_name || "",
        app_id: found.app_id || "",
        app_name: found.app_name || "",
        app_version: found.app_version || "",
        large_image: found.large_image || "",
        actions_count: found.actions_count || 0,
        created: found.created || 0,
        valid: Boolean(found.valid || (found.validation && found.validation.valid))
      };
      window.attachedShuffleTools.push(targetTool);
      attachedNow = true;
    }
  }

  try {
    localStorage.setItem("orborus_attached_shuffle_tools", JSON.stringify(window.attachedShuffleTools));
  } catch (_) {}

  updateShuffleToolsButtonVisibility();
  renderShuffleToolsDropdown();
  await syncAttachedShuffleToolsToBackend(targetTool, attachedNow);
}

async function removeAttachedShuffleTool(authOrAppId, event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  const key = String(authOrAppId || "").trim();
  if (!key || !Array.isArray(window.attachedShuffleTools)) return;

  const idx = window.attachedShuffleTools.findIndex(t => (t.auth_id || t.app_id) === key);
  if (idx < 0) return;
  const removed = window.attachedShuffleTools[idx];
  window.attachedShuffleTools.splice(idx, 1);

  try {
    localStorage.setItem("orborus_attached_shuffle_tools", JSON.stringify(window.attachedShuffleTools));
  } catch (_) {}

  updateShuffleToolsButtonVisibility();
  renderShuffleToolsDropdown();
  await syncAttachedShuffleToolsToBackend(removed, false);
}

async function clearAllAttachedShuffleTools(event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  window.attachedShuffleTools = [];
  try {
    localStorage.setItem("orborus_attached_shuffle_tools", "[]");
    if (false) syncAttachedShuffleSkillsToBackend(null, false);
  } catch (_) {}
  updateShuffleToolsButtonVisibility();
  renderShuffleToolsDropdown();
  await syncAttachedShuffleToolsToBackend(null, false);
}

async function syncAttachedShuffleToolsToBackend(changedTool, attachedNow) {
  if (typeof callGo !== "function") return;
  const tools = Array.isArray(window.attachedShuffleTools) ? window.attachedShuffleTools : [];
  const convIds = new Set([""]);
  if (typeof activeConversationId !== "undefined" && activeConversationId) {
    convIds.add(activeConversationId);
  }
  if (typeof runningConversationId !== "undefined" && runningConversationId) {
    convIds.add(runningConversationId);
  }

  for (const cid of convIds) {
    try {
      await callGo("setConversationShuffleTools", JSON.stringify({
        conversation_id: cid,
        tools: tools
      }));
    } catch (err) {
      console.warn("[Shuffle Tools] Failed to sync attached tools for conversation:", cid, err);
    }
  }

  if (typeof isPromptExecuting !== "undefined" && isPromptExecuting && changedTool && typeof showToast === "function") {
    const name = (changedTool.app_name || changedTool.label || "App").replace(/_/g, " ");
    if (attachedNow) {
      showToast(`Attached ${name} to running agent (active on next step)`);
    } else {
      showToast(`Detached ${name} from running agent`);
    }
  }
}

async function refreshShuffleSharedSkills() {
  if (typeof callGo !== "function") return;
  try {
    const cid = (typeof activeConversationId !== "undefined" && activeConversationId) ? activeConversationId : "";
    const raw = await callGo("getShuffleSharedSkills", JSON.stringify({ conversation_id: cid }));
    const parsed = raw ? JSON.parse(raw) : {};
    if (Array.isArray(parsed.skills) && parsed.skills.length > 0) {
      window.shuffleSharedSkillsCatalog = parsed.skills;
    }
    if (Array.isArray(parsed.attached_ids) && (!Array.isArray(window.attachedShuffleSkills) || window.attachedShuffleSkills.length === 0)) {
      window.attachedShuffleSkills = parsed.attached_ids;
    }
  } catch (err) {
    console.warn("[Shuffle Skills] Failed to fetch shuffle-shared skills:", err);
  }
  updateShuffleToolsButtonVisibility();
  renderPromptPlusMenu();
  if (typeof renderSkillsView === "function") {
    renderSkillsView();
  }
}

async function toggleAttachShuffleSkill(skillId, event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  const sid = String(skillId || "").trim();
  if (!sid) return;
  if (!Array.isArray(window.attachedShuffleSkills)) {
    window.attachedShuffleSkills = [];
  }
  const idx = window.attachedShuffleSkills.indexOf(sid);
  let attachedNow = false;
  if (idx >= 0) {
    window.attachedShuffleSkills.splice(idx, 1);
  } else {
    window.attachedShuffleSkills.push(sid);
    attachedNow = true;
  }
  try {
    localStorage.setItem("orborus_attached_shuffle_skills", JSON.stringify(window.attachedShuffleSkills));
  } catch (_) {}

  const catalog = Array.isArray(window.shuffleSharedSkillsCatalog) && window.shuffleSharedSkillsCatalog.length > 0
    ? window.shuffleSharedSkillsCatalog
    : (window.DEFAULT_SHUFFLE_SHARED_SKILLS || []);
  const skillObj = catalog.find(s => s && s.id === sid) || { id: sid, name: sid };

  updateShuffleToolsButtonVisibility();
  renderPromptPlusMenu();
  if (typeof renderSkillsView === "function") {
    renderSkillsView();
  }
  await syncAttachedShuffleSkillsToBackend(skillObj, attachedNow);
}

async function removeAttachedShuffleSkill(skillId, event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  const sid = String(skillId || "").trim();
  if (!sid || !Array.isArray(window.attachedShuffleSkills)) return;
  const idx = window.attachedShuffleSkills.indexOf(sid);
  if (idx < 0) return;
  window.attachedShuffleSkills.splice(idx, 1);
  try {
    localStorage.setItem("orborus_attached_shuffle_skills", JSON.stringify(window.attachedShuffleSkills));
  } catch (_) {}

  const catalog = Array.isArray(window.shuffleSharedSkillsCatalog) && window.shuffleSharedSkillsCatalog.length > 0
    ? window.shuffleSharedSkillsCatalog
    : (window.DEFAULT_SHUFFLE_SHARED_SKILLS || []);
  const skillObj = catalog.find(s => s && s.id === sid) || { id: sid, name: sid };

  updateShuffleToolsButtonVisibility();
  renderPromptPlusMenu();
  if (typeof renderSkillsView === "function") {
    renderSkillsView();
  }
  await syncAttachedShuffleSkillsToBackend(skillObj, false);
}

async function syncAttachedShuffleSkillsToBackend(changedSkill, attachedNow) {
  if (typeof callGo !== "function") return;
  const skillIds = Array.isArray(window.attachedShuffleSkills) ? window.attachedShuffleSkills : [];
  const convIds = new Set([""]);
  if (typeof activeConversationId !== "undefined" && activeConversationId) {
    convIds.add(activeConversationId);
  }
  if (typeof runningConversationId !== "undefined" && runningConversationId) {
    convIds.add(runningConversationId);
  }
  for (const cid of convIds) {
    try {
      await callGo("setConversationShuffleSkills", JSON.stringify({
        conversation_id: cid,
        skills: skillIds
      }));
    } catch (err) {
      console.warn("[Shuffle Skills] Failed to sync attached shuffle skills for conversation:", cid, err);
    }
  }
  if (changedSkill && typeof showToast === "function") {
    const name = changedSkill.name || changedSkill.id || "Skill";
    if (attachedNow) {
      showToast(`Attached skill "${name}" (template & tools)`);
    } else {
      showToast(`Detached skill "${name}"`);
    }
  }
}

function unusedSyncShuffleToolsTailPlaceholder() {
  if (false) {
    if (false) {
    }
  }
}



