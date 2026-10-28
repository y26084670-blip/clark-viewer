import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import { buildProtocolScene } from "./build-protocol-scene.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = process.env.CHECK_OUTPUT || "/tmp/clark-protocol-scene";
const fixture = path.join(root, "__protocol_scene_check__");
await buildProtocolScene(); await mkdir(output, { recursive: true }); await mkdir(fixture, { recursive: true });
const clipPath = path.join(output, "clip.webm");
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=4", "-frames:v", "8",
  "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-an", "-y", clipPath]);
const clip = (await readFile(clipPath)).toString("base64");
await writeFile(path.join(fixture, "index.html"), '<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="./fixture.jsx"></script></body></html>');
await writeFile(path.join(fixture, "fixture.jsx"), `
import {render} from 'solid-js/web';import {createSignal} from 'solid-js';
import {TaskProtocolDialog} from '/src/components/protocol/TaskProtocolDialog.jsx';
import {TaskProtocolDownload} from '/src/components/tasks/TaskProtocolDownload.jsx';
import {listTaskProtocolDownloads} from '/src/services/protocol/protocolDownloads.js';
import {normalizeTaskInput} from '/src/services/taskLoadService.js';
import {parseProtocol} from '/src/services/protocol/protocolDocument.js';
import {general,elements,regions,inputSummary,outputSummary} from '/test/fixtures/protocolScene.js';import '/src/App.css';
const root=await navigator.storage.getDirectory(),task=await root.getDirectoryHandle('SceneTask',{create:true});
let permissions=0;FileSystemDirectoryHandle.prototype.requestPermission=async()=>{permissions++;return 'granted';};
async function put(payload,data){const parts=payload.split('/'),name=parts.pop();let dir=task;
 for(const part of parts)dir=await dir.getDirectoryHandle(part,{create:true});const w=await(await dir.getFileHandle(name,{create:true})).createWritable();await w.write(data);await w.close();}
if(!localStorage.getItem('scene-no-sources')){
 for(const[name,value]of Object.entries({'general.txt':general,'kvs.txt':elements[0],'tks.txt':regions[0]}))await put('input3XX/'+name,JSON.stringify(value));
 await put('input3XX/_summary.txt',inputSummary);await put('output3XX/_summary_out.txt',outputSummary);
 await put('output3XX/conditions.json','must not be automatically inserted');
 await put('output3XX/demo/a.webm',Uint8Array.from(atob('${clip}'),c=>c.charCodeAt(0)));}
const model=normalizeTaskInput({general,elements,regions,moves:[],amps:[],mhj:[]});
const current={...model,handle:task,plotLabel:'Workspace/Project/SceneTask'};
const c=document.createElement('canvas');c.width=40;c.height=30;c.getContext('2d').fillRect(0,0,40,30);
const image=id=>({id,kind:'image',title:id,comment:'Отмечено в протокол',width:40,height:30,dataUrl:c.toDataURL('image/png')});
function Fixture(){const[open,setOpen]=createSignal(false),[name,setName]=createSignal(''),[record,setRecord]=createSignal({files:[]}),[entries,setEntries]=createSignal({one:image('Отмеченный вид 1'),two:image('Отмеченный вид 2')});
window.fixture={ready:true,permissions:()=>permissions,
 open(){setName('');setOpen(true);},reopen(){setName('protocol.html');setOpen(true);},
 async html(){return(await(await(await task.getDirectoryHandle('DOCS')).getFileHandle('protocol.html')).getFile()).text();},
 async doc(){return parseProtocol(await this.html());},
 async erase(){await task.removeEntry('input3XX',{recursive:true});await task.removeEntry('output3XX',{recursive:true});localStorage.setItem('scene-no-sources','1');},
 async names(){const out=[];for await(const[name]of(await task.getDirectoryHandle('DOCS')).entries())out.push(name);return out;},
 more(){setEntries(p=>({...p,three:image('Отмеченный вид 3')}));}
};return <><button onClick={()=>fixture.open()}>Создать</button><TaskProtocolDownload taskHandle={task} taskName="SceneTask" record={record()}/>
 <TaskProtocolDialog open={open()} task={current} initialFilename={name()} entries={entries()} onClose={()=>setOpen(false)}
 onSaved={async()=>setRecord({files:await listTaskProtocolDownloads(task)})}/></>;}
render(()=><Fixture/>,document.getElementById('root'));
`);

