"use strict";
/* ============================================================================
   Tables as a real document object, not a picture of one.

   Every other generated diagram is placed as an SVG image: fixed once made, re-editable only by
   reopening the dialog. A table can't work that way, because the point of putting one on a
   worksheet is writing IN it — during the lesson, in front of the class, one cell at a time. So
   doc.tables is its own object kind alongside strokes/texts/images/tapes/timers: drawn on the
   canvas, clicked into cell by cell, and moved, scaled, copied, undone and exported as one thing.

   Geometry is stored as column widths and row heights in world units rather than as a single
   w/h, so a scale drag can multiply them and a long heading can widen just its own column. w and
   h are kept in sync with their totals (tableSyncSize) because the generic selection code —
   selBounds, shiftObject, snapshotItem, the lasso — reads x/y/w/h off any object it doesn't
   recognise, and that is most of what makes a new kind cheap to add.
   ========================================================================== */

const TABLE_MIN_COL = 26, TABLE_MIN_ROW = 18;
const TABLE_DEFAULTS = {
  headFill: "#DCE9F5", stripeFill: "", gridColour: "#2D4E86", textColour: "#1F2933",
};
// Cell padding and line height as multiples of the font size, so a table scales as one piece.
const tablePadX = t => t.fontSize * 0.55;
const tableRowFor = t => Math.round(t.fontSize * 2.1);

function tableSyncSize(t) {
  t.w = t.colW.reduce((a, b) => a + b, 0);
  t.h = t.rowH.reduce((a, b) => a + b, 0);
  return t;
}
function makeTable(opts) {
  const o = opts || {};
  const rows = Math.max(1, Math.min(40, o.rows || 3));
  const cols = Math.max(1, Math.min(20, o.cols || 3));
  const fontSize = o.fontSize || 20;
  const t = {
    x: o.x || 0, y: o.y || 0,
    cells: Array.from({ length: rows }, (_, r) =>
      Array.from({ length: cols }, (_, c) => (o.cells && o.cells[r] && o.cells[r][c]) || "")),
    // How many leading rows/columns are headings. Two rows of heading is what a sample-space
    // table needs for its spanning "1st" strip, so this is a count rather than a flag.
    headRows: o.headRows == null ? 1 : o.headRows,
    headCols: o.headCols == null ? 1 : o.headCols,
    spans: o.spans || {},           // "r,c" -> { rs, cs }: this cell swallows rs rows by cs columns
    // Cells that aren't there at all — no border, no fill, not clickable. A sample-space table's
    // top-left corner is genuinely empty space in the textbook, not a blank cell with a box round
    // it, and an empty cell reads as "you forgot to fill this in".
    hidden: o.hidden || {},         // "r,c" -> true
    fontSize,
    headFill: o.headFill || TABLE_DEFAULTS.headFill,
    stripeFill: o.stripeFill || "",
    gridColour: o.gridColour || TABLE_DEFAULTS.gridColour,
    textColour: o.textColour || TABLE_DEFAULTS.textColour,
    colW: null, rowH: null, del: false, layer: o.layer != null ? o.layer : currentLayerId(),
  };
  // Saved widths are only trusted when they still describe this many columns; otherwise measure
  // afresh, or a mismatched array would leave every column at zero and the table invisible.
  const keepW = o.colW && o.colW.length === cols && o.colW.every(v => Number.isFinite(v) && v > 0);
  const keepH = o.rowH && o.rowH.length === rows && o.rowH.every(v => Number.isFinite(v) && v > 0);
  t.colW = keepW ? o.colW.slice() : new Array(cols).fill(0);
  t.rowH = keepH ? o.rowH.slice() : new Array(rows).fill(tableRowFor(t));
  if (!keepW) tableAutoFitCols(t);
  return tableSyncSize(t);
}
const tableRows = t => t.cells.length;
const tableCols = t => (t.cells[0] || []).length;
const tableIsHead = (t, r, c) => r < t.headRows || c < t.headCols;
const tableSpanAt = (t, r, c) => t.spans[r + "," + c] || null;
const tableHidden = (t, r, c) => !!t.hidden[r + "," + c];
// The single test every drawing, hit-testing and export loop uses: is there a cell to deal with
// here at all, or is it hidden or already swallowed by a span?
const tableSkip = (t, r, c) => tableHidden(t, r, c) || tableCovered(t, r, c);
// True when this cell is underneath a span belonging to some other cell, so it must not be drawn
// or clicked. Scanning is cheap next to the alternative of a second parallel grid to keep in sync.
function tableCovered(t, r, c) {
  for (const key in t.spans) {
    const [sr, sc] = key.split(",").map(Number);
    const { rs, cs } = t.spans[key];
    if (r >= sr && r < sr + rs && c >= sc && c < sc + cs && !(r === sr && c === sc)) return true;
  }
  return false;
}
/* ---------------- what a cell draws ----------------
   A cell is a miniature text box, inline maths and all: a probability table whose cells can't hold
   a fraction is a table you can't teach probability with. It uses the same raster spans text boxes
   use (js/math-typeset.js) rather than the vector labels shapes use — one cache for both, and the
   PDF and SVG exporters already know how to place a span.

   Laid out once into a left-to-right list of pieces so the canvas, the PDF and the SVG each draw
   the same arrangement with their own primitives, instead of three drifting copies of this loop.
   `measure` lets the PDF path substitute its own font metrics; everything else measures on canvas. */
