// Only small, immutable scale descriptors survive tab unmounts. Neither result
// arrays nor the task's HDF5/Three resources are retained by these maps.
const taskReferences = new WeakMap();

/** One reference per task, result group and physical quantity. A zero first
 * frame does not lock a zero denominator: the first finite nonzero frame wins.
 * It is a length reference, NOT the live maximum or a global colour scale.
 */
export function referenceResultVectorLayers(task, layers = []) {
  if (!task || (typeof task !== "object" && typeof task !== "function")) return layers;
  let references = taskReferences.get(task);
  if (!references) taskReferences.set(task, references = new Map());
  return layers.map(layer => {
    if (!layer?.scene || (layer.state && layer.state !== "ready")) return layer;
    const key = `${layer.key}:${layer.quantityKey}`;
    let reference = references.get(key);
    if (!reference) {
      const maximum = { current: 0, magnetization: 0 };
      let characteristicSize = 0;
      for (const vector of layer.scene.vectors ?? []) {
        if (Object.hasOwn(maximum, vector.kind) && Number.isFinite(vector.magnitude) && vector.magnitude >= 0) {
          maximum[vector.kind] = Math.max(maximum[vector.kind], vector.magnitude);
        }
        if (Number.isFinite(vector.characteristicSize) && vector.characteristicSize > 0) {
          characteristicSize = Math.max(characteristicSize, vector.characteristicSize);
        }
      }
      if (Math.max(maximum.current, maximum.magnetization) > 0 && characteristicSize > 0) {
        const diagonal = layer.scene.sceneDiagonal;
        reference = Object.freeze({
          maximumMagnitude: Object.freeze(maximum), characteristicSize,
          sceneDiagonal: Number.isFinite(diagonal) && diagonal > 0 ? diagonal : 0,
        });
        references.set(key, reference);
      }
    }
    return reference ? { ...layer, vectorLengthReference: reference } : layer;
  });
}

/** Shared by thin and solid arrows. The reference affects display length only;
 * coordinates, components, signed direction and colour magnitudes stay intact.
 */
export function resultVectorLength(item, scale, maximumMagnitude, sceneDiagonal, reference = null) {
  const size = reference?.characteristicSize ?? item.characteristicSize;
  const diagonal = reference?.sceneDiagonal ?? sceneDiagonal;
  const maximum = reference?.maximumMagnitude?.[item.kind] ?? maximumMagnitude?.[item.kind];
  const sceneLimit = diagonal > 0 ? 0.06 * diagonal : Infinity;
  const length = Math.min(0.7 * size, sceneLimit) * (item.magnitude / maximum) * scale;
  return Number.isFinite(length) && length > 0 ? length : 0;
}
