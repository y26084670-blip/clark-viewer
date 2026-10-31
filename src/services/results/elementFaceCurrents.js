import { toStorage } from "../model/arrayShape.js";
import { unpackKvVertices } from "../solver/geometryKv.js";
import { expandElementSymmetry } from "../solver/symmetryExpansion.js";
import { applyMatrix4ToPoint } from "../solver/rotation3d.js";
import { trilinearElementPoint } from "../visualization/geometryDiscretization.js";
import { buildGeometryTimeModel } from "../visualization/geometryTimeModel.js";
import { elementLayout, mapResultObjects, QUANTITIES } from "./resultMappings.js";

const CHUNK_ROWS = 16384;
const J_OFFSET = QUANTITIES.J.offset;
const sub = (a, b) => a.map((x, k) => x - b[k]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// Three distinct layer slots in display order. With an even count select the
// first of the two central layers. Indices here, as in elementLayout, start at 0.
function selectedLayers(n) {
  return [0, n >= 2 ? n - 1 : null, n >= 3 ? Math.floor((n - 1) / 2) : null];
}

// The four corners are on the mid-surface of the selected layer. On a bilinear
// section P(u,v)=p+u*b+v*c+uv*w, the vector area density is affine in (u,v).
// Its midpoint value times the parametric patch area is the exact vector area
// of the elementary quadrilateral, including a warped one.
function sectionArea(vertices, dims, axis, layer, column) {
  const b = (axis + 1) % 3, c = (axis + 2) % 3;
  const section = (layer + 0.5) / dims[axis];
  function point(s, u, v) {
    const t = [0, 0, 0];
    t[axis] = s; t[b] = u; t[c] = v;
    return trilinearElementPoint(vertices, ...t);
  }
  const origin = point(section, 0, 0), edgeU = sub(point(section, 1, 0), origin);
  const cornerV = point(section, 0, 1), edgeV = sub(cornerV, origin);
  const twist = sub(sub(point(section, 1, 1), cornerV), edgeU);
  const base = cross(edgeU, edgeV), du = cross(edgeU, twist), dv = cross(twist, edgeV);
  const forward = sub(point(1, 0.5, 0.5), point(0, 0.5, 0.5));
  const determinant = dot(forward, base.map((x, k) => x + (du[k] + dv[k]) / 2));
  if (!Number.isFinite(determinant) || determinant === 0) throw new Error("вырожденное срединное сечение");
  const scale = Math.sign(determinant) / (dims[b] * dims[c]);
  return { column, b, c, base: base.map(x => x * scale), du: du.map(x => x * scale), dv: dv.map(x => x * scale) };
}

function makeSections(record, layout, layers) {
  const geo = Array.isArray(record.geo?.[0]) ? toStorage(record.geo, { nColumns: 3, order: "row" }) : record.geo;
  const { vertices, err } = unpackKvVertices(geo, record.geoType);
  if (err || !vertices.every(p => p.length === 3 && p.every(Number.isFinite))) throw new Error("ошибка геометрии");
  const relative = vertices.map(p => sub(p, vertices[0]));
  // Solver current_topology._currentCells / weakCurrentImages: saved unknown J
  // is in the frame BEFORE the common AS rotation. Rotating both J and dS to
  // the physical AS image would cancel in their dot product. Translations also
  // drop out. Each independent LS still has its own rotated faces.
  const localImages = expandElementSymmetry({ ...record, symAs: 1, symPs: 1, dr: [0, 0, 0], symR0: [0, 0, 0] });
  return localImages.map(image => {
    const rotated = relative.map(p => applyMatrix4ToPoint(image.matrix, p));
    return layers.map((slots, axis) => {
      const sections = new Map();
      slots.forEach((layer, slot) => {
        if (layer !== null) sections.set(layer, sectionArea(rotated, layout.dimensions, axis, layer, 3 * axis + slot));
      });
      return sections;
    });
  });
}

// Compensate cancellation of large inward and outward contributions (amperes).
function add(row, column, value) {
  const old = row.sums[column], next = old + value;
  row.corrections[column] += Math.abs(old) >= Math.abs(value) ? (old - next) + value : (value - next) + old;
  row.sums[column] = next;
}

function integrateElement(file, step, { record, start, count }) {
  const layout = elementLayout(record), dims = layout.dimensions, layers = dims.map(selectedLayers);
  const boundary = dims.every(n => n >= 3);
  const localSections = makeSections(record, layout, layers);
  const [nl, na, np] = layout.copies, images = [];
  for (let ls = 0; ls < nl; ls++) for (let as = 0; as < na; as++) for (let ps = 0; ps < np; ps++) {
    images.push({ ls, as, ps, sums: new Float64Array(11), corrections: new Float64Array(11) });
  }
  if (layout.count !== count) throw new Error("сетка не соответствует данным JE");
  for (let offset = 0; offset < count; offset += CHUNK_ROWS) {
    const size = Math.min(CHUNK_ROWS, count - offset);
    const frame = file.read({ step, start: start + offset, count: size });
    for (let i = 0; i < size; i++) {
      const { i1, i2, i3, ls, as, ps } = layout.indices(offset + i);
      const index = [i1, i2, i3], sections = localSections[ls];
      const row = images[(ls * na + as) * np + ps];
      const j = i * frame.stride + J_OFFSET;
      for (let axis = 0; axis < 3; axis++) {
        const area = sections[axis].get(index[axis]);
        if (!area) continue;
        const { column, b, c, base, du, dv } = area;
        const u = (index[b] + 0.5) / dims[b], v = (index[c] + 0.5) / dims[c];
        let flux = 0;
        for (let k = 0; k < 3; k++) flux += frame.values[j + k] * (base[k] + u * du[k] + v * dv[k]);
        if (!Number.isFinite(flux)) throw new Error("неконечное значение тока через площадку");
        add(row, column, flux);
        if (boundary && column % 3 < 2) {
          add(row, 9, column % 3 === 0 ? -flux : flux);
          add(row, 10, Math.abs(flux));
        }
      }
    }
  }
  const available = [...layers.flat().map(layer => layer !== null), boundary, boundary];
  return { id: record.id, name: record.name ?? "", dimensions: dims, layers, images: images.map(row => {
    const values = available.map((present, k) => present ? row.sums[k] + row.corrections[k] : null);
    if (values.some(value => value !== null && !Number.isFinite(value))) throw new Error("переполнение суммы токов");
    return { ls: row.ls + 1, as: row.as + 1, ps: row.ps + 1, values };
  }) };
}

// Called inside the HDF5 worker. Keep all JE header offsets (including coils)
// before selecting the solved conductors. Only one bounded slice is resident.
export function elementFaceCurrents(file, task, step) {
  if (!file.steps.some(item => item.index === step)) throw new Error(`В JE.h5 нет данных для шага ${step}.`);
  const projected = buildGeometryTimeModel(task, task.moves, step);
  const objects = mapResultObjects(projected.model, "JE", file.header).filter(({ record }) => record.targ === 0);
  return objects.map(object => {
    try {
      const problem = projected.diagnostics.find(d => d.schemaId === "general" || (
        d.schemaId === "elements" && d.recordIndex === object.record.recordIndex));
      if (problem) throw new Error(problem.message);
      return integrateElement(file, step, object);
    } catch (error) {
      throw new Error(`ШГ №${object.record.id}: ${error.message}`);
    }
  });
}
