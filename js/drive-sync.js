"use strict";
/* ---------------- Google Drive sync ----------------
   Three tiers, three kinds of file, all inside an app-created "InkPad"
   folder in the user's own My Drive (drive.file scope — visible, findable,
   renameable/movable like any other file):

     - "InkPad Settings.json"  — global/user prefs: keymap, palette, text
       & timer defaults. Not tied to any notebook.
     - "InkPad Library.json"   — the library index: folder tree, the
       notebook list (name/folderId/timestamps, NOT content), stamps,
       rosters. Small, no notebook content in it.
     - "<Notebook Name>.json"  — one per notebook, the actual heavy
       content (strokes/images/audio/text) plus that notebook's own
       per-notebook prefs (S, including shapePrefs). Only re-uploaded when
       that specific notebook has actually changed (nb.updatedAt newer
       than nb.driveSyncedAt) — editing one notebook does NOT re-upload
       every other notebook, unlike the first version of this file.

   Push (backup) can be fully automatic — it only ever overwrites *Drive*
   with local state. Pull (restore) is never fully automatic: auto-sync
   just checks on boot whether Drive has something newer and asks before
   overwriting whatever is stored locally (browser storage, or a
   connected folder). Fully silent bidirectional sync would risk one
   device quietly clobbering unsaved edits made on another — no real
   conflict/merge resolution is attempted here, so that one step stays
   manual-by-confirmation.

   Restore isn't all-or-nothing: "Restore from Drive" opens a picker (built
   from the lightweight library-index file only, no content downloaded up
   front) offering "restore everything" or a folder/notebook tree where any
   single folder or notebook can be restored on its own — driveRestoreSelected/
   driveRestoreFolder use a Drive "properties" query to fetch just the wanted
   notebook file(s) directly, not by downloading and checking every file.

   Known intentional gap: deleting a notebook locally does NOT delete its
   Drive file. Restore treats Drive as "everything ever backed up" and
   will bring a deleted-locally notebook back, rather than risking a
   silent permanent delete propagating from one device to another.

   Setup: fill in DRIVE_CLIENT_ID below with a Client ID from Google Cloud
   Console (OAuth consent screen + Web application credential, scope
   drive.file, authorized JavaScript origin = wherever this is served
   from, e.g. http://localhost:<port>). Buttons no-op with an explanatory
   alert until this is set. */
const DRIVE_CLIENT_ID = "499950486642-ja82isquib6bepvi34pt1moepsvsje2u.apps.googleusercontent.com"; // e.g. "123456789-abc123.apps.googleusercontent.com"
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_FOLDER_NAME = "InkPad";
const DRIVE_SETTINGS_FILE_NAME = "InkPad Settings.json";
const DRIVE_LIBRARY_FILE_NAME = "InkPad Library.json";
const DRIVE_SETTINGS_FILE_ID_KEY = "inkpad.driveSettingsFileId";
const DRIVE_LIBRARY_FILE_ID_KEY = "inkpad.driveLibraryFileId";
const DRIVE_AUTO_SYNC_KEY = "inkpad.driveAutoSync";
const DRIVE_LAST_SEEN_KEY = "inkpad.driveLastSeenModified";
const DRIVE_AUTO_PUSH_INTERVAL_MS = 2 * 60000;

function driveConfigured() { return !!DRIVE_CLIENT_ID; }
function driveSanitizeName(name) { return ((name || "Untitled").replace(/[\\/:*?"<>|]/g, "-").trim() || "Untitled"); }

let driveTokenClient = null;
let driveAccessToken = null;
let driveGisReady = null;

function loadGis() {
  if (driveGisReady) return driveGisReady;
  driveGisReady = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Couldn't reach accounts.google.com — check your connection."));
    document.head.appendChild(s);
  });
  return driveGisReady;
}

// Tries a silent token refresh first (works while an earlier grant this
// session is still valid); only falls back to the interactive Google
// account picker when that fails or forceConsent is requested.
async function driveGetToken(forceConsent) {
  await loadGis();
  if (!driveTokenClient) {
    driveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: DRIVE_CLIENT_ID, scope: DRIVE_SCOPE, callback: () => {},
    });
  }
  const attempt = prompt => new Promise((resolve, reject) => {
    driveTokenClient.callback = resp => resp.error ? reject(resp) : resolve(resp.access_token);
    driveTokenClient.requestAccessToken({ prompt });
  });
  if (!forceConsent) {
    try { return driveAccessToken = await attempt(""); } catch (_) {}
  }
  return driveAccessToken = await attempt("consent");
}

