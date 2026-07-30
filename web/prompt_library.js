import { app } from "../../scripts/app.js";
import { $el } from "../../scripts/ui.js";

// ──────────────────────────────────────────────────────────────────
//  API helpers
// ──────────────────────────────────────────────────────────────────
async function parseApiResponse(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    // A non-JSON error response is handled by the generic message below.
  }
  if (!response.ok) {
    throw new Error(payload?.error || `Request failed with status ${response.status}.`);
  }
  return payload;
}

const API = {
  async get() {
    return parseApiResponse(await fetch("/prompt_library/data"));
  },
  async save(data) {
    const response = await fetch("/prompt_library/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return parseApiResponse(response);
  },
  async addCategory(body) {
    const response = await fetch("/prompt_library/category", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return parseApiResponse(response);
  },
  async updateCategory(id, body) {
    const response = await fetch(`/prompt_library/category/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await parseApiResponse(response);
  },
  async deleteCategory(id) {
    await parseApiResponse(
      await fetch(`/prompt_library/category/${id}`, { method: "DELETE" })
    );
  },
  async addPrompt(body) {
    const response = await fetch("/prompt_library/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return parseApiResponse(response);
  },
  async updatePrompt(id, body) {
    const response = await fetch(`/prompt_library/prompt/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await parseApiResponse(response);
  },
  async deletePrompt(id) {
    await parseApiResponse(
      await fetch(`/prompt_library/prompt/${id}`, { method: "DELETE" })
    );
  },
};

// ──────────────────────────────────────────────────────────────────
//  State
// ──────────────────────────────────────────────────────────────────
let state = {
  categories: [],
  prompts: [],
  selectedCategoryId: null,
  selectedPromptIds: [],
  expandedCategories: new Set(),
  searchQuery: "",
  editingPrompt: null,
  editingCategory: null,
  activeTab: "browse", // browse | edit
};

// Per-node random state (keyed by node id)
const randomStates = {};
function getRandomState(nodeId) {
  if (!randomStates[nodeId]) {
    randomStates[nodeId] = {
      selectedCategoryIds: new Set(),
      expandedCategories: new Set(),
      previewPrompts: [],
    };
  }
  return randomStates[nodeId];
}

// ──────────────────────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────────────────────
function getRootCategories() {
  return state.categories.filter((c) => !c.parent_id);
}
function getChildCategories(parentId) {
  return state.categories.filter((c) => c.parent_id === parentId);
}
function getPromptsByCategory(catId) {
  if (catId === null) return state.prompts;
  return state.prompts.filter((p) => p.category_id === catId);
}
function getAllDescendantIds(catId) {
  const ids = [catId];
  getChildCategories(catId).forEach((c) => ids.push(...getAllDescendantIds(c.id)));
  return ids;
}
function getPromptsInSubtree(catId) {
  const ids = getAllDescendantIds(catId);
  return state.prompts.filter((p) => ids.includes(p.category_id));
}

function filteredPrompts() {
  let list =
    state.selectedCategoryId !== null
      ? getPromptsInSubtree(state.selectedCategoryId)
      : state.prompts;

  if (state.searchQuery.trim()) {
    const q = state.searchQuery.toLowerCase();
    list = list.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.text.toLowerCase().includes(q) ||
        (p.tags || []).some((t) => t.toLowerCase().includes(q))
    );
  }
  return list;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeColor(value, fallback = "#6366f1") {
  return /^#[0-9a-fA-F]{6}$/.test(value || "") ? value : fallback;
}

function checkImportedLibraryShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("The library root must be a JSON object.");
  }
  if (!Array.isArray(data.categories) || !Array.isArray(data.prompts)) {
    throw new Error("The library must contain categories and prompts arrays.");
  }
}

// ──────────────────────────────────────────────────────────────────
//  Modal dialog
// ──────────────────────────────────────────────────────────────────
function showModal(content, onClose) {
  const overlay = document.createElement("div");
  overlay.className = "pl-modal-overlay";
  overlay.innerHTML = `<div class="pl-modal">${content}</div>`;
  document.body.appendChild(overlay);
  const close = () => {
    overlay.remove();
    onClose && onClose();
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  // Return reference to modal el + close fn
  return { modal: overlay.querySelector(".pl-modal"), close };
}

// ──────────────────────────────────────────────────────────────────
//  Main panel renderer
// ──────────────────────────────────────────────────────────────────
class PromptLibraryPanel {

  constructor(node) {
    this.node = node;
    this.container = null;
  }

  async init() {
    const data = await API.get();
    state.categories = data.categories || [];
    state.prompts = data.prompts || [];

    // Sync from node if it already contains a saved workflow selection.
    if (this.node) {
      const widget = this.node.widgets?.find((item) => item.name === "prompt_ids");
      const selectedIds = widget?.value
        ? widget.value.split(",").map((id) => id.trim()).filter(Boolean)
        : [];
      this.syncPromptSelection(selectedIds, false);
    }

    this.render();
  }

  render() {
    if (!this.container) return;

    // ── First render: build everything from scratch ──────────────────
    if (!this.container.querySelector(".pl-wrap")) {
      this.container.innerHTML = "";
      this.container.appendChild(this.buildPanel());
      return;
    }

    // ── Subsequent renders: only replace sidebar + content ───────────
    // This preserves the header DOM (including the search <input>)
    // so the browser never loses focus on it.
    const main = this.container.querySelector(".pl-main");
    if (!main) {
      // Fallback: full rebuild
      this.container.innerHTML = "";
      this.container.appendChild(this.buildPanel());
      return;
    }

    // Remember which element currently has focus so we can restore it
    const focused = document.activeElement;
    const isSearchFocused = focused?.classList.contains("pl-search");
    const searchCursor = isSearchFocused ? focused.selectionStart : null;

    // Replace sidebar
    const oldSidebar = main.querySelector(".pl-sidebar");
    const newSidebar = this.buildSidebar();
    main.replaceChild(newSidebar, oldSidebar);

    // Replace content
    const oldContent = main.querySelector(".pl-content");
    const newContent = this.buildContent();
    main.replaceChild(newContent, oldContent);

    // Restore focus + caret position if user was typing in search
    if (isSearchFocused) {
      const searchEl = this.container.querySelector(".pl-search");
      if (searchEl) {
        searchEl.focus();
        if (searchCursor !== null) {
          searchEl.setSelectionRange(searchCursor, searchCursor);
        }
      }
    }
  }

  buildPanel() {
    const wrap = document.createElement("div");
    wrap.className = "pl-wrap";

    // Header
    wrap.appendChild(this.buildHeader());

    // Main layout
    const main = document.createElement("div");
    main.className = "pl-main";
    main.appendChild(this.buildSidebar());
    main.appendChild(this.buildContent());
    wrap.appendChild(main);

    return wrap;
  }

  // ── Header ──────────────────────────────────────────────────────
  buildHeader() {
    const header = document.createElement("div");
    header.className = "pl-header";
    header.innerHTML = `
      <div class="pl-header-title">
        <span class="pl-icon">📚</span>
        <span>Prompt Library</span>
      </div>
      <div class="pl-header-actions">
        <input class="pl-search" placeholder="🔍  Search prompts…" value="${escapeHtml(state.searchQuery)}">
        <button class="pl-btn pl-btn-compact" id="pl-import" title="Replace the library from a JSON file">Import</button>
        <button class="pl-btn pl-btn-compact" id="pl-export" title="Download the current library as JSON">Export</button>
        <button class="pl-btn pl-btn-accent" id="pl-new-prompt">＋ New Prompt</button>
        <input class="pl-file-input" id="pl-import-file" type="file" accept=".json,application/json">
      </div>
    `;
    header.querySelector(".pl-search").addEventListener("input", (event) => {
      state.searchQuery = event.target.value;
      this.render();
    });
    header.querySelector("#pl-new-prompt").addEventListener("click", () => {
      this.openPromptEditor(null);
    });

    const fileInput = header.querySelector("#pl-import-file");
    header.querySelector("#pl-import").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) await this.prepareImport(file);
    });
    header.querySelector("#pl-export").addEventListener("click", (event) => {
      this.exportLibrary(event.currentTarget);
    });
    return header;
  }

  async prepareImport(file) {
    let importedData;
    try {
      importedData = JSON.parse(await file.text());
      checkImportedLibraryShape(importedData);
    } catch (error) {
      const message = error instanceof SyntaxError ? "The selected file is not valid JSON." : error.message;
      this.showToast(`Import failed: ${message}`);
      return;
    }

    const content = `
      <div class="pl-modal-header"><h2>Import Prompt Library</h2><button class="pl-modal-close" id="mclose">✕</button></div>
      <div class="pl-form">
        <p>Replace the complete current library with <strong>${importedData.categories.length}</strong> categories and <strong>${importedData.prompts.length}</strong> prompts?</p>
        <p class="pl-warn">⚠ Existing categories and prompts will be replaced. Export a backup first if needed.</p>
        <div class="pl-form-actions">
          <button class="pl-btn" id="f-cancel">Cancel</button>
          <button class="pl-btn pl-btn-accent" id="f-confirm">Import and Replace</button>
        </div>
      </div>
    `;
    const { modal, close } = showModal(content);
    modal.querySelector("#mclose").addEventListener("click", close);
    modal.querySelector("#f-cancel").addEventListener("click", close);
    modal.querySelector("#f-confirm").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = "Importing…";
      try {
        const response = await API.save(importedData);
        const acceptedData = response?.data || importedData;
        state.categories = acceptedData.categories;
        state.prompts = acceptedData.prompts;
        state.selectedCategoryId = null;
        state.expandedCategories = new Set();
        state.searchQuery = "";
        const searchInput = this.container?.querySelector(".pl-search");
        if (searchInput) searchInput.value = "";
        this.syncPromptSelection(state.selectedPromptIds);
        close();
        this.render();
        this.showToast(
          `Imported ${state.categories.length} categories and ${state.prompts.length} prompts.`
        );
      } catch (error) {
        button.disabled = false;
        button.textContent = "Import and Replace";
        this.showToast(`Import failed: ${error.message}`);
      }
    });
  }

  async exportLibrary(button) {
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Exporting…";
    try {
      const data = await API.get();
      const json = `${JSON.stringify(data, null, 2)}\n`;
      const blob = new Blob([json], { type: "application/json;charset=utf-8" });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = "prompt_library_data.json";
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      this.showToast("Prompt library exported.");
    } catch (error) {
      this.showToast(`Export failed: ${error.message}`);
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  // ── Sidebar (categories tree) ────────────────────────────────────
  buildSidebar() {
    const sidebar = document.createElement("div");
    sidebar.className = "pl-sidebar";

    const titleRow = document.createElement("div");
    titleRow.className = "pl-sidebar-title";
    titleRow.innerHTML = `<span>Categories</span>
      <button class="pl-icon-btn" id="pl-add-root-cat" title="Add root category">＋</button>`;
    titleRow.querySelector("#pl-add-root-cat").addEventListener("click", () =>
      this.openCategoryEditor(null, null)
    );
    sidebar.appendChild(titleRow);

    // "All" entry
    const allBtn = document.createElement("div");
    allBtn.className =
      "pl-cat-item pl-cat-all" + (state.selectedCategoryId === null ? " active" : "");
    allBtn.innerHTML = `<span class="pl-cat-dot" style="background:#888"></span>
      <span class="pl-cat-label">All Prompts</span>
      <span class="pl-cat-count">${state.prompts.length}</span>`;
    allBtn.addEventListener("click", () => {
      state.selectedCategoryId = null;
      this.render();
    });
    sidebar.appendChild(allBtn);

    // Tree
    const tree = document.createElement("div");
    tree.className = "pl-tree";
    getRootCategories().forEach((cat) => {
      tree.appendChild(this.buildCategoryItem(cat, 0));
    });
    sidebar.appendChild(tree);

    return sidebar;
  }

  buildCategoryItem(cat, depth) {
    const children = getChildCategories(cat.id);
    const hasChildren = children.length > 0;
    const expanded = state.expandedCategories.has(cat.id);
    const isSelected = state.selectedCategoryId === cat.id;
    const count = getPromptsInSubtree(cat.id).length;

    const wrap = document.createElement("div");
    wrap.className = "pl-cat-wrap";

    const row = document.createElement("div");
    row.className = "pl-cat-item" + (isSelected ? " active" : "");
    row.style.paddingLeft = `${12 + depth * 16}px`;

    row.innerHTML = `
      <span class="pl-cat-toggle">${hasChildren ? (expanded ? "▾" : "▸") : "·"}</span>
      <span class="pl-cat-dot" style="background:${safeColor(cat.color)}"></span>
      <span class="pl-cat-label">${escapeHtml(cat.name)}</span>
      <span class="pl-cat-count">${count}</span>
      <span class="pl-cat-actions">
        <button class="pl-icon-btn" title="Add sub-category" data-action="add-sub">＋</button>
        <button class="pl-icon-btn" title="Edit category" data-action="edit">✎</button>
        <button class="pl-icon-btn pl-icon-btn-danger" title="Delete category" data-action="delete">✕</button>
      </span>
    `;

    // Toggle expand
    row.querySelector(".pl-cat-toggle").addEventListener("click", (e) => {
      e.stopPropagation();
      if (!hasChildren) return;
      if (expanded) state.expandedCategories.delete(cat.id);
      else state.expandedCategories.add(cat.id);
      this.render();
    });

    // Select
    row.addEventListener("click", (e) => {
      if (e.target.closest(".pl-cat-actions")) return;
      state.selectedCategoryId = cat.id;
      this.render();
    });

    // Actions
    row.querySelector("[data-action='add-sub']").addEventListener("click", (e) => {
      e.stopPropagation();
      this.openCategoryEditor(null, cat.id);
    });
    row.querySelector("[data-action='edit']").addEventListener("click", (e) => {
      e.stopPropagation();
      this.openCategoryEditor(cat, cat.parent_id);
    });
    row.querySelector("[data-action='delete']").addEventListener("click", (e) => {
      e.stopPropagation();
      this.confirmDeleteCategory(cat);
    });

    wrap.appendChild(row);

    if (hasChildren && expanded) {
      const childWrap = document.createElement("div");
      childWrap.className = "pl-cat-children";
      children.forEach((child) => childWrap.appendChild(this.buildCategoryItem(child, depth + 1)));
      wrap.appendChild(childWrap);
    }

    return wrap;
  }

  // ── Content area ─────────────────────────────────────────────────
  buildContent() {
    const content = document.createElement("div");
    content.className = "pl-content";

    const prompts = filteredPrompts();
    const catName =
      state.selectedCategoryId !== null
        ? state.categories.find((c) => c.id === state.selectedCategoryId)?.name || "Unknown"
        : "All Prompts";

    const selectedCount = state.selectedPromptIds.length;
    const bar = document.createElement("div");
    bar.className = "pl-content-bar";
    bar.innerHTML = `
      <h3 class="pl-content-title">${escapeHtml(catName)} <span class="pl-count-badge">${prompts.length}</span></h3>
      <div class="pl-selection-actions">
        <span class="pl-selection-count">${selectedCount} selected</span>
        <button class="pl-btn pl-btn-compact" id="pl-clear-selection" ${selectedCount ? "" : "disabled"}>Clear selection</button>
      </div>
    `;
    bar.querySelector("#pl-clear-selection").addEventListener("click", () => {
      this.syncPromptSelection([]);
      this.render();
      this.showToast("Prompt selection cleared.");
    });
    content.appendChild(bar);

    if (prompts.length === 0) {
      content.appendChild(this.buildEmptyState());
    } else {
      const grid = document.createElement("div");
      grid.className = "pl-grid";
      prompts.forEach((p) => grid.appendChild(this.buildPromptCard(p)));
      content.appendChild(grid);
    }

    return content;
  }

  buildEmptyState() {
    const empty = document.createElement("div");
    empty.className = "pl-empty";
    empty.innerHTML = `
      <div class="pl-empty-icon">🗒️</div>
      <p>No prompts here yet.</p>
      <button class="pl-btn pl-btn-accent">＋ Add your first prompt</button>
    `;
    empty.querySelector("button").addEventListener("click", () => this.openPromptEditor(null));
    return empty;
  }

  buildPromptCard(prompt) {
    const cat = state.categories.find((c) => c.id === prompt.category_id);
    const categoryColor = safeColor(cat?.color);
    const isSelected = state.selectedPromptIds.includes(prompt.id);
    const card = document.createElement("div");
    card.className = "pl-card" + (isSelected ? " selected" : "");
    card.innerHTML = `
      <div class="pl-card-header">
        <span class="pl-card-title">${escapeHtml(prompt.title)}</span>
        <div class="pl-card-header-actions">
          <button class="pl-icon-btn" title="Edit" data-action="edit">✎</button>
          <button class="pl-icon-btn pl-icon-btn-danger" title="Delete" data-action="delete">✕</button>
        </div>
      </div>
      ${cat ? `<div class="pl-card-cat" style="background:${categoryColor}22;color:${categoryColor}">
        <span class="pl-card-dot" style="background:${categoryColor}"></span>${escapeHtml(cat.name)}</div>` : ""}
      <p class="pl-card-text">${escapeHtml(prompt.text)}</p>
      ${prompt.negative ? `<p class="pl-card-neg"><span>neg:</span> ${escapeHtml(prompt.negative)}</p>` : ""}
      ${
        prompt.tags?.length
          ? `<div class="pl-card-tags">${prompt.tags.map((tag) => `<span class="pl-tag">${escapeHtml(tag)}</span>`).join("")}</div>`
          : ""
      }
      <input type="checkbox" style="display:none" ${isSelected ? "checked" : ""}>
    `;

    card.addEventListener("click", (e) => {
      if (e.target.closest(".pl-card-header-actions")) return;
      this.togglePrompt(prompt);
    });

    card.querySelector("[data-action='edit']").addEventListener("click", () => {
      this.openPromptEditor(prompt);
    });
    card.querySelector("[data-action='delete']").addEventListener("click", () => {
      this.confirmDeletePrompt(prompt);
    });

    return card;
  }

  // ── Prompt selection ────────────────────────────────────────────
  syncPromptSelection(selectedIds, markDirty = true) {
    const validPromptIds = new Set(state.prompts.map((prompt) => prompt.id));
    state.selectedPromptIds = [...new Set(selectedIds)].filter((id) => validPromptIds.has(id));

    if (this.node) {
      const idsWidget = this.node.widgets?.find((widget) => widget.name === "prompt_ids");
      if (idsWidget) idsWidget.value = state.selectedPromptIds.join(",");

      const titlesWidget = this.node.widgets?.find((widget) => widget.name === "prompts");
      if (titlesWidget) {
        titlesWidget.value = state.selectedPromptIds
          .map((id) => state.prompts.find((prompt) => prompt.id === id)?.title || id)
          .join(", ");
      }
      if (markDirty) this.node.setDirtyCanvas?.(true);
    }
  }

  togglePrompt(prompt) {
    const selectedIds = [...state.selectedPromptIds];
    const index = selectedIds.indexOf(prompt.id);
    if (index === -1) {
      selectedIds.push(prompt.id);
      this.showToast(`✓ Selected: ${prompt.title}`);
    } else {
      selectedIds.splice(index, 1);
      this.showToast(`✕ Unselected: ${prompt.title}`);
    }

    this.syncPromptSelection(selectedIds);
    this.render();
  }

  showToast(msg) {
    const t = document.createElement("div");
    t.className = "pl-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add("show"), 10);
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 300);
    }, 2500);
  }

  // ── Prompt editor modal ───────────────────────────────────────────
  openPromptEditor(existing) {
    const isNew = !existing;
    const title = isNew ? "New Prompt" : "Edit Prompt";
    const catOptions = state.categories
      .map(
        (c) =>
          `<option value="${escapeHtml(c.id)}" ${existing?.category_id === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`
      )
      .join("");

    const content = `
      <div class="pl-modal-header"><h2>${title}</h2><button class="pl-modal-close" id="mclose">✕</button></div>
      <div class="pl-form">
        <label>Title *</label>
        <input id="f-title" class="pl-input" value="${escapeHtml(existing?.title)}">
        
        <label>Category</label>
        <select id="f-cat" class="pl-input">
          <option value="">— uncategorized —</option>
          ${catOptions}
        </select>
        
        <label>Positive Prompt *</label>
        <textarea id="f-text" class="pl-textarea" rows="6">${escapeHtml(existing?.text)}</textarea>
        
        <label>Negative Prompt</label>
        <textarea id="f-neg" class="pl-textarea" rows="3">${escapeHtml(existing?.negative)}</textarea>
        
        <label>Tags <span style="opacity:.5;font-size:11px">(comma separated)</span></label>
        <input id="f-tags" class="pl-input" value="${escapeHtml((existing?.tags || []).join(", "))}">
        
        <div class="pl-form-actions">
          <button class="pl-btn" id="f-cancel">Cancel</button>
          <button class="pl-btn pl-btn-accent" id="f-save">Save Prompt</button>
        </div>
      </div>
    `;

    const { modal, close } = showModal(content);
    modal.querySelector("#mclose").addEventListener("click", close);
    modal.querySelector("#f-cancel").addEventListener("click", close);
    modal.querySelector("#f-save").addEventListener("click", async () => {
      const titleVal = modal.querySelector("#f-title").value.trim();
      const textVal = modal.querySelector("#f-text").value.trim();
      if (!titleVal || !textVal) {
        modal.querySelector("#f-title").classList.toggle("pl-error", !titleVal);
        modal.querySelector("#f-text").classList.toggle("pl-error", !textVal);
        return;
      }
      const body = {
        title: titleVal,
        text: textVal,
        negative: modal.querySelector("#f-neg").value.trim(),
        category_id: modal.querySelector("#f-cat").value || null,
        tags: modal
          .querySelector("#f-tags")
          .value.split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      };
      if (isNew) {
        const prompt = await API.addPrompt(body);
        state.prompts.push(prompt);
      } else {
        await API.updatePrompt(existing.id, body);
        Object.assign(existing, body);
      }
      this.syncPromptSelection(state.selectedPromptIds);
      close();
      this.render();
    });
  }

  // ── Category editor modal ─────────────────────────────────────────
  openCategoryEditor(existing, parentId) {
    const isNew = !existing;
    const colors = ["#6366f1","#ec4899","#f59e0b","#10b981","#3b82f6","#ef4444","#8b5cf6","#14b8a6"];
    const selectedColor = safeColor(existing?.color, colors[0]);

    const content = `
      <div class="pl-modal-header">
        <h2>${isNew ? "New Category" : "Edit Category"}</h2>
        <button class="pl-modal-close" id="mclose">✕</button>
      </div>
      <div class="pl-form">
        <label>Name *</label>
        <input id="f-catname" class="pl-input" value="${escapeHtml(existing?.name)}">
        
        <label>Color</label>
        <div class="pl-color-picker" id="f-colorpicker">
          ${colors.map((c) => `<div class="pl-color-swatch ${c === selectedColor ? "selected" : ""}" style="background:${c}" data-color="${c}"></div>`).join("")}
        </div>
        <input type="hidden" id="f-color" value="${selectedColor}">
        
        <div class="pl-form-actions">
          <button class="pl-btn" id="f-cancel">Cancel</button>
          <button class="pl-btn pl-btn-accent" id="f-save">Save</button>
        </div>
      </div>
    `;
    const { modal, close } = showModal(content);
    modal.querySelector("#mclose").addEventListener("click", close);
    modal.querySelector("#f-cancel").addEventListener("click", close);

    modal.querySelectorAll(".pl-color-swatch").forEach((el) => {
      el.addEventListener("click", () => {
        modal.querySelectorAll(".pl-color-swatch").forEach((s) => s.classList.remove("selected"));
        el.classList.add("selected");
        modal.querySelector("#f-color").value = el.dataset.color;
      });
    });

    modal.querySelector("#f-save").addEventListener("click", async () => {
      const nameVal = modal.querySelector("#f-catname").value.trim();
      if (!nameVal) {
        modal.querySelector("#f-catname").classList.add("pl-error");
        return;
      }
      const body = {
        name: nameVal,
        color: modal.querySelector("#f-color").value,
        parent_id: parentId || null,
      };
      if (isNew) {
        const c = await API.addCategory(body);
        state.categories.push(c);
        state.expandedCategories.add(parentId);
      } else {
        await API.updateCategory(existing.id, body);
        Object.assign(existing, body);
      }
      close();
      this.render();
    });
  }

  // ── Delete confirmations ──────────────────────────────────────────
  confirmDeleteCategory(cat) {
    const subs = getChildCategories(cat.id).length;
    const prompts = getPromptsInSubtree(cat.id).length;
    const content = `
      <div class="pl-modal-header"><h2>Delete Category</h2><button class="pl-modal-close" id="mclose">✕</button></div>
      <div class="pl-form">
        <p>Delete <strong>${escapeHtml(cat.name)}</strong>?</p>
        ${subs ? `<p class="pl-warn">⚠ This will also delete <strong>${subs}</strong> sub-categor${subs > 1 ? "ies" : "y"}.</p>` : ""}
        ${prompts ? `<p class="pl-warn">⚠ This will also delete <strong>${prompts}</strong> prompt${prompts > 1 ? "s" : ""}.</p>` : ""}
        <div class="pl-form-actions">
          <button class="pl-btn" id="f-cancel">Cancel</button>
          <button class="pl-btn pl-btn-danger" id="f-confirm">Delete</button>
        </div>
      </div>
    `;
    const { modal, close } = showModal(content);
    modal.querySelector("#mclose").addEventListener("click", close);
    modal.querySelector("#f-cancel").addEventListener("click", close);
    modal.querySelector("#f-confirm").addEventListener("click", async () => {
      await API.deleteCategory(cat.id);
      const ids = getAllDescendantIds(cat.id);
      state.categories = state.categories.filter((c) => !ids.includes(c.id));
      state.prompts = state.prompts.filter((p) => !ids.includes(p.category_id));
      if (ids.includes(state.selectedCategoryId)) state.selectedCategoryId = null;
      this.syncPromptSelection(state.selectedPromptIds);
      close();
      this.render();
    });
  }

  confirmDeletePrompt(prompt) {
    const content = `
      <div class="pl-modal-header"><h2>Delete Prompt</h2><button class="pl-modal-close" id="mclose">✕</button></div>
      <div class="pl-form">
        <p>Delete <strong>${escapeHtml(prompt.title)}</strong>?</p>
        <div class="pl-form-actions">
          <button class="pl-btn" id="f-cancel">Cancel</button>
          <button class="pl-btn pl-btn-danger" id="f-confirm">Delete</button>
        </div>
      </div>
    `;
    const { modal, close } = showModal(content);
    modal.querySelector("#mclose").addEventListener("click", close);
    modal.querySelector("#f-cancel").addEventListener("click", close);
    modal.querySelector("#f-confirm").addEventListener("click", async () => {
      await API.deletePrompt(prompt.id);
      state.prompts = state.prompts.filter((item) => item.id !== prompt.id);
      this.syncPromptSelection(state.selectedPromptIds);
      close();
      this.render();
    });
  }
}

