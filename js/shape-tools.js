"use strict";
const QUAD_TYPES = ["square", "rectangle", "parallelogram"];
function toggleShapeFormFields() {
  const type = $("shapeTypeSelect").value;
  $("planeFields").style.display = type === "plane" ? "block" : "none";
  $("planeMathFields").style.display = type === "planeMath" ? "block" : "none";
  $("planeQ1Fields").style.display = type === "planeQ1" ? "block" : "none";
  $("triangleFields").style.display = type === "triangle" ? "block" : "none";
  $("circleFields").style.display = type === "circle" ? "block" : "none";
  $("quadFields").style.display = QUAD_TYPES.includes(type) ? "block" : "none";
  $("quadSquareFields").style.display = type === "square" ? "block" : "none";
  $("quadRectFields").style.display = type === "rectangle" ? "block" : "none";
  $("quadParaFields").style.display = type === "parallelogram" ? "block" : "none";
  $("polygonFields").style.display = type === "polygon" ? "block" : "none";
  const SOLID3D_TYPES = ["cube", "prism", "cylinder", "cone", "pyramid"];
  $("solid3dFields").style.display = SOLID3D_TYPES.includes(type) ? "block" : "none";
  $("cubeFields").style.display = type === "cube" ? "block" : "none";
  $("prismFields").style.display = type === "prism" ? "block" : "none";
  $("cylinderFields").style.display = type === "cylinder" ? "block" : "none";
  $("coneFields").style.display = type === "cone" ? "block" : "none";
  $("pyramidFields").style.display = type === "pyramid" ? "block" : "none";
  $("solid3dDepthAngleField").style.display = ["cube", "prism", "pyramid"].includes(type) ? "block" : "none";
  $("solid3dPerspectiveField").style.display = ["cylinder", "cone"].includes(type) ? "block" : "none";
  $("numberlineFields").style.display = type === "numberline" ? "block" : "none";
  $("fractionFields").style.display = type === "fraction" ? "block" : "none";
}

const SHAPE_CATEGORY = {
  triangle: "2d", circle: "2d", square: "2d", rectangle: "2d", parallelogram: "2d",
  polygon: "2d", fraction: "2d",
  cube: "3d", prism: "3d", cylinder: "3d", cone: "3d", pyramid: "3d",
  plane: "tools", planeMath: "tools", planeQ1: "tools", numberline: "tools",
};
function selectShapeCategory(category) {
  document.querySelectorAll(".shape-cat-tab").forEach(t => t.classList.toggle("active", t.dataset.category === category));
  document.querySelectorAll("#shapeTypeTiles .shape-tile").forEach(t => {
    t.style.display = t.dataset.category === category ? "" : "none";
  });
  localStorage.setItem("inkpad.shapeCategory", category);
  scheduleSettingsSave();
}
function selectShapeType(type) {
  $("shapeTypeSelect").value = type;
  document.querySelectorAll("#shapeTypeTiles .shape-tile").forEach(t => t.classList.toggle("active", t.dataset.type === type));
  selectShapeCategory(SHAPE_CATEGORY[type] || "2d");
  toggleShapeFormFields();
  renderShapePreview();
}

// Per-notebook shape-dialog checkbox prefs (e.g. "show side labels") — saved in
// S.shapePrefs, which rides along with everything else serialized per notebook.
// A checkbox's own HTML "checked" attribute (.defaultChecked) is the fallback
// for a notebook that's never touched this particular checkbox before.
function applyShapePrefsToDialog() {
  document.querySelectorAll('#shapeImporterDlg input[type="checkbox"]').forEach(cb => {
    cb.checked = S.shapePrefs && Object.prototype.hasOwnProperty.call(S.shapePrefs, cb.id) ? S.shapePrefs[cb.id] : cb.defaultChecked;
  });
}
function captureShapePrefsFromDialog() {
  document.querySelectorAll('#shapeImporterDlg input[type="checkbox"]').forEach(cb => { S.shapePrefs[cb.id] = cb.checked; });
  markDirty();
}