const tableInk = (t, head) => (head ? t.gridColour : t.textColour);
function tableMeasurer(t, head) {
  measureCtx.font = `${head ? "bold " : ""}${t.fontSize}px ${FONT_STACKS[DEFAULT_FONT_KEY].css}`;
  return s => measureCtx.measureText(s).width;
}
function tableCellLayout(t, r, c, measure) {
  const text = String(t.cells[r][c] || "");
  const head = tableIsHead(t, r, c);
  const m = measure || tableMeasurer(t, head);
  if (!text) return { pieces: [], width: 0 };
  if (!lineNeedsMathPass(text)) return { pieces: [{ text, x: 0, w: m(text) }], width: m(text) };
  const pieces = [];
  let x = 0;
  for (const run of splitMathRuns(text)) {
    if (run.text !== undefined) {
      if (!run.text) continue;
      const w = m(run.text);
      pieces.push({ text: run.text, x, w });
      x += w;
      continue;
    }
    const span = getMathSpan(run.math, mathSizePx(t.fontSize), tableInk(t, head));
    if (span && span.w && span.img && !span.failed) { pieces.push({ span, x, w: span.w }); x += span.w; continue; }
    // Still rasterizing, or KaTeX failed: show the source rather than leave a hole in the table.
    const raw = `$${run.math}$`;
    const w = m(raw);
    pieces.push({ text: raw, x, w });
    x += w;
  }
  return { pieces, width: x };
}
// Every math span this table needs. The export paths must have them all resolved before they can
// measure anything, and a formula typed into a cell only knows its width once it has rendered.
function tableMathJobs(t) {
  const jobs = [];
  for (let r = 0; r < tableRows(t); r++) {
    for (let c = 0; c < tableCols(t); c++) {
      if (tableSkip(t, r, c)) continue;
      const text = String(t.cells[r][c] || "");
      if (!lineNeedsMathPass(text)) continue;
      const ink = tableInk(t, tableIsHead(t, r, c));
      for (const run of splitMathRuns(text))
        if (run.math !== undefined) jobs.push(getMathSpanAsync(run.math, mathSizePx(t.fontSize), ink));
    }
  }
  return jobs;
}
const tableWarmMath = t => Promise.all(tableMathJobs(t));
// Re-fits once every formula in the table has a rendered width. Until then a cell containing maths
// measures as its LaTeX source, which is far wider than what it draws as.
function tableRefitAfterMath(t, then) {
  if (!tableMathJobs(t).length) return;
  tableWarmMath(t).then(() => {
    tableAutoFitCols(t);
    needsDraw = true;
    if (then) then();
  });
}

// Each column at least as wide as its widest entry. Only ever grows a column past the minimum, so
// a hand-widened column isn't snapped back the next time a cell is typed into.
function tableAutoFitCols(t) {
  for (let c = 0; c < tableCols(t); c++) {
    let wide = TABLE_MIN_COL;
    for (let r = 0; r < tableRows(t); r++) {
      if (tableSkip(t, r, c)) continue;
      // A cell spanning several columns shouldn't force all of its width onto the first one.
      const span = tableSpanAt(t, r, c);
      const share = span && span.cs > 1 ? span.cs : 1;
      wide = Math.max(wide, tableCellLayout(t, r, c).width / share + tablePadX(t) * 2);
    }
    t.colW[c] = Math.max(t.colW[c] || 0, wide);
  }
  tableSyncSize(t);
}
/* Changing the text size has to take the geometry with it, or a table set to 30px keeps the column
   widths it had at 20 and every entry overflows. Proportional first (so a hand-widened column stays
   proportionally wide), then the usual fit to catch anything the bigger glyphs no longer fit in. */
function tableSetFontSize(t, size) {
  size = Math.max(6, Math.min(200, size));
  if (!Number.isFinite(size) || Math.abs(size - t.fontSize) < 1e-6) return t;
  const k = size / t.fontSize;
  t.fontSize = size;
  t.colW = t.colW.map(v => Math.max(TABLE_MIN_COL, v * k));
  t.rowH = t.rowH.map(v => Math.max(TABLE_MIN_ROW, v * k));
  tableAutoFitCols(t);
  return tableSyncSize(t);
}
/* ---------------- adding and removing rows and columns ----------------
   The cells are the easy half. The awkward half is everything keyed by position: a span says "the
   cell at 0,2 swallows the three columns to its right", a hidden entry says "there is no cell at
   0,1 at all", and both are keyed "r,c". A line inserted in the middle has to shift every key after
   it, stretch any span it lands inside, and leave the rest alone — so the maps are rebuilt rather
   than patched in place. `axis` is 0 for rows and 1 for columns; the two are exactly symmetric. */
function tableRemap(t, axis, at, delta) {
  const extent = axis === 0 ? "rs" : "cs";
  const spans = {}, hidden = {};
  for (const key in t.spans) {
    const idx = key.split(",").map(Number);
    const s = t.spans[key], i = idx[axis], len = s[extent];
    if (delta < 0 && i === at && len === 1) continue; // the span's own cell went with the line
    // Straddling the change stretches or shrinks the span; sitting after it just moves it along.
    const covers = delta > 0 ? (i < at && i + len > at) : (i <= at && i + len > at);
    idx[axis] = (i > at || (delta > 0 && i === at)) ? i + delta : i;
    spans[idx.join(",")] = { rs: s.rs, cs: s.cs, [extent]: Math.max(1, len + (covers ? delta : 0)) };
  }
  for (const key in t.hidden) {
    const idx = key.split(",").map(Number);
    const i = idx[axis];
    if (delta < 0 && i === at) continue;
    idx[axis] = (i > at || (delta > 0 && i === at)) ? i + delta : i;
    hidden[idx.join(",")] = true;
  }
  t.spans = spans;
  t.hidden = hidden;
}
function tableInsertRow(t, at) {
  at = Math.max(0, Math.min(tableRows(t), at));
  t.cells.splice(at, 0, new Array(tableCols(t)).fill(""));
  t.rowH.splice(at, 0, t.rowH[Math.max(0, at - 1)] || tableRowFor(t));
  // A line inserted INSIDE the heading block is itself a heading; one at its boundary is the first
  // body line. That is what makes "add a row" at the top of a two-way table do the obvious thing.
  if (at < t.headRows) t.headRows++;
  tableRemap(t, 0, at, 1);
  return tableSyncSize(t);
}
function tableDeleteRow(t, at) {
  if (tableRows(t) <= 1) return t;
  at = Math.max(0, Math.min(tableRows(t) - 1, at));
  t.cells.splice(at, 1);
  t.rowH.splice(at, 1);
  if (at < t.headRows) t.headRows--;
  tableRemap(t, 0, at, -1);
  return tableSyncSize(t);
}
function tableInsertCol(t, at) {
  at = Math.max(0, Math.min(tableCols(t), at));
  t.cells.forEach(row => row.splice(at, 0, ""));
  // Matched to the column beside it, so a new column arrives the same size as its neighbours
  // rather than as a sliver you then have to type something into to widen.
  t.colW.splice(at, 0, t.colW[Math.max(0, at - 1)] || TABLE_MIN_COL);
  if (at < t.headCols) t.headCols++;
  tableRemap(t, 1, at, 1);
  return tableSyncSize(t);
}
function tableDeleteCol(t, at) {
  if (tableCols(t) <= 1) return t;
  at = Math.max(0, Math.min(tableCols(t) - 1, at));
  t.cells.forEach(row => row.splice(at, 1));
  t.colW.splice(at, 1);
  if (at < t.headCols) t.headCols--;
  tableRemap(t, 1, at, -1);
  return tableSyncSize(t);
}
// Grows or shrinks to a given size from whichever end has to give, keeping everything already
// typed. Used by the dialog's row/column counts, so changing them doesn't wipe the preview.
function tableResizeTo(t, rows, cols) {
  rows = Math.max(1, Math.min(40, rows | 0));
  cols = Math.max(1, Math.min(20, cols | 0));
  while (tableRows(t) > rows) tableDeleteRow(t, tableRows(t) - 1);
  while (tableRows(t) < rows) tableInsertRow(t, tableRows(t));
  while (tableCols(t) > cols) tableDeleteCol(t, tableCols(t) - 1);
  while (tableCols(t) < cols) tableInsertCol(t, tableCols(t));
  return t;
}

