import { QUANTITIES } from "./resultMappings.js";
import { scalarAt } from "./resultPlots.js";
import { measurementCoils, readFluxHistories, fluxHistorySeries, readForceMomentHistory,
  forceMomentHistorySeries, readLossHistory, lossHistorySeries } from "./resultHistories.js";
import { checkReadRange } from "./resultLayout.js";
import { supportsElementLine, readElementLineProfile } from "./elementLinePlots.js";

export function plotChannels(task, extra = []) {
  const channels = [{ key: "time", label: "Время", unit: "с", kind: "time" }];
  for (const [key, quantity] of Object.entries(QUANTITIES)) {
    const metadata = task.metadata?.[quantity.file];
    if (metadata?.steps?.length && !metadata.error && metadata.pointCount > 0) channels.push({
      key: `field:${key}`, ...quantity, kind: "field", quantity, points: metadata.pointCount });
  }
  if (task.metadata?.PSI?.steps?.length) for (const record of measurementCoils(task)) {
    channels.push({ key: `flux:${record.id}`, label: `Потокосцепление · ${record.name}`, unit: "Вб", kind: "flux", coil: record.id });
  }
  if (task.metadata?.FM?.steps?.length) for (const kind of ["force", "moment"]) channels.push({
    key: kind, label: kind === "force" ? "Суммарная сила" : "Суммарный момент", unit: kind === "force" ? "Н" : "Н·м", kind, components: 3 });
  if (task.metadata?.Q?.steps?.length) channels.push({ key: "loss", label: "Суммарные потери на токи проводимости", unit: "Вт", kind: "loss" });
  for (const [index, source] of extra.entries()) for (const c of source.manifest.channels) channels.push({
    key: `extra:${index}:${c.column}`, label: `${source.manifest.model || "ОМ"} · ${c.label}`, unit: c.unit, kind: "extra", source, column: c.column });
  return channels;
}
export async function readPlotChannel(task, channel, spec = {}) {
  if (!channel) throw new Error("Выберите величину");
  if (channel.kind === "time") return Array.from({ length: task.general.countTimeSteps + 1 }, (_, step) => ({ step, time: step * task.general.timeStep, value: step * task.general.timeStep }));
  if (channel.kind === "extra") {
    const index = channel.source.table.header.indexOf(channel.column);
    return channel.source.table.rows.map(r => ({ step: r[0], time: r[1], value: r[index] }));
  }
  let points;
  if (channel.kind === "field") {
    const point = Number(spec.point ?? 1) - 1;
    if (!Number.isSafeInteger(point) || point < 0 || point >= channel.points) throw new Error(`Номер точки должен быть от 1 до ${channel.points}`);
    const metadata = task.metadata[channel.file];
    checkReadRange(0, metadata.steps.length, metadata.steps.length, metadata.header.stride);
    const history = await task.reader.history({ name: channel.file, point });
    if (history.stride !== metadata.header.stride || history.steps.length !== metadata.steps.length
      || history.steps.some((s, i) => s !== metadata.steps[i].index)) throw new Error("Несогласованная история полевого результата");
    const component = spec.component ?? "norm";
    if (!["norm", "0", "1", "2"].includes(component)) throw new Error("Неверная компонента величины");
    const frame = { stride: history.stride, values: history.values };
    points = history.steps.map((step, i) => ({ step, x: step * task.general.timeStep,
      y: scalarAt(frame, i, channel.quantity, component) }));
  } else if (channel.kind === "flux") {
    const [history] = await readFluxHistories({ task, selected: [channel.coil] });
    points = fluxHistorySeries(history, task.general.timeStep).points;
  } else if (["force", "moment"].includes(channel.kind)) {
    points = forceMomentHistorySeries(await readForceMomentHistory(task), task.general.timeStep, channel.kind, spec.component ?? "norm").points;
  } else if (channel.kind === "loss") points = lossHistorySeries(await readLossHistory(task), task.general.timeStep).points;
  else throw new Error("Неизвестный источник величины");
  if (points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error("Результат содержит нечисловые значения");
  return points.map(p => ({ step: p.step, time: p.x, value: p.y }));
}
export function pairPlotChannels(x, y) {
  const byStep = new Map(y.map(p => [p.step, p]));
  const points = [];
  for (const a of x) {
    const b = byStep.get(a.step);
    if (!b) continue;
    if (Math.abs(a.time - b.time) > 1e-12 * Math.max(Math.abs(a.time), Math.abs(b.time), 1e-12)) throw new Error("Времена X и Y не совпадают");
    points.push({ x: a.value, y: b.value, step: a.step, time: a.time });
  }
  if (!points.length) throw new Error("У выбранных величин нет общих сохранённых шагов");
  // Keep time order: sorting by X would destroy hysteresis and phase portraits.
  return points;
}

const sameTime = (a, b) => Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b), 1e-12);
export function plotPointAtStep(point, task, step) {
  return sameTime(point.time, step * task.general.timeStep);
}

