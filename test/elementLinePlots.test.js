import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import h5wasm from "h5wasm/node";
import { Hdf5ResultFile } from "../src/services/results/hdf5ResultFile.js";
import { ELEMENT_LINE_CHANNEL, defaultElementLine, elementLineObjects, elementLineRequest,
  elementLineDistances, readElementLineProfile } from "../src/services/results/elementLinePlots.js";
import { plotChannels, expandPlotComponents, readPlotCurves, validatePlotCurve, isSingleTimePlot } from "../src/services/results/plotConstructor.js";
import { QUANTITIES, elementLayout } from "../src/services/results/resultMappings.js";
import { chartTableText } from "../src/services/visualization/chartTable.js";

const record = { id: 7, recordIndex: 1, name: "Лента", targ: 0, model: 2, xapName: "HTS", rv: 1,
  dp: [[4], [3], [5]], symLs: 2, symAs: 3, symPs: 2, symKya: 0, symKyp: 0 };
const axes = [[0, .2, 1.4, 3.1], [0, .9, 2.7], [0, .3, 1.5, 2.6, 4.2]];
const channel = key => ({ key: `field:${key}`, kind: "field", ...QUANTITIES[key], quantity: QUANTITIES[key] });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

// Independent on-disk order: i1/i2/i3/LS/AS/PS; spatial axes are rotated,
// translated and nonuniform. A known-current object precedes the tested tape.
async function fixture(body) {
  await h5wasm.ready;
  const directory = await mkdtemp(join(tmpdir(), "clark-element-line-"));
  let handle;
  try {
    const path = join(directory, "JE.h5");
    handle = new h5wasm.File(path, "w");
    const header = handle.create_group("HEADER");
    for (const [key, value] of Object.entries({ columns: 3n, arrCount: 2n, hasCoo: 1n }))
      header.create_dataset({ name: key, data: new BigInt64Array([value]), shape: [] });
    header.create_dataset({ name: "inds1", data: new BigInt64Array([1n, 2n]) });
    header.create_dataset({ name: "numbs", data: new BigInt64Array([1n, 720n]) });
    const rows = [];
    for (const step of [0, 2, 5]) {
      const data = [Array(9).fill(0)];
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 5; k++)
        for (let ls = 0; ls < 2; ls++) for (let az = 0; az < 3; az++) for (let ps = 0; ps < 2; ps++) {
          const [x, y, z] = [axes[0][i], axes[1][j], axes[2][k]];
          const point = [100 + 3 * x - 4 * y + ls * 100, 200 + 4 * x + 3 * y + az * 100, -30 + 2 * z + ps * 100];
          const value = step * 10000 + i * 100 + j * 10 + k + ls * 1000 + az * 100 + ps * 10;
          data.push([...point, value, -2 * value, 3 * value, 1, 2, 3]);
          if (step === 2) rows.push({ i, j, k, ls, az, ps, point, value, row: data.length - 1 });
        }
      handle.create_dataset({ name: String(step).padStart(6, "0"), data: new Float64Array(data.flat()), shape: [721, 9] });
    }
    handle.close(); handle = new h5wasm.File(path, "r");
    const file = new Hdf5ResultFile("JE", handle), reads = [];
    const task = { general: { countTimeSteps: 5, timeStep: .25 }, elements: [
      { id: 1, targ: 2, dp: [1, 1, 1] }, record], metadata: { JE: file.metadata },
      reader: { read: async request => { reads.push(request); return file.read(request); } } };
    await body(task, reads, rows);
  } finally { handle?.close(); await rm(directory, { recursive: true, force: true }); }
}

