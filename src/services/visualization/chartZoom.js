export function clampChartPoint(point, area) {
  return {
    x: Math.max(area.left, Math.min(area.right, point.x)),
    y: Math.max(area.top, Math.min(area.bottom, point.y)),
  };
}

// Chart.js supplies the scale conversion; only the visible plot rectangle can
// become a new range. Requiring both dimensions avoids zooming on an ordinary click.
export function chartZoomLimits(start, end, area, scales, minimumSize = 6) {
  if (![start?.x, start?.y, end?.x, end?.y, area?.left, area?.right, area?.top, area?.bottom]
    .every(Number.isFinite) || area.right <= area.left || area.bottom <= area.top) return null;
  const first = clampChartPoint(start, area), last = clampChartPoint(end, area);
  if (Math.abs(first.x - last.x) < minimumSize || Math.abs(first.y - last.y) < minimumSize) return null;
  const x = [scales.x.getValueForPixel(first.x), scales.x.getValueForPixel(last.x)];
  const y = [scales.y.getValueForPixel(first.y), scales.y.getValueForPixel(last.y)];
  if (![...x, ...y].every(Number.isFinite)) return null;
  const limits = { xMin: Math.min(...x), xMax: Math.max(...x), yMin: Math.min(...y), yMax: Math.max(...y) };
  return limits.xMin < limits.xMax && limits.yMin < limits.yMax ? limits : null;
}

// Translate the starting linear ranges, keeping their scale fixed throughout the
// gesture. Captured pointers may leave the canvas, so pan positions are not clamped.
export function chartPanLimits(start, end, area, limits) {
  if (![start?.x, start?.y, end?.x, end?.y, area?.left, area?.right, area?.top, area?.bottom,
    limits?.xMin, limits?.xMax, limits?.yMin, limits?.yMax].every(Number.isFinite)) return null;
  const width = area.right - area.left, height = area.bottom - area.top;
  const xSpan = limits.xMax - limits.xMin, ySpan = limits.yMax - limits.yMin;
  if (![width, height, xSpan, ySpan].every(value => Number.isFinite(value) && value > 0)) return null;
  const dx = (end.x - start.x) / width * xSpan;
  const dy = (end.y - start.y) / height * ySpan;
  const next = {
    xMin: limits.xMin - dx, xMax: limits.xMax - dx,
    yMin: limits.yMin + dy, yMax: limits.yMax + dy,
  };
  return Object.values(next).every(Number.isFinite) && next.xMin < next.xMax && next.yMin < next.yMax
    ? next : null;
}
