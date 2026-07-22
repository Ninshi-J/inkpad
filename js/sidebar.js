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
  $("setPaper").onchange = e => { S.paper = e.target.value; clampScroll(); markDirty(); };
  $("setOrient").onchange = e => { S.landscape = e.target.value === "l"; clampScroll(); markDirty(); };
  $("setTmpl").onchange = e => { S.template = e.target.value; markDirty(); };
  $("setRule").onchange = e => { S.ruleSp = Math.max(12, +e.target.value || 34); markDirty(); };
  $("setGrid").onchange = e => { S.gridSp = Math.max(10, +e.target.value || 28); markDirty(); };
  $("setOutline").onchange = e => { S.outline = e.target.checked; markDirty(); };

  // "This page" overrides — each control falls back to the document default when left blank/unset.
  const setPageOverride = (field, value) => {
    const p = curPage();
    if (value === null || value === "") { if (S.pageStyles && S.pageStyles[p]) delete S.pageStyles[p][field]; }
    else { S.pageStyles = S.pageStyles || {}; S.pageStyles[p] = { ...(S.pageStyles[p] || {}), [field]: value }; }
    markDirty(); needsDraw = true;
  };
  $("setPageTmpl").onchange = e => setPageOverride("template", e.target.value || null);
  $("setPageRule").onchange = e => setPageOverride("ruleSp", e.target.value ? Math.max(12, +e.target.value) : null);
  $("setPageGrid").onchange = e => setPageOverride("gridSp", e.target.value ? Math.max(10, +e.target.value) : null);
  $("setPageOutline").onchange = e => setPageOverride("outline", e.target.value === "" ? null : e.target.value === "1");
  $("setPageOrient").onchange = e => { setPageOverride("landscape", e.target.value === "" ? null : e.target.value === "l"); clampScroll(); };
  refreshPageSetupControls();

  $("addPageBtn").onclick = () => { if (S.pages < MAX_PAGES) { S.pages++; V.scroll = maxScroll(); markDirty(); syncUI(); } };
  $("insertPageBtn").onclick = () => { const at = curPage() + 1; insertPageAt(at); V.scroll = at * stride(); clampScroll(); };
  $("clearPageBtn").onclick = clearCurrentPage;
  $("delPageBtn").onclick = () => { if (confirm(`Delete page ${curPage() + 1}?`)) deleteCurrentPage(); };
  $("importPdfBtn").onclick = () => $("filePdf").click();
  $("deleteDocBtn").onclick = () => confirmDialog(
    "Delete entire document?",
    "This clears every page, all ink, images, text, tape, and recorded audio.",
    deleteDocument
  );
  const sk = $("sideKeys");
  sk.innerHTML = "";
  for (const a of ACTIONS) {
    const row = document.createElement("div");
    row.className = "keymap-row";
    row.innerHTML = `<span>${a.label}</span><kbd>${keyFor(a.id)}</kbd>`;
    row.querySelector("kbd").onclick = ev => beginRemap(a.id, ev.target);
    sk.appendChild(row);
  }
  $("resetKeysBtn").onclick = () => { defaultKeymap(); saveKeymap(); rebuildSidebar(); refreshHelp(); buildSelToolbar(); };

  $("libNewNotebookBtn").onclick = () => createNotebook(null);
  $("libNewFolderBtn").onclick = () => createFolder(null);
  renderLibTree();
}

