import { movieAbortError } from "./movieWait.js";
import { MOVIE_LIMITS } from "./movieFrame.js";
import { movieFilename } from "./movieFilename.js";

// Keep the controller's public option names while the encoder and capture
// compositor share a single source for the actual resource/playback limits.
export const MOVIE_EXPORT_LIMITS = Object.freeze({ frames: MOVIE_LIMITS.frames,
  width: MOVIE_LIMITS.width, height: MOVIE_LIMITS.height, outputBytes: MOVIE_LIMITS.bytes,
  minIntervalMs: MOVIE_LIMITS.minDelayMs, maxIntervalMs: MOVIE_LIMITS.maxDelayMs,
  intervalStepMs: MOVIE_LIMITS.delayStepMs });

function checkedContext(adapter, intervalMs, limits) {
  const context = adapter.getContext();
  if (!context?.task) throw new Error("Задание для moview не загружено");
  if (!Number.isSafeInteger(context.frameCount) || context.frameCount < 1 || context.frameCount > limits.frames) {
    throw new Error(`Для moview допустимо от 1 до ${limits.frames} кадров`);
  }
  if (!Number.isSafeInteger(context.originalTime) || context.originalTime < 0 || context.originalTime >= context.frameCount) {
    throw new Error("Некорректный исходный момент времени для moview");
  }
  if (!Number.isFinite(context.timeStep) || context.timeStep < 0
      || !Number.isFinite((context.frameCount - 1) * context.timeStep)) throw new Error("Некорректная шкала времени для moview");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < limits.minIntervalMs || intervalMs > limits.maxIntervalMs || intervalMs % limits.intervalStepMs !== 0) {
    throw new Error(`Интервал GIF должен быть от ${limits.minIntervalMs} до ${limits.maxIntervalMs} мс с шагом ${limits.intervalStepMs} мс`);
  }
  return { ...context };
}

function checkedPixels(image, size, limits) {
  const { width, height, data } = image ?? {};
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
      || width > limits.width || height > limits.height) throw new Error(`Размер кадра moview должен укладываться в ${limits.width}×${limits.height}`);
  if (!(data instanceof Uint8ClampedArray || data instanceof Uint8Array) || data.length !== width * height * 4) {
    throw new Error("Неполные пиксельные данные кадра moview");
  }
  if (size && (width !== size.width || height !== size.height)) throw new Error("Размер кадра изменился во время создания moview");
  return { width, height };
}

export function movieFrameCaption(context, index) {
  const time = Number((index * context.timeStep).toPrecision(9));
  return `${context.title || "E3D Viewer"} · шаг ${index} · t = ${time} с`;
}

function abortable(operation, signal) {
  if (signal.aborted) return Promise.reject(movieAbortError(signal.reason));
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(movieAbortError(signal.reason)); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(movieAbortError(signal.reason)); else resolve(value);
    }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

/** Sequential deterministic capture; the adapter owns reactive data/render
 * readiness and view restoration. Only one RGBA image is handed to the encoder
 * at a time. Frame interval controls playback, never the readiness of a frame.
 */
export function createMovieExportController({ createEncoder, limits: overrides = {}, onAdapterChange = () => {} }) {
  const limits = { ...MOVIE_EXPORT_LIMITS, ...overrides };
  let currentAdapter = null, running = null, disposed = false;
  const cancel = (reason = "Создание moview отменено") => running?.abort.abort(reason);
  return {
    register(adapter) {
      if (disposed) throw new Error("Создание moview недоступно после закрытия приложения");
      if (currentAdapter !== adapter && running) cancel("Вкладка просмотра изменилась");
      currentAdapter = adapter; onAdapterChange(adapter);
      return () => {
        if (running?.adapter === adapter) cancel("Вкладка просмотра закрыта");
        if (currentAdapter === adapter) { currentAdapter = null; onAdapterChange(null); }
      };
    },
    async run({ intervalMs, onProgress = () => {}, signal } = {}) {
      if (disposed) throw new Error("Создание moview недоступно после закрытия приложения");
      if (running) throw new Error("Создание moview уже выполняется");
      if (!currentAdapter) throw new Error("Для текущей вкладки создание moview недоступно");
      if (signal?.aborted) throw movieAbortError(signal.reason);
      const adapter = currentAdapter, context = checkedContext(adapter, intervalMs, limits);
      const abort = new AbortController();
      const forwardAbort = () => abort.abort(signal?.reason);
      signal?.addEventListener("abort", forwardAbort, { once: true });
      running = { adapter, abort };
      let encoder, prepared = false, size, result, failure;
      let completed = 0;
      const progress = (phase, step = null) => {
        // A UI observer must not prevent finally from restoring the viewer.
        try { onProgress({ phase, completed, total: context.frameCount, step }); } catch { /* view cleanup still owns the session */ }
      };
      const closeEncoder = () => encoder?.close();
      abort.signal.addEventListener("abort", closeEncoder, { once: true });
      try {
        progress("preparing");
        prepared = true;
        await abortable(adapter.prepare({ signal: abort.signal }), abort.signal);
        for (let index = 0; index < context.frameCount; index++) {
          if (abort.signal.aborted) throw movieAbortError(abort.signal.reason);
          if (adapter.getContext().task !== context.task) throw new Error("Задание изменилось во время создания moview");
          progress("capturing", index);
          const image = await abortable(adapter.capture(index, { signal: abort.signal,
            caption: movieFrameCaption(context, index) }), abort.signal);
          size = checkedPixels(image, size, limits);
          encoder ??= createEncoder();
          await abortable(encoder.addFrame(image, { delayMs: intervalMs }), abort.signal);
          completed++;
          progress("capturing", index);
        }
        progress("encoding");
        const blob = await abortable(encoder.finish(), abort.signal);
        if (!(blob instanceof Blob) || blob.type !== "image/gif") throw new Error("Кодировщик moview не вернул GIF");
        if (!blob.size || blob.size > limits.outputBytes) throw new Error(`Размер GIF превышает допустимые ${Math.floor(limits.outputBytes / 1024 / 1024)} МиБ`);
        result = { blob, filename: movieFilename(context.filenamePrefix), frameCount: context.frameCount, ...size };
      } catch (error) {
        failure = abort.signal.aborted ? movieAbortError(abort.signal.reason) : error;
      } finally {
        abort.signal.removeEventListener("abort", closeEncoder);
        try { closeEncoder(); } catch (error) { failure ??= error; }
        if (prepared) {
          try { progress("restoring"); await adapter.restore(context.originalTime); }
          catch (error) {
            // Restoration failure is visible even if export was cancelled.
            failure = new Error(`Не удалось восстановить исходный вид: ${error?.message ?? String(error)}${failure ? ` (${failure.message ?? failure})` : ""}`);
          }
        }
        signal?.removeEventListener("abort", forwardAbort);
        if (!failure && abort.signal.aborted) failure = movieAbortError(abort.signal.reason);
        running = null;
      }
      if (failure) throw failure;
      return result;
    },
    cancel,
    dispose() {
      disposed = true; cancel("Приложение закрыто");
      currentAdapter = null; onAdapterChange(null);
    },
  };
}
