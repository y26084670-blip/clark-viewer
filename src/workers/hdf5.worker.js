import h5wasm from "h5wasm";
import { Hdf5ResultFile } from "../services/results/hdf5ResultFile.js";

const files = new Map();
let mounted = false;
let queue = Promise.resolve();

async function openFiles(blobs) {
  const { FS } = await h5wasm.ready;
  for (const file of files.values()) file.close();
  files.clear();
  if (mounted) FS.unmount("/task");
  mounted = false;
  FS.mkdirTree("/task");
  FS.mount(FS.filesystems.WORKERFS, { blobs: Object.entries(blobs).map(([name, data]) => ({ name: `${name}.h5`, data })) }, "/task");
  mounted = true;
  const metadata = {};
  for (const name of Object.keys(blobs)) {
    let handle;
    try {
      handle = new h5wasm.File(`/task/${name}.h5`, "r");
      const file = new Hdf5ResultFile(name, handle);
      files.set(name, file); metadata[name] = file.metadata;
    } catch (error) { handle?.close(); metadata[name] = { error: `${name}.h5: ${error.message}` }; }
  }
  return metadata;
}

self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    let result;
    if (data.action === "open") result = await openFiles(data.files);
    else {
      const file = files.get(data.name);
      if (!file) throw new Error(`Файл ${data.name}.h5 недоступен`);
      if (data.action === "read") result = file.read(data);
      else if (data.action === "history") result = file.history(data);
      else throw new Error("Неизвестная операция чтения");
    }
    self.postMessage({ id: data.id, result }, result?.values ? [result.values.buffer] : []);
  }).catch(error => self.postMessage({ id: data.id, error: error.message ?? String(error) }));
};
