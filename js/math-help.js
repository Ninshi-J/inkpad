"use strict";
/* ============================================================================
   Math typesetting reference — a searchable, comprehensive KaTeX cheat sheet.

   Distinct from #mathHelperPanel (js/text-edit.js), which is a deliberately short
   grid of the handful of things you reach for constantly. This is the other half:
   the thing you open when you know what you want and need to find how to write it
   ("how do I subscript the perpendicular symbol?"). Hence search over browsing --
   every entry carries plain-English keywords, so "perpendicular" finds \perp even
   though the command shares no letters with the word.

   Every entry is live-rendered with the same KaTeX the canvas uses, so what's shown
   is exactly what the page will draw, and clicking one inserts it at the cursor.
   ========================================================================== */

// { i: what gets inserted ("$1" = where the cursor lands), s: what's rendered as the
//   preview, k: extra search keywords }. `s` defaults to `i` with the $1 marker removed.
const MATH_HELP = [
  ["Start here", [
    { i: "^{$1}", s: "x^{n}", k: "superscript power exponent index raise squared cubed above" },
    { i: "_{$1}", s: "x_{n}", k: "subscript below under index suffix" },
    { i: "_{$1}^{}", s: "x_{i}^{n}", k: "subscript superscript both together" },
    { i: "\\frac{$1}{}", s: "\\frac{a}{b}", k: "fraction divide over quotient ratio" },
    { i: "\\sqrt{$1}", s: "\\sqrt{x}", k: "square root surd radical" },
    { i: "\\sqrt[$1]{}", s: "\\sqrt[n]{x}", k: "nth root cube root radical" },
    { i: "\\text{$1}", s: "\\text{words}", k: "text words plain upright roman non-italic label" },
  ]],

  // Answers the "subscript a symbol" question head-on: braces are what let a command
  // sit in a sub/superscript, and that isn't obvious from the individual entries.
  ["Combining things", [
    { i: "_\\perp", s: "F_\\perp", k: "subscript perpendicular symbol component perp" },
    { i: "_{\\parallel}", s: "F_{\\parallel}", k: "subscript parallel component" },
    { i: "_{\\text{$1}}", s: "v_{\\text{max}}", k: "subscript word text label max min total" },
    { i: "^{$1}", s: "x^{2n}", k: "superscript multiple characters braces group" },
    { i: "\\vec{$1}", s: "\\vec{F}_\\perp", k: "vector with subscript combine accent" },
    { i: "{$1}", s: "a^{bc}", k: "braces group grouping multiple characters more than one" },
  ]],

  ["Geometry", [
    { i: "\\perp", k: "perpendicular right angle normal orthogonal" },
    { i: "\\parallel", k: "parallel" },
    { i: "\\nparallel", k: "not parallel" },
    { i: "\\angle", k: "angle" },
    { i: "\\measuredangle", k: "measured angle" },
    { i: "\\triangle", k: "triangle" },
    { i: "\\square", k: "square quadrilateral" },
    { i: "\\cong", k: "congruent" },
    { i: "\\sim", k: "similar tilde" },
    { i: "\\overline{$1}", s: "\\overline{AB}", k: "segment line over bar overline" },
    { i: "\\overrightarrow{$1}", s: "\\overrightarrow{AB}", k: "ray vector arrow over" },
    { i: "\\overleftrightarrow{$1}", s: "\\overleftrightarrow{AB}", k: "line both arrows" },
    { i: "^\\circ", s: "90^\\circ", k: "degree degrees angle circle" },
    { i: "\\pi", k: "pi" },
  ]],

  ["Relations", [
    { i: "=", k: "equals" }, { i: "\\neq", k: "not equal" },
    { i: "\\approx", k: "approximately about roughly" },
    { i: "\\equiv", k: "equivalent identical congruent modulo" },
    { i: "\\leq", k: "less than or equal" }, { i: "\\geq", k: "greater than or equal" },
    { i: "<", k: "less than" }, { i: ">", k: "greater than" },
    { i: "\\ll", k: "much less than" }, { i: "\\gg", k: "much greater than" },
    { i: "\\propto", k: "proportional to varies" },
    { i: "\\doteq", k: "approaches equals dot" },
  ]],

  ["Operators", [
    { i: "\\times", k: "times multiply cross product" },
    { i: "\\div", k: "divide division obelus" },
    { i: "\\cdot", k: "dot multiply centre product" },
    { i: "\\pm", k: "plus minus plus or minus" },
    { i: "\\mp", k: "minus plus" },
    { i: "\\ast", k: "asterisk star convolution" },
    { i: "\\circ", k: "composition ring compose" },
    { i: "\\oplus", k: "direct sum circled plus xor" },
    { i: "\\otimes", k: "tensor circled times" },
    { i: "\\bmod", s: "a \\bmod b", k: "modulo modulus remainder" },
  ]],

  ["Greek — lower case", [
    { i: "\\alpha", k: "alpha a" }, { i: "\\beta", k: "beta b" }, { i: "\\gamma", k: "gamma g" },
    { i: "\\delta", k: "delta d" }, { i: "\\epsilon", k: "epsilon e" }, { i: "\\varepsilon", k: "varepsilon" },
    { i: "\\zeta", k: "zeta" }, { i: "\\eta", k: "eta" }, { i: "\\theta", k: "theta angle" },
    { i: "\\vartheta", k: "vartheta" }, { i: "\\iota", k: "iota" }, { i: "\\kappa", k: "kappa" },
    { i: "\\lambda", k: "lambda wavelength" }, { i: "\\mu", k: "mu micro mean" }, { i: "\\nu", k: "nu frequency" },
    { i: "\\xi", k: "xi" }, { i: "\\rho", k: "rho density" }, { i: "\\sigma", k: "sigma std deviation" },
    { i: "\\tau", k: "tau" }, { i: "\\phi", k: "phi" }, { i: "\\varphi", k: "varphi" },
    { i: "\\chi", k: "chi" }, { i: "\\psi", k: "psi" }, { i: "\\omega", k: "omega" },
  ]],

  ["Greek — capitals", [
    { i: "\\Gamma", k: "gamma capital" }, { i: "\\Delta", k: "delta change difference triangle" },
    { i: "\\Theta", k: "theta capital" }, { i: "\\Lambda", k: "lambda capital" },
    { i: "\\Xi", k: "xi capital" }, { i: "\\Pi", k: "pi capital product" },
    { i: "\\Sigma", k: "sigma capital sum" }, { i: "\\Phi", k: "phi capital" },
    { i: "\\Psi", k: "psi capital" }, { i: "\\Omega", k: "omega capital ohm resistance" },
  ]],

  ["Sets & logic", [
    { i: "\\in", k: "element of member belongs in" },
    { i: "\\notin", k: "not an element not in" },
    { i: "\\subset", k: "subset" }, { i: "\\subseteq", k: "subset or equal" },
    { i: "\\supset", k: "superset" }, { i: "\\supseteq", k: "superset or equal" },
    { i: "\\cup", k: "union or join" }, { i: "\\cap", k: "intersection and meet" },
    { i: "\\emptyset", k: "empty set null" }, { i: "\\varnothing", k: "empty set null varnothing" },
    { i: "\\setminus", k: "set minus difference without" },
    { i: "\\forall", k: "for all every universal" },
    { i: "\\exists", k: "there exists some existential" },
    { i: "\\nexists", k: "there does not exist" },
    { i: "\\neg", k: "not negation logical" },
    { i: "\\land", k: "and conjunction logical wedge" },
    { i: "\\lor", k: "or disjunction logical vee" },
    { i: "\\therefore", k: "therefore so hence" },
    { i: "\\because", k: "because since" },
    { i: "\\mathbb{$1}", s: "\\mathbb{R}", k: "real numbers blackboard bold naturals integers set N Z Q R C" },
  ]],

  ["Arrows", [
    { i: "\\to", k: "to right arrow maps approaches limit" },
    { i: "\\rightarrow", k: "right arrow" }, { i: "\\leftarrow", k: "left arrow" },
    { i: "\\leftrightarrow", k: "both left right arrow" },
    { i: "\\Rightarrow", k: "implies double arrow then" },
    { i: "\\Leftarrow", k: "implied by double left" },
    { i: "\\iff", k: "if and only if equivalent double both" },
    { i: "\\mapsto", k: "maps to function" },
    { i: "\\uparrow", k: "up arrow" }, { i: "\\downarrow", k: "down arrow" },
  ]],

  ["Calculus & big operators", [
    { i: "\\sum_{$1}^{}", s: "\\sum_{i=1}^{n}", k: "sum summation sigma series total" },
    { i: "\\prod_{$1}^{}", s: "\\prod_{i=1}^{n}", k: "product pi" },
    { i: "\\int_{$1}^{}", s: "\\int_{a}^{b}", k: "integral antiderivative area" },
    { i: "\\iint", k: "double integral" }, { i: "\\oint", k: "contour closed integral" },
    { i: "\\lim_{$1}", s: "\\lim_{x \\to 0}", k: "limit approaches tends" },
    { i: "\\frac{d$1}{dx}", s: "\\frac{dy}{dx}", k: "derivative differentiate rate of change" },
    { i: "\\frac{\\partial $1}{\\partial x}", s: "\\frac{\\partial f}{\\partial x}", k: "partial derivative" },
    { i: "\\partial", k: "partial derivative del curly d" },
    { i: "\\nabla", k: "nabla del gradient divergence curl" },
    { i: "\\infty", k: "infinity unbounded" },
    { i: "\\Delta", s: "\\Delta x", k: "change in delta difference" },
  ]],

  ["Functions", [
    { i: "\\sin", k: "sine trig" }, { i: "\\cos", k: "cosine trig" }, { i: "\\tan", k: "tangent trig" },
    { i: "\\csc", k: "cosecant" }, { i: "\\sec", k: "secant" }, { i: "\\cot", k: "cotangent" },
    { i: "\\arcsin", k: "inverse sine arcsin" }, { i: "\\arccos", k: "inverse cosine" }, { i: "\\arctan", k: "inverse tangent" },
    { i: "\\log", k: "logarithm log" }, { i: "\\log_{$1}", s: "\\log_{2}", k: "log base subscript" },
    { i: "\\ln", k: "natural log" }, { i: "\\exp", k: "exponential" },
    { i: "\\min", k: "minimum" }, { i: "\\max", k: "maximum" },
  ]],

  ["Accents & bars", [
    { i: "\\hat{$1}", s: "\\hat{x}", k: "hat circumflex unit estimate" },
    { i: "\\bar{$1}", s: "\\bar{x}", k: "bar mean average overline" },
    { i: "\\vec{$1}", s: "\\vec{v}", k: "vector arrow" },
    { i: "\\dot{$1}", s: "\\dot{x}", k: "dot derivative time rate" },
    { i: "\\ddot{$1}", s: "\\ddot{x}", k: "double dot second derivative acceleration" },
    { i: "\\tilde{$1}", s: "\\tilde{x}", k: "tilde approx" },
    { i: "\\underline{$1}", s: "\\underline{x}", k: "underline under" },
    { i: "\\overbrace{$1}", s: "\\overbrace{a+b}", k: "brace over group" },
    { i: "\\underbrace{$1}", s: "\\underbrace{a+b}", k: "brace under group" },
  ]],

  ["Brackets & delimiters", [
    { i: "\\left( $1 \\right)", s: "\\left( \\frac{a}{b} \\right)", k: "auto sizing parentheses brackets round big" },
    { i: "\\left[ $1 \\right]", s: "\\left[ \\frac{a}{b} \\right]", k: "square brackets auto" },
    { i: "\\left\\{ $1 \\right\\}", s: "\\left\\{ \\frac{a}{b} \\right\\}", k: "curly braces set auto" },
    { i: "\\left| $1 \\right|", s: "\\left| x \\right|", k: "absolute value modulus magnitude bars" },
    { i: "\\left\\| $1 \\right\\|", s: "\\left\\| v \\right\\|", k: "norm magnitude double bars" },
    { i: "\\lfloor $1 \\rfloor", s: "\\lfloor x \\rfloor", k: "floor round down" },
    { i: "\\lceil $1 \\rceil", s: "\\lceil x \\rceil", k: "ceiling round up" },
    { i: "\\binom{$1}{}", s: "\\binom{n}{k}", k: "binomial choose combination nCr" },
  ]],

  ["Matrices & cases", [
    { i: "\\begin{pmatrix} $1 & \\\\ & \\end{pmatrix}", s: "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}", k: "matrix round brackets 2x2 array" },
    { i: "\\begin{bmatrix} $1 & \\\\ & \\end{bmatrix}", s: "\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}", k: "matrix square brackets" },
    { i: "\\begin{vmatrix} $1 & \\\\ & \\end{vmatrix}", s: "\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}", k: "determinant bars matrix" },
    { i: "\\begin{cases} $1 & \\text{if } \\\\ & \\text{otherwise} \\end{cases}", s: "\\begin{cases} x & \\text{if } x>0 \\\\ -x & \\text{otherwise} \\end{cases}", k: "cases piecewise conditional brace system" },
  ]],

  ["Styles & spacing", [
    { i: "\\mathrm{$1}", s: "\\mathrm{d}", k: "roman upright non italic" },
    { i: "\\mathbf{$1}", s: "\\mathbf{v}", k: "bold vector" },
    { i: "\\mathit{$1}", s: "\\mathit{x}", k: "italic" },
    { i: "\\mathcal{$1}", s: "\\mathcal{L}", k: "calligraphic script fancy" },
    { i: "\\mathbb{$1}", s: "\\mathbb{N}", k: "blackboard bold double struck" },
    { i: "\\,", s: "a\\,b", k: "thin space small gap" },
    { i: "\\;", s: "a\\;b", k: "medium space gap" },
    { i: "\\quad", s: "a\\quad b", k: "wide space gap quad" },
    { i: "\\!", s: "a\\!b", k: "negative space tighten" },
  ]],
];

