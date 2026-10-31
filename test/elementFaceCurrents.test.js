import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import h5wasm from "h5wasm/node";
import { Hdf5ResultFile } from "../src/services/results/hdf5ResultFile.js";
import { elementFaceCurrents } from "../src/services/results/elementFaceCurrents.js";

const corners = fn => Array.from({ length: 8 }, (_, i) => fn(i & 1, (i >> 1) & 1, (i >> 2) & 1));
const cube = corners((x, y, z) => [x, y, z]);
const conductor = (dp, extra = {}) => ({ id: 1, recordIndex: 0, targ: 0, rv: 1,
  geoType: 0, geo: cube, dp, symLs: 1, symAs: 1, symPs: 1, symKya: 0, symKyp: 0, ...extra });
const model = (...elements) => ({ elements, general: { timeStep: 1, countTimeSteps: 2 }, moves: [] });
const close = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((v, i) => {
    if (expected[i] === null) assert.equal(v, null);
    else assert.ok(typeof v === "number" && Math.abs(v - expected[i]) < 1e-10, `column ${i}: ${v} != ${expected[i]}`);
  });
};
function je(numbs, current) {
  let offset = 1;
  const inds1 = numbs.map(count => { const start = offset; offset += count; return start; });
  return {
    header: { inds1, numbs }, steps: [{ index: 0 }, { index: 1 }, { index: 2 }],
    read({ step, start, count }) {
      const values = new Float64Array(count * 9);
      for (let i = 0; i < count; i++) values.set([0, 0, 0, ...current(start + i, step), 99, 98, 97], 9 * i);
      return { values, stride: 9 };
    },
  };
}
function single(dp, field, extra = {}) {
  const task = model(conductor(dp, extra));
  return elementFaceCurrents(je([dp.reduce((a, b) => a * b)], field), task, 0)[0].images[0].values;
}

test("all nine signed sections use local directions on an oblique hexahedron", () => {
  const geo = corners((x, y, z) => [2 * x + y, 3 * y, 4 * z]);
  // Positive area vectors are (12,-4,0), (0,8,0) and (0,0,6).
  close(single([3, 3, 3], () => [1, 2, -3], { geo }), [4,4,4, 16,16,16, -18,-18,-18, 0,76]);
});

test("tapered first, last and lower central layers use their own mid-surfaces", () => {
  const geo = corners((x, y, z) => [6 * x, (1 + x) * y, (1 + 2 * x) * z]);
  const area = x => (1 + x) * (1 + 2 * x);
  const flux = single([4, 3, 3], () => [1, 0, 0], { geo });
  close(flux.slice(0, 3), [area(1/8), area(7/8), area(3/8)]);
  close(single([1, 3, 3], () => [1, 0, 0], { geo }).slice(0, 3), [area(1/2), null, null]);
});

test("the two unsigned counterflows on a single section add before face cancellation", () => {
  const flux = single([3, 3, 3], i => [[3, 0, -3][Math.floor(i / 3) % 3], 0, 0]);
  close(flux, [0,0,0, 0,0,0, 0,0,0, 0,4]);
});

test("singleton and two-layer axes keep one and two real values, respectively", () => {
  close(single([1, 2, 4], i => [1, 2, (i % 4) + 1]), [1,null,null, 2,2,null, 1,4,2, null,null]);
  for (const length of [100, 2000]) {
    const geo = corners((x, y, z) => [length * x, 2 * y, 3 * z]);
    close(single([1, 3, 3], () => [1, 0, 0], { geo }), [6,null,null, 0,0,0, 0,0,0, null,null]);
  }
});

