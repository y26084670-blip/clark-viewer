// Exercise the real App and Tasks, not only the nested Three.js viewport.
// Native OPFS files; the system picker, read delays and lazy import timing are controlled.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.CHECK_OUTPUT || "/tmp/clark-task-geometry-check";
const baseline = process.env.EXPECT_TRANSIENT === "1";
const fixture = await mkdtemp(resolve(root, "__task_geometry_check_"));
await mkdir(output, { recursive: true });
const checks = [], errors = [];
const pass = name => { checks.push(name); console.log("PASS", name); };
let server, browser, releaseModule;
try {
  await writeFile(resolve(fixture, "index.html"), '<!doctype html><html><meta charset="utf-8"><body><div id="root"></div><script type="module" src="./fixture.jsx"></script></body></html>');
  await writeFile(resolve(fixture, "fixture.jsx"), `
import { render } from 'solid-js/web';
import App from '../src/App.jsx';
import { createGeometryViewSetting } from '../src/services/visualization/geometryViewSettings.js';
import '../src/App.css';
const storage = await navigator.storage.getDirectory();
const disk = await storage.getDirectoryHandle('Geometry check disk', {create:true});
const catalog = await disk.getDirectoryHandle('clark.geometry', {create:true});
const project = await catalog.getDirectoryHandle('Project', {create:true});
const tasks = {}, records = {}, holds = new Set(), pending = [];
async function put(task, name, value) {
  const input = await task.getDirectoryHandle('input3XX', {create:true});
  const stream = await (await input.getFileHandle(name, {create:true})).createWritable();
  await stream.write(value); await stream.close();
}
for (const name of ['A','B']) {
  const task = tasks[name] = await project.getDirectoryHandle(name, {create:true});
  const record = {name,geoType:2,geo:[20,name==='A'?2:4,3,...Array(21).fill(0)],dr:[-10,0,0],dp:[1,2,3],targ:0,model:0,rv:0,
    sym:{vi:[0,0,0],r0:[0,0,0],yl:0,ya:0,tx:0,ls:1,as:1,ps:1,kya:0,kyp:0}};
  records[name] = JSON.stringify(record);
  await put(task,'general.txt',JSON.stringify({countTimeSteps:0,timeStep:0,mirrorSymmetryX:-1,mirrorSymmetryY:-1}));
  await put(task,'kvs.txt',records[name]);
  await put(task,'_summary.txt',name+' geometry ready');
  if (name==='A') await put(task,'_2d.e3d','');
}
const nativeRead = FileSystemFileHandle.prototype.getFile;
FileSystemFileHandle.prototype.getFile = async function() {
  const file = await nativeRead.call(this);
  if(this.name==='kvs.txt') {
    let name; try {name=JSON.parse(await file.text()).name;} catch {return file;}
    if(holds.has(name)) await new Promise(resolve=>pending.push({name,resolve}));
  }
  return file;
};
window.showDirectoryPicker = async ()=>disk;
for (const key of ['resultElementsQuantity','resultRegionsQuantity','resultVirtualQuantity']) createGeometryViewSetting(key,'none')[1]('none');
window.geometryFixture = {
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
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
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
      if (matches) geometryTextTrace.push(...matches);
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

  await page.getByRole("button", { name: "Выбор задания", exact: true }).click();
  await pick("A"); await previewReady("A");
  await page.getByRole("button", { name: "Загрузить для просмотра", exact: true }).click();
  await page.locator('.source-geometry-viewport .three-geometry-viewport[aria-busy="false"] canvas').waitFor();
  assert.equal(await page.locator(".source-geometry-viewport .geometry-planar-mode").count(), 1);
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
