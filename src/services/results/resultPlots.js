import { virtualLayout } from "./resultMappings.js";

export function scalarAt(frame, row, quantity, component = "norm") {
  const offset = row * frame.stride + quantity.offset;
  const factor = quantity.factor ?? 1;
  if (quantity.components === 1) return frame.values[offset] * factor;
  if (component !== "norm") return frame.values[offset + Number(component)] * factor;
  return Math.hypot(...frame.values.subarray(offset, offset + 3)) * factor;
}

export function pointAt(frame, row) {
  return Array.from(frame.values.subarray(row * frame.stride, row * frame.stride + 3));
}

export function vectorScene(frames, quantity) {
  const vectors = [];
  let maximum = 0;
  let extent = 0;
  for (const { frame, record } of frames) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let row = 0; row < frame.count; row++) {
      const origin = pointAt(frame, row);
      const offset = row * frame.stride + quantity.offset;
      const vector = Array.from(frame.values.subarray(offset, offset + 3), value => value * (quantity.factor ?? 1));
      const magnitude = Math.hypot(...vector);
      if (![...origin, ...vector, magnitude].every(Number.isFinite)) continue;
      origin.forEach((value, axis) => { min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value); });
      maximum = Math.max(maximum, magnitude);
      const savedRow = row * (frame.every ?? 1);
      let ls = 0, az = 0, ps = 0;
      if (quantity.group === "regions") {
        ls = Math.floor(savedRow / (record.dp[0][0] * record.dp[1][0]));
      } else {
        const full = quantity.file === "HV" || quantity.file === "AV";
        const nAS = full || record.symKya === 0 ? record.symAs : 1;
        const nPS = full || record.symKyp === 0 ? record.symPs : 1;
        ps = savedRow % nPS;
        az = Math.floor(savedRow / nPS) % nAS;
        ls = Math.floor(savedRow / (nPS * nAS)) % record.symLs;
      }
      vectors.push({ origin, vector, magnitude, kind: "magnetization", characteristicSize: 1,
        source: { schemaId: quantity.group, recordIndex: record.recordIndex }, instance: { ls, as: az, ps } });
    }
    extent = Math.max(extent, Math.hypot(...max.map((v, i) => v - min[i])) || 0);
  }
  const size = extent > 0 ? extent / Math.max(4, Math.cbrt(vectors.length)) : 1;
  vectors.forEach(vector => { vector.characteristicSize = size; });
  return { vectors, maximumMagnitude: { current: 0, magnetization: maximum }, sceneDiagonal: extent };
}

// Observation region order is LS, dp[0], dp[1]. Never connect separate copies.
export function lineSeries(frame, record, quantity, component) {
  const [n1, n2] = record.dp.map(x => x[0]);
  if (n1 > 1 && n2 > 1) throw new Error("Выберите линейную область с одним направлением сетки");
  const length = Math.max(n1, n2);
  const copies = record.symLs;
  if (length * copies !== frame.count) throw new Error("Сетка линии не совпадает с данными");
  return Array.from({ length: copies }, (_, copy) => {
    let distance = 0, previous;
    const points = [];
    for (let i = 0; i < length; i++) {
      const row = copy * length + i;
      const coordinates = pointAt(frame, row);
      if (previous) distance += Math.hypot(...coordinates.map((v, j) => v - previous[j]));
      previous = coordinates;
      points.push({ x: distance, y: scalarAt(frame, row, quantity, component) });
    }
    return { label: `№${record.id} ${record.name || "Область"}${copies > 1 ? ` · LS ${copy + 1}` : ""}`, points };
  });
}

// The last spatial dimension is NOT contiguous: geometric copies are inner loops.
export function surfaceGrid(frame, record, quantity, component, axis, layer, copy) {
  const layout = virtualLayout(record);
  const direction = Number(axis);
  if (![0, 1, 2].includes(direction)) throw new Error("Неверное направление среза");
  if (!Number.isSafeInteger(layer) || layer < 0 || layer >= layout.dimensions[direction]
      || !Number.isSafeInteger(copy) || copy < 0 || copy >= layout.copyCount) throw new Error("Срез вне сетки");
  const other = [0, 1, 2].filter(i => i !== direction);
  const [width, height] = other.map(i => layout.dimensions[i]);
  if (width < 2 || height < 2) throw new Error("Для поверхности нужны хотя бы два узла по каждому направлению. Выберите другой срез.");
  if (width * height > 250_000) throw new Error("В срезе больше 250 000 узлов. Уменьшите сетку для просмотра поверхности.");
  const values = new Float64Array(width * height);
  const coordinates = new Float64Array(width * height * 3);
  for (let i = 0; i < width; i++) for (let j = 0; j < height; j++) {
    const indices = [0, 0, 0];
    indices[direction] = layer; indices[other[0]] = i; indices[other[1]] = j;
    const row = layout.index(...indices, copy);
    const k = i * height + j;
    values[k] = scalarAt(frame, row, quantity, component);
    coordinates.set(pointAt(frame, row), k * 3);
  }
  if (![...values].every(Number.isFinite)) throw new Error("Поверхность содержит нечисловые значения");
  return { width, height, values, coordinates, axes: other.map(i => `i${i + 1}`) };
}