function handleDlgRightAngleToggle() {
  const isRight = $("triRightAngle").checked;
  $("triAngleA").disabled = isRight;
  if (isRight) $("triAngleA").value = "";
  renderShapePreview();
}

function setTriRotationPreset(val) {
  $("triRotation").value = val;
  $("triRotVal").textContent = val;
  renderShapePreview();
}

function randomiseTriangleFields() {
  const isRight = $("triRightAngle").checked;
  const targetSide = $("triGenTarget").value === "side";
  
  $("triTickBottom").checked = false;
  $("triTickLeft").checked = false;
  $("triTickRight").checked = false;
  $("triRotation").value = Math.floor(Math.random() * 361);
  $("triRotVal").textContent = $("triRotation").value;

  if (isRight) {
    const angle = Math.floor(Math.random() * 35) + 25;
    $("triAngleA").value = "";
    
    if (targetSide) {
      const angleChoice = Math.random() > 0.5;
      $("triAngleB").value = angleChoice ? (90 - angle) + "°" : "";
      $("triAngleC").value = angleChoice ? "" : angle + "°";
      
      const sideCombo = Math.floor(Math.random() * 4);
      const hyp = Math.floor(Math.random() * 10) + 10;
      if (sideCombo === 0) {
        // leg (left) unknown, hypotenuse given -> sin/cos
        $("triBottom").value = "";
        $("triLeft").value = "x";
        $("triRight").value = hyp;
      } else if (sideCombo === 1) {
        // leg (bottom) unknown, hypotenuse given -> sin/cos
        $("triBottom").value = "x";
        $("triLeft").value = "";
        $("triRight").value = hyp;
      } else if (sideCombo === 2) {
        // hypotenuse unknown, one leg given -> sin/cos
        $("triBottom").value = Math.floor(Math.random() * 6) + 5;
        $("triLeft").value = "";
        $("triRight").value = "x";
      } else {
        // both legs involved, hypotenuse hidden entirely -> tan
        const knownLeft = Math.random() > 0.5;
        const legVal = Math.floor(Math.random() * 10) + 5;
        $("triRight").value = "";
        $("triLeft").value = knownLeft ? legVal : "x";
        $("triBottom").value = knownLeft ? "x" : legVal;
      }
    } else {
      const angleChoice = Math.random() > 0.5;
      $("triAngleB").value = angleChoice ? "θ" : "";
      $("triAngleC").value = angleChoice ? "" : "θ";
      $("triBottom").value = Math.floor(Math.random() * 5) + 3;
      $("triLeft").value = Math.floor(Math.random() * 5) + 4;
      $("triRight").value = "";
    }
  } else {
    const tX = Math.floor(Math.random() * 140) + 180;
    const tY = Math.floor(Math.random() * 80) + 80;
    $("triVertexBX").value = tX;
    $("triVertexBY").value = tY;
    
    const degA = Math.floor(Math.random() * 30) + 40;
    const degC = Math.floor(Math.random() * 30) + 40;
    
    if (targetSide) {
      $("triAngleA").value = degA + "°";
      $("triAngleB").value = "";
      $("triAngleC").value = degC + "°";
      
      const sideCombo = Math.floor(Math.random() * 3);
      if (sideCombo === 0) {
        $("triBottom").value = Math.floor(Math.random() * 10) + 10;
        $("triLeft").value = "x";
        $("triRight").value = "";
      } else if (sideCombo === 1) {
        $("triBottom").value = "x";
        $("triLeft").value = Math.floor(Math.random() * 10) + 10;
        $("triRight").value = "";
      } else {
        $("triBottom").value = "";
        $("triLeft").value = Math.floor(Math.random() * 10) + 10;
        $("triRight").value = "x";
      }
    } else {
      $("triAngleA").value = "θ";
      $("triAngleB").value = "";
      $("triAngleC").value = degC + "°";
      $("triBottom").value = Math.floor(Math.random() * 8) + 8;
      $("triLeft").value = "";
      $("triRight").value = Math.floor(Math.random() * 8) + 7;
    }
  }
  renderShapePreview();
}