test("real HDF5: every direction reads only its row, preserving all three saved image indices", async () => fixture(async (task, reads, rows) => {
  const indices = [3, 2, 4], copies = [2, 3, 2];
  for (let direction = 0; direction < 3; direction++) {
    const profile = await readElementLineProfile(task, channel("J"), { element: 7, direction, indices, copies }, { step: 2, component: "0" });
    const expected = rows.filter(row => [row.i, row.j, row.k].every((v, a) => a === direction || v === indices[a] - 1)
      && row.ls === 1 && row.az === 2 && row.ps === 1);
    assert.deepEqual(profile.points.map(p => p.y), expected.map(p => p.value));
    assert.deepEqual(profile.points.map(p => p.position), expected.map(p => p.point));
    assert.deepEqual(profile.points.map(p => p.volumeNumber), expected.map(p => p.row + 1));
    const distances = axes[direction].map(v => v * (direction === 2 ? 2 : 5));
    profile.points.forEach((p, i) => close(p.x, distances[i]));
    assert.equal(profile.points[0].x, 0); close(profile.length, distances.at(-1));
    assert.ok(profile.points.every(p => p.step === 2 && p.time === .5));
    assert.match(profile.annotations.join(" "), /начало.*Конец.*L=/);
    assert.equal(reads.at(-1).count, (expected.length - 1) * reads.at(-1).every + 1);
  }
  assert.equal(reads.length, 3);
}));

test("components share one slice; fixed-time and cross-task profiles retain distances in table export", async () => fixture(async (task, reads) => {
  const yChannel = plotChannels(task).find(c => c.key === "field:J");
  const selection = { element: 7, direction: 2, indices: [1, 2, 1], copies: [1, 1, 1], lineLabel: "Лента" };
  const curve = { id: "line", xChannel: ELEMENT_LINE_CHANNEL, yChannel,
    x: selection, y: { profile: true, step: 2, time: .5 }, taskLabel: "Проект/Лента" };
  assert.doesNotThrow(() => validatePlotCurve(curve));
  const curves = expandPlotComponents(curve), result = await readPlotCurves(task, curves);
  assert.equal(result.error, ""); assert.equal(reads.length, 1); assert.equal(result.series.length, 3);
  const x = result.series[0].points.map(p => p.y);
  assert.deepEqual(result.series[1].points.map(p => p.y), x.map(v => -2 * v));
  assert.deepEqual(result.series[2].points.map(p => p.y), x.map(v => 3 * v));
  const text = chartTableText(result.series, "Расстояние, мм", "J, А/мм²");
  assert.equal(text.split("\n")[1].split("\t")[0], "0");
  close(Number(text.split("\n").at(-1).split("\t")[0]), 8.4);
  assert.equal(isSingleTimePlot({ ...task, general: { countTimeSteps: 0 } }, curves), false);
  const other = { ...task, general: { countTimeSteps: 5, timeStep: 2 } };
  const compared = await readPlotCurves(task, [{ ...curves[0], yTask: other, y: { ...curves[0].y, step: 5, time: 10 } }]);
  assert.equal(compared.error, ""); assert.ok(compared.series[0].points.every(p => p.time === 10));
  assert.ok(compared.series[0].points[0].y > 50000);
}));

test("UI defaults use middle transverse indices and a non-singleton direction without inventing averages", () => {
  assert.deepEqual(defaultElementLine(record, channel("J")), { element: 7, direction: 2, indices: [2, 2, 3], copies: [1, 1, 1] });
  const flat = { ...record, dp: [4, 1, 5], symAs: 9, symPs: 7, symKya: 1, symKyp: -1 };
  assert.deepEqual(elementLayout(flat).copies, [2, 1, 1]);
  assert.deepEqual(defaultElementLine(flat, channel("J"), { direction: 1, indices: [4, 2, 0] }).indices, [4, 1, 3]);
});

test("unavailable objects, steps and invalid transverse/copy indices fail before any file read", async () => fixture(async (task, reads) => {
  const spec = { element: 7, direction: 2, indices: [1, 1, 1], copies: [1, 1, 1] };
  assert.deepEqual(elementLineObjects(task, channel("E")).map(o => o.record.id), [7]);
  assert.deepEqual(elementLineObjects(task, channel("J")).map(o => o.record.id), [1, 7]);
  for (const delta of [{ element: 99 }, { direction: 3 }, { indices: [0, 1, 1] }, { indices: [1.5, 1, 1] },
    { indices: [1, 4, 1] }, { copies: [1, 4, 1] }]) assert.throws(() => elementLineRequest(task, channel("J"), { ...spec, ...delta }, 2));
  assert.throws(() => elementLineRequest(task, channel("J"), spec, 1), /сохранённого/);
  assert.throws(() => elementLineRequest(task, channel("J"), { ...spec, element: 1 }, 2), /только один/);
  assert.throws(() => elementLineObjects(task, channel("Bs")), /локальную/);
  assert.throws(() => validatePlotCurve({ xChannel: ELEMENT_LINE_CHANNEL, yChannel: { kind: "loss" } }), /локальную/);
  assert.equal(reads.length, 0);
}));

