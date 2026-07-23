"use strict";
function evtPos(e) {
  const r = wrap.getBoundingClientRect();
  return { px: e.clientX - r.left, py: e.clientY - r.top };
}
function evtWorld(e) {
  const { px, py } = evtPos(e);
  return { x: wx(px), y: wy(py), p: e.pressure && e.pressure > 0 ? e.pressure : 0.5 };
}

cv.addEventListener("pointerdown", e => {
  dbgLog("DOWN", e.pointerType, e.pointerId, "pointers.size(before)=" + pointers.size, "drag=" + (drag ? drag.mode + "#" + drag.pointerId : "null"));
  if (e.pointerType === "pen") {
    // Evict any OTHER tracked pointer — a resting-palm touch (see below), or a stale entry left
    // by the previous pen session whose pointerup hasn't been processed yet. On iOS, writing at a
    // normal pace can deliver the next stroke's pointerdown slightly before the previous stroke's
    // pointerup — leaving that old entry in `pointers` made this new pointerdown push
    // pointers.size to 2, which got misread as a two-finger pinch (wiping BOTH strokes: the old
    // one's drag/curStroke were nulled by startPinch(), and the new one's moves got consumed as
    // pinch panning instead of drawing). That's what was silently eating every other stroke.
    // Only a stale PEN drag gets finalized — a drag still owned by a touch pointer means a
    // finger started drawing before this pencil touched down (nothing was rejecting it yet), and
    // that touch is retroactively the palm, same as the already-tracked case above: discarded,
    // not committed as a real stroke.
    const staleOwner = drag && pointers.get(drag.pointerId);
    const staleOwnerWasPen = !!staleOwner && staleOwner.pointerType === "pen";
    for (const id of [...pointers.keys()]) {
      if (id === e.pointerId) continue;
      dbgLog("  evicting stale pointer", id, pointers.get(id).pointerType);
      try { cv.releasePointerCapture(id); } catch (_) {}
      pointers.delete(id);
    }
    if (drag && drag.pointerId !== e.pointerId) {
      dbgLog("  stale drag found, mode=" + drag.mode, "staleOwnerWasPen=" + staleOwnerWasPen, "pts=" + (curStroke ? curStroke.pts.length : "n/a"));
      if (staleOwnerWasPen && drag.mode === "draw") { commitStroke(); dbgLog("  -> finalized stale stroke, totalStrokes=" + doc.strokes.length); }
      else dbgLog("  -> stale drag DISCARDED (not committed)");
      drag = null; live = null; curStroke = null;
    }
    if (pinch) pinch = null;
    touchPan = null;
  } else if (e.pointerType === "touch" && [...pointers.values()].some(p => p.pointerType === "pen")) {
    dbgLog("  -> touch rejected: pencil already down");
    return; // palm resting while the pencil is already down — ignore it entirely
  }
  try { cv.setPointerCapture(e.pointerId); } catch (err) { dbgLog("  setPointerCapture THREW:", err.message); }
  pointers.set(e.pointerId, e);
  if (pointers.size === 2 && [...pointers.values()].every(p => p.pointerType === "touch")) { dbgLog("  -> PINCH START"); touchPan = null; startPinch(); return; }
  if (pointers.size >= 2) dbgLog("  ** pointers.size=" + pointers.size + " but not a touch pair:", [...pointers.values()].map(p => p.pointerType).join(","));
  // "Only draw with a stylus" mode: a lone finger can't draw/erase/select, but it can still pan
  // the canvas — otherwise it'd be useless for navigation whenever the stylus isn't in hand.
  if (pencilOnly && e.pointerType === "touch") { dbgLog("  -> PAN START"); startTouchPan(e); return; }
  if (e.button !== 0) { dbgLog("  -> ignored: button=" + e.button); return; }
  commitTextEdit();
  const w = evtWorld(e);
  const { px, py } = evtPos(e);
  hover = { x: px, y: py };

  if (pendingPlacement) {
    finalizePendingPlacement(w.x - pendingPlacement.w / 2, w.y - pendingPlacement.h / 2);
    needsDraw = true;
    return;
  }

  if ((e.ctrlKey || e.metaKey) && audio.totalMs > 0 && V.tool !== "tape") {
    const s = strokeAt(w.x, w.y);
    if (s && s.t != null) { seekAudio(s.t); startPlayback(); return; }
  }

  switch (V.tool) {
    case "pen": case "hl":
      curStroke = {
        tool: V.tool, color: V.colorHex, w: V.width,
        pts: [{ x: w.x, y: w.y, p: w.p }],
        t: audio.rec ? recNowMs() : null, del: false, bb: null,
      };
      drag = { mode: "draw", pEma: w.p };
      lastMoveT = performance.now();
      break;
    case "eraserStroke":
      drag = { mode: "eraseS" }; eraseStrokeAt(w.x, w.y); break;
    case "eraserPartial":
      drag = { mode: "eraseP" }; erasePartialAt(w.x, w.y); break;
    case "tape": {
      const t = tapeAt(w.x, w.y);
      if (t && (e.altKey)) { t.del = true; pushUndo({ op: "del", items: [{ kind: "tape", ref: t }] }); markDirty(); break; }
      drag = { mode: "tapeMaybe", x0: w.x, y0: w.y, hit: t };
      break;
    }
    case "lasso": {
      const hs = sel.items.length ? selHandles() : null;
      const hit = hs ? hitSelHandle(hs, px, py) : null;
      if (hit && hit.mode === "rotate") {
        const snaps = sel.items.map(it => snapshotItem(it.kind, it.ref));
        drag = {
          mode: "rotate", pivot: hs.pivot, snaps,
          startAngle: Math.atan2(w.y - hs.pivot.y, w.x - hs.pivot.x),
        };
        break;
      }
      if (hit && hit.mode === "scale") {
        const snaps = sel.items.map(it => snapshotItem(it.kind, it.ref));
        drag = {
          mode: "scale", pivot: hit.corner.opp, snaps,
          startDist: Math.max(1, Math.hypot(w.x - hit.corner.opp.x, w.y - hit.corner.opp.y)),
        };
        break;
      }
      const b = selBounds();
      if (b && w.x > b.x0 - 10 && w.x < b.x1 + 10 && w.y > b.y0 - 10 && w.y < b.y1 + 10) {
        drag = { mode: "selMove", lx: w.x, ly: w.y, dx: 0, dy: 0 };
      } else {
        clearSelection();
        drag = { mode: "lassoNew", rect: e.shiftKey, partial: e.altKey, downPx: px, downPy: py, x0: w.x, y0: w.y, moved: false };
        live = { mode: "lasso", pts: [{ x: w.x, y: w.y }], rect: e.shiftKey };
        if (clipboard.items.length || clipboard.crop) {
          const pasteAt = { x: w.x, y: w.y };
          const myDrag = drag;
          drag.pasteTimer = setTimeout(() => {
            if (drag === myDrag && drag.mode === "lassoNew" && !drag.moved) {
              pasteClipboardAt(pasteAt.x, pasteAt.y);
              drag.mode = "pasteHoldDone";
              live = null;
            }
          }, 450);
        }
      }
      break;
    }
    case "text": startTextEdit(w.x, w.y); break;
    case "laser":
      drag = { mode: "laser" };
      laser.push({ x: w.x, y: w.y, t: performance.now() });
      break;
  }
  if (drag) drag.pointerId = e.pointerId;
  dbgLog("  -> drag=" + (drag ? drag.mode : "null"), "pointers.size(after)=" + pointers.size);
  needsDraw = true;
});

