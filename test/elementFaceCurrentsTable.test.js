import assert from "node:assert/strict";
import test from "node:test";
import { faceCurrentCellKey, formatSignificantNumber, selectedFaceCurrentTotal } from "../src/services/visualization/elementFaceCurrentsTable.js";

const image = (values, extra = {}) => ({ ls: 1, as: 1, ps: 1, values, ...extra });
const key = (id, column, extra = {}) => faceCurrentCellKey(id, image([], extra), column);

test("face-current display uses a point, significant digits and nonzero tiny values", () => {
  assert.equal(formatSignificantNumber(1.23456789), "1.235");
  assert.equal(formatSignificantNumber(-1.23456789, 5), "-1.2346");
  assert.equal(formatSignificantNumber(1.23456789e-12, 5), "1.2346e-12");
  assert.equal(formatSignificantNumber(-0), "0");
  assert.equal(formatSignificantNumber(null), "—");
});

test("selected sums use full precision and retain small terms between opposite currents", () => {
  const groups = [{ id: 7, images: [image([1e16, 1, -1e16, 1.23456789, -1.2345, null])] }];
  assert.equal(selectedFaceCurrentTotal(groups, new Set([key(7, 0), key(7, 1), key(7, 2)])), 1);
  const difference = selectedFaceCurrentTotal(groups, new Set([key(7, 3), key(7, 4)]));
  assert.ok(Math.abs(difference - 0.00006789) < 1e-15);
  assert.equal(formatSignificantNumber(difference, 5), "0.00006789");
  assert.equal(selectedFaceCurrentTotal(groups, new Set()), 0);
  assert.equal(selectedFaceCurrentTotal(groups, new Set([key(7, 5)])), 0);
});

test("selection distinguishes element and symmetry images and follows the next frame's values", () => {
  const groups = [
    { id: 7, images: [image([2]), image([3], { ls: 2 }), image([5], { as: 2 }), image([7], { ps: 2 })] },
    { id: 8, images: [image([11])] },
  ];
  const selected = new Set([key(7, 0, { ls: 2 }), key(7, 0, { as: 2 }), key(8, 0)]);
  assert.equal(selectedFaceCurrentTotal(groups, selected), 19);
  const next = groups.toReversed().map(element => ({ ...element, images: element.images.toReversed()
    .map(row => ({ ...row, values: row.values.map(value => -2 * value) })) }));
  assert.equal(selectedFaceCurrentTotal(next, selected), -38);
  assert.equal(selectedFaceCurrentTotal(next.filter(element => element.id === 7), selected), -16);
});