function randomiseCircleFields() {
  const r = Math.floor(Math.random() * 8) + 3;
  $("circRadius").value = r;
  $("circShowDiameter").checked = Math.random() > 0.5;
  $("circDiameter").value = r * 2;
  const hasSector = Math.random() > 0.4;
  $("circSectorAngle").value = hasSector ? Math.floor(Math.random() * 120) + 30 : 0;
  $("circSectorLabel").value = hasSector ? (Math.random() > 0.5 ? "θ" : (Math.floor(Math.random() * 90) + 20) + "°") : "";
  renderShapePreview();
}

function randomiseSquareFields() {
  $("quadSquareSide").value = Math.floor(Math.random() * 9) + 3;
  $("quadSquareTicks").checked = Math.random() > 0.3;
  $("quadSquareRight").checked = Math.random() > 0.2;
  $("quadRotation").value = Math.floor(Math.random() * 4) * 90;
  $("quadRotVal").textContent = $("quadRotation").value;
  renderShapePreview();
}

function randomiseRectangleFields() {
  const w = Math.floor(Math.random() * 8) + 6;
  let h = Math.floor(Math.random() * 6) + 3;
  if (h === w) h += 2;
  $("quadRectWidth").value = w;
  $("quadRectHeight").value = h;
  $("quadRectRight").checked = Math.random() > 0.2;
  $("quadRotation").value = Math.floor(Math.random() * 4) * 90;
  $("quadRotVal").textContent = $("quadRotation").value;
  renderShapePreview();
}

function randomiseParallelogramFields() {
  $("quadParaBase").value = Math.floor(Math.random() * 8) + 6;
  $("quadParaSide").value = Math.floor(Math.random() * 6) + 4;
  $("quadParaAngle").value = Math.floor(Math.random() * 60) + 50;
  $("quadRotation").value = Math.floor(Math.random() * 4) * 90;
  $("quadRotVal").textContent = $("quadRotation").value;
  renderShapePreview();
}

function randomisePolygonFields() {
  $("polygonSides").value = Math.floor(Math.random() * 6) + 5;
  $("polygonSide").value = Math.floor(Math.random() * 8) + 3;
  $("polygonShowAngle").checked = Math.random() > 0.25;
  $("polygonRotation").value = Math.floor(Math.random() * 360);
  $("polygonRotVal").textContent = $("polygonRotation").value;
  renderShapePreview();
}

function randomiseCubeFields() {
  $("cubeSide").value = Math.floor(Math.random() * 8) + 3;
  renderShapePreview();
}

function randomisePrismFields() {
  $("prismWidth").value = Math.floor(Math.random() * 8) + 5;
  $("prismHeight").value = Math.floor(Math.random() * 6) + 3;
  $("prismDepth").value = Math.floor(Math.random() * 6) + 3;
  renderShapePreview();
}

function randomiseCylinderFields() {
  const r = Math.floor(Math.random() * 5) + 2;
  $("cylRadius").value = r;
  $("cylHeight").value = Math.floor(Math.random() * 8) + 5;
  const showD = Math.random() > 0.5;
  $("cylShowDiameter").checked = showD;
  $("cylDiameter").value = r * 2;
  renderShapePreview();
}

function randomiseConeFields() {
  $("coneRadius").value = Math.floor(Math.random() * 5) + 2;
  $("coneHeight").value = Math.floor(Math.random() * 8) + 5;
  const showSlant = Math.random() > 0.4;
  $("coneShowSlant").checked = showSlant;
  if (showSlant) {
    const r = +$("coneRadius").value, h = +$("coneHeight").value;
    $("coneSlant").value = Math.round(Math.sqrt(r * r + h * h) * 10) / 10;
  }
  renderShapePreview();
}