let server, browser;
const checks = [], errors = [];
const passed = message => { checks.push(message); console.log(`PASS ${checks.length}: ${message}`); };
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  server = await createServer({ configFile: false, root, cacheDir: path.join(root, "node_modules/.vite-protocol-scene"),
    plugins: [solid()], server: { host: "127.0.0.1", port: 0, hmr: false } });
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, headless: true,
    args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage(); page.setDefaultTimeout(20000); page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__protocol_scene_check__/index.html`);
  await page.waitForFunction(() => window.fixture?.ready); await page.getByRole('button',{name:'Создать',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Создать протокол',exact:true});
  await dialog.locator('.protocol-block').nth(5).waitFor();
  assert.deepEqual(await dialog.locator('.protocol-block-header strong').allTextContents(),[
    '3D-геометрия системы','Сводка исходных данных · input3XX/_summary.txt','Сводка расчёта · output3XX/_summary_out.txt',
    'Отмеченный вид 1','Отмеченный вид 2','Анимация · a.webm']);
  assert.equal((await dialog.innerText()).includes('MH.h5 — подробное описание'),false);
  assert.equal((await dialog.innerText()).includes('must not be automatically inserted'),false);
  assert.equal(await dialog.getByRole('button',{name:'Добавить условия расчёта',exact:true}).count(),0);
  assert.equal(await dialog.getByLabel('Комментарий: Сводка исходных данных · input3XX/_summary.txt',{exact:true}).count(),0);
  assert.equal(await dialog.getByLabel('Комментарий: Сводка расчёта · output3XX/_summary_out.txt',{exact:true}).count(),0);
  assert.equal(await dialog.locator('textarea').count(),4);
  assert.ok((await dialog.locator('textarea').evaluateAll(nodes=>nodes.map(node=>node.value))).every(value=>value===''));
  assert.equal(await page.evaluate(()=>fixture.permissions()),0);
  passed('Protocol order is scene → input summary → trimmed output summary → marked views → WebM, without an automatic conditions block');

  await dialog.getByRole('button',{name:'Интерактивный просмотр 3D',exact:true}).click();
  const frame=dialog.frameLocator('iframe[title="Интерактивная геометрия протокола"]');
  await frame.getByRole('button',{name:'Открыть 3D',exact:true}).click();await frame.locator('canvas').waitFor();
  assert.equal(await frame.getByRole('checkbox').count(),2);
  assert.match(await frame.locator('.protocol-scene-objects').innerText(),/ВТСП <полоска>/);
  await dialog.getByRole('button',{name:'Скрыть интерактивный просмотр',exact:true}).click();
  passed('Editor opens the same interactive player inside a sandboxed iframe and preserves literal source names');

  await dialog.getByRole('button',{name:'Сохранить в DOCS',exact:true}).click();
  await dialog.getByRole('status').filter({hasText:'Сохранено:'}).waitFor();
  const original=await page.evaluate(()=>fixture.doc()),source=await page.evaluate(()=>fixture.html());
  assert.equal(original.version,3);assert.equal(original.blocks[0].scene.objects[0].instances.length,32);
  assert.equal(source.includes('<p class="comment">'),false);
  assert.equal(original.blocks[0].scene.objects[1].instances.length,4);
  assert.equal(original.blocks[2].text,'Расчёт завершён\r\nИтераций: 17');
  assert.equal((source.match(/<script>/g)||[]).length,1);
  assert.match(source,/script-src 'sha256-/);assert.equal(source.includes('MH.h5 — подробное описание'),false);
  await dialog.getByRole('button',{name:'Закрыть',exact:true}).click();
  const downloadPromise=page.waitForEvent('download');await page.locator('.task-protocol-download-button').click();
  const download=await downloadPromise,portable=path.join(output,'portable-scene.html');await download.saveAs(portable);
  assert.equal(await readFile(portable,'utf8'),source);
  passed('Format 3 saves complete geometry/symmetry/poster and exact-hash code, and direct download preserves the single HTML byte for byte');

  const offline=await browser.newContext({offline:true,viewport:{width:1400,height:1000}}),standalone=await offline.newPage(),requests=[],csp=[];
  standalone.on('pageerror',error=>errors.push(error.message));standalone.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
  await standalone.addInitScript(()=>document.addEventListener('securitypolicyviolation',e=>{window.cspViolations??=[];window.cspViolations.push(e.violatedDirective);}));
  await standalone.goto(new URL(`file://${portable}`).href);await standalone.getByRole('button',{name:'Открыть 3D',exact:true}).click();
  const canvas=standalone.locator('.protocol-scene-live canvas');await canvas.waitFor();
  const pixels=()=>canvas.evaluate(c=>c.toDataURL()); const initial=await pixels();
  await standalone.getByRole('button',{name:'X',exact:true}).click();assert.notEqual(await pixels(),initial);
  await standalone.getByRole('button',{name:'Исходный вид',exact:true}).click();assert.equal(await pixels(),initial);
  await standalone.getByRole('button',{name:'Z',exact:true}).click();assert.notEqual(await pixels(),initial);
  await standalone.getByRole('button',{name:'Исходный вид',exact:true}).click();
  const bounds=await canvas.boundingBox();
  await standalone.mouse.move(bounds.x+bounds.width*.5,bounds.y+bounds.height*.5);
  await standalone.mouse.down();await standalone.mouse.move(bounds.x+bounds.width*.62,bounds.y+bounds.height*.58,{steps:8});await standalone.mouse.up();
  assert.notEqual(await pixels(),initial);const rotated=await pixels();
  await standalone.mouse.wheel(0,-180);await standalone.waitForTimeout(100);assert.notEqual(await pixels(),rotated);
  const zoomed=await pixels();await standalone.mouse.down({button:'right'});await standalone.mouse.move(bounds.x+bounds.width*.52,bounds.y+bounds.height*.48,{steps:6});await standalone.mouse.up({button:'right'});
  assert.notEqual(await pixels(),zoomed);
  await standalone.getByRole('button',{name:'Исходный вид',exact:true}).click();assert.equal(await pixels(),initial);
  passed('Copied file:// HTML works offline: standard views, reset, mouse rotation, wheel zoom and right-button pan visibly change real WebGL pixels');

  await standalone.getByRole('checkbox').first().uncheck();assert.notEqual(await pixels(),initial);
  await standalone.getByRole('button',{name:'Скрыть все',exact:true}).click();assert.equal(await standalone.locator('.protocol-scene-objects input:checked').count(),0);
  await standalone.getByRole('button',{name:'Показать все',exact:true}).click();assert.equal(await pixels(),initial);
  assert.deepEqual(await standalone.evaluate(()=>window.cspViolations||[]),[]);
  const video=standalone.locator('video');await video.evaluate(v=>v.play());await standalone.waitForTimeout(200);
  assert.ok(await video.evaluate(v=>v.currentTime>0));await video.evaluate(v=>v.pause());
  assert.deepEqual(requests,[]);
  await standalone.screenshot({path:path.join(output,'interactive-scene.png'),fullPage:true});
  passed('Object visibility and show/hide all work; embedded WebM still plays, with zero HTTP requests and zero CSP violations');

  await standalone.emulateMedia({media:'print'});
  assert.equal(await standalone.locator('.protocol-scene-poster').isVisible(),true);
  assert.equal(await standalone.locator('.protocol-scene-player').isVisible(),false);
  await standalone.pdf({path:path.join(output,'printed-scene.pdf'),format:'A4'});
  const noJs=await browser.newContext({offline:true,javaScriptEnabled:false}),staticPage=await noJs.newPage();
  await staticPage.goto(new URL(`file://${portable}`).href);assert.equal(await staticPage.locator('.protocol-scene-poster').isVisible(),true);
  assert.equal(await staticPage.getByRole('button',{name:'Открыть 3D',exact:true}).isVisible(),false);
  await noJs.close();
  passed('Printing an active scene and opening with JavaScript disabled both show the saved static system image');

  const noGl=await browser.newContext({offline:true}),noGlPage=await noGl.newPage();
  await noGlPage.addInitScript(()=>{const old=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return String(type).startsWith('webgl')?null:old.call(this,type,...args);};});
  await noGlPage.goto(new URL(`file://${portable}`).href);await noGlPage.getByRole('button',{name:'Открыть 3D',exact:true}).click();
  await noGlPage.getByRole('status').filter({hasText:'требует WebGL 2'}).waitFor();assert.equal(await noGlPage.locator('.protocol-scene-poster').isVisible(),true);
  await noGl.close();
  passed('Unavailable WebGL leaves a clear message and the original static snapshot');

  await page.evaluate(()=>fixture.erase());await page.reload();await page.waitForFunction(()=>window.fixture?.ready);await page.evaluate(()=>fixture.reopen());
  const reopened=page.getByRole('dialog',{name:'Редактировать протокол',exact:true});await reopened.locator('.protocol-block').nth(5).waitFor();
  await reopened.getByLabel('Комментарий: 3D-геометрия системы',{exact:true}).fill('Сцена после удаления исходников');
  await page.evaluate(()=>fixture.more());await reopened.getByRole('button',{name:'Добавить отмеченные (1)',exact:true}).click();
  await reopened.getByRole('button',{name:'Сохранить в DOCS',exact:true}).click();await reopened.getByRole('status').filter({hasText:'Сохранено:'}).waitFor();
  const revised=await page.evaluate(()=>fixture.doc());assert.deepEqual(revised.blocks[0].scene,original.blocks[0].scene);
  assert.deepEqual(revised.blocks[0].poster,original.blocks[0].poster);assert.equal(revised.blocks.at(-1).kind,'video');
  assert.equal(revised.blocks[0].comment,'Сцена после удаления исходников');assert.deepEqual(await page.evaluate(()=>fixture.names()),['protocol.html']);
  passed('After F5 and deletion of all source files, the embedded scene, summaries and videos reopen and survive comment edits/additions in one protocol');

  assert.deepEqual(errors,[]);await writeFile(path.join(output,'browser.json'),JSON.stringify({checks,errors,requests,csp},null,2));
  console.log(`BROWSER_OK ${checks.length}/${checks.length}`);
} catch(error) {
  await writeFile(path.join(output,'browser.json'),JSON.stringify({checks,errors,failure:error.stack},null,2));throw error;
} finally {
  for(const resource of [browser,server]) {let timer;try{await Promise.race([resource?.close(),new Promise(resolve=>{timer=setTimeout(resolve,5000);})]);}finally{clearTimeout(timer);}}
  await rm(fixture,{recursive:true,force:true});
}
