import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import { buildProtocolScene } from "./build-protocol-scene.mjs";

// Real dialog, OPFS, native WebM players and portable HTML. No solver data.
const root = fileURLToPath(new URL("..", import.meta.url));
const output = process.env.CHECK_OUTPUT || "/tmp/clark-protocol-webm";
const fixture = path.join(root, "__protocol_webm_check__");
await buildProtocolScene();
await mkdir(output, { recursive: true }); await mkdir(fixture, { recursive: true });
const clips = [];
for (const [index, source] of ["testsrc2", "smptebars"].entries()) {
  const filename = path.join(output, `sample-${index}.webm`);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `${source}=size=96x64:rate=4`,
    "-frames:v", "8", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-an", "-y", filename]);
  clips.push((await readFile(filename)).toString("base64"));
}
await writeFile(path.join(fixture, "index.html"), '<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="./fixture.jsx"></script></body></html>');
await writeFile(path.join(fixture, "fixture.jsx"), `
import {render} from 'solid-js/web';import {createSignal} from 'solid-js';
import {TaskProtocolDialog} from '/src/components/protocol/TaskProtocolDialog.jsx';
import {parseProtocol} from '/src/services/protocol/protocolDocument.js';import '/src/App.css';
const root=await navigator.storage.getDirectory(),task=await root.getDirectoryHandle('Task A',{create:true}),other=await root.getDirectoryHandle('Task B',{create:true});
let permissions=0;FileSystemDirectoryHandle.prototype.requestPermission=async()=>{permissions++;return 'granted';};
const clips=${JSON.stringify(clips)};
const bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function put(handle,payload,data){const parts=payload.split('/'),name=parts.pop();let dir=handle;
 for(const p of parts)dir=await dir.getDirectoryHandle(p,{create:true});const writer=await(await dir.getFileHandle(name,{create:true})).createWritable();await writer.write(data);await writer.close();}
if(!localStorage.getItem('protocol-no-sources')){
 await put(task,'output3XX/_summary_out.txt','Расчёт WebM завершён');
 await put(task,'output3XX/demo/z.webm',bytes(clips[1]));await put(task,'output3XX/demo/a.WEBM',bytes(clips[0]));
 await put(task,'output3XX/demo/legacy.gif','GIF89a');await put(task,'outside.webm',bytes(clips[0]));
 await put(other,'output3XX/demo/foreign.webm',bytes(clips[0]));}
const c=document.createElement('canvas');c.width=32;c.height=20;c.getContext('2d').fillRect(0,0,32,20);
const image=id=>({id,kind:'image',title:id,comment:'Исходный комментарий',width:32,height:20,dataUrl:c.toDataURL('image/png')});
function Fixture(){const[open,setOpen]=createSignal(false),[name,setName]=createSignal(''),[entries,setEntries]=createSignal({one:image('Снимок 1')});
const currentTask={handle:task,plotLabel:'Workspace/Project/Task A'};
window.fixture={ready:true,permissions:()=>permissions,
 open(){setName('');setOpen(true);},reopen(){setName('protocol.html');setOpen(true);},more(){setEntries(p=>({...p,two:image('Снимок 2')}));},
 async html(){return(await(await(await task.getDirectoryHandle('DOCS')).getFileHandle('protocol.html')).getFile()).text();},
 async document(){return parseProtocol(await this.html());},
 async erase(){await task.removeEntry('output3XX',{recursive:true});await task.removeEntry('outside.webm');localStorage.setItem('protocol-no-sources','1');},
 async corrupt(){await put(task,'output3XX/demo/broken.webm','invalid');},
 async recalculate(){await put(task,'output3XX/_summary_out.txt','Расчёт WebM обновлён');
  await put(task,'output3XX/demo/a.WEBM',bytes(clips[1]));await put(task,'output3XX/demo/z.webm',bytes(clips[0]));},
 async external(){await put(task,'DOCS/protocol.html',(await this.html())+'\\n');},
 async names(){const docs=await task.getDirectoryHandle('DOCS');const names=[];for await(const[name]of docs.entries())names.push(name);return names;}
};return <TaskProtocolDialog open={open()} task={currentTask} initialFilename={name()} entries={entries()} onClose={()=>setOpen(false)}/>;}
render(()=><Fixture/>,document.getElementById('root'));
`);

