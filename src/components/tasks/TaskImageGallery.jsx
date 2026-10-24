import { createEffect, createSignal, createUniqueId, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { TaskMediaDialog } from "./TaskMediaDialog.jsx";
import "./TaskGifGallery.css";

export function TaskImageGallery(props) {
  const titleId = createUniqueId();
  const [view, setView] = createSignal({ entries: [], thumbnails: {}, loading: false, error: "", deleting: null, preview: null });
  const [deleteRequest, setDeleteRequest] = createSignal(null);
  const controller = props.createController({ publish: setView });
  let grid, opener, observer;
  let confirmDialog, confirmCancelButton, deleteOpener;
  let disposed = false, deleteBusy = false;
  let previousTask, previousActive, previousRefreshKey, initialized = false;
  const cells = new Map();
  const enabled = () => props.active !== false && Boolean(props.taskHandle) && props.visible !== false;
  const actionsDisabled = () => !enabled() || props.disabled || Boolean(view().deleting);
  const canNavigate = direction => {
    const index = view().entries.findIndex(entry => entry.name === view().preview?.entry.name);
    return !actionsDisabled() && index >= 0 && Boolean(view().entries[index + direction]);
  };
  function updateFallbackVisibility() {
    if (observer || !grid || disposed) return;
    const bounds = grid.getBoundingClientRect();
    for (const [element, entry] of cells) {
      const rect = element.getBoundingClientRect();
      controller.setVisible(entry, enabled() && bounds.width > 0 && bounds.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom
        && rect.right > bounds.left && rect.left < bounds.right);
    }
  }
  function watchCell(element, entry) {
    cells.set(element, entry);
    if (observer) observer.observe(element);
    else queueMicrotask(updateFallbackVisibility);
    return () => { observer?.unobserve(element); cells.delete(element); controller.setVisible(entry, false); };
  }
  function showPreview(entry, event) {
    if (actionsDisabled()) return;
    opener = event.currentTarget; controller.openPreview(entry);
  }
  function requestDelete(entry, event) {
    if (!props.allowDelete || actionsDisabled() || deleteBusy) return;
    deleteOpener = event.currentTarget;
    setDeleteRequest({ entry, task: props.taskHandle });
    queueMicrotask(() => confirmCancelButton?.focus());
  }
  async function confirmDelete() {
    const request = deleteRequest();
    if (!request) return;
    setDeleteRequest(null);
    if (disposed || !props.allowDelete || props.taskHandle !== request.task || actionsDisabled() || deleteBusy
      || !view().entries.includes(request.entry)) return;
    // This is a fresh, explicit Delete click. Its transient activation remains
    // available to requestPermission even after reading the confirmation slowly.
    deleteBusy = true; props.onBusyChange?.(true);
    try { await controller.deleteEntry(request.entry); }
    finally {
      if (deleteBusy) { deleteBusy = false; props.onBusyChange?.(false); }
    }
  }
  function ImageCell(cellProps) {
    const thumbnail = () => view().thumbnails[cellProps.entry.name] ?? {};
    let cell, unwatch;
    onMount(() => { unwatch = watchCell(cell, cellProps.entry); });
    onCleanup(() => unwatch?.());
    return <article ref={cell} class="task-gif-cell">
      <button type="button" class="task-gif-thumbnail" disabled={actionsDisabled()}
        title={`Открыть ${cellProps.entry.name}`} aria-label={`Открыть ${cellProps.entry.name}`}
        onClick={event => { event.stopPropagation(); showPreview(cellProps.entry, event); }}>
        <Show when={thumbnail().url} fallback={<span class="task-gif-placeholder" title={thumbnail().error || undefined}>
          {thumbnail().error ? "Не удалось прочитать изображение" : thumbnail().loading ? "Загрузка…" : props.label}
        </span>}>
          <Show when={/\.webm$/i.test(cellProps.entry.name)} fallback={
            <img src={thumbnail().url} alt="" loading="lazy" decoding="async"
              onError={event => controller.thumbnailFailed(cellProps.entry, event.currentTarget.getAttribute("src"))} />}>
            <video src={thumbnail().url} autoplay loop muted playsinline aria-label={cellProps.entry.name}
              onError={event => controller.thumbnailFailed(cellProps.entry, event.currentTarget.getAttribute("src"))} />
          </Show>
        </Show>
      </button>
      <div class="task-gif-cell-actions">
        <button type="button" disabled={actionsDisabled()} title={`Открыть ${cellProps.entry.name}`} aria-label={`Открыть ${cellProps.entry.name}`}
          onClick={event => { event.stopPropagation(); showPreview(cellProps.entry, event); }}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12 3h5v5M17 3l-8 8M8 4H4v12h12v-4" /></svg>
        </button>
        <Show when={props.allowDelete}>
        <button type="button" disabled={actionsDisabled()} title={`Удалить ${cellProps.entry.name}`} aria-label={`Удалить ${cellProps.entry.name}`}
          onClick={event => { event.stopPropagation(); requestDelete(cellProps.entry, event); }}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M7 5V3h6v2M6 5l1 12h6l1-12M9 8v6M11 8v6" /></svg>
        </button>
        </Show>
      </div>
      <div class="task-gif-filename" title={cellProps.entry.name}>{cellProps.entry.name}</div>
    </article>;
  }

  createEffect(() => {
    controller.setDisplayActive(props.visible !== false);
    queueMicrotask(updateFallbackVisibility);
  });
  createEffect(() => { props.onCountChange?.(view().entries.length); });
  createEffect(() => {
    const task = props.taskHandle, active = props.active !== false, refreshKey = props.refreshKey;
    const sameContext = initialized && task === previousTask && active === previousActive;
    controller.setContext(task, active);
    if (sameContext && refreshKey !== previousRefreshKey) controller.refresh();
    previousTask = task; previousActive = active; previousRefreshKey = refreshKey; initialized = true;
  });
  createEffect(() => {
    let request = deleteRequest();
    if (request && (props.taskHandle !== request.task || !enabled() || props.disabled
      || !view().entries.includes(request.entry))) { setDeleteRequest(null); request = null; }
    if (!confirmDialog) return;
    if (request) { if (!confirmDialog.open) confirmDialog.showModal(); }
    else if (confirmDialog.open) {
      confirmDialog.close(); if (deleteOpener?.isConnected) deleteOpener.focus();
    }
  });
  onMount(() => {
    if (typeof IntersectionObserver === "function") {
      observer = new IntersectionObserver(items => {
        for (const item of items) {
          const entry = cells.get(item.target);
          if (entry) controller.setVisible(entry, enabled() && item.isIntersecting && item.intersectionRatio > 0);
        }
      }, { root: grid, threshold: 0.001 });
      for (const cell of cells.keys()) observer.observe(cell);
    }
    const refresh = () => controller.refresh();
    const unsubscribe = props.subscribe?.(refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("resize", updateFallbackVisibility);
    onCleanup(() => {
      unsubscribe?.(); window.removeEventListener("focus", refresh);
      window.removeEventListener("resize", updateFallbackVisibility);
    });
    updateFallbackVisibility();
  });
  onCleanup(() => {
    disposed = true; observer?.disconnect(); cells.clear(); controller.dispose();
    if (confirmDialog?.open) confirmDialog.close();
    if (deleteBusy) { deleteBusy = false; props.onBusyChange?.(false); }
  });

  return <section class="task-gif-gallery" aria-label={`${props.label} выбранного задания`}>
    <header class="task-gif-gallery-header"><span>{props.label} <span class="task-gif-count">{view().entries.length}</span>
      <Show when={view().deleting}><span class="task-gif-count" role="status">Удаление…</span></Show>
    </span>
      <button type="button" disabled={actionsDisabled() || view().loading} title={`Обновить список ${props.label}`} aria-label={`Обновить список ${props.label}`}
        onClick={() => { controller.refresh(); props.onRefresh?.(); }}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 8a6 6 0 1 0 0 5M16 3v5h-5" /></svg>
      </button>
    </header>
    <Show when={view().error}><div class="task-gif-error" role="alert">{view().error}</div></Show>
    <div ref={grid} class="task-gif-grid" onScroll={updateFallbackVisibility} aria-busy={view().loading}>
      <For each={view().entries}>{entry => <ImageCell entry={entry} />}</For>
      <Show when={view().entries.length === 0}><p class="task-gif-empty" role="status">
        {!props.taskHandle ? "Выберите задание" : view().loading ? `Чтение списка ${props.label}…` : view().error ? `Список ${props.label} недоступен` : props.emptyMessage}
      </p></Show>
    </div>
    <TaskMediaDialog open={Boolean(view().preview)} title={view().preview?.entry.name} opener={() => opener}
      onClose={() => controller.closePreview()} closeLabel={`Закрыть просмотр ${props.label}`}
      showNavigation={view().entries.length > 1} canPrevious={canNavigate(-1)} canNext={canNavigate(1)}
      onNavigate={direction => controller.navigatePreview(direction)}
      previousLabel={props.label === "GIF" ? "Предыдущий GIF" : "Предыдущее изображение"}
      nextLabel={props.label === "GIF" ? "Следующий GIF" : "Следующее изображение"}
      renderBody={maximized => <Show when={view().preview?.url} fallback={<p role={view().preview?.error ? "alert" : "status"}>
        {view().preview?.error || "Загрузка…"}
      </p>}>
        {props.renderPreview ? props.renderPreview(() => view().preview, maximized) :
          <img src={view().preview?.url} alt={view().preview?.entry.name}
            onError={event => controller.previewFailed(event.currentTarget.getAttribute("src"))} />}
      </Show>} />

    <Show when={props.allowDelete}><Portal>
      <dialog ref={confirmDialog} class="task-gif-confirm" aria-labelledby={`${titleId}-delete`}
        onCancel={event => { event.preventDefault(); setDeleteRequest(null); }} onClose={() => setDeleteRequest(null)}>
        <h2 id={`${titleId}-delete`}>Удалить файл?</h2>
        <p>Файл: <strong>{deleteRequest()?.entry.name}</strong></p>
        <p>Задание: {deleteRequest()?.task.name || "выбранное задание"}</p>
        <div class="task-gif-confirm-actions">
          <button type="button" onClick={confirmDelete}>Удалить</button>
          <button ref={confirmCancelButton} type="button" onClick={() => setDeleteRequest(null)}>Отмена</button>
        </div>
      </dialog>

    </Portal></Show>
  </section>;
}
