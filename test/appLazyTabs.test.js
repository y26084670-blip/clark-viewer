import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");

test("all result tabs share cached lazy loaders and are preloaded on mount", () => {
  for (const name of ["SourcesFields3D","WorkingPoints","FieldLines","FieldAreas","Fluxes","ForcesMoments"]) {
    assert.match(source, new RegExp(`${name}: \\(\\\\\\) => import`));
    assert.match(source, new RegExp(`const ${name} = tabComponent\\("${name}"\\)`));
  }
  assert.match(source, /const tabModulePromises = new Map\(\)/);
  assert.match(source, /if \(!tabModulePromises\.has\(name\)\) tabModulePromises\.set\(name, loader\(\)\)/);
  assert.match(source, /onMount\(\(\) => \{[\s\S]*void preloadViewerTabs\(\)/);
});

test("lazy tab import failure has an explicit reload message and action", () => {
  assert.match(source, /<ErrorBoundary/);
  assert.match(source, /Версия Viewer обновлена\. Перезагрузите страницу\./);
  assert.match(source, /window\.location\.reload\(\)/);
  assert.match(source, /<Suspense fallback=\{<div class="empty-task">Загрузка вкладки…<\/div>\}>/);
});