/* ---------------- Files sidebar: folder/notebook tree ---------------- */
function libChildren(parentId) {
  parentId = parentId || null;
  return {
    folders: libFolders.filter(f => (f.parentId || null) === parentId).sort((a, b) => a.name.localeCompare(b.name)),
    notebooks: libNotebooks.filter(n => (n.folderId || null) === parentId).sort((a, b) => a.name.localeCompare(b.name)),
  };
}
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
  renderLibStorageStatus();
  const root = $("libTree");
  if (!root) return; // sidebar not built yet (initLibrary() can resolve before first rebuildSidebar() call lands)
  root.innerHTML = "";
  const { folders, notebooks } = libChildren(null);
  if (!folders.length && !notebooks.length) {
    root.innerHTML = `<div class="lib-empty">No notebooks yet</div>`;
  } else {
    root.appendChild(buildNotebookGroup("root", 0, notebooks));
    for (const f of folders) root.appendChild(buildFolderRow(f, 0));
  }
  // Dropping on the tree's own background (not on a specific row) files the dragged item at the
  // top level — the "un-nest it" gesture.
  root.ondragover = e => { if (libDrag) { e.preventDefault(); root.classList.add("dragover"); } };
  root.ondragleave = e => { if (e.target === root) root.classList.remove("dragover"); };
  root.ondrop = e => {
    e.preventDefault(); root.classList.remove("dragover");
    if (libDrag) moveItem(libDrag.kind, libDrag.id, null);
  };
}
let libDrag = null; // { kind: "folder"|"notebook", id } of the row currently being dragged
let libNbGroupCollapsed = new Set(); // folder ids (or "root") whose own direct-notebook group is collapsed
// A folder's own notebooks render as one collapsible group, ABOVE its subfolders — so opening
// "Algebra" shows its notebooks (Graphing, Expanding brackets, ...) immediately, instead of
// burying them below every nested subfolder's entire contents (subfolders sort alphabetically
// after notebooks used to, which meant a folder's own notebooks could end up far down the list
// once it had a few levels of subfolders under it — see [[inkpad-architecture]]). `parentKey` is
// the folder id this group belongs to, or the literal string "root" for top-level notebooks.
function buildNotebookGroup(parentKey, depth, notebooks) {
  const frag = document.createDocumentFragment();
  if (!notebooks.length) return frag;
  const collapsed = libNbGroupCollapsed.has(parentKey);
  const header = document.createElement("div");
  header.className = "lib-row lib-nbgroup";
  header.style.paddingLeft = (depth * 14) + "px";
  header.innerHTML = `<span class="lib-toggle">${collapsed ? "▸" : "▾"}</span><span class="lib-name">Notebooks (${notebooks.length})</span>`;
  header.onclick = () => {
    libNbGroupCollapsed.has(parentKey) ? libNbGroupCollapsed.delete(parentKey) : libNbGroupCollapsed.add(parentKey);
    renderLibTree();
  };
  frag.appendChild(header);
  if (!collapsed) for (const nb of notebooks) frag.appendChild(buildNotebookRow(nb, depth));
  return frag;
}
function buildFolderRow(f, depth) {
  const wrap = document.createElement("div");
  const row = document.createElement("div");
  row.className = "lib-row lib-folder";
  row.style.paddingLeft = (depth * 14) + "px";
  row.draggable = true;
  const expanded = libExpanded.has(f.id);
  const { folders, notebooks } = libChildren(f.id);
  const hasChildren = folders.length + notebooks.length > 0;
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
      ${showRosterBtn ? `<button type="button" data-act="roster" title="${hasOwnRoster ? "This folder's class roster" : "Create a class roster for this folder"}">🎓</button>` : ""}
      <button type="button" data-act="rename" title="Rename">✎</button>
      <button type="button" data-act="delete" title="Delete">\u{1F5D1}</button>
    </span>`;
  wrap.appendChild(row);
  const nameEl = row.querySelector(".lib-name");
  const childWrap = document.createElement("div");
  childWrap.className = "lib-children";
  if (!expanded) childWrap.style.display = "none";
  if (expanded) {
    childWrap.appendChild(buildNotebookGroup(f.id, depth + 1, notebooks));
    for (const sub of folders) childWrap.appendChild(buildFolderRow(sub, depth + 1));
  }
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
  const rosterBtn = row.querySelector('[data-act=roster]');
  if (rosterBtn) rosterBtn.onclick = e => { e.stopPropagation(); manageFolderRoster(f); };
  row.querySelector('[data-act=rename]').onclick = e => { e.stopPropagation(); startInlineRename(nameEl, "folder", f.id); };
  row.querySelector('[data-act=delete]').onclick = e => { e.stopPropagation(); deleteFolder(f.id); };

  row.addEventListener("dragstart", e => { libDrag = { kind: "folder", id: f.id }; if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"; e.stopPropagation(); });
  row.addEventListener("dragend", () => { libDrag = null; });
  row.addEventListener("dragover", e => {
    if (!libDrag || (libDrag.kind === "folder" && (libDrag.id === f.id || isDescendantFolder(f.id, libDrag.id)))) return;
    e.preventDefault(); e.stopPropagation(); row.classList.add("dragover");
  });
  row.addEventListener("dragleave", () => row.classList.remove("dragover"));
  row.addEventListener("drop", e => {
    e.preventDefault(); e.stopPropagation(); row.classList.remove("dragover");
    if (libDrag) { libExpanded.add(f.id); moveItem(libDrag.kind, libDrag.id, f.id); }
  });
  return wrap;
}
function buildNotebookRow(n, depth) {
  const row = document.createElement("div");
  row.className = "lib-row lib-notebook" + (n.id === activeNotebookId ? " active" : "");
  row.style.paddingLeft = (depth * 14 + 12) + "px";
  row.draggable = true;
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
  row.addEventListener("dragend", () => { libDrag = null; });
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
}
function refreshHelp() {
  const dyn = ACTIONS.map(a => [keyFor(a.id), a.label]);
  const fixed = [
    ["1–6", "Preset colors"],
    ["Shift (while drawing)", "Straight line, snapped to horizontal/vertical"],
    ["Wheel / Ctrl+Wheel", "Scroll / zoom at cursor"], ["Ctrl+0", "Reset zoom"],
    ["PgUp / PgDn", "Jump a page"], ["F5 / Space", "Record / play replay"],
    ["Ctrl+Click ink", "Jump audio to stroke"], ["Ctrl+Z / Ctrl+Y", "Undo / redo"],
    ["Ctrl+D", "Duplicate selection"], ["Ctrl+C / Ctrl+V", "Copy / paste selection"],
    ["Ctrl+S / Ctrl+O", "Save / open"],
    ["Ctrl+E", "Export PDF"], ["Del", "Delete selection / clear page"],
    ["Alt+Click tape", "Delete tape"],
    ["F1 / F2 / F3 / F4", "Help / panel / pop-out / overview"],
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
  if (killed.length) { pushUndo({ op: "del", items: killed }); clearSelection(); markDirty(); }
}

/* ---------------- random picker (students / dice / number spinner) ---------------- */
// Named class rosters — a teacher with several periods keeps one roster per class and switches
// the active one from the Students tab, rather than retyping/pasting a list every time. Follows
// the same idb-vs-connected-folder backend as stamps/notebooks (see storeGetAll/storePut).
let libRosters = []; // [{id, name, names: string[]}]
let activeRosterId = null;
