"use strict";
/* ============================================================================
   Canvas video recording — a screen-recording of just the drawing surface.

   Records exactly what the board canvas shows (so whatever you're zoomed in on
   fills the frame — no browser chrome, toolbar, or sidebar), live as you write,
   straight to a downloadable video file.

   The microphone is captured too, but into a SEPARATE file — the video track itself
   carries no audio. That split is deliberate and requested: a standalone audio file
   feeds straight into transcription software, whereas pulling speech back out of a
   video means demuxing it first. Both recorders start off the same click and stop
   together, so the two files share a timeline and line up when recombined.

   Distinct from the "● Rec" button (js/audio.js), which records notebook audio:
   segmented, timestamped against individual strokes, replayable and seekable inside
   the app, saved with the notebook. This is a plain single-take mic capture that
   exists only to accompany the video, and shares none of that machinery — both can
   run at once without interfering.

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

// Same list, but with an audio codec alongside the video one — used only when the mic is being
// muxed INTO the video file. A video-only MIME can't carry an audio track, so the two lists
// can't be merged: asking for "video/webm;codecs=vp9" with an audio track attached silently
// produces a file some players won't read.
const VIDEO_AV_MIME_CANDIDATES = [
  ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "mp4"],
  ["video/mp4", "mp4"],
  ["video/webm;codecs=vp9,opus", "webm"],
  ["video/webm;codecs=vp8,opus", "webm"],
  ["video/webm", "webm"],
];

/* Where the microphone ends up is a setting, because the two useful answers pull in opposite
   directions. A standalone audio file drops straight into transcription software, where a video
   would have to be demuxed first — that's why the original build always split them. But a video
   with no sound is useless to hand to a student, so "embedded" has to be available too, and
   "both" gets one shareable file plus one transcribable one out of a single take.

   Whatever the mode, there is exactly ONE microphone capture: the embedded track is a clone of
   the same MediaStreamTrack the separate file records, so the two can never drift apart, and
   only one permission prompt ever appears.

   Note none of this is the "● Rec" button (js/audio.js). That records notebook audio: segmented,
   timestamped against individual strokes, replayable and seekable inside the app, saved with the
   notebook. This is a plain single-take mic capture that exists only to accompany the video, and
   deliberately shares none of that machinery — the two can run at once without interfering. */
const VIDEO_AUDIO_MODES = ["separate", "embed", "both", "none"];
const VIDEO_AUDIO_MODE_KEY = "inkpad.videoAudioMode";
let videoAudioMode = "separate";
function loadVideoAudioMode() {
  try {
    const v = localStorage.getItem(VIDEO_AUDIO_MODE_KEY);
    if (VIDEO_AUDIO_MODES.includes(v)) videoAudioMode = v;
  } catch (_) {}
}
function saveVideoAudioMode() {
  try { localStorage.setItem(VIDEO_AUDIO_MODE_KEY, videoAudioMode); } catch (_) {}
  scheduleSettingsSave();
}
function setVideoAudioMode(mode) {
  if (!VIDEO_AUDIO_MODES.includes(mode)) return;
  videoAudioMode = mode;
  saveVideoAudioMode();
}
const videoAudioWantsMic = () => videoAudioMode !== "none";
const videoAudioWantsEmbed = () => videoAudioMode === "embed" || videoAudioMode === "both";
const videoAudioWantsFile = () => videoAudioMode === "separate" || videoAudioMode === "both";
loadVideoAudioMode();

/* Format preference mirrors the video list: m4a/AAC first (what iPad Safari offers,
   and accepted by essentially every transcription service), then Opus in webm/ogg. */
const AUDIO_MIME_CANDIDATES = [
  ["audio/mp4;codecs=mp4a.40.2", "m4a"],
  ["audio/mp4", "m4a"],
  ["audio/webm;codecs=opus", "webm"],
  ["audio/webm", "webm"],
  ["audio/ogg;codecs=opus", "ogg"],
];
const AUDIO_BITRATE = 128000; // ample for speech; keeps a long lesson's file small

