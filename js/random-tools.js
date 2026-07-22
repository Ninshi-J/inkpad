"use strict";
async function loadRosters() {
  try { libRosters = await storeGetAll("rosters"); } catch (_) { libRosters = []; }
  if (!libRosters.length) {
    // Migrate a flat single-roster list from an earlier version of this feature, if present, so
    // an already-typed class list doesn't just disappear.
    let legacy = [];
    try { legacy = JSON.parse(localStorage.getItem("inkpad.roster") || "[]"); } catch (_) {}
    const r = { id: genId(), name: "My Class", names: Array.isArray(legacy) ? legacy : [] };
    libRosters = [r];
    try { await storePut("rosters", r); } catch (_) {}
    try { localStorage.removeItem("inkpad.roster"); } catch (_) {}
  }
  try { activeRosterId = localStorage.getItem("inkpad.activeRosterId"); } catch (_) {}
  if (!activeRosterId || !libRosters.some(r => r.id === activeRosterId)) activeRosterId = libRosters[0].id;
  try { localStorage.setItem("inkpad.activeRosterId", activeRosterId); } catch (_) {}
}
function activeRoster() { return libRosters.find(r => r.id === activeRosterId) || libRosters[0] || null; }
function setActiveRosterId(id) {
  activeRosterId = id;
  try { localStorage.setItem("inkpad.activeRosterId", activeRosterId); } catch (_) {}
  rpPicked.clear();
}

