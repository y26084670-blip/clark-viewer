import { eoCount, eoCountAll, epCount, kvFlags } from "../solver/kvDerived.js";

export const MU0 = 4 * Math.PI * 1e-7;
export const QUANTITIES = Object.freeze({
  M: { label: "Намагниченность M", unit: "кА/м", file: "MH", offset: 3, components: 3, group: "elements" },
  H: { label: "Напряжённость H", unit: "кА/м", file: "MH", offset: 6, components: 3, group: "elements", solvedOnly: true },
  J: { label: "Плотность тока J", unit: "А/мм²", file: "JE", offset: 3, components: 3, group: "elements" },
  E: { label: "Напряжённость E", unit: "В/м", file: "JE", offset: 6, components: 3, group: "elements", solvedOnly: true },
  Bs: { label: "Индукция B — области", unit: "Тл", file: "HS", offset: 3, components: 3, group: "regions" },
  As: { label: "Векторный потенциал A — области", unit: "Тл·м", file: "AS", offset: 3, components: 3, group: "regions", factor: MU0 },
  Bv: { label: "Индукция B — виртуальные элементы", unit: "Тл", file: "HV", offset: 3, components: 3, group: "elements" },
  Av: { label: "Векторный потенциал A — виртуальные элементы", unit: "Тл·м", file: "AV", offset: 3, components: 3, group: "elements", factor: MU0 },
  Q: { label: "Плотность потерь J·E", unit: "МВт/м³", file: "Q", offset: 3, components: 1, group: "elements", solvedOnly: true },
});

export function sourceRecords(task, file) {
  if (file === "HS" || file === "AS") return task.regions;
  if (file === "HV" || file === "AV") return task.elements.filter(e => e.targ === 3);
  if (file === "MH") return task.elements.filter(e => kvFlags(e).mv);
  if (file === "JE" || file === "Q") return task.elements.filter(e => kvFlags(e).rv);
  return [];
}

export function expectedPointCount(record, file) {
  if (file === "HS" || file === "AS") return epCount(record);
  return file === "HV" || file === "AV" ? eoCountAll(record) : eoCount(record);
}

export function mapResultObjects(task, file, header) {
  const records = sourceRecords(task, file);
  if (records.length !== header.numbs.length) {
    throw new Error(`${file}.h5: число объектов не совпадает с input3XX`);
  }
  return records.map((record, index) => {
    if (expectedPointCount(record, file) !== header.numbs[index]) {
      throw new Error(`${file}.h5: сетка объекта №${record.id} не совпадает с input3XX`);
    }
    return { record, start: header.inds1[index] - 1, count: header.numbs[index] };
  });
}

export function virtualLayout(record) {
  const dp = record.dp.map(x => Number(Array.isArray(x) ? x[0] : x));
  const dimensions = record.indAmp === 1 ? [dp[2], dp[1], dp[0]]
    : record.indAmp === 2 ? [dp[2], dp[0], dp[1]]
    : record.indAmp === 3 ? [dp[1], dp[0], dp[2]] : dp;
  const copies = [record.symLs ?? 1, record.symAs ?? 1, record.symPs ?? 1];
  if (![...dimensions, ...copies].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new Error("Недопустимая сетка виртуального элемента");
  }
  const copyCount = copies.reduce((a, b) => a * b, 1);
  return { dimensions, copies, copyCount,
    index: (i, j, k, copy = 0) => ((i * dimensions[1] + j) * dimensions[2] + k) * copyCount + copy };
}

function counts(values) {
  const result = values.map(value => Number(Array.isArray(value) ? value[0] : value));
  if (!result.every(n => Number.isSafeInteger(n) && n > 0)
      || !Number.isSafeInteger(result.reduce((a, b) => a * b, 1))) {
    throw new Error("Недопустимые размеры расчётной сетки");
  }
  return result;
}

// Saved source order: i1, i2, i3, LS, AS, PS (PS changes fastest).
export function elementLayout(record, full = false) {
  const dimensions = full ? virtualLayout(record).dimensions : counts(record.dp);
  if (dimensions.length !== 3) throw new Error("Для элемента нужны три направления сетки");
  const copies = counts([record.symLs ?? 1,
    full || record.symKya === 0 ? record.symAs ?? 1 : 1,
    full || record.symKyp === 0 ? record.symPs ?? 1 : 1]);
  const sizes = counts([...dimensions, ...copies]);
  const count = sizes.reduce((a, b) => a * b, 1);
  return { dimensions, copies, count, indices(row) {
    if (!Number.isSafeInteger(row) || row < 0 || row >= count) throw new Error("Узел вне сетки элемента");
    const result = {};
    for (let i = 5; i >= 0; i--) {
      result[["i1", "i2", "i3", "ls", "as", "ps"][i]] = row % sizes[i];
      row = Math.floor(row / sizes[i]);
    }
    return result;
  } };
}

// Saved observation order: LS, i1, i2. dp already counts nodes, not intervals.
export function regionLayout(record) {
  if (!Array.isArray(record.dp) || record.dp.length !== 2) throw new Error("Для площадки нужны два направления сетки");
  const [n1, n2, copies] = counts([...record.dp, record.symLs ?? 1]);
  const planeCount = n1 * n2;
  return { n1, n2, copies, planeCount, count: planeCount * copies,
    index(i1, i2, ls = 0) { return (ls * n1 + i1) * n2 + i2; } };
}