test("virtual reordered dimensions and all saved images use the existing HV/AV layout", () => {
  const virtual = { ...record, targ: 3, indAmp: 1, symKya: 1, symKyp: -1 };
  const task = { elements: [virtual], metadata: { HV: { header: { numbs: [720], inds1: [1], stride: 6 }, steps: [{ index: 0 }] } } };
  const result = elementLineRequest(task, channel("Bv"), { element: 7, direction: 0, indices: [1, 2, 4], copies: [2, 3, 2] }, 0);
  assert.deepEqual(result.layout.dimensions, [5, 3, 4]); assert.deepEqual(result.layout.copies, [2, 3, 2]);
  assert.equal(result.length, 5); assert.equal(result.request.start, 95); assert.equal(result.request.every, 144);
});

test("distance is measured on saved centres; curved, reversing, coincident and invalid rows are rejected", () => {
  const straight = [[10, 20, 30], [9.4, 19.2, 30], [7, 16, 30]];
  const result = elementLineDistances(straight); result.distances.forEach((v, i) => close(v, [0, 1, 5][i]));
  close(result.length, 5);
  for (const positions of [[[0, 0, 0], [0, 1, 0], [1, 1, 0]], [[0, 0, 0], [2, 0, 0], [1, 0, 0]],
    [[1, 1, 1], [1, 1, 1]], [[0, 0, 0], [NaN, 1, 2]]]) assert.throws(() => elementLineDistances(positions));
});

test("derived losses and relative conductivity reuse display units and retain undefined sigma as gaps", async () => fixture(async task => {
  const selection = { element: 7, direction: 2, indices: [1, 2, 1], copies: [1, 1, 1] };
  const j = await readElementLineProfile(task, channel("J"), selection, { step: 2, component: "0" });
  const loss = await readElementLineProfile(task, channel("JEdot"), selection, { step: 2 });
  loss.points.forEach((p, i) => close(p.y, j.points[i].y * 6e-3));
  const handle = { getDirectoryHandle: async () => handle, getFileHandle: async () => ({ getFile: async () => ({ text: async () => '{"j_gmin":10}' }) }) };
  task.handle = handle;
  const sigma = await readElementLineProfile(task, channel("sigmaRelative"), selection, { step: 2 });
  sigma.points.forEach((p, i) => close(p.y, j.points[i].y / 10));
  const rawReader = task.reader;
  task.reader = { read: async request => { const frame = await rawReader.read(request); frame.values.fill(0, 6, 9); return frame; } };
  const gap = await readElementLineProfile(task, channel("sigmaRelative"), selection, { step: 2 });
  assert.equal(gap.points[0].y, null); assert.ok(Number.isFinite(gap.points[1].y));
  assert.match(gap.tooltip(gap.points[0]).join(" "), /не определено/);
}));

test("one failed profile preserves successful curves and reports the failure", async () => fixture(async task => {
  const curve = { id: "good", xChannel: ELEMENT_LINE_CHANNEL, yChannel: channel("J"),
    x: { element: 7, direction: 2, indices: [1, 1, 1], copies: [1, 1, 1] }, y: { step: 2, component: "0" } };
  const result = await readPlotCurves(task, [curve, { ...curve, id: "missing", y: { ...curve.y, step: 3 } }]);
  assert.deepEqual(result.series.map(s => s.key), ["good"]); assert.match(result.error, /Кривая 2.*сохранённого/);
}));