// Walks up from a folder through its ancestors (the folder itself first),
// returning the id of the nearest one with a roster directly attached —
// so a roster set on "Y9" applies to every notebook under "Y9/Algebra",
// "Y9/Graphing", etc. without re-attaching it at every subfolder level.
function resolveRosterIdForFolder(folderId) {
  for (let fid = folderId; fid; fid = (libFolders.find(f => f.id === fid) || {}).parentId) {
    const match = libRosters.find(r => r.folderId === fid);
    if (match) return match.id;
  }
  return null;
}
// Re-picks the active roster to match the current notebook's folder, if that
// folder chain has one attached. Leaves the existing manual/global selection
// alone otherwise (e.g. ungrouped rosters, or no folder has one assigned) —
// called when the random picker opens, not on every keystroke, so switching
// between a Y9 and a Y7 notebook naturally switches the class list too.
function resolveActiveRosterForCurrentNotebook() {
  const nb = libNotebooks.find(n => n.id === activeNotebookId);
  const resolved = nb && resolveRosterIdForFolder(nb.folderId);
  if (resolved && resolved !== activeRosterId) setActiveRosterId(resolved);
}
async function createRosterForFolder(folderId, suggestedName) {
  const name = await promptDialog("New class roster", "e.g. " + (suggestedName || "Year 9"), suggestedName || "");
  if (name == null) return null;
  const r = { id: genId(), name: name.trim() || "Untitled roster", names: [], folderId };
  libRosters.push(r);
  try { await storePut("rosters", r); } catch (_) {}
  setActiveRosterId(r.id);
  refreshRosterUI();
  setRosterEditorOpen(true, false);
  return r;
}
function folderNameFor(id) { const f = libFolders.find(x => x.id === id); return f ? f.name : null; }
// Sidebar folder-row action: opens the existing roster for this folder (so it
// can be viewed/edited), or offers to create one if this folder doesn't have
// its own yet (it may still be inheriting an ancestor's — this always means
// "this specific folder", not the resolved/inherited one).
async function manageFolderRoster(folder) {
  const existing = libRosters.find(r => r.folderId === folder.id);
  if (existing) { setActiveRosterId(existing.id); openRandomDlg(true); return; }
  const r = await createRosterForFolder(folder.id, folder.name);
  if (r) openRandomDlg(true); // skip auto-resolve — we just deliberately picked this folder's roster
}
async function saveActiveRosterNames(names) {
  const r = activeRoster();
  if (!r) return;
  r.names = names;
  try { await storePut("rosters", r); } catch (_) {}
}
async function createRoster() {
  const name = await promptDialog("New roster", "e.g. Period 3", "");
  if (name == null) return;
  const r = { id: genId(), name: name.trim() || "Untitled roster", names: [] };
  libRosters.push(r);
  try { await storePut("rosters", r); } catch (_) {}
  setActiveRosterId(r.id);
  refreshRosterUI();
  setRosterEditorOpen(true, false);
}
async function renameRoster() {
  const r = activeRoster();
  if (!r) return;
  const name = await promptDialog("Rename roster", "Name", r.name);
  if (name == null) return;
  r.name = name.trim() || r.name;
  try { await storePut("rosters", r); } catch (_) {}
  refreshRosterUI();
}
function deleteRoster() {
  const r = activeRoster();
  if (!r) return;
  if (libRosters.length <= 1) { alert("You need at least one roster — add another before deleting this one."); return; }
  confirmDialog(`Delete "${r.name}"?`, "This removes this roster's student list.", async () => {
    libRosters = libRosters.filter(x => x.id !== r.id);
    try { await storeDelete("rosters", r.id); } catch (_) {}
    setActiveRosterId(libRosters[0].id);
    refreshRosterUI();
  });
}
// The roster textarea is hidden by default — picking a name shouldn't require scrolling past the
// whole class list every time. `persist` controls whether this toggle becomes the remembered
// default for next time the dialog opens (true for an explicit user click; false when we're just
// auto-opening it because the active roster happens to be empty and has nothing to pick from).
function setRosterEditorOpen(open, persist = true) {
  const box = $("rpRosterEditor");
  if (!box) return;
  box.style.display = open ? "" : "none";
  const btn = $("rpToggleEditBtn");
  if (btn) btn.textContent = open ? "✓ Done editing" : "📋 Edit list";
  if (persist) { try { localStorage.setItem("inkpad.roster.editorOpen", open ? "1" : "0"); } catch (_) {} }
}
function maybeAutoOpenEditorForEmptyRoster() {
  const r = activeRoster();
  if (r && !r.names.length) setRosterEditorOpen(true, false);
}
function refreshRosterUI() {
  const sel = $("rpRosterSelect");
  if (!sel) return;
  sel.innerHTML = libRosters.map(r => {
    const folderTag = r.folderId && folderNameFor(r.folderId) ? ` · ${escapeXml(folderNameFor(r.folderId))}` : "";
    return `<option value="${r.id}"${r.id === activeRosterId ? " selected" : ""}>${escapeXml(r.name)}${folderTag}</option>`;
  }).join("");
  const r = activeRoster();
  $("rpRoster").value = r ? r.names.join("\n") : "";
  updateRosterStatus();
}
function currentRosterNames() { return $("rpRoster").value.split("\n").map(s => s.trim()).filter(Boolean); }
let rpPicked = new Set(); // names already drawn this round, while "no repeats" is on
function updateRosterStatus() {
  const names = currentRosterNames();
  const remaining = names.filter(n => !rpPicked.has(n));
  $("rpRosterStatus").textContent = $("rpNoRepeat").checked
    ? `${remaining.length} of ${names.length} left this round`
    : `${names.length} student${names.length === 1 ? "" : "s"} in roster`;
}
// Rapidly swaps a display element through random candidate values before settling on the real
// pick — a lightweight "spin" feel shared by the student/dice/number pickers, without needing an
// actual animated wheel graphic.
function spinReveal(el, candidates, finalText, durMs = 650) {
  if (!candidates.length) { el.textContent = finalText; return; }
  const start = performance.now();
  const step = () => {
    const t = performance.now() - start;
    if (t >= durMs) { el.textContent = finalText; return; }
    el.textContent = candidates[Math.floor(Math.random() * candidates.length)];
    setTimeout(step, 55 + (t / durMs) * 90); // slows down as it approaches the final value
  };
  step();
}
function pickStudent() {
  const names = currentRosterNames();
  saveActiveRosterNames(names);
  if (!names.length) { $("rpResult").textContent = "Add names below"; return; }
  const noRepeat = $("rpNoRepeat").checked;
  let pool = noRepeat ? names.filter(n => !rpPicked.has(n)) : names;
  if (!pool.length) { rpPicked.clear(); pool = names; }
  const pick = pool[Math.floor(Math.random() * pool.length)];
  if (noRepeat) rpPicked.add(pick);
  spinReveal($("rpResult"), names, pick);
  updateRosterStatus();
}
function rollDice() {
  const count = Math.max(1, Math.min(6, Math.round(+$("rpDiceCount").value) || 1));
  const sides = +$("rpDiceSides").value || 6;
  const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
  const row = $("rpDiceRow");
  row.innerHTML = rolls.map(() => `<div class="rp-die">?</div>`).join("");
  const dice = [...row.children];
  $("rpDiceTotal").textContent = "";
  let ticks = 0;
  const iv = setInterval(() => {
    dice.forEach(d => d.textContent = 1 + Math.floor(Math.random() * sides));
    ticks++;
    if (ticks > 8) {
      clearInterval(iv);
      dice.forEach((d, i) => d.textContent = rolls[i]);
      $("rpDiceTotal").textContent = count > 1 ? `Total: ${rolls.reduce((a, b) => a + b, 0)}` : "";
    }
  }, 70);
}
function spinNumber() {
  const a = Math.round(+$("rpNumMin").value || 0), b = Math.round(+$("rpNumMax").value || 0);
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const pick = lo + Math.floor(Math.random() * (hi - lo + 1));
  const candidates = Array.from({ length: Math.min(hi - lo + 1, 50) }, () => String(lo + Math.floor(Math.random() * (hi - lo + 1))));
  spinReveal($("rpNumberResult"), candidates, String(pick));
}
function openRandomDlg(skipResolve) {
  // strict === true, not just truthy: the toolbar wires this straight to onclick (btn() does
  // `b.onclick = fn`), so a normal click passes the MouseEvent as this argument
  if (skipResolve !== true) resolveActiveRosterForCurrentNotebook();
  refreshRosterUI();
  $("rpNoRepeat").checked = localStorage.getItem("inkpad.roster.noRepeat") === "1";
  setRosterEditorOpen(localStorage.getItem("inkpad.roster.editorOpen") === "1", false);
  maybeAutoOpenEditorForEmptyRoster();
  $("randomDlg").showModal();
}
function wireRandomDlg() {
  const dlg = $("randomDlg");
  dlg.querySelectorAll(".rp-tab").forEach(tab => {
    tab.onclick = () => {
      dlg.querySelectorAll(".rp-tab").forEach(t => t.classList.toggle("active", t === tab));
      ["students", "dice", "number"].forEach(k => {
        $("rp" + k[0].toUpperCase() + k.slice(1)).style.display = k === tab.dataset.tab ? "" : "none";
      });
    };
  });
  dlg.querySelector('.rp-tab[data-tab="students"]').click();
  $("rpRosterSelect").onchange = () => { setActiveRosterId($("rpRosterSelect").value); refreshRosterUI(); maybeAutoOpenEditorForEmptyRoster(); };
  $("rpNewRosterBtn").onclick = createRoster;
  $("rpRenameRosterBtn").onclick = renameRoster;
  $("rpDeleteRosterBtn").onclick = deleteRoster;
  $("rpToggleEditBtn").onclick = () => setRosterEditorOpen($("rpRosterEditor").style.display === "none");
  $("rpPickBtn").onclick = pickStudent;
  $("rpResetPicksBtn").onclick = () => { rpPicked.clear(); updateRosterStatus(); };
  $("rpRoster").addEventListener("change", () => { saveActiveRosterNames(currentRosterNames()); rpPicked.clear(); updateRosterStatus(); });
  $("rpNoRepeat").onchange = () => {
    localStorage.setItem("inkpad.roster.noRepeat", $("rpNoRepeat").checked ? "1" : "0");
    rpPicked.clear(); updateRosterStatus();
  };
  $("rpRollBtn").onclick = rollDice;
  $("rpSpinBtn").onclick = spinNumber;
}

/* ---------------- timer / stopwatch overlay ---------------- */
// A floating, non-modal panel (unlike randomDlg's <dialog>) — a teacher keeps drawing/writing
// while it counts, so it deliberately doesn't block canvas pointer/keyboard input the way a
// modal would.
