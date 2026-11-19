import { elementLayout, mapResultObjects, QUANTITIES, sourceRecords } from "./resultMappings.js";
import { isFmm } from "./fmmCharacteristics.js";
import { resultCycleRange } from "./resultRanges.js";
import { resultSymmetryCopies } from "./resultSymmetry.js";

const unavailable = (reason, state = "unavailable") => ({ available: false, reason, state });
const products = Object.freeze({ MHdot: ["M", "H"], JEdot: ["J", "E"] });

/** Optional HEADER/RANGES v1 is already decoded by Hdf5ResultFile. Never read
 * full time frames here, reinterpret units, or use a partial index as complete.
 */
export function globalResultRange(task, quantityKey, selected, { component = "norm", exact = false } = {}) {
  try {
    const quantity = QUANTITIES[quantityKey];
    if (!quantity || !selected?.length) return unavailable("Нет объектов для показа", "empty");
    const wanted = new Set(selected);
    const ids = sourceRecords(task, quantity.file).filter(record => wanted.has(record.id)
      && (!quantity.solvedOnly || record.targ === 0)
      && (!quantity.fmmOnly || isFmm(record))).map(record => record.id);
    if (!ids.length) return unavailable("Для этих объектов нет величины", "empty");
    // Independent J/E extrema do not determine extrema of the local ratio.
    // HEADER/RANGES v1 has no relative conductivity channel; use actual frame values.
    if (quantity.relativeConductivity) return unavailable("Для относительной электропроводности доступны пределы текущего кадра");
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
        || Math.abs(ranges.times[i] - i * dt) > 1e-6 * Math.max(1, Math.abs(i * dt)))) {
      return unavailable(`${quantity.file}.h5: временная сетка не соответствует заданию`, "stale");
    }
    const operands = products[quantityKey];
    let range;
    if (operands && !exact) {
      // Explicit owner policy: products of global MODULUS bounds, not the
      // stored exact signed dot-product channel. Actual scalar values stay intact.
      const [a, b] = operands.map(key => resultCycleRange(ranges, key, ids));
      if (!a.available || !b.available) return unavailable(a.reason ?? b.reason);
      if (a.minimum < 0 || b.minimum < 0) return unavailable("Отрицательная граница модуля", "invalid");
      const factor = quantity.factor ?? 1;
      range = { ...a, minimum: factor * a.minimum * b.minimum,
        maximum: factor * a.maximum * b.maximum, unit: quantity.unit,
        approximate: true, definition: `${operands[0]}min·${operands[1]}min … ${operands[0]}max·${operands[1]}max` };
    } else range = resultCycleRange(ranges, quantityKey, ids, { component });
    if (!range.available) return range;
    if (!Number.isFinite(range.minimum) || !Number.isFinite(range.maximum) || range.minimum > range.maximum
      || (quantity.components === 3 && component === "norm" && range.minimum < 0)) return unavailable("Некорректные глобальные пределы", "invalid");
    return Object.freeze({ ...range, objectIds: Object.freeze(ids), file: quantity.file });
  } catch (error) {
    return unavailable(`Глобальные пределы: ${error.message ?? error}`, "invalid");
  }
}

