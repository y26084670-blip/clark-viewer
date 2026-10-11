import test from "node:test";
import assert from "node:assert/strict";
import { expandResultStreamline, savedStreamlineSeed } from "../src/services/results/resultStreamlineSymmetry.js";
import { resultSymmetryCopies, applyMatrix4ToVector } from "../src/services/results/resultSymmetry.js";

const record = { id: 1, recordIndex: 0, targ: 0, dp: [[2], [2], [2]],
  dr: [[0], [0], [0]], symR0: [[0], [0], [0]], symVi: [[0], [0], [0]],
  symLs: 1, symAs: 2, symPs: 2, symYa: 90, symTx: 10, symKya: -1, symKyp: -1 };
const source = { schemaId: "elements", recordIndex: 0 };
const instance = { ls: 0, as: 0, ps: 0 };
const path = (direction = 1) => ({ source, instance, direction, key: "base",
  positions: Float64Array.from(direction > 0 ? [1, 2, 3, 2, 4, 6] : [1, 2, 3, 0, 0, 0]),
  magnitudes: Float64Array.from([Math.sqrt(14), Math.sqrt(14)]) });
const line = (quantityKey = "M") => ({ id: 1, quantityKey, source, instance,
  start: [1, 2, 3], paths: [path(-1), path(1)], length: Math.sqrt(14) * 2 });
const task = (changes = {}, general = {}) => ({ elements: [{ ...record, ...changes }], general });
const close = (actual, expected) => actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-8, `${actual} != ${expected}`));

test("reconstructed seed images map back to the saved node without collapsing independent LS/AS/PS", () => {
  const seed = { ...line(), node: 7, instance: { ls: 1, as: 1, ps: 1, mirrorX: 1 } };
  const t = task({ symLs: 2 });
  assert.deepEqual(savedStreamlineSeed(t, seed).instance, { ls: 1, as: 0, ps: 0 });
  assert.equal(savedStreamlineSeed(t, seed).node, 7);
  assert.deepEqual(seed.instance, { ls: 1, as: 1, ps: 1, mirrorX: 1 });
  assert.deepEqual(savedStreamlineSeed(task({ symLs: 2, symKya: 0, symKyp: 0 }), seed).instance, { ls: 1, as: 1, ps: 1 });
  for (const quantityKey of ["Bv", "Av"]) {
    assert.deepEqual(savedStreamlineSeed(task({ symLs: 2, targ: 3, indAmp: 0 }), { ...seed, quantityKey }).instance,
      { ls: 1, as: 1, ps: 1 });
  }
  assert.throws(() => savedStreamlineSeed(t, { ...seed, instance: { ls: 2, as: 0, ps: 0 } }), /Образ линии/);
  assert.throws(() => savedStreamlineSeed(t, { ...seed, quantityKey: "JEdot" }), /векторного поля/);
});

test("mirror images of all six vector fields respect magnetic/opposite parity and branch direction", () => {
  for (const quantityKey of ["M", "H", "J", "E", "Bv", "Av"]) for (const setting of [0, 1]) {
    const t = task({ symAs: 1, symPs: 1, targ: ["Bv", "Av"].includes(quantityKey) ? 3 : 0 },
      { mirrorSymmetryX: setting, mirrorSymmetryY: -1 });
    const original = line(quantityKey), expanded = expandResultStreamline(t, original);
    assert.equal(expanded.starts.length, 2); assert.equal(expanded.paths.length, 4);
    close(expanded.starts[1].start, [-1, 2, 3]);
    const copy = resultSymmetryCopies(t, t.elements[0], quantityKey, instance).find(c => c.instance.mirrorX === 1);
    const opposite = ["J", "E", "Av"].includes(quantityKey);
    const sign = (setting === 1 ? -1 : 1) * (opposite ? -1 : 1);
    assert.equal(copy.sign, sign);
    for (const [i, p] of expanded.paths.slice(2).entries()) {
      assert.equal(p.fieldSign, sign); assert.equal(p.direction, original.paths[i].direction * sign);
      const vector = applyMatrix4ToVector(copy.matrix, [1, 2, 3], sign);
      const delta = [0, 1, 2].map(k => p.positions[k + 3] - p.positions[k]);
      assert.ok(delta.reduce((n, v, k) => n + v * vector[k], 0) * p.direction > 0);
      assert.equal(p.magnitudes, original.paths[i].magnitudes);
    }
    assert.equal(expanded.paths[0], original.paths[0]); assert.deepEqual(original.start, [1, 2, 3]);
  }
});

