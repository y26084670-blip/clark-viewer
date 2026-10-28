import { listTaskGifs, readTaskGif } from "../taskGifService.js";
import { PROTOCOL_MAX_BYTES, PROTOCOL_SIZE_ERROR } from "./protocolDocument.js";

// Multiples of three keep intermediate base64 chunks free of padding.
async function webmDataUrl(blob, signal) {
  const parts = ["data:video/webm;base64,"];
  for (let offset = 0; offset < blob.size; offset += 3 * 1024 * 1024) {
    signal?.throwIfAborted();
    const bytes = new Uint8Array(await blob.slice(offset, offset + 3 * 1024 * 1024).arrayBuffer());
    signal?.throwIfAborted();
    for (let start = 0; start < bytes.length; start += 24576) {
      parts.push(btoa(String.fromCharCode(...bytes.subarray(start, start + 24576))));
    }
  }
  return parts.join("");
}

export async function readProtocolVideos(task, availableBytes, { signal } = {}) {
  const entries = (await listTaskGifs(task.handle, { signal })).filter(entry => /\.webm$/i.test(entry.name));
  const files = [];
  let estimated = 0;
  // Validate the entire selection and its size before converting large files.
  for (const entry of entries) {
    signal?.throwIfAborted();
    try {
      const blob = await readTaskGif(entry.handle, { signal });
      estimated += Math.ceil(blob.size / 3) * 4 + 4096;
      if (estimated > Math.min(availableBytes, PROTOCOL_MAX_BYTES)) throw new Error(PROTOCOL_SIZE_ERROR);
      files.push({ name: entry.name, blob });
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`Не удалось включить WebM «${entry.name}»: ${error.message ?? error}`);
    }
  }
  const blocks = [];
  for (const file of files) {
    signal?.throwIfAborted();
    try {
      blocks.push({ id: crypto.randomUUID(), kind: "video", filename: file.name,
        title: `Анимация · ${file.name}`, comment: "",
        dataUrl: await webmDataUrl(file.blob, signal) });
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`Не удалось включить WebM «${file.name}»: ${error.message ?? error}`);
    }
  }
  signal?.throwIfAborted();
  return blocks;
}
