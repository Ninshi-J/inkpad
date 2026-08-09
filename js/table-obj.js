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
// Each column at least as wide as its widest entry. Only ever grows a column past the minimum, so
// a hand-widened column isn't snapped back the next time a cell is typed into.
function tableAutoFitCols(t) {
  measureCtx.font = `${t.fontSize}px ${FONT_STACKS[DEFAULT_FONT_KEY].css}`;
  for (let c = 0; c < tableCols(t); c++) {
    let wide = TABLE_MIN_COL;
    for (let r = 0; r < tableRows(t); r++) {
      // A cell spanning several columns shouldn't force all of its width onto the first one.
      const span = tableSpanAt(t, r, c);
      const share = span && span.cs > 1 ? span.cs : 1;
      const bold = tableIsHead(t, r, c);
      measureCtx.font = `${bold ? "bold " : ""}${t.fontSize}px ${FONT_STACKS[DEFAULT_FONT_KEY].css}`;
      wide = Math.max(wide, measureCtx.measureText(String(t.cells[r][c] || "")).width / share + tablePadX(t) * 2);
    }
    t.colW[c] = Math.max(t.colW[c] || 0, wide);
  }
  tableSyncSize(t);
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
  ctx.textBaseline = "middle";
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
      const text = String(t.cells[r][c] || "");
      if (!text) continue;
      ctx.fillStyle = head ? t.gridColour : t.textColour;
      ctx.font = `${head ? "bold " : ""}${t.fontSize * z}px ${FONT_STACKS[DEFAULT_FONT_KEY].css}`;
      ctx.textAlign = "center";
      // Clipped to its own cell so an over-long entry can't bleed into its neighbour — the column
      // auto-fits when the cell is committed, but a scaled-down table can still overflow.
      ctx.save();
      ctx.beginPath(); ctx.rect(X + 1, Y + 1, W - 2, H - 2); ctx.clip();
      ctx.fillText(text, X + W / 2, Y + H / 2 + 1);
      ctx.restore();
    }
  }
  ctx.restore();
}

/* ---------------- editing a cell ----------------
   A plain <input> parked over the cell in screen space, rather than reusing the canvas text
   editor: a cell is one short value with no wrapping, and Tab/Enter should walk the grid rather
   than insert anything. Committing re-fits the column so a long entry widens its own column
   instead of being clipped. */
let editingTableCell = null; // { t, r, c, before } while an input is open
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
  if (tableCovered(t, at.r, at.c)) return tableStep(t, at.r, at.c, dir);
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
    pushUndo({ op: "tableEdit", ref: st.t, before: st.before, after: tableSnapshot(st.t) });
    markDirty();
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
function tableApplyScale(t, snap, cx, cy, factor) {
  t.fontSize = Math.max(6, snap.fontSize * factor);
  t.colW = snap.colW.map(v => Math.max(TABLE_MIN_COL * 0.4, v * factor));
  t.rowH = snap.rowH.map(v => Math.max(TABLE_MIN_ROW * 0.4, v * factor));
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
// A table being dragged, scaled or deleted underneath an open editor would leave the input
// floating over nothing, so any of those closes it first.
function tableEditorFollowsDocument() {
  if (!editingTableCell) return;
  const t = editingTableCell.t;
  if (t.del || !sel.items.some(it => it.ref === t)) cancelTableCellEdit();
}

/* ---------------- building one from the dialog ----------------
   Three presets over the same object, because they differ only in what the cells start as:

     plain   an empty grid, the "just give me a table" case
     twoWay  the headings you type, plus a Total row and column
     sample  a sample space: both sets of outcomes as headings under a spanning "1st"/"2nd"
             strip, and every cell pre-filled with its own ordered pair. "Without replacement"
             crosses out the diagonal, which is the entire difference between the two versions
             of that question and the reason it is a checkbox rather than a second preset. */
function buildTableFromDialog() {
  const preset = $("tbPreset").value;
  const cols = probList($("tbCols").value, ["", ""]);
  const rows = probList($("tbRows").value, ["", ""]);
  const fontSize = Math.max(8, probNum($("tbFontSize").value, 20));
  const style = {
    fontSize,
    headFill: $("tbShade").checked ? ($("tbHeadColour").value || TABLE_DEFAULTS.headFill) : "#FFFFFF",
    stripeFill: $("tbStripe").checked ? ($("tbStripeColour").value || "#F4F7FB") : "",
  };
  if (preset === "sample") return buildSampleSpaceTable(cols, rows, style);

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

/* Drops the built table onto the page and selects it, rather than going through the click-to-place
   ghost every other shape uses: a table's size is decided by its own contents, so there is nothing
   for the placement preview to be scaled against, and landing it selected means the next click can
   go straight into a cell. */
function insertTableFromDialog() {
  const t = buildTableFromDialog();
  $("shapeImporterDlg").close();
  const at = clampObjToPage(40, V.scroll + 60, t.w, t.h);
  t.x = at.x; t.y = at.y;
  doc.tables.push(t);
  pushUndo({ op: "add", items: [{ kind: "table", ref: t }] });
  sel.items = [{ kind: "table", ref: t }];
  sel.shape = null;
  bumpPages(t.y + t.h);
  markDirty(); needsDraw = true; syncUI();
}

/* The table as SVG markup, in coordinates relative to `originX/originY`. One function for the
   dialog preview and for SVG export, so what the preview shows is what the file contains — the
   preview used to be a separate generator and the two could drift. */
function tableSvgBody(t, originX, originY) {
  const fam = FONT_STACKS[DEFAULT_FONT_KEY].css;
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
      const text = String(t.cells[r][c] || "");
      if (!text) continue;
      out += `  <text xml:space="preserve" x="${pn(x + q.w / 2)}" y="${pn(y + q.h / 2 + t.fontSize * 0.35)}" ` +
        `font-family="${fam}" font-size="${t.fontSize}"${head ? ' font-weight="bold"' : ""} ` +
        `text-anchor="middle" fill="${head ? t.gridColour : t.textColour}">${escapeXml(text)}</text>\n`;
    }
  }
  return out;
}
function tableToSvg(t) {
  const W = Math.ceil(t.w) + 4, H = Math.ceil(t.h) + 4;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">\n` +
    `<rect width="100%" height="100%" fill="none"/>\n` +
    `<g transform="translate(2 2)">\n${tableSvgBody(t, t.x, t.y)}</g></svg>`;
}

/* ---------------- persistence ---------------- */
function tableToJson(t) {
  return {
    x: t.x, y: t.y, cells: t.cells, headRows: t.headRows, headCols: t.headCols,
    spans: t.spans, hidden: t.hidden, fontSize: t.fontSize, colW: t.colW, rowH: t.rowH,
    headFill: t.headFill, stripeFill: t.stripeFill, gridColour: t.gridColour,
    textColour: t.textColour, layer: t.layer,
  };
}
function tableFromJson(j) {
  const t = makeTable({
    x: j.x, y: j.y, rows: (j.cells || [[]]).length, cols: (j.cells && j.cells[0] || []).length,
    cells: j.cells, headRows: j.headRows, headCols: j.headCols, spans: j.spans, hidden: j.hidden,
    fontSize: j.fontSize, colW: j.colW, rowH: j.rowH, headFill: j.headFill,
    stripeFill: j.stripeFill, gridColour: j.gridColour, textColour: j.textColour, layer: j.layer,
  });
  return t;
}