async function driveFetch(url, opts = {}) {
  const token = driveAccessToken || await driveGetToken(false);
  const withAuth = t => ({ ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${t}` } });
  let res = await fetch(url, withAuth(token));
  if (res.status === 401) { // token expired mid-session
    const fresh = await driveGetToken(true);
    res = await fetch(url, withAuth(fresh));
  }
  return res;
}

/* ---------------- low-level Drive file helpers ---------------- */

// drive.file scope restricts what this can even see to folders the app
// itself created, so a plain name match can't collide with the user's own.
async function driveFindFolder() {
  const q = encodeURIComponent(`name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`);
  if (!res.ok) throw new Error(`Drive folder lookup failed: ${res.status}`);
  const data = await res.json();
  return (data.files && data.files[0] && data.files[0].id) || null;
}

async function driveCreateFolder() {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
  });
  if (!res.ok) throw new Error(`Drive folder creation failed: ${res.status}`);
  return (await res.json()).id;
}

// Cached locally so routine backups skip a name-lookup round trip; falls back
// to searching by name (e.g. after a fresh restore, or on a new device)
// when the cache is empty.
async function driveFindSingletonFileId(folderId, name, cacheKey) {
  let id = null;
  try { id = localStorage.getItem(cacheKey); } catch (_) {}
  if (id) return id;
  const q = encodeURIComponent(`name='${name}' and trashed=false and '${folderId}' in parents`);
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`);
  if (!res.ok) throw new Error(`Drive lookup failed: ${res.status}`);
  const data = await res.json();
  id = (data.files && data.files[0] && data.files[0].id) || null;
  if (id) { try { localStorage.setItem(cacheKey, id); } catch (_) {} }
  return id;
}

// existingId null -> create; existingId set -> update in place (optionally
// renaming too, since Drive's update endpoint can change metadata and
// content in the same multipart request). `properties` (small string
// key/values Drive stores on the file itself) lets a specific file be found
// later by a direct query instead of downloading everything to check.
async function drivePushFile(existingId, folderId, name, bodyStr, renameToo, properties) {
  const metadata = existingId
    ? { ...(renameToo ? { name } : {}), ...(properties ? { properties } : {}) }
    : { name, parents: [folderId], ...(properties ? { properties } : {}) };
  const boundary = "inkpad-" + Date.now() + Math.random().toString(36).slice(2, 8);
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${bodyStr}\r\n--${boundary}--`;
  const url = existingId
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&fields=id,modifiedTime`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime`;
  const res = await driveFetch(url, { method: existingId ? "PATCH" : "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: multipart });
  if (!res.ok) throw new Error(`Drive upload failed: ${res.status} ${await res.text()}`);
  return res.json(); // { id, modifiedTime }
}

async function driveFolderNewestModifiedTime(folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&pageSize=1&fields=files(modifiedTime)`);
  if (!res.ok) throw new Error(`Drive lookup failed: ${res.status}`);
  const data = await res.json();
  return (data.files && data.files[0] && data.files[0].modifiedTime) || null;
}

