// --- Window Controls & Global Shortcuts ---
function windowControl(action) {
  if (window.windowAction) {
    window.windowAction(action);
  } else {
    console.log("[WINDOW] Action:", action);
  }
}

// Global Cmd+A / Ctrl+A handler for textareas, inputs, and text content
document.addEventListener("keydown", function(e) {
  if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
      active.select();
    }
  }
});


// --- Window Dragging, Modals & Native File Dialogs ---
function toggleSidebar() {
  const sidebar = document.querySelector(".sidebar");
  if (!sidebar) return;
  const isCollapsed = sidebar.classList.toggle("collapsed");
  const toggleBtn = document.getElementById("btn-toggle-sidebar");
  if (toggleBtn) {
    toggleBtn.setAttribute("title", isCollapsed ? "Expand Sidebar" : "Contract Sidebar");
  }
}

function setRightSidebarFullscreen(isFull) {
  const sidebar = document.getElementById("preview-sidebar");
  const appBody = document.querySelector(".app-body");
  const mainWorkspace = document.getElementById("main-container") || document.querySelector(".main-workspace");
  const btn = document.getElementById("btn-rs-action-expand");

  if (sidebar) {
    sidebar.classList.toggle("expanded", !!isFull);
  }
  if (appBody) {
    appBody.classList.toggle("rs-fullscreen", !!isFull);
  }
  if (mainWorkspace) {
    mainWorkspace.style.display = isFull ? "none" : "";
  }
  if (btn) {
    btn.classList.toggle("active", !!isFull);
    btn.setAttribute("title", isFull ? "Exit Fullscreen" : "Toggle Fullscreen");
    btn.innerHTML = isFull
      ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`
      : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
  }
}

function toggleRightSidebar() {
  const sidebar = document.getElementById("preview-sidebar");
  if (!sidebar) return;
  const isHidden = sidebar.style.display === "none" || !sidebar.style.display;
  const btnTopbar = document.getElementById("btn-toggle-right-sidebar");

  if (isHidden) {
    sidebar.style.display = "flex";
    if (btnTopbar) {
      btnTopbar.classList.add("active");
      btnTopbar.setAttribute("title", "Contract Right Sidebar");
    }
    if (typeof currentRightTab === "undefined" || currentRightTab === "overview") {
      if (typeof switchRightSidebarTab === "function") {
        switchRightSidebarTab("overview");
      }
    }
  } else {
    setRightSidebarFullscreen(false);
    sidebar.style.display = "none";
    if (btnTopbar) {
      btnTopbar.classList.remove("active");
      btnTopbar.setAttribute("title", "Expand Right Sidebar");
    }
  }
}

function toggleRightSidebarMaximize() {
  const sidebar = document.getElementById("preview-sidebar");
  if (!sidebar) return;
  const isMax = !sidebar.classList.contains("expanded");
  if (isMax && (sidebar.style.display === "none" || !sidebar.style.display)) {
    sidebar.style.display = "flex";
    const btnTopbar = document.getElementById("btn-toggle-right-sidebar");
    if (btnTopbar) {
      btnTopbar.classList.add("active");
      btnTopbar.setAttribute("title", "Contract Right Sidebar");
    }
  }
  setRightSidebarFullscreen(isMax);
}

function reportTitlebarNoDragWidth() {
  const leftEl = document.querySelector(".titlebar-left");
  if (leftEl) {
    const rect = leftEl.getBoundingClientRect();
    const width = Math.ceil(rect.right);
    if (window.setTitlebarNoDragWidth) {
      window.setTitlebarNoDragWidth(width);
    }
  }
}

function checkModalActive() {
  const hasModal = !!document.querySelector(".modal-overlay.visible");
  if (window.setModalActive) {
    window.setModalActive(hasModal);
  }
}

function setupWindowDragging() {
  window.addEventListener("resize", reportTitlebarNoDragWidth);
  setTimeout(reportTitlebarNoDragWidth, 200);
  setTimeout(reportTitlebarNoDragWidth, 1000);

  const modalObserver = new MutationObserver(checkModalActive);
  modalObserver.observe(document.body, { attributes: true, subtree: true, attributeFilter: ["class"] });

  window.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return; // Left click only
    const isTopHeader = !!e.target.closest(".app-titlebar, .window-drag-area");
    const isNoDrag = !!e.target.closest("button, input, select, textarea, a, .no-drag, .traffic-lights, .dot, .nav-icon-btn, .btn-new-chat, .project-folder-actions, .btn-pin-toggle, .win-control-btn, .win-window-controls");

    if (isTopHeader && !isNoDrag) {
      if (typeof window.startWindowDrag === "function") {
        window.startWindowDrag();
      } else if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.windowDrag) {
        window.webkit.messageHandlers.windowDrag.postMessage("");
      } else if (typeof window.windowAction === "function") {
        window.windowAction("drag");
      }
    }
  }, true);

  window.addEventListener("dblclick", (e) => {
    if (e.button !== 0) return;
    const isTopHeader = !!e.target.closest(".app-titlebar, .window-drag-area");
    const isNoDrag = !!e.target.closest("button, input, select, textarea, a, .no-drag, .traffic-lights, .dot, .nav-icon-btn, .btn-new-chat, .project-folder-actions, .btn-pin-toggle, .win-control-btn, .win-window-controls");

    if (isTopHeader && !isNoDrag) {
      if (typeof window.windowAction === "function") {
        window.windowAction("maximize");
      }
    }
  }, true);
}

function openCustomDirModal() {
  browseNativeDirectory();
}

async function chooseCustomDirectory() {
  await browseNativeDirectory();
}

function closeCustomDirModal() {
  const modal = document.getElementById("custom-dir-modal");
  if (modal) modal.classList.remove("visible");
  if (typeof checkModalActive === "function") checkModalActive();
}

async function handleOpenOrSelectDirectory(rawPath) {
  if (!rawPath || !rawPath.trim()) return;
  const path = rawPath.trim();
  const getNorm = (typeof normPath === "function") ? normPath : (p => (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase());
  const targetNorm = getNorm(path);

  // 1. Check if it matches an existing project in allProjects or stored conversations
  let matchedProject = null;
  if (Array.isArray(allProjects)) {
    matchedProject = allProjects.find(p => {
      const pNorm = getNorm(p.Path || p.path);
      return pNorm === targetNorm;
    });
  }

  if (!matchedProject && Array.isArray(appConversations)) {
    const matchConv = appConversations.find(c => {
      if (!c) return false;
      const cNorm = getNorm(c.projectId || c.project_id);
      return cNorm === targetNorm;
    });
    if (matchConv) {
      const foundName = matchConv.projectName || matchConv.project_name || path.split(/[/\\]/).filter(Boolean).pop() || "Project";
      matchedProject = { Name: foundName, Path: path };
    }
  }

  let finalName = "";
  if (matchedProject) {
    // Existing project found: activate it
    finalName = matchedProject.Name || matchedProject.name || path.split(/[/\\]/).filter(Boolean).pop() || "Project";
  } else {
    // New project: create instantly
    finalName = path.split(/[/\\]/).filter(Boolean).pop() || "Project";
    const newProj = { Name: finalName, Path: path };
    if (typeof mergeProjects === "function") {
      mergeProjects([newProj]);
    } else {
      if (!Array.isArray(allProjects)) allProjects = [];
      allProjects.unshift(newProj);
      if (typeof saveStoredProjects === "function") saveStoredProjects();
    }
  }

  // Ensure this project is expanded in the sidebar
  if (typeof collapsedProjects !== "undefined" && collapsedProjects) {
    collapsedProjects[path] = false;
    if (matchedProject && (matchedProject.Path || matchedProject.path)) {
      collapsedProjects[matchedProject.Path || matchedProject.path] = false;
    }
    try {
      localStorage.setItem("orborus_collapsed_projects", JSON.stringify(collapsedProjects));
    } catch (e) {}
  }

  // Switch to project and start/switch conversation
  await selectProject(path, finalName, { switchConversation: true });

  if (typeof renderProjectTree === "function") {
    renderProjectTree();
  }
  if (typeof renderSettingsProjectsList === "function") {
    renderSettingsProjectsList();
  }

  showToast(matchedProject ? ("Switched to project: " + finalName) : ("Project created: " + finalName));
}
if (typeof window !== "undefined") {
  window.handleOpenOrSelectDirectory = handleOpenOrSelectDirectory;
}

async function browseNativeDirectory() {
  toggleProjectDropdown(null, false);
  try {
    if (window.chooseDirectory) {
      const raw = await window.chooseDirectory();
      let selectedPath = "";
      if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.status === "ok" && parsed.path) {
            selectedPath = parsed.path;
          }
        } catch (e) {
          selectedPath = raw;
        }
      } else if (raw && raw.path) {
        selectedPath = raw.path;
      }
      if (selectedPath && selectedPath.trim()) {
        await handleOpenOrSelectDirectory(selectedPath.trim());
      }
    } else {
      showToast("Native directory browser not supported in web mode");
    }
  } catch (err) {
    console.error("Browse directory error:", err);
  }
}

async function submitCustomDir() {
  const input = document.getElementById("input-custom-dir-path");
  const path = input ? input.value.trim() : "";
  if (path) {
    await handleOpenOrSelectDirectory(path);
    closeCustomDirModal();
  }
}

if (typeof window !== "undefined") {
  window.pendingAttachments = window.pendingAttachments || [];
}

async function addFileContext() {
  try {
    let raw = null;
    if (typeof window.chooseFile === "function") {
      raw = await window.chooseFile();
    } else if (typeof window.agentBridge !== "undefined" && window.agentBridge && typeof window.agentBridge.handleAction === "function") {
      raw = await window.agentBridge.handleAction("chooseFile", "");
    }
    if (raw) {
      let selectedFile = "";
      if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.status === "ok" && parsed.path) {
            selectedFile = parsed.path;
          } else if (parsed && parsed.status === "cancelled") {
            return;
          }
        } catch (e) {
          selectedFile = raw;
        }
      } else if (raw && raw.path) {
        selectedFile = raw.path;
      } else if (raw && raw.status === "cancelled") {
        return;
      }
      if (selectedFile && selectedFile.trim()) {
        await addPendingAttachmentFromPath(selectedFile.trim());
        return;
      }
    }
  } catch (err) {
    console.log("chooseFile fallback to modal:", err);
  }
  const modal = document.getElementById("file-context-modal");
  if (modal) modal.classList.add("visible");
}

function closeFileContextModal() {
  const modal = document.getElementById("file-context-modal");
  if (modal) modal.classList.remove("visible");
  if (typeof checkModalActive === "function") checkModalActive();
}

async function submitFileContext() {
  const input = document.getElementById("input-file-context-path");
  const path = input ? input.value.trim() : "";
  closeFileContextModal();
  if (path) {
    await addPendingAttachmentFromPath(path);
  }
}

async function insertFileContext(filePath) {
  if (!filePath || !String(filePath).trim()) return;
  await addPendingAttachmentFromPath(String(filePath).trim());
}

async function addPendingAttachmentFromPath(filePath) {
  const cleanPath = String(filePath || "").trim();
  if (!cleanPath) return;

  const fileName = cleanPath.split(/[/\\]/).pop() || cleanPath;
  const ext = (fileName.includes(".") ? "." + fileName.split(".").pop() : "").toLowerCase();
  const imgMimeMap = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
  };

  let att = {
    id: "att-" + Date.now() + "-" + Math.random().toString(36).substring(2, 7),
    name: fileName,
    path: cleanPath,
    mime: imgMimeMap[ext] || "application/octet-stream",
    is_image: Boolean(imgMimeMap[ext]),
    data_uri: "",
    content: "",
    size: 0
  };

  try {
    const reqPayload = JSON.stringify({ path: cleanPath, for_attachment: true });
    let raw = null;
    if (typeof window.agentBridge !== "undefined" && window.agentBridge && typeof window.agentBridge.handleAction === "function") {
      raw = await window.agentBridge.handleAction("readFilePreview", reqPayload);
    } else if (typeof callGo === "function") {
      raw = await callGo("readFilePreview", reqPayload);
    } else if (typeof window.bridgeCall === "function") {
      raw = await window.bridgeCall("readFilePreview", reqPayload);
    }
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && !parsed.error) {
      att.name = parsed.name || fileName;
      att.path = parsed.full_path || cleanPath;
      att.size = parsed.size || 0;
      if (parsed.is_image && parsed.data) {
        att.is_image = true;
        att.mime = parsed.mime || att.mime || "image/png";
        att.data_uri = `data:${att.mime};base64,${parsed.data}`;
      } else if (typeof parsed.content === "string") {
        att.is_image = false;
        att.content = parsed.content;
      }
    }
  } catch (e) {
    console.warn("Preview load for attachment failed, will resolve on backend:", e);
  }

  addPendingAttachmentObject(att);
}

function addPendingAttachmentObject(att) {
  if (!att) return;
  if (!Array.isArray(window.pendingAttachments)) {
    window.pendingAttachments = [];
  }
  // Avoid duplicate path if already attached
  if (att.path) {
    const dupIdx = window.pendingAttachments.findIndex(x => x.path && x.path === att.path);
    if (dupIdx !== -1) {
      window.pendingAttachments.splice(dupIdx, 1);
    }
  }
  if (!att.id) {
    att.id = "att-" + Date.now() + "-" + Math.random().toString(36).substring(2, 7);
  }
  window.pendingAttachments.push(att);
  renderPendingAttachments();
  const textarea = document.getElementById("prompt-input");
  if (textarea && typeof handleInput === "function") {
    handleInput(textarea);
  }
  if (typeof showToast === "function") {
    showToast(`${att.is_image ? "Image" : "File"} attached: ${att.name || "attachment"}`);
  }
}

function removePendingAttachment(attId, event) {
  if (event && typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
  if (!Array.isArray(window.pendingAttachments)) return;
  window.pendingAttachments = window.pendingAttachments.filter(a => a.id !== attId);
  renderPendingAttachments();
  const textarea = document.getElementById("prompt-input");
  if (textarea && typeof handleInput === "function") {
    handleInput(textarea);
  }
}

function clearPendingAttachments() {
  window.pendingAttachments = [];
  renderPendingAttachments();
}

function handleFileInputChange(event) {
  const input = event && event.target ? event.target : document.getElementById("hidden-file-input");
  if (!input || !input.files || input.files.length === 0) return;
  const files = Array.from(input.files);
  files.forEach(file => readBrowserFileAsAttachment(file));
  input.value = "";
}

function readBrowserFileAsAttachment(file) {
  if (!file) return;
  const isImg = (file.type && file.type.startsWith("image/")) || /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i.test(file.name || "");
  const reader = new FileReader();
  if (isImg) {
    reader.onload = () => {
      addPendingAttachmentObject({
        id: "att-" + Date.now() + "-" + Math.random().toString(36).substring(2, 7),
        name: file.name || "pasted-image.png",
        path: file.path || "",
        mime: file.type || "image/png",
        is_image: true,
        data_uri: String(reader.result || ""),
        size: file.size || 0
      });
    };
    reader.readAsDataURL(file);
  } else {
    reader.onload = () => {
      addPendingAttachmentObject({
        id: "att-" + Date.now() + "-" + Math.random().toString(36).substring(2, 7),
        name: file.name || "attached-file.txt",
        path: file.path || "",
        mime: file.type || "text/plain",
        is_image: false,
        content: String(reader.result || ""),
        size: file.size || 0
      });
    };
    reader.readAsText(file);
  }
}

function renderPendingAttachments() {
  const bar = document.getElementById("prompt-attachments-bar");
  if (!bar) return;
  const list = Array.isArray(window.pendingAttachments) ? window.pendingAttachments : [];
  if (list.length === 0) {
    bar.style.display = "none";
    bar.innerHTML = "";
    return;
  }
  bar.style.display = "flex";
  const esc = typeof escapeHtml === "function" ? escapeHtml : (s => String(s || ""));
  const escAttr = typeof escapeJsAttr === "function" ? escapeJsAttr : (s => String(s || ""));

  bar.innerHTML = list.map(att => {
    const isImg = Boolean(att.is_image);
    const sizeStr = att.size && typeof formatBytes === "function" ? formatBytes(att.size) : (isImg ? "Image" : "File");
    const thumbHtml = (isImg && att.data_uri)
      ? `<img class="prompt-attachment-thumb" src="${att.data_uri}" alt="${esc(att.name)}" />`
      : `<span class="prompt-attachment-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            ${isImg
              ? '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>'
              : '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'}
          </svg>
        </span>`;
    const clickAction = att.path ? `onclick="previewFileInSidebar('${escAttr(att.path)}')"` : "";
    return `
      <div class="prompt-attachment-chip" ${clickAction} title="${esc(att.path || att.name || "")}">
        ${thumbHtml}
        <div class="prompt-attachment-meta">
          <span class="prompt-attachment-name">${esc(att.name || "attachment")}</span>
          <span class="prompt-attachment-sub">${esc(sizeStr)}</span>
        </div>
        <button type="button" class="prompt-attachment-remove" onclick="removePendingAttachment('${escAttr(att.id)}', event)" title="Remove attachment">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    `;
  }).join("");
}

if (typeof window !== "undefined") {
  window.addPendingAttachmentFromPath = addPendingAttachmentFromPath;
  window.addPendingAttachmentObject = addPendingAttachmentObject;
  window.removePendingAttachment = removePendingAttachment;
  window.clearPendingAttachments = clearPendingAttachments;
  window.handleFileInputChange = handleFileInputChange;
  window.readBrowserFileAsAttachment = readBrowserFileAsAttachment;
  window.renderPendingAttachments = renderPendingAttachments;
}
