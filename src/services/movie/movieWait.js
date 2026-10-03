import { createEffect, createRoot } from "solid-js";

export function movieAbortError(reason) {
  return Object.assign(new Error(typeof reason === "string" ? reason : "Создание moview отменено"), { name: "AbortError" });
}

/** Observe actual reactive publication, including when called outside a Solid
 * owner. read() returns {ready,value,error}; no RAF polling or timeout guessing.
 */
export function waitForMovieCondition(read, { signal } = {}) {
  return new Promise((resolve, reject) => {
    let dispose = () => {}, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      dispose();
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve(value);
    };
    const abort = () => finish(movieAbortError(signal?.reason));
    createRoot(cleanup => {
      dispose = cleanup;
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      createEffect(() => {
        try {
          const condition = read();
          if (condition?.error) finish(condition.error);
          else if (condition?.ready) finish(null, condition.value);
        } catch (error) { finish(error); }
      });
    });
  });
}
