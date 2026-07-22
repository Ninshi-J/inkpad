"use strict";
const clipboard = { items: [], crop: null, pasteCount: 0 };

function cloneForClipboard(kind, ref) {
  if (kind === "stroke") return { kind, tool: ref.tool, color: ref.color, w: ref.w, pts: ref.pts.map(p => ({ ...p })) };
  if (kind === "tape") return { kind, x: ref.x, y: ref.y, w: ref.w, h: ref.h };
  if (kind === "text") return { kind, x: ref.x, y: ref.y, color: ref.color, size: ref.size, lines: ref.lines.slice() };
  return {
    kind, img: ref.img, data: ref.data, x: ref.x, y: ref.y, w: ref.w, h: ref.h,
    rot: ref.rot || 0, flipX: !!ref.flipX, flipY: !!ref.flipY,
    pdfPage: ref.pdfPage, pdfFit: ref.pdfFit, renderPxPerUnit: ref.renderPxPerUnit,
    pdfSrcId: ref.pdfSrcId, pdfPageIndex: ref.pdfPageIndex, pdfBox: ref.pdfBox, pdfWholePage: ref.pdfWholePage,
  };
}

function imageOverlapsRect(im, x0, y0, x1, y1) {
  const b = imageBBox(im); 
  return !(b.x1 < x0 || b.x0 > x1 || b.y1 < y0 || b.y0 > y1);
}

function renderShapeCrop(poly, excludeImages) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const overlapping = doc.images.filter(im => !im.del && !excludeImages.has(im) && imageOverlapsRect(im, x0, y0, x1, y1));
  if (!overlapping.length) return null;

  const scale = 2;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w * scale));
  c.height = Math.max(1, Math.ceil(h * scale));
  const cx = c.getContext("2d");
  cx.save();
  cx.beginPath();
  poly.forEach((p, i) => {
    const X = (p.x - x0) * scale, Y = (p.y - y0) * scale;
    i ? cx.lineTo(X, Y) : cx.moveTo(X, Y);
  });
  cx.closePath();
  cx.clip();
  for (const im of overlapping) {
    if (im.rot || im.flipX || im.flipY) {
      cx.save();
      cx.translate((im.x + im.w / 2 - x0) * scale, (im.y + im.h / 2 - y0) * scale);
      if (im.rot) cx.rotate(im.rot);
      cx.scale(im.flipX ? -1 : 1, im.flipY ? -1 : 1);
      cx.drawImage(im.img, -im.w * scale / 2, -im.h * scale / 2, im.w * scale, im.h * scale);
      cx.restore();
    } else {
      cx.drawImage(im.img, (im.x - x0) * scale, (im.y - y0) * scale, im.w * scale, im.h * scale);
    }
  }
  cx.restore();
  const result = { dataURL: c.toDataURL("image/png"), x0, y0, w, h };
  // If the crop touches exactly one unrotated PDF-sourced image, carry a matching sub-box of
  // that source page's own coordinates so export can embed this crop as vector content instead
  // of baking it down to the raster preview above. Uses the crop's bounding box, not its exact
  // — possibly freeform — outline, so a non-rectangular lasso vector-exports as its enclosing
  // rectangle rather than the precisely clipped shape.
  if (overlapping.length === 1) {
    const im = overlapping[0];
    if (im.pdfSrcId != null && !im.rot && !im.flipX && !im.flipY) {
      const fx0 = Math.max(0, Math.min(1, (x0 - im.x) / im.w));
      const fx1 = Math.max(0, Math.min(1, (x1 - im.x) / im.w));
      const fyTop = Math.max(0, Math.min(1, (y0 - im.y) / im.h));
      const fyBot = Math.max(0, Math.min(1, (y1 - im.y) / im.h));
      const box = im.pdfBox, boxW = box.right - box.left, boxH = box.top - box.bottom;
      result.pdfSrcId = im.pdfSrcId;
      result.pdfPageIndex = im.pdfPageIndex;
      result.pdfBox = {
        left: box.left + fx0 * boxW, right: box.left + fx1 * boxW,
        top: box.top - fyTop * boxH, bottom: box.top - fyBot * boxH,
      };
    }
  }
  return result;
}

