import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const jsx = readFileSync(new URL("../src/components/geometry/ResultsGeometryViewport.jsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/components/geometry/ResultsGeometryViewport.css", import.meta.url), "utf8");

test("General options own the palette, performance and flight controls in that order", () => {
  assert.doesNotMatch(jsx, /openPanel\(\) === "view"/);
  const general = jsx.slice(jsx.indexOf('<Show when={openPanel() === "general"}>'));
  assert.ok(general.indexOf('geometry-viewer-palette-select') < general.indexOf('checked={performanceEnabled()}'));
  assert.ok(general.indexOf('checked={performanceEnabled()}') < general.indexOf('geometry-flight-command'));
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
  assert.match(css, /\.geometry-performance-overlay\s*\{[^}]*top:\s*8px;[^}]*left:\s*8px;/);
});