// World-space rectangle of one cell, spans included.
function tableCellRect(t, r, c) {
  let x = t.x, y = t.y;
  for (let i = 0; i < c; i++) x += t.colW[i];
  for (let i = 0; i < r; i++) y += t.rowH[i];
  const span = tableSpanAt(t, r, c) || { rs: 1, cs: 1 };
  let w = 0, h = 0;
  for (let i = c; i < Math.min(tableCols(t), c + span.cs); i++) w += t.colW[i];
  for (let i = r; i < Math.min(tableRows(t), r + span.rs); i++) h += t.rowH[i];
  return { x, y, w, h };
}
function tableCellAtPoint(t, wx, wy) {
  if (wx < t.x || wy < t.y || wx > t.x + t.w || wy > t.y + t.h) return null;
  for (let r = 0; r < tableRows(t); r++) {
    for (let c = 0; c < tableCols(t); c++) {
      if (tableSkip(t, r, c)) continue;
      const q = tableCellRect(t, r, c);
      if (wx >= q.x && wx <= q.x + q.w && wy >= q.y && wy <= q.y + q.h) return { r, c };
    }
  }
  return null;
}
function tableAt(wx, wy) {
  for (let i = doc.tables.length - 1; i >= 0; i--) {
    const t = doc.tables[i];
    if (t.del || !isLayerVisible(t.layer)) continue;
    if (wx >= t.x && wx <= t.x + t.w && wy >= t.y && wy <= t.y + t.h) return t;
  }
  return null;
}

/* ---------------- drawing ---------------- */
function drawTables() {
  for (const t of doc.tables) {
    if (t.del || !isLayerVisible(t.layer)) continue;
    drawOneTable(t);
  }
}
function drawOneTable(t) {
  const z = V.zoom;
  ctx.save();
  ctx.lineWidth = Math.max(1, 1.6 * z);
  ctx.strokeStyle = t.gridColour;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  for (let r = 0; r < tableRows(t); r++) {
    for (let c = 0; c < tableCols(t); c++) {
      if (tableSkip(t, r, c)) continue;
      const q = tableCellRect(t, r, c);
      const X = sx(q.x), Y = sy(q.y), W = q.w * z, H = q.h * z;
      const head = tableIsHead(t, r, c);
      const striped = !head && t.stripeFill && (r - t.headRows) % 2 === 1;
      ctx.fillStyle = head ? t.headFill : (striped ? t.stripeFill : "#FFFFFF");
      ctx.fillRect(X, Y, W, H);
      ctx.strokeRect(X, Y, W, H);
      const lay = tableCellLayout(t, r, c);
      if (!lay.pieces.length) continue;
      ctx.fillStyle = tableInk(t, head);
      ctx.font = `${head ? "bold " : ""}${t.fontSize * z}px ${FONT_STACKS[DEFAULT_FONT_KEY].css}`;
      // A third of the font size below the cell's middle, the same figure the PDF and SVG paths
      // use, so a cell sits identically on screen, in print and in an exported drawing.
      const base = Y + H / 2 + t.fontSize * z * 0.35;
      const left = X + W / 2 - (lay.width * z) / 2;
      // Clipped to its own cell so an over-long entry can't bleed into its neighbour — the column
      // auto-fits when the cell is committed, but a scaled-down table can still overflow.
      ctx.save();
      ctx.beginPath(); ctx.rect(X + 1, Y + 1, W - 2, H - 2); ctx.clip();
      for (const p of lay.pieces) {
        if (p.span) ctx.drawImage(p.span.img, left + p.x * z, base + p.span.baselineOffset * z, p.w * z, p.span.h * z);
        else ctx.fillText(p.text, left + p.x * z, base);
      }
      ctx.restore();
    }
  }
  // The cell a new row or column is inserted next to (see tableSelToolbarButtons). Without it the
  // toolbar's "insert below" has no visible "below what", and the answer moves as you type.
  const f = tableFocusIn(t);
  if (f && !editingTableCell) {
    const q = tableCellRect(t, f.r, f.c);
    ctx.strokeStyle = "#0F766E";
    ctx.lineWidth = 2;
    ctx.strokeRect(sx(q.x) + 1, sy(q.y) + 1, q.w * z - 2, q.h * z - 2);
  }
  ctx.restore();
}

/* ---------------- editing a cell ----------------
   A plain <input> parked over the cell in screen space, rather than reusing the canvas text
   editor: a cell is one short value with no wrapping, and Tab/Enter should walk the grid rather
   than insert anything. Committing re-fits the column so a long entry widens its own column
   instead of being clipped. */
let editingTableCell = null; // { t, r, c, before } while an input is open
/* The cell last typed into, which outlives the editor: it is what "add a row here" is relative to.
   Read through tableFocusIn so a stale one — pointing at a table that is no longer selected, or
   past the end after a delete — simply doesn't count, rather than needing to be cleared from
   everywhere a table can change. */
