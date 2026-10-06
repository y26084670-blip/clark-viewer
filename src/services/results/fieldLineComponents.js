import { lineSeries } from "./resultPlots.js";
import { mapResultObjects, QUANTITIES } from "./resultMappings.js";
import { resultCycleRange } from "./resultRanges.js";

export const FIELD_LINE_COMPONENTS = Object.freeze([
  Object.freeze({ value: "norm", label: "Модуль" }),
  Object.freeze({ value: "0", label: "X" }),
  Object.freeze({ value: "1", label: "Y" }),
  Object.freeze({ value: "2", label: "Z" }),
]);

/** Canonical ordering makes checkbox order irrelevant to curves and frame identity. */
export function normalizeFieldLineComponents(values = ["norm"]) {
  if (!Array.isArray(values)) throw new Error("Ожидался список компонент поля");
  const selected = new Set(values.map(String));
  if ([...selected].some(value => !FIELD_LINE_COMPONENTS.some(item => item.value === value))) {
    throw new Error("Неизвестная компонента поля");
  }
  return FIELD_LINE_COMPONENTS.filter(item => selected.has(item.value)).map(item => item.value);
}

export function fieldLineComponentSymbol(quantityKey, component) {
  const symbol = quantityKey === "As" ? "A" : quantityKey === "Bs" ? "B" : quantityKey;
  return component === "norm" ? `|${symbol}|` : `${symbol}${["x", "y", "z"][Number(component)]}`;
}

/** All curves are derived from the same saved vector frame, never separate reads. */
export function lineComponentSeries(frame, record, quantityKey, components, direction, options) {
  const quantity = QUANTITIES[quantityKey];
  return normalizeFieldLineComponents(components).flatMap(component => {
    const symbol = fieldLineComponentSymbol(quantityKey, component);
    return lineSeries(frame, record, { ...quantity, label: symbol }, component, direction, options)
      .map(series => ({ ...series, component, label: `${series.label} · ${symbol}` }));
  });
}

const unavailable = reason => ({ available: false, reason });

/** Full-cycle Y union for selected MODEL regions and checked channels.
 * HEADER/RANGES values are already in display units: never multiply by mu0 here.
 * Ranges cover all nodes/local images of each selected region, not just one line.
 */
export function fieldLineCycleRange(task, quantityKey, selected, components) {
  try {
    const choices = normalizeFieldLineComponents(components);
    if (!choices.length) return unavailable("Выберите компоненты");
    if (!selected?.length) return unavailable("Выберите площадки");
    const quantity = QUANTITIES[quantityKey];
    if (!quantity || !["HS", "AS"].includes(quantity.file)) return unavailable("Нет диапазона для этой величины");
    const metadata = task?.metadata?.[quantity.file];
    if (metadata?.error) return unavailable(metadata.error);
    const ranges = metadata?.ranges;
    if (!ranges?.available || ranges.state !== "complete") {
      return unavailable(ranges?.reason ?? (ranges?.state === "partial"
        ? "Диапазоны охватывают не весь расчёт" : "В HDF5 нет готовых глобальных пределов"));
    }
    const objects = mapResultObjects(task, quantity.file, metadata.header);
    if (objects.length !== ranges.objectIds.length
      || objects.some((object, i) => object.record.id !== ranges.objectIds[i])) {
      return unavailable("Идентификаторы диапазонов не совпадают с моделью");
    }
    const intervals = task.general?.countTimeSteps, timeStep = task.general?.timeStep;
    if (!Number.isSafeInteger(intervals) || intervals < 0 || !Number.isFinite(timeStep) || timeStep < 0
      || (intervals > 0 && timeStep === 0) || ranges.stepIds.length !== intervals + 1
      || ranges.times.length !== ranges.stepIds.length
      || ranges.stepIds.some((step, i) => step !== i || !Number.isFinite(ranges.times[i])
        || Math.abs(ranges.times[i] - i * timeStep) > 1e-12 * Math.max(1, Math.abs(i * timeStep)))) {
      return unavailable("Временная сетка диапазонов не совпадает с заданием");
    }
    const channels = choices.map(component => resultCycleRange(ranges, quantityKey, selected, { component }));
    const failed = channels.find(range => !range.available);
    if (failed) return unavailable(failed.reason);
    const minimum = Math.min(...channels.map(range => range.minimum));
    const maximum = Math.max(...channels.map(range => range.maximum));
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum > maximum) {
      return unavailable("Некорректные глобальные пределы");
    }
    return { available: true, minimum, maximum, runId: ranges.runId,
      revision: ranges.revision, stepCount: ranges.stepIds.length };
  } catch (error) {
    // An optional index must not stop ordinary field viewing or old-file support.
    return unavailable(error.message ?? String(error));
  }
}

/** A deterministic 5% margin, including constant/zero fields, independent of time. */
export function fieldLineChartRange(range) {
  if (!range?.available) return null;
  const { minimum, maximum } = range;
  const span = maximum - minimum;
  const padding = span > 0 ? span * 0.05 : (Math.abs(minimum) || 1) * 0.05;
  const low = minimum - padding, high = maximum + padding;
  if (!Number.isFinite(low) || !Number.isFinite(high) || !(low < high)) {
    return Number.isFinite(minimum) && Number.isFinite(maximum) && minimum < maximum
      ? { minimum, maximum } : null;
  }
  return { minimum: low, maximum: high };
}
