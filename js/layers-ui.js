"use strict";
/* ---------------- layers panel ----------------
   A notebook-wide set of named layers (S.layers, see state.js) that every stroke/text/image/tape/
   timer carries a `layer` id into. Toggling a layer off hides it on screen, blocks interaction
   with its content (see the isLayerVisible() checks throughout input.js/render.js), and excludes
   it from PDF/SVG export (pdf-export.js) — e.g. an answer-key overlay that's normally hidden while
   teaching, then toggled on just for the exported/printed version, or vice versa. */

// Counts how many objects across every kind currently sit on a given layer — used both to decide
// whether deleting it needs a confirmation, and what that confirmation should say.
function countObjectsOnLayer(id) {
  let n = 0;
  for (const arr of [doc.strokes, doc.tapes, doc.texts, doc.images, doc.timers])
    for (const o of arr) if (!o.del && o.layer === id) n++;
  return n;
}

function renderLayersPanel() {
  if (!V.layersPanel) return; // skip the work while the panel's closed; re-rendered on open
  LP.innerHTML = "";
  const h = document.createElement("h3");
  h.innerHTML = `<span>🗂️ Layers</span>`;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button"; closeBtn.textContent = "✕"; closeBtn.title = "Close layers panel";
  closeBtn.onclick = () => { V.layersPanel = false; syncUI(); };
  h.appendChild(closeBtn);
  LP.appendChild(h);

  const list = document.createElement("div");
  list.className = "layer-list";
  S.layers.forEach((l, i) => {
    const row = document.createElement("div");
    row.className = "layer-row" + (l.id === S.activeLayer ? " active" : "") + (l.visible === false ? " layer-hidden" : "");
    row.title = l.id === S.activeLayer ? "Active — new ink/text/shapes go here" : "Click to draw on this layer";
    row.onclick = e => { if (!e.target.closest("button")) setActiveLayer(l.id); };

    const visBtn = document.createElement("button");
    visBtn.type = "button"; visBtn.className = "layer-vis";
    visBtn.textContent = l.visible === false ? "🙈" : "👁️";
    visBtn.title = l.visible === false ? "Hidden — click to show" : "Visible — click to hide";
    visBtn.onclick = () => toggleLayerVisibility(l.id);
    row.appendChild(visBtn);

    const name = document.createElement("span");
    name.className = "layer-name";
    name.textContent = l.name;
    row.appendChild(name);

    const actions = document.createElement("div");
    actions.className = "layer-actions";
    const mk = (label, title, fn) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = label; b.title = title;
      b.onclick = fn;
      actions.appendChild(b);
    };
    if (i > 0) mk("↑", "Move up", () => moveLayer(l.id, -1));
    if (i < S.layers.length - 1) mk("↓", "Move down", () => moveLayer(l.id, 1));
    mk("✎", "Rename", () => renameLayer(l.id));
    mk("🗑", "Delete", () => deleteLayer(l.id));
    row.appendChild(actions);

    list.appendChild(row);
  });
  LP.appendChild(list);

  const addBtn = document.createElement("button");
  addBtn.type = "button"; addBtn.className = "side-btn"; addBtn.textContent = "+ New Layer";
  addBtn.style.marginTop = "0";
  addBtn.onclick = createLayer;
  LP.appendChild(addBtn);
}

function setActiveLayer(id) {
  if (!S.layers.some(l => l.id === id)) return;
  S.activeLayer = id;
  // Selecting a hidden layer as the one you're about to draw on also un-hides it — otherwise
  // new strokes would silently vanish onto a layer nothing shows, which reads as data loss.
  const l = S.layers.find(x => x.id === id);
  if (l.visible === false) l.visible = true;
  markDirty(); needsDraw = true; renderLayersPanel();
}

function toggleLayerVisibility(id) {
  const l = S.layers.find(x => x.id === id);
  if (!l) return;
  const turningOff = l.visible !== false;
  l.visible = turningOff ? false : true;
  // Hiding the layer you're currently drawing on would otherwise make new strokes vanish the
  // instant they're made — hand the active slot to another layer (preferring an already-visible
  // one) so there's always a visible layer to draw on, same invariant setActiveLayer() enforces
  // from the other direction.
  if (turningOff && S.activeLayer === id) {
    const next = S.layers.find(x => x.id !== id && x.visible !== false) || S.layers.find(x => x.id !== id);
    if (next) { S.activeLayer = next.id; if (next.visible === false) next.visible = true; }
  }
  markDirty(); needsDraw = true; clearSelection(); renderLayersPanel();
}

async function createLayer() {
  const name = await promptDialog("New layer", "Layer name", `Layer ${S.layers.length + 1}`);
  if (name == null) return;
  const l = { id: genId(), name: name.trim() || `Layer ${S.layers.length + 1}`, visible: true };
  S.layers.push(l);
  S.activeLayer = l.id;
  markDirty(); renderLayersPanel();
}

async function renameLayer(id) {
  const l = S.layers.find(x => x.id === id);
  if (!l) return;
  const name = await promptDialog("Rename layer", "Layer name", l.name);
  if (name == null) return;
  l.name = name.trim() || l.name;
  markDirty(); renderLayersPanel();
}

function deleteLayer(id) {
  if (S.layers.length <= 1) { alert("A notebook needs at least one layer — create another before deleting this one."); return; }
  const l = S.layers.find(x => x.id === id);
  if (!l) return;
  const fallback = S.layers.find(x => x.id !== id);
  const n = countObjectsOnLayer(id);
  const doDelete = () => {
    for (const arr of [doc.strokes, doc.tapes, doc.texts, doc.images, doc.timers])
      for (const o of arr) if (o.layer === id) o.layer = fallback.id;
    S.layers = S.layers.filter(x => x.id !== id);
    if (S.activeLayer === id) { S.activeLayer = fallback.id; if (fallback.visible === false) fallback.visible = true; }
    markDirty(); needsDraw = true; clearSelection(); renderLayersPanel();
  };
  if (n > 0) {
    confirmDialog(`Delete "${l.name}"?`, `${n} item${n === 1 ? "" : "s"} on this layer will move to "${fallback.name}" instead of being deleted.`, doDelete);
  } else {
    doDelete();
  }
}

// Pure list-order swap (which row shows where in the panel) — layers are a visibility/interaction
// grouping only, not a compositing z-order, so this doesn't touch how anything actually draws;
// see the architecture note in the render.js draw functions for why that's out of scope here.
function moveLayer(id, dir) {
  const i = S.layers.findIndex(x => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= S.layers.length) return;
  [S.layers[i], S.layers[j]] = [S.layers[j], S.layers[i]];
  markDirty(); renderLayersPanel();
}
