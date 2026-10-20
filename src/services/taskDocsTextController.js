import { listTaskDocs, preferredTaskDoc, readTaskDocsText } from "./taskDocsService.js";

// A scan and a read each have one slot. Aborted native operations keep their
// slot until settled; rapid selection/focus changes replace the pending work.
export function createTaskDocsTextController({ publish = () => {}, list = listTaskDocs, read = readTaskDocsText } = {}) {
  let task = null, active = false, displayed = true, disposed = false, epoch = 0;
  let documents = [], selected = null, text = "", error = "", loading = false;
  let scanRunning = false, scanAgain = false, scanAbort;
  let readRunning = false, readAbort, pendingRead = null, readId = 0;
  const enabled = () => !disposed && active && displayed && Boolean(task);
  const emit = () => { if (!disposed) publish({ documents, selected, text, error, loading }); };
  function cancelRead() { readId++; readAbort?.abort(); pendingRead = null; }
  function pumpRead() {
    if (!enabled() || readRunning || !pendingRead) return;
    const job = pendingRead; pendingRead = null; readRunning = true; readAbort = job.abort;
    const current = () => enabled() && job.epoch === epoch && job.id === readId && !job.abort.signal.aborted;
    Promise.resolve().then(() => current() ? read(job.entry.handle, { signal: job.abort.signal }) : null).then(value => {
      if (!current()) return;
      text = value; loading = false; emit();
    }).catch(failure => {
      if (!current()) return;
      text = ""; error = failure?.message ?? String(failure); loading = false; emit();
    }).finally(() => { readRunning = false; pumpRead(); });
  }
  function select(name, reload = false) {
    if (!enabled()) return;
    const entry = documents.find(item => item.name === name) ?? null;
    if (!reload && entry === selected) return;
    cancelRead();
    if (selected?.name !== entry?.name) text = "";
    selected = entry; error = ""; loading = Boolean(entry);
    if (entry) pendingRead = { entry, epoch, id: readId, abort: new AbortController() };
    else text = "";
    emit(); pumpRead();
  }
  function scan() {
    if (!enabled() || scanRunning) return;
    scanRunning = true; scanAgain = false; loading = true; error = "";
    const current = epoch, handle = task, abort = new AbortController(); scanAbort = abort;
    emit();
    Promise.resolve().then(() => list(handle, { signal: abort.signal })).then(result => {
      if (!enabled() || current !== epoch || abort.signal.aborted) return;
      documents = result.documents;
      select(preferredTaskDoc(documents, selected?.name)?.name, true);
    }).catch(failure => {
      if (!enabled() || current !== epoch || abort.signal.aborted) return;
      cancelRead(); documents = []; selected = null; text = "";
      error = failure?.message ?? String(failure); loading = false; emit();
    }).finally(() => { scanRunning = false; if (scanAgain) scan(); });
  }
  function refresh() {
    if (!enabled()) return;
    cancelRead(); scanAgain = true; loading = true;
    if (scanRunning) { scanAbort?.abort(); emit(); }
    else scan();
  }
  function setContext(nextTask, nextActive = true) {
    const next = nextActive !== false && Boolean(nextTask);
    if (disposed || (task === nextTask && active === next)) return;
    epoch++; scanAbort?.abort(); cancelRead(); scanAgain = false;
    task = nextTask; active = next;
    documents = []; selected = null; text = ""; error = ""; loading = false;
    emit(); refresh();
  }
  function setDisplayActive(next) {
    const value = next !== false;
    if (disposed || displayed === value) return;
    displayed = value;
    if (displayed) refresh();
    else { scanAbort?.abort(); scanAgain = false; cancelRead(); loading = false; emit(); }
  }
  function dispose() {
    disposed = true; epoch++; scanAbort?.abort(); cancelRead(); scanAgain = false;
    documents = []; selected = null; text = "";
  }
  emit();
  return { setContext, setDisplayActive, select, refresh, dispose };
}
