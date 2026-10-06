import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFieldLineComponents, fieldLineComponentSymbol, fieldLineCycleRange, fieldLineChartRange } from "../src/services/results/fieldLineComponents.js";
import { readLineFrame, readSurfaceFrame } from "../src/services/results/resultRequests.js";
import { sameFrameContext, createResultFrameController } from "../src/services/results/resultFrameController.js";
import { MU0 } from "../src/services/results/resultMappings.js";

function fixture(Type = Float64Array) {
  const reads = [];
  const regions = [{ id: 1, name: "A", dp: [[2], [2]], symLs: 2 }, { id: 2, name: "B", dp: [[2], [2]], symLs: 1 }];
  const ranges = key => ({ available: true, state: "complete", runId: "test-run", revision: 1,
    objectIds: [1, 2], channelIds: ["x", "y", "z", "norm"].map(c => `${key}.${c}`),
    channelUnits: Array(4).fill(key === "Bs" ? "T" : "T*m"), stepIds: [0, 1, 2], times: [0, .1, .2],
    minimum: [-9, -6, -36, 0, -90, -60, -360, 0].map(x => key === "Bs" ? x : x * MU0),
    maximum: [-3, 6, -12, 40, -30, 60, -120, 400].map(x => key === "Bs" ? x : x * MU0),
    validCount: [24, 24, 24, 24, 12, 12, 12, 12], invalidCount: Array(8).fill(0) });
  const header = { inds1: [1, 9], numbs: [8, 4] };
  const task = { general: { countTimeSteps: 2, timeStep: .1 }, regions,
    metadata: { HS: { header, steps: [0, 1, 2], ranges: ranges("Bs") }, AS: { header, steps: [0, 1, 2], ranges: ranges("As") } },
    reader: { read: async request => {
      reads.push(request);
      return { stride: 6, count: request.count, every: 1,
        values: new Type(Array.from({ length: request.count }, (_, i) => [request.start + i, 10, 20,
          -3 * (request.step + 1), 4 + i, -12]).flat()) };
    } } };
  const request = { task, quantityKey: "Bs", selected: [1, 2], time: 0, components: ["norm", "0", "1", "2"], direction: "i2", copy: 0, allCopies: false };
  return { task, reads, request };
}

test("line component choices default to norm, preserve empty selection and canonicalize independent checkboxes", () => {
  assert.deepEqual(normalizeFieldLineComponents(), ["norm"]);
  assert.deepEqual(normalizeFieldLineComponents([]), []);
  assert.deepEqual(normalizeFieldLineComponents([2, "0", "norm", "0", 1]), ["norm", "0", "1", "2"]);
  assert.throws(() => normalizeFieldLineComponents(["bad"]), /Неизвестная/);
  assert.throws(() => normalizeFieldLineComponents("norm"), /список/);
  assert.equal(fieldLineComponentSymbol("As", "1"), "Ay");
  assert.equal(fieldLineComponentSymbol("Bs", "norm"), "|B|");
});

for (const Type of [Float32Array, Float64Array]) test(`${Type.name}: four component curves share each HDF5 read and retain signs, norms and tooltip coordinates`, async () => {
  const { request, reads } = fixture(Type);
  const value = await readLineFrame(request);
  assert.equal(reads.length, 2);
  assert.equal(value.series.length, 16); // 2 regions x 2 lines x 4 quantities
  const x = value.series.find(series => series.component === "0");
  const y = value.series.find(series => series.component === "1");
  const z = value.series.find(series => series.component === "2");
  const norm = value.series.find(series => series.component === "norm");
  assert.equal(x.points[0].y, -3); assert.equal(y.points[0].y, 4); assert.equal(z.points[0].y, -12);
  assert.equal(norm.points[0].y, 13);
  assert.match(x.label, /Bx$/);
  assert.match(x.tooltip(x.points[0])[1], /Bx = -3 Тл/);
  assert.match(x.tooltip(x.points[0])[2], /XYZ = \(0, 10, 20\)/);
  assert.deepEqual(request.components, ["norm", "0", "1", "2"]);
});

test("component curves preserve selected and unfolded LS layouts, skip absent copies and change line direction", async () => {
  const { request, reads } = fixture();
  const one = await readLineFrame({ ...request, copy: 1 });
  assert.equal(reads.length, 1); assert.equal(reads[0].start, 4);
  assert.deepEqual(one.skipped, ["№2"]); assert.equal(one.series.length, 8);
  reads.length = 0;
  const all = await readLineFrame({ ...request, allCopies: true, direction: "i1" });
  assert.equal(reads.length, 2); assert.equal(all.series.length, 24);
  assert.ok(all.series.some(series => /LS 2/.test(series.label) && series.points[0].x === 3));
  assert.match(all.series[0].tooltip(all.series[0].points[0])[0], /i1=1; i2=1/);
});

test("empty components produce an empty frame without metadata or worker access; legacy single-component callers still work", async () => {
  const empty = await readLineFrame({ task: { get metadata() { throw new Error("must not read"); } }, quantityKey: "Bs", selected: [1], components: [] });
  assert.deepEqual(empty, { series: [], skipped: [] });
  const { request, reads } = fixture();
  const { components, ...legacy } = request;
  const value = await readLineFrame({ ...legacy, component: "2" });
  assert.equal(reads.length, 2); assert.equal(value.series.length, 4);
  assert.equal(value.series[0].points[0].y, -12);
});

