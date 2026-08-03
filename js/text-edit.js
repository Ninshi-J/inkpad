"use strict";
function autoTextEditWidthPx() {
  const lines = textEdit.value.split("\n");
  measureCtx.font = `${editingText.size}px ${fontCss(editingText)}`;
  let w = 20;
  for (const ln of lines) w = Math.max(w, measureCtx.measureText(ln || " ").width);
  return Math.round(Math.min(560, Math.max(40, w + 14)) * V.zoom);
}
// World-space width still available between a text box's left edge and its own page's right
// edge — once free-flowing content would need more room than this, syncTextEditAutoWidth()
// switches the box into wrapped mode at this width instead of letting it run off the page.
function textEditMaxWidthWorld() {
  const page = Math.max(0, Math.floor(editingText.y / stride()));
  const margin = 24;
  return Math.max(60, pageDims(page).w - editingText.x - margin);
}
function syncTextEditAutoWidth() {
  if (!editingText || editingText.w) return;
  const naturalPx = autoTextEditWidthPx();
  const maxPx = Math.round(textEditMaxWidthWorld() * V.zoom);
  if (naturalPx > maxPx) {
    // Reached the page's right edge — switch into wrapped mode at that width, the same state a
    // manual resize-handle drag would leave the box in.
    editingText.w = maxPx / V.zoom;
    textEdit.classList.add("wrap");
    lastSetWidthPx = maxPx;
    textEdit.style.width = maxPx + "px";
    return;
  }
  lastSetWidthPx = naturalPx;
  textEdit.style.width = naturalPx + "px";
}
// Counting rows by raw "\n"s only tells you the number of paragraphs the user actually typed —
// once a wrap width is set, a single paragraph can soft-wrap into several displayed lines, and
// sizing the box for the paragraph count instead of the true rendered line count clips the
// wrapped lines out of view while editing (and made the box look shorter while editing than the
// box you get after committing, since drawTexts() renders every wrapped line just fine).
function textEditRowCount() {
  const paras = textEdit.value.split("\n");
  if (!editingText || !editingText.w) return paras.length;
  measureCtx.font = `${editingText.size}px ${fontCss(editingText)}`;
  let total = 0;
  for (const p of paras) total += wrapParagraph(p, editingText.w).length;
  return total;
}
function syncTextEditRows() { textEdit.rows = Math.max(1, textEditRowCount()); }
function startTextEdit(x, y, existing) {
  commitTextEdit();
  let t = existing;
  if (!t) {
    for (const q of doc.texts) {
      if (!q.del && isLayerVisible(q.layer) && textHitTest(q, x, y)) { t = q; break; }
    }
  }
  editingTextBefore = (t && !t.fresh) ? snapshotItem("text", t) : null;
  if (!t) {
    t = { x, y, color: V.colorHex, size: V.textSize, font: V.textFont, w: null, lines: [], del: false, fresh: true, layer: currentLayerId() };
    doc.texts.push(t);
  }
  editingText = t;
  textEdit.value = t.lines.join("\n");
  textEdit.style.display = "block";
  textEdit.style.left = (sx(t.x) - 5) + "px";
  textEdit.style.top = (sy(t.y) - 4) + "px";
  textEdit.style.fontFamily = fontCss(t);
  textEdit.style.fontSize = (t.size * V.zoom) + "px";
  textEdit.style.color = t.color;
  if (t.w) { textEdit.classList.add("wrap"); textEdit.style.width = (t.w * V.zoom) + "px"; lastSetWidthPx = t.w * V.zoom; }
  else { textEdit.classList.remove("wrap"); syncTextEditAutoWidth(); }
  syncTextEditRows();
  t.hidden = true;
  needsDraw = true;
  setTimeout(() => textEdit.focus(), 0);

  buildTextFmtBar();
  positionTextFmtBar();
  textResizeHandleEl.classList.add("open");
  positionTextResizeHandle();

  // Dragging the resize handle (or, as a fallback, any other way the box's width ends up
  // changing) switches this box into wrapped mode from here on, at whatever width the user
  // dropped it at — auto-sized boxes stay auto-sized until resized.
  if (textEditResizeObs) textEditResizeObs.disconnect();
  textEditResizeObs = new ResizeObserver(() => {
    if (!editingText) return;
    if (Math.abs(textEdit.offsetWidth - lastSetWidthPx) > 3) {
      textEdit.classList.add("wrap");
      editingText.w = textEdit.offsetWidth / V.zoom;
      lastSetWidthPx = textEdit.offsetWidth;
      syncTextEditRows();
    }
  });
  textEditResizeObs.observe(textEdit);
}
textEdit.addEventListener("input", () => {
  syncTextEditAutoWidth(); // may switch the box into wrapped mode, which row counting needs to see
  syncTextEditRows();
});
textEdit.addEventListener("keydown", e => {
  if (e.key === "Escape") { cancelTextEdit(); e.stopPropagation(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    // Distinct from plain Enter (which inserts a newline, needed for multi-line text) — a
    // deliberate "I'm done" shortcut so you don't have to click away or hunt for Escape (which
    // now cancels instead of committing).
    e.preventDefault();
    commitTextEdit();
    e.stopPropagation();
    return;
  }
  if (e.key === "Tab") {
    // Textareas give Tab to the browser (moves focus away) by default — inserting spaces instead
    // keeps it a useful in-box indent key, and plain spaces (not a literal tab char) render
    // identically here, on the canvas, and in PDF export instead of drifting between them.
    e.preventDefault();
    const s = textEdit.selectionStart, en = textEdit.selectionEnd;
    const val = textEdit.value;
    textEdit.value = val.slice(0, s) + "    " + val.slice(en);
    textEdit.selectionStart = textEdit.selectionEnd = s + 4;
    textEdit.dispatchEvent(new Event("input"));
    e.stopPropagation();
    return;
  }
  e.stopPropagation();
});
// Shared by commit and cancel: hides the editing chrome and returns the {t, before} pair that
// was being edited (or null if nothing was).
function closeTextEditUI() {
  if (!editingText) return null;
  const t = editingText, before = editingTextBefore;
  editingText = null; editingTextBefore = null;
  textEdit.style.display = "none";
  textEdit.classList.remove("wrap");
  if (textEditResizeObs) { textEditResizeObs.disconnect(); textEditResizeObs = null; }
  hideTextFmtBar();
  closeMathHelper();
  textResizeHandleEl.classList.remove("open");
  endTextResizeDrag();
  t.hidden = false;
  return { t, before };
}
function commitTextEdit() {
  const closed = closeTextEditUI();
  if (!closed) return;
  const { t, before } = closed;
  const lines = textEdit.value.replace(/\s+$/, "").split("\n");
  if (!lines.length || (lines.length === 1 && !lines[0])) {
    if (before) Object.assign(t, before); // discard any live formatting changes along with the content
    t.del = true;
    if (before) pushUndo({ op: "del", items: [{ kind: "text", ref: t }] });
  } else {
    t.lines = lines;
    if (t.fresh) {
      delete t.fresh;
      pushUndo({ op: "add", items: [{ kind: "text", ref: t }] });
    } else if (before) {
      const after = snapshotItem("text", t);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        pushUndo({ op: "transform", items: [{ kind: "text", ref: t, before, after }] });
      }
    }
    bumpPages(textBB(t).y1);
  }
  markDirty();
}
// Escape: discard whatever was typed/changed this session instead of saving it — reverts an
// existing box back to exactly how it was before this edit started, or removes a brand-new one
// that was never committed, rather than treating Escape the same as clicking away (which saves).
function cancelTextEdit() {
  const closed = closeTextEditUI();
  if (!closed) return;
  const { t, before } = closed;
  if (before) Object.assign(t, before);
  else t.del = true;
  markDirty(); needsDraw = true;
}

