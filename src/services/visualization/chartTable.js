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

// Flat TSV for Excel: every image is a complete row, including the parent
// element. Missing sections stay empty and the original numeric precision is kept.
export function elementFaceCurrentsTableText(groups) {
  const headings = ["№ ШГ", "Название ШГ", "Разбиений D1", "Разбиений D2", "Разбиений D3", "LS", "AS", "PS",
    ...["D1", "D2", "D3"].flatMap(axis => ["нач.", "кон.", "сред."].map(slot => `${axis} ${slot}, А`)),
    "Баланс, А", "Σ |ΔI|, А"];
  const rows = [headings.join("\t")];
  for (const group of groups) {
    const name = String(group.name ?? "").replace(/[\t\r\n]+/g, " ");
    const label = /^\s*[=+@-]/.test(name) ? "'" + name : name;
    for (const { ls, as, ps, values } of group.images) {
      rows.push([group.id, label, ...group.dimensions, ls, as, ps,
        ...values.map(value => value === null ? "" : String(value).replace(".", ","))].join("\t"));
    }
  }
  return rows.join("\r\n");
}
