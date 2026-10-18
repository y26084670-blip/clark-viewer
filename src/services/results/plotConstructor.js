import { QUANTITIES } from "./resultMappings.js";
import { scalarAt } from "./resultPlots.js";
import { measurementCoils, readFluxHistories, fluxHistorySeries, readForceMomentHistory,
  forceMomentHistorySeries, readLossHistory, lossHistorySeries } from "./resultHistories.js";
import { checkReadRange } from "./resultLayout.js";

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
