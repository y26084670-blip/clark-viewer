import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import { buildProtocolScene } from "./build-protocol-scene.mjs";

// Actual Tasks list + report tabs + protocol editor + OPFS + native browser downloads.
const root = fileURLToPath(new URL("..", import.meta.url));
const output = process.env.CHECK_OUTPUT || "/tmp/clark-protocol-download";
const fixture = path.join(root, "__protocol_download_check__");
await buildProtocolScene();
await mkdir(output, { recursive: true }); await mkdir(fixture, { recursive: true });
const movie = path.join(output, "sample.webm");
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=4", "-frames:v", "8",
  "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-an", "-y", movie]);
const clip = (await readFile(movie)).toString("base64");
await writeFile(path.join(fixture, "index.html"), '<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="./fixture.jsx"></script></body></html>');
await writeFile(path.join(fixture, "fixture.jsx"), `
import {render} from 'solid-js/web';import {createSignal} from 'solid-js';
import {Tasks} from '/src/tabs/Tasks.jsx';import {TaskProtocolDialog} from '/src/components/protocol/TaskProtocolDialog.jsx';
import {newProtocol,serializeProtocol} from '/src/services/protocol/protocolDocument.js';import '/src/App.css';
const disk=await navigator.storage.getDirectory(),catalog=await disk.getDirectoryHandle('clark.download',{create:true}),
 project=await catalog.getDirectoryHandle('Project',{create:true}),other=await catalog.getDirectoryHandle('Other',{create:true}),tasks={};
const permissions=[],reads=[];let blockRead=false,releaseRead,readStarted=false;
FileSystemDirectoryHandle.prototype.requestPermission=async function(options){permissions.push(options);return 'granted';};
FileSystemDirectoryHandle.prototype.queryPermission=async()=> 'granted';window.showDirectoryPicker=async()=>disk;
const getFile=FileSystemFileHandle.prototype.getFile;
FileSystemFileHandle.prototype.getFile=async function(){if(blockRead&&this.name==='protocol.html'){blockRead=false;readStarted=true;await new Promise(r=>releaseRead=r);}return getFile.call(this);};
const text=File.prototype.text;File.prototype.text=function(){reads.push(this.name);return text.call(this);};
async function put(task,payload,data){const parts=payload.split('/'),name=parts.pop();let dir=task;
 for(const p of parts)dir=await dir.getDirectoryHandle(p,{create:true});const w=await(await dir.getFileHandle(name,{create:true})).createWritable();await w.write(data);await w.close();}
const doc=serializeProtocol(newProtocol('clark.download/Project/Task A',[
 {id:'video',kind:'video',title:'Встроенная анимация',comment:'Переносимый протокол',filename:'sample.webm',dataUrl:'data:video/webm;base64,${clip}'}]));
for(const name of ['Task A','Task B','Task C'])tasks[name]=await project.getDirectoryHandle(name,{create:true});
await other.getDirectoryHandle('Foreign Task',{create:true});
await put(tasks['Task A'],'DOCS/protocol.html',doc);await put(tasks['Task A'],'DOCS/readme.txt','Описание');
await put(tasks['Task A'],'comparison/report.html','<h1>Regression report</h1>');
await put(tasks['Task B'],'DOCS/protocol-10.html',doc+'\\n');await put(tasks['Task B'],'DOCS/protocol-2.html',doc+'\\r\\n');
await tasks['Task B'].getDirectoryHandle('DOCS').then(d=>d.getDirectoryHandle('folder.html',{create:true}));
function Fixture(){const[revision,setRevision]=createSignal(0),[open,setOpen]=createSignal(false),[createTask,setCreateTask]=createSignal(null);let loaded=0;
window.fixture={ready:true,permissions,reads,source:()=>doc,loaded:()=>loaded,
 async remove(){await(await tasks['Task A'].getDirectoryHandle('DOCS')).removeEntry('protocol.html');},
 async restore(){await put(tasks['Task A'],'DOCS/protocol.html',doc);},
 create(){setCreateTask({handle:tasks['Task C'],plotLabel:'clark.download/Project/Task C'});setOpen(true);},
 block(){blockRead=true;readStarted=false;},started:()=>readStarted,release(){releaseRead?.();},
 async saved(name,filename='protocol.html'){return(await(await(await tasks[name].getDirectoryHandle('DOCS')).getFileHandle(filename)).getFile()).text();}
};
return <><div style="height:100vh"><Tasks active={true} docsRevision={revision()} onLoad={()=>{loaded++;return true;}} /></div>
 <TaskProtocolDialog open={open()} task={createTask()} entries={{}} onChanged={()=>setRevision(n=>n+1)} onClose={()=>setOpen(false)}/></>;}
render(()=><Fixture/>,document.getElementById('root'));
`);

