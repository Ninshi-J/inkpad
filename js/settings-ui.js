"use strict";
/* ============================================================================
   Unified settings/defaults dialog (#settingsDlg, app.html)
   One dialog, one category visible at a time (.settings-nav-btn / .settings-pane, matched by
   data-cat) — pen/highlighter, eraser, text, tape, timer/stopwatch, and shapes/graphs (which
   used to be its own separate #shapeDefaultsDlg, folded in here). Every category's fields are
   staged in the dialog on open and only committed to the real V/*Defaults state by the single
   Save button — Cancel just closes, discarding whatever was typed/dragged, same as the old
   shape-defaults dialog already did.
   ========================================================================== */

const SETTINGS_CATEGORIES = ["pen", "eraser", "text", "tape", "timer", "shapes"];
// Pen/eraser/text don't have their own standalone "defaults" object the way tape/timer/shapes
// do — V.widthByTool/V.eraserSizeByTool/V.textFont/V.textSize/V.colorByTool ARE both the live
// current value (per tool) and the remembered default simultaneously (same dual role
// V.textFont/V.textSize already had before this dialog existed). These fallbacks are only for
// this dialog's own "restore" button.
const PEN_DEFAULTS_FALLBACK = { penWidth: 3, hlWidth: 3, penColor: "#2a2a2a", hlColor: "#ffd53d" };
const ERASER_DEFAULTS_FALLBACK = { eraserStroke: 12, eraserPartial: 12 };
const TEXT_DEFAULTS_FALLBACK = { font: "sans", size: 20, color: "#2a2a2a" };

function populateSettingsCategory(cat) {
  if (cat === "pen") {
    $("stPenWidth").value = V.widthByTool.pen; $("stPenWidthVal").textContent = V.widthByTool.pen;
    $("stPenColor").value = /^#[0-9a-f]{6}$/i.test(V.colorByTool.pen) ? V.colorByTool.pen : PEN_DEFAULTS_FALLBACK.penColor;
    $("stHlWidth").value = V.widthByTool.hl; $("stHlWidthVal").textContent = V.widthByTool.hl;
    $("stHlColor").value = /^#[0-9a-f]{6}$/i.test(V.colorByTool.hl) ? V.colorByTool.hl : PEN_DEFAULTS_FALLBACK.hlColor;
  } else if (cat === "eraser") {
    $("stEraserStrokeSize").value = V.eraserSizeByTool.eraserStroke; $("stEraserStrokeSizeVal").textContent = V.eraserSizeByTool.eraserStroke;
    $("stEraserPartialSize").value = V.eraserSizeByTool.eraserPartial; $("stEraserPartialSizeVal").textContent = V.eraserSizeByTool.eraserPartial;
  } else if (cat === "text") {
    const sel = $("stTextFont");
    if (!sel.options.length) {
      for (const [key, def] of Object.entries(FONT_STACKS)) {
        const opt = document.createElement("option"); opt.value = key; opt.textContent = def.label; sel.appendChild(opt);
      }
    }
    sel.value = V.textFont;
    $("stTextSize").value = V.textSize; $("stTextSizeVal").textContent = V.textSize;
    $("stTextColor").value = /^#[0-9a-f]{6}$/i.test(V.colorByTool.text) ? V.colorByTool.text : TEXT_DEFAULTS_FALLBACK.color;
  } else if (cat === "tape") {
    $("stTapeW").value = tapeDefaults.w; $("stTapeWVal").textContent = tapeDefaults.w;
    $("stTapeH").value = tapeDefaults.h; $("stTapeHVal").textContent = tapeDefaults.h;
    $("stTapeColor").value = /^#[0-9a-f]{6}$/i.test(tapeDefaults.color) ? tapeDefaults.color : TAPE_DEFAULTS_FALLBACK.color;
  } else if (cat === "timer") {
    $("stTimerW").value = timerObjDefaults.w; $("stTimerWVal").textContent = timerObjDefaults.w;
    $("stTimerH").value = timerObjDefaults.h; $("stTimerHVal").textContent = timerObjDefaults.h;
    const totalSec = Math.round(timerObjDefaults.durationMs / 1000);
    $("stTimerMin").value = Math.floor(totalSec / 60);
    $("stTimerSec").value = totalSec % 60;
  } else if (cat === "shapes") {
    populateShapeDefaultsFields(); // js/shape-tools.js
  }
}

function setActiveSettingsCategory(cat) {
  document.querySelectorAll(".settings-nav-btn").forEach(b => b.classList.toggle("active", b.dataset.cat === cat));
  document.querySelectorAll(".settings-pane").forEach(p => p.classList.toggle("active", p.dataset.cat === cat));
  $("settingsDlg").dataset.activeCat = cat;
}

function openSettingsDlg(initialCategory) {
  SETTINGS_CATEGORIES.forEach(populateSettingsCategory);
  setActiveSettingsCategory(SETTINGS_CATEGORIES.includes(initialCategory) ? initialCategory : "pen");
  $("settingsDlg").showModal();
}

// The nav buttons are static markup (never rebuilt), so one delegated listener wired at load
// covers every open — no per-open rewiring needed.
document.querySelector(".settings-nav").addEventListener("click", e => {
  const b = e.target.closest(".settings-nav-btn");
  if (b) setActiveSettingsCategory(b.dataset.cat);
});

