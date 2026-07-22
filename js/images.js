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
      w, h, del: false,
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
let pendingPlacement = null; // { img, dataUrl, w, h, labelSpecs, srcBox }
function beginShapePlacement(svgString, labelSpecs, srcBox) {
  const dataUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgString);
  const img = new Image();
  img.onload = () => {
    // Capped at 1/4 of the page in both dimensions (never enlarged) — these are typically viewed
    // zoomed in on a fraction of the page, so a shape sized near the full page width overflows
    // that view and, without the page-bounds clamp below, can spill past the page edge entirely.
    const maxW = pageW() * 0.25, maxH = pageH() * 0.25;
    let w = img.naturalWidth, h = img.naturalHeight;
    const scale = Math.min(1, maxW / w, maxH / h);
    if (scale < 1) { w *= scale; h *= scale; }
    pendingPlacement = { img, dataUrl, w, h, labelSpecs, srcBox };
    needsDraw = true;
  };
  img.src = dataUrl;
}
function finalizePendingPlacement(x, y) {
  const p = pendingPlacement;
  if (!p) return;
  // Keep the shape fully on the page it's dropped onto instead of letting it spill past
  // whichever edge is nearest the click.
  const pageIdx = Math.max(0, Math.min(S.pages - 1, Math.floor(y / stride())));
  const dims = pageDims(pageIdx);
  const pageTop = pageIdx * stride();
  const margin = 8;
  x = Math.max(margin, Math.min(x, dims.w - p.w - margin));
  y = Math.max(pageTop + margin, Math.min(y, pageTop + dims.h - p.h - margin));
  const im = { img: p.img, data: p.dataUrl, x, y, w: p.w, h: p.h, del: false };
  doc.images.push(im);
  const items = [{ kind: "image", ref: im }];
  if (p.labelSpecs && p.labelSpecs.length) {
    const scale = p.w / p.srcBox.w;
    for (const spec of p.labelSpecs) {
      const text = String(spec.text);
      const size = Math.max(10, Math.round(spec.fontSize * scale));
      // labelSpecs.x is where the label should be visually CENTERED (it's built assuming
      // text-anchor="middle", same as the live preview's SVG overlay), but doc.texts renders
      // left-anchored like any other text object — shift left by half the estimated rendered
      // width so the centered appearance survives the switch from SVG text to canvas fillText.
      const t = {
        x: x + (spec.x - p.srcBox.x) * scale - text.length * size * 0.28, y: y + (spec.y - p.srcBox.y) * scale,
        color: "#000000", size,
        lines: [text], del: false,
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
addEventListener("paste", e => {
  const items = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith("image/"));
  if (items.length) importImageFiles(items.map(i => i.getAsFile()));
});

/* ============================================================================
   Math Shapes Importer — Mathematical SVG Generator Pipeline
   ========================================================================== */