// Cursor-marker stripped: what actually renders as the preview.
function mathHelpSample(entry) { return entry.s || entry.i.replace("$1", ""); }

/* ---------------- type-and-Tab abbreviations ----------------
   Typing the abbreviation and pressing Tab INSIDE a "$...$" run expands it (see
   expandMathAbbrev in js/text-edit.js). Outside a formula Tab still indents, untouched — that
   restriction is what makes two-letter abbreviations safe: there's no English prose inside a
   formula for "in" or "to" to be part of.

   Templates use the same "$1 = cursor lands here" convention as MATH_HELP above, and go through
   the same insertMathSnippet(), so a selection becomes the argument and the "$...$" wrapping
   rules are shared. Case matters, which is how "de"/"De" give delta and Delta.

   Deliberately not exhaustive — the cheat sheet is for finding the rare thing, this is for the
   handful typed constantly. Anything not listed just falls through to an indent. */
const MATH_ABBREV = {
  // structures
  fr: "\\frac{$1}{}", sq: "\\sqrt{$1}", cb: "\\sqrt[3]{$1}",
  ve: "\\vec{$1}", ha: "\\hat{$1}", ba: "\\bar{$1}", do: "\\dot{$1}", dd: "\\ddot{$1}",
  su: "\\sum_{$1}^{}", pr: "\\prod_{$1}^{}", in: "\\int_{$1}^{}", li: "\\lim_{$1}",
  pd: "\\partial", tx: "\\text{$1}",
  // units and degrees — upright, with the thin space that stops "5m" jamming together
  un: "\\,\\mathrm{$1}", deg: "^{\\circ}",
  // greek, lower case
  al: "\\alpha", be: "\\beta", ga: "\\gamma", de: "\\delta", ep: "\\epsilon", ze: "\\zeta",
  et: "\\eta", th: "\\theta", ka: "\\kappa", la: "\\lambda", mu: "\\mu", nu: "\\nu",
  xi: "\\xi", pi: "\\pi", rh: "\\rho", si: "\\sigma", ta: "\\tau", ph: "\\phi",
  ch: "\\chi", ps: "\\psi", om: "\\omega",
  // greek, capitals
  Ga: "\\Gamma", De: "\\Delta", Th: "\\Theta", La: "\\Lambda", Xi: "\\Xi", Pi: "\\Pi",
  Si: "\\Sigma", Ph: "\\Phi", Ps: "\\Psi", Om: "\\Omega",
  // operators and relations
  ti: "\\times", cd: "\\cdot", di: "\\div", pm: "\\pm", mp: "\\mp",
  ap: "\\approx", eq: "\\equiv", ne: "\\neq", le: "\\leq", ge: "\\geq",
  ll: "\\ll", gg: "\\gg", pp: "\\propto", inf: "\\infty",
  to: "\\to", ar: "\\rightarrow", im: "\\Rightarrow",
  // named functions
  sin: "\\sin", cos: "\\cos", tan: "\\tan", ln: "\\ln", lg: "\\log",
};
// Reverse lookup, so the cheat sheet can show "there's a shortcut for this one".
const MATH_ABBREV_BY_TPL = (() => {
  const m = {};
  for (const [k, v] of Object.entries(MATH_ABBREV)) if (!m[v]) m[v] = k;
  return m;
})();
const mathAbbrevFor = tpl => MATH_ABBREV_BY_TPL[tpl] || null;

