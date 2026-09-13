import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import h5wasm from "h5wasm/node";
import { Hdf5ResultFile } from "../src/services/results/hdf5ResultFile.js";
import { checkReadRange, decodeHeader } from "../src/services/results/resultLayout.js";
import { elementLayout, regionLayout, mapResultObjects, QUANTITIES, virtualLayout } from "../src/services/results/resultMappings.js";
import { lineSeries, scalarAt, surfaceGrid, regionSurfaceGrid, vectorScene } from "../src/services/results/resultPlots.js";
import { formatResultVectorTooltip, resultHitVector } from "../src/services/visualization/geometryPicking.js";
import { normalizeTaskInput } from "../src/services/taskLoadService.js";

// The fixture uses the on-disk order produced by Julia resWrite: each point
// has xyz, then Mxyz, then Hxyz. Unequal dimensions expose accidental transpose.
async function fixture(Type, body, options = {}) {
  await h5wasm.ready;
  const directory = await mkdtemp(join(tmpdir(), "clark-viewer-test-"));
  const path = join(directory, "MH.h5");
  let handle;
  try {
    handle = new h5wasm.File(path, "w");
    const header = handle.create_group("HEADER");
    for (const [name, value] of Object.entries({ columns: 3n, arrCount: 2n, hasCoo: 1n })) {
      header.create_dataset({ name, data: new BigInt64Array([value]), shape: [] });
    }
    header.create_dataset({ name: "inds1", data: new BigInt64Array([1n, 3n]) });
    header.create_dataset({ name: "numbs", data: new BigInt64Array([2n, 2n]) });
    if (!options.empty) for (const step of [0, 2, 12]) {
      const data = new Type(Array.from({ length: 4 * 9 }, (_, i) => step * 1000 + Math.floor(i / 9) * 100 + i % 9 + .25));
      handle.create_dataset({ name: String(step).padStart(6, "0"), data, shape: options.badShape ? [9, 4] : [4, 9] });
    }
    handle.close(); handle = new h5wasm.File(path, "r");
    await body(handle);
  } finally { handle?.close(); await rm(directory, { recursive: true, force: true }); }
}

for (const Type of [Float32Array, Float64Array]) {
  test(`Real HDF5 ${Type.name}: component order, sparse steps, point history`, async () => fixture(Type, handle => {
    const file = new Hdf5ResultFile("MH", handle);
    assert.deepEqual(file.steps.map(x => x.index), [0, 2, 12]);
    assert.deepEqual(file.header.inds1, [1, 3]);
    const frame = file.read({ step: 2, start: 1, count: 2 });
    assert.ok(frame.values instanceof Type);
    assert.deepEqual(Array.from(frame.values.slice(0, 9)), [2100.25, 2101.25, 2102.25, 2103.25, 2104.25, 2105.25, 2106.25, 2107.25, 2108.25]);
    assert.equal(scalarAt(frame, 1, QUANTITIES.H, "2"), 2208.25);
    const sampled = file.read({ step: 0, start: 0, count: 4, every: 2 });
    assert.equal(sampled.count, 2); assert.equal(sampled.values[9], 200.25);
    const history = file.history({ point: 3 });
    assert.deepEqual(history.steps, [0, 2, 12]);
    assert.deepEqual([history.values[3], history.values[12], history.values[21]], [303.25, 2303.25, 12303.25]);
    assert.throws(() => file.read({ step: 1, start: 0, count: 1 }), /нет данных/);
    assert.throws(() => file.read({ step: 0, start: 3, count: 2 }), /границы/);
  }));
}

test("Reject Julia shape mistaken for HDF5 shape; empty result remains empty", async () => {
  await fixture(Float64Array, handle => assert.throws(() => new Hdf5ResultFile("MH", handle), /форма/), { badShape: true });
  await fixture(Float64Array, handle => {
    const file = new Hdf5ResultFile("MH", handle);
    assert.deepEqual(file.steps, []);
    assert.throws(() => file.read({ step: 0, start: 0, count: 1 }), /нет данных/);
  }, { empty: true });
});

