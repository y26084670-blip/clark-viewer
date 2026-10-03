import { listTaskGifs, readTaskGif, deleteTaskGif } from "./taskGifService.js";

// One list scan and at most two file reads are in flight. Aborted browser file
// operations still occupy their slot until settled, so rapid scrolling cannot
// create an unbounded tail of reads. Public entry references stay stable while
// thumbnails update; Solid's keyed rows must not remount for every loaded image.
export function createTaskGifGalleryController({ publish = () => {}, concurrency = 2,
  list = listTaskGifs, read = readTaskGif, remove = deleteTaskGif,
  createURL = blob => URL.createObjectURL(blob), revokeURL = url => URL.revokeObjectURL(url),
} = {}) {
  let handle = null, active = false, disposed = false, epoch = 0;
  let entries = [], records = new Map(), error = "", loading = false, deleting = null;
  let preview = null, previewId = 0, previewAbort;
  let listRunning = false, listAgain = false, listAbort;
  let deleteAbort;
  const queue = [], running = new Set();
  const limit = Number.isFinite(concurrency) ? Math.max(1, Math.min(2, Math.floor(concurrency))) : 2;
  const message = failure => failure?.message ?? String(failure);
  function emit() {
    if (disposed) return;
    const thumbnails = Object.fromEntries([...records].map(([name, record]) => [name,
      { url: record.url, loading: record.loading, error: record.error }]));
    publish({ entries, thumbnails, loading, error, deleting, preview: preview ? { ...preview } : null });
  }
  function revoke(url) { if (url) revokeURL(url); }
  function abortThumbnails() {
    for (const record of records.values()) {
      record.token++; record.abort?.abort(); revoke(record.url); record.url = "";
    }
    queue.splice(0, queue.length, ...queue.filter(job => job.kind === "preview"));
  }
  function resetPreview() {
    previewId++; previewAbort?.abort(); previewAbort = undefined;
    revoke(preview?.url); preview = null;
    queue.splice(0, queue.length, ...queue.filter(job => job.kind !== "preview"));
  }
  const currentJob = job => !disposed && active && job.epoch === epoch && !job.abort.signal.aborted
    && (job.kind === "preview" ? preview?.entry === job.entry && previewId === job.token
      : records.get(job.entry.name) === job.record && job.record.visible && job.record.token === job.token);
  function pump() {
    while (!disposed && running.size < limit && queue.length) {
      const job = queue.shift();
      if (!currentJob(job)) continue;
      running.add(job);
      // Invoke synchronously, but settle every rejection through the same path.
      Promise.resolve().then(() => {
        if (!currentJob(job)) return null;
        return read(job.entry.handle, { signal: job.abort.signal });
      }).then(blob => {
        if (!blob || !currentJob(job)) return;
        const url = createURL(blob);
        if (!currentJob(job)) { revoke(url); return; }
        if (job.kind === "preview") { preview.url = url; preview.loading = false; }
        else { job.record.url = url; job.record.loading = false; }
        emit();
      }).catch(failure => {
        if (!currentJob(job)) return;
        if (job.kind === "preview") { preview.error = message(failure); preview.loading = false; }
        else { job.record.error = message(failure); job.record.loading = false; }
        emit();
      }).finally(() => { running.delete(job); pump(); });
    }
  }
  function replaceEntries(next) {
    abortThumbnails();
    entries = next.map(entry => ({ name: entry.name, handle: entry.handle }));
    records = new Map(entries.map(entry => [entry.name,
      { entry, visible: false, url: "", loading: false, error: "", token: 0, abort: null }]));
    // A preview owns its URL independently of the thumbnail list. Only removal
    // of its file closes it; ordinary background refresh does not interrupt GIF.
    if (preview && !entries.some(entry => entry.name === preview.entry.name)) resetPreview();
  }
  function scan() {
    if (disposed || !active || !handle || listRunning) return;
    listRunning = true; listAgain = false; loading = true; error = "";
    const current = epoch, task = handle, abort = new AbortController(); listAbort = abort;
    emit();
    Promise.resolve().then(() => list(task, { signal: abort.signal })).then(next => {
      if (disposed || !active || current !== epoch || abort.signal.aborted) return;
      replaceEntries(next); loading = false; emit();
    }).catch(failure => {
      if (disposed || !active || current !== epoch || abort.signal.aborted) return;
      replaceEntries([]); loading = false; error = message(failure); emit();
    }).finally(() => {
      listRunning = false;
      if (!disposed && active && listAgain) scan();
    });
  }
  function refresh() {
    if (disposed || !active || !handle) return;
    listAgain = true; loading = true;
    if (listRunning) { listAbort?.abort(); emit(); }
    else scan();
  }
  function setContext(nextHandle, nextActive = true) {
    const enabled = nextActive !== false && Boolean(nextHandle);
    if (disposed || (handle === nextHandle && active === enabled)) return;
    epoch++; listAbort?.abort(); deleteAbort?.abort(); abortThumbnails(); resetPreview();
    queue.length = 0; handle = nextHandle; active = enabled;
    entries = []; records = new Map(); error = ""; loading = false; deleting = null; listAgain = false;
    emit();
    if (active) refresh();
  }
  function setVisible(entry, visible) {
    const record = records.get(entry?.name);
    if (disposed || !active || record?.entry !== entry || record.visible === visible) return;
    record.visible = visible;
    record.token++; record.abort?.abort(); record.error = "";
    if (!visible) {
      revoke(record.url); record.url = ""; record.loading = false; emit(); return;
    }
    record.abort = new AbortController(); record.loading = true; emit();
    queue.push({ kind: "thumbnail", entry, record, epoch, token: record.token, abort: record.abort }); pump();
  }
  function openPreview(entry) {
    if (disposed || !active || records.get(entry?.name)?.entry !== entry) return;
    resetPreview(); previewAbort = new AbortController();
    preview = { entry, url: "", loading: true, error: "" };
    emit();
    queue.unshift({ kind: "preview", entry, epoch, token: previewId, abort: previewAbort }); pump();
  }
  function closePreview() { resetPreview(); emit(); }
  function thumbnailFailed(entry, url) {
    const record = records.get(entry?.name);
    if (record?.entry !== entry || !url || record.url !== url) return;
    revoke(record.url); record.url = ""; record.loading = false; record.error = "Не удалось отобразить GIF."; emit();
  }
  function previewFailed(url) {
    if (!url || preview?.url !== url) return;
    revoke(preview.url); preview.url = ""; preview.loading = false; preview.error = "Не удалось отобразить GIF."; emit();
  }
  async function deleteEntry(entry) {
    if (disposed || !active || deleting || records.get(entry?.name)?.entry !== entry) return false;
    const task = handle, current = epoch, abort = new AbortController(); deleteAbort = abort;
    deleting = entry.name; error = ""; emit();
    try {
      // No await before this call: write permission remains tied to the explicit
      // confirmed Delete click in the component, never to background refresh.
      await remove(task, entry, { signal: abort.signal });
      if (!disposed && active && current === epoch) {
        if (preview?.entry.name === entry.name) resetPreview();
        const record = records.get(entry.name);
        record?.abort?.abort(); revoke(record?.url);
        records.delete(entry.name); entries = entries.filter(item => item !== entry);
        refresh();
      }
      return true;
    } catch (failure) {
      if (!disposed && active && current === epoch && !abort.signal.aborted) { error = message(failure); emit(); }
      return false;
    } finally {
      if (!disposed && current === epoch) { deleting = null; deleteAbort = undefined; emit(); }
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true; epoch++; listAbort?.abort(); deleteAbort?.abort(); abortThumbnails(); resetPreview();
    queue.length = 0; entries = []; records.clear();
  }
  emit();
  return { setContext, refresh, setVisible, openPreview, closePreview, thumbnailFailed, previewFailed, deleteEntry, dispose };
}