cv.addEventListener("pointermove", e => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, e);
  if (pointers.size === 2) { doPinch(); return; }
  if (touchPan && e.pointerId === touchPan.pointerId) { doTouchPan(e); return; }
  if (drag && e.pointerId !== drag.pointerId) dbgLog("MOVE", e.pointerType, e.pointerId, "IGNORED (drag owned by #" + drag.pointerId + ")");
  // A second pointer (a resting palm, most commonly) moving around shouldn't steer a stroke or
  // drag that a DIFFERENT pointer started — without this, an untracked palm touch could feed its
  // own coordinates into the in-progress drag, warping the line being drawn.
  if (drag && e.pointerId !== drag.pointerId) return;
  const { px, py } = evtPos(e);
  hover = { x: px, y: py };
  if (V.tool.startsWith("eraser") || pendingPlacement) needsDraw = true;
  if (!drag) {
    if (V.tool === "lasso" && sel.items.length) {
      const hs = selHandles();
      const hit = hs ? hitSelHandle(hs, px, py) : null;
      cv.style.cursor = hit ? (hit.mode === "scale" ? hit.corner.cursor : "grab") : "default";
    }
    return;
  }
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];

  switch (drag.mode) {
    case "draw": {
      // Holding Shift forces a straight line for this stroke even with Ruler mode off, and
      // additionally snaps it to whichever of horizontal/vertical is closer to the drag
      // direction — held live, so toggling Shift mid-stroke switches modes on the fly, same as
      // Ruler mode's own live toggle.
      const straight = V.ruler || e.shiftKey;
      for (const ce of events) {
        const w = evtWorld(ce);
        const lp = curStroke.pts.at(-1);
        const d2 = (w.x - lp.x) ** 2 + (w.y - lp.y) ** 2;
        if (d2 < 0.6 / V.zoom) continue;
        if (d2 > 2) lastMoveT = performance.now();
        drag.pEma += 0.35 * (w.p - drag.pEma);
        if (straight) {
          const p0 = curStroke.pts[0];
          let px = w.x, py = w.y;
          if (e.shiftKey) {
            if (Math.abs(px - p0.x) > Math.abs(py - p0.y)) py = p0.y; else px = p0.x;
          }
          curStroke.pts.length = 1;
          curStroke.pts.push({ x: px, y: py, p: drag.pEma });
        } else {
          curStroke.pts.push({ x: w.x, y: w.y, p: drag.pEma });
        }
      }
      needsDraw = true;
      break;
    }
    case "eraseS": eraseStrokeAt(evtWorld(e).x, evtWorld(e).y); break;
    case "eraseP": erasePartialAt(evtWorld(e).x, evtWorld(e).y); break;
    case "tapeMaybe": {
      const w = evtWorld(e);
      if ((w.x - drag.x0) ** 2 + (w.y - drag.y0) ** 2 > 20) {
        drag = { mode: "tapeNew", x0: drag.x0, y0: drag.y0 };
        live = { mode: "tape", x0: drag.x0, y0: drag.y0, x1: w.x, y1: w.y };
      }
      break;
    }
    case "tapeNew": {
      const w = evtWorld(e);
      live.x1 = w.x; live.y1 = w.y; needsDraw = true;
      break;
    }
    case "lassoNew": {
      const w = evtWorld(e);
      const { px: mpx, py: mpy } = evtPos(e);
      if (Math.hypot(mpx - drag.downPx, mpy - drag.downPy) > 6) {
        drag.moved = true;
        if (drag.pasteTimer) { clearTimeout(drag.pasteTimer); drag.pasteTimer = null; }
      }
      if (drag.rect) {
        const x0 = drag.x0, y0 = drag.y0;
        live.pts = [{ x: x0, y: y0 }, { x: w.x, y: y0 }, { x: w.x, y: w.y }, { x: x0, y: w.y }];
        needsDraw = true;
      } else {
        const lp = live.pts.at(-1);
        if ((w.x - lp.x) ** 2 + (w.y - lp.y) ** 2 > 4) { live.pts.push({ x: w.x, y: w.y }); needsDraw = true; }
      }
      break;
    }
    case "selMove": {
      const w = evtWorld(e);
      const dx = w.x - drag.lx, dy = w.y - drag.ly;
      drag.lx = w.x; drag.ly = w.y; drag.dx += dx; drag.dy += dy;
      sel.items.forEach(it => shiftObject(it.ref, it.kind, dx, dy));
      needsDraw = true;
      break;
    }
    case "rotate": {
      const w = evtWorld(e);
      let dAngle = Math.atan2(w.y - drag.pivot.y, w.x - drag.pivot.x) - drag.startAngle;
      if (e.shiftKey) { 
        const step = Math.PI / 12;
        dAngle = Math.round(dAngle / step) * step;
      } else {
        dAngle = magnetSnapTo90(dAngle); 
      }
      applyGroupTransform(sel.items, drag.snaps, drag.pivot, 1, dAngle);
      needsDraw = true;
      break;
    }
    case "scale": {
      const w = evtWorld(e);
      const dist = Math.hypot(w.x - drag.pivot.x, w.y - drag.pivot.y);
      const scaleFactor = Math.max(0.08, Math.min(12, dist / drag.startDist));
      applyGroupTransform(sel.items, drag.snaps, drag.pivot, scaleFactor, 0);
      needsDraw = true;
      break;
    }
    case "laser": {
      const w = evtWorld(e);
      laser.push({ x: w.x, y: w.y, t: performance.now() });
      needsDraw = true;
      break;
    }
  }
});

