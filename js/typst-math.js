"use strict";
/* ============================================================================
   Typst-flavoured math source, translated to LaTeX for KaTeX to render.

   "$...$" spans are now read as Typst, not LaTeX. The motivation is purely typing
   ergonomics -- "1/2" and "sqrt(b^2-4a c)" are what you actually want to type at the
   front of a class, and "\frac{1}{2}" and "\sqrt{b^{2}-4ac}" are not. Nothing about
   the rendering pipeline changes: this hands KaTeX a LaTeX string exactly as before,
   so the canvas, the PDF export, the SVG export and the table renderer all keep
   working through the single seam in js/math-typeset.js.

   THE ONE COMPATIBILITY RULE: a span containing a backslash anywhere is passed
   through to KaTeX untouched, as LaTeX. Typst has no use for backslashes at all, so
   this costs nothing on the Typst side, and it means every note already written in
   this app -- plus the whole cheat sheet in js/math-help.js and every Tab
   abbreviation -- keeps rendering exactly as it always did. The flavour lives in the
   content, decided per span by what's in it, never in a setting: a stored preference
   that flips the meaning of "$1/2$" would silently change what old notes say, with
   no error anywhere to notice it by.

   What genuinely changed meaning: a span with NO backslash. "$1/2$" used to draw
   "1/2" and now draws a fraction. "$alpha$" used to draw five italic letters and now
   draws a Greek alpha. Both of those are what the person typing them meant.

   The precedence here isn't guessed -- it was checked against the real typst 0.14.2
   compiler, and matching it exactly is the point, since the whole value of the
   feature is that what you type here means what it means everywhere else Typst runs:
     a b/c      ->  a * (b/c)          "/" takes ONE factor on the left
     1/2 x      ->  (1/2) * x          and ONE on the right
     x^2/3      ->  (x^2)/3            attachments are part of the factor
     (a+b)/2    ->  the parens dissolve into the fraction
     a/b/c      ->  ((a/b)/c)          left-associative
     -b/2a      ->  -(b/2)*a           NOT -b/(2a), which surprises people
     f(x)       ->  f(x)               an unknown name before "(" is juxtaposition,
                                       so its brackets stay visible
   ========================================================================== */

/* Greek, symbols, and Typst's dotted variant names ("plus.minus", "lt.eq"). Not
   exhaustive -- Typst's symbol set runs to thousands of names -- but it covers what a
   secondary maths/physics classroom actually reaches for. Anything missing falls
   through to \mathrm{} and renders as upright letters, which is visibly wrong rather
   than silently wrong, and that's the right failure. */
