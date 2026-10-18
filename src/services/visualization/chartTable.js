// Export all curves of one chart, including curves hidden through the legend.
// Only identical ordered grids share X. Never sort or interpolate XY loops.
export function chartTableText(series = [], xLabel = "X", yLabel = "Y") {
  const cell = value => String(value ?? "").replace(/[\t\r\n]+/g, " ");
  const row = values => values.map(cell).join("\t");
  if (!series.length) return row([xLabel, yLabel]);
  const names = series.map((curve, index) => `${index + 1}. ${curve.label || "Кривая"}`);
  const first = series[0].points;
  const sharedX = series.every(curve => curve.points.length === first.length
    && curve.points.every((point, index) => point.x === first[index].x
      && point.step === first[index].step && point.time === first[index].time));
  const rows = [row(sharedX
    ? [xLabel, ...names.map(name => `${name} · ${yLabel}`)]
    : names.flatMap(name => [`${name} · X: ${xLabel}`, `${name} · Y: ${yLabel}`]))];
  const count = series.reduce((maximum, curve) => Math.max(maximum, curve.points.length), 0);
  for (let index = 0; index < count; index++) {
    rows.push(row(sharedX
      ? [first[index].x, ...series.map(curve => curve.points[index].y)]
      : series.flatMap(curve => {
        const point = curve.points[index];
        return point ? [point.x, point.y] : ["", ""];
      })));
  }
  return rows.join("\n");
}
