import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const jsx = readFileSync(new URL("../src/components/geometry/ResultsGeometryViewport.jsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/components/geometry/ResultsGeometryViewport.css", import.meta.url), "utf8");

test("Show panel has fixed no-scroll height and one dark palette selector", () => {
  assert.match(jsx, /classList=\{\{ "is-view-panel": openPanel\(\) === "view" \}\}/);
  assert.match(jsx, /class="geometry-viewer-palette-select"/);
  assert.doesNotMatch(jsx, /geometry-viewer-options-title">Палитра/);
  assert.doesNotMatch(jsx, /<span>Палитра<\/span>/);
  assert.match(jsx, /<option value=\{name\}>палитра \{name\}<\/option>/);
  assert.match(css, /\.geometry-viewer-options-panel\.is-view-panel\s*\{[\s\S]*height:\s*330px;[\s\S]*overflow:\s*hidden;/);
  assert.match(css, /\.geometry-viewer-palette-select\s*\{[\s\S]*background:\s*#141a20;[\s\S]*color:\s*#edf2f7;[\s\S]*color-scheme:\s*dark;/);
});
