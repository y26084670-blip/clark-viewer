import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { batch, createEffect, createRoot, createSignal, on, onCleanup, onMount, untrack } from "solid-js/dist/solid.js";
import { chartPanLimits, chartZoomLimits, clampChartPoint } from "../src/services/visualization/chartZoom.js";

const source = await readFile(new URL("../src/components/LineChart.jsx", import.meta.url), "utf8");
const start = source.indexOf("export function LineChart(props) {") + "export function LineChart(props) {".length;
const end = source.indexOf('  return <div class="line-chart"', start);
assert.ok(start > 0 && end > start);
// Execute the production handlers and effects with Solid's real reactive runtime.
// Only the canvas/Chart.js drawing boundary is replaced; no browser is started.
const component = new Function("props", "dependencies", `
  const { batch, createEffect, createSignal, on, onCleanup, onMount, untrack,
    Chart, window, chartPanLimits, chartZoomLimits, clampChartPoint, testCanvas } = dependencies;
  const colors = ["blue"], drawOverlayLegend = () => [];
  ${source.slice(start, end)}
  canvas = testCanvas;
  return { toggleAutoScale, autoScale, startSelection, updateSelection, finishSelection,
    cancelSelection, setShowLegend, limits, chart: () => chart };
`);

const series = maximum => [{ label: "field", points: [{ x: 0, y: 0 }, { x: maximum, y: maximum * 2 }] }];
const area = { left: 40, right: 360, top: 20, bottom: 180 };
class FakeChart {
  constructor(canvas, config) {
    this.data = config.data; this.options = config.options;
    this.width = 400; this.height = 200; this.chartArea = area; this.scales = {};
    this.tooltip = { setActiveElements() {} }; this.updates = 0; this.destroyed = false;
    this.update();
  }
  update() {
    this.updates++;
    for (const axis of ["x", "y"]) {
      const points = this.data.datasets.flatMap(dataset => dataset.data.map(point => point[axis])).filter(Number.isFinite);
      const limits = this.options.scales[axis];
      const min = limits.min ?? (points.length ? Math.min(...points) : 0);
      const max = limits.max ?? (points.length ? Math.max(...points) : 1);
      this.scales[axis] = { min, max, getValueForPixel: pixel => axis === "x"
        ? min + (pixel - area.left) / (area.right - area.left) * (max - min)
        : max - (pixel - area.top) / (area.bottom - area.top) * (max - min) };
    }
  }
  setActiveElements() {}
  draw() {}
  destroy() { this.destroyed = true; }
}
function runtime(initial = series(10), autoScaleToggle = true) {
  let dispose, api;
  createRoot(cleanup => {
    dispose = cleanup;
    const [data, setSeries] = createSignal(initial), [axis, setAxis] = createSignal("Field");
    const props = { autoScaleToggle, get series() { return data(); }, get yLabel() { return axis(); }, xLabel: "Node" };
    const captured = new Set();
    const testCanvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 200 }),
      hasPointerCapture: id => captured.has(id), setPointerCapture: id => captured.add(id),
      releasePointerCapture: id => captured.delete(id) };
    api = component(props, { batch, createEffect, createSignal, on, onCleanup, onMount, untrack,
      Chart: FakeChart, window: { addEventListener() {}, removeEventListener() {} },
      chartPanLimits, chartZoomLimits, clampChartPoint, testCanvas });
    Object.assign(api, { setSeries, setAxis });
  });
  return { ...api, dispose };
}
const bounds = chart => ({ xMin: chart.scales.x.min, xMax: chart.scales.x.max, yMin: chart.scales.y.min, yMax: chart.scales.y.max });
const pointer = (x, y, button = 0) => ({ clientX: x, clientY: y, button, buttons: button === 2 ? 2 : 1,
  pointerId: 1, isPrimary: true, preventDefault() {} });

test("Auto toggle tracks time while enabled and freezes the displayed limits while disabled", () => {
  const h = runtime(), chart = h.chart();
  assert.equal(h.autoScale(), true);
  h.setSeries(series(20)); assert.equal(chart.scales.y.max, 40);
  h.toggleAutoScale(); const frozen = bounds(chart);
  assert.equal(h.autoScale(), false);
  h.setSeries(series(50)); h.setAxis("Another quantity"); h.setShowLegend(true);
  assert.deepEqual(bounds(chart), frozen); assert.equal(h.chart(), chart);
  h.toggleAutoScale(); assert.equal(h.autoScale(), true); assert.equal(chart.scales.y.max, 100);
  h.setSeries(series(30)); assert.equal(chart.scales.y.max, 60);
  h.dispose(); assert.equal(chart.destroyed, true);
});

test("turning Auto off before a valid frame freezes the first real data range", () => {
  const h = runtime([]), chart = h.chart();
  h.toggleAutoScale(); assert.equal(h.autoScale(), false);
  h.setSeries(series(20)); const frozen = bounds(chart);
  assert.deepEqual(frozen, { xMin: 0, xMax: 20, yMin: 0, yMax: 40 });
  h.setSeries(series(100)); assert.deepEqual(bounds(chart), frozen);
  h.dispose();
});

test("a committed selection or pan disables Auto and preserves manual limits across frames", () => {
  for (const button of [0, 2]) {
    const h = runtime(), chart = h.chart(), span = chart.scales.x.max - chart.scales.x.min;
    h.startSelection(pointer(80, 40, button));
    h.updateSelection(pointer(240, 140, button));
    h.finishSelection(pointer(240, 140, button));
    assert.equal(h.autoScale(), false);
    const selected = bounds(chart);
    if (button === 2) assert.equal(selected.xMax - selected.xMin, span);
    else assert.ok(selected.xMax - selected.xMin < span);
    h.setSeries(series(100)); assert.deepEqual(bounds(chart), selected);
    h.toggleAutoScale(); assert.equal(chart.scales.x.max, 100);
    h.dispose();
  }
});

test("cancelled pan and a too-small selection keep Auto enabled", () => {
  const h = runtime(), chart = h.chart(), initial = bounds(chart);
  h.startSelection(pointer(80, 40, 2)); h.updateSelection(pointer(240, 140, 2)); h.cancelSelection();
  assert.equal(h.autoScale(), true); assert.deepEqual(bounds(chart), initial);
  h.startSelection(pointer(80, 40)); h.finishSelection(pointer(81, 41));
  assert.equal(h.autoScale(), true);
  h.setSeries(series(100)); assert.equal(chart.scales.y.max, 200);
  h.dispose();
});

test("other line charts keep their one-shot Auto button and axis-change reset", () => {
  const h = runtime(series(10), false), chart = h.chart();
  h.startSelection(pointer(80, 40)); h.finishSelection(pointer(240, 140));
  const zoomed = bounds(chart); h.setSeries(series(50)); assert.deepEqual(bounds(chart), zoomed);
  h.toggleAutoScale(); assert.equal(chart.scales.y.max, 100);
  h.startSelection(pointer(80, 40)); h.finishSelection(pointer(240, 140));
  h.setAxis("New axis"); assert.equal(chart.scales.y.max, 100);
  h.toggleAutoScale(); h.setSeries(series(100)); assert.equal(chart.scales.y.max, 200);
  h.dispose();
});
