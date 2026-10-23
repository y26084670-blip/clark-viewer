import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import { parseGIF, decompressFrames } from "gifuct-js";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(path.join(root, "__full_results_check_"));
let server, browser;
try {
  await writeFile(path.join(directory, "index.html"), '<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="/scripts/test-support/fullResultsBrowserFixture.js"></script></body></html>');
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  server = await createServer({ configFile: false, root, plugins: [solid()],
    server: { host: "127.0.0.1", port: 0, hmr: false }, optimizeDeps: { include: ["solid-js", "solid-js/web", "three"] } });
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--disable-dev-shm-usage"] });
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/${path.basename(directory)}/index.html`);
  await page.waitForFunction(() => typeof window.runFullResultsCheck === "function");
  const report = await page.evaluate(() => window.runFullResultsCheck());
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.reads, report.counts.map(count => ({ count, every: 1 })));
  for (const mode of report.modes) {
    assert.deepEqual(mode.displayed, report.counts, mode.mode);
    assert.equal(mode.glError, 0, mode.mode);
  }
  assert.equal(report.lastCurrent, 7);
  assert.deepEqual(report.volume.dimensions, [193, 2, 2]);
  assert.equal(report.volume.glError, 0);
  assert.ok(report.volume.pixel.slice(0, 3).some(channel => channel < 240), "volume ray must render past the former step ceiling");
  const initial = await page.evaluate(() => window.fullResultsCube.snapshot());
  for (const direction of [[1, 0, 0], [1, 1, 0], [1, 1, 1]]) {
    const point = await page.evaluate(direction => window.fullResultsCube.project(direction), direction);
    await page.mouse.click(...point);
    const snapshot = await page.evaluate(() => window.fullResultsCube.snapshot());
    const norm = Math.hypot(...direction);
    assert.ok(snapshot.direction.every((value, axis) => Math.abs(value - direction[axis] / norm) < 1e-7));
    assert.ok(Math.abs(snapshot.distance - initial.distance) < 1e-7);
    assert.deepEqual(snapshot.target, initial.target); assert.equal(snapshot.zoom, initial.zoom);
    assert.equal(snapshot.sceneClicks, 0);
  }
  const point = await page.evaluate(() => window.fullResultsCube.project([1, 1, 1]));
  await page.mouse.move(...point); await page.mouse.down();
  await page.mouse.move(point[0] + 15, point[1] - 10, { steps: 4 }); await page.mouse.up();
  const dragged = await page.evaluate(() => window.fullResultsCube.snapshot());
  assert.ok(dragged.direction.some(value => Math.abs(value - 1 / Math.sqrt(3)) > .01));
  assert.ok(Math.abs(dragged.distance - initial.distance) < 1e-7); assert.equal(dragged.sceneClicks, 0);
  const corner = await page.evaluate(() => window.fullResultsCube.project(window.fullResultsCube.snapshot().direction));
  await page.mouse.move(...corner); await page.mouse.down();
  await page.mouse.move(300, 300, { steps: 4 }); await page.mouse.up();
  assert.equal((await page.evaluate(() => window.fullResultsCube.snapshot())).sceneClicks, 0,
    "cube drag released over the scene must not select a result");
  await page.mouse.click(300, 300);
  assert.equal((await page.evaluate(() => window.fullResultsCube.snapshot())).sceneClicks, 1,
    "normal scene clicks remain enabled");
  await page.evaluate(() => window.closeFullResultsCheck());
  await page.evaluate(() => window.mountFullViewportCheck());
  await page.waitForFunction(() => window.fullViewport.state());
  for (const projection of ["orthographic", "perspective"]) {
    await page.evaluate(projection => window.fullViewport.projection(projection), projection);
    await page.waitForFunction(projection => window.fullViewport.state()?.projection === projection, projection);
    const before = await page.evaluate(() => window.fullViewport.state());
    const point = await page.evaluate(() => window.fullViewport.project([1, 0, 0]));
    await page.mouse.click(...point);
    await page.waitForFunction(() => {
      const { position, target } = window.fullViewport.state();
      return position[0] > target[0] && Math.abs(position[1] - target[1]) < 1e-5 && Math.abs(position[2] - target[2]) < 1e-5;
    });
    const after = await page.evaluate(() => window.fullViewport.state());
    assert.deepEqual(after.target, before.target); assert.equal(after.zoom, before.zoom);
    await page.mouse.move(400, 300); await page.mouse.down();
    await page.mouse.move(440, 320, { steps: 4 }); await page.mouse.up();
    await page.waitForFunction(before => JSON.stringify(window.fullViewport.state().quaternion) !== JSON.stringify(before), after.quaternion);
  }
  const movie = await page.evaluate(() => window.fullViewport.movie());
  assert.ok(movie.cubePixels > 400, "coloured ViewCube must be present in the captured canvas");
  assert.equal(decompressFrames(parseGIF(Uint8Array.from(movie.bytes).buffer), true).length, 2);
  assert.deepEqual(await page.evaluate(() => window.fullViewport.errors), []);
  if (process.env.CHECK_SCREENSHOT) await page.screenshot({ path: process.env.CHECK_SCREENSHOT });
  await page.evaluate(() => window.fullViewport.close());
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: "Chromium", ...report, viewCube: "face, edge, corner, drag and isolated picking passed",
    viewport: "both projections, OrbitControls after cube clicks, canvas capture and two-frame GIF passed" }, null, 2));
} finally {
  await browser?.close(); await server?.close(); await rm(directory, { recursive: true, force: true });
}
