import { ResultVolumeLimitError } from "../visualization/resultVolumeField.js";

/** One worker and at most one in-flight interpolation. Frame coalescing stays in
 * resultFrameController. Input grid buffers are consumed; scene/picking points
 * and the original HDF5 frame are retained on the main thread.
 */
export function createResultVolumeProcessor({ workerFactory = () => new Worker(
  new URL("../../workers/resultVolume.worker.js", import.meta.url), { type: "module" }) } = {}) {
  let worker = null, pending = null, sequence = 0, closed = false;
  function release() {
    if (!worker) return;
    worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
    worker.terminate(); worker = null;
  }
  function fail(error) {
    const job = pending; pending = null;
    release(); job?.reject(error);
  }
  function open() {
    worker = workerFactory();
    worker.onmessage = ({ data }) => {
      if (!pending || pending.id !== data.id || closed) return;
      const job = pending; pending = null;
      if (data.error) {
        const error = data.limit ? new ResultVolumeLimitError(data.error) : new Error(data.error);
        job.reject(error); return;
      }
      const fields = data.result;
      for (const field of fields.domains) {
        const original = job.domains.get(field.key);
        field.points = original?.points ?? [];
        field.source = original?.source; field.instance = original?.instance;
      }
      fields.fallbackPoints = [];
      for (const key of fields.fallbackDomainKeys) for (const point of job.domains.get(key)?.points ?? []) fields.fallbackPoints.push(point);
      job.resolve(fields);
    };
    worker.onerror = event => fail(new Error(event.message || "Ошибка модуля объёмной интерполяции"));
    worker.onmessageerror = () => fail(new Error("Не удалось передать объёмную карту из рабочего потока"));
  }
  return {
    process(domains) {
      if (closed) return Promise.reject(new Error("Модуль объёмной интерполяции закрыт"));
      if (pending) return Promise.reject(new Error("Предыдущая объёмная интерполяция ещё выполняется"));
      return new Promise((resolve, reject) => {
        try {
          if (!worker) open();
          const id = ++sequence;
          pending = { id, resolve, reject, domains: new Map(domains.map(domain => [domain.key, domain])) };
          const grids = domains.map(({ key, dimensions, positions, values, support, supportExpected, supportLabel, coordinateBytes }) =>
            ({ key, dimensions, positions, values, support, supportExpected, supportLabel, coordinateBytes }));
          const transfer = [...new Set(grids.flatMap(grid => [grid.positions.buffer, grid.values.buffer]))];
          worker.postMessage({ id, domains: grids }, transfer);
        } catch (error) {
          if (pending) fail(error);
          else { release(); reject(error); }
        }
      });
    },
    close() {
      closed = true;
      const error = new Error("Объёмная интерполяция отменена: вкладка закрыта");
      error.name = "AbortError";
      fail(error);
    },
  };
}
