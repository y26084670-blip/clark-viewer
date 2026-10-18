import { createServer } from "vite";
import solid from "vite-plugin-solid";
import { mkdir, writeFile, rm } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseGIF, decompressFrames } from "gifuct-js";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = path.join(root, "__plot_constructor_check__");
const output = process.env.CHECK_OUTPUT || "/tmp/clark-graphs-check";
await mkdir(fixture, { recursive: true }); await mkdir(output, { recursive: true });
await writeFile(path.join(fixture, "index.html"), '<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="./fixture.jsx"></script></body></html>');
await writeFile(path.join(fixture, "app.html"), '<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="./app.jsx"></script></body></html>');
await writeFile(path.join(fixture, "app.jsx"), `import {render} from 'solid-js/web';import App from '../src/App.jsx';import '../src/App.css';render(()=><App/>,document.getElementById('root'));`);
await writeFile(path.join(fixture, "fixture.jsx"), `
import {render} from 'solid-js/web';import {createSignal,Show} from 'solid-js';import {Chart} from 'chart.js';
import {PlotConstructor} from '../src/tabs/PlotConstructor.jsx';import '../src/App.css';
import {installBrowserDefaults} from '../src/services/browserDefaults.js';
import {createMovieExportController} from '../src/services/movie/movieExportController.js';
import {createMovieGifEncoder} from '../src/services/movie/movieGifEncoder.js';
installBrowserDefaults(window);
const task={general:{countTimeSteps:2,timeStep:.5},metadata:{MH:{steps:[{index:0},{index:1},{index:2}],header:{stride:9},pointCount:1,ranges:{runId:'field-1'}}},
handle:{getDirectoryHandle:async()=>{throw new DOMException('no OM','NotFoundError')}},reader:{history:async()=>{await window.__historyGate;return {steps:[0,1,2],stride:9,values:Float64Array.from([0,0,0,3,4,0,0,0,0,0,0,0,-3,0,4,0,0,0,0,0,0,3,4,0,0,0,0])}}}};
const manifest={schema:'clark-result-channels/1',model:'mechanics',role:'derived',complete:true,fieldRunId:'field-1',grid:{steps:2,dt:.5},dataFile:'energy.tsv',channels:[{column:'energy_J',label:'Механическая энергия',unit:'Дж'}]};
window.pickerCalls=0;
window.showDirectoryPicker=async()=>{window.pickerCalls++;return {getFileHandle:async name=>({getFile:async()=>new File([name==='results.json'?JSON.stringify(manifest):'step\\ttime_s\\tenergy_J\\n0\\t0\\t0\\n1\\t0.5\\t7\\n2\\t1\\t3\\n'],name)})}};
function Fixture(){
 const [recipes,setPlotRecipes]=createSignal([]),[sources,setPlotSources]=createSignal([]),[active,setActivePlotId]=createSignal(null);
 const [time,setTime]=createSignal(1),[busy,setBusy]=createSignal(false),[shown,setShown]=createSignal(true);
 const controller=createMovieExportController({createEncoder:createMovieGifEncoder});
 window.__graphs={setShown,visible(plot,index,value){const chart=Chart.getChart(document.querySelectorAll('.constructor-plot canvas')[plot]);chart.setDatasetVisibility(index,value);chart.update('none');},snapshot:()=>({time:time(),active:active(),recipes:recipes().map(r=>({id:r.id,count:r.curves.length})),plots:Array.from(document.querySelectorAll('.constructor-plot canvas')).map(c=>{const chart=Chart.getChart(c);return {id:chart.id,visible:chart.data.datasets.map((d,i)=>chart.isDatasetVisible(i)),series:chart.data.datasets.filter(d=>d._seriesKey!=="marker").map(d=>d.data),range:{xmin:chart.scales.x.min,xmax:chart.scales.x.max,ymin:chart.scales.y.min,ymax:chart.scales.y.max}}})}),
 async movie(){setBusy(true);try{const r=await controller.run({intervalMs:100});return {...r,bytes:Array.from(new Uint8Array(await r.blob.arrayBuffer()))};}finally{setBusy(false);}}};
 return <div class="app-container"><h1>Графики</h1><input aria-label="Проверка локального выделения" value="Локальный текст"/>
 <main class="tabs-body" inert={busy()}><Show when={shown()}><PlotConstructor task={task} time={time()} setTime={setTime} setMovieTime={setTime} movieBusy={busy()} registerMovieAdapter={controller.register}
 plotRecipes={recipes()} setPlotRecipes={setPlotRecipes} plotSources={sources()} setPlotSources={setPlotSources} activePlotId={active()} setActivePlotId={setActivePlotId}/></Show></main></div>;
}
render(()=><Fixture/>,document.getElementById('root'));
`);
let server, browser, page;
const errors = [], checks = [];
const passed = name => { checks.push(name); console.log(`PASS ${checks.length}: ${name}`); };
try {
 const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
 server = await createServer({ configFile:false, root, plugins:[solid()], server:{host:'127.0.0.1',port:0} }); await server.listen();
 browser = await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox']});
 page = await browser.newPage({viewport:{width:1440,height:950}}); page.on('pageerror',e=>errors.push(e.message));
 const base = 'http://127.0.0.1:'+server.httpServer.address().port+'/__plot_constructor_check__/';
 await page.goto(base+'app.html');
 const tabs = page.locator('nav[aria-label="Вкладки просмотра"] > button:not([aria-haspopup])');
 assert.deepEqual(await tabs.allTextContents(), ['Выбор задания','Источники / Поле 3D','Рабочие точки','Поле на линиях','Поле в областях','Графики']);
 await page.keyboard.press('Control+a'); assert.equal(await page.evaluate(()=>String(window.getSelection())), '');
 const cancelled = await page.evaluate(()=>!document.querySelector('header').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})));
 assert.equal(cancelled,true); passed('Actual App has six tabs and suppresses native page selection/context menu');
 await page.goto(base+'index.html');
 const snap = () => page.evaluate(()=>window.__graphs.snapshot());
 const waitSeries = (plot, count) => page.waitForFunction(({plot,count})=>window.__graphs.snapshot().plots[plot]?.series.length===count,{plot,count});
 const graphs = page.locator('.constructor-plot'), x = page.locator('fieldset').nth(0), y = page.locator('fieldset').nth(1);
 const add = page.getByRole('button',{name:'Добавить график',exact:true}), curve = page.getByRole('button',{name:'Добавить кривую',exact:true});
 assert.equal(await curve.isDisabled(),true);
 await add.click(); await waitSeries(0,1);
 assert.equal(await x.getByLabel('Величина').inputValue(),'time');
 assert.equal(await y.getByLabel('Величина').inputValue(),'field:M');
 let first = (await snap()).plots[0]; assert.deepEqual(first.series[0].map(p=>p.y),[5,5,5]);
 const firstId = first.id;
 await y.getByLabel('Компонента').selectOption('0'); await curve.click(); await waitSeries(0,2);
 assert.equal((await snap()).plots[0].id,firstId);
 await graphs.nth(0).getByRole('button',{name:'Авто',exact:true}).click();
 const frozen = (await snap()).plots[0].range;
 await page.evaluate(()=>window.__graphs.visible(0,0,false));
 await page.evaluate(()=>{window.__historyGate=new Promise(resolve=>{window.__releaseHistory=resolve;});});
 await y.getByLabel('Компонента').selectOption('1'); await curve.click();
 await graphs.nth(0).locator('canvas').click({button:'right'});
 const pendingCopy=graphs.nth(0).getByRole('button',{name:'Копировать таблицу',exact:true});
 assert.equal(await pendingCopy.isDisabled(),true);
 assert.match(await pendingCopy.getAttribute('title'),/загрузки всех кривых/);
 assert.equal((await snap()).plots[0].series.length,2);
 await page.evaluate(()=>window.__releaseHistory()); await waitSeries(0,3);
 assert.equal(await pendingCopy.isEnabled(),true);
 await graphs.nth(0).locator('.chart-toolbar strong').click();
 passed('Copy waits for all requested curves while the preceding plotted data remains visible');
 assert.equal((await snap()).plots[0].visible[0],false);
 assert.deepEqual((await snap()).plots[0].range,frozen);
 passed('Add curve preserves chart identity, existing curves and manual axis limits');
 await add.click(); await waitSeries(1,1);
 assert.equal(await graphs.nth(1).getAttribute('class').then(s=>s.includes('constructor-plot-active')),true);
 await graphs.nth(0).locator('canvas').click();
 await y.getByLabel('Компонента').selectOption('2'); await curve.click(); await waitSeries(0,4);
 assert.equal((await snap()).plots[1].series.length,1);
 assert.equal((await snap()).active,(await snap()).recipes[0].id);
 await graphs.nth(0).locator('summary').click();
 await graphs.nth(0).getByRole('button',{name:'Удалить кривую 2',exact:true}).click(); await waitSeries(0,3);
 assert.equal((await snap()).plots[0].id,firstId);
 assert.equal((await snap()).plots[0].visible[0],false);
 await page.evaluate(()=>window.__graphs.visible(0,0,true));
 await graphs.nth(0).locator('summary').click();
 passed('Click selects the target plot; one curve can be removed while other plots remain intact');
 await graphs.nth(0).locator('canvas').click({button:'right'});
 assert.equal(await graphs.nth(0).getByRole('button',{name:'Копировать таблицу',exact:true}).isVisible(),true);
 await page.context().grantPermissions(['clipboard-read','clipboard-write']);
 async function copyAndCheck(plot, sharedX=true) {
   const expected=(await snap()).plots[plot].series;
   await graphs.nth(plot).locator('.chart-toolbar strong').click();
   await graphs.nth(plot).locator('canvas').click({button:'right'});
   await graphs.nth(plot).getByRole('button',{name:'Копировать таблицу',exact:true}).click();
   await graphs.nth(plot).getByRole('button',{name:'Таблица скопирована',exact:true}).waitFor();
   const rows=(await page.evaluate(()=>navigator.clipboard.readText())).split('\n').map(row=>row.split('\t'));
   assert.equal(rows.length,expected[0].length+1,'Clipboard must have one data row per shared X, with every curve in its own column');
   assert.equal(rows[0].length,sharedX ? expected.length+1 : expected.length*2);
   assert.equal(new Set(rows[0]).size,rows[0].length);
   assert.deepEqual(rows.slice(1).map(row=>row.map(Number)),expected[0].map((p,i)=>sharedX
     ? [p.x,...expected.map(s=>s[i].y)] : expected.flatMap(s=>[s[i].x,s[i].y])));
 }
 await page.evaluate(()=>window.__graphs.visible(0,0,false));
 await copyAndCheck(0);
 await copyAndCheck(1);
 await page.evaluate(()=>window.__graphs.visible(0,0,true));
 passed('Clipboard contains every current curve in separate columns, including hidden curves, and only from the chosen plot');
 await graphs.nth(0).locator('.chart-toolbar strong').click();
 await page.getByRole('heading',{name:'Графики',exact:true}).click(); await page.keyboard.press('Control+a');
 assert.equal(await page.evaluate(()=>String(window.getSelection())), '');
 const textInput = page.getByRole('textbox',{name:'Проверка локального выделения'}); await textInput.focus(); await page.keyboard.press('Control+a');
 assert.deepEqual(await textInput.evaluate(el=>[el.selectionStart,el.selectionEnd]),[0,'Локальный текст'.length]);
 passed('Custom chart context menu and local text Ctrl+A remain available');
 const source = page.getByRole('button',{name:'Добавить параметры ОМ…',exact:true});
 assert.match(await source.getAttribute('title'),/results.json/); await source.click();
 const dialog = page.getByRole('dialog',{name:'Добавление параметров ОМ'});
 assert.match(await dialog.innerText(),/outputOM\/run/); assert.match(await dialog.innerText(),/results.json/);
 assert.equal(await page.evaluate(()=>window.pickerCalls),0);
 await dialog.getByRole('button',{name:'Выбрать каталог…',exact:true}).click();
 await dialog.waitFor({state:'hidden'}); assert.equal(await page.evaluate(()=>window.pickerCalls),1);
 await x.getByLabel('Величина').selectOption('field:M'); await x.getByLabel('Компонента').selectOption('0');
 await y.getByLabel('Величина').selectOption('extra:0:energy_J'); await curve.click();
 assert.match(await page.getByRole('alert').innerText(),/Ось X.*не совпадают/); assert.equal(await graphs.count(),2);
 await add.click(); await waitSeries(2,1);
 const loop=(await snap()).plots[2].series[0]; assert.deepEqual(loop.map(p=>p.x),[3,-3,3]); assert.deepEqual(loop.map(p=>p.y),[0,7,3]);
 await x.getByLabel('Компонента').selectOption('1'); await curve.click(); await waitSeries(2,2);
 await copyAndCheck(2,false);
 passed('OM import explains the directory first; XY keeps time order and incompatible axes are rejected');
 await page.screenshot({path:path.join(output,'graphs.png'),fullPage:true});
 async function checkMovie(filename) {
   const before=await snap(); const r=await page.evaluate(()=>window.__graphs.movie());
   const bytes=Buffer.from(r.bytes),frames=decompressFrames(parseGIF(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)),true);
   assert.equal(frames.length,3); assert.equal(r.frameCount,3); assert.equal((await snap()).time,before.time);
   assert.equal((await snap()).active,before.active); assert.deepEqual((await snap()).plots.map(p=>p.range),before.plots.map(p=>p.range));
   await writeFile(path.join(output,filename),bytes);
 }
 await checkMovie('xy-active.gif');
 await graphs.nth(0).locator('canvas').click(); await checkMovie('curves-active.gif');
 passed('Real GIF export follows the active plot, supports multiple curves and restores time and axes');
 const beforeRemount=(await snap()).recipes, active=(await snap()).active;
 await page.evaluate(()=>window.__graphs.setShown(false)); await page.evaluate(()=>window.__graphs.setShown(true));
 await waitSeries(0,3); await waitSeries(2,2); assert.deepEqual((await snap()).recipes,beforeRemount); assert.equal((await snap()).active,active);
 await graphs.nth(2).getByRole('button',{name:'Удалить график',exact:true}).click(); assert.equal(await graphs.count(),2);
 assert.equal((await snap()).active,(await snap()).recipes[1].id);
 assert.equal(await page.locator('.constructor-actions button:not([title])').count(),0);
 passed('Recipe/source/active state survives tab remount; deleting an active plot selects a remaining plot');
 assert.deepEqual(errors,[]);
 await writeFile(path.join(output,'browser.json'),JSON.stringify({checks,errors},null,2));
 console.log(`BROWSER_OK ${checks.length}/${checks.length}`);
} catch(error) {
 if(page) await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});
 await writeFile(path.join(output,'browser.json'),JSON.stringify({checks,errors,failure:error.stack},null,2));
 console.error(error);process.exitCode=1;
} finally {await browser?.close();await server?.close();await rm(fixture,{recursive:true,force:true});}
