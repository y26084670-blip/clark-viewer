import test from "node:test";
import assert from "node:assert/strict";
import { graph3DTask } from "../scripts/test-support/graph3DFixture.js";
import { createResultGraphReader } from "../src/services/results/resultGraphRequests.js";
import { calculateResultGraphs } from "../src/services/visualization/resultGraphField.js";
import { graphProfileSeries, graphProfileThumbnail } from "../src/services/visualization/graphProfileChart.js";
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const reader = () => createResultGraphReader({ processorFactory: () => ({ process: async input => calculateResultGraphs(input), close() {} }) });
const request = f => ({ task: f.task, time: 0, quantities: { elements: "J", regions: "Bs" }, regions: [0],
  slices: [{ id: 1, recordIndex: 0, direction: 2, discrete: 1, component: 0 }] });

test("1D slices use every native EO centre, all XYZ values, original units and the selected symmetry image", async () => {
  const f = graph3DTask({ dimensions: [150, 3, 2] }), r = reader(), base = request(f);
  const first = await r.read(base), surface = first.graphs.find(g => g.id === 1).surfaces.find(s => s.instance.ps === 1);
  assert.equal(surface.dimensions[0], 65);
  const selected = { id: 7, graphId: 1, instanceKey: surface.instanceKey, direction: 0, index: 2 };
  const output = await r.read({ ...base, profiles: [selected] });
  const p = output.profiles[0]; assert.equal(p.distances.length, 150); assert.equal(p.components, 3); assert.equal(p.id, 7);
  for (let n = 0; n < p.distances.length; n++) {
    const [x, y, z] = p.positions.subarray(n * 3, n * 3 + 3);
    near(x, 60 + 40 * (n + .5) / 150); near(y, 20 * 2.5 / 3); near(z, 2.5);
    near(p.values[n * 3], x); near(p.values[n * 3 + 1], 2 * y); near(p.values[n * 3 + 2], -z);
    near(p.distances[n], x - p.start[0]);
  }
  near(p.length, 40 * 149 / 150); assert.equal(p.count, 3); assert.equal(p.discreteCount, 2);
  const changed = await r.read({ ...base, slices: [{ ...base.slices[0], component: 2 }], profiles: [selected] });
  assert.deepEqual(changed.profiles[0].values, p.values); assert.equal(f.reads.length, 2, "one element grid and one area grid");
  const later = (await r.read({ ...base, time: 2, profiles: [selected] })).profiles[0];
  near(later.values[0], p.values[0] + 2); near(later.values[1], p.values[1] - 2); near(later.values[2], p.values[2] + 4);
  const series = graphProfileSeries(later); assert.deepEqual(series.map(s => s.color), ["#ff0000", "#00ff00", "#0000ff"]);
  assert.equal(series[0].points.length, 150); assert.equal(graphProfileThumbnail(series, ["X", "Z"]).length, 1); r.close();
});

test("area profiles follow the original row in either direction and physical mirror parity", async () => {
  const f = graph3DTask({ mirror: 0 }), r = reader(), base = { ...request(f), slices: [] };
  const initial = await r.read(base), surfaces = initial.graphs[0].surfaces.filter(s => s.component === 0);
  const profiles = surfaces.flatMap((surface, image) => [0, 1].map(direction => ({ id: image * 2 + direction + 1,
    graphId: "region:0", instanceKey: surface.instanceKey, direction, index: 1 })));
  const output = await r.read({ ...base, profiles }); assert.equal(output.profiles.length, 4);
  for (const p of output.profiles) {
    assert.equal(p.distances.length, p.direction === 0 ? 5 : 4);
    near(p.length, p.direction === 0 ? 40 : 20);
    for (let n = 0; n < p.distances.length; n++) {
      const [x, y, z] = p.positions.subarray(n * 3, n * 3 + 3);
      near(p.values[n * 3], x); near(p.values[n * 3 + 1], 2 * y); near(p.values[n * 3 + 2], -z);
    }
  }
  assert.equal(f.reads.length, 1); r.close();
});

test("scalar and one-cell profiles contain one truthful curve/point, without invented vector components", async () => {
  const f = graph3DTask({ dimensions: [1, 3, 2] }), r = reader(), base = { ...request(f), regions: [], quantities: { elements: "JEdot" } };
  const first = await r.read(base), profile = { id: 1, graphId: 1, instanceKey: first.graphs[0].surfaces[0].instanceKey, direction: 0, index: 0 };
  const p = (await r.read({ ...base, profiles: [profile] })).profiles[0];
  assert.equal(p.components, 1); assert.equal(p.length, 0); assert.deepEqual(p.start, p.end);
  const [x, y, z] = p.start; near(p.values[0], (2 * x - 2 * y - .5 * z) * .001);
  assert.equal(graphProfileSeries(p).length, 1); assert.equal(graphProfileSeries(p)[0].points.length, 1); r.close();
});