function endPointer(e) {
  dbgLog("UP", e.type, e.pointerType, e.pointerId, "drag=" + (drag ? drag.mode + "#" + drag.pointerId : "null"), "pinch=" + !!pinch, "touchPan=" + !!touchPan);
  pointers.delete(e.pointerId);
  if (touchPan && e.pointerId === touchPan.pointerId) { touchPan = null; return; }
  if (drag && e.pointerId !== drag.pointerId) { dbgLog("  -> IGNORED (drag owned by a different pointer)"); return; } // a different pointer lifting shouldn't end this drag
  if (pinch) { pinch = null; return; }
  if (!drag) { dbgLog("  -> no active drag, nothing to end"); return; }
  if (drag.pasteTimer) { clearTimeout(drag.pasteTimer); drag.pasteTimer = null; }
  const w = evtWorld(e);
  switch (drag.mode) {
    case "draw": commitStroke(); break;
    case "tapeMaybe":
      if (drag.hit) { drag.hit.revealed = !drag.hit.revealed; markDirty(); }
      break;
    case "tapeNew": {
      const x = Math.min(drag.x0, w.x), y = Math.min(drag.y0, w.y);
      const tw = Math.abs(w.x - drag.x0), th = Math.abs(w.y - drag.y0);
      if (tw > 10 && th > 8) {
        const t = { x, y, w: tw, h: th, revealed: false, del: false };
        doc.tapes.push(t);
        pushUndo({ op: "add", items: [{ kind: "tape", ref: t }] });
        bumpPages(y + th); markDirty();
      }
      break;
    }
    case "lassoNew": {
      const { px, py } = evtPos(e);
      const clickDist = Math.hypot(px - drag.downPx, py - drag.downPy);
      if (clickDist < 6) {
        const picked = pickObjectAt(w.x, w.y);
        sel.items = picked ? [picked] : [];
        sel.shape = null;
      } else {
        finishLasso(drag.partial);
      }
      break;
    }
    case "selMove":
      if (drag.dx || drag.dy) {
        pushUndo({ op: "move", dx: drag.dx, dy: drag.dy, items: sel.items.slice() });
        bumpPages(selBounds()?.y1 ?? 0); markDirty();
      }
      break;
    case "rotate": case "scale": {
      const items = sel.items.map((it, i) => ({ kind: it.kind, ref: it.ref, before: drag.snaps[i], after: snapshotItem(it.kind, it.ref) }));
      pushUndo({ op: "transform", items });
      bumpPages(selBounds()?.y1 ?? 0);
      markDirty();
      break;
    }
  }
  drag = null; live = null; curStroke = null;
  needsDraw = true;
}
cv.addEventListener("pointerup", endPointer);
cv.addEventListener("pointercancel", endPointer);
cv.addEventListener("pointerleave", () => { hover = { x: -99, y: -99 }; needsDraw = true; });

