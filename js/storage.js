"use strict";
const IDB_NAME = "inkpad-db", IDB_VERSION = 5;
let idbReady = null;
function openIdb() {
  if (idbReady) return idbReady;
  idbReady = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("autosave")) db.createObjectStore("autosave");
      if (!db.objectStoreNames.contains("folders")) db.createObjectStore("folders", { keyPath: "id" });
      if (!db.objectStoreNames.contains("notebooks")) db.createObjectStore("notebooks", { keyPath: "id" });
      if (!db.objectStoreNames.contains("docdata")) db.createObjectStore("docdata");
      // Small key/value store for cross-session odds and ends that aren't notebook data itself —
      // currently just the last-connected folder's FileSystemDirectoryHandle (see fs* below),
      // which IndexedDB can hold directly via structured clone.
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      // Reusable "stamp" snippets (saved selections of ink/text/images a teacher inserts
      // repeatedly — a unit circle, a formula sheet) — global to the browser, not per-notebook.
      if (!db.objectStoreNames.contains("stamps")) db.createObjectStore("stamps", { keyPath: "id" });
      // Named class rosters for the random student picker — a teacher with several class periods
      // keeps one roster per class, switching the active one from the picker dialog.
      if (!db.objectStoreNames.contains("rosters")) db.createObjectStore("rosters", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbReady;
}
// Surfaces IndexedDB failures once instead of leaving them as silent swallowed rejections — this
// storage layer previously failed completely invisibly (e.g. under a browser/profile that blocks
// IndexedDB on file:// origins, or a private-browsing mode that rejects writes): the UI would
// accept input (a name typed into the "new notebook" prompt) but nothing would ever appear, with
// no error anywhere to explain why. One alert names the real cause instead of many.
let storageWarned = false;
function warnStorageUnavailable(err) {
  if (storageWarned) return;
  storageWarned = true;
  alert(
    "This browser/session won't let InkPad save notebooks persistently, so changes here will be " +
    "lost on reload.\n\n(" + (err && err.message ? err.message : err) + ")"
  );
}
function idbGetAll(store) {
  return openIdb().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  })).catch(err => { warnStorageUnavailable(err); throw err; });
}
function idbGet(store, key) {
  return openIdb().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  })).catch(err => { warnStorageUnavailable(err); throw err; });
}
function idbPut(store, value, key) {
  return openIdb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    key === undefined ? tx.objectStore(store).put(value) : tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  })).catch(err => { warnStorageUnavailable(err); throw err; });
}
function idbDelete(store, key) {
  return openIdb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  })).catch(err => { warnStorageUnavailable(err); throw err; });
}

/* ---------------- folder-on-disk storage (File System Access API) ----------------
   An alternative to the IndexedDB library above — instead of notebooks living only inside one
   browser's storage, they're written as real files under a folder the user picks (e.g. on a USB
   stick), so the same notebooks can be carried between computers. Layout inside that folder:
     inkpad-index.json   — { folders: [...], notebooks: [...] } metadata, mirrors the "folders"/
                            "notebooks" IndexedDB stores exactly (small, rewritten on every edit)
     docs/<id>.json       — one file per notebook, the same serialize() JSON used by Save/Open —
                            mirrors the "docdata" store, one file per key instead of one row per key
   storeGetAll/storeGet/storePut/storeDelete below dispatch to whichever backend (idb or fs) is
   currently active, so every higher-level library function (createNotebookRaw, moveItem, etc.)
   didn't need to change at all to gain this — they already only ever called the store* functions. */
