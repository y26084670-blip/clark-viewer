import { toStorage } from "../model/arrayShape.js";
import { unpackKvVertices } from "../solver/geometryKv.js";
import { applyMatrix4ToPoint } from "../solver/rotation3d.js";
import { expandElementSymmetry } from "../solver/symmetryExpansion.js";
import { trilinearElementPoint } from "../visualization/geometryDiscretization.js";
import { buildGeometryTimeModel } from "../visualization/geometryTimeModel.js";

// MH/JE are values at elementary-volume centres, not at element vertices.
// A one-cell-thick element therefore still has a physical volume. Only known
// task geometry may supply its boundary; observation planes get no thickness.
export function attachResultVolumeSupport(domains, { task, quantity, time }) {
  if (!["MH", "JE"].includes(quantity.file)) return domains;
  const projected = buildGeometryTimeModel(task, task.moves, time);
  const contexts = new Map();
  return domains.map(domain => {
    const recordIndex = domain.source.recordIndex;
    if (!contexts.has(recordIndex)) {
      const record = projected.model.elements?.[recordIndex];
      let context = null;
      if (record && !projected.diagnostics.some(item => item.schemaId === "elements" && item.recordIndex === recordIndex)) {
        const geo = Array.isArray(record.geo?.[0]) ? toStorage(record.geo, { nColumns: 3, order: "row" }) : record.geo;
        if (geo && [0, 1, 2, 3, 4].includes(record.geoType)) {
          const { vertices, err } = unpackKvVertices(geo, record.geoType);
          if (!err && vertices.every(vertex => vertex.every(Number.isFinite))) {
            // Only saved images: reduced physical AS/PS are not present in HDF5.
            const images = domains.filter(item => item.source.recordIndex === recordIndex);
            const copies = ["ls", "as", "ps"].map(key => Math.max(...images.map(item => item.instance[key])) + 1);
            context = { vertices, instances: expandElementSymmetry({ ...record,
              symLs: copies[0], symAs: copies[1], symPs: copies[2] }) };
          }
        }
      }
      contexts.set(recordIndex, context);
    }
    const context = contexts.get(recordIndex);
    const image = context?.instances.find(item => ["ls", "as", "ps"].every(key => item[key] === domain.instance[key]));
    const support = image ? { vertices: context.vertices.map(point => applyMatrix4ToPoint(image.matrix, point)) } : null;
    const record = projected.model.elements?.[recordIndex];
    const supportLabel = `Элемент №${record?.id ?? recordIndex + 1} (LS ${domain.instance.ls + 1}, AS ${domain.instance.as + 1}, PS ${domain.instance.ps + 1})`;
    return { ...domain, support, supportExpected: true, supportLabel };
  });
}

// At most (n1+2)(n2+2)(n3+2) <= 9*N+18 support nodes for N>=1;
// the reader bounds N at 100000. Expansion and validation run in the worker.
export const VOLUME_MAX_SUPPORT_NODES = 900_018;

/** Preserve the exact saved centres. Add physical boundary layers and extend
 * their nearest centre value constantly to the boundary. A singleton axis has
 * no measured derivative, so it must not acquire an invented gradient.
 */
export function extendResultVolumeSupport(domain) {
  if (!domain.supportExpected) return { domain, reason: "" };
  const vertices = domain.support?.vertices;
  if (!vertices || vertices.length !== 8 || !vertices.every(point => point.length === 3 && point.every(Number.isFinite))) {
    return { domain, reason: "границы ШГ недоступны" };
  }
  const [n1, n2, n3] = domain.dimensions;
  const dimensions = domain.dimensions.map(n => n + 2);
  const count = dimensions.reduce((a, b) => a * b, 1);
  if (!Number.isSafeInteger(count) || count > VOLUME_MAX_SUPPORT_NODES) return { domain, reason: "превышен предел граничной сетки" };
  const spans = [0, 1, 2].map(axis => Math.max(...vertices.map(point => point[axis])) - Math.min(...vertices.map(point => point[axis])));
  const extent = Math.hypot(...spans);
  const eps = domain.coordinateBytes === 4 ? 2 ** -23 : Number.EPSILON;
  // The cap prevents an enormous global offset from accepting the wrong task,
  // even when a low-precision file can no longer resolve individual cells.
  let minimumCellSpan = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const low = [0.5, 0.5, 0.5], high = [...low];
    low[axis] = 0; high[axis] = 1;
    const a = trilinearElementPoint(vertices, ...low), b = trilinearElementPoint(vertices, ...high);
    minimumCellSpan = Math.min(minimumCellSpan, Math.hypot(...b.map((v, i) => v - a[i])) / domain.dimensions[axis]);
  }
  if (!(minimumCellSpan > 0)) return { domain, reason: "вырожденная геометрия ШГ" };
  for (let i = 0; i < n1; i++) for (let j = 0; j < n2; j++) for (let k = 0; k < n3; k++) {
    const expected = trilinearElementPoint(vertices, (i + 0.5) / n1, (j + 0.5) / n2, (k + 0.5) / n3);
    const offset = ((i * n2 + j) * n3 + k) * 3;
    for (let axis = 0; axis < 3; axis++) {
      const saved = domain.positions[offset + axis];
      const tolerance = Math.min(minimumCellSpan * 1e-3,
        8 * eps * Math.max(Math.abs(expected[axis]), Math.abs(saved), extent) + extent * 1e-10);
      if (!Number.isFinite(saved) || Math.abs(saved - expected[axis]) > tolerance) {
        return { domain, reason: "координаты HDF5 не совпадают с текущей геометрией ШГ" };
      }
    }
  }
  const parameters = domain.dimensions.map(n => Array.from({ length: n + 2 }, (_, i) => i === 0 ? 0 : i === n + 1 ? 1 : (i - 0.5) / n));
  const positions = new Float64Array(count * 3), values = new Float64Array(count);
  for (let i = 0; i < dimensions[0]; i++) for (let j = 0; j < dimensions[1]; j++) for (let k = 0; k < dimensions[2]; k++) {
    const indices = [i, j, k];
    const saved = indices.map((index, axis) => Math.max(0, Math.min(domain.dimensions[axis] - 1, index - 1)));
    const source = (saved[0] * n2 + saved[1]) * n3 + saved[2];
    const target = (i * dimensions[1] + j) * dimensions[2] + k;
    values[target] = domain.values[source];
    const interior = indices.every((index, axis) => index > 0 && index <= domain.dimensions[axis]);
    positions.set(interior ? domain.positions.subarray(source * 3, source * 3 + 3)
      : trilinearElementPoint(vertices, parameters[0][i], parameters[1][j], parameters[2][k]), target * 3);
  }
  return { domain: { ...domain, dimensions, positions, values }, reason: "" };
}
