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

   Deleting a notebook locally also deletes (trashes) its Drive file and
   records a tombstone, so other devices know to drop their own copy
   instead of resurrecting it — see storage.js's tombstoneNotebooks and
   driveApplyTombstones below.

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
const DRIVE_EVER_SIGNED_IN_KEY = "inkpad.driveEverSignedIn";
const DRIVE_LAST_SEEN_KEY = "inkpad.driveLastSeenModified";
const DRIVE_AUTO_PUSH_INTERVAL_MS = 2 * 60000;

function driveConfigured() { return !!DRIVE_CLIENT_ID; }
function driveSanitizeName(name) { return ((name || "Untitled").replace(/[\\/:*?"<>|]/g, "-").trim() || "Untitled"); }

let driveTokenClient = null;
let driveAccessToken = null;
let driveGisReady = null;

// Automatic/background code (the boot-time "check for a newer Drive backup" and the periodic
// auto-push timer) must never surprise the user with a real Google sign-in popup they didn't ask
// for -- only a genuine click on a Drive action (Back up, Restore, Manage) should ever escalate a
// failed silent token refresh into the interactive consent flow. Set true only around those
// explicit user-initiated call trees; driveGetToken consults it below.
let driveInteractiveAllowed = false;
async function withDriveInteractive(fn) {
  driveInteractiveAllowed = true;
  try { return await fn(); }
  finally { driveInteractiveAllowed = false; }
}

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

function ensureDriveTokenClient() {
  if (!driveTokenClient) {
    driveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: DRIVE_CLIENT_ID, scope: DRIVE_SCOPE, callback: () => {},
    });
  }
  return driveTokenClient;
}
/* GIS `prompt` values, straight from Google's TokenClientConfig reference — the exact meanings
   matter here and getting them backwards is what made this app prompt constantly:
     "none"           — never show any UI. The only genuinely silent option.
     ""               — show UI only the FIRST time the app requests access. Interactive when a
                        grant is actually needed, invisible once granted.
     "consent"        — ALWAYS re-show the consent screen, even to a signed-in, already-granted
                        user. Never appropriate for routine use.
     "select_account" — always show the account chooser. (Also the default when prompt is omitted.)
   So: "none" for background checks, "" for genuine user-initiated actions. Nothing here should
   ever use "consent" — that is a re-authorize action, not a sign-in. */
function requestDriveToken(prompt) {
  return new Promise((resolve, reject) => {
    driveTokenClient.callback = resp => resp.error ? reject(resp) : resolve(resp);
    driveTokenClient.requestAccessToken({ prompt });
  });
}

/* Access tokens last about an hour, but this app used to keep them only in a module variable —
   thrown away on every page load. That made each refresh depend on a fresh silent renewal from
   Google, which needs a usable third-party session cookie: exactly what Safari's ITP blocks and
   what Chrome is phasing out. When that renewal fails there's nothing to fall back on, so the
   next Drive action has to escalate to a visible sign-in.
   Persisting the token with its expiry means a reload inside the hour needs no contact with
   Google at all. It is a bearer credential in localStorage, which is a real if modest tradeoff —
   mitigated by the narrow drive.file scope (only files this app itself created) and by the fact
   that anything able to read localStorage here could just as easily read the notebooks. */
const DRIVE_TOKEN_KEY = "inkpad.driveToken";
const DRIVE_TOKEN_SKEW_MS = 60000; // treat as expired a minute early, so it can't die mid-request
let driveTokenExpiresAt = 0;

function storeDriveToken(resp) {
  driveAccessToken = resp.access_token;
  const ttl = (Number(resp.expires_in) || 3600) * 1000;
  driveTokenExpiresAt = Date.now() + ttl;
  try { localStorage.setItem(DRIVE_TOKEN_KEY, JSON.stringify({ t: driveAccessToken, exp: driveTokenExpiresAt })); } catch (_) {}
  markDriveEverSignedIn();
  return driveAccessToken;
}
function clearStoredDriveToken() {
  driveAccessToken = null;
  driveTokenExpiresAt = 0;
  try { localStorage.removeItem(DRIVE_TOKEN_KEY); } catch (_) {}
}
// The still-usable token, or null. Reads through to localStorage so the very first call after a
// page load picks up a token that's still good rather than going back to Google for one.
function driveValidToken() {
  if (!driveAccessToken) {
    try {
      const s = JSON.parse(localStorage.getItem(DRIVE_TOKEN_KEY) || "null");
      if (s && s.t && s.exp) { driveAccessToken = s.t; driveTokenExpiresAt = s.exp; }
    } catch (_) {}
  }
  if (!driveAccessToken) return null;
  if (Date.now() > driveTokenExpiresAt - DRIVE_TOKEN_SKEW_MS) { clearStoredDriveToken(); return null; }
  return driveAccessToken;
}
// Coalesces silent-token attempts that happen close together into ONE real call to Google instead
// of one per call site. At boot alone, three independent places can each want a token within
// moments of each other -- the sign-in status check, the "is there a newer Drive backup?" check,
// and whatever driveFetch call happens first -- and none of them knew about each other, so each
// fired its own separate requestAccessToken. On an account/browser where the silent attempt can't
// complete invisibly (no valid session, blocked third-party cookies, etc.), that meant one visible
// Google prompt per call site -- reported directly as "opening the app, I got 3 login prompts."
// The settled result (success OR failure) is kept for a few seconds so near-simultaneous callers
// share it instead of each retrying live.
let driveSilentAttempt = null;
function driveSilentTokenShared() {
  const existing = driveValidToken();
  if (existing) return Promise.resolve(existing); // still-good token: no round trip at all
  if (driveSilentAttempt) return driveSilentAttempt;
  driveSilentAttempt = (async () => {
    await loadGis();
    ensureDriveTokenClient();
    // "none", not "" — see the prompt-value notes above. "" shows a real sign-in window whenever a
    // grant is needed, so using it here meant the boot-time status check could pop a Google window
    // on an ordinary page refresh. That was half of the "it keeps asking me to log in" report.
    return storeDriveToken(await requestDriveToken("none"));
  })();
  driveSilentAttempt.catch(() => {}).finally(() => setTimeout(() => { driveSilentAttempt = null; }, 5000));
  return driveSilentAttempt;
}
// Reuses a stored/still-valid token, then tries a genuinely silent renewal; only falls back to a
// prompt-if-needed request when that fails AND we're inside a real user-initiated action (see
// driveInteractiveAllowed above). That gate applies to the forceInteractive path too (used by
// driveFetch's 401 retry) -- a token that stops working mid-background-operation must fail quietly
// rather than force a window just because that call site skipped the silent step.
// Note "interactive" here means "may show UI if a grant is genuinely needed" -- for an already
// signed-in, already-granted user it still completes with nothing shown.
async function driveGetToken(forceInteractive) {
  if (!forceInteractive) {
    try {
      return await driveSilentTokenShared();
    } catch (err) {
      if (!driveInteractiveAllowed) throw err;
    }
  } else if (!driveInteractiveAllowed) {
    throw new Error("Not signed in to Google Drive.");
  }
  await loadGis();
  ensureDriveTokenClient();
  // "" — prompt only if a grant is actually needed. This used to be "consent", which forces the
  // full "InkPad wants access to your Google Drive" screen on EVERY call regardless of being
  // already signed in and already granted: the other half of the "it keeps asking me to log in"
  // report, and why it happened on every Back up / Restore / Manage click.
  return storeDriveToken(await requestDriveToken(""));
}
// Silent-only check, used purely to answer "are we signed in right now" (status line, boot check)
// — unlike driveGetToken(false), this never falls back to the interactive consent popup on
// failure. Popping a real Google sign-in window just to display a status label would be a bad
// surprise the user never asked for. Shares the same coalesced attempt as driveGetToken's silent
// path above, so this and a near-simultaneous automatic Drive call don't each fire their own.
function driveTrySilentToken() {
  return driveSilentTokenShared();
}
function markDriveEverSignedIn() {
  try { localStorage.setItem(DRIVE_EVER_SIGNED_IN_KEY, "1"); } catch (_) {}
}
function driveHasEverSignedIn() {
  try { return localStorage.getItem(DRIVE_EVER_SIGNED_IN_KEY) === "1"; } catch (_) { return false; }
}
// Distinguishes a device that's *never* connected Drive from one where a previously-working grant
// has stopped silently renewing (revoked access, consent expired, etc.) — the latter is the "was
// signed in, now isn't" case the status line calls out specifically, since the fix (re-authorize)
// differs from a fresh setup. Checked opportunistically (boot, and every time the File menu opens)
// via the silent-only path above rather than kept as a standing flag.
async function refreshDriveSignInStatus() {
  const el = $("fmDriveStatus");
  if (!el) return;
  if (!driveConfigured()) { el.textContent = ""; el.className = "fm-status"; return; }
  try {
    await driveTrySilentToken();
    el.textContent = "Signed in to Google Drive";
    el.className = "fm-status signed-in";
  } catch (_) {
    if (driveHasEverSignedIn()) {
      el.textContent = "Not signed in — this device was signed in before; sign in again to resume syncing";
      el.className = "fm-status signed-out-lost";
    } else {
      el.textContent = "Not signed in";
      el.className = "fm-status";
    }
  }
}

async function driveFetch(url, opts = {}) {
  const token = driveValidToken() || await driveGetToken(false);
  const withAuth = t => ({ ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${t}` } });
  let res = await fetch(url, withAuth(token));
  if (res.status === 401) { // rejected despite not being past its expiry — revoked, or clock skew
    clearStoredDriveToken(); // never retry with, or re-persist, a token Google has just refused
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

// Confirms a cached Drive file id is still live, not trashed, and still filed under `folderId` —
// guards against a stale cache silently overwriting an orphaned file when the user deletes/trashes
// a file (or the whole InkPad folder) directly in Drive's own UI, outside the app. Trusting a stale
// id blindly is dangerous specifically because it's SELF-consistent: the device that wrote it keeps
// reading its own writes back fine (same stale id, still resolves, still has the content it just
// wrote), so nothing looks wrong there — but a *different* device's fresh, uncached lookup searches
// by name/property with trashed=false and finds nothing, since the real data landed in a trashed or
// wrong-folder file. This is what made "I cleared Drive, backed up, then couldn't see it on another
// device" so confusing: the backup silently "succeeded" every time, on the one device that could no
// longer tell the difference.
async function driveValidateCachedFileId(id, folderId) {
  if (!id) return false;
  try {
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,trashed,parents`);
    if (!res.ok) return false;
    const meta = await res.json();
    return !meta.trashed && Array.isArray(meta.parents) && meta.parents.includes(folderId);
  } catch (_) { return false; }
}

// Cached locally so routine backups skip a name-lookup round trip; falls back
// to searching by name (e.g. after a fresh restore, or on a new device, or
// when the cached id turns out to be stale) when the cache is empty or invalid.
async function driveFindSingletonFileId(folderId, name, cacheKey) {
  let id = null;
  try { id = localStorage.getItem(cacheKey); } catch (_) {}
  if (id) {
    if (await driveValidateCachedFileId(id, folderId)) return id;
    try { localStorage.removeItem(cacheKey); } catch (_) {}
    id = null;
  }
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
  let existingId = nb.driveFileId || null;
  if (existingId && !(await driveValidateCachedFileId(existingId, folderId))) {
    // The cached id went stale (trashed, or the whole InkPad folder got cleared directly in Drive,
    // outside the app) — don't blindly create a duplicate: another device may have already re-synced
    // this exact notebook under a different Drive file, findable by its notebookId property.
    const existing = await driveFindNotebookFileByProperty(folderId, nb.id);
    existingId = existing ? existing.id : null;
  }
  const renameToo = !!existingId && nb.driveSyncedName !== nb.name;
  const bodyStr = JSON.stringify({ version: 1, notebookId: nb.id, docdata: json });
  const result = await drivePushFile(existingId, folderId, fileName, bodyStr, renameToo, { notebookId: nb.id });
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

/* ---------------- warn before deleting a notebook that was never in Drive at all ---------------- */

// "Restore everything" is the one restore path meant to make local storage exactly mirror Drive
// (its own confirm dialog already says "replaces every notebook..."). That means deleting local
// notebooks that aren't part of the Drive backup at all — not just ones this device already knows
// were deliberately deleted (driveApplyTombstones handles those separately). This is a distinct
// risk from DriveNewerLocalWarning above: there's no remote copy to compare timestamps against, so
// silently wiping one could destroy something that was never backed up anywhere. Warned separately,
// and only on this one restore path — driveRestoreSelected/driveRestoreFolder are deliberately
// scoped and never touch notebooks outside what was asked for.
class DriveLocalOnlyWarning extends Error {
  constructor(items) { super("Local-only notebooks would be deleted"); this.localOnly = items; }
}
function formatLocalOnlyWarning(items) {
  return items.map(nb => `"${nb.name}"`).join(", ");
}
// Runs driveRestoreNow, sequentially confirming each distinct risk it can throw (a notebook that
// looks newer locally, then — separately — local-only notebooks a true mirror would delete) before
// re-running with that specific guard bypassed. Two independent flags rather than one shared
// "force" so confirming one risk doesn't silently wave through the other unconfirmed.
async function runRestoreEverythingGuard() {
  let force = false, forceLocalWipe = false;
  for (;;) {
    try {
      await driveRestoreNow(force, forceLocalWipe);
      return true;
    } catch (err) {
      if (err instanceof DriveNewerLocalWarning) {
        const ok = await confirmDialogAsync(
          "Local changes look newer than Drive",
          `${formatNewerLocalWarning(err.newerLocal)}. Restoring will overwrite ${err.newerLocal.length > 1 ? "these" : "this"} with the older Drive version. Continue anyway?`,
          "Restore anyway"
        );
        if (!ok) return false;
        force = true;
        continue;
      }
      if (err instanceof DriveLocalOnlyWarning) {
        const ok = await confirmDialogAsync(
          "Local notebooks not in this Drive backup",
          `${formatLocalOnlyWarning(err.localOnly)} ${err.localOnly.length > 1 ? "aren't" : "isn't"} in your Drive backup at all and will be permanently deleted to make this device match Drive exactly. This can't be undone. Continue?`,
          "Delete and restore"
        );
        if (!ok) return false;
        forceLocalWipe = true;
        continue;
      }
      throw err;
    }
  }
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
async function driveRestoreNow(force, forceLocalWipe) {
  const snapshot = await driveFetchLibrarySnapshot();
  if (!snapshot || !snapshot.folderId || (!snapshot.folders.length && !snapshot.notebooks.length)) {
    throw new Error('No InkPad backup found in Google Drive yet — use "Back up to Drive" first.');
  }
  if (!force) {
    const atRisk = findNewerLocalNotebooks(snapshot.notebooks);
    if (atRisk.length) throw new DriveNewerLocalWarning(atRisk);
  }

  // Reconcile tombstones early (safe/idempotent — recording a remote-known deletion id doesn't
  // itself remove anything) so the local-only check below can tell apart "local-only because it was
  // deliberately deleted somewhere" (already handled by tombstones, not a surprise) from "local-only
  // because it simply never made it into this Drive backup at all" (the new, riskier case).
  await driveMergeRemoteTombstones(snapshot.deletedNotebookIds);
  const remoteIds = new Set(snapshot.notebooks.map(n => n.id));
  const tombstonedIds = new Set(libTombstones.map(t => t.id));
  const localOnly = libNotebooks.filter(nb => !remoteIds.has(nb.id) && !tombstonedIds.has(nb.id));
  if (!forceLocalWipe && localOnly.length) throw new DriveLocalOnlyWarning(localOnly);

  for (const fo of snapshot.folders) await storePut("folders", fo);
  for (const st of snapshot.stamps) await storePut("stamps", st);
  for (const r of snapshot.rosters) await storePut("rosters", r);
  await driveApplyTombstones(snapshot.deletedNotebookIds);

  if (snapshot.notebooks.length) await driveRestoreSelected(snapshot.notebooks.map(n => n.id), snapshot, true);

  // True mirror: delete local notebooks that aren't part of the Drive backup at all. Computed
  // above (before any mutation) so the warning names exactly what's about to go; re-filter against
  // the current activeNotebookId here since driveRestoreSelected (just above) may have switched it.
  for (const nb of localOnly) {
    try { await storeDelete("notebooks", nb.id); await storeDelete("docdata", nb.id); } catch (_) {}
    if (nb.id === activeNotebookId) activeNotebookId = null;
  }

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
  // Edge case the local-only wipe above can newly reach: a Drive backup with no notebooks in it,
  // restored onto a device whose entire local library was local-only — matches deleteNotebook's own
  // "don't leave the app with nothing open" fallback rather than leaving activeNotebookId dangling.
  if (libNotebooks.length === 0) await createNotebookRaw("My Notes", null);
  else if (!activeNotebookId || !libNotebooks.some(nb => nb.id === activeNotebookId)) await switchNotebook(libNotebooks[0].id);
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
      const proceeded = await withDriveInteractive(() => runRestoreWithNewerLocalGuard(force => driveRestoreFolder(f.id, force)));
      if (proceeded) { notifyDialog("Restored from Drive", `"${f.name}" was restored from Google Drive.`); $("driveRestoreDlg").close(); }
    } catch (err) { notifyDialog("Restore failed", (err && err.message ? err.message : String(err))); }
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
      const proceeded = await withDriveInteractive(() => runRestoreWithNewerLocalGuard(force => driveRestoreSelected([nb.id], null, force)));
      if (proceeded) { notifyDialog("Restored from Drive", `"${nb.name}" was restored from Google Drive.`); $("driveRestoreDlg").close(); }
    } catch (err) { notifyDialog("Restore failed", (err && err.message ? err.message : String(err))); }
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
  const nb = { id, name: file.name, folderId: null, order: nextOrderIn(null), createdAt: Date.now(), updatedAt: Date.now(), driveFileId: file.id, driveSyncedAt: Date.now(), driveSyncedName: file.name };
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
// onRestored lets a caller other than the restore picker (e.g. the manage-backups dialog) decide
// what happens after a successful restore instead of always closing #driveRestoreDlg — defaults to
// that same close-the-restore-picker behavior so the original call site is unaffected.
function driveOrphanRow(file, onRestored) {
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
    try { await withDriveInteractive(() => driveRestoreOrphanedFile(file)); notifyDialog("Restored from Drive", `"${file.name}" was restored from Google Drive.`); (onRestored || (() => $("driveRestoreDlg").close()))(); }
    catch (err) { notifyDialog("Restore failed", (err && err.message ? err.message : String(err))); }
  };
  deleteBtn.onclick = async e => {
    e.stopPropagation();
    const ok = await confirmDialogAsync(`Delete "${file.name}" from Drive?`, "This permanently removes this leftover file from Google Drive (moved to Drive's own Trash). It won't show up here again.", "Delete");
    if (!ok) return;
    try { await withDriveInteractive(() => driveTrashFile(file.id)); row.remove(); }
    catch (err) { notifyDialog("Delete failed", (err && err.message ? err.message : String(err))); return; }
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
  if (!driveConfigured()) { notifyDialog("Drive sync isn't set up", "Google Drive sync isn't configured yet — see the top of js/drive-sync.js for the one-line config."); return; }
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

/* ---------------- manage backups: what's actually in Drive right now, link health, per-file control ----------------
   Unlike the restore picker (built from the lightweight library index, for speed), this reads the
   real Drive-side status directly — whether each cached file link still resolves — since that's
   exactly the thing that can silently go wrong (see driveValidateCachedFileId's comment) and is
   otherwise invisible until a *different* device's restore comes up empty. */

function driveManageSingletonRow(label, cacheKey, folderId) {
  const row = document.createElement("div");
  row.className = "lib-row lib-notebook";
  row.innerHTML = `
    <span class="lib-icon">\u{1F4C4}</span>
    <span class="lib-name">${escapeXml(label)}</span>
    <span class="lib-actions" style="display:flex;">
      <span class="drive-status" style="color:var(--ink-soft);font-size:11px;margin-right:6px;white-space:nowrap;"></span>
      <button type="button" title="Re-check this file's link">⟳</button>
    </span>`;
  const statusEl = row.querySelector(".drive-status");
  const check = async () => {
    statusEl.textContent = "checking…";
    let id = null;
    try { id = localStorage.getItem(cacheKey); } catch (_) {}
    if (!id) { statusEl.textContent = "not created yet"; return; }
    const ok = await driveValidateCachedFileId(id, folderId);
    statusEl.textContent = ok ? "linked ✓" : "⚠ link is stale — will recreate on next backup";
  };
  row.querySelector("button").onclick = e => { e.stopPropagation(); withDriveInteractive(check); };
  check();
  return row;
}

function driveManageNotebookRow(nb, folderId) {
  const row = document.createElement("div");
  row.className = "lib-row lib-notebook";
  row.innerHTML = `
    <span class="lib-icon">\u{1F4C4}</span>
    <span class="lib-name">${escapeXml(nb.name)}</span>
    <span class="lib-actions" style="display:flex;">
      <span class="drive-status" style="color:var(--ink-soft);font-size:11px;margin-right:6px;white-space:nowrap;"></span>
      <button type="button" data-act="push" title="Push this notebook to Drive now">📤</button>
      <button type="button" data-act="recheck" title="Re-check this notebook's Drive link">⟳</button>
      <button type="button" data-act="delete" title="Delete this notebook's file from Drive (keeps it here locally)">\u{1F5D1}</button>
    </span>`;
  const statusEl = row.querySelector(".drive-status");
  const refreshStatus = async () => {
    if (!nb.driveFileId) { statusEl.textContent = "not backed up yet"; return; }
    statusEl.textContent = "checking…";
    const ok = await driveValidateCachedFileId(nb.driveFileId, folderId);
    statusEl.textContent = ok ? `synced ${new Date(nb.driveSyncedAt).toLocaleString()}` : "⚠ link is stale — will recreate on next backup";
  };
  row.querySelector('[data-act=push]').onclick = async e => {
    e.stopPropagation();
    try { await withDriveInteractive(() => driveBackupNotebook(nb, folderId)); await refreshStatus(); }
    catch (err) { notifyDialog("Push failed", (err && err.message ? err.message : String(err))); }
  };
  row.querySelector('[data-act=recheck]').onclick = e => { e.stopPropagation(); withDriveInteractive(refreshStatus); };
  row.querySelector('[data-act=delete]').onclick = async e => {
    e.stopPropagation();
    const ok = await confirmDialogAsync(
      `Delete "${nb.name}" from Drive?`,
      "This removes just the Drive backup (moved to Drive's own Trash) — the notebook itself stays right here. It'll be backed up again next time you edit it, or if you push it here.",
      "Delete"
    );
    if (!ok) return;
    try {
      await withDriveInteractive(async () => {
        let id = nb.driveFileId && await driveValidateCachedFileId(nb.driveFileId, folderId) ? nb.driveFileId : null;
        if (!id) { const f = await driveFindNotebookFileByProperty(folderId, nb.id); id = f ? f.id : null; }
        if (!id) { notifyDialog("Nothing to delete", `"${nb.name}" isn't backed up to Drive right now.`); return; }
        await driveTrashFile(id);
        // Deliberately clear driveFileId only, not driveSyncedAt -- leaving driveSyncedAt alone keeps
        // the auto-sync loop's dirty check (updatedAt > driveSyncedAt) false, so this doesn't get
        // silently re-created on the next auto-push; it comes back only on a real edit or the push
        // button above, same as if it had never had a Drive file at all.
        nb.driveFileId = null;
        try { await storePut("notebooks", nb); } catch (_) {}
      });
      await refreshStatus();
    } catch (err) { notifyDialog("Delete failed", (err && err.message ? err.message : String(err))); }
  };
  refreshStatus();
  return row;
}

async function openDriveManageDialog() {
  if (!driveConfigured()) { notifyDialog("Drive sync isn't set up", "Google Drive sync isn't configured yet — see the top of js/drive-sync.js for the one-line config."); return; }
  const tree = $("driveManageTree"), status = $("driveManageStatus");
  tree.innerHTML = "";
  status.textContent = "Loading…";
  $("driveManageDlg").showModal();
  let folderId;
  try { folderId = await driveFindFolder(); }
  catch (err) { status.textContent = "Couldn't load: " + (err && err.message ? err.message : err); return; }
  if (!folderId) { status.textContent = "No InkPad backup found in Google Drive yet — back up once first."; return; }
  status.textContent = "";

  tree.appendChild(driveManageSingletonRow("InkPad Library.json (folder tree, notebook list)", DRIVE_LIBRARY_FILE_ID_KEY, folderId));
  tree.appendChild(driveManageSingletonRow("InkPad Settings.json (keymap, palette, etc.)", DRIVE_SETTINGS_FILE_ID_KEY, folderId));

  const nbHeading = document.createElement("div");
  nbHeading.textContent = `Notebooks (${libNotebooks.length})`;
  nbHeading.style.cssText = "font-size:11px;color:var(--ink-soft);margin:10px 0 4px;";
  tree.appendChild(nbHeading);
  for (const nb of libNotebooks) tree.appendChild(driveManageNotebookRow(nb, folderId));

  try {
    const knownIds = new Set(libNotebooks.map(n => n.id));
    const orphans = await driveFetchOrphanedNotebookFiles(folderId, knownIds);
    if (orphans.length) {
      const heading = document.createElement("div");
      heading.textContent = `Unrecognized files in Drive (${orphans.length}) — not linked to any notebook here`;
      heading.style.cssText = "font-size:11px;color:var(--ink-soft);margin:10px 0 4px;";
      tree.appendChild(heading);
      for (const f of orphans) tree.appendChild(driveOrphanRow(f, () => openDriveManageDialog()));
    }
  } catch (_) {} // best-effort -- the rest of the dialog above still works even if this extra check fails
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
    if (ok) { await withDriveInteractive(runRestoreEverythingGuard); return; }
    try { localStorage.setItem(DRIVE_LAST_SEEN_KEY, newest); } catch (_) {} // don't ask again for the same version
  } catch (_) {}
}

function wireDriveMenu() {
  const needsSetup = () => { notifyDialog("Drive sync isn't set up", "Google Drive sync isn't configured yet — see the top of js/drive-sync.js for the one-line config."); };
  $("fmDriveBackup").onclick = async () => {
    closeFileMenu();
    if (!driveConfigured()) return needsSetup();
    try { const pushed = await withDriveInteractive(driveBackupNow); notifyDialog("Back up to Drive", pushed ? "Backed up to Google Drive." : "Already up to date — nothing's changed since the last backup."); }
    catch (err) { notifyDialog("Backup failed", (err && err.message ? err.message : String(err))); }
    refreshDriveSignInStatus();
  };
  $("fmDriveRestore").onclick = () => { closeFileMenu(); withDriveInteractive(openDriveRestorePicker); };
  $("fmDriveManage").onclick = () => { closeFileMenu(); withDriveInteractive(openDriveManageDialog); };
  $("driveRestoreAllBtn").onclick = async () => {
    if (!driveConfigured()) return needsSetup();
    const ok = await confirmDialogAsync("Restore everything from Google Drive?", "This replaces every notebook currently stored in your active storage location (browser storage, or a connected folder if you have one open) with what's in your Drive backup. This can't be undone locally.", "Restore");
    if (!ok) return;
    try {
      const proceeded = await withDriveInteractive(runRestoreEverythingGuard);
      if (proceeded) { notifyDialog("Restored from Drive", "Your library was restored from Google Drive."); $("driveRestoreDlg").close(); }
    } catch (err) { notifyDialog("Restore failed", (err && err.message ? err.message : String(err))); }
    refreshDriveSignInStatus();
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
      try { await withDriveInteractive(driveBackupNow); } catch (err) { notifyDialog("Initial backup failed", (err && err.message ? err.message : String(err))); }
      refreshDriveSignInStatus();
    }
  };
  startDriveAutoPushLoop(); // no-op internally unless/until the pref is on
  refreshDriveSignInStatus(); // one silent check at boot only -- not re-probed on every File-menu open
}
