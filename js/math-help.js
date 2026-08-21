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

/* Every entry is authored ONCE, in Typst, and the LaTeX form is derived from it by
   js/typst-math.js when the math-syntax setting says LaTeX -- so the two flavours can't drift
   apart the way two hand-maintained tables would.

   { i: what gets inserted, in Typst ("$1" = where the cursor lands),
     l: the LaTeX form to insert instead, ONLY where the translator can't derive it -- fragments
        like "^($1)" that aren't valid maths standing on their own, and the couple of places
        where Typst spells two different LaTeX things the same way,
     s: what's rendered as the preview, also Typst; defaults to `i` with the marker removed,
     k: extra search keywords }.

   Search keywords still carry the LaTeX names as well ("frac", "cdot"), and the haystack built
   in openMathHelpDlg() includes the derived LaTeX too, so looking up what you already know the
   LaTeX name for still finds the Typst way of writing it. */
const MATH_HELP = [
  ["Start here", [
    { i: "($1)/()", s: "a/b", k: "fraction frac divide over quotient ratio slash" },
    { i: "^($1)", l: "^{$1}", s: "x^n", k: "superscript power exponent index raise squared cubed above" },
    { i: "_($1)", l: "_{$1}", s: "x_n", k: "subscript below under index suffix" },
    { i: "_($1)^()", l: "_{$1}^{}", s: "x_i^n", k: "subscript superscript both together" },
    { i: "sqrt($1)", s: "sqrt(x)", k: "square root surd radical" },
    { i: "root($1, )", s: "root(n, x)", k: "nth root cube root radical" },
    { i: "\"$1\"", s: "\"words\"", k: "text words plain upright roman non-italic label quotes" },
  ]],

  /* Answers the "subscript a symbol" question head-on: in Typst it's round brackets that let a
     whole expression sit in a sub/superscript, and that isn't obvious from the entries alone. */
  ["Combining things", [
    { i: "_perp", l: "_\\perp", s: "F_perp", k: "subscript perpendicular symbol component perp" },
    { i: "_(parallel)", l: "_{\\parallel}", s: "F_parallel", k: "subscript parallel component" },
    { i: "_(\"$1\")", l: "_{\\text{$1}}", s: "v_(\"max\")", k: "subscript word text label max min total" },
    { i: "^($1)", l: "^{$1}", s: "x^(2n)", k: "superscript multiple characters brackets group" },
    { i: "arrow($1)", s: "arrow(F)_perp", k: "vector with subscript combine accent" },
    // In Typst round brackets both group AND auto-size, so this one entry covers what took two
    // in LaTeX ("{...}" for grouping, "\left( \right)" for sizing).
    { i: "($1)", l: "{$1}", s: "a^(b c)", k: "brackets braces group grouping multiple characters more than one auto sizing parentheses round big" },
  ]],

  ["Geometry", [
    { i: "perp", k: "perpendicular right angle normal orthogonal" },
    { i: "parallel", k: "parallel" },
    { i: "parallel.not", k: "not parallel nparallel" },
    { i: "angle", k: "angle" },
    { i: "angle.arc", k: "measured angle" },
    { i: "triangle", k: "triangle" },
    { i: "square", k: "square quadrilateral" },
    { i: "tilde.eq", k: "congruent cong" },
    { i: "tilde", k: "similar tilde sim" },
    { i: "overline($1)", s: "overline(A B)", k: "segment line over bar overline" },
    { i: "arrow($1)", s: "arrow(A B)", k: "ray vector arrow over overrightarrow" },
    { i: "arrow.l.r($1)", s: "arrow.l.r(A B)", k: "line both arrows overleftrightarrow" },
    { i: "degree", s: "90 degree", k: "degree degrees angle circle" },
    { i: "pi", k: "pi" },
  ]],

  ["Relations", [
    { i: "=", k: "equals" }, { i: "eq.not", k: "not equal neq" },
    { i: "approx", k: "approximately about roughly" },
    { i: "equiv", k: "equivalent identical congruent modulo" },
    { i: "lt.eq", k: "less than or equal leq" }, { i: "gt.eq", k: "greater than or equal geq" },
    { i: "<", k: "less than" }, { i: ">", k: "greater than" },
    { i: "lt.double", k: "much less than ll" }, { i: "gt.double", k: "much greater than gg" },
    { i: "prop", k: "proportional to varies propto" },
    { i: "eq.dot", k: "approaches equals dot doteq" },
  ]],

  ["Operators", [
    { i: "times", k: "times multiply cross product" },
    { i: "div", k: "divide division obelus" },
    { i: "dot", k: "dot multiply centre product cdot" },
    { i: "plus.minus", k: "plus minus plus or minus pm" },
    { i: "minus.plus", k: "minus plus mp" },
    { i: "ast", k: "asterisk star convolution" },
    { i: "circle", k: "composition ring compose circ" },
    { i: "plus.circle", k: "direct sum circled plus xor oplus" },
    { i: "times.circle", k: "tensor circled times otimes" },
    { i: "mod", s: "a mod b", k: "modulo modulus remainder bmod" },
  ]],

  ["Greek — lower case", [
    { i: "alpha", k: "alpha a" }, { i: "beta", k: "beta b" }, { i: "gamma", k: "gamma g" },
    { i: "delta", k: "delta d" }, { i: "epsilon", k: "epsilon e varepsilon" },
    { i: "epsilon.alt", k: "epsilon alternate straight" },
    { i: "zeta", k: "zeta" }, { i: "eta", k: "eta" }, { i: "theta", k: "theta angle" },
    { i: "theta.alt", k: "vartheta theta alternate" }, { i: "iota", k: "iota" }, { i: "kappa", k: "kappa" },
    { i: "lambda", k: "lambda wavelength" }, { i: "mu", k: "mu micro mean" }, { i: "nu", k: "nu frequency" },
    { i: "xi", k: "xi" }, { i: "rho", k: "rho density" }, { i: "sigma", k: "sigma std deviation" },
    { i: "tau", k: "tau" }, { i: "phi", k: "phi" }, { i: "phi.alt", k: "varphi phi alternate" },
    { i: "chi", k: "chi" }, { i: "psi", k: "psi" }, { i: "omega", k: "omega" },
  ]],

  ["Greek — capitals", [
    { i: "Gamma", k: "gamma capital" }, { i: "Delta", k: "delta change difference triangle" },
    { i: "Theta", k: "theta capital" }, { i: "Lambda", k: "lambda capital" },
    { i: "Xi", k: "xi capital" }, { i: "Pi", k: "pi capital product" },
    { i: "Sigma", k: "sigma capital sum" }, { i: "Phi", k: "phi capital" },
    { i: "Psi", k: "psi capital" }, { i: "Omega", k: "omega capital ohm resistance" },
  ]],

  ["Sets & logic", [
    { i: "in", k: "element of member belongs in" },
    { i: "in.not", k: "not an element not in notin" },
    { i: "subset", k: "subset" }, { i: "subset.eq", k: "subset or equal subseteq" },
    { i: "supset", k: "superset" }, { i: "supset.eq", k: "superset or equal supseteq" },
    { i: "union", k: "union or join cup" }, { i: "sect", k: "intersection and meet cap" },
    { i: "emptyset", k: "empty set null varnothing" },
    { i: "without", k: "set minus difference without setminus" },
    { i: "forall", k: "for all every universal" },
    { i: "exists", k: "there exists some existential" },
    { i: "exists.not", k: "there does not exist nexists" },
    { i: "not", k: "not negation logical neg" },
    { i: "and", k: "and conjunction logical wedge land" },
    { i: "or", k: "or disjunction logical vee lor" },
    { i: "therefore", k: "therefore so hence" },
    { i: "because", k: "because since" },
    { i: "bb($1)", s: "bb(R)", k: "real numbers blackboard bold naturals integers set N Z Q R C mathbb" },
  ]],

  ["Arrows", [
    { i: "->", k: "to right arrow maps approaches limit" },
    { i: "arrow.r", k: "right arrow rightarrow" }, { i: "arrow.l", k: "left arrow leftarrow" },
    { i: "arrow.l.r", k: "both left right arrow leftrightarrow" },
    { i: "=>", k: "implies double arrow then Rightarrow" },
    { i: "arrow.l.double", k: "implied by double left Leftarrow" },
    { i: "arrow.l.r.double", k: "if and only if iff equivalent double both" },
    { i: "arrow.r.bar", k: "maps to function mapsto" },
    { i: "arrow.t", k: "up arrow uparrow" }, { i: "arrow.b", k: "down arrow downarrow" },
  ]],

  ["Calculus & big operators", [
    { i: "sum_($1)^()", s: "sum_(i=1)^n", k: "sum summation sigma series total" },
    { i: "product_($1)^()", s: "product_(i=1)^n", k: "product pi prod" },
    { i: "integral_($1)^()", s: "integral_a^b", k: "integral antiderivative area int" },
    { i: "integral.double", k: "double integral iint" },
    { i: "integral.cont", k: "contour closed integral oint" },
    { i: "lim_($1)", s: "lim_(x -> 0)", k: "limit approaches tends" },
    { i: "(d $1)/(d x)", s: "(d y)/(d x)", k: "derivative differentiate rate of change" },
    { i: "(diff $1)/(diff x)", s: "(diff f)/(diff x)", k: "partial derivative" },
    { i: "diff", k: "partial derivative del curly d" },
    { i: "nabla", k: "nabla del gradient divergence curl" },
    { i: "infinity", k: "infinity unbounded infty oo" },
    { i: "Delta", s: "Delta x", k: "change in delta difference" },
  ]],

  ["Functions", [
    { i: "sin", k: "sine trig" }, { i: "cos", k: "cosine trig" }, { i: "tan", k: "tangent trig" },
    { i: "csc", k: "cosecant" }, { i: "sec", k: "secant" }, { i: "cot", k: "cotangent" },
    { i: "arcsin", k: "inverse sine arcsin" }, { i: "arccos", k: "inverse cosine" }, { i: "arctan", k: "inverse tangent" },
    { i: "log", k: "logarithm log" }, { i: "log_($1)", s: "log_2", k: "log base subscript" },
    { i: "ln", k: "natural log" }, { i: "exp", k: "exponential" },
    { i: "min", k: "minimum" }, { i: "max", k: "maximum" },
  ]],

  ["Accents & bars", [
    { i: "hat($1)", s: "hat(x)", k: "hat circumflex unit estimate" },
    { i: "bar($1)", s: "bar(x)", k: "bar mean average overline" },
    { i: "arrow($1)", s: "arrow(v)", k: "vector arrow vec" },
    { i: "dot($1)", s: "dot(x)", k: "dot derivative time rate" },
    { i: "dot.double($1)", s: "dot.double(x)", k: "double dot second derivative acceleration ddot" },
    { i: "tilde($1)", s: "tilde(x)", k: "tilde approx" },
    { i: "underline($1)", s: "underline(x)", k: "underline under" },
    { i: "overbrace($1)", s: "overbrace(a+b)", k: "brace over group" },
    { i: "underbrace($1)", s: "underbrace(a+b)", k: "brace under group" },
  ]],

  ["Brackets & delimiters", [
    { i: "[$1]", s: "[a/b]", k: "square brackets auto sizing" },
    { i: "{$1}", s: "{a, b}", k: "curly braces set auto sizing" },
    { i: "abs($1)", s: "abs(x)", k: "absolute value modulus magnitude bars" },
    { i: "norm($1)", s: "norm(v)", k: "norm magnitude double bars" },
    { i: "floor($1)", s: "floor(x)", k: "floor round down" },
    { i: "ceil($1)", s: "ceil(x)", k: "ceiling round up" },
    { i: "binom($1, )", s: "binom(n, k)", k: "binomial choose combination nCr" },
  ]],

  ["Matrices & cases", [
    { i: "mat($1, ; , )", s: "mat(a, b; c, d)", k: "matrix round brackets 2x2 array pmatrix" },
    { i: "mat($1, ; , , delim: \"[\")", s: "mat(a, b; c, d, delim: \"[\")", k: "matrix square brackets bmatrix" },
    { i: "mat($1, ; , , delim: \"|\")", s: "mat(a, b; c, d, delim: \"|\")", k: "determinant bars matrix vmatrix" },
    { i: "vec($1, )", s: "vec(a, b)", k: "column vector" },
    // The spaces inside the quotes matter: LaTeX's "&" used to open the gap between the value
    // and its condition, and without an alignment column the words jam together ("xif x>0").
    { i: "cases($1 \" if \", \" otherwise\")", s: "cases(x \" if \" x>0, -x \" otherwise\")", k: "cases piecewise conditional brace system" },
  ]],

  ["Styles & spacing", [
    { i: "upright($1)", s: "upright(d)", k: "roman upright non italic mathrm" },
    { i: "bold($1)", s: "bold(v)", k: "bold vector mathbf" },
    { i: "italic($1)", s: "italic(x)", k: "italic mathit" },
    { i: "cal($1)", s: "cal(L)", k: "calligraphic script fancy mathcal" },
    { i: "bb($1)", s: "bb(N)", k: "blackboard bold double struck mathbb" },
    { i: "thin", s: "a thin b", k: "thin space small gap" },
    { i: "med", s: "a med b", k: "medium space gap" },
    { i: "quad", s: "a quad b", k: "wide space gap quad" },
  ]],
];