/* ---------------- text formatting toolbar ---------------- */
function applyTextFmt(patch) {
  if (!editingText) return;
  Object.assign(editingText, patch);
  // Font/size/color picked here become the default for the NEXT new text box too (persisted,
  // survives reload) — matches how the pen/highlighter already remember their last color.
  if (patch.font !== undefined) { textEdit.style.fontFamily = fontCss(editingText); V.textFont = editingText.font; saveTextDefaults(); }
  if (patch.size !== undefined) { textEdit.style.fontSize = (editingText.size * V.zoom) + "px"; V.textSize = editingText.size; saveTextDefaults(); }
  if (patch.color !== undefined) { textEdit.style.color = editingText.color; setColor(editingText.color); }
  if (patch.font !== undefined || patch.size !== undefined) { syncTextEditAutoWidth(); syncTextEditRows(); }
  needsDraw = true;
}
// Bold/italic/underline — toggled by wrapping/unwrapping "[b]"/"[i]"/"[u]" tags around the
// current selection (see splitFormatRuns in js/math-typeset.js for how these get parsed back out
// for rendering). With no selection -- including the common "textbox is still empty" case, since
// an empty box trivially has no selection either -- an empty tag pair is inserted at the cursor
// instead, so whatever gets typed next lands inside it already formatted, same idea as clicking
// Bold in a word processor before typing rather than after.
function toggleInlineFormat(tag) {
  if (!editingText) return;
  const ta = textEdit;
  const open = `[${tag}]`, close = `[/${tag}]`;
  const s = ta.selectionStart, e = ta.selectionEnd;
  if (s === e) {
    ta.value = ta.value.slice(0, s) + open + close + ta.value.slice(s);
    ta.selectionStart = ta.selectionEnd = s + open.length;
  } else {
    const before = ta.value.slice(Math.max(0, s - open.length), s);
    const after = ta.value.slice(e, e + close.length);
    if (before === open && after === close) {
      // Exactly wrapped already at this boundary -- unwrap rather than nesting another layer.
      ta.value = ta.value.slice(0, s - open.length) + ta.value.slice(s, e) + ta.value.slice(e + close.length);
      ta.selectionStart = s - open.length;
      ta.selectionEnd = e - open.length;
    } else {
      const selected = ta.value.slice(s, e);
      ta.value = ta.value.slice(0, s) + open + selected + close + ta.value.slice(e);
      ta.selectionStart = s + open.length;
      ta.selectionEnd = s + open.length + selected.length;
    }
  }
  ta.dispatchEvent(new Event("input"));
  ta.focus();
}
function buildTextFmtBar() {
  const bar = $("textFmtBar");
  bar.innerHTML = "";

  const fontSel = document.createElement("select");
  for (const [key, def] of Object.entries(FONT_STACKS)) {
    const opt = document.createElement("option");
    opt.value = key; opt.textContent = def.label;
    fontSel.appendChild(opt);
  }
  fontSel.value = editingText.font || DEFAULT_FONT_KEY;
  fontSel.title = "Font";
  fontSel.onchange = () => applyTextFmt({ font: fontSel.value });
  bar.appendChild(fontSel);

  const sep1 = document.createElement("div"); sep1.className = "tfb-sep"; bar.appendChild(sep1);

  const sizeWrap = document.createElement("div"); sizeWrap.className = "tfb-size";
  const SIZE_TITLE = "Font size — drag, type a value, scroll to nudge it, or Ctrl+Enter to finish";
  const sizeRng = document.createElement("input");
  sizeRng.type = "range"; sizeRng.min = 8; sizeRng.max = 120; sizeRng.value = editingText.size;
  sizeRng.title = SIZE_TITLE;
  const sizeNum = document.createElement("input");
  sizeNum.type = "number"; sizeNum.min = 1; sizeNum.max = 400; sizeNum.step = 1;
  sizeNum.value = editingText.size;
  sizeNum.title = SIZE_TITLE;
  const clampSize = v => Math.max(1, Math.min(400, Math.round(v)));
  // Only nudges the slider thumb — never overwrites the number box's own text. Typing "15"
  // fires an input event after the "1" too, and forcing the box to display the clamped value
  // right then (e.g. snapping a bare "1" up to some higher minimum) would stomp the "1" before
  // the "5" keystroke ever lands, making it impossible to type any value whose leading digit(s)
  // alone fall outside the allowed range.
  const syncSlider = v => { if (v >= +sizeRng.min && v <= +sizeRng.max) sizeRng.value = v; };
  sizeRng.oninput = () => { const v = clampSize(+sizeRng.value); syncSlider(v); sizeNum.value = v; applyTextFmt({ size: v }); };
  sizeNum.addEventListener("input", () => {
    const raw = sizeNum.value;
    if (raw === "" || raw === "-") return; // mid-edit (e.g. cleared it to retype) — don't commit yet
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const v = clampSize(n);
    syncSlider(v);
    applyTextFmt({ size: v });
  });
  // Leaving the box empty/invalid/out-of-range and clicking away shouldn't silently leave the
  // text mis-sized — reformat the displayed number to whatever size is actually still in effect.
  // Committing (Ctrl+Enter, or clicking away entirely) closes the box first and clears
  // editingText before this blur fires, so there may be nothing left to reformat against.
  sizeNum.addEventListener("blur", () => { if (editingText) sizeNum.value = editingText.size; });
  sizeNum.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      // Same "I'm done" shortcut as the text box itself, usable without first clicking back
      // into the text to reach it.
      e.preventDefault();
      commitTextEdit();
    }
  });
  const onSizeWheel = e => {
    if (!editingText) return;
    e.preventDefault();
    // Stop this at the toolbar — canvasWrap has its own unconditional wheel handler (pan/zoom)
    // that doesn't check e.defaultPrevented, so without this a scroll meant for the size control
    // also scrolls/zooms the page underneath it. stopPropagation() also means it never reaches the
    // bar-level "busy" listener below, so the busy flag is set right here instead.
    e.stopPropagation();
    textFmtBarBusy = true;
    clearTimeout(textFmtBarWheelTimer);
    textFmtBarWheelTimer = setTimeout(() => { textFmtBarBusy = false; }, 250);
    const v = clampSize(editingText.size + (e.deltaY < 0 ? 1 : -1));
    syncSlider(v);
    sizeNum.value = v;
    applyTextFmt({ size: v });
  };
  sizeRng.addEventListener("wheel", onSizeWheel, { passive: false });
  sizeNum.addEventListener("wheel", onSizeWheel, { passive: false });
  sizeWrap.append(sizeRng, sizeNum);
  bar.appendChild(sizeWrap);

  const sep2 = document.createElement("div"); sep2.className = "tfb-sep"; bar.appendChild(sep2);

  const fmtWrap = document.createElement("div"); fmtWrap.className = "tfb-fmt";
  [["b", "B", "Bold"], ["i", "I", "Italic"], ["u", "U", "Underline"]].forEach(([tag, label, title]) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = `tfb-fmt-${tag}`; b.textContent = label;
    b.title = `${title} — applies to the selection, or to whatever you type next if nothing's selected`;
    b.onclick = () => toggleInlineFormat(tag);
    fmtWrap.appendChild(b);
  });
  bar.appendChild(fmtWrap);

  const sep2b = document.createElement("div"); sep2b.className = "tfb-sep"; bar.appendChild(sep2b);

  const swWrap = document.createElement("div"); swWrap.className = "tfb-swatches";
  PALETTE.forEach(c => {
    const b = document.createElement("button");
    b.className = "swatch" + (c === editingText.color ? " active" : "");
    b.style.background = c;
    b.title = c;
    b.onclick = () => { applyTextFmt({ color: c }); buildTextFmtBar(); };
    swWrap.appendChild(b);
  });
  const colorInp = document.createElement("input");
  colorInp.type = "color";
  colorInp.value = /^#[0-9a-f]{6}$/i.test(editingText.color) ? editingText.color : "#2a2a2a";
  colorInp.style.cssText = "width:20px;height:20px;border:none;background:none;padding:0;cursor:pointer;";
  colorInp.title = "Custom color";
  colorInp.oninput = () => applyTextFmt({ color: colorInp.value });
  swWrap.appendChild(colorInp);
  bar.appendChild(swWrap);

  const sep3 = document.createElement("div"); sep3.className = "tfb-sep"; bar.appendChild(sep3);

  const mathBtn = document.createElement("button");
  mathBtn.className = "tfb-math"; mathBtn.type = "button"; mathBtn.textContent = "∑";
  mathBtn.title = "Insert math symbols & structures ($...$ via KaTeX)";
  mathBtn.onclick = e => toggleMathHelper(e.currentTarget);
  bar.appendChild(mathBtn);

  bar.classList.add("open");
}
function positionTextFmtBar() {
  const bar = $("textFmtBar");
  // canvasWrap clips anything outside it (overflow: hidden) — without clamping, a box near the
  // left/right edge of the screen centers the bar partway off the visible area, leaving it
  // unreachable until the box is moved or the view is zoomed out.
  const half = bar.offsetWidth / 2;
  let left = textEdit.offsetLeft + textEdit.offsetWidth / 2;
  left = Math.max(half + 4, Math.min(wrap.clientWidth - half - 4, left));
  const above = textEdit.offsetTop - 44;
  let top = above > 4 ? above : textEdit.offsetTop + textEdit.offsetHeight + 8;
  top = Math.max(4, Math.min(wrap.clientHeight - bar.offsetHeight - 4, top));
  bar.style.left = Math.round(left) + "px";
  bar.style.top = Math.round(top) + "px";
}
function hideTextFmtBar() { $("textFmtBar").classList.remove("open"); }

