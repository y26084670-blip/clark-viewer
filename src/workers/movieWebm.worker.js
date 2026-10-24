import { createMovieWebmCore } from "../services/movie/movieWebmCore.js";

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
    } else if (type === "finish") {
      const bytes = await core.finish(); self.postMessage({ id, bytes }, [bytes.buffer]);
    } else throw new Error("Неизвестная команда кодировщика WebM");
  } catch (error) { self.postMessage({ id, error: error.message ?? String(error) }); }
};