let tableFocus = null; // { t, r, c }
function tableFocusAt(t, wx2, wy2) {
  const at = tableCellAtPoint(t, wx2, wy2);
  tableFocus = at ? { t, r: at.r, c: at.c } : null;
  needsDraw = true;
}
function tableFocusIn(t) {
  if (!tableFocus || tableFocus.t !== t) return null;
  if (!sel.items.some(it => it.ref === t)) return null;
  if (tableFocus.r >= tableRows(t) || tableFocus.c >= tableCols(t)) return null;
  return tableFocus;
}
function tableCellEditor() {
  let el = document.getElementById("tableCellInput");
  if (el) return el;
  el = document.createElement("input");
  el.id = "tableCellInput";
  el.type = "text";
  el.autocomplete = "off";
  el.style.cssText = "position:fixed; display:none; z-index:60; text-align:center; " +
    "border:2px solid var(--accent); border-radius:3px; background:#fff; padding:0 2px; " +
    "box-sizing:border-box; font-family:inherit;";
  document.body.appendChild(el);
  el.addEventListener("keydown", e => {
    e.stopPropagation(); // the canvas keymap must not see letters typed into a cell
    if (e.key === "Escape") { e.preventDefault(); cancelTableCellEdit(); }
    else if (e.key === "Enter") { e.preventDefault(); commitTableCellEdit(e.shiftKey ? "up" : "down"); }
    else if (e.key === "Tab") { e.preventDefault(); commitTableCellEdit(e.shiftKey ? "left" : "right"); }
  });
  el.addEventListener("blur", () => { if (editingTableCell) commitTableCellEdit(null); });
  return el;
}
function startTableCellEdit(t, r, c) {
  if (tableSkip(t, r, c)) return;
  commitTableCellEdit(null);
  const el = tableCellEditor();
  editingTableCell = { t, r, c, before: tableSnapshot(t) };
  tableFocus = { t, r, c };
  const q = tableCellRect(t, r, c);
  const rect = cv.getBoundingClientRect();
  el.style.left = (rect.left + sx(q.x)) + "px";
  el.style.top = (rect.top + sy(q.y)) + "px";
  el.style.width = (q.w * V.zoom) + "px";
  el.style.height = (q.h * V.zoom) + "px";
  el.style.fontSize = Math.max(9, t.fontSize * V.zoom) + "px";
  el.style.fontWeight = tableIsHead(t, r, c) ? "bold" : "normal";
  el.style.color = tableIsHead(t, r, c) ? t.gridColour : t.textColour;
  el.style.display = "block";
  el.value = String(t.cells[r][c] || "");
  el.focus();
  el.select();
}
// Walking off the edge closes the editor rather than wrapping — wrapping from the end of a row to
// the start of the next is right in a spreadsheet, but here it reads as the cursor running away.
function tableStep(t, r, c, dir) {
  const at = { r, c };
  if (dir === "right") at.c++; else if (dir === "left") at.c--;
  else if (dir === "down") at.r++; else if (dir === "up") at.r--;
  if (at.r < 0 || at.c < 0 || at.r >= tableRows(t) || at.c >= tableCols(t)) return null;
  // Skips a cell that isn't there — a span's continuation, or the blank corner of a sample space.
  if (tableSkip(t, at.r, at.c)) return tableStep(t, at.r, at.c, dir);
  return at;
}
function commitTableCellEdit(moveDir) {
  const st = editingTableCell;
  if (!st) return;
  editingTableCell = null;
  const el = tableCellEditor();
  const next = el.value;
  el.style.display = "none";
  const changed = String(st.t.cells[st.r][st.c] || "") !== next;
  if (changed) {
    st.t.cells[st.r][st.c] = next;
    tableAutoFitCols(st.t);
    const entry = { op: "tableEdit", ref: st.t, before: st.before, after: tableSnapshot(st.t) };
    pushUndo(entry);
    markDirty();
    // A formula's width isn't known until KaTeX has rendered it, so a cell holding maths is fitted
    // again when the span lands — and this entry's "after" restamped, or redo would put back the
    // column width measured from the LaTeX source instead of from the formula it draws as.
    tableRefitAfterMath(st.t, () => { entry.after = tableSnapshot(st.t); });
  }
  needsDraw = true;
  if (moveDir) {
    const at = tableStep(st.t, st.r, st.c, moveDir);
    if (at) startTableCellEdit(st.t, at.r, at.c);
  }
}
function cancelTableCellEdit() {
  if (!editingTableCell) return;
  editingTableCell = null;
  tableCellEditor().style.display = "none";
  needsDraw = true;
}
/* One undo step per structural change, taken around whatever the caller does to the table. Reuses
   the "tableEdit" op because its snapshot already covers the whole shape of the thing — cells,
   spans, hidden corners, headings and geometry — so adding a row needs no new undo machinery. */
function tableStructureEdit(t, fn) {
  cancelTableCellEdit(); // the open editor is parked over a cell that is about to move
  const before = tableSnapshot(t);
  fn(t);
  tableAutoFitCols(t);
  if (tableFocus && tableFocus.t === t) {
    tableFocus.r = Math.min(tableFocus.r, tableRows(t) - 1);
    tableFocus.c = Math.min(tableFocus.c, tableCols(t) - 1);
  }
  pushUndo({ op: "tableEdit", ref: t, before, after: tableSnapshot(t) });
  markDirty();
  needsDraw = true;
  syncUI();
}
const selTable = () => (sel.items.length === 1 && sel.items[0].kind === "table" ? sel.items[0].ref : null);
/* The row and column controls on the floating selection toolbar (see buildSelToolbarContent).
   Anchored on the cell last typed into — the one wearing the ring — so "add a row" means "here";
   with nothing touched yet they fall back to the end of the table, which is where you want a row
   the first time you realise you need one. */