const vidrec = {
  rec: null,        // live video MediaRecorder while recording, null otherwise
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

  audioRec: null,
  audioStream: null,
  audioChunks: [],
  audioBytes: 0,
  audioMime: "",
  audioExt: "",
  audioBlob: null,
  audioUrl: null,
  audioNote: "",    // why there's no audio file, when there isn't one
  embedded: false,  // was the mic muxed into the video track this take?
  baseName: "",     // shared filename stem for the video/audio pair, fixed at record start

  // Both recorders must have delivered their final data before the dialog can open,
  // and they stop independently — this counts down the outstanding onstop callbacks.
  pendingStops: 0,
};

function videoRecActive() { return !!vidrec.rec; }
function videoRecElapsedMs() { return vidrec.rec ? performance.now() - vidrec.startWall : 0; }
function videoRecPending() { return !!vidrec.blob || !!vidrec.audioBlob; }

function pickMime(candidates) {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return null;
  for (const [mime, ext] of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return { mime, ext };
  }
  return null;
}
function pickVideoMime() { return pickMime(VIDEO_MIME_CANDIDATES); }
function pickAudioMime() { return pickMime(AUDIO_MIME_CANDIDATES); }

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
  if (videoRecPending()) {
    const ok = await confirmDialogAsync(
      "Start a new recording?",
      "Your last recording hasn't been downloaded yet. Starting a new one discards it.",
      "Discard and record",
    );
    if (!ok) return;
    releaseVideoBlob();
  }
  await startVideoRecord();
}

// Opens the microphone. Resolves to null (never throws) if there's no mic or permission is
// refused — neither of which should stop the canvas itself from being recorded. Sets audioNote
// with the reason so the save dialog can explain a silent recording rather than just showing one.
async function acquireMicStream() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    vidrec.audioNote = "This browser doesn't allow microphone access here.";
    return null;
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    vidrec.audioNote = err && err.name === "NotAllowedError"
      ? "Microphone access was blocked, so no audio was recorded."
      : `Microphone unavailable, so no audio was recorded. (${err && err.message ? err.message : err})`;
    return null;
  }
}

// Builds the recorder for the SEPARATE audio file, WITHOUT starting it. Returns null (with a note)
// if this browser can't encode standalone audio — the embedded track, if any, is unaffected.
function createAudioFileRecorder(stream) {
  const picked = pickAudioMime();
  if (!picked) { vidrec.audioNote = "This browser has no audio format available for a separate file."; return null; }
  try {
    const rec = new MediaRecorder(stream, { mimeType: picked.mime, audioBitsPerSecond: AUDIO_BITRATE });
    vidrec.audioMime = picked.mime;
    vidrec.audioExt = picked.ext;
    vidrec.audioChunks = [];
    vidrec.audioBytes = 0;
    rec.ondataavailable = e => {
      if (!e.data || !e.data.size) return;
      vidrec.audioChunks.push(e.data);
      vidrec.audioBytes += e.data.size;
    };
    rec.onstop = () => settleRecorderStop();
    return rec;
  } catch (err) {
    vidrec.audioNote = `Couldn't start the audio recorder. (${err && err.message ? err.message : err})`;
    return null;
  }
}

