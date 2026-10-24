import { kvFlags } from "../solver/kvDerived.js";
import { elementLayout, QUANTITIES } from "./resultMappings.js";
import { pointAt, scalarAt } from "./resultPlots.js";

const number = value => String(Number(value.toPrecision(8)));

export function workingPointRecords(task) {
  return (task?.elements ?? []).filter(record => record.targ === 0);
}

export function workingPointEligibleIds(records, mode) {
  const property = mode === "J" ? "rv" : "mv";
  return records.filter(record => record.targ === 0 && kvFlags(record)[property]).map(record => record.id);
}

// An inactive material group keeps its selection when the other group changes.
export function updateWorkingPointSelection(current, next, eligible) {
  const allowed = new Set(eligible);
  return [...new Set([...current.filter(id => !allowed.has(id)), ...next.filter(id => allowed.has(id))])];
}

export function currentWorkingPointSeries(frame, record) {
  const layout = elementLayout(record);
  if (frame.count !== layout.count || (frame.every ?? 1) !== 1
    || frame.stride < 9 || frame.values.length < frame.count * frame.stride) {
    throw new Error("Сетка рабочих точек J(E) не совпадает с данными");
  }
  const points = Array.from({ length: frame.count }, (_, row) => {
    const e = scalarAt(frame, row, QUANTITIES.E), j = scalarAt(frame, row, QUANTITIES.J);
    if (!Number.isFinite(e) || !Number.isFinite(j)) throw new Error("Рабочие точки J(E) содержат нечисловые значения");
    return { x: e, y: j, e, j, row };
  });
  return { label: `№${record.id} ${record.name || "Проводник"} · рабочие точки`, points, showLine: false, pointRadius: 3,
    tooltip: p => {
      const idx = layout.indices(p.row);
      return [`|E|=${number(p.e)} В/м; |J|=${number(p.j)} А/мм²`,
        ...(p.logE == null ? [] : [`log₁₀(|E| / (1 В/м))=${number(p.logE)}`]),
        ...(p.logJ == null ? [] : [`log₁₀(|J| / (1 А/мм²))=${number(p.logJ)}`]),
        `XYZ = (${pointAt(frame, p.row).map(number).join(", ")}) мм`,
        `i1=${idx.i1 + 1}; i2=${idx.i2 + 1}; i3=${idx.i3 + 1}; LS=${idx.ls + 1}; AS=${idx.as + 1}; PS=${idx.ps + 1}`];
    } };
}

export function currentWorkingPointView(series, logE = false, logJ = false) {
  let omittedZeros = 0;
  const displayed = series.map(item => {
    if (!logE && !logJ) return item;
    const points = [];
    for (const point of item.points) {
      const j = point.j ?? point.y;
      if ((logE && point.e === 0) || (logJ && j === 0)) { omittedZeros++; continue; }
      points.push({ ...point, x: logE ? Math.log10(point.e) : point.e, y: logJ ? Math.log10(j) : j,
        ...(logE ? { logE: Math.log10(point.e) } : {}), ...(logJ ? { logJ: Math.log10(j) } : {}) });
    }
    return { ...item, points };
  }).filter(item => item.points.length);
  return { series: displayed, omittedZeros, count: displayed.reduce((n, item) => n + item.points.length, 0) };
}
