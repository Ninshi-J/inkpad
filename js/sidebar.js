"use strict";
const SIDEBAR_SECTION_DEFAULTS = { files: true, docSetup: true, pageSetup: true, pageTools: true, shortcuts: false };
function sidebarSectionOpen(key) {
  const v = localStorage.getItem("inkpad.sidebarSection." + key);
  return v === null ? SIDEBAR_SECTION_DEFAULTS[key] : v === "1";
}
function rebuildSidebar() {
  SB.innerHTML = `
    <details class="side-section" id="secFiles" ${sidebarSectionOpen("files") ? "open" : ""}>
      <summary>Files</summary>
      <div id="libStorageStatus" class="lib-storage-status"></div>
      <div class="lib-toolbar">
        <button class="side-btn" id="libNewNotebookBtn" style="width:auto;flex:1;margin-top:0;">+ Notebook</button>
        <button class="side-btn" id="libNewFolderBtn" style="width:auto;flex:1;margin-top:0;">+ Folder</button>
      </div>
      <div id="libTree" class="lib-tree"></div>
    </details>
    <details class="side-section" id="secDocSetup" ${sidebarSectionOpen("docSetup") ? "open" : ""}>
      <summary>Document setup</summary>
      <div class="side-row"><label>Paper</label>
        <select id="setPaper">
          <option value="a4">A4</option><option value="letter">Letter</option><option value="a5">A5</option>
          <option value="widescreen">Widescreen (16:9)</option>
        </select></div>
      <div class="side-row"><label>Orientation</label>
        <select id="setOrient"><option value="p">Portrait</option><option value="l">Landscape</option></select></div>
      <div class="side-row"><label>Default template</label>
        <select id="setTmpl">
          <option value="ruled">Ruled</option><option value="grid">Grid</option>
          <option value="dotted">Dotted</option><option value="blank">Blank</option>
        </select></div>
      <div class="side-row"><label>Default line spacing</label><input id="setRule" type="number" min="18" max="80" step="2"></div>
      <div class="side-row"><label>Default grid / dot size</label><input id="setGrid" type="number" min="14" max="80" step="2"></div>
      <div class="side-row"><label>Default page outline</label><input id="setOutline" type="checkbox"></div>
    </details>
    <details class="side-section" id="secPageSetup" ${sidebarSectionOpen("pageSetup") ? "open" : ""}>
      <summary>Page setup <span style="text-transform:none; letter-spacing:normal; font-weight:normal;">(this page)</span></summary>
      <div class="side-row"><label>Paper</label>
        <select id="setPagePaper">
          <option value="">(document default)</option>
          <option value="a4">A4</option><option value="letter">Letter</option><option value="a5">A5</option>
          <option value="widescreen">Widescreen (16:9)</option>
        </select></div>
      <div class="side-row"><label>Orientation</label>
        <select id="setPageOrient">
          <option value="">(document default)</option>
          <option value="p">Portrait</option><option value="l">Landscape</option>
        </select></div>
      <div class="side-row"><label>Template</label>
        <select id="setPageTmpl">
          <option value="">(document default)</option>
          <option value="ruled">Ruled</option><option value="grid">Grid</option>
          <option value="dotted">Dotted</option><option value="blank">Blank</option>
        </select></div>
      <div class="side-row"><label>Line spacing</label><input id="setPageRule" type="number" min="18" max="80" step="2" placeholder="default"></div>
      <div class="side-row"><label>Grid / dot size</label><input id="setPageGrid" type="number" min="14" max="80" step="2" placeholder="default"></div>
      <div class="side-row"><label>Page outline</label>
        <select id="setPageOutline">
          <option value="">(document default)</option>
          <option value="1">On</option><option value="0">Off</option>
        </select></div>
    </details>
    <details class="side-section" id="secPageTools" ${sidebarSectionOpen("pageTools") ? "open" : ""}>
      <summary>Page tools</summary>
      <button class="side-btn" id="addPageBtn">+ Add page</button>
      <button class="side-btn" id="insertPageBtn">+ Insert page here</button>
      <button class="side-btn" id="clearPageBtn">Clear current page</button>
      <button class="side-btn" id="delPageBtn">Delete current page</button>
      <button class="side-btn" id="importPdfBtn">Import PDF…</button>
      <button class="side-btn" id="deleteDocBtn" style="color:#B03A3A;border-color:#E3C3C3">Delete entire document…</button>
    </details>
    <details class="side-section" id="secShortcuts" ${sidebarSectionOpen("shortcuts") ? "open" : ""}>
      <summary>Shortcuts</summary>
      <div class="keys" id="sideKeys"></div>
      <button class="side-btn" id="resetKeysBtn">Reset shortcuts</button>
    </details>`;
  for (const key of Object.keys(SIDEBAR_SECTION_DEFAULTS)) {
    const el = $("sec" + key[0].toUpperCase() + key.slice(1));
    el.addEventListener("toggle", () => localStorage.setItem("inkpad.sidebarSection." + key, el.open ? "1" : "0"));
  }
  $("setPaper").value = S.paper;
  $("setOrient").value = S.landscape ? "l" : "p";
  $("setTmpl").value = S.template;
  $("setRule").value = S.ruleSp;
  $("setGrid").value = S.gridSp;
  $("setOutline").checked = S.outline;
  // Page/document setup below is never undo-tracked (no pushUndo call) -- invalidateCleanMarker()
  // stops undo/redo from ever mistaking a stack position match for "back to clean" while one of
  // these is still unsaved (see its comment in state.js).
  // withPageGrid: paper and orientation both change how much height each page reserves, and every
  // object's position is an absolute world y — so without moving the content with the grid, page 2
  // onwards slides off the page it was on (see reflowPagesForStride in js/state.js).
  $("setPaper").onchange = e => { withPageGrid(() => { S.paper = e.target.value; }); clampScroll(); markDirty(); invalidateCleanMarker(); };
  $("setOrient").onchange = e => { withPageGrid(() => { S.landscape = e.target.value === "l"; }); clampScroll(); markDirty(); invalidateCleanMarker(); };
  $("setTmpl").onchange = e => { S.template = e.target.value; markDirty(); invalidateCleanMarker(); };
  $("setRule").onchange = e => { S.ruleSp = Math.max(12, +e.target.value || 34); markDirty(); invalidateCleanMarker(); };
  $("setGrid").onchange = e => { S.gridSp = Math.max(10, +e.target.value || 28); markDirty(); invalidateCleanMarker(); };
  $("setOutline").onchange = e => { S.outline = e.target.checked; markDirty(); invalidateCleanMarker(); };

  // "This page" overrides — each control falls back to the document default when left blank/unset.
  const setPageOverride = (field, value) => {
    const p = curPage();
    if (value === null || value === "") { if (S.pageStyles && S.pageStyles[p]) delete S.pageStyles[p][field]; }
    else { S.pageStyles = S.pageStyles || {}; S.pageStyles[p] = { ...(S.pageStyles[p] || {}), [field]: value }; }
    markDirty(); invalidateCleanMarker(); needsDraw = true;
  };
  $("setPageTmpl").onchange = e => setPageOverride("template", e.target.value || null);
  $("setPageRule").onchange = e => setPageOverride("ruleSp", e.target.value ? Math.max(12, +e.target.value) : null);
  $("setPageGrid").onchange = e => setPageOverride("gridSp", e.target.value ? Math.max(10, +e.target.value) : null);
  $("setPageOutline").onchange = e => setPageOverride("outline", e.target.value === "" ? null : e.target.value === "1");
  /* Both of these change how tall the tallest page in the document is, and every page reserves
     that same height — so changing one page's paper moves the page boundaries for all of them.
     withPageGrid puts the content back on its own page afterwards; without it everything below
     page 1 slides by a whole slot per boundary. */
  const setPageSizeOverride = (field, value) => {
    withPageGrid(() => setPageOverride(field, value));
    clampScroll();
  };
  $("setPagePaper").onchange = e => setPageSizeOverride("paper", e.target.value || null);
  $("setPageOrient").onchange = e => setPageSizeOverride("landscape", e.target.value === "" ? null : e.target.value === "l");
  refreshPageSetupControls();

  $("addPageBtn").onclick = () => { if (S.pages < MAX_PAGES) { S.pages++; V.scroll = maxScroll(); markDirty(); invalidateCleanMarker(); syncUI(); } };
  $("insertPageBtn").onclick = () => { const at = curPage() + 1; insertPageAt(at); V.scroll = at * stride(); clampScroll(); };
  $("clearPageBtn").onclick = clearCurrentPage;
  $("delPageBtn").onclick = () => confirmDialog(
    `Delete page ${curPage() + 1}?`,
    "Everything on this page — ink, text, images, tape — goes with it.",
    deleteCurrentPage,
  );
  $("importPdfBtn").onclick = () => $("filePdf").click();
  $("deleteDocBtn").onclick = () => confirmDialog(
    "Delete entire document?",
    "This clears every page, all ink, images, text, tape, and recorded audio.",
    deleteDocument
  );
  renderKeymapRows($("sideKeys")); // shared with the settings dialog — see js/keymap-colorring.js
  $("resetKeysBtn").onclick = () => { defaultKeymap(); saveKeymap(); refreshKeymapUI(); };

  // Into the working folder when there is one: while scoped, the tree top level is that folder,
  // so a new notebook filed at the real root would be created straight out of sight.
  $("libNewNotebookBtn").onclick = () => createNotebook(libRootId());
  $("libNewFolderBtn").onclick = () => createFolder(libRootId());
  renderLibTree();
}