let server, browser;
const checks = [], errors = [];
const passed = name => { checks.push(name); console.log(`PASS ${checks.length}: ${name}`); };
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  server = await createServer({ configFile: false, root, cacheDir: path.join(root, "node_modules/.vite-protocol-webm"),
    plugins: [solid()], server: { host: "127.0.0.1", port: 0, hmr: false } });
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  const url = `http://127.0.0.1:${server.httpServer.address().port}/__protocol_webm_check__/index.html`;
  await page.goto(url); await page.waitForFunction(() => window.fixture?.ready);
  await page.evaluate(() => fixture.open());
  const dialog = page.getByRole("dialog");
  await page.waitForFunction(() => document.querySelectorAll('.protocol-block video').length === 2);
  assert.deepEqual(await dialog.locator('.protocol-block-header strong').allTextContents(),
    ['Сводка расчёта · output3XX/_summary_out.txt', 'Снимок 1', 'Анимация · a.WEBM', 'Анимация · z.webm']);
  assert.equal(await page.evaluate(() => fixture.permissions()), 0);
  passed("All and only current task WebM files are appended after summaries and selected views; opening requests no write permission");
  await page.waitForFunction(() => [...document.querySelectorAll('.protocol-block video')].every(v => v.videoWidth === 96 && v.duration > 1.5));
  passed("Actual native WebM players load both real VP9 animations in the protocol dialog");
  await page.getByLabel('Комментарий: Снимок 1', {exact:true}).fill('Старый комментарий');
  await dialog.getByRole('button', { name: 'Сохранить в DOCS', exact: true }).click();
  await page.getByRole('status').filter({hasText:'Сохранено:'}).waitFor();
  assert.equal(await page.evaluate(() => fixture.permissions()), 1);
  let original = await page.evaluate(() => fixture.document());
  const html = await page.evaluate(() => fixture.html());
  assert.equal(original.version, 2);
  for (const block of original.blocks.filter(b => b.kind === 'video')) assert.equal(html.split(block.dataUrl).length - 1, 1);
  passed("Saved HTML contains each video once and carries the complete editable version 2 document");
  const popupPromise = context.waitForEvent('page');
  await dialog.getByRole('button', { name: 'Просмотр HTML', exact: true }).click();
  const popup = await popupPromise;
  await popup.waitForFunction(() => [...document.querySelectorAll('video')].length === 2 && [...document.querySelectorAll('video')].every(v => v.videoWidth === 96));
  await popup.close();
  passed("HTML preview plays embedded media with the document's restrictive content policy");
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.evaluate(() => fixture.recalculate());await page.evaluate(() => fixture.open());
  await page.waitForFunction(() => document.querySelectorAll('.protocol-block video').length === 2);
  assert.equal(await dialog.getByLabel('Имя файла протокола',{exact:true}).inputValue(),'protocol.html');
  await dialog.getByText('При сохранении DOCS/protocol.html будет перезаписан текущим содержимым протокола.',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Комментарий: Снимок 1',{exact:true}).inputValue(),'Исходный комментарий');
  assert.equal(await page.evaluate(()=>fixture.html()),html,'Opening must leave the saved protocol untouched');
  await dialog.getByRole('button',{name:'Закрыть',exact:true}).click();
  assert.equal(await page.evaluate(()=>fixture.html()),html,'Closing without Save must keep the saved protocol');
  await page.evaluate(()=>fixture.open());await page.waitForFunction(()=>document.querySelectorAll('.protocol-block video').length===2);
  await dialog.getByRole('button',{name:'Сохранить в DOCS',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Сохранено:'}).waitFor();
  const replaced=await page.evaluate(()=>fixture.document());
  assert.notEqual(replaced.id,original.id);
  assert.equal(replaced.blocks[0].text,'Расчёт WebM обновлён');
  assert.notEqual(replaced.blocks.find(b=>b.filename==='a.WEBM').dataUrl,original.blocks.find(b=>b.filename==='a.WEBM').dataUrl);
  assert.equal(replaced.blocks.find(b=>b.id==='Снимок 1').comment,'Исходный комментарий');
  assert.deepEqual(await page.evaluate(()=>fixture.names()),['protocol.html']);original=replaced;
  passed('Repeated creation rebuilds current conditions, snapshots and WebM and overwrites protocol.html only on Save, without numbered copies');

  await dialog.getByRole('button',{name:'Закрыть',exact:true}).click();await page.evaluate(()=>fixture.open());
  await page.waitForFunction(()=>document.querySelectorAll('.protocol-block video').length===2);
  await page.evaluate(()=>fixture.external());const externallyChanged=await page.evaluate(()=>fixture.html());
  await dialog.getByRole('button',{name:'Сохранить в DOCS',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'изменён после открытия'}).waitFor();
  assert.equal(await page.evaluate(()=>fixture.html()),externallyChanged);
  assert.deepEqual(await page.evaluate(()=>fixture.names()),['protocol.html']);
  passed('Regeneration still detects external edits after opening and preserves the changed file without creating a copy');
  await dialog.getByRole('button',{name:'Закрыть',exact:true}).click();
  await page.evaluate(() => fixture.erase()); await page.reload(); await page.waitForFunction(() => window.fixture?.ready);
  await page.evaluate(() => fixture.reopen());
  await page.waitForFunction(() => document.querySelectorAll('.protocol-block video').length === 2);
  await page.getByLabel('Комментарий: Снимок 1', {exact:true}).fill('Комментарий после удаления исходных WebM');
  await page.evaluate(() => fixture.more());
  await dialog.getByRole('button', {name:'Добавить отмеченные (1)',exact:true}).click();
  assert.deepEqual((await dialog.locator('.protocol-block-header strong').allTextContents()).slice(-2),['Анимация · a.WEBM','Анимация · z.webm']);
  await dialog.getByRole('button', {name:'Сохранить в DOCS',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Сохранено:'}).waitFor();
  const reopened = await page.evaluate(() => fixture.document());
  assert.deepEqual(reopened.blocks.filter(b => b.kind === 'video'), original.blocks.filter(b => b.kind === 'video'));
  assert.equal(reopened.blocks.find(b => b.id === 'Снимок 1').comment,'Комментарий после удаления исходных WebM');
  passed("After reload and deletion of all source movies, existing protocol reopens, adds views before videos and preserves media bytes/comments");
  const portable = path.join(output,'portable-protocol.html'); await writeFile(portable,await page.evaluate(() => fixture.html()));
  const offline = await browser.newContext({javaScriptEnabled:false,offline:true});
  const standalone = await offline.newPage(), requests=[];
  standalone.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
  await standalone.goto(new URL(`file://${portable}`).href);
  const videos=standalone.locator('video');assert.equal(await videos.count(),2);
  for (const video of await videos.all()) {
    assert.ok((await video.boundingBox()).width >= 320, 'small clips must keep usable native controls');
    await video.evaluate(v=>new Promise((resolve,reject)=>{if(v.readyState>=2)return resolve();v.addEventListener('loadeddata',resolve,{once:true});v.addEventListener('error',()=>reject(Error(v.error?.message)),{once:true});}));
    assert.equal(await video.evaluate(v=>v.videoWidth),96);
    await video.evaluate(v=>v.play());
    await standalone.waitForTimeout(350);assert.ok(await video.evaluate(v=>v.currentTime>0));
    await video.evaluate(v=>{v.pause();v.currentTime=1;});
    await standalone.waitForTimeout(150);assert.ok(await video.evaluate(v=>Math.abs(v.currentTime-1)<.1));
  }
  assert.deepEqual(requests,[]);
  await standalone.screenshot({path:path.join(output,'portable-protocol.png'),fullPage:true});
  passed("Copied single HTML works from file:// offline with JavaScript disabled: both videos decode, play, pause and seek without external requests");
  await dialog.getByRole('button',{name:'Закрыть',exact:true}).click();await page.evaluate(()=>fixture.corrupt());
  const beforeFailure=await page.evaluate(()=>fixture.html());
  await page.evaluate(()=>fixture.open());
  await page.getByRole('alert').filter({hasText:'broken.webm'}).waitFor();
  assert.equal(await dialog.getByRole('button',{name:'Сохранить в DOCS',exact:true}).isDisabled(),true);
  assert.deepEqual(await page.evaluate(()=>fixture.names()),['protocol.html']);
  assert.equal(await page.evaluate(()=>fixture.html()),beforeFailure);
  passed("A corrupt task WebM prevents partial protocol creation and leaves the saved document untouched");
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'browser.json'),JSON.stringify({checks,errors},null,2));
  console.log(`BROWSER_OK ${checks.length}/${checks.length}`);
} catch (error) {
  await writeFile(path.join(output,'browser.json'),JSON.stringify({checks,errors,failure:error.stack},null,2));
  throw error;
} finally {
  await rm(fixture,{recursive:true,force:true});
  for (const resource of [browser,server]) {
    let timer;
    try { await Promise.race([resource?.close(),new Promise(resolve=>{timer=setTimeout(resolve,5000);})]); }
    finally { clearTimeout(timer); }
  }
}