test("Unsafe Int64 indices rejected; sparse large-file selection uses output memory", () => {
  assert.throws(() => decodeHeader({ columns: 3, arrCount: 2, hasCoo: 1,
    inds1: new BigInt64Array([9007199254740993n]), numbs: [1] }), /целое/);
  assert.doesNotThrow(() => checkReadRange(0, 2_000_000, 2_000_000, 9, 2000));
  assert.throws(() => checkReadRange(0, 2_000_000, 2_000_000, 9), /64 МБ/);
});

const base = { name: "Элемент", targ: 0, rv: 0, xapName: "", dp: [[1], [1], [1]], symLs: 1, symAs: 1, symPs: 1, symKya: 0, symKyp: 0 };
test("Header indices follow filtered input order and source symmetry counts", () => {
  const records = [{ ...base, id: 1, targ: 2 }, { ...base, id: 2, xapName: "сталь", symAs: 4, symKya: 1 },
    { ...base, id: 3, targ: 3 }, { ...base, id: 4, targ: 1, dp: [[2], [1], [1]] }];
  const header = decodeHeader({ columns: 3, arrCount: 2, hasCoo: true, inds1: [1, 2], numbs: [1, 2] });
  const objects = mapResultObjects({ elements: records, regions: [] }, "MH", header);
  assert.deepEqual(objects.map(x => [x.record.id, x.start, x.count]), [[2, 0, 1], [4, 1, 2]]);
  assert.throws(() => mapResultObjects({ elements: records.slice(1, 3), regions: [] }, "MH", header), /число объектов/);
});

test("Virtual surface slices preserve innermost geometric copies and indAmp orientation", () => {
  const record = { ...base, targ: 3, dp: [[2], [3], [4]], indAmp: 1, symAs: 2, symKya: 1 };
  const layout = virtualLayout(record);
  assert.deepEqual(layout.dimensions, [4, 3, 2]); assert.equal(layout.copyCount, 2);
  const values = new Float64Array(4 * 3 * 2 * 2 * 6);
  // Fill the file in the independently specified nested solver order.
  let offset = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 2; k++) for (let image = 0; image < 2; image++) {
    values.set([i, j, k, 1000 * image + 100 * i + 10 * j + k, 0, 0], offset); offset += 6;
  }
  const grid = surfaceGrid({ values, stride: 6 }, record, QUANTITIES.Bv, "0", 2, 1, 1);
  assert.deepEqual([grid.width, grid.height], [4, 3]);
  assert.deepEqual(Array.from(grid.values), [1001, 1011, 1021, 1101, 1111, 1121, 1201, 1211, 1221, 1301, 1311, 1321]);
  assert.deepEqual(Array.from(grid.coordinates.slice(-3)), [3, 2, 1]);
});

test("Line copies are disconnected; B has no extra scaling and A converts once", () => {
  const record = { ...base, id: 1, dp: [[1], [2]], symLs: 2 };
  const frame = { stride: 6, count: 4, values: new Float64Array([0,0,0,3,4,0, 3,4,0,0,0,2, 100,0,0,1,0,0, 100,0,12,0,2,0]) };
  const lines = lineSeries(frame, record, QUANTITIES.Bs, "norm");
  assert.deepEqual(lines.map(x => x.points.map(p => p.x)), [[1, 2], [1, 2]]);
  assert.equal(lines[0].points[0].y, 5);
  assert.ok(Math.abs(scalarAt(frame, 0, QUANTITIES.As, "norm") - 5 * 4 * Math.PI * 1e-7) < 1e-20);
});

