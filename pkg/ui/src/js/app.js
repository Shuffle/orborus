// --- App Bootstrap, Keyboard Shortcuts & Overlay Handlers ---
function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showToast(message) {
  const toast = document.getElementById("app-toast");
  if (!toast) return;
  toast.innerText = message;
  toast.classList.add("visible");
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.remove("visible");
  }, 2800);
}

function handleOverlayClick(event, modalId) {
  if (event.target && (event.target.id === modalId || event.target.classList.contains("modal-overlay"))) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove("visible");
    if (typeof checkModalActive === "function") checkModalActive();
  }
}

function closeAllModals() {
  document.querySelectorAll(".modal-overlay").forEach(m => m.classList.remove("visible"));
  if (typeof checkModalActive === "function") checkModalActive();
}

function closeAllDropdowns(exceptIds = []) {
  const dropdowns = [
    "project-dropdown-menu"
  ];
  dropdowns.forEach(id => {
    if (!exceptIds.includes(id)) {
      const el = document.getElementById(id);
      if (el) el.classList.remove("visible");
    }
  });
}

function handleClickOutside(e) {
  const projMenu = document.getElementById("project-dropdown-menu");
  const projBtn = document.getElementById("project-dropdown-btn");
  if (projMenu && projMenu.classList.contains("visible")) {
    if (!projMenu.contains(e.target) && !projBtn.contains(e.target)) {
      projMenu.classList.remove("visible");
    }
  }
}

window.addEventListener("pointerdown", handleClickOutside, true);
window.addEventListener("click", handleClickOutside, true);

// Global keyboard shortcuts (1-5 for approvals, Cmd+Y for history, Cmd+N for new chat, Cmd+, for settings, Esc to close modals/popovers)
window.addEventListener("keydown", function(e) {
  const card = document.getElementById("approval-card");
  if (card && card.classList.contains("visible")) {
    if (e.key >= "1" && e.key <= "5") {
      e.preventDefault();
      selectApprovalOption(parseInt(e.key, 10));
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectApprovalOption(Math.min(5, selectedApprovalOption + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      selectApprovalOption(Math.max(1, selectedApprovalOption - 1));
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      submitApproval();
      return;
    }
    if (e.key === "Escape" || e.key === "Esc") {
      e.preventDefault();
      skipApproval();
      return;
    }
  }

  if ((e.metaKey || e.ctrlKey) && (e.key === "," || e.code === "Comma")) {
    e.preventDefault();
    openSettingsModal();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === "y" || e.key === "Y")) {
    e.preventDefault();
    toggleHistoryModal();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === "n" || e.key === "N")) {
    e.preventDefault();
    startNewSession();
    return;
  }
  if (e.key === "Escape" || e.key === "Esc" || e.keyCode === 27) {
    closeAllModals();
    closeAllDropdowns();
  }
}, true);

function bootApp() {
  try {
    if (typeof updateActiveModelLabel === "function") {
      updateActiveModelLabel();
    }
  } catch(e) {}

  try {
    setupWindowDragging();
  } catch(e) {}

  try {
    init();
  } catch(e) {
    console.error("init error:", e);
  }

  try {
    initFooterControls();
  } catch(e) {}

  try {
    const savedModel = localStorage.getItem("orborus_ai_model");
    if (savedModel) {
      activeAiModel = savedModel;
      const sel = document.getElementById("select-ai-model");
      if (sel) sel.value = savedModel;
    }
    if (typeof updateActiveModelLabel === "function") {
      updateActiveModelLabel();
    }
  } catch(e) {}

  try {
    if (typeof populateAiModelSelect === "function") {
      populateAiModelSelect();
    }
    if (typeof updateModesDisplay === "function") {
      updateModesDisplay();
    }
  } catch(e) {}
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", bootApp);
} else {
  bootApp();
}