// Cursor-marker stripped: what actually renders as the preview. Always the Typst form, since
// the preview goes through typstToLatex() on its way to KaTeX either way.
function mathHelpSample(entry) { return entry.s || entry.i.replace("$1", ""); }

/* ---------------- type-and-Tab abbreviations ----------------
   Typing the abbreviation and pressing Tab INSIDE a "$...$" run expands it (see
   expandMathAbbrev in js/text-edit.js). Outside a formula Tab still indents, untouched — that
   restriction is what makes two-letter abbreviations safe: there's no English prose inside a
   formula for "to" to be part of.

   Authored in Typst like everything else, and put through mathSnippet() at the point of
   insertion, so the same keystroke gives you whichever flavour the setting is on.

   Note what ISN'T here any more: "in" used to expand to \int. Under Typst "in" is the word for
   ∈, and an abbreviation that swallowed it every time you typed "x in A" would be unusable, so
   the integral moved to "ig". Several others ("fr" for a fraction, "pi", "al") now save far
   fewer keystrokes than they did, since Typst spells them close to how you say them — they're
   kept because the muscle memory is already there, not because they still earn their place.

   Deliberately not exhaustive — the cheat sheet is for finding the rare thing, this is for the
   handful typed constantly. Anything not listed just falls through to an indent. */