function clearShapeFromImage(im, polyWorld) {
  const natW = im.img.naturalWidth || Math.max(1, Math.round(im.w * 2));
  const natH = im.img.naturalHeight || Math.max(1, Math.round(im.h * 2));
  const c = document.createElement("canvas");
  c.width = natW; c.height = natH;
  const cx = c.getContext("2d");
  cx.drawImage(im.img, 0, 0, natW, natH);

  const rot = im.rot || 0, cf = Math.cos(rot), sf = Math.sin(rot);
  const cxW = im.x + im.w / 2, cyW = im.y + im.h / 2;
  const toLocalPx = (wx, wy) => {
    let rx = wx - cxW, ry = wy - cyW;
    let lx = rx * cf + ry * sf, ly = -rx * sf + ry * cf;
    if (im.flipX) lx = -lx;
    if (im.flipY) ly = -ly;
    return { x: (lx / im.w + 0.5) * natW, y: (ly / im.h + 0.5) * natH };
  };

  cx.fillStyle = "#ffffff";
  cx.beginPath();
  polyWorld.forEach((p, i) => {
    const q = toLocalPx(p.x, p.y);
    i ? cx.lineTo(q.x, q.y) : cx.moveTo(q.x, q.y);
  });
  cx.closePath();
  cx.fill();
  return c.toDataURL("image/png");
}

async function clearShapeSelection() {
  if (!sel.shape) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of sel.shape) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const overlapping = doc.images.filter(im => !im.del && imageOverlapsRect(im, x0, y0, x1, y1));

  const imgChanges = [];
  for (const im of overlapping) {
    const beforeData = im.data, beforeImg = im.img;
    const afterData = clearShapeFromImage(im, sel.shape);
    const afterImg = new Image();
    await new Promise(r => { afterImg.onload = r; afterImg.src = afterData; });
    im.data = afterData; im.img = afterImg;
    imgChanges.push({ ref: im, beforeData, beforeImg, afterData, afterImg });
  }

  const delItems = sel.items.filter(it => !it.ref.del);
  delItems.forEach(it => it.ref.del = true);

  if (imgChanges.length || delItems.length) {
    pushUndo({ op: "clearShape", imgChanges, delItems });
    clearSelection();
    markDirty(); needsDraw = true;
  }
}

