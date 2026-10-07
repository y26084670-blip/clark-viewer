import { mapResultObjects, QUANTITIES, sourceRecords } from "./resultMappings.js";
import { isFmm } from "./fmmCharacteristics.js";
import { resultCycleRange } from "./resultRanges.js";

const unavailable = (reason, state = "unavailable") => ({ available: false, reason, state });
const products = Object.freeze({ MHdot: ["M", "H"], JEdot: ["J", "E"] });

/** Optional HEADER/RANGES v1 is already decoded by Hdf5ResultFile. Never read
 * full time frames here, reinterpret units, or use a partial index as complete.
 */
export function globalResultRange(task, quantityKey, selected) {
  try {
    const quantity = QUANTITIES[quantityKey];
    if (!quantity || !selected?.length) return unavailable("Нет объектов для показа", "empty");
    const wanted = new Set(selected);
    const ids = sourceRecords(task, quantity.file).filter(record => wanted.has(record.id)
      && (!quantity.solvedOnly || record.targ === 0)
      && (!quantity.fmmOnly || isFmm(record))).map(record => record.id);
    if (!ids.length) return unavailable("Для этих объектов нет величины", "empty");
    const metadata = task.metadata?.[quantity.file];
    if (metadata?.error) return unavailable(metadata.error, "invalid");
    const ranges = metadata?.ranges;
    if (!ranges?.available) return unavailable(ranges?.reason ?? `${quantity.file}.h5: нет глобальных пределов`, ranges?.state);
    if (ranges.state !== "complete") return unavailable(`${quantity.file}.h5: неполный временной цикл`, "partial");
    const objects = mapResultObjects(task, quantity.file, metadata.header);
    if (objects.length !== ranges.objectIds.length
      || objects.some((object, i) => object.record.id !== ranges.objectIds[i])) {
      return unavailable(`${quantity.file}.h5: диапазоны не соответствуют объектам модели`, "invalid");
    }
    const { countTimeSteps: count, timeStep: dt } = task.general ?? {};
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isFinite(dt) || dt < 0 || (count > 0 && dt === 0)
      || ranges.stepIds.length !== count + 1 || ranges.times.length !== count + 1
      || ranges.stepIds.some((step, i) => step !== i || !Number.isFinite(ranges.times[i])
        || Math.abs(ranges.times[i] - i * dt) > 1e-12 * Math.max(1, Math.abs(i * dt)))) {
      return unavailable(`${quantity.file}.h5: временная сетка не соответствует заданию`, "stale");
    }
    const operands = products[quantityKey];
    let range;
    if (operands) {
      // Explicit owner policy: products of global MODULUS bounds, not the
      // stored exact signed dot-product channel. Actual scalar values stay intact.
      const [a, b] = operands.map(key => resultCycleRange(ranges, key, ids));
      if (!a.available || !b.available) return unavailable(a.reason ?? b.reason);
      if (a.minimum < 0 || b.minimum < 0) return unavailable("Отрицательная граница модуля", "invalid");
      const factor = quantity.factor ?? 1;
      range = { ...a, minimum: factor * a.minimum * b.minimum,
        maximum: factor * a.maximum * b.maximum, unit: quantity.unit,
        approximate: true, definition: `${operands[0]}min·${operands[1]}min … ${operands[0]}max·${operands[1]}max` };
    } else range = resultCycleRange(ranges, quantityKey, ids);
    if (!range.available) return range;
    if (!Number.isFinite(range.minimum) || !Number.isFinite(range.maximum) || range.minimum > range.maximum
      || (quantity.components === 3 && range.minimum < 0)) return unavailable("Некорректные глобальные пределы", "invalid");
    return Object.freeze({ ...range, objectIds: Object.freeze(ids), file: quantity.file });
  } catch (error) {
    return unavailable(`Глобальные пределы: ${error.message ?? error}`, "invalid");
  }
}

/** One checkbox enables a coherent mode for every active layer. An unavailable
 * active channel disables the mode instead of silently mixing local/global maps.
 * Streamlines may enter unselected elements, so their range covers all eligible
 * physical elements, not just the list used to display source arrows.
 */
export function resultGlobalScale(task, layers = [], seeds = []) {
  const layerRanges = {}, lineRanges = {}, active = [];
  for (const layer of layers) {
    if (layer.quantityKey === "none" || !layer.selected?.length) continue;
    const range = globalResultRange(task, layer.quantityKey, layer.selected);
    if (range.state === "empty") continue;
    layerRanges[layer.key] = range; active.push(range);
  }
  for (const key of new Set(seeds.map(seed => seed.quantityKey))) {
    const range = globalResultRange(task, key, (task?.elements ?? []).filter(record => record.targ !== 3).map(record => record.id));
    lineRanges[key] = range; active.push(range);
  }
  const failed = active.find(range => !range.available);
  const runs = new Set(active.filter(range => range.available).map(range => range.runId));
  const reason = failed?.reason ?? (runs.size > 1 ? "Файлы относятся к разным расчётам" : active.length ? "" : "Нет отображаемых величин");
  return { available: active.length > 0 && !failed && runs.size === 1,
    reason, layerRanges, lineRanges };
}

/** Attach display-only overrides: never mutate fields, extrema, provenance,
 * cached first-frame references or GPU payload arrays from the result reader.
 */
export function applyResultGlobalRange(layer, range) {
  if (!range?.available) return layer;
  const reference = layer.scene ? Object.freeze({ ...layer.vectorLengthReference,
    maximumMagnitude: Object.freeze({ current: range.maximum, magnetization: range.maximum }),
  }) : layer.vectorLengthReference;
  return { ...layer, displayRange: range, vectorLengthReference: reference };
}