let storageBackend = "idb"; // "idb" | "fs"
let fsRoot = null;          // FileSystemDirectoryHandle, set while storageBackend === "fs"
let fsIndexCache = null;    // in-memory mirror of <fsRoot>/inkpad-index.json
let fsWarned = false;
function warnFsUnavailable(err) {
  if (fsWarned) return;
  fsWarned = true;
  alert(
    "Lost access to the connected folder, so changes won't be saved there until you reconnect it " +
    "from the Files section (this happens if e.g. a USB drive is removed).\n\n(" +
    (err && err.message ? err.message : err) + ")"
  );
}
async function fsLoadIndex() {
  if (fsIndexCache) return fsIndexCache;
  try {
    const fh = await fsRoot.getFileHandle("inkpad-index.json");
    fsIndexCache = JSON.parse(await (await fh.getFile()).text());
  } catch (err) {
    // A missing index file means a genuinely new/empty folder — fine, start fresh there. Any OTHER
    // error (the drive was unplugged, the folder was deleted, permission is actually denied despite
    // queryPermission having said "granted") must NOT be treated the same way, or reconnecting to a
    // now-unreachable remembered folder would look indistinguishable from "this folder is empty" and
    // silently wipe out the view of whatever's really there instead of surfacing the failure.
    if (err && err.name === "NotFoundError") { fsIndexCache = { folders: [], notebooks: [] }; }
    else { throw err; }
  }
  if (!Array.isArray(fsIndexCache.folders)) fsIndexCache.folders = [];
  if (!Array.isArray(fsIndexCache.notebooks)) fsIndexCache.notebooks = [];
  return fsIndexCache;
}
async function fsSaveIndex() {
  const fh = await fsRoot.getFileHandle("inkpad-index.json", { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(fsIndexCache));
  await w.close();
}
async function fsGetAll(store) {
  try {
    const idx = await fsLoadIndex();
    return (idx[store] || []).slice();
  } catch (err) { warnFsUnavailable(err); throw err; }
}
async function fsGet(store, key) {
  try {
    if (store === "docdata") {
      const docs = await fsRoot.getDirectoryHandle("docs", { create: true });
      try {
        const fh = await docs.getFileHandle(key + ".json");
        return await (await fh.getFile()).text();
      } catch (_) { return null; } // no file yet for this notebook — not an error, just "no data"
    }
    const idx = await fsLoadIndex();
    return (idx[store] || []).find(x => x.id === key) ?? null;
  } catch (err) { warnFsUnavailable(err); throw err; }
}
async function fsPut(store, value, key) {
  try {
    if (store === "docdata") {
      const docs = await fsRoot.getDirectoryHandle("docs", { create: true });
      const fh = await docs.getFileHandle(key + ".json", { create: true });
      const w = await fh.createWritable();
      await w.write(value);
      await w.close();
      return;
    }
    const idx = await fsLoadIndex();
    const list = idx[store] || (idx[store] = []);
    const id = key !== undefined ? key : value.id;
    const i = list.findIndex(x => x.id === id);
    if (i >= 0) list[i] = value; else list.push(value);
    await fsSaveIndex();
  } catch (err) { warnFsUnavailable(err); throw err; }
}
async function fsDelete(store, key) {
  try {
    if (store === "docdata") {
      const docs = await fsRoot.getDirectoryHandle("docs", { create: true });
      try { await docs.removeEntry(key + ".json"); } catch (_) {}
      return;
    }
    const idx = await fsLoadIndex();
    idx[store] = (idx[store] || []).filter(x => x.id !== key);
    await fsSaveIndex();
  } catch (err) { warnFsUnavailable(err); throw err; }
}
function storeGetAll(store) { return storageBackend === "fs" ? fsGetAll(store) : idbGetAll(store); }
function storeGet(store, key) { return storageBackend === "fs" ? fsGet(store, key) : idbGet(store, key); }
function storePut(store, value, key) { return storageBackend === "fs" ? fsPut(store, value, key) : idbPut(store, value, key); }
function storeDelete(store, key) { return storageBackend === "fs" ? fsDelete(store, key) : idbDelete(store, key); }

/* ---------------- settings disk mirror ----------------
   Small teacher-wide preferences (palette, keyboard remapping, text defaults, per-tool color
   memory, timer config, last-used shape category) live in localStorage as the fast synchronous
   path that works from first load. When a folder is connected, they're additionally mirrored to
   inkpad-settings.json in that same folder — one shared file, not per-store like
   notebooks/stamps/rosters, since these are simple scalars rather than a growing collection. On
   connect, disk is treated as the source of truth (see connectToFsHandle) so the same
   preferences follow a teacher between computers that open the same folder. Rosters/stamps are
   NOT part of this file — they're each their own store (see storeGetAll) since they're
   collections that grow, not flat preferences. */
function currentSettingsSnapshot() {
  return {
    palette: PALETTE, hlPalette: HL_PALETTE, keymap,
    textFont: V.textFont, textSize: V.textSize, colorByTool: V.colorByTool,
    timerMode: timer.mode, timerDurationMs: timer.durationMs,
    shapeCategory: localStorage.getItem("inkpad.shapeCategory") || null,
  };
}
function applySettingsSnapshot(s) {
  if (!s || typeof s !== "object") return;
  if (Array.isArray(s.palette) && s.palette.length >= PALETTE_MIN) PALETTE = s.palette;
  if (Array.isArray(s.hlPalette) && s.hlPalette.length >= PALETTE_MIN) HL_PALETTE = s.hlPalette;
  if (s.keymap && typeof s.keymap === "object") {
    keymap = {};
    for (const [k, id] of Object.entries(s.keymap)) if (ACTIONS.some(a => a.id === id)) keymap[k] = id;
    ACTIONS.forEach(a => { if (!Object.values(keymap).includes(a.id)) keymap[a.key] = a.id; });
  }
  if (FONT_STACKS[s.textFont]) V.textFont = s.textFont;
  if (Number.isFinite(s.textSize) && s.textSize > 0) V.textSize = s.textSize;
  if (s.colorByTool && typeof s.colorByTool === "object") Object.assign(V.colorByTool, s.colorByTool);
  if (s.timerMode === "up" || s.timerMode === "down") timer.mode = s.timerMode;
  if (Number.isFinite(s.timerDurationMs) && s.timerDurationMs > 0) timer.durationMs = s.timerDurationMs;
  if (s.shapeCategory) try { localStorage.setItem("inkpad.shapeCategory", s.shapeCategory); } catch (_) {}
  savePalette(); saveKeymap(); saveTextDefaults(); saveTimerPrefs();
  try { localStorage.setItem("inkpad.colorByTool", JSON.stringify(V.colorByTool)); } catch (_) {}
}
let settingsSaveTimer = null;
// Debounced the same way scheduleAutosave() debounces notebook writes — called from every small
// setting's save path (savePalette, saveKeymap, ...) so those call sites don't need to know
// whether a folder happens to be connected right now.
function scheduleSettingsSave() {
  if (storageBackend !== "fs" || !fsRoot) return;
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => { saveSettingsToDisk().catch(() => {}); }, 700);
}
async function saveSettingsToDisk() {
  if (storageBackend !== "fs" || !fsRoot) return;
  const fh = await fsRoot.getFileHandle("inkpad-settings.json", { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(currentSettingsSnapshot()));
  await w.close();
}
async function loadSettingsFromDisk() {
  try {
    const fh = await fsRoot.getFileHandle("inkpad-settings.json");
    return JSON.parse(await (await fh.getFile()).text());
  } catch (_) { return null; } // no settings file in this folder yet — not an error
}

/* ---------------- notebook/folder library ---------------- */
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function defaultDocSettings() {
  return { paper: "a4", landscape: false, template: "ruled", ruleSp: 34, gridSp: 28, outline: true, pages: 1, pageStyles: {}, shapePrefs: {} };
}

let libFolders = [];       // [{id, name, parentId, createdAt}]
let libNotebooks = [];     // [{id, name, folderId, createdAt, updatedAt}]
let activeNotebookId = null;
let libExpanded = new Set(); // folder ids currently expanded in the sidebar tree
let libEditingName = false;  // true while a tree row's name is being inline-renamed — suspends global hotkeys, same idea as editingText

let autosaveTimer = null;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => { await flushAutosave(); dirty = false; syncStatus(); }, 900);
}
// Writes the in-memory document to the *currently active* notebook's record — called both by the
// debounced autosave timer and right before switching notebooks, so the notebook being left never
// loses whatever was typed/drawn in the last <900ms.
async function flushAutosave() {
  clearTimeout(autosaveTimer);
  if (!activeNotebookId) return;
  try {
    await storePut("docdata", await serialize(), activeNotebookId);
    const nb = libNotebooks.find(n => n.id === activeNotebookId);
    if (nb) { nb.updatedAt = Date.now(); await storePut("notebooks", nb); }
  } catch (_) {}
}