export function pairPlotChannelsByTime(x, y) {
  const points = [];
  let j = 0;
  for (const a of x) {
    while (j < y.length && y[j].time < a.time && !sameTime(a.time, y[j].time)) j++;
    const b = y[j];
    if (b && sameTime(a.time, b.time)) {
      points.push({ x: a.value, y: b.value, step: a.step, sourceStep: b.step, time: a.time });
    }
  }
  if (!points.length) throw new Error("У заданий нет общих сохранённых моментов времени");
  return points;
}

export function plotChannelLabel(channel, spec = {}) {
  if (!channel) return "";
  const component = channel.components === 3 && !channel.productOffsets
    ? ` · ${spec.component === "norm" || spec.component == null ? "модуль" : "XYZ"[Number(spec.component)]}` : "";
  const point = channel.kind === "field" && !spec.profile ? ` · точка ${spec.point ?? 1}` : "";
  return `${channel.label}${component}${point}${channel.unit ? `, ${channel.unit}` : ""}`;
}

export function plotCurveLabel(curve, axis) {
  let label = plotChannelLabel(curve[`${axis}Channel`], curve[axis]);
  if (curve.xChannel.kind === "distance") label += axis === "x" ? ` · ${curve.x.lineLabel}`
    : ` · момент №${curve.y.step}, t=${curve.y.time} с`;
  return axis === "y" && curve.taskLabel ? `${curve.taskLabel} · ${label}` : label;
}

export function validatePlotCurve(curve, existing) {
  const spatial = curve.xChannel?.kind === "distance";
  if (spatial && !supportsElementLine(curve.yChannel)) throw new Error("Для отрезка выберите локальную величину в ЭО элемента.");
  for (const axis of ["x", "y"]) {
    const channel = curve[`${axis}Channel`], spec = curve[axis];
    if (!channel) throw new Error("Выберите X и Y.");
    if (!(spatial && axis === "y") && channel.kind === "field" && (!Number.isSafeInteger(Number(spec.point))
      || Number(spec.point) < 1 || Number(spec.point) > channel.points)) {
      throw new Error(`Ось ${axis.toUpperCase()}: номер точки должен быть от 1 до ${channel.points}.`);
    }
    const previous = existing?.[`${axis}Channel`];
    const identity = c => c.kind === "extra"
      ? JSON.stringify([c.kind, c.source?.manifest.model || "ОМ", c.column]) : c.key;
    if (previous && identity(previous) !== identity(channel)) {
      throw new Error(`Ось ${axis.toUpperCase()}: выбранная величина и величина активного графика не совпадают. Добавьте отдельный график.`);
    }
  }
  return curve;
}

