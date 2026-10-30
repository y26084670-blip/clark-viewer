import h5wasm from "h5wasm";
import { Hdf5ResultFile } from "../services/results/hdf5ResultFile.js";
import { loadTaskInput } from "../services/taskLoadService.js";
import { createTextProtocols, deleteTextProtocols, TEXT_PROTOCOL_FAMILIES } from "../services/taskTextProtocols.js";

let running = false, cancelled = false;
self.onmessage = async ({ data }) => {
  if (data.action === "cancel") { cancelled = true; return; }
  if (running) return;
  running = true;
  const files = new Map();
  let fs, mounted = false;
  const check = () => { if (cancelled) throw new DOMException("Операция с протоколами отменена", "AbortError"); };
  const onProgress = (message, extra = {}) => self.postMessage({ progress: message, ...extra });
  try {
    let result;
    if (data.action === "delete") result = await deleteTextProtocols(data.handle, { check, onProgress });
    else if (data.action === "create") {
      const handle = data.handle, task = { ...await loadTaskInput(handle), handle };
      const output = await handle.getDirectoryHandle("output3XX"), blobs = [];
      for (const name of TEXT_PROTOCOL_FAMILIES) {
        check();
        try { blobs.push({ name: `${name}.h5`, data: await (await output.getFileHandle(`${name}.h5`)).getFile() }); }
        catch (error) { if (error.name !== "NotFoundError") throw error; }
      }
      check(); onProgress("Чтение результатов…");
      fs = (await h5wasm.ready).FS;
      fs.mkdirTree("/protocols");
      fs.mount(fs.filesystems.WORKERFS, { blobs }, "/protocols"); mounted = true;
      const metadata = {};
      for (const blob of blobs) {
        const name = blob.name.slice(0, -3);
        const h5 = new h5wasm.File(`/protocols/${blob.name}`, "r");
        try { const file = new Hdf5ResultFile(name, h5); files.set(name, file); metadata[name] = file.metadata; }
        catch (error) { h5.close(); throw error; }
      }
      result = await createTextProtocols(task, metadata, { read: request => files.get(request.name).read(request) }, output, { check, onProgress });
    } else throw new Error("Неизвестная команда протоколов");
    self.postMessage({ result });
  } catch (error) { self.postMessage({ error: error.message, cancelled: error.name === "AbortError" }); }
  finally { for (const file of files.values()) file.close(); if (mounted) fs.unmount("/protocols"); running = false; }
};