let mathHelpBuilt = false;
function ensureKatexPageCss(css) {
  if (document.getElementById("katexPageCss")) return;
  const st = document.createElement("style");
  st.id = "katexPageCss";
  st.textContent = css;
  document.head.appendChild(st);
}

async function openMathHelpDlg() {
  const dlg = $("mathHelpDlg");
  dlg.showModal();
  const body = $("mhelpBody");
  const search = $("mhelpSearch");
  if (!mathHelpBuilt) {
    body.innerHTML = `<div class="mhelp-loading">Loading symbols…</div>`;
    try {
      const [katex, css] = await Promise.all([loadKatex(), loadInlinedKatexCss()]);
      ensureKatexPageCss(css);
      body.innerHTML = "";
      for (const [cat, entries] of MATH_HELP) {
        const h = document.createElement("div");
        h.className = "mhelp-cat"; h.textContent = cat;
        h.dataset.cat = cat;
        body.appendChild(h);
        const grid = document.createElement("div");
        grid.className = "mhelp-grid"; grid.dataset.cat = cat;
        for (const e of entries) {
          const cell = document.createElement("button");
          cell.type = "button";
          cell.className = "mhelp-item";
          // Searchable haystack: the command itself plus plain-English keywords, so
          // "perpendicular" finds \perp even sharing no letters with it.
          const abbr = mathAbbrevFor(e.i);
          cell.dataset.find = `${e.i} ${e.s || ""} ${e.k || ""} ${cat} ${abbr || ""}`.toLowerCase();
          const prev = document.createElement("span");
          prev.className = "mhelp-prev";
          try { prev.innerHTML = katex.renderToString(mathHelpSample(e), { throwOnError: false, displayMode: false }); }
          catch (_) { prev.textContent = mathHelpSample(e); }
          const code = document.createElement("code");
          code.textContent = e.i.replace("$1", "");
          cell.append(prev, code);
          // Nobody discovers a typing shortcut on their own, so the ones that have one say so.
          if (abbr) {
            const tag = document.createElement("kbd");
            tag.className = "mhelp-abbr";
            tag.textContent = `${abbr} ⇥`;
            tag.title = `Inside $…$, type "${abbr}" and press Tab`;
            cell.append(tag);
          }
          cell.onclick = () => useMathHelpEntry(e);
          grid.appendChild(cell);
        }
        body.appendChild(grid);
      }
      mathHelpBuilt = true;
    } catch (err) {
      body.innerHTML = `<div class="mhelp-loading">Couldn't load the symbol previews (${err && err.message ? err.message : err}).</div>`;
      return;
    }
  }
  $("mhelpHint").textContent = editingText
    ? "Click any symbol to insert it at your cursor."
    : "Click any symbol to copy its command. Open a text box first to insert directly.";
  search.value = "";
  filterMathHelp("");
  search.focus();
}

