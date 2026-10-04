import { createEffect, createSignal, createUniqueId, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { createTaskGifGalleryController } from "../../services/taskGifGalleryController.js";
import { subscribeTaskGifs } from "../../services/taskGifService.js";
import { TaskGifPlayer } from "./TaskGifPlayer.jsx";
import "./TaskGifGallery.css";

export function TaskGifGallery(props) {
  const titleId = createUniqueId();
  const [view, setView] = createSignal({ entries: [], thumbnails: {}, loading: false, error: "", deleting: null, preview: null });
  const [dialogPosition, setDialogPosition] = createSignal(null);
  const [maximized,setMaximized]=createSignal(false);
  const [dialogSize,setDialogSize]=createSignal(null);
  let restoreBounds=null;
  const [deleteRequest, setDeleteRequest] = createSignal(null);
  const controller = createTaskGifGalleryController({ publish: setView });
  let grid, dialog, dialogHeader, closeButton, opener, observer, drag;
  let confirmDialog, confirmCancelButton, deleteOpener;
  let disposed = false, deleteBusy = false;
  let previousTask, previousActive, previousRefreshKey, initialized = false;
  const cells = new Map();
  const enabled = () => props.active !== false && Boolean(props.taskHandle);
  const actionsDisabled = () => !enabled() || props.disabled || Boolean(view().deleting);

  function updateFallbackVisibility() {
    if (observer || !grid || disposed) return;
    const bounds = grid.getBoundingClientRect();
    for (const [element, entry] of cells) {
      const rect = element.getBoundingClientRect();
      controller.setVisible(entry, rect.bottom > bounds.top && rect.top < bounds.bottom
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
    opener = event.currentTarget; setDialogPosition(null); setMaximized(false); setDialogSize(null);
    restoreBounds=null; controller.openPreview(entry);
  }
  function requestDelete(entry, event) {
    if (actionsDisabled() || deleteBusy) return;
    deleteOpener = event.currentTarget;
    setDeleteRequest({ entry, task: props.taskHandle });
    queueMicrotask(() => confirmCancelButton?.focus());
  }
  async function confirmDelete() {
    const request = deleteRequest();
    if (!request) return;
    setDeleteRequest(null);
    if (disposed || props.taskHandle !== request.task || actionsDisabled() || deleteBusy
      || !view().entries.includes(request.entry)) return;
    // This is a fresh, explicit Delete click. Its transient activation remains
    // available to requestPermission even after reading the confirmation slowly.
    deleteBusy = true; props.onBusyChange?.(true);
    try { await controller.deleteEntry(request.entry); }
    finally {
      if (deleteBusy) { deleteBusy = false; props.onBusyChange?.(false); }
    }
  }
  function stopDrag() {
    if (!drag) return;
    const pointerId = drag.pointerId; drag = null;
    if (dialogHeader?.hasPointerCapture?.(pointerId)) dialogHeader.releasePointerCapture(pointerId);
  }
  function clampPosition(left, top) {
    const bounds = dialog?.getBoundingClientRect();
    if (!bounds) return;
    setDialogPosition({ left: Math.max(0, Math.min(left, Math.max(0, window.innerWidth - bounds.width))),
      top: Math.max(0, Math.min(top, Math.max(0, window.innerHeight - bounds.height))) });
  }
  function startDrag(event) {
    if (maximized() || event.button !== 0 || event.isPrimary === false || event.target.closest?.("button")) return;
    const bounds = dialog?.getBoundingClientRect();
    if (!bounds) return;
    event.preventDefault();
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top };
    dialogHeader?.setPointerCapture?.(event.pointerId);
  }
  function moveDrag(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    clampPosition(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
  }
  function clampPreview() {
    if (dialogPosition()) clampPosition(dialogPosition().left, dialogPosition().top);
    updateFallbackVisibility();
  }
  function toggleMaximized() {
    stopDrag();
    if(maximized()) {
      setMaximized(false);
      const r=restoreBounds;
      if(r) {
        const width=Math.min(r.width,window.innerWidth-16),height=Math.min(r.height,window.innerHeight-16);
        setDialogSize({width,height});
        setDialogPosition({left:Math.max(8,Math.min(r.left,window.innerWidth-width-8)),
          top:Math.max(8,Math.min(r.top,window.innerHeight-height-8))});
      }
    } else { restoreBounds=dialog?.getBoundingClientRect();setMaximized(true); }
  }
  function GifCell(cellProps) {
    const thumbnail = () => view().thumbnails[cellProps.entry.name] ?? {};
    let cell, unwatch;
    onMount(() => { unwatch = watchCell(cell, cellProps.entry); });
    onCleanup(() => unwatch?.());
    return <article ref={cell} class="task-gif-cell">
      <div class="task-gif-thumbnail">
        <Show when={thumbnail().url} fallback={<span class="task-gif-placeholder" title={thumbnail().error || undefined}>
          {thumbnail().error ? "Не удалось прочитать GIF" : thumbnail().loading ? "Загрузка…" : "GIF"}
        </span>}>
          <img src={thumbnail().url} alt="" loading="lazy" decoding="async"
            onError={event => controller.thumbnailFailed(cellProps.entry, event.currentTarget.getAttribute("src"))} />
        </Show>
      </div>
      <div class="task-gif-cell-actions">
        <button type="button" disabled={actionsDisabled()} title={`Открыть ${cellProps.entry.name}`} aria-label={`Открыть ${cellProps.entry.name}`}
          onClick={event => { event.stopPropagation(); showPreview(cellProps.entry, event); }}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12 3h5v5M17 3l-8 8M8 4H4v12h12v-4" /></svg>
        </button>
        <button type="button" disabled={actionsDisabled()} title={`Удалить ${cellProps.entry.name}`} aria-label={`Удалить ${cellProps.entry.name}`}
          onClick={event => { event.stopPropagation(); requestDelete(cellProps.entry, event); }}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M7 5V3h6v2M6 5l1 12h6l1-12M9 8v6M11 8v6" /></svg>
        </button>
      </div>
      <div class="task-gif-filename" title={cellProps.entry.name}>{cellProps.entry.name}</div>
    </article>;
  }

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
  createEffect(() => {
    const preview = view().preview;
    if (!dialog) return;
    if (preview) {
      if (!dialog.open) { dialog.showModal(); closeButton?.focus(); }
    } else {
      stopDrag();
      if (dialog.open) { dialog.close(); if (opener?.isConnected) opener.focus(); }
    }
  });
  onMount(() => {
    if (typeof IntersectionObserver === "function") {
      observer = new IntersectionObserver(items => {
        for (const item of items) {
          const entry = cells.get(item.target);
          if (entry) controller.setVisible(entry, item.isIntersecting && item.intersectionRatio > 0);
        }
      }, { root: grid, threshold: 0.001 });
      for (const cell of cells.keys()) observer.observe(cell);
    }
    const refresh = () => controller.refresh();
    const blur = () => stopDrag();
    const unsubscribe = subscribeTaskGifs(refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("resize", clampPreview);
    window.addEventListener("blur", blur);
    onCleanup(() => {
      unsubscribe(); window.removeEventListener("focus", refresh);
      window.removeEventListener("resize", clampPreview); window.removeEventListener("blur", blur);
    });
    updateFallbackVisibility();
  });
  onCleanup(() => {
    disposed = true; observer?.disconnect(); cells.clear(); stopDrag(); controller.dispose();
    if (dialog?.open) dialog.close();
    if (confirmDialog?.open) confirmDialog.close();
    if (deleteBusy) { deleteBusy = false; props.onBusyChange?.(false); }
  });

  return <section class="task-gif-gallery" aria-label="GIF выбранного задания">
    <header class="task-gif-gallery-header"><span>GIF <span class="task-gif-count">{view().entries.length}</span>
      <Show when={view().deleting}><span class="task-gif-count" role="status">Удаление…</span></Show>
    </span>
      <button type="button" disabled={actionsDisabled() || view().loading} title="Обновить список GIF" aria-label="Обновить список GIF"
        onClick={() => controller.refresh()}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 8a6 6 0 1 0 0 5M16 3v5h-5" /></svg>
      </button>
    </header>
    <Show when={view().error}><div class="task-gif-error" role="alert">{view().error}</div></Show>
    <div ref={grid} class="task-gif-grid" onScroll={updateFallbackVisibility} aria-busy={view().loading}>
      <For each={view().entries}>{entry => <GifCell entry={entry} />}</For>
      <Show when={view().entries.length === 0}><p class="task-gif-empty" role="status">
        {!props.taskHandle ? "Выберите задание" : view().loading ? "Чтение списка GIF…" : view().error ? "Список GIF недоступен" : "GIF-файлов нет"}
      </p></Show>
    </div>
    <Portal>
      <dialog ref={confirmDialog} class="task-gif-confirm" aria-labelledby={`${titleId}-delete`}
        onCancel={event => { event.preventDefault(); setDeleteRequest(null); }} onClose={() => setDeleteRequest(null)}>
        <h2 id={`${titleId}-delete`}>Удалить GIF?</h2>
        <p>Файл: <strong>{deleteRequest()?.entry.name}</strong></p>
        <p>Задание: {deleteRequest()?.task.name || "выбранное задание"}</p>
        <div class="task-gif-confirm-actions">
          <button type="button" onClick={confirmDelete}>Удалить</button>
          <button ref={confirmCancelButton} type="button" onClick={() => setDeleteRequest(null)}>Отмена</button>
        </div>
      </dialog>
      <dialog ref={dialog} class="task-gif-dialog" aria-labelledby={titleId}
        classList={{"is-maximized":maximized()}}
        style={maximized() ? {left:"8px",top:"8px",right:"auto",bottom:"auto",margin:"0",width:"calc(100vw - 16px)",height:"calc(100dvh - 16px)"} : {
          ...(dialogPosition() ? { left: `${dialogPosition().left}px`, top: `${dialogPosition().top}px`, right: "auto", bottom: "auto", margin: "0" } : {}),
          ...(dialogSize() ? {width:`${dialogSize().width}px`,height:`${dialogSize().height}px`} : {})}}
        onCancel={event => { event.preventDefault(); controller.closePreview(); }}
        onClose={() => { if (view().preview) controller.closePreview(); }}>
        <header ref={dialogHeader} class="task-gif-dialog-header" onPointerDown={startDrag} onPointerMove={moveDrag}
          onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}>
          <h2 id={titleId} title={view().preview?.entry.name}>{view().preview?.entry.name}</h2>
          <button type="button" title={maximized()?"Восстановить размер":"Максимальный размер окна"}
            aria-label={maximized()?"Восстановить размер":"Максимальный размер окна"} onClick={toggleMaximized}>{maximized()?"❐":"□"}</button>
          <button ref={closeButton} type="button" title="Закрыть" aria-label="Закрыть просмотр GIF" onClick={() => controller.closePreview()}>×</button>
        </header>
        <div class="task-gif-preview-body">
          <Show when={view().preview?.url} fallback={<p role={view().preview?.error ? "alert" : "status"}>
            {view().preview?.error || "Загрузка…"}
          </p>}>
            <TaskGifPlayer url={view().preview?.url} name={view().preview?.entry.name} />
          </Show>
        </div>
      </dialog>
    </Portal>
  </section>;
}
