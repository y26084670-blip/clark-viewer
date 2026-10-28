import { buildGeometryScene } from "../visualization/geometrySceneModel.js";
import { geometryMaterialStyle } from "../visualization/geometryMaterialStyle.js";

export const PROTOCOL_SCENE_INSTANCE_LIMIT = 20_000;
export const PROTOCOL_SCENE_VERTEX_LIMIT = 1_000_000;
const finite = value => Number.isFinite(value) && Math.abs(value) <= 3.402823466e38;
const numbers = (values, multiple) => Array.isArray(values) && values.length > 0
  && values.length % multiple === 0 && values.every(finite);
const indices = (values, count, multiple) => Array.isArray(values) && values.length % multiple === 0
  && values.every(value => Number.isSafeInteger(value) && value >= 0 && value < count);

export function validateProtocolScene(scene) {
  if (scene?.version !== 1 || !Array.isArray(scene.objects) || !scene.objects.length || scene.objects.length > 20_000
    || !numbers(scene.bounds?.min, 3) || scene.bounds.min.length !== 3
    || !numbers(scene.bounds?.max, 3) || scene.bounds.max.length !== 3
    || scene.bounds.min.some((v, i) => v > scene.bounds.max[i])) throw new Error("Некорректная 3D-геометрия протокола.");
  let instances = 0, vertices = 0;
  const ids = new Set();
  for (const object of scene.objects) {
    if (typeof object.id !== "string" || !object.id || object.id.length > 100 || ids.has(object.id)
      || typeof object.label !== "string" || object.label.length > 10000
      || !["element-volume", "region-surface", "region-line"].includes(object.kind)
      || ![object.color, object.copyColor, object.edgeColor].every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffff)
      || !numbers(object.positions, 3) || !numbers(object.edgePositions, 3)
      || object.indices?.length > 6_000_000 || object.edgeIndices?.length > 6_000_000
      || !indices(object.indices, object.positions.length / 3, object.kind === "region-line" ? 2 : 3)
      || !indices(object.edgeIndices, object.edgePositions.length / 3, 2)
      || !Array.isArray(object.instances) || !object.instances.length) throw new Error("Некорректный объект 3D-протокола.");
    ids.add(object.id);
    instances += object.instances.length;
    vertices += (object.positions.length + object.edgePositions.length) / 3 * object.instances.length;
    if (instances > PROTOCOL_SCENE_INSTANCE_LIMIT || vertices > PROTOCOL_SCENE_VERTEX_LIMIT) {
      throw new Error("3D-протокол превышает предел 20 000 образов или 1 000 000 вершин.");
    }
    for (const instance of object.instances) {
      const matrix = instance?.matrix;
      if (!numbers(matrix, 16) || matrix.length !== 16 || typeof instance.original !== "boolean"
        || matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) throw new Error("Некорректное преобразование 3D-протокола.");
      for (const positions of [object.positions, object.edgePositions]) for (let i = 0; i < positions.length; i += 3) {
        for (let axis = 0; axis < 3; axis++) {
          const value = matrix[axis] * positions[i] + matrix[4 + axis] * positions[i + 1]
            + matrix[8 + axis] * positions[i + 2] + matrix[12 + axis];
          if (!finite(value)) throw new Error("Координаты 3D-протокола выходят за пределы отображения.");
        }
      }
    }
  }
  return scene;
}

export function buildProtocolScene(task) {
  const scene = buildGeometryScene(task);
  if (scene.counts.skipped) throw new Error(`Не удалось включить всю геометрию в протокол: ${scene.diagnostics.map(item => item.message).join("; ")}`);
  if (!scene.primitives.length) return null;
  const objects = scene.primitives.map(primitive => {
    const original = primitive.kind === "element-volume" ? geometryMaterialStyle(primitive.materialKind, true)
      : { color: 0xd99043, edgeColor: 0x000000 };
    const copy = primitive.kind === "element-volume" ? geometryMaterialStyle(primitive.materialKind, false) : { color: 0xffb65e };
    return {
      id: `${primitive.source.schemaId}:${primitive.source.recordIndex}`,
      label: `${primitive.kind === "element-volume" ? "Элемент" : "Область"} ${primitive.source.recordIndex + 1}: ${primitive.source.name}`,
      kind: primitive.kind, color: original.color, copyColor: copy.color, edgeColor: original.edgeColor,
      positions: Array.from(primitive.vertices), indices: Array.from(primitive.indices),
      edgePositions: Array.from(primitive.controlVertices ?? primitive.vertices), edgeIndices: Array.from(primitive.edgeIndices),
      instances: primitive.instances.map(instance => ({ matrix: Array.from(instance.matrix), original:
        !instance.ls && !instance.as && !instance.ps && !instance.mirrorX && !instance.mirrorY })),
    };
  });
  return validateProtocolScene({ version: 1, bounds: { min: Array.from(scene.bounds.min), max: Array.from(scene.bounds.max) }, objects });
}