async function startVideoRecord() {
  if (vidrec.rec) return;
  if (!cv.captureStream || !window.MediaRecorder) {
    notifyDialog("Recording unavailable", "This browser can't record the canvas — it's missing MediaRecorder or canvas.captureStream.");
    return;
  }
  // Mic permission is resolved BEFORE either recorder starts. Doing it the other way
  // round would let the permission prompt — which can sit there for seconds — run while
  // the video was already rolling, and the two files would no longer share a start.
  vidrec.audioNote = "";
  vidrec.embedded = false; // cleared up front so an aborted start can't leave last take's value
  const micStream = videoAudioWantsMic() ? await acquireMicStream() : null;
  vidrec.audioStream = micStream;

  // Embedding needs a container that can actually carry both tracks; if this browser has no such
  // format, fall back to a silent video rather than refusing to record, and say so. In "embed"
  // mode that fallback would otherwise lose the audio entirely, so it forces the separate file on.
  let embed = videoAudioWantsEmbed() && !!micStream;
  let picked = embed ? pickMime(VIDEO_AV_MIME_CANDIDATES) : pickVideoMime();
  let forceAudioFile = false;
  if (embed && !picked) {
    embed = false;
    forceAudioFile = true;
    picked = pickVideoMime();
    vidrec.audioNote = "This browser can't put audio inside the video file, so it was saved separately instead.";
  }
  if (!picked) {
    teardownAudioStream();
    notifyDialog("Recording unavailable", "This browser has no video format available for recording.");
    return;
  }
  const audioRec = micStream && (videoAudioWantsFile() || forceAudioFile) ? createAudioFileRecorder(micStream) : null;
  vidrec.embedded = embed;

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
    if (embed) {
      // A CLONE, not the original track: the separate-file recorder may be reading the same mic
      // at the same time, and giving two MediaRecorders the identical track object is the kind of
      // thing browsers disagree about. Cloning costs nothing (same underlying source, so the two
      // stay sample-for-sample aligned) and teardownVideoStream already stops every track it
      // finds on this stream, so the clone can't outlive the recording.
      for (const t of vidrec.audioStream.getAudioTracks()) vidrec.stream.addTrack(t.clone());
    }
    rec = new MediaRecorder(vidrec.stream, embed
      ? { mimeType: picked.mime, videoBitsPerSecond: VIDEO_BITRATE, audioBitsPerSecond: AUDIO_BITRATE }
      : { mimeType: picked.mime, videoBitsPerSecond: VIDEO_BITRATE });
  } catch (err) {
    teardownVideoStream();
    teardownAudioStream();
    notifyDialog("Recording failed to start", err.message || String(err));
    return;
  }

  rec.ondataavailable = e => {
    if (!e.data || !e.data.size) return;
    vidrec.chunks.push(e.data);
    vidrec.bytes += e.data.size;
  };
  rec.onstop = () => settleRecorderStop();
  vidrec.rec = rec;
  vidrec.audioRec = audioRec;
  vidrec.pendingStops = audioRec ? 2 : 1;
  vidrec.baseName = videoFileBaseName();
  vidrec.startWall = performance.now();
  // One chunk per second rather than one giant blob at the end: keeps the live size
  // readout honest, and means a crash mid-recording loses a second, not everything.
  // Started back to back with nothing awaited between them, so both files begin at
  // effectively the same instant and stay aligned.
  rec.start(1000);
  if (audioRec) { try { audioRec.start(1000); } catch (_) { vidrec.audioRec = null; vidrec.pendingStops = 1; } }
  syncStatus();
}

function stopVideoRecord() {
  if (!vidrec.rec) return;
  vidrec.durationMs = videoRecElapsedMs();
  const rec = vidrec.rec, arec = vidrec.audioRec;
  vidrec.rec = null; // flip the "recording" state immediately; onstop lands a tick later
  vidrec.audioRec = null;
  try { rec.stop(); } catch (_) { settleRecorderStop(); }
  if (arec) { try { arec.stop(); } catch (_) { settleRecorderStop(); } }
  syncStatus();
}

// Each recorder calls this once it has handed over its last chunk; the dialog only
// opens after every outstanding one has, so it never shows a half-finished pair.
function settleRecorderStop() {
  if (vidrec.pendingStops > 0) vidrec.pendingStops--;
  if (vidrec.pendingStops > 0) return;
  finishVideoRecord();
}

