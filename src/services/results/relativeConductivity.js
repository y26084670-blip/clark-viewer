import { assignedHtsElements } from "./resultMappings.js";
import { loadCurrentMaterial } from "./currentCharacteristics.js";
import { readObjectFrames, resultObjects } from "./resultRequests.js";

export async function relativeConductivityBases(task) {
  const names = [...new Set(assignedHtsElements(task).map(record => record.xapName))];
  if (!names.length) throw new Error("Карта σ/j_gmin недоступна: в задании нет материалов ВТСП");
  // Include all assigned HTS materials, independently of the display selection.
  // A missing/invalid material must not silently change the common minimum.
  const results = await Promise.allSettled(names.map(async name => [name, (await loadCurrentMaterial(task, name)).j_gmin]));
  const failed = results.find(result => result.status === "rejected");
  if (failed) throw new Error(`Карта σ/j_gmin: не удалось загрузить материалы ВТСП — ${failed.reason?.message ?? failed.reason}`);
  const materials = new Map(results.map(result => result.value));
  return { materials, minimum: Math.min(...materials.values()) };
}

export function relativeConductivityValues(frame, record, bases) {
  const model = record.model ?? 0;
  if (model !== 0 && model !== 2) throw new Error(`Электропроводность: модель материала ${model} не поддерживается`);
  const gmin = model === 2 ? bases.materials.get(record.xapName) : bases.minimum;
  if (!(Number.isFinite(gmin) && gmin > 0)) throw new Error("Недопустимое j_gmin для карты электропроводности");
  const values = new Float64Array(frame.count);
  if (model === 0) {
    const value = record.rv / gmin;
    if (!(Number.isFinite(record.rv) && record.rv > 0 && Number.isFinite(value))) throw new Error("Недопустимая постоянная электропроводность");
    // Both conductivities are in MS/m. This value is known even at J=E=0.
    return values.fill(value);
  }
  for (let row = 0; row < frame.count; row++) {
    const vectors = frame.values.subarray(row * frame.stride + 3, row * frame.stride + 9);
    if (vectors.length !== 6 || !vectors.every(Number.isFinite)) throw new Error("Электропроводность: J или E содержит нечисловые значения");
    const j = Math.hypot(vectors[0], vectors[1], vectors[2]), e = Math.hypot(vectors[3], vectors[4], vectors[5]);
    if (![j, e].every(Number.isFinite)) throw new Error("Электропроводность: модуль J или E вне числового диапазона");
    // JE: J in A/mm², E in V/m => J/E in MS/m, the same units as j_gmin.
    // E=0 has no finite ratio. Keep holes in the full grid, never use a fake zero.
    const value = e === 0 ? NaN : j / e / gmin;
    if (e !== 0 && !Number.isFinite(value)) throw new Error("Относительная электропроводность вне числового диапазона");
    values[row] = value;
  }
  return values;
}

export async function readRelativeConductivityFrames(request) {
  const bases = await relativeConductivityBases(request.task);
  const frames = await readObjectFrames(request);
  return frames.map(entry => ({ ...entry, frame: { ...entry.frame,
    relativeConductivityValues: relativeConductivityValues(entry.frame, entry.record, bases) } }));
}

// Store only completed per-element extrema. Selection changes can reuse them
// without retaining any time frames or publishing an interrupted scan.
const cycleRanges = new WeakMap();

export async function relativeConductivityCycleRange(task, selected, signal) {
  const meta = task.metadata?.JE;
  const steps = meta?.steps ?? [];
  if (!steps.length || steps.length !== task.general.countTimeSteps + 1
    || steps.some((step, i) => step.index !== i)) throw new Error("JE.h5: сохранены не все шаги расчёта");
  const selectedIds = new Set(selected);
  const objects = resultObjects(task, "sigmaRelative").filter(obj => selectedIds.has(obj.record.id));
  const bases = await relativeConductivityBases(task);
  let cached = cycleRanges.get(task);
  if (cached?.metadata !== meta) {
    cached = { metadata: meta, byObject: new Map() };
    cycleRanges.set(task, cached);
  }
  let minimum = Infinity, maximum = -Infinity;
  for (const { record, start, count } of objects) {
    signal?.throwIfAborted();
    let extrema = cached.byObject.get(record.id);
    if (!extrema) {
      let low = Infinity, high = -Infinity;
      if (record.model === 2) {
        for (const { index } of steps) {
          for (let offset = 0; offset < count; offset += 16384) {
            signal?.throwIfAborted();
            const frame = await task.reader.read({ name: "JE", step: index, start: start + offset,
              count: Math.min(count - offset, 16384), every: 1 });
            for (const value of relativeConductivityValues(frame, record, bases)) {
              if (Number.isNaN(value)) continue; // E=0 at this node.
              low = Math.min(low, value);
              high = Math.max(high, value);
            }
          }
        }
      } else if (count) {
        [low] = relativeConductivityValues({ count: 1 }, record, bases);
        high = low;
      }
      signal?.throwIfAborted();
      extrema = { minimum: low, maximum: high };
      cached.byObject.set(record.id, extrema);
    }
    minimum = Math.min(minimum, extrema.minimum);
    maximum = Math.max(maximum, extrema.maximum);
  }
  if (!(minimum <= maximum)) throw new Error("В выбранных элементах нет конечных значений σ/j_gmin за цикл");
  return { available: true, minimum, maximum, runId: meta.ranges?.runId, unit: "отн. ед.", state: "complete" };
}
