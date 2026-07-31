"use strict";
/* ============================================================================
   Canvas video recording — a screen-recording of just the drawing surface.

   Records exactly what the board canvas shows (so whatever you're zoomed in on
   fills the frame — no browser chrome, toolbar, or sidebar), live as you write,
   straight to a downloadable video file.

   Deliberately VIDEO ONLY, no audio track. The app already has its own separate
   audio recorder (js/audio.js, the "● Rec" button) whose recordings stay tied to
   the notebook and drive stroke-level replay/seeking; mixing a mic into this file
   would duplicate that and make the two impossible to use independently. The two
   run happily at the same time — different APIs, no shared state.

   Everything here goes through an intermediate capture canvas rather than
   calling cv.captureStream() directly. That costs one cheap per-frame blit and
   buys three things worth having:
     - A fixed output resolution decided once at start, so resizing the window
       (or opening/closing the sidebar) mid-recording letterboxes instead of
       resizing the video track, which produces a broken/garbled file.
     - Guaranteed even pixel dimensions — H.264, which is what the mp4 path and
       iPad Safari both use, rejects or green-edges odd width/height.
     - A cap on resolution, so a high-DPR display doesn't silently produce a
       3000x2000 video nobody asked for.
   ========================================================================== */

// Longest edge of the output video. The board canvas is CW*DPR x CH*DPR, which on
// a retina/iPad display is comfortably past this — downscaling to 1080p-ish keeps
// handwriting perfectly legible at a fraction of the file size.
const VIDEO_MAX_DIM = 1920;
const VIDEO_FPS = 30;
// Target, not a floor — the encoder runs well under this on the mostly-static,
// flat-color content a notes canvas produces, and spends it only where ink moves.
const VIDEO_BITRATE = 6_000_000;
// Fills any letterbox bars when the window's aspect ratio drifts from what it was
// at record time; matches the desk color behind the page so bars read as part of
// the app rather than as black bars.
const VIDEO_LETTERBOX_BG = "#ECE9E2";

// Preference order matters: mp4/H.264 plays everywhere a teacher is likely to put
// it (Photos, PowerPoint, Google Slides, iOS share sheet) with no conversion step,
// while .webm needs VLC or a re-encode on plenty of those. Safari only ever offers
// the mp4 entries; older Chrome only ever offers the webm ones.
const VIDEO_MIME_CANDIDATES = [
  ["video/mp4;codecs=avc1.42E01E", "mp4"],
  ["video/mp4", "mp4"],
  ["video/webm;codecs=vp9", "webm"],
  ["video/webm;codecs=vp8", "webm"],
  ["video/webm", "webm"],
];

const vidrec = {
  rec: null,        // live MediaRecorder while recording, null otherwise
  stream: null,
  canvas: null,     // intermediate fixed-size capture canvas
  cctx: null,
  chunks: [],
  bytes: 0,         // running size of `chunks`, for the live status-bar readout
  startWall: 0,
  mime: "",
  ext: "webm",
  w: 0, h: 0,
  blob: null,       // finished, not-yet-saved recording (survives closing the dialog)
  url: null,
  durationMs: 0,
  lastStatusSec: -1,
};

function videoRecActive() { return !!vidrec.rec; }
function videoRecElapsedMs() { return vidrec.rec ? performance.now() - vidrec.startWall : 0; }
function videoRecPending() { return !!vidrec.blob; }

function pickVideoMime() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return null;
  for (const [mime, ext] of VIDEO_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return { mime, ext };
  }
  return null;
}

// Output dimensions, derived once at record start from the board's current backing
// store. Even numbers are a hard requirement, not a nicety — see the header note.
function videoOutputSize() {
  let w = cv.width || 1280, h = cv.height || 720;
  const scale = Math.min(1, VIDEO_MAX_DIM / Math.max(w, h));
  w = Math.max(2, Math.round(w * scale));
  h = Math.max(2, Math.round(h * scale));
  return { w: w - (w % 2), h: h - (h % 2) };
}

function fmtBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

async function toggleVideoRecord() {
  if (vidrec.rec) { stopVideoRecord(); return; }
  // A finished-but-unsaved recording is only held in memory — starting a new one
  // is the single way to lose it, so it's the one case worth confirming.
  if (vidrec.blob) {
    const ok = await confirmDialogAsync(
      "Start a new recording?",
      "Your last recording hasn't been downloaded yet. Starting a new one discards it.",
      "Discard and record",
    );
    if (!ok) return;
    releaseVideoBlob();
  }
  startVideoRecord();
}

function startVideoRecord() {
  if (vidrec.rec) return;
  if (!cv.captureStream || !window.MediaRecorder) {
    notifyDialog("Recording unavailable", "This browser can't record the canvas — it's missing MediaRecorder or canvas.captureStream.");
    return;
  }
  const picked = pickVideoMime();
  if (!picked) {
    notifyDialog("Recording unavailable", "This browser has no video format available for recording.");
    return;
  }

  const { w, h } = videoOutputSize();
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  vidrec.canvas = c;
  vidrec.cctx = c.getContext("2d");
  vidrec.w = w; vidrec.h = h;
  vidrec.mime = picked.mime; vidrec.ext = picked.ext;
  vidrec.chunks = []; vidrec.bytes = 0;
  vidrec.lastStatusSec = -1;
  pumpVideoFrame(); // seed frame 1 so the track never opens on a blank canvas

  let rec;
  try {
    vidrec.stream = c.captureStream(VIDEO_FPS);
    rec = new MediaRecorder(vidrec.stream, { mimeType: picked.mime, videoBitsPerSecond: VIDEO_BITRATE });
  } catch (err) {
    teardownVideoStream();
    notifyDialog("Recording failed to start", err.message || String(err));
    return;
  }

  rec.ondataavailable = e => {
    if (!e.data || !e.data.size) return;
    vidrec.chunks.push(e.data);
    vidrec.bytes += e.data.size;
  };
  rec.onstop = finishVideoRecord;
  vidrec.rec = rec;
  vidrec.startWall = performance.now();
  // One chunk per second rather than one giant blob at the end: keeps the live size
  // readout honest, and means a crash mid-recording loses a second, not everything.
  rec.start(1000);
  syncStatus();
}