/* pinch zoom + two-finger pan */
let pinch = null;
function startPinch() {
  drag = null; live = null; curStroke = null;
  const [a, b] = [...pointers.values()];
  pinch = { d: dist(a, b), zoom: V.zoom, my: (a.clientY + b.clientY) / 2, scroll: V.scroll };
}
function doPinch() {
  if (!pinch) return;
  const [a, b] = [...pointers.values()];
  const nd = dist(a, b);
  setZoom(pinch.zoom * nd / pinch.d, CW / 2, pinch.my);
  needsDraw = true;
}
const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;

/* single-finger pan, "only draw with a stylus" mode only — a lone finger can't draw there, so it
   drags the canvas instead (content follows the finger, like scrolling any touch surface) rather
   than being dead weight whenever the stylus isn't in hand. */
let touchPan = null;
function startTouchPan(e) {
  const { px, py } = evtPos(e);
  touchPan = { pointerId: e.pointerId, x0: px, y0: py, scroll0: V.scroll, scrollX0: V.scrollX };
}
function doTouchPan(e) {
  if (!touchPan) return;
  const { px, py } = evtPos(e);
  V.scroll = touchPan.scroll0 - (py - touchPan.y0) / V.zoom;
  V.scrollX = touchPan.scrollX0 - (px - touchPan.x0) / V.zoom;
  clampScroll(); clampScrollX();
  needsDraw = true;
}