// ──────────────────────────────────────────────────────────────────
//  Random Panel
// ──────────────────────────────────────────────────────────────────
class PromptLibraryRandomPanel {
  constructor(node) {
    this.node = node;
    this.container = null;
    this.rs = null; // random state for this node instance
  }

  async init() {
    // Ensure shared library data is loaded
    if (!state.categories.length && !state.prompts.length) {
      const data = await API.get();
      state.categories = data.categories || [];
      state.prompts = data.prompts || [];
    }
    this.rs = getRandomState(this.node.id);
    this._syncFromWidget();
    this.render();
  }

  // Read category_ids widget → populate rs.selectedCategoryIds
  _syncFromWidget() {
    const w = this.node.widgets?.find((w) => w.name === "category_ids");
    if (w && w.value) {
      this.rs.selectedCategoryIds = new Set(
        w.value.split(",").map((s) => s.trim()).filter(Boolean)
      );
    }
  }

  // Write rs.selectedCategoryIds → category_ids widget
  _flushToWidget() {
    const w = this.node.widgets?.find((w) => w.name === "category_ids");
    if (w) {
      w.value = [...this.rs.selectedCategoryIds].join(",");
      this.node.setDirtyCanvas?.(true);
    }
  }

  _getPool() {
    if (!this.rs.selectedCategoryIds.size) return [];
    const allIds = new Set();
    for (const cid of this.rs.selectedCategoryIds) {
      getAllDescendantIds(cid).forEach((id) => allIds.add(id));
    }
    return state.prompts.filter((p) => allIds.has(p.category_id));
  }

