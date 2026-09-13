import test from "node:test";
import assert from "node:assert/strict";
import { chartPanLimits, chartZoomLimits } from "../src/services/visualization/chartZoom.js";

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

const panLimits = { xMin: -5, xMax: 15, yMin: 0, yMax: 50 };
const panStart = { x: 90, y: 40 };

test("Chart pan follows the pointer in every direction and preserves both scale spans", () => {
  for (const [end, expected] of [
    [{ x: 120, y: 60 }, { xMin: -8, xMax: 12, yMin: 10, yMax: 60 }],
    [{ x: 60, y: 20 }, { xMin: -2, xMax: 18, yMin: -10, yMax: 40 }],
    [{ x: 120, y: 20 }, { xMin: -8, xMax: 12, yMin: -10, yMax: 40 }],
    [{ x: 60, y: 60 }, { xMin: -2, xMax: 18, yMin: 10, yMax: 60 }],
  ]) {
    const result = chartPanLimits(panStart, end, area, panLimits);
    assert.deepEqual(result, expected);
    assert.equal(result.xMax - result.xMin, panLimits.xMax - panLimits.xMin);
    assert.equal(result.yMax - result.yMin, panLimits.yMax - panLimits.yMin);
  }
});

test("Chart pan preserves stationary axes and leaves its initial snapshot unchanged", () => {
  const snapshot = Object.freeze({ ...panLimits });
  assert.deepEqual(chartPanLimits(panStart, panStart, area, snapshot), panLimits);
  assert.deepEqual(chartPanLimits(panStart, { x: 120, y: 40 }, area, snapshot),
    { xMin: -8, xMax: 12, yMin: 0, yMax: 50 });
  assert.deepEqual(chartPanLimits(panStart, { x: 90, y: 60 }, area, snapshot),
    { xMin: -5, xMax: 15, yMin: 10, yMax: 60 });
  assert.deepEqual(chartPanLimits(panStart, panStart, area, snapshot), panLimits);
  assert.deepEqual(snapshot, panLimits);
});

test("Chart pan continues beyond the plot and data limits under pointer capture", () => {
  assert.deepEqual(chartPanLimits(panStart, { x: 490, y: 240 }, area, panLimits),
    { xMin: -45, xMax: -25, yMin: 100, yMax: 150 });
  assert.deepEqual(chartPanLimits(panStart, { x: -310, y: -160 }, area, panLimits),
    { xMin: 35, xMax: 55, yMin: -100, yMax: -50 });
});

test("Chart pan rejects malformed, degenerate and unrepresentable ranges", () => {
  const end = { x: 120, y: 60 };
  for (const args of [
    [null, end, area, panLimits],
    [panStart, { ...end, x: NaN }, area, panLimits],
    [panStart, end, undefined, panLimits],
    [panStart, end, { ...area, right: area.left }, panLimits],
    [panStart, end, { ...area, bottom: area.top - 1 }, panLimits],
    [panStart, end, { ...area, left: -1e308, right: 1e308 }, panLimits],
    [panStart, end, area, null],
    [panStart, end, area, { ...panLimits, xMax: Infinity }],
    [panStart, end, area, { ...panLimits, xMax: panLimits.xMin }],
    [panStart, end, area, { ...panLimits, yMax: panLimits.yMin - 1 }],
    [panStart, end, area, { ...panLimits, xMin: -1e308, xMax: 1e308 }],
    [panStart, { x: 1e308, y: 60 }, area, { ...panLimits, xMax: 1e308 }],
    [panStart, { x: 1e308, y: 60 }, area, panLimits],
  ]) assert.equal(chartPanLimits(...args), null);
});