function randomisePyramidFields() {
  const sameBase = Math.random() > 0.5;
  const w = Math.floor(Math.random() * 6) + 4;
  $("pyramidWidth").value = w;
  $("pyramidDepth").value = sameBase ? w : Math.floor(Math.random() * 6) + 4;
  $("pyramidHeight").value = Math.floor(Math.random() * 8) + 4;
  renderShapePreview();
}

function randomiseNumberlineFields() {
  const min = -(Math.floor(Math.random() * 8) + 2);
  const max = Math.floor(Math.random() * 8) + 2;
  $("nlMin").value = min; $("nlMax").value = max;
  $("nlStep").value = 1;
  const hasHl = Math.random() > 0.35;
  if (hasHl) {
    const a = Math.floor(Math.random() * (max - min - 1)) + min + 1;
    const openEnded = Math.random() > 0.5;
    if (openEnded) {
      // Showcase the "extend to arrow" mode, e.g. x > a or x < a.
      const dir = Math.random() > 0.5;
      $("nlHlFrom").value = dir ? a : "";
      $("nlHlTo").value = dir ? "" : a;
      $("nlFromCircle").value = dir ? (Math.random() > 0.5 ? "open" : "closed") : "end";
      $("nlToCircle").value = dir ? "end" : (Math.random() > 0.5 ? "open" : "closed");
    } else {
      const dir = Math.random() > 0.5;
      $("nlHlFrom").value = dir ? a : min;
      $("nlHlTo").value = dir ? max : a;
      $("nlFromCircle").value = Math.random() > 0.5 ? "open" : "closed";
      $("nlToCircle").value = Math.random() > 0.5 ? "open" : "closed";
    }
  } else {
    $("nlHlFrom").value = ""; $("nlHlTo").value = "";
    $("nlFromCircle").value = "closed"; $("nlToCircle").value = "closed";
  }
  renderShapePreview();
}

function randomiseFractionFields() {
  $("fracStyle").value = Math.random() > 0.5 ? "bar" : "circle";
  const den = Math.floor(Math.random() * 6) + 3;
  const num = Math.floor(Math.random() * den);
  $("fracDenominator").value = den;
  $("fracNumerator").value = num;
  renderShapePreview();
}

function rotatePoint(pt, center, deg) {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return {
    x: cos * (pt.x - center.x) - sin * (pt.y - center.y) + center.x,
    y: sin * (pt.x - center.x) + cos * (pt.y - center.y) + center.y
  };
}

function getBisectorVector(pAnchor, p1, p2, offsetDist, centerPoint) {
  let d1 = { x: p1.x - pAnchor.x, y: p1.y - pAnchor.y };
  let d2 = { x: p2.x - pAnchor.x, y: p2.y - pAnchor.y };
  let len1 = Math.sqrt(d1.x*d1.x + d1.y*d1.y) || 1;
  let len2 = Math.sqrt(d2.x*d2.x + d2.y*d2.y) || 1;
  let u1 = { x: d1.x / len1, y: d1.y / len1 };
  let u2 = { x: d2.x / len2, y: d2.y / len2 };
  let bi = { x: u1.x + u2.x, y: u1.y + u2.y };
  let lenBi = Math.sqrt(bi.x*bi.x + bi.y*bi.y);
  if (lenBi === 0) return { x: pAnchor.x, y: pAnchor.y };
  let bx = bi.x / lenBi, by = bi.y / lenBi;
  let targetVectorX = centerPoint.x - pAnchor.x;
  let targetVectorY = centerPoint.y - pAnchor.y;
  if (bx * targetVectorX + by * targetVectorY < 0) { bx = -bx; by = -by; }
  let dotProd = u1.x * u2.x + u1.y * u2.y;
  let angleRad = Math.acos(Math.max(-1, Math.min(1, dotProd)));
  let extraPush = angleRad < 0.8 ? (0.8 - angleRad) * 26 : 0;
  return {
    x: pAnchor.x + bx * (offsetDist + extraPush + 6),
    y: pAnchor.y + by * (offsetDist + extraPush + 6) + 4
  };
}

