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
const DRIVE_AUTO_SYNC_INTERVAL_MS = 30000;

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
// Set when the auto-push loop had something to send but no usable token, so the status line can
// explain the pause instead of leaving backups silently not happening.
let driveAutoSyncPausedNoToken = false;
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

// Holds the current in-flight request's reject function so error_callback (below) can
// fail it — GIS delivers those errors out-of-band, not through the per-request callback.
let drivePendingTokenFail = null;

function ensureDriveTokenClient() {
  if (!driveTokenClient) {
    driveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: DRIVE_CLIENT_ID, scope: DRIVE_SCOPE,
      callback: () => {},
      // Fires for failures that never reach `callback` at all: popup blocked, the GIS
      // iframe failing to load, the user closing the sign-in window. Without this those
      // cases leave the request promise pending forever, which surfaces as the whole UI
      // sitting on "Loading your Drive library…" with no error and no way forward.
      error_callback: err => {
        if (drivePendingTokenFail) drivePendingTokenFail(err || new Error("Google sign-in didn't complete."));
      },
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
// Every request is bounded by a timeout. A prompt:"none" attempt that Google simply
// never answers is a real, observed failure mode — and with no deadline the promise
// stays pending forever, hanging whatever awaited it with no error to report. A signed
// -out user clicking Restore should get "couldn't load", not an eternal spinner.
const DRIVE_SILENT_TIMEOUT_MS = 8000;        // no user interaction — should be quick or not at all
const DRIVE_INTERACTIVE_TIMEOUT_MS = 180000; // a real person is typing a password; be generous
function requestDriveToken(prompt) {
  const silent = prompt === "none";
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => settle(reject, new Error(silent
      ? "Google didn't respond to the silent sign-in check."
      : "Google sign-in timed out.")), silent ? DRIVE_SILENT_TIMEOUT_MS : DRIVE_INTERACTIVE_TIMEOUT_MS);
    function settle(fn, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      drivePendingTokenFail = null;
      fn(value);
    }
    drivePendingTokenFail = err => settle(reject, err);
    driveTokenClient.callback = resp => resp && resp.error ? settle(reject, resp) : settle(resolve, resp);
    try { driveTokenClient.requestAccessToken({ prompt }); }
    catch (err) { settle(reject, err); }
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
// Notebooks another device has newer copies of outrank the sign-in state in the status line: being
// signed in is reassuring but not news, whereas "your other device has work this one hasn't taken"
// is the thing that used to be invisible right up until it got overwritten.
function drivePendingIncomingText() {
  const n = driveIncoming.length, c = driveConflicted.length, k = driveKeptDeleted.length;
  if (!n && !c && !k) return null;
  const parts = [];
  if (n) parts.push(`${n} notebook${n === 1 ? "" : "s"} newer in Drive`);
  if (c) parts.push(`${c} changed in both places`);
  if (k) parts.push(`${k} deleted elsewhere but kept here`);
  return parts.join(", ") + " — use Restore to download";
}
async function refreshDriveSignInStatus() {
  const el = $("fmDriveStatus");
  if (!el) return;
  if (!driveConfigured()) { el.textContent = ""; el.className = "fm-status"; return; }
  const pending = drivePendingIncomingText();
  if (pending) {
    el.textContent = pending;
    el.className = "fm-status signed-out-lost"; // same attention-drawing style as a lapsed session
    return;
  }
  // A still-valid stored token means signed in, with no need to ask Google anything.
  if (driveValidToken()) {
    el.textContent = "Signed in to Google Drive";
    el.className = "fm-status signed-in";
    return;
  }
  if (driveAutoSyncPausedNoToken) {
    el.textContent = "Auto-sync paused — your Google session expired. Back up or restore once to resume it.";
    el.className = "fm-status signed-out-lost";
    return;
  }
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

/* ---------------- per-notebook sync state ----------------
   Backup used to push blindly. That is safe only while one device is in play: the library index is
   a SINGLE blob carrying every notebook's metadata, so a device pushing its own one change also
   republishes its stale view of every other notebook, reverting whatever another device had
   recorded. The result was silent: after device A backed up an unrelated edit, device B's newer
   work was still in its content file but the index said otherwise, A believed it was fully in
   sync, and A's next edit to that notebook overwrote B's work for good.

   The comparison below is deliberately an equality test against driveSyncedUpdatedAt — the
   updatedAt value this notebook had at its last successful sync, written at both push and pull.
   Comparing "is the remote newer" across devices would mean comparing one machine's wall clock
   against another's, which clock skew alone can invert; "is it the same value I last saw" cannot
   be fooled that way. */
const DRIVE_SYNC_STATES = ["inSync", "push", "pull", "conflict", "localOnly"];
function driveNotebookSyncState(nb, remote) {
  if (!remote) return "localOnly"; // never backed up, or backed up from nowhere this index knows
  const local = nb.updatedAt || 0, rem = remote.updatedAt || 0;
  const base = nb.driveSyncedUpdatedAt;
  if (base === undefined) {
    // A notebook last synced by a build that predates this marker. One-time fallback to the old
    // straight timestamp comparison, which at least always prefers the newer side; the marker is
    // written on the next sync either way, so this branch stops being reachable per notebook.
    if (local === rem) return "inSync";
    return local > rem ? "push" : "pull";
  }
  const localChanged = local !== base, remoteChanged = rem !== base;
  if (localChanged && remoteChanged) return "conflict";
  if (localChanged) return "push";
  if (remoteChanged) return "pull";
  return "inSync";
}
// Drive file id / sync bookkeeping is local-only, meaningless to other devices.
const driveStripLocalFields = ({ driveFileId, driveSyncedAt, driveSyncedName, driveSyncedUpdatedAt, ...rest }) => rest;

// What this device should publish as the shared index. Its own entry per notebook, EXCEPT where
// Drive's is the one holding work this device hasn't taken yet — plus every notebook that exists
// only in Drive, which the old purely-local list dropped outright, orphaning its content file.
function driveMergedNotebookIndex(localNotebooks, remoteNotebooks, states) {
  const tombstoned = new Set(libTombstones.map(t => t.id));
  const byId = new Map();
  for (const rn of remoteNotebooks || []) if (!tombstoned.has(rn.id)) byId.set(rn.id, rn);
  for (const nb of localNotebooks) {
    if (tombstoned.has(nb.id)) { byId.delete(nb.id); continue; }
    const st = states.get(nb.id);
    if (st === "pull" || st === "conflict") continue; // Drive's entry is the authoritative one
    byId.set(nb.id, nb);
  }
  return [...byId.values()];
}

/* ---------------- per-tier push, each skipping a no-op upload ---------------- */

let driveLastPushedSettingsJson = null;
let driveLastPushedLibraryJson = null;
// Notebooks the last backup found newer in Drive, or changed on both sides — surfaced in the File
// menu's status line and offered as a download after a manual backup, never resolved silently.
let driveIncoming = [];   // [{id, name}] — safe to download, nothing local would be lost
let driveConflicted = []; // [{id, name}] — changed here AND in Drive since the last sync

async function driveBackupSettingsIfChanged(folderId) {
  const bodyStr = JSON.stringify({ version: 1, settings: currentSettingsSnapshot() });
  if (bodyStr === driveLastPushedSettingsJson) return null;
  const id = await driveFindSingletonFileId(folderId, DRIVE_SETTINGS_FILE_NAME, DRIVE_SETTINGS_FILE_ID_KEY);
  const result = await drivePushFile(id, folderId, DRIVE_SETTINGS_FILE_NAME, bodyStr, false);
  try { localStorage.setItem(DRIVE_SETTINGS_FILE_ID_KEY, result.id); } catch (_) {}
  driveLastPushedSettingsJson = bodyStr;
  return result;
}

// `mergedNotebooks` is what this device should publish for the notebook list — see
// driveMergedNotebookIndex. Falls back to the plain local list only when a caller has no snapshot
// to merge against (e.g. Drive was unreachable for the read).
async function driveBackupLibraryIndexIfChanged(folderId, mergedNotebooks) {
  const [folders, notebooksRaw, stamps, rosters, deletedNotebookIds] = await Promise.all([
    storeGetAll("folders"), storeGetAll("notebooks"), storeGetAll("stamps"), storeGetAll("rosters"), storeGetAll("tombstones"),
  ]);
  const notebooks = (mergedNotebooks || notebooksRaw).map(driveStripLocalFields);
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
  nb.driveSyncedUpdatedAt = nb.updatedAt || 0; // the marker every sync-state comparison keys off
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
// Has this device got work in a notebook that Drive has never seen? Same question
// driveNotebookSyncState answers, asked without needing the remote entry — which matters for a
// tombstoned notebook, because there ISN'T a remote entry any more.
function driveNotebookHasUnsyncedWork(nb) {
  return nb.driveSyncedUpdatedAt === undefined
    ? (nb.updatedAt || 0) > (nb.driveSyncedAt || 0)   // pre-marker record: same test push uses
    : (nb.updatedAt || 0) !== nb.driveSyncedUpdatedAt;
}
// Applies deletions made on other devices. A tombstone is a decision taken elsewhere, at a moment
// when THIS device's unsynced edits weren't visible to whoever made it — so applying it blindly
// destroys work nobody chose to throw away, and did so from an ordinary backup as well as a
// restore, with no warning and no way back. Anything edited here since its last sync is kept and
// reported instead; everything else (nothing local to lose) is removed as before.
let driveKeptDeleted = []; // [{id, name}] — deleted elsewhere, kept here because of local edits
async function driveApplyTombstones(remoteDeleted) {
  await driveMergeRemoteTombstones(remoteDeleted);
  const deletedIds = new Set(libTombstones.map(t => t.id));
  const toRemove = [], kept = [];
  for (const nb of libNotebooks.filter(n => deletedIds.has(n.id))) {
    (driveNotebookHasUnsyncedWork(nb) ? kept : toRemove).push(nb);
  }
  for (const nb of toRemove) {
    libNotebooks = libNotebooks.filter(n => n.id !== nb.id);
    try { await storeDelete("notebooks", nb.id); await storeDelete("docdata", nb.id); } catch (_) {}
    if (nb.id === activeNotebookId) activeNotebookId = null;
  }
  // Merged, not replaced: a backup and a restore can each reach this, and whichever runs second
  // shouldn't drop what the first one reported.
  for (const nb of kept) {
    if (!driveKeptDeleted.some(k => k.id === nb.id)) driveKeptDeleted.push({ id: nb.id, name: nb.name });
  }
  driveKeptDeleted = driveKeptDeleted.filter(k => libNotebooks.some(nb => nb.id === k.id));
  return toRemove;
}

/* Is there anything at all to push? Answered PURELY LOCALLY — no Drive request, no token, no
   Google contact of any kind. This exists because the 2-minute auto-push loop used to call
   driveBackupNow() unconditionally, and that function's very first acts are driveFindFolder()
   and driveFetchLibrarySnapshot() — real authenticated requests. So an idle notebook still
   produced Drive traffic (and a token acquisition, which GIS services through a popup window
   that opens and closes on its own) every two minutes, forever. The per-item "has this changed?"
   dedup further down only ever ran *after* that damage was done.
   Mirrors exactly what driveBackupNow would find changed, so it can never skip a real push. */
function driveHasLocalChangesToPush() {
  if (libNotebooks.some(nb => (nb.updatedAt || 0) > (nb.driveSyncedAt || 0))) return true;
  // Both of these compare against the last-pushed JSON this session; a null cache means "never
  // pushed from this device yet", which counts as needing a push.
  if (driveLastPushedSettingsJson === null || driveLastPushedLibraryJson === null) return true;
  try {
    if (JSON.stringify({ version: 1, settings: currentSettingsSnapshot() }) !== driveLastPushedSettingsJson) return true;
  } catch (_) { return true; }
  return false;
}

// Returns {pushedAny, incoming, conflicted}. A notebook Drive holds a newer copy of is never
// pushed over and never quietly downloaded either — it's reported, and the caller decides.
// `keepLocalIds` (optional) is the explicit exception: notebook ids the user has just confirmed
// resolving toward THIS device's copy after seeing a conflict — see wireDriveMenu's conflict
// branch. Without this, "conflict" is a dead end: driveSyncedUpdatedAt only ever advances via a
// real push below, which conflict status itself blocks, so a notebook that lands in conflict once
// stays there on every future backup no matter how many more times it's edited — the "edit and
// back up again to keep this device's" advice in the UI had no code path that actually did it.
async function driveBackupNow(keepLocalIds) {
  await flushAutosave(); // make sure the active notebook's own latest edits are in docdata first
  const folderId = (await driveFindFolder()) || (await driveCreateFolder());
  let pushedAny = false, newestSeen = null;
  const note = t => { if (t && (!newestSeen || new Date(t) > new Date(newestSeen))) newestSeen = t; };

  // This snapshot is what makes the push safe, and it was already being fetched here purely for
  // tombstones (if a notebook was deleted on another device since this one last looked, drop it
  // locally instead of blindly re-uploading it below and resurrecting it in Drive).
  let snap = null;
  try {
    snap = await driveFetchLibrarySnapshot();
    const removed = await driveApplyTombstones(snap ? snap.deletedNotebookIds : []);
    if (removed.length) {
      if (!activeNotebookId) {
        if (libNotebooks.length) await switchNotebook(libNotebooks[0].id);
        else await createNotebookRaw("My Notes", null);
      }
      renderLibTree();
    }
  } catch (_) {} // best-effort -- worst case a since-deleted notebook gets re-pushed once more

  // Classify every notebook BEFORE anything is written. Doing it afterwards would be useless: this
  // device's own push is what overwrites the remote entry it needs to compare against.
  const remoteById = new Map(((snap && snap.notebooks) || []).map(n => [n.id, n]));
  // A null snap means the fetch itself failed (network/Drive error, caught above) — not "nothing is
  // on Drive yet" (a real empty/first-time snapshot is still a truthy object). Falling through to
  // driveNotebookSyncState in that case would find no remote entry for ANY notebook and classify
  // every single one "localOnly", mass-pushing the whole library on a transient blip. Fall back to
  // the plain local dirty-check instead, matching pre-merge behavior when remote state is unknown.
  const states = new Map(libNotebooks.map(nb => [nb.id, snap
    ? driveNotebookSyncState(nb, remoteById.get(nb.id))
    : ((nb.updatedAt || 0) > (nb.driveSyncedAt || 0) ? "push" : "inSync")]));
  // Treat an explicitly-confirmed id as "push" for this one run — everything downstream (the
  // merged index, the per-notebook push loop) already handles "push" correctly, so this needs no
  // special-casing beyond overriding the classification itself.
  if (keepLocalIds) for (const id of keepLocalIds) if (states.has(id)) states.set(id, "push");
  const named = st => libNotebooks.filter(nb => states.get(nb.id) === st).map(nb => ({ id: nb.id, name: nb.name }));
  driveIncoming = named("pull");
  driveConflicted = named("conflict");

  const settingsResult = await driveBackupSettingsIfChanged(folderId);
  if (settingsResult) { pushedAny = true; note(settingsResult.modifiedTime); }
  const libraryResult = await driveBackupLibraryIndexIfChanged(
    folderId, snap ? driveMergedNotebookIndex(libNotebooks, snap.notebooks, states) : null);
  if (libraryResult) { pushedAny = true; note(libraryResult.modifiedTime); }
  for (const nb of libNotebooks) {
    const st = states.get(nb.id);
    if (st !== "push" && st !== "localOnly") continue; // never overwrite a newer or diverged remote
    const r = await driveBackupNotebook(nb, folderId);
    pushedAny = true; note(r.modifiedTime);
  }
  if (newestSeen) { try { localStorage.setItem(DRIVE_LAST_SEEN_KEY, newestSeen); } catch (_) {} }
  refreshDriveSignInStatus();
  return { pushedAny, incoming: driveIncoming, conflicted: driveConflicted };
}

// Downloads just the notebooks Drive holds newer copies of, without yanking the user out of
// whatever they currently have open. skipActiveSwitch on the underlying restore means it never
// jumps away from the current view on its own; the only view change here is reloading the ACTIVE
// notebook's own content, and only if it was itself one of the ones just restored — the quiet
// auto-sync loop deliberately excludes the active notebook from what it silently pulls, so for it
// this is always a no-op, and whatever's on screen stays completely undisturbed.
async function driveDownloadIncoming(items) {
  const wasActive = activeNotebookId;
  const ids = items.map(i => i.id);
  await driveRestoreSelected(ids, null, false, { skipActiveSwitch: true });
  // driveRestoreSelected already filters driveIncoming/driveConflicted down to what's left —
  // clearing the whole list here would be wrong for a caller passing a subset (the auto-sync loop).
  if (wasActive && ids.includes(wasActive)) { activeNotebookId = null; await switchNotebook(wasActive); }
  refreshDriveSignInStatus();
  renderLibTree();
}

/* ---------------- warn before overwriting a notebook that looks newer locally ---------------- */

// Thrown instead of proceeding when at least one notebook about to be overwritten has a local
// updatedAt newer than the remote copy's — names each one so the confirm dialog can be specific
// rather than a generic "this can't be undone" warning. Re-calling the same restore function with
// force=true skips this check and proceeds unconditionally (matches today's behavior).
class DriveNewerLocalWarning extends Error {
  constructor(items) { super("Local changes look newer than Drive"); this.newerLocal = items; }
}
// Uses driveNotebookSyncState's clock-skew-safe classification (equality against
// driveSyncedUpdatedAt, the same thing push already relies on) rather than comparing raw
// updatedAt timestamps across devices, which clock skew alone can invert.
function findNewerLocalNotebooks(remoteNotebooksMeta) {
  return remoteNotebooksMeta
    .map(remoteNb => ({ remoteNb, localNb: libNotebooks.find(n => n.id === remoteNb.id) }))
    .filter(({ remoteNb, localNb }) => localNb && ["push", "conflict"].includes(driveNotebookSyncState(localNb, remoteNb)))
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

/* ---------------- restore: merge in whatever Drive has that's safe to take ---------------- */

// Index-driven, deliberately — restores exactly what the picker's preview shows (the library
// index), nothing more. It used to also enumerate every raw file in the Drive folder and
// resurrect anything not in the index, which silently brought back old notebooks that had been
// deleted locally (their Drive file was never cleaned up — see js/storage.js's
// tombstoneNotebooks) even though they were never shown as part of what "restore everything"
// claimed it would do. Any such leftover files are now surfaced separately in the picker as
// "Unfiled backups," restorable/deletable on their own — driveRestoreNow() itself no longer
// touches them.
//
// This used to make local storage an exact mirror of Drive: overwrite everything Drive has
// (guarded only by a blanket "local looks newer, overwrite anyway?" confirm) and DELETE every
// local notebook Drive didn't know about. That's a destructive operation dressed up as a restore
// — a notebook started on this device since the last sync, or one with real unsynced edits, could
// vanish without ever being individually named. This is a non-destructive MERGE instead, using the
// same clock-skew-safe classification driveBackupNow already relies on (driveNotebookSyncState):
// pulls anything genuinely new or safely newer in Drive, and never touches (let alone deletes)
// anything with unsynced local work or an unresolved conflict — those are just reported afterward,
// same as driveBackupNow already does for its own "incoming"/"conflicted" lists.
async function driveRestoreNow() {
  const snapshot = await driveFetchLibrarySnapshot();
  if (!snapshot || !snapshot.folderId || (!snapshot.folders.length && !snapshot.notebooks.length)) {
    throw new Error('No InkPad backup found in Google Drive yet — use "Back up to Drive" first.');
  }

  // Reconcile tombstones first (safe/idempotent) so a notebook deliberately deleted elsewhere
  // doesn't get classified as some kind of local-vs-Drive mismatch below.
  await driveMergeRemoteTombstones(snapshot.deletedNotebookIds);

  const remoteById = new Map(snapshot.notebooks.map(n => [n.id, n]));
  const states = new Map(libNotebooks.map(nb => [nb.id, driveNotebookSyncState(nb, remoteById.get(nb.id))]));
  const conflicted = libNotebooks.filter(nb => states.get(nb.id) === "conflict");
  const keptUnsynced = libNotebooks.filter(nb => states.get(nb.id) === "push");

  // Safe to pull: brand new to this device (no local entry at all -- states has nothing for it), or
  // Drive's copy is genuinely newer with no local edits at risk. "inSync" is deliberately excluded
  // -- there's nothing to actually change, so re-writing it would just be a no-op fetch, and it
  // shouldn't get reported as "pulled" when nothing about it changed. Never "push" (local has
  // unsynced work) or "conflict" (both sides changed) -- those are left alone, not overwritten.
  const toPull = snapshot.notebooks
    .filter(remoteNb => { const st = states.get(remoteNb.id); return st === undefined || st === "pull"; })
    .map(n => n.id);

  for (const fo of snapshot.folders) await storePut("folders", fo);
  for (const st of snapshot.stamps) await storePut("stamps", st);
  for (const r of snapshot.rosters) await storePut("rosters", r);
  await driveApplyTombstones(snapshot.deletedNotebookIds);

  if (toPull.length) await driveRestoreSelected(toPull, snapshot, true);

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
  // A brand new device with no local library yet and nothing pulled (e.g. an empty Drive backup)
  // still needs something open — matches deleteNotebook's own "don't leave the app with nothing
  // open" fallback rather than leaving activeNotebookId dangling.
  if (libNotebooks.length === 0) await createNotebookRaw("My Notes", null);
  else if (!activeNotebookId || !libNotebooks.some(nb => nb.id === activeNotebookId)) await switchNotebook(libNotebooks[0].id);
  renderLibTree();
  renderStampGrid();

  if (settingsId) { try { localStorage.setItem(DRIVE_SETTINGS_FILE_ID_KEY, settingsId); } catch (_) {} }
  try { localStorage.setItem(DRIVE_LIBRARY_FILE_ID_KEY, await driveFindSingletonFileId(folderId, DRIVE_LIBRARY_FILE_NAME, DRIVE_LIBRARY_FILE_ID_KEY)); } catch (_) {}
  // Local now matches Drive's settings exactly (just applied above), so that cache is legitimately
  // up to date. driveLastPushedLibraryJson is deliberately left untouched, unlike the old full-mirror
  // restore -- a merge can leave local-only/unsynced notebooks that were never actually part of
  // Drive's published index, so claiming this snapshot IS what's published would make the next real
  // push wrongly think there's nothing new to publish. The next backup computes and pushes that for
  // real instead.
  driveLastPushedSettingsJson = settingsSnapshot ? JSON.stringify(settingsSnapshot) : null;
  // Only the notebooks actually just pulled are settled; anything left alone (unsynced local work,
  // an unresolved conflict) is still genuinely outstanding, so report it rather than pretending a
  // merge resolved everything the way a full mirror-restore used to.
  const pulledIds = new Set(toPull);
  driveIncoming = driveIncoming.filter(i => !pulledIds.has(i.id));
  driveConflicted = conflicted.map(nb => ({ id: nb.id, name: nb.name }));
  refreshDriveSignInStatus();
  try {
    const newest = await driveFolderNewestModifiedTime(folderId);
    if (newest) localStorage.setItem(DRIVE_LAST_SEEN_KEY, newest);
  } catch (_) {}
  return {
    pulled: toPull.map(id => (remoteById.get(id) || {}).name).filter(Boolean),
    keptUnsynced: keptUnsynced.map(nb => nb.name),
    conflicted: conflicted.map(nb => nb.name),
    keptDeleted: driveKeptDeleted.map(k => k.name),
  };
}

/* ---------------- targeted restore: one notebook, or one folder's worth ---------------- */

// Set by the restore picker only while a restore IT started is running, so each notebook row can
// report what's happening to it as it happens rather than the whole thing being one opaque pause.
// Null the rest of the time: every restore funnels through driveRestoreSelected, including the
// quiet auto-sync pulls, and those have no open UI to talk to.
let driveRestoreProgressFn = null;
function driveNoteRestoreProgress(id, phase) {
  if (!driveRestoreProgressFn) return;
  try { driveRestoreProgressFn(id, phase); } catch (_) {} // never let a UI slip abort a restore
}
// Yields to the browser so a progress update actually paints before the next notebook's fetch
// starts. Without this the whole loop can land in one frame and the tracker is invisible.
const driveProgressPaint = () => new Promise(r => requestAnimationFrame(() => r()));

// Restores just these notebook ids (plus whichever ancestor folders they need so the sidebar
// nests them correctly), leaving every other locally-stored notebook untouched. driveRestoreNow()
// is the same idea at library scope — it also never touches anything outside what it classifies
// as safe to pull, it just decides that set itself instead of taking it as a parameter.
async function driveRestoreSelected(notebookIds, snapshot, force, opts = {}) {
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
    driveNoteRestoreProgress(nb.id, "working");
    if (driveRestoreProgressFn) await driveProgressPaint();
    const file = await driveFindNotebookFileByProperty(snapshot.folderId, nb.id);
    if (file) {
      const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`);
      if (res.ok) {
        const parsed = JSON.parse(await res.text());
        await storePut("docdata", parsed.docdata, nb.id);
        // nb here is the REMOTE metadata entry, so this records "local and Drive now agree at this
        // updatedAt" — the same invariant driveBackupNotebook establishes on the way out.
        nb.driveFileId = file.id; nb.driveSyncedAt = Date.now(); nb.driveSyncedName = nb.name;
        nb.driveSyncedUpdatedAt = nb.updatedAt || 0;
      }
    } else if (snapshot.docdata && snapshot.docdata[nb.id]) {
      // Legacy single-file backup (from before per-notebook files existed) — content was bundled
      // inside the library file itself. Restores fine; migrates to its own file automatically on
      // the next "Back up to Drive" (nb.updatedAt > nb.driveSyncedAt).
      await storePut("docdata", snapshot.docdata[nb.id], nb.id);
    }
    await storePut("notebooks", nb);
    driveNoteRestoreProgress(nb.id, "done");
  }

  libFolders = await storeGetAll("folders");
  libNotebooks = await storeGetAll("notebooks");
  // Taking Drive's copy settles whatever was outstanding for exactly these notebooks.
  const done = new Set(wantedMeta.map(n => n.id));
  driveIncoming = driveIncoming.filter(i => !done.has(i.id));
  driveConflicted = driveConflicted.filter(i => !done.has(i.id));
  refreshDriveSignInStatus();
  // Callers restoring as a side effect of something else (driveDownloadIncoming, mid-backup) pass
  // skipActiveSwitch and handle the active view themselves -- jumping to whatever was restored is
  // right when that's the whole point of the click (the restore picker), wrong as a side effect.
  if (!opts.skipActiveSwitch) {
    activeNotebookId = null;
    await switchNotebook(wantedMeta[0].id);
  }
  renderLibTree();
}

// The conflict resolution that doesn't make you pick a loser: "Take Drive's" and "Keep mine" each
// throw one side away, which is a real decision to have to make about a lesson you may not remember
// editing. This forks THIS device's copy off as its own notebook under a new id — so Drive's entry
// for the original is untouched and the fork simply uploads as a brand-new file on the next backup —
// and only then lets the original take Drive's copy.
//
// Order is the whole safety argument: the fork has to be written and persisted BEFORE
// driveRestoreSelected overwrites the original's docdata, or the copy being preserved is the one
// that just got clobbered.
async function driveKeepBothCopies(remoteNb) {
  const fork = await duplicateNotebook(remoteNb.id, `${remoteNb.name} (this device)`);
  if (!fork) throw new Error("Couldn't find that notebook on this device.");
  await driveRestoreSelected([remoteNb.id], null, true);
  return fork;
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

// One place that answers "how does this row differ from Drive?", so the notebook badge, the folder
// rollup counts and the auto-expand decision below can't drift apart. Reuses driveNotebookSyncState's
// clock-skew-safe classification (the same one push already relies on) rather than a naive updatedAt
// comparison. localNb is undefined for a notebook Drive has that this device has never seen at all --
// not one of driveNotebookSyncState's own states (that function always assumes a real local notebook
// to classify), so it's handled here as "new".
function driveRowChangeState(localNb, remoteNb) {
  return localNb ? driveNotebookSyncState(localNb, remoteNb) : "new";
}
const driveRemoteNbState = nb => driveRowChangeState(libNotebooks.find(n => n.id === nb.id), nb);
const DRIVE_CHANGE_LABELS = {
  inSync: null, // nothing worth calling out for the common case
  new: ["new in Drive", "#0F766E"],
  pull: ["Drive is newer", "#0F766E"],
  push: ["you have unsynced changes", "#B45309"],
  conflict: ["changed in both places", "#B91C1C"],
};
// Severity order for rolling a subtree's states up into one folder badge: a folder holding a single
// conflict among nine clean notebooks has to read as a conflict, not average away into the mildest
// thing in there.
const DRIVE_CHANGE_RANK = { new: 1, pull: 1, push: 2, conflict: 3 };
const driveWorstChange = states => states.reduce((a, b) => (DRIVE_CHANGE_RANK[b] > DRIVE_CHANGE_RANK[a] ? b : a), states[0]);
const driveBadgeHtml = (text, color) =>
  `<span class="drive-badge" style="color:${color || "var(--ink-soft)"};font-size:11px;margin-right:6px;white-space:nowrap;">${text}</span>`;
const driveSetBadge = (row, text, color) => {
  const b = row.querySelector(".drive-badge");
  if (b) { b.textContent = text; b.style.color = color || "var(--ink-soft)"; }
};

// Small colored label showing how a notebook's local copy compares to Drive's. Emitted even when
// there's nothing to say, because a running restore writes its live progress into this same element
// and an in-sync notebook can still be restored deliberately.
function driveSyncBadgeHtml(localNb, remoteNb) {
  const l = DRIVE_CHANGE_LABELS[driveRowChangeState(localNb, remoteNb)];
  return driveBadgeHtml(l ? l[0] : "", l ? l[1] : "");
}

/* ---------------- picker state: rows to light up, folder badges to recompute ---------------- */
// Rebuilt from scratch every time the picker opens, so nothing here can outlive the DOM it points at.
let driveRestoreRows = new Map();       // notebookId -> its row element, for live progress
let driveRestoreFolderRefresh = [];     // () => void, one per folder: recompute its rollup badge
let driveRestoreRemoteById = new Map(); // notebookId -> Drive's metadata entry for it

// Runs a restore with the picker's rows tracking it live, then leaves the ✓ marks in place and
// brings the folder rollups back in line with what just happened. The dialog deliberately stays
// open: watching it land IS the confirmation, and closing on success threw that away.
async function withRestorePickerProgress(run) {
  driveRestoreProgressFn = (id, phase) => {
    const row = driveRestoreRows.get(id);
    if (!row) return;
    if (phase === "working") { driveSetBadge(row, "restoring…", "#B45309"); row.style.background = "var(--accent-soft)"; }
    else { driveSetBadge(row, "restored ✓", "#0F766E"); row.style.background = ""; }
  };
  try { return await run(); }
  finally {
    driveRestoreProgressFn = null;
    // Folder counts are stale the moment anything under them lands; recompute rather than rebuild,
    // so the per-row ✓ the user just watched survives.
    for (const fn of driveRestoreFolderRefresh) fn();
  }
}

function driveRestoreFolderRow(f, childrenByFolder, notebooksByFolder, depth) {
  const wrap = document.createElement("div");
  const row = document.createElement("div");
  row.className = "lib-row lib-folder";
  row.style.paddingLeft = (depth * 14) + "px";

  // Children are built BEFORE the folder's own row markup, because both the badge it shows and
  // whether it starts open are decided entirely by what turns out to be underneath it.
  const childWrap = document.createElement("div");
  childWrap.className = "lib-children";
  const subFolders = childrenByFolder.get(f.id) || [], notebooks = notebooksByFolder.get(f.id) || [];
  const nbIds = []; // every notebook in this whole subtree, so the rollup can be recomputed later
  for (const sub of subFolders) {
    const r = driveRestoreFolderRow(sub, childrenByFolder, notebooksByFolder, depth + 1);
    childWrap.appendChild(r.wrap);
    nbIds.push(...r.nbIds);
  }
  for (const nb of notebooks) {
    nbIds.push(nb.id);
    childWrap.appendChild(driveRestoreNotebookRow(nb, depth + 1));
  }
  const subtreeChanges = () => nbIds
    .map(id => driveRemoteNbState(driveRestoreRemoteById.get(id)))
    .filter(st => st !== "inSync");
  const changed = subtreeChanges();
  const hasChildren = subFolders.length > 0 || notebooks.length > 0;
  // The whole point: a folder stays shut unless something inside it actually needs attention. Since
  // this recurses bottom-up, an ancestor of a changed notebook is opened too — so the path down to
  // it is visible without any hunting, and everything settled stays out of the way.
  let expanded = changed.length > 0;

  const rollupText = states => (states.length ? `${states.length} to review` : "");
  const rollupColor = states => (states.length ? DRIVE_CHANGE_LABELS[driveWorstChange(states)][1] : "");
  row.innerHTML = `
    <span class="lib-toggle">${hasChildren ? (expanded ? "▾" : "▸") : ""}</span>
    <span class="lib-icon">\u{1F4C1}</span>
    <span class="lib-name">${escapeXml(f.name)}</span>
    ${driveBadgeHtml(rollupText(changed), rollupColor(changed))}
    <span class="lib-actions" style="display:flex;"><button type="button" title="Replace every notebook in this folder with Drive's copy">⟳</button></span>`;
  wrap.appendChild(row);
  if (!expanded) childWrap.style.display = "none";
  driveRestoreFolderRefresh.push(() => {
    const now = subtreeChanges();
    driveSetBadge(row, rollupText(now), rollupColor(now));
  });

  // Rows are already built, so this just shows/hides them — no re-render, and no expansion state to
  // keep anywhere, unlike the sidebar's tree (which rebuilds itself from libExpanded on every change).
  const toggleEl = row.querySelector(".lib-toggle");
  const toggle = () => {
    if (!hasChildren) return;
    expanded = !expanded;
    childWrap.style.display = expanded ? "" : "none";
    toggleEl.textContent = expanded ? "▾" : "▸";
  };
  toggleEl.onclick = e => { e.stopPropagation(); toggle(); };
  row.onclick = () => toggle();

  row.querySelector("button").onclick = async e => {
    e.stopPropagation();
    const ok = await confirmDialogAsync(`Restore "${f.name}"?`, "This replaces every notebook in this folder (and any subfolders) currently stored on this device with what's in Drive.", "Restore");
    if (!ok) return;
    await runPickerRestore(
      () => runRestoreWithNewerLocalGuard(force => driveRestoreFolder(f.id, force)),
      `Restored "${f.name}" from Drive.`);
  };
  wrap.appendChild(childWrap);
  return { wrap, changed, nbIds };
}

// Every restore started from inside the picker goes through here: live per-row progress, the result
// reported in the picker's own status line, and the dialog left open. It used to fire a separate
// "Restored from Drive" dialog and close the picker, which meant the tree you were working through
// vanished after every single item and told you nothing about what the rest of it now looked like.
async function runPickerRestore(run, successMsg) {
  const status = $("driveRestoreStatus");
  try {
    const proceeded = await withRestorePickerProgress(() => withDriveInteractive(run));
    // runRestoreWithNewerLocalGuard returns false when the user backs out of its confirm; the
    // plain restores below return undefined, which is not a refusal.
    if (proceeded !== false) { status.textContent = successMsg; status.style.color = "#0F766E"; }
  } catch (err) {
    status.textContent = "Restore failed: " + (err && err.message ? err.message : String(err));
    status.style.color = "#B91C1C";
  }
  refreshDriveSignInStatus();
}

function driveRestoreNotebookRow(nb, depth) {
  const state = driveRemoteNbState(nb);
  const row = document.createElement("div");
  row.className = "lib-row lib-notebook";
  row.style.paddingLeft = (depth * 14 + 12) + "px";
  driveRestoreRows.set(nb.id, row);
  // A merge deliberately skips "push" and "conflict" notebooks — it will not overwrite local work.
  // That's correct, but on its own it's a dead end: the merge keeps reporting the same rows forever
  // and nothing in the UI ever resolves them. These two buttons are the way out, spelled out on
  // exactly the rows that need one instead of hidden behind a generic ⟳ and a scary confirm.
  const stuck = state === "push" || state === "conflict";
  // The sync badge sits OUTSIDE .lib-actions deliberately -- that class is hover-only (see
  // style.css), but the whole point of the badge is to be scannable across the tree at a glance,
  // not discovered one row at a time.
  row.innerHTML = `
    <span class="lib-icon">\u{1F4C4}</span>
    <span class="lib-name">${escapeXml(nb.name)}</span>
    ${driveSyncBadgeHtml(libNotebooks.find(n => n.id === nb.id), nb)}
    <span class="lib-actions" style="display:flex;">
      ${stuck ? `<button type="button" data-act="take" class="drive-resolve" title="Replace this device's copy with Drive's">Take Drive's</button>` : ""}
      ${state === "conflict" ? `<button type="button" data-act="keep" class="drive-resolve" title="Publish this device's copy to Drive, replacing what's there">Keep mine</button>` : ""}
      ${state === "conflict" ? `<button type="button" data-act="both" class="drive-resolve" title="Split into two notebooks — nothing is discarded">Keep both</button>` : ""}
      <button type="button" data-act="restore" title="Replace this notebook with Drive's copy">⟳</button>
    </span>`;

  const takeBtn = row.querySelector('[data-act=take]');
  if (takeBtn) takeBtn.onclick = async e => {
    e.stopPropagation();
    const detail = state === "conflict"
      ? `"${nb.name}" was changed both here and on another device. Taking Drive's copy discards the changes made on this device.`
      : `You have changes to "${nb.name}" on this device that were never backed up. Taking Drive's copy discards them.`;
    if (!await confirmDialogAsync(`Take Drive's copy of "${nb.name}"?`, detail + " This can't be undone.", "Take Drive's copy")) return;
    // force=true on purpose: the newer-local guard exists to catch exactly this situation, and the
    // confirm above has already named what's being given up. Asking twice for one decision is noise.
    await runPickerRestore(() => driveRestoreSelected([nb.id], null, true), `Took Drive's copy of "${nb.name}".`);
  };

  const keepBtn = row.querySelector('[data-act=keep]');
  if (keepBtn) keepBtn.onclick = async e => {
    e.stopPropagation();
    if (!await confirmDialogAsync(`Keep this device's copy of "${nb.name}"?`,
      `Publishes this device's copy to Drive, replacing what's there. The changes made to "${nb.name}" on the other device are discarded. This can't be undone.`, "Keep mine")) return;
    // driveBackupNow's keepLocalIds is the existing, already-tested route out of a conflict — it
    // reclassifies just this notebook as a push for one run, which advances driveSyncedUpdatedAt
    // and is the only thing that actually clears the conflict.
    await runPickerRestore(() => driveBackupNow([nb.id]), `Kept this device's copy of "${nb.name}" and pushed it to Drive.`);
    driveSetBadge(row, "kept yours ✓", "#0F766E");
  };

  const bothBtn = row.querySelector('[data-act=both]');
  if (bothBtn) bothBtn.onclick = async e => {
    e.stopPropagation();
    const forkName = `${nb.name} (this device)`;
    if (!await confirmDialogAsync(`Keep both copies of "${nb.name}"?`,
      `This device's copy is kept as a separate notebook called "${forkName}", and "${nb.name}" takes Drive's copy. Nothing is discarded, and the new one backs up to Drive on its own next time.`,
      "Keep both")) return;
    await runPickerRestore(() => driveKeepBothCopies(nb), `Kept both — this device's copy is now "${forkName}".`);
    driveSetBadge(row, "kept both ✓", "#0F766E");
  };

  row.querySelector('[data-act=restore]').onclick = async e => {
    e.stopPropagation();
    const ok = await confirmDialogAsync(`Restore "${nb.name}"?`, "This replaces this notebook's content currently stored on this device with what's in Drive.", "Restore");
    if (!ok) return;
    await runPickerRestore(
      () => runRestoreWithNewerLocalGuard(force => driveRestoreSelected([nb.id], null, force)),
      `Restored "${nb.name}" from Drive.`);
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
  // Tombstoned so another device that still has this notebook locally doesn't just re-upload it on
  // its next backup, which would bring the leftover straight back.
  if (file.notebookId) await recordTombstone(file.notebookId);
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
    // driveDeleteOrphanedFile does exactly this (trash + tombstone) and already existed — this
    // handler had its body inlined instead, leaving the real function unreferenced.
    try { await withDriveInteractive(() => driveDeleteOrphanedFile(file)); row.remove(); }
    catch (err) { notifyDialog("Delete failed", (err && err.message ? err.message : String(err))); return; }
  };
  return row;
}

// Notebooks that exist only on this device -- absent from the Drive snapshot and not tombstoned
// (i.e. never deliberately deleted elsewhere either). The old "Restore everything" used to silently
// destroy these to make local storage mirror Drive exactly; the merge-based restore below always
// keeps them instead, so this section is purely informational, plus a one-click way to back one up
// to Drive right from here if that's what's actually wanted.
function driveLocalOnlyRow(nb, folderId) {
  const row = document.createElement("div");
  row.className = "lib-row lib-notebook";
  row.innerHTML = `
    <span class="lib-icon">\u{1F4C4}</span>
    <span class="lib-name">${escapeXml(nb.name)}</span>
    <span style="color:#0F766E;font-size:11px;margin-right:6px;white-space:nowrap;">kept — not in Drive</span>
    <span class="lib-actions" style="display:flex;"><button type="button" title="Back this up to Drive now">📤</button></span>`;
  row.querySelector("button").onclick = async e => {
    e.stopPropagation();
    try { await withDriveInteractive(() => driveBackupNotebook(nb, folderId)); notifyDialog("Backed up to Drive", `"${nb.name}" was backed up to Google Drive.`); row.remove(); }
    catch (err) { notifyDialog("Backup failed", (err && err.message ? err.message : String(err))); }
  };
  return row;
}

async function openDriveRestorePicker() {
  if (!driveConfigured()) { notifyDialog("Drive sync isn't set up", "Google Drive sync isn't configured yet — see the top of js/drive-sync.js for the one-line config."); return; }
  const tree = $("driveRestoreTree"), status = $("driveRestoreStatus");
  tree.innerHTML = "";
  driveRestoreRows = new Map();
  driveRestoreFolderRefresh = [];
  driveRestoreRemoteById = new Map();
  status.style.color = "";
  status.textContent = "Loading your Drive library…";
  $("driveRestoreDlg").showModal();
  let snapshot;
  try { snapshot = await driveFetchLibrarySnapshot(); }
  catch (err) { status.textContent = "Couldn't load: " + (err && err.message ? err.message : err); return; }
  if (!snapshot || !snapshot.folderId || (!snapshot.folders.length && !snapshot.notebooks.length)) {
    status.textContent = "No InkPad backup found in Google Drive yet.";
    return;
  }
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
    driveRestoreRemoteById.set(nb.id, nb); // folder rollups recompute against this after a restore
  }
  const changed = [];
  for (const f of (childrenByFolder.get(null) || [])) {
    const r = driveRestoreFolderRow(f, childrenByFolder, notebooksByFolder, 0);
    tree.appendChild(r.wrap);
    changed.push(...r.changed);
  }
  for (const nb of (notebooksByFolder.get(null) || [])) {
    const st = driveRemoteNbState(nb);
    if (st !== "inSync") changed.push(st);
    tree.appendChild(driveRestoreNotebookRow(nb, 0));
  }
  // Says up front what the collapsed tree is hiding, so "nothing to do" and "I have to go looking"
  // are distinguishable without opening a single folder.
  status.textContent = changed.length
    ? `${changed.length} notebook${changed.length === 1 ? "" : "s"} to review — folders holding one are already open.`
    : "Everything in Drive matches this device.";

  const knownIds = new Set(snapshot.notebooks.map(n => n.id));
  const tombstonedIds = new Set(libTombstones.map(t => t.id));
  const localOnly = libNotebooks.filter(nb => !knownIds.has(nb.id) && !tombstonedIds.has(nb.id));
  if (localOnly.length) {
    const heading = document.createElement("div");
    heading.textContent = `Only on this device (${localOnly.length}) — a restore always keeps these`;
    heading.style.cssText = "font-size:11px;color:var(--ink-soft);margin:10px 0 4px;";
    tree.appendChild(heading);
    for (const nb of localOnly) tree.appendChild(driveLocalOnlyRow(nb, snapshot.folderId));
  }

  try {
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

// Both directions now: pushes local changes AND silently pulls in anything Drive has that's safe
// to take automatically (a notebook classified "pull" by driveNotebookSyncState, meaning THIS
// device hasn't touched it since the last sync — no local edit is ever at risk). A "conflict"
// notebook is never auto-resolved either way, same as a manual backup — it's only ever surfaced,
// same as before this loop existed. Split out from the setInterval registration so it can be
// called directly (once, awaited) from tests without waiting on a real 30s timer.
async function driveAutoSyncTick() {
  if (!driveAutoSyncEnabled || !driveConfigured() || dirty) return; // dirty: let local autosave settle first
  // Hard rule: background work NEVER acquires a token, it only spends one that's already
  // valid. Even prompt:"none" is serviced by GIS through a real popup window that opens and
  // closes on its own, so acquiring one here means a window flashing over the page while
  // someone is mid-sentence — which is precisely the complaint. When the hour-long token
  // lapses, auto-sync quietly pauses rather than interrupting; the next deliberate Drive
  // action (Back up, Restore, Manage) refreshes it and syncing resumes, and the File menu
  // says so in the meantime.
  if (!driveValidToken()) { driveAutoSyncPausedNoToken = true; refreshDriveSignInStatus(); return; }
  driveAutoSyncPausedNoToken = false;

  // The "quick check" this loop is named for: one cheap metadata-only listing call (no content
  // download — see driveFolderNewestModifiedTime) to see whether ANYTHING on the Drive side has
  // moved since this device last looked. Combined with the existing local dirty-check, a fully
  // idle notebook on a fully idle Drive folder costs exactly one small request per tick, not a
  // full library-index fetch — that only happens below once there's an actual reason for it.
  const hasLocal = driveHasLocalChangesToPush();
  let driveMoved = false;
  try {
    const folderId = await driveFindFolder();
    if (folderId) {
      const newest = await driveFolderNewestModifiedTime(folderId);
      let lastSeen = null;
      try { lastSeen = localStorage.getItem(DRIVE_LAST_SEEN_KEY); } catch (_) {}
      driveMoved = !!newest && (!lastSeen || new Date(newest) > new Date(lastSeen));
    }
  } catch (_) { return; } // transient — try again next tick rather than escalating blind
  if (!hasLocal && !driveMoved) return; // idle in both directions — stay completely silent

  let res;
  try { res = await driveBackupNow(); } catch (_) { return; } // silent — don't nag every interval

  // Safe to take without asking (by construction, "pull" means local hasn't changed) — except
  // whatever notebook is on screen right now. Swapping that one out from under an active
  // viewer/editor would be jarring even though nothing local is actually at risk; it stays
  // flagged for a conscious download instead, exactly like before this loop pulled anything.
  const safeToAutoPull = res.incoming.filter(nb => nb.id !== activeNotebookId);
  if (safeToAutoPull.length) { try { await driveDownloadIncoming(safeToAutoPull); } catch (_) {} }
}
function startDriveAutoSyncLoop() {
  if (driveAutoTimer) return;
  driveAutoTimer = setInterval(driveAutoSyncTick, DRIVE_AUTO_SYNC_INTERVAL_MS);
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
      `Your Drive backup was updated ${new Date(newest).toLocaleString()}. Pull in what's new? Anything you've changed here since your last sync is left alone either way.`,
      "Pull in changes"
    );
    if (ok) { await withDriveInteractive(driveRestoreNow); return; }
    try { localStorage.setItem(DRIVE_LAST_SEEN_KEY, newest); } catch (_) {} // don't ask again for the same version
  } catch (_) {}
}

function wireDriveMenu() {
  const needsSetup = () => { notifyDialog("Drive sync isn't set up", "Google Drive sync isn't configured yet — see the top of js/drive-sync.js for the one-line config."); };
  $("fmDriveBackup").onclick = async () => {
    closeFileMenu();
    if (!driveConfigured()) return needsSetup();
    let res;
    try { res = await withDriveInteractive(driveBackupNow); }
    catch (err) { notifyDialog("Backup failed", (err && err.message ? err.message : String(err))); refreshDriveSignInStatus(); return; }
    const names = list => list.map(i => `"${i.name}"`).join(", ");
    const sent = res.pushedAny ? "Backed up to Google Drive." : "Already up to date — nothing's changed since the last backup.";
    // Anything Drive holds a newer copy of was deliberately left alone above rather than
    // overwritten; offer to bring it down now, while the user is already thinking about sync.
    if (res.incoming.length) {
      const ok = await confirmDialogAsync(
        "Newer in Drive",
        `${sent} ${names(res.incoming)} ${res.incoming.length > 1 ? "have" : "has"} newer version${res.incoming.length > 1 ? "s" : ""} in Drive that this device hasn't taken yet. Download ${res.incoming.length > 1 ? "them" : "it"} now?`,
        "Download");
      if (ok) {
        try { await withDriveInteractive(() => driveDownloadIncoming(res.incoming)); notifyDialog("Downloaded from Drive", `${names(res.incoming)} updated from Google Drive.`); }
        catch (err) { notifyDialog("Download failed", (err && err.message ? err.message : String(err))); }
      }
    } else if (res.conflicted.length) {
      // Backing up again on its own can never clear this — driveBackupNow always leaves a
      // "conflict" notebook alone, so without an explicit resolution here it would just re-detect
      // the same stale conflict forever. Keeping this device's version needs to be an actual choice,
      // confirmed each time, since it does overwrite Drive's diverged copy.
      const ok = await confirmDialogAsync(
        "Changed in both places",
        `${sent} ${names(res.conflicted)} changed both here and in Drive since the last sync, so ${res.conflicted.length > 1 ? "they were" : "it was"} left untouched rather than one version overwriting the other. Keep this device's version and overwrite Drive's copy? Use "Restore from Drive" instead if you want Drive's copy.`,
        "Keep this device's");
      if (ok) {
        const ids = res.conflicted.map(i => i.id);
        try {
          const res2 = await withDriveInteractive(() => driveBackupNow(ids));
          notifyDialog("Backed up to Drive", `${names(res.conflicted)} backed up, overwriting Drive's diverged copy.`);
          res.incoming = res2.incoming; res.conflicted = res2.conflicted; // stay accurate for the status-line refresh below
        } catch (err) { notifyDialog("Backup failed", (err && err.message ? err.message : String(err))); }
      }
    } else {
      notifyDialog("Back up to Drive", sent);
    }
    refreshDriveSignInStatus();
  };
  $("fmDriveRestore").onclick = () => { closeFileMenu(); withDriveInteractive(openDriveRestorePicker); };
  $("fmDriveManage").onclick = () => { closeFileMenu(); withDriveInteractive(openDriveManageDialog); };
  $("driveRestoreAllBtn").onclick = async () => {
    if (!driveConfigured()) return needsSetup();
    const ok = await confirmDialogAsync(
      "Merge from Google Drive?",
      "Pulls in anything new or updated from your Drive backup. Notebooks you've changed here since the last sync (or that only exist on this device) are left completely alone.",
      "Merge"
    );
    if (!ok) return;
    const status = $("driveRestoreStatus");
    status.style.color = ""; status.textContent = "Merging from Drive…";
    try {
      // Same live per-row tracker the targeted restores use — a merge is the one that can touch many
      // notebooks at once, so it's where watching them land one by one matters most.
      const res = await withRestorePickerProgress(() => withDriveInteractive(driveRestoreNow));
      const parts = [];
      parts.push(res.pulled.length ? `Pulled in: ${res.pulled.map(n => `"${n}"`).join(", ")}.` : "Nothing new to pull in.");
      if (res.keptUnsynced.length) parts.push(`Left alone (you have unsynced changes): ${res.keptUnsynced.map(n => `"${n}"`).join(", ")}.`);
      if (res.conflicted.length) parts.push(`Changed in both places, left alone: ${res.conflicted.map(n => `"${n}"`).join(", ")} — use "Back up to Drive" to resolve.`);
      if (res.keptDeleted.length) parts.push(`Deleted on another device but kept here because you've edited ${res.keptDeleted.length > 1 ? "them" : "it"} since: ${res.keptDeleted.map(n => `"${n}"`).join(", ")} — ${res.keptDeleted.length > 1 ? "they stay" : "it stays"} on this device only until you delete or duplicate ${res.keptDeleted.length > 1 ? "them" : "it"}.`);
      // The picker stays open: the tree behind this dialog now shows what the merge did and what it
      // deliberately left alone, with a "Take Drive's"/"Keep mine" button on each row it skipped —
      // which is exactly where you'd want to go next, and used to be closed out from under you.
      status.textContent = res.pulled.length
        ? `Merged — pulled in ${res.pulled.length} notebook${res.pulled.length === 1 ? "" : "s"}.`
        : "Merged — nothing new to pull in.";
      status.style.color = "#0F766E";
      notifyDialog("Merged from Drive", parts.join(" "));
    } catch (err) {
      status.textContent = "Merge failed: " + (err && err.message ? err.message : String(err));
      status.style.color = "#B91C1C";
    }
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
      startDriveAutoSyncLoop();
      try { await withDriveInteractive(driveBackupNow); } catch (err) { notifyDialog("Initial backup failed", (err && err.message ? err.message : String(err))); }
      refreshDriveSignInStatus();
    }
  };
  startDriveAutoSyncLoop(); // no-op internally unless/until the pref is on
  refreshDriveSignInStatus(); // one silent check at boot only -- not re-probed on every File-menu open
}
