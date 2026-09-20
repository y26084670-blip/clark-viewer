// One active frame read and one replaceable pending request. Files/worker are
// owned by the task; an already executing HDF5 read is allowed to finish.
export function sameFrameContext(a, b) {
  if (!a || !b || a.task !== b.task || a.quantityKey !== b.quantityKey || a.budget !== b.budget) return false;
  const left = [...a.selected].sort((x, y) => x - y);
  const right = [...b.selected].sort((x, y) => x - y);
  return left.length === right.length && left.every((id, i) => id === right[i]);
}

export function createResultFrameController({ load, publish,
  schedule = callback => requestAnimationFrame(callback),
  cancel = id => cancelAnimationFrame(id) }) {
  let requested = null, pending = null, frame = null;
  let active = false, disposed = false, revision = 0, scheduled = null;
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
    try {
      const value = await load(item.request);
      if (!disposed && item.revision === revision) {
        frame = { request: item.request, value };
        emit(false);
      }
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
      if (!sameFrameContext(requested, next)) frame = null;
      requested = next;
      pending = next ? { request: next, revision } : null;
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