const MATH_ABBREV = {
  // structures
  fr: "($1)/()", sq: "sqrt($1)", cb: "root(3, $1)",
  ve: "arrow($1)", ha: "hat($1)", ba: "bar($1)", do: "dot($1)", dd: "dot.double($1)",
  su: "sum_($1)^()", pr: "product_($1)^()", ig: "integral_($1)^()", li: "lim_($1)",
  pd: "diff", tx: "\"$1\"",
  // units and degrees — upright, with the thin space that stops "5m" jamming together
  un: "thin \"$1\"", deg: "degree",
  // greek, lower case
  al: "alpha", be: "beta", ga: "gamma", de: "delta", ep: "epsilon", ze: "zeta",
  et: "eta", th: "theta", ka: "kappa", la: "lambda", mu: "mu", nu: "nu",
  xi: "xi", pi: "pi", rh: "rho", si: "sigma", ta: "tau", ph: "phi",
  ch: "chi", ps: "psi", om: "omega",
  // greek, capitals
  Ga: "Gamma", De: "Delta", Th: "Theta", La: "Lambda", Xi: "Xi", Pi: "Pi",
  Si: "Sigma", Ph: "Phi", Ps: "Psi", Om: "Omega",
  // operators and relations
  ti: "times", cd: "dot", di: "div", pm: "plus.minus", mp: "minus.plus",
  ap: "approx", eq: "equiv", ne: "eq.not", le: "lt.eq", ge: "gt.eq",
  ll: "lt.double", gg: "gt.double", pp: "prop", inf: "infinity",
  to: "->", ar: "arrow.r", im: "=>",
  // named functions
  sin: "sin", cos: "cos", tan: "tan", ln: "ln", lg: "log",
};
// Reverse lookup, so the cheat sheet can show "there's a shortcut for this one".
const MATH_ABBREV_BY_TPL = (() => {
  const m = {};
  for (const [k, v] of Object.entries(MATH_ABBREV)) if (!m[v]) m[v] = k;
  return m;
})();
const mathAbbrevFor = tpl => MATH_ABBREV_BY_TPL[tpl] || null;
/* Three shortcuts have nothing in MATH_HELP above to borrow a preview from, and their bare
   template is a poor advertisement for itself — "thin" renders as a space. */