function stopVideoRecord() {
  if (!vidrec.rec) return;
  vidrec.durationMs = videoRecElapsedMs();
  const rec = vidrec.rec;
  vidrec.rec = null; // flip the "recording" state immediately; onstop lands a tick later
  try { rec.stop(); } catch (_) { finishVideoRecord(); }
  syncStatus();
}

function teardownVideoStream() {
  if (vidrec.stream) {
    try { vidrec.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
    vidrec.stream = null;
  }
  vidrec.canvas = null;
  vidrec.cctx = null;
}

function finishVideoRecord() {
  teardownVideoStream();
  if (!vidrec.chunks.length) { syncStatus(); return; }
  releaseVideoBlob();
  vidrec.blob = new Blob(vidrec.chunks, { type: vidrec.mime });
  vidrec.url = URL.createObjectURL(vidrec.blob);
  vidrec.chunks = [];
  syncStatus();
  openVideoRecDialog();
}

function releaseVideoBlob() {
  if (vidrec.url) { try { URL.revokeObjectURL(vidrec.url); } catch (_) {} }
  vidrec.url = null;
  vidrec.blob = null;
}

/* Copies the board into the fixed-size capture canvas, letterboxed and centered.
   Called once per animation frame from frame() (js/render.js) while recording.
   Doing this every frame — rather than only when the board actually re-renders —
   is what keeps the capture canvas "changing" from the browser's point of view, so
   captureStream keeps emitting frames and the video's timeline stays in step with
   real elapsed time even through long pauses where nothing is drawn. */
function pumpVideoFrame() {
  const c = vidrec.canvas, g = vidrec.cctx;
  if (!c || !g) return;
  g.fillStyle = VIDEO_LETTERBOX_BG;
  g.fillRect(0, 0, c.width, c.height);
  if (!cv.width || !cv.height) return;
  const scale = Math.min(c.width / cv.width, c.height / cv.height);
  const dw = cv.width * scale, dh = cv.height * scale;
  g.drawImage(cv, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
}

// Driven from frame(); returns whether the status bar needs a repaint, so the
// elapsed/size readout updates once a second instead of 60 times.
function tickVideoRecord() {
  if (!vidrec.rec) return false;
  pumpVideoFrame();
  const sec = Math.floor(videoRecElapsedMs() / 1000);
  if (sec === vidrec.lastStatusSec) return false;
  vidrec.lastStatusSec = sec;
  return true;
}

function videoRecStatusText() {
  if (vidrec.rec) return `⏺ Video ${fmtT(videoRecElapsedMs())} · ${fmtBytes(vidrec.bytes)}`;
  if (vidrec.blob) return `🎥 Ready · ${fmtBytes(vidrec.blob.size)}`;
  return "";
}

/* ---------------- preview / save dialog ---------------- */
// Same lazy element-reuse wiring as promptDialog (js/dialogs.js) — no boot-time
// setup needed, handlers are (re)bound each time it opens.
function openVideoRecDialog() {
  if (!vidrec.blob) return;
  const dlg = $("videoRecDlg");
  const v = $("vrPreview");
  v.src = vidrec.url;
  $("vrMeta").textContent =
    `${fmtT(vidrec.durationMs)} · ${fmtBytes(vidrec.blob.size)} · ${vidrec.w}×${vidrec.h} · ${vidrec.ext.toUpperCase()}`;
  const stopPreview = () => { try { v.pause(); } catch (_) {} v.removeAttribute("src"); };
  $("vrDownloadBtn").onclick = () => { downloadVideoRecording(); stopPreview(); dlg.close(); };
  $("vrDiscardBtn").onclick = () => { stopPreview(); releaseVideoBlob(); dlg.close(); syncStatus(); };
  // Closing any other way (Esc) deliberately KEEPS the recording — it's only held in
  // memory, so a stray Escape silently binning a lesson would be unforgivable. The
  // status bar keeps showing "🎥 Ready", and clicking it reopens this dialog.
  dlg.showModal();
}

function videoFileBaseName() {
  let name = "InkPad";
  try {
    const nb = libNotebooks.find(n => n.id === activeNotebookId);
    if (nb && nb.name) name = nb.name;
  } catch (_) {}
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` +
    ` ${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  // Strip what Windows/macOS/iOS reject in a filename, collapse the leftovers.
  const safe = name.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 60) || "InkPad";
  return `${safe} ${stamp}`;
}

function downloadVideoRecording() {
  if (!vidrec.blob) return;
  const a = document.createElement("a");
  a.href = vidrec.url;
  a.download = `${videoFileBaseName()}.${vidrec.ext}`;
  a.click();
  // The object URL is deliberately NOT revoked here — it's still the <video>
  // preview's source, and releaseVideoBlob() owns its lifetime.
}