const TYPST_SYMBOLS = {
  // Greek, lower case
  alpha: "\\alpha", beta: "\\beta", gamma: "\\gamma", delta: "\\delta",
  epsilon: "\\varepsilon", zeta: "\\zeta", eta: "\\eta", theta: "\\theta",
  iota: "\\iota", kappa: "\\kappa", lambda: "\\lambda", mu: "\\mu", nu: "\\nu",
  xi: "\\xi", omicron: "o", pi: "\\pi", rho: "\\rho", sigma: "\\sigma",
  tau: "\\tau", upsilon: "\\upsilon", phi: "\\phi", chi: "\\chi", psi: "\\psi",
  omega: "\\omega",
  "phi.alt": "\\varphi", "epsilon.alt": "\\epsilon", "theta.alt": "\\vartheta",
  "pi.alt": "\\varpi", "rho.alt": "\\varrho", "sigma.alt": "\\varsigma",
  // Greek, capitals
  Alpha: "A", Beta: "B", Gamma: "\\Gamma", Delta: "\\Delta", Epsilon: "E",
  Zeta: "Z", Eta: "H", Theta: "\\Theta", Iota: "I", Kappa: "K",
  Lambda: "\\Lambda", Mu: "M", Nu: "N", Xi: "\\Xi", Omicron: "O", Pi: "\\Pi",
  Rho: "P", Sigma: "\\Sigma", Tau: "T", Upsilon: "\\Upsilon", Phi: "\\Phi",
  Chi: "X", Psi: "\\Psi", Omega: "\\Omega",

  // Arithmetic and the dotted variant names
  "plus.minus": "\\pm", "minus.plus": "\\mp", times: "\\times", div: "\\div",
  dot: "\\cdot", "dot.op": "\\cdot", ast: "\\ast", star: "\\star",
  "times.circle": "\\otimes", "plus.circle": "\\oplus", "dot.circle": "\\odot",

  // Relations
  "eq.not": "\\neq", "lt.eq": "\\leq", "gt.eq": "\\geq", lt: "<", gt: ">",
  "lt.double": "\\ll", "gt.double": "\\gg", approx: "\\approx",
  "approx.eq": "\\approxeq", equiv: "\\equiv", prop: "\\propto",
  tilde: "\\sim", "tilde.eq": "\\cong", "tilde.equiv": "\\cong",
  "eq.def": "\\coloneqq", "col.eq": "\\coloneqq", "eq.dot": "\\doteq",

  // Sets -- chapter 9C's whole vocabulary
  in: "\\in", "in.not": "\\notin", "in.rev": "\\ni",
  subset: "\\subset", "subset.eq": "\\subseteq", "subset.not": "\\not\\subset",
  supset: "\\supset", "supset.eq": "\\supseteq",
  union: "\\cup", sect: "\\cap", "union.big": "\\bigcup", "sect.big": "\\bigcap",
  emptyset: "\\emptyset", nothing: "\\emptyset", complement: "\\complement",
  without: "\\setminus", "minus.set": "\\setminus",

  // Logic
  and: "\\land", or: "\\lor", not: "\\lnot", forall: "\\forall",
  exists: "\\exists", "exists.not": "\\nexists", therefore: "\\therefore",
  because: "\\because", "arrow.r.double": "\\Rightarrow",
  "arrow.l.double": "\\Leftarrow", "arrow.l.r.double": "\\Leftrightarrow",

  // Arrows
  "arrow.r": "\\rightarrow", "arrow.l": "\\leftarrow", "arrow.t": "\\uparrow",
  "arrow.b": "\\downarrow", "arrow.l.r": "\\leftrightarrow",
  "arrow.r.bar": "\\mapsto", "arrow.r.long": "\\longrightarrow",

  // Geometry and the rest of the physics furniture
  // Typst's "angle.right" is a right angle BRACKET, not a measured angle -- the measured one is
  // "angle.arc". Getting this wrong would have put the wrong glyph on a geometry slide.
  angle: "\\angle", "angle.arc": "\\measuredangle", perp: "\\perp",
  parallel: "\\parallel", "parallel.not": "\\nparallel",
  degree: "^{\\circ}", percent: "\\%", infinity: "\\infty", oo: "\\infty",
  diff: "\\partial", partial: "\\partial", nabla: "\\nabla",
  planck: "\\hbar", "planck.reduce": "\\hbar", ell: "\\ell",
  "dots.h": "\\dots", "dots.v": "\\vdots", "dots.down": "\\ddots",
  "dots.c": "\\cdots", dots: "\\dots",
  square: "\\square", triangle: "\\triangle", circle: "\\circ",
  checkmark: "\\checkmark", "convolve": "\\ast",

  // Explicit spacing
  thin: "\\,", med: "\\:", thick: "\\;", quad: "\\quad", wide: "\\qquad",
  space: "\\ ", "space.quad": "\\quad", "space.thin": "\\,",
};

/* Names that render upright as operators, exactly as in LaTeX. Written out rather
   than derived so an unknown multi-letter name can still be told apart from these. */
const TYPST_OPERATORS = new Set([
  "sin", "cos", "tan", "sec", "csc", "cot", "sinh", "cosh", "tanh",
  "arcsin", "arccos", "arctan", "ln", "log", "lg", "exp", "lim", "limsup",
  "liminf", "max", "min", "sup", "inf", "det", "dim", "ker", "deg", "gcd",
  "hom", "arg", "mod", "Pr",
]);

