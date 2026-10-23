import { elementLayout, QUANTITIES } from "./resultMappings.js";
import { resultInstanceKey, resultSymmetryCopies } from "./resultSymmetry.js";
import { applyMatrix4ToPoint } from "../solver/rotation3d.js";

export function savedStreamlineSeed(task, seed) {
  const record = task?.elements?.[seed.source?.recordIndex], quantity = QUANTITIES[seed.quantityKey];
  if (!record || seed.source?.schemaId !== "elements" || quantity?.components !== 3 || quantity.group !== "elements") {
    throw new Error("Линия доступна для векторного поля в объёмном элементе");
  }
  const instance = seed.instance ?? {}, counts = [record.symLs ?? 1, record.symAs ?? 1, record.symPs ?? 1];
  const indices = ["ls", "as", "ps"].map(key => instance[key] ?? 0);
  if (indices.some((value, i) => !Number.isSafeInteger(value) || value < 0 || value >= counts[i])) {
    throw new Error("Образ линии вне геометрии элемента");
  }
  const full = quantity.file === "HV" || quantity.file === "AV";
  const saved = elementLayout(record, full).copies;
  // A displayed vector retains the saved node index. Missing AS/PS images and
  // mirrors refer to that same saved node; LS and independent images stay distinct.
  return { ...seed, instance: {
    ls: indices[0], as: saved[1] === 1 ? 0 : indices[1], ps: saved[2] === 1 ? 0 : indices[2],
  } };
}

function sameInstance(a, b) {
  return ["ls", "as", "ps", "mirrorX", "mirrorY"].every(key => (a?.[key] ?? 0) === (b?.[key] ?? 0));
}

function sameTransform(a, b) {
  if (a.sign !== b.sign) return false;
  return a.matrix.every((value, i) => {
    const scale = Math.max(1, Math.abs(value), Math.abs(b.matrix[i]));
    return Math.abs(value - b.matrix[i]) <= 1e-6 + 32 * 1e-6 * scale;
  });
}

function transformPositions(matrix, positions) {
  const result = new Float64Array(positions.length);
  for (let offset = 0; offset < positions.length; offset += 3) {
    result.set(applyMatrix4ToPoint(matrix, positions.subarray(offset, offset + 3)), offset);
  }
  return result;
}

/** Copy a whole curve only when every traversed element has the same spatial
 * transform AND field sign. Geometry alone cannot imply field symmetry, and
 * independently saved LS/AS/PS images must never inherit another image's curve.
 */
export function expandResultStreamline(task, line) {
  if (line.error || !line.start) return line;
  const cache = new Map();
  function copies(item) {
    const key = resultInstanceKey(item.source, item.instance);
    if (!cache.has(key)) {
      const record = task?.elements?.[item.source?.recordIndex];
      if (!record) throw new Error("Элемент линии отсутствует в модели");
      cache.set(key, resultSymmetryCopies(task, record, line.quantityKey, item.instance));
    }
    return cache.get(key);
  }
  const candidates = copies(line), paths = [...line.paths], starts = [
    { start: line.start, source: line.source, instance: line.instance, fieldSign: 1 },
  ];
  let incompatible = false;
  for (const candidate of candidates) {
    if (sameInstance(candidate.instance, line.instance)) continue;
    const targets = line.paths.map(path => copies(path).find(copy => sameTransform(copy, candidate)));
    if (targets.some(copy => !copy)) { incompatible = true; continue; }
    for (let i = 0; i < line.paths.length; i++) {
      const path = line.paths[i], target = targets[i];
      paths.push({ ...path, key: resultInstanceKey(path.source, target.instance), instance: target.instance,
        positions: transformPositions(candidate.matrix, path.positions),
        // Orthogonal transforms preserve the modulus. A negative field sign
        // swaps forward/backward branches without changing the two-sided locus.
        magnitudes: path.magnitudes, direction: (path.direction ?? 1) * candidate.sign, fieldSign: candidate.sign,
      });
    }
    starts.push({ start: applyMatrix4ToPoint(candidate.matrix, line.start), source: line.source,
      instance: candidate.instance, fieldSign: candidate.sign });
  }
  const notices = [];
  if (incompatible) notices.push("Показаны образы с общей симметрией поля во всех пройденных элементах.");
  if (starts.length === 1 && !notices.length) return line;
  return { ...line, paths, starts, notice: notices.join(" ") };
}