function restoreActiveSettingsCategory() {
  const cat = $("settingsDlg").dataset.activeCat || "pen";
  if (cat === "pen") {
    $("stPenWidth").value = PEN_DEFAULTS_FALLBACK.penWidth; $("stPenWidthVal").textContent = PEN_DEFAULTS_FALLBACK.penWidth;
    $("stPenColor").value = PEN_DEFAULTS_FALLBACK.penColor;
    $("stHlWidth").value = PEN_DEFAULTS_FALLBACK.hlWidth; $("stHlWidthVal").textContent = PEN_DEFAULTS_FALLBACK.hlWidth;
    $("stHlColor").value = PEN_DEFAULTS_FALLBACK.hlColor;
  } else if (cat === "eraser") {
    $("stEraserStrokeSize").value = ERASER_DEFAULTS_FALLBACK.eraserStroke; $("stEraserStrokeSizeVal").textContent = ERASER_DEFAULTS_FALLBACK.eraserStroke;
    $("stEraserPartialSize").value = ERASER_DEFAULTS_FALLBACK.eraserPartial; $("stEraserPartialSizeVal").textContent = ERASER_DEFAULTS_FALLBACK.eraserPartial;
  } else if (cat === "text") {
    $("stTextFont").value = TEXT_DEFAULTS_FALLBACK.font;
    $("stTextSize").value = TEXT_DEFAULTS_FALLBACK.size; $("stTextSizeVal").textContent = TEXT_DEFAULTS_FALLBACK.size;
    $("stTextColor").value = TEXT_DEFAULTS_FALLBACK.color;
  } else if (cat === "tape") {
    $("stTapeW").value = TAPE_DEFAULTS_FALLBACK.w; $("stTapeWVal").textContent = TAPE_DEFAULTS_FALLBACK.w;
    $("stTapeH").value = TAPE_DEFAULTS_FALLBACK.h; $("stTapeHVal").textContent = TAPE_DEFAULTS_FALLBACK.h;
    $("stTapeColor").value = TAPE_DEFAULTS_FALLBACK.color;
  } else if (cat === "timer") {
    $("stTimerW").value = TIMER_OBJ_DEFAULTS_FALLBACK.w; $("stTimerWVal").textContent = TIMER_OBJ_DEFAULTS_FALLBACK.w;
    $("stTimerH").value = TIMER_OBJ_DEFAULTS_FALLBACK.h; $("stTimerHVal").textContent = TIMER_OBJ_DEFAULTS_FALLBACK.h;
    const totalSec = Math.round(TIMER_OBJ_DEFAULTS_FALLBACK.durationMs / 1000);
    $("stTimerMin").value = Math.floor(totalSec / 60); $("stTimerSec").value = totalSec % 60;
  } else if (cat === "shapes") {
    resetShapeDefaultsFields(); // js/shape-tools.js
  }
}

function saveSettingsDlg() {
  setToolWidth("pen", Math.max(PEN_MIN_W, Math.min(PEN_MAX_W, +$("stPenWidth").value || PEN_DEFAULTS_FALLBACK.penWidth)));
  setToolDefaultColor("pen", $("stPenColor").value);
  setToolWidth("hl", Math.max(PEN_MIN_W, Math.min(PEN_MAX_W, +$("stHlWidth").value || PEN_DEFAULTS_FALLBACK.hlWidth)));
  setToolDefaultColor("hl", $("stHlColor").value);

  setEraserToolSize("eraserStroke", Math.max(4, Math.min(48, +$("stEraserStrokeSize").value || ERASER_DEFAULTS_FALLBACK.eraserStroke)));
  setEraserToolSize("eraserPartial", Math.max(4, Math.min(48, +$("stEraserPartialSize").value || ERASER_DEFAULTS_FALLBACK.eraserPartial)));

  if (FONT_STACKS[$("stTextFont").value]) V.textFont = $("stTextFont").value;
  V.textSize = Math.max(1, +$("stTextSize").value || TEXT_DEFAULTS_FALLBACK.size);
  saveTextDefaults();
  setToolDefaultColor("text", $("stTextColor").value);

  tapeDefaults = {
    w: Math.max(10, +$("stTapeW").value || TAPE_DEFAULTS_FALLBACK.w),
    h: Math.max(10, +$("stTapeH").value || TAPE_DEFAULTS_FALLBACK.h),
    color: $("stTapeColor").value,
  };
  saveTapeDefaults();

  const min = Math.max(0, parseInt($("stTimerMin").value) || 0);
  const sec = Math.max(0, Math.min(59, parseInt($("stTimerSec").value) || 0));
  timerObjDefaults = {
    w: Math.max(40, +$("stTimerW").value || TIMER_OBJ_DEFAULTS_FALLBACK.w),
    h: Math.max(10, +$("stTimerH").value || TIMER_OBJ_DEFAULTS_FALLBACK.h),
    durationMs: Math.max(1000, (min * 60 + sec) * 1000),
  };
  saveTimerObjDefaults();

  commitShapeDefaultsFromSettingsDlg(); // js/shape-tools.js

  needsDraw = true; syncUI();
  $("settingsDlg").close();
}
