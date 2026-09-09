import { eulerRotationMatrix4, multiplyMatrix4, rotationXMatrix4 } from "../solver/rotation3d.js";

const libraries = new WeakMap();
const vector3 = value => (value ?? [0, 0, 0]).map(x => Number(Array.isArray(x) ? x[0] : x));

export function isFmm(record) {
  return record.targ === 0 && (record.model ?? 0) === 0 && Boolean(record.xapName?.trim());
}

export function isAnisotropic(record) {
  return vector3(record.vkan).some(value => value !== 0);
}

export function parseFmmCharacteristic(text) {
  const data = JSON.parse(text.replace(/^\uFEFF/, ""));
  const table = data?.tabl;
  if (!Array.isArray(table) || table.length < 4 || table.length % 2 || !table.every(Number.isFinite)) {
    throw new Error("tabl должна содержать H и M: не менее двух пар конечных чисел");
  }
  const n = table.length / 2;
  const points = Array.from({ length: n }, (_, i) => ({ x: table[i], y: table[n + i] }));
  if (points.some((point, i) => i > 0 && point.x <= points[i - 1].x)) {
    throw new Error("Значения H в характеристике должны возрастать");
  }
  return points;
}

export function characteristicCurve(points, anisotropic) {
  // core/03_kv.jl: reproduce the negative branch actually used by the solver.
  const reflected = anisotropic && Math.abs(points[0].x) <= .001 && Math.abs(points[0].y) <= .001;
  return { reflected, points: reflected
    ? [...points.slice(1).reverse().map(p => ({ x: -p.x, y: -p.y })), ...points] : points };
}

export function loadFmmCharacteristic(task, name) {
  if (typeof name !== "string" || !name.trim() || /[\\/:\0]/.test(name) || name === "." || name === "..") {
    return Promise.reject(new Error("Некорректное имя характеристики ФММ"));
  }
  let cache = libraries.get(task);
  if (!cache) { cache = new Map(); libraries.set(task, cache); }
  if (!cache.has(name)) cache.set(name, (async () => {
    const input = await task.handle.getDirectoryHandle("input3XX");
    const library = await input.getDirectoryHandle("xapLibFMM");
    const file = await (await library.getFileHandle(`${name}.txt`)).getFile();
    return parseFmmCharacteristic(await file.text());
  })());
  return cache.get(name);
}

// projectedRecord already contains motion.angle(t) added to symVi.
// kanRotate rotates KAN by local symmetry only when auto=true; AS/PS do not
// enter this operation. Saved M/H are global and must not be rotated again.
export function fmmAxis(projectedRecord, ls = 0) {
  const vi = vector3(projectedRecord.symVi), vkan = vector3(projectedRecord.vkan);
  if (vi.length !== 3 || vkan.length !== 3 || ![...vi, ...vkan].every(Number.isFinite)) {
    throw new Error("Некорректные углы оси анизотропии");
  }
  let rotation = eulerRotationMatrix4(...vi);
  if (projectedRecord.auto ?? true) rotation = multiplyMatrix4(rotation, rotationXMatrix4((projectedRecord.symYl ?? 0) * ls));
  rotation = multiplyMatrix4(rotation, eulerRotationMatrix4(...vkan));
  return [rotation[0], rotation[1], rotation[2]];
}