function tableSelToolbarButtons(t, mk, sepEl) {
  sepEl();
  const f = tableFocusIn(t);
  const r = f ? f.r : tableRows(t) - 1, c = f ? f.c : tableCols(t) - 1;
  mk("+Row", () => tableStructureEdit(t, tb => tableInsertRow(tb, r + 1)),
    f ? `Insert a row below row ${r + 1}` : "Add a row at the bottom");
  mk("−Row", () => tableStructureEdit(t, tb => tableDeleteRow(tb, r)),
    f ? `Delete row ${r + 1}` : "Delete the last row");
  mk("+Col", () => tableStructureEdit(t, tb => tableInsertCol(tb, c + 1)),
    f ? `Insert a column to the right of column ${c + 1}` : "Add a column on the right");
  mk("−Col", () => tableStructureEdit(t, tb => tableDeleteCol(tb, c)),
    f ? `Delete column ${c + 1}` : "Delete the last column");
}
// Everything a table edit has to be able to put back: the text, and the geometry the text moved.
function tableSnapshot(t) {
  return {
    cells: t.cells.map(row => row.slice()),
    colW: t.colW.slice(), rowH: t.rowH.slice(),
    x: t.x, y: t.y, w: t.w, h: t.h, fontSize: t.fontSize,
    headRows: t.headRows, headCols: t.headCols,
    spans: JSON.parse(JSON.stringify(t.spans)), hidden: { ...t.hidden },
  };
}
function tableRestore(t, snap) {
  t.cells = snap.cells.map(row => row.slice());
  t.colW = snap.colW.slice(); t.rowH = snap.rowH.slice();
  t.x = snap.x; t.y = snap.y; t.fontSize = snap.fontSize;
  t.headRows = snap.headRows; t.headCols = snap.headCols;
  t.spans = JSON.parse(JSON.stringify(snap.spans));
  t.hidden = { ...snap.hidden };
  tableSyncSize(t);
}
// Scaling drags the font with the geometry, so a table stays internally consistent rather than
// keeping 20px text in cells half the size (which is what the generic tape branch would do).
// An edge drag passes a different kx and ky: the columns or the rows move on their own and the
// font stays where it is, so widening a table gives its cells more room rather than bigger text.
function tableApplyScale(t, snap, cx, cy, kx, ky = kx) {
  t.fontSize = kx === ky ? Math.max(6, snap.fontSize * kx) : snap.fontSize;
  t.colW = snap.colW.map(v => Math.max(TABLE_MIN_COL * 0.4, v * kx));
  t.rowH = snap.rowH.map(v => Math.max(TABLE_MIN_ROW * 0.4, v * ky));
  tableSyncSize(t);
  t.x = cx - t.w / 2; t.y = cy - t.h / 2;
}
/* Double-click is the gesture, matching how a cell is opened everywhere else that has them, and
   leaving single-click free to select and drag the table as one object. Registered here rather
   than in input.js so everything about tables stays in one file; it runs before the canvas's own
   handlers only in the sense that it consumes the event when it lands on a table. */
cv.addEventListener("dblclick", e => {
  const w = { x: wx(e.offsetX ?? 0), y: wy(e.offsetY ?? 0) };
  const t = tableAt(w.x, w.y);
  if (!t) return;
  const at = tableCellAtPoint(t, w.x, w.y);
  if (!at) return;
  e.preventDefault();
  sel.items = [{ kind: "table", ref: t }];
  sel.shape = null;
  startTableCellEdit(t, at.r, at.c);
  needsDraw = true;
});

/* ---------------- building one from the dialog ----------------
   Three presets over the same object, because they differ only in what the cells start as:

     plain   an empty grid, the "just give me a table" case
     twoWay  the headings you type, plus a Total row and column
     sample  a sample space: both sets of outcomes as headings under a spanning "1st"/"2nd"
             strip, and every cell pre-filled with its own ordered pair. "Without replacement"
             crosses out the diagonal, which is the entire difference between the two versions
             of that question and the reason it is a checkbox rather than a second preset. */
const tableDialogStyle = () => ({
  fontSize: Math.max(8, probNum($("tbFontSize").value, 20)),
  headFill: $("tbShade").checked ? ($("tbHeadColour").value || TABLE_DEFAULTS.headFill) : "#FFFFFF",
  stripeFill: $("tbStripe").checked ? ($("tbStripeColour").value || "#F4F7FB") : "",
});
function buildTableFromDialog() {
  const preset = $("tbPreset").value;
  const cols = probList($("tbCols").value, ["", ""]);
  const rows = probList($("tbRows").value, ["", ""]);
  const style = tableDialogStyle();
  if (preset === "sample") return buildSampleSpaceTable(cols, rows, style);
  if (preset === "plain") {
    // Nothing but a grid: the plain kind asks for a size, not for headings, because every cell of
    // it is typed on the preview. An empty column measures as the bare minimum, which is too narrow
    // to aim at, so they start wide enough to hold a few characters.
    const nc = Math.max(1, Math.min(20, Math.round(probNum($("tbPlainCols").value, 3))));
    const nr = Math.max(1, Math.min(40, Math.round(probNum($("tbPlainRows").value, 3))));
    return makeTable({
      rows: nr, cols: nc, headRows: $("tbHeadRow").checked ? 1 : 0,
      headCols: $("tbHeadCol").checked ? 1 : 0,
      colW: new Array(nc).fill(Math.max(TABLE_MIN_COL, style.fontSize * 4)), ...style,
    });
  }

  const totals = preset === "twoWay" && $("tbTotals").checked;
  const colHead = totals ? cols.concat("Total") : cols.slice();
  const rowHead = totals ? rows.concat("Total") : rows.slice();
  const body = String($("tbBody").value || "").split("\n").map(line => probList(line, []));
  const cells = [[$("tbCorner").value.trim()].concat(colHead)];
  rowHead.forEach((h, r) => {
    cells.push([h].concat(colHead.map((_, c) => (body[r] && body[r][c] != null) ? body[r][c] : "")));
  });
  return makeTable({ rows: cells.length, cols: cells[0].length, cells, headRows: 1, headCols: 1, ...style });
}
/* The layout in the textbook: two heading rows and two heading columns, where the outer one of
   each is a single cell spanning the rest and naming the whole axis. */
