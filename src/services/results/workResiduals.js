import { ResultService } from "../resultService.js";
import { QUANTITIES } from "./resultMappings.js";
import { readObjectFrames } from "./resultRequests.js";

// Work files may be replaced after the task was loaded. Acquire a new File and
// a separate short-lived HDF5 reader for every request, including repeated clicks.
// The ordinary task reader and its time-series File snapshots remain untouched.
export async function readWorkResidualFrames(request, { readerFactory = () => new ResultService() } = {}) {
  const quantity = QUANTITIES[request.quantityKey];
  if (!quantity?.workResidual) throw new Error("Неизвестная невязка");
  const name = `${quantity.file}.h5`;
  let file;
  try {
    const output = await request.task.handle.getDirectoryHandle("output3XX");
    file = await (await output.getFileHandle(name)).getFile();
  } catch (error) {
    if (error.name === "NotFoundError") throw new Error(`${name} отсутствует. Запросите запись невязки в Editor.`);
    throw error;
  }
  const reader = readerFactory();
  try {
    const metadata = await reader.open({ [quantity.file]: file });
    const task = { ...request.task, reader, metadata };
    // 000000 is the single snapshot, independent of the Viewer time slider.
    return await readObjectFrames({ ...request, task, time: 0 });
  } finally { reader.close(); }
}
