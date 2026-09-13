import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import h5wasm from "h5wasm/node";
import { Hdf5ResultFile } from "../src/services/results/hdf5ResultFile.js";
import { decodeHeader } from "../src/services/results/resultLayout.js";
import { QUANTITIES } from "../src/services/results/resultMappings.js";
import { readObjectFrames, resultObjects } from "../src/services/results/resultRequests.js";
import { scalarAt, scalarScene } from "../src/services/results/resultPlots.js";
import { resultScalarColor, RESULT_SCALAR_GRADIENT } from "../src/services/visualization/resultScalarColors.js";
import { formatResultScalarTooltip, resultHitScalar } from "../src/services/visualization/geometryPicking.js";

const material = { id: 1, recordIndex: 0, name: "Сталь", targ: 0, model: 0, rv: 1,
  xapName: "Сталь", dp: [[3], [1], [1]], symLs: 1, symAs: 1, symPs: 1, symKya: 0, symKyp: 0 };
// Nonparallel, opposite and perpendicular vectors distinguish signed dot
// products from products of lengths, absolute values and accidental offsets.
const rows = [
  [11, 12, 13, 2, 3, 0, 1, 0, 4],
  [21, 22, 23, -2, 3, 0, 4, -1, 0],
  [31, 32, 33, 1, 0, 0, 0, 9, 0],
];
const frame = { count: 3, stride: 9, every: 1, values: new Float64Array(rows.flat()) };

test("Derived quantities use signed vector products and the saved component units", () => {
  for (const key of ["MHdot", "JEdot"]) {
    assert.deepEqual(rows.map((_, row) => scalarAt(frame, row, QUANTITIES[key])), [2, -11, 0]);
    assert.equal(scalarAt(frame, 0, QUANTITIES[key], "2"), 2);
  }
  assert.equal(QUANTITIES.MHdot.unit, "(кА/м)²");
  assert.equal(QUANTITIES.JEdot.unit, "МВт/м³");
  // A/mm² × V/m = MW/m³ numerically: neither a second 10^6 nor µ0 applies.
  const unitFrame = { count: 1, stride: 9, values: new Float64Array([0, 0, 0, 1, 0, 0, 1, 0, 0]) };
  assert.equal(scalarAt(unitFrame, 0, QUANTITIES.MHdot), 1);
  assert.equal(scalarAt(unitFrame, 0, QUANTITIES.JEdot), 1);
});

function metadata(counts) {
  let start = 1;
  return { header: decodeHeader({ columns: 3, arrCount: 2, hasCoo: 1, numbs: counts,
    inds1: counts.map(count => { const first = start; start += count; return first; }) }),
  steps: [{ key: "000000", index: 0 }] };
}

test("FMM filtering keeps original MH ranges around magnets and HTC materials", () => {
  const elements = [
    { ...material, id: 1, targ: 1, dp: [[2], [1], [1]] },
    { ...material, id: 2 },
    { ...material, id: 3, model: 2, dp: [[1], [1], [1]] },
    { ...material, id: 4, model: undefined, dp: [[2], [1], [1]] },
    { ...material, id: 5, xapName: "" },
  ];
  const task = { elements, regions: [], metadata: { MH: metadata([2, 3, 1, 2]) } };
  assert.deepEqual(resultObjects(task, "MHdot").map(object => [object.record.id, object.start, object.count]),
    [[2, 2, 3], [4, 6, 2]]);
});

test("Conduction losses use solved JE objects without shifting ranges past prescribed coils", () => {
  const elements = [
    { ...material, id: 1, targ: 2, dp: [[2], [1], [1]] },
    { ...material, id: 2 },
    { ...material, id: 3, model: 2, dp: [[1], [1], [1]] },
    { ...material, id: 4, rv: 0 },
  ];
  const task = { elements, regions: [], metadata: { JE: metadata([2, 3, 1]) } };
  assert.deepEqual(resultObjects(task, "JEdot").map(object => [object.record.id, object.start, object.count]),
    [[2, 2, 3], [3, 5, 1]]);
});

test("Scalar scenes retain saved coordinates, signed extrema and sampled symmetry indices", () => {
  const record = { ...material, dp: [[2], [1], [1]], symLs: 3, symAs: 2, symPs: 2 };
  const sampled = { ...frame, every: 3, rowIndices: new Float64Array([7, 12, 20]) };
  const scene = scalarScene([{ frame: sampled, record }], QUANTITIES.MHdot);
  assert.deepEqual(scene.points.map(point => point.origin), rows.map(row => row.slice(0, 3)));
  assert.deepEqual(scene.points.map(point => point.value), [2, -11, 0]);
  assert.deepEqual(scene.points.map(point => point.instance),
    [{ ls: 1, as: 1, ps: 1 }, { ls: 0, as: 0, ps: 0 }, { ls: 2, as: 0, ps: 0 }]);
  assert.deepEqual([scene.minimum, scene.maximum], [-11, 2]);
  assert.equal(scene.points[0].source.recordIndex, material.recordIndex);
  assert.equal(scene.points[0].source.schemaId, "elements");
  assert.equal(scene.points[0].quantity, "Плотность энергии ФММ (M·H)");
  assert.equal(scene.points[0].unit, QUANTITIES.MHdot.unit);
});

