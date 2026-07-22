"use strict";
function buildMathShapeSVG() {
  const type = $("shapeTypeSelect").value;
  let svgString = "";
  const labelSpecs = []; // {x, y, text, fontSize} in the SVG-local coordinate space
  let srcBox = null; // {x, y, w, h} — the SVG-local crop box labelSpecs coordinates are relative to
  let fnErrors = []; // parse/eval errors from the "Plot Functions" fields, by function
  const size = 500;

  // Shared by both coordinate-plane tools (plane, planeMath).
  function ticksFor(min, max, step) {
    const arr = [];
    const startI = Math.ceil(min / step - 1e-9);
    for (let i = startI; i * step <= max + 1e-9; i++) {
      const v = i * step;
      if (Math.abs(v) > 1e-9) arr.push(v);
    }
    return arr;
  }
  const fmtNum = v => (Math.round(v * 1e6) / 1e6).toString();
  const fnColors = ["#DC2626", "#2563EB", "#16A34A", "#9333EA", "#D97706", "#0891B2"];

  if (type === "plane") {
    const xMin = parseFloat($("planeXMin").value) || -5;
    const xMax = parseFloat($("planeXMax").value) || 5;
    const yMin = parseFloat($("planeYMin").value) || -5;
    const yMax = parseFloat($("planeYMax").value) || 5;
    const drawGrid = $("planeGridLines").checked;
    const axisFontSize = parseInt($("planeFontSize").value) || 20;
    const legendFontSize = Math.max(9, axisFontSize - 1);
    const gridThickness = parseFloat($("planeGridThickness").value) || 2;
    const bgEnabled = $("planeBgEnabled").checked;
    const bgColor = $("planeBgColor").value || "#ffffff";
    const pad = 40;
    const graphW = size - pad * 2;
    const graphH = size - pad * 2;
    const mapX = val => pad + ((val - xMin) / (xMax - xMin)) * graphW;
    const mapY = val => pad + ((yMax - val) / (yMax - yMin)) * graphH;

    // Increments are user-settable now; guard against pathologically fine steps (huge ranges,
    // tiny increments) blowing up rendering by auto-coarsening while still covering the full range.
    const maxGridLines = 200;
    let xStep = Math.max(0.0001, parseFloat($("planeXStep").value) || 1);
    let yStep = Math.max(0.0001, parseFloat($("planeYStep").value) || 1);
    if ((xMax - xMin) / xStep > maxGridLines) xStep = (xMax - xMin) / maxGridLines;
    if ((yMax - yMin) / yStep > maxGridLines) yStep = (yMax - yMin) / maxGridLines;

    const xTicks = ticksFor(xMin, xMax, xStep);
    const yTicks = ticksFor(yMin, yMax, yStep);

    let innerSvg = "";
    if (drawGrid) {
      innerSvg += `<!-- Sub-grid structures -->\n`;
      for (const x of xTicks) {
        const cx = mapX(x);
        innerSvg += `  <line x1="${cx}" y1="${pad}" x2="${cx}" y2="${size-pad}" stroke="#E2E8F0" stroke-width="${gridThickness}"/>\n`;
      }
      for (const y of yTicks) {
        const cy = mapY(y);
        innerSvg += `  <line x1="${pad}" y1="${cy}" x2="${size-pad}" y2="${cy}" stroke="#E2E8F0" stroke-width="${gridThickness}"/>\n`;
      }
    }
    const originX = mapX(0); const originY = mapY(0);
    innerSvg += `<!-- Master Axis -->\n  <line x1="${pad}" y1="${originY}" x2="${size-pad}" y2="${originY}" stroke="black" stroke-width="2"/>\n`;
    innerSvg += `  <line x1="${originX}" y1="${pad}" x2="${originX}" y2="${size-pad}" stroke="black" stroke-width="2"/>\n`;
    for (const x of xTicks) {
      innerSvg += `  <text x="${mapX(x)}" y="${originY + 20}" font-family="sans-serif" font-size="${axisFontSize}" text-anchor="middle">${fmtNum(x)}</text>\n`;
    }
    for (const y of yTicks) {
      innerSvg += `  <text x="${originX - 10}" y="${mapY(y) + 4}" font-family="sans-serif" font-size="${axisFontSize}" text-anchor="end">${fmtNum(y)}</text>\n`;
    }

    // Clips plotted curves to the grid box — without it, steep functions (e.g. y=6x) compute
    // pixel coordinates far outside the box and the line spills into the margin/legend instead
    // of stopping at the axes.
    innerSvg += `  <defs><clipPath id="plotClip"><rect x="${pad}" y="${pad}" width="${graphW}" height="${graphH}"/></clipPath></defs>\n`;
    const fnLines = $("planeFunctions").value.split("\n").map(l => l.trim()).filter(Boolean);
    let legendY = pad + legendFontSize;
    fnLines.forEach((line, idx) => {
      const color = fnColors[idx % fnColors.length];
      try {
        const fn = compileExpr(line);
        const d = buildFunctionPathD(fn, mapX, mapY, xMin, xMax, yMin, yMax);
        if (d) innerSvg += `  <path d="${d}" fill="none" stroke="${color}" stroke-width="2" clip-path="url(#plotClip)"/>\n`;
        innerSvg += `  <rect x="${pad + 4}" y="${legendY - legendFontSize + 2}" width="${legendFontSize}" height="${legendFontSize}" fill="${color}"/>\n`;
        innerSvg += `  <text x="${pad + legendFontSize + 8}" y="${legendY}" font-family="ui-monospace, monospace" font-size="${legendFontSize}" fill="#333">${escapeXml(line)}</text>\n`;
        legendY += legendFontSize + 6;
      } catch (err) {
        fnErrors.push(`Line ${idx + 1} ("${line}"): ${err.message}`);
      }
    });

    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">\n<rect width="100%" height="100%" fill="${bgEnabled ? bgColor : "none"}"/>\n${innerSvg}</svg>`;

  } else if (type === "planeMath") {
    const xMin = parseFloat($("pmXMin").value) || -5;
    const xMax = parseFloat($("pmXMax").value) || 5;
    const yMin = parseFloat($("pmYMin").value) || -5;
    const yMax = parseFloat($("pmYMax").value) || 5;
    const drawGrid = $("pmGridLines").checked;
    const axisFontSize = parseInt($("pmFontSize").value) || 20;
    const legendFontSize = Math.max(9, axisFontSize - 1);
    const gridThickness = parseFloat($("pmGridThickness").value) || 1.5;
    const bgEnabled = $("pmBgEnabled").checked;
    const bgColor = $("pmBgColor").value || "#ffffff";
    const labelAxes = $("pmLabelAxes").checked;
    const xAxisLabel = $("pmAxisXLabel").value.trim() || "x";
    const yAxisLabel = $("pmAxisYLabel").value.trim() || "y";
    const showLegend = $("pmShowLegend").checked;
    const pad = 40;
    const graphW = size - pad * 2;
    const graphH = size - pad * 2;
    const mapX = val => pad + ((val - xMin) / (xMax - xMin)) * graphW;
    const mapY = val => pad + ((yMax - val) / (yMax - yMin)) * graphH;

    const maxGridLines = 200;
    let xStep = Math.max(0.0001, parseFloat($("pmXStep").value) || 1);
    let yStep = Math.max(0.0001, parseFloat($("pmYStep").value) || 1);
    if ((xMax - xMin) / xStep > maxGridLines) xStep = (xMax - xMin) / maxGridLines;
    if ((yMax - yMin) / yStep > maxGridLines) yStep = (yMax - yMin) / maxGridLines;

    const xTicks = ticksFor(xMin, xMax, xStep);
    const yTicks = ticksFor(yMin, yMax, yStep);

    let innerSvg = "";
    if (drawGrid) {
      innerSvg += `<!-- Sub-grid structures -->\n`;
      for (const x of xTicks) {
        const cx = mapX(x);
        innerSvg += `  <line x1="${cx}" y1="${pad}" x2="${cx}" y2="${size-pad}" stroke="#E2E8F0" stroke-width="${gridThickness}"/>\n`;
      }
      for (const y of yTicks) {
        const cy = mapY(y);
        innerSvg += `  <line x1="${pad}" y1="${cy}" x2="${size-pad}" y2="${cy}" stroke="#E2E8F0" stroke-width="${gridThickness}"/>\n`;
      }
    }
    const originX = mapX(0); const originY = mapY(0);
    innerSvg += `<!-- Master Axis -->\n  <line x1="${pad}" y1="${originY}" x2="${size-pad}" y2="${originY}" stroke="black" stroke-width="2"/>\n`;
    innerSvg += `  <line x1="${originX}" y1="${pad}" x2="${originX}" y2="${size-pad}" stroke="black" stroke-width="2"/>\n`;
    // Arrowheads on all four axis ends, matching the number-line tool's arrow style.
    innerSvg += `  <path d="M ${size-pad} ${originY} L ${size-pad-12} ${originY-6} L ${size-pad-12} ${originY+6} Z" fill="black"/>\n`;
    innerSvg += `  <path d="M ${pad} ${originY} L ${pad+12} ${originY-6} L ${pad+12} ${originY+6} Z" fill="black"/>\n`;
    innerSvg += `  <path d="M ${originX} ${pad} L ${originX-6} ${pad+12} L ${originX+6} ${pad+12} Z" fill="black"/>\n`;
    innerSvg += `  <path d="M ${originX} ${size-pad} L ${originX-6} ${size-pad-12} L ${originX+6} ${size-pad-12} Z" fill="black"/>\n`;
    for (const x of xTicks) {
      innerSvg += `  <text x="${mapX(x)}" y="${originY + 20}" font-family="sans-serif" font-size="${axisFontSize}" text-anchor="middle">${fmtNum(x)}</text>\n`;
    }
    for (const y of yTicks) {
      innerSvg += `  <text x="${originX - 10}" y="${mapY(y) + 4}" font-family="sans-serif" font-size="${axisFontSize}" text-anchor="end">${fmtNum(y)}</text>\n`;
    }
    if (labelAxes) {
      const axisLabelSize = axisFontSize + 2;
      // "y" sits on the y-axis, above its arrowhead; "x" sits outside the plot, past the x-axis arrowhead.
      innerSvg += `  <text x="${size - pad + 10}" y="${originY + 5}" font-family="serif" font-style="italic" font-weight="bold" font-size="${axisLabelSize}" text-anchor="start">${escapeXml(xAxisLabel)}</text>\n`;
      innerSvg += `  <text x="${originX}" y="${pad - 12}" font-family="serif" font-style="italic" font-weight="bold" font-size="${axisLabelSize}" text-anchor="middle">${escapeXml(yAxisLabel)}</text>\n`;
    }

    // Clips plotted curves to the grid box — without it, steep functions (e.g. y=6x) compute
    // pixel coordinates far outside the box and the line spills into the margin/legend instead
    // of stopping at the axes.
    innerSvg += `  <defs><clipPath id="plotClip"><rect x="${pad}" y="${pad}" width="${graphW}" height="${graphH}"/></clipPath></defs>\n`;
    const fnRows = Array.from(document.querySelectorAll("#pmFnList .eq-row"));
    let legendY = pad + legendFontSize;
    fnRows.forEach((row, idx) => {
      const enabled = row.querySelector(".eq-enabled").checked;
      const expr = row.querySelector(".eq-expr").value.trim();
      const customLabel = row.querySelector(".eq-label").value.trim();
      if (!expr || !enabled) return;
      const color = fnColors[idx % fnColors.length];
      try {
        const fn = compileExpr(expr);
        const d = buildFunctionPathD(fn, mapX, mapY, xMin, xMax, yMin, yMax);
        if (d) innerSvg += `  <path d="${d}" fill="none" stroke="${color}" stroke-width="2" clip-path="url(#plotClip)"/>\n`;
        if (showLegend) {
          const legendText = customLabel || (labelAxes ? `${yAxisLabel} = ${expr}` : expr);
          innerSvg += `  <rect x="${pad + 4}" y="${legendY - legendFontSize + 2}" width="${legendFontSize}" height="${legendFontSize}" fill="${color}"/>\n`;
          innerSvg += `  <text x="${pad + legendFontSize + 8}" y="${legendY}" font-family="ui-monospace, monospace" font-size="${legendFontSize}" fill="#333">${escapeXml(legendText)}</text>\n`;
          legendY += legendFontSize + 6;
        }
      } catch (err) {
        fnErrors.push(`"${expr}": ${err.message}`);
      }
    });

    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">\n<rect width="100%" height="100%" fill="${bgEnabled ? bgColor : "none"}"/>\n${innerSvg}</svg>`;

  } else if (type === "planeQ1") {
    const xMin = 0, yMin = 0;
    const xMax = Math.max(0.0001, parseFloat($("q1XMax").value) || 10);
    const yMax = Math.max(0.0001, parseFloat($("q1YMax").value) || 10);
    const drawGrid = $("q1GridLines").checked;
    const axisFontSize = parseInt($("q1FontSize").value) || 20;
    const legendFontSize = Math.max(9, axisFontSize - 1);
    const gridThickness = parseFloat($("q1GridThickness").value) || 2;
    const bgEnabled = $("q1BgEnabled").checked;
    const bgColor = $("q1BgColor").value || "#ffffff";
    const labelAxes = $("q1LabelAxes").checked;
    const xAxisLabel = $("q1AxisXLabel").value.trim() || "x";
    const yAxisLabel = $("q1AxisYLabel").value.trim() || "y";
    const showLegend = $("q1ShowLegend").checked;
    const pad = 40;
    const graphW = size - pad * 2;
    const graphH = size - pad * 2;
    const mapX = val => pad + ((val - xMin) / (xMax - xMin)) * graphW;
    const mapY = val => pad + ((yMax - val) / (yMax - yMin)) * graphH;

    const maxGridLines = 200;
    let xStep = Math.max(0.0001, parseFloat($("q1XStep").value) || 1);
    let yStep = Math.max(0.0001, parseFloat($("q1YStep").value) || 1);
    if ((xMax - xMin) / xStep > maxGridLines) xStep = (xMax - xMin) / maxGridLines;
    if ((yMax - yMin) / yStep > maxGridLines) yStep = (yMax - yMin) / maxGridLines;

    const xTicks = ticksFor(xMin, xMax, xStep);
    const yTicks = ticksFor(yMin, yMax, yStep);

    let innerSvg = "";
    if (drawGrid) {
      innerSvg += `<!-- Sub-grid structures -->\n`;
      for (const x of xTicks) {
        const cx = mapX(x);
        innerSvg += `  <line x1="${cx}" y1="${pad}" x2="${cx}" y2="${size-pad}" stroke="#E2E8F0" stroke-width="${gridThickness}"/>\n`;
      }
      for (const y of yTicks) {
        const cy = mapY(y);
        innerSvg += `  <line x1="${pad}" y1="${cy}" x2="${size-pad}" y2="${cy}" stroke="#E2E8F0" stroke-width="${gridThickness}"/>\n`;
      }
    }
    const originX = mapX(0); const originY = mapY(0);
    innerSvg += `<!-- Master Axis -->\n  <line x1="${pad}" y1="${originY}" x2="${size-pad}" y2="${originY}" stroke="black" stroke-width="2"/>\n`;
    innerSvg += `  <line x1="${originX}" y1="${pad}" x2="${originX}" y2="${size-pad}" stroke="black" stroke-width="2"/>\n`;
    // Only the positive ends get arrowheads — the origin sits at the box's bottom-left corner,
    // so there's no negative direction to point into.
    innerSvg += `  <path d="M ${size-pad} ${originY} L ${size-pad-12} ${originY-6} L ${size-pad-12} ${originY+6} Z" fill="black"/>\n`;
    innerSvg += `  <path d="M ${originX} ${pad} L ${originX-6} ${pad+12} L ${originX+6} ${pad+12} Z" fill="black"/>\n`;
    for (const x of xTicks) {
      innerSvg += `  <text x="${mapX(x)}" y="${originY + 20}" font-family="sans-serif" font-size="${axisFontSize}" text-anchor="middle">${fmtNum(x)}</text>\n`;
    }
    for (const y of yTicks) {
      innerSvg += `  <text x="${originX - 10}" y="${mapY(y) + 4}" font-family="sans-serif" font-size="${axisFontSize}" text-anchor="end">${fmtNum(y)}</text>\n`;
    }
    if (labelAxes) {
      const axisLabelSize = axisFontSize + 2;
      innerSvg += `  <text x="${size - pad + 10}" y="${originY + 5}" font-family="serif" font-style="italic" font-weight="bold" font-size="${axisLabelSize}" text-anchor="start">${escapeXml(xAxisLabel)}</text>\n`;
      innerSvg += `  <text x="${originX}" y="${pad - 12}" font-family="serif" font-style="italic" font-weight="bold" font-size="${axisLabelSize}" text-anchor="middle">${escapeXml(yAxisLabel)}</text>\n`;
    }

    // Clips plotted curves to the grid box — without it, steep functions (e.g. y=6x) compute
    // pixel coordinates far outside the box and the line spills into the margin/legend instead
    // of stopping at the axes.
    innerSvg += `  <defs><clipPath id="plotClip"><rect x="${pad}" y="${pad}" width="${graphW}" height="${graphH}"/></clipPath></defs>\n`;
    const fnRowsQ1 = Array.from(document.querySelectorAll("#q1FnList .eq-row"));
    let legendYQ1 = pad + legendFontSize;
    fnRowsQ1.forEach((row, idx) => {
      const enabled = row.querySelector(".eq-enabled").checked;
      const expr = row.querySelector(".eq-expr").value.trim();
      const customLabel = row.querySelector(".eq-label").value.trim();
      if (!expr || !enabled) return;
      const color = fnColors[idx % fnColors.length];
      try {
        const fn = compileExpr(expr);
        const d = buildFunctionPathD(fn, mapX, mapY, xMin, xMax, yMin, yMax);
        if (d) innerSvg += `  <path d="${d}" fill="none" stroke="${color}" stroke-width="2" clip-path="url(#plotClip)"/>\n`;
        if (showLegend) {
          const legendText = customLabel || (labelAxes ? `${yAxisLabel} = ${expr}` : expr);
          innerSvg += `  <rect x="${pad + 4}" y="${legendYQ1 - legendFontSize + 2}" width="${legendFontSize}" height="${legendFontSize}" fill="${color}"/>\n`;
          innerSvg += `  <text x="${pad + legendFontSize + 8}" y="${legendYQ1}" font-family="ui-monospace, monospace" font-size="${legendFontSize}" fill="#333">${escapeXml(legendText)}</text>\n`;
          legendYQ1 += legendFontSize + 6;
        }
      } catch (err) {
        fnErrors.push(`"${expr}": ${err.message}`);
      }
    });

    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">\n<rect width="100%" height="100%" fill="${bgEnabled ? bgColor : "none"}"/>\n${innerSvg}</svg>`;

  } else if (type === "triangle") {
    const isRight = $("triRightAngle").checked;
    const rotationDeg = parseFloat($("triRotation").value) || 0;

    const lblBottom = $("triBottom").value;
    const lblLeft = $("triLeft").value;
    const lblRight = $("triRight").value;
    
    const txtAngleA = isRight ? "" : $("triAngleA").value;
    const txtAngleB = $("triAngleB").value;
    const txtAngleC = $("triAngleC").value;

    const tickB = $("triTickBottom").checked;
    const tickL = $("triTickLeft").checked;
    const tickR = $("triTickRight").checked;
    const showSideLabels = $("triShowSideLabels").checked;
    const showAngleLabels = $("triShowAngleLabels").checked;

    // Font size is driven directly by the slider; the rest scale proportionally from it
    // (calibrated so slider=24 matches the old "off" state and slider=36 matches the old "large" state).
    const sideFontSize = parseInt($("triFontSize").value) || 24;
    const scaleT = sideFontSize - 24;
    const angleFontSize = Math.round(22 + scaleT * (10 / 12));
    const sideOffsetDist = Math.round(32 + scaleT * (14 / 12));
    const sideVertAdjust = Math.round(7 + scaleT * (4 / 12));
    const angleOffsetDist = Math.round(47 + scaleT * (15 / 12));

    let A = { x: 160, y: 320 }, B = { x: 0, y: 0 }, C = { x: 340, y: 320 };
    if (isRight) {
      C.x = A.x + 180; C.y = A.y;
      B.x = A.x; B.y = A.y - 140;
      // If both legs are given as plain numbers, draw the triangle at their true relative proportions.
      const parsedLegs = tryParseDims([lblBottom, lblLeft]);
      if (parsedLegs) {
        const [bottomPx, leftPx] = scaleToPixels(parsedLegs, 16, 80, 280);
        C.x = A.x + bottomPx; C.y = A.y;
        B.x = A.x; B.y = A.y - leftPx;
      }
    } else {
      B.x = parseInt($("triVertexBX").value) || 250;
      B.y = parseInt($("triVertexBY").value) || 130;
      // If all three sides are given as plain numbers (and form a valid triangle), construct the
      // true SSS shape via the law of cosines instead of using the arbitrary vertex-B position.
      const parsedSSS = tryParseDims([lblBottom, lblLeft, lblRight]);
      if (parsedSSS) {
        const [bottomU, leftU, rightU] = parsedSSS;
        if (bottomU + leftU > rightU && bottomU + rightU > leftU && leftU + rightU > bottomU) {
          const [bottomPx, leftPx, rightPx] = scaleToPixels(parsedSSS, 16, 80, 280);
          const cosA = (leftPx * leftPx + bottomPx * bottomPx - rightPx * rightPx) / (2 * leftPx * bottomPx);
          const angleA = Math.acos(Math.max(-1, Math.min(1, cosA)));
          A = { x: 160, y: 320 };
          C = { x: 160 + bottomPx, y: 320 };
          B = { x: A.x + leftPx * Math.cos(angleA), y: A.y - leftPx * Math.sin(angleA) };
        }
      }
    }

    const canvasCenter = { x: 250, y: 250 };
    const rawCentroid = { x: (A.x + B.x + C.x) / 3, y: (A.y + B.y + C.y) / 3 };
    const shiftX = canvasCenter.x - rawCentroid.x;
    const shiftY = canvasCenter.y - rawCentroid.y;
    A.x += shiftX; A.y += shiftY; B.x += shiftX; B.y += shiftY; C.x += shiftX; C.y += shiftY;

    const rotA = rotatePoint(A, canvasCenter, rotationDeg);
    const rotB = rotatePoint(B, canvasCenter, rotationDeg);
    const rotC = rotatePoint(C, canvasCenter, rotationDeg);

    let bbMinX = Infinity, bbMinY = Infinity, bbMaxX = -Infinity, bbMaxY = -Infinity;
    function trackBB(x, y) {
      if (x < bbMinX) bbMinX = x; if (x > bbMaxX) bbMaxX = x;
      if (y < bbMinY) bbMinY = y; if (y > bbMaxY) bbMaxY = y;
    }
    trackBB(rotA.x, rotA.y); trackBB(rotB.x, rotB.y); trackBB(rotC.x, rotC.y);

    let innerSvg = `  <!-- Geometry Outline -->\n`;
    innerSvg += `  <polygon points="${rotA.x},${rotA.y} ${rotB.x},${rotB.y} ${rotC.x},${rotC.y}" fill="none" stroke="black" stroke-width="2.5" stroke-linejoin="round"/>\n`;

    if (isRight) {
      const rSize = 18;
      let abX = rotB.x - rotA.x, abY = rotB.y - rotA.y;
      let acX = rotC.x - rotA.x, acY = rotC.y - rotA.y;
      let lenAB = Math.sqrt(abX*abX + abY*abY) || 1;
      let lenAC = Math.sqrt(acX*acX + acY*acY) || 1;
      let uAB = { x: abX/lenAB, y: abY/lenAB }, uAC = { x: acX/lenAC, y: acY/lenAC };
      let p1 = { x: rotA.x + uAB.x * rSize, y: rotA.y + uAB.y * rSize };
      let p3 = { x: rotA.x + uAC.x * rSize, y: rotA.y + uAC.y * rSize };
      let p2 = { x: p1.x + uAC.x * rSize, y: p1.y + uAC.y * rSize };
      innerSvg += `  <path d="M ${p1.x} ${p1.y} L ${p2.x} ${p2.y} L ${p3.x} ${p3.y}" fill="none" stroke="black" stroke-width="1.5"/>\n`;
      trackBB(p1.x, p1.y); trackBB(p2.x, p2.y); trackBB(p3.x, p3.y);
    }

    function processSide(pStart, pEnd, labelText, drawTick) {
      let mx = (pStart.x + pEnd.x) / 2, my = (pStart.y + pEnd.y) / 2;
      let dx = pEnd.x - pStart.x, dy = pEnd.y - pStart.y;
      let len = Math.sqrt(dx*dx + dy*dy) || 1;
      let nx = -dy / len, ny = dx / len;
      let cx = mx - canvasCenter.x, cy = my - canvasCenter.y;
      if (nx * cx + ny * cy < 0) { nx = -nx; ny = -ny; }
      if (drawTick) {
        const tLen = 9;
        const tx1 = mx - nx * tLen, ty1 = my - ny * tLen, tx2 = mx + nx * tLen, ty2 = my + ny * tLen;
        innerSvg += `  <line x1="${tx1}" y1="${ty1}" x2="${tx2}" y2="${ty2}" stroke="black" stroke-width="2"/>\n`;
        trackBB(tx1, ty1); trackBB(tx2, ty2);
      }
      if (labelText && showSideLabels) {
        labelSpecs.push({ x: mx + nx * sideOffsetDist, y: my + ny * sideOffsetDist + sideVertAdjust, text: labelText, fontSize: +sideFontSize });
      }
    }

    processSide(rotA, rotC, lblBottom, tickB);
    processSide(rotA, rotB, lblLeft, tickL);
    processSide(rotB, rotC, lblRight, tickR);

    if (txtAngleA && !isRight) {
      innerSvg += drawAngleArc(rotA, rotB, rotC, 26, canvasCenter);
      trackBB(rotA.x - 26, rotA.y - 26); trackBB(rotA.x + 26, rotA.y + 26);
      if (showAngleLabels) {
        let pos = getBisectorVector(rotA, rotB, rotC, angleOffsetDist, canvasCenter);
        labelSpecs.push({ x: pos.x, y: pos.y, text: txtAngleA, fontSize: +angleFontSize });
      }
    }
    if (txtAngleB) {
      innerSvg += drawAngleArc(rotB, rotA, rotC, 26, canvasCenter);
      trackBB(rotB.x - 26, rotB.y - 26); trackBB(rotB.x + 26, rotB.y + 26);
      if (showAngleLabels) {
        let pos = getBisectorVector(rotB, rotA, rotC, angleOffsetDist, canvasCenter);
        labelSpecs.push({ x: pos.x, y: pos.y, text: txtAngleB, fontSize: +angleFontSize });
      }
    }
    if (txtAngleC) {
      innerSvg += drawAngleArc(rotC, rotA, rotB, 26, canvasCenter);
      trackBB(rotC.x - 26, rotC.y - 26); trackBB(rotC.x + 26, rotC.y + 26);
      if (showAngleLabels) {
        let pos = getBisectorVector(rotC, rotA, rotB, angleOffsetDist, canvasCenter);
        labelSpecs.push({ x: pos.x, y: pos.y, text: txtAngleC, fontSize: +angleFontSize });
      }
    }

    const cropMargin = 16;
    const boxX = Math.floor(bbMinX - cropMargin), boxY = Math.floor(bbMinY - cropMargin);
    const boxW = Math.ceil(bbMaxX - bbMinX) + cropMargin * 2, boxH = Math.ceil(bbMaxY - bbMinY) + cropMargin * 2;
    srcBox = { x: boxX, y: boxY, w: boxW, h: boxH };
    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${boxX} ${boxY} ${boxW} ${boxH}" width="${boxW}" height="${boxH}">\n<rect width="100%" height="100%" fill="none"/>\n${innerSvg}</svg>`;

  } else if (type === "circle") {
    const lblRadius = $("circRadius").value;
    const showRadius = $("circShowRadius").checked;
    const showDiameter = $("circShowDiameter").checked;
    const lblDiameter = $("circDiameter").value;
    const sectorAngle = Math.max(0, Math.min(360, parseFloat($("circSectorAngle").value) || 0));
    const lblSector = $("circSectorLabel").value;
    const fontSize = parseInt($("circFontSize").value) || 24;
    const showSideLabels = $("circShowSideLabels").checked;
    const showAngleLabels = $("circShowAngleLabels").checked;

    const center = { x: 250, y: 250 };
    let R = 150;
    const parsedR = tryParseDims([lblRadius]);
    if (parsedR) [R] = scaleToPixels(parsedR, 20, 60, 200);

    let bbMinX = Infinity, bbMinY = Infinity, bbMaxX = -Infinity, bbMaxY = -Infinity;
    function trackBB(x, y) {
      if (x < bbMinX) bbMinX = x; if (x > bbMaxX) bbMaxX = x;
      if (y < bbMinY) bbMinY = y; if (y > bbMaxY) bbMaxY = y;
    }
    trackBB(center.x - R, center.y - R); trackBB(center.x + R, center.y + R);

    let innerSvg = `  <circle cx="${center.x}" cy="${center.y}" r="${R}" fill="none" stroke="black" stroke-width="2.5"/>\n`;

    if (sectorAngle > 0) {
      const rad = sectorAngle * Math.PI / 180;
      const p1 = { x: center.x + R, y: center.y };
      const p2 = { x: center.x + R * Math.cos(rad), y: center.y + R * Math.sin(rad) };
      const largeArc = sectorAngle > 180 ? 1 : 0;
      innerSvg += `  <path d="M ${center.x} ${center.y} L ${p1.x} ${p1.y} A ${R} ${R} 0 ${largeArc} 1 ${p2.x} ${p2.y} Z" fill="rgba(15,118,110,0.12)" stroke="black" stroke-width="2"/>\n`;
      if (lblSector && showAngleLabels) {
        const midRad = rad / 2, labelDist = R * 0.55;
        labelSpecs.push({
          x: center.x + labelDist * Math.cos(midRad), y: center.y + labelDist * Math.sin(midRad),
          text: lblSector, fontSize: Math.round(fontSize * 0.9),
        });
      }
    }

    // Radius line — placed away from the sector (if any) so labels don't collide.
    const radiusAngleDeg = sectorAngle > 0 ? sectorAngle + 55 : -20;
    const radRad = radiusAngleDeg * Math.PI / 180;
    if (showRadius) {
      const rEnd = { x: center.x + R * Math.cos(radRad), y: center.y + R * Math.sin(radRad) };
      innerSvg += `  <line x1="${center.x}" y1="${center.y}" x2="${rEnd.x}" y2="${rEnd.y}" stroke="black" stroke-width="2"/>\n`;
      trackBB(rEnd.x, rEnd.y);
      if (lblRadius && showSideLabels) {
        // Sits right on the line itself (partway out from center), not offset to one side of it —
        // reads as labeling the line instead of floating near it inside the circle.
        const t = 0.55;
        labelSpecs.push({
          x: center.x + R * t * Math.cos(radRad), y: center.y + R * t * Math.sin(radRad),
          text: lblRadius, fontSize,
        });
      }
    }

    if (showDiameter) {
      const diamAngleDeg = radiusAngleDeg + 90;
      const dr = diamAngleDeg * Math.PI / 180;
      const d1 = { x: center.x + R * Math.cos(dr), y: center.y + R * Math.sin(dr) };
      const d2 = { x: center.x - R * Math.cos(dr), y: center.y - R * Math.sin(dr) };
      innerSvg += `  <line x1="${d1.x}" y1="${d1.y}" x2="${d2.x}" y2="${d2.y}" stroke="black" stroke-width="2"/>\n`;
      trackBB(d1.x, d1.y); trackBB(d2.x, d2.y);
      if (lblDiameter && showSideLabels) {
        const t = 0.55;
        labelSpecs.push({
          x: center.x + R * t * Math.cos(dr), y: center.y + R * t * Math.sin(dr),
          text: lblDiameter, fontSize,
        });
      }
    }

    const cropMargin = 16;
    const boxX = Math.floor(bbMinX - cropMargin), boxY = Math.floor(bbMinY - cropMargin);
    const boxW = Math.ceil(bbMaxX - bbMinX) + cropMargin * 2, boxH = Math.ceil(bbMaxY - bbMinY) + cropMargin * 2;
    srcBox = { x: boxX, y: boxY, w: boxW, h: boxH };
    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${boxX} ${boxY} ${boxW} ${boxH}" width="${boxW}" height="${boxH}">\n<rect width="100%" height="100%" fill="none"/>\n${innerSvg}</svg>`;

  } else if (type === "square" || type === "rectangle" || type === "parallelogram") {
    const fontSize = parseInt($("quadFontSize").value) || 24;
    const rotationDeg = parseFloat($("quadRotation").value) || 0;
    const center = { x: 250, y: 250 };

    let A, B, C, D;
    const sideLabels = []; // {p1, p2, text}
    const tickSides = [];  // [p1, p2] pairs to mark with a tick
    let rightAngleCorners = []; // {corner, adjA, adjB}
    let angleLabel = null; // {corner, adjA, adjB, text}
    const showSideLabels = type === "square" ? $("quadSquareShowLabels").checked
      : type === "rectangle" ? $("quadRectShowLabels").checked
      : $("quadParaShowSideLabels").checked;
    const showAngleLabels = type === "parallelogram" ? $("quadParaShowAngleLabels").checked : true;

    if (type === "square") {
      const sideVal = $("quadSquareSide").value;
      let s = 200;
      const parsed = tryParseDims([sideVal]);
      if (parsed) [s] = scaleToPixels(parsed, 18, 80, 300);
      A = { x: 150, y: 150 + s }; B = { x: 150, y: 150 }; C = { x: 150 + s, y: 150 }; D = { x: 150 + s, y: 150 + s };
      if (sideVal && showSideLabels) sideLabels.push({ p1: A, p2: D, text: sideVal });
      if ($("quadSquareTicks").checked) tickSides.push([A, D], [D, C], [C, B], [B, A]);
      if ($("quadSquareRight").checked) rightAngleCorners = [
        { corner: A, adjA: B, adjB: D }, { corner: B, adjA: C, adjB: A },
        { corner: C, adjA: D, adjB: B }, { corner: D, adjA: A, adjB: C },
      ];
    } else if (type === "rectangle") {
      const wVal = $("quadRectWidth").value, hVal = $("quadRectHeight").value;
      let w = 260, h = 180;
      const parsed = tryParseDims([wVal, hVal]);
      if (parsed) [w, h] = scaleToPixels(parsed, 18, 80, 320);
      A = { x: 120, y: 160 + h }; B = { x: 120, y: 160 }; C = { x: 120 + w, y: 160 }; D = { x: 120 + w, y: 160 + h };
      if (wVal && showSideLabels) sideLabels.push({ p1: A, p2: D, text: wVal });
      if (hVal && showSideLabels) sideLabels.push({ p1: A, p2: B, text: hVal });
      if ($("quadRectRight").checked) rightAngleCorners = [
        { corner: A, adjA: B, adjB: D }, { corner: B, adjA: C, adjB: A },
        { corner: C, adjA: D, adjB: B }, { corner: D, adjA: A, adjB: C },
      ];
    } else {
      const paraAngleDeg = parseFloat($("quadParaAngle").value) || 60;
      const angleRad = paraAngleDeg * Math.PI / 180;
      const baseVal = $("quadParaBase").value, sideVal = $("quadParaSide").value;
      let baseLen = 220, sideLen = 170;
      const parsed = tryParseDims([baseVal, sideVal]);
      if (parsed) [baseLen, sideLen] = scaleToPixels(parsed, 18, 80, 300);
      A = { x: 150, y: 350 };
      D = { x: 150 + baseLen, y: 350 };
      B = { x: A.x + sideLen * Math.cos(angleRad), y: A.y - sideLen * Math.sin(angleRad) };
      C = { x: D.x + sideLen * Math.cos(angleRad), y: D.y - sideLen * Math.sin(angleRad) };
      if (baseVal && showSideLabels) sideLabels.push({ p1: A, p2: D, text: baseVal });
      if (sideVal && showSideLabels) sideLabels.push({ p1: A, p2: B, text: sideVal });
      if (showAngleLabels) angleLabel = { corner: A, adjA: D, adjB: B, text: Math.round(paraAngleDeg) + "°" };
    }

    const verts = [A, B, C, D];
    const rawCentroid = { x: (A.x + B.x + C.x + D.x) / 4, y: (A.y + B.y + C.y + D.y) / 4 };
    const shiftX = center.x - rawCentroid.x, shiftY = center.y - rawCentroid.y;
    verts.forEach(v => { v.x += shiftX; v.y += shiftY; });

    const rot = v => rotatePoint(v, center, rotationDeg);
    const rA = rot(A), rB = rot(B), rC = rot(C), rD = rot(D);
    const rotMap = new Map([[A, rA], [B, rB], [C, rC], [D, rD]]);

    let bbMinX = Infinity, bbMinY = Infinity, bbMaxX = -Infinity, bbMaxY = -Infinity;
    function trackBB(x, y) {
      if (x < bbMinX) bbMinX = x; if (x > bbMaxX) bbMaxX = x;
      if (y < bbMinY) bbMinY = y; if (y > bbMaxY) bbMaxY = y;
    }
    [rA, rB, rC, rD].forEach(p => trackBB(p.x, p.y));

    let innerSvg = `  <polygon points="${rA.x},${rA.y} ${rB.x},${rB.y} ${rC.x},${rC.y} ${rD.x},${rD.y}" fill="none" stroke="black" stroke-width="2.5" stroke-linejoin="round"/>\n`;

    for (const [p1, p2] of tickSides) {
      const rp1 = rotMap.get(p1), rp2 = rotMap.get(p2);
      const mx = (rp1.x + rp2.x) / 2, my = (rp1.y + rp2.y) / 2;
      const dx = rp2.x - rp1.x, dy = rp2.y - rp1.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = -dy / len, ny = dx / len, tLen = 9;
      innerSvg += `  <line x1="${mx - nx * tLen}" y1="${my - ny * tLen}" x2="${mx + nx * tLen}" y2="${my + ny * tLen}" stroke="black" stroke-width="2"/>\n`;
    }

    for (const { corner, adjA, adjB } of rightAngleCorners) {
      const rc = rotMap.get(corner), ra = rotMap.get(adjA), rb = rotMap.get(adjB);
      const rSize = 16;
      let uA = { x: ra.x - rc.x, y: ra.y - rc.y }, uB = { x: rb.x - rc.x, y: rb.y - rc.y };
      const lenA = Math.sqrt(uA.x ** 2 + uA.y ** 2) || 1, lenB = Math.sqrt(uB.x ** 2 + uB.y ** 2) || 1;
      uA = { x: uA.x / lenA, y: uA.y / lenA }; uB = { x: uB.x / lenB, y: uB.y / lenB };
      const p1 = { x: rc.x + uA.x * rSize, y: rc.y + uA.y * rSize };
      const p3 = { x: rc.x + uB.x * rSize, y: rc.y + uB.y * rSize };
      const p2 = { x: p1.x + uB.x * rSize, y: p1.y + uB.y * rSize };
      innerSvg += `  <path d="M ${p1.x} ${p1.y} L ${p2.x} ${p2.y} L ${p3.x} ${p3.y}" fill="none" stroke="black" stroke-width="1.5"/>\n`;
    }

    for (const { p1, p2, text } of sideLabels) {
      const rp1 = rotMap.get(p1), rp2 = rotMap.get(p2);
      const mx = (rp1.x + rp2.x) / 2, my = (rp1.y + rp2.y) / 2;
      const dx = rp2.x - rp1.x, dy = rp2.y - rp1.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      let nx = -dy / len, ny = dx / len;
      const cx = mx - center.x, cy = my - center.y;
      if (nx * cx + ny * cy < 0) { nx = -nx; ny = -ny; }
      const offsetDist = 32;
      labelSpecs.push({ x: mx + nx * offsetDist, y: my + ny * offsetDist, text, fontSize });
    }

    if (angleLabel) {
      const rc = rotMap.get(angleLabel.corner), ra = rotMap.get(angleLabel.adjA), rb = rotMap.get(angleLabel.adjB);
      innerSvg += drawAngleArc(rc, ra, rb, 26, center);
      trackBB(rc.x - 26, rc.y - 26); trackBB(rc.x + 26, rc.y + 26);
      const pos = getBisectorVector(rc, ra, rb, 47, center);
      labelSpecs.push({ x: pos.x, y: pos.y, text: angleLabel.text, fontSize: Math.round(fontSize * 0.9) });
    }

    const cropMargin = 16;
    const boxX = Math.floor(bbMinX - cropMargin), boxY = Math.floor(bbMinY - cropMargin);
    const boxW = Math.ceil(bbMaxX - bbMinX) + cropMargin * 2, boxH = Math.ceil(bbMaxY - bbMinY) + cropMargin * 2;
    srcBox = { x: boxX, y: boxY, w: boxW, h: boxH };
    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${boxX} ${boxY} ${boxW} ${boxH}" width="${boxW}" height="${boxH}">\n<rect width="100%" height="100%" fill="none"/>\n${innerSvg}</svg>`;

  } else if (type === "polygon") {
    const n = Math.max(3, Math.min(12, parseInt($("polygonSides").value) || 6));
    const fontSize = parseInt($("polygonFontSize").value) || 24;
    const rotationDeg = parseFloat($("polygonRotation").value) || 0;
    const sideVal = $("polygonSide").value;
    const showAngle = $("polygonShowAngle").checked;
    const center = { x: 250, y: 250 };
    let R = 150;
    const parsedSide = tryParseDims([sideVal]);
    if (parsedSide) {
      const [sidePx] = scaleToPixels(parsedSide, 18, 40, 150);
      R = Math.max(50, Math.min(220, sidePx / (2 * Math.sin(Math.PI / n))));
    }

    let bbMinX = Infinity, bbMinY = Infinity, bbMaxX = -Infinity, bbMaxY = -Infinity;
    function trackBB(x, y) {
      if (x < bbMinX) bbMinX = x; if (x > bbMaxX) bbMaxX = x;
      if (y < bbMinY) bbMinY = y; if (y > bbMaxY) bbMaxY = y;
    }

    const verts = [];
    for (let i = 0; i < n; i++) {
      const angle = -Math.PI / 2 + i * (2 * Math.PI / n) + rotationDeg * Math.PI / 180;
      verts.push({ x: center.x + R * Math.cos(angle), y: center.y + R * Math.sin(angle) });
    }
    verts.forEach(v => trackBB(v.x, v.y));

    let innerSvg = `  <polygon points="${verts.map(v => `${v.x},${v.y}`).join(" ")}" fill="none" stroke="black" stroke-width="2.5" stroke-linejoin="round"/>\n`;

    if (sideVal && $("polygonShowSideLabels").checked) {
      const p1 = verts[0], p2 = verts[1];
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      let nx = -dy / len, ny = dx / len;
      const cx = mx - center.x, cy = my - center.y;
      if (nx * cx + ny * cy < 0) { nx = -nx; ny = -ny; }
      labelSpecs.push({ x: mx + nx * 28, y: my + ny * 28, text: sideVal, fontSize });
    }

    if (showAngle) {
      const interiorDeg = Math.round((n - 2) * 180 / n);
      const v0 = verts[0], prev = verts[n - 1], next = verts[1];
      innerSvg += drawAngleArc(v0, prev, next, 22, center);
      trackBB(v0.x - 22, v0.y - 22); trackBB(v0.x + 22, v0.y + 22);
      const pos = getBisectorVector(v0, prev, next, 40, center);
      labelSpecs.push({ x: pos.x, y: pos.y, text: interiorDeg + "°", fontSize: Math.round(fontSize * 0.85) });
    }

    const cropMargin = 16;
    const boxX = Math.floor(bbMinX - cropMargin), boxY = Math.floor(bbMinY - cropMargin);
    const boxW = Math.ceil(bbMaxX - bbMinX) + cropMargin * 2, boxH = Math.ceil(bbMaxY - bbMinY) + cropMargin * 2;
    srcBox = { x: boxX, y: boxY, w: boxW, h: boxH };
    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${boxX} ${boxY} ${boxW} ${boxH}" width="${boxW}" height="${boxH}">\n<rect width="100%" height="100%" fill="none"/>\n${innerSvg}</svg>`;

  } else if (type === "cube" || type === "prism") {
    const fontSize = parseInt($("solid3dFontSize").value) || 24;
    let W, H, Dd, lblW, lblH, lblD;
    if (type === "cube") {
      const sideVal = $("cubeSide").value;
      W = H = 160; Dd = 96;
      const parsed = tryParseDims([sideVal]);
      if (parsed) { const [s] = scaleToPixels(parsed, 16, 70, 240); W = H = s; Dd = s * 0.6; }
      lblW = lblH = lblD = sideVal;
    } else {
      const wVal = $("prismWidth").value, hVal = $("prismHeight").value, dVal = $("prismDepth").value;
      W = 220; H = 150; Dd = 130;
      const parsed = tryParseDims([wVal, hVal, dVal]);
      if (parsed) [W, H, Dd] = scaleToPixels(parsed, 16, 70, 240);
      lblW = wVal; lblH = hVal; lblD = dVal;
    }
    const depthAngle = (parseFloat($("solid3dDepthAngle").value) || 35) * Math.PI / 180;
    const dvx = Dd * Math.cos(depthAngle), dvy = -Dd * Math.sin(depthAngle);

    const FTL = { x: 0, y: 0 }, FTR = { x: W, y: 0 }, FBR = { x: W, y: H }, FBL = { x: 0, y: H };
    const BTL = { x: FTL.x + dvx, y: FTL.y + dvy }, BTR = { x: FTR.x + dvx, y: FTR.y + dvy };
    const BBR = { x: FBR.x + dvx, y: FBR.y + dvy }, BBL = { x: FBL.x + dvx, y: FBL.y + dvy };

    const allPts = [FTL, FTR, FBR, FBL, BTL, BTR, BBR, BBL];
    const cx0 = allPts.reduce((a, p) => a + p.x, 0) / allPts.length;
    const cy0 = allPts.reduce((a, p) => a + p.y, 0) / allPts.length;
    const shiftX = 250 - cx0, shiftY = 250 - cy0;
    allPts.forEach(p => { p.x += shiftX; p.y += shiftY; });

    let bbMinX = Infinity, bbMinY = Infinity, bbMaxX = -Infinity, bbMaxY = -Infinity;
    function trackBB(x, y) {
      if (x < bbMinX) bbMinX = x; if (x > bbMaxX) bbMaxX = x;
      if (y < bbMinY) bbMinY = y; if (y > bbMaxY) bbMaxY = y;
    }
    allPts.forEach(p => trackBB(p.x, p.y));

    const solidEdges = [[FTL, FTR], [FTR, FBR], [FBR, FBL], [FBL, FTL], [FTL, BTL], [FTR, BTR], [FBR, BBR], [BTL, BTR], [BTR, BBR]];
    const hiddenEdges = [[FBL, BBL], [BBL, BTL], [BBL, BBR]];
    let innerSvg = "";
    for (const [p1, p2] of solidEdges) innerSvg += `  <line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="black" stroke-width="2.2"/>\n`;
    for (const [p1, p2] of hiddenEdges) innerSvg += `  <line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="black" stroke-width="1.3" stroke-dasharray="5,4"/>\n`;

    const showLabels3d = (type === "cube" ? $("cubeShowLabels") : $("prismShowLabels")).checked;
    if (lblW && showLabels3d) { const mx = (FBL.x + FBR.x) / 2, my = (FBL.y + FBR.y) / 2; labelSpecs.push({ x: mx, y: my + 26, text: lblW, fontSize }); }
    if (lblH && showLabels3d) { const mx = (FTL.x + FBL.x) / 2, my = (FTL.y + FBL.y) / 2; labelSpecs.push({ x: mx - 32, y: my, text: lblH, fontSize }); }
    if (lblD && showLabels3d) { const p = labelOffEdge(FTR, BTR, { x: 250, y: 250 }, 20); labelSpecs.push({ x: p.x, y: p.y, text: lblD, fontSize }); }

    const cropMargin = 16;
    const boxX = Math.floor(bbMinX - cropMargin), boxY = Math.floor(bbMinY - cropMargin);
    const boxW = Math.ceil(bbMaxX - bbMinX) + cropMargin * 2, boxH = Math.ceil(bbMaxY - bbMinY) + cropMargin * 2;
    srcBox = { x: boxX, y: boxY, w: boxW, h: boxH };
    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${boxX} ${boxY} ${boxW} ${boxH}" width="${boxW}" height="${boxH}">\n<rect width="100%" height="100%" fill="none"/>\n${innerSvg}</svg>`;

  } else if (type === "pyramid") {
    const fontSize = parseInt($("solid3dFontSize").value) || 24;
    const lblWidth = $("pyramidWidth").value, lblDepth = $("pyramidDepth").value, lblHeight = $("pyramidHeight").value;
    let baseLen = 210, Dd = 147, heightPx = 180;
    const parsedPyr = tryParseDims([lblWidth, lblDepth, lblHeight]);
    if (parsedPyr) [baseLen, Dd, heightPx] = scaleToPixels(parsedPyr, 16, 70, 240);
    const depthAngle = (parseFloat($("solid3dDepthAngle").value) || 35) * Math.PI / 180;
    const dvx = Dd * Math.cos(depthAngle), dvy = -Dd * Math.sin(depthAngle);

    const FBL = { x: 0, y: 0 }, FBR = { x: baseLen, y: 0 };
    const BBL = { x: FBL.x + dvx, y: FBL.y + dvy }, BBR = { x: FBR.x + dvx, y: FBR.y + dvy };
    const baseCenter = { x: (FBL.x + FBR.x + BBL.x + BBR.x) / 4, y: (FBL.y + FBR.y + BBL.y + BBR.y) / 4 };
    const apex = { x: baseCenter.x, y: baseCenter.y - heightPx };

    const allPts = [FBL, FBR, BBL, BBR, apex];
    const cx0 = allPts.reduce((a, p) => a + p.x, 0) / allPts.length;
    const cy0 = allPts.reduce((a, p) => a + p.y, 0) / allPts.length;
    const shiftX = 250 - cx0, shiftY = 250 - cy0;
    allPts.forEach(p => { p.x += shiftX; p.y += shiftY; });
    baseCenter.x += shiftX; baseCenter.y += shiftY;

    let bbMinX = Infinity, bbMinY = Infinity, bbMaxX = -Infinity, bbMaxY = -Infinity;
    function trackBB(x, y) {
      if (x < bbMinX) bbMinX = x; if (x > bbMaxX) bbMaxX = x;
      if (y < bbMinY) bbMinY = y; if (y > bbMaxY) bbMaxY = y;
    }
    allPts.forEach(p => trackBB(p.x, p.y));

    const solidEdges = [[FBL, FBR], [FBR, BBR], [FBR, apex], [FBL, apex], [BBR, apex]];
    const hiddenEdges = [[BBL, BBR], [BBL, FBL], [BBL, apex]];
    let innerSvg = "";
    for (const [p1, p2] of solidEdges) innerSvg += `  <line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="black" stroke-width="2.2"/>\n`;
    for (const [p1, p2] of hiddenEdges) innerSvg += `  <line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="black" stroke-width="1.3" stroke-dasharray="5,4"/>\n`;
    const showHeightPyr = $("pyramidShowHeight").checked;
    if (showHeightPyr) innerSvg += `  <line x1="${apex.x}" y1="${apex.y}" x2="${baseCenter.x}" y2="${baseCenter.y}" stroke="black" stroke-width="1.2" stroke-dasharray="4,3"/>\n`;

    const showLabelsPyr = $("pyramidShowLabels").checked;
    if (lblWidth && showLabelsPyr) { const mx = (FBL.x + FBR.x) / 2, my = (FBL.y + FBR.y) / 2; labelSpecs.push({ x: mx, y: my + 26, text: lblWidth, fontSize }); }
    if (lblDepth && showLabelsPyr) { const p = labelOffEdge(FBR, BBR, { x: 250, y: 250 }, 18); labelSpecs.push({ x: p.x, y: p.y, text: lblDepth, fontSize }); }
    // Placed on the left of the dashed height line, two-thirds of the way down, where the pyramid
    // is widest and the apex's rightward depth-offset leaves the least room on the right side —
    // this keeps long label text clear of both slant edges instead of sitting on top of one.
    if (showHeightPyr && lblHeight && showLabelsPyr) { labelSpecs.push({ x: apex.x - 45, y: apex.y + 0.62 * (baseCenter.y - apex.y), text: lblHeight, fontSize }); }

    const cropMargin = 16;
    const boxX = Math.floor(bbMinX - cropMargin), boxY = Math.floor(bbMinY - cropMargin);
    const boxW = Math.ceil(bbMaxX - bbMinX) + cropMargin * 2, boxH = Math.ceil(bbMaxY - bbMinY) + cropMargin * 2;
    srcBox = { x: boxX, y: boxY, w: boxW, h: boxH };
    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${boxX} ${boxY} ${boxW} ${boxH}" width="${boxW}" height="${boxH}">\n<rect width="100%" height="100%" fill="none"/>\n${innerSvg}</svg>`;

  } else if (type === "cylinder") {
    const fontSize = parseInt($("solid3dFontSize").value) || 24;
    const lblR = $("cylRadius").value, lblH = $("cylHeight").value;
    const showRadiusCyl = $("cylShowRadius").checked;
    const showDiameterCyl = $("cylShowDiameter").checked, lblDiameterCyl = $("cylDiameter").value;
    let rx = 120, heightPx = 180;
    const parsedCyl = tryParseDims([lblR, lblH]);
    if (parsedCyl) [rx, heightPx] = scaleToPixels(parsedCyl, 16, 50, 200);
    const ry = rx * ((parseFloat($("solid3dPerspective").value) || 33) / 100);
    const topCenter = { x: 250, y: 250 - heightPx / 2 };
    const botCenter = { x: 250, y: 250 + heightPx / 2 };

    let innerSvg = `  <ellipse cx="${topCenter.x}" cy="${topCenter.y}" rx="${rx}" ry="${ry}" fill="none" stroke="black" stroke-width="2.5"/>\n`;
    innerSvg += `  <path d="M ${botCenter.x - rx} ${botCenter.y} A ${rx} ${ry} 0 0 0 ${botCenter.x + rx} ${botCenter.y}" fill="none" stroke="black" stroke-width="2.5"/>\n`;
    innerSvg += `  <path d="M ${botCenter.x - rx} ${botCenter.y} A ${rx} ${ry} 0 0 1 ${botCenter.x + rx} ${botCenter.y}" fill="none" stroke="black" stroke-width="1.3" stroke-dasharray="5,4"/>\n`;
    innerSvg += `  <line x1="${topCenter.x - rx}" y1="${topCenter.y}" x2="${botCenter.x - rx}" y2="${botCenter.y}" stroke="black" stroke-width="2.5"/>\n`;
    innerSvg += `  <line x1="${topCenter.x + rx}" y1="${topCenter.y}" x2="${botCenter.x + rx}" y2="${botCenter.y}" stroke="black" stroke-width="2.5"/>\n`;

    // The radius (and optional diameter) indicator line's label depends on showLabelsCyl, but
    // whether the LINE itself is drawn at all is a separate toggle (showRadiusCyl/showDiameterCyl).
    const showLabelsCyl = $("cylShowLabels").checked;
    if (showRadiusCyl) {
      innerSvg += `  <line x1="${topCenter.x}" y1="${topCenter.y}" x2="${topCenter.x + rx}" y2="${topCenter.y}" stroke="black" stroke-width="1.8"/>\n`;
      if (lblR && showLabelsCyl) labelSpecs.push({ x: topCenter.x + rx / 2, y: topCenter.y - 14, text: lblR, fontSize });
    }
    if (lblH && showLabelsCyl) labelSpecs.push({ x: topCenter.x + rx + 22, y: (topCenter.y + botCenter.y) / 2, text: lblH, fontSize });

    if (showDiameterCyl) {
      innerSvg += `  <line x1="${topCenter.x - rx}" y1="${topCenter.y}" x2="${topCenter.x + rx}" y2="${topCenter.y}" stroke="black" stroke-width="1.8"/>\n`;
      // Placed above the ellipse (not alongside the radius label) so long label text never collides
      // with the radius label regardless of string length.
      if (lblDiameterCyl && showLabelsCyl) labelSpecs.push({ x: topCenter.x, y: topCenter.y - ry - fontSize * 0.6 - 10, text: lblDiameterCyl, fontSize });
    }

    const cropMargin = 16;
    const boxX = Math.floor(topCenter.x - rx - cropMargin), boxY = Math.floor(topCenter.y - ry - cropMargin);
    const boxW = Math.ceil((rx * 2)) + cropMargin * 2, boxH = Math.ceil(botCenter.y + ry - (topCenter.y - ry)) + cropMargin * 2;
    srcBox = { x: boxX, y: boxY, w: boxW, h: boxH };
    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${boxX} ${boxY} ${boxW} ${boxH}" width="${boxW}" height="${boxH}">\n<rect width="100%" height="100%" fill="none"/>\n${innerSvg}</svg>`;

  } else if (type === "cone") {
    const fontSize = parseInt($("solid3dFontSize").value) || 24;
    const lblR = $("coneRadius").value, lblH = $("coneHeight").value;
    const showRadiusCone = $("coneShowRadius").checked;
    const showSlant = $("coneShowSlant").checked, lblSlant = $("coneSlant").value;
    let rx = 120, heightPx = 190;
    const parsedCone = tryParseDims([lblR, lblH]);
    if (parsedCone) [rx, heightPx] = scaleToPixels(parsedCone, 16, 50, 200);
    const ry = rx * ((parseFloat($("solid3dPerspective").value) || 33) / 100);
    const apex = { x: 250, y: 250 - heightPx / 2 };
    const baseCenter = { x: 250, y: 250 + heightPx / 2 };
    const leftPt = { x: baseCenter.x - rx, y: baseCenter.y };
    const rightPt = { x: baseCenter.x + rx, y: baseCenter.y };

    let innerSvg = `  <line x1="${apex.x}" y1="${apex.y}" x2="${leftPt.x}" y2="${leftPt.y}" stroke="black" stroke-width="2.5"/>\n`;
    innerSvg += `  <line x1="${apex.x}" y1="${apex.y}" x2="${rightPt.x}" y2="${rightPt.y}" stroke="black" stroke-width="2.5"/>\n`;
    innerSvg += `  <path d="M ${leftPt.x} ${leftPt.y} A ${rx} ${ry} 0 0 0 ${rightPt.x} ${rightPt.y}" fill="none" stroke="black" stroke-width="2.5"/>\n`;
    innerSvg += `  <path d="M ${leftPt.x} ${leftPt.y} A ${rx} ${ry} 0 0 1 ${rightPt.x} ${rightPt.y}" fill="none" stroke="black" stroke-width="1.3" stroke-dasharray="5,4"/>\n`;
    const showHeightCone = $("coneShowHeight").checked;
    if (showHeightCone) innerSvg += `  <line x1="${apex.x}" y1="${apex.y}" x2="${baseCenter.x}" y2="${baseCenter.y}" stroke="black" stroke-width="1.2" stroke-dasharray="4,3"/>\n`;

    // Indicator lines' labels depend on showLabelsCone, but whether the radius LINE itself is
    // drawn at all is a separate toggle (showRadiusCone).
    const showLabelsCone = $("coneShowLabels").checked;
    if (showRadiusCone) {
      innerSvg += `  <line x1="${baseCenter.x}" y1="${baseCenter.y}" x2="${rightPt.x}" y2="${rightPt.y}" stroke="black" stroke-width="1.8"/>\n`;
      // r sits above its line (not below, where it would cross the base ellipse's front curve).
      if (lblR && showLabelsCone) labelSpecs.push({ x: (baseCenter.x + rightPt.x) / 2, y: baseCenter.y - 14, text: lblR, fontSize });
    }
    // h and the slant label are staggered at different heights/sides along their own lines so
    // long label text never collides, instead of both landing at the same mid-height row.
    if (showHeightCone && lblH && showLabelsCone) labelSpecs.push({ x: apex.x - 30, y: apex.y + 0.4 * heightPx, text: lblH, fontSize });
    if (showSlant && lblSlant && showLabelsCone) {
      // Placed perpendicular-outward from the slant line's own midpoint (the same convention used
      // for triangle/quadrilateral side labels) rather than a fixed fraction/offset along the line —
      // for a short, wide cone a fixed fraction can land close enough to the radius label below it
      // to collide; an outward normal from the midpoint keeps consistent clearance from both
      // neighbors regardless of the cone's proportions.
      const mx = (apex.x + rightPt.x) / 2, my = (apex.y + rightPt.y) / 2;
      const dx = rightPt.x - apex.x, dy = rightPt.y - apex.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
      let nx = -dy / len, ny = dx / len;
      const coneCenter = { x: apex.x, y: (apex.y + baseCenter.y) / 2 };
      if (nx * (mx - coneCenter.x) + ny * (my - coneCenter.y) < 0) { nx = -nx; ny = -ny; }
      labelSpecs.push({ x: mx + nx * 20, y: my + ny * 20, text: lblSlant, fontSize });
    }

    const cropMargin = 16;
    const boxX = Math.floor(leftPt.x - cropMargin), boxY = Math.floor(apex.y - cropMargin);
    const boxW = Math.ceil(rightPt.x - leftPt.x) + cropMargin * 2, boxH = Math.ceil((baseCenter.y + ry) - apex.y) + cropMargin * 2;
    srcBox = { x: boxX, y: boxY, w: boxW, h: boxH };
    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${boxX} ${boxY} ${boxW} ${boxH}" width="${boxW}" height="${boxH}">\n<rect width="100%" height="100%" fill="none"/>\n${innerSvg}</svg>`;

  } else if (type === "numberline") {
    const fontSize = parseInt($("nlFontSize").value) || 20;
    let minV = parseFloat($("nlMin").value), maxV = parseFloat($("nlMax").value);
    if (!Number.isFinite(minV)) minV = -4;
    if (!Number.isFinite(maxV)) maxV = 4;
    if (maxV <= minV) maxV = minV + 1;
    let step = Math.max(0.0001, parseFloat($("nlStep").value) || 1);
    const hlFromStr = $("nlHlFrom").value, hlToStr = $("nlHlTo").value;
    const hlFrom = hlFromStr === "" ? null : parseFloat(hlFromStr);
    const hlTo = hlToStr === "" ? null : parseFloat(hlToStr);
    const fromMode = $("nlFromCircle").value, toMode = $("nlToCircle").value;
    const fromOpen = fromMode === "open", toOpen = toMode === "open";
    const fromEnd = fromMode === "end", toEnd = toMode === "end";
    const showLabelsNl = $("nlShowLabels").checked;

    const pad = 50, lineY = 250, usableW = 500 - pad * 2;
    const mapX = v => pad + ((v - minV) / (maxV - minV)) * usableW;

    // Arrows extend a bit past the last labeled tick, as on a traditionally drawn number line.
    const arrowExt = Math.min(30, Math.max(15, usableW * 0.06));
    const x0 = mapX(minV) - arrowExt, x1e = mapX(maxV) + arrowExt;

    let innerSvg = "";

    let hlLeftX = null, hlRightX = null;
    if (fromEnd) hlLeftX = x0;
    else if (hlFrom != null && Number.isFinite(hlFrom)) hlLeftX = mapX(hlFrom);
    if (toEnd) hlRightX = x1e;
    else if (hlTo != null && Number.isFinite(hlTo)) hlRightX = mapX(hlTo);
    if (hlLeftX != null && hlRightX != null) {
      const xa = Math.min(hlLeftX, hlRightX), xb = Math.max(hlLeftX, hlRightX);
      innerSvg += `  <line x1="${xa}" y1="${lineY}" x2="${xb}" y2="${lineY}" stroke="#0F766E" stroke-width="5"/>\n`;
    }

    innerSvg += `  <line x1="${x0}" y1="${lineY}" x2="${x1e}" y2="${lineY}" stroke="black" stroke-width="2.5"/>\n`;
    innerSvg += `  <path d="M ${x0} ${lineY} L ${x0 + 12} ${lineY - 6} L ${x0 + 12} ${lineY + 6} Z" fill="black"/>\n`;
    innerSvg += `  <path d="M ${x1e} ${lineY} L ${x1e - 12} ${lineY - 6} L ${x1e - 12} ${lineY + 6} Z" fill="black"/>\n`;

    // Increment is user-settable; guard against pathologically fine steps on large ranges by
    // auto-coarsening the effective step rather than silently truncating ticks partway through the line.
    const EPS = 1e-9;
    const maxTicks = 400;
    const rawTickCount = Math.floor((maxV - minV) / step + EPS) + 1;
    if (rawTickCount > maxTicks) step = (maxV - minV) / (maxTicks - 1);
    const tickCount = Math.floor((maxV - minV) / step + EPS) + 1;

    // A wide range at interval 1 (e.g. -9 to 9) packs many tick labels into the fixed-width line —
    // at the user's chosen font size they'd overlap into an unreadable smear. First shrink the tick
    // label font to fit the space available between ticks; if even a small floor size still can't
    // fit, thin out which ticks get a text label (every tick mark still gets drawn) the way a ruler
    // labels every 5th/10th mark instead of every one.
    const pxPerTick = tickCount > 1 ? usableW / (tickCount - 1) : usableW;
    let maxLabelChars = 1;
    for (let i = 0; i < tickCount; i++) {
      maxLabelChars = Math.max(maxLabelChars, (Math.round((minV + i * step) * 1e6) / 1e6).toString().length);
    }
    const CHAR_W = 0.58; // approx glyph width as a fraction of font size, for bold digit-heavy labels
    const neededWidth = maxLabelChars * fontSize * CHAR_W + 10; // + a visual breathing-room gap
    let tickFontSize = fontSize, labelStep = 1;
    if (neededWidth > pxPerTick) {
      const MIN_FONT = 11;
      tickFontSize = Math.max(MIN_FONT, Math.floor(fontSize * pxPerTick / neededWidth));
      const neededAtFloor = maxLabelChars * tickFontSize * CHAR_W + 10;
      if (neededAtFloor > pxPerTick) labelStep = Math.max(1, Math.ceil(neededAtFloor / pxPerTick));
    }

    for (let i = 0; i < tickCount; i++) {
      const v = minV + i * step;
      const x = mapX(v);
      innerSvg += `  <line x1="${x}" y1="${lineY - 8}" x2="${x}" y2="${lineY + 8}" stroke="black" stroke-width="2"/>\n`;
      if (showLabelsNl && (i % labelStep === 0 || i === tickCount - 1)) {
        const label = (Math.round(v * 1e6) / 1e6).toString();
        labelSpecs.push({ x, y: lineY + 28, text: label, fontSize: tickFontSize });
      }
    }

    if (!fromEnd && hlFrom != null && Number.isFinite(hlFrom)) {
      const x = mapX(hlFrom);
      innerSvg += `  <circle cx="${x}" cy="${lineY}" r="7" fill="${fromOpen ? "white" : "black"}" stroke="black" stroke-width="2"/>\n`;
    }
    if (!toEnd && hlTo != null && Number.isFinite(hlTo)) {
      const x = mapX(hlTo);
      innerSvg += `  <circle cx="${x}" cy="${lineY}" r="7" fill="${toOpen ? "white" : "black"}" stroke="black" stroke-width="2"/>\n`;
    }

    const boxX = 0, boxY = lineY - 55, boxW = 500, boxH = 110;
    srcBox = { x: boxX, y: boxY, w: boxW, h: boxH };
    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${boxX} ${boxY} ${boxW} ${boxH}" width="${boxW}" height="${boxH}">\n<rect width="100%" height="100%" fill="none"/>\n${innerSvg}</svg>`;

  } else if (type === "fraction") {
    const style = $("fracStyle").value;
    const num = Math.max(0, parseInt($("fracNumerator").value) || 0);
    const den = Math.max(1, parseInt($("fracDenominator").value) || 1);
    const showLabel = $("fracShowLabel").checked;
    const fontSize = parseInt($("fracFontSize").value) || 24;
    const shadeColor = "rgba(15,118,110,0.35)";

    let innerSvg = "";
    let boxX, boxY, boxW, boxH;

    if (style === "circle") {
      const center = { x: 250, y: 250 }, R = 150;
      for (let i = 0; i < den; i++) {
        const a0 = -Math.PI / 2 + i * (2 * Math.PI / den);
        const a1 = -Math.PI / 2 + (i + 1) * (2 * Math.PI / den);
        const p0 = { x: center.x + R * Math.cos(a0), y: center.y + R * Math.sin(a0) };
        const p1 = { x: center.x + R * Math.cos(a1), y: center.y + R * Math.sin(a1) };
        const largeArc = (a1 - a0) > Math.PI ? 1 : 0;
        const fill = i < num ? shadeColor : "none";
        innerSvg += `  <path d="M ${center.x} ${center.y} L ${p0.x} ${p0.y} A ${R} ${R} 0 ${largeArc} 1 ${p1.x} ${p1.y} Z" fill="${fill}" stroke="black" stroke-width="2"/>\n`;
      }
      boxX = center.x - R - 16; boxY = center.y - R - 16; boxW = (R + 16) * 2; boxH = (R + 16) * 2;
    } else {
      const w = 360, h = 110, x0 = 70, y0 = 195;
      const segW = w / den;
      for (let i = 0; i < den; i++) {
        const fill = i < num ? shadeColor : "none";
        innerSvg += `  <rect x="${x0 + i * segW}" y="${y0}" width="${segW}" height="${h}" fill="${fill}" stroke="black" stroke-width="2"/>\n`;
      }
      boxX = x0 - 16; boxY = y0 - 16; boxW = w + 32; boxH = h + 32;
    }

    if (showLabel) {
      labelSpecs.push({ x: boxX + boxW / 2, y: boxY + boxH + 34, text: `${num}/${den}`, fontSize });
    }

    srcBox = { x: boxX, y: boxY, w: boxW, h: boxH };
    svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${boxX} ${boxY} ${boxW} ${boxH}" width="${boxW}" height="${boxH}">\n<rect width="100%" height="100%" fill="none"/>\n${innerSvg}</svg>`;
  }

  return { svgString, labelSpecs, srcBox, fnErrors };
}