async function initLibrary() {
  try {
    libFolders = await idbGetAll("folders");
    libNotebooks = await idbGetAll("notebooks");
  } catch (_) { libFolders = []; libNotebooks = []; }
  await loadStamps();
  await loadRosters();

  if (libNotebooks.length === 0) {
    // First launch of this version — migrate whatever single document existed (IndexedDB v1
    // autosave, or the older localStorage fallback) into this library's first notebook.
    let legacyJson = null;
    try { legacyJson = await idbGet("autosave", "current"); } catch (_) {}
    if (!legacyJson) { try { legacyJson = localStorage.getItem("inkpad.autosave"); } catch (_) {} }
    const id = genId(), now = Date.now();
    const nb = { id, name: "My Notes", folderId: null, createdAt: now, updatedAt: now };
    libNotebooks = [nb];
    try {
      await idbPut("notebooks", nb);
      if (legacyJson) { await idbPut("docdata", legacyJson, id); try { await idbDelete("autosave", "current"); } catch (_) {} }
    } catch (_) {} // already warned by the idb* helpers; keep going in-memory so the app is still usable
    try { localStorage.removeItem("inkpad.autosave"); } catch (_) {}
    activeNotebookId = id;
  } else {
    activeNotebookId = null;
    try { activeNotebookId = localStorage.getItem("inkpad.activeNotebookId"); } catch (_) {}
    if (!activeNotebookId || !libNotebooks.some(n => n.id === activeNotebookId)) activeNotebookId = libNotebooks[0].id;
  }
  try { localStorage.setItem("inkpad.activeNotebookId", activeNotebookId); } catch (_) {}

  const activeNb = libNotebooks.find(n => n.id === activeNotebookId);
  for (let anc = activeNb && activeNb.folderId; anc; anc = libFolders.find(f => f.id === anc)?.parentId) libExpanded.add(anc);

  let json = null;
  try { json = await idbGet("docdata", activeNotebookId); } catch (_) {}
  if (json) { try { deserialize(json); } catch (_) {} }
  renderLibTree();
  renderStampGrid();
}

