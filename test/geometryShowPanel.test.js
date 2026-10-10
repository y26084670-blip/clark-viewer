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


test("General options use one dark vector type selector without a duplicate label", () => {
  assert.match(jsx, /class="geometry-viewer-vector-type-select"/);
  assert.doesNotMatch(jsx, /<span>Вид векторов<\/span>/);
  assert.match(jsx, /<option value="thin">тип векторов: Тонкие<\/option>/);
  assert.match(jsx, /<option value="solid">тип векторов: Объемные<\/option>/);
  assert.match(css, /\.geometry-viewer-vector-type-select\s*\{[\s\S]*background:\s*#141a20;[\s\S]*color:\s*#edf2f7;[\s\S]*color-scheme:\s*dark;/);
});


test("Show panel exposes performance toggle and the canvas owns the adaptive overlay", () => {
  assert.match(jsx, />\s*Производительность\s*<\/label>/);
  assert.match(jsx, /class="geometry-performance-overlay"/);
  assert.match(jsx, />TIME</);
  assert.match(jsx, />VECTOR LINE</);
  assert.match(css, /\.geometry-performance-overlay\s*\{[\s\S]*top:\s*8px;[\s\S]*right:\s*8px;/);
});
