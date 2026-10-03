import { createEffect, createSignal, createUniqueId, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { saveTaskGif } from "../../services/taskGifService.js";
import "./ViewerToolsMenu.css";

export function ViewerToolsMenu(props) {
  const menuId = createUniqueId(), titleId = createUniqueId();
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuPosition, setMenuPosition] = createSignal({ left: 8, top: 8 });
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [phase, setPhase] = createSignal("setup");
  const [intervalMs, setIntervalMs] = createSignal(100);
  const [progress, setProgress] = createSignal({ phase: "preparing", completed: 0, total: 0, step: null });
  const [error, setError] = createSignal("");
  const [result, setResult] = createSignal(null);
  const [saveInTask, setSaveInTask] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [savedNotice, setSavedNotice] = createSignal("");
  let trigger, menu, menuItem, dialog, intervalInput, cancelButton, saveButton;
  let runAbort, saveAbort, revision = 0, disposed = false;
  let openedTask, openedTab, closeAfterRun = false, closeAfterSave = false;
  const running = () => phase() === "running" || phase() === "cancelling";
  const validInterval = () => Number.isInteger(intervalMs()) && intervalMs() >= 20
    && intervalMs() <= 60000 && intervalMs() % 10 === 0;
  const duration = () => (props.frameCount * intervalMs() / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 2 });

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
    setMenuOpen(true);
    queueMicrotask(() => { if (menuOpen() && !disposed) { positionMenu(); menuItem?.focus(); } });
  }
  function openSetup() {
    if (!props.eligible || running() || saving()) return;
    closeMenu(); discardResult(); setError(""); setPhase("setup");
    setSaveInTask(false); setSavedNotice("");
    openedTask = props.task; openedTab = props.tabIndex; closeAfterRun = false;
    setDialogOpen(true);
    queueMicrotask(() => intervalInput?.focus());
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
      const movie = await props.onRun({ intervalMs: intervalMs(), signal: abort.signal,
        onProgress: value => { if (!disposed && current === revision) setProgress(value); } });
      if (disposed || current !== revision || abort.signal.aborted) return;
      if (!(movie?.blob instanceof Blob) || movie.blob.size === 0) throw new Error("Не удалось сформировать GIF.");
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
          else queueMicrotask(() => intervalInput?.focus());
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
        setError(failure?.name === "AbortError" ? "Сохранение отменено. GIF доступен для повторного сохранения."
          : failure?.message ?? String(failure));
      }
    } finally {
      if (current === revision) {
        saveAbort = null; setSaving(false); props.onBusyChange?.(false);
        if (!disposed && closeAfterSave) closeDialog();
      }
    }
  }
  function onTriggerKeyDown(event) {
    if (event.code === "ArrowDown" || event.code === "ArrowUp") {
      event.preventDefault(); if (!menuOpen()) toggleMenu(); else menuItem?.focus();
    } else if (event.code === "Escape" && menuOpen()) {
      event.preventDefault(); closeMenu(true);
    }
  }
  function onMenuKeyDown(event) {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.code)) {
      event.preventDefault(); menuItem?.focus();
    } else if (event.code === "Escape") {
      event.preventDefault(); event.stopPropagation(); closeMenu(true);
    } else if (event.code === "Tab") closeMenu(true);
  }
  const progressText = () => {
    const current = progress();
    if (phase() === "cancelling") return "Отмена и восстановление вида…";
    if (current.phase === "encoding") return "Формирование GIF…";
    if (current.phase === "restoring") return "Восстановление исходного вида…";
    if (current.phase === "capturing") return `Кадр ${current.completed} из ${current.total}`;
    return "Подготовка кадров…";
  };

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
    disposed = true; runAbort?.abort(); saveAbort?.abort(); discardResult();
    if (dialog?.open) dialog.close();
  });

  return <>
    <button ref={trigger} type="button" class="viewer-tools-trigger" aria-haspopup="menu" aria-expanded={menuOpen()}
      aria-controls={menuId} onClick={toggleMenu} onKeyDown={onTriggerKeyDown}>Инструменты</button>
    <Portal>
      <Show when={menuOpen()}>
        <div ref={menu} id={menuId} class="viewer-tools-popup" role="menu" aria-label="Инструменты"
          style={{ left: `${menuPosition().left}px`, top: `${menuPosition().top}px` }} onKeyDown={onMenuKeyDown}>
          <button ref={menuItem} type="button" role="menuitem" aria-disabled={!props.eligible}
            onClick={openSetup}>Создать moview</button>
          <Show when={!props.eligible}><p class="viewer-tools-disabled-reason">{props.disabledReason}</p></Show>
        </div>
      </Show>
      <dialog ref={dialog} class="viewer-movie-dialog" aria-labelledby={titleId}
        onCancel={event => { event.preventDefault(); closeDialog(); }}
        onClose={() => { if (dialogOpen()) closeDialog(); }}>
        <h2 id={titleId}>Создать moview</h2>
        <Show when={!running() && phase() !== "ready"}>
          <p>Текущий вид · шаги 0–{Math.max(0, props.frameCount - 1)} · {props.frameCount} кадров.</p>
          <label class="viewer-movie-interval">Интервал между кадрами, мс
            <input ref={intervalInput} type="number" min="20" max="60000" step="10" value={intervalMs()}
              onInput={event => setIntervalMs(event.currentTarget.valueAsNumber)} />
          </label>
          <p>Длительность GIF: {validInterval() ? duration() : "—"} с.</p>
          <p class="viewer-movie-note">Сохраняются камера и режим масштаба; «Авто» действует на каждом кадре. Размер кадра ограничен для GIF, подпись показывает время расчёта.</p>
        </Show>
        <Show when={running()}>
          <p role="status" aria-live="polite">{progressText()}</p>
          <progress max={Math.max(1, progress().total)} value={progress().completed} aria-label="Создание GIF" />
          <p class="viewer-movie-note">По завершении будет восстановлен исходный момент времени.</p>
        </Show>
        <Show when={result()}>{movie => <>
          <img class="viewer-movie-preview" src={movie().url} alt="Предпросмотр созданной анимации GIF" />
          <p>{movie().frameCount} кадров · {movie().width} × {movie().height}</p>
        </>}</Show>
        <Show when={error()}><p class="viewer-movie-error" role="alert">{error()}</p></Show>
        <Show when={saving()}><p class="viewer-movie-note" role="status">Сохранение GIF в задании…</p></Show>
        <Show when={savedNotice()}><p class="viewer-movie-saved" role="status">{savedNotice()}</p></Show>
        <div class="viewer-movie-actions">
          <Show when={running()} fallback={<>
            <Show when={result()} fallback={<button type="button" disabled={!props.eligible || !validInterval()} onClick={startCapture}>Начать</button>}>
              <Show when={saveInTask()} fallback={<a ref={saveButton} class="viewer-movie-save" href={result()?.url} download={result()?.filename}>Сохранить GIF</a>}>
                <button ref={saveButton} type="button" class="viewer-movie-save" disabled={saving()} onClick={saveToTask}>Сохранить GIF</button>
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
    </Portal>
  </>;
}