test("alternating axial/periodic signs multiply, double mirrors retain quantity-specific parity", () => {
  const t = task({}, { mirrorSymmetryX: 0, mirrorSymmetryY: 1 });
  const original = line(), expanded = expandResultStreamline(t, original);
  assert.equal(expanded.starts.length, 16); assert.equal(expanded.paths.length, 32);
  const axial = expanded.paths.find(p => p.instance.as === 1 && p.instance.ps === 0 && !p.instance.mirrorX && !p.instance.mirrorY);
  close(Array.from(axial.positions.subarray(0, 3)), [1, -3, 2]);
  assert.equal(axial.fieldSign, -1);
  const combined = expanded.paths.find(p => p.instance.as === 1 && p.instance.ps === 1 && !p.instance.mirrorX && !p.instance.mirrorY);
  close(Array.from(combined.positions.subarray(0, 3)), [11, -3, 2]);
  assert.equal(combined.fieldSign, 1);
  const mirrors = expanded.paths.find(p => p.instance.as === 0 && p.instance.ps === 0 && p.instance.mirrorX && p.instance.mirrorY);
  close(Array.from(mirrors.positions.subarray(0, 3)), [-1, -2, 3]);
  assert.equal(mirrors.fieldSign, -1);
});

test("geometry copies with independently saved fields are not assigned a copied curve", () => {
  const t = task({ symLs: 2, symKya: 0, symKyp: 0 });
  const original = { ...line(), instance: { ls: 1, as: 1, ps: 1 },
    paths: [ { ...path(), instance: { ls: 1, as: 1, ps: 1 } } ] };
  assert.equal(expandResultStreamline(t, original), original);
  for (const quantityKey of ["Bv", "Av"]) assert.equal(expandResultStreamline(task({ targ: 3, indAmp: 0 }), line(quantityKey)).paths.length, 2);
});

test("a curve crossing elements is copied only under a common transform and field sign", () => {
  for (const second of [
    { ...record, id: 2, recordIndex: 1 },
    { ...record, id: 2, recordIndex: 1, symYa: 120 },
    { ...record, id: 2, recordIndex: 1, symKya: 1 },
  ]) {
    const t = task({}); t.elements.push(second);
    const original = line(); original.paths.push({ ...path(), source: { schemaId: "elements", recordIndex: 1 } });
    const expanded = expandResultStreamline(t, original);
    assert.equal(expanded.starts.length, second.symYa === 90 && second.symKya === -1 ? 4 : 2);
    assert.ok(expanded.paths.every(p => p.source.recordIndex === 0 || p.source.recordIndex === 1));
  }
});

test("copy limits preserve the original curve and seed and preflight huge symmetry tables", () => {
  const original = line();
  const limited = expandResultStreamline(task(), original, { images: 2, points: 100 });
  assert.equal(limited.starts.length, 2); assert.ok(limited.notice);
  const points = expandResultStreamline(task(), original, { images: 100, points: 4 });
  assert.equal(points.starts.length, 1); assert.equal(points.paths[0], original.paths[0]); assert.ok(points.notice);
  const huge = expandResultStreamline(task({ symAs: 1e8 }), original);
  assert.equal(huge.starts.length, 1); assert.ok(huge.notice);
  const errored = { ...original, error: "no data" }; assert.equal(expandResultStreamline(task(), errored), errored);
});