function drawAngleArc(pAnchor, p1, p2, radius, centerPoint) {
  let d1 = { x: p1.x - pAnchor.x, y: p1.y - pAnchor.y };
  let d2 = { x: p2.x - pAnchor.x, y: p2.y - pAnchor.y };
  let len1 = Math.sqrt(d1.x*d1.x + d1.y*d1.y) || 1;
  let len2 = Math.sqrt(d2.x*d2.x + d2.y*d2.y) || 1;
  let u1 = { x: d1.x / len1, y: d1.y / len1 };
  let u2 = { x: d2.x / len2, y: d2.y / len2 };
  let arcStart = { x: pAnchor.x + u1.x * radius, y: pAnchor.y + u1.y * radius };
  let arcEnd = { x: pAnchor.x + u2.x * radius, y: pAnchor.y + u2.y * radius };
  let cross = u1.x * u2.y - u1.y * u2.x;
  let midArc = { x: (arcStart.x + arcEnd.x)/2, y: (arcStart.y + arcEnd.y)/2 };
  let dotCheck = (midArc.x - pAnchor.x) * (centerPoint.x - pAnchor.x) + (midArc.y - pAnchor.y) * (centerPoint.y - pAnchor.y);
  let sweepFlag = cross > 0 ? 1 : 0;
  if (dotCheck < 0) sweepFlag = sweepFlag === 1 ? 0 : 1;
  return `  <path d="M ${arcStart.x} ${arcStart.y} A ${radius} ${radius} 0 0 ${sweepFlag} ${arcEnd.x} ${arcEnd.y}" fill="none" stroke="black" stroke-width="1.5"/>\n`;
}

function escapeXml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Compiles a Typst-style math expression of `x` (e.g. "sin(x)", "x^2 - 3", "2cos(x)+1")
// into a JS function (x) => number. Throws with a descriptive message on invalid syntax.
function compileExpr(src) {
  const s = src.trim();
  if (!s) throw new Error("empty expression");
  let i = 0;
  const peek = () => s[i];
  const isDigit = c => c >= "0" && c <= "9";
  const isAlpha = c => !!c && /[a-zA-Z_]/.test(c);
  const skipWs = () => { while (s[i] === " " || s[i] === "\t") i++; };

  const FUNCS = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: Math.asin, acos: Math.acos, atan: Math.atan,
    sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp,
    ln: Math.log, log: Math.log10, floor: Math.floor,
    ceil: Math.ceil, round: Math.round,
  };

  function canStartPrimary() {
    skipWs();
    const c = peek();
    return c === "(" || isDigit(c) || c === "." || isAlpha(c);
  }
  function parseExpr() { return parseAddSub(); }
  function parseAddSub() {
    let node = parseMulDiv();
    for (;;) {
      skipWs();
      const c = peek();
      if (c === "+" || c === "-") {
        i++;
        const rhs = parseMulDiv(), left = node;
        node = x => c === "+" ? left(x) + rhs(x) : left(x) - rhs(x);
      } else break;
    }
    return node;
  }
  function parseMulDiv() {
    let node = parseUnary();
    for (;;) {
      skipWs();
      const c = peek();
      if (c === "*" || c === "/") {
        i++;
        const rhs = parseUnary(), left = node;
        node = x => c === "*" ? left(x) * rhs(x) : left(x) / rhs(x);
      } else if (canStartPrimary()) {
        const rhs = parseUnary(), left = node; // implicit multiplication: "2x", "3(x+1)"
        node = x => left(x) * rhs(x);
      } else break;
    }
    return node;
  }
  function parseUnary() {
    skipWs();
    const c = peek();
    if (c === "-") { i++; const node = parseUnary(); return x => -node(x); }
    if (c === "+") { i++; return parseUnary(); }
    return parsePow();
  }
  function parsePow() {
    const node = parsePrimary();
    skipWs();
    if (peek() === "^") {
      i++;
      const rhs = parseUnary();
      return x => Math.pow(node(x), rhs(x));
    }
    return node;
  }
  function parsePrimary() {
    skipWs();
    const c = peek();
    if (c === "(") {
      i++;
      const node = parseExpr();
      skipWs();
      if (peek() !== ")") throw new Error("expected ')'");
      i++;
      return node;
    }
    if (isDigit(c) || c === ".") {
      const start = i;
      while (isDigit(peek())) i++;
      if (peek() === ".") { i++; while (isDigit(peek())) i++; }
      const val = parseFloat(s.slice(start, i));
      return () => val;
    }
    if (isAlpha(c)) {
      const start = i;
      while (isAlpha(peek()) || isDigit(peek())) i++;
      const name = s.slice(start, i);
      skipWs();
      if (peek() === "(") {
        i++;
        const arg = parseExpr();
        skipWs();
        if (peek() !== ")") throw new Error(`expected ')' after ${name}(`);
        i++;
        const fn = FUNCS[name];
        if (!fn) throw new Error(`unknown function "${name}"`);
        return x => fn(arg(x));
      }
      if (name === "x") return x => x;
      if (name === "pi") return () => Math.PI;
      if (name === "e") return () => Math.E;
      throw new Error(`unknown identifier "${name}"`);
    }
    throw new Error(c === undefined ? "unexpected end of expression" : `unexpected character "${c}"`);
  }

  const result = parseExpr();
  skipWs();
  if (i < s.length) throw new Error(`unexpected trailing input "${s.slice(i)}"`);
  return result;
}