function generateAndInsertMathShape() {
  const { svgString, labelSpecs, srcBox } = buildMathShapeSVG();
  $("shapeImporterDlg").close();
  beginShapePlacement(svgString, labelSpecs, srcBox);
}

function togglePlaneFnHelp(id = "planeFnHelp") {
  const help = $(id);
  help.style.display = help.style.display === "none" ? "block" : "none";
}

function toggleAxisLabelInputs(checkboxId, xLabelId, yLabelId) {
  const on = $(checkboxId).checked;
  $(xLabelId).disabled = !on;
  $(yLabelId).disabled = !on;
}
function eqRowHTML(expr, label, enabled) {
  const esc = s => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<div class="eq-row" style="display:flex; align-items:center; gap:6px; margin-top:6px;">
          <input type="checkbox" class="eq-enabled" ${enabled ? "checked" : ""} title="Show/hide this equation">
          <input type="text" class="eq-label" value="${esc(label)}" placeholder="label" style="width:64px; padding:4px 6px; border:1px solid var(--line); border-radius:6px; font-size:11.5px; box-sizing:border-box;">
          <input type="text" class="eq-expr" value="${esc(expr)}" placeholder="e.g. sin(x)" style="flex:1; padding:4px 6px; border:1px solid var(--line); border-radius:6px; font-family: ui-monospace, monospace; font-size:12px; box-sizing:border-box;">
          <button type="button" class="side-btn" style="width:auto; margin-top:0; padding:2px 8px;" onclick="removeEqRow(this)">✕</button>
        </div>`;
}
function addEqRow(listId, expr = "", label = "", enabled = true) {
  $(listId).insertAdjacentHTML("beforeend", eqRowHTML(expr, label, enabled));
  renderShapePreview();
}
function removeEqRow(btn) {
  btn.closest(".eq-row").remove();
  renderShapePreview();
}

// The real insertion places labels as independent canvas objects (never clipped by the shape
// image's own crop box), but the dialog preview overlays them INSIDE one combined SVG — so that
// SVG's viewBox has to be widened to actually contain them, or they render outside it and vanish.
function previewViewBoxFor(srcBox, labelSpecs) {
  let minX = srcBox.x, minY = srcBox.y, maxX = srcBox.x + srcBox.w, maxY = srcBox.y + srcBox.h;
  for (const s of labelSpecs) {
    const halfW = Math.max(20, String(s.text).length * s.fontSize * 0.32);
    const halfH = s.fontSize * 0.9;
    minX = Math.min(minX, s.x - halfW); maxX = Math.max(maxX, s.x + halfW);
    minY = Math.min(minY, s.y - halfH); maxY = Math.max(maxY, s.y + halfH);
  }
  return { x: Math.floor(minX), y: Math.floor(minY), w: Math.ceil(maxX - minX), h: Math.ceil(maxY - minY) };
}

function renderShapePreview() {
  let svgString, labelSpecs, srcBox, fnErrors;
  try {
    ({ svgString, labelSpecs, srcBox, fnErrors } = buildMathShapeSVG());
  } catch (err) {
    return; // fields mid-edit / momentarily invalid — keep showing the last good preview
  }
  let preview = svgString;
  if (labelSpecs.length) {
    const labelsMarkup = labelSpecs.map(s =>
      `  <text x="${s.x}" y="${s.y}" font-family="Arial, sans-serif" font-size="${s.fontSize}" font-weight="bold" text-anchor="middle">${escapeXml(s.text)}</text>\n`
    ).join("");
    preview = svgString.replace("</svg>", labelsMarkup + "</svg>");
    if (srcBox) {
      const box = previewViewBoxFor(srcBox, labelSpecs);
      preview = preview.replace(
        /viewBox="[^"]*" width="[^"]*" height="[^"]*"/,
        `viewBox="${box.x} ${box.y} ${box.w} ${box.h}" width="${box.w}" height="${box.h}"`
      );
    }
  }
  $("shapePreview").innerHTML = preview;

  const type = $("shapeTypeSelect").value;
  const FN_STATUS_IDS = { plane: "planeFnStatus", planeMath: "pmFnStatus", planeQ1: "q1FnStatus" };
  const statusId = FN_STATUS_IDS[type];
  Object.values(FN_STATUS_IDS).forEach(id => { if (id !== statusId) $(id).style.display = "none"; });
  const status = statusId ? $(statusId) : null;
  if (status && fnErrors && fnErrors.length) {
    status.textContent = fnErrors.join(" · ");
    status.style.display = "block";
  } else if (status) {
    status.style.display = "none";
  }
}
$("shapeImporterDlg").addEventListener("input", renderShapePreview);
$("shapeImporterDlg").addEventListener("change", renderShapePreview);
// Only checkbox commits are notebook-level prefs worth persisting — other fields
// (dimensions, labels, ...) are per-insert, not saved anywhere.
$("shapeImporterDlg").addEventListener("change", e => { if (e.target.matches('input[type="checkbox"]')) captureShapePrefsFromDialog(); });

/* ============================================================================
   Shared dialogs: confirm, and a page picker
   ========================================================================== */
