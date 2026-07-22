"use strict";
function confirmDialog(title, body, onConfirm, onCancel, opts) {
  $("confirmTitle").textContent = title;
  $("confirmBody").textContent = body;
  const dlg = $("confirmDlg");
  const okBtn = $("confirmOk");
  okBtn.textContent = (opts && opts.okLabel) || "Delete";
  okBtn.style.background = opts && opts.safe ? "" : "#FBEAEA";
  okBtn.style.borderColor = opts && opts.safe ? "" : "#E3A9A9";
  $("confirmCancel").onclick = () => { dlg.close(); if (onCancel) onCancel(); };
  okBtn.onclick = () => { dlg.close(); onConfirm(); };
  dlg.showModal();
}
// Same dialog, promise-flavored — for non-destructive yes/no confirmations (e.g. "copy your
// notebooks into this folder?") where confirmDialog's callback style and "Delete"-red default
// styling don't fit.
function confirmDialogAsync(title, body, okLabel) {
  return new Promise(resolve =>
    confirmDialog(title, body, () => resolve(true), () => resolve(false), { okLabel, safe: true })
  );
}

// Small text-input dialog (name a new notebook/folder, etc.) — resolves the entered string, or
// null if cancelled. Mirrors confirmDialog's element-reuse pattern rather than building a fresh
// <dialog> per call.
//
// Deliberately does NOT rely on native <form> submission (no type=submit button, no onsubmit as
// the primary path) — a plain text input inside a <form> can have its Enter/submit behavior
// hijacked by browser autofill or extensions (password managers, form fillers), which on a
// file:// page surfaces as Chrome blocking a same-URL navigation ("Unsafe attempt to load URL ...
// 'file:' URLs are treated as unique security origins") instead of the dialog just closing. OK/
// Cancel/Enter/Escape are all wired directly instead, with onsubmit kept only as a no-op safety
// net in case some environment still fires a submit event.
function promptDialog(title, placeholder, defaultValue) {
  return new Promise(resolve => {
    const dlg = $("promptDlg");
    $("promptTitle").textContent = title;
    const input = $("promptInput");
    input.placeholder = placeholder || "";
    input.value = defaultValue || "";
    let done = false;
    const cleanup = () => {
      $("promptCancel").onclick = null; $("promptOk").onclick = null; $("promptForm").onsubmit = null;
      input.removeEventListener("keydown", onKeydown);
    };
    const finish = val => { if (done) return; done = true; cleanup(); dlg.close(); resolve(val); };
    const onKeydown = e => {
      if (e.key === "Enter") { e.preventDefault(); finish(input.value); }
      else if (e.key === "Escape") { e.preventDefault(); finish(null); }
    };
    $("promptCancel").onclick = () => finish(null);
    $("promptOk").onclick = () => finish(input.value);
    $("promptForm").onsubmit = e => e.preventDefault();
    input.addEventListener("keydown", onKeydown);
    dlg.showModal();
    input.focus(); input.select();
  });
}

function showPagePicker({ title, items, okLabel, extraControls }) {
  return new Promise(resolve => {
    const dlg = $("pagePickerDlg");
    $("pagePickerTitle").textContent = title;
    const grid = $("pagePickerGrid");
    grid.innerHTML = "";
    const checked = items.map(() => true);
    const paintCount = () => {
      $("ppCount").textContent = `${checked.filter(Boolean).length} of ${items.length} selected`;
    };
    items.forEach((it, i) => {
      const cell = document.createElement("div");
      cell.className = "pp-thumb checked" + (it.empty ? " empty" : "");
      cell.innerHTML =
        `<div class="pp-check"><svg viewBox="0 0 16 16"><path d="M3 8l4 4 6-7"/></svg></div>` +
        (it.thumbURL ? `<img src="${it.thumbURL}" draggable="false">` : `<div style="flex:1"></div>`) +
        `<div class="pp-label">${it.label}</div>`;
      cell.onclick = () => { checked[i] = !checked[i]; cell.classList.toggle("checked", checked[i]); paintCount(); };
      grid.appendChild(cell);
    });
    paintCount();
    const fc = $("ppFileType");
    fc.innerHTML = "";
    if (extraControls) fc.appendChild(extraControls);
    $("ppAll").onclick = () => { checked.fill(true); [...grid.children].forEach(c => c.classList.add("checked")); paintCount(); };
    $("ppNone").onclick = () => { checked.fill(false); [...grid.children].forEach(c => c.classList.remove("checked")); paintCount(); };
    $("ppOk").textContent = okLabel || "OK";
    const cleanup = () => { $("ppCancel").onclick = null; $("pagePickerForm").onsubmit = null; };
    $("ppCancel").onclick = () => { cleanup(); dlg.close(); resolve(null); };
    $("pagePickerForm").onsubmit = e => {
      e.preventDefault();
      cleanup();
      dlg.close();
      const idxs = checked.map((c, i) => c ? i : -1).filter(i => i >= 0);
      resolve(idxs.length ? idxs : null);
    };
    dlg.showModal();
  });
}

// Clears every page's content in place, without touching which notebook is active or its
// name/folder — shared by "Delete entire document…" (clears the current notebook, keeps it in
// the library) and by opening a freshly-created, still-empty notebook for the first time.
