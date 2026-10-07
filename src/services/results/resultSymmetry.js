import { elementLayout, QUANTITIES } from "./resultMappings.js";
import { expandElementSymmetry, expandRegionSymmetry } from "../solver/symmetryExpansion.js";
import { applyMatrix4ToPoint, multiplyMatrix4 } from "../solver/rotation3d.js";

const NO_MIRRORS = Object.freeze({ mirrorSymmetryX: -1, mirrorSymmetryY: -1 });

function invertOrthogonalAffine(matrix) {
  const result = new Float64Array(16);
  result[0] = matrix[0]; result[4] = matrix[1]; result[8] = matrix[2];
  result[1] = matrix[4]; result[5] = matrix[5]; result[9] = matrix[6];
  result[2] = matrix[8]; result[6] = matrix[9]; result[10] = matrix[10];
  result[15] = 1;
  const [x,y,z] = [matrix[12],matrix[13],matrix[14]];
  result[12] = -(matrix[0]*x + matrix[1]*y + matrix[2]*z);
  result[13] = -(matrix[4]*x + matrix[5]*y + matrix[6]*z);
  result[14] = -(matrix[8]*x + matrix[9]*y + matrix[10]*z);
  return result;
}

export function applyMatrix4ToVector(matrix, vector, sign = 1) {
  const [x,y,z] = vector;
  return [
    sign * (matrix[0]*x + matrix[4]*y + matrix[8]*z),
    sign * (matrix[1]*x + matrix[5]*y + matrix[9]*z),
    sign * (matrix[2]*x + matrix[6]*y + matrix[10]*z),
  ];
}

function sameInstance(a, b) {
  return Number(a?.ls ?? 0) === Number(b?.ls ?? 0)
    && Number(a?.as ?? 0) === Number(b?.as ?? 0)
    && Number(a?.ps ?? 0) === Number(b?.ps ?? 0);
}

function mirrorSign(setting, parity) {
  if (setting !== 0 && setting !== 1) return 1;
  // reflectionMatrix4 is the polar-vector transform.
  // General mirror settings are defined for H:
  // 0 -> zero normal H => polar transform; 1 -> zero tangential H => opposite sign.
  const magnetic = setting === 1 ? -1 : 1;
  return parity === "opposite" ? -magnetic : magnetic;
}

function elementCopies(task, record, quantity, savedInstance) {
  const fullStored = quantity.file === "HV" || quantity.file === "AV";
  const savedCopies = elementLayout(record, fullStored).copies;
  const source = expandElementSymmetry(record, NO_MIRRORS)
    .find(instance => sameInstance(instance, savedInstance) && !instance.mirrorX && !instance.mirrorY);
  if (!source) return [];
  const inverse = invertOrthogonalAffine(source.matrix);
  return expandElementSymmetry(record, task?.general ?? {}).filter(target =>
    target.ls === savedInstance.ls
    && (savedCopies[1] > 1 ? target.as === savedInstance.as : true)
    && (savedCopies[2] > 1 ? target.ps === savedInstance.ps : true)
  ).map(target => {
    let sign = 1;
    if (quantity.components === 3) {
      if (savedCopies[1] === 1 && Number(record.symAs ?? 1) > 1) sign *= target.axialSign;
      if (savedCopies[2] === 1 && Number(record.symPs ?? 1) > 1) sign *= target.periodicSign;
      if (target.mirrorX) sign *= mirrorSign(task?.general?.mirrorSymmetryX, quantity.mirrorParity);
      if (target.mirrorY) sign *= mirrorSign(task?.general?.mirrorSymmetryY, quantity.mirrorParity);
    }
    return { instance: target, matrix: multiplyMatrix4(target.matrix, inverse), sign };
  });
}

function regionCopies(task, record, quantity, savedInstance) {
  const source = expandRegionSymmetry(record, NO_MIRRORS)
    .find(instance => sameInstance(instance, savedInstance) && !instance.mirrorX && !instance.mirrorY);
  if (!source) return [];
  const inverse = invertOrthogonalAffine(source.matrix);
  return expandRegionSymmetry(record, task?.general ?? {})
    .filter(target => target.ls === savedInstance.ls)
    .map(target => {
      let sign = 1;
      if (quantity.components === 3) {
        if (target.mirrorX) sign *= mirrorSign(task?.general?.mirrorSymmetryX, quantity.mirrorParity);
        if (target.mirrorY) sign *= mirrorSign(task?.general?.mirrorSymmetryY, quantity.mirrorParity);
      }
      return { instance: target, matrix: multiplyMatrix4(target.matrix, inverse), sign };
    });
}

export function resultSymmetryCopies(task, record, quantityKey, savedInstance) {
  const quantity = QUANTITIES[quantityKey];
  if (!quantity) return [];
  return quantity.group === "regions"
    ? regionCopies(task, record, quantity, savedInstance)
    : elementCopies(task, record, quantity, savedInstance);
}

export function resultInstanceKey(source, instance) {
  return `${source.schemaId}:${source.recordIndex}:${instance?.ls ?? 0}:${instance?.as ?? 0}:${instance?.ps ?? 0}:${instance?.mirrorX ?? 0}:${instance?.mirrorY ?? 0}`;
}

export function expandResultVector(task, record, quantityKey, item) {
  const copies = resultSymmetryCopies(task, record, quantityKey, item.instance);
  return copies.map(copy => {
    const vector = applyMatrix4ToVector(copy.matrix, item.vector, copy.sign);
    return { ...item, origin: applyMatrix4ToPoint(copy.matrix, item.origin), vector,
      magnitude: Math.hypot(...vector), instance: copy.instance };
  });
}

export function expandResultScalar(task, record, quantityKey, item) {
  return resultSymmetryCopies(task, record, quantityKey, item.instance)
    .map(copy => ({ ...item, origin: applyMatrix4ToPoint(copy.matrix, item.origin), instance: copy.instance }));
}

export function expandResultDomain(task, record, quantityKey, domain) {
  return resultSymmetryCopies(task, record, quantityKey, domain.instance).map(copy => {
    const positions = new Float64Array(domain.positions.length);
    for (let offset=0; offset<domain.positions.length; offset+=3) {
      positions.set(applyMatrix4ToPoint(copy.matrix,
        [domain.positions[offset],domain.positions[offset+1],domain.positions[offset+2]]), offset);
    }
    return { ...domain, key: resultInstanceKey(domain.source, copy.instance), instance: copy.instance,
      positions, values: domain.values.slice ? domain.values.slice() : Float64Array.from(domain.values) };
  });
}