/* ---------------- Files sidebar: folder/notebook tree ---------------- */
// Folders and notebooks under the same parent are merged into one manually-ordered list (see
// storage.js's ensureLibOrder/moveItem) instead of notebooks always being grouped separately from
// folders — so a drag can freely interleave them, and there's no separate "collapse the notebooks"
// affordance needed beyond each folder's own expand/collapse.
function libChildren(parentId) {
  parentId = parentId || null;
  const folders = libFolders.filter(f => (f.parentId || null) === parentId).map(item => ({ kind: "folder", item }));
  const notebooks = libNotebooks.filter(n => (n.folderId || null) === parentId).map(item => ({ kind: "notebook", item }));
  return [...folders, ...notebooks].sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0) || a.item.name.localeCompare(b.item.name));
}
function buildLibChild(c, depth) { return c.kind === "folder" ? buildFolderRow(c.item, depth) : buildNotebookRow(c.item, depth); }
// Which zone of a row a dragged item is hovering over: "before"/"after" reorder as a sibling, or
// (only offered for folders, in the row's middle band) "nest" to drop inside it.
function dragZone(e, row, allowNest) {
  const r = row.getBoundingClientRect();
  const frac = (e.clientY - r.top) / r.height;
  if (!allowNest) return frac < 0.5 ? "before" : "after";
  if (frac < 0.25) return "before";
  if (frac > 0.75) return "after";
  return "nest";
}
// The sibling right after `id` in parentId's list, skipping the item currently being dragged (which
// may itself be that "next" sibling) — used to translate a "drop after this row" gesture into the
// insertBeforeKey moveItem() actually wants. Null means "id is last", i.e. append at the end.
function siblingKeyAfter(parentId, kind, id, dragged) {
  const list = libChildren(parentId).filter(c => !(dragged && c.kind === dragged.kind && c.item.id === dragged.id));
  const idx = list.findIndex(c => c.kind === kind && c.item.id === id);
  if (idx === -1 || idx === list.length - 1) return null;
  return { kind: list[idx + 1].kind, id: list[idx + 1].item.id };
}
function clearDropClasses(row) { row.classList.remove("dragover", "drop-before", "drop-after"); }
// Connect/disconnect/reconnect controls for the folder-on-disk backend — kept in step with
// renderLibTree() (called from there) since every place that changes storageBackend/fsRoot/
// fsPendingHandle already triggers a tree re-render, so this piggybacks on the same call sites
// instead of needing its own scattered throughout connectToFsHandle/disconnectFsRoot/etc.
function renderLibStorageStatus() {
  const el = $("libStorageStatus");
  if (!el) return;
  if (storageBackend === "fs" && fsRoot) {
    el.innerHTML =
      `<span class="lib-storage-label" title="Notebooks are saved as real files in this folder">📁 ${escapeXml(fsRoot.name)}</span>` +
      `<button type="button" id="libDisconnectBtn">Disconnect</button>`;
    $("libDisconnectBtn").onclick = disconnectFsRoot;
  } else if (fsPendingHandle) {
    el.innerHTML =
      `<span class="lib-storage-label">📁 ${escapeXml(fsPendingHandle.name)} (disconnected)</span>` +
      `<button type="button" id="libReconnectBtn">Reconnect</button>`;
    $("libReconnectBtn").onclick = reconnectFs;
  } else {
    el.innerHTML = `<button type="button" class="side-btn" id="libConnectBtn" style="width:100%;margin-top:0;">📁 Use a folder on disk…</button>`;
    $("libConnectBtn").onclick = chooseFsFolder;
  }
}
function renderLibTree() {
  ensureLibOrder();
  renderLibStorageStatus();
  const root = $("libTree");
  if (!root) return; // sidebar not built yet (initLibrary() can resolve before first rebuildSidebar() call lands)
  root.innerHTML = "";
  /* Scoped to one folder, that folder's contents ARE the library: its children render at the
     top level with a banner naming what you are inside, rather than the whole tree with
     everything else greyed out. The banner is the only way back out, so it is always shown. */
  const scope = libScopeFolder();
  // Say where the toolbar buttons will file things, so "+ Notebook" does not keep reading as
  // "at the top of the library" once the top of the library is a folder.
  const nbBtn = $("libNewNotebookBtn"), foBtn = $("libNewFolderBtn");
  if (nbBtn) nbBtn.title = scope ? `New notebook in ${scope.name}` : "New notebook";
  if (foBtn) foBtn.title = scope ? `New folder in ${scope.name}` : "New folder";
  if (scope) {
    const bar = document.createElement("div");
    bar.className = "lib-scope";
    bar.innerHTML = `<span class="lib-scope-name" title="Working in this folder only">\u{1F4C2} ${escapeXml(scope.name)}</span>`
      + `<button type="button" class="lib-scope-clear" title="Show the whole library again">Show all</button>`;
    bar.querySelector(".lib-scope-clear").onclick = () => setLibScope(null);
    root.appendChild(bar);
  }
  const children = libChildren(scope ? scope.id : null);
  if (!children.length) {
    const empty = document.createElement("div");
    empty.className = "lib-empty";
    empty.textContent = scope ? "Nothing in this folder yet" : "No notebooks yet";
    root.appendChild(empty);
  } else {
    for (const c of children) root.appendChild(buildLibChild(c, 0));
  }
  // Dropping on the tree's own background (not on a specific row) files the dragged item at the
  // top level — the "un-nest it" gesture.
  root.ondragover = e => { if (libDrag) { e.preventDefault(); root.classList.add("dragover"); } };
  root.ondragleave = e => { if (e.target === root) root.classList.remove("dragover"); };
  root.ondrop = e => {
    e.preventDefault(); root.classList.remove("dragover");
    if (libDrag) moveItem(libDrag.kind, libDrag.id, libRootId());
  };
}
let libDrag = null; // { kind: "folder"|"notebook", id } of the row currently being dragged
function buildFolderRow(f, depth) {
  const wrap = document.createElement("div");
  const row = document.createElement("div");
  row.className = "lib-row lib-folder";
  row.style.paddingLeft = (depth * 14) + "px";
  row.draggable = true;
  row.dataset.id = f.id;
  const expanded = libExpanded.has(f.id);
  const children = libChildren(f.id);
  const hasChildren = children.length > 0;
  // Only offer "create a roster" on top-level folders (the real-world unit that gets a class
  // list, e.g. a "Y9" folder) — showing it on every subject subfolder underneath is clutter,
  // since those inherit the top-level roster automatically. A subfolder that already has its
  // own override roster (rare — e.g. a merged elective) still shows the button so it stays
  // manageable/deletable.
  const hasOwnRoster = libRosters.some(r => r.folderId === f.id);
  const showRosterBtn = !f.parentId || hasOwnRoster;
  row.innerHTML = `
    <span class="lib-toggle">${hasChildren ? (expanded ? "▾" : "▸") : ""}</span>
    <span class="lib-icon">\u{1F4C1}</span>
    <span class="lib-name">${escapeXml(f.name)}</span>
    <span class="lib-actions">
      <button type="button" data-act="newnb" title="New notebook here">➕\u{1F4C4}</button>
      <button type="button" data-act="newfolder" title="New folder here">➕\u{1F4C1}</button>
      <button type="button" data-act="focus" title="Work in this folder only - hides the rest, and stops notebooks outside it downloading to this device">\u{1F3AF}</button>
      <button type="button" data-act="props" title="Folder properties — default template for new notebooks here">⚙️</button>
      ${showRosterBtn ? `<button type="button" data-act="roster" title="${hasOwnRoster ? "This folder's class roster" : "Create a class roster for this folder"}">🎓</button>` : ""}
      <button type="button" data-act="rename" title="Rename">✎</button>
      <button type="button" data-act="delete" title="Delete">\u{1F5D1}</button>
    </span>`;
  wrap.appendChild(row);
  const nameEl = row.querySelector(".lib-name");
  const childWrap = document.createElement("div");
  childWrap.className = "lib-children";
  if (!expanded) childWrap.style.display = "none";
  if (expanded) for (const c of children) childWrap.appendChild(buildLibChild(c, depth + 1));
  wrap.appendChild(childWrap);

  const toggle = () => {
    if (!hasChildren) return;
    libExpanded.has(f.id) ? libExpanded.delete(f.id) : libExpanded.add(f.id);
    renderLibTree();
  };
  row.querySelector(".lib-toggle").onclick = e => { e.stopPropagation(); toggle(); };
  row.onclick = e => { if (e.target !== nameEl) toggle(); };
  nameEl.ondblclick = e => { e.stopPropagation(); startInlineRename(nameEl, "folder", f.id); };
  row.querySelector('[data-act=newnb]').onclick = e => { e.stopPropagation(); createNotebook(f.id); };
  row.querySelector('[data-act=newfolder]').onclick = e => { e.stopPropagation(); createFolder(f.id); };
  row.querySelector('[data-act=focus]').onclick = e => { e.stopPropagation(); setLibScope(f.id); };
  row.querySelector('[data-act=props]').onclick = e => { e.stopPropagation(); openFolderProps(f); };
  const rosterBtn = row.querySelector('[data-act=roster]');
  if (rosterBtn) rosterBtn.onclick = e => { e.stopPropagation(); manageFolderRoster(f); };
  row.querySelector('[data-act=rename]').onclick = e => { e.stopPropagation(); startInlineRename(nameEl, "folder", f.id); };
  row.querySelector('[data-act=delete]').onclick = e => { e.stopPropagation(); deleteFolder(f.id); };
  // Right-click is a bonus shortcut to the same properties dialog for mouse users — the ⚙ button
  // above is the reliable path everywhere else, since there's no right-click on a touchscreen/iPad.
  row.addEventListener("contextmenu", e => { e.preventDefault(); e.stopPropagation(); openFolderProps(f); });

  row.addEventListener("dragstart", e => { libDrag = { kind: "folder", id: f.id }; if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"; e.stopPropagation(); });
  row.addEventListener("dragend", () => { libDrag = null; clearDropClasses(row); });
  // Top/bottom bands reorder this folder as a sibling; the middle band nests the dragged item
  // inside it instead (existing "drop onto a folder" gesture, now just one of three zones).
  row.addEventListener("dragover", e => {
    if (!libDrag || (libDrag.kind === "folder" && (libDrag.id === f.id || isDescendantFolder(f.id, libDrag.id)))) return;
    e.preventDefault(); e.stopPropagation();
    const zone = dragZone(e, row, true);
    clearDropClasses(row);
    row.classList.add(zone === "nest" ? "dragover" : zone === "before" ? "drop-before" : "drop-after");
    row.dataset.dropZone = zone;
  });
  row.addEventListener("dragleave", () => clearDropClasses(row));
  row.addEventListener("drop", e => {
    e.preventDefault(); e.stopPropagation();
    const zone = row.dataset.dropZone;
    clearDropClasses(row);
    if (!libDrag) return;
    if (zone === "nest") { libExpanded.add(f.id); moveItem(libDrag.kind, libDrag.id, f.id); }
    else {
      const parentId = f.parentId || null;
      const beforeKey = zone === "before" ? { kind: "folder", id: f.id } : siblingKeyAfter(parentId, "folder", f.id, libDrag);
      moveItem(libDrag.kind, libDrag.id, parentId, beforeKey);
    }
  });
  return wrap;
}
// Folder properties: the default doc settings (paper/orientation/template/ruling/grid/outline) a
// brand-new notebook created in this folder starts with, instead of the app-wide default — see
// resolveDocDefaultsForFolder() in storage.js. Each field has an "(app default)" opt-out (mirroring
// the sidebar's own "This page" override controls) so a folder can override just one field while
// leaving the rest inherited from a parent folder's own defaults, or from the app default.
function openFolderProps(f) {
  const d = f.docDefaults || {};
  $("folderPropsName").textContent = f.name;
  $("fpPaper").value = d.paper || "";
  $("fpOrient").value = d.landscape == null ? "" : (d.landscape ? "l" : "p");
  $("fpTmpl").value = d.template || "";
  $("fpRule").value = d.ruleSp || "";
  $("fpGrid").value = d.gridSp || "";
  $("fpOutline").value = d.outline == null ? "" : (d.outline ? "1" : "0");
  const dlg = $("folderPropsDlg");
  dlg.showModal();
  $("folderPropsCancelBtn").onclick = () => dlg.close();
  $("folderPropsSaveBtn").onclick = async () => {
    const nd = {};
    if ($("fpPaper").value) nd.paper = $("fpPaper").value;
    if ($("fpOrient").value) nd.landscape = $("fpOrient").value === "l";
    if ($("fpTmpl").value) nd.template = $("fpTmpl").value;
    if ($("fpRule").value) nd.ruleSp = Math.max(12, +$("fpRule").value);
    if ($("fpGrid").value) nd.gridSp = Math.max(10, +$("fpGrid").value);
    if ($("fpOutline").value !== "") nd.outline = $("fpOutline").value === "1";
    if (Object.keys(nd).length) f.docDefaults = nd; else delete f.docDefaults;
    try { await storePut("folders", f); } catch (_) {}
    dlg.close();
  };
}
function buildNotebookRow(n, depth) {
  const row = document.createElement("div");
  row.className = "lib-row lib-notebook" + (n.id === activeNotebookId ? " active" : "");
  row.style.paddingLeft = (depth * 14 + 12) + "px";
  row.draggable = true;
  row.dataset.id = n.id;
  row.innerHTML = `
    <span class="lib-icon">\u{1F4C4}</span>
    <span class="lib-name">${escapeXml(n.name)}</span>
    <span class="lib-actions">
      <button type="button" data-act="dup" title="Duplicate">⧉</button>
      <button type="button" data-act="rename" title="Rename">✎</button>
      <button type="button" data-act="delete" title="Delete">\u{1F5D1}</button>
    </span>`;
  const nameEl = row.querySelector(".lib-name");
  row.onclick = e => { if (!nameEl.isContentEditable) switchNotebook(n.id); };
  nameEl.ondblclick = e => { e.stopPropagation(); startInlineRename(nameEl, "notebook", n.id); };
  row.querySelector('[data-act=dup]').onclick = e => { e.stopPropagation(); duplicateNotebook(n.id); };
  row.querySelector('[data-act=rename]').onclick = e => { e.stopPropagation(); startInlineRename(nameEl, "notebook", n.id); };
  row.querySelector('[data-act=delete]').onclick = e => { e.stopPropagation(); deleteNotebook(n.id); };

  row.addEventListener("dragstart", e => { libDrag = { kind: "notebook", id: n.id }; if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"; e.stopPropagation(); });
  row.addEventListener("dragend", () => { libDrag = null; clearDropClasses(row); });
  // Notebooks can't contain anything, so unlike a folder row this only ever reorders a sibling —
  // top half of the row means "before", bottom half means "after".
  row.addEventListener("dragover", e => {
    if (!libDrag || (libDrag.kind === "notebook" && libDrag.id === n.id)) return;
    e.preventDefault(); e.stopPropagation();
    const zone = dragZone(e, row, false);
    clearDropClasses(row);
    row.classList.add(zone === "before" ? "drop-before" : "drop-after");
    row.dataset.dropZone = zone;
  });
  row.addEventListener("dragleave", () => clearDropClasses(row));
  row.addEventListener("drop", e => {
    e.preventDefault(); e.stopPropagation();
    const zone = row.dataset.dropZone;
    clearDropClasses(row);
    if (!libDrag) return;
    const parentId = n.folderId || null;
    const beforeKey = zone === "before" ? { kind: "notebook", id: n.id } : siblingKeyAfter(parentId, "notebook", n.id, libDrag);
    moveItem(libDrag.kind, libDrag.id, parentId, beforeKey);
  });
  return row;
}
// Rename in place — double-click (or the pencil button) turns the row's name span into an
// editable field, matching how the color-add "+" and other inline controls in this app avoid
// popping a whole separate dialog for a one-field edit.
function startInlineRename(nameEl, kind, id) {
  const original = nameEl.textContent;
  nameEl.contentEditable = "true";
  nameEl.spellcheck = false;
  libEditingName = true;
  nameEl.focus();
  const range = document.createRange();
  range.selectNodeContents(nameEl);
  const sel2 = window.getSelection();
  sel2.removeAllRanges(); sel2.addRange(range);
  let done = false;
  const onKeydown = e => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); nameEl.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  };
  const onBlur = () => finish(true);
  const finish = async commit => {
    if (done) return; done = true;
    nameEl.removeEventListener("keydown", onKeydown);
    nameEl.removeEventListener("blur", onBlur);
    nameEl.contentEditable = "false";
    libEditingName = false;
    const val = nameEl.textContent.trim();
    if (commit && val && val !== original) { await renameLibItem(kind, id, val); renderLibTree(); }
    else nameEl.textContent = original;
  };
  nameEl.addEventListener("keydown", onKeydown);
  nameEl.addEventListener("blur", onBlur);
}
// Keeps the "This page" override controls in sync with whichever page is currently in view.
function refreshPageSetupControls() {
  const tmplEl = document.getElementById("setPageTmpl");
  if (!tmplEl) return;
  const o = (S.pageStyles && S.pageStyles[curPage()]) || {};
  tmplEl.value = o.template || "";
  document.getElementById("setPageRule").value = o.ruleSp || "";
  document.getElementById("setPageGrid").value = o.gridSp || "";
  document.getElementById("setPageOutline").value = o.outline == null ? "" : (o.outline ? "1" : "0");
  document.getElementById("setPageOrient").value = o.landscape == null ? "" : (o.landscape ? "l" : "p");
  document.getElementById("setPagePaper").value = o.paper || "";
}
function refreshHelp() {
  const dyn = ACTIONS.map(a => [keyFor(a.id), a.label]);
  const fixed = [
    ["1–6", "Preset colors"],
    ["Shift (while drawing)", "Straight line, snapped to horizontal/vertical"],
    ["Wheel / Ctrl+Wheel", "Scroll / zoom at cursor"], ["Ctrl+0", "Reset zoom"],
    ["PgUp / PgDn", "Jump a page"], ["F5 / Space", "Record / play audio replay"],
    ["F6", "Record canvas video + separate audio file"],
    ["Ctrl+Click ink", "Jump audio to stroke"], ["Ctrl+Z / Ctrl+Y", "Undo / redo"],
    ["Ctrl+D", "Duplicate selection"], ["Ctrl+C / Ctrl+V", "Copy / paste selection"],
    ["Ctrl+G / Ctrl+Shift+G", "Group / ungroup selection"],
    ["Ctrl+] / Ctrl+[", "Bring forward / send back (Shift: all the way)"],
    ["Ctrl+S / Ctrl+O", "Save / open"],
    ["Ctrl+E", "Export PDF"], ["Del", "Delete selection / clear page"],
    ["Ctrl+B / I / U (in a text box)", "Bold / italic / underline the selection"],
    ["( { $ (in a text box)", "Enclose the selected text in brackets, braces or maths"],
    ["Alt+Click tape", "Delete tape"],
    ["F1 / F2 / F3 / F4", "Help / panel / pop-out / overview"],
    ["Shift+F", "Toggle Teaching / Presentation mode"],
  ];
  $("helpKeys").innerHTML = [...dyn, ...fixed]
    .map(([k, v]) => `<div><span>${v}</span><kbd>${k}</kbd></div>`).join("");
}

function clearCurrentPage() {
  const p = curPage(), top = p * stride(), bot = top + pageDims(p).h;
  const killed = [];
  const inPage = y => y >= top && y < bot;
  doc.strokes.forEach(s => { if (!s.del && inPage(s.pts[0].y)) { s.del = true; killed.push({ kind: "stroke", ref: s }); } });
  doc.tapes.forEach(t => { if (!t.del && inPage(t.y)) { t.del = true; killed.push({ kind: "tape", ref: t }); } });
  doc.texts.forEach(t => { if (!t.del && inPage(t.y)) { t.del = true; killed.push({ kind: "text", ref: t }); } });
  doc.images.forEach(i => { if (!i.del && inPage(i.y)) { i.del = true; killed.push({ kind: "image", ref: i }); } });
  doc.timers.forEach(t => { if (!t.del && inPage(t.y)) { t.del = true; killed.push({ kind: "timer", ref: t }); } });
  doc.tables.forEach(t => { if (!t.del && inPage(t.y)) { t.del = true; killed.push({ kind: "table", ref: t }); } });
  if (killed.length) { pushUndo({ op: "del", items: killed }); clearSelection(); markDirty(); }
}

/* ---------------- random picker (students / dice / number spinner) ---------------- */
// Named class rosters — a teacher with several periods keeps one roster per class and switches
// the active one from the Students tab, rather than retyping/pasting a list every time. Follows
// the same idb-vs-connected-folder backend as stamps/notebooks (see storeGetAll/storePut).
let libRosters = []; // [{id, name, names: string[]}]
let activeRosterId = null;
