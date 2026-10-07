import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer } from "vite";
import solid from "vite-plugin-solid";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = path.join(root, "__range_backfill_acceptance__");
await mkdir(fixture, { recursive: true });
await writeFile(path.join(fixture, "index.html"), '<!doctype html><html><body><script type="module" src="./fixture.js"></script></body></html>');
await writeFile(path.join(fixture, "fixture.js"), `
import h5wasm from "h5wasm";
import { Hdf5ResultFile } from "/src/services/results/hdf5ResultFile.js";

async function oldBytes() {
  const { FS } = await h5wasm.ready;
  const path = "/acceptance-old-MH.h5";
  try { FS.unlink(path); } catch {}
  let h = new h5wasm.File(path, "w");
  const header = h.create_group("HEADER");
  for (const [name,value] of Object.entries({columns:3,arrCount:2,hasCoo:1}))
    header.create_dataset({name,data:new BigInt64Array([BigInt(value)]),shape:[]});
  header.create_dataset({name:"inds1",data:new BigInt64Array([1n])});
  header.create_dataset({name:"numbs",data:new BigInt64Array([2n])});
  for (let step=0; step<2; step++) {
    const b=step+1;
    h.create_dataset({name:String(step).padStart(6,"0"),shape:[2,9],
      data:new Float64Array([0,0,0,b,0,0, 0,b,0, 1,0,0,2*b,0,0, 0,2*b,0])});
  }
  h.close();
  const out = FS.readFile(path).slice();
  FS.unlink(path);
  return out;
}
async function verifyBytes(bytes) {
  const { FS } = await h5wasm.ready;
  const path="/acceptance-verify-MH.h5";
  try { FS.unlink(path); } catch {}
  FS.writeFile(path,bytes);
  const handle=new h5wasm.File(path,"r");
  const reader=new Hdf5ResultFile("MH",handle);
  const result={ranges:reader.metadata.ranges, frame:Array.from(reader.read({step:1,start:0,count:2}).values)};
  reader.close(); FS.unlink(path); return result;
}
window.__acceptance = (async () => {
  const root=await navigator.storage.getDirectory();
  const fileHandle=await root.getFileHandle("range-backfill-MH.h5",{create:true});
  let writable=await fileHandle.createWritable();
  await writable.write(await oldBytes()); await writable.close();
  const worker=new Worker(new URL("/src/services/results/resultRangeBackfill.worker.js", import.meta.url),{type:"module"});
  const messages=[];
  const result=await new Promise((resolve,reject)=>{
    worker.onmessage=e=>{messages.push(e.data); if(e.data.error)reject(new Error(e.data.error)); else if(e.data.result)resolve(e.data.result);};
    worker.onerror=e=>reject(new Error(e.message));
    worker.postMessage({id:"acceptance",action:"backfill",fileHandle,plan:{
      name:"MH",objectIds:[1],applicability:Array(9).fill(true),objectKind:"elements",
      timeStep:.25,lastStep:1,runId:"browser-backfill"
    }});
  });
  worker.terminate();
  const updated=await fileHandle.getFile();
  const verified=await verifyBytes(new Uint8Array(await updated.arrayBuffer()));
  await root.removeEntry("range-backfill-MH.h5");
  return {result,messages,verified};
})().catch(error => ({error:error.stack||String(error)}));
`);
let server, browser;
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  server = await createServer({ configFile:false, root, plugins:[solid()], server:{host:"127.0.0.1",port:0} });
  await server.listen();
  browser = await chromium.launch({ headless:true });
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__range_backfill_acceptance__/index.html`);
  await page.waitForFunction(() => window.__acceptance !== undefined);
  const result=await page.evaluate(() => window.__acceptance);
  if(result.error) throw new Error(result.error);
  assert.deepEqual(result.result,{steps:2,objects:1,channels:9});
  assert.equal(result.verified.ranges.available,true);
  assert.equal(result.verified.ranges.state,"complete");
  assert.equal(result.verified.ranges.runId,"browser-backfill");
  assert.deepEqual(result.verified.ranges.stepIds,[0,1]);
  assert.equal(result.verified.frame[3],2);
  assert.ok(result.messages.some(message => message.progress?.phase === "scan"));
  console.log("BROWSER_RANGE_BACKFILL_OK");
} finally {
  await browser?.close(); await server?.close(); await rm(fixture,{recursive:true,force:true});
}
