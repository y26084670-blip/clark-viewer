import { createMovieGifSession } from "../services/movie/movieGifCore.js";

let session = null;
self.onmessage = ({ data }) => {
  try {
    if (!session) session = createMovieGifSession();
    if (data.type === "frame") {
      const result = session.addFrame(data.frame, { delayMs: data.delayMs, repeat: data.repeat });
      self.postMessage({ id: data.id, result });
    } else if (data.type === "finish") {
      const bytes = session.finish(); session = null;
      self.postMessage({ id: data.id, bytes }, [bytes.buffer]);
    } else throw new Error("Неизвестная операция записи GIF");
  } catch (error) {
    session = null;
    self.postMessage({ id: data.id, error: error.message ?? String(error) });
  }
};
