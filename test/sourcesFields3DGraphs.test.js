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
    f.props.time = 1; ui.flushEffects(); assert.equal(ui.currentGraphResults()[0], graph);
    await ui.whenGraphsReady(); assert.equal(ui.currentGraphResults()[0].timeIndex, 1); assert.equal(f.reads.length, 2);
  } finally { ui.close(); }
});

const tick = () => new Promise(resolve => setImmediate(resolve));
function holdReads(f) {
  const read = f.task.reader.read, waiting = [], started = [];
  f.task.reader.read = async request => { started.push(request.step); await new Promise(resolve => waiting.push(resolve)); return read(request); };
  return { waiting, started, release: () => { assert.ok(waiting.length); waiting.shift()(); } };
}

test("rapid time changes keep the last graph and compute only the running and latest requested steps", async () => {
  const f = setup(), ui = sourcesFields3DSetup(f.props, f.settings, options);
  try {
    ui.graphController.reset([f.axis]); await ui.buildGraphs();
    const graph = ui.currentGraphResults()[0], hold = holdReads(f);
    f.props.time = 1; ui.flushEffects(); assert.equal(ui.graphBusy(), true);
    f.props.time = 0; ui.flushEffects(); f.props.time = 2; ui.flushEffects();
    assert.equal(ui.currentGraphResults()[0], graph); assert.deepEqual(hold.started, [1]);
    hold.release(); await tick(); assert.deepEqual(hold.started, [1, 2]);
    assert.equal(ui.currentGraphResults()[0], graph, "superseded step must never replace the old curve");
    hold.release(); await ui.whenGraphsReady();
    assert.equal(ui.currentGraphResults()[0].timeIndex, 2); assert.equal(ui.graphBusy(), false);
  } finally { ui.close(); }
});

test("changing time during the first Build finishes at the latest time; a late old task cannot publish", async () => {
  const f = setup(), hold = holdReads(f), ui = sourcesFields3DSetup(f.props, f.settings, options);
  try {
    ui.graphController.reset([f.axis]); const build = ui.buildGraphs();
    f.props.time = 2; ui.flushEffects(); hold.release(); await tick();
    assert.deepEqual(ui.graphResults(), []); assert.deepEqual(hold.started, [0, 2]);
    hold.release(); await build; assert.equal(ui.currentGraphResults()[0].timeIndex, 2);
    f.props.time = 1; ui.flushEffects(); const oldTask = ui.whenGraphsReady();
    f.props.task = graph3DTask().task; ui.flushEffects(); hold.release(); await oldTask;
    assert.deepEqual(ui.graphState().axes, []); assert.deepEqual(ui.graphResults(), []); assert.equal(ui.graphBusy(), false);
  } finally { ui.close(); }
});

test("a missing step retains its previous labelled curve and reports an error; the next valid time recovers", async () => {
  const f = setup(), ui = sourcesFields3DSetup(f.props, f.settings, options);
  try {
    ui.graphController.reset([f.axis]); await ui.buildGraphs(); const graph = ui.currentGraphResults()[0];
    f.props.time = 9; ui.flushEffects(); await ui.whenGraphsReady();
    assert.equal(ui.currentGraphResults()[0], graph); assert.match(ui.graphError(), /Нет сохранённого момента/);
    assert.match(ui.graphCaptureStatus(9).error, /Нет сохранённого момента/);
    f.props.time = 1; ui.flushEffects(); await ui.whenGraphsReady();
    assert.equal(ui.currentGraphResults()[0].timeIndex, 1); assert.equal(ui.graphError(), "");
  } finally { ui.close(); }
});

test("hidden graphs update in time; a newly added unbuilt axis is not computed implicitly", async () => {
  const f = setup(), ui = sourcesFields3DSetup(f.props, f.settings, options);
  try {
    ui.graphController.reset([f.axis]); await ui.buildGraphs(); ui.setShowGraphs(false);
    ui.graphController.reset([f.axis, { ...f.axis, id: 2, points: [2,20] }]);
    f.props.time = 1; ui.flushEffects(); await ui.whenGraphsReady();
    assert.equal(ui.showGraphs(), false); assert.equal(ui.currentGraphResults().length, 1);
    assert.equal(ui.currentGraphResults()[0].timeIndex, 1); assert.equal(f.reads.length, 2);
    ui.setShowGraphs(true); assert.equal(f.reads.length, 2);
  } finally { ui.close(); }
});

test("movie capture waits for updated graph data even while manual controls are blocked", async () => {
  const f = setup(), ui = sourcesFields3DSetup(f.props, f.settings, options);
  try {
    ui.graphController.reset([f.axis]); await ui.buildGraphs(); const hold = holdReads(f);
    f.props.movieBusy = true; f.props.time = 1; ui.flushEffects();
    assert.deepEqual(ui.graphCaptureStatus(1), { ready: false }); assert.equal(ui.currentGraphResults()[0].timeIndex, 0);
    hold.release(); await ui.whenGraphsReady();
    assert.deepEqual(ui.graphCaptureStatus(1), { ready: true }); assert.equal(ui.currentGraphResults()[0].timeIndex, 1);
  } finally { ui.close(); }
});