function buildSampleSpaceTable(cols, rows, style) {
  const acrossName = $("tbAcrossName").value.trim() || "1st";
  const downName = $("tbDownName").value.trim() || "2nd";
  const without = $("tbNoRepeat").checked;
  const nc = cols.length, nr = rows.length;
  const cells = [];
  // Row 0: two blanks, then the spanning name for the across axis.
  cells.push(["", ""].concat(cols.map((_, i) => (i === 0 ? acrossName : ""))));
  cells.push(["", ""].concat(cols));
  rows.forEach((rh, r) => {
    cells.push([r === 0 ? downName : "", rh].concat(cols.map((ch, c) =>
      (without && ch === rh) ? "×" : `(${ch}, ${rh})`)));
  });
  return makeTable({
    rows: cells.length, cols: nc + 2, cells, headRows: 2, headCols: 2,
    spans: {
      "0,2": { rs: 1, cs: nc },   // the "1st" strip across the outcome columns
      "2,0": { rs: nr, cs: 1 },   // the "2nd" strip down beside the outcome rows
    },
    // The 2x2 block above the row headings belongs to neither axis. In the textbook it is blank
    // page, not a bordered empty cell, and a bordered one reads as something left unfilled.
    hidden: { "0,0": true, "0,1": true, "1,0": true, "1,1": true },
    ...style,
  });
}

/* ---------------- the table the dialog is holding ----------------
   The preview isn't a picture of what you'd get, it IS what you'd get: you type into its cells and
   add and remove its rows right there, and Insert places a copy of it. So it has to survive
   between renders instead of being rebuilt from the form each time — otherwise a keystroke
   anywhere in the dialog would throw away everything typed on the preview.

   The rule for when it IS rebuilt is the one that matches what you meant. Fields that decide the
   CONTENT (the kind, the headings, the starting cells) start it again: you asked for different
   content, so you get it. Fields that only style or size it are applied to the table already on
   the stage, so changing the colour or adding a heading row keeps your typing and your extra rows. */
let tableDraft = null;
let tableDraftSig = null;
function tableContentSig() {
  return JSON.stringify([$("tbPreset").value, $("tbCols").value, $("tbRows").value,
    $("tbBody").value, $("tbCorner").value, $("tbTotals").checked, $("tbNoRepeat").checked,
    $("tbAcrossName").value, $("tbDownName").value]);
}
function tableDraftForDialog() {
  const sig = tableContentSig();
  if (!tableDraft || sig !== tableDraftSig) {
    tableDraft = buildTableFromDialog();
    tableDraftSig = sig;
    tableRefitAfterMath(tableDraft, () => { if ($("shapeImporterDlg").open) renderShapePreview(); });
  } else {
    const st = tableDialogStyle();
    tableDraft.headFill = st.headFill;
    tableDraft.stripeFill = st.stripeFill;
    if ($("tbPreset").value === "plain") {
      tableDraft.headRows = $("tbHeadRow").checked ? 1 : 0;
      tableDraft.headCols = $("tbHeadCol").checked ? 1 : 0;
    }
    tableSetFontSize(tableDraft, st.fontSize);
  }
  return tableDraft;
}
/* The count fields and the preview's own ＋/✕ are two views of one thing, so each follows the
   other, and resizing rather than rebuilding is what keeps the cells already typed.

   Bound to `change` and never to `input`, unlike every other field in this dialog: retyping "12"
   over "6" passes through "1" on the way, and applying that per keystroke would delete eleven rows
   and everything in them before the second digit arrived. */
function syncTableCountsFromForm() {
  if (!tableDraft || $("tbPreset").value !== "plain") return;
  tableResizeTo(tableDraft,
    Math.round(probNum($("tbPlainRows").value, tableRows(tableDraft))),
    Math.round(probNum($("tbPlainCols").value, tableCols(tableDraft))));
  syncTablePlainCounts(tableDraft); // reflect the clamp, so the field can't claim 99 rows
}
// Writes the preview's own size back into the count fields, so adding a column there doesn't leave
// the form claiming a different number from the one on the stage.
function syncTablePlainCounts(t) {
  if ($("tbPreset").value !== "plain") return;
  $("tbPlainCols").value = tableCols(t);
  $("tbPlainRows").value = tableRows(t);
}

/* Drops the built table onto the page and selects it, rather than going through the click-to-place
   ghost every other shape uses: a table's size is decided by its own contents, so there is nothing
   for the placement preview to be scaled against, and landing it selected means the next click can
   go straight into a cell. */
function insertTableFromDialog() {
  closeTableDraftEditor();
  // A copy, never the draft itself. The dialog keeps its table alive so reopening it shows what you
  // last built, and a preview that went on editing the placed one would be a genuine surprise.
  const t = tableFromJson(tableToJson(tableDraftForDialog()));
  t.layer = currentLayerId(); // the draft was made whenever the dialog was last opened
  $("shapeImporterDlg").close();
  const at = clampObjToPage(40, V.scroll + 60, t.w, t.h);
  t.x = at.x; t.y = at.y;
  doc.tables.push(t);
  pushUndo({ op: "add", items: [{ kind: "table", ref: t }] });
  sel.items = [{ kind: "table", ref: t }];
  sel.shape = null;
  tableFocus = null;
  bumpPages(t.y + t.h);
  tableRefitAfterMath(t);
  markDirty(); needsDraw = true; syncUI();
}

/* The table as SVG markup, in coordinates relative to `originX/originY`. One function for the
   dialog preview and for SVG export, so what the preview shows is what the file contains — the
   preview used to be a separate generator and the two could drift. */