test("independent LS and geometric AS/PS retain distinct currents; field AS/PS and mirrors contribute only their original", () => {
  for (const kya of [0, 1, -1]) for (const kyp of [0, 1, -1]) {
    const na = kya === 0 ? 3 : 1, np = kyp === 0 ? 2 : 1, copies = 2 * na * np;
    const target = conductor([1,2,1], { id: 2, recordIndex: 1, symLs: 2, symYl: 90, symAs: 3, symYa: 60,
      symPs: 2, symTx: 17, symKya: kya, symKyp: kyp });
    const task = model(conductor([1,1,1], { targ: 2 }), target);
    task.general.mirrorSymmetryX = 1; task.general.mirrorSymmetryY = 0;
    const file = je([1, 2 * copies], i => {
      if (i === 0) return [1000,1000,1000]; // Prescribed current in the JE header.
      const image = (i - 1) % copies, ls = Math.floor(image / (na * np));
      const j = image + 1 + 100 * Math.floor((i - 1) / copies);
      return ls === 0 ? [0, j, 0] : [0, 0, j];
    });
    const groups = elementFaceCurrents(file, task, 0);
    assert.deepEqual(groups.map(group => group.id), [2]);
    assert.equal(groups[0].images.length, copies);
    for (const [i, image] of groups[0].images.entries()) {
      assert.deepEqual([image.ls, image.as, image.ps], [1 + Math.floor(i / (na*np)), 1 + Math.floor(i/np)%na, 1+i%np]);
      close(image.values, [0,null,null, i+1,i+101,null, 0,null,null, null,null]);
    }
  }
});

test("face geometry follows the selected step of a moving element", () => {
  const task = model(conductor([3,3,3], { indMove: 1, symVi: [[0],[0],[0]], symR0: [[0],[0],[0]] }));
  task.moves = [{ angle: [[0,0,0,0],[1,0,0,90]], position: [[0,0,0,0],[1,120,5,7]] }];
  const file = je([27], () => [0,1,0]);
  close(elementFaceCurrents(file, task, 0)[0].images[0].values, [0,0,0, 1,1,1, 0,0,0, 0,2]);
  close(elementFaceCurrents(file, task, 1)[0].images[0].values, [1,1,1, 0,0,0, 0,0,0, 0,2]);
});

test("missing steps, inconsistent JE layouts and nonfinite currents are diagnosed", () => {
  const task = model(conductor([1,1,1]));
  assert.throws(() => elementFaceCurrents(je([1], () => [0,0,0]), task, 7), /нет данных для шага 7/);
  assert.throws(() => elementFaceCurrents(je([2], () => [0,0,0]), task, 0), /сетка объекта №1/);
  assert.throws(() => elementFaceCurrents(je([1], () => [NaN,0,0]), task, 0), /ШГ №1/);
});

for (const Type of [Float32Array, Float64Array]) {
  test(`real JE ${Type.name} reads the selected saved step in bounded slices`, async () => {
    await h5wasm.ready;
    const dir = await mkdtemp(join(tmpdir(), "clark-face-currents-"));
    const path = join(dir, "JE.h5"), n = 16385;
    let handle;
    try {
      handle = new h5wasm.File(path, "w");
      const header = handle.create_group("HEADER");
      for (const [key,value] of Object.entries({ columns:3, arrCount:2, hasCoo:1 })) {
        header.create_dataset({ name:key, data:BigInt64Array.of(BigInt(value)), shape:[] });
      }
      header.create_dataset({ name:"inds1", data:BigInt64Array.of(1n) });
      header.create_dataset({ name:"numbs", data:BigInt64Array.of(BigInt(n)) });
      for (const step of [0,2]) {
        const data = new Type(n * 9);
        for (let i = 0; i < n; i++) data.set([0.5, (i+0.5)/n, 0.5, step, 0, 0, 999, 0, 0], 9*i);
        handle.create_dataset({ name:String(step).padStart(6,"0"), data, shape:[n,9] });
      }
      handle.close(); handle = new h5wasm.File(path, "r");
      const file = new Hdf5ResultFile("JE", handle), read = file.read.bind(file), requests = [];
      file.read = req => { requests.push(req); return read(req); };
      const task = model(conductor([1,n,1]));
      close(elementFaceCurrents(file, task, 2)[0].images[0].values, [2,null,null, 0,0,0, 0,null,null, null,null]);
      assert.deepEqual(requests.map(r => [r.start, r.count, r.step]), [[0,16384,2],[16384,1,2]]);
    } finally { handle?.close(); await rm(dir, { recursive:true, force:true }); }
  });
}