  render() {
    if (!this.container) return;

    // Partial update: only rebuild body if wrap already exists
    const existing = this.container.querySelector(".plr-wrap");
    if (!existing) {
      this.container.innerHTML = "";
      this.container.appendChild(this._buildFull());
      return;
    }

    // Replace only the category tree and the pool preview
    const newTree = this._buildCategoryTree();
    const oldTree = existing.querySelector(".plr-tree-wrap");
    if (oldTree) existing.querySelector(".plr-main").replaceChild(newTree, oldTree);

    const newPool = this._buildPool();
    const oldPool = existing.querySelector(".plr-pool-wrap");
    if (oldPool) existing.querySelector(".plr-main").replaceChild(newPool, oldPool);
  }

  _buildFull() {
    const wrap = document.createElement("div");
    wrap.className = "plr-wrap";
    wrap.appendChild(this._buildHeader());
    const main = document.createElement("div");
    main.className = "plr-main";
    main.appendChild(this._buildCategoryTree());
    main.appendChild(this._buildPool());
    wrap.appendChild(main);
    return wrap;
  }

  // ── Header ──────────────────────────────────────────────────────
  _buildHeader() {
    const h = document.createElement("div");
    h.className = "plr-header";
    h.innerHTML = `
      <div class="plr-header-title">
        <span class="pl-icon">🎲</span>
        <span>Random Prompt</span>
      </div>
      <div class="plr-header-sub">
        Select categories — a random prompt is picked on each run
      </div>
    `;
    return h;
  }