test("A curves convert saved components once, while HDF5 global A bounds remain already converted", async () => {
  const { request, task } = fixture();
  const value = await readLineFrame({ ...request, quantityKey: "As" });
  assert.equal(value.series.find(series => series.component === "0").points[0].y, -3 * MU0);
  assert.equal(value.series.find(series => series.component === "norm").points[0].y, 13 * MU0);
  const range = fieldLineCycleRange(task, "As", [1], ["0"]);
  assert.equal(range.available, true); assert.equal(range.minimum, -9 * MU0); assert.equal(range.maximum, -3 * MU0);
});

test("full-cycle range reduces only selected channels and model objects and is independent of current time", () => {
  const { task } = fixture();
  const combined = fieldLineCycleRange(task, "Bs", [1, 2], ["norm", "1"]);
  assert.equal(combined.available, true); assert.equal(combined.minimum, -60); assert.equal(combined.maximum, 400);
  const one = fieldLineCycleRange(task, "Bs", [1], ["0"]);
  assert.equal(one.minimum, -9); assert.equal(one.maximum, -3);
  const norm = fieldLineCycleRange(task, "Bs", [1], ["norm"]);
  assert.equal(norm.minimum, 0); assert.equal(norm.maximum, 40);
  assert.equal(combined.runId, "test-run"); assert.equal(combined.revision, 1);
  assert.deepEqual(fieldLineChartRange(combined), { minimum: -83, maximum: 423 });
});

test("missing, partial, stale, misordered and damaged global metadata falls back without blocking field viewing", () => {
  for (const change of [
    task => { delete task.metadata.HS.ranges; },
    task => { task.metadata.HS.ranges.state = "partial"; },
    task => { task.metadata.HS.ranges.available = false; task.metadata.HS.ranges.reason = "stale"; },
    task => { task.metadata.HS.ranges.objectIds.reverse(); },
    task => { task.general.countTimeSteps = 3; },
    task => { task.general.timeStep = .2; },
    task => { task.metadata.HS.ranges.invalidCount[3] = 1; },
    task => { task.metadata.HS.ranges = { available: true, state: "complete" }; },
  ]) {
    const { task } = fixture(); change(task);
    assert.equal(fieldLineCycleRange(task, "Bs", [1], ["norm"]).available, false);
  }
  const { task } = fixture();
  assert.equal(fieldLineCycleRange(task, "Bs", [99], ["norm"]).available, false);
  assert.equal(fieldLineCycleRange(task, "Bs", [1], []).available, false);
  assert.equal(fieldLineCycleRange(task, "Bs", [], ["norm"]).available, false);
});

test("zero and constant fields have finite nondegenerate chart bounds and static ranges remain supported", () => {
  assert.deepEqual(fieldLineChartRange({ available: true, minimum: 0, maximum: 0 }), { minimum: -.05, maximum: .05 });
  assert.deepEqual(fieldLineChartRange({ available: true, minimum: -10, maximum: -10 }), { minimum: -10.5, maximum: -9.5 });
  assert.equal(fieldLineChartRange({ available: false }), null);
  const { task } = fixture();
  task.general = { countTimeSteps: 0, timeStep: 0 };
  task.metadata.HS.ranges.stepIds = [0]; task.metadata.HS.ranges.times = [0];
  assert.equal(fieldLineCycleRange(task, "Bs", [1], ["norm"]).available, true);
});

test("component sets participate in frame context; time/order changes do not masquerade as a new selection", () => {
  const { request } = fixture();
  assert.equal(sameFrameContext(request, { ...request, time: 1, components: ["2", "1", "norm", "0"] }), true);
  assert.equal(sameFrameContext(request, { ...request, components: ["norm"] }), false);
  assert.equal(sameFrameContext(request, { ...request, components: [] }), false);
  assert.equal(sameFrameContext({ ...request, components: [] }, { ...request, components: [] }), true);
});

test("late responses for a previous checkbox set cannot publish a wrong frame", async () => {
  const { request } = fixture();
  const scheduled = [], reads = [], states = [];
  const controller = createResultFrameController({ schedule: callback => { scheduled.push(callback); return scheduled.length; }, cancel() {},
    publish: value => states.push(value), load: request => new Promise(resolve => reads.push({ request, resolve })) });
  controller.request(request); void scheduled.shift()();
  controller.request({ ...request, components: ["0"] });
  reads[0].resolve("old norm"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(states.at(-1).frame, null);
  void scheduled.shift()(); reads[1].resolve("new x"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(states.at(-1).frame.value, "new x");
  assert.deepEqual(states.at(-1).frame.request.components, ["0"]);
  controller.close();
});

test("FieldAreas retains the original single-component surface contract", async () => {
  const { request, reads } = fixture();
  const grid = await readSurfaceFrame({ ...request, selected: [1], component: "0" });
  assert.equal(reads.length, 1); assert.deepEqual([...grid.values], [-3, -3, -3, -3]);
  assert.equal(grid.width, 2); assert.equal(grid.height, 2);
});
