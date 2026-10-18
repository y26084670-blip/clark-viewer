import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import { parseGIF, decompressFrames } from "gifuct-js";

// Actual FieldLines/FieldAreas, Chart.js/WebGL, Solid and GIF worker in Chromium.
// Only the task/reader are deterministic fixtures; no user result is claimed here.
const root = fileURLToPath(new URL("..", import.meta.url));
const output = process.env.CHECK_OUTPUT || path.join(root, "verification-output");
const fixturePath = path.join(root, "__field_line_acceptance__");
await mkdir(output, { recursive: true });
await mkdir(fixturePath, { recursive: true });
await writeFile(path.join(fixturePath, "index.html"), '<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="./fixture.jsx"></script></body></html>');
await writeFile(path.join(fixturePath, "fixture.jsx"), `
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import Chart from "chart.js/auto";
import { FieldLines } from "/src/tabs/FieldLines.jsx";
import { FieldAreas } from "/src/tabs/FieldAreas.jsx";
import { createMovieExportController } from "/src/services/movie/movieExportController.js";
import { createMovieGifEncoder } from "/src/services/movie/movieGifEncoder.js";
import { MU0 } from "/src/services/results/resultMappings.js";
import "/src/App.css";
import "tabulator-tables/dist/css/tabulator.min.css";
let readCount = 0;
function makeTask(intervals=2, hasRanges=true) {
  const steps=Array.from({length:intervals+1},(_,i)=>i);
  const ranges = key => hasRanges ? { available:true,state:"complete",runId:"browser-task",revision:1,
    objectIds:[1],channelIds:["x","y","z","norm"].map(c=>key+"."+c),
    channelUnits:Array(4).fill(key==="Bs"?"T":"T*m"),stepIds:steps,times:steps.map(i=>i*.1),
    minimum:[-30,-40,-50,0].map(v=>key==="Bs"?v:v*MU0),maximum:[30,40,50,100].map(v=>key==="Bs"?v:v*MU0),
    validCount:Array(4).fill(12*steps.length),invalidCount:[0,0,0,0] } : {available:false,state:"missing",reason:"В HDF5 нет готовых глобальных пределов"};
  const header={inds1:[1],numbs:[12]};
  return {general:{countTimeSteps:intervals,timeStep:.1},regions:[{id:1,name:"Контрольная площадка",dp:[[2],[3]],symLs:2}],
    metadata:{HS:{header,steps,ranges:ranges("Bs")},AS:{header,steps,ranges:ranges("As")}},
    reader:{read:async request=>{readCount++;return {stride:6,count:request.count,every:1,
      values:new Float64Array(Array.from({length:request.count},(_,i)=>[request.start+i,10,20,3*(request.step+1),4,-12]).flat())};}}};
}
function Fixture() {
  const [task,setTask]=createSignal(makeTask());
  const [time,setTime]=createSignal(0),[regions,setRegions]=createSignal([1]);
  const [busy,setBusy]=createSignal(false),[area,setArea]=createSignal(false);
  const controller=createMovieExportController({createEncoder:createMovieGifEncoder});
  const props={get task(){return task();},get time(){return time();},get regions(){return regions();},setRegions,
    setTime, setMovieTime:setTime, get movieBusy(){return busy();},registerMovieAdapter:controller.register};
  window.__acceptance={
    setTime, area:setArea,
    load(intervals=2,hasRanges=true){setTime(0);setTask(makeTask(intervals,hasRanges));},
    snapshot(){const canvas=document.querySelector('.line-chart canvas');const chart=canvas?Chart.getChart(canvas):null;
      return {time:time(),readCount,busy:busy(), labels:chart?.data.datasets.map(d=>d.label)||[],
        values:chart?.data.datasets.map(d=>d.data.map(p=>p.y))||[],
        range:chart?{xMin:chart.scales.x.min,xMax:chart.scales.x.max,yMin:chart.scales.y.min,yMax:chart.scales.y.max}:null,
        chartArea:chart?{left:chart.chartArea.left,right:chart.chartArea.right,top:chart.chartArea.top,bottom:chart.chartArea.bottom}:null};},
    async exportMovie(){setBusy(true);const globalDisabledDuringExport=document.querySelector('input[aria-label="Общий минимакс"]')?.disabled;
      const viewButtonsDisabled=Array.from(document.querySelectorAll('.surface-view-buttons button')).map(button=>button.disabled);
      try{const value=await controller.run({intervalMs:100});
      return {filename:value.filename,frameCount:value.frameCount,globalDisabledDuringExport,viewButtonsDisabled,bytes:Array.from(new Uint8Array(await value.blob.arrayBuffer()))};}finally{setBusy(false);}}
  };
  return <div class="app-container"><header class="task-info-bar"><strong id="fixture-heading">Проверка компонент поля</strong></header>
    <main class="tabs-body"><Show when={!area()} fallback={<FieldAreas {...props}/>}><FieldLines {...props}/></Show></main></div>;
}
render(()=><Fixture/>,document.getElementById("root"));
`);

