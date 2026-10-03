import { createEffect, createSignal, onCleanup } from "solid-js";
import { waitForMovieCondition } from "./movieWait.js";

// Publication identity, not just loading=false, is the boundary between data
// and rendering. A previous step is never a substitute for a missing result.
export function completedMovieFrame(state, { task, index, timed = true }) {
  const request = state?.requested;
  if (!request || request.task !== task || (timed && request.time !== index) || state.loading) return { ready: false };
  if (state.error) return { error: state.error };
  const frame = state.frame;
  return frame?.request === request ? { ready: true, value: frame } : { ready: false };
}

/** Connect an active tab's published data to its local renderer. Renderer state
 * remains owned by the chart; this adapter never changes geometry or selection.
 */
export function createMovieTabAdapter(props, { title, readFrame }) {
  const [renderer, setRenderer] = createSignal(null);
  let lifetime = new AbortController(), lifetimeTask = props.task;
  let alive = true, prepared = null, preparedTask = null;
  createEffect(() => {
    const task = props.task;
    if (task === lifetimeTask) return;
    lifetime.abort(new DOMException("Задание изменилось", "AbortError"));
    lifetimeTask = task; lifetime = new AbortController();
  });
  const setTime = index => (props.setMovieTime ?? props.setTime)?.(index);
  const frameReady = (index, signal, expectedTask) => waitForMovieCondition(() => {
    if (!alive) return { error: new DOMException("Вкладка закрыта", "AbortError") };
    if (props.task !== expectedTask) return { error: new DOMException("Задание изменилось", "AbortError") };
    const status = readFrame(index);
    if (status.error || !status.ready) return status;
    const target = renderer();
    return target ? { ready: true, value: { target, key: status.value } } : { ready: false };
  }, { signal });
  const adapter = {
    getContext: () => ({ task: props.task, title,
      frameCount: (props.task?.general.countTimeSteps ?? 0) + 1,
      timeStep: props.task?.general.timeStep ?? 0, originalTime: props.time }),
    async prepare({ signal } = {}) {
      const task = props.task;
      const { target, key } = await frameReady(props.time, signal, task);
      await target.renderReady(key, { signal });
      if (props.task !== task) throw new DOMException("Задание изменилось", "AbortError");
      prepared = target;
      preparedTask = task;
      await target.prepare({ signal });
    },
    async capture(index, { signal, caption } = {}) {
      if (!alive || !prepared) throw new Error("Запись вкладки не подготовлена");
      if (props.task !== preparedTask) throw new DOMException("Задание изменилось", "AbortError");
      setTime(index);
      const { target, key } = await frameReady(index, signal, preparedTask);
      if (target !== prepared) throw new Error("Область просмотра изменилась во время записи");
      await target.renderReady(key, { signal });
      if (signal?.aborted) throw signal.reason ?? new DOMException("Запись отменена", "AbortError");
      if (props.task !== preparedTask) throw new DOMException("Задание изменилось", "AbortError");
      return target.capture(key, { caption });
    },
    async restore(originalTime) {
      const target = prepared, task = preparedTask;
      prepared = null; preparedTask = null;
      if (!target) return;
      try {
        if (alive && props.task === task) {
          const signal = lifetime.signal;
          setTime(originalTime);
          const restored = await frameReady(originalTime, signal, task);
          if (restored.target === target) await target.renderReady(restored.key, { signal });
        }
      } finally { await target.restore(); }
    },
  };
  const unregister = props.registerMovieAdapter?.(adapter);
  onCleanup(() => {
    alive = false;
    lifetime.abort(new DOMException("Вкладка закрыта", "AbortError"));
    unregister?.();
  });
  return { onCaptureReady: target => setRenderer(() => target), adapter };
}
