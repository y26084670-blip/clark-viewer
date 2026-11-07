import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createServer} from 'vite';
import solid from 'vite-plugin-solid';
import {libavAssets} from './libavAssets.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const out=process.env.CHECK_OUTPUT||path.join(root,'verification-output');
await mkdir(out,{recursive:true});
const dir=await mkdtemp(path.join(root,'__minmax_acceptance_'));
await copyFile(path.join(root,'scripts/test-support/3dMinmaxBrowserFixture.jsx'),path.join(dir,'fixture.jsx'));
await writeFile(path.join(dir,'index.html'),'<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="./fixture.jsx"></script></body></html>');
const checks=[],errors=[];let server,browser,page;
const pass=name=>{checks.push(name);console.log(`PASS ${checks.length}: ${name}`);};
try{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
 server=await createServer({configFile:false,root,plugins:[solid(),libavAssets()],server:{host:'127.0.0.1',port:0,hmr:false},optimizeDeps:{include:['solid-js','solid-js/web','three','tabulator-tables']}});
 await server.listen();
 browser=await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_EXECUTABLE || undefined,
  args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error' && /shader|WebGLProgram/i.test(m.text()))errors.push(m.text());});
 page.setDefaultTimeout(12000);
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/${path.basename(dir)}/index.html`);
 const group = label => page.locator('.geometry-scalar-legend').filter({has:page.getByText(label,{exact:true})});
 const elements = group('Элементы'), regions = group('Области');
 const lower = elements.getByRole('textbox',{name:'Нижний предел'});
 const upper = elements.getByRole('textbox',{name:'Верхний предел'});
 const defaults = page.getByRole('checkbox',{name:'По умолчанию',exact:true});
 const log = page.getByRole('checkbox',{name:'log',exact:true});
 const global = page.getByRole('checkbox',{name:'Общий минимакс',exact:true});
 const menu = async name => {
   const button=page.getByRole('button',{name,exact:true});
   if(await button.getAttribute('aria-expanded')!=='true')await button.click();
 };
 const waitRange = (label, min, max) => page.waitForFunction(([name,lo,hi]) => {
   const row=Array.from(document.querySelectorAll('.geometry-scalar-legend')).find(el=>el.querySelector('strong')?.textContent===name);
   const ends=row?.querySelector('.geometry-scalar-legend-limits');
   const number=el=>Number(el?.value ?? el?.textContent);
   const close=(a,b)=>Number.isFinite(a) && Math.abs(a-b)<=1e-5*Math.max(Math.abs(b),1e-16);
   return ends && close(number(ends.firstElementChild),lo) && close(number(ends.lastElementChild),hi);
 },[label,min,max]);
 const quantity=async pattern=>{
   await menu('Элементы');
   await page.getByRole('radio',{name:pattern}).check();
 };
 const setTime=time=>page.evaluate(t=>window.minmax.setTime(t),time);
 const load=(kind,stat=false)=>page.evaluate(([k,s])=>window.minmax.load(k,s),[kind,stat]);

 await waitRange('Элементы',5,150);
 assert.equal(await defaults.isChecked(),false);assert.equal(await log.isChecked(),false);
 assert.equal(await lower.isEditable(),true);
 await waitRange('Области',5,100);
 pass('Independent global scales start with editable limits and linear colours');
 await menu('Представление');
 const before=(await page.evaluate(()=>window.minmax.snapshot())).readCount;
 await global.uncheck();await waitRange('Элементы',5,5);
 await global.check();await waitRange('Элементы',5,150);
 assert.equal((await page.evaluate(()=>window.minmax.snapshot())).readCount,before);
 await setTime(2);await waitRange('Элементы',5,150);
 await global.uncheck();await waitRange('Элементы',15,15);
 await global.check();await waitRange('Элементы',5,150);
 pass('Switching global and per-frame ranges preserves input data and avoids rereading indexed fields');

 await lower.fill('1');await lower.press('Enter');await upper.fill('1e2');await upper.press('Enter');
 await waitRange('Элементы',1,100);await waitRange('Области',5,100);
 await log.check();await elements.getByText('10',{exact:true}).waitFor();
 await page.getByRole('checkbox',{name:'По умолчанию',exact:true}).check();
 await waitRange('Элементы',5,150);assert.equal(await lower.count(),0);
 await defaults.uncheck();await waitRange('Элементы',1,100);
 await lower.fill('200');await lower.press('Enter');
 await elements.getByRole('status').waitFor();
 await upper.fill('400');await upper.press('Enter');await waitRange('Элементы',200,400);
 await lower.fill('2,5');await lower.press('Enter');await waitRange('Элементы',2.5,400);
 await lower.fill('-100');await lower.press('Enter');await upper.fill('100');await upper.press('Enter');
 await elements.getByText('0',{exact:true}).waitFor();await setTime(1);await waitRange('Элементы',-100,100);
 pass('Per-quantity manual limits, validation, comma/exponent entry, true log midpoint and signed zero');
 await defaults.check();
 await load('missing');await waitRange('Элементы',5,5);
 assert.equal(await defaults.isChecked(),true);assert.equal(await log.isChecked(),true);
 await menu('Представление');
 assert.equal(await global.isDisabled(),true);assert.equal(await global.isChecked(),false);
 await load('partial');await waitRange('Элементы',5,5);
 assert.equal(await global.isDisabled(),true);
 await load('complete');await waitRange('Элементы',5,150);
 assert.equal(await global.isEnabled(),true);assert.equal(await global.isChecked(),true);
 await page.evaluate(()=>{window.minmax.setSetting('elementsMode','none');window.minmax.setSetting('regionsMode','none');});
 await page.waitForFunction(()=>!document.querySelector('.geometry-scalar-legend'));
 assert.equal(await global.isDisabled(),true);assert.equal(await global.isChecked(),false);
 await page.evaluate(()=>{window.minmax.setSetting('elementsMode','all');window.minmax.setSetting('regionsMode','all');});
 await waitRange('Элементы',5,150);
 await page.evaluate(()=>window.minmax.setBusy(true));
 assert.equal(await global.isDisabled(),true);assert.equal(await global.isChecked(),true);
 await page.evaluate(()=>window.minmax.setBusy(false));
 assert.equal(await global.isEnabled(),true);
 pass('Missing/partial ranges, empty selection and recording restore the original disabled states');

 await load('conductivity');await waitRange('Элементы',5,150);
 await quantity(/Относительная электропроводность/);
 await waitRange('Элементы',1,10);await menu('Представление');
 assert.equal(await global.isDisabled(),true);assert.equal(await global.isChecked(),false);

 // Reopen a fresh task with the conductivity quantity and the user's global preference retained.
 await load('conductivity');await page.waitForFunction(()=>window.minmax.snapshot().jeSteps.length>=2);
 await waitRange('Элементы',1,10);
 const reads=()=>page.evaluate(()=>window.minmax.snapshot().jeSteps);
 assert.deepEqual(await reads(),[0,0]); // selected HTS and ordinary conductor, one read per element
 await setTime(2);await waitRange('Элементы',1,30);
 assert.deepEqual(await reads(),[0,0,2,2]);
 await defaults.uncheck();
 await upper.fill('100');await upper.press('Enter');await waitRange('Элементы',1,100);
 await elements.getByText('10',{exact:true}).waitFor();
 assert.deepEqual(await reads(),[0,0,2,2]);
 await defaults.check();await waitRange('Элементы',1,30);
 await quantity(/Плотность тока,/);await menu('Представление');
 assert.equal(await global.isEnabled(),true);assert.equal(await global.isChecked(),true);
 await global.uncheck();
 await quantity(/Относительная электропроводность/);await menu('Представление');
 assert.equal(await global.isDisabled(),true);assert.equal(await global.isChecked(),false);
 await quantity(/Плотность тока,/);await menu('Представление');
 assert.equal(await global.isEnabled(),true);assert.equal(await global.isChecked(),false);
 await global.check();await defaults.uncheck();
 pass('Conductivity reads only requested frames, retains manual/log scales, and restores the saved global preference for indexed quantities');

 await load('complete');await quantity(/Потери на токи проводимости/);
 await waitRange('Элементы',0.05,45);
 await quantity(/Плотность энергии ФММ/);await waitRange('Элементы',0.4*Math.PI*50,0.4*Math.PI*20000);
 await quantity(/Плотность тока,/);await waitRange('Элементы',5,150);
 await page.evaluate(()=>{window.minmax.setSetting('elementsMode','selected');window.minmax.setSetting('regionsMode','selected');});
 await waitRange('Элементы',5,50);await waitRange('Области',5,50);
 await page.evaluate(()=>{window.minmax.setSetting('elementsMode','all');window.minmax.setSetting('regionsMode','all');});
 await waitRange('Элементы',5,150);
 pass('Derived energy and losses retain their existing units; selected IDs have independent extrema');

 await setTime(2);await lower.fill('1');await lower.press('Enter');await upper.fill('100');await upper.press('Enter');
 await elements.getByText('10',{exact:true}).waitFor();
 await page.screenshot({path:path.join(out,'3d-color-scales.png')});
 const dynamic=await page.evaluate(()=>window.minmax.movie());
 const webmHeader=bytes=>assert.deepEqual(bytes.slice(0,4),[0x1a,0x45,0xdf,0xa3]);
 assert.equal(dynamic.frames,3);webmHeader(dynamic.bytes);
 assert.equal((await page.evaluate(()=>window.minmax.snapshot())).time,2);await waitRange('Элементы',1,100);
 await writeFile(path.join(out,'3d-global-dynamic.webm'),Uint8Array.from(dynamic.bytes));
 await load('complete',true);await waitRange('Элементы',5,150);
 const staticMovie=await page.evaluate(()=>window.minmax.movie());
 assert.equal(staticMovie.frames,1);webmHeader(staticMovie.bytes);
 await writeFile(path.join(out,'3d-global-static.webm'),Uint8Array.from(staticMovie.bytes));
 pass('Real WebGL and VP9 WebM capture with log scale and custom limits, dynamic and static tasks');

 const samples=await page.evaluate(()=>window.minmax.sampledColors());
 for(const sample of samples)for(const actual of [sample.face,sample.body]) {
   assert.ok(actual.every((v,i)=>Math.abs(v-sample.expected[i])<=8),JSON.stringify(sample));
 }
 pass('Surface and volume midpoint pixels match the CPU palette after physical interpolation in four log domains');
 assert.deepEqual(errors,[]);
 await writeFile(path.join(out,'browser.json'),JSON.stringify({passed:checks.length,checks,errors},null,2));
 console.log(`BROWSER_OK ${checks.length}`);
}catch(error){
 if(page)await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});
 await writeFile(path.join(out,'browser.json'),JSON.stringify({passed:checks.length,checks,errors,failure:error.stack},null,2));
 console.error(error);process.exitCode=1;
}finally{await browser?.close();await server?.close();await rm(dir,{recursive:true,force:true});}
