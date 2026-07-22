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
      const b = textBB(q);
      if (!q.del && x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1) { t = q; break; }
    }
  }
  editingTextBefore = (t && !t.fresh) ? snapshotItem("text", t) : null;
  if (!t) {
    t = { x, y, color: V.colorHex, size: V.textSize, font: V.textFont, w: null, lines: [], del: false, fresh: true };
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
  const sizeRng = document.createElement("input");
  sizeRng.type = "range"; sizeRng.min = 8; sizeRng.max = 120; sizeRng.value = editingText.size;
  sizeRng.title = "Font size";
  const sizeLabel = document.createElement("span"); sizeLabel.textContent = editingText.size + "px";
  sizeRng.oninput = () => { sizeLabel.textContent = sizeRng.value + "px"; applyTextFmt({ size: +sizeRng.value }); };
  sizeWrap.append(sizeRng, sizeLabel);
  bar.appendChild(sizeWrap);

  const sep2 = document.createElement("div"); sep2.className = "tfb-sep"; bar.appendChild(sep2);

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

  bar.classList.add("open");
}
function positionTextFmtBar() {
  const bar = $("textFmtBar");
  const left = textEdit.offsetLeft + textEdit.offsetWidth / 2;
  const above = textEdit.offsetTop - 44;
  const top = above > 4 ? above : textEdit.offsetTop + textEdit.offsetHeight + 8;
  bar.style.left = Math.round(left) + "px";
  bar.style.top = Math.round(top) + "px";
}
function hideTextFmtBar() { $("textFmtBar").classList.remove("open"); }

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
}
textResizeHandleEl.addEventListener("pointerup", endTextResizeDrag);
textResizeHandleEl.addEventListener("pointercancel", endTextResizeDrag);

/* ============================================================================
   Audio recording + Note Replay
   ========================================================================== */