wrap.addEventListener("wheel", e => {
  e.preventDefault();
  const { px, py } = evtPos(e);
  if (e.ctrlKey || e.metaKey) {
    setZoom(V.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), px, py);
  } else {
    V.scroll += (e.deltaY / V.zoom);
    if (e.deltaX) { V.scrollX += (e.deltaX / V.zoom); clampScrollX(); }
    clampScroll(); needsDraw = true; syncUI();
    schedulePdfUpgrade();
  }
}, { passive: false });

/* ---------------- stroke commit + smart shapes ---------------- */
function commitStroke() {
  if (!curStroke || !curStroke.pts.length) { dbgLog("commitStroke: NOTHING TO COMMIT (curStroke=" + !!curStroke + ")"); return; }
  dbgLog("commitStroke: committing", curStroke.pts.length, "pts, totalStrokes will be", doc.strokes.length + 1);
  if (curStroke.pts.length === 1) {
    const p = curStroke.pts[0];
    curStroke.pts.push({ x: p.x + 0.4, y: p.y + 0.4, p: p.p });
  }
  if (!curStroke.snapped && !V.ruler) smoothPts(curStroke.pts);
  curStroke.bb = strokeBB(curStroke);
  doc.strokes.push(curStroke);
  pushUndo({ op: "add", items: [{ kind: "stroke", ref: curStroke }] });
  bumpPages(curStroke.bb.y1);
  markDirty();
}
function smoothPts(pts) {
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < pts.length - 1; i++) {
      pts[i].x = (pts[i - 1].x + 2 * pts[i].x + pts[i + 1].x) / 4;
      pts[i].y = (pts[i - 1].y + 2 * pts[i].y + pts[i + 1].y) / 4;
      pts[i].p = ((pts[i - 1].p ?? .5) + 2 * (pts[i].p ?? .5) + (pts[i + 1].p ?? .5)) / 4;
    }
  }
}

const SHAPE_SNAP_ENABLED = false;
setInterval(() => {
  if (!SHAPE_SNAP_ENABLED) return;
  if (drag?.mode === "draw" && curStroke && !curStroke.snapped && !V.ruler
      && performance.now() - lastMoveT > SHAPE_HOLD_MS && curStroke.pts.length > 7) {
    const snapped = trySnap(curStroke.pts);
    if (snapped) { curStroke.pts = snapped; curStroke.snapped = true; needsDraw = true; }
  }
}, 90);

function resamplePts(pts, step) {
  const out = [{ x: pts[0].x, y: pts[0].y }];
  let prev = pts[0], acc = 0;
  for (let i = 1; i < pts.length; i++) {
    let cur = pts[i];
    let d = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    while (acc + d >= step && d > 0) {
      const t = (step - acc) / d;
      const np = { x: prev.x + t * (cur.x - prev.x), y: prev.y + t * (cur.y - prev.y) };
      out.push(np);
      prev = np;
      d = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      acc = 0;
    }
    acc += d; prev = cur;
  }
  out.push({ x: pts.at(-1).x, y: pts.at(-1).y });
  return out;
}