/* Big operators. KaTeX defaults to inline style, which parks the bounds beside the
   sign; Typst stacks them above and below even inline, so \limits is added to match.
   \int is deliberately absent -- Typst leaves an integral's bounds beside it too. */
const TYPST_BIG_OPS = {
  sum: "\\sum", product: "\\prod", integral: "\\int", "integral.double": "\\iint",
  "integral.cont": "\\oint",
};
const TYPST_STACKS_LIMITS = new Set(["sum", "product", "lim", "max", "min", "sup", "inf",
  "union.big", "sect.big", "limsup", "liminf"]);

/* Accents: Typst spells them as function calls, e.g. arrow(v) for a vector. */
const TYPST_ACCENTS = {
  hat: "\\hat", tilde: "\\tilde", bar: "\\bar", macron: "\\bar", dot: "\\dot",
  "dot.double": "\\ddot", breve: "\\breve", acute: "\\acute", grave: "\\grave",
  check: "\\check", arrow: "\\vec", overline: "\\overline", underline: "\\underline",
  overbrace: "\\overbrace", underbrace: "\\underbrace",
  "arrow.l": "\\overleftarrow", "arrow.l.r": "\\overleftrightarrow",
};

/* Font/style wrappers, also spelled as calls. */
const TYPST_STYLES = {
  upright: "\\mathrm", bold: "\\mathbf", italic: "\\mathit", cal: "\\mathcal",
  bb: "\\mathbb", frak: "\\mathfrak", sans: "\\mathsf", mono: "\\mathtt",
  text: "\\text",
};

/* Two-character operators, longest first so "<=" never tokenizes as "<" then "=". */
const TYPST_OP_TEXT = {
  "<->": "\\leftrightarrow", "|->": "\\mapsto", "=>": "\\Rightarrow",
  "<=": "\\leq", ">=": "\\geq", "!=": "\\neq", "->": "\\rightarrow",
  "==": "\\equiv", "~": "\\sim", "+": "+", "-": "-", "=": "=", "<": "<", ">": ">",
  "*": "\\ast", "!": "!", "|": "\\mid", ":": ":", ".": ".", "'": "'",
  // "%" and "#" are live syntax to the layer below -- a bare "%" opens a comment in KaTeX and
  // eats the rest of the formula, so "$50%$" would have drawn as "50". Escaped at the border.
  "%": "\\%", "#": "\\#", "&": "\\&",
};
const TYPST_OP_ORDER = ["<->", "|->", "=>", "<=", ">=", "!=", "->", "=="];

/* ---------------- tokenizer ---------------- */
// Identifiers carry their dots ("plus.minus"), because that IS the name in Typst --
// splitting on "." would turn one symbol into three tokens and lose it.
function tokenizeTypst(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9]/.test(src[j])) j++;
      // Absorb ".word" runs, but only when a letter follows -- "f(x). " at the end of a
      // sentence, or "0.5", must not be swallowed into a name.
      while (src[j] === "." && /[A-Za-z]/.test(src[j + 1] || "")) {
        j++;
        while (j < src.length && /[A-Za-z0-9]/.test(src[j])) j++;
      }
      out.push({ t: "ident", v: src.slice(i, j) });
      i = j; continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      if (src[j] === "." && /[0-9]/.test(src[j + 1] || "")) {
        j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      out.push({ t: "num", v: src.slice(i, j) });
      i = j; continue;
    }
    // "$1" is the cheat sheet's cursor-lands-here marker (see MATH_HELP in js/math-help.js),
    // not maths. It has to survive translation intact so a snippet authored once in Typst can
    // be handed to a LaTeX-flavoured insert with the marker still in place.
    if (ch === "$" && src[i + 1] === "1") { out.push({ t: "marker", v: "$1" }); i += 2; continue; }
    if (ch === '"') {
      let j = i + 1, buf = "";
      while (j < src.length && src[j] !== '"') { buf += src[j]; j++; }
      out.push({ t: "str", v: buf });
      i = Math.min(j + 1, src.length); continue;
    }
    if ("()[]{}".includes(ch)) { out.push({ t: ch, v: ch }); i++; continue; }
    if (ch === ",") { out.push({ t: ",", v: "," }); i++; continue; }
    if (ch === ";") { out.push({ t: ";", v: ";" }); i++; continue; }
    if (ch === "/") { out.push({ t: "/", v: "/" }); i++; continue; }
    if (ch === "^") { out.push({ t: "^", v: "^" }); i++; continue; }
    if (ch === "_") { out.push({ t: "_", v: "_" }); i++; continue; }
    if (ch === "&") { i++; continue; } // alignment point: meaningless in one inline span
    const two = TYPST_OP_ORDER.find(o => src.startsWith(o, i));
    if (two) { out.push({ t: "op", v: two }); i += two.length; continue; }
    out.push({ t: "op", v: ch });
    i++;
  }
  out.push({ t: "end", v: "" });
  return out;
}

