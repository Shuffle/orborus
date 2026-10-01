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
    const isNoDrag = !!e.target.closest("button, input, select, textarea, a, .no-drag, .traffic-lights, .dot, .nav-icon-btn, .btn-new-chat, .project-folder-actions, .btn-pin-toggle");

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
    const isNoDrag = !!e.target.closest("button, input, select, textarea, a, .no-drag, .traffic-lights, .dot, .nav-icon-btn, .btn-new-chat, .project-folder-actions, .btn-pin-toggle");

    if (isTopHeader && !isNoDrag) {
      if (typeof window.windowAction === "function") {
        window.windowAction("maximize");
      }
    }
  }, true);
}

function openCustomDirModal() {
  toggleProjectDropdown(null, false);
  const input = document.getElementById("input-custom-dir-path");
  if (input) {
    input.value = (activeProjectPath && activeProjectPath !== ".") ? activeProjectPath : "";
  }
  const modal = document.getElementById("custom-dir-modal");
  if (modal) {
    modal.classList.add("visible");
    setTimeout(() => {
      if (input) {
        input.focus();
        input.select();
      }
    }, 50);
  }
}

function chooseCustomDirectory() {
  openCustomDirModal();
}

function closeCustomDirModal() {
  const modal = document.getElementById("custom-dir-modal");
  if (modal) modal.classList.remove("visible");
  if (typeof checkModalActive === "function") checkModalActive();
}

async function browseNativeDirectory() {
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
        const input = document.getElementById("input-custom-dir-path");
        if (input) input.value = selectedPath.trim();
        await submitCustomDir();
        return;
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
    await selectProject(path);
    showToast("Project opened: " + path.split("/").filter(Boolean).pop());
    closeCustomDirModal();
  }
}

async function addFileContext() {
  try {
    if (window.chooseFile) {
      const raw = await window.chooseFile();
      let selectedFile = "";
      if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.status === "ok" && parsed.path) {
            selectedFile = parsed.path;
          }
        } catch (e) {
          selectedFile = raw;
        }
      } else if (raw && raw.path) {
        selectedFile = raw.path;
      }
      if (selectedFile && selectedFile.trim()) {
        insertFileContext(selectedFile.trim());
        showToast("File added to prompt");
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

function submitFileContext() {
  const input = document.getElementById("input-file-context-path");
  const path = input ? input.value.trim() : "";
  if (path) {
    insertFileContext(path);
    showToast("File context added");
  }
  closeFileContextModal();
}

function insertFileContext(filePath) {
  const textarea = document.getElementById("prompt-input");
  if (!textarea) return;
  let refPath = filePath;
  if (activeProjectPath && activeProjectPath !== "." && filePath.startsWith(activeProjectPath)) {
    refPath = filePath.slice(activeProjectPath.length).replace(/^\/+/, "");
  }
  const mention = `@${refPath} `;
  const start = textarea.selectionStart || textarea.value.length;
  const end = textarea.selectionEnd || textarea.value.length;
  const current = textarea.value;
  textarea.value = current.substring(0, start) + mention + current.substring(end);
  textarea.selectionStart = textarea.selectionEnd = start + mention.length;
  textarea.focus();
  handleInput(textarea);
}
