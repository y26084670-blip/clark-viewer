export function createMovieWebmEncoder({ workerFactory = () => new Worker(
  new URL("../../workers/movieWebm.worker.js", import.meta.url), { type: "module" }),
  runtimeUrl = new URL(`${import.meta.env.BASE_URL}vendor/libav/libav-6.10.9.0-webm-vp9.mjs`, window.location.href).href,
} = {}) {
  let worker, pending, sequence = 0, closed = false;
  function release() { worker?.terminate(); worker = null; }
  function fail(error) { closed = true; const job = pending; pending = null; release(); job?.reject(error); }
  function send(type, body, transfer = [], onProgress) {
    if (closed) return Promise.reject(new Error("Кодировщик WebM закрыт"));
    if (pending) return Promise.reject(new Error("Предыдущий кадр WebM ещё обрабатывается"));
    return new Promise((resolve, reject) => {
      pending = { id: ++sequence, resolve, reject, onProgress };
      try {
        if (!worker) {
          worker = workerFactory();
          worker.onmessage = ({ data }) => {
            if (closed || data.id !== pending?.id) return;
            if (data.progress) { pending.onProgress?.(data.progress); return; }
            if (data.error) { fail(new Error(data.error)); return; }
            const job = pending; pending = null;
            if (data.bytes) {
              closed = true; release(); job.resolve({ ...data.result, blob: new Blob([data.bytes], { type: "video/webm" }) });
            } else job.resolve(data.result);
          };
          worker.onerror = event => fail(new Error(event.message || "Ошибка кодирования WebM"));
          worker.onmessageerror = () => fail(new Error("Ошибка передачи кадра WebM"));
        }
        worker.postMessage({ id: pending.id, type, runtimeUrl, ...body }, transfer);
      } catch (error) { fail(error); }
    });
  }
  return {
    addFrame(frame, { delayMs } = {}) {
      const data = frame.data.byteOffset === 0 && frame.data.byteLength === frame.data.buffer.byteLength ? frame.data : frame.data.slice();
      return send("frame", { frame: { width: frame.width, height: frame.height, data }, delayMs }, [data.buffer]);
    },
    async finish() { return (await send("finish", {})).blob; },
    convertGif(buffer, onProgress) { return send("gif", { buffer }, [buffer], onProgress); },
    close() { fail(Object.assign(new Error("Кодирование WebM отменено"), { name: "AbortError" })); },
  };
}
