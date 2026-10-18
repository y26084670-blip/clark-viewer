import { createServer } from 'vite';
import solid from 'vite-plugin-solid';
import { mkdir,writeFile,rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const fixture=path.join(root,'__plot_constructor_check__');await mkdir(fixture,{recursive:true});
await writeFile(path.join(fixture,'index.html'),'<html><body><div id="root"></div><script type="module" src="./fixture.jsx"></script></body></html>');
await writeFile(path.join(fixture,'fixture.jsx'),`
import {render} from 'solid-js/web';import {createSignal} from 'solid-js';import {Chart} from 'chart.js';
import {PlotConstructor} from '../src/tabs/PlotConstructor.jsx';import '../src/App.css';
const task={general:{countTimeSteps:2,timeStep:.5},metadata:{MH:{steps:[{index:0},{index:1},{index:2}],header:{stride:9},pointCount:1,ranges:{runId:'field-1'}}},
handle:{getDirectoryHandle:async()=>{throw new DOMException('no OM','NotFoundError')}},reader:{history:async()=>({steps:[0,1,2],stride:9,values:Float64Array.from([0,0,0,3,4,0,0,0,0,0,0,0,-3,0,4,0,0,0,0,0,0,3,4,0,0,0,0])})}};
const manifest={schema:'clark-result-channels/1',model:'mechanics',role:'derived',complete:true,fieldRunId:'field-1',grid:{steps:2,dt:.5},dataFile:'energy.tsv',channels:[{column:'energy_J',label:'Механическая энергия',unit:'Дж'}]};
window.showDirectoryPicker=async()=>({getFileHandle:async name=>({getFile:async()=>new File([name==='results.json'?JSON.stringify(manifest):'step\\ttime_s\\tenergy_J\\n0\\t0\\t0\\n1\\t0.5\\t7\\n2\\t1\\t3\\n'],name)})});
function Fixture(){const [recipes,setPlotRecipes]=createSignal([]),[sources,setPlotSources]=createSignal([]);return <div class="app-container"><h1>Конструктор графиков</h1><PlotConstructor task={task} time={1} plotRecipes={recipes()} setPlotRecipes={setPlotRecipes} plotSources={sources()} setPlotSources={setPlotSources}/></div>}
render(()=><Fixture/>,document.getElementById('root'));
window.plotSnapshot=()=>Array.from(document.querySelectorAll('canvas')).map(c=>Chart.getChart(c)?.data.datasets[0]?.data);
`);
let server,browser;
try{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
 server=await createServer({configFile:false,root,plugins:[solid()],server:{host:'127.0.0.1',port:0}});await server.listen();
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__plot_constructor_check__/index.html');
 await page.getByRole('button',{name:'Добавить график',exact:true}).click();
 await page.waitForFunction(()=>window.plotSnapshot()?.[0]?.length===3);
 assert.deepEqual((await page.evaluate(()=>plotSnapshot()[0])).map(p=>p.y),[5,5,5]);
 await page.getByRole('button',{name:'Добавить параметры ОМ…',exact:true}).click();
 await page.locator('fieldset').nth(0).getByLabel('Величина').selectOption('field:M');
 await page.locator('fieldset').nth(0).getByLabel('Компонента').selectOption('0');
 await page.locator('fieldset').nth(1).getByLabel('Величина').selectOption('extra:0:energy_J');
 await page.getByRole('button',{name:'Добавить график',exact:true}).click();
 await page.waitForFunction(()=>window.plotSnapshot()?.[1]?.length===3);
 const loop=await page.evaluate(()=>plotSnapshot()[1]);assert.deepEqual(loop.map(p=>p.x),[3,-3,3]);assert.deepEqual(loop.map(p=>p.y),[0,7,3]);
 assert.deepEqual(errors,[]);await page.screenshot({path:process.env.CHECK_SCREENSHOT||'/tmp/clark-plot-constructor.png',fullPage:true});
 console.log('PASS: standard quantities, arbitrary derived OM channel, XY time order, rendered plots; no browser errors');
}finally{await browser?.close();await server?.close();await rm(fixture,{recursive:true,force:true});}
