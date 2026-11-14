import { elementLayout, QUANTITIES } from "./resultMappings.js";
import { expandElementSymmetry, expandRegionSymmetry } from "../solver/symmetryExpansion.js";
import { applyMatrix4ToPoint, identityMatrix4, multiplyMatrix4 } from "../solver/rotation3d.js";

import { instanceVisible } from "../visualization/geometryRenderFilters.js";

// Task and projected records are immutable. Weak keys release plans on reload or motion.
const taskPlans = new WeakMap();
const noCopies = [];

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

function mirrorSign(setting, parity) {
  if (setting !== 0 && setting !== 1) return 1;
  // reflectionMatrix4 is the polar-vector transform.
  // General mirror settings are defined for H:
  // 0 -> zero normal H => polar transform; 1 -> zero tangential H => opposite sign.
  const magnetic = setting === 1 ? -1 : 1;
  return parity === "opposite" ? -magnetic : magnetic;
}

function buildCopyPlan(task, record, quantity) {
  // FieldS has already written each local TK grid in world coordinates.
  if (quantity.group === "regions") {
    const identity = identityMatrix4();
    const saved = expandRegionSymmetry(record).map(instance => [{instance, matrix:identity, sign:1}]);
    return ({ls, as, ps}) => as === 0 && ps === 0 ? saved[ls] ?? noCopies : noCopies;
  }
  const full = quantity.file === "HV" || quantity.file === "AV";
  const [, axial, periodic] = elementLayout(record, full).copies;
  const general = task?.general ?? {};
  const targets = expandElementSymmetry(record, general);
  const index = (ls, az, ps) => (ls * axial + az) * periodic + ps;
  const inverses = new Map(), copies = new Map();
  for (const image of targets) {
    if (image.mirrorX || image.mirrorY || image.as >= axial || image.ps >= periodic) continue;
    inverses.set(index(image.ls, image.as, image.ps), invertOrthogonalAffine(image.matrix));
  }
  for (const image of targets) {
    const saved = index(image.ls, axial > 1 ? image.as : 0, periodic > 1 ? image.ps : 0);
    const inverse = inverses.get(saved);
    if (!inverse) continue;
    let sign = 1;
    if (quantity.components === 3) {
      if (axial === 1 && record.symAs > 1) sign *= image.axialSign;
      if (periodic === 1 && record.symPs > 1) sign *= image.periodicSign;
      if (image.mirrorX) sign *= mirrorSign(general.mirrorSymmetryX, quantity.mirrorParity);
      if (image.mirrorY) sign *= mirrorSign(general.mirrorSymmetryY, quantity.mirrorParity);
    }
    if (!copies.has(saved)) copies.set(saved, []);
    copies.get(saved).push({ instance: image, matrix: multiplyMatrix4(image.matrix, inverse), sign });
  }
  return ({ ls, as, ps }) => as >= 0 && as < axial && ps >= 0 && ps < periodic
    ? copies.get(index(ls, as, ps)) ?? noCopies : noCopies;
}

// Build matrices once per physical symmetry layout. Visibility only selects
// references to those matrices before any point/vector/volume is expanded.
export function resultCopyPlan(task, record, quantityKey) {
  const quantity = QUANTITIES[quantityKey];
  if (!quantity) return () => noCopies;
  if (!task) return buildCopyPlan(task, record, quantity);
  let records = taskPlans.get(task);
  if (!records) taskPlans.set(task, records = new WeakMap());
  let plans = records.get(record);
  if (!plans) records.set(record, plans = new Map());
  const full = quantity.file === "HV" || quantity.file === "AV";
  const key = [quantity.group, full, quantity.mirrorParity ?? "scalar"].join(":");
  if (!plans.has(key)) plans.set(key, buildCopyPlan(task, record, quantity));
  return plans.get(key);
}

export function visibleResultCopies(filters) {
  if (!filters || Object.values(filters).every(value => value !== false)) return copies => copies;
  const filtered = new Map();
  return copies => {
    if (!filtered.has(copies)) filtered.set(copies, copies.filter(copy => instanceVisible(copy.instance, filters)));
    return filtered.get(copies);
  };
}

export function resultSymmetryCopies(task, record, quantityKey, savedInstance) {
  return resultCopyPlan(task, record, quantityKey)(savedInstance);
}

export function resultInstanceKey(source, instance) {
  return `${source.schemaId}:${source.recordIndex}:${instance?.ls ?? 0}:${instance?.as ?? 0}:${instance?.ps ?? 0}:${instance?.mirrorX ?? 0}:${instance?.mirrorY ?? 0}`;
}

export function expandResultVector(task, record, quantityKey, item, copies = resultSymmetryCopies(task, record, quantityKey, item.instance)) {
  return copies.map(copy => {
    const vector = applyMatrix4ToVector(copy.matrix, item.vector, copy.sign);
    return { ...item, origin: applyMatrix4ToPoint(copy.matrix, item.origin), vector,
      magnitude: Math.hypot(...vector), instance: copy.instance };
  });
}

export function expandResultScalar(task, record, quantityKey, item, copies = resultSymmetryCopies(task, record, quantityKey, item.instance)) {
  return copies.map(copy => ({ ...item, origin: applyMatrix4ToPoint(copy.matrix, item.origin), instance: copy.instance }));
}

export function expandResultDomain(task, record, quantityKey, domain, copies = resultSymmetryCopies(task, record, quantityKey, domain.instance)) {
  return copies.map(copy => {
    const positions = new Float64Array(domain.positions.length);
    for (let offset=0; offset<domain.positions.length; offset+=3) {
      positions.set(applyMatrix4ToPoint(copy.matrix,
        [domain.positions[offset],domain.positions[offset+1],domain.positions[offset+2]]), offset);
    }
    return { ...domain, key: resultInstanceKey(domain.source, copy.instance), instance: copy.instance,
      positions, values: domain.values.slice ? domain.values.slice() : Float64Array.from(domain.values) };
  });
}