for (const Type of [Float32Array, Float64Array]) {
  test(`Real HDF5 ${Type.name}: MH and JE scalar maps use the requested step without Q`, async () => {
    await h5wasm.ready;
    const directory = await mkdtemp(join(tmpdir(), "e3d-scalar-results-"));
    try {
      for (const [name, quantityKey] of [["MH", "MHdot"], ["JE", "JEdot"]]) {
        let handle;
        try {
          const path = join(directory, `${name}.h5`);
          handle = new h5wasm.File(path, "w");
          const header = handle.create_group("HEADER");
          for (const [key, value] of Object.entries({ columns: 3n, arrCount: 2n, hasCoo: 1n })) {
            header.create_dataset({ name: key, data: new BigInt64Array([value]), shape: [] });
          }
          header.create_dataset({ name: "inds1", data: new BigInt64Array([1n]) });
          header.create_dataset({ name: "numbs", data: new BigInt64Array([3n]) });
          handle.create_dataset({ name: "000000", data: new Type(rows.flat()), shape: [3, 9] });
          // Motion changes coordinates at the same time as the field values.
          const nextRows = rows.map(row => row.map((value, column) => column < 3 ? value + 100
            : column < 6 ? value * 2 : value));
          handle.create_dataset({ name: "000002", data: new Type(nextRows.flat()), shape: [3, 9] });
          handle.close(); handle = new h5wasm.File(path, "r");
          const file = new Hdf5ResultFile(name, handle);
          const requestedFiles = [];
          const task = { elements: [material], regions: [], metadata: { [name]: file.metadata },
            reader: { read(request) { requestedFiles.push(request.name); return file.read(request); } } };
          const frames = await readObjectFrames({ task, quantityKey, selected: [1], time: 2 });
          assert.ok(frames[0].frame.values instanceof Type);
          const scene = scalarScene(frames, QUANTITIES[quantityKey]);
          assert.deepEqual(requestedFiles, [name]);
          assert.deepEqual(scene.points.map(point => point.value), [4, -22, 0]);
          assert.deepEqual(scene.points.map(point => point.origin), nextRows.map(row => row.slice(0, 3)));
          assert.deepEqual([scene.minimum, scene.maximum], [-22, 4]);
        } finally { handle?.close(); }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test("Scalar colors handle signed, constant and clipped ranges with a matching legend", () => {
  const minimum = [68, 1, 84].map(value => value / 255);
  const maximum = [253, 231, 37].map(value => value / 255);
  assert.deepEqual(resultScalarColor(-11, -11, 2), minimum);
  assert.deepEqual(resultScalarColor(2, -11, 2), maximum);
  assert.deepEqual(resultScalarColor(-100, -11, 2), minimum);
  assert.deepEqual(resultScalarColor(100, -11, 2), maximum);
  assert.deepEqual(resultScalarColor(0, 0, 0), [33, 145, 140].map(value => value / 255));
  assert.match(RESULT_SCALAR_GRADIENT, /linear-gradient/);
});

test("Scalar picking reports only saved nodes and keeps zero and negative values", () => {
  const scene = scalarScene([{ frame, record: material }], QUANTITIES.JEdot);
  const object = { isPoints: true, userData: { resultScalars: scene.points } };
  assert.equal(resultHitScalar({ object, index: 1 }), scene.points[1]);
  assert.equal(resultHitScalar({ object, index: 2 }), scene.points[2]);
  for (const index of [-1, 3, 0.5, NaN, undefined]) assert.equal(resultHitScalar({ object, index }), null);
  assert.equal(resultHitScalar({ object: { isPoints: true, userData: {} }, index: 0 }), null);
  assert.equal(resultHitScalar({ object: { isMesh: true, userData: { resultScalars: scene.points } }, index: 0 }), null);
  const tooltip = formatResultScalarTooltip(scene.points[1]);
  assert.match(tooltip, /X=21.*Y=22.*Z=23.*мм\n/);
  assert.match(tooltip, /Потери на токи проводимости.*-11.*МВт\/м³/);
  assert.match(formatResultScalarTooltip(scene.points[2]), /:\s*0\s+МВт\/м³/);
});