/* ---------------- parser ----------------
   Every parse function returns {tex, bare}: `tex` is what to draw where it stands,
   `bare` is the same thing with any wrapping brackets removed. A fraction and a
   sub/superscript both want `bare`, which is what makes "(a+b)/2" put a+b over 2
   instead of putting (a+b) over 2 with the brackets still showing. */
function TypstParser(tokens) {
  let p = 0;
  const peek = () => tokens[p];
  const next = () => tokens[p++];

  function parseSeq(stops) {
    const parts = [];
    while (peek().t !== "end" && !stops.includes(peek().t)) {
      const before = p;
      parts.push(parseFrac().tex);
      if (p === before) next(); // belt and braces: never spin on a token nothing consumed
    }
    return parts.join(" ");
  }

  function parseFrac() {
    let left = parseFactor();
    while (peek().t === "/") {
      next();
      const right = parseFactor();
      left = { tex: `\\frac{${left.bare}}{${right.bare}}`, bare: `\\frac{${left.bare}}{${right.bare}}` };
    }
    return left;
  }

  function parseFactor() {
    let a = parseAtom();
    // Bounds have to be gathered before \limits is emitted, since \limits must sit
    // directly after the operator it applies to and before either script.
    let sub = null, sup = null;
    while (peek().t === "_" || peek().t === "^") {
      const which = next().t;
      const arg = parseAtom();
      if (which === "_") sub = arg.bare; else sup = arg.bare;
    }
    if (sub === null && sup === null) return a;
    let tex = a.tex + (a.stacks ? "\\limits" : "");
    if (sub !== null) tex += `_{${sub}}`;
    if (sup !== null) tex += `^{${sup}}`;
    return { tex, bare: tex };
  }

  // Collects call arguments, remembering where the ";" row breaks fell so mat() and
  // cases() can use the same routine as everything else.
  function parseArgs() {
    next(); // "("
    const rows = [[]];
    rows.named = {};
    if (peek().t === ")") { next(); return rows; }
    for (;;) {
      // A named argument -- mat(1, 2; 3, 4, delim: "["). Recognised before the argument is
      // parsed, because afterwards "delim" and its value are just two more atoms in a row and
      // there's no telling them apart from a matrix entry that happens to contain a colon.
      if (peek().t === "ident" && tokens[p + 1] && tokens[p + 1].t === "op" && tokens[p + 1].v === ":") {
        const key = next().v;
        next(); // ":"
        rows.named[key] = peek().t === "str" ? next().v : parseSeq([",", ";", ")"]);
        if (peek().t === "," || peek().t === ";") next();
        if (peek().t === ")") { next(); break; }
        continue;
      }
      rows[rows.length - 1].push(parseSeq([",", ";", ")"]));
      const sep = peek().t;
      if (sep === ",") { next(); continue; }
      if (sep === ";") { next(); rows.push([]); continue; }
      if (sep === ")") next();
      break;
    }
    return rows;
  }
  const flatArgs = rows => rows.reduce((acc, r) => acc.concat(r), []);

  function parseCall(name) {
    const rows = parseArgs();
    const args = flatArgs(rows);
    const a0 = args[0] || "", a1 = args[1] || "";
    if (name === "sqrt") return { tex: `\\sqrt{${a0}}`, bare: `\\sqrt{${a0}}` };
    if (name === "root") return { tex: `\\sqrt[${a0}]{${a1}}`, bare: `\\sqrt[${a0}]{${a1}}` };
    if (name === "frac") return { tex: `\\frac{${a0}}{${a1}}`, bare: `\\frac{${a0}}{${a1}}` };
    if (name === "binom") return { tex: `\\binom{${a0}}{${a1}}`, bare: `\\binom{${a0}}{${a1}}` };
    if (name === "abs") return wrapped("\\lvert", a0, "\\rvert");
    if (name === "norm") return wrapped("\\lVert", a0, "\\rVert");
    if (name === "floor") return wrapped("\\lfloor", a0, "\\rfloor");
    if (name === "ceil") return wrapped("\\lceil", a0, "\\rceil");
    if (name === "vec" || name === "mat") {
      // Typst picks the surrounding brackets with a delim: argument; LaTeX picks them by using
      // a different environment name. Same idea, spelled differently.
      const env = { "[": "bmatrix", "|": "vmatrix", "{": "Bmatrix", "(": "pmatrix", "": "matrix" };
      const kind = env[rows.named.delim] || "pmatrix";
      const body = name === "vec" ? args.join(" \\\\ ") : rows.map(r => r.join(" & ")).join(" \\\\ ");
      const t = `\\begin{${kind}}${body}\\end{${kind}}`;
      return { tex: t, bare: t };
    }
    if (name === "cases") {
      const body = args.join(" \\\\ ");
      return { tex: `\\begin{cases}${body}\\end{cases}`, bare: `\\begin{cases}${body}\\end{cases}` };
    }
    if (TYPST_ACCENTS[name]) {
      // Typst draws one arrow accent that stretches to fit what's under it; LaTeX makes you
      // pick between a short \vec and a stretchy \overrightarrow up front. A space in the body
      // means more than one thing is under the arrow -- "arrow(A B)" -- which is the case that
      // needs the stretchy one. "arrow(v)" and "arrow(alpha)" both stay short, correctly.
      const accent = (name === "arrow" && /\s/.test(a0)) ? "\\overrightarrow" : TYPST_ACCENTS[name];
      const t = `${accent}{${a0}}`;
      return { tex: t, bare: t };
    }
    if (TYPST_STYLES[name]) {
      const t = `${TYPST_STYLES[name]}{${a0}}`;
      return { tex: t, bare: t };
    }
    // Not a function this knows: it was juxtaposition all along, e.g. "f(x)" or
    // "P(A union B)". Put the brackets back and render the arguments as written.
    const inner = rows.map(r => r.join(", ")).join("; ");
    // \operatorname adds a thin space after itself, which is right for "lim x" and wrong for
    // "Pr(A)" -- it drew as "Pr (A)". A name that has brackets right after it is being applied
    // to them, so it just wants to be upright, not spaced as a standalone operator.
    const head = TYPST_OPERATORS.has(name) ? `\\mathrm{${name}}` : identTex(name);
    const t = `${head}\\left(${inner}\\right)`;
    return { tex: t, bare: t };
  }
  const wrapped = (open, body, close) =>
    ({ tex: `\\left${open} ${body} \\right${close}`, bare: `\\left${open} ${body} \\right${close}` });

  // A bare name, with no call brackets after it.
  function identTex(name) {
    if (TYPST_SYMBOLS[name]) return TYPST_SYMBOLS[name];
    if (TYPST_BIG_OPS[name]) return TYPST_BIG_OPS[name];
    if (TYPST_OPERATORS.has(name)) return `\\operatorname{${name}}`;
    if (name.length === 1) return name;
    return `\\mathrm{${name}}`;
  }

  function parseAtom() {
    const tok = next();
    switch (tok.t) {
      case "(": {
        const inner = parseSeq([")"]);
        if (peek().t === ")") next();
        // `bare` drops the brackets, `tex` keeps them -- see the note on the return shape.
        return { tex: `\\left(${inner}\\right)`, bare: inner };
      }
      case "[": {
        const inner = parseSeq(["]"]);
        if (peek().t === "]") next();
        return { tex: `\\left[${inner}\\right]`, bare: inner };
      }
      case "{": {
        // Set braces, which Typst draws and LaTeX-by-habit does not. Kept visible on
        // purpose: this app is used to teach set notation, so "{1, 2, 3}" quietly
        // losing its braces would be a silent wrong answer on a projector.
        const inner = parseSeq(["}"]);
        if (peek().t === "}") next();
        return { tex: `\\left\\{${inner}\\right\\}`, bare: `\\left\\{${inner}\\right\\}` };
      }
      case "marker":
        return { tex: "$1", bare: "$1" };
      case "str":
        return { tex: `\\text{${tok.v}}`, bare: `\\text{${tok.v}}` };
      case "num":
        return { tex: tok.v, bare: tok.v };
      case "ident": {
        if (peek().t === "(") return parseCall(tok.v);
        const tex = identTex(tok.v);
        return { tex, bare: tex, stacks: TYPST_STACKS_LIMITS.has(tok.v) };
      }
      // Separators inside a bracket group that is NOT a call -- "{1, 2, 3}", "(a, b)" -- still
      // have to reach the page; without this they get consumed here and silently vanish.
      case ",": return { tex: ",", bare: "," };
      case ";": return { tex: ";", bare: ";" };
      case "op": {
        const tex = TYPST_OP_TEXT[tok.v] !== undefined ? TYPST_OP_TEXT[tok.v] : tok.v;
        return { tex, bare: tex };
      }
      default:
        return { tex: "", bare: "" };
    }
  }

  return { run: () => parseSeq([]) };
}

