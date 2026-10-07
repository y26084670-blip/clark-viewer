import h5wasm from "h5wasm";
import { Hdf5ResultFile } from "./hdf5ResultFile.js";
import { appendResultRanges } from "./resultRangeBackfillCore.js";

const queue = [];
let running = false;

async function backfill(data) {
  const { FS } = await h5wasm.ready;
  FS.mkdirTree("/range-backfill");
  const path = `/range-backfill/${data.plan.name}-${data.id}.h5`;
  let writable = null;
  try {
    const source = await data.fileHandle.getFile();
    const bytes = new Uint8Array(await source.arrayBuffer());
    FS.writeFile(path, bytes);
    let handle = new h5wasm.File(path, "a");
    const result = appendResultRanges(handle, data.plan, progress => self.postMessage({ id: data.id, progress }));
    handle.close(); handle = null;
    const checkHandle = new h5wasm.File(path, "r");
    const check = new Hdf5ResultFile(data.plan.name, checkHandle);
    const ranges = check.metadata.ranges;
    if (!ranges.available || ranges.state !== "complete" || ranges.runId !== data.plan.runId) {
      check.close();
      throw new Error(`${data.plan.name}.h5: созданные диапазоны не прошли повторную проверку`);
    }
    check.close();
    const output = FS.readFile(path);
    writable = await data.fileHandle.createWritable({ keepExistingData: false });
    await writable.write(output);
    await writable.close(); writable = null;
    return result;
  } catch (error) {
    try { await writable?.abort?.(); } catch {}
    throw error;
  } finally {
    try { FS.unlink(path); } catch {}
  }
}

async function drain() {
  if (running) return;
  running = true;
  while (queue.length) {
    const data = queue.shift();
    try {
      if (data.action !== "backfill") throw new Error("Неизвестная операция дозаписи диапазонов");
      const result = await backfill(data);
      self.postMessage({ id: data.id, result });
    } catch (error) {
      self.postMessage({ id: data.id, error: error.message ?? String(error) });
    }
  }
  running = false;
}
self.onmessage = event => { queue.push(event.data); void drain(); };