const MATH_ABBREV_SAMPLE = {
  "thin \"$1\"": "5 thin \"m\"", "degree": "90 degree", "root(3, $1)": "root(3, x)",
};
const MATH_ABBREV_CAT = "Type it, then press Tab";

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
      const addCategory = (cat, entries) => {
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
          // The LaTeX form goes in the haystack too, whichever flavour is selected: someone who
          // already knows they want "\cdot" should still find it, and be shown that Typst
          // spells it "dot".
          cell.dataset.find =
            `${e.i} ${typstToLatex(e.i)} ${e.l || ""} ${e.s || ""} ${e.k || ""} ${cat} ${abbr || ""}`.toLowerCase();
          const prev = document.createElement("span");
          prev.className = "mhelp-prev";
          try { prev.innerHTML = katex.renderToString(typstToLatex(mathHelpSample(e)), { throwOnError: false, displayMode: false }); }
          catch (_) { prev.textContent = mathHelpSample(e); }
          const code = document.createElement("code");
          // Shows what clicking will actually insert, which depends on the flavour setting.
          code.textContent = mathSnippet(e).replace("$1", "");
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
      };
      /* The shortcuts get their own section, first, even though every one of them is already
         badged on its own symbol further down. A badge can only tell you about the shortcut for
         the symbol you happened to look up — it can't tell you the FEATURE exists, which is the
         thing actually forgotten ("there was a quick way to type this"). Generated from
         MATH_ABBREV in its own order, so it can never fall behind the list it documents, and
         each shortcut borrows the sheet's own entry where there is one, so clicking still
         inserts and searching still finds it by meaning. */
      const byTpl = new Map();
      for (const [, entries] of MATH_HELP) for (const e of entries) if (!byTpl.has(e.i)) byTpl.set(e.i, e);
      addCategory(MATH_ABBREV_CAT, [...new Set(Object.values(MATH_ABBREV))].map(tpl =>
        byTpl.get(tpl) || { i: tpl, s: MATH_ABBREV_SAMPLE[tpl] || tpl.replace("$1", "x") }));
      for (const [cat, entries] of MATH_HELP) addCategory(cat, entries);
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
    insertMathSnippet(mathSnippet(e));
    $("mathHelpDlg").close();
    return;
  }
  const cmd = mathSnippet(e).replace("$1", "");
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
