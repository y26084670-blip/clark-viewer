import test from "node:test";
import assert from "node:assert/strict";
import { sourcesFields3DSetup } from "../scripts/test-support/sourcesFields3DSetup.js";
import { graph3DTask } from "../scripts/test-support/graph3DFixture.js";
const setup = () => { const { task } = graph3DTask(); const props = { task, elements: [1,2], regions: [1], time: 0 }; return { props, ui: sourcesFields3DSetup(props, { resultElementsQuantity: "J", resultRegionsQuantity: "Bs" }) }; };

test("all graph options start unchecked; Only graphs keeps geometry selections and suppresses calculated layers", () => {
  const { ui } = setup();
  assert.equal(ui.graphsOnly(), false); assert.equal(ui.areaGraphs(), false); assert.equal(ui.sliceGraphs(), false);
  assert.deepEqual(ui.graphRequest().slices, []); assert.deepEqual(ui.graphRequest().regions, []);
  const selection = ui.selections(); ui.setGraphsOnly(true);
  assert.ok(ui.request().layers.every(l => l.quantityKey === "none")); assert.deepEqual(ui.selections(), selection);
  ui.setAreaGraphs(true); assert.deepEqual(ui.graphRequest().regions, [0]); ui.close();
});

test("adding shows a central EO layer immediately; editing one row, selection and deletion are independent", () => {
  const { ui } = setup(); ui.setAddElement(0); ui.addSlice(2);
  assert.equal(ui.sliceGraphs(), true); assert.equal(ui.graphSlices().length, 1); assert.equal(ui.graphRequest().slices[0].direction, 2);
  assert.equal(ui.graphSlices()[0].discrete, 1);
  ui.setAddElement(1); ui.addSlice(0); assert.equal(ui.graphSlices().length, 2);
  const first = ui.graphSlices()[0].id; ui.changeSlice(first, { component: 2, direction: 1 });
  assert.equal(ui.activeSlice(), first); assert.equal(ui.graphSlices()[1].component, 0);
  ui.deleteSlice(); assert.equal(ui.graphSlices().length, 1); assert.equal(ui.graphSlices()[0].recordIndex, 1); ui.close();
});

test("discrete edits retain row identity, reject invalid numbers and reset to the central layer on direction change", () => {
  const { ui } = setup(); ui.addSlice(0); const id = ui.activeSlice();
  assert.equal(ui.sliceLabel(0, 0), "плоскость DV1 (4)"); assert.equal(ui.graphSlices()[0].discrete, 2);
  ui.changeSlice(id, { discrete: 4 }); assert.equal(ui.graphSlices()[0].discrete, 4);
  for (const discrete of [0,5,NaN,1.5]) ui.changeSlice(id, { discrete });
  assert.equal(ui.graphSlices()[0].discrete, 4); assert.equal(ui.graphSlices()[0].id, id);
  ui.addSlice(0); assert.equal(ui.graphSlices().length, 2, "a different layer is a different graph");
  ui.addSlice(0); assert.equal(ui.graphSlices().length, 2, "adding the same central layer selects it");
  assert.deepEqual(ui.sliceChoice(0, 0, ui.graphSlices()[0]), { recordIndex: 0, direction: 0, discrete: 4 });
  assert.deepEqual(ui.sliceChoice(0, 2, ui.graphSlices()[0]), { recordIndex: 0, direction: 2, discrete: 1 });
  ui.changeSlice(id, { direction: 2 }); assert.equal(ui.graphSlices()[0].discrete, 1);
  ui.close();
});

test("hiding preserves rows; task-bound choices survive tab remount and do not leak to another task", () => {
  const { ui, props } = setup(); ui.addSlice(1); ui.setSliceGraphs(false); ui.setAreaGraphs(true);
  assert.deepEqual(ui.graphRequest().slices, []); assert.equal(ui.graphSlices().length, 1); ui.close();
  const remount = sourcesFields3DSetup(props); assert.equal(remount.graphSlices().length, 1); assert.equal(remount.sliceGraphs(), false); assert.equal(remount.areaGraphs(), true);
  props.task = graph3DTask().task; remount.flushEffects(); assert.equal(remount.graphSlices().length, 0); assert.equal(remount.areaGraphs(), false); remount.close();
});

