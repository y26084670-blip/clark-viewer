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

test("scalar choice disables component selection and capture prevents slice mutations", () => {
  const { ui, props } = setup(); ui.addSlice(0); const row = ui.graphSlices()[0]; assert.equal(ui.sliceScalar(row), false);
  ui.quantities.elements.write("JEdot"); assert.equal(ui.sliceScalar(row), true);
  props.movieBusy = true; ui.changeSlice(row.id, { direction: 2 }); ui.addSlice(1); ui.deleteSlice();
  assert.equal(ui.graphSlices().length, 1); assert.equal(ui.graphSlices()[0].direction, 0); ui.close();
});

test("contour choices survive time, hiding and tab remount; changing plane/component or deleting resets the choice", () => {
  const { ui, props } = setup(); ui.addSlice(1); const id = ui.activeSlice();
  const contour = { graphId: id, surfaceKey: "elements:0:0", direction: 0, index: 2 };
  ui.selectGraphContour(contour); props.time = 1; ui.flushEffects();
  ui.setSliceGraphs(false); assert.deepEqual(ui.graphContour(), contour); ui.close();
  const next = sourcesFields3DSetup(props); assert.deepEqual(next.graphContour(), contour);
  next.changeSlice(id, { discrete: 3 }); assert.deepEqual(next.graphContour(), contour);
  next.changeSlice(id, { direction: 0 }); assert.equal(next.graphContour(), null);
  next.selectGraphContour(contour); next.changeSlice(id, { component: 1 }); assert.equal(next.graphContour(), null);
  next.selectGraphContour(contour); props.movieBusy = true; next.selectGraphContour(null); assert.deepEqual(next.graphContour(), contour);
  props.movieBusy = false; next.deleteSlice(); assert.equal(next.graphContour(), null);
  next.selectGraphContour({ ...contour, graphId: "region:0" }); props.task = graph3DTask().task; next.flushEffects();
  assert.equal(next.graphContour(), null); next.close();
});