  // ── Category tree with checkboxes ────────────────────────────────
  _buildCategoryTree() {
    const wrap = document.createElement("div");
    wrap.className = "plr-tree-wrap";

    const title = document.createElement("div");
    title.className = "plr-section-title";
    const totalSelected = this.rs.selectedCategoryIds.size;
    const pool = this._getPool();
    title.innerHTML = `
      <span>Categories</span>
      <span class="plr-badge">${totalSelected} selected · ${pool.length} prompt${pool.length !== 1 ? "s" : ""} in pool</span>
    `;
    wrap.appendChild(title);

    // Select all / none
    const actions = document.createElement("div");
    actions.className = "plr-tree-actions";
    const allLeafIds = state.categories.map((c) => c.id);
    actions.innerHTML = `
      <button class="pl-btn plr-sm-btn" id="plr-sel-all">Select all</button>
      <button class="pl-btn plr-sm-btn" id="plr-sel-none">Clear</button>
    `;
    actions.querySelector("#plr-sel-all").addEventListener("click", () => {
      allLeafIds.forEach((id) => this.rs.selectedCategoryIds.add(id));
      this._flushToWidget();
      this.render();
    });
    actions.querySelector("#plr-sel-none").addEventListener("click", () => {
      this.rs.selectedCategoryIds.clear();
      this._flushToWidget();
      this.render();
    });
    wrap.appendChild(actions);

    const tree = document.createElement("div");
    tree.className = "plr-tree";
    getRootCategories().forEach((cat) => tree.appendChild(this._buildCatRow(cat, 0)));
    wrap.appendChild(tree);
    return wrap;
  }

