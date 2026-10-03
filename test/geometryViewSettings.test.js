import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRoot } from "solid-js";
import { createGeometryViewSetting } from "../src/services/visualization/geometryViewSettings.js";

test("опции компонентов сохраняются после уничтожения владельца и смены задания", () => {
  const components = ["../src/components/geometry/ResultsGeometryViewport.jsx","../src/tabs/SourcesFields3D.jsx"];
  const entries = [...new Map(components.flatMap(path => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    return [...source.matchAll(/createGeometryViewSetting\("([^"]+)",\s*([^)]*)\)/g)]
      .map(([, name, initial]) => [name, JSON.parse(initial)]);
  })).entries()];
  assert.ok(entries.length > 0);
  assert.equal(new Map(entries).get("vectorStyle"), "thin");
  assert.equal(new Map(entries).get("resultVectorColorMap"), false);
  assert.equal(new Map(entries).get("resultPalette"), "Viridis");
  const expected = new Map();
  let dispose;
  createRoot(cleanup => {
    dispose = cleanup;
    for (const [name, initial] of entries) {
      const [read, write] = createGeometryViewSetting(name, initial);
      assert.equal(read(), initial);
      const changed = typeof initial === "boolean" ? !initial :
        typeof initial === "number" ? initial + 0.25 :
        name === "renderModeBeforeSources" ? "wireframe" : initial + "-changed";
      write(changed);
      expected.set(name, changed);
    }
  });
  dispose();
  createRoot(cleanup => {
    for (const [name, initial] of entries) {
      const [read] = createGeometryViewSetting(name, initial);
      assert.equal(read(), expected.get(name), name);
    }
    cleanup();
  });
});

test("повторное подключение не сбрасывает false и 0; настройки независимы", () => {
  const [, setA] = createGeometryViewSetting("test:a", true);
  const [, setB] = createGeometryViewSetting("test:b", 1);
  setA(false); setB(0);
  assert.equal(createGeometryViewSetting("test:a", true)[0](), false);
  assert.equal(createGeometryViewSetting("test:b", 1)[0](), 0);
});

test("новый владелец получает реактивные изменения после уничтожения старого", () => {
  execFileSync(process.execPath, ["--conditions=browser", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { createRoot, createComputed } from "solid-js";
    import { createGeometryViewSetting } from "./src/services/visualization/geometryViewSettings.js";
    let dispose, observed;
    createRoot(cleanup => {
      dispose = cleanup;
      createGeometryViewSetting("reactive", 1);
    });
    dispose();
    createRoot(cleanup => {
      const [read, write] = createGeometryViewSetting("reactive", 99);
      createComputed(() => { observed = read(); });
      assert.equal(observed, 1);
      write(2);
      assert.equal(observed, 2);
      cleanup();
    });
  `], { cwd: new URL("../", import.meta.url), stdio: "pipe" });
});