// Graph heights and palette colours need signed component bounds, rather than
// modulus bounds or products of separate extrema. Include generated symmetry
// images conservatively without reading any saved field frame.
function graphRecordRange(task, graph) {
  const quantity = QUANTITIES[graph.quantityKey];
  const record = task?.[graph.source?.schemaId]?.[graph.source?.recordIndex];
  if (!quantity || !record) return unavailable("Объект графика отсутствует", "invalid");
  const ranges = Array.from({ length: quantity.components }, (_, component) =>
    globalResultRange(task, graph.quantityKey, [record.id], { component, exact: true }));
  const failed = ranges.find(range => !range.available);
  if (failed) return failed;
  let minimum = Math.min(...ranges.map(r => r.minimum)), maximum = Math.max(...ranges.map(r => r.maximum));
  if (quantity.components === 3 && quantity.group === "elements") {
    const [local, axial, periodic] = elementLayout(record, ["HV", "AV"].includes(quantity.file)).copies;
    const general = task.general ?? {};
    const mirrors = [general.mirrorSymmetryX, general.mirrorSymmetryY].some(v => v === 0 || v === 1);
    if (mirrors || record.symAs > axial || record.symPs > periodic) {
      for (let ls = 0; ls < local; ls++) for (let az = 0; az < axial; az++) for (let ps = 0; ps < periodic; ps++) {
        for (const copy of resultSymmetryCopies(task, record, graph.quantityKey, { ls, as: az, ps })) {
          const m = copy.matrix, sign = copy.sign;
          if ([1, 2, 4, 6, 8, 9].some(i => Math.abs(m[i]) > 1e-12)) {
            // Component correlations and moving symmetry axes are not in the
            // index; the stored cycle modulus safely bounds every rotation.
            const norm = globalResultRange(task, graph.quantityKey, [record.id]);
            if (!norm.available) return norm;
            minimum = Math.min(minimum, -norm.maximum); maximum = Math.max(maximum, norm.maximum);
          } else for (let c = 0; c < 3; c++) {
            const coefficient = sign * m[c * 5];
            minimum = Math.min(minimum, coefficient * ranges[c].minimum, coefficient * ranges[c].maximum);
            maximum = Math.max(maximum, coefficient * ranges[c].minimum, coefficient * ranges[c].maximum);
          }
        }
      }
    }
  }
  return { ...ranges[0], minimum, maximum };
}

export function globalGraphRanges(task, graphs = []) {
  const graphRanges = {}, records = new Set(), active = [];
  for (const graph of graphs) {
    const key = JSON.stringify([graph.quantityKey, graph.source?.schemaId, graph.source?.recordIndex]);
    if (records.has(key)) continue;
    records.add(key);
    let range;
    try { range = graphRecordRange(task, graph); }
    catch (error) { range = unavailable(`Глобальные пределы графика: ${error.message ?? error}`, "invalid"); }
    active.push(range);
    if (!range.available) continue;
    const previous = graphRanges[graph.quantityKey];
    const minimum = Math.min(previous?.minimum ?? Infinity, range.minimum);
    const maximum = Math.max(previous?.maximum ?? -Infinity, range.maximum);
    graphRanges[graph.quantityKey] = Object.freeze({ ...range, minimum, maximum,
      referenceMaximum: Math.max(Math.abs(minimum), Math.abs(maximum)) || 1 });
  }
  return { graphRanges, active };
}

/** Display-only overrides: raw values, local extrema, reader references and
 * profiles retain their original identity. Toggling requires no HDF5 reads.
 */
export function applyGraphGlobalRange(graph, range) {
  return range?.available ? { ...graph, displayRange: range, referenceMaximum: range.referenceMaximum } : graph;
}

/** One checkbox enables a coherent mode for every active layer. An unavailable
 * active channel disables the mode instead of silently mixing local/global maps.
 * Streamlines may enter unselected elements, so their range covers all eligible
 * physical elements, not just the list used to display source arrows.
 */
export function resultGlobalScale(task, layers = [], seeds = [], graphs = []) {
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
  const { graphRanges, active: graphActive } = globalGraphRanges(task, graphs);
  active.push(...graphActive);
  const failed = active.find(range => !range.available);
  const runs = new Set(active.filter(range => range.available).map(range => range.runId));
  const reason = failed?.reason ?? (runs.size > 1 ? "Файлы относятся к разным расчётам" : active.length ? "" : "Нет отображаемых величин");
  return { available: active.length > 0 && !failed && runs.size === 1,
    reason, layerRanges, lineRanges, graphRanges };
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


export function workingPointGlobalMRange(task, selected) {
  const range = globalResultRange(task, "M", selected);
  if (!range.available) return range;
  const minimum = Math.min(0, range.minimum);
  const maximum = range.maximum;
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || !(minimum < maximum)) {
    return unavailable("Некорректные глобальные пределы M", "invalid");
  }
  return Object.freeze({ ...range, minimum, maximum });
}