  _buildCatRow(cat, depth) {
    const children = getChildCategories(cat.id);
    const hasChildren = children.length > 0;
    const expanded = this.rs.expandedCategories.has(cat.id);
    const checked = this.rs.selectedCategoryIds.has(cat.id);
    const subtreeCount = getPromptsInSubtree(cat.id).length;

    const wrap = document.createElement("div");

    const row = document.createElement("label");
    row.className = "plr-cat-row" + (checked ? " checked" : "");
    row.style.paddingLeft = `${10 + depth * 16}px`;
    row.innerHTML = `
      <span class="plr-toggle">${hasChildren ? (expanded ? "▾" : "▸") : "·"}</span>
      <input type="checkbox" class="plr-check" ${checked ? "checked" : ""}>
      <span class="plr-cat-dot" style="background:${safeColor(cat.color)}"></span>
      <span class="plr-cat-name">${escapeHtml(cat.name)}</span>
      <span class="plr-cat-n">${subtreeCount}</span>
    `;

    // Toggle expand arrow
    row.querySelector(".plr-toggle").addEventListener("click", (e) => {
      e.preventDefault();
      if (!hasChildren) return;
      if (expanded) this.rs.expandedCategories.delete(cat.id);
      else this.rs.expandedCategories.add(cat.id);
      this.render();
    });

    // Checkbox
    row.querySelector(".plr-check").addEventListener("change", (e) => {
      if (e.target.checked) this.rs.selectedCategoryIds.add(cat.id);
      else this.rs.selectedCategoryIds.delete(cat.id);
      this._flushToWidget();
      this.render();
    });

    wrap.appendChild(row);

    if (hasChildren && expanded) {
      const sub = document.createElement("div");
      children.forEach((c) => sub.appendChild(this._buildCatRow(c, depth + 1)));
      wrap.appendChild(sub);
    }
    return wrap;
  }

