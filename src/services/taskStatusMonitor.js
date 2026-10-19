import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { EMPTY_TASK_STATUS, readTaskStatusEntry, unavailableTaskStatus } from "./taskStatusService.js";

function equalStatus(a, b) {
  return a && b && ["hasSolution", "missingInput", "hasGifs", "hasComparison", "omState"]
    .every(key => a[key] === b[key] && a.errors[key] === b.errors[key]);
}

// One bounded scan at a time. Replaced sources invalidate all pending results.
export function createTaskStatusMonitor({
  onChange, onBusyChange, read = readTaskStatusEntry, concurrency = 6,
} = {}) {
  let entries = [], disposed = false, revision = 0;
  let values = new Map(), controller = null, running = null, requested = false;
  const enabled = () => !disposed && entries.length > 0;
  const sameEntry = (a, b) => a?.key === b?.key && a?.handle === b?.handle
    && a?.root === b?.root && a?.path === b?.path;

  async function scan() {
    while (requested && enabled()) {
      requested = false;
      const current = revision, source = entries;
      controller = new AbortController();
      const signal = controller.signal, next = new Map();
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, source.length) }, async () => {
        while (!signal.aborted && index < source.length) {
          const entry = source[index++];
          try { next.set(entry.key, await read(entry, { signal })); }
          catch (error) {
            if (signal.aborted || error?.name === "AbortError") return;
            next.set(entry.key, unavailableTaskStatus(error));
          }
        }
      }));
      if (signal.aborted || current !== revision || !enabled()) continue;
      const changed = next.size !== values.size || [...next].some(([key, value]) => !equalStatus(value, values.get(key)));
      if (changed) { values = next; onChange?.(next); }
    }
  }

  function refresh() {
    if (!enabled()) return running ?? Promise.resolve();
    requested = true;
    if (!running) {
      onBusyChange?.(true);
      running = scan().finally(() => {
        running = null;
        if (!disposed) onBusyChange?.(false);
      });
    }
    return running;
  }

  function setSource(source) {
    if (disposed || (source.length === entries.length
      && source.every((entry, index) => sameEntry(entry, entries[index])))) return false;
    revision += 1;
    controller?.abort();
    const previous = new Map(entries.map(entry => [entry.key, entry]));
    entries = source;
    requested = false;
    const retained = new Map(source.filter(entry => sameEntry(entry, previous.get(entry.key)) && values.has(entry.key))
      .map(entry => [entry.key, values.get(entry.key)]));
    if (retained.size !== values.size) { values = retained; onChange?.(values); }
    return true;
  }

  return {
    setSource, refresh,
    dispose() {
      disposed = true;
      revision += 1;
      requested = false;
      controller?.abort();
      onBusyChange?.(false);
    },
  };
}

export function useTaskStatuses(source, { refreshOnChange = true } = {}) {
  const [statuses, setStatuses] = createSignal(new Map());
  const [busy, setBusy] = createSignal(false);
  const monitor = createTaskStatusMonitor({ onChange: setStatuses, onBusyChange: setBusy });
  createEffect(() => {
    if (monitor.setSource(source()) && refreshOnChange) void monitor.refresh();
  });
  onCleanup(() => monitor.dispose());
  const lookup = key => statuses().get(key) ?? EMPTY_TASK_STATUS;
  lookup.busy = busy;
  lookup.refresh = () => {
    // A button may run before the source effect flushes after setEntries.
    monitor.setSource(untrack(source));
    return monitor.refresh();
  };
  return lookup;
}