function filterMathHelp(q) {
  const body = $("mhelpBody");
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  let anyShown = false;
  for (const grid of body.querySelectorAll(".mhelp-grid")) {
    let shown = 0;
    for (const cell of grid.children) {
      // Every term must match somewhere, so "sub perp" narrows rather than widens.
      const hit = terms.every(t => cell.dataset.find.includes(t));
      cell.style.display = hit ? "" : "none";
      if (hit) shown++;
    }
    grid.style.display = shown ? "" : "none";
    const head = body.querySelector(`.mhelp-cat[data-cat="${CSS.escape(grid.dataset.cat)}"]`);
    if (head) head.style.display = shown ? "" : "none";
    if (shown) anyShown = true;
  }
  $("mhelpEmpty").style.display = anyShown ? "none" : "";
}

function useMathHelpEntry(e) {
  if (editingText) {
    insertMathSnippet(e.i);
    $("mathHelpDlg").close();
    return;
  }
  const cmd = e.i.replace("$1", "");
  const done = () => { $("mhelpHint").textContent = `Copied  ${cmd}  to the clipboard.`; };
  try { navigator.clipboard.writeText(cmd).then(done, done); } catch (_) { done(); }
}

function wireMathHelpDlg() {
  // Reachable from the F1 shortcuts dialog too, not only from inside a text box — you often
  // want to look something up before you've started typing it.
  $("helpMathRefBtn").onclick = () => { $("helpDlg").close(); openMathHelpDlg(); };
  $("mhelpSearch").addEventListener("input", ev => filterMathHelp(ev.target.value));
  // Escape is handled natively by <dialog>; this stops the keystroke also reaching the
  // canvas hotkey handler behind it.
  $("mhelpSearch").addEventListener("keydown", ev => ev.stopPropagation());
}
