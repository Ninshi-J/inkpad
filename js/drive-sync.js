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

// Moves a Drive file to Trash rather than a hard delete — recoverable from Drive's own Trash if
// something goes wrong, and consistent with every other query here already filtering trashed=false.
async function driveTrashFile(fileId) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }),
  });
  if (!res.ok) throw new Error(`Drive delete failed: ${res.status}`);
}

// Best-effort: called right after a local delete (see storage.js's tombstoneNotebooks). Deliberately
// swallows failures (no Drive configured yet, offline, not signed in) — the tombstone is already
// recorded locally regardless, so a device that IS synced will still catch the deletion next time
// it reconciles, even if this specific attempt couldn't reach Drive.
async function driveDeleteNotebookFiles(ids) {
  if (!driveConfigured() || !ids.length) return;
  try {
    const folderId = await driveFindFolder();
    if (!folderId) return; // never backed up anywhere yet -- nothing to delete
    for (const id of ids) {
      try {
        const file = await driveFindNotebookFileByProperty(folderId, id);
        if (file) await driveTrashFile(file.id);
      } catch (_) {} // one file failing shouldn't block the rest
    }
  } catch (_) {}
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
  if (!id) return { folderId, folders: [], notebooks: [], stamps: [], rosters: [], deletedNotebookIds: [], docdata: null };
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
  if (!res.ok) throw new Error(`Drive lookup failed: ${res.status}`);
  const snap = JSON.parse(await res.text());
  return {
    folderId, folders: snap.folders || [], notebooks: snap.notebooks || [], stamps: snap.stamps || [], rosters: snap.rosters || [],
    deletedNotebookIds: snap.deletedNotebookIds || [],
    docdata: snap.docdata || null, // legacy single-blob backups only, predates per-notebook files
  };
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
  const [folders, notebooksRaw, stamps, rosters, deletedNotebookIds] = await Promise.all([
    storeGetAll("folders"), storeGetAll("notebooks"), storeGetAll("stamps"), storeGetAll("rosters"), storeGetAll("tombstones"),
  ]);
  // Drive file id / sync bookkeeping is local-only, not meaningful to other devices.
  const notebooks = notebooksRaw.map(({ driveFileId, driveSyncedAt, driveSyncedName, ...rest }) => rest);
  const bodyStr = JSON.stringify({ version: 1, folders, notebooks, stamps, rosters, deletedNotebookIds });
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

// Merges remote tombstones into the local list (so this device's own next push carries them
// forward too — the library index is one shared blob, not a merge-friendly log, so if this
// device's push didn't include a tombstone another device already recorded, it'd effectively
// un-delete that notebook from the shared index). Returns any locally-present notebook that
// turned out to be tombstoned, after actually removing it locally.
async function driveMergeRemoteTombstones(remoteDeleted) {
  if (!remoteDeleted || !remoteDeleted.length) return [];
  const localIds = new Set(libTombstones.map(t => t.id));
  for (const t of remoteDeleted) {
    if (!localIds.has(t.id)) { libTombstones.push(t); try { await storePut("tombstones", t); } catch (_) {} }
  }
  return [];
}
async function driveApplyTombstones(remoteDeleted) {
  await driveMergeRemoteTombstones(remoteDeleted);
  const deletedIds = new Set(libTombstones.map(t => t.id));
  const toRemove = libNotebooks.filter(nb => deletedIds.has(nb.id));
  for (const nb of toRemove) {
    libNotebooks = libNotebooks.filter(n => n.id !== nb.id);
    try { await storeDelete("notebooks", nb.id); await storeDelete("docdata", nb.id); } catch (_) {}
    if (nb.id === activeNotebookId) activeNotebookId = null;
  }
  return toRemove;
}

async function driveBackupNow() {
  await flushAutosave(); // make sure the active notebook's own latest edits are in docdata first
  const folderId = (await driveFindFolder()) || (await driveCreateFolder());
  let pushedAny = false, newestSeen = null;
  const note = t => { if (t && (!newestSeen || new Date(t) > new Date(newestSeen))) newestSeen = t; };

  // Quick sync check: if a notebook was deleted on another device since this device last looked,
  // drop it locally instead of blindly re-uploading it below and resurrecting it in Drive.
  try {
    const snap = await driveFetchLibrarySnapshot();
    const removed = await driveApplyTombstones(snap ? snap.deletedNotebookIds : []);
    if (removed.length) {
      if (!activeNotebookId) {
        if (libNotebooks.length) await switchNotebook(libNotebooks[0].id);
        else await createNotebookRaw("My Notes", null);
      }
      renderLibTree();
    }
  } catch (_) {} // best-effort -- worst case a since-deleted notebook gets re-pushed once more

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

// Index-driven, deliberately — restores exactly what the picker's preview shows (the library
// index), nothing more. It used to also enumerate every raw file in the Drive folder and
// resurrect anything not in the index, which silently brought back old notebooks that had been
// deleted locally (their Drive file was never cleaned up — see js/storage.js's
// tombstoneNotebooks) even though they were never shown as part of what "restore everything"
// claimed it would do. Any such leftover files are now surfaced separately in the picker as
// "Unfiled backups," restorable/deletable on their own — driveRestoreNow() itself no longer
// touches them.
async function driveRestoreNow(force) {
  const snapshot = await driveFetchLibrarySnapshot();
  if (!snapshot || !snapshot.folderId || (!snapshot.folders.length && !snapshot.notebooks.length)) {
    throw new Error('No InkPad backup found in Google Drive yet — use "Back up to Drive" first.');
  }
  if (!force) {
    const atRisk = findNewerLocalNotebooks(snapshot.notebooks);
    if (atRisk.length) throw new DriveNewerLocalWarning(atRisk);
  }

  for (const fo of snapshot.folders) await storePut("folders", fo);
  for (const st of snapshot.stamps) await storePut("stamps", st);
  for (const r of snapshot.rosters) await storePut("rosters", r);
  await driveApplyTombstones(snapshot.deletedNotebookIds);

  if (snapshot.notebooks.length) await driveRestoreSelected(snapshot.notebooks.map(n => n.id), snapshot, true);

  const folderId = snapshot.folderId;
  const settingsId = await driveFindSingletonFileId(folderId, DRIVE_SETTINGS_FILE_NAME, DRIVE_SETTINGS_FILE_ID_KEY);
  let settingsSnapshot = null;
  if (settingsId) {
    const r = await driveFetch(`https://www.googleapis.com/drive/v3/files/${settingsId}?alt=media`);
    settingsSnapshot = r.ok ? JSON.parse(await r.text()) : null;
  }
  if (settingsSnapshot && settingsSnapshot.settings) applySettingsSnapshot(settingsSnapshot.settings);

  // Re-read from whichever backend is actually active (idb or a connected
  // folder) rather than initLibrary(), which hard-codes idb and is meant
  // only for cold boot — using it here would silently show browser-storage
  // state even while connected to a folder.
  libFolders = await storeGetAll("folders");
  libNotebooks = await storeGetAll("notebooks");
  libStamps = await storeGetAll("stamps");
  libRosters = await storeGetAll("rosters");
  libTombstones = await storeGetAll("tombstones");
  renderLibTree();
  renderStampGrid();

  if (settingsId) { try { localStorage.setItem(DRIVE_SETTINGS_FILE_ID_KEY, settingsId); } catch (_) {} }
  try { localStorage.setItem(DRIVE_LIBRARY_FILE_ID_KEY, await driveFindSingletonFileId(folderId, DRIVE_LIBRARY_FILE_NAME, DRIVE_LIBRARY_FILE_ID_KEY)); } catch (_) {}
  driveLastPushedSettingsJson = settingsSnapshot ? JSON.stringify(settingsSnapshot) : null;
  driveLastPushedLibraryJson = JSON.stringify({
    version: 1, folders: snapshot.folders,
    notebooks: libNotebooks.map(({ driveFileId, driveSyncedAt, driveSyncedName, ...rest }) => rest),
    stamps: snapshot.stamps, rosters: snapshot.rosters, deletedNotebookIds: libTombstones,
  });
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
    } else if (snapshot.docdata && snapshot.docdata[nb.id]) {
      // Legacy single-file backup (from before per-notebook files existed) — content was bundled
      // inside the library file itself. Restores fine; migrates to its own file automatically on
      // the next "Back up to Drive" (nb.updatedAt > nb.driveSyncedAt).
      await storePut("docdata", snapshot.docdata[nb.id], nb.id);
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

/* ---------------- orphaned files: in Drive, but not in the current library index ---------------- */
// These are exactly what "Restore everything" used to silently resurrect without ever showing them
// in the preview first (see driveRestoreNow's comment) — most commonly notebooks deleted locally
// before local-delete started also cleaning up Drive (js/storage.js's tombstoneNotebooks). Surfaced
// here instead so the preview matches reality: restorable or deletable on their own, nothing hidden.
// Metadata-only (name/modifiedTime/properties) — no content downloaded just to list them.
async function driveFetchOrphanedNotebookFiles(folderId, knownIds) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime,properties)&pageSize=1000`);
  if (!res.ok) throw new Error(`Drive lookup failed: ${res.status}`);
  const { files } = await res.json();
  return (files || [])
    .filter(f => f.name !== DRIVE_SETTINGS_FILE_NAME && f.name !== DRIVE_LIBRARY_FILE_NAME)
    .filter(f => !(f.properties && f.properties.notebookId && knownIds.has(f.properties.notebookId)))
    .map(f => ({ id: f.id, name: f.name.replace(/\.json$/, ""), notebookId: (f.properties && f.properties.notebookId) || null, modifiedTime: f.modifiedTime }));
}
async function driveRestoreOrphanedFile(file) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`);
  if (!res.ok) throw new Error(`Drive lookup failed: ${res.status}`);
  const parsed = JSON.parse(await res.text());
  const id = file.notebookId || parsed.notebookId || genId();
  const nb = { id, name: file.name, folderId: null, createdAt: Date.now(), updatedAt: Date.now(), driveFileId: file.id, driveSyncedAt: Date.now(), driveSyncedName: file.name };
  await storePut("docdata", parsed.docdata, id);
  await storePut("notebooks", nb);
  libNotebooks = await storeGetAll("notebooks");
  await switchNotebook(id);
  renderLibTree();
  return nb;
}
async function driveDeleteOrphanedFile(file) {
  await driveTrashFile(file.id);
  if (file.notebookId) {
    const entry = { id: file.notebookId, deletedAt: Date.now() };
    libTombstones = libTombstones.filter(t => t.id !== entry.id);
    libTombstones.push(entry);
    try { await storePut("tombstones", entry); } catch (_) {}
  }
}
function driveOrphanRow(file) {
  const row = document.createElement("div");
  row.className = "lib-row lib-notebook";
  row.innerHTML = `
    <span class="lib-icon">\u{1F4C4}</span>
    <span class="lib-name">${escapeXml(file.name)}</span>
    <span class="lib-actions" style="display:flex;">
      <button type="button" title="Restore this notebook">⟳</button>
      <button type="button" title="Delete this from Drive">\u{1F5D1}</button>
    </span>`;
  const [restoreBtn, deleteBtn] = row.querySelectorAll("button");
  restoreBtn.onclick = async e => {
    e.stopPropagation();
    const ok = await confirmDialogAsync(`Restore "${file.name}"?`, "This wasn't in your current library index — it's a leftover file in Drive (often from a notebook deleted locally before that also cleaned up Drive). Restoring adds it back as a new notebook.", "Restore");
    if (!ok) return;
    try { await driveRestoreOrphanedFile(file); alert(`Restored "${file.name}" from Google Drive.`); $("driveRestoreDlg").close(); }
    catch (err) { alert("Restore failed: " + (err && err.message ? err.message : err)); }
  };
  deleteBtn.onclick = async e => {
    e.stopPropagation();
    const ok = await confirmDialogAsync(`Delete "${file.name}" from Drive?`, "This permanently removes this leftover file from Google Drive (moved to Drive's own Trash). It won't show up here again.", "Delete");
    if (!ok) return;
    try { await driveTrashFile(file.id); row.remove(); }
    catch (err) { alert("Delete failed: " + (err && err.message ? err.message : err)); return; }
    if (file.notebookId) {
      const entry = { id: file.notebookId, deletedAt: Date.now() };
      libTombstones = libTombstones.filter(t => t.id !== entry.id);
      libTombstones.push(entry);
      try { await storePut("tombstones", entry); } catch (_) {}
    }
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

  try {
    const knownIds = new Set(snapshot.notebooks.map(n => n.id));
    const orphans = await driveFetchOrphanedNotebookFiles(snapshot.folderId, knownIds);
    if (orphans.length) {
      const heading = document.createElement("div");
      heading.textContent = `Unfiled backups (${orphans.length}) — in Drive, not in your current library`;
      heading.style.cssText = "font-size:11px;color:var(--ink-soft);margin:10px 0 4px;";
      tree.appendChild(heading);
      for (const f of orphans) tree.appendChild(driveOrphanRow(f));
    }
  } catch (_) {} // best-effort -- the main tree above still works even if this extra check fails
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
