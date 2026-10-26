export function createResultGraphProcessor({ workerFactory = () => new Worker(
  new URL("../../workers/resultGraph.worker.js", import.meta.url), { type: "module" }) } = {}) {
  let worker, pending, sequence = 0, closed = false;
  const abort = () => Object.assign(new Error("Построение графиков отменено."), { name: "AbortError" });
  function release(error) {
    if (worker) { worker.onmessage = worker.onerror = worker.onmessageerror = null; worker.terminate(); worker = null; }
    const job = pending; pending = null; job?.reject(error);
  }
  return {
    process(input) {
      if (closed) return Promise.reject(abort());
      if (pending) return Promise.reject(new Error("Предыдущее построение ещё не завершено."));
      return new Promise((resolve, reject) => {
        try {
          if (!worker) {
            worker = workerFactory();
            worker.onmessage = ({ data }) => {
              if (!pending || data.id !== pending.id) return;
              const job = pending; pending = null;
              if (data.error) job.reject(new Error(data.error)); else job.resolve(data.result);
            };
            worker.onerror = event => release(new Error(event.message || "Ошибка построения графиков."));
            worker.onmessageerror = () => release(new Error("Ошибка передачи графиков."));
          }
          const id = ++sequence; pending = { id, resolve, reject };
          worker.postMessage({ id, input }, input.domains.flatMap(d => [d.positions.buffer, d.vectors.buffer, d.invalid.buffer]));
        } catch (error) { release(error); reject(error); }
      });
    },
    close() { closed = true; release(abort()); },
  };
}