  // ── Pool preview ─────────────────────────────────────────────────
  _buildPool() {
    const wrap = document.createElement("div");
    wrap.className = "plr-pool-wrap";

    const pool = this._getPool();

    const title = document.createElement("div");
    title.className = "plr-section-title";
    title.innerHTML = `<span>Prompt pool</span>
      <span class="plr-badge ${pool.length === 0 ? "plr-badge-warn" : ""}">${pool.length} eligible</span>`;
    wrap.appendChild(title);

    if (pool.length === 0) {
      const empty = document.createElement("div");
      empty.className = "plr-empty";
      empty.innerHTML = `<span>No categories selected — nothing to randomize.</span>`;
      wrap.appendChild(empty);
      return wrap;
    }

    const list = document.createElement("div");
    list.className = "plr-pool-list";
    pool.forEach((p) => {
      const cat = state.categories.find((c) => c.id === p.category_id);
      const item = document.createElement("div");
      item.className = "plr-pool-item";
      item.innerHTML = `
        <span class="plr-pool-dot" style="background:${safeColor(cat?.color, "#888888")}"></span>
        <span class="plr-pool-title">${escapeHtml(p.title)}</span>
        ${cat ? `<span class="plr-pool-cat">${escapeHtml(cat.name)}</span>` : ""}
      `;
      list.appendChild(item);
    });
    wrap.appendChild(list);
    return wrap;
  }
}

