"use strict";
const sel = { items: [], box: null, shape: null }; // items: {kind, ref}; shape: last traced lasso/rect polygon (world coords), kept for Copy
function clearSelection() { if (sel.items.length) { sel.items = []; sel.box = null; sel.shape = null; needsDraw = true; } }
function selBounds() {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const { kind, ref } of sel.items) {
    let b;
    if (kind === "stroke") b = ref.bb;
    else if (kind === "text") b = textBB(ref);
    else if (kind === "image") b = imageBBox(ref);
    else b = { x0: ref.x, y0: ref.y, x1: ref.x + ref.w, y1: ref.y + ref.h };
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0);
    x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
  }
  return sel.items.length ? { x0, y0, x1, y1 } : null;
}
function textBB(t) {
  const lines = wrappedLines(t);
  measureCtx.font = `${t.size}px ${fontCss(t)}`;
  let wMax = 1;
  for (const ln of lines) wMax = Math.max(wMax, measureCtx.measureText(ln).width);
  if (t.w) wMax = Math.min(wMax, t.w);
  return { x0: t.x - 3, y0: t.y - 3, x1: t.x + wMax + 6, y1: t.y + lines.length * t.size * 1.3 + 4 };
}

/* ============================================================================
   Rendering — antialiased variable-width ink on a high-DPI canvas
   ========================================================================== */
function render() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, CW, CH);
  drawPages();

  ctx.save();
  drawImages();
  drawStrokes("hl");
  drawStrokes("pen");
  drawTexts();
  drawTapes();
  ctx.restore();

  drawSelection();
  drawLive();
  drawLaser();
  drawEraserCursor();
  drawPendingPlacement();
  drawMinimap();
  updateScrollbars();
}

function pageScreenRect(p) {
  const d = pageDims(p);
  return { x: viewX(), y: sy(p * stride()), w: d.w * V.zoom, h: d.h * V.zoom };
}
function visiblePages() {
  const first = Math.max(0, Math.floor(V.scroll / stride()));
  const last = Math.min(S.pages - 1, Math.floor((V.scroll + CH / V.zoom) / stride()));
  return [first, last];
}

function drawPages() {
  const [first, last] = visiblePages();
  for (let p = first; p <= last; p++) {
    const r = pageScreenRect(p);
    ctx.save();
    ctx.shadowColor = "rgba(60,55,45,.16)";
    ctx.shadowBlur = 12 * Math.min(1, V.zoom);
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.restore();

    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    const z = V.zoom;
    const pStyle = pageStyle(p);
    if (pStyle.template === "ruled") {
      ctx.strokeStyle = "#D9E4F0"; ctx.lineWidth = 1;
      const step = pStyle.ruleSp * z;
      for (let y = r.y + step * 2; y < r.y + r.h; y += step) line(r.x, y, r.x + r.w, y);
      ctx.strokeStyle = "#F2C4C4";
      line(r.x + 72 * z, r.y, r.x + 72 * z, r.y + r.h);
    } else if (pStyle.template === "grid") {
      ctx.strokeStyle = "#E2EAF2"; ctx.lineWidth = 1;
      const step = pStyle.gridSp * z;
      for (let y = r.y + step; y < r.y + r.h; y += step) line(r.x, y, r.x + r.w, y);
      for (let x = r.x + step; x < r.x + r.w; x += step) line(x, r.y, x, r.y + r.h);
    } else if (pStyle.template === "dotted") {
      ctx.fillStyle = "#C6D0DC";
      const step = pStyle.gridSp * z, dr = Math.max(0.8, 1.1 * z);
      for (let y = r.y + step; y < r.y + r.h; y += step)
        for (let x = r.x + step; x < r.x + r.w; x += step) {
          ctx.beginPath(); ctx.arc(x, y, dr, 0, 7); ctx.fill();
        }
    }
    ctx.restore();

    if (pStyle.outline) {
      ctx.strokeStyle = "#C9C4B8"; ctx.lineWidth = 1;
      ctx.strokeRect(r.x + .5, r.y + .5, r.w - 1, r.h - 1);
    }
    ctx.fillStyle = "#A29C8E"; ctx.font = "11px system-ui"; ctx.textAlign = "center";
    ctx.fillText(String(p + 1), r.x + r.w / 2, r.y + r.h + 18);
    ctx.textAlign = "left";
  }
}
function line(x0, y0, x1, y1) { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }

