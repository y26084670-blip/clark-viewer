import test from "node:test";
import assert from "node:assert/strict";
import { sourcesFields3DSetup } from "../scripts/test-support/sourcesFields3DSetup.js";
import { graph3DTask } from "../scripts/test-support/graph3DFixture.js";
import { createResultGraphReader } from "../src/services/results/resultGraphRequests.js";
import { calculateResultGraphs } from "../src/services/visualization/resultGraphField.js";

const readerFactory = initial => createResultGraphReader({ ...initial,
  processorFactory: () => ({ process: async input => calculateResultGraphs(input), close() {} }) });
const options = { graphsOnly: true, graphReaderFactory: readerFactory };
function setup() {
  const f = graph3DTask();
  const props = { task: f.task, elements: [1, 2], regions: [1], time: 0 };
  const settings = { resultElementsQuantity: "J", resultRegionsQuantity: "Bs" };
  return { ...f, props, settings };
}

test("only-graphs defaults suppress all field requests while retaining quantities and selected geometry", async () => {
  const f = setup(), ui = sourcesFields3DSetup(f.props, f.settings, options);
  try {
    assert.equal(ui.graphsOnly(), true); assert.equal(ui.showGraphs(), true);
    assert.ok(ui.request().layers.every(l => l.quantityKey === "none"));
    await ui.load(ui.request()); assert.equal(f.reads.length, 0);
    assert.deepEqual(ui.request().streamlineSeeds, []);
    assert.deepEqual(ui.selections(), { elements: [0, 1], regions: [0] });
    ui.setGraphsOnly(false);
    assert.deepEqual(ui.request().layers.map(l => l.quantityKey), ["J", "Bs", "none"]);
    ui.setGraphsOnly(true); f.props.time = 2; ui.flushEffects(); assert.equal(ui.timeIndex(), 2);
  } finally { ui.close(); }
});

test("hide/show and tab remount preserve axes and sampled data without reading the result file again", async () => {
  const f = setup(); let ui = sourcesFields3DSetup(f.props, f.settings, options);
  try {
    ui.graphController.reset([f.axis]); await ui.buildGraphs();
    const graph = ui.currentGraphResults()[0]; assert.equal(graph.error, undefined);
    ui.setShowGraphs(false); assert.equal(ui.currentGraphResults()[0], graph);
    ui.close(); ui = sourcesFields3DSetup(f.props, f.settings, options);
    assert.equal(ui.showGraphs(), false); assert.deepEqual(ui.graphState().axes, [f.axis]);
    assert.equal(ui.currentGraphResults()[0], graph);
    ui.setShowGraphs(true); await ui.buildGraphs(); assert.equal(f.reads.length, 1);
    f.props.time = 1; ui.flushEffects(); assert.deepEqual(ui.currentGraphResults(), []);
    await ui.buildGraphs(); assert.equal(ui.currentGraphResults()[0].timeIndex, 1); assert.equal(f.reads.length, 2);
  } finally { ui.close(); }
});

test("a late computation cannot publish a curve for a previous time or a previous task", async () => {
  const f = setup(); let finish;
  const ui = sourcesFields3DSetup(f.props, f.settings, { ...options,
    graphReaderFactory: () => ({ read: () => new Promise(resolve => { finish = resolve; }), close() {} }) });
  try {
    ui.graphController.reset([f.axis]);
    const oldTime = ui.buildGraphs(); assert.equal(ui.graphBusy(), true);
    f.props.time = 1; ui.flushEffects(); finish([{ id: 1, signature: "stale" }]); await oldTime;
    assert.deepEqual(ui.graphResults(), []); assert.equal(ui.graphBusy(), false);
    const oldTask = ui.buildGraphs(); f.props.task = graph3DTask().task; ui.flushEffects();
    finish([{ id: 1, signature: "wrong task" }]); await oldTask;
    assert.deepEqual(ui.graphState().axes, []); assert.deepEqual(ui.graphResults(), []); assert.equal(ui.graphBusy(), false);
  } finally { ui.close(); }
});
