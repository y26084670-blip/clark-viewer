const NO_FRAME = Symbol("No rendered movie frame");
const aborted = () => new DOMException("Создание фильма отменено", "AbortError");

/** Exact published-frame rendezvous; neither time numbers nor elapsed time prove a render. */
export function createRenderedFrameGate() {
  let current = NO_FRAME, failure = null, closed = false;
  const waiting = new Set();
  function settle(waiter, error) {
    waiting.delete(waiter);
    waiter.signal?.removeEventListener("abort", waiter.abort);
    if (error) waiter.reject(error); else waiter.resolve(waiter.key);
  }
  return {
    get current() { return current; },
    wait(key, { signal } = {}) {
      if (signal?.aborted) return Promise.reject(signal.reason ?? aborted());
      if (failure) return Promise.reject(failure);
      if (closed) return Promise.reject(new Error("Окно графика закрыто"));
      if (Object.is(current, key)) return Promise.resolve(key);
      return new Promise((resolve, reject) => {
        const waiter = { key, signal, resolve, reject };
        waiter.abort = () => settle(waiter, signal.reason ?? aborted());
        waiting.add(waiter);
        signal?.addEventListener("abort", waiter.abort, { once: true });
      });
    },
    rendered(key) {
      if (closed) return;
      current = key; failure = null;
      for (const waiter of waiting) if (Object.is(waiter.key, key)) settle(waiter);
    },
    fail(error) {
      failure = error instanceof Error ? error : new Error(String(error));
      current = NO_FRAME;
      for (const waiter of waiting) settle(waiter, failure);
    },
    close() {
      closed = true;
      this.fail(new Error("Окно графика закрыто"));
    },
  };
}

export function snapshotMovieCamera(camera, controls) {
  const snapshot = { camera: camera.clone(), target: controls.target.clone(), enabled: controls.enabled };
  controls.enabled = false;
  return snapshot;
}

export function restoreMovieCamera(camera, controls, snapshot) {
  camera.copy(snapshot.camera, false);
  camera.updateProjectionMatrix();
  controls.target.copy(snapshot.target);
  controls.enabled = snapshot.enabled;
  controls.update();
}

/** Capture must stay in the same JavaScript turn as its forced WebGL render. */
export function captureRenderedMovieFrame(gate, expectedKey, draw, copy) {
  if (!Object.is(gate.current, expectedKey)) throw new Error("Запрошенный кадр ещё не отрисован");
  draw();
  if (!Object.is(gate.current, expectedKey)) throw new Error("Кадр изменился до захвата изображения");
  return copy();
}
