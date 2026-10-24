import { listTaskGifs, readTaskGif, saveTaskGif } from "../taskGifService.js";
import { createMovieWebmEncoder } from "./movieWebmEncoder.js";

export async function convertTaskGifs(taskHandle, { signal, onProgress = () => {},
  createEncoder = createMovieWebmEncoder, list = listTaskGifs, read = readTaskGif, save = saveTaskGif } = {}) {
  // Keep the permission request in the Start click's transient activation.
  const permission = taskHandle?.requestPermission?.({ mode: "readwrite" });
  signal?.throwIfAborted();
  if (await permission !== "granted") throw new Error("Не предоставлено разрешение на запись в каталог задания");
  signal?.throwIfAborted();
  const entries = (await list(taskHandle, { signal })).filter(entry => /\.gif$/i.test(entry.name));
  const saved = [];
  for (const [index, entry] of entries.entries()) {
    signal?.throwIfAborted();
    const progress = extra => onProgress({ completed: saved.length, total: entries.length, name: entry.name, saved: [...saved], ...extra });
    progress({ phase: "reading" });
    const blob = await read(entry.handle, { signal });
    const buffer = await blob.arrayBuffer(); signal?.throwIfAborted();
    const encoder = createEncoder(), cancel = () => encoder.close();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const movie = await encoder.convertGif(buffer, frame => progress({ phase: "encoding", frame }));
      signal?.throwIfAborted(); progress({ phase: "saving" });
      const result = await save(taskHandle, movie.blob, entry.name.replace(/\.gif$/i, ".webm"), { signal });
      saved.push({ source: entry.name, name: result.name });
      progress({ phase: "saved", completed: index + 1 });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`${entry.name}: ${error.message ?? error}`);
    } finally { signal?.removeEventListener("abort", cancel); encoder.close(); }
  }
  return saved;
}