function strokeVisible(s) {
  const top = V.scroll, bot = V.scroll + CH / V.zoom;
  return !s.del && s.bb && s.bb.y1 >= top && s.bb.y0 <= bot;
}
function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, p: (a.p + b.p) / 2 }; }

function halfWidth(s, p) {
  if (s.tool === "hl") return s.w * 2.6;
  // Floor is proportionally low (not a flat 0.35 like before) so fine pen widths near PEN_MIN_W
  // still render visibly thinner than mid-range ones instead of all clamping to the same minimum.
  return Math.max(0.12, s.w * (0.55 + 0.9 * (p ?? 0.5)) * 0.5);
}

function drawInk(s, colorOverride) {
  const pts = s.pts;
  if (!pts.length) return;
  const col = colorOverride || s.color;
  ctx.save();
  if (s.tool === "hl") {
    ctx.globalAlpha = colorOverride ? 0.55 : HL_ALPHA;
    ctx.strokeStyle = col;
    ctx.lineWidth = halfWidth(s) * 2 * V.zoom;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    pathThrough(pts); ctx.stroke();
    ctx.restore();
    return;
  }
  if (pts.length < 3) {
    ctx.strokeStyle = col; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.lineWidth = halfWidth(s, pts[0].p) * 2 * V.zoom;
    pathThrough(pts); ctx.stroke();
    ctx.restore();
    return;
  }
  const L = [], R = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let nx = -(b.y - a.y), ny = b.x - a.x;
    const len = Math.hypot(nx, ny) || 1;
    const h = halfWidth(s, pts[i].p);
    nx = nx / len * h; ny = ny / len * h;
    L.push({ x: pts[i].x + nx, y: pts[i].y + ny });
    R.push({ x: pts[i].x - nx, y: pts[i].y - ny });
  }
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(sx(L[0].x), sy(L[0].y));
  for (let i = 1; i < L.length - 1; i++) {
    const m = { x: (L[i].x + L[i + 1].x) / 2, y: (L[i].y + L[i + 1].y) / 2 };
    ctx.quadraticCurveTo(sx(L[i].x), sy(L[i].y), sx(m.x), sy(m.y));
  }
  ctx.lineTo(sx(L[L.length - 1].x), sy(L[L.length - 1].y));
  ctx.lineTo(sx(R[R.length - 1].x), sy(R[R.length - 1].y));
  for (let i = R.length - 2; i > 0; i--) {
    const m = { x: (R[i].x + R[i - 1].x) / 2, y: (R[i].y + R[i - 1].y) / 2 };
    ctx.quadraticCurveTo(sx(R[i].x), sy(R[i].y), sx(m.x), sy(m.y));
  }
  ctx.lineTo(sx(R[0].x), sy(R[0].y));
  ctx.closePath();
  ctx.fill();

  const s0 = pts[0], eN = pts[pts.length - 1];
  ctx.beginPath();
  ctx.arc(sx(s0.x), sy(s0.y), halfWidth(s, s0.p) * V.zoom, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(sx(eN.x), sy(eN.y), halfWidth(s, eN.p) * V.zoom, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
function pathThrough(pts) {
  ctx.beginPath();
  ctx.moveTo(sx(pts[0].x), sy(pts[0].y));
  if (pts.length === 1) { ctx.lineTo(sx(pts[0].x) + .01, sy(pts[0].y)); return; }
  for (let i = 1; i < pts.length - 1; i++) {
    const m = midpoint(pts[i], pts[i + 1]);
    ctx.quadraticCurveTo(sx(pts[i].x), sy(pts[i].y), sx(m.x), sy(m.y));
  }
  ctx.lineTo(sx(pts.at(-1).x), sy(pts.at(-1).y));
}

function replayGrey(s) {
  return audio.playing && s.t != null && s.t > playPosMs();
}
function drawStrokes(kind) {
  const want = kind === "hl" ? "hl" : "pen";
  for (const s of doc.strokes) {
    if (s.tool !== want) continue;
    if (!strokeVisible(s)) continue;
    drawInk(s, replayGrey(s) ? "#CFCCC5" : null);
  }
  if (curStroke && curStroke.tool === want) drawInk(curStroke);
}

function drawImages() {
  const top = V.scroll, bot = V.scroll + CH / V.zoom;
  for (const im of doc.images) {
    if (im.del || im.y > bot || im.y + im.h < top) continue;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    if (im.rot || im.flipX || im.flipY) {
      const ccx = sx(im.x + im.w / 2), ccy = sy(im.y + im.h / 2);
      ctx.save();
      ctx.translate(ccx, ccy);
      if (im.rot) ctx.rotate(im.rot);
      ctx.scale(im.flipX ? -1 : 1, im.flipY ? -1 : 1);
      ctx.drawImage(im.img, -im.w * V.zoom / 2, -im.h * V.zoom / 2, im.w * V.zoom, im.h * V.zoom);
      ctx.restore();
    } else {
      ctx.drawImage(im.img, sx(im.x), sy(im.y), im.w * V.zoom, im.h * V.zoom);
    }
  }
}

function drawTexts() {
  for (const t of doc.texts) {
    if (t.del || t.hidden) continue;
    ctx.fillStyle = t.color;
    ctx.font = `${t.size * V.zoom}px ${fontCss(t)}`;
    ctx.textBaseline = "top";
    wrappedLines(t).forEach((ln, i) => ctx.fillText(ln, sx(t.x), sy(t.y + i * t.size * 1.3)));
  }
}

function drawTapes() {
  for (const t of doc.tapes) {
    if (t.del) continue;
    const x = sx(t.x), y = sy(t.y), w = t.w * V.zoom, h = t.h * V.zoom;
    if (!t.revealed) {
      ctx.fillStyle = "#FFD682";
      ctx.strokeStyle = "#D4A03C"; ctx.lineWidth = 1.5;
      roundRect(x, y, w, h, 4); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = "rgba(180,130,40,.35)";
      line(x + 8, y + 3, x + 8, y + h - 3);
    } else {
      ctx.strokeStyle = "#D4A03C"; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
      roundRect(x, y, w, h, 4); ctx.stroke(); ctx.setLineDash([]);
    }
  }
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
}

function canRotateSelection() {
  return sel.items.some(it => it.kind === "stroke" || it.kind === "image");
}
const HANDLE_INNER_PX = 9;
const HANDLE_OUTER_PX = 22;
function selHandles() {
  const b = selBounds();
  if (!b) return null;
  const pivot = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  const pad = 6 / V.zoom; 
  const raw = [
    { key: "tl", w: { x: b.x0 - pad, y: b.y0 - pad }, opp: { x: b.x1, y: b.y1 }, cursor: "nwse-resize" },
    { key: "tr", w: { x: b.x1 + pad, y: b.y0 - pad }, opp: { x: b.x0, y: b.y1 }, cursor: "nesw-resize" },
    { key: "br", w: { x: b.x1 + pad, y: b.y1 + pad }, opp: { x: b.x0, y: b.y0 }, cursor: "nwse-resize" },
    { key: "bl", w: { x: b.x0 - pad, y: b.y1 + pad }, opp: { x: b.x1, y: b.y0 }, cursor: "nesw-resize" },
  ];
  const corners = raw.map(c => ({ ...c, s: { x: sx(c.w.x), y: sy(c.w.y) } }));
  return { b, pivot, corners };
}
function hitSelHandle(hs, px, py) {
  const rotOk = canRotateSelection();
  for (const c of hs.corners) {
    const d = Math.hypot(px - c.s.x, py - c.s.y);
    if (d <= HANDLE_INNER_PX) return { mode: "scale", corner: c };
    if (rotOk && d <= HANDLE_OUTER_PX) return { mode: "rotate", corner: c };
  }
  return null;
}

function drawSelection() {
  if (!sel.items.length) return;
  const h = selHandles(); if (!h) return;
  const b = h.b;
  ctx.strokeStyle = "#0F766E"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
  ctx.strokeRect(sx(b.x0) - 6, sy(b.y0) - 6, (b.x1 - b.x0) * V.zoom + 12, (b.y1 - b.y0) * V.zoom + 12);
  ctx.setLineDash([]);

  const rotOk = canRotateSelection();
  for (const c of h.corners) {
    if (rotOk) {
      ctx.strokeStyle = "rgba(15,118,110,.35)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(c.s.x, c.s.y, HANDLE_OUTER_PX - 3, 0, 7); ctx.stroke();
    }
    ctx.fillStyle = "#fff"; ctx.strokeStyle = "#0F766E"; ctx.lineWidth = 1.5;
    ctx.fillRect(c.s.x - 5, c.s.y - 5, 10, 10);
    ctx.strokeRect(c.s.x - 5, c.s.y - 5, 10, 10);
  }
}

let live = null; 
function drawLive() {
  if (!live) return;
  if (live.mode === "tape") {
    const x = sx(Math.min(live.x0, live.x1)), y = sy(Math.min(live.y0, live.y1));
    const w = Math.abs(live.x1 - live.x0) * V.zoom, h = Math.abs(live.y1 - live.y0) * V.zoom;
    ctx.strokeStyle = "#D4A03C"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
  } else if (live.mode === "lasso" && live.pts.length > 1) {
    ctx.strokeStyle = "#6B6B6B"; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(sx(live.pts[0].x), sy(live.pts[0].y));
    for (const p of live.pts) ctx.lineTo(sx(p.x), sy(p.y));
    ctx.stroke(); ctx.setLineDash([]);
  }
}

const laser = [];
function drawLaser() {
  const now = performance.now();
  while (laser.length && now - laser[0].t > LASER_MS) laser.shift();
  if (laser.length < 2) return;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (let i = 1; i < laser.length; i++) {
    const age = (now - laser[i].t) / LASER_MS;
    ctx.strokeStyle = `rgba(235,60,45,${(1 - age) * .9})`;
    ctx.lineWidth = (1 + (1 - age) * 4) * V.zoom;
    ctx.beginPath();
    ctx.moveTo(sx(laser[i - 1].x), sy(laser[i - 1].y));
    ctx.lineTo(sx(laser[i].x), sy(laser[i].y));
    ctx.stroke();
  }
  if (laser.length) needsDraw = true;
}

let hover = { x: -99, y: -99 }; 
function drawEraserCursor() {
  if (V.tool !== "eraserStroke" && V.tool !== "eraserPartial") return;
  const r = V.eraserSize * V.zoom;
  ctx.strokeStyle = "rgba(90,86,78,.9)"; ctx.lineWidth = 1.25;
  ctx.beginPath(); ctx.arc(hover.x, hover.y, r, 0, 7); ctx.stroke();
  ctx.fillStyle = "rgba(90,86,78,.08)"; ctx.fill();
}

function shapeBounds(poly) {
  if (!poly || !poly.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0, y0, x1, y1 };
}
function shapeHasImageTarget() {
  if (!sel.shape) return false;
  const b = shapeBounds(sel.shape);
  return doc.images.some(im => !im.del && imageOverlapsRect(im, b.x0, b.y0, b.x1, b.y1));
}

function buildSelToolbarContent(showItems, showShape) {
  const host = $("selToolbar");
  host.innerHTML = "";
  const mk = (label, fn, title) => {
    const b = document.createElement("button");
    b.textContent = label; b.title = title; b.onclick = fn;
    host.appendChild(b);
    return b;
  };
  const sepEl = () => { const s = document.createElement("div"); s.className = "sel-sep"; host.appendChild(s); };
  if (showItems) {
    mk("↔", () => flipSelection("x"), `Flip horizontal (${keyFor("flipH").toUpperCase()})`);
    mk("↕", () => flipSelection("y"), `Flip vertical (${keyFor("flipV").toUpperCase()})`);
    mk("↻90°", () => rotateSelection90(), `Rotate 90° (${keyFor("rotate90").toUpperCase()})`);
    sepEl();
    mk("⧉", () => duplicateSelection(), "Duplicate (Ctrl+D)");
    mk("✕", () => deleteSelection(), "Delete");
  }
  if (showShape) {
    if (showItems) sepEl();
    mk("📋 Copy", () => copySelectionToClipboard(), "Copy this region (Ctrl+C)");
    mk("🧹 Clear", () => clearShapeSelection(), "Clear this region");
  }
}
function buildSelToolbar() { buildSelToolbarContent(sel.items.length > 0, sel.shape && shapeHasImageTarget()); }

let selToolbarSig = "";
function positionSelToolbar() {
  const host = $("selToolbar");
  const showItems = sel.items.length > 0;
  const showShape = !!(sel.shape && shapeHasImageTarget());
  if ((!showItems && !showShape) || drag) { host.classList.remove("open"); return; }
  const sig = `${showItems}|${showShape}|${keyFor("flipH")}|${keyFor("flipV")}|${keyFor("rotate90")}`;
  if (sig !== selToolbarSig) { selToolbarSig = sig; buildSelToolbarContent(showItems, showShape); }
  const b = selBounds() || shapeBounds(sel.shape);
  if (!b) { host.classList.remove("open"); return; }
  const left = (sx(b.x0) + sx(b.x1)) / 2;
  const above = sy(b.y0) - 44; 
  const top = above > 4 ? above : sy(b.y1) + 14; 
  host.style.left = Math.round(left) + "px";
  host.style.top = Math.round(top) + "px";
  host.classList.add("open");
}

/* ============================================================================
   Minimap — a continuous, whole-document scroll rail on the left of the canvas
   ========================================================================== */
const mmCache = new Map(); // page index -> cached thumbnail canvas, or "flat" for slots too small to render
let mmRegenTimer = null;
function scheduleMinimapRegen() {
  if (mmRegenTimer) return;
  mmRegenTimer = setTimeout(() => { mmRegenTimer = null; mmCache.clear(); needsDraw = true; }, 400);
}
function minimapScale() {
  const totalH = Math.max(1, S.pages * stride());
  const baseW = pageW(); // this document's actual page width — landscape-override pages may slightly overflow the rail, which is fine (clipped)
  return Math.max(1e-6, Math.min(MMH / totalH, (MMW - 6) / baseW));
}
function drawMinimap() {
  if (!V.minimap || MMW <= 0 || MMH <= 0) return;
  mmCtx.setTransform(MMDPR, 0, 0, MMDPR, 0, 0);
  mmCtx.clearRect(0, 0, MMW, MMH);
  const scale = minimapScale();
  for (let p = 0; p < S.pages; p++) {
    const dims = pageDims(p);
    const slotY = p * stride() * scale;
    const w = dims.w * scale, h = dims.h * scale;
    const x = (MMW - w) / 2;
    if (slotY > MMH) break;
    let tile = mmCache.get(p);
    if (tile === undefined) {
      if (h * MMDPR < 3) {
        tile = "flat"; // too small to matter — skip the (relatively) expensive full render
      } else {
        tile = renderPageThumbnail(p, Math.max(1, Math.round(w * MMDPR)), true);
      }
      mmCache.set(p, tile);
    }
    if (tile === "flat") {
      mmCtx.fillStyle = "#fff";
      mmCtx.fillRect(x, slotY, w, h);
    } else {
      mmCtx.drawImage(tile, x, slotY, w, h);
    }
    mmCtx.strokeStyle = "rgba(60,55,45,.18)"; mmCtx.lineWidth = 1;
    mmCtx.strokeRect(x + .5, slotY + .5, Math.max(0, w - 1), Math.max(0, h - 1));
  }
  const viewY = V.scroll * scale, viewH = Math.max(3, (CH / V.zoom) * scale);
  mmCtx.fillStyle = "rgba(15,118,110,.16)";
  mmCtx.fillRect(0, viewY, MMW, viewH);
  mmCtx.strokeStyle = "#0F766E"; mmCtx.lineWidth = 1.5;
  mmCtx.strokeRect(.75, viewY + .75, MMW - 1.5, Math.max(0, viewH - 1.5));
}
function mmScrollTo(clientY) {
  const r = MM.getBoundingClientRect();
  const scale = minimapScale();
  const worldY = (clientY - r.top) / scale;
  V.scroll = worldY - (CH / V.zoom) / 2;
  clampScroll();
  needsDraw = true;
  schedulePdfUpgrade();
  syncStatus();
}
let mmDragging = false;
MM.addEventListener("pointerdown", e => {
  mmDragging = true;
  MM.setPointerCapture(e.pointerId);
  mmScrollTo(e.clientY);
});
MM.addEventListener("pointermove", e => { if (mmDragging) mmScrollTo(e.clientY); });
MM.addEventListener("pointerup", e => { mmDragging = false; try { MM.releasePointerCapture(e.pointerId); } catch (_) {} });
MM.addEventListener("pointercancel", () => { mmDragging = false; });

/* ---------------- page scrollbars (bottom: horizontal, right: vertical) ---------------- */
const hScrollTrack = $("hScrollTrack"), hScrollThumb = $("hScrollThumb");
const vScrollTrack = $("vScrollTrack"), vScrollThumb = $("vScrollThumb");
const SCROLLBAR_MIN_THUMB = 30;
function updateScrollbars() {
  const contentW = pageW() * V.zoom;
  const needH = contentW > CW;
  hScrollTrack.classList.toggle("show", needH);
  if (needH) {
    const trackW = hScrollTrack.clientWidth;
    const thumbW = Math.max(SCROLLBAR_MIN_THUMB, Math.min(trackW, trackW * (CW / contentW)));
    const mx = maxScrollX();
    const frac = mx > 0 ? V.scrollX / mx : 0;
    hScrollThumb.style.width = Math.round(thumbW) + "px";
    hScrollThumb.style.left = Math.round(frac * (trackW - thumbW)) + "px";
  }

  // Scoped to the current page only (not the whole document) — the minimap rail already covers
  // jumping between pages, so this one is for fine vertical movement within whichever page
  // you're on, rebasing to whatever page that is as it changes.
  const p = curPage();
  const pagePxH = pageDims(p).h * V.zoom;
  const needV = pagePxH > CH;
  vScrollTrack.classList.toggle("show", needV);
  if (needV) {
    const trackH = vScrollTrack.clientHeight;
    const thumbH = Math.max(SCROLLBAR_MIN_THUMB, Math.min(trackH, trackH * (CH / pagePxH)));
    const mx = pageScrollMax(p);
    const within = Math.max(0, Math.min(mx, V.scroll - p * stride()));
    const frac = mx > 0 ? within / mx : 0;
    vScrollThumb.style.height = Math.round(thumbH) + "px";
    vScrollThumb.style.top = Math.round(frac * (trackH - thumbH)) + "px";
  }
}
// Max scroll offset within a single page's own content (world units) — the top of page `p` sits
// at world y = p*stride(), so this is how far past that the viewport can go while staying on it.
function pageScrollMax(p) { return Math.max(0, pageDims(p).h - CH / V.zoom); }
// Shared drag (thumb) + click-to-jump (track) wiring for both scrollbars — `axis` picks the
// client coordinate / element dimension to read, `get`/`set`/`max` bind it to either
// V.scrollX/maxScrollX or V.scroll/maxScroll.
function wireScrollbar(track, thumb, axis, set, max, clampFn) {
  const clientPos = e => axis === "x" ? e.clientX : e.clientY;
  const size = el => axis === "x" ? el.offsetWidth : el.offsetHeight;
  const rectStart = r => axis === "x" ? r.left : r.top;
  const rectSize = r => axis === "x" ? r.width : r.height;

  let pid = null, grabOffset = 0;
  thumb.addEventListener("pointerdown", e => {
    e.stopPropagation(); e.preventDefault();
    pid = e.pointerId;
    try { thumb.setPointerCapture(pid); } catch (_) {}
    thumb.classList.add("dragging");
    grabOffset = clientPos(e) - rectStart(thumb.getBoundingClientRect());
  });
  function dragTo(e) {
    if (pid === null || e.pointerId !== pid) return;
    const trackRect = track.getBoundingClientRect();
    const span = rectSize(trackRect) - size(thumb);
    const pos = clientPos(e) - rectStart(trackRect) - grabOffset;
    const frac = span > 0 ? Math.max(0, Math.min(1, pos / span)) : 0;
    set(frac * max());
    clampFn();
    needsDraw = true; syncStatus();
  }
  thumb.addEventListener("pointermove", dragTo);
  function endDrag() {
    if (pid === null) return;
    try { thumb.releasePointerCapture(pid); } catch (_) {}
    pid = null;
    thumb.classList.remove("dragging");
  }
  thumb.addEventListener("pointerup", endDrag);
  thumb.addEventListener("pointercancel", endDrag);

  // Clicking the track itself (not the thumb) jumps straight to that position, thumb centered
  // under the click — standard scrollbar-track behavior.
  track.addEventListener("pointerdown", e => {
    if (e.target === thumb) return;
    const trackRect = track.getBoundingClientRect();
    const span = rectSize(trackRect) - size(thumb);
    const pos = clientPos(e) - rectStart(trackRect) - size(thumb) / 2;
    const frac = span > 0 ? Math.max(0, Math.min(1, pos / span)) : 0;
    set(frac * max());
    clampFn();
    needsDraw = true; syncStatus();
  });
}
wireScrollbar(hScrollTrack, hScrollThumb, "x", v => { V.scrollX = v; }, maxScrollX, clampScrollX);
wireScrollbar(vScrollTrack, vScrollThumb, "y",
  v => { V.scroll = curPage() * stride() + v; },
  () => pageScrollMax(curPage()),
  clampScroll);

function frame() {
  if (needsDraw) { needsDraw = false; render(); }
  if (audio.playing || audio.rec) { needsDraw = true; syncStatus(); }
  positionSelToolbar();
  if (editingText) { positionTextFmtBar(); positionTextResizeHandle(); }
  requestAnimationFrame(frame);
}

/* ============================================================================
   Input — pointer events with pressure, tools, smart shapes
   ========================================================================== */
let drag = null;         
let curStroke = null;
let lastMoveT = 0;
const pointers = new Map(); 

