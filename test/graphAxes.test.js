import test from "node:test";
import assert from "node:assert/strict";
import { createGraphAxesController, graphPlaneFrame, resolveGraphAxis } from "../src/services/visualization/graphAxes.js";
import { graph3DTask } from "../scripts/test-support/graph3DFixture.js";
import { graphPlotLayout } from "../src/services/visualization/resultGraphRenderer.js";

test("axis creation rejects different objects and every symmetry identity; Escape resets the first point", () => {
  const { axis } = graph3DTask(), controller = createGraphAxesController();
  const point = { ...axis, pointIndex: 0 };
  controller.toggle("add"); controller.point(point);
  for (const key of ["ls", "as", "ps", "mirrorX", "mirrorY"]) {
    assert.equal(controller.point({ ...point, pointIndex: 2, instance: { ...point.instance, [key]: 1 } }), false);
    assert.equal(controller.state.pending.pointIndex, 0); assert.equal(controller.state.mode, "add");
  }
  assert.equal(controller.point({ ...point, source: { ...point.source, recordIndex: 1 }, pointIndex: 2 }), false);
  assert.equal(controller.point(point), false);
  controller.cancel(); assert.equal(controller.state.pending, null); assert.equal(controller.state.mode, null);
  controller.toggle("add"); controller.point({ ...point, pointIndex: 3 }); controller.point({ ...point, pointIndex: 7 });
  assert.deepEqual(controller.state.axes[0].points, [3, 7]); assert.equal(controller.state.mode, null);
});

test("endpoint editing snaps only in its original image; delete cancellation retains axes and delete mode", () => {
  const { axis } = graph3DTask(), controller = createGraphAxesController(() => {}, [axis]);
  controller.toggle("edit"); controller.grab(1, 0);
  assert.equal(controller.move({ ...axis, pointIndex: 4, instance: { ...axis.instance, ps: 1 } }), false);
  assert.equal(controller.move({ ...axis, pointIndex: axis.points[1] }), false);
  assert.equal(controller.move({ ...axis, pointIndex: 4 }), true); assert.deepEqual(controller.state.axes[0].points, [4, axis.points[1]]);
  controller.release(); assert.equal(controller.state.mode, "edit");
  controller.toggle("delete"); controller.grab(1, 1); controller.confirmDelete(false);
  assert.equal(controller.state.axes.length, 1); assert.equal(controller.state.mode, "delete");
  controller.grab(1, 0); controller.confirmDelete(true); assert.equal(controller.state.axes.length, 0); assert.equal(controller.state.mode, "delete");
});

test("arbitrary geometric endpoints are resolved in the chosen image and remain perpendicular to the plot ordinate", () => {
  const { scene, axis } = graph3DTask();
  const a = resolveGraphAxis(scene, axis), b = resolveGraphAxis(scene, { ...axis, instance: { ...axis.instance, ps: 1 } });
  assert.ok(a.start.every((v, i) => Math.abs(v - [5, 10 / 3, 2.5][i]) < 1e-12)); assert.ok(Math.abs(a.end[0] - 35) < 1e-12);
  assert.ok(Math.abs(b.start[0] - a.start[0] - 60) < 1e-12);
  for (const end of [[0,0,4], [-4,0,0], [2,5,-3]]) {
    const frame = graphPlaneFrame([0,0,0], end, [0,0,1]);
    assert.ok(Math.abs(frame.right.reduce((n, v, i) => n + v * frame.up[i], 0)) < 1e-12);
    assert.ok(Math.abs(Math.hypot(...frame.normal) - 1) < 1e-12);
  }
});

test("graph scale includes zero and signed components, while undefined scalar samples remain gaps", () => {
  const graph = { components: 3, length: 12, distances: [0,12], values: [1,-4,2,3,-1,5] };
  const layout = graphPlotLayout(graph, { X: true, Y: true, Z: false });
  assert.ok(layout.low < -4 && layout.high > 3); assert.ok(layout.y(-4) > layout.zero && layout.y(3) < layout.zero);
  assert.equal(layout.x(12) - layout.x(0), 872);
  const scalar = graphPlotLayout({ ...graph, components: 1, values: [NaN,2] }, { X: false, Y: false, Z: false });
  assert.deepEqual(scalar.components, [0]); assert.equal(scalar.low, 0); assert.ok(scalar.high > 2);
});
