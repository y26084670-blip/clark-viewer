import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
const root = fileURLToPath(new URL("..",import.meta.url)), out = process.env.CHECK_OUTPUT || "/tmp/clark-3d-graphs";
const dir = await mkdtemp(path.join(root,"__graph3d_check_")); await mkdir(out,{recursive:true});
await writeFile(path.join(dir,"index.html"),'<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/scripts/test-support/graph3DBrowserFixture.jsx"></script></body></html>');
const inspect = { name:"graph-scene-inspection", enforce:"pre", configureServer(server) {
  server.middlewares.use(async (request,response,next) => {
    if(!request.url?.startsWith("/__graph-libav/"))return next();
    try {const file=path.basename(request.url);response.setHeader("Content-Type",file.endsWith(".wasm")?"application/wasm":"text/javascript");
      response.end(await readFile(path.join(root,"node_modules/@libav.js/variant-webm-vp9/dist",file)));}
    catch(error){next(error);}
  });
}, transform(code,id) {
  if(id.endsWith("/src/tabs/SourcesFields3D.jsx")) return code.replace('  return <div class="results-layout">',
    '  window.graphUI = { state: graphState, results: graphResults, current: currentGraphResults, only: graphsOnly, busy: graphBusy };\n  return <div class="results-layout">');
  if(id.endsWith("/src/components/geometry/ThreeGeometryViewport.jsx")) return code.replace('  return (\n    <div',
    `  window.graphScene = { ready: () => ready(), snapshot: () => ({ axes: graphFrames.map(a=>({id:a.id,start:a.start,end:a.end})), planes: graphRoot?.children.map(g=>g.getObjectByName("result-graph-plane")).filter(Boolean).map(p=>({id:p.userData.axisId,visible:p.visible,border:Array.from(p.material.map.image.getContext("2d").getImageData(2,2,1,1).data)})),
      colors: graphRoot?.children.flatMap(g=>g.children.filter(o=>o.isPoints||o.isLine).map(o=>o.material.color.getHexString())), nodeSize: discretizationPoints?.material.size,
      camera: [camera?.position.toArray(),camera?.quaternion.toArray(),controls?.target.toArray()], preview: graphPreview?.visible, layers: [...resultLayerStates.values()].reduce((n,s)=>n+(s.vectorRoot?.children.length??0)+(s.scalarRoot?.children.length??0),0) }),
      planePoint: id => {const p=graphRoot.children.find(g=>g.userData.axisId===id).getObjectByName("result-graph-plane");const v=p.localToWorld(new THREE.Vector3()).project(camera),b=renderer.domElement.getBoundingClientRect();return {x:b.left+(v.x+1)*b.width/2,y:b.top+(1-v.y)*b.height/2};},
      screen: node => { const p=resolveGraphNode(props.scene,node).position; const v=new THREE.Vector3(...p).project(camera),b=renderer.domElement.getBoundingClientRect();return {x:b.left+(v.x+1)*b.width/2,y:b.top+(1-v.y)*b.height/2}; } };\n  return (\n    <div`);
} };
let browser,server,page;const errors=[],checks=[];const pass=text=>{checks.push(text);console.log("PASS "+checks.length+": "+text);};
try {
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||"playwright");
  server=await createServer({configFile:false,root,plugins:[inspect,solid()],server:{host:"127.0.0.1",port:0,hmr:false}});await server.listen();
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE||undefined,args:["--no-sandbox","--enable-unsafe-swiftshader","--disable-dev-shm-usage"]});
  page=await browser.newPage({viewport:{width:1920,height:1080}});page.on("pageerror",error=>errors.push(error.message));
  await page.goto("http://127.0.0.1:"+server.httpServer.address().port+"/"+path.basename(dir)+"/index.html");
  await page.waitForFunction(()=>window.graphScene?.ready());
  const state=()=>page.evaluate(()=>graphUI.state()), scene=()=>page.evaluate(()=>graphScene.snapshot());
  const node=(pointIndex,recordIndex=0,ps=0,schemaId="elements")=>({source:{schemaId,recordIndex},instance:{ls:0,as:0,ps,mirrorX:0,mirrorY:0},pointIndex});
  const screen=n=>page.evaluate(n=>graphScene.screen(n),n);
  const click=async n=>{const p=await screen(n);await page.mouse.click(p.x,p.y);};
  const graphs=page.locator(".source-graphs-panel");
  const open=async()=>{if(!await graphs.isVisible())await page.getByRole("button",{name:"Графики",exact:true}).click();};
  const mode=async label=>{await open();await graphs.getByRole("button",{name:label,exact:true}).click();};
  await open();assert.equal(await graphs.getByRole("checkbox",{name:"только графики",exact:true}).isChecked(),true);
  assert.equal(await page.evaluate(()=>graphFixture.reads.length),0);assert.equal((await scene()).layers,0);
  pass("Only graphs starts enabled and suppresses result visualization and field reads");
  await mode("Добавить");await page.waitForFunction(()=>graphScene.snapshot().nodeSize>0);
  const defaultSize=(await scene()).nodeSize;
  await page.getByRole("button",{name:"Представление",exact:true}).click();
  const size=page.getByRole("slider",{name:"Размер представления",exact:true});
  await size.focus();await size.press("End");await page.waitForFunction(n=>graphScene.snapshot().nodeSize>n,defaultSize);
  await size.press("Home");await page.waitForFunction(n=>graphScene.snapshot().nodeSize<n,defaultSize);
  await size.evaluate(input=>{input.value="0";input.dispatchEvent(new Event("input",{bubbles:true}));});
  await page.waitForFunction(n=>graphScene.snapshot().nodeSize===n,defaultSize);await open();
  pass("The existing Size slider changes selectable geometric node sizes without reading result files");
  await click(node(0));assert.equal((await state()).pending.pointIndex,0);
  const move=await screen(node(12));await page.mouse.move(move.x,move.y);await page.waitForFunction(()=>graphScene.snapshot().preview===true);
  await click(node(23,0,1));assert.equal((await state()).axes.length,0);assert.ok((await state()).notice.includes("образ"));
  await click(node(23,1));assert.equal((await state()).axes.length,0);
  await click(node(23));await page.waitForFunction(()=>graphScene.snapshot().axes.length===1);
  assert.equal((await state()).mode,null);assert.deepEqual((await state()).axes[0].points,[0,23]);
  assert.ok((await scene()).colors.every(c=>c==="ff0000"));
  pass("Real node clicks create a rubber-band axis, rejecting another object and another periodic image");
  await mode("Добавить");await click(node(2));await page.keyboard.press("Escape");assert.equal((await state()).pending,null);assert.equal((await state()).mode,null);
  await open();await graphs.getByRole("button",{name:"Построить",exact:true}).click();
  await page.waitForFunction(()=>graphUI.current().length===1&&!graphUI.current()[0].error&&graphScene.snapshot().planes?.length===1);
  const reads=await page.evaluate(()=>graphFixture.reads.length);await graphs.getByRole("button",{name:"Построить",exact:true}).click();await page.waitForFunction(()=>!graphUI.busy());
  assert.equal(await page.evaluate(()=>graphFixture.reads.length),reads);
  await page.screenshot({path:path.join(out,"oblique-graph.png"),fullPage:true});
  pass("Escape resets addition; Build computes a graph in the real worker and reuses unchanged results");
  await graphs.getByRole("checkbox",{name:"Показывать графики",exact:true}).uncheck();await page.waitForFunction(()=>graphScene.snapshot().planes.every(p=>!p.visible));
  assert.equal((await state()).axes.length,1);await graphs.getByRole("checkbox",{name:"Показывать графики",exact:true}).check();
  await page.waitForFunction(()=>graphScene.snapshot().planes.every(p=>p.visible));assert.equal(await page.evaluate(()=>graphFixture.reads.length),reads);
  await graphs.getByRole("button",{name:"Повернуть",exact:true}).click();
  await page.waitForFunction(()=>{const a=graphUI.state().axes[0];const p=a.points.map(pointIndex=>graphScene.screen({...a,pointIndex}));return Math.abs(p[0].y-p[1].y)<.05&&p[1].x>p[0].x;});
  await page.screenshot({path:path.join(out,"horizontal-graph.png"),fullPage:true});
  pass("Hiding preserves axes/data without new reads; Rotate faces the plane with a horizontal increasing abscissa");
  await mode("Изменить");const from=await screen(node(0)),to=await screen(node(5));
  await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:5});await page.mouse.up();
  assert.equal((await state()).axes[0].points[0],5);assert.equal((await state()).mode,"edit");
  await mode("Изменить");await open();await graphs.getByRole("button",{name:"Построить",exact:true}).click();
  await page.waitForFunction(()=>!graphUI.busy()&&graphUI.current().length===1&&!graphUI.current()[0].error);
  pass("Editing snaps an endpoint and invalidates only the changed graph");
  await mode("Удалить");await click(node(5));const dialog=page.getByRole("dialog",{name:"Удаление оси графика"});await dialog.waitFor();
  await dialog.getByRole("button",{name:"Отмена",exact:true}).click();assert.equal((await state()).axes.length,1);assert.equal((await state()).mode,"delete");
  await click(node(5));await dialog.waitFor();await dialog.getByRole("button",{name:"Удалить ось",exact:true}).click();
  assert.equal((await state()).axes.length,0);assert.equal((await state()).mode,"delete");await page.keyboard.press("Escape");
  assert.equal((await state()).mode,null,"Escape exits delete mode after the confirmation closes");
  pass("Deletion requires a modal confirmation; cancelling preserves the axis and the editing mode");
  await page.getByRole("button",{name:"Показ",exact:true}).click();await page.getByRole("button",{name:"Показать все",exact:true}).click();
  await page.waitForFunction(()=>{const p=graphScene.screen({source:{schemaId:"regions",recordIndex:0},instance:{ls:0,as:0,ps:0,mirrorX:0,mirrorY:0},pointIndex:19});return p.x>320&&p.x<1900&&p.y>150&&p.y<1000;});
  await mode("Добавить");await click(node(0,0,0,"regions"));await click(node(19,0,0,"regions"));await open();await graphs.getByRole("button",{name:"Построить",exact:true}).click();
  await page.waitForFunction(()=>!graphUI.busy()&&graphUI.current().some(g=>!g.error&&g.quantityKey==="Bs"));
  await page.evaluate(()=>{graphFixture.holdReads();graphFixture.setTime(1);});
  await page.waitForFunction(()=>graphFixture.pendingReads()>0);
  assert.equal((await scene()).planes.length,1);assert.equal(await page.evaluate(()=>graphUI.current()[0].timeIndex),0);
  await page.evaluate(()=>graphFixture.releaseReads());
  await page.waitForFunction(()=>!graphUI.busy()&&graphUI.current().some(g=>g.timeIndex===1&&!g.error));
  pass("Changing time keeps the observation-area graph visible and automatically replaces its curve when ready");
  await graphs.getByRole("checkbox",{name:"только графики",exact:true}).uncheck();await page.waitForFunction(()=>graphScene.snapshot().layers>0);
  await graphs.getByRole("checkbox",{name:"только графики",exact:true}).check();await page.waitForFunction(()=>graphScene.snapshot().layers===0);
  assert.ok((await scene()).planes.length);pass("Only graphs hides every result layer and restores them on demand while retaining the graphs");
  await mode("Добавить");await click(node(0));await click(node(23));
  assert.equal((await state()).axes.length,2);
  await page.getByRole("button",{name:"Объемные элементы",exact:true}).click();
  await page.getByRole("radio",{name:/Потери на токи проводимости/}).check();await open();
  for(const component of ["X","Y","Z"])assert.equal(await graphs.getByRole("checkbox",{name:component+"-компонента",exact:true}).isDisabled(),true);
  await graphs.getByRole("button",{name:"Построить",exact:true}).click();
  await page.waitForFunction(()=>!graphUI.busy()&&graphUI.current().length===2&&graphUI.current().some(g=>g.components===1&&!g.error));
  const scalar=await page.evaluate(()=>{const g=graphUI.current().find(g=>g.components===1);return {start:g.start,value:g.values[0],length:g.values.length};});
  assert.ok(Math.abs(scalar.value-(2*(scalar.start[0]+1)-(2*scalar.start[1]-1)+.5*(-scalar.start[2]+2))*.001)<1e-9);
  const cachedReads=await page.evaluate(()=>graphFixture.reads.length);
  await graphs.getByRole("checkbox",{name:"Показывать графики",exact:true}).uncheck();
  await page.evaluate(()=>graphFixture.setMounted(false));await page.waitForFunction(()=>document.querySelector(".source-graphs-panel")===null);
  await page.evaluate(()=>graphFixture.setMounted(true));await page.waitForFunction(()=>graphScene.ready());await open();
  assert.equal(await graphs.getByRole("checkbox",{name:"Показывать графики",exact:true}).isChecked(),false);
  assert.equal((await state()).axes.length,2);await graphs.getByRole("checkbox",{name:"Показывать графики",exact:true}).check();
  await graphs.getByRole("button",{name:"Построить",exact:true}).click();await page.waitForFunction(()=>!graphUI.busy());
  assert.equal(await page.evaluate(()=>graphFixture.reads.length),cachedReads);
  pass("Scalar graphs disable component switches; hiding and remounting preserve both axes and cached curves");
  await click(node(0,0,0,"regions"));await open();
  for(const component of ["X","Y","Z"])assert.equal(await graphs.getByRole("checkbox",{name:component+"-компонента",exact:true}).isEnabled(),true);
  await graphs.getByRole("checkbox",{name:"Y-компонента",exact:true}).uncheck();
  await graphs.getByLabel("фон",{exact:true}).fill("#ecf2ff");
  await graphs.getByRole("button",{name:"Повернуть",exact:true}).click();
  await page.getByRole("button",{name:"Графики",exact:true}).click();
  await page.screenshot({path:path.join(out,"surface-graph.png"),fullPage:true});
  assert.equal(await page.evaluate(()=>graphFixture.reads.length),cachedReads);
  const regionId=(await state()).axes.find(a=>a.source.schemaId==="regions").id;
  const planePoint=await page.evaluate(id=>graphScene.planePoint(id),regionId);
  await page.mouse.click(planePoint.x,planePoint.y);assert.equal((await state()).active,regionId);
  assert.deepEqual((await scene()).planes.find(p=>p.id===regionId).border,[237,156,38,255]);
  const steady=(await scene()).camera;
  await page.mouse.move(planePoint.x+100,planePoint.y+80,{steps:8});
  assert.deepEqual((await scene()).camera,steady,"a released mouse must not move the camera after selecting the graph plane");
  await open();await graphs.getByRole("button",{name:"Повернуть",exact:true}).click();
  const rotated=(await scene()).camera;
  await page.mouse.move(planePoint.x-80,planePoint.y+100,{steps:8});assert.deepEqual((await scene()).camera,rotated);
  await page.mouse.move(planePoint.x,planePoint.y);await page.mouse.down();await page.mouse.move(planePoint.x+65,planePoint.y+45,{steps:5});await page.mouse.up();
  assert.notDeepEqual((await scene()).camera,rotated,"normal camera dragging still works");
  const released=(await scene()).camera;await page.mouse.move(planePoint.x+100,planePoint.y+80,{steps:5});assert.deepEqual((await scene()).camera,released);
  await open();await graphs.getByRole("button",{name:"Повернуть",exact:true}).click();await page.getByRole("button",{name:"Графики",exact:true}).click();
  pass("Clicking a graph plane selects its frame; Rotate affects that selection and released mouse movement never drags the view");
  const movie=await page.evaluate(async()=>{
    const {createMovieExportController}=await import("/src/services/movie/movieExportController.js");
    const {createMovieWebmEncoder}=await import("/src/services/movie/movieWebmEncoder.js");
    const samples=[];
    const controller=createMovieExportController({createEncoder:()=>{
      const encoder=createMovieWebmEncoder({runtimeUrl:new URL("/__graph-libav/libav-6.10.9.0-webm-vp9.mjs",location.href).href});
      return {addFrame(frame,options){let red=0,background=0;for(let i=0;i<frame.data.length;i+=4){const [r,g,b]=frame.data.subarray(i,i+3);if(r>230&&g<30&&b<30)red++;if(Math.abs(r-236)<5&&Math.abs(g-242)<5&&b>250)background++;}
        samples.push({times:graphUI.current().map(g=>g.timeIndex),red,background});return encoder.addFrame(frame,options);},finish:()=>encoder.finish(),close:()=>encoder.close()};
    }});
    controller.register(graphFixture.capture());graphFixture.setBusy(true);
    try {const result=await controller.run({intervalMs:100});
      const video=document.createElement("video"),url=URL.createObjectURL(result.blob);video.muted=true;video.src=url;
      await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(new Error("Encoded WebM cannot be decoded"));});
      const decoded=[video.videoWidth,video.videoHeight];URL.revokeObjectURL(url);
      return {frames:result.frameCount,width:result.width,height:result.height,decoded,samples,bytes:Array.from(new Uint8Array(await result.blob.arrayBuffer()))};
    } finally {graphFixture.setBusy(false);controller.dispose();}
  });
  await writeFile(path.join(out,"graphs.webm"),new Uint8Array(movie.bytes));delete movie.bytes;
  assert.equal(movie.frames,3);assert.deepEqual(movie.decoded,[movie.width,movie.height]);
  movie.samples.forEach((sample,index)=>{assert.deepEqual(sample.times,[index,index]);assert.ok(sample.red>20&&sample.background>5000,JSON.stringify(sample));});
  assert.ok(await page.evaluate(()=>graphUI.current().every(g=>g.timeIndex===1)));
  await writeFile(path.join(out,"movie.json"),JSON.stringify(movie,null,2));
  pass("Real moview export encodes and decodes a three-frame WebM containing both refreshed graphs and restores the original time");
  await page.setViewportSize({width:1440,height:900});await open();
  const panel=await graphs.boundingBox();assert.ok(panel.x>=0&&panel.x+panel.width<=1440&&panel.y+panel.height<=900);
  pass("Selecting a vector graph re-enables components; component/background changes only redraw, and the panel fits 1440px");
  assert.deepEqual(errors,[]);await writeFile(path.join(out,"browser.json"),JSON.stringify({checks,errors},null,2));console.log("BROWSER_OK "+checks.length);
} catch(error) {await page?.screenshot({path:path.join(out,"failure.png"),fullPage:true}).catch(()=>{});const state=await page?.evaluate(()=>({ui:graphUI.state(),scene:graphScene.snapshot(),region:graphScene.screen({source:{schemaId:"regions",recordIndex:0},instance:{ls:0,as:0,ps:0,mirrorX:0,mirrorY:0},pointIndex:19})})).catch(()=>null);await writeFile(path.join(out,"browser.json"),JSON.stringify({checks,errors,state,error:error.stack},null,2));console.error(error);process.exitCode=1;}
finally {await browser?.close();await server?.close();await rm(dir,{recursive:true,force:true});}