test("Area lines follow either node index and never cross LS or fixed indices", () => {
  const record = { ...base, id: 7, dp: [[2], [3]], symLs: 2 };
  const rows = [];
  for (let ls = 0; ls < 2; ls++) for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) rows.push(i, j, ls, 100 * ls + 10 * i + j, 0, 0);
  const frame = { stride: 6, count: 12, values: new Float64Array(rows) };
  const along1 = lineSeries(frame, record, QUANTITIES.Bs, "0", "i1");
  assert.deepEqual(along1.map(s => s.points.map(p => p.y)), [[0,10], [1,11], [2,12], [100,110], [101,111], [102,112]]);
  assert.deepEqual(along1[4].points.map(p => p.x), [1,2]);
  assert.match(along1[4].label, /LS 2 · i2=2/);
  assert.match(along1[4].tooltip(along1[4].points[1]).join(" "), /XYZ = \(1, 1, 1\)/);
  const along2 = lineSeries(frame, record, QUANTITIES.Bs, "0", "i2");
  assert.deepEqual(along2.map(s => s.points.map(p => p.y)), [[0,1,2], [10,11,12], [100,101,102], [110,111,112]]);
  const second = { ...record, id: 8, dp: [[3], [2]], symLs: 1 };
  assert.equal(lineSeries({ ...frame, count: 6, values: frame.values.slice(0,36) }, second, QUANTITIES.Bs, "0", "i1").length, 2);
  const layout = regionLayout(record);
  const block = { stride: 6, count: layout.planeCount, values: frame.values.slice(36) };
  const grid = regionSurfaceGrid(block, record, QUANTITIES.Bs, "0", 1);
  assert.deepEqual([grid.width, grid.height, grid.copy], [2,3,1]);
  assert.deepEqual(Array.from(grid.values), [100,101,102,110,111,112]);
  assert.deepEqual(Array.from(grid.coordinates.slice(-3)), [1,2,1]);
  assert.throws(() => regionSurfaceGrid({ ...block, count: 3 }, { ...record, dp: [[1],[3]] }, QUANTITIES.Bs, "0"), /два узла/);
});

test("Saved element indices account for independent and geometric symmetry counts", () => {
  const record = { ...base, dp: [[2],[3],[4]], symLs: 2, symAs: 3, symPs: 2 };
  const layout = elementLayout(record);
  let row = 0;
  for (let i1 = 0; i1 < 2; i1++) for (let i2 = 0; i2 < 3; i2++) for (let i3 = 0; i3 < 4; i3++)
    for (let ls = 0; ls < 2; ls++) for (let as = 0; as < 3; as++) for (let ps = 0; ps < 2; ps++) {
      assert.deepEqual(layout.indices(row++), { i1,i2,i3,ls,as,ps });
    }
  assert.equal(row, layout.count);
  const independent = elementLayout({ ...record, symKya: -1, symKyp: 1 });
  assert.deepEqual(independent.copies, [2,1,1]);
  assert.deepEqual(independent.indices(47), { i1:1,i2:2,i3:3,ls:1,as:0,ps:0 });
  assert.throws(() => independent.indices(48), /вне сетки/);
});

test("3D tooltip maps vector sticks to saved nodes and retains zero nodes", () => {
  const record = { ...base, id: 1, recordIndex: 0, dp: [[2],[1],[1]] };
  const frame = { stride: 9, count: 2, values: new Float64Array([1.123456789,2,3, 0,0,0, 0,0,0, 4,5,6, 3,4,0, 0,0,0]) };
  const scene = vectorScene([{ frame, record }], QUANTITIES.M);
  assert.equal(scene.vectors.length, 2);
  assert.equal(scene.vectors[0].magnitude, 0);
  const object = { userData: { resultVectors: scene.vectors } };
  assert.equal(resultHitVector({ object, index: 0 }), scene.vectors[0]);
  assert.equal(resultHitVector({ object, index: 2 }), scene.vectors[1]);
  assert.equal(resultHitVector({ object: { ...object, isPoints: true }, index: 0 }), scene.vectors[0]);
  const text = formatResultVectorTooltip(scene.vectors[1]);
  assert.equal(text, "X=4; Y=5; Z=6 мм\nНамагниченность M: (3; 4; 0) кА/м");
  assert.equal(resultHitVector({ object, index: 4 }), null);
});

test("Input adapter preserves column-major MHJ and motion tables", () => {
  const data = normalizeTaskInput({ general: { countTimeSteps: 2, timeStep: .1 }, elements: [], regions: [], amps: [],
    moves: [{ angle: [0,1, 10,11, 20,21, 30,31], position: [0,1, 2,3, 4,5, 6,7] }],
    mhj: [{ v: [1,2, 3,4, 5,6] }] });
  assert.deepEqual(data.moves[0].angle, [[0,10,20,30], [1,11,21,31]]);
  assert.deepEqual(data.mhj[0].v, [[1,3,5], [2,4,6]]);
});
