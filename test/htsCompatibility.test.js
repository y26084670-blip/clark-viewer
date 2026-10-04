import test from "node:test";
import assert from "node:assert/strict";
import { classifyGeometryMaterial, GEOMETRY_MATERIAL_KINDS as K } from "../src/services/visualization/geometryMaterialStyle.js";

test("HTS classification accepts legacy and canonical flags with unchanged defaults", () => {
  const record = { targ: 0, model: 2 };
  for (const [mu, ro, expected] of [
    [false, false, K.NEUTRAL], [true, false, K.HTSC_MAGNETIC],
    [false, true, K.HTSC_CURRENT], [true, true, K.HTSC_BOTH],
  ]) {
    assert.equal(classifyGeometryMaterial(record, { htsMu: mu, htsRo: ro }), expected);
    assert.equal(classifyGeometryMaterial(record, { htcMu: mu, htcRo: ro }), expected);
    assert.equal(classifyGeometryMaterial(record, { htsMu: mu, htsRo: ro, htcMu: !mu, htcRo: !ro }), expected);
  }
  assert.equal(classifyGeometryMaterial(record, {}), K.HTSC_BOTH);
  assert.equal(classifyGeometryMaterial(record, { htsMu: false, htcRo: true }), K.HTSC_CURRENT);
  assert.equal(classifyGeometryMaterial(record, { htsMu: 0, htsRo: 1 }), K.HTSC_CURRENT);
});
