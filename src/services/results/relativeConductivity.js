import { assignedHtsElements } from "./resultMappings.js";
import { loadCurrentMaterial } from "./currentCharacteristics.js";
import { readObjectFrames } from "./resultRequests.js";

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
