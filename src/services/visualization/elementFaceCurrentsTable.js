import { applyMatrix4ToPoint } from "../solver/rotation3d.js";
import { createElementPointMapper } from "./geometryDiscretization.js";

// Number.toString keeps the decimal point independently of the browser locale.
export function formatSignificantNumber(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toPrecision(digits)).toString() : "—";
}

function imageKey(elementId, ls, as, ps) {
  return `${elementId}:${ls}:${as}:${ps}`;
}

// Selection belongs to the element/image/column, not to a rounded value or frame.
export function faceCurrentCellKey(elementId, image, column) {
  return `${imageKey(elementId, image.ls, image.as, image.ps)}:${column}`;
}

export function selectedFaceCurrentTotal(groups, selected) {
  let sum = 0, correction = 0;
  for (const element of groups) for (const image of element.images) {
    image.values.forEach((value, column) => {
      if (!Number.isFinite(value) || !selected.has(faceCurrentCellKey(element.id, image, column))) return;
      // Opposite currents may almost cancel; retain the small contributions.
      const next = sum + value;
      correction += Math.abs(sum) >= Math.abs(value) ? (sum - next) + value : (value - next) + sum;
      sum = next;
    });
  }
  return sum + correction;
}

// Use the zero-based layers returned with the actual current values. Each
// boundary total uses the first and last section in all three directions.
export function selectedFaceCurrentSections(groups, selected) {
  const sections = new Map();
  if (!selected.size) return sections;
  for (const element of groups) for (const image of element.images) {
    const key = imageKey(element.id, image.ls, image.as, image.ps);
    const marked = column => Number.isFinite(image.values[column]) && selected.has(`${key}:${column}`);
    const boundary = marked(9) || marked(10);
    const onImage = [];
    element.layers.forEach((slots, axis) => slots.forEach((layer, slot) => {
      if (layer !== null && ((boundary && slot < 2) || marked(3 * axis + slot))) {
        onImage.push({ axis, position: (layer + 0.5) / element.dimensions[axis] });
      }
    }));
    if (onImage.length) sections.set(key, onImage);
  }
  return sections;
}

const sectionCorners = [[0, 0], [1, 0], [1, 1], [0, 1]];

export function faceCurrentContourPositions(sections, visibleBatches) {
  const positions = [];
  if (!sections?.size) return positions;
  for (const { primitive, instances } of visibleBatches) {
    if (primitive.kind !== "element-volume") continue;
    const id = primitive.source.recordIndex + 1;
    let point;
    for (const instance of instances) {
      // The JE table has a row only for saved LS/AS/PS images, before mirroring.
      if (instance.mirrorX || instance.mirrorY) continue;
      const selected = sections.get(imageKey(id, instance.ls + 1, instance.as + 1, instance.ps + 1));
      if (!selected) continue;
      point ??= createElementPointMapper(primitive.vertices);
      if (!point) continue;
      for (const { axis, position } of selected) {
        const corners = sectionCorners.map(([u, v]) => {
          const t = [0, 0, 0];
          t[axis] = position;
          t[(axis + 1) % 3] = u;
          t[(axis + 2) % 3] = v;
          return applyMatrix4ToPoint(instance.matrix, point(...t));
        });
        for (let edge = 0; edge < 4; edge++) {
          positions.push(...corners[edge], ...corners[(edge + 1) % 4]);
        }
      }
    }
  }
  return positions;
}