async function copySelectionToClipboard() {
  if (!sel.items.length && !sel.shape) return;
  const items = sel.items.map(({ kind, ref }) => cloneForClipboard(kind, ref));
  clipboard.items = items;
  clipboard.crop = null;
  clipboard.pasteCount = 0;

  if (sel.shape) {
    const wholeImages = new Set(sel.items.filter(it => it.kind === "image").map(it => it.ref));
    const crop = renderShapeCrop(sel.shape, wholeImages);
    if (crop) {
      const img = new Image();
      await new Promise(r => { img.onload = r; img.src = crop.dataURL; });
      clipboard.crop = {
        img, data: crop.dataURL, x: crop.x0, y: crop.y0, w: crop.w, h: crop.h,
        pdfSrcId: crop.pdfSrcId, pdfPageIndex: crop.pdfPageIndex, pdfBox: crop.pdfBox,
      };
    }
  }

  if (clipboard.crop && navigator.clipboard && window.ClipboardItem) {
    try {
      const blob = await (await fetch(clipboard.crop.data)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    } catch (_) {}
  }
}

function insertClipboardWithOffset(dx, dy) {
  if (!clipboard.items.length && !clipboard.crop) return;
  const added = [];
  for (const it of clipboard.items) {
    let copy;
    if (it.kind === "stroke") {
      copy = { tool: it.tool, color: it.color, w: it.w, del: false, t: null, pts: it.pts.map(p => ({ x: p.x + dx, y: p.y + dy, p: p.p })) };
      copy.bb = strokeBB(copy);
      doc.strokes.push(copy);
    } else if (it.kind === "tape") {
      copy = { x: it.x + dx, y: it.y + dy, w: it.w, h: it.h, revealed: false, del: false };
      doc.tapes.push(copy);
    } else if (it.kind === "text") {
      copy = { x: it.x + dx, y: it.y + dy, color: it.color, size: it.size, lines: it.lines.slice(), del: false };
      doc.texts.push(copy);
    } else {
      copy = {
        img: it.img, data: it.data, x: it.x + dx, y: it.y + dy, w: it.w, h: it.h, rot: it.rot, flipX: it.flipX, flipY: it.flipY, del: false, _pdfBusy: false,
        pdfPage: it.pdfPage, pdfFit: it.pdfFit, renderPxPerUnit: it.renderPxPerUnit,
        pdfSrcId: it.pdfSrcId, pdfPageIndex: it.pdfPageIndex, pdfBox: it.pdfBox, pdfWholePage: it.pdfWholePage,
      };
      doc.images.push(copy);
    }
    added.push({ kind: it.kind, ref: copy });
  }
  if (clipboard.crop) {
    const c = clipboard.crop;
    const copy = {
      img: c.img, data: c.data, x: c.x + dx, y: c.y + dy, w: c.w, h: c.h, rot: 0, flipX: false, flipY: false, del: false, _pdfBusy: false,
      pdfSrcId: c.pdfSrcId, pdfPageIndex: c.pdfPageIndex, pdfBox: c.pdfBox,
    };
    doc.images.push(copy);
    added.push({ kind: "image", ref: copy });
  }
  if (!added.length) return;
  pushUndo({ op: "add", items: added });
  sel.items = added;
  sel.shape = null;
  bumpPages(selBounds()?.y1 ?? 0);
  markDirty(); needsDraw = true;
}

function pasteFromClipboard() {
  if (!clipboard.items.length && !clipboard.crop) return;
  // Paste centered at the cursor (matching how inserted shapes land near the pointer) when the
  // mouse is actually over the canvas; otherwise fall back to the old stepped-offset behavior.
  if (hover.x >= 0 && hover.x <= CW && hover.y >= 0 && hover.y <= CH) {
    pasteClipboardAt(wx(hover.x), wy(hover.y));
  } else {
    clipboard.pasteCount++;
    const off = clipboard.pasteCount * 18;
    insertClipboardWithOffset(off, off);
  }
}

function pasteClipboardAt(x, y) {
  if (!clipboard.items.length && !clipboard.crop) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (a, b, c, d) => { x0 = Math.min(x0, a); y0 = Math.min(y0, b); x1 = Math.max(x1, c); y1 = Math.max(y1, d); };
  for (const it of clipboard.items) {
    if (it.kind === "stroke") { for (const p of it.pts) grow(p.x, p.y, p.x, p.y); }
    else grow(it.x, it.y, it.x + (it.w || 0), it.y + (it.h || 0));
  }
  if (clipboard.crop) grow(clipboard.crop.x, clipboard.crop.y, clipboard.crop.x + clipboard.crop.w, clipboard.crop.y + clipboard.crop.h);
  if (!isFinite(x0)) return;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  clipboard.pasteCount = 0; 
  insertClipboardWithOffset(x - cx, y - cy);
}

function duplicateSelection() {
  if (!sel.items.length) return;
  const added = [];
  for (const { kind, ref } of sel.items) {
    let copy;
    if (kind === "stroke") {
      copy = { ...ref, pts: ref.pts.map(p => ({ x: p.x + 20, y: p.y + 20, p: p.p })), t: null };
      copy.bb = strokeBB(copy); doc.strokes.push(copy);
    } else if (kind === "tape") { copy = { ...ref, x: ref.x + 20, y: ref.y + 20 }; doc.tapes.push(copy); }
    else if (kind === "text") { copy = { ...ref, x: ref.x + 20, y: ref.y + 20, lines: ref.lines.slice() }; doc.texts.push(copy); }
    else { copy = { ...ref, x: ref.x + 20, y: ref.y + 20, _pdfBusy: false }; doc.images.push(copy); }
    added.push({ kind, ref: copy });
  }
  pushUndo({ op: "add", items: added });
  sel.items = added;
  markDirty();
}

/* ---------------- stamp library ----------------
   Reusable snippets — a teacher selects some ink/text/images (a hand-drawn unit circle, a
   formula reference, a times table), saves it once, then drops fresh independently-editable
   copies of it onto any page later. Storage is a dedicated store ("stamps", see openIdb()) kept
   separate from per-notebook docdata — stamps are global to the library, not any one notebook —
   but it still goes through storeGetAll/storePut/storeDelete, so it follows the same
   IndexedDB-vs-connected-folder backend as folders/notebooks (see connectToFsHandle). */
let libStamps = []; // [{id, name, items, w, h, thumb, createdAt}]
async function loadStamps() {
  try { libStamps = await storeGetAll("stamps"); } catch (_) { libStamps = []; }
}
// Like cloneForClipboard, but strips the live `img` element (images keep only their dataURL) so
// the result survives IndexedDB's structured-clone storage — mirrors how serialize() persists
// images for file save/export.
function stampableClone(kind, ref) {
  if (kind === "stroke") return { kind, tool: ref.tool, color: ref.color, w: ref.w, pts: ref.pts.map(p => ({ ...p })) };
  if (kind === "tape") return { kind, x: ref.x, y: ref.y, w: ref.w, h: ref.h };
  if (kind === "text") return { kind, x: ref.x, y: ref.y, color: ref.color, size: ref.size, font: ref.font, w: ref.w, lines: ref.lines.slice() };
  return { kind, data: ref.data, x: ref.x, y: ref.y, w: ref.w, h: ref.h, rot: ref.rot || 0, flipX: !!ref.flipX, flipY: !!ref.flipY };
}
// Rasterizes an arbitrary {kind,ref} item list into a standalone thumbnail — same per-kind
// drawing as renderPageThumbnail(), but driven by a supplied item list + bounds instead of a
// page's worth of `doc` content, since a stamp isn't tied to any one page.
function renderSelectionThumbnail(items, bounds, thumbW = 220) {
  const w = Math.max(1, bounds.x1 - bounds.x0), h = Math.max(1, bounds.y1 - bounds.y0);
  const sc = thumbW / Math.max(w, h); // native aspect ratio, capped to thumbW on the long side
  const cw = Math.max(1, Math.round(w * sc)), ch = Math.max(1, Math.round(h * sc));
  const c = document.createElement("canvas");
  c.width = cw; c.height = ch;
  const tctx = c.getContext("2d");
  tctx.fillStyle = "#fff"; tctx.fillRect(0, 0, cw, ch);
  const ox = bounds.x0, oy = bounds.y0;
  for (const { kind, ref } of items) {
    if (kind !== "image" || !ref.img) continue;
    tctx.save();
    if (ref.rot || ref.flipX || ref.flipY) {
      tctx.translate((ref.x + ref.w / 2 - ox) * sc, (ref.y + ref.h / 2 - oy) * sc);
      if (ref.rot) tctx.rotate(ref.rot);
      tctx.scale(ref.flipX ? -1 : 1, ref.flipY ? -1 : 1);
      tctx.drawImage(ref.img, -ref.w * sc / 2, -ref.h * sc / 2, ref.w * sc, ref.h * sc);
    } else {
      tctx.drawImage(ref.img, (ref.x - ox) * sc, (ref.y - oy) * sc, ref.w * sc, ref.h * sc);
    }
    tctx.restore();
  }
  for (const pass of ["hl", "pen"]) {
    for (const { kind, ref } of items) {
      if (kind !== "stroke" || ref.tool !== pass || !ref.pts.length) continue;
      tctx.save();
      tctx.globalAlpha = pass === "hl" ? 0.4 : 1;
      tctx.strokeStyle = ref.color;
      tctx.lineWidth = Math.max(0.6, ref.w * sc * (pass === "hl" ? 2.4 : 1));
      tctx.lineCap = "round"; tctx.lineJoin = "round";
      tctx.beginPath();
      ref.pts.forEach((pt, i) => { const x = (pt.x - ox) * sc, y = (pt.y - oy) * sc; i ? tctx.lineTo(x, y) : tctx.moveTo(x, y); });
      tctx.stroke();
      tctx.restore();
    }
  }
  for (const { kind, ref } of items) {
    if (kind !== "tape") continue;
    tctx.fillStyle = "#FFD682";
    tctx.fillRect((ref.x - ox) * sc, (ref.y - oy) * sc, ref.w * sc, ref.h * sc);
  }
  tctx.textBaseline = "top";
  for (const { kind, ref } of items) {
    if (kind !== "text") continue;
    tctx.fillStyle = ref.color;
    tctx.font = `${Math.max(6, ref.size * sc)}px ${fontCss(ref)}`;
    wrappedLines(ref).forEach((ln, i) => tctx.fillText(ln, (ref.x - ox) * sc, (ref.y - oy + i * ref.size * 1.3) * sc));
  }
  return c.toDataURL("image/png");
}
async function saveSelectionAsStamp() {
  if (!sel.items.length) { alert("Select some ink, text, or images first, then save them as a stamp."); return; }
  const bounds = selBounds();
  const name = await promptDialog("Name this stamp", "e.g. Unit Circle", "");
  if (name == null) return;
  const stamp = {
    id: genId(), name: name.trim() || "Untitled stamp",
    items: sel.items.map(({ kind, ref }) => stampableClone(kind, ref)),
    w: bounds.x1 - bounds.x0, h: bounds.y1 - bounds.y0,
    thumb: renderSelectionThumbnail(sel.items, bounds),
    createdAt: Date.now(),
  };
  libStamps.push(stamp);
  try { await storePut("stamps", stamp); } catch (_) {}
  renderStampGrid();
}
function stampItemsBounds(items) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (a, b, c, d) => { x0 = Math.min(x0, a); y0 = Math.min(y0, b); x1 = Math.max(x1, c); y1 = Math.max(y1, d); };
  for (const it of items) {
    if (it.kind === "stroke") { for (const p of it.pts) grow(p.x, p.y, p.x, p.y); }
    else grow(it.x, it.y, it.x + (it.w || 0), it.y + (it.h || 0));
  }
  return isFinite(x0) ? { x0, y0, x1, y1 } : null;
}
// Rebuilds a stamp's saved items into live doc.* objects offset by (dx,dy) — the insertion
// counterpart to stampableClone(), reconstructing a fresh Image() per image item since only its
// dataURL survived storage.
function instantiateStampItems(items, dx, dy) {
  const added = [];
  for (const it of items) {
    let copy;
    if (it.kind === "stroke") {
      copy = { tool: it.tool, color: it.color, w: it.w, del: false, t: null, pts: it.pts.map(p => ({ x: p.x + dx, y: p.y + dy, p: p.p })) };
      copy.bb = strokeBB(copy); doc.strokes.push(copy);
    } else if (it.kind === "tape") {
      copy = { x: it.x + dx, y: it.y + dy, w: it.w, h: it.h, revealed: false, del: false };
      doc.tapes.push(copy);
    } else if (it.kind === "text") {
      copy = { x: it.x + dx, y: it.y + dy, color: it.color, size: it.size, font: it.font, w: it.w, lines: it.lines.slice(), del: false };
      doc.texts.push(copy);
    } else {
      const img = new Image();
      img.onload = () => { needsDraw = true; mmCache.clear(); };
      img.src = it.data;
      copy = { img, data: it.data, x: it.x + dx, y: it.y + dy, w: it.w, h: it.h, rot: it.rot || 0, flipX: !!it.flipX, flipY: !!it.flipY, del: false, _pdfBusy: false };
      doc.images.push(copy);
    }
    added.push({ kind: it.kind, ref: copy });
  }
  return added;
}
function insertStampAt(stamp, x, y) {
  const b = stampItemsBounds(stamp.items);
  if (!b) return;
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const added = instantiateStampItems(stamp.items, x - cx, y - cy);
  if (!added.length) return;
  pushUndo({ op: "add", items: added });
  sel.items = added; sel.shape = null;
  bumpPages(selBounds()?.y1 ?? 0);
  markDirty(); needsDraw = true;
}
// Drops the stamp under the cursor if it's over the canvas, otherwise centered in the current
// viewport — same fallback pasteFromClipboard() uses. Landing selected (not placed-and-done)
// means the natural next step is dragging it into its exact spot with the existing move gesture.
function insertStamp(stamp) {
  const over = hover.x >= 0 && hover.x <= CW && hover.y >= 0 && hover.y <= CH;
  const px = over ? hover.x : CW / 2, py = over ? hover.y : CH / 2;
  insertStampAt(stamp, wx(px), wy(py));
}
async function renameStamp(stamp) {
  const name = await promptDialog("Rename stamp", "Name", stamp.name);
  if (name == null) return;
  stamp.name = name.trim() || stamp.name;
  try { await storePut("stamps", stamp); } catch (_) {}
  renderStampGrid();
}
function deleteStamp(stamp) {
  confirmDialog(`Delete "${stamp.name}"?`, "This removes it from your stamp library. Copies already inserted on your pages are unaffected.", async () => {
    libStamps = libStamps.filter(s => s.id !== stamp.id);
    try { await storeDelete("stamps", stamp.id); } catch (_) {}
    renderStampGrid();
  });
}
function renderStampGrid() {
  const grid = $("stampGrid");
  if (!grid) return;
  grid.innerHTML = "";
  if (!libStamps.length) {
    grid.innerHTML = `<div class="lib-empty">No stamps yet — select ink, text, or images on the page, then "Save selection as stamp".</div>`;
    return;
  }
  for (const st of libStamps.slice().sort((a, b) => b.createdAt - a.createdAt)) {
    const cell = document.createElement("div");
    cell.className = "stamp-thumb";
    cell.title = `Insert "${st.name}"`;
    cell.innerHTML =
      `<img src="${st.thumb}" draggable="false">` +
      `<div class="stamp-label">${escapeXml(st.name)}</div>` +
      `<div class="stamp-actions">` +
      `<button type="button" data-act="rename" title="Rename">✎</button>` +
      `<button type="button" data-act="delete" title="Delete">🗑</button>` +
      `</div>`;
    cell.addEventListener("click", e => { if (!e.target.closest(".stamp-actions")) insertStamp(st); });
    cell.querySelector('[data-act=rename]').onclick = e => { e.stopPropagation(); renameStamp(st); };
    cell.querySelector('[data-act=delete]').onclick = e => { e.stopPropagation(); deleteStamp(st); };
    grid.appendChild(cell);
  }
}
function openStampDlg() { renderStampGrid(); $("stampDlg").showModal(); }
function wireStampDlg() { $("saveStampBtn").onclick = saveSelectionAsStamp; }

/* ---------------- text tool ---------------- */
let editingText = null;
let editingTextBefore = null; // pre-edit snapshot of existing (non-fresh) text, for undo
let textEditResizeObs = null;
let lastSetWidthPx = 0; // width we last set ourselves, so the resize observer can tell a real
                         // user drag (offsetWidth diverges from this) from our own reflow after
                         // a font/size/content change (textareas have no native "auto width").
// A plain <textarea> doesn't shrink/grow its width to fit typed content — its unset width is a
// fixed column count that itself scales with font size, so leaving it "auto" would make e.g. a
// font-size change look exactly like a manual drag-resize. Measuring content width ourselves and
// setting it explicitly (while not in wrap mode) gives real auto-sizing and a stable baseline to
// diff a genuine resize-handle drag against.