// Direct property lookup — finds a specific notebook's Drive file without
// downloading/parsing every notebook file's content to check its embedded id.
async function driveFindNotebookFileByProperty(folderId, notebookId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and properties has { key='notebookId' and value='${notebookId}' }`);
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
  if (!res.ok) throw new Error(`Drive lookup failed: ${res.status}`);
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}

// Lightweight — just the library index (folder tree + notebook metadata),
// no per-notebook content. Used to populate the restore picker without
// downloading anything heavy.
async function driveFetchLibrarySnapshot() {
  const folderId = await driveFindFolder();
  if (!folderId) return null;
  const id = await driveFindSingletonFileId(folderId, DRIVE_LIBRARY_FILE_NAME, DRIVE_LIBRARY_FILE_ID_KEY);
  if (!id) return { folderId, folders: [], notebooks: [], stamps: [], rosters: [] };
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
  if (!res.ok) throw new Error(`Drive lookup failed: ${res.status}`);
  const snap = JSON.parse(await res.text());
  return { folderId, folders: snap.folders || [], notebooks: snap.notebooks || [], stamps: snap.stamps || [], rosters: snap.rosters || [] };
}

/* ---------------- per-tier push, each skipping a no-op upload ---------------- */

let driveLastPushedSettingsJson = null;
let driveLastPushedLibraryJson = null;

async function driveBackupSettingsIfChanged(folderId) {
  const bodyStr = JSON.stringify({ version: 1, settings: currentSettingsSnapshot() });
  if (bodyStr === driveLastPushedSettingsJson) return null;
  const id = await driveFindSingletonFileId(folderId, DRIVE_SETTINGS_FILE_NAME, DRIVE_SETTINGS_FILE_ID_KEY);
  const result = await drivePushFile(id, folderId, DRIVE_SETTINGS_FILE_NAME, bodyStr, false);
  try { localStorage.setItem(DRIVE_SETTINGS_FILE_ID_KEY, result.id); } catch (_) {}
  driveLastPushedSettingsJson = bodyStr;
  return result;
}

async function driveBackupLibraryIndexIfChanged(folderId) {
  const [folders, notebooksRaw, stamps, rosters] = await Promise.all([
    storeGetAll("folders"), storeGetAll("notebooks"), storeGetAll("stamps"), storeGetAll("rosters"),
  ]);
  // Drive file id / sync bookkeeping is local-only, not meaningful to other devices.
  const notebooks = notebooksRaw.map(({ driveFileId, driveSyncedAt, driveSyncedName, ...rest }) => rest);
  const bodyStr = JSON.stringify({ version: 1, folders, notebooks, stamps, rosters });
  if (bodyStr === driveLastPushedLibraryJson) return null;
  const id = await driveFindSingletonFileId(folderId, DRIVE_LIBRARY_FILE_NAME, DRIVE_LIBRARY_FILE_ID_KEY);
  const result = await drivePushFile(id, folderId, DRIVE_LIBRARY_FILE_NAME, bodyStr, false);
  try { localStorage.setItem(DRIVE_LIBRARY_FILE_ID_KEY, result.id); } catch (_) {}
  driveLastPushedLibraryJson = bodyStr;
  return result;
}

async function driveBackupNotebook(nb, folderId) {
  const json = await storeGet("docdata", nb.id); // already-serialized string
  const fileName = driveSanitizeName(nb.name) + ".json";
  const renameToo = !!nb.driveFileId && nb.driveSyncedName !== nb.name;
  const bodyStr = JSON.stringify({ version: 1, notebookId: nb.id, docdata: json });
  const result = await drivePushFile(nb.driveFileId || null, folderId, fileName, bodyStr, renameToo, { notebookId: nb.id });
  nb.driveFileId = result.id;
  nb.driveSyncedAt = Date.now();
  nb.driveSyncedName = nb.name;
  await storePut("notebooks", nb);
  return result;
}

async function driveBackupNow() {
  await flushAutosave(); // make sure the active notebook's own latest edits are in docdata first
  const folderId = (await driveFindFolder()) || (await driveCreateFolder());
  let pushedAny = false, newestSeen = null;
  const note = t => { if (t && (!newestSeen || new Date(t) > new Date(newestSeen))) newestSeen = t; };

  const settingsResult = await driveBackupSettingsIfChanged(folderId);
  if (settingsResult) { pushedAny = true; note(settingsResult.modifiedTime); }
  const libraryResult = await driveBackupLibraryIndexIfChanged(folderId);
  if (libraryResult) { pushedAny = true; note(libraryResult.modifiedTime); }
  for (const nb of libNotebooks) {
    if ((nb.updatedAt || 0) > (nb.driveSyncedAt || 0)) {
      const r = await driveBackupNotebook(nb, folderId);
      pushedAny = true; note(r.modifiedTime);
    }
  }
  if (newestSeen) { try { localStorage.setItem(DRIVE_LAST_SEEN_KEY, newestSeen); } catch (_) {} }
  return pushedAny;
}

/* ---------------- warn before overwriting a notebook that looks newer locally ---------------- */

// Thrown instead of proceeding when at least one notebook about to be overwritten has a local
// updatedAt newer than the remote copy's — names each one so the confirm dialog can be specific
// rather than a generic "this can't be undone" warning. Re-calling the same restore function with
// force=true skips this check and proceeds unconditionally (matches today's behavior).
class DriveNewerLocalWarning extends Error {
  constructor(items) { super("Local changes look newer than Drive"); this.newerLocal = items; }
}
function findNewerLocalNotebooks(remoteNotebooksMeta) {
  return remoteNotebooksMeta
    .map(remoteNb => ({ remoteNb, localNb: libNotebooks.find(n => n.id === remoteNb.id) }))
    .filter(({ remoteNb, localNb }) => localNb && (localNb.updatedAt || 0) > (remoteNb.updatedAt || 0))
    .map(({ remoteNb, localNb }) => ({ name: localNb.name, localUpdatedAt: localNb.updatedAt, remoteUpdatedAt: remoteNb.updatedAt || 0 }));
}
function formatNewerLocalWarning(items) {
  return items.map(x => `"${x.name}" (your local copy from ${new Date(x.localUpdatedAt).toLocaleString()} looks newer than Drive's from ${new Date(x.remoteUpdatedAt).toLocaleString()})`).join("; ");
}
// Wraps a restore call: runs it once (force=false); if it throws DriveNewerLocalWarning, shows a
// dialog naming exactly which notebook(s) are at risk and re-runs with force=true only if
// confirmed. Returns true if the restore actually happened, false if the user backed out.
async function runRestoreWithNewerLocalGuard(runFn) {
  try {
    await runFn(false);
  } catch (err) {
    if (!(err instanceof DriveNewerLocalWarning)) throw err;
    const ok = await confirmDialogAsync(
      "Local changes look newer than Drive",
      `${formatNewerLocalWarning(err.newerLocal)}. Restoring will overwrite ${err.newerLocal.length > 1 ? "these" : "this"} with the older Drive version. Continue anyway?`,
      "Restore anyway"
    );
    if (!ok) return false;
    await runFn(true);
  }
  return true;
}

/* ---------------- restore: enumerate the whole folder and rebuild ---------------- */

async function driveRestoreNow(force) {
  const folderId = await driveFindFolder();
  if (!folderId) throw new Error('No InkPad backup found in Google Drive yet — use "Back up to Drive" first.');
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&pageSize=1000`);
  if (!res.ok) throw new Error(`Drive lookup failed: ${res.status}`);
  const { files } = await res.json();
  if (!files || !files.length) throw new Error('No InkPad backup found in Google Drive yet — use "Back up to Drive" first.');

  const settingsFile = files.find(f => f.name === DRIVE_SETTINGS_FILE_NAME);
  const libraryFile = files.find(f => f.name === DRIVE_LIBRARY_FILE_NAME);
  const notebookFiles = files.filter(f => f !== settingsFile && f !== libraryFile);

  const fetchJson = async id => { const r = await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`); return r.ok ? JSON.parse(await r.text()) : null; };

  const librarySnapshot = libraryFile ? await fetchJson(libraryFile.id) : null;
  const settingsSnapshot = settingsFile ? await fetchJson(settingsFile.id) : null;

  // Check against just the lightweight metadata already in hand — no need to download any
  // notebook content yet to know whether to warn.
  if (!force) {
    const atRisk = findNewerLocalNotebooks((librarySnapshot && librarySnapshot.notebooks) || []);
    if (atRisk.length) throw new DriveNewerLocalWarning(atRisk);
  }

  const remoteNotebooks = [];
  for (const f of notebookFiles) {
    try {
      const parsed = await fetchJson(f.id);
      if (parsed && parsed.notebookId) remoteNotebooks.push({ file: f, notebookId: parsed.notebookId, docdata: parsed.docdata });
    } catch (_) {} // skip anything in that folder that isn't a recognisable InkPad notebook file
  }

  const folders = (librarySnapshot && librarySnapshot.folders) || [];
  const notebooks = (librarySnapshot && librarySnapshot.notebooks) || [];
  const knownIds = new Set(notebooks.map(n => n.id));
  for (const rn of remoteNotebooks) {
    if (!knownIds.has(rn.notebookId)) notebooks.push({ id: rn.notebookId, name: rn.file.name.replace(/\.json$/, ""), folderId: null, createdAt: Date.now(), updatedAt: Date.now() });
  }
  const stamps = (librarySnapshot && librarySnapshot.stamps) || [];
  const rosters = (librarySnapshot && librarySnapshot.rosters) || [];

  for (const fo of folders) await storePut("folders", fo);
  for (const nb of notebooks) {
    const rn = remoteNotebooks.find(r => r.notebookId === nb.id);
    if (rn) {
      await storePut("docdata", rn.docdata, nb.id);
      nb.driveFileId = rn.file.id; nb.driveSyncedAt = Date.now(); nb.driveSyncedName = nb.name;
    } else if (librarySnapshot && librarySnapshot.docdata && librarySnapshot.docdata[nb.id]) {
      // Legacy single-file backup (from before per-notebook files existed) — content was
      // bundled inside the library file itself. Restores fine; migrates to its own file
      // automatically on the next "Back up to Drive" (nb.updatedAt > nb.driveSyncedAt).
      await storePut("docdata", librarySnapshot.docdata[nb.id], nb.id);
    }
    await storePut("notebooks", nb);
  }
  for (const st of stamps) await storePut("stamps", st);
  for (const r of rosters) await storePut("rosters", r);
  if (settingsSnapshot && settingsSnapshot.settings) applySettingsSnapshot(settingsSnapshot.settings);

  // Re-read from whichever backend is actually active (idb or a connected
  // folder) rather than initLibrary(), which hard-codes idb and is meant
  // only for cold boot — using it here would silently show browser-storage
  // state even while connected to a folder.
  libFolders = await storeGetAll("folders");
  libNotebooks = await storeGetAll("notebooks");
  libStamps = await storeGetAll("stamps");
  libRosters = await storeGetAll("rosters");
  activeNotebookId = null;
  const firstId = (notebooks[0] && notebooks[0].id) || (libNotebooks[0] && libNotebooks[0].id);
  if (firstId) await switchNotebook(firstId);
  renderLibTree();
  renderStampGrid();

  if (settingsFile) { try { localStorage.setItem(DRIVE_SETTINGS_FILE_ID_KEY, settingsFile.id); } catch (_) {} }
  if (libraryFile) { try { localStorage.setItem(DRIVE_LIBRARY_FILE_ID_KEY, libraryFile.id); } catch (_) {} }
  driveLastPushedSettingsJson = settingsSnapshot ? JSON.stringify(settingsSnapshot) : null;
  driveLastPushedLibraryJson = librarySnapshot ? JSON.stringify({ version: 1, folders, notebooks: notebooks.map(({ driveFileId, driveSyncedAt, driveSyncedName, ...rest }) => rest), stamps, rosters }) : null;
  try {
    const newest = await driveFolderNewestModifiedTime(folderId);
    if (newest) localStorage.setItem(DRIVE_LAST_SEEN_KEY, newest);
  } catch (_) {}
}

