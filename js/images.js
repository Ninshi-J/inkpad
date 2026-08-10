"use strict";
function importImageFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    const rd = new FileReader();
    rd.onload = () => addImageFromDataURL(rd.result);
    rd.readAsDataURL(f);
  }
}
function addImageFromDataURL(data, atX, atY) {
  const img = new Image();
  img.onload = () => {
    const maxW = pageW() - 80;
    let w = img.naturalWidth, h = img.naturalHeight;
    if (w > maxW) { h = h * maxW / w; w = maxW; }
    const im = {
      img, data,
      x: atX ?? 40, y: atY ?? (V.scroll + 40),
      w, h, del: false, layer: currentLayerId(),
    };
    doc.images.push(im);
    pushUndo({ op: "add", items: [{ kind: "image", ref: im }] });
    bumpPages(im.y + im.h);
    markDirty();
  };
  img.src = data;
}
// Instead of dropping a generated shape at a fixed spot (which could land on top of existing
// content), a ghost preview follows the cursor until the user clicks the canvas to place it.
let pendingPlacement = null; // { img, dataUrl, w, h, labelSpecs, srcBox, genParams }
function beginShapePlacement(svgString, labelSpecs, srcBox, genParams, shapeType) {
  // dataUrl is the stored form — no fonts, just a note of which ones it needs. setShapeImgSrc
  // splices them in for the copy the browser actually decodes (see shape-svg.js).
  const dataUrl = SHAPE_SVG_URL_PREFIX + encodeURIComponent(svgString);
  const img = new Image();
  img.onload = () => {
    // Capped at a fraction of the page in both dimensions (never enlarged) — these are typically
    // viewed zoomed in on a fraction of the page, so a shape sized near the full page width
    // overflows that view and, without the page-bounds clamp below, can spill past the page edge
    // entirely. All three fractions are user-configurable — see shapeDefaults (shape-tools.js) /
    // the "⚙ Defaults" button in the Math Shape Importer.
    //
    // Which fraction applies is looked up from the type, NOT inferred from srcBox being absent as
    // it used to be. That test meant "is it a coordinate plane" only while the planes were the
    // one thing placed whole; every re-editable chart since (spinner, table, box plot, ...) also
    // has no srcBox, so they were all silently taking the graph figure. They need their own,
    // because they are wide and text-heavy: at the graph's 31% a box plot's scale labels landed
    // on the page at under 8px, half the size of the text around them.
    const sizeFrac = shapeSizeFracFor(shapeType, srcBox);
    const maxW = pageW() * sizeFrac, maxH = pageH() * sizeFrac;
    let w = img.naturalWidth, h = img.naturalHeight;
    const scale = Math.min(1, maxW / w, maxH / h);
    if (scale < 1) { w *= scale; h *= scale; }
    pendingPlacement = { img, dataUrl, w, h, labelSpecs, srcBox, genParams };
    needsDraw = true;
  };
  setShapeImgSrc(img, dataUrl);
}
// Keeps a w×h object fully on the page its top-left lands on, instead of letting it spill past
// whichever edge is nearest. Shared by shape placement and clipboard-image paste.
function clampObjToPage(x, y, w, h) {
  const pageIdx = pageIndexForBox(y, h);
  const dims = pageDims(pageIdx);
  const pageTop = pageIdx * stride();
  const margin = 8;
  return {
    x: Math.max(margin, Math.min(x, dims.w - w - margin)),
    y: Math.max(pageTop + margin, Math.min(y, pageTop + dims.h - h - margin)),
  };
}
function finalizePendingPlacement(x, y) {
  const p = pendingPlacement;
  if (!p) return;
  ({ x, y } = clampObjToPage(x, y, p.w, p.h));
  const im = { img: p.img, data: p.dataUrl, x, y, w: p.w, h: p.h, del: false, layer: currentLayerId() };
  // Only a graph (no srcBox — see beginShapePlacement) carries its generating params forward,
  // which is what makes it re-editable later (see editGeneratedShape in shape-tools.js).
  if (!p.srcBox && p.genParams) im.shapeGen = p.genParams;
  doc.images.push(im);
  const items = [{ kind: "image", ref: im }];
  if (p.labelSpecs && p.labelSpecs.length) {
    const scale = p.w / p.srcBox.w;
    for (const spec of p.labelSpecs) {
      const text = String(spec.text);
      const size = Math.max(10, Math.round(spec.fontSize * scale));
      // labelSpecs.x is where the label should be visually CENTERED (it's built assuming
      // text-anchor="middle", same as the live preview's SVG overlay), but doc.texts renders
      // left-anchored like any other text object — shift left by half the rendered width so the
      // centered appearance survives the switch from SVG text to canvas fillText. A character
      // count is hopeless for a formula, so ask for its real measured width when it has one.
      const half = shapeLabelMetrics(text, size, SHAPE_LABEL_CSS).w / 2;
      const t = {
        x: x + (spec.x - p.srcBox.x) * scale - half, y: y + (spec.y - p.srcBox.y) * scale,
        color: "#000000", size,
        lines: [text], del: false, layer: im.layer,
      };
      doc.texts.push(t);
      items.push({ kind: "text", ref: t });
    }
  }
  pushUndo({ op: "add", items });
  bumpPages(im.y + im.h);
  markDirty();
  pendingPlacement = null;
  needsDraw = true;
}
function drawPendingPlacement() {
  const p = pendingPlacement;
  if (!p) return;
  const dw = p.w * V.zoom, dh = p.h * V.zoom;
  const x = hover.x - dw / 2, y = hover.y - dh / 2;
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.drawImage(p.img, x, y, dw, dh);
  ctx.strokeStyle = "#0F766E"; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y, dw, dh);
  ctx.restore();
}
$("fileImg").addEventListener("change", e => { importImageFiles(e.target.files); e.target.value = ""; });
wrap.addEventListener("dragover", e => { e.preventDefault(); $("dropHint").style.display = "flex"; });
wrap.addEventListener("dragleave", () => $("dropHint").style.display = "none");
wrap.addEventListener("drop", e => {
  e.preventDefault(); $("dropHint").style.display = "none";
  const files = [...e.dataTransfer.files];
  const pdfs = files.filter(f => f.type === "application/pdf");
  if (pdfs.length) importPdfFiles(pdfs);
  importImageFiles(files.filter(f => f.type.startsWith("image/")));
});
/* ---------------- pasting from the system clipboard ----------------
   The browser's `paste` event is the single dispatcher for Ctrl/Cmd+V (the keydown handler in
   keymap-colorring.js deliberately leaves it alone — see the note there), because it's the only
   thing that reports what's really on the system clipboard right now. An image on it wins: that's
   the user copying a screenshot elsewhere and wanting it here. Anything else falls through to the
   in-app selection clipboard, which is what a Ctrl+C inside InkPad filled. */