function tableSvgBody(t, originX, originY) {
  // Single quotes inside the stack, because this goes into a double-quoted XML attribute and the
  // stack names a font that needs quoting ("Segoe UI"). Left as-is it closes the attribute early
  // and the whole file stops being parseable XML — which for an SVG means it does not open at all.
  // svgTextEl does the same to fontCss() for exactly this reason.
  const fam = FONT_STACKS[DEFAULT_FONT_KEY].css.replace(/"/g, "'");
  let out = "";
  for (let r = 0; r < tableRows(t); r++) {
    for (let c = 0; c < tableCols(t); c++) {
      if (tableSkip(t, r, c)) continue;
      const q = tableCellRect(t, r, c);
      const head = tableIsHead(t, r, c);
      const striped = !head && t.stripeFill && (r - t.headRows) % 2 === 1;
      const x = q.x - originX, y = q.y - originY;
      out += `  <rect x="${pn(x)}" y="${pn(y)}" width="${pn(q.w)}" height="${pn(q.h)}" ` +
        `fill="${head ? t.headFill : (striped ? t.stripeFill : "#FFFFFF")}" ` +
        `stroke="${t.gridColour}" stroke-width="1.6"/>\n`;
      // Laid out piece by piece rather than as one centred <text>, because a cell can hold maths
      // and a rasterized formula has to be placed at its own measured width (see tableCellLayout).
      const lay = tableCellLayout(t, r, c);
      if (!lay.pieces.length) continue;
      const base = y + q.h / 2 + t.fontSize * 0.35;
      const left = x + q.w / 2 - lay.width / 2;
      for (const p of lay.pieces) {
        if (p.span) {
          out += `  <image href="${p.span.dataURL}" xlink:href="${p.span.dataURL}" x="${pn(left + p.x)}" ` +
            `y="${pn(base + p.span.baselineOffset)}" width="${pn(p.w)}" height="${pn(p.span.h)}"/>\n`;
          continue;
        }
        out += `  <text xml:space="preserve" x="${pn(left + p.x)}" y="${pn(base)}" ` +
          `font-family="${fam}" font-size="${t.fontSize}"${head ? ' font-weight="bold"' : ""} ` +
          `fill="${tableInk(t, head)}">${escapeXml(p.text)}</text>\n`;
      }
    }
  }
  return out;
}
const SVG_NS_ATTRS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
function tableToSvg(t) {
  const W = Math.ceil(t.w) + 4, H = Math.ceil(t.h) + 4;
  return `<svg ${SVG_NS_ATTRS} viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">\n` +
    `<rect width="100%" height="100%" fill="none"/>\n` +
    `<g transform="translate(2 2)">\n${tableSvgBody(t, t.x, t.y)}</g></svg>`;
}

/* ---------------- the table as the dialog shows it ----------------
   The real table plus the controls for changing it, because the shortest route from "I need one
   more column" to having one is clicking where it should go. None of this chrome can ever reach
   the page: a table is placed as an object built from the draft, and this markup only ever becomes
   the preview stage's innerHTML.

   Everything is sized in world units, since that is what the viewBox is in, but the chips have to
   come out a constant size ON SCREEN — the stage scales the whole SVG to fit, so a chip fixed in
   world units balloons on a small table and disappears on a wide one. `u` is the conversion, and
   it is solved rather than measured: the gutters the chips live in are themselves part of the
   width being scaled, so u = table width / (stage width - what the gutters cost in pixels). */
const TABLE_CHIP_PX = 22;
function tableEditorSvg(t) {
  const stage = $("shapePreview");
  const stageW = (stage && stage.clientWidth) || 420;
  const u = Math.max(0.02, t.w / Math.max(80, stageW - TABLE_CHIP_PX * 2 - 8));
  const g = TABLE_CHIP_PX * u, pad = 4 * u, rad = 7.5 * u, ins = 4.5 * u;
  const ox = g + pad, oy = g + pad;
  const W = t.w + (g + pad) * 2, H = t.h + (g + pad) * 2;
  // Running edges, so a chip can be put over a column or on the boundary between two.
  const colX = [0], rowY = [0];
  t.colW.forEach(w => colX.push(colX[colX.length - 1] + w));
  t.rowH.forEach(h => rowY.push(rowY[rowY.length - 1] + h));

  const chip = (cx, cy, r, cls, glyph, act, at, title) =>
    `<g class="tbl-chip ${cls}" data-act="${act}" data-at="${at}"><title>${escapeXml(title)}</title>` +
    `<circle cx="${pn(cx)}" cy="${pn(cy)}" r="${pn(r)}" vector-effect="non-scaling-stroke"/>` +
    `<text x="${pn(cx)}" y="${pn(cy + r * 0.38)}" font-size="${pn(r * 1.45)}" text-anchor="middle">${glyph}</text></g>`;

  let ui = "";
  // Columns along the top, rows down the left side: each line gets a ✕, each strip ends in a ＋,
  // and the ＋ between two lines (revealed on hovering the strip) inserts there instead.
  ui += `<g class="tbl-strip"><rect class="tbl-strip-hit" x="${pn(ox - g)}" y="${pn(oy - g)}" width="${pn(t.w + g)}" height="${pn(g)}"/>`;
  for (let c = 0; c < tableCols(t); c++) {
    if (t.colW[c] > rad * 2.2)
      ui += chip(ox + (colX[c] + colX[c + 1]) / 2, oy - g / 2, rad, "tbl-del", "✕", "delCol", c, `Delete column ${c + 1}`);
    if (c === 0 || t.colW[c - 1] > rad * 3)
      ui += chip(ox + colX[c], oy - g / 2, ins, "tbl-ins", "+", "insCol", c, `Insert a column here`);
  }
  ui += chip(ox + t.w + g / 2, oy - g / 2, rad, "tbl-add", "+", "insCol", tableCols(t), "Add a column on the right");
  ui += `</g>`;
  ui += `<g class="tbl-strip"><rect class="tbl-strip-hit" x="${pn(ox - g)}" y="${pn(oy - g)}" width="${pn(g)}" height="${pn(t.h + g)}"/>`;
  for (let r = 0; r < tableRows(t); r++) {
    if (t.rowH[r] > rad * 2.2)
      ui += chip(ox - g / 2, oy + (rowY[r] + rowY[r + 1]) / 2, rad, "tbl-del", "✕", "delRow", r, `Delete row ${r + 1}`);
    if (r === 0 || t.rowH[r - 1] > rad * 3)
      ui += chip(ox - g / 2, oy + rowY[r], ins, "tbl-ins", "+", "insRow", r, `Insert a row here`);
  }
  ui += chip(ox - g / 2, oy + t.h + g / 2, rad, "tbl-add", "+", "insRow", tableRows(t), "Add a row at the bottom");
  ui += `</g>`;
  // Click targets over the cells themselves, on top of everything so a cell is always reachable.
  let hots = "";
  for (let r = 0; r < tableRows(t); r++) {
    for (let c = 0; c < tableCols(t); c++) {
      if (tableSkip(t, r, c)) continue;
      const q = tableCellRect(t, r, c);
      hots += `<rect class="tbl-cell" data-tr="${r}" data-tc="${c}" x="${pn(q.x - t.x + ox)}" y="${pn(q.y - t.y + oy)}" ` +
        `width="${pn(q.w)}" height="${pn(q.h)}"><title>Click to type in this cell</title></rect>`;
    }
  }
  return `<svg ${SVG_NS_ATTRS} viewBox="0 0 ${pn(W)} ${pn(H)}" width="${pn(W)}" height="${pn(H)}">\n` +
    `<rect width="100%" height="100%" fill="none"/>\n` +
    tableSvgBody(t, t.x - ox, t.y - oy) + ui + hots + `</svg>`;
}

/* ---------------- typing into the preview ----------------
   A cell isn't backed by a form field, so this can't be the shape dialog's inline editor (which
   exists to read and write one). It writes into the draft and redraws. Enter and Tab walk the grid
   exactly as they do once the table is on the page, so the gesture you learn here is the one that
   still works there. */
function openTableDraftEditor(r, c, anchorEl) {
  const t = tableDraft;
  if (!t || tableSkip(t, r, c)) return;
  closeTableDraftEditor();
  const box = anchorEl.getBoundingClientRect();
  const stage = $("shapePreview").getBoundingClientRect();
  const ed = document.createElement("input");
  ed.type = "text";
  ed.className = "shape-inline-edit tbl-inline-edit";
  ed.value = String(t.cells[r][c] || "");
  const w = Math.max(64, Math.min(box.width + 10, stage.width - 8));
  ed.style.width = w + "px";
  ed.style.left = Math.round(Math.max(2, Math.min(box.left - stage.left + box.width / 2 - w / 2, stage.width - w - 2))) + "px";
  ed.style.top = Math.round(Math.max(2, Math.min(box.top - stage.top + box.height / 2 - 13, stage.height - 30))) + "px";
  // stopPropagation because the dialog listens for input on everything inside it and would render
  // a second time for the same keystroke.
  ed.oninput = ev => { ev.stopPropagation(); t.cells[r][c] = ed.value; renderTableStageOnly(); };
  ed.onkeydown = ev => {
    ev.stopPropagation();
    if (ev.key === "Escape") { ev.preventDefault(); closeTableDraftEditor(); return; }
    if (ev.key !== "Enter" && ev.key !== "Tab") return;
    ev.preventDefault();
    const dir = ev.key === "Tab" ? (ev.shiftKey ? "left" : "right") : (ev.shiftKey ? "up" : "down");
    const at = tableStep(t, r, c, dir);
    closeTableDraftEditor();
    if (!at) return;
    const next = $("shapePreview").querySelector(`.tbl-cell[data-tr="${at.r}"][data-tc="${at.c}"]`);
    if (next) openTableDraftEditor(at.r, at.c, next);
  };
  ed.onblur = () => closeTableDraftEditor();
  $("shapePreview").parentElement.appendChild(ed);
  renderTableStageOnly();
  ed.focus();
  ed.select();
}
function closeTableDraftEditor() {
  const ed = document.querySelector(".tbl-inline-edit");
  if (!ed) return;
  ed.onblur = null;
  ed.remove();
  // Fitted on the way out rather than on every keystroke: columns only ever grow, so fitting as you
  // typed would jump the whole table sideways letter by letter and never give the width back.
  if (tableDraft) {
    tableAutoFitCols(tableDraft);
    tableRefitAfterMath(tableDraft, renderTableStageOnly);
  }
  renderTableStageOnly();
}
// Redraws just the stage. renderShapePreview() would do it too, but it re-reads the whole form, and
// while a cell editor is open the draft — not the form — is the thing that has changed.
function renderTableStageOnly() {
  if (!tableDraft || !$("shapeImporterDlg").open || $("shapeTypeSelect").value !== "table") return;
  $("shapePreview").innerHTML = tableEditorSvg(tableDraft);
}
/* Clicks on the preview's own controls, called before the shape dialog's hotspot handling so a
   table's chips win over the generic machinery (which has nothing to offer here anyway). */
function tablePreviewPointerDown(e) {
  if (!tableDraft || $("shapeTypeSelect").value !== "table") return false;
  const chip = e.target.closest(".tbl-chip");
  if (chip) {
    e.preventDefault();
    closeTableDraftEditor();
    const t = tableDraft, at = +chip.dataset.at;
    ({
      insRow: () => tableInsertRow(t, at), delRow: () => tableDeleteRow(t, at),
      insCol: () => tableInsertCol(t, at), delCol: () => tableDeleteCol(t, at),
    })[chip.dataset.act]();
    tableAutoFitCols(t);
    syncTablePlainCounts(t);
    renderTableStageOnly();
    return true;
  }
  const cell = e.target.closest(".tbl-cell");
  if (!cell) return false;
  e.preventDefault();
  openTableDraftEditor(+cell.dataset.tr, +cell.dataset.tc, cell);
  return true;
}

/* ---------------- persistence ---------------- */
function tableToJson(t) {
  return {
    x: t.x, y: t.y, cells: t.cells, headRows: t.headRows, headCols: t.headCols,
    spans: t.spans, hidden: t.hidden, fontSize: t.fontSize, colW: t.colW, rowH: t.rowH,
    headFill: t.headFill, stripeFill: t.stripeFill, gridColour: t.gridColour,
    textColour: t.textColour, layer: t.layer,
    ...(t.grp ? { grp: t.grp } : {}),
  };
}
function tableFromJson(j) {
  const t = makeTable({
    x: j.x, y: j.y, rows: (j.cells || [[]]).length, cols: (j.cells && j.cells[0] || []).length,
    cells: j.cells, headRows: j.headRows, headCols: j.headCols, spans: j.spans, hidden: j.hidden,
    fontSize: j.fontSize, colW: j.colW, rowH: j.rowH, headFill: j.headFill,
    stripeFill: j.stripeFill, gridColour: j.gridColour, textColour: j.textColour, layer: j.layer,
  });
  // Not a makeTable option: grouping is about how a table is selected, not how one is built.
  if (j.grp) t.grp = j.grp;
  return t;
}
