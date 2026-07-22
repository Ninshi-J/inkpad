"use strict";
function recNowMs() { return audio.recBaseMs + (performance.now() - audio.recStartWall); }
function playPosMs() {
  if (!audio.playing || audio.playSeg < 0) return audio.posMs;
  return audio.segments[audio.playSeg].startMs + audio.el.currentTime * 1000;
}
async function toggleRecord() {
  if (audio.rec) { stopRecord(); return; }
  stopPlayback();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream);
    const chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      const seg = { blob, url: URL.createObjectURL(blob), startMs: audio.recBaseMs, durMs: performance.now() - audio.recStartWall };
      audio.segments.push(seg);
      audio.totalMs = seg.startMs + seg.durMs;
      stream.getTracks().forEach(t => t.stop());
      markDirty(); syncStatus();
    };
    audio.rec = rec; audio.recStream = stream;
    audio.recBaseMs = audio.totalMs;
    audio.recStartWall = performance.now();
    rec.start();
  } catch (err) {
    alert("Microphone unavailable: " + err.message);
  }
  syncStatus();
}
function stopRecord() {
  if (!audio.rec) return;
  audio.rec.stop();
  audio.rec = null;
  syncStatus();
}
function segAt(ms) {
  for (let i = audio.segments.length - 1; i >= 0; i--)
    if (ms >= audio.segments[i].startMs) return i;
  return audio.segments.length ? 0 : -1;
}
function seekAudio(ms) { audio.posMs = Math.max(0, Math.min(ms, audio.totalMs)); }
function startPlayback() {
  if (!audio.segments.length) return;
  stopRecord();
  if (audio.posMs >= audio.totalMs - 50) audio.posMs = 0;
  const i = segAt(audio.posMs);
  audio.playSeg = i;
  const seg = audio.segments[i];
  audio.el.src = seg.url;
  audio.el.currentTime = Math.max(0, (audio.posMs - seg.startMs) / 1000);
  audio.el.play();
  audio.playing = true;
  audio.el.onended = () => {
    if (audio.playSeg + 1 < audio.segments.length) {
      audio.playSeg++;
      const n = audio.segments[audio.playSeg];
      audio.el.src = n.url; audio.el.currentTime = 0; audio.el.play();
    } else { audio.posMs = audio.totalMs; stopPlayback(); }
  };
  needsDraw = true; syncStatus();
}
function stopPlayback() {
  if (!audio.playing) { syncStatus(); return; }
  audio.posMs = playPosMs();
  audio.el.pause(); audio.el.onended = null;
  audio.playing = false;
  needsDraw = true; syncStatus();
}
function togglePlayback() { audio.playing ? stopPlayback() : startPlayback(); }

/* ============================================================================
   Images — file picker, drag-drop, paste
   ========================================================================== */
