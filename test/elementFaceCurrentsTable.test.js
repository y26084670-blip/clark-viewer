import assert from "node:assert/strict";
import test from "node:test";
import { faceCurrentCellKey, faceCurrentContourPositions, formatSignificantNumber, selectedFaceCurrentSections, selectedFaceCurrentTotal } from "../src/services/visualization/elementFaceCurrentsTable.js";
import { elementFaceCurrents } from "../src/services/results/elementFaceCurrents.js";
import { buildGeometryScene } from "../src/services/visualization/geometrySceneModel.js";
import { buildGeometryTimeModel } from "../src/services/visualization/geometryTimeModel.js";
import { graph3DTask } from "../scripts/test-support/graph3DFixture.js";

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

function currentFrame({ task, buffers }, step = 0) {
  const metadata = task.metadata.JE, stride = metadata.header.stride;
  return elementFaceCurrents({ ...metadata, read({ start, count }) {
    return { stride, values: buffers.JE[step].subarray(start * stride, (start + count) * stride) };
  } }, task, step);
}

const batches = scene => scene.primitives.map(primitive => ({ primitive, instances: primitive.instances }));

test("each selected JE column outlines four full edges at its computed layer centre", () => {
  const fixture = graph3DTask({ dimensions: [5, 4, 3] });
  const frame = currentFrame(fixture), lengths = [40, 20, 10];
  const coordinates = [[.1, .9, .5], [.125, .875, .375], [1/6, 5/6, .5]];
  for (const [axis, slots] of coordinates.entries()) for (const [slot, t] of slots.entries()) {
    const sections = selectedFaceCurrentSections(frame, new Set([key(1, 3 * axis + slot)]));
    const positions = faceCurrentContourPositions(sections, batches(fixture.scene));
    assert.equal(positions.length, 24);
    const b = (axis + 1) % 3, c = (axis + 2) % 3;
    const corners = [[0, 0], [lengths[b], 0], [lengths[b], lengths[c]], [0, lengths[c]]];
    for (const [edge, [u, v]] of corners.entries()) {
      const start = positions.slice(6 * edge, 6 * edge + 3);
      const next = 6 * ((edge + 1) % 4);
      assert.deepEqual(positions.slice(6 * edge + 3, 6 * edge + 6), positions.slice(next, next + 3));
      assert.ok(Math.abs(start[axis] - t * lengths[axis]) < 1e-10);
      assert.ok(Math.abs(start[b] - u) < 1e-10 && Math.abs(start[c] - v) < 1e-10);
    }
  }
  const sparse = graph3DTask({ dimensions: [1, 2, 3] });
  assert.equal(selectedFaceCurrentSections(currentFrame(sparse), new Set([1, 2, 5, 9, 10].map(col => key(1, col)))).size, 0);
});

test("each boundary total selects the same six sections and overlapping selections draw them once", () => {
  const fixture = graph3DTask({ dimensions: [3, 3, 3] }), frame = currentFrame(fixture);
  const contours = columns => faceCurrentContourPositions(
    selectedFaceCurrentSections(frame, new Set(columns.map(col => key(1, col)))), batches(fixture.scene));
  const boundary = contours([0, 1, 3, 4, 6, 7]);
  assert.equal(boundary.length, 6 * 24);
  for (const selected of [[9], [10], [9, 10, 0, 4]]) assert.deepEqual(contours(selected), boundary);
  assert.equal(contours([9, 2]).length, 7 * 24);
  assert.equal(contours([0]).length, 24);
  assert.deepEqual(contours([]), []);
});

test("selections distinguish hexahedra and saved images and follow a warped moving section", () => {
  const fixture = graph3DTask({ images: 2, mirror: 1, dimensions: [5, 4, 3] });
  const { task } = fixture, moving = task.elements[1];
  moving.geo = moving.geo.map((vertex, i) => i === 7 ? [48, 24, 14] : vertex);
  moving.indMove = 1;
  task.moves = [{ angle: [[0, 0, 0, 0], [.25, 0, 0, 90]], position: [[0, 0, 0, 0], [.25, 7, 8, 9]] }];
  const selected = new Set([key(1, 0), key(2, 2, { ps: 2 })]);
  const corners = [[80, 80, 0], [80, 100, 0], [84, 102, 12], [80, 80, 10]];
  for (const step of [0, 1]) {
    const scene = buildGeometryScene(buildGeometryTimeModel(task, task.moves, step).model);
    const sections = selectedFaceCurrentSections(currentFrame(fixture, step), selected);
    const visible = batches(scene);
    assert.equal(faceCurrentContourPositions(sections, visible).length, 2 * 24);
    const positions = faceCurrentContourPositions(sections, [visible[1]]);
    assert.equal(positions.length, 24);
    for (const [edge, corner] of corners.entries()) {
      const [x, y, z] = corner;
      const expected = step ? [67 - y, 8 + x - 60, 9 + z] : corner;
      expected.forEach((v, i) => assert.ok(Math.abs(positions[edge * 6 + i] - v) < 1e-9));
    }
    const otherImages = visible[1].instances.filter(i => i.ps === 0 || i.mirrorX);
    assert.deepEqual(faceCurrentContourPositions(sections, [{ ...visible[1], instances: otherImages }]), []);
  }
});
