"use strict";
function evtPos(e) {
  const r = wrap.getBoundingClientRect();
  return { px: e.clientX - r.left, py: e.clientY - r.top };
}
function evtWorld(e) {
  const { px, py } = evtPos(e);
  // With pressureEnabled off (File menu), every point reports the same neutral 0.5 regardless of
  // actual stylus pressure -- same fallback value already used for pressure-less input (mouse,
  // touch), which is what makes those draw at a flat medium width today.
  const p = pressureEnabled && e.pressure && e.pressure > 0 ? e.pressure : 0.5;
  return { x: wx(px), y: wy(py), p };
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

  // Lasso is excluded: there Ctrl+click means "add to selection" (see the lasso branch below),
  // which would otherwise be eaten by this audio-seek shortcut on any notebook that has audio.
  if ((e.ctrlKey || e.metaKey) && audio.totalMs > 0 && V.tool !== "lasso" && V.tool !== "tape" && V.tool !== "timerObj" && V.tool !== "stopwatchObj") {
    const s = strokeAt(w.x, w.y);
    if (s && s.t != null) { seekAudio(s.t); startPlayback(); return; }
  }

  switch (V.tool) {
    case "pen": case "hl":
      curStroke = {
        tool: V.tool, color: V.colorHex, w: V.width,
        pts: [{ x: w.x, y: w.y, p: w.p }],
        t: audio.rec ? recNowMs() : null, del: false, bb: null, layer: currentLayerId(),
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
    case "timerObj": case "stopwatchObj": {
      const t = timerObjAt(w.x, w.y);
      if (t && e.altKey) { t.del = true; pushUndo({ op: "del", items: [{ kind: "timer", ref: t }] }); markDirty(); break; }
      drag = { mode: "timerObjMaybe", x0: w.x, y0: w.y, hit: t, newMode: V.tool === "timerObj" ? "down" : "up" };
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
      if (hit && hit.mode === "scaleAxis") {
        const ed = hit.edge;
        const along = ed.axis === "x";
        // The far edge is what stays put; the other axis keeps the centre line it already had, so
        // the selection grows out of the side you grabbed and nowhere else.
        drag = {
          mode: "scaleAxis", axis: ed.axis,
          pivot: along ? { x: ed.opp, y: hs.pivot.y } : { x: hs.pivot.x, y: ed.opp },
          snaps: sel.items.map(it => snapshotItem(it.kind, it.ref)),
          startDist: Math.max(1, Math.abs((along ? w.x : w.y) - ed.opp)),
        };
        break;
      }
      const additive = e.ctrlKey || e.metaKey;
      const b = selBounds();
      // With Ctrl held, a click inside the selection box must still be able to toggle the item
      // under the cursor back OUT of the selection, so it deliberately skips the drag-to-move
      // branch that would otherwise swallow it.
      if (!additive && b && w.x > b.x0 - 10 && w.x < b.x1 + 10 && w.y > b.y0 - 10 && w.y < b.y1 + 10) {
        // The bounds at pointerdown, so every move re-derives the snapped position from the RAW
        // pointer offset. Applying snap corrections incrementally instead would leave the
        // selection permanently offset from the pointer by however much it had snapped so far.
        drag = { mode: "selMove", x0: w.x, y0: w.y, dx: 0, dy: 0, box0: b };
      } else {
        if (!additive) clearSelection(); // Ctrl builds on what's already picked
        drag = { mode: "lassoNew", additive, rect: e.shiftKey, partial: e.altKey, downPx: px, downPy: py, x0: w.x, y0: w.y, moved: false };
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
      // brk marks where the pen came down, i.e. a gap in the trail rather than a continuation of
      // it — see drawLaser(). Without it, lifting the pen and starting again somewhere else
      // before the old trail has faded draws a line straight across the gap.
      laser.push({ x: w.x, y: w.y, t: performance.now(), brk: true });
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
      cv.style.cursor = !hit ? "default"
        : hit.mode === "scale" ? hit.corner.cursor
        : hit.mode === "scaleAxis" ? hit.edge.cursor
        : "grab";
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
        // Carries drag.pointerId forward — without it, this fresh object loses the tag pointerdown
        // gave it (see line ~141), and the very next pointermove's owner check (line ~154) treats
        // it as belonging to a different pointer and silently drops every further move for the
        // rest of the drag, freezing the tape's live preview right at the threshold-crossing size.
        drag = { mode: "tapeNew", x0: drag.x0, y0: drag.y0, pointerId: drag.pointerId };
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
      const rawDx = w.x - drag.x0, rawDy = w.y - drag.y0;
      const b = drag.box0;
      // Alt drags free, the usual escape hatch for when the guide is in the way of what you want.
      const snap = e.altKey ? { dx: 0, dy: 0 } : pageSnapOffset({
        x0: b.x0 + rawDx, y0: b.y0 + rawDy, x1: b.x1 + rawDx, y1: b.y1 + rawDy,
      });
      const wantDx = rawDx + snap.dx, wantDy = rawDy + snap.dy;
      sel.items.forEach(it => shiftObject(it.ref, it.kind, wantDx - drag.dx, wantDy - drag.dy));
      drag.dx = wantDx; drag.dy = wantDy;
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
    case "scaleAxis": {
      const w = evtWorld(e);
      const along = drag.axis === "x";
      const dist = Math.abs((along ? w.x : w.y) - (along ? drag.pivot.x : drag.pivot.y));
      // Shift is the escape hatch back to a uniform scale, for when you started on a side handle
      // and then decided you wanted the whole thing bigger.
      const k = Math.max(0.08, Math.min(12, dist / drag.startDist));
      const f = e.shiftKey ? k : (along ? { x: k, y: 1 } : { x: 1, y: k });
      applyGroupTransform(sel.items, drag.snaps, drag.pivot, f, 0);
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
      if (drag.hit) { drag.hit.revealed = !drag.hit.revealed; markDirty(); invalidateCleanMarker(); } // not undo-tracked
      else createTapeAt(drag.x0, drag.y0);
      break;
    case "timerObjMaybe": {
      // No drag-to-size for these (fixed chip size) — moving past the tap threshold just cancels
      // the gesture instead of creating/toggling anything, rather than trying to interpret a drag.
      if (Math.hypot(w.x - drag.x0, w.y - drag.y0) > 6) break;
      if (drag.hit) {
        if (timerObjZone(drag.hit, w.x) === "reset") resetTimerObj(drag.hit);
        else toggleTimerObj(drag.hit);
      } else {
        createTimerObjAt(drag.x0, drag.y0, drag.newMode);
      }
      break;
    }
    case "tapeNew": {
      const x = Math.min(drag.x0, w.x), y = Math.min(drag.y0, w.y);
      const tw = Math.abs(w.x - drag.x0), th = Math.abs(w.y - drag.y0);
      if (tw > 10 && th > 8) {
        const t = { x, y, w: tw, h: th, color: tapeDefaults.color, revealed: false, del: false, layer: currentLayerId() };
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
        // Ctrl/Cmd+click adds to (or removes from) the selection instead of replacing it, the
        // usual modifier for this everywhere else. Ctrl+click on empty space deliberately keeps
        // what's already selected -- with a plain click still one keystroke away, having a
        // slightly-missed ctrl+click wipe a carefully built-up selection would be the worse
        // failure. Matched by pointerdown's own ctrl handling so the click isn't consumed there.
        if (drag.additive) {
          if (picked) {
            // A group toggles as one thing: ctrl+clicking a member of an already-selected group
            // takes the whole group back out, rather than leaving the rest of it behind.
            const mates = expandToGroups([picked]);
            const already = sel.items.some(it => it.ref === picked.ref);
            if (already) sel.items = sel.items.filter(it => !mates.some(m => m.ref === it.ref));
            else for (const m of mates) if (!sel.items.some(it => it.ref === m.ref)) sel.items.push(m);
          }
        } else {
          sel.items = picked ? expandToGroups([picked]) : [];
        }
        sel.shape = null;
        // A click inside a table marks the cell the toolbar's row/column buttons act on, without
        // opening an editor — double-click still does that. Otherwise "insert below this row"
        // would only ever be reachable by typing in a cell first and then clicking away.
        if (picked && picked.kind === "table") tableFocusAt(picked.ref, w.x, w.y);
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
    case "rotate": case "scale": case "scaleAxis": {
      // Read off `drag` now: it's cleared below, and the commit can run a frame or two later.
      const snaps = drag.snaps, picked = sel.items.slice();
      const commit = () => {
        const items = picked.map((it, i) => ({ kind: it.kind, ref: it.ref, before: snaps[i], after: snapshotItem(it.kind, it.ref) }));
        pushUndo({ op: "transform", items });
        bumpPages(selBounds()?.y1 ?? 0);
        markDirty();
      };
      // A graph stretched one way is redrawn at its new proportions instead of being left as a
      // smeared picture. Decoding the new SVG is asynchronous, and it has to land BEFORE the
      // "after" snapshot is taken — otherwise one undo would put the shape back and leave the
      // redrawn artwork sitting in it.
      if (drag.mode === "scaleAxis" && refitStretchedGraph(picked, commit)) break;
      commit();
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
  clampScroll(true); clampScrollX();
  needsDraw = true;
}

// Windows treats a stylus "press and hold" as a synthesized right-click by default (its own Pen &
// Touch setting, separate from any browser touch-gesture handling) -- without this, that shows the
// browser's native context menu (with Cut/Copy/Paste) right in the middle of drawing. Suppressed
// unconditionally; InkPad has no legitimate use for a right-click context menu on the canvas itself.
wrap.addEventListener("contextmenu", e => e.preventDefault());

wrap.addEventListener("wheel", e => {
  e.preventDefault();
  const { px, py } = evtPos(e);
  if (e.ctrlKey || e.metaKey) {
    setZoom(V.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), px, py);
  } else {
    V.scroll += (e.deltaY / V.zoom);
    if (e.deltaX) { V.scrollX += (e.deltaX / V.zoom); clampScrollX(); }
    clampScroll(true); needsDraw = true; syncUI();
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
    if (s.del || !isLayerVisible(s.layer)) continue;
    if (x < s.bb.x0 - r || x > s.bb.x1 + r || y < s.bb.y0 - r || y > s.bb.y1 + r) continue;
    for (let j = 0; j + 1 < s.pts.length; j++)
      if (distToSeg(x, y, s.pts[j], s.pts[j + 1]) < r + s.w) return s;
  }
  return null;
}
function tapeAt(x, y) {
  for (let i = doc.tapes.length - 1; i >= 0; i--) {
    const t = doc.tapes[i];
    if (!t.del && isLayerVisible(t.layer) && x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h) return t;
  }
  return null;
}
// A plain click (no meaningful drag — see "tapeMaybe" in endPointer) used to just do nothing;
// now it drops a tape at tapeDefaults' size, centered on the click point, same click-to-place
// idiom as createTimerObjAt below.
function createTapeAt(cx, cy) {
  const w = tapeDefaults.w, h = tapeDefaults.h;
  const t = { x: cx - w / 2, y: cy - h / 2, w, h, color: tapeDefaults.color, revealed: false, del: false, layer: currentLayerId() };
  doc.tapes.push(t);
  pushUndo({ op: "add", items: [{ kind: "tape", ref: t }] });
  bumpPages(t.y + t.h); markDirty(); needsDraw = true;
}

/* ---------------- embedded timer/stopwatch objects ---------------- */
// Chip size and default duration come from timerObjDefaults (js/state.js) — user-editable via
// the Settings dialog. These are click-to-place at that default size (then movable/resizable
// afterward like any other object via lasso-select), not drag-to-size like tape.
function timerObjAt(x, y) {
  for (let i = doc.timers.length - 1; i >= 0; i--) {
    const t = doc.timers[i];
    if (!t.del && isLayerVisible(t.layer) && x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h) return t;
  }
  return null;
}
// Which part of the chip a world-space x falls in — "reset" is the narrow strip at the right edge
// (see timerObjResetWidth in render.js, shared so the drawn divider and this hit-test always agree).
function timerObjZone(t, wx) {
  return wx >= t.x + t.w - timerObjResetWidth(t) ? "reset" : "body";
}
function toggleTimerObj(t) {
  if (t.running) {
    t.baseMs = timerObjElapsedMs(t); t.running = false;
  } else {
    if (t.mode === "down" && t.baseMs >= t.durationMs) t.baseMs = 0; // restart a finished countdown
    t.startWall = performance.now(); t.running = true;
  }
  markDirty(); invalidateCleanMarker(); needsDraw = true; // not undo-tracked
}
function resetTimerObj(t) {
  t.running = false; t.baseMs = 0;
  markDirty(); invalidateCleanMarker(); needsDraw = true; // not undo-tracked
}
// Timer (countdown) asks for a duration first since there's a real target to hit; Stopwatch has
// nothing to configure, so it's just dropped in place immediately, already at 0:00.
async function createTimerObjAt(cx, cy, mode) {
  let durationMs = timerObjDefaults.durationMs;
  if (mode === "down") {
    const ms = await promptTimerDuration(durationMs);
    if (ms == null) return;
    durationMs = ms;
  }
  const w = timerObjDefaults.w, h = timerObjDefaults.h;
  const t = { x: cx - w / 2, y: cy - h / 2, w, h, mode, durationMs, running: false, baseMs: 0, startWall: null, del: false, layer: currentLayerId() };
  doc.timers.push(t);
  pushUndo({ op: "add", items: [{ kind: "timer", ref: t }] });
  bumpPages(t.y + t.h); markDirty(); needsDraw = true;
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
  // Text boxes and images (including imported PDF pages) are intentionally left alone here —
  // the eraser is for freehand ink; the Text tool (click in, select-all + delete) or lasso-select +
  // delete are the intended ways to remove those instead.
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
    if (s.del || !isLayerVisible(s.layer)) continue;
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
    if (s.del || !isLayerVisible(s.layer)) continue;
    const { insideRuns, outsideRuns } = splitStrokeByTest(s, inside);
    if (!insideRuns.length) continue;
    if (!outsideRuns.length) { picked.push({ kind: "stroke", ref: s }); continue; }
    s.del = true;
    pushUndo({ op: "del", items: [{ kind: "stroke", ref: s }] });
    for (const r of insideRuns) {
      if (r.length < 2 || pathLen(r) < 2.5) continue;
      const ns = { ...s, del: false, pts: r.map(pt => ({ ...pt })), t: null };
      // The piece being lifted out leaves the group behind. The outside runs below keep it: they
      // are the remainder, still sitting where the grouped object was, so the group survives the
      // cut minus the bit that was taken out of it.
      delete ns.grp;
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
      if (s.del || !isLayerVisible(s.layer)) continue;
      let inN = 0, tot = 0;
      const step = Math.max(1, Math.floor(s.pts.length / 14));
      for (let i = 0; i < s.pts.length; i += step) { tot++; if (pointInPoly(s.pts[i].x, s.pts[i].y, poly)) inN++; }
      if (tot && inN * 2 > tot) sel.items.push({ kind: "stroke", ref: s });
    }
  }
  for (const t of doc.tapes)
    if (!t.del && isLayerVisible(t.layer) && pointInPoly(t.x + t.w / 2, t.y + t.h / 2, poly)) sel.items.push({ kind: "tape", ref: t });
  for (const t of doc.texts) {
    if (t.del || !isLayerVisible(t.layer)) continue;
    const b = textBB(t);
    if (pointInPoly((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, poly)) sel.items.push({ kind: "text", ref: t });
  }
  for (const im of doc.images)
    if (!im.del && isLayerVisible(im.layer) && pointInPoly(im.x + im.w / 2, im.y + im.h / 2, poly)) sel.items.push({ kind: "image", ref: im });
  for (const t of doc.timers)
    if (!t.del && isLayerVisible(t.layer) && pointInPoly(t.x + t.w / 2, t.y + t.h / 2, poly)) sel.items.push({ kind: "timer", ref: t });
  for (const t of doc.tables)
    if (!t.del && isLayerVisible(t.layer) && pointInPoly(t.x + t.w / 2, t.y + t.h / 2, poly)) sel.items.push({ kind: "table", ref: t });
  // A lasso that catches part of a group takes all of it. Anything else would let a lasso quietly
  // tear a group in half — and the very next drag would move the caught half away from the rest,
  // which is the one thing grouping exists to prevent. The split lasso's own fragments have
  // already been untagged (see finishLassoSplit), so they don't drag the original group back in.
  sel.items = expandToGroups(sel.items);
}

function pickObjectAt(x, y) {
  const t = tapeAt(x, y);
  if (t) return { kind: "tape", ref: t };
  for (let i = doc.texts.length - 1; i >= 0; i--) {
    const q = doc.texts[i];
    if (q.del || !isLayerVisible(q.layer)) continue;
    if (textHitTest(q, x, y)) return { kind: "text", ref: q };
  }
  const s = strokeAt(x, y);
  if (s) return { kind: "stroke", ref: s };
  for (let i = doc.images.length - 1; i >= 0; i--) {
    const im = doc.images[i];
    if (!im.del && isLayerVisible(im.layer) && pointInImage(im, x, y)) return { kind: "image", ref: im };
  }
  const tm = timerObjAt(x, y);
  if (tm) return { kind: "timer", ref: tm };
  // Last: a table is a large filled rectangle, so hit-testing it before the smaller things drawn
  // on top of it would make anything written over a table unselectable.
  const tb = tableAt(x, y);
  if (tb) return { kind: "table", ref: tb };
  return null;
}
function deleteSelection() {
  if (!sel.items.length) return;
  sel.items.forEach(it => it.ref.del = true);
  pushUndo({ op: "del", items: sel.items.slice() });
  clearSelection(); markDirty();
}
/* ---------------- stacking order ----------------
   Objects are drawn kind by kind — images, tables, highlighter, pen, text, tape, timers — and
   within each kind in array order (see render()). So this reorders an object among others OF ITS
   OWN KIND, which is exactly what overlapping pasted pictures need.

   It deliberately cannot lift an image above ink. That ordering is fixed and worth keeping: writing
   on top of an imported page is the main thing images are here for, and a document where some ink
   had silently fallen behind a picture would be much harder to explain than this limit. Use layers
   when you need something to sit above a whole class of objects.

   A selection spanning several kinds is restacked within each of them independently. */
const KIND_ARRAY = { stroke: "strokes", tape: "tapes", text: "texts", image: "images", timer: "timers", table: "tables" };
/* dir: +1 towards the front (later in the array is drawn on top), -1 towards the back.
   toEnd: all the way rather than one step. */
function reorderWithin(arr, chosen, dir, toEnd) {
  // Deleted objects still occupy their slot but draw nothing, so they're lifted out of the
  // reckoning and put straight back — otherwise a step "forward" could be spent swapping past an
  // erased stroke, and the button would look broken.
  const slots = [], order = [];
  arr.forEach((o, i) => { if (!o.del) { slots.push(i); order.push(o); } });
  const was = order.slice();
  if (toEnd) {
    const rest = order.filter(o => !chosen.has(o));
    const move = order.filter(o => chosen.has(o));
    const next = dir > 0 ? rest.concat(move) : move.concat(rest);
    if (next.every((o, i) => o === was[i])) return false;
    next.forEach((o, i) => { arr[slots[i]] = o; });
    return true;
  }
  // One step, as a block: a run of selected objects keeps its own internal order and hops the
  // single unselected neighbour beyond it.
  let moved = false;
  if (dir > 0) {
    for (let i = order.length - 2; i >= 0; i--) {
      if (chosen.has(order[i]) && !chosen.has(order[i + 1])) {
        [order[i], order[i + 1]] = [order[i + 1], order[i]]; moved = true;
      }
    }
  } else {
    for (let i = 1; i < order.length; i++) {
      if (chosen.has(order[i]) && !chosen.has(order[i - 1])) {
        [order[i], order[i - 1]] = [order[i - 1], order[i]]; moved = true;
      }
    }
  }
  if (moved) order.forEach((o, i) => { arr[slots[i]] = o; });
  return moved;
}
function restackSelection(dir, toEnd) {
  if (!sel.items.length) return;
  const byKind = new Map();
  for (const it of sel.items) {
    const key = KIND_ARRAY[it.kind];
    if (!key) continue;
    if (!byKind.has(key)) byKind.set(key, new Set());
    byKind.get(key).add(it.ref);
  }
  const changes = [];
  for (const [key, chosen] of byKind) {
    const arr = doc[key];
    const before = arr.slice();
    if (reorderWithin(arr, chosen, dir, toEnd)) changes.push({ key, before, after: arr.slice() });
  }
  if (!changes.length) return; // already as far as it goes — no undo entry for a no-op
  pushUndo({ op: "reorder", changes });
  markDirty(); needsDraw = true;
}
/* ---------------- grouping ----------------
   Both directions are the same operation — write a `grp` onto every selected object — so they
   share one undo entry shape recording what each item's tag was before. */
function applyGroupTags(items, id) {
  items.forEach(it => { if (id) it.ref.grp = id; else delete it.ref.grp; });
}
function commitGroupChange(items, before, id) {
  pushUndo({ op: "group", items: items.map((it, i) => ({ ref: it.ref, before: before[i], after: id || undefined })) });
  markDirty(); needsDraw = true;
}
function groupSelection() {
  if (sel.items.length < 2) return;
  const items = sel.items.slice();
  const before = items.map(it => it.ref.grp);
  const id = newGroupId();
  applyGroupTags(items, id);
  commitGroupChange(items, before, id);
}
function ungroupSelection() {
  // Anything tagged at all, not just a clean whole group — ungrouping a mixed selection should
  // free the parts of it that were grouped rather than doing nothing at all.
  const items = sel.items.filter(it => it.ref.grp);
  if (!items.length) return;
  const before = items.map(it => it.ref.grp);
  applyGroupTags(items, null);
  commitGroupChange(items, before, null);
}
// One key for both, the way Ctrl+G / Ctrl+Shift+G work everywhere else that has grouping.
function toggleGroupSelection() {
  if (selGroupId()) ungroupSelection(); else groupSelection();
}
/* ---------------- Copy / Paste ---------------- */