const clipboardImageFile = e => {
  const dt = e.clipboardData;
  if (!dt) return null;
  const file = [...(dt.files || [])].find(f => f.type.startsWith("image/"));
  if (file) return file;
  const item = [...(dt.items || [])].find(i => i.kind === "file" && i.type.startsWith("image/"));
  return item ? item.getAsFile() : null;
};
// Copying a lasso selection also writes its flattened crop to the system clipboard (so it can be
// pasted into other apps — see copySelectionToClipboard), which makes pasting it straight back in
// look identical to an external image paste. The in-app clipboard holds the richer original though
// — the crop PLUS any whole strokes/text/timers selected alongside it — so it should win. The OS
// round trip re-encodes the PNG, so the bytes can't be compared; the pixel dimensions survive it
// intact, and renderShapeCrop() rasterizes at a known 2x.
function pastedImageIsOwnCrop(w, h) {
  const c = clipboard.crop;
  return !!c && w === Math.max(1, Math.ceil(c.w * 2)) && h === Math.max(1, Math.ceil(c.h * 2));
}
// Drops a pasted image centered on the pointer (or the middle of the view when the pointer is off
// canvas — the same fallback pasteFromClipboard/insertStamp use), scaled down to fit the page and
// left selected, so the natural next step is dragging or resizing it with the existing gestures.
function placePastedImage(file) {
  const rd = new FileReader();
  rd.onload = () => {
    const data = rd.result;
    const img = new Image();
    img.onload = () => {
      if (pastedImageIsOwnCrop(img.naturalWidth, img.naturalHeight)) { pasteFromClipboard(); syncUI(); return; }
      let w = img.naturalWidth, h = img.naturalHeight;
      // Unlike a file import (width-capped only), a pasted screenshot is very often taller than
      // the page as well — cap both so it can't run off the bottom of the page it lands on.
      const scale = Math.min(1, (pageW() - 80) / w, (pageH() - 80) / h);
      w *= scale; h *= scale;
      const over = hover.x >= 0 && hover.x <= CW && hover.y >= 0 && hover.y <= CH;
      const px = over ? hover.x : CW / 2, py = over ? hover.y : CH / 2;
      const at = clampObjToPage(wx(px) - w / 2, wy(py) - h / 2, w, h);
      const im = { img, data, x: at.x, y: at.y, w, h, del: false, layer: currentLayerId() };
      doc.images.push(im);
      pushUndo({ op: "add", items: [{ kind: "image", ref: im }] });
      sel.items = [{ kind: "image", ref: im }];
      sel.shape = null;
      bumpPages(im.y + im.h);
      markDirty(); needsDraw = true; mmCache.clear(); syncUI();
    };
    img.src = data;
  };
  rd.readAsDataURL(file);
}
// Menu-driven paste, for devices that can't press Ctrl/Cmd+V at all: an iPad with no hardware
// keyboard has no paste gesture on a non-editable page, so the paste event above can never fire
// there. Reads the clipboard directly instead — Safari and Chrome each gate that behind their own
// one-off permission prompt, which is exactly why this can't just replace the keyboard path.
async function pasteImageFromSystemClipboard() {
  if (!navigator.clipboard?.read) {
    notifyDialog("Can't read the clipboard",
      "This browser won't hand over the clipboard on request. Copy your image, then press Ctrl+V (Cmd+V on a Mac or iPad) with the pointer over the page.");
    return;
  }
  let contents;
  try {
    contents = await navigator.clipboard.read();
  } catch (err) {
    notifyDialog("Can't read the clipboard",
      "Permission to read the clipboard was declined or unavailable. Copy your image, then press Ctrl+V (Cmd+V on a Mac or iPad) with the pointer over the page.");
    return;
  }
  for (const item of contents) {
    const type = item.types.find(t => t.startsWith("image/"));
    if (!type) continue;
    placePastedImage(await item.getType(type)); // a Blob reads the same as a File here
    return;
  }
  notifyDialog("No image on the clipboard",
    "Copy an image somewhere first — a screenshot, or “Copy image” on a picture in your browser — then try this again.");
}

function onSystemPaste(e) {
  if (uiOwnsKeyboard()) return; // a focused text field / open dialog gets an ordinary text paste
  const file = clipboardImageFile(e);
  if (!file) { pasteFromClipboard(); syncUI(); return; }
  // Claim the event synchronously — placePastedImage decides between the image and the in-app
  // clipboard asynchronously (it needs the decoded pixel size), but either way this paste is ours.
  e.preventDefault();
  placePastedImage(file);
}
addEventListener("paste", onSystemPaste);

/* ============================================================================
   Math Shapes Importer — Mathematical SVG Generator Pipeline
   ========================================================================== */