function buildFunctionPathD(fn, mapX, mapY, xMin, xMax, yMin, yMax) {
  const steps = 240;
  const yRange = yMax - yMin || 1;
  const yClipLo = yMin - yRange * 3, yClipHi = yMax + yRange * 3;
  let d = "", penDown = false;
  for (let k = 0; k <= steps; k++) {
    const xVal = xMin + (xMax - xMin) * (k / steps);
    let yVal;
    try { yVal = fn(xVal); } catch (e) { yVal = NaN; }
    const valid = Number.isFinite(yVal) && yVal >= yClipLo && yVal <= yClipHi;
    if (!valid) { penDown = false; continue; }
    const px = mapX(xVal).toFixed(2), py = mapY(yVal).toFixed(2);
    d += (penDown ? "L" : "M") + px + " " + py + " ";
    penDown = true;
  }
  return d.trim();
}

// Parses each raw field string as a plain positive number; returns null (not partial results)
// if ANY value fails, since mixing a real number with a variable like "x" can't be scaled sensibly.
function tryParseDims(strs) {
  const nums = strs.map(s => parseFloat(s));
  if (nums.some(n => !Number.isFinite(n) || n <= 0)) return null;
  return nums;
}
// Converts unit values to pixel dimensions at `pxPerUnit`, preserving their relative ratio exactly,
// then uniformly rescales (never distorting the ratio) so the largest dimension lands in [minPx, maxPx].
function scaleToPixels(nums, pxPerUnit, minPx, maxPx) {
  let px = nums.map(n => n * pxPerUnit);
  const maxRaw = Math.max(...px);
  if (maxRaw > maxPx) { const f = maxPx / maxRaw; px = px.map(v => v * f); }
  const maxAfter = Math.max(...px);
  if (maxAfter < minPx) { const f = minPx / maxAfter; px = px.map(v => v * f); }
  return px;
}

// Midpoint of an edge, nudged outward (away from a reference center point) along the edge's own
// perpendicular — the label sits at a consistent clearance from the edge regardless of the edge's
// angle, instead of a fixed x/y offset that only looks right for the one angle it was tuned at
// (e.g. a depth edge whose angle changes with the "Perspective" slider).
function labelOffEdge(p1, p2, center, dist) {
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
  const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
  let nx = -dy / len, ny = dx / len;
  if (nx * (mx - center.x) + ny * (my - center.y) < 0) { nx = -nx; ny = -ny; }
  return { x: mx + nx * dist, y: my + ny * dist };
}