function teardownVideoStream() {
  if (vidrec.stream) {
    try { vidrec.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
    vidrec.stream = null;
  }
  vidrec.canvas = null;
  vidrec.cctx = null;
}

// Releasing the mic tracks is what turns off the browser/OS "this tab is using your
// microphone" indicator — leaving them live would look like the app kept listening.
function teardownAudioStream() {
  if (vidrec.audioStream) {
    try { vidrec.audioStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    vidrec.audioStream = null;
  }
}

function finishVideoRecord() {
  teardownVideoStream();
  teardownAudioStream();
  releaseVideoBlob();
  if (vidrec.chunks.length) {
    vidrec.blob = new Blob(vidrec.chunks, { type: vidrec.mime });
    vidrec.url = URL.createObjectURL(vidrec.blob);
  }
  if (vidrec.audioChunks.length) {
    vidrec.audioBlob = new Blob(vidrec.audioChunks, { type: vidrec.audioMime });
    vidrec.audioUrl = URL.createObjectURL(vidrec.audioBlob);
  }
  vidrec.chunks = [];
  vidrec.audioChunks = [];
  syncStatus();
  if (videoRecPending()) openVideoRecDialog();
}

function releaseVideoBlob() {
  if (vidrec.url) { try { URL.revokeObjectURL(vidrec.url); } catch (_) {} }
  if (vidrec.audioUrl) { try { URL.revokeObjectURL(vidrec.audioUrl); } catch (_) {} }
  vidrec.url = null;
  vidrec.blob = null;
  vidrec.audioUrl = null;
  vidrec.audioBlob = null;
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
  if (vidrec.rec) {
    const mic = (vidrec.audioRec || vidrec.embedded) ? " 🎙" : "";
    return `⏺ Video${mic} ${fmtT(videoRecElapsedMs())} · ${fmtBytes(vidrec.bytes + vidrec.audioBytes)}`;
  }
  if (videoRecPending()) {
    const total = (vidrec.blob ? vidrec.blob.size : 0) + (vidrec.audioBlob ? vidrec.audioBlob.size : 0);
    return `🎥 Ready · ${fmtBytes(total)}`;
  }
  return "";
}

// MediaRecorder holds every chunk in memory until stop, so a long recording is real
// pressure on the tab — and on an iPad, hitting the limit kills the tab and the whole
// recording with it. Past this the readout goes amber: the size is already on screen,
// but a number ticking upward means nothing without a point where it starts to matter.
const VIDEO_SIZE_WARN_BYTES = 500 * 1024 * 1024;
function videoRecStatusLevel() {
  if (!vidrec.rec) return "";
  return vidrec.bytes + vidrec.audioBytes > VIDEO_SIZE_WARN_BYTES ? "warn" : "live";
}
function videoRecStatusTitle() {
  if (videoRecStatusLevel() === "warn") return "This recording is getting large — consider stopping and saving it, then starting a new one.";
  if (videoRecPending()) return "Click to reopen the last recording";
  return "";
}

/* ---------------- preview / save dialog ---------------- */
// Same lazy element-reuse wiring as promptDialog (js/dialogs.js) — no boot-time
// setup needed, handlers are (re)bound each time it opens.
function openVideoRecDialog() {
  if (!videoRecPending()) return;
  const dlg = $("videoRecDlg");
  const v = $("vrPreview");
  const a = $("vrAudioPreview");

  const hasVideo = !!vidrec.blob, hasAudio = !!vidrec.audioBlob;
  $("vrVideoRow").style.display = hasVideo ? "" : "none";
  if (hasVideo) {
    v.src = vidrec.url;
    $("vrMeta").textContent =
      `${fmtT(vidrec.durationMs)} · ${fmtBytes(vidrec.blob.size)} · ${vidrec.w}×${vidrec.h} · ${vidrec.ext.toUpperCase()}` +
      (vidrec.embedded ? " · sound included" : "");
  }
  $("vrAudioRow").style.display = hasAudio ? "" : "none";
  if (hasAudio) {
    a.src = vidrec.audioUrl;
    $("vrAudioMeta").textContent =
      `Separate audio track · ${fmtBytes(vidrec.audioBlob.size)} · ${vidrec.audioExt.toUpperCase()} — ` +
      (vidrec.embedded ? "the same audio that's in the video, on its own for transcription"
                       : "starts at the same moment as the video");
  }
  // Only surfaced when audio was expected but didn't happen (or didn't land where it was meant
  // to); silent when the recording came out exactly as configured.
  const note = $("vrNote");
  const audioMissing = !hasAudio && !vidrec.embedded && videoAudioWantsMic();
  note.textContent = (audioMissing || vidrec.audioNote) ? (vidrec.audioNote || "") : "";
  note.style.display = note.textContent ? "" : "none";

  const stopPreview = () => {
    try { v.pause(); } catch (_) {} v.removeAttribute("src");
    try { a.pause(); } catch (_) {} a.removeAttribute("src");
  };
  const dlBtn = $("vrDownloadBtn");
  dlBtn.textContent = hasVideo && hasAudio ? "⬇ Download both" : hasAudio ? "⬇ Download audio" : "⬇ Download video";
  dlBtn.onclick = async () => { await downloadVideoRecording(); stopPreview(); dlg.close(); };
  const audioBtn = $("vrDownloadAudioBtn");
  audioBtn.style.display = hasVideo && hasAudio ? "" : "none";
  audioBtn.onclick = () => downloadBlobAs(vidrec.audioUrl, `${videoChosenBaseName()}.${vidrec.audioExt}`);
  // Pre-filled with the auto-generated name, editable before saving. Both files always take the
  // same stem, so a renamed pair still reads as a pair.
  const nameEl = $("vrFileName");
  nameEl.value = vidrec.baseName || videoFileBaseName();
  nameEl.oninput = updateVideoFileNamePreview;
  updateVideoFileNamePreview();
  $("vrIntro").textContent = vidrec.embedded && hasAudio
    ? "The microphone is inside the video and saved as its own file as well, so you can hand over one file and still send the audio to transcription software."
    : vidrec.embedded
      ? "The microphone is mixed into the video, so it plays with sound as a single file."
      : hasAudio
        ? "The microphone is saved as its own file rather than mixed into the video, so it can go straight into transcription software. Both start together, so they stay in sync."
        : "Recorded without sound. Change this under Settings → Video Recording.";
  $("vrDiscardBtn").onclick = () => { stopPreview(); releaseVideoBlob(); dlg.close(); syncStatus(); };
  // Closing any other way (Esc) deliberately KEEPS the recording — it's only held in
  // memory, so a stray Escape silently binning a lesson would be unforgivable. The
  // status bar keeps showing "🎥 Ready", and clicking it reopens this dialog.
  dlg.showModal();
}

// Captured once, when recording starts, and shared by both files — so the video and its
// audio always land as an obviously-matching pair, and the timestamp is when the lesson
// was actually recorded rather than whenever the download button happened to be pressed.
// Only the STARTING point for the name: the save dialog's field takes over from here.
function videoFileBaseName() {
  let name = "InkPad";
  try {
    const nb = libNotebooks.find(n => n.id === activeNotebookId);
    if (nb && nb.name) name = nb.name;
  } catch (_) {}
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` +
    ` ${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  return `${safeFileStem(name) || "InkPad"} ${stamp}`;
}

// What the user actually typed in the save dialog, cleaned up. Falls back to the generated name
// rather than letting an empty (or all-punctuation) field produce a file called ".mp4".
function videoChosenBaseName() {
  const el = $("vrFileName");
  const typed = el ? safeFileStem(el.value) : "";
  return typed || vidrec.baseName || videoFileBaseName();
}
function updateVideoFileNamePreview() {
  const base = videoChosenBaseName();
  const names = [];
  if (vidrec.blob) names.push(`${base}.${vidrec.ext}`);
  if (vidrec.audioBlob) names.push(`${base}.${vidrec.audioExt}`);
  $("vrFileNamePreview").textContent = names.length ? "Saves as " + names.join("  +  ") : "";
}

function downloadBlobAs(url, filename) {
  if (!url) return;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Object URLs are deliberately NOT revoked here — they're still the preview
  // elements' sources, and releaseVideoBlob() owns their lifetime.
}

async function downloadVideoRecording() {
  const base = videoChosenBaseName();
  if (vidrec.blob) downloadBlobAs(vidrec.url, `${base}.${vidrec.ext}`);
  if (vidrec.audioBlob) {
    // Staggered, same as the multi-page SVG export: Chrome's "allow multiple
    // downloads?" permission prompt only appears once, and firing two saves in the
    // same tick lets it swallow the second.
    if (vidrec.blob) await new Promise(res => setTimeout(res, 250));
    downloadBlobAs(vidrec.audioUrl, `${base}.${vidrec.audioExt}`);
  }
}