const checks = [], errors = [];
let server, browser, page;
function passed(name) { checks.push(name); console.log(`PASS ${checks.length}: ${name}`); }
const snapshot = () => page.evaluate(() => window.__acceptance.snapshot());
const waitCount = count => page.waitForFunction(count => window.__acceptance?.snapshot().labels.length === count, count);
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  server = await createServer({ configFile: false, root, plugins: [{name:"observe-test-cameras",enforce:"pre",transform(source,id){
    if (!id.endsWith("/src/components/SurfaceChart.jsx")) return;
    // Acceptance-only observation; no test globals in the shipped component.
    return source.replace('view("iso"); resize(); setReady(true);',
      'view("iso"); resize(); setReady(true); (window.__surfaceViews??=[]).push({camera,controls,host});');
  }},solid()], server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") console.error(message.text()); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__field_line_acceptance__/index.html`);
  await waitCount(16);
  assert.equal(await page.getByRole("checkbox", { name: "Все локальные образы", exact: true }).isChecked(), true);
  assert.ok((await snapshot()).labels.some(label => label.includes("LS 2")));
  passed("Initial view contains all four quantities and all local images");
  const trigger = page.getByRole("button", { name: "Компоненты", exact: true });
  await trigger.click();
  const panel = page.getByRole("group", { name: "Компоненты поля" });
  assert.equal(await panel.getByRole("checkbox").count(), 4);
  assert.equal(await panel.getByRole("checkbox", { name: "Модуль", exact: true }).isChecked(), true);
  passed("Components button opens four native checkboxes with the expected default");
  for (const name of ["X", "Y", "Z"]) assert.equal(await panel.getByRole("checkbox", { name, exact: true }).isChecked(), true);
  await waitCount(16);
  assert.equal(await panel.isVisible(), true);
  const all = await snapshot();
  assert.equal(all.values[all.labels.findIndex(label => label.endsWith("Bz"))][0], -12);
  assert.equal(all.values[all.labels.findIndex(label => label.endsWith("|B|"))][0], 13);
  passed("Four independent quantities render together; signed Z and full norm are correct");
  const bounds = await panel.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1440 && bounds.y + bounds.height <= 900);
  passed("Dropdown is not clipped by the chart toolbar");
  await page.screenshot({ path: path.join(output, "four-components.png"), fullPage: true });
  await page.keyboard.press("Escape");
  assert.equal(await panel.count(), 0);
  assert.equal(await trigger.evaluate(el => document.activeElement === el), true);
  passed("Escape closes the panel and returns focus to its button");
  await trigger.focus(); await page.keyboard.press("ArrowDown");
  assert.equal(await panel.getByRole("checkbox", { name: "Модуль", exact: true }).evaluate(el => document.activeElement === el), true);
  await page.keyboard.press("End");
  assert.equal(await panel.getByRole("checkbox", { name: "Z", exact: true }).evaluate(el => document.activeElement === el), true);
  await page.keyboard.press("Space"); await waitCount(12);
  await page.keyboard.press("Space"); await waitCount(16);
  await page.locator("#fixture-heading").click(); assert.equal(await panel.count(), 0);
  passed("Keyboard navigation and Space toggle work; outside click closes the panel");
  const global = page.getByRole("checkbox", { name: "За весь расчёт", exact: true });
  assert.equal(await global.isChecked(), true);
  const beforeTime = await snapshot();
  assert.equal(beforeTime.range.yMin, -57.5); assert.equal(beforeTime.range.yMax, 107.5);
  await page.evaluate(() => window.__acceptance.setTime(1));
  await page.waitForFunction(() => window.__acceptance.snapshot().values[0]?.[0] === 14);
  const afterTime = await snapshot();
  assert.equal(afterTime.readCount - beforeTime.readCount, 1);
  assert.deepEqual(afterTime.range, beforeTime.range);
  passed("One HDF5 read serves all checked curves at a new time; global axes remain unchanged");
  await page.getByRole("checkbox", { name: "Все локальные образы", exact: true }).uncheck(); await waitCount(8);
  await page.getByRole("checkbox", { name: "Все локальные образы", exact: true }).check(); await waitCount(16);
  assert.ok((await snapshot()).labels.some(label => label.includes("LS 2")));
  passed("All local images retain all four quantities");
  await page.getByRole("checkbox", { name: "Все локальные образы", exact: true }).uncheck(); await waitCount(8);
  const original = await snapshot();
  const dynamic = await page.evaluate(() => window.__acceptance.exportMovie());
  const dynamicBytes = Buffer.from(dynamic.bytes);
  const frames = decompressFrames(parseGIF(dynamicBytes.buffer.slice(dynamicBytes.byteOffset, dynamicBytes.byteOffset + dynamicBytes.byteLength)), true);
  assert.equal(dynamic.frameCount, 3); assert.equal(frames.length, 3);
  assert.ok(dynamicBytes.includes(Buffer.from("NETSCAPE2.0")));
  await writeFile(path.join(output, "components-dynamic.gif"), dynamicBytes);
  assert.deepEqual((await snapshot()).range, original.range); assert.equal((await snapshot()).time, original.time);
  assert.equal((await snapshot()).labels.length, 8);
  passed("Real GIF worker encodes three chart frames with the selected curves and restores time and global axes");
  const bb = await page.locator(".line-chart canvas").boundingBox();
  const ca = (await snapshot()).chartArea;
  await page.mouse.move(bb.x + ca.left + (ca.right - ca.left) * .2, bb.y + ca.top + (ca.bottom - ca.top) * .2);
  await page.mouse.down();
  await page.mouse.move(bb.x + ca.left + (ca.right - ca.left) * .8, bb.y + ca.top + (ca.bottom - ca.top) * .8, { steps: 5 });
  await page.mouse.up();
  const auto = page.getByRole("button", { name: "Авто", exact: true });
  assert.equal(await auto.getAttribute("aria-pressed"), "false");
  const manual = (await snapshot()).range;
  await page.evaluate(() => window.__acceptance.setTime(0));
  await page.waitForFunction(() => window.__acceptance.snapshot().values[0]?.[0] === 13);
  assert.deepEqual((await snapshot()).range, manual);
  await global.uncheck(); assert.deepEqual((await snapshot()).range, manual);
  await global.check(); assert.deepEqual((await snapshot()).range, manual);
  passed("Manual zoom survives time and global-mode changes while Auto is off");
  await auto.click();
  await page.waitForFunction(() => window.__acceptance.snapshot().range?.yMax === 107.5);
  passed("Auto restores the same global full-cycle union");
  await trigger.click();
  for (const name of ["Модуль", "X", "Y", "Z"]) await panel.getByRole("checkbox", { name, exact: true }).uncheck();
  await waitCount(0); await page.keyboard.press("Escape");
  const emptyReads = (await snapshot()).readCount;
  await page.evaluate(() => window.__acceptance.setTime(1));
  await page.waitForTimeout(80);
  assert.equal((await snapshot()).readCount, emptyReads);
  assert.ok(await page.getByText("Выберите компоненты поля", { exact: true }).count());
  const emptyError = await page.evaluate(async () => { try { await window.__acceptance.exportMovie(); return null; } catch (e) { return e.message; } });
  assert.match(emptyError, /Выберите компоненты/);
  passed("No checkbox selected means no curves, no HDF5 reads and an explicit GIF error rather than a hang");
  await trigger.click();
  for (const name of ["Модуль", "X", "Y", "Z"]) await panel.getByRole("checkbox", { name, exact: true }).check();
  await waitCount(8); await page.keyboard.press("Escape");
  await page.evaluate(() => window.__acceptance.load(2, false));
  await page.waitForFunction(() => window.__acceptance.snapshot().values[0]?.[0] === 13);
  assert.equal(await global.isDisabled(), true); assert.equal(await global.isChecked(), false);
  assert.match(await page.locator(".plot-status").innerText(), /общий диапазон недоступен/);
  passed("Old HDF5 files remain viewable and cannot claim a full-cycle scale");
  await page.evaluate(() => window.__acceptance.load(0, true));
  await waitCount(8);
  await page.waitForFunction(() => window.__acceptance.snapshot().range?.yMax === 107.5);
  // Loading a static task removes the time slider; let Chart.js finish its
  // responsive resize before freezing the capture dimensions.
  await page.evaluate(() => new Promise((resolve, reject) => {
    let previous, stable = 0, frames = 0;
    function check() {
      const canvas = document.querySelector(".line-chart canvas"), box = canvas.getBoundingClientRect();
      const size = [canvas.width, canvas.height, box.width, box.height].join(",");
      stable = size === previous ? stable + 1 : 0; previous = size;
      if (stable >= 4) resolve();
      else if (++frames > 120) reject(new Error("Chart size did not settle before static capture"));
      else requestAnimationFrame(check);
    }
    requestAnimationFrame(check);
  }));
  const single = await page.evaluate(() => window.__acceptance.exportMovie());
  const singleBytes = Buffer.from(single.bytes);
  const singleFrames = decompressFrames(parseGIF(singleBytes.buffer.slice(singleBytes.byteOffset, singleBytes.byteOffset + singleBytes.byteLength)), true);
  assert.equal(singleFrames.length, 1); assert.equal(single.frameCount, 1);
  assert.equal(singleBytes.includes(Buffer.from("NETSCAPE2.0")), false);
  await writeFile(path.join(output, "components-static.gif"), singleBytes);
  passed("Zero-interval task exports a genuine one-frame non-looping GIF with all selected curves");
  await page.locator('select:has(option[value="As"])').selectOption("As");
  await page.waitForFunction(() => window.__acceptance.snapshot().labels.some(label => label.endsWith("Ax")));
  const a = await snapshot();
  const mu0 = 4 * Math.PI * 1e-7;
  assert.ok(Math.abs(a.range.yMax - 107.5 * mu0) < 1e-15);
  assert.ok(Math.abs(a.values[a.labels.findIndex(label => label.endsWith("Ax"))][0] - 3 * mu0) < 1e-15);
  assert.equal(a.labels.length, 8);
  passed("Switching B to A keeps the component mask; saved values and global bounds use one unit conversion");
  await page.setViewportSize({ width: 800, height: 720 });
  await trigger.click();
  const small = await panel.boundingBox();
  assert.ok(small.x >= 0 && small.y >= 0 && small.x + small.width <= 800 && small.y + small.height <= 720);
  await page.screenshot({ path: path.join(output, "narrow-components-menu.png"), fullPage: true });
  await page.keyboard.press("Escape");
  passed("Dropdown stays within a narrower viewport after toolbar wrapping");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => window.__acceptance.area(true));
  await page.locator('.surface-chart canvas').nth(2).waitFor();
  assert.equal(await page.locator('select:has(option[value="norm"])').count(), 0);
  assert.equal(await page.getByRole("button", { name: "Компоненты", exact: true }).count(), 0);
  const areaGlobal = page.getByRole("checkbox", { name: "Общий минимакс", exact: true });
  const surfaceLimits = () => page.locator(".surface-legend span").evaluateAll(nodes => nodes.map(node => parseFloat(node.textContent)));
  const waitSurface = index => page.waitForFunction(index => {
    const text = document.querySelector(".plot-status")?.textContent || "";
    return text.includes("показан шаг " + index) && !text.includes("Чтение");
  }, index);
  await waitSurface(0); assert.equal(await areaGlobal.isChecked(), true);
  assert.deepEqual(await surfaceLimits(), [-12, 4, -12, 4, -12, 4]);
  const row = await page.locator('.field-area-component').evaluateAll(nodes => nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width};}));
  assert.equal(row.length,3); assert.equal(row[0].y,row[1].y); assert.equal(row[1].y,row[2].y);
  assert.ok(row[1].x>=row[0].x+row[0].width && row[2].x>=row[1].x+row[1].width);
  const areaReads = (await snapshot()).readCount;
  await areaGlobal.uncheck(); assert.deepEqual(await surfaceLimits(), [3,3,4,4,-12,-12]);
  assert.equal((await snapshot()).readCount, areaReads);
  passed("Three X/Y/Z panels occupy one row; the checkbox changes common current-frame bounds to independent bounds without reading again");
  await page.evaluate(() => window.__acceptance.area(false));
  assert.equal(await global.isChecked(), true);
  await page.evaluate(() => window.__acceptance.area(true)); await waitSurface(0);
  assert.equal(await areaGlobal.isChecked(), false);
  await areaGlobal.check(); assert.deepEqual(await surfaceLimits(), [-12,4,-12,4,-12,4]);
  passed("Area scale has its own persistent preference and leaves line full-cycle scale unchanged");
  await page.evaluate(() => window.__acceptance.load(2, true)); await waitSurface(0);
  const beforeAreaTime = (await snapshot()).readCount;
  await page.evaluate(() => window.__acceptance.setTime(2)); await waitSurface(2);
  assert.deepEqual(await surfaceLimits(), [-12,9,-12,9,-12,9]); assert.equal((await snapshot()).readCount, beforeAreaTime + 1);
  passed("Time changes update the shared component limits from one selected LS plane, without using full-cycle RANGES");
  const views = () => page.evaluate(()=>window.__surfaceViews.filter(s=>s.host.isConnected).map(({camera:c,controls:o})=>[...c.position.toArray(),...c.quaternion.toArray(),...c.up.toArray(),...o.target.toArray(),c.zoom]));
  const assertLinked = async () => { const v=await views();assert.equal(v.length,3);for(const w of v.slice(1)) for(let i=0;i<w.length;i++) assert.ok(Math.abs(w[i]-v[0][i])<1e-10);return v; };
  const panels=page.locator('.field-area-component');
  const viewButtons=page.getByRole('group',{name:'Ракурс всех компонент',exact:true});
  assert.equal(await viewButtons.count(),1);
  assert.equal(await panels.locator('button').count(),0);
  const toolbar=page.locator('.field-area-panel > .plot-toolbar');
  assert.equal(await toolbar.getByRole('group',{name:'Ракурс всех компонент',exact:true}).count(),1);
  const controlRows=await toolbar.locator(':scope > select, :scope > label, :scope > .surface-view-buttons').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {top:r.top,bottom:r.bottom};}));
  assert.ok(controlRows.length>=3);
  assert.ok(Math.max(...controlRows.map(r=>r.top))<Math.min(...controlRows.map(r=>r.bottom)), 'Common buttons share the quantity/minimax row');
  const initialView=await assertLinked();
  for(const name of ['Вид X','Вид Y','Вид Z']) {
    const before=await views();
    assert.equal(await page.getByRole('button',{name,exact:true}).count(),1);
    await viewButtons.getByRole('button',{name,exact:true}).click();
    assert.notDeepEqual(await assertLinked(),before);
  }
  assert.equal(await page.getByRole('button',{name:'Вписать',exact:true}).count(),1);
  passed("One shared set of four camera buttons sits beside quantity/minimax; X/Y/Z commands update all surfaces");
  const beforeDrag=await views(), surface=await panels.nth(2).locator('canvas').boundingBox();
  await page.mouse.move(surface.x+surface.width*.45,surface.y+surface.height*.45);await page.mouse.down();
  await page.mouse.move(surface.x+surface.width*.65,surface.y+surface.height*.6,{steps:8});await page.mouse.up();
  assert.notDeepEqual(await assertLinked(),beforeDrag);
  await viewButtons.getByRole('button',{name:'Вписать',exact:true}).click();
  const fitted=await assertLinked();
  for(let p=0;p<3;p++) for(let i=0;i<fitted[p].length;i++) assert.ok(Math.abs(fitted[p][i]-initialView[p][i])<1e-10);
  await page.screenshot({ path: path.join(output, "area-components-common.png"), fullPage: true });
  passed("Real OrbitControls drag and view buttons synchronize all three cameras without feedback");
  const originalViews=await views(), areaMovie = await page.evaluate(() => window.__acceptance.exportMovie());
  const areaBytes = Buffer.from(areaMovie.bytes);
  const areaFrames = decompressFrames(parseGIF(areaBytes.buffer.slice(areaBytes.byteOffset, areaBytes.byteOffset + areaBytes.byteLength)), true);
  assert.equal(areaMovie.frameCount, 3); assert.equal(areaFrames.length, 3);
  assert.equal(areaMovie.globalDisabledDuringExport, true);
  assert.deepEqual(areaMovie.viewButtonsDisabled,[true,true,true,true]);
  assert.equal(await viewButtons.locator('button:disabled').count(),0);
  assert.equal(await areaGlobal.isDisabled(), false); assert.deepEqual(await surfaceLimits(), [-12,9,-12,9,-12,9]);
  assert.equal((await snapshot()).time, 2);
  const restoredViews=await assertLinked();
  for(let p=0;p<3;p++) for(let i=0;i<restoredViews[p].length;i++) assert.ok(Math.abs(restoredViews[p][i]-originalViews[p][i])<1e-10);
  // The composited frame contains all three canvases, not only the last registered renderer.
  assert.ok(areaFrames[0].dims.width>surface.width*2.5);
  await writeFile(path.join(output, "area-components.gif"), areaBytes);
  passed("Real GIF includes all three surfaces with per-frame scales and restores the selected time and linked view");
  await page.locator('select:has(option[value="As"])').selectOption("As");
  await page.waitForFunction(()=>Math.abs(parseFloat(document.querySelector('.surface-legend span')?.textContent)+12*4*Math.PI*1e-7)<1e-10);
  const areaA = await surfaceLimits();
  for(let i=0;i<6;i++) assert.ok(Math.abs(areaA[i]-(i%2?9:-12)*mu0)<1e-10);
  passed("All A components and their common interval use exactly one unit conversion");
  await page.evaluate(() => window.__acceptance.load(2, false)); await waitSurface(0);
  assert.equal(await areaGlobal.isDisabled(), false); assert.equal(await areaGlobal.isChecked(), true);
  const oldA=await surfaceLimits(); for(let i=0;i<6;i++) assert.ok(Math.abs(oldA[i]-(i%2?4:-12)*mu0)<1e-10);
  await areaGlobal.uncheck(); const localA=await surfaceLimits();
  for(let i=0;i<6;i++) assert.ok(Math.abs(localA[i]-[3,3,4,4,-12,-12][i]*mu0)<1e-10);
  passed("Common and independent component scales also work without an HDF5 range index");
  await page.setViewportSize({width:800,height:720});
  const narrow=await panels.evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().y));assert.deepEqual(narrow,[narrow[0],narrow[0],narrow[0]]);
  const scroll=await page.locator('.field-area-plots').evaluate(n=>({width:n.clientWidth,scroll:n.scrollWidth}));assert.ok(scroll.scroll>scroll.width);
  const sharedButtons=await viewButtons.boundingBox();
  assert.ok(sharedButtons.x>=0 && sharedButtons.x+sharedButtons.width<=800);
  for(const button of await viewButtons.getByRole('button').all()) assert.ok(await button.isVisible());
  await page.screenshot({path:path.join(output,'area-components-narrow.png'),fullPage:true});
  passed("Narrow screens retain a single horizontally scrollable component row");
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, "browser.json"), JSON.stringify({ passed: checks.length, checks, errors }, null, 2));
  console.log(`BROWSER_OK ${checks.length}/${checks.length}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
  await writeFile(path.join(output, "browser.json"), JSON.stringify({ passed: checks.length, checks, errors, failure: error.stack }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  await rm(fixturePath, { recursive: true, force: true });
  // Headless browser/Vite shutdown must not leave the fixture behind.
  for (const resource of [browser, server]) {
    let closeTimeout;
    try {
      await Promise.race([resource?.close(), new Promise(resolve => { closeTimeout = setTimeout(resolve, 5000); })]);
    } finally { clearTimeout(closeTimeout); }
  }
}
