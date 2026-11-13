// Exercise the real App and Tasks, not only the nested Three.js viewport.
// Native OPFS files; the system picker, read delays and lazy import timing are controlled.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createServer } from "vite";
import h5wasm from "h5wasm/node";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.CHECK_OUTPUT || "/tmp/clark-task-geometry-check";
const baseline = process.env.EXPECT_TRANSIENT === "1";
const fixture = await mkdtemp(resolve(root, "__task_geometry_check_"));
await mkdir(output, { recursive: true });
const checks = [], errors = [];
const pass = name => { checks.push(name); console.log("PASS", name); };
let server, browser, releaseModule;
try {
  await h5wasm.ready;
  const resultFile = new h5wasm.File(resolve(fixture, "field.h5"), "w");
  const header = resultFile.create_group("HEADER");
  for (const [name, value] of Object.entries({ columns: 3n, arrCount: 2n, hasCoo: 1n, inds1: 1n, numbs: 6n })) {
    header.create_dataset({ name, data: new BigInt64Array([value]) });
  }
  for (let step = 0; step <= 2; step++) {
    const rows = Array.from({ length: 6 }, (_, i) => [i, 0, 0, i+1+step, 0, 0, 10+i+step, 0, 0]);
    resultFile.create_dataset({ name: String(step).padStart(6, "0"), shape: [6, 9], data: new Float32Array(rows.flat()) });
  }
  resultFile.close();
  await writeFile(resolve(fixture, "index.html"), '<!doctype html><html><meta charset="utf-8"><body><div id="root"></div><script type="module" src="./fixture.jsx"></script></body></html>');
  await writeFile(resolve(fixture, "fixture.jsx"), `
import { render } from 'solid-js/web';
import App from '../src/App.jsx';
import { createGeometryViewSetting } from '../src/services/visualization/geometryViewSettings.js';
import { ResultService } from '../src/services/resultService.js';
import '../src/App.css';
const storage = await navigator.storage.getDirectory();
const disk = await storage.getDirectoryHandle('Geometry check disk', {create:true});
const catalog = await disk.getDirectoryHandle('clark.geometry', {create:true});
const project = await catalog.getDirectoryHandle('Project', {create:true});
const tasks = {}, records = {}, holds = new Set(), pending = [];
const reads = [], read = ResultService.prototype.read;
ResultService.prototype.read = function(slice) { reads.push([slice.name, slice.step]); return read.call(this, slice); };
let settingsHeld = false, releaseSettings;
const settingsGate = new Promise(resolve => { releaseSettings = resolve; });
const bytes = await (await fetch(new URL('./field.h5', import.meta.url))).arrayBuffer();
async function put(task, name, value) {
  const input = await task.getDirectoryHandle('input3XX', {create:true});
  const stream = await (await input.getFileHandle(name, {create:true})).createWritable();
  await stream.write(value); await stream.close();
}
for (const name of ['A','B']) {
  const task = tasks[name] = await project.getDirectoryHandle(name, {create:true});
  const record = {name,geoType:2,geo:[20,name==='A'?2:4,3,...Array(21).fill(0)],dr:[-10,0,0],dp:[1,2,3],targ:0,model:0,rv:1,xapName:'steel',
    sym:{vi:[0,0,0],r0:[0,0,0],yl:0,ya:0,tx:0,ls:1,as:1,ps:1,kya:0,kyp:0}};
  records[name] = JSON.stringify(record);
  await put(task,'general.txt',JSON.stringify({countTimeSteps:2,timeStep:.1,mirrorSymmetryX:-1,mirrorSymmetryY:-1}));
  await put(task,'kvs.txt',records[name]);
  await put(task,'_summary.txt',name+' geometry ready');
  if (name==='A') await put(task,'_2d.e3d','');
  const out = await task.getDirectoryHandle('output3XX', {create:true});
  for (const family of ['MH','JE']) {
    const stream = await (await out.getFileHandle(family+'.h5',{create:true})).createWritable();
    await stream.write(bytes); await stream.close();
  }
  if (name==='B') {
    const config = await (await task.getFileHandle('clark.viewer-graphs.json',{create:true})).createWritable();
    await config.write(JSON.stringify({version:1,settings:{view:{resultElementsQuantity:'M',elementsMode:'all'},selections:{elements:[],regions:[]}}}));
    await config.close();
  }
}
const nativeRead = FileSystemFileHandle.prototype.getFile;
FileSystemFileHandle.prototype.getFile = async function() {
  const file = await nativeRead.call(this);
  if (this.name==='clark.viewer-graphs.json') { settingsHeld=true; await settingsGate; }
  if(this.name==='kvs.txt') {
    let name; try {name=JSON.parse(await file.text()).name;} catch {return file;}
    if(holds.has(name)) await new Promise(resolve=>pending.push({name,resolve}));
  }
  return file;
};
window.showDirectoryPicker = async ()=>disk;
createGeometryViewSetting('resultElementsQuantity','M');
window.geometryFixture = {
  reads, settingsHeld:()=>settingsHeld, releaseSettings,
  hold:name=>holds.add(name), pending:name=>pending.filter(p=>p.name===name).length,
  release(name){holds.delete(name);for(let i=pending.length-1;i>=0;i--)if(pending[i].name===name)pending.splice(i,1)[0].resolve();},
  corrupt:name=>put(tasks[name],'kvs.txt','invalid input'),
  repair:name=>put(tasks[name],'kvs.txt',records[name]),
};
render(()=><App/>,document.getElementById('root'));
window.geometryFixture.ready=true;
`);
  server = await createServer({ root, cacheDir: resolve(output, "vite-cache"),
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await server.listen();
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true,
    args: [...JSON.parse(process.env.CHROMIUM_ARGS || "[]"), "--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20000);
  page.on("pageerror", e => errors.push(e.message));
  let moduleHeld = false;
  await page.route("**/src/tabs/SourcesFields3D.jsx*", async route => {
    moduleHeld = true;
    await new Promise(resolve => { releaseModule = resolve; });
    await route.continue();
  });
  await page.addInitScript(() => {
    window.geometryTextTrace = [];
    const inspect = node => {
      if (node.nodeType === 1 && ["SCRIPT", "STYLE"].includes(node.tagName)) return;
      const matches = (node.textContent || "").match(/Чтение геометрии…|Загрузка геометрии…|Геометрия выбранного задания|Загрузка 3D-модуля…|Нет геометрии для текущих настроек|Загрузка вкладки…/g);
      const activeTab = document.querySelector('.tabs-header [aria-current="page"]')?.textContent;
      if (matches) geometryTextTrace.push(...matches.filter(text => text !== "Загрузка вкладки…" || activeTab === "Источники / Поле 3D"));
    };
    new MutationObserver(records => records.forEach(record => {
      if (record.type === "characterData") inspect(record.target);
      else record.addedNodes.forEach(inspect);
    })).observe(document, { subtree: true, childList: true, characterData: true });
  });
  const name = fixture.split("/").at(-1);
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/${name}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.geometryFixture?.ready);
  const dialog = page.locator(".task-disk-dialog");
  await dialog.getByRole("button", { name: "Выбрать диск с проектами", exact: true }).click();
  await dialog.getByRole("button", { name: "Продолжить", exact: true }).click();
  await page.locator("#listProject").selectOption("Project");
  // After loading, the label also contains the last-opened marker's SVG title.
  const pick = name => page.locator(".task-status-label").filter({ hasText: new RegExp(name + "$") }).click();
  const previewReady = async name => {
    await page.waitForFunction(name => document.querySelector('[aria-label="Сводка исходных данных"]')?.value === name + " geometry ready", name);
    await page.locator('.task-geometry-preview .three-geometry-viewport[aria-busy="false"] canvas').waitFor();
  };
  await pick("A"); await previewReady("A");
  assert.equal(await page.locator(".task-geometry-preview .geometry-planar-mode").count(), 1);
  await page.evaluate(() => geometryFixture.hold("B")); await pick("B");
  await page.waitForFunction(() => geometryFixture.pending("B") > 0);
  if (baseline) await page.getByText("Чтение геометрии…", { exact: true }).waitFor();
  else {
    assert.equal(await page.locator(".task-geometry-preview").innerText(), "");
    assert.equal(await page.locator(".task-geometry-preview").getAttribute("aria-busy"), "true");
  }
  await page.evaluate(() => geometryFixture.release("B")); await previewReady("B");
  assert.equal(await page.locator(".task-geometry-preview .geometry-planar-mode").count(), 0);
  pass(baseline ? "reproduced the outer preview loading message" : "task preview remains silent while real input reads are delayed");

  // Late reads for a no-longer-selected task must not replace the current preview.
  await page.evaluate(() => geometryFixture.hold("A")); await pick("A");
  await page.waitForFunction(() => geometryFixture.pending("A") > 0);
  await pick("B"); await previewReady("B");
  await page.evaluate(() => geometryFixture.release("A"));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await previewReady("B");
  assert.equal(await page.locator(".task-geometry-preview .geometry-planar-mode").count(), 0);
  pass("rapid selection ignores the previous task's late geometry");

  assert.ok(moduleHeld, "the actual lazy 3D tab must still be loading");
  await page.getByRole("button", { name: "Загрузить для просмотра", exact: true }).click();
  await page.getByRole("button", { name: "Источники / Поле 3D", exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.tabs-header button[aria-current="page"]')?.textContent === "Источники / Поле 3D");
  if (baseline) await page.getByText("Загрузка вкладки…", { exact: true }).waitFor();
  else assert.equal(await page.getByText("Загрузка вкладки…", { exact: true }).count(), 0);
  releaseModule(); releaseModule = null;
  await page.locator('.source-geometry-viewport .three-geometry-viewport[aria-busy="false"] canvas').waitFor();
  pass(baseline ? "reproduced the lazy 3D tab loading message" : "the initial lazy 3D tab opens without a text placeholder");

  if (!baseline) {
    await page.waitForFunction(() => geometryFixture.settingsHeld());
    const reads = () => page.evaluate(() => geometryFixture.reads);
    const nextPaint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await nextPaint();
    assert.deepEqual(await reads(), []);
    await page.evaluate(() => geometryFixture.releaseSettings());
    const legend = name => page.locator(".source-geometry-viewport .geometry-scalar-legend").filter({ hasText: name });
    await legend("Намагниченность M").waitFor();
    assert.deepEqual(await reads(), [["MH", 0]]);
    pass("restoring settings starts exactly one real MH.h5 slice");
    const generalOptions = page.getByRole("button", { name: "Общие опции отображения", exact: true });
    await generalOptions.click();
    await page.getByRole("checkbox", { name: "Ортогональный вид", exact: true }).waitFor();
    assert.equal(await page.getByRole("checkbox", { name: "Показать начало СК", exact: true }).count(), 0);
    await generalOptions.click();

    const choose = async (radio, name) => {
      const menu = page.getByRole("button", { name: "Элементы", exact: true });
      if (await menu.getAttribute("aria-expanded") !== "true") await menu.click();
      await page.getByRole("radio", { name: radio }).check();
      await legend(name).waitFor();
    };
    await choose(/Напряженность МП/, "Напряжённость H");
    await choose(/Намагниченность,/, "Намагниченность M");
    await choose(/Плотность тока,/, "Плотность тока J");
    await choose(/Напряженность ЭП/, "Напряжённость E");
    assert.deepEqual(await reads(), [["MH", 0], ["JE", 0]]);
    pass("M/H/M and J/E update visible legends from one slice per file");

    await page.evaluate(() => {
      geometryFixture.canvas = document.querySelector(".source-geometry-viewport canvas");
      geometryFixture.gl = geometryFixture.canvas.getContext("webgl2");
      geometryFixture.buffers = 0;
      const gl = geometryFixture.gl, original = gl.createBuffer.bind(gl);
      gl.createBuffer = () => { geometryFixture.buffers++; return original(); };
    });
    const tab = name => page.locator(".tabs-header").getByRole("button", { name, exact: true }).click();
    await tab("Поле на линиях");
    await page.getByRole("slider", {name:"Текущий момент времени"}).waitFor();
    await page.keyboard.press("ArrowRight"); await nextPaint();
    assert.equal(await page.getByRole("slider", {name:"Текущий момент времени"}).inputValue(), "0");
    await tab("Источники / Поле 3D"); await legend("Напряжённость E").waitFor(); await nextPaint();
    assert.ok(await page.evaluate(() => geometryFixture.gl && !geometryFixture.gl.isContextLost()
      && document.querySelector(".source-geometry-viewport canvas") === geometryFixture.canvas && geometryFixture.buffers === 0));
    assert.deepEqual(await reads(), [["MH", 0], ["JE", 0]]);
    pass("tab return retains the canvas, live WebGL context and buffers with zero reads");

    await tab("Поле на линиях");
    await page.getByRole("slider", {name:"Текущий момент времени"}).fill("2"); await nextPaint();
    assert.deepEqual(await reads(), [["MH", 0], ["JE", 0]]);
    await tab("Источники / Поле 3D");
    await page.waitForFunction(() => geometryFixture.reads.some(([name,step]) => name==="JE" && step===2));
    await nextPaint();
    assert.deepEqual(await reads(), [["MH", 0], ["JE", 0], ["JE", 2]]);
    pass("time changes on another tab read only the final step when 3D resumes");
  }

  await page.getByRole("button", { name: "Выбор задания", exact: true }).click();
  await pick("A"); await previewReady("A");
  await page.getByRole("button", { name: "Загрузить для просмотра", exact: true }).click();
  await page.locator('.source-geometry-viewport .three-geometry-viewport[aria-busy="false"] canvas').waitFor();
  assert.equal(await page.locator(".source-geometry-viewport .geometry-planar-mode").count(), 1);
  if (!baseline) {
    await page.waitForFunction(() => geometryFixture.gl.isContextLost());
    assert.ok(await page.evaluate(() => !geometryFixture.canvas.isConnected));
  }
  pass("a second task loads into the main 3D view and retains its 2D marker");

  await page.getByRole("button", { name: "Выбор задания", exact: true }).click();
  await page.evaluate(() => geometryFixture.corrupt("B")); await pick("B");
  await page.locator('.task-error[role="alert"]').filter({ hasText: "kvs.txt, строка 1" }).waitFor();
  await page.evaluate(() => geometryFixture.repair("B"));
  await pick("A"); await previewReady("A"); await pick("B"); await previewReady("B");
  assert.equal(await page.locator('.task-error[role="alert"]').count(), 0);
  pass("a real input parse error remains visible and a repaired task recovers");

  const trace = await page.evaluate(() => geometryTextTrace);
  if (baseline) {
    assert.ok(trace.includes("Чтение геометрии…")); assert.ok(trace.includes("Загрузка вкладки…"));
    console.log("REPRODUCED", JSON.stringify([...new Set(trace)]));
  } else {
    assert.deepEqual(trace, []);
    pass("MutationObserver saw no transient geometry or 3D-tab text anywhere in the full App");
  }
  assert.deepEqual(errors, []);
  pass("no browser page errors");
  await page.screenshot({ path: resolve(output, "viewer-task-preview.png") });
  await writeFile(resolve(output, "trace.json"), JSON.stringify(trace, null, 2));
} finally {
  releaseModule?.();
  await writeFile(resolve(output, "checks.json"), JSON.stringify({ baseline, checks, errors }, null, 2));
  await browser?.close(); await server?.close(); await rm(fixture, { recursive: true, force: true });
}