/* The one entry point. Never throws and never returns nothing: if anything at all
   goes wrong the original source is handed to KaTeX unchanged, which at worst shows
   its own error in red -- exactly what happened before this file existed. */
function typstToLatex(src) {
  if (typeof src !== "string" || !src) return src;
  if (src.includes("\\")) return src; // LaTeX, by the compatibility rule above
  try {
    const out = TypstParser(tokenizeTypst(src)).run();
    return out.trim() ? out : src;
  } catch (_) {
    return src;
  }
}

/* ---------------- which flavour gets TYPED ----------------
   A deliberately narrow setting. It decides what the cheat sheet, the quick math panel and the
   Tab abbreviations INSERT -- and nothing else. It has no say in how an existing "$...$" span is
   READ, which is settled per span by the backslash rule above, from the content itself.

   That split is the whole point. A preference that decided how spans are read would silently
   change what old notes mean the moment it was flipped -- "$1/2$" is valid in both flavours and
   means different things in each, so there'd be no error anywhere to notice it by, just a page
   that quietly says something else. A preference that only decides what gets typed next can't
   reach backwards into anything already written.

   Device-level like the keymap and pencil-only, not per notebook: it's a fact about how the
   person at the keyboard types, not about the document. */
let mathFlavour = "typst";
function loadMathFlavourPref() {
  try { mathFlavour = localStorage.getItem("inkpad.mathFlavour") === "latex" ? "latex" : "typst"; }
  catch (_) { mathFlavour = "typst"; }
}
function saveMathFlavourPref() {
  try { localStorage.setItem("inkpad.mathFlavour", mathFlavour); } catch (_) {}
}

/* Every snippet in the app is authored ONCE, in Typst. The LaTeX form is derived by running it
   back through the translator, so the two can never drift apart the way two hand-kept tables
   would. `l` is an explicit override for the handful of entries the translator can't derive --
   fragments like "^($1)" that aren't valid maths standing on their own. */
function mathSnippet(entry) {
  const e = typeof entry === "string" ? { i: entry } : entry;
  if (mathFlavour !== "latex") return e.i;
  return e.l !== undefined ? e.l : typstToLatex(e.i);
}