// ──────────────────────────────────────────────────────────────────
//  Register the ComfyUI extension
// ──────────────────────────────────────────────────────────────────
app.registerExtension({
  name: "PromptLibrary",

  async beforeRegisterNodeDef(nodeType, nodeData, app) {

    // ── Existing browse node ───────────────────────────────────────
    if (nodeData.name === "PromptLibraryNode") {
      const onNodeCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        onNodeCreated?.apply(this, arguments);

        this.size = [540, 640];
        this.resizable = true;

        const el = document.createElement("div");
        el.className = "pl-container";
        el.style.cssText = [
          "width:100%", "height:100%", "overflow:hidden",
          "display:flex", "flex-direction:column", "box-sizing:border-box",
        ].join(";");

        const domWidget = this.addDOMWidget("library_ui", "customtext", el, {
          getValue: () => "",
          setValue: () => {},
          computeSize: (width) => {
            const otherWidgetsH = 50 + 80 + 80 + 80;
            const minH = 340;
            const desired = (this.size?.[1] ?? 640) - otherWidgetsH;
            return [width, Math.max(minH, desired)];
          },
        });

        const syncHeight = () => {
          const otherWidgetsH = 50 + 80 + 80 + 80;
          const h = Math.max(340, (this.size?.[1] ?? 640) - otherWidgetsH);
          el.style.height = h + "px";
          el.style.maxHeight = h + "px";
        };
        const origOnResize = this.onResize;
        this.onResize = function (size) {
          origOnResize?.call(this, size);
          syncHeight();
        };
        syncHeight();

        const panel = new PromptLibraryPanel(this);
        panel.container = el;
        panel.init();
      };
    }

    // ── New random node ────────────────────────────────────────────
    if (nodeData.name === "PromptLibraryRandomNode") {
      const onNodeCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        onNodeCreated?.apply(this, arguments);

        this.size = [460, 560];
        this.resizable = true;

        const el = document.createElement("div");
        el.className = "pl-container";
        el.style.cssText = [
          "width:100%", "height:100%", "overflow:hidden",
          "display:flex", "flex-direction:column", "box-sizing:border-box",
        ].join(";");

        // category_ids and seed widgets are already created by ComfyUI
        // from INPUT_TYPES — estimate their combined height
        const otherWidgetsH = () => {
          const wCount = (this.widgets?.length ?? 4);
          // Each standard single-line widget ≈ 38px, node title ≈ 36px
          return 36 + (wCount - 1) * 38; // -1 for the DOM widget itself
        };

        this.addDOMWidget("random_ui", "customtext", el, {
          getValue: () => "",
          setValue: () => {},
          computeSize: (width) => {
            const minH = 300;
            const desired = (this.size?.[1] ?? 560) - otherWidgetsH();
            return [width, Math.max(minH, desired)];
          },
        });

        const syncHeight = () => {
          const h = Math.max(300, (this.size?.[1] ?? 560) - otherWidgetsH());
          el.style.height = h + "px";
          el.style.maxHeight = h + "px";
        };
        const origOnResize = this.onResize;
        this.onResize = function (size) {
          origOnResize?.call(this, size);
          syncHeight();
        };
        syncHeight();

        const panel = new PromptLibraryRandomPanel(this);
        panel.container = el;
        panel.init();
      };
    }

    // ── String concatenate node ────────────────────────────────────
    if (nodeData.name === "StringConcatenateNode") {
      const onNodeCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        onNodeCreated?.apply(this, arguments);

        const inputCountWidget = this.widgets.find((w) => w.name === "input_count");
        const delimiterWidget = this.widgets.find((w) => w.name === "delimiter");
        const resultWidget = this.widgets.find((w) => w.name === "result");

        if (resultWidget) {
          resultWidget.inputEl.readOnly = true;
          resultWidget.inputEl.style.opacity = 0.7;
        }

        const syncInputs = (count) => {
          if (!this.inputs) this.inputs = [];

          // Add inputs up to count
          for (let i = 1; i <= count; i++) {
            const name = `string${i}`;
            if (this.findInputSlot(name) === -1) {
              this.addInput(name, "STRING");
            }
          }

          // Remove inputs beyond count
          for (let i = this.inputs.length - 1; i >= 0; i--) {
            const name = this.inputs[i].name;
            if (name.startsWith("string")) {
              const num = parseInt(name.replace("string", ""));
              if (num > count || isNaN(num)) {
                this.removeInput(i);
              }
            }
          }

          this.setDirtyCanvas(true);
        };

        if (inputCountWidget) {
          const self = this;
          const origCallback = inputCountWidget.callback;
          inputCountWidget.callback = function (v) {
            const res = origCallback?.apply(this, arguments);
            syncInputs(v);
            return res;
          };
        }

        if (delimiterWidget) {
          const origCallback = delimiterWidget.callback;
          delimiterWidget.callback = function (v) {
            const res = origCallback?.apply(this, arguments);
            return res;
          };
        }

        // Initial sync
        setTimeout(() => {
          if (inputCountWidget) syncInputs(inputCountWidget.value);
        }, 0);
      };
    }
  },
});