// A failing curve does not remove the other curves. The caller also uses the
// combined diagnostic to stop movie capture of an incomplete plot.
export async function readPlotCurves(task, curves) {
  const cache = new Map();
  const frames = new Map();
  const readFrame = (sourceTask, request) => {
    let entries = frames.get(sourceTask);
    if (!entries) frames.set(sourceTask, entries = new Map());
    const key = JSON.stringify(request);
    if (!entries.has(key)) entries.set(key, sourceTask.reader.read(request));
    return entries.get(key);
  };
  const read = (sourceTask, channel, spec) => {
    let channels = cache.get(sourceTask);
    if (!channels) cache.set(sourceTask, channels = new Map());
    let entries = channels.get(channel);
    if (!entries) channels.set(channel, entries = new Map());
    const key = JSON.stringify(spec);
    if (!entries.has(key)) entries.set(key, readPlotChannel(sourceTask, channel, spec));
    return entries.get(key);
  };
  const results = await Promise.allSettled(curves.map(async curve => {
    const yTask = curve.yTask ?? task;
    const crossTask = yTask !== task;
    if (curve.xChannel.kind === "distance") {
      const profile = await readElementLineProfile(yTask, curve.yChannel, curve.x, curve.y, request => readFrame(yTask, request));
      const yLabel = plotCurveLabel(curve, "y");
      return { key: curve.id, label: `${yLabel} / ${profile.label}`, points: profile.points,
        profile,
        tooltip: point => [...profile.tooltip(point), yLabel] };
    }
    let points;
    if (crossTask && curve.xChannel.kind === "time") {
      const y = await read(yTask, curve.yChannel, curve.y);
      points = y.map(p => ({ x: p.time, y: p.value, step: p.step, sourceStep: p.step, time: p.time }));
    } else {
      const [x, y] = await Promise.all([read(task, curve.xChannel, curve.x), read(yTask, curve.yChannel, curve.y)]);
      points = crossTask ? pairPlotChannelsByTime(x, y) : pairPlotChannels(x, y);
    }
    const xLabel = plotCurveLabel(curve, "x"), yLabel = plotCurveLabel(curve, "y");
    return { key: curve.id, label: `${yLabel} / ${xLabel}`, points,
      tooltip: point => [`t = ${point.time} с; ${crossTask ? `шаг задания Y ${point.sourceStep}` : `шаг ${point.step}`}`, `${xLabel}: ${point.x}`, `${yLabel}: ${point.y}`] };
  }));
  return { series: results.filter(r => r.status === "fulfilled").map(r => r.value),
    error: results.flatMap((r, i) => r.status === "rejected" ? [`Кривая ${i + 1}: ${r.reason.message ?? r.reason}`] : []).join("; ") };
}

// Expand the selected dependency, keeping each component independently hideable.
export function expandPlotComponents(curve) {
  const vector = axis => curve[`${axis}Channel`]?.components === 3 && !curve[`${axis}Channel`]?.productOffsets;
  if (!vector("x") && !vector("y")) return [curve];
  return ["0", "1", "2"].map(component => ({
    ...curve, groupId: curve.id, id: `${curve.id}:${component}`,
    x: { ...curve.x, ...(vector("x") ? { component } : {}) },
    y: { ...curve.y, ...(vector("y") ? { component } : {}) },
  }));
}

export function isSingleTimePlot(task, curves) {
  return curves.length > 0 && curves.every(curve => curve.xChannel?.kind === "time"
    && (curve.yTask ?? task)?.general?.countTimeSteps === 0);
}

export function singleTimePlotRow(series) {
  if (!series.length || series.some(item => item.points.length !== 1)) return null;
  const time = series[0].points[0].time;
  if (series.some(item => !sameTime(item.points[0].time, time))) return null;
  return { time, values: series.map(item => item.points[0].y),
    comment: series.map(item => item.label).join("; ") };
}

// Each Add operation is a row; components share the originating group ID.
export function singleTimePlotTable(curves, series) {
  if (!singleTimePlotRow(series) || series.length !== curves.length) return null;
  const values = new Map(series.map(item => [item.key, item.points[0].y]));
  const columns = new Map(), groups = new Map();
  for (const curve of curves) {
    const component = curve.y.component ?? "scalar";
    if (!columns.has(component)) {
      const channel = curve.yChannel;
      const suffix = component === "scalar" ? "" : ` · ${"XYZ"[Number(component)]}`;
      columns.set(component, `${channel.label}${suffix}${channel.unit ? `, ${channel.unit}` : ""}`);
    }
    const id = curve.groupId ?? curve.id;
    if (!groups.has(id)) groups.set(id, { id, values: new Map(), point: curve.yChannel.kind === "field" ? curve.y.point ?? 1 : null, comment: curve.taskLabel || "" });
    groups.get(id).values.set(component, values.get(curve.id));
  }
  const keys = [...columns.keys()].sort();
  return { headers: keys.map(key => columns.get(key)), hasPoint: curves.some(curve => curve.yChannel.kind === "field"),
    rows: [...groups.values()].map(row => ({ ...row, values: keys.map(key => row.values.get(key) ?? "") })) };
}