/* ---------------- math snippet helper ($...$ via KaTeX, see js/math-typeset.js) ---------------- */
// True when the cursor sits inside an already-open "$...$" run on its current line -- counts
// unescaped "$" from the start of that line up to the cursor, same alternating-run logic
// splitMathRuns() (math-typeset.js) uses to parse a line for rendering, so this always agrees
// with how the line will actually be interpreted.
function isCursorInsideMathRun(text, pos) {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const line = text.slice(lineStart, pos);
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && line[i + 1] === "$") { i++; continue; }
    if (line[i] === "$") count++;
  }
  return count % 2 === 1;
}
// Inserts a snippet template at the cursor (replacing any current selection). A template
// containing "$1" is a "fill this in" construct -- the selected text (if any) becomes its
// argument and the cursor lands at the very end of the finished snippet, ready to keep typing
// after it; with no selection, the cursor instead lands at $1's own position, ready to type the
// argument in. A template without "$1" is a plain symbol, inserted at/in place of the cursor/
// selection with the cursor landing right after it. Only ONE such position is ever tracked (a
// plain <textarea> has just one cursor) -- multi-argument constructs like \frac's second argument
// are left as empty {} for the user to click into themselves.
function insertMathSnippet(tpl) {
  if (!editingText) return;
  const ta = textEdit;
  const s = ta.selectionStart, e = ta.selectionEnd;
  const selected = ta.value.slice(s, e);
  let body, cursorInBody;
  const idx = tpl.indexOf("$1");
  if (idx === -1) {
    body = tpl;
    cursorInBody = body.length;
  } else if (selected) {
    body = tpl.slice(0, idx) + selected + tpl.slice(idx + 2);
    cursorInBody = body.length;
  } else {
    body = tpl.slice(0, idx) + tpl.slice(idx + 2);
    cursorInBody = idx;
  }
  // Only wrap in fresh "$...$" delimiters when not already inside a math run -- pulling up the
  // helper mid-formula (e.g. to add a fraction inside a bigger expression) should just insert the
  // raw LaTeX there, not start a nested/separate one.
  const wrap = !isCursorInsideMathRun(ta.value, s);
  const insert = wrap ? "$" + body + "$" : body;
  // Landing at the very end of `body` (nothing left inside this construct to type) lands past the
  // closing "$" too, not just inside it -- free to continue with plain text right after instead of
  // being stuck having to add more to the same formula. Landing mid-body (an empty $1 waiting to
  // be typed into) stays inside the wrap, offset by the opening "$" if one was added.
  const atEnd = cursorInBody === body.length;
  const cursorPos = s + (atEnd ? insert.length : (wrap ? 1 : 0) + cursorInBody);
  ta.value = ta.value.slice(0, s) + insert + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = cursorPos;
  ta.dispatchEvent(new Event("input"));
  closeMathHelper();
  ta.focus();
}
function toggleMathHelper(btnEl) {
  const panel = $("mathHelperPanel");
  // Bound here rather than at boot so it survives any future rebuild of the panel, and
  // because this is the only place the panel becomes reachable.
  $("mhOpenRef").onclick = () => { closeMathHelper(); openMathHelpDlg(); };
  if (panel.classList.contains("open")) { closeMathHelper(); return; }
  const r = btnEl.getBoundingClientRect();
  panel.style.left = Math.round(Math.min(r.left, innerWidth - 250)) + "px";
  panel.style.top = Math.round(r.bottom + 4) + "px";
  panel.classList.add("open");
  btnEl.classList.add("active");
  setTimeout(() => addEventListener("pointerdown", mathHelperOutside, true), 0);
}
function closeMathHelper() {
  $("mathHelperPanel").classList.remove("open");
  document.querySelectorAll("#textFmtBar .tfb-math.active").forEach(b => b.classList.remove("active"));
  removeEventListener("pointerdown", mathHelperOutside, true);
}
function mathHelperOutside(e) {
  if (!$("mathHelperPanel").contains(e.target) && !e.target.closest(".tfb-math")) closeMathHelper();
}
$("mathHelperPanel").addEventListener("click", e => {
  const b = e.target.closest("button[data-tpl]");
  if (b) insertMathSnippet(b.dataset.tpl);
});
// Set while any control inside the toolbar (currently: the size slider/number box) is being
// actively dragged or scrolled — see the frame() loop in render.js, which skips re-centering the
// bar during this window so a width-changing edit (e.g. the size slider) can't shift the bar out
// from under the very control the user is dragging. The wheel side is armed directly in
// onSizeWheel (its own stopPropagation() would otherwise keep a bar-level wheel listener from
// ever seeing the event); this listener only needs to cover pointer drags on the slider thumb.
let textFmtBarBusy = false;
let textFmtBarWheelTimer = null;
(() => {
  const bar = $("textFmtBar");
  bar.addEventListener("pointerdown", () => { textFmtBarBusy = true; });
  addEventListener("pointerup", () => { textFmtBarBusy = false; });
  addEventListener("pointercancel", () => { textFmtBarBusy = false; });
})();

