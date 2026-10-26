import assert from "node:assert/strict";
import test from "node:test";
import { chartTooltipBounds } from "../src/services/visualization/chartTooltip.js";

test("tooltip opens below the pointer with a bounded scrolling viewport", () => {
  const box = chartTooltipBounds({ x: 200, y: 150 }, { width: 1200, height: 800 }, 1000);
  assert.equal(box.top, 162);
  assert.equal(box.maxHeight, 220);
  assert.ok(box.left > 200 && box.left + box.width <= 1192);
});

test("tooltip fits small and edge viewports, preferring the space below", () => {
  for (const width of [240, 800, 1440]) for (const height of [200, 600, 900]) {
    for (const x of [5, width / 2, width - 5]) for (const y of [5, height / 2, height - 5]) {
      const box = chartTooltipBounds({ x, y }, { width, height });
      assert.ok(box.left >= 8 && box.top >= 8);
      assert.ok(box.left + box.width <= width - 8);
      assert.ok(box.top + box.maxHeight <= height - 8);
      assert.ok(box.maxHeight > 0 && box.maxHeight <= 220);
      if (height - 8 - y - 12 >= 80) assert.equal(box.top, y + 12);
    }
  }
});
