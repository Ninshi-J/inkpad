"use strict";
const timer = { mode: "down", running: false, durationMs: 5 * 60000, baseMs: 0, startWall: 0, handle: null };
function fmtClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function timerElapsedMs() { return timer.running ? timer.baseMs + (performance.now() - timer.startWall) : timer.baseMs; }
function timerRemainingMs() { return Math.max(0, timer.durationMs - timerElapsedMs()); }
function playTimerChime() {
  try {
    const actx = new (window.AudioContext || window.webkitAudioContext)();
    const now = actx.currentTime;
    [0, 0.22, 0.44].forEach((t, i) => {
      const osc = actx.createOscillator(), gain = actx.createGain();
      osc.type = "sine"; osc.frequency.value = i === 2 ? 987.77 : 783.99; // G5, G5, B5 — a short two-note chime
      gain.gain.setValueAtTime(0, now + t);
      gain.gain.linearRampToValueAtTime(0.25, now + t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.35);
      osc.connect(gain); gain.connect(actx.destination);
      osc.start(now + t); osc.stop(now + t + 0.4);
    });
    setTimeout(() => actx.close(), 900);
  } catch (_) {}
}
function timerTick() {
  const disp = $("timerDisplay");
  if (timer.mode === "down") {
    const rem = timerRemainingMs();
    disp.textContent = fmtClock(rem);
    if (rem <= 0 && timer.running) {
      timer.running = false; timer.baseMs = timer.durationMs;
      clearInterval(timer.handle); timer.handle = null;
      $("timerWidget").classList.add("done");
      $("timerStartBtn").textContent = "▶ Start";
      playTimerChime();
    }
  } else {
    disp.textContent = fmtClock(timerElapsedMs());
  }
}
function timerStart() {
  if (timer.running) {
    timer.baseMs = timerElapsedMs(); timer.running = false;
    clearInterval(timer.handle); timer.handle = null;
    $("timerStartBtn").textContent = "▶ Start";
    return;
  }
  $("timerWidget").classList.remove("done");
  if (timer.mode === "down" && timer.baseMs >= timer.durationMs) timer.baseMs = 0; // restart a finished countdown
  timer.startWall = performance.now(); timer.running = true;
  timer.handle = setInterval(timerTick, 200);
  $("timerStartBtn").textContent = "⏸ Pause";
  timerTick();
}
function timerReset() {
  timer.running = false; timer.baseMs = 0;
  clearInterval(timer.handle); timer.handle = null;
  $("timerWidget").classList.remove("done");
  $("timerStartBtn").textContent = "▶ Start";
  timerTick();
}
function saveTimerPrefs() {
  try { localStorage.setItem("inkpad.timer", JSON.stringify({ mode: timer.mode, durationMs: timer.durationMs })); } catch (_) {}
  scheduleSettingsSave();
}
function loadTimerPrefs() {
  try {
    const j = JSON.parse(localStorage.getItem("inkpad.timer") || "null");
    if (j) { timer.mode = j.mode === "up" ? "up" : "down"; timer.durationMs = Math.max(1000, j.durationMs || 300000); }
  } catch (_) {}
}
function highlightTimerPreset(ms) {
  $("timerPresets").querySelectorAll("button").forEach(b => b.classList.toggle("active", +b.dataset.sec * 1000 === ms));
}
function timerSetDuration(ms) { timer.durationMs = Math.max(1000, ms); timerReset(); saveTimerPrefs(); highlightTimerPreset(timer.durationMs); }
function timerSetMode(mode) {
  timer.mode = mode; timerReset();
  $("timerWidget").querySelectorAll(".timer-mode").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  $("timerPresets").style.display = mode === "down" ? "" : "none";
  $("timerCustom").style.display = mode === "down" ? "" : "none";
  saveTimerPrefs();
}
function toggleTimerWidget() { $("timerWidget").classList.toggle("open"); }
// Generic drag-by-handle for a position:fixed floating panel — same gesture as #palette's own
// drag handling, factored out here so the timer widget (and any future floating panel) can reuse
// it without duplicating the pointer-capture bookkeeping.
function makeDraggable(handle, panel) {
  let sx0 = 0, sy0 = 0, ox = 0, oy = 0, on = false;
  handle.addEventListener("pointerdown", e => {
    if (e.target.closest("button")) return; // let the close button work instead of starting a drag
    on = true; sx0 = e.clientX; sy0 = e.clientY;
    const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", e => {
    if (!on) return;
    panel.style.left = Math.max(4, ox + e.clientX - sx0) + "px";
    panel.style.top = Math.max(4, oy + e.clientY - sy0) + "px";
    panel.style.right = "auto";
  });
  handle.addEventListener("pointerup", () => on = false);
}
function wireTimerWidget() {
  loadTimerPrefs();
  $("timerWidget").querySelectorAll(".timer-mode").forEach(b => {
    b.classList.toggle("active", b.dataset.mode === timer.mode);
    b.onclick = () => timerSetMode(b.dataset.mode);
  });
  $("timerPresets").style.display = timer.mode === "down" ? "" : "none";
  $("timerCustom").style.display = timer.mode === "down" ? "" : "none";
  $("timerPresets").querySelectorAll("button").forEach(b => { b.onclick = () => timerSetDuration(+b.dataset.sec * 1000); });
  highlightTimerPreset(timer.durationMs);
  $("timerSetBtn").onclick = () => {
    const m = Math.max(0, +$("timerMin").value || 0), s = Math.max(0, Math.min(59, +$("timerSec").value || 0));
    timerSetDuration((m * 60 + s) * 1000);
  };
  $("timerStartBtn").onclick = timerStart;
  $("timerResetBtn").onclick = timerReset;
  $("timerCloseBtn").onclick = () => $("timerWidget").classList.remove("open");
  timerTick();
  makeDraggable($("timerHandle"), $("timerWidget"));
}

/* ---------------- remappable actions ---------------- */