// A folder handle remembered from a previous session whose permission wasn't silently re-grantable
// (queryPermission returned "prompt", not "granted") — File System Access API requires a real user
// gesture to (re-)request permission, so this just sits here until the user clicks "Reconnect".
let fsPendingHandle = null;
// Runs once after initLibrary() has loaded the idb-backed library (the fallback/baseline) — if a
// folder was connected last session and the browser will still silently grant it permission,
// switches straight over to it; otherwise leaves fsPendingHandle set so the sidebar can offer a
// one-click "Reconnect" (which needs a click, since permission grants require a user gesture).
async function tryAutoReconnectFs() {
  let handle = null;
  try { handle = await idbGet("meta", "fsHandle"); } catch (_) {}
  if (!handle) return;
  let perm = "denied";
  try { perm = await handle.queryPermission({ mode: "readwrite" }); } catch (_) {}
  // silent: true — a failure here (permission not actually usable, or the folder having become
  // unreachable) must fall back to whatever initLibrary() already loaded from IndexedDB rather than
  // popping an alert or a "copy your notebooks?" dialog unprompted during boot.
  if (perm === "granted" && await connectToFsHandle(handle, { silent: true })) return;
  fsPendingHandle = handle;
  renderLibTree();
}
async function reconnectFs() {
  if (!fsPendingHandle) return;
  let perm = "denied";
  try { perm = await fsPendingHandle.requestPermission({ mode: "readwrite" }); } catch (_) {}
  if (perm !== "granted") { alert("Permission wasn't granted, so that folder stays disconnected."); return; }
  const h = fsPendingHandle; fsPendingHandle = null;
  await flushAutosave();
  await connectToFsHandle(h);
}
// Opens the OS folder picker and connects to whatever's chosen. Only reachable while
// storageBackend === "idb" (the button that calls this is hidden once connected — see
// buildFilesToolbar), so "the previous backend" below is always idb; no need to handle
// fs-folder-to-fs-folder reconnects.
async function chooseFsFolder() {
  if (!window.showDirectoryPicker) {
    alert("This browser doesn't support connecting to a folder on disk (Chrome or Edge only). Notebooks will keep saving to browser storage instead.");
    return;
  }
  let handle;
  try { handle = await window.showDirectoryPicker({ mode: "readwrite" }); }
  catch (err) { if (!err || err.name !== "AbortError") alert("Couldn't open the folder picker: " + (err && err.message ? err.message : err)); return; }
  await flushAutosave();
  await connectToFsHandle(handle);
}
async function connectToFsHandle(handle, { silent } = {}) {
  let perm = "denied";
  try { perm = await handle.queryPermission({ mode: "readwrite" }); } catch (_) {}
  if (perm !== "granted" && !silent) { try { perm = await handle.requestPermission({ mode: "readwrite" }); } catch (_) {} }
  if (perm !== "granted") { if (!silent) alert("Permission to read/write that folder wasn't granted."); return false; }

  fsRoot = handle; fsIndexCache = null; fsWarned = false;
  let idx;
  try { idx = await fsLoadIndex(); }
  catch (err) {
    fsRoot = null;
    if (!silent) alert("Couldn't read that folder: " + (err && err.message ? err.message : err));
    return false;
  }

  const isEmpty = idx.folders.length === 0 && idx.notebooks.length === 0;
  if (isEmpty && !silent && libNotebooks.length > 0 && await confirmDialogAsync(
    "Copy your notebooks into this folder?",
    `This folder is empty. Copy your ${libNotebooks.length} existing notebook(s) into it so they're available here too?`,
    "Copy them"
  )) {
    for (const fo of libFolders) await fsPut("folders", fo);
    for (const nb of libNotebooks) {
      await fsPut("notebooks", nb);
      let json = null;
      try { json = nb.id === activeNotebookId ? await serialize() : await idbGet("docdata", nb.id); } catch (_) {}
      if (json) await fsPut("docdata", json, nb.id);
    }
    for (const st of libStamps) await fsPut("stamps", st);
    for (const r of libRosters) await fsPut("rosters", r);
    storageBackend = "fs";
  } else if (isEmpty) {
    const id = genId(), now = Date.now();
    const nb = { id, name: "My Notes", folderId: null, createdAt: now, updatedAt: now };
    await fsPut("notebooks", nb);
    // Stamps/rosters are low-stakes reference collections, not notebook content — carried over
    // unconditionally (no extra confirm) whenever a fresh folder becomes the active backend, so
    // switching storage doesn't quietly empty a teacher's stamp library or class rosters.
    for (const st of libStamps) await fsPut("stamps", st);
    for (const r of libRosters) await fsPut("rosters", r);
    storageBackend = "fs";
    libFolders = []; libNotebooks = [nb]; activeNotebookId = null;
    await switchNotebook(id);
  } else {
    storageBackend = "fs";
    libFolders = idx.folders.slice();
    libNotebooks = idx.notebooks.slice();
    libStamps = (idx.stamps || []).slice();
    libRosters = (idx.rosters || []).slice();
    if (!libRosters.length) {
      const r = { id: genId(), name: "My Class", names: [] };
      libRosters = [r];
      await fsPut("rosters", r);
    }
    if (!libRosters.some(r => r.id === activeRosterId)) activeRosterId = libRosters[0].id;
    try { localStorage.setItem("inkpad.activeRosterId", activeRosterId); } catch (_) {}
    renderStampGrid();
    activeNotebookId = null;
    await switchNotebook(libNotebooks[0].id);
  }
  // Settings (palette, keymap, text/timer defaults, ...) are a single shared file, separate from
  // the notebooks/stamps/rosters index above. Disk wins on connect if it already has one;
  // otherwise this folder gets seeded with whatever's currently active.
  const diskSettings = await loadSettingsFromDisk();
  if (diskSettings) { applySettingsSnapshot(diskSettings); buildToolButtons(V.popped ? PALB : TB); refreshHelp(); }
  else { try { await saveSettingsToDisk(); } catch (_) {} }
  try { await idbPut("meta", handle, "fsHandle"); } catch (_) {}
  rebuildSidebar();
  return true;
}
async function disconnectFsRoot() {
  await flushAutosave();
  storageBackend = "idb";
  fsRoot = null; fsIndexCache = null; fsWarned = false; fsPendingHandle = null;
  try { await idbDelete("meta", "fsHandle"); } catch (_) {}
  await initLibrary();
}

