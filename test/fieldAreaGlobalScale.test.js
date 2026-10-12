import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { globalRangesTask } from "../scripts/test-support/globalRangesFixture.js";
import { QUANTITIES, regionLayout, MU0 } from "../src/services/results/resultMappings.js";
import { fieldLineCycleRange } from "../src/services/results/fieldLineComponents.js";
import { readSurfaceFrame } from "../src/services/results/resultRequests.js";
import { disposeSurfaceObject, updateSurfaceMesh } from "../src/services/visualization/surfaceChartResources.js";

// Exercise the actual tab's request/display setup; browser acceptance additionally
// covers Solid scheduling, the checkbox and WebGL/GIF boundaries.
const source = readFileSync(new URL("../src/tabs/FieldAreas.jsx", import.meta.url), "utf8");
const setup = source.slice(source.indexOf("export function FieldAreas"), source.indexOf('  return <div class="results-layout"'));
function fixture(settings = {}) {
  const task = globalRangesTask(), reads = [], nativeRead = task.reader.read;
  task.reader.read = request => { reads.push(request); return nativeRead(request); };
  const props = { task, regions: [1], time: 0, movieBusy: false };
  let state = { frame: null, requested: null, loading: false, error: "" }, request, load;
  // The component body ends immediately before JSX. Append its public test
  // boundary there, rather than reconstructing the production request logic.
  const run = new Function("props", "dependencies", `
    const {createSignal,createMemo,createEffect,createGeometryViewSetting,QUANTITIES,regionLayout,
      fieldLineCycleRange,useResultFrame,readSurfaceFrame,createMovieTabAdapter,completedMovieFrame}=dependencies;
    ${setup.replace("export function", "function")}
    return {quantityKey,setQuantity,component,setComponent,globalMinMax,setGlobalMinMax,
      cycleRange,globalRange,grid,setCopy,copy,record,status};
    } return FieldAreas(props);`);
  const api = run(props, {
    createSignal: initial => { let value = initial; return [() => value, next => { value = next; }]; },
    createMemo: compute => compute, createEffect: callback => callback(),
    createGeometryViewSetting: (name, initial) => [() => settings[name] ?? initial, value => { settings[name] = value; }],
    QUANTITIES, regionLayout, fieldLineCycleRange, readSurfaceFrame,
    useResultFrame: (source, reader) => { request = source; load = reader; return () => state; },
    createMovieTabAdapter: () => ({ onCaptureReady() {} }), completedMovieFrame() {},
  });
  return { ...api, props, reads, settings, request: () => request(),
    async display() { const current = request(), value = await load(current);
      state = { requested: current, frame: { request: current, value }, loading: false, error: "" }; return value; },
  };
}

test("area default uses only the displayed region's full-cycle bounds, with original field values intact", async () => {
  const h = fixture(); h.props.regions = [1, 2];
  const original = await h.display(), values = original.values.slice();
  assert.equal(h.globalMinMax(), true);
  assert.equal(h.globalRange().minimum, 5); assert.equal(h.globalRange().maximum, 50);
  assert.notEqual(h.grid(), original); assert.equal(h.grid().values, original.values);
  assert.equal(h.grid().coordinates, original.coordinates); assert.equal(original.displayRange, undefined);
  const first = updateSurfaceMesh(null, h.grid());
  assert.deepEqual(first.userData.limits, { min: 5, max: 50 });
  h.props.time = 2; await h.display();
  updateSurfaceMesh(first, h.grid()); assert.deepEqual(first.userData.limits, { min: 5, max: 50 });
  assert.deepEqual(original.values, values); assert.equal(h.reads.length, 2);
  disposeSurfaceObject(first);
});

test("changing the flag updates display limits without another read or mutating a cached grid", async () => {
  const h = fixture(), raw = await h.display(), request = h.request();
  h.setGlobalMinMax(false); assert.equal(h.globalRange(), null); assert.equal(h.grid(), raw);
  const mesh = updateSurfaceMesh(null, h.grid()); assert.deepEqual(mesh.userData.limits, { min: 5, max: 5 });
  h.setGlobalMinMax(true); updateSurfaceMesh(mesh, h.grid());
  assert.deepEqual(mesh.userData.limits, { min: 5, max: 50 }); assert.equal(h.reads.length, 1);
  assert.deepEqual(h.request(), request); assert.equal(raw.displayRange, undefined);
  disposeSurfaceObject(mesh);
});

test("signed components and A bounds use the chosen channel and exactly one unit conversion", async () => {
  const h = fixture(); h.setComponent("0"); await h.display();
  assert.equal(h.globalRange().minimum, -3); assert.equal(h.globalRange().maximum, 30);
  assert.equal(h.grid().values[0], 3);
  h.setQuantity("As"); await h.display();
  assert.equal(h.globalRange().minimum, -3 * MU0); assert.equal(h.globalRange().maximum, 30 * MU0);
  assert.equal(h.grid().values[0], 3 * MU0);
  h.props.regions = [2]; await h.display();
  assert.equal(h.globalRange().minimum, -6 * MU0); assert.equal(h.globalRange().maximum, 60 * MU0);
});

test("LS choice retains the complete region's bounds and reads only the chosen plane", async () => {
  const h = fixture(); h.props.task.regions[0].symLs = 2;
  for (const file of ["HS", "AS"]) {
    const metadata = h.props.task.metadata[file]; metadata.header.numbs[0] = 8; metadata.header.inds1[1] = 9;
  }
  h.setCopy(1); await h.display();
  assert.equal(h.reads[0].start, 4); assert.equal(h.reads[0].count, 4);
  assert.equal(h.grid().copy, 1); assert.equal(h.globalRange().minimum, 5); assert.equal(h.globalRange().maximum, 50);
});

test("unusable indexes retain the requested default and a viewable frame-local scale", async () => {
  for (const change of [t => { delete t.metadata.HS.ranges; },
    t => { t.metadata.HS.ranges.state = "partial"; }, t => { t.general.timeStep = .2; },
    t => { t.metadata.HS.ranges.objectIds.reverse(); }, t => { t.metadata.HS.ranges.invalidCount[3] = 1; }]) {
    const h = fixture(); change(h.props.task); const raw = await h.display();
    assert.equal(h.globalMinMax(), true); assert.equal(h.cycleRange().available, false);
    assert.equal(h.globalRange(), null); assert.equal(h.grid(), raw);
    const mesh = updateSurfaceMesh(null, h.grid()); assert.deepEqual(mesh.userData.limits, { min: 5, max: 5 });
    disposeSurfaceObject(mesh);
  }
});

test("the existing page setting is preserved across remounts and task changes", async () => {
  const settings = {}, first = fixture(settings); first.setGlobalMinMax(false);
  const next = fixture(settings); assert.equal(next.globalMinMax(), false);
  next.props.task = globalRangesTask(); await next.display(); assert.equal(next.globalRange(), null);
  next.setGlobalMinMax(true); assert.equal(first.globalMinMax(), true);
});
