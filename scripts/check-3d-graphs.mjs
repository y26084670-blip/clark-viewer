import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
const planeName = direction => `плоскость DV${direction} (${[4,3,2][direction-1]})`;
const root = fileURLToPath(new URL("..", import.meta.url)), out = process.env.CHECK_OUTPUT || "/tmp/clark-3d-graphs";
const dir = await mkdtemp(path.join(root, "__graph3d_check_")); await mkdir(out, { recursive: true });
await writeFile(path.join(dir, "index.html"), '<html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/scripts/test-support/graph3DBrowserFixture.jsx"></script></body></html>');
const inspect = { name: "surface-graph-inspection", enforce: "pre", configureServer(server) {
  server.middlewares.use(async (request, response, next) => {
    if (!request.url?.startsWith("/__graph-libav/")) return next();
    try { const file = path.basename(request.url); response.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : "text/javascript"); response.end(await readFile(path.join(root, "node_modules/@libav.js/variant-webm-vp9/dist", file))); } catch (error) { next(error); }
  });
}, transform(code, id) {
  if (id.endsWith("/src/tabs/SourcesFields3D.jsx")) return code.replace('  return <div class="results-layout">',
    '  window.graphUI = { slices: graphSlices, active: activeSlice, results: graphResults, only: graphsOnly, busy: graphBusy, error: graphError, contour: graphContour, profiles: graphProfiles, profileResults, ready: graphReady, expanded: expandedProfile };\n  return <div class="results-layout">');
  if (id.endsWith("/src/components/LineChart.jsx")) return code.replace('  return <div class="line-chart"',
    '  window.profileChart = { chart: () => chart, legend: () => legendHitBoxes, endpoints: () => props.endpointCoordinates, view: () => ({limits:limits(),auto:autoScale(),legend:showLegend()}) };\n  return <div class="line-chart"');
  if (id.endsWith("/src/tabs/WorkingPoints.jsx")) return code.replace('  // Axis transforms use different coordinates:',
    '  window.workingPointUI = { series, count: () => displayed().count, omitted: () => displayed().omittedZeros, log: () => props.logarithmic };\n  // Axis transforms use different coordinates:');
  if (id.endsWith("/src/components/geometry/ThreeGeometryViewport.jsx")) return code.replace('  return (\n    <div',
    `  window.graphScene = { ready: () => ready(), point: (id, component, u, v, ps = 0) => {
      renderNow();
      let mesh; graphRoot?.traverseVisible(o=>{if(o.name==="result-graph-surface" && o.userData.graphId===id && o.userData.component===component && o.userData.surface.instance.ps===ps)mesh=o;});
      if(!mesh)throw new Error("missing surface");
      const [n1,n2]=mesh.userData.surface.dimensions, x=u*(n1-1),y=v*(n2-1),i=Math.min(n1-2,Math.floor(x)),j=Math.min(n2-2,Math.floor(y)),a=i*n2+j,b=(i+1)*n2+j,c=b+1,d=a+1,du=x-i,dv=y-j;
      const ids=du>=dv?[a,b,c]:[a,c,d],weights=du>=dv?[1-du,du-dv,dv]:[1-dv,du,dv-du],p=new THREE.Vector3();
      ids.forEach((n,k)=>p.addScaledVector(new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position,n),weights[k]));
      p.project(camera);const box=renderer.domElement.getBoundingClientRect();return {x:box.left+(p.x+1)*box.width/2,y:box.top+(1-p.y)*box.height/2};
    }, snapshot: () => {
      const meshes=[];graphRoot?.traverse(o=>{if(o.name==="result-graph-surface")meshes.push({id:o.userData.graphId,component:o.userData.component,visible:o.parent.visible,color:o.material.color.getHexString(),lit:o.material.isMeshStandardMaterial,palette:o.material.vertexColors,factor:o.userData.factor,positions:Array.from(o.geometry.attributes.position.array.slice(0,9)),basePositions:Array.from(o.userData.surface.positions.slice(0,9))});});
      const contours=[];graphRoot?.traverse(o=>{if(o.name==="graph-contour")contours.push({selection:o.userData.selection,preview:o.userData.preview,positions:Array.from(o.children[0].geometry.attributes.instanceStart.array)});});
      return {meshes,contours,filters:activeResultFilters,geometryCount:geometryRoot?.children.length,preview:graphRoot?.getObjectByName("graph-slice-preview")?.children.length??0,previewSpec:props.graphPreview,previewPoint:graphRoot?.getObjectByName("graph-slice-preview")?.children[0]?.geometry.attributes.position.array.slice(0,3),selectionTypes:graphRoot?.getObjectByName("graph-selected-element")?.children.map(o=>o.type)??[],selected:graphRoot?.getObjectByName("graph-selected-element")?.children.length??0,
        camera:[camera?.position.toArray(),camera?.quaternion.toArray(),controls?.target.toArray()],direction:camera?.position.clone().sub(controls.target).normalize().toArray(),layers:[...resultLayerStates.values()].reduce((n,s)=>n+(s.vectorRoot?.children.length??0)+(s.scalarRoot?.children.length??0),0)};
    }};\n  return (\n    <div`);
} };
let browser, server, page; const errors = [], checks = [];
const pass = text => { checks.push(text); console.log("PASS " + checks.length + ": " + text); };
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  server = await createServer({ configFile: false, root, cacheDir: path.join(root, "node_modules/.vite-graph3d-check"), plugins: [inspect, solid()], optimizeDeps: { entries: [path.join(dir, "index.html")] }, server: { host: "127.0.0.1", port: 0, hmr: false } }); await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--disable-dev-shm-usage"] });
  page = await browser.newPage({ viewport: { width: 1920, height: 1080 } }); page.on("pageerror", e => errors.push(e.message)); page.on("console", message => { if (message.type() === "error") console.error(message.text()); if(message.text().includes("computations created outside")) errors.push(message.text()); });
  await page.goto("http://127.0.0.1:" + server.httpServer.address().port + "/" + path.basename(dir) + "/index.html");
  await page.waitForFunction(() => window.graphScene?.ready() && graphUI.ready());
  const scene = () => page.evaluate(() => graphScene.snapshot()), graphs = page.locator(".source-graphs-panel");
  const closeMenus = () => page.locator(".task-info-bar").click();
  const open = async () => {
    if (await graphs.isVisible()) return;
    if (!await page.locator(".source-presentation-panel").isVisible()) await page.getByRole("button", { name: "Представление", exact: true }).click();
    await page.getByRole("button", { name: "Графики", exact: true }).click();
  };
  const waitGraphs = () => page.waitForFunction(() => !graphUI.busy() && !graphUI.error());
  const toolbar = page.locator(".sources-fields-toolbar");
  const topButtons = toolbar.locator(".sources-fields-toolbar-controls > .source-toolbar-menu > button, .source-geometry-controls button");
  assert.deepEqual(await topButtons.allTextContents(), ["Элементы", "Области", "Симметрии", "Представление", "Векторные линии", "Общие опции"]);
  assert.equal(await page.locator(".geometry-viewer-window .geometry-viewer-toolbar").count(), 0);
  for (const width of [1920,1440,960]) {
    await page.setViewportSize({ width, height: 1080 });
    const boxes = await toolbar.locator(".source-toolbar-menu > button, .source-geometry-controls button, .geometry-viewer-transparency, .protocol-check-wrap").evaluateAll(els => els.map(el => { const r=el.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom}; }));
    assert.ok(boxes.every(box => box.x>=0 && box.right<=width), JSON.stringify({width,boxes}));
    for (let i=1;i<boxes.length;i++) assert.ok(boxes[i].y>=boxes[i-1].bottom || boxes[i].x>=boxes[i-1].right, JSON.stringify({width,boxes}));
    if(width>=1440) assert.ok(Math.max(...boxes.map(b=>b.y))-Math.min(...boxes.map(b=>b.y))<12, JSON.stringify({width,boxes}));
  }
  await page.screenshot({path:path.join(out,"toolbar-960.png"),fullPage:true});
  await page.setViewportSize({width:1920,height:1080});
  pass("Unified toolbar has six buttons and Size/Transparency before Protocol; no duplicate inner toolbar, no overlaps at 960/1440/1920px");

  const sourceMenu = page.locator(".source-toolbar-menu-panel");
  const geometryCount = (await scene()).geometryCount;
  await page.evaluate(n=>{window.toolbarGeometryCount=n;graphFixture.setElements([1]);},geometryCount);
  for(const [label,key,separators] of [["Элементы","elements",[/Не показывать/,/Плотность энергии/,/Относительная электропроводность/]], ["Области","regions",[/Не показывать/,/Векторный потенциал/]]]) {
    await page.getByRole("button",{name:label,exact:true}).click();
    const preceding = await sourceMenu.locator("hr").evaluateAll(els=>els.map(el=>el.previousElementSibling.textContent));
    assert.equal(preceding.length,separators.length); preceding.forEach((text,i)=>assert.match(text,separators[i]));
    assert.deepEqual((await sourceMenu.locator("label").allTextContents()).slice(-3),["Показать все","Выделенные в списке","Кроме выделенных"]);
    await sourceMenu.getByRole("radio",{name:"Кроме выделенных",exact:true}).check();
    await page.waitForFunction(key=>graphScene.snapshot().filters.objectModes[key]==="exceptSelected" && graphScene.snapshot().geometryCount<window.toolbarGeometryCount,key);
    await sourceMenu.getByRole("radio",{name:"Выделенные в списке",exact:true}).check();
    await page.waitForFunction(key=>graphScene.snapshot().filters.objectModes[key]==="selected",key);
    await sourceMenu.getByRole("radio",{name:"Показать все",exact:true}).check();
    await page.waitForFunction(n=>graphScene.snapshot().geometryCount===n,geometryCount);
    await closeMenus();
  }
  await page.evaluate(()=>graphFixture.setElements([1,2]));
  pass("Elements/Regions contain separators and independent quantity/visibility radios; selection filters really remove and restore geometry");

  await page.getByRole("button",{name:"Симметрии",exact:true}).click();
  assert.equal(await sourceMenu.getByRole("radio").count(),3);
  assert.deepEqual(await sourceMenu.locator("label:has(input[type=checkbox])").allTextContents(),["Локальная","Азимутальная","Периодическая","Зеркальная"]);
  for (const [label,key] of [["Локальная","local"],["Азимутальная","axial"],["Периодическая","periodic"],["Зеркальная","mirror"]]) {
    const checkbox=sourceMenu.getByRole("checkbox",{name:label,exact:true}); const initial=await checkbox.isChecked();
    await checkbox.setChecked(!initial); await page.waitForFunction(({key,value})=>graphScene.snapshot().filters.symmetry[key]===value,{key,value:!initial});
    if(key==="periodic") assert.ok((await scene()).geometryCount<geometryCount);
    await checkbox.setChecked(initial);
  }
  await page.waitForFunction(n=>graphScene.snapshot().geometryCount===n,geometryCount);
  await closeMenus();
  pass("Symmetries preserves virtual quantity choices and all four display switches; periodic images hide and return");

  await page.getByRole("button",{name:"Представление",exact:true}).click();
  assert.equal(await page.locator(".source-presentation-panel > :last-child").innerText(),"Графики");
  await page.getByRole("checkbox",{name:"Карта",exact:true}).check(); await closeMenus();
  await page.waitForFunction(()=>document.querySelectorAll(".geometry-scalar-legend").length===2);
  const legendPanel=page.locator(".geometry-scalar-legends");
  const legendBox=await legendPanel.boundingBox(), viewBox=await page.locator(".three-geometry-viewport").boundingBox();
  assert.ok(Math.abs(viewBox.y+viewBox.height-legendBox.y-legendBox.height-10)<2);
  assert.ok(Math.abs(viewBox.x+viewBox.width-legendBox.x-legendBox.width-10)<2);
  const legendPositions=await legendPanel.locator(".geometry-scalar-legend").evaluateAll(els=>els.map(el=>({label:el.querySelector("strong").textContent,y:el.getBoundingClientRect().y})));
  assert.deepEqual(legendPositions.map(p=>p.label),["Элементы","Области"]);assert.ok(legendPositions[0].y>legendPositions[1].y);
  const capturedLegends=await page.evaluate(async()=>{
    const adapter=graphFixture.capture();await adapter.prepare();const frame=await adapter.capture(0);await adapter.restore(0);
    const pixel=(x,y)=>Array.from(frame.data.slice((Math.round(y)*frame.width+Math.round(x))*4,(Math.round(y)*frame.width+Math.round(x))*4+3));
    const strips=[1,2].map(i=>[pixel(frame.width-288,frame.height-8-i*86+46),pixel(frame.width-25,frame.height-8-i*86+46)]);
    const canvas=document.createElement("canvas");canvas.width=frame.width;canvas.height=frame.height;canvas.getContext("2d").putImageData(frame,0,0);
    return {strips,png:canvas.toDataURL("image/png").split(",")[1]};
  });
  capturedLegends.strips.forEach(([a,b])=>assert.ok(a.some((v,i)=>Math.abs(v-b[i])>50),JSON.stringify({a,b})));
  await writeFile(path.join(out,"bottom-legends-capture.png"),Buffer.from(capturedLegends.png,"base64"));
  await page.screenshot({path:path.join(out,"bottom-legends.png"),fullPage:true});
  const heading=await legendPanel.locator(".geometry-overlay-drag-handle").boundingBox();
  await page.mouse.move(heading.x+30,heading.y+8);await page.mouse.down();await page.mouse.move(viewBox.x+100,viewBox.y+80,{steps:5});await page.mouse.up();
  const movedLegend=await legendPanel.boundingBox(); assert.equal(movedLegend.height,legendBox.height);assert.ok(movedLegend.x<legendBox.x && movedLegend.y<legendBox.y);
  assert.equal(await legendPanel.evaluate(el=>el.style.bottom),"auto");
  await page.mouse.move(400,400);assert.deepEqual(await legendPanel.boundingBox(),movedLegend);
  await page.getByRole("button",{name:"Представление",exact:true}).click();await page.getByRole("checkbox",{name:"Карта",exact:true}).uncheck();await closeMenus();
  pass("Colour legends start at bottom right and grow upward in both viewport and captured frame; dragging retains panel height and releases the pointer");

  await open();
  for (const label of ["Только графики", "Графики над площадками", "Срезы в элементах"]) assert.equal(await graphs.getByRole("checkbox", { name: label, exact: true }).isChecked(), false);
  for (const label of ["Изменить", "Построить", "Повернуть"]) assert.equal(await graphs.getByRole("button", { name: label, exact: true }).count(), 0);
  assert.equal(await graphs.locator('input[type="color"]').count(), 0);
  assert.equal(await page.getByRole("button", { name: "Показ", exact: true }).count(), 0);
  await page.waitForFunction(() => graphScene.snapshot().layers > 0);
  await graphs.getByRole("checkbox", { name: "Только графики", exact: true }).check(); await page.waitForFunction(() => graphScene.snapshot().layers === 0);
  pass("New graph controls start unchecked; obsolete controls are absent and Only graphs suppresses result layers");

  const size = page.getByRole("slider", { name: "Размер представления", exact: true });
  const transparency = page.getByRole("slider", { name: "Прозрачность геометрии и рёбер", exact: true });
  assert.equal((await size.boundingBox()).width, (await transparency.boundingBox()).width);
  assert.ok((await size.boundingBox()).x < (await transparency.boundingBox()).x);
  assert.equal(await size.getAttribute("min"), "-2"); assert.equal(await size.getAttribute("max"), "3");
  const mark = await page.locator(".geometry-size-range > i").boundingBox(), slider = await size.boundingBox();
  assert.ok(Math.abs(mark.x + mark.width / 2 - slider.x - slider.width * .4) < 1);
  if (await graphs.isVisible()) await closeMenus();
  await page.getByRole("button", { name: "Общие опции отображения", exact: true }).click();
  const general = page.getByRole("dialog", { name: "Общие опции отображения", exact: true });
  const order = await general.locator("select,label,button").allTextContents();
  assert.ok(order.at(-3).includes("палитра")); assert.ok(order.at(-2).includes("Производительность")); assert.equal(order.at(-1), "Полёт");
  assert.ok(await general.evaluate(el => el.scrollHeight <= el.clientHeight + 1));
  await page.screenshot({ path: path.join(out, "general-options.png"), fullPage: true });
  pass("Logarithmic size covers 0.01–1000 with the nominal marker at 40%; equal-width sliders and General options without scrolling");

  await open(); await graphs.getByRole("checkbox", { name: "Графики над площадками", exact: true }).check();
  await page.waitForFunction(() => graphScene.snapshot().meshes.length === 3); await waitGraphs();
  const rgb = (await scene()).meshes; assert.deepEqual(rgb.map(m => m.color), ["ff0000", "00ff00", "0000ff"]); assert.ok(rgb.every(m => m.lit && !m.palette));
  pass("Area graphs build three lit RGB surfaces in the real worker");
  const surfacePoint = (id,component,u,v,ps=0) => page.evaluate(args=>graphScene.point(...args),[id,component,u,v,ps]);
  const clickSurface = async (id,component,u,v,button="left",ps=0) => {await waitGraphs(); const p=await surfacePoint(id,component,u,v,ps);await page.mouse.click(p.x,p.y,{button});};
  await closeMenus();
  await page.keyboard.press("z"); await page.waitForFunction(()=>graphScene.snapshot().direction[2]>.999);
  const contourMenu = page.getByRole("menu",{name:"Направление 1D графика",exact:true});
  await clickSurface("region:0",1,.4,.4,"right"); await contourMenu.waitFor();
  const cameraBefore = (await scene()).camera, contourReads = await page.evaluate(()=>graphFixture.reads.length);
  for(const direction of [0,1]) {
    await contourMenu.getByRole("menuitemradio").nth(direction).hover();
    await page.waitForFunction(d=>graphScene.snapshot().contours.some(c=>c.preview && c.selection.direction===d),direction);
    assert.equal(await page.evaluate(()=>graphUI.contour()),null);
  }
  await page.screenshot({path:path.join(out,"contour-preview.png"),fullPage:true});
  await page.keyboard.press("Escape"); await contourMenu.waitFor({state:"hidden"});
  await page.waitForFunction(()=>graphScene.snapshot().contours.length===0);
  await clickSurface("region:0",1,.4,.4,"right");
  await contourMenu.getByRole("menuitemradio").nth(0).click();
  await page.waitForFunction(()=>graphScene.snapshot().contours[0] && !graphScene.snapshot().contours[0].preview);
  assert.equal(await page.evaluate(()=>graphUI.contour().index),1);
  await clickSurface("region:0",1,.4,.9); await page.waitForFunction(()=>graphUI.contour().index===3);
  const fixedContour=await page.evaluate(()=>graphUI.contour());
  await page.mouse.move(1100,500); assert.deepEqual((await scene()).camera,cameraBefore);
  assert.deepEqual(await page.evaluate(()=>graphUI.contour()),fixedContour);
  assert.equal(await page.evaluate(()=>graphFixture.reads.length),contourReads);
  await page.screenshot({path:path.join(out,"contour-selected.png"),fullPage:true});
  pass("Right-click hover previews both area directions, Escape cancels, clicks pin/move a single contour without camera sticking or HDF5 reads");
  await page.setViewportSize({width:960,height:640}); await page.waitForTimeout(100);
  await clickSurface("region:0",1,.9,.9,"right"); await contourMenu.waitFor();
  const menuBox=await contourMenu.boundingBox(), viewportBox=await page.locator(".three-geometry-viewport").boundingBox();
  assert.ok(menuBox.x>=viewportBox.x && menuBox.y>=viewportBox.y && menuBox.x+menuBox.width<=viewportBox.x+viewportBox.width && menuBox.y+menuBox.height<=viewportBox.y+viewportBox.height);
  await contourMenu.getByRole("menuitemradio").first().focus(); await page.keyboard.press("ArrowDown");
  await page.waitForFunction(()=>graphScene.snapshot().contours.some(c=>c.preview && c.selection.direction===1));
  await page.keyboard.press("Escape"); assert.deepEqual(await page.evaluate(()=>graphUI.contour()),fixedContour);
  await page.setViewportSize({width:1920,height:1080}); await page.waitForTimeout(100);
  pass("Context menu stays inside a smaller viewport; keyboard preview and Escape preserve the selected contour");
  await open();


  await graphs.getByRole("button", { name: "Добавить", exact: true }).click();
  const add = graphs.locator(".source-slice-add");
  for (const direction of [1, 2, 3]) {
    await add.getByRole("menuitem", { name: planeName(direction), exact: true }).hover();
    await page.waitForFunction(d => graphScene.snapshot().preview > 0 && graphScene.snapshot().previewSpec.direction === d - 1, direction);
  }
  await add.getByRole("menuitem", { name: planeName(1), exact: true }).click();
  await page.waitForFunction(() => graphUI.slices().length === 1 && graphScene.snapshot().meshes.length === 5); await waitGraphs();
  assert.equal(await graphs.getByRole("checkbox", { name: "Срезы в элементах", exact: true }).isChecked(), true);
  assert.equal((await scene()).selected, 2); assert.ok((await scene()).meshes.filter(m => m.id === 1).every(m => m.palette && m.lit));
  assert.deepEqual((await scene()).selectionTypes, ["Mesh", "Mesh"]);
  assert.equal(await graphs.getByRole("spinbutton", { name: "Дискрет среза 1", exact: true }).inputValue(), "2");
  for (const button of ["Добавить", "Удалить"]) assert.ok((await graphs.getByRole("button", { name: button, exact: true }).getAttribute("title")).length > 50);
  for (const checkbox of await graphs.getByRole("checkbox").all()) assert.ok(await checkbox.evaluate(el => !!el.closest("[title]")?.title));
  pass("Direction menus show actual discrete counts; hover previews, tooltips and light element tint replace the extra wireframe");

  const discrete = graphs.getByRole("spinbutton", { name: "Дискрет среза 1", exact: true }), discreteReads = await page.evaluate(() => graphFixture.reads.length);
  assert.deepEqual(await discrete.evaluate(el => { const s=getComputedStyle(el); return [s.color,s.backgroundColor]; }), ["rgb(237, 242, 247)", "rgb(48, 57, 67)"]);
  await discrete.fill("4"); await page.waitForFunction(() => graphUI.results().find(g=>g.id===1)?.discrete === 4); await waitGraphs();
  assert.equal((await scene()).meshes.find(m=>m.id===1).basePositions[0], 35);
  assert.ok(await discrete.evaluate(el => document.activeElement === el));
  await discrete.press("ArrowDown"); await page.waitForFunction(() => graphUI.results().find(g=>g.id===1)?.discrete === 3);
  await discrete.fill("0"); await graphs.locator("th").first().click(); assert.equal(await discrete.inputValue(), "3");
  await graphs.locator("tbody tr").first().getByRole("button", { name: planeName(1), exact: true }).click();
  await graphs.getByRole("menuitem", { name: planeName(1), exact: true }).hover();
  await page.waitForFunction(() => graphScene.snapshot().previewSpec?.discrete === 3);
  assert.equal((await scene()).previewPoint[0], 25);
  await graphs.getByRole("menuitem", { name: planeName(1), exact: true }).click();
  assert.equal(await page.evaluate(() => graphFixture.reads.length), discreteReads);
  pass("Editing the discrete moves the plane through EO centres, preserves keyboard focus and cached reads, and rejects invalid numbers");

  const reads = await page.evaluate(() => graphFixture.reads.length), before = (await scene()).meshes.find(m => m.id === 1).factor;
  for (const [exponent, factor] of [[-2,.01],[3,1000]]) {
    await size.evaluate((input, value) => { input.value = String(value); input.dispatchEvent(new Event("input", { bubbles: true })); }, exponent);
    await page.waitForFunction(({before, factor}) => Math.abs(graphScene.snapshot().meshes.find(m => m.id === 1).factor / before - factor) < 1e-6, {before, factor});
  }
  assert.equal(await page.evaluate(() => graphFixture.reads.length), reads);
  await size.evaluate(input => { input.value = "0"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  if (await graphs.isVisible()) await closeMenus();
  await page.getByRole("button", { name: "Общие опции отображения", exact: true }).click();
  await page.getByRole("combobox", { name: "Палитра результатов", exact: true }).selectOption("Viridis");
  assert.equal(await page.evaluate(() => graphFixture.reads.length), reads);
  await open(); const row = graphs.locator("tbody tr").first();
  await row.getByRole("button", { name: planeName(1), exact: true }).click();
  await graphs.getByRole("menuitem", { name: planeName(3), exact: true }).hover(); await page.waitForFunction(() => graphScene.snapshot().previewSpec?.direction === 2);
  await graphs.getByRole("menuitem", { name: planeName(3), exact: true }).click();
  assert.equal(await discrete.inputValue(), "1"); assert.equal(await discrete.getAttribute("max"), "2");
  await discrete.fill("2"); await row.getByRole("combobox").selectOption("1"); await waitGraphs();
  await page.waitForFunction(() => graphUI.results().find(g => g.id === 1)?.component === 1);
  assert.equal(await page.evaluate(() => graphFixture.reads.length), reads);
  pass("Height, palette, direction and component update immediately; editing a slice reuses cached HDF5 data");
  await closeMenus();
  await transparency.evaluate(el=>{el.value="100";el.dispatchEvent(new Event("input",{bubbles:true}));});
  await page.keyboard.press("z"); await page.waitForFunction(()=>graphScene.snapshot().direction[2]>.999);
  await clickSurface(1,1,.35,.45,"right");
  assert.match(await contourMenu.getByRole("menuitemradio").nth(0).innerText(),/направлении 1 \(DV1\)/);
  assert.match(await contourMenu.getByRole("menuitemradio").nth(1).innerText(),/направлении 2 \(DV2\)/);
  await contourMenu.getByRole("menuitemradio").nth(0).hover();
  await page.waitForFunction(()=>graphScene.snapshot().contours.some(c=>c.preview));
  await contourMenu.getByRole("menuitemradio").nth(0).click();
  await page.waitForFunction(()=>graphUI.contour()?.graphId===1);
  await clickSurface(1,1,.35,.92); await page.waitForFunction(()=>graphUI.contour().index===2);
  const sliceContour=await page.evaluate(()=>graphUI.contour());
  await clickSurface(1,1,.35,.05,"left",1); assert.deepEqual(await page.evaluate(()=>graphUI.contour()),sliceContour);
  assert.equal((await scene()).contours.length,2);
  await page.screenshot({path:path.join(out,"slice-contour.png"),fullPage:true});
  pass("Slice menu names the two actual DV axes; clicks snap to EO rows and cannot move the selection onto a different symmetry image");
  const collection = page.getByRole("complementary", {name:"Коллекция 1D"});
  assert.equal(await collection.locator(".graph-1d-miniature").count(), 2);
  const contourPoint = await surfacePoint(1,1,.35,5/6); await page.mouse.move(contourPoint.x,contourPoint.y);
  await page.waitForFunction(()=>document.querySelector(".geometry-viewport-tooltip")?.textContent.includes("Сечение:"));
  const contourHint=await page.locator(".geometry-viewport-tooltip").innerText();
  assert.match(contourHint,/дискрет 2 \/ 2/); assert.match(contourHint,/индекс 3 \/ 3/);
  await open(); await graphs.locator("tbody select").selectOption("2"); await waitGraphs();
  await page.waitForFunction(()=>graphScene.snapshot().meshes.some(m=>m.id===1 && m.component===2));
  assert.deepEqual(await page.evaluate(()=>graphUI.contour()),sliceContour);
  assert.equal((await scene()).contours.length,2);
  await closeMenus();
  await clickSurface(1,2,.35,.92,"right"); await contourMenu.getByRole("menuitemradio").first().click(); await waitGraphs();
  assert.equal(await collection.locator(".graph-1d-miniature").count(),2);
  pass("Marked sections remain on multiple graphs, tooltips show bounded slice/section indices, and component changes or duplicate picks preserve the collection");

  const expandProfile = id => page.getByRole("button",{name:`Развернуть 1D график №${id}`,exact:true}).click();
  await expandProfile(2); const expanded=page.getByRole("dialog",{name:"1D график №2",exact:true});
  await page.waitForFunction(()=>profileChart.chart()?.data.datasets.length===3);
  const full = await page.evaluate(()=>({ colors:profileChart.chart().data.datasets.map(d=>d.borderColor), points:profileChart.chart().data.datasets.map(d=>d.data), endpoints:profileChart.endpoints() }));
  assert.deepEqual(full.colors,["#ff0000","#00ff00","#0000ff"]); assert.equal(full.points[0].length,4);
  assert.ok(Math.abs(full.endpoints.start[0]-5)<1e-8); assert.ok(Math.abs(full.endpoints.end[0]-35)<1e-8); assert.ok(Math.abs(full.endpoints.length-30)<1e-8);
  const chartBox=await expanded.locator("canvas").boundingBox();
  const legendY=await page.evaluate(()=>profileChart.legend()[1]);
  await page.mouse.click(chartBox.x+(legendY.left+legendY.right)/2,chartBox.y+(legendY.top+legendY.bottom)/2);
  assert.equal(await page.evaluate(()=>profileChart.chart().isDatasetVisible(1)),false);
  await expanded.getByRole("button",{name:"Авто",exact:true}).click();
  const frozen=await page.evaluate(()=>profileChart.view().limits);
  await page.evaluate(()=>{window.keptProfileChart=profileChart.chart();graphFixture.setTime(1);}); await waitGraphs();
  assert.ok(await page.evaluate(()=>profileChart.chart()===keptProfileChart && !profileChart.chart().isDatasetVisible(1)));
  assert.deepEqual(await page.evaluate(()=>profileChart.view().limits),frozen);
  await page.evaluate(()=>graphFixture.setTime(0)); await waitGraphs();
  pass("Expanded 1D uses all XYZ samples in RGB, actual endpoint coordinates, a toggling legend and frozen axes that survive time updates without recreating the chart");

  await page.evaluate(()=>{
    window.copiedGraph={}; Object.defineProperty(navigator,"clipboard",{configurable:true,value:{
      async writeText(text){copiedGraph.table=text;},async write(items){const blob=await items[0].getType("image/png");const bitmap=await createImageBitmap(blob);copiedGraph.image={type:blob.type,size:blob.size,width:bitmap.width,height:bitmap.height};bitmap.close();}
    }});
  });
  await expanded.locator("canvas").click({button:"right",position:{x:60,y:60}});
  await expanded.getByRole("button",{name:"Копировать таблицу",exact:true}).click();
  const copied=await page.evaluate(()=>copiedGraph.table); assert.equal(copied.split("\n").length,5);assert.equal(copied.split("\n")[0].split("\t").length,4);assert.match(copied,/X/);assert.match(copied,/Y/);assert.match(copied,/Z/);
  await expanded.locator("canvas").click({button:"right",position:{x:60,y:60}});
  await expanded.getByRole("button",{name:"Копировать изображение",exact:true}).click();
  await page.waitForFunction(()=>copiedGraph.image?.size>1000);
  assert.ok((await page.evaluate(()=>copiedGraph.image)).width>1000);
  await page.screenshot({path:path.join(out,"expanded-profile.png"),fullPage:true});
  await expanded.getByRole("button",{name:"Свернуть",exact:true}).click(); await expandProfile(2);
  await page.waitForFunction(()=>profileChart.chart()?.data.datasets.length===3);
  assert.equal(await page.evaluate(()=>profileChart.chart().isDatasetVisible(1)),false);assert.deepEqual(await page.evaluate(()=>profileChart.view().limits),frozen);
  await expanded.getByRole("button",{name:"Свернуть",exact:true}).click();
  pass("Copy table includes hidden components; copy image produces PNG with the full plot; collapse/expand retains visibility and axes");
  await open();

  await graphs.getByRole("checkbox", { name: "Срезы в элементах", exact: true }).uncheck(); await page.waitForFunction(() => graphScene.snapshot().meshes.length === 3);
  assert.equal(await graphs.locator("tbody tr").count(), 1);
  await graphs.getByRole("checkbox", { name: "Срезы в элементах", exact: true }).check(); await waitGraphs();
  await page.waitForFunction(() => graphScene.snapshot().meshes.length === 5);
  await page.evaluate(() => { graphFixture.holdReads(); graphFixture.setTime(1); }); await page.waitForFunction(() => graphFixture.pendingReads() > 0);
  assert.equal((await scene()).meshes.length, 5); assert.ok(await page.evaluate(() => graphUI.results().every(g => g.timeIndex === 0)));
  await page.evaluate(() => graphFixture.releaseReads()); await page.waitForFunction(() => !graphUI.busy() && graphUI.results().every(g => g.timeIndex === 1));
  assert.deepEqual(await page.evaluate(()=>{const {view,...selection}=graphUI.contour();return selection;}),sliceContour);
  await page.waitForFunction(()=>graphScene.snapshot().contours.length===2);
  pass("Hiding retains rows and contour; time changes retain old surfaces then update the selected contour with the new frame");

  await open(); await graphs.getByRole("button", { name: "Добавить", exact: true }).click();
  await add.getByRole("combobox", { name: "Элемент для среза", exact: true }).selectOption("1");
  await add.getByRole("menuitem", { name: planeName(2), exact: true }).click(); await waitGraphs();
  assert.equal(await graphs.locator("tbody tr").count(), 2);
  await graphs.locator("tbody tr").first().getByRole("button", { name: planeName(3), exact: true }).click();
  await graphs.getByRole("menuitem", { name: planeName(1), exact: true }).hover();
  await graphs.getByRole("spinbutton", { name: "Дискрет среза 2", exact: true }).focus();
  assert.equal(await graphs.getByRole("menuitem").count(), 0);
  await page.waitForFunction(() => graphScene.snapshot().preview === 0);
  await graphs.locator("tbody tr").first().locator("td").first().click(); assert.equal(await page.evaluate(() => graphUI.active()), 1);
  await graphs.getByRole("button", { name: "Удалить", exact: true }).click(); await waitGraphs();
  assert.equal(await graphs.locator("tbody tr").count(), 1); assert.equal(await graphs.locator("tbody tr td").nth(1).innerText(), "2");
  await page.getByRole("button", { name: "Элементы", exact: true }).click(); await page.getByRole("radio", { name: /Потери на токи проводимости/ }).check();
  await open(); await waitGraphs(); assert.equal(await graphs.locator("tbody select").isDisabled(), true);
  assert.equal(await page.evaluate(() => graphUI.results().find(g => g.kind === "slice").components), 1);
  pass("One table row selects its highlighted element; Delete removes that row and scalar quantities disable component selection");

  await graphs.getByRole("checkbox", { name: "Срезы в элементах", exact: true }).uncheck();
  await page.evaluate(() => graphFixture.setMounted(false)); await page.waitForFunction(() => !document.querySelector(".source-graphs-panel"));
  await page.evaluate(() => graphFixture.setMounted(true)); await page.waitForFunction(() => graphScene.ready()); await open();
  assert.equal(await graphs.locator("tbody tr").count(), 1); assert.equal(await graphs.getByRole("checkbox", { name: "Срезы в элементах", exact: true }).isChecked(), false);
  await graphs.getByRole("checkbox", { name: "Срезы в элементах", exact: true }).check(); await waitGraphs();
  await closeMenus();
  pass("Tab remount preserves slices, selection and visibility settings");

  for (const key of ["x", "y", "z"]) for (const negative of [false, true]) {
    await page.keyboard.press(negative ? `Control+${key}` : key);
    await page.waitForFunction(({ axis, sign }) => graphScene.snapshot().direction[axis] * sign > .999, { axis: "xyz".indexOf(key), sign: negative ? -1 : 1 });
  }
  await page.keyboard.press("Control+a"); await page.waitForFunction(() => graphScene.snapshot().direction.every(x => x > .5));
  const canvas = page.locator(".geometry-viewer-canvas-region canvas").first(), box = await canvas.boundingBox();
  await page.mouse.move(box.x + 50, box.y + box.height - 50); await page.waitForSelector(".geometry-viewport-tooltip");
  const tooltip = page.locator(".geometry-viewport-tooltip"); const hint = await tooltip.innerText(); assert.equal(hint.split("\n").length, 3); assert.ok(hint.includes("Ctrl+X"));
  await page.mouse.move(box.x + box.width * .65, box.y + box.height * .55); await page.mouse.down(); await page.mouse.move(box.x + box.width * .7, box.y + box.height * .6, { steps: 5 }); await page.mouse.up();
  const stopped = (await scene()).camera; await page.mouse.move(box.x + box.width * .75, box.y + box.height * .65, { steps: 5 }); assert.deepEqual((await scene()).camera, stopped);
  await page.keyboard.press("Control+a");
  await page.screenshot({ path: path.join(out, "surfaces.png"), fullPage: true });
  pass("X/Y/Z and Ctrl+X/Y/Z face the requested sides, the cube has three help lines, and camera drag ends on mouse release");

  await page.keyboard.press("z"); await page.waitForFunction(()=>graphScene.snapshot().direction[2]>.999);
  await clickSurface("region:0",1,.4,.55,"right"); await contourMenu.getByRole("menuitemradio").nth(1).click();
  await page.waitForFunction(()=>graphScene.snapshot().contours.length===2);
  await clickSurface("region:0",1,.4,.55,"right"); await contourMenu.getByRole("menuitemradio").nth(0).hover();
  await page.waitForFunction(()=>graphScene.snapshot().contours.some(c=>c.preview));
  await page.evaluate(async()=>{const adapter=graphFixture.capture();await adapter.prepare();await adapter.capture(1);await adapter.restore(1);});
  await contourMenu.waitFor({state:"hidden"});
  assert.equal((await scene()).contours[0].preview,false);
  pass("Capture preparation removes an uncommitted preview and records the selected contour even without a movie-busy flag");
  await page.keyboard.press("Control+a");
  const movie = await page.evaluate(async () => {
    const { createMovieExportController } = await import("/src/services/movie/movieExportController.js");
    const { createMovieWebmEncoder } = await import("/src/services/movie/movieWebmEncoder.js"); const samples = [];
    const controller = createMovieExportController({ createEncoder: () => {
      const encoder = createMovieWebmEncoder({ runtimeUrl: new URL("/__graph-libav/libav-6.10.9.0-webm-vp9.mjs", location.href).href });
      return { addFrame(frame, options) {
        let color = 0, white = 0;
        for (let i = 0; i < frame.data.length; i += 4) { const [r,g,b] = frame.data.subarray(i,i+3); if (Math.max(r,g,b) > 150 && Math.max(r,g,b) - Math.min(r,g,b) > 100) color++; if (r > 245 && g > 245 && b > 245) white++; }
        samples.push({ times: graphUI.results().map(g => g.timeIndex), meshes: graphScene.snapshot().meshes.length, contours: graphScene.snapshot().contours.length, color, white }); return encoder.addFrame(frame, options);
      }, finish: () => encoder.finish(), close: () => encoder.close() };
    } });
    controller.register(graphFixture.capture()); graphFixture.setBusy(true);
    try { const result = await controller.run({ intervalMs: 100 }); const video = document.createElement("video"), url = URL.createObjectURL(result.blob); video.muted = true; video.src = url;
      await new Promise((resolve,reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error("WebM decode failed")); });
      const decoded = [video.videoWidth, video.videoHeight]; URL.revokeObjectURL(url);
      return { frames: result.frameCount, width: result.width, height: result.height, decoded, samples, bytes: Array.from(new Uint8Array(await result.blob.arrayBuffer())) };
    } finally { graphFixture.setBusy(false); controller.dispose(); }
  });
  await writeFile(path.join(out, "surfaces.webm"), new Uint8Array(movie.bytes)); delete movie.bytes;
  assert.equal(movie.frames, 3); assert.deepEqual(movie.decoded, [movie.width, movie.height]);
  movie.samples.forEach((sample, index) => { assert.deepEqual(sample.times, [index,index]); assert.equal(sample.meshes, 5); assert.equal(sample.contours, 2); assert.ok(sample.color > 100 && sample.white > 100, JSON.stringify(sample)); });
  assert.ok(await page.evaluate(() => graphUI.results().every(g => g.timeIndex === 1)));
  await writeFile(path.join(out, "movie.json"), JSON.stringify(movie, null, 2));
  pass("Real moview encodes and decodes WebM with refreshed area/slice surfaces and the selected contour in every frame and restores time");
  await page.setViewportSize({ width: 1440, height: 900 }); await open(); const panel = await graphs.boundingBox();
  assert.ok(panel.x >= 0 && panel.x + panel.width <= 1440 && panel.y + panel.height <= 900);
  for (const recordIndex of [0,1]) for (const direction of [0,1,2]) {
    await graphs.getByRole("button", { name: "Добавить", exact: true }).click();
    await add.getByRole("combobox", { name: "Элемент для среза", exact: true }).selectOption(String(recordIndex));
    await add.getByRole("menuitem", { name: planeName(direction+1), exact: true }).click(); await waitGraphs();
  }
  const scroll = graphs.locator(".source-slice-scroll");
  assert.ok(await scroll.evaluate(element => element.scrollHeight > element.clientHeight));
  await scroll.hover(); await page.mouse.wheel(0, 300); await page.waitForFunction(() => document.querySelector(".source-slice-scroll").scrollTop > 0);
  const textColor = await graphs.locator("tbody td").first().evaluate(element => getComputedStyle(element).color);
  assert.equal(textColor, "rgb(237, 242, 247)");
  await page.screenshot({ path: path.join(out, "panel.png"), fullPage: true });
  pass("The graph panel fits 1440px and the slice table has its own vertical scroll");
  await closeMenus();
  await size.evaluate(el=>{el.value="0.5";el.dispatchEvent(new Event("input",{bubbles:true}));});
  await page.getByRole("button", { name: "Общие опции отображения", exact: true }).click();
  await page.getByRole("combobox", { name: "Палитра результатов", exact: true }).selectOption("Turbo");
  await expandProfile(1); const persistedDialog=page.getByRole("dialog",{name:"1D график №1",exact:true});
  await page.waitForFunction(()=>profileChart.chart()?.data.datasets.length===3);
  const persistedBox=await persistedDialog.locator("canvas").boundingBox(), persistedLegend=await page.evaluate(()=>profileChart.legend()[2]);
  await page.mouse.click(persistedBox.x+(persistedLegend.left+persistedLegend.right)/2,persistedBox.y+(persistedLegend.top+persistedLegend.bottom)/2);
  await persistedDialog.getByRole("button",{name:"Авто",exact:true}).click();
  await page.waitForFunction(()=>graphFixture.saved()?.settings.expandedProfile===1 && graphFixture.saved()?.settings.profiles.find(p=>p.id===1)?.view?.hidden.includes("Z"));
  const savedSettings=await page.evaluate(()=>graphFixture.saved().settings);
  await page.reload(); await page.waitForFunction(()=>window.graphUI?.ready() && window.graphScene?.ready() && !graphUI.busy());
  await persistedDialog.waitFor(); await page.waitForFunction(()=>profileChart.chart()?.data.datasets.length===3);
  assert.equal(await page.evaluate(()=>graphUI.profiles().length),savedSettings.profiles.length);
  assert.deepEqual(await page.evaluate(()=>graphUI.slices()),savedSettings.slices);
  assert.equal(await page.evaluate(()=>profileChart.chart().isDatasetVisible(2)),false);
  assert.equal(await page.evaluate(()=>profileChart.view().auto),false);
  assert.equal(await size.inputValue(),"0.5");
  await page.screenshot({path:path.join(out,"restored-profile.png"),fullPage:true});
  await persistedDialog.getByRole("button",{name:"Свернуть",exact:true}).click();
  await page.getByRole("button", { name: "Общие опции отображения", exact: true }).click();
  assert.equal(await page.getByRole("combobox", { name: "Палитра результатов", exact: true }).inputValue(),"Turbo");
  const storedIds=await page.evaluate(()=>graphUI.profiles().map(p=>p.id));
  for(const id of storedIds) await page.getByRole("button",{name:`Удалить 1D график №${id}`,exact:true}).click();
  await page.waitForFunction(()=>graphUI.profiles().length===0 && graphScene.snapshot().contours.length===0 && graphFixture.saved()?.settings.profiles.length===0);
  assert.equal(await collection.count(),0); assert.equal(await page.evaluate(()=>graphUI.slices().length),savedSettings.slices.length);
  pass("Full page reload restores task-owned slices, collection, size, palette, expanded state, hidden components and manual axes; deleting thumbnails clears only 1D sections and saves automatically");

  await page.evaluate(()=>{
    graphFixture.buffers.JE[0].fill(0,3,6); graphFixture.buffers.JE[0].fill(0,15,18);
    graphFixture.setTime(0);graphFixture.showWorking(true);
  });
  await page.getByRole("tab",{name:"J(E)",exact:true}).click();
  await page.waitForFunction(()=>workingPointUI.count()>0);
  const linear = await page.evaluate(()=>({count:workingPointUI.count(),points:workingPointUI.series().flatMap(s=>s.points).map(p=>({x:p.x,y:p.y}))}));
  const logarithmic=page.getByRole("checkbox",{name:"логарифмическая",exact:true});
  assert.equal(await logarithmic.isChecked(),false);
  assert.equal(await page.getByRole("checkbox",{name:/^log\([EJ]\)$/}).count(),0);
  await logarithmic.check();await page.waitForFunction(()=>workingPointUI.log());
  const logarithms=await page.evaluate(()=>({count:workingPointUI.count(),omitted:workingPointUI.omitted(),points:workingPointUI.series().flatMap(s=>s.points).map(p=>({x:p.x,y:p.y}))}));
  assert.equal(logarithms.omitted,2);assert.equal(logarithms.count,linear.count-2);
  const positive=linear.points.filter(p=>p.x>0&&p.y>0);assert.equal(positive.length,logarithms.points.length);
  positive.forEach((p,i)=>{assert.ok(Math.abs(Math.log10(p.x)-logarithms.points[i].x)<1e-10);assert.ok(Math.abs(Math.log10(p.y)-logarithms.points[i].y)<1e-10);});
  await page.screenshot({path:path.join(out,"working-point-log.png"),fullPage:true});
  await page.evaluate(()=>graphFixture.setBusy(true));assert.equal(await logarithmic.isDisabled(),true);await page.evaluate(()=>graphFixture.setBusy(false));
  await page.getByRole("tab",{name:"M(H)",exact:true}).click();assert.equal(await page.getByRole("checkbox",{name:"логарифмическая",exact:true}).count(),0);
  await page.getByRole("tab",{name:"J(E)",exact:true}).click();assert.equal(await logarithmic.isChecked(),true);
  await logarithmic.uncheck();await page.waitForFunction(()=>!workingPointUI.log());assert.equal(await page.evaluate(()=>workingPointUI.count()),linear.count);
  pass("One logarithmic checkbox transforms both data and material curves, omits either zero coordinate, persists across M/J and is locked during recording");
  assert.deepEqual(errors, []); await writeFile(path.join(out, "browser.json"), JSON.stringify({ checks, errors }, null, 2)); console.log("BROWSER_OK " + checks.length);
} catch (error) {
  await page?.screenshot({ path: path.join(out, "failure.png"), fullPage: true }).catch(() => {});
  const state = await page?.evaluate(() => ({ slices: graphUI.slices(), error: graphUI.error(), scene: graphScene.snapshot() })).catch(() => null);
  await writeFile(path.join(out, "browser.json"), JSON.stringify({ checks, errors, state, error: error.stack }, null, 2)); console.error(error); process.exitCode = 1;
} finally { await browser?.close(); await server?.close(); await rm(dir, { recursive: true, force: true }); }
