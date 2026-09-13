import test from "node:test";
import assert from "node:assert/strict";
import { chartZoomLimits } from "../src/services/visualization/chartZoom.js";

const area = { left: 40, right: 240, top: 20, bottom: 120 };
const scales = {
  x: { getValueForPixel: pixel => (pixel - 40) / 10 - 5 },
  y: { getValueForPixel: pixel => 50 - (pixel - 20) / 2 },
};

test("Chart frame maps both axes and accepts all drag directions", () => {
  const expected = { xMin: 0, xMax: 10, yMin: 10, yMax: 40 };
  for (const [start, end] of [
    [{ x: 90, y: 40 }, { x: 190, y: 100 }],
    [{ x: 190, y: 100 }, { x: 90, y: 40 }],
    [{ x: 90, y: 100 }, { x: 190, y: 40 }],
    [{ x: 190, y: 40 }, { x: 90, y: 100 }],
  ]) assert.deepEqual(chartZoomLimits(start, end, area, scales), expected);
});

test("Chart frame clamps to plot limits even when captured pointer leaves canvas", () => {
  assert.deepEqual(chartZoomLimits({ x: 90, y: 40 }, { x: 400, y: 200 }, area, scales),
    { xMin: 0, xMax: 15, yMin: 0, yMax: 40 });
  assert.deepEqual(chartZoomLimits({ x: 90, y: 100 }, { x: -50, y: -50 }, area, scales),
    { xMin: -5, xMax: 0, yMin: 10, yMax: 50 });
});

test("Chart frame ignores clicks, narrow selections and invalid ranges", () => {
  const start = { x: 90, y: 40 };
  for (const end of [start, { x: 94, y: 100 }, { x: 190, y: 44 }, { x: NaN, y: 100 }]) {
    assert.equal(chartZoomLimits(start, end, area, scales), null);
  }
  assert.equal(chartZoomLimits(start, { x: 190, y: 100 }, { ...area, right: area.left }, scales), null);
  assert.equal(chartZoomLimits(start, { x: 190, y: 100 }, area,
    { ...scales, x: { getValueForPixel: () => 1 } }), null);
  assert.equal(chartZoomLimits(start, { x: 190, y: 100 }, area,
    { ...scales, y: { getValueForPixel: () => Infinity } }), null);
});