function trySnap(pts) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  const diag = Math.hypot(x1 - x0, y1 - y0);
  if (diag < 24) return null;
  const P = (x, y) => ({ x, y, p: 0.5 });

  const r = resamplePts(pts, Math.max(3, diag / 60));
  const gap = Math.hypot(r[0].x - r.at(-1).x, r[0].y - r.at(-1).y);
  const closed = gap < Math.max(28, diag / 4);

  if (closed) {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const rx = Math.max(1, (x1 - x0) / 2), ry = Math.max(1, (y1 - y0) / 2);
    let sum = 0, sum2 = 0;
    for (const q of r) {
      const nr = Math.hypot((q.x - cx) / rx, (q.y - cy) / ry); 
      sum += nr; sum2 += nr * nr;
    }
    const mean = sum / r.length;
    const cv = Math.sqrt(Math.max(0, sum2 / r.length - mean * mean)) / mean;
    if (cv < 0.09) {
      const out = [];
      for (let i = 0; i <= 40; i++) {
        const a = i / 40 * Math.PI * 2;
        out.push(P(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry));
      }
      return out;
    }
    let far = 0, fd = -1;
    for (let i = 0; i < r.length; i++) {
      const d = (r[i].x - cx) ** 2 + (r[i].y - cy) ** 2;
      if (d > fd) { fd = d; far = i; }
    }
    const loop = [...r.slice(far), ...r.slice(0, far)];
    loop.push({ x: loop[0].x, y: loop[0].y });
    let simp = null, corners = 0;
    for (const div of [20, 15, 11]) { 
      simp = rdp(loop, Math.max(6, diag / div));
      for (let i = simp.length - 2; i > 0; i--) {
        if (Math.hypot(simp[i].x - simp[i + 1].x, simp[i].y - simp[i + 1].y) < 7) simp.splice(i, 1);
      }
      corners = simp.length - 1;
      if (corners === 3 || corners === 4) break;
    }
    if (corners === 3) return [...simp.slice(0, 3), simp[0]].map(q => P(q.x, q.y));
    if (corners === 4) {
      const near = (v, t) => Math.abs(v - t) < Math.max(9, diag / 14);
      const axis = simp.slice(0, 4).every(c =>
        (near(c.x, x0) || near(c.x, x1)) && (near(c.y, y0) || near(c.y, y1)));
      if (axis) return [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1), P(x0, y0)];
      return [...simp.slice(0, 4), simp[0]].map(q => P(q.x, q.y));
    }
    return null; 
  }

  const simp = rdp(r, Math.max(6, diag / 18));
  if (simp.length === 2) {
    const a = pts[0], b = pts.at(-1);
    const deg = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    const targets = [-180, -135, -90, -45, 0, 45, 90, 135, 180];
    let best = deg, bd = 1e9;
    for (const t of targets) if (Math.abs(deg - t) < bd) { bd = Math.abs(deg - t); best = t; }
    if (bd < 5) {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const na = best * Math.PI / 180;
      return [P(a.x, a.y), P(a.x + Math.cos(na) * len, a.y + Math.sin(na) * len)];
    }
    return [P(a.x, a.y), P(b.x, b.y)];
  }
  return null;
}

