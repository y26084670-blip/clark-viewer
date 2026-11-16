import { installTrafficTracking } from "../services/trafficService.js";
import h5wasm from "h5wasm";
import { compareResultFilePairs } from "../services/taskResultsComparisonService.js";

installTrafficTracking("viewer");

self.onmessage = async ({ data }) => {
  const mounted = [];
  let fileSystem;
  try {
    const { FS } = await h5wasm.ready;
    fileSystem = FS;
    for (const [index, files] of [data.first, data.second].entries()) {
      const path = `/comparison-${index}`;
      FS.mkdirTree(path);
      FS.mount(FS.filesystems.WORKERFS, { blobs: files.filter(file => file.file).map(file => ({ name: file.name, data: file.file })) }, path);
      mounted.push(path);
    }
    const lines = compareResultFilePairs(data.first, data.second,
      (index, file) => new h5wasm.File(`/comparison-${index}/${file.name}`, "r"),
      message => self.postMessage({ type: "progress", message }));
    self.postMessage({ type: "complete", lines });
  } catch (error) { self.postMessage({ type: "error", message: error.message }); }
  finally {
    for (const path of mounted) fileSystem.unmount(path);
  }
};
