import { toStorage } from "../model/arrayShape.js";
import { unpackKvVertices } from "../solver/geometryKv.js";
import { trilinearElementPoint } from "../visualization/geometryDiscretization.js";
import { elementLayout, mapResultObjects } from "./resultMappings.js";
import { checkReadRange } from "./resultLayout.js";

const subtract = (a, b) => a.map((value, i) => value - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);

// solver/core/01_common.jl: surf4 и volume6, та же нумерация вершин.
// Сдвиг начала координат уменьшает потерю точности для удалённого ШГ.
function volume6(vertices) {
  const q = vertices.map(vertex => subtract(vertex, vertices[0]));
  let volume = 0;
  for (const [i, j, k, l] of [[0, 1, 3, 2], [6, 7, 5, 4], [4, 5, 1, 0],
    [2, 3, 7, 6], [0, 2, 6, 4], [5, 7, 3, 1]]) {
    const a = cross(subtract(q[l], q[i]), subtract(q[j], q[i]));
    const b = cross(subtract(q[k], q[l]), subtract(q[j], q[l]));
    volume += dot(q[i], a.map((value, axis) => (value + b[axis]) / 2));
  }
  return volume / 3;
}

// Q.h5 содержит плотность J·E в МВт/м³. Для ватт: сумма Q*dV[мм³]*1e-3.
// Повторяет solver/vsolver/01_protocol.jl::_integrateQKV: только неизвестные
// токи, все сохранённые LS/AS/PS, затем отсутствующие симметричные образы.
export function lossIntegrationWeights(task, metadata) {
  const objects = mapResultObjects(task, "Q", metadata.header);
  const count = objects.reduce((sum, object) => sum + object.count, 0);
  if (count !== metadata.pointCount) throw new Error("Q.h5: число строк не совпадает с сеткой задания");
  checkReadRange(0, count, count, 1);
  const weights = new Float64Array(count);
  const mirrors = [task.general?.mirrorSymmetryX, task.general?.mirrorSymmetryY]
    .reduce((factor, setting) => factor * (setting === 0 || setting === 1 ? 2 : 1), 1);
  for (const { record, start } of objects) {
    // Сохраняем исходные смещения Q, в том числе после заданных источников тока.
    if (record.targ !== 0) continue;
    const layout = elementLayout(record);
    const geo = toStorage(record.geo, { nColumns: 3, order: "row" });
    const { vertices, err } = unpackKvVertices(geo, record.geoType);
    if (err || vertices.some(vertex => !vertex.every(Number.isFinite))) {
      throw new Error(`Потери: некорректная геометрия ШГ №${record.id}`);
    }
    const [n1, n2, n3] = layout.dimensions;
    const copies = layout.copies.reduce((a, b) => a * b, 1);
    const multiplicity = mirrors * ((record.symKya ?? 0) !== 0 ? record.symAs ?? 1 : 1)
      * ((record.symKyp ?? 0) !== 0 ? record.symPs ?? 1 : 1);
    let row = start;
    for (let i1 = 0; i1 < n1; i1++) for (let i2 = 0; i2 < n2; i2++) for (let i3 = 0; i3 < n3; i3++) {
      const cell = Array.from({ length: 8 }, (_, v) => trilinearElementPoint(vertices,
        (i1 + (v & 1)) / n1, (i2 + ((v >> 1) & 1)) / n2, (i3 + ((v >> 2) & 1)) / n3));
      const weight = volume6(cell) * multiplicity * 1e-3;
      if (!Number.isFinite(weight)) throw new Error(`Потери: объём ШГ №${record.id} выходит за числовой диапазон`);
      weights.fill(weight, row, row + copies);
      row += copies;
    }
  }
  return weights;
}