test("opening a project resets all three graph flags from disk but keeps collections and same-session tab choices", async () => {
  const slices = [{ id: 1, recordIndex: 0, direction: 2, discrete: 1, component: 0 }];
  let text = JSON.stringify({ version: 1, settings: { only: true, areas: true, showSlices: true, slices,
    profiles: [{ id: 1, graphId: 1, instanceKey: "elements:0:0:0:0:0:0", direction: 0, index: 1 }] } });
  const handle = { async getFileHandle() { return {
    async getFile() { return { size: text.length, text: async () => text }; },
    async createWritable() { let next; return { async write(value) { next = value; }, async close() { text = next; } }; },
  }; } };
  const props = { task: { ...graph3DTask().task, handle }, elements: [1,2], regions: [1], time: 0 };
  const open = () => sourcesFields3DSetup(props, {}, { graphsOnly: true });
  const ready = async ui => {
    for (let n = 0; n < 20 && !ui.graphReady(); n++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(ui.graphReady(), true);
  };
  const flags = ui => [ui.graphsOnly(), ui.areaGraphs(), ui.sliceGraphs()];
  let ui = open();
  try {
    await ready(ui);
    assert.deepEqual(flags(ui), [false, false, false]); assert.deepEqual(ui.graphSlices(), slices);
    assert.equal(ui.graphProfiles().length, 1);
    ui.setGraphsOnly(true); ui.setAreaGraphs(true); ui.setSliceGraphs(true); ui.close();
    ui = open(); await ready(ui);
    assert.deepEqual(flags(ui), [true, true, true]); assert.deepEqual(ui.graphSlices(), slices);
    ui.close(); props.task = { ...graph3DTask().task, handle };
    ui = open(); await ready(ui);
    assert.deepEqual(flags(ui), [false, false, false]); assert.deepEqual(ui.graphSlices(), slices);
    assert.equal(ui.graphProfiles().length, 1);
  } finally { ui.close(); }
});

test("scalar choice disables component selection and capture prevents slice mutations", () => {
  const { ui, props } = setup(); ui.addSlice(0); const row = ui.graphSlices()[0]; assert.equal(ui.sliceScalar(row), false);
  ui.quantities.elements.write("JEdot"); assert.equal(ui.sliceScalar(row), true);
  props.movieBusy = true; ui.changeSlice(row.id, { direction: 2 }); ui.addSlice(1); ui.deleteSlice();
  assert.equal(ui.graphSlices().length, 1); assert.equal(ui.graphSlices()[0].direction, 0); ui.close();
});

test("collection retains sections across graphs, components, time and tab remount; deletion and plane changes remove only affected entries", () => {
  const { ui, props } = setup(); ui.addSlice(1); const id = ui.activeSlice();
  const selection = { graphId: id, instanceKey: "elements:0:0:0:0:0:0", direction: 0, index: 2 };
  ui.selectGraphContour(selection); const contour = ui.graphContour();
  props.time = 1; ui.flushEffects(); ui.setSliceGraphs(false);
  assert.deepEqual(ui.graphContour(), contour);
  assert.equal(ui.graphRequest().profiles.length, 1); assert.equal(ui.graphRequest().slices.length, 1, "hidden surfaces still supply 1D values");
  ui.selectGraphContour({ ...selection, graphId: "region:0", instanceKey: "regions:0:0:0:0:0:0", index: 1 });
  const area = ui.graphContour(); assert.equal(ui.graphProfiles().length, 2);
  ui.changeSlice(id, { component: 2 }); assert.deepEqual(ui.graphProfiles()[0], contour);
  ui.selectProfile(contour.id); ui.selectGraphContour({ ...selection, index: 1 }, { add: false });
  assert.equal(ui.graphProfiles().length, 2); assert.equal(ui.graphContour().id, contour.id);
  ui.selectGraphContour({ ...selection, index: 1 }); assert.equal(ui.graphProfiles().length, 2, "duplicate selection reuses entry");
  ui.close(); const next = sourcesFields3DSetup(props);
  assert.equal(next.graphProfiles().length, 2); assert.equal(next.graphContour().index, 1);
  next.changeSlice(id, { discrete: 3 }); assert.equal(next.graphProfiles().length, 2);
  next.changeSlice(id, { direction: 0 }); assert.deepEqual(next.graphProfiles(), [area]);
  next.selectGraphContour(selection); props.movieBusy = true; next.selectGraphContour({ ...selection, index: 0 });
  assert.equal(next.graphContour().index, 2);
  props.movieBusy = false; next.deleteSlice(); assert.deepEqual(next.graphProfiles(), [area]);
  props.task = graph3DTask().task; next.flushEffects(); assert.equal(next.graphProfiles().length, 0); next.close();
});