function rdp(pts, eps) {
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi <= lo + 1) continue;
    let worst = -1, wd = 0;
    const A = pts[lo], B = pts[hi];
    const abx = B.x - A.x, aby = B.y - A.y, len = Math.hypot(abx, aby);
    for (let i = lo + 1; i < hi; i++) {
      const d = len < 1e-6
        ? Math.hypot(pts[i].x - A.x, pts[i].y - A.y)
        : Math.abs(abx * (pts[i].y - A.y) - aby * (pts[i].x - A.x)) / len;
      if (d > wd) { wd = d; worst = i; }
    }
    if (wd > eps) { keep[worst] = true; stack.push([lo, worst], [worst, hi]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/* ---------------- hit tests & erasers ---------------- */
function distToSeg(px, py, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((px - a.x) * abx + (py - a.y) * aby) / (abx * abx + aby * aby || 1)));
  return Math.hypot(px - (a.x + abx * t), py - (a.y + aby * t));
}
function strokeAt(x, y, r = 8) {
  for (let i = doc.strokes.length - 1; i >= 0; i--) {
    const s = doc.strokes[i];
    if (s.del) continue;
    if (x < s.bb.x0 - r || x > s.bb.x1 + r || y < s.bb.y0 - r || y > s.bb.y1 + r) continue;
    for (let j = 0; j + 1 < s.pts.length; j++)
      if (distToSeg(x, y, s.pts[j], s.pts[j + 1]) < r + s.w) return s;
  }
  return null;
}
function tapeAt(x, y) {
  for (let i = doc.tapes.length - 1; i >= 0; i--) {
    const t = doc.tapes[i];
    if (!t.del && x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h) return t;
  }
  return null;
}
function imageCorners(im) {
  const cx = im.x + im.w / 2, cy = im.y + im.h / 2;
  const hw = im.w / 2, hh = im.h / 2, rot = im.rot || 0;
  const c = Math.cos(rot), s = Math.sin(rot);
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([dx, dy]) => ({
    x: cx + dx * c - dy * s, y: cy + dx * s + dy * c,
  }));
}
function imageBBox(im) {
  const c = imageCorners(im);
  return {
    x0: Math.min(...c.map(p => p.x)), y0: Math.min(...c.map(p => p.y)),
    x1: Math.max(...c.map(p => p.x)), y1: Math.max(...c.map(p => p.y)),
  };
}
function pointInImage(im, x, y) {
  if (!im.rot) return x >= im.x && x <= im.x + im.w && y >= im.y && y <= im.y + im.h;
  const cx = im.x + im.w / 2, cy = im.y + im.h / 2;
  const c = Math.cos(-im.rot), s = Math.sin(-im.rot);
  const dx = x - cx, dy = y - cy;
  const lx = dx * c - dy * s, ly = dx * s + dy * c; 
  return Math.abs(lx) <= im.w / 2 && Math.abs(ly) <= im.h / 2;
}

function eraseStrokeAt(x, y) {
  const killed = [];
  const s = strokeAt(x, y, V.eraserSize);
  if (s) { s.del = true; killed.push({ kind: "stroke", ref: s }); }
  for (const t of doc.texts) {
    const b = textBB(t);
    if (!t.del && x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1) { t.del = true; killed.push({ kind: "text", ref: t }); }
  }
  // Images (including imported PDF pages) are intentionally left alone here — lasso-select + delete is the
  // intended way to remove them, since the eraser is meant for freehand ink, not whole embedded pictures.
  if (killed.length) { pushUndo({ op: "del", items: killed }); markDirty(); }
}
function splitStrokeByTest(s, insideTest) {
  const dense = [];
  for (let i = 0; i < s.pts.length; i++) {
    const a = s.pts[i];
    dense.push(a);
    const b = s.pts[i + 1];
    if (!b) break;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.floor(d / 3);
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      dense.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, p: (a.p ?? .5) + ((b.p ?? .5) - (a.p ?? .5)) * t });
    }
  }
  const insideRuns = [], outsideRuns = [];
  let curIn = null, curOut = null;
  for (const pt of dense) {
    if (insideTest(pt)) {
      if (curOut) { outsideRuns.push(curOut); curOut = null; }
      (curIn ?? (curIn = [])).push(pt);
    } else {
      if (curIn) { insideRuns.push(curIn); curIn = null; }
      (curOut ?? (curOut = [])).push(pt);
    }
  }
  if (curIn) insideRuns.push(curIn);
  if (curOut) outsideRuns.push(curOut);
  return { insideRuns, outsideRuns };
}

function erasePartialAt(x, y) {
  const R = V.eraserSize;
  for (const s of [...doc.strokes]) {
    if (s.del) continue;
    const pad = R + s.w * 2 + 4;
    if (x < s.bb.x0 - pad || x > s.bb.x1 + pad || y < s.bb.y0 - pad || y > s.bb.y1 + pad) continue;
    const cut = p => Math.hypot(p.x - x, p.y - y) <= R + halfWidth(s, p.p);
    const { insideRuns, outsideRuns } = splitStrokeByTest(s, cut);
    if (!insideRuns.length) continue;
    s.del = true;
    pushUndo({ op: "del", items: [{ kind: "stroke", ref: s }] });
    for (const r of outsideRuns) {
      if (r.length < 2 || pathLen(r) < 2.5) continue;
      const ns = { ...s, del: false, pts: r.map(pt => ({ ...pt })), t: s.t };
      ns.bb = strokeBB(ns);
      doc.strokes.push(ns);
      pushUndo({ op: "add", items: [{ kind: "stroke", ref: ns }] });
    }
    markDirty();
  }
}
function pathLen(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return d;
}

