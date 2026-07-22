"use strict";
function pushUndo(entry) { undoStack.push(entry); if (undoStack.length > 400) undoStack.shift(); redoStack = []; }
function applyEntry(e, dir) { // dir: -1 undo, +1 redo
  const undoing = dir < 0;
  switch (e.op) {
    case "add":    e.items.forEach(it => it.ref.del = undoing); break;
    case "del":    e.items.forEach(it => it.ref.del = !undoing); break;
    case "move": {
      const dx = undoing ? -e.dx : e.dx, dy = undoing ? -e.dy : e.dy;
      e.items.forEach(it => shiftObject(it.ref, it.kind, dx, dy));
      break;
    }
    case "clearShape": {
      e.imgChanges.forEach(c => {
        c.ref.data = undoing ? c.beforeData : c.afterData;
        c.ref.img = undoing ? c.beforeImg : c.afterImg;
      });
      e.delItems.forEach(it => it.ref.del = !undoing);
      break;
    }
    case "pageDel": {
      if (undoing) {
        e.removed.forEach(it => it.ref.del = false);
        e.shifted.forEach(it => shiftObject(it.ref, it.kind, 0, e.d));
        S.pages = Math.min(MAX_PAGES, S.pages + 1);
        S.pageStyles = e.pageStylesBefore;
      } else {
        e.removed.forEach(it => it.ref.del = true);
        e.shifted.forEach(it => shiftObject(it.ref, it.kind, 0, -e.d));
        S.pages = Math.max(1, S.pages - 1);
        S.pageStyles = e.pageStylesAfter;
      }
      clampScroll();
      break;
    }
    case "pageIns": {
      if (undoing) {
        e.shifted.forEach(it => shiftObject(it.ref, it.kind, 0, -e.d));
        S.pages = Math.max(1, S.pages - e.count);
        S.pageStyles = e.pageStylesBefore;
      } else {
        e.shifted.forEach(it => shiftObject(it.ref, it.kind, 0, e.d));
        S.pages = Math.min(MAX_PAGES, S.pages + e.count);
        S.pageStyles = e.pageStylesAfter;
      }
      clampScroll();
      break;
    }
    case "replacePts": {
      const cur = e.ref.pts;
      e.ref.pts = undoing ? e.before : e.after;
      if (undoing) e.after = cur;
      e.ref.bb = strokeBB(e.ref);
      break;
    }
    case "transform": {
      e.items.forEach(it => {
        const snap = undoing ? it.before : it.after;
        if (it.kind === "stroke") {
          it.ref.pts = snap.pts.map(p => ({ ...p }));
          it.ref.w = snap.w;
          it.ref.bb = strokeBB(it.ref);
        } else {
          Object.assign(it.ref, snap);
        }
      });
      break;
    }
  }
  markDirty(); clearSelection();
}
function undo() { const e = undoStack.pop(); if (e) { applyEntry(e, -1); redoStack.push(e); } }
function redo() { const e = redoStack.pop(); if (e) { applyEntry(e, +1); undoStack.push(e); } }

function shiftObject(o, kind, dx, dy) {
  if (kind === "stroke") { o.pts.forEach(p => { p.x += dx; p.y += dy; }); o.bb = strokeBB(o); }
  else { o.x += dx; o.y += dy; }
}

