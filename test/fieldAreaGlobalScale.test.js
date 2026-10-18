import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { globalRangesTask } from "../scripts/test-support/globalRangesFixture.js";
import { QUANTITIES, regionLayout, MU0 } from "../src/services/results/resultMappings.js";
import { surfaceComponentRange } from "../src/services/results/resultPlots.js";
import { readSurfaceFrame } from "../src/services/results/resultRequests.js";
import { disposeSurfaceObject, updateSurfaceMesh } from "../src/services/visualization/surfaceChartResources.js";

const source = readFileSync(new URL("../src/tabs/FieldAreas.jsx", import.meta.url), "utf8");
const setup = source.slice(source.indexOf("export function FieldAreas"), source.indexOf('  return <div class="results-layout"'));
function fixture(settings = {}) {
  const task = globalRangesTask(), reads = [], nativeRead = task.reader.read;
  task.reader.read = request => { reads.push(request); return nativeRead(request); };
  const props = { task, regions: [1], time: 0, movieBusy: false };
  let state = { frame: null, requested: null, loading: false, error: "" }, request, load;
  const run = new Function("props", "dependencies", `
    const {createSignal,createMemo,createEffect,createGeometryViewSetting,QUANTITIES,regionLayout,
      surfaceComponentRange,useResultFrame,readSurfaceFrame,createMovieTabAdapter,completedMovieFrame,combineMovieFrames}=dependencies;
    ${setup.replace("export function", "function")}
    return {quantityKey,setQuantity,globalMinMax,setGlobalMinMax,commonRange,grids,setCopy,copy,record,status};
    } return FieldAreas(props);`);
  const api = run(props, {
    createSignal: initial => { let value = initial; return [() => value, next => { value = next; }]; },
    createMemo: compute => compute, createEffect: callback => callback(),
    createGeometryViewSetting: (name, initial) => [() => settings[name] ?? initial, value => { settings[name] = value; }],
    QUANTITIES, regionLayout, surfaceComponentRange, readSurfaceFrame,
    useResultFrame: (source, reader) => { request = source; load = reader; return () => state; },
    createMovieTabAdapter: () => ({ onCaptureReady() {} }), completedMovieFrame() {}, combineMovieFrames() {},
  });
  return { ...api, props, reads, settings, request: () => request(),
    async display() { const current = request(), value = await load(current);
      state = { requested: current, frame: { request: current, value }, loading: false, error: "" }; return value; },
  };
}

test("three signed component surfaces share only the displayed frame's bounds and one read", async () => {
  const h = fixture(); h.props.regions = [1, 2];
  const original = await h.display();
  assert.equal(h.reads.length, 1); assert.equal(original.length, 3);
  assert.deepEqual(original.map(grid => grid.values[0]), [3, 4, 0]);
  assert.equal(h.globalMinMax(), true);
  assert.deepEqual(h.commonRange(), { minimum: 0, maximum: 4 });
  for (const [i, grid] of h.grids().entries()) {
    assert.equal(grid.values, original[i].values); assert.equal(original[i].displayRange, undefined);
    const mesh = updateSurfaceMesh(null, grid);
    assert.deepEqual(mesh.userData.limits, { min: 0, max: 4 }); disposeSurfaceObject(mesh);
  }
  h.props.time = 2; await h.display();
  assert.deepEqual(h.commonRange(), { minimum: 0, maximum: 12 }); assert.equal(h.reads.length, 2);
});

test("unchecked uses each component's own bounds without another read or changed values", async () => {
  const h = fixture(), original = await h.display(), request = h.request();
  h.setGlobalMinMax(false);
  assert.equal(h.grids(), original);
  for (const [i, grid] of h.grids().entries()) {
    const mesh = updateSurfaceMesh(null, grid);
    assert.deepEqual(mesh.userData.limits, { min: [3, 4, 0][i], max: [3, 4, 0][i] }); disposeSurfaceObject(mesh);
  }
  h.setGlobalMinMax(true); assert.deepEqual(h.commonRange(), { minimum: 0, maximum: 4 });
  assert.equal(h.reads.length, 1); assert.deepEqual(h.request(), request);
});

test("common bounds preserve negative components, constants, zero and tiny values", () => {
  const grids = (...values) => values.map(items => ({ values: Float64Array.from(items) }));
  assert.deepEqual(surfaceComponentRange(grids([-10, -3], [1, 4], [-2, 0])), { minimum: -10, maximum: 4 });
  assert.deepEqual(surfaceComponentRange(grids([0, 0], [0, 0], [0, 0])), { minimum: 0, maximum: 0 });
  assert.deepEqual(surfaceComponentRange(grids([-1e-30], [2e-30], [0])), { minimum: -1e-30, maximum: 2e-30 });
  assert.throws(() => surfaceComponentRange(grids([NaN], [1], [2])), /нечисловые/);
});

test("A components and shared bounds are converted into display units exactly once", async () => {
  const h = fixture(); h.setQuantity("As"); await h.display();
  assert.deepEqual(h.grids().map(grid => grid.values[0]), [3 * MU0, 4 * MU0, 0]);
  assert.deepEqual(h.commonRange(), { minimum: 0, maximum: 4 * MU0 });
});

test("one selected LS plane supplies all components; full-cycle indexes are irrelevant", async () => {
  const h = fixture(); h.props.task.regions[0].symLs = 2;
  for (const file of ["HS", "AS"]) {
    const metadata = h.props.task.metadata[file]; metadata.header.numbs[0] = 8; metadata.header.inds1[1] = 9;
    delete metadata.ranges;
  }
  h.setCopy(1); await h.display();
  assert.equal(h.reads[0].start, 4); assert.equal(h.reads[0].count, 4); assert.equal(h.reads.length, 1);
  assert.ok(h.grids().every(grid => grid.copy === 1));
  assert.deepEqual(h.commonRange(), { minimum: 0, maximum: 4 });
});

test("area preference survives remounts and task changes without changing other tabs", async () => {
  const settings = { resultGlobalMinMax: false }, first = fixture(settings);
  assert.equal(first.globalMinMax(), true); first.setGlobalMinMax(false);
  const next = fixture(settings); assert.equal(next.globalMinMax(), false);
  next.props.task = globalRangesTask(); await next.display(); assert.equal(next.grids()[0].displayRange, undefined);
  next.setGlobalMinMax(true); assert.equal(first.globalMinMax(), true); assert.equal(settings.resultGlobalMinMax, false);
});
