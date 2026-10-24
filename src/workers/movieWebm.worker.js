import { createMovieWebmCore } from "../services/movie/movieWebmCore.js";
import { createTaskGifDecoder } from "../services/taskGifDecoder.js";

let core, libav;
self.onmessage = async ({ data: message }) => {
  const { id, type } = message;
  try {
    if (!core) {
      const { default: LibAV } = await import(/* @vite-ignore */ message.runtimeUrl);
      libav = await LibAV.LibAV({ noworker: true, nothreads: true });
      core = createMovieWebmCore(libav);
    }
    if (type === "frame") {
      const result = await core.addFrame(message.frame, { delayMs: message.delayMs });
      self.postMessage({ id, result });
    } else if (type === "gif") {
      const decoder = createTaskGifDecoder(message.buffer);
      let info;
      do {
        const frame = decoder.next();
        info = await core.addFrame({ width: frame.width, height: frame.height, data: frame.pixels }, { delayMs: frame.delay });
        self.postMessage({ id, progress: { completed: frame.index + 1, total: frame.count } });
        if (frame.index + 1 === frame.count) break;
      } while (true);
      const bytes = await core.finish();
      self.postMessage({ id, bytes, result: info }, [bytes.buffer]);
    } else if (type === "finish") {
      const bytes = await core.finish(); self.postMessage({ id, bytes }, [bytes.buffer]);
    } else throw new Error("Неизвестная команда кодировщика WebM");
  } catch (error) { self.postMessage({ id, error: error.message ?? String(error) }); }
};