/* ---------------- scale & rotate: shared math for the selection handles ---------------- */
function snapshotItem(kind, ref) {
  if (kind === "stroke") return { pts: ref.pts.map(p => ({ ...p })), w: ref.w };
  if (kind === "image") return { x: ref.x, y: ref.y, w: ref.w, h: ref.h, rot: ref.rot || 0, flipX: !!ref.flipX, flipY: !!ref.flipY };
  if (kind === "text") return { x: ref.x, y: ref.y, size: ref.size, color: ref.color, font: ref.font, w: ref.w, lines: ref.lines.slice() };
  return { x: ref.x, y: ref.y, w: ref.w, h: ref.h }; // tape
}
const MAGNET_90_THRESHOLD_DEG = 4;
function magnetSnapTo90(dAngle) {
  const step = Math.PI / 2;
  const nearest = Math.round(dAngle / step) * step;
  const diffDeg = Math.abs(dAngle - nearest) * 180 / Math.PI;
  return diffDeg <= MAGNET_90_THRESHOLD_DEG ? nearest : dAngle;
}
function applyGroupTransform(items, snaps, pivot, scaleFactor, dAngle) {
  const cos = Math.cos(dAngle), sin = Math.sin(dAngle);
  const tf = (px, py) => {
    const dx = (px - pivot.x) * scaleFactor, dy = (py - pivot.y) * scaleFactor;
    return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
  };
  items.forEach(({ kind, ref }, i) => {
    const snap = snaps[i];
    if (kind === "stroke") {
      ref.pts = snap.pts.map(p => { const r = tf(p.x, p.y); return { x: r.x, y: r.y, p: p.p }; });
      ref.w = Math.max(0.5, snap.w * scaleFactor);
      ref.bb = strokeBB(ref);
    } else if (kind === "image") {
      const c = tf(snap.x + snap.w / 2, snap.y + snap.h / 2);
      const nw = Math.max(6, snap.w * scaleFactor), nh = Math.max(6, snap.h * scaleFactor);
      ref.w = nw; ref.h = nh; ref.x = c.x - nw / 2; ref.y = c.y - nh / 2;
      ref.rot = (snap.rot || 0) + dAngle;
      ref.flipX = snap.flipX; ref.flipY = snap.flipY;
    } else if (kind === "text") {
      const c = tf(snap.x, snap.y);
      ref.x = c.x; ref.y = c.y;
      ref.size = Math.max(6, snap.size * scaleFactor);
      if (snap.w) ref.w = Math.max(20, snap.w * scaleFactor); // keep the wrap width in proportion with the font
    } else { // tape
      const c = tf(snap.x + snap.w / 2, snap.y + snap.h / 2);
      const nw = Math.max(8, snap.w * scaleFactor), nh = Math.max(8, snap.h * scaleFactor);
      ref.w = nw; ref.h = nh; ref.x = c.x - nw / 2; ref.y = c.y - nh / 2;
    }
  });
}

function applyGroupFlip(items, snaps, pivot, axis) { // axis: "x" (horizontal flip) or "y" (vertical flip)
  const mirror = (px, py) => axis === "x"
    ? { x: 2 * pivot.x - px, y: py }
    : { x: px, y: 2 * pivot.y - py };
  items.forEach(({ kind, ref }, i) => {
    const snap = snaps[i];
    if (kind === "stroke") {
      ref.pts = snap.pts.map(p => { const r = mirror(p.x, p.y); return { x: r.x, y: r.y, p: p.p }; });
      ref.bb = strokeBB(ref);
    } else if (kind === "image") {
      const c = mirror(snap.x + snap.w / 2, snap.y + snap.h / 2);
      ref.x = c.x - snap.w / 2; ref.y = c.y - snap.h / 2;
      ref.w = snap.w; ref.h = snap.h;
      ref.rot = -(snap.rot || 0);
      ref.flipX = axis === "x" ? !snap.flipX : snap.flipX;
      ref.flipY = axis === "y" ? !snap.flipY : snap.flipY;
    } else if (kind === "text") {
      const r = mirror(snap.x, snap.y);
      ref.x = r.x; ref.y = r.y;
    } else { // tape
      const c = mirror(snap.x + snap.w / 2, snap.y + snap.h / 2);
      ref.x = c.x - snap.w / 2; ref.y = c.y - snap.h / 2;
      ref.w = snap.w; ref.h = snap.h;
    }
  });
}

function runSelectionTransform(fn) {
  if (!sel.items.length) return;
  const b = selBounds(); if (!b) return;
  const pivot = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  const snaps = sel.items.map(it => snapshotItem(it.kind, it.ref));
  fn(pivot, snaps);
  const items = sel.items.map((it, i) => ({ kind: it.kind, ref: it.ref, before: snaps[i], after: snapshotItem(it.kind, it.ref) }));
  pushUndo({ op: "transform", items });
  bumpPages(selBounds()?.y1 ?? 0);
  markDirty(); needsDraw = true; syncUI();
}
function flipSelection(axis) {
  runSelectionTransform((pivot, snaps) => applyGroupFlip(sel.items, snaps, pivot, axis));
}
function rotateSelection90() {
  runSelectionTransform((pivot, snaps) => applyGroupTransform(sel.items, snaps, pivot, 1, Math.PI / 2));
}
function strokeBB(s) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of s.pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  const m = s.w + 4;
  return { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
}

/* ---------------- selection ---------------- */
