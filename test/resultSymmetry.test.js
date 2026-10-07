import test from "node:test";
import assert from "node:assert/strict";
import { expandResultScalar, expandResultVector, resultSymmetryCopies } from "../src/services/results/resultSymmetry.js";

const record = {
  id:1, recordIndex:0, targ:0, dp:[[1],[1],[1]],
  dr:[[0],[0],[0]], symVi:[[0],[0],[0]], symR0:[[0],[0],[0]],
  symLs:1, symYl:0, symAs:2, symYa:90, symPs:2, symTx:10,
  symKya:-1, symKyp:1,
};
const source = { schemaId:"elements", recordIndex:0, name:"box" };
const base = { origin:[1,2,3], vector:[1,2,3], magnitude:Math.sqrt(14), source,
  instance:{ls:0,as:0,ps:0}, quantity:"q", unit:"u" };

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

test("region B and A receive opposite mirror parity", () => {
  const region={id:1,recordIndex:0,dp:[[2],[2]],dr:[[0],[0],[0]],symVi:[[0],[0],[0]],symR0:[[0],[0],[0]],symLs:1,symYl:0};
  const task={general:{mirrorSymmetryX:0,mirrorSymmetryY:-1}};
  const item={...base,source:{schemaId:"regions",recordIndex:0},instance:{ls:0,as:0,ps:0}};
  const b=expandResultVector(task,region,"Bs",item).find(v=>v.instance.mirrorX===1);
  const a=expandResultVector(task,region,"As",item).find(v=>v.instance.mirrorX===1);
  assert.deepEqual(b.vector.map(v=>Math.round(v)),[-1,2,3]);
  assert.deepEqual(a.vector.map(v=>Math.round(v)),[1,-2,-3]);
});