// Saves the notebook being left, then loads the target notebook's content (or a blank slate, for
// a just-created notebook that has never been saved yet).
async function switchNotebook(id) {
  if (id === activeNotebookId) return;
  await flushAutosave();
  let json = null;
  try { json = await storeGet("docdata", id); } catch (_) {}
  activeNotebookId = id;
  try { localStorage.setItem("inkpad.activeNotebookId", id); } catch (_) {}
  if (json) { deserialize(json); }
  else { resetDocState(); Object.assign(S, defaultDocSettings()); rebuildSidebar(); }
}

async function createNotebookRaw(name, folderId) {
  const id = genId(), now = Date.now();
  const nb = { id, name, folderId: folderId || null, createdAt: now, updatedAt: now };
  libNotebooks.push(nb);
  try { await storePut("notebooks", nb); } catch (_) {} // already warned; still usable in-memory this session
  for (let anc = folderId; anc; anc = libFolders.find(f => f.id === anc)?.parentId) libExpanded.add(anc);
  await switchNotebook(id);
  renderLibTree();
  return nb;
}
async function createNotebook(folderId) {
  const name = await promptDialog("New notebook", "Name", "Untitled");
  if (name == null) return;
  await createNotebookRaw(name.trim() || "Untitled", folderId);
}
async function createFolder(parentId) {
  const name = await promptDialog("New folder", "Name", "New folder");
  if (name == null) return;
  const fo = { id: genId(), name: name.trim() || "New folder", parentId: parentId || null, createdAt: Date.now() };
  libFolders.push(fo);
  try { await storePut("folders", fo); } catch (_) {} // already warned; still usable in-memory this session
  if (parentId) libExpanded.add(parentId);
  libExpanded.add(fo.id);
  renderLibTree();
}
async function renameLibItem(kind, id, name) {
  const trimmed = name.trim();
  if (!trimmed) return;
  const item = (kind === "folder" ? libFolders : libNotebooks).find(x => x.id === id);
  if (!item || item.name === trimmed) return;
  item.name = trimmed;
  if (kind === "notebook") item.updatedAt = Date.now();
  try { await storePut(kind === "folder" ? "folders" : "notebooks", item); } catch (_) {} // already warned; name still updates in-memory
}
function isDescendantFolder(folderId, ancestorId) {
  for (let f = libFolders.find(x => x.id === folderId); f; f = libFolders.find(x => x.id === f.parentId)) {
    if (f.parentId === ancestorId) return true;
  }
  return false;
}
async function moveItem(kind, id, newParentId) {
  newParentId = newParentId || null;
  try {
    if (kind === "folder") {
      if (id === newParentId || (newParentId && isDescendantFolder(newParentId, id))) return; // no cycles
      const fo = libFolders.find(f => f.id === id);
      if (!fo || fo.parentId === newParentId) return;
      fo.parentId = newParentId;
      await storePut("folders", fo);
    } else {
      const nb = libNotebooks.find(n => n.id === id);
      if (!nb || nb.folderId === newParentId) return;
      nb.folderId = newParentId;
      nb.updatedAt = Date.now();
      await storePut("notebooks", nb);
    }
  } catch (_) {} // already warned; the move still applies in-memory
  renderLibTree();
}
async function duplicateNotebook(id) {
  const src = libNotebooks.find(n => n.id === id);
  if (!src) return;
  let json = null;
  try { json = id === activeNotebookId ? await serialize() : await storeGet("docdata", id); } catch (_) {}
  const nb = { id: genId(), name: src.name + " copy", folderId: src.folderId, createdAt: Date.now(), updatedAt: Date.now() };
  libNotebooks.push(nb);
  try {
    await storePut("notebooks", nb);
    if (json) await storePut("docdata", json, nb.id);
  } catch (_) {} // already warned; still usable in-memory this session
  renderLibTree();
}
function collectFolderDescendantFolders(folderId) {
  const out = [];
  (function walk(pid) { for (const f of libFolders.filter(x => x.parentId === pid)) { out.push(f.id); walk(f.id); } })(folderId);
  return out;
}
async function deleteNotebook(id) {
  const nb = libNotebooks.find(n => n.id === id);
  if (!nb) return;
  confirmDialog(`Delete "${nb.name}"?`, "This permanently deletes this notebook and everything in it.", async () => {
    const wasActive = id === activeNotebookId;
    libNotebooks = libNotebooks.filter(n => n.id !== id);
    try { await storeDelete("notebooks", id); await storeDelete("docdata", id); } catch (_) {} // already warned; still removed in-memory
    if (!wasActive) { renderLibTree(); return; }
    activeNotebookId = null;
    if (libNotebooks.length === 0) await createNotebookRaw("My Notes", null);
    else await switchNotebook(libNotebooks[0].id);
  });
}
async function deleteFolder(id) {
  const fo = libFolders.find(f => f.id === id);
  if (!fo) return;
  const descFolders = [id, ...collectFolderDescendantFolders(id)];
  const affected = libNotebooks.filter(n => descFolders.includes(n.folderId));
  confirmDialog(`Delete "${fo.name}"?`, `This permanently deletes this folder and ${affected.length} notebook(s) inside it.`, async () => {
    try {
      for (const n of affected) { await storeDelete("docdata", n.id); await storeDelete("notebooks", n.id); }
      for (const fid of descFolders) await storeDelete("folders", fid);
    } catch (_) {} // already warned; still removed in-memory
    const removedIds = new Set(affected.map(n => n.id));
    libNotebooks = libNotebooks.filter(n => !removedIds.has(n.id));
    libFolders = libFolders.filter(f => !descFolders.includes(f.id));
    if (!removedIds.has(activeNotebookId)) { renderLibTree(); return; }
    activeNotebookId = null;
    if (libNotebooks.length === 0) await createNotebookRaw("My Notes", null);
    else await switchNotebook(libNotebooks[0].id);
  });
}

/* ---------------- Vector PDF export ---------------- */
// Best-effort Unicode -> WinAnsi (cp1252) fallback for PDF text strings, with readable ASCII
// substitutes for the Greek/math symbols this app's Math Shape Importer commonly uses
// (Helvetica/WinAnsi has no Greek glyphs, so "?" would otherwise appear for e.g. "θ").