/* ---------------- lasso ---------------- */
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function finishLassoSplit(poly) {
  const picked = [];
  const inside = p => pointInPoly(p.x, p.y, poly);
  for (const s of [...doc.strokes]) {
    if (s.del) continue;
    const { insideRuns, outsideRuns } = splitStrokeByTest(s, inside);
    if (!insideRuns.length) continue;
    if (!outsideRuns.length) { picked.push({ kind: "stroke", ref: s }); continue; }
    s.del = true;
    pushUndo({ op: "del", items: [{ kind: "stroke", ref: s }] });
    for (const r of insideRuns) {
      if (r.length < 2 || pathLen(r) < 2.5) continue;
      const ns = { ...s, del: false, pts: r.map(pt => ({ ...pt })), t: null };
      ns.bb = strokeBB(ns);
      doc.strokes.push(ns);
      pushUndo({ op: "add", items: [{ kind: "stroke", ref: ns }] });
      picked.push({ kind: "stroke", ref: ns });
    }
    for (const r of outsideRuns) {
      if (r.length < 2 || pathLen(r) < 2.5) continue;
      const ns = { ...s, del: false, pts: r.map(pt => ({ ...pt })), t: s.t };
      ns.bb = strokeBB(ns);
      doc.strokes.push(ns);
      pushUndo({ op: "add", items: [{ kind: "stroke", ref: ns }] });
    }
  }
  return picked;
}

function finishLasso(partial) {
  if (!live || live.pts.length < 3) return;
  const poly = live.pts;
  sel.items = [];
  sel.shape = poly.slice(); 

  if (partial) {
    sel.items.push(...finishLassoSplit(poly));
    markDirty(); 
  } else {
    for (const s of doc.strokes) {
      if (s.del) continue;
      let inN = 0, tot = 0;
      const step = Math.max(1, Math.floor(s.pts.length / 14));
      for (let i = 0; i < s.pts.length; i += step) { tot++; if (pointInPoly(s.pts[i].x, s.pts[i].y, poly)) inN++; }
      if (tot && inN * 2 > tot) sel.items.push({ kind: "stroke", ref: s });
    }
  }
  for (const t of doc.tapes)
    if (!t.del && pointInPoly(t.x + t.w / 2, t.y + t.h / 2, poly)) sel.items.push({ kind: "tape", ref: t });
  for (const t of doc.texts) {
    const b = textBB(t);
    if (!t.del && pointInPoly((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, poly)) sel.items.push({ kind: "text", ref: t });
  }
  for (const im of doc.images)
    if (!im.del && pointInPoly(im.x + im.w / 2, im.y + im.h / 2, poly)) sel.items.push({ kind: "image", ref: im });
}

function pickObjectAt(x, y) {
  const t = tapeAt(x, y);
  if (t) return { kind: "tape", ref: t };
  for (let i = doc.texts.length - 1; i >= 0; i--) {
    const q = doc.texts[i];
    if (q.del) continue;
    const b = textBB(q);
    if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return { kind: "text", ref: q };
  }
  const s = strokeAt(x, y);
  if (s) return { kind: "stroke", ref: s };
  for (let i = doc.images.length - 1; i >= 0; i--) {
    const im = doc.images[i];
    if (!im.del && pointInImage(im, x, y)) return { kind: "image", ref: im };
  }
  return null;
}
function deleteSelection() {
  if (!sel.items.length) return;
  sel.items.forEach(it => it.ref.del = true);
  pushUndo({ op: "del", items: sel.items.slice() });
  clearSelection(); markDirty();
}
/* ---------------- Copy / Paste ---------------- */