/* ---------------- targeted restore: one notebook, or one folder's worth ---------------- */

// Restores just these notebook ids (plus whichever ancestor folders they need
// so the sidebar nests them correctly), leaving every other locally-stored
// notebook untouched — unlike driveRestoreNow(), which replaces everything.
async function driveRestoreSelected(notebookIds, snapshot, force) {
  snapshot = snapshot || await driveFetchLibrarySnapshot();
  if (!snapshot || !snapshot.folderId) throw new Error('No InkPad backup found in Google Drive yet — use "Back up to Drive" first.');
  const wantedMeta = snapshot.notebooks.filter(n => notebookIds.includes(n.id));
  if (!wantedMeta.length) throw new Error("Couldn't find that in the Drive backup.");

  if (!force) {
    const atRisk = findNewerLocalNotebooks(wantedMeta);
    if (atRisk.length) throw new DriveNewerLocalWarning(atRisk);
  }

  const neededFolderIds = new Set();
  for (const nb of wantedMeta) {
    for (let fid = nb.folderId; fid; fid = (snapshot.folders.find(f => f.id === fid) || {}).parentId) neededFolderIds.add(fid);
  }
  for (const fo of snapshot.folders.filter(f => neededFolderIds.has(f.id))) await storePut("folders", fo);

  for (const nb of wantedMeta) {
    const file = await driveFindNotebookFileByProperty(snapshot.folderId, nb.id);
    if (file) {
      const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`);
      if (res.ok) {
        const parsed = JSON.parse(await res.text());
        await storePut("docdata", parsed.docdata, nb.id);
        nb.driveFileId = file.id; nb.driveSyncedAt = Date.now(); nb.driveSyncedName = nb.name;
      }
    }
    await storePut("notebooks", nb);
  }

  libFolders = await storeGetAll("folders");
  libNotebooks = await storeGetAll("notebooks");
  activeNotebookId = null;
  await switchNotebook(wantedMeta[0].id);
  renderLibTree();
}

async function driveRestoreFolder(folderId, force) {
  const snapshot = await driveFetchLibrarySnapshot();
  if (!snapshot || !snapshot.folderId) throw new Error('No InkPad backup found in Google Drive yet — use "Back up to Drive" first.');
  const descendantIds = new Set([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of snapshot.folders) {
      if (f.parentId && descendantIds.has(f.parentId) && !descendantIds.has(f.id)) { descendantIds.add(f.id); changed = true; }
    }
  }
  const notebookIds = snapshot.notebooks.filter(n => descendantIds.has(n.folderId)).map(n => n.id);
  if (!notebookIds.length) throw new Error("That folder has no notebooks in the Drive backup.");
  await driveRestoreSelected(notebookIds, snapshot, force);
}

/* ---------------- restore picker: everything, or pick a folder/notebook ---------------- */

function driveRestoreFolderRow(f, childrenByFolder, notebooksByFolder, depth) {
  const wrap = document.createElement("div");
  const row = document.createElement("div");
  row.className = "lib-row lib-folder";
  row.style.paddingLeft = (depth * 14) + "px";
  row.innerHTML = `
    <span class="lib-icon">\u{1F4C1}</span>
    <span class="lib-name">${escapeXml(f.name)}</span>
    <span class="lib-actions" style="display:flex;"><button type="button" title="Restore this folder">⟳</button></span>`;
  wrap.appendChild(row);
  row.querySelector("button").onclick = async e => {
    e.stopPropagation();
    const ok = await confirmDialogAsync(`Restore "${f.name}"?`, "This replaces every notebook in this folder (and any subfolders) currently stored on this device with what's in Drive.", "Restore");
    if (!ok) return;
    try {
      const proceeded = await runRestoreWithNewerLocalGuard(force => driveRestoreFolder(f.id, force));
      if (proceeded) { alert(`Restored "${f.name}" from Google Drive.`); $("driveRestoreDlg").close(); }
    } catch (err) { alert("Restore failed: " + (err && err.message ? err.message : err)); }
  };
  const childWrap = document.createElement("div");
  childWrap.className = "lib-children";
  for (const sub of (childrenByFolder.get(f.id) || [])) childWrap.appendChild(driveRestoreFolderRow(sub, childrenByFolder, notebooksByFolder, depth + 1));
  for (const nb of (notebooksByFolder.get(f.id) || [])) childWrap.appendChild(driveRestoreNotebookRow(nb, depth + 1));
  wrap.appendChild(childWrap);
  return wrap;
}
function driveRestoreNotebookRow(nb, depth) {
  const row = document.createElement("div");
  row.className = "lib-row lib-notebook";
  row.style.paddingLeft = (depth * 14 + 12) + "px";
  row.innerHTML = `
    <span class="lib-icon">\u{1F4C4}</span>
    <span class="lib-name">${escapeXml(nb.name)}</span>
    <span class="lib-actions" style="display:flex;"><button type="button" title="Restore this notebook">⟳</button></span>`;
  row.querySelector("button").onclick = async e => {
    e.stopPropagation();
    const ok = await confirmDialogAsync(`Restore "${nb.name}"?`, "This replaces this notebook's content currently stored on this device with what's in Drive.", "Restore");
    if (!ok) return;
    try {
      const proceeded = await runRestoreWithNewerLocalGuard(force => driveRestoreSelected([nb.id], null, force));
      if (proceeded) { alert(`Restored "${nb.name}" from Google Drive.`); $("driveRestoreDlg").close(); }
    } catch (err) { alert("Restore failed: " + (err && err.message ? err.message : err)); }
  };
  return row;
}

async function openDriveRestorePicker() {
  if (!driveConfigured()) { alert("Google Drive sync isn't set up yet — see the top of js/drive-sync.js for the one-line config."); return; }
  const tree = $("driveRestoreTree"), status = $("driveRestoreStatus");
  tree.innerHTML = "";
  status.textContent = "Loading your Drive library…";
  $("driveRestoreDlg").showModal();
  let snapshot;
  try { snapshot = await driveFetchLibrarySnapshot(); }
  catch (err) { status.textContent = "Couldn't load: " + (err && err.message ? err.message : err); return; }
  if (!snapshot || !snapshot.folderId || (!snapshot.folders.length && !snapshot.notebooks.length)) {
    status.textContent = "No InkPad backup found in Google Drive yet.";
    return;
  }
  status.textContent = "";
  const childrenByFolder = new Map(), notebooksByFolder = new Map();
  for (const f of snapshot.folders) {
    const key = f.parentId || null;
    if (!childrenByFolder.has(key)) childrenByFolder.set(key, []);
    childrenByFolder.get(key).push(f);
  }
  for (const nb of snapshot.notebooks) {
    const key = nb.folderId || null;
    if (!notebooksByFolder.has(key)) notebooksByFolder.set(key, []);
    notebooksByFolder.get(key).push(nb);
  }
  for (const f of (childrenByFolder.get(null) || [])) tree.appendChild(driveRestoreFolderRow(f, childrenByFolder, notebooksByFolder, 0));
  for (const nb of (notebooksByFolder.get(null) || [])) tree.appendChild(driveRestoreNotebookRow(nb, 0));
}

/* ---------------- auto-sync ---------------- */
let driveAutoSyncEnabled = false;
let driveAutoTimer = null;

function loadDriveAutoSyncPref() {
  try { driveAutoSyncEnabled = localStorage.getItem(DRIVE_AUTO_SYNC_KEY) === "1"; } catch (_) { driveAutoSyncEnabled = false; }
}
function saveDriveAutoSyncPref() {
  try { localStorage.setItem(DRIVE_AUTO_SYNC_KEY, driveAutoSyncEnabled ? "1" : "0"); } catch (_) {}
}

function startDriveAutoPushLoop() {
  if (driveAutoTimer) return;
  driveAutoTimer = setInterval(async () => {
    if (!driveAutoSyncEnabled || !driveConfigured() || dirty) return; // dirty: let local autosave settle first
    try { await driveBackupNow(); } catch (_) {} // silent — don't nag every interval on transient failures
  }, DRIVE_AUTO_PUSH_INTERVAL_MS);
}

// Runs once at boot when auto-sync is on: if Drive has anything newer than
// whatever this device last saw (its own pushes included), asks before
// pulling it in — never overwrites local data without a confirm.
async function checkDriveForNewerBackup() {
  if (!driveAutoSyncEnabled || !driveConfigured()) return;
  try {
    const folderId = await driveFindFolder();
    if (!folderId) return; // never backed up from anywhere yet
    const newest = await driveFolderNewestModifiedTime(folderId);
    if (!newest) return;
    let lastSeen = null;
    try { lastSeen = localStorage.getItem(DRIVE_LAST_SEEN_KEY); } catch (_) {}
    if (lastSeen && new Date(newest) <= new Date(lastSeen)) return;
    const ok = await confirmDialogAsync(
      "Newer backup found in Google Drive",
      `Your Drive backup was updated ${new Date(newest).toLocaleString()}. Restore it now? This replaces what's currently stored on this device.`,
      "Restore"
    );
    if (ok) { await runRestoreWithNewerLocalGuard(force => driveRestoreNow(force)); return; }
    try { localStorage.setItem(DRIVE_LAST_SEEN_KEY, newest); } catch (_) {} // don't ask again for the same version
  } catch (_) {}
}