let server, browser;
const checks = [], errors = [], downloads = [];
const passed = message => { checks.push(message); console.log(`PASS ${checks.length}: ${message}`); };
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  server = await createServer({ configFile: false, root, cacheDir: path.join(root, "node_modules/.vite-protocol-download"),
    plugins: [solid()], server: { host: "127.0.0.1", port: 0, hmr: false } });
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
  page.on("download", download => downloads.push(download));
  context.on("page", tab => { tab.on("download", d => downloads.push(d)); tab.on("pageerror", e => errors.push(e.message)); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__protocol_download_check__/index.html`);
  await page.waitForFunction(() => window.fixture?.ready);
  await page.getByRole('button',{name:'Выбрать диск с проектами',exact:true}).click();
  await page.getByRole('button',{name:'Продолжить',exact:true}).click();
  const projects = page.getByRole('combobox',{name:'Список проектов',exact:true});
  await projects.selectOption('Project');
  const row = name => page.getByRole('option',{name:new RegExp(name)}).filter({has:page.locator('.task-status-name')});
  const icon = name => row(name).locator('.task-protocol-download-button');
  await icon('Task A').waitFor(); await icon('Task B').waitFor();
  assert.equal(await icon('Task C').count(),0);
  assert.equal(await icon('Task B').innerText(),'2');
  assert.match(await icon('Task A').getAttribute('title'),/protocol\.html[\s\S]*КиБ/);
  assert.equal(await page.evaluate(()=>fixture.reads.some(n=>n.endsWith('.html'))),false);
  assert.equal(await page.evaluate(()=>fixture.permissions.length),0);
  passed('Saved HTML has a document/download indicator, multiple protocols show a count; scanning reads metadata only and requests no permission');

  // Opening a row's report must retain selection and the loaded task.
  await row('Task B').click(); await icon('Task A').waitFor({state:'visible'});
  const popupPromise = page.waitForEvent('popup'); await icon('Task A').click();
  const report = await popupPromise;
  const downloadButton = report.getByRole('link', {name:'Загрузить',exact:true}); await downloadButton.waitFor();
  await report.frameLocator('iframe').locator('video').waitFor();
  assert.equal(await report.evaluate(()=>window.opener),null); assert.equal(downloads.length,0);
  const downloadBox=await downloadButton.boundingBox();assert.ok(downloadBox.x>1200&&downloadBox.y<20);
  await report.screenshot({path:path.join(output,'opened-protocol.png')});
  const singlePromise = report.waitForEvent('download'); await downloadButton.click();
  const single = await singlePromise, singlePath = path.join(output,'downloaded-protocol.html'); await single.saveAs(singlePath);
  assert.equal(single.suggestedFilename(),'protocol.html');
  assert.equal(await readFile(singlePath,'utf8'),await page.evaluate(()=>fixture.source()));
  assert.equal(await row('Task B').getAttribute('aria-selected'),'true');
  assert.equal(await page.evaluate(()=>fixture.loaded()),0);
  assert.equal(await page.evaluate(()=>fixture.permissions.length),0);
  passed('The icon opens a report tab without downloading; its top-right button downloads exact HTML with WebM, without changing selection or loading results');

  await icon('Task B').focus(); await page.keyboard.press('Enter');
  const chooser = page.getByRole('dialog',{name:'Протоколы задания «Task B»',exact:true});
  await chooser.waitFor();
  assert.deepEqual(await chooser.locator('.task-protocol-download-list button > span').allTextContents(),['protocol-2.html','protocol-10.html']);
  await page.keyboard.press('Escape'); await chooser.waitFor({state:'hidden'});
  assert.equal(await icon('Task B').evaluate(n=>n===document.activeElement),true);
  await icon('Task B').click();
  const selectedPopup = page.waitForEvent('popup');
  await chooser.getByRole('button',{name:/^protocol-10\.html/}).click();
  const selectedReport=await selectedPopup;await selectedReport.getByRole('link',{name:'Загрузить',exact:true}).waitFor();
  assert.equal(downloads.length,1);
  const selectedPromise=selectedReport.waitForEvent('download');await selectedReport.getByRole('link',{name:'Загрузить',exact:true}).click();
  const selected=await selectedPromise, selectedPath=path.join(output,'selected-protocol.html');await selected.saveAs(selectedPath);
  assert.equal(selected.suggestedFilename(),'protocol-10.html');
  assert.equal(await readFile(selectedPath,'utf8'),await page.evaluate(()=>fixture.saved('Task B','protocol-10.html')));
  await chooser.waitFor({state:'hidden'});
  passed('Multiple protocols open a compact naturally sorted chooser with size/date; keyboard, Escape, focus return and chosen-file download work');

  // The actual downloaded file, moved out of browser storage, remains portable.
  const offline=await browser.newContext({offline:true,javaScriptEnabled:false}),standalone=await offline.newPage(),requests=[];
  standalone.on('request',request=>{if(/^https?:/.test(request.url()))requests.push(request.url());});
  await standalone.goto(new URL(`file://${singlePath}`).href);
  const video=standalone.locator('video');
  await video.evaluate(v=>new Promise((resolve,reject)=>{if(v.readyState>=2)return resolve();v.onloadeddata=resolve;v.onerror=()=>reject(Error('video decode failed'));}));
  assert.equal(await video.evaluate(v=>v.videoWidth),96);await video.evaluate(v=>v.play());
  await standalone.waitForTimeout(200);assert.ok(await video.evaluate(v=>v.currentTime>0));
  await video.evaluate(v=>{v.pause();v.currentTime=1;});await standalone.waitForTimeout(100);
  assert.ok(await video.evaluate(v=>Math.abs(v.currentTime-1)<.1));assert.deepEqual(requests,[]);await offline.close();
  passed('The downloaded single HTML plays and seeks its real VP9 video offline from file:// with JavaScript disabled');

  await page.evaluate(()=>fixture.create());
  const editor=page.getByRole('dialog',{name:/^(Создать|Редактировать) протокол$/});await editor.waitFor();
  await editor.getByRole('button',{name:'Сохранить в DOCS',exact:true}).click();
  await editor.getByRole('status').filter({hasText:'Сохранено:'}).waitFor();
  await editor.getByRole('button',{name:'Закрыть',exact:true}).click();
  await icon('Task C').waitFor();
  passed('Saving a new protocol in the actual editor immediately adds its task-list indicator without reloading the task list');

  const refresh=page.getByRole('button',{name:'Обновить список заданий',exact:true});
  await page.evaluate(()=>fixture.remove());await refresh.click();await icon('Task A').waitFor({state:'hidden'});
  await page.evaluate(()=>fixture.restore());await refresh.click();await icon('Task A').waitFor();
  passed('Manual task-list refresh removes and restores indicators after external file changes');

  const before=downloads.length;await page.evaluate(()=>fixture.block());
  const pendingPopup=page.waitForEvent('popup');await icon('Task A').click();const pendingReport=await pendingPopup;
  await page.waitForFunction(()=>fixture.started());await projects.selectOption('Other');await page.evaluate(()=>fixture.release());
  await row('Foreign Task').waitFor();await page.waitForTimeout(250);assert.equal(downloads.length,before);assert.equal(pendingReport.isClosed(),true);
  assert.equal(await downloadButton.isVisible(),true);
  await projects.selectOption('Project');await icon('Task A').waitFor();
  passed('Switching projects closes a pending report; already opened reports remain available');

  await page.evaluate(()=>fixture.remove());const failedPopup=page.waitForEvent('popup');await icon('Task A').click();const failedReport=await failedPopup;
  await row('Task A').locator('.task-protocol-download-error').getByRole('alert').or(row('Task A').getByRole('alert')).first().waitFor();
  assert.equal(downloads.length,before);assert.equal(failedReport.isClosed(),true);
  await refresh.click();await icon('Task A').waitFor({state:'hidden'});
  passed('Deleting a source file before clicking reports an opening error and closes the placeholder without creating a download');

  await page.screenshot({path:path.join(output,'task-protocol-download.png'),fullPage:true});
  await page.close();
  const independent=report.waitForEvent('download');await downloadButton.click();const afterClose=await independent;
  await afterClose.saveAs(path.join(output,'after-gui-close.html'));
  assert.equal(await readFile(path.join(output,'after-gui-close.html'),'utf8'),await readFile(singlePath,'utf8'));
  passed('The opened report and original-file download survive closing the Viewer tab');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'browser.json'),JSON.stringify({checks,errors,downloads:downloads.map(d=>d.suggestedFilename())},null,2));
  console.log(`BROWSER_OK ${checks.length}/${checks.length}`);
} catch(error) {
  await writeFile(path.join(output,'browser.json'),JSON.stringify({checks,errors,failure:error.stack},null,2));throw error;
} finally {
  await rm(fixture,{recursive:true,force:true});
  for(const resource of [browser,server]) {
    let timer;
    try {await Promise.race([resource?.close(),new Promise(resolve=>{timer=setTimeout(resolve,5000);})]);}
    finally {clearTimeout(timer);}
  }
}
