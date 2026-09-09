import { elementLayout, regionLayout, virtualLayout } from "./resultMappings.js";
import { fmmAxis, isAnisotropic } from "./fmmCharacteristics.js";

const number = value => Number.isFinite(value) ? String(Number(value.toPrecision(8))) : "—";
const xyzText = (frame, row) => `XYZ = (${pointAt(frame, row).map(number).join(", ")}) мм`;

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
        source: { schemaId: quantity.group, recordIndex: record.recordIndex, name: record.name }, instance: { ls, as: az, ps },
        quantity: quantity.label, unit: quantity.unit });
    }
    extent = Math.max(extent, Math.hypot(...max.map((v, i) => v - min[i])) || 0);
  }
  const size = extent > 0 ? extent / Math.max(4, Math.cbrt(vectors.length)) : 1;
  vectors.forEach(vector => { vector.characteristicSize = size; });
  return { vectors, maximumMagnitude: { current: 0, magnetization: maximum }, sceneDiagonal: extent };
}

// Every fixed index produces a separate curve, including each saved LS copy.
export function lineSeries(frame, record, quantity, component, direction = "i2") {
  const layout = regionLayout(record);
  if (frame.count !== layout.count || (frame.every ?? 1) !== 1) throw new Error("Сетка площадки не совпадает с данными");
  if (!["i1", "i2"].includes(direction)) throw new Error("Неверное направление линии");
  const alongFirst = direction === "i1";
  const length = alongFirst ? layout.n1 : layout.n2;
  const lines = alongFirst ? layout.n2 : layout.n1;
  const fixedName = alongFirst ? "i2" : "i1";
  const series = [];
  for (let ls = 0; ls < layout.copies; ls++) for (let fixed = 0; fixed < lines; fixed++) {
    const points = Array.from({ length }, (_, i) => {
      const row = layout.index(alongFirst ? i : fixed, alongFirst ? fixed : i, ls);
      return { x: i + 1, y: scalarAt(frame, row, quantity, component), row };
    });
    series.push({ label: `№${record.id} ${record.name || "Площадка"} · LS ${ls + 1} · ${fixedName}=${fixed + 1}`, points,
      tooltip: p => [`${direction}=${p.x}; ${fixedName}=${fixed + 1}; LS=${ls + 1}`,
        `${quantity.label} = ${number(p.y)} ${quantity.unit}`, xyzText(frame, p.row)] });
  }
  return series;
}

export function workingPointSeries(frame, record, projectedRecord = record) {
  const layout = elementLayout(record);
  if (frame.count !== layout.count || (frame.every ?? 1) !== 1) throw new Error("Сетка рабочих точек не совпадает с данными");
  const anisotropic = isAnisotropic(record);
  const axes = anisotropic ? Array.from({ length: layout.copies[0] }, (_, ls) => fmmAxis(projectedRecord, ls)) : null;
  const points = Array.from({ length: frame.count }, (_, row) => {
    const offset = row * frame.stride;
    const m = frame.values.subarray(offset + 3, offset + 6), h = frame.values.subarray(offset + 6, offset + 9);
    const ls = Math.floor(row / (layout.copies[1] * layout.copies[2])) % layout.copies[0];
    const dot = v => v[0] * axes[ls][0] + v[1] * axes[ls][1] + v[2] * axes[ls][2];
    const x = anisotropic ? dot(h) : Math.hypot(...h), y = anisotropic ? dot(m) : Math.hypot(...m);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Рабочие точки содержат нечисловые значения");
    return { x, y, row };
  });
  return { label: `№${record.id} ${record.name || "ФММ"} · рабочие точки`, points, showLine: false, pointRadius: 3,
    tooltip: p => {
      const idx = layout.indices(p.row);
      return [`H=${number(p.x)}; M=${number(p.y)} кА/м`, xyzText(frame, p.row),
        `i1=${idx.i1 + 1}; i2=${idx.i2 + 1}; i3=${idx.i3 + 1}; LS=${idx.ls + 1}; AS=${idx.as + 1}; PS=${idx.ps + 1}`];
    } };
}

// frame contains one contiguous LS block, not an entire virtual volume.
export function regionSurfaceGrid(frame, record, quantity, component, copy = 0) {
  const layout = regionLayout(record);
  if (!Number.isSafeInteger(copy) || copy < 0 || copy >= layout.copies) throw new Error("Образ LS вне сетки площадки");
  if (frame.count !== layout.planeCount || (frame.every ?? 1) !== 1) throw new Error("Сетка площадки не совпадает с данными");
  if (layout.n1 < 2 || layout.n2 < 2) throw new Error("Для поверхности нужны хотя бы два узла по каждому направлению. Эта область доступна на вкладке «Поле на линиях».");
  if (layout.planeCount > 250_000) throw new Error("На площадке больше 250 000 узлов. Уменьшите сетку для просмотра поверхности.");
  const values = new Float64Array(layout.planeCount), coordinates = new Float64Array(layout.planeCount * 3);
  for (let row = 0; row < layout.planeCount; row++) {
    values[row] = scalarAt(frame, row, quantity, component);
    coordinates.set(pointAt(frame, row), row * 3);
    if (!Number.isFinite(values[row])) throw new Error("Поверхность содержит нечисловые значения");
  }
  return { width: layout.n1, height: layout.n2, values, coordinates, axes: ["i1", "i2"], copy,
    title: `№${record.id} ${record.name || "Площадка"} · LS ${copy + 1}` };
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