/* ---------------- text box resize handle ---------------- */
function positionTextResizeHandle() {
  const h = $("textEditResizeHandle");
  h.style.left = (textEdit.offsetLeft + textEdit.offsetWidth - 2) + "px";
  h.style.top = textEdit.offsetTop + "px";
  h.style.height = textEdit.offsetHeight + "px";
}
let textResizeDrag = null;
const textResizeHandleEl = $("textEditResizeHandle");
textResizeHandleEl.addEventListener("pointerdown", e => {
  if (!editingText) return;
  e.preventDefault();
  try { textResizeHandleEl.setPointerCapture(e.pointerId); } catch (_) {}
  textResizeHandleEl.classList.add("dragging");
  textResizeDrag = { pointerId: e.pointerId, startX: e.clientX, startWidth: textEdit.offsetWidth };
  // This drag already tracks width/position itself below — the ResizeObserver exists only to
  // catch width changes from OTHER sources (e.g. re-opening an already-sized box), and leaving
  // it live during a manual drag means two independent systems can both react to the very same
  // DOM width change, each writing editingText.w/lastSetWidthPx off the back of the other's
  // write. Paused for the duration of the drag, resumed on release (see endTextResizeDrag).
  if (textEditResizeObs) textEditResizeObs.disconnect();
});
textResizeHandleEl.addEventListener("pointermove", e => {
  if (!textResizeDrag || !editingText || e.pointerId !== textResizeDrag.pointerId) return;
  const newWidth = Math.max(40, textResizeDrag.startWidth + (e.clientX - textResizeDrag.startX));
  textEdit.classList.add("wrap");
  textEdit.style.width = newWidth + "px";
  lastSetWidthPx = newWidth;
  editingText.w = newWidth / V.zoom;
  syncTextEditRows();
  positionTextResizeHandle();
  needsDraw = true;
});
function endTextResizeDrag(e) {
  if (!textResizeDrag) return;
  try { textResizeHandleEl.releasePointerCapture(textResizeDrag.pointerId); } catch (_) {}
  textResizeDrag = null;
  textResizeHandleEl.classList.remove("dragging");
  if (textEditResizeObs && editingText) textEditResizeObs.observe(textEdit);
}
textResizeHandleEl.addEventListener("pointerup", endTextResizeDrag);
textResizeHandleEl.addEventListener("pointercancel", endTextResizeDrag);

/* ============================================================================
   Audio recording + Note Replay
   ========================================================================== */
