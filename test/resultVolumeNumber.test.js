import test from "node:test";
import assert from "node:assert/strict";
import { scalarScene, vectorScene } from "../src/services/results/resultPlots.js";
import { QUANTITIES } from "../src/services/results/resultMappings.js";
import { formatResultScalarTooltip, formatResultVectorTooltip } from "../src/services/visualization/geometryPicking.js";

test("MH/JE numbering uses each file's saved indices, including sampling and local images", () => {
  const record = { recordIndex: 3, name: "Selected", dp: [[3], [1], [1]], symLs: 2, symAs: 1, symPs: 1, symKya: 0, symKyp: 0 };
  const frame = { start: 11, count: 2, stride: 9, rowIndices: [1, 5], values: new Float64Array([1,2,3,4,5,6,7,8,9, 1,2,3,4,5,6,7,8,9]) };
  for (const key of ["M", "H"]) {
    const scene = vectorScene([{ record, frame }], QUANTITIES[key]);
    assert.deepEqual(scene.vectors.map(item => item.volumeNumber), [13, 17]);
    assert.match(formatResultVectorTooltip(scene.vectors[1]), /Z=3 мм; ЭО №17\n/);
  }
  for (const key of ["J", "E"]) {
    const scene = vectorScene([{ record, frame: { ...frame, start: 2 } }], QUANTITIES[key]);
    assert.deepEqual(scene.vectors.map(item => item.volumeNumber), [4, 8]);
  }
  for (const key of ["MHdot", "JEdot"]) {
    const scene = scalarScene([{ record, frame }], QUANTITIES[key]);
    assert.match(formatResultScalarTooltip(scene.points[0]), /ЭО №13/);
  }
  const virtual = vectorScene([{ record, frame }], QUANTITIES.Bv);
  assert.doesNotMatch(formatResultVectorTooltip(virtual.vectors[0]), /ЭО №/);
});
