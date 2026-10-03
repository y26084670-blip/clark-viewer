import { validateMovieFrame } from "./movieFrame.js";

export function createMovieGifEncoder({ workerFactory = () => new Worker(
  new URL("../../workers/movieGif.worker.js", import.meta.url), { type: "module" }) } = {}) {
  let worker = null, pending = null, sequence = 0, closed = false;
  function release() {
    if (!worker) return;
    worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
    worker.terminate(); worker = null;
  }
  function fail(error) {
    closed = true;
    const job = pending; pending = null;
    release(); job?.reject(error);
  }
  function open() {
    worker = workerFactory();
    worker.onmessage = ({ data }) => {
      if (!pending || pending.id !== data.id || closed) return;
      if (data.error) { fail(new Error(data.error)); return; }
      const job = pending; pending = null;
      if (job.type === "finish") {
        closed = true;
        release();
        job.resolve(new Blob([data.bytes], { type: "image/gif" }));
      } else job.resolve(data.result);
    };
    worker.onerror = event => fail(new Error(event.message || "Ошибка кодирования GIF"));
    worker.onmessageerror = () => fail(new Error("Не удалось получить кадр из модуля записи GIF"));
  }
  function send(type, body = {}, transfer = []) {
    if (closed) return Promise.reject(new Error("Модуль записи GIF закрыт"));
    if (pending) return Promise.reject(new Error("Предыдущий кадр GIF ещё обрабатывается"));
    return new Promise((resolve, reject) => {
      try {
        if (!worker) open();
        const id = ++sequence;
        pending = { id, type, resolve, reject };
        worker.postMessage({ id, type, ...body }, transfer);
      } catch (error) {
        if (pending) fail(error);
        else { closed = true; release(); reject(error); }
      }
    });
  }
  return {
    addFrame(frame, { delayMs } = {}) {
      try {
        validateMovieFrame(frame, delayMs);
        const data = frame.data.byteOffset === 0 && frame.data.byteLength === frame.data.buffer.byteLength
          ? frame.data : frame.data.slice();
        return send("frame", { frame: { width: frame.width, height: frame.height, data }, delayMs }, [data.buffer]);
      } catch (error) { return Promise.reject(error); }
    },
    finish() { return send("finish"); },
    close() {
      const error = new Error("Запись фильма отменена"); error.name = "AbortError";
      fail(error);
    },
  };
}