function wireDriveMenu() {
  const needsSetup = () => { alert("Google Drive sync isn't set up yet — see the top of js/drive-sync.js for the one-line config."); };
  $("fmDriveBackup").onclick = async () => {
    closeFileMenu();
    if (!driveConfigured()) return needsSetup();
    try { const pushed = await driveBackupNow(); alert(pushed ? "Backed up to Google Drive." : "Already up to date — nothing's changed since the last backup."); }
    catch (err) { alert("Backup failed: " + (err && err.message ? err.message : err)); }
  };
  $("fmDriveRestore").onclick = () => { closeFileMenu(); openDriveRestorePicker(); };
  $("driveRestoreAllBtn").onclick = async () => {
    if (!driveConfigured()) return needsSetup();
    const ok = await confirmDialogAsync("Restore everything from Google Drive?", "This replaces every notebook currently stored in your active storage location (browser storage, or a connected folder if you have one open) with what's in your Drive backup. This can't be undone locally.", "Restore");
    if (!ok) return;
    try {
      const proceeded = await runRestoreWithNewerLocalGuard(force => driveRestoreNow(force));
      if (proceeded) { alert("Restored from Google Drive."); $("driveRestoreDlg").close(); }
    } catch (err) { alert("Restore failed: " + (err && err.message ? err.message : err)); }
  };

  loadDriveAutoSyncPref();
  const chk = $("fmDriveAutoSync");
  chk.checked = driveAutoSyncEnabled;
  chk.onchange = async () => {
    if (!driveConfigured()) { chk.checked = false; return needsSetup(); }
    driveAutoSyncEnabled = chk.checked;
    saveDriveAutoSyncPref();
    if (driveAutoSyncEnabled) {
      startDriveAutoPushLoop();
      try { await driveBackupNow(); } catch (err) { alert("Initial backup failed: " + (err && err.message ? err.message : err)); }
    }
  };
  startDriveAutoPushLoop(); // no-op internally unless/until the pref is on
}
