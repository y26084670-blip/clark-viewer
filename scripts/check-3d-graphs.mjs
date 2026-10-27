import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
const planeName = direction => `плоскость DV${direction} (${[4,3,2][direction-1]})`;
const root = fileURLToPath(new URL("..", import.meta.url)), out = process.env.CHECK_OUTPUT || "/tmp/clark-3d-graphs";
const dir = await mkdtemp(path.join(root, "__graph3d_check_")); await mkdir(out, { recursive: true });
await writeFile(path.join(dir, "index.html"), '<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/scripts/test-support/graph3DBrowserFixture.jsx"></script></body></html>');
const inspect = { name: "surface-graph-inspection", enforce: "pre", configureServer(server) {
  server.middlewares.use(async (request, response, next) => {
    if (!request.url?.startsWith("/__graph-libav/")) return next();
    try { const file = path.basename(request.url); response.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : "text/javascript"); response.end(await readFile(path.join(root, "node_modules/@libav.js/variant-webm-vp9/dist", file))); } catch (error) { next(error); }
  });
}, transform(code, id) {
  if (id.endsWith("/src/tabs/SourcesFields3D.jsx")) return code.replace('  return <div class="results-layout">',
    '  window.graphUI = { slices: graphSlices, active: activeSlice, results: graphResults, only: graphsOnly, busy: graphBusy, error: graphError };\n  return <div class="results-layout">');
  if (id.endsWith("/src/components/geometry/ThreeGeometryViewport.jsx")) return code.replace('  return (\n    <div',
    `  window.graphScene = { ready: () => ready(), snapshot: () => {
      const meshes=[];graphRoot?.traverse(o=>{if(o.name==="result-graph-surface")meshes.push({id:o.userData.graphId,component:o.userData.component,visible:o.parent.visible,color:o.material.color.getHexString(),lit:o.material.isMeshStandardMaterial,palette:o.material.vertexColors,factor:o.userData.factor,positions:Array.from(o.geometry.attributes.position.array.slice(0,9)),basePositions:Array.from(o.userData.surface.positions.slice(0,9))});});
      return {meshes,preview:graphRoot?.getObjectByName("graph-slice-preview")?.children.length??0,previewSpec:props.graphPreview,previewPoint:graphRoot?.getObjectByName("graph-slice-preview")?.children[0]?.geometry.attributes.position.array.slice(0,3),selectionTypes:graphRoot?.getObjectByName("graph-selected-element")?.children.map(o=>o.type)??[],selected:graphRoot?.getObjectByName("graph-selected-element")?.children.length??0,
        camera:[camera?.position.toArray(),camera?.quaternion.toArray(),controls?.target.toArray()],direction:camera?.position.clone().sub(controls.target).normalize().toArray(),layers:[...resultLayerStates.values()].reduce((n,s)=>n+(s.vectorRoot?.children.length??0)+(s.scalarRoot?.children.length??0),0)};
    }};\n  return (\n    <div`);
} };
let browser, server, page; const errors = [], checks = [];
const pass = text => { checks.push(text); console.log("PASS " + checks.length + ": " + text); };
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  server = await createServer({ configFile: false, root, plugins: [inspect, solid()], optimizeDeps: { entries: [path.join(dir, "index.html")] }, server: { host: "127.0.0.1", port: 0, hmr: false } }); await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--disable-dev-shm-usage"] });
  page = await browser.newPage({ viewport: { width: 1920, height: 1080 } }); page.on("pageerror", e => errors.push(e.message)); page.on("console", message => { if (message.type() === "error") console.error(message.text()); });
  await page.goto("http://127.0.0.1:" + server.httpServer.address().port + "/" + path.basename(dir) + "/index.html");
  await page.waitForFunction(() => window.graphScene?.ready());
  const scene = () => page.evaluate(() => graphScene.snapshot()), graphs = page.locator(".source-graphs-panel");
  const open = async () => { if (!await graphs.isVisible()) await page.getByRole("button", { name: "Графики", exact: true }).click(); };
  const waitGraphs = () => page.waitForFunction(() => !graphUI.busy() && !graphUI.error());
  await open();
  for (const label of ["Только графики", "Графики над площадками", "Срезы в элементах"]) assert.equal(await graphs.getByRole("checkbox", { name: label, exact: true }).isChecked(), false);
  for (const label of ["Изменить", "Построить", "Повернуть"]) assert.equal(await graphs.getByRole("button", { name: label, exact: true }).count(), 0);
  assert.equal(await graphs.locator('input[type="color"]').count(), 0);
  assert.equal(await page.getByRole("button", { name: "Показ", exact: true }).count(), 0);
  await page.waitForFunction(() => graphScene.snapshot().layers > 0);
  await graphs.getByRole("checkbox", { name: "Только графики", exact: true }).check(); await page.waitForFunction(() => graphScene.snapshot().layers === 0);
  pass("New graph controls start unchecked; obsolete controls are absent and Only graphs suppresses result layers");

  const size = page.getByRole("slider", { name: "Размер представления", exact: true });
  const transparency = page.getByRole("slider", { name: "Прозрачность геометрии и рёбер", exact: true });
  assert.equal((await size.boundingBox()).width, (await transparency.boundingBox()).width);
  assert.ok((await size.boundingBox()).x < (await transparency.boundingBox()).x);
  assert.equal(await size.getAttribute("min"), "-2"); assert.equal(await size.getAttribute("max"), "3");
  const mark = await page.locator(".geometry-size-range > i").boundingBox(), slider = await size.boundingBox();
  assert.ok(Math.abs(mark.x + mark.width / 2 - slider.x - slider.width * .4) < 1);
  if (await graphs.isVisible()) await page.getByRole("button", { name: "Графики", exact: true }).click();
  await page.getByRole("button", { name: "Общие опции отображения", exact: true }).click();
  const general = page.getByRole("dialog", { name: "Общие опции отображения", exact: true });
  const order = await general.locator("select,label,button").allTextContents();
  assert.ok(order.at(-3).includes("палитра")); assert.ok(order.at(-2).includes("Производительность")); assert.equal(order.at(-1), "Полёт");
  assert.ok(await general.evaluate(el => el.scrollHeight <= el.clientHeight + 1));
  await page.screenshot({ path: path.join(out, "general-options.png"), fullPage: true });
  pass("Logarithmic size covers 0.01–1000 with the nominal marker at 40%; equal-width sliders and General options without scrolling");

  await open(); await graphs.getByRole("checkbox", { name: "Графики над площадками", exact: true }).check();
  await page.waitForFunction(() => graphScene.snapshot().meshes.length === 3); await waitGraphs();
  const rgb = (await scene()).meshes; assert.deepEqual(rgb.map(m => m.color), ["ff0000", "00ff00", "0000ff"]); assert.ok(rgb.every(m => m.lit && !m.palette));
  pass("Area graphs build three lit RGB surfaces in the real worker");

  await graphs.getByRole("button", { name: "Добавить", exact: true }).click();
  const add = graphs.locator(".source-slice-add");
  for (const direction of [1, 2, 3]) {
    await add.getByRole("menuitem", { name: planeName(direction), exact: true }).hover();
    await page.waitForFunction(d => graphScene.snapshot().preview > 0 && graphScene.snapshot().previewSpec.direction === d - 1, direction);
  }
  await add.getByRole("menuitem", { name: planeName(1), exact: true }).click();
  await page.waitForFunction(() => graphUI.slices().length === 1 && graphScene.snapshot().meshes.length === 5); await waitGraphs();
  assert.equal(await graphs.getByRole("checkbox", { name: "Срезы в элементах", exact: true }).isChecked(), true);
  assert.equal((await scene()).selected, 2); assert.ok((await scene()).meshes.filter(m => m.id === 1).every(m => m.palette && m.lit));
  assert.deepEqual((await scene()).selectionTypes, ["Mesh", "Mesh"]);
  assert.equal(await graphs.getByRole("spinbutton", { name: "Дискрет среза 1", exact: true }).inputValue(), "2");
  for (const button of ["Добавить", "Удалить"]) assert.ok((await graphs.getByRole("button", { name: button, exact: true }).getAttribute("title")).length > 50);
  for (const checkbox of await graphs.getByRole("checkbox").all()) assert.ok(await checkbox.evaluate(el => !!el.closest("[title]")?.title));
  pass("Direction menus show actual discrete counts; hover previews, tooltips and light element tint replace the extra wireframe");

  const discrete = graphs.getByRole("spinbutton", { name: "Дискрет среза 1", exact: true }), discreteReads = await page.evaluate(() => graphFixture.reads.length);
  assert.deepEqual(await discrete.evaluate(el => { const s=getComputedStyle(el); return [s.color,s.backgroundColor]; }), ["rgb(237, 242, 247)", "rgb(48, 57, 67)"]);
  await discrete.fill("4"); await page.waitForFunction(() => graphUI.results().find(g=>g.id===1)?.discrete === 4); await waitGraphs();
  assert.equal((await scene()).meshes.find(m=>m.id===1).basePositions[0], 35);
  assert.ok(await discrete.evaluate(el => document.activeElement === el));
  await discrete.press("ArrowDown"); await page.waitForFunction(() => graphUI.results().find(g=>g.id===1)?.discrete === 3);
  await discrete.fill("0"); await graphs.locator("th").first().click(); assert.equal(await discrete.inputValue(), "3");
  await graphs.locator("tbody tr").first().getByRole("button", { name: planeName(1), exact: true }).click();
  await graphs.getByRole("menuitem", { name: planeName(1), exact: true }).hover();
  await page.waitForFunction(() => graphScene.snapshot().previewSpec?.discrete === 3);
  assert.equal((await scene()).previewPoint[0], 25);
  await graphs.getByRole("menuitem", { name: planeName(1), exact: true }).click();
  assert.equal(await page.evaluate(() => graphFixture.reads.length), discreteReads);
  pass("Editing the discrete moves the plane through EO centres, preserves keyboard focus and cached reads, and rejects invalid numbers");

  const reads = await page.evaluate(() => graphFixture.reads.length), before = (await scene()).meshes.find(m => m.id === 1).factor;
  for (const [exponent, factor] of [[-2,.01],[3,1000]]) {
    await size.evaluate((input, value) => { input.value = String(value); input.dispatchEvent(new Event("input", { bubbles: true })); }, exponent);
    await page.waitForFunction(({before, factor}) => Math.abs(graphScene.snapshot().meshes.find(m => m.id === 1).factor / before - factor) < 1e-6, {before, factor});
  }
  assert.equal(await page.evaluate(() => graphFixture.reads.length), reads);
  await size.evaluate(input => { input.value = "0"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  if (await graphs.isVisible()) await page.getByRole("button", { name: "Графики", exact: true }).click();
  await page.getByRole("button", { name: "Общие опции отображения", exact: true }).click();
  await page.getByRole("combobox", { name: "Палитра результатов", exact: true }).selectOption("Viridis");
  assert.equal(await page.evaluate(() => graphFixture.reads.length), reads);
  await open(); const row = graphs.locator("tbody tr").first();
  await row.getByRole("button", { name: planeName(1), exact: true }).click();
  await graphs.getByRole("menuitem", { name: planeName(3), exact: true }).hover(); await page.waitForFunction(() => graphScene.snapshot().previewSpec?.direction === 2);
  await graphs.getByRole("menuitem", { name: planeName(3), exact: true }).click();
  assert.equal(await discrete.inputValue(), "1"); assert.equal(await discrete.getAttribute("max"), "2");
  await discrete.fill("2"); await row.getByRole("combobox").selectOption("1"); await waitGraphs();
  await page.waitForFunction(() => graphUI.results().find(g => g.id === 1)?.component === 1);
  assert.equal(await page.evaluate(() => graphFixture.reads.length), reads);
  pass("Height, palette, direction and component update immediately; editing a slice reuses cached HDF5 data");

  await graphs.getByRole("checkbox", { name: "Срезы в элементах", exact: true }).uncheck(); await page.waitForFunction(() => graphScene.snapshot().meshes.length === 3);
  assert.equal(await graphs.locator("tbody tr").count(), 1);
  await graphs.getByRole("checkbox", { name: "Срезы в элементах", exact: true }).check(); await waitGraphs();
  await page.waitForFunction(() => graphScene.snapshot().meshes.length === 5);
  await page.evaluate(() => { graphFixture.holdReads(); graphFixture.setTime(1); }); await page.waitForFunction(() => graphFixture.pendingReads() > 0);
  assert.equal((await scene()).meshes.length, 5); assert.ok(await page.evaluate(() => graphUI.results().every(g => g.timeIndex === 0)));
  await page.evaluate(() => graphFixture.releaseReads()); await page.waitForFunction(() => !graphUI.busy() && graphUI.results().every(g => g.timeIndex === 1));
  pass("Hiding retains table rows; time changes retain visible surfaces until their replacement is ready");

  await open(); await graphs.getByRole("button", { name: "Добавить", exact: true }).click();
  await add.getByRole("combobox", { name: "Элемент для среза", exact: true }).selectOption("1");
  await add.getByRole("menuitem", { name: planeName(2), exact: true }).click(); await waitGraphs();
  assert.equal(await graphs.locator("tbody tr").count(), 2);
  await graphs.locator("tbody tr").first().getByRole("button", { name: planeName(3), exact: true }).click();
  await graphs.getByRole("menuitem", { name: planeName(1), exact: true }).hover();
  await graphs.getByRole("spinbutton", { name: "Дискрет среза 2", exact: true }).focus();
  assert.equal(await graphs.getByRole("menuitem").count(), 0);
  await page.waitForFunction(() => graphScene.snapshot().preview === 0);
  await graphs.locator("tbody tr").first().locator("td").first().click(); assert.equal(await page.evaluate(() => graphUI.active()), 1);
  await graphs.getByRole("button", { name: "Удалить", exact: true }).click(); await waitGraphs();
  assert.equal(await graphs.locator("tbody tr").count(), 1); assert.equal(await graphs.locator("tbody tr td").nth(1).innerText(), "2");
  await page.getByRole("button", { name: "Объемные элементы", exact: true }).click(); await page.getByRole("radio", { name: /Потери на токи проводимости/ }).check();
  await open(); await waitGraphs(); assert.equal(await graphs.locator("tbody select").isDisabled(), true);
  assert.equal(await page.evaluate(() => graphUI.results().find(g => g.kind === "slice").components), 1);
  pass("One table row selects its highlighted element; Delete removes that row and scalar quantities disable component selection");

  await graphs.getByRole("checkbox", { name: "Срезы в элементах", exact: true }).uncheck();
  await page.evaluate(() => graphFixture.setMounted(false)); await page.waitForFunction(() => !document.querySelector(".source-graphs-panel"));
  await page.evaluate(() => graphFixture.setMounted(true)); await page.waitForFunction(() => graphScene.ready()); await open();
  assert.equal(await graphs.locator("tbody tr").count(), 1); assert.equal(await graphs.getByRole("checkbox", { name: "Срезы в элементах", exact: true }).isChecked(), false);
  await graphs.getByRole("checkbox", { name: "Срезы в элементах", exact: true }).check(); await waitGraphs();
  await page.getByRole("button", { name: "Графики", exact: true }).click();
  pass("Tab remount preserves slices, selection and visibility settings");

  for (const key of ["x", "y", "z"]) for (const negative of [false, true]) {
    await page.keyboard.press(negative ? `Control+${key}` : key);
    await page.waitForFunction(({ axis, sign }) => graphScene.snapshot().direction[axis] * sign > .999, { axis: "xyz".indexOf(key), sign: negative ? -1 : 1 });
  }
  await page.keyboard.press("Control+a"); await page.waitForFunction(() => graphScene.snapshot().direction.every(x => x > .5));
  const canvas = page.locator(".geometry-viewer-canvas-region canvas").first(), box = await canvas.boundingBox();
  await page.mouse.move(box.x + 50, box.y + box.height - 50); await page.waitForSelector(".geometry-viewport-tooltip");
  const tooltip = page.locator(".geometry-viewport-tooltip"); const hint = await tooltip.innerText(); assert.equal(hint.split("\n").length, 3); assert.ok(hint.includes("Ctrl+X"));
  await page.mouse.move(box.x + box.width * .65, box.y + box.height * .55); await page.mouse.down(); await page.mouse.move(box.x + box.width * .7, box.y + box.height * .6, { steps: 5 }); await page.mouse.up();
  const stopped = (await scene()).camera; await page.mouse.move(box.x + box.width * .75, box.y + box.height * .65, { steps: 5 }); assert.deepEqual((await scene()).camera, stopped);
  await page.keyboard.press("Control+a");
  await page.screenshot({ path: path.join(out, "surfaces.png"), fullPage: true });
  pass("X/Y/Z and Ctrl+X/Y/Z face the requested sides, the cube has three help lines, and camera drag ends on mouse release");

  const movie = await page.evaluate(async () => {
    const { createMovieExportController } = await import("/src/services/movie/movieExportController.js");
    const { createMovieWebmEncoder } = await import("/src/services/movie/movieWebmEncoder.js"); const samples = [];
    const controller = createMovieExportController({ createEncoder: () => {
      const encoder = createMovieWebmEncoder({ runtimeUrl: new URL("/__graph-libav/libav-6.10.9.0-webm-vp9.mjs", location.href).href });
      return { addFrame(frame, options) {
        let color = 0, white = 0;
        for (let i = 0; i < frame.data.length; i += 4) { const [r,g,b] = frame.data.subarray(i,i+3); if (Math.max(r,g,b) > 150 && Math.max(r,g,b) - Math.min(r,g,b) > 100) color++; if (r > 245 && g > 245 && b > 245) white++; }
        samples.push({ times: graphUI.results().map(g => g.timeIndex), meshes: graphScene.snapshot().meshes.length, color, white }); return encoder.addFrame(frame, options);
      }, finish: () => encoder.finish(), close: () => encoder.close() };
    } });
    controller.register(graphFixture.capture()); graphFixture.setBusy(true);
    try { const result = await controller.run({ intervalMs: 100 }); const video = document.createElement("video"), url = URL.createObjectURL(result.blob); video.muted = true; video.src = url;
      await new Promise((resolve,reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error("WebM decode failed")); });
      const decoded = [video.videoWidth, video.videoHeight]; URL.revokeObjectURL(url);
      return { frames: result.frameCount, width: result.width, height: result.height, decoded, samples, bytes: Array.from(new Uint8Array(await result.blob.arrayBuffer())) };
    } finally { graphFixture.setBusy(false); controller.dispose(); }
  });
  await writeFile(path.join(out, "surfaces.webm"), new Uint8Array(movie.bytes)); delete movie.bytes;
  assert.equal(movie.frames, 3); assert.deepEqual(movie.decoded, [movie.width, movie.height]);
  movie.samples.forEach((sample, index) => { assert.deepEqual(sample.times, [index,index]); assert.equal(sample.meshes, 5); assert.ok(sample.color > 100 && sample.white > 100, JSON.stringify(sample)); });
  assert.ok(await page.evaluate(() => graphUI.results().every(g => g.timeIndex === 1)));
  await writeFile(path.join(out, "movie.json"), JSON.stringify(movie, null, 2));
  pass("Real moview encodes and decodes WebM with refreshed area/slice surfaces in every frame and restores time");
  await page.setViewportSize({ width: 1440, height: 900 }); await open(); const panel = await graphs.boundingBox();
  assert.ok(panel.x >= 0 && panel.x + panel.width <= 1440 && panel.y + panel.height <= 900);
  for (const recordIndex of [0,1]) for (const direction of [0,1,2]) {
    await graphs.getByRole("button", { name: "Добавить", exact: true }).click();
    await add.getByRole("combobox", { name: "Элемент для среза", exact: true }).selectOption(String(recordIndex));
    await add.getByRole("menuitem", { name: planeName(direction+1), exact: true }).click(); await waitGraphs();
  }
  const scroll = graphs.locator(".source-slice-scroll");
  assert.ok(await scroll.evaluate(element => element.scrollHeight > element.clientHeight));
  await scroll.hover(); await page.mouse.wheel(0, 300); await page.waitForFunction(() => document.querySelector(".source-slice-scroll").scrollTop > 0);
  const textColor = await graphs.locator("tbody td").first().evaluate(element => getComputedStyle(element).color);
  assert.equal(textColor, "rgb(237, 242, 247)");
  await page.screenshot({ path: path.join(out, "panel.png"), fullPage: true });
  pass("The graph panel fits 1440px and the slice table has its own vertical scroll");
  assert.deepEqual(errors, []); await writeFile(path.join(out, "browser.json"), JSON.stringify({ checks, errors }, null, 2)); console.log("BROWSER_OK " + checks.length);
} catch (error) {
  await page?.screenshot({ path: path.join(out, "failure.png"), fullPage: true }).catch(() => {});
  const state = await page?.evaluate(() => ({ slices: graphUI.slices(), error: graphUI.error(), scene: graphScene.snapshot() })).catch(() => null);
  await writeFile(path.join(out, "browser.json"), JSON.stringify({ checks, errors, state, error: error.stack }, null, 2)); console.error(error); process.exitCode = 1;
} finally { await browser?.close(); await server?.close(); await rm(dir, { recursive: true, force: true }); }
