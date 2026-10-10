// One active frame read and one replaceable pending request. Files/worker are
// owned by the task; an already executing HDF5 read is allowed to finish.
export function sameFrameContext(a, b) {
  if (!a || !b || a.task !== b.task || a.quantityKey !== b.quantityKey || a.budget !== b.budget) return false;
  // Adding seeds/changing tracing tolerance may retain the previous displayed
  // frame while recalculating. Request identity still gates movie capture.
  if (Array.isArray(a.layers) || Array.isArray(b.layers)) {
    if (!Array.isArray(a.layers) || !Array.isArray(b.layers) || a.layers.length !== b.layers.length) return false;
    const right = new Map(b.layers.map(layer => [layer.key, layer]));
    return a.layers.every(layer => {
      const other = right.get(layer.key);
      return other && ["quantityKey", "volumeMode", "budget"].every(key => layer[key] === other[key])
        && sameSelection(layer.selected, other.selected);
    });
  }
  // Component arrays are sets; an empty set is distinct from the legacy default.
  if (a.components !== undefined || b.components !== undefined) {
    if (!Array.isArray(a.components) || !Array.isArray(b.components)) return false;
    const left = [...new Set(a.components.map(String))].sort();
    const right = [...new Set(b.components.map(String))].sort();
    if (left.length !== right.length || left.some((value, i) => value !== right[i])) return false;
  }
  // Plot choices belong to the frame context; time alone may reuse the old frame.
  for (const key of ["component", "direction", "copy", "allCopies"]) {
    if (a[key] !== b[key]) return false;
  }
  return sameSelection(a.selected, b.selected);
}

function sameSelection(a = [], b = []) {
  const left = [...a].sort((x, y) => x - y);
  const right = [...b].sort((x, y) => x - y);
  return left.length === right.length && left.every((id, i) => id === right[i]);
}

export function createResultFrameController({ load, publish, onPerformance,
  now = () => performance.now(),
  schedule = callback => requestAnimationFrame(callback),
  cancel = id => cancelAnimationFrame(id) }) {
  let requested = null, pending = null, frame = null;
  let active = false, disposed = false, revision = 0, scheduled = null;
  let requests = 0, started = 0, published = 0, skipped = 0;
  const emit = (loading, error = "") => publish({ frame, requested, loading, error });
  function enqueue() {
    if (disposed || active || !pending || scheduled !== null) return;
    scheduled = schedule(run);
  }
  async function run() {
    scheduled = null;
    if (disposed || active || !pending) return;
    const item = pending;
    pending = null;
    active = true;
    started++;
    const startedAt = onPerformance ? now() : 0;
    try {
      const value = await load(item.request);
      if (!disposed && item.revision === revision) {
        frame = { request: item.request, value };
        emit(false);
        published++;
        if (onPerformance) {
          const finishedAt = now();
          onPerformance({ kind: "time", time: item.request.time, loadMs: finishedAt - startedAt,
            latencyMs: finishedAt - item.requestedAt, requests, started, published, skipped });
        }
      } else if (!disposed) skipped++;
    } catch (error) {
      if (!disposed && item.revision === revision) emit(false, error.message ?? String(error));
    } finally {
      active = false;
      enqueue();
    }
  }
  return {
    request(next) {
      if (disposed) return;
      revision++;
      if (next) requests++;
      if (!sameFrameContext(requested, next)) frame = null;
      requested = next;
      if (next && pending) skipped++;
      pending = next ? { request: next, revision, requestedAt: onPerformance ? now() : 0 } : null;
      if (!next && scheduled !== null) { cancel(scheduled); scheduled = null; }
      emit(Boolean(next));
      enqueue();
    },
    close() {
      disposed = true; revision++; pending = null; frame = null; requested = null;
      if (scheduled !== null) cancel(scheduled);
      scheduled = null;
    },
  };
}
