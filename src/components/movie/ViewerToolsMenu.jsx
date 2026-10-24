import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { saveTaskGif } from "../../services/taskGifService.js";
import { listTaskTestProtocols, readTaskTestProtocol } from "../../services/taskTestProtocolService.js";
import { GifWebmDialog } from "./GifWebmDialog.jsx";
import { TaskConditionsDialog } from "./TaskConditionsDialog.jsx";
import "./ViewerToolsMenu.css";

export function ViewerToolsMenu(props) {
  const menuId = createUniqueId(), titleId = createUniqueId(), protocolsTitleId = createUniqueId();
  const [conditionsOpen, setConditionsOpen] = createSignal(false);
  const [conversionTask, setConversionTask] = createSignal(null);
  const canEditProtocol = createMemo(() => Boolean(props.backfillEligible));
  let taskProtocolMenuItem, conversionMenuItem;
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuPosition, setMenuPosition] = createSignal({ left: 8, top: 8 });
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [phase, setPhase] = createSignal("setup");
  const [intervalMs, setIntervalMs] = createSignal(100);
  const [progress, setProgress] = createSignal({ phase: "preparing", completed: 0, total: 0, step: null });
  const [error, setError] = createSignal("");
  const [result, setResult] = createSignal(null);
  const [saveInTask, setSaveInTask] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [savedNotice, setSavedNotice] = createSignal("");
  const [backfillDialogOpen, setBackfillDialogOpen] = createSignal(false);
  const [backfillRunning, setBackfillRunning] = createSignal(false);
  const [backfillProgress, setBackfillProgress] = createSignal(null);
  const [backfillError, setBackfillError] = createSignal("");
  const [backfillSummary, setBackfillSummary] = createSignal([]);
  const [protocols, setProtocols] = createSignal([]);
  const [protocolScanning, setProtocolScanning] = createSignal(false);
  const [protocolScanError, setProtocolScanError] = createSignal("");
  const [protocolOpenError, setProtocolOpenError] = createSignal("");
  const [protocolsDialogOpen, setProtocolsDialogOpen] = createSignal(false);
  const [protocolOpening, setProtocolOpening] = createSignal("");
  let trigger, menu, menuItem, rangeMenuItem, protocolsMenuItem, conditionsMenuItem, dialog, backfillDialog, protocolsDialog, protocolsCloseButton;
  let intervalInput, cancelButton, saveButton, startButton;
  let runAbort, saveAbort, backfillAbort, revision = 0, disposed = false;
  let protocolTaskHandle, protocolScanAbort, protocolReadAbort, protocolScanRevision = 0;
  const protocolTabs = new Set();
  let openedTask, openedTab, closeAfterRun = false, closeAfterSave = false;
  const running = () => phase() === "running" || phase() === "cancelling";
  const staticImage = () => props.frameCount === 1;
  const validInterval = () => staticImage() || (Number.isInteger(intervalMs()) && intervalMs() >= 20
    && intervalMs() <= 60000 && intervalMs() % 10 === 0);
  const focusSetup = () => (staticImage() ? startButton : intervalInput)?.focus();
  const duration = () => (props.frameCount * intervalMs() / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 2 });
  const protocolsDisabledReason = () => {
    if (!props.task?.handle) return "Загрузите задание.";
    if (!props.backfillEligible) return props.backfillDisabledReason || "Дождитесь завершения текущей операции.";
    if (protocolScanning()) return "Поиск протоколов…";
    if (protocolScanError()) return protocolScanError();
    return protocols().length ? "" : "В comparison нет HTML-протоколов.";
  };

  async function refreshProtocols(handle = props.task?.handle) {
    const current = ++protocolScanRevision;
    protocolScanAbort?.abort();
    const abort = new AbortController(); protocolScanAbort = abort;
    setProtocols([]); setProtocolScanError(""); setProtocolScanning(Boolean(handle));
    try {
      const entries = handle ? await listTaskTestProtocols(handle, { signal: abort.signal }) : [];
      if (!disposed && current === protocolScanRevision && !abort.signal.aborted && handle === props.task?.handle) {
        setProtocols(entries);
      }
    } catch (failure) {
      if (!disposed && current === protocolScanRevision && !abort.signal.aborted && handle === props.task?.handle) {
        setProtocolScanError(`Не удалось найти протоколы: ${failure?.message ?? String(failure)}`);
      }
    } finally {
      if (!disposed && current === protocolScanRevision) { protocolScanAbort = null; setProtocolScanning(false); }
    }
  }
  function releaseProtocolTabs(all = false) {
    for (const item of protocolTabs) {
      if (all || item.tab.closed) { URL.revokeObjectURL(item.url); protocolTabs.delete(item); }
    }
  }
  function openProtocols() {
    if (protocolsDisabledReason()) return;
    closeMenu(); setProtocolOpenError(""); setProtocolsDialogOpen(true);
    queueMicrotask(() => protocolsCloseButton?.focus());
  }
  function closeProtocols() {
    protocolReadAbort?.abort(); protocolReadAbort = null; setProtocolOpening("");
    setProtocolsDialogOpen(false); trigger?.focus();
  }
  async function openProtocol(entry) {
    if (disposed || !protocolsDialogOpen() || protocolOpening() || !props.backfillEligible || !protocols().includes(entry)) return;
    const handle = props.task?.handle;
    setProtocolOpenError(""); releaseProtocolTabs();
    // Reserve the tab during the click, before the asynchronous filesystem read.
    const tab = window.open("", "_blank");
    if (!tab) { setProtocolOpenError("Браузер заблокировал новую вкладку. Разрешите её открытие и повторите попытку."); return; }
    const abort = new AbortController(); protocolReadAbort = abort;
    const closePending = () => tab.close();
    abort.signal.addEventListener("abort", closePending, { once: true });
    let url;
    setProtocolOpening(entry.path);
    try {
      tab.opener = null;
      const blob = await readTaskTestProtocol(entry.handle, { signal: abort.signal });
      if (disposed || abort.signal.aborted || handle !== props.task?.handle || !protocolsDialogOpen() || tab.closed) {
        tab.close(); return;
      }
      url = URL.createObjectURL(blob);
      tab.location.replace(url);
      protocolTabs.add({ tab, url }); url = null;
    } catch (failure) {
      tab.close();
      if (!disposed && !abort.signal.aborted && handle === props.task?.handle) {
        setProtocolOpenError(`Не удалось открыть ${entry.path}: ${failure?.message ?? String(failure)}`);
        // A deleted file must also disappear from the next list.
        void refreshProtocols(handle);
      }
    } finally {
      abort.signal.removeEventListener("abort", closePending);
      if (url) URL.revokeObjectURL(url);
      if (protocolReadAbort === abort) { protocolReadAbort = null; if (!disposed) setProtocolOpening(""); }
    }
  }
  const onProtocolFocus = () => { releaseProtocolTabs(); void refreshProtocols(); };
  window.addEventListener("focus", onProtocolFocus);

  function discardResult() {
    const previous = result();
    if (previous?.url) URL.revokeObjectURL(previous.url);
    setResult(null);
  }
  function closeMenu(restoreFocus = false) {
    setMenuOpen(false);
    if (restoreFocus) trigger?.focus();
  }
  function positionMenu() {
    if (!trigger) return;
    const bounds = trigger.getBoundingClientRect();
    const width = menu?.offsetWidth ?? 260, height = menu?.offsetHeight ?? 90;
    setMenuPosition({ left: Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(bounds.bottom + 4, window.innerHeight - height - 8)) });
  }
  function toggleMenu() {
    if (menuOpen()) { closeMenu(); return; }
    void refreshProtocols();
    setMenuOpen(true);
    queueMicrotask(() => { if (menuOpen() && !disposed) { positionMenu(); menuItem?.focus(); } });
  }
  function openSetup() {
    if (!props.eligible || running() || saving()) return;
    closeMenu(); discardResult(); setError(""); setPhase("setup");
    setSaveInTask(true); setSavedNotice("");
    openedTask = props.task; openedTab = props.tabIndex; closeAfterRun = false;
    setDialogOpen(true);
    queueMicrotask(focusSetup);
  }
  function cancelCapture(close = false) {
    if (!running()) return;
    closeAfterRun ||= close;
    setPhase("cancelling"); runAbort?.abort();
  }
  function closeDialog() {
    if (saving()) return;
    if (running()) { cancelCapture(true); return; }
    setDialogOpen(false); discardResult(); setError("");
    trigger?.focus();
  }
  async function startCapture() {
    if (running() || saving() || !props.eligible) return;
    if (!validInterval()) {
      setError("Введите интервал от 20 до 60000 мс с шагом 10 мс.");
      intervalInput?.focus(); return;
    }
    const current = ++revision;
    const capturedTask = props.task;
    const abort = new AbortController(); runAbort = abort;
    discardResult(); setError(""); setPhase("running"); closeAfterRun = false;
    setProgress({ phase: "preparing", completed: 0, total: props.frameCount, step: null });
    props.onBusyChange?.(true);
    queueMicrotask(() => cancelButton?.focus());
    try {
      const movie = await props.onRun({ intervalMs: staticImage() ? 100 : intervalMs(), signal: abort.signal,
        onProgress: value => { if (!disposed && current === revision) setProgress(value); } });
      if (disposed || current !== revision || abort.signal.aborted) return;
      if (!(movie?.blob instanceof Blob) || movie.blob.size === 0) throw new Error("Не удалось сформировать WebM.");
      setResult({ ...movie, task: capturedTask, url: URL.createObjectURL(movie.blob) });
      setPhase("ready");
      queueMicrotask(() => saveButton?.focus());
    } catch (failure) {
      if (disposed || current !== revision) return;
      if (failure?.name === "AbortError") abort.abort();
      else {
        setError(failure?.message ?? String(failure)); setPhase("error");
      }
    } finally {
      if (current === revision) {
        runAbort = null; props.onBusyChange?.(false);
        if (!disposed && phase() !== "error" && (abort.signal.aborted || phase() === "cancelling")) {
          setPhase("setup"); setError("");
          if (closeAfterRun) { setDialogOpen(false); discardResult(); trigger?.focus(); }
          else queueMicrotask(focusSetup);
        }
      }
    }
  }
  function changeSaveLocation(checked) {
    if (saving()) return;
    setSaveInTask(Boolean(checked)); setError(""); setSavedNotice("");
  }
  async function saveToTask() {
    const movie = result();
    if (!movie || !saveInTask() || saving() || running() || disposed) return;
    if (movie.task !== props.task || movie.task !== openedTask || props.tabIndex !== openedTab) {
      setError("Задание изменилось. Создайте фильм для текущего открытого задания."); return;
    }
    const current = ++revision;
    const abort = new AbortController(); saveAbort = abort; closeAfterSave = false;
    setSaving(true); setError(""); setSavedNotice(""); props.onBusyChange?.(true);
    try {
      // Call directly from the click before the first await, preserving browser
      // user activation for the directory's write-permission request.
      const saved = await saveTaskGif(movie.task?.handle, movie.blob, movie.filename, { signal: abort.signal });
      if (disposed || current !== revision || abort.signal.aborted || props.task !== movie.task) return;
      setSavedNotice(`Сохранено: output3XX/demo/${saved.name}`);
    } catch (failure) {
      if (!disposed && current === revision && !closeAfterSave) {
        setError(failure?.name === "AbortError" ? "Сохранение отменено. WebM доступен для повторного сохранения."
          : failure?.message ?? String(failure));
      }
    } finally {
      if (current === revision) {
        saveAbort = null; setSaving(false); props.onBusyChange?.(false);
        if (!disposed && closeAfterSave) closeDialog();
      }
    }
  }
  function openBackfill() {
    if (!props.backfillEligible || backfillRunning() || running() || saving()) return;
    closeMenu(); setBackfillError(""); setBackfillSummary([]); setBackfillProgress(null);
    setBackfillDialogOpen(true);
  }
  function closeBackfill() {
    if (backfillRunning()) { backfillAbort?.abort(); return; }
    setBackfillDialogOpen(false); setBackfillError(""); trigger?.focus();
  }
  async function startBackfill() {
    if (!props.backfillEligible || backfillRunning() || !props.onBackfill) return;
    const abort = new AbortController(); backfillAbort = abort;
    setBackfillRunning(true); setBackfillError(""); setBackfillSummary([]);
    props.onBusyChange?.(true);
    try {
      const summary = await props.onBackfill({ signal: abort.signal, onProgress: setBackfillProgress });
      if (!disposed && !abort.signal.aborted) setBackfillSummary(summary ?? []);
    } catch (failure) {
      if (!disposed) setBackfillError(failure?.name === "AbortError"
        ? "Операция отменена. Уже завершённые файлы, если они были, остаются обновлёнными."
        : failure?.message ?? String(failure));
    } finally {
      if (backfillAbort === abort) backfillAbort = null;
      if (!disposed) { setBackfillRunning(false); props.onBusyChange?.(false); }
    }
  }
  const backfillProgressText = () => {
    const value = backfillProgress();
    if (!value) return "Подготовка…";
    if (value.phase === "scan") return `${value.name}.h5 · шаг ${value.step} из ${value.total} · файл ${value.file} из ${value.files}`;
    if (value.phase === "file") return `${value.name}.h5 · файл ${value.file} из ${value.files}`;
    return "Обработка HDF5…";
  };

  function onTriggerKeyDown(event) {
    if (event.code === "ArrowDown" || event.code === "ArrowUp") {
      event.preventDefault(); if (!menuOpen()) toggleMenu(); else menuItem?.focus();
    } else if (event.code === "Escape" && menuOpen()) {
      event.preventDefault(); closeMenu(true);
    }
  }
  function onMenuKeyDown(event) {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.code)) {
      event.preventDefault();
      const items = [menuItem, conversionMenuItem, taskProtocolMenuItem, rangeMenuItem, protocolsMenuItem, conditionsMenuItem].filter(item => item && !item.disabled);
      const current = Math.max(0, items.indexOf(event.target));
      const index = event.code === "Home" ? 0 : event.code === "End" ? items.length - 1
        : event.code === "ArrowUp" ? (current + items.length - 1) % items.length : (current + 1) % items.length;
      items[index]?.focus();
    } else if (event.code === "Escape") {
      event.preventDefault(); event.stopPropagation(); closeMenu(true);
    } else if (event.code === "Tab") closeMenu(true);
  }
  const progressText = () => {
    const current = progress();
    if (phase() === "cancelling") return "Отмена и восстановление вида…";
    if (current.phase === "encoding") return "Формирование WebM…";
    if (current.phase === "restoring") return "Восстановление исходного вида…";
    if (current.phase === "capturing") return `Кадр ${current.completed} из ${current.total}`;
    return "Подготовка кадров…";
  };

  createEffect(() => {
    const handle = props.task?.handle;
    if (handle === protocolTaskHandle) return;
    protocolTaskHandle = handle;
    setConditionsOpen(false); setConversionTask(null);
    protocolReadAbort?.abort(); protocolReadAbort = null; setProtocolOpening("");
    setProtocolsDialogOpen(false); setProtocolOpenError("");
    void refreshProtocols(handle);
  });
  createEffect(() => {
    if (!protocolsDialog) return;
    if (protocolsDialogOpen()) { if (!protocolsDialog.open) protocolsDialog.showModal(); }
    else if (protocolsDialog.open) protocolsDialog.close();
  });
  createEffect(() => {
    if (!menuOpen()) return;
    const owner = trigger?.ownerDocument ?? document;
    const outside = event => {
      const path = event.composedPath?.() ?? [];
      if (!path.includes(trigger) && !path.includes(menu)) closeMenu();
    };
    const escape = event => { if (event.code === "Escape") { event.preventDefault(); closeMenu(true); } };
    const move = () => closeMenu();
    owner.addEventListener("pointerdown", outside, true);
    owner.addEventListener("keydown", escape, true);
    window.addEventListener("resize", move);
    window.addEventListener("scroll", move, true);
    onCleanup(() => {
      owner.removeEventListener("pointerdown", outside, true);
      owner.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", move);
      window.removeEventListener("scroll", move, true);
    });
  });
  createEffect(() => {
    if (!dialog) return;
    if (dialogOpen()) { if (!dialog.open) dialog.showModal(); }
    else if (dialog.open) dialog.close();
  });
  createEffect(() => {
    if (!backfillDialog) return;
    if (backfillDialogOpen()) { if (!backfillDialog.open) backfillDialog.showModal(); }
    else if (backfillDialog.open) backfillDialog.close();
  });
  createEffect(() => {
    const task = props.task, tab = props.tabIndex;
    if (dialogOpen() && (task !== openedTask || tab !== openedTab)) {
      // Handle each context change once. A later restoration error must remain
      // visible instead of retriggering this effect and closing its dialog.
      openedTask = task; openedTab = tab;
      if (saving()) { closeAfterSave = true; saveAbort?.abort(); }
      else closeDialog();
    }
  });
  onCleanup(() => {
    disposed = true; runAbort?.abort(); saveAbort?.abort(); backfillAbort?.abort(); discardResult();
    protocolScanRevision++; protocolScanAbort?.abort(); protocolReadAbort?.abort(); releaseProtocolTabs(true);
    window.removeEventListener("focus", onProtocolFocus);
    if (dialog?.open) dialog.close();
    if (backfillDialog?.open) backfillDialog.close();
    if (protocolsDialog?.open) protocolsDialog.close();
  });

  return <>
    <button ref={trigger} type="button" class="viewer-tools-trigger" aria-haspopup="menu" aria-expanded={menuOpen()}
      aria-controls={menuId} onClick={toggleMenu} onKeyDown={onTriggerKeyDown}>Инструменты</button>
    <Portal>
      <Show when={conversionTask()} keyed>{task => <GifWebmDialog task={task} onBusyChange={props.onBusyChange}
        onClose={() => { setConversionTask(null); trigger?.focus(); }} />}</Show>
      <TaskConditionsDialog open={conditionsOpen()} task={props.task} onBusyChange={props.onBusyChange}
        onClose={() => { setConditionsOpen(false); trigger?.focus(); }} />
      <Show when={menuOpen()}>
        <div ref={menu} id={menuId} class="viewer-tools-popup" role="menu" aria-label="Инструменты"
          style={{ left: `${menuPosition().left}px`, top: `${menuPosition().top}px` }} onKeyDown={onMenuKeyDown}>
          <button ref={menuItem} type="button" role="menuitem" aria-disabled={!props.eligible}
            onClick={openSetup}>Создать moview</button>
          <button ref={conversionMenuItem} type="button" role="menuitem" disabled={!props.task?.handle || !props.backfillEligible}
            onClick={() => { if (props.task?.handle && props.backfillEligible) { closeMenu(); setConversionTask(props.task); } }}>GIF → WebM</button>
          <button ref={taskProtocolMenuItem} type="button" role="menuitem" disabled={!canEditProtocol()}
            onClick={() => { if (canEditProtocol()) { closeMenu(); props.onCreateProtocol?.(trigger); } }}>Создать протокол</button>
          <Show when={!props.eligible}><p class="viewer-tools-disabled-reason">{props.disabledReason}</p></Show>
          <button ref={rangeMenuItem} type="button" role="menuitem" aria-disabled={!props.backfillEligible}
            onClick={openBackfill}>Дозаписать глобальные минмакс</button>
          <Show when={!props.backfillEligible}><p class="viewer-tools-disabled-reason">{props.backfillDisabledReason}</p></Show>
          <button ref={protocolsMenuItem} type="button" role="menuitem" disabled={Boolean(protocolsDisabledReason())}
            aria-disabled={Boolean(protocolsDisabledReason())} title={protocolsDisabledReason() || "Открыть HTML-протоколы текущего задания"}
            onClick={openProtocols}>Протоколы тестов</button>
          <Show when={protocolsDisabledReason()}><p class="viewer-tools-disabled-reason">{protocolsDisabledReason()}</p></Show>
          <button ref={conditionsMenuItem} type="button" role="menuitem" disabled={!props.backfillEligible}
            onClick={() => { if (props.backfillEligible) { closeMenu(); setConditionsOpen(true); } }}>Сохранить условия расчета</button>
        </div>
      </Show>
      <dialog ref={protocolsDialog} class="viewer-movie-dialog viewer-protocols-dialog" aria-labelledby={protocolsTitleId}
        aria-busy={protocolScanning() || Boolean(protocolOpening())}
        onCancel={event => { event.preventDefault(); closeProtocols(); }}
        onClose={() => { if (protocolsDialogOpen()) closeProtocols(); }}>
        <h2 id={protocolsTitleId}>Протоколы тестов</h2>
        <p class="viewer-movie-note">{props.task?.name} · comparison</p>
        <Show when={protocolScanning()}><p role="status">Поиск протоколов…</p></Show>
        <Show when={protocolScanError() || protocolOpenError()}>
          <p class="viewer-movie-error" role="alert">{protocolScanError() || protocolOpenError()}</p>
        </Show>
        <Show when={!protocolScanning() && !protocolScanError() && !protocols().length}><p>Протоколы не найдены.</p></Show>
        <div class="viewer-protocols-list">
          <For each={protocols()}>{entry => <button type="button" title="Открыть в новой вкладке браузера"
            disabled={Boolean(protocolOpening()) || !props.backfillEligible} onClick={() => void openProtocol(entry)}>{entry.path}</button>}</For>
        </div>
        <Show when={protocolOpening()}><p role="status">Открытие {protocolOpening()}…</p></Show>
        <div class="viewer-movie-actions">
          <button type="button" disabled={protocolScanning() || Boolean(protocolOpening())} onClick={() => void refreshProtocols()}>Обновить</button>
          <button ref={protocolsCloseButton} type="button" onClick={closeProtocols}>Закрыть</button>
        </div>
      </dialog>
      <dialog ref={dialog} class="viewer-movie-dialog" aria-labelledby={titleId}
        onCancel={event => { event.preventDefault(); closeDialog(); }}
        onClose={() => { if (dialogOpen()) closeDialog(); }}>
        <h2 id={titleId}>Создать moview</h2>
        <p class="viewer-movie-note">WebM · VP9 · CRF 30</p>
        <Show when={!running() && phase() !== "ready"}>
          <Show when={staticImage()} fallback={<p>Текущий вид · шаги 0–{Math.max(0, props.frameCount - 1)} · {props.frameCount} кадров.</p>}>
            <p>WebM — 1 кадр текущего вида.</p>
          </Show>
          <Show when={!staticImage()}>
            <label class="viewer-movie-interval">Интервал между кадрами, мс
              <input ref={intervalInput} type="number" min="20" max="60000" step="10" value={intervalMs()}
                onInput={event => setIntervalMs(event.currentTarget.valueAsNumber)} />
            </label>
            <p>Длительность WebM: {validInterval() ? duration() : "—"} с.</p>
          </Show>
          <p class="viewer-movie-note">Сохраняются камера и режим масштаба. Нормировка длин векторов 3D фиксирована; «Авто» графиков сохраняет выбранный режим. Подпись показывает время расчёта.</p>
        </Show>
        <Show when={running()}>
          <p role="status" aria-live="polite">{progressText()}</p>
          <progress max={Math.max(1, progress().total)} value={progress().completed} aria-label="Создание WebM" />
          <p class="viewer-movie-note">По завершении будет восстановлен исходный момент времени.</p>
        </Show>
        <Show when={result()}>{movie => <>
          <video class="viewer-movie-preview" src={movie().url} aria-label="Предпросмотр созданного WebM" autoplay loop muted controls playsinline />
          <p>{movie().frameCount === 1 ? "WebM — 1 кадр" : `${movie().frameCount} кадров`} · {movie().width} × {movie().height}</p>
        </>}</Show>
        <Show when={error()}><p class="viewer-movie-error" role="alert">{error()}</p></Show>
        <Show when={saving()}><p class="viewer-movie-note" role="status">Сохранение WebM в задании…</p></Show>
        <Show when={savedNotice()}><p class="viewer-movie-saved" role="status">{savedNotice()}</p></Show>
        <div class="viewer-movie-actions">
          <Show when={running()} fallback={<>
            <Show when={result()} fallback={<button ref={startButton} type="button" disabled={!props.eligible || !validInterval()} onClick={startCapture}>Начать</button>}>
              <Show when={saveInTask()} fallback={<a ref={saveButton} class="viewer-movie-save" href={result()?.url} download={result()?.filename}>Сохранить WebM</a>}>
                <button ref={saveButton} type="button" class="viewer-movie-save" disabled={saving()} onClick={saveToTask}>Сохранить WebM</button>
              </Show>
              <label class="viewer-movie-task-save"><input type="checkbox" checked={saveInTask()} disabled={saving()}
                onChange={event => changeSaveLocation(event.currentTarget.checked)} />в задании</label>
            </Show>
            <button type="button" disabled={saving()} onClick={closeDialog}>Закрыть</button>
          </>}>
            <button ref={cancelButton} type="button" disabled={phase() === "cancelling"} onClick={() => cancelCapture(false)}>Отмена</button>
          </Show>
        </div>
      </dialog>
      <dialog ref={backfillDialog} class="viewer-movie-dialog viewer-backfill-dialog"
        aria-label="Дозаписать глобальные минмакс"
        onCancel={event => { event.preventDefault(); closeBackfill(); }}
        onClose={() => { if (backfillDialogOpen() && !backfillRunning()) closeBackfill(); }}>
        <h2>Дозаписать глобальные минмакс</h2>
        <p>Для H5 текущего задания без <code>HEADER/RANGES</code> будут вычислены диапазоны по всем сохранённым шагам и полной выходной сетке.</p>
        <p class="viewer-movie-note">Существующие complete/partial/stale/повреждённые RANGES не перезаписываются. Каждый файл сначала изменяется во временной WASM-копии, повторно проверяется и только затем заменяет исходный файл.</p>
        <Show when={backfillRunning()}>
          <p role="status">{backfillProgressText()}</p>
          <progress max={Math.max(1, backfillProgress()?.files ?? 1)} value={Math.max(0, (backfillProgress()?.file ?? 1) - 1)} />
        </Show>
        <Show when={backfillError()}><p class="viewer-movie-error" role="alert">{backfillError()}</p></Show>
        <Show when={backfillSummary().length}>
          <div class="viewer-backfill-summary">
            <For each={backfillSummary()}>{item => <div>
              <Show when={item.name} fallback={item.message}><><b>{item.name}.h5</b> — {item.message}</></Show>
            </div>}</For>
          </div>
        </Show>
        <div class="viewer-movie-actions">
          <Show when={backfillRunning()} fallback={<>
            <button type="button" disabled={!props.backfillEligible || backfillSummary().some(item => item.state === "created")}
              onClick={startBackfill}>Выполнить</button>
            <button type="button" onClick={closeBackfill}>Закрыть</button>
          </>}>
            <button type="button" onClick={() => backfillAbort?.abort()}>Отмена</button>
          </Show>
        </div>
      </dialog>
    </Portal>
  </>;
}
