import test from "node:test";
import assert from "node:assert/strict";
import { expandResultScalar, expandResultVector, resultSymmetryCopies } from "../src/services/results/resultSymmetry.js";
import { vectorScene, scalarScene, resultVolumeDomains } from "../src/services/results/resultPlots.js";
import { QUANTITIES } from "../src/services/results/resultMappings.js";
import { referenceResultVectorLayers } from "../src/services/visualization/resultVectorScale.js";
import { instanceVisible } from "../src/services/visualization/geometryRenderFilters.js";

const record = {
  id:1, recordIndex:0, targ:0, dp:[[1],[1],[1]],
  dr:[[0],[0],[0]], symVi:[[0],[0],[0]], symR0:[[0],[0],[0]],
  symLs:1, symYl:0, symAs:2, symYa:90, symPs:2, symTx:10,
  symKya:-1, symKyp:1,
};
const source = { schemaId:"elements", recordIndex:0, name:"box" };
const base = { origin:[1,2,3], vector:[1,2,3], magnitude:Math.sqrt(14), source,
  instance:{ls:0,as:0,ps:0}, quantity:"q", unit:"u" };

test("saved images share matrices across nodes and M/H; early filters preserve full-grid scales and signs", () => {
  const task = { general: { mirrorSymmetryX: 1, mirrorSymmetryY: 0 } };
  const physical = { ...record, symLs: 2, symYl: 45, symKya: 0 };
  const rows = [0, 1, 2, 3].flatMap(i => [i, 2, 3, i + 1, -2, 3, 0, 0, 2]);
  const frames = [{ record: physical, frame: { count: 4, stride: 9, values: Float64Array.from(rows) } }];
  const instance = { ls: 1, as: 1, ps: 0 };
  const plan = resultSymmetryCopies(task, physical, "M", instance);
  assert.equal(plan, resultSymmetryCopies(task, physical, "H", { ...instance }));
  assert.equal(plan.length, 8);
  const filters = { local: false, axial: false, periodic: true, mirror: false };
  const choose = item => instanceVisible(item.instance, filters);
  const full = vectorScene(frames, QUANTITIES.M, task), visible = vectorScene(frames, QUANTITIES.M, task, filters);
  assert.deepEqual(visible.vectors, full.vectors.filter(choose));
  const reference = scene => referenceResultVectorLayers({}, [{ key: "elements", quantityKey: "M", scene }])[0].vectorLengthReference;
  assert.deepEqual(reference(visible), reference(full));
  const scalars = scalarScene(frames, QUANTITIES.MHdot, task, filters);
  assert.deepEqual(scalars.points, scalarScene(frames, QUANTITIES.MHdot, task).points.filter(choose));
  const domains = resultVolumeDomains(frames, QUANTITIES.M, full, task);
  assert.deepEqual(resultVolumeDomains(frames, QUANTITIES.M, visible, task, filters), domains.filter(choose));
});

test("mirror settings are defined for H/B/M and opposite for J/E/A", () => {
  for (const [setting, magnetic, opposite] of [
    [0, [-1,2,3], [1,-2,-3]],
    [1, [1,-2,-3], [-1,2,3]],
  ]) {
    const task={general:{mirrorSymmetryX:setting,mirrorSymmetryY:-1}};
    const h=expandResultVector(task,{...record,symAs:1,symPs:1},"H",base);
    const e=expandResultVector(task,{...record,symAs:1,symPs:1},"E",base);
    assert.equal(h.length,2); assert.equal(e.length,2);
    assert.deepEqual(h.find(v=>v.instance.mirrorX===1).vector.map(v=>Math.round(v)), magnetic);
    assert.deepEqual(e.find(v=>v.instance.mirrorX===1).vector.map(v=>Math.round(v)), opposite);
  }
});

test("missing full AS/PS images are reconstructed with signs while scalar products keep value", () => {
  const task={general:{mirrorSymmetryX:-1,mirrorSymmetryY:-1}};
  const vectors=expandResultVector(task,record,"H",base);
  assert.equal(vectors.length,4);
  const axial=vectors.find(v=>v.instance.as===1&&v.instance.ps===0);
  assert.deepEqual(axial.origin.map(v=>Math.round(v)),[1,-3,2]);
  assert.deepEqual(axial.vector.map(v=>Math.round(v)),[-1,3,-2]);
  const periodic=vectors.find(v=>v.instance.as===0&&v.instance.ps===1);
  assert.deepEqual(periodic.origin.map(v=>Math.round(v)),[11,2,3]);
  assert.deepEqual(periodic.vector.map(v=>Math.round(v)),[1,2,3]);

  const scalar={origin:[1,2,3],value:-7,source,instance:{ls:0,as:0,ps:0}};
  const expanded=expandResultScalar(task,record,"JEdot",scalar);
  assert.equal(expanded.length,4);
  assert.ok(expanded.every(item=>item.value===-7));
});

test("HV/AV already saved AS/PS images are not duplicated; only mirrors are added", () => {
  const virtual={...record,targ:3,symKya:-1,symKyp:-1};
  const task={general:{mirrorSymmetryX:0,mirrorSymmetryY:-1}};
  const copies=resultSymmetryCopies(task,virtual,"Bv",{ls:0,as:1,ps:1});
  assert.equal(copies.length,2);
  assert.ok(copies.every(copy=>copy.instance.as===1&&copy.instance.ps===1));
  assert.deepEqual(copies.map(copy=>copy.instance.mirrorX).sort(),[0,1]);
});

test("area fields keep each saved local grid and its vector in both mirror planes", () => {
  const region = { ...record, symLs: 2, symYl: 90 };
  const task = { general: { mirrorSymmetryX: 0, mirrorSymmetryY: 1 } };
  for (const key of ["Bs", "As"]) for (const ls of [0, 1]) {
    const item = { ...base, origin: [1, -2, 3], source: {schemaId:"regions", recordIndex:0}, instance: {ls, as:0, ps:0} };
    const copies = expandResultVector(task, region, key, item);
    assert.equal(copies.length, 1);
    assert.deepEqual([copies[0].instance.ls, copies[0].instance.mirrorX, copies[0].instance.mirrorY], [ls, 0, 0]);
    assert.deepEqual(copies[0].origin, item.origin);
    assert.deepEqual(copies[0].vector, item.vector);
  }
});
