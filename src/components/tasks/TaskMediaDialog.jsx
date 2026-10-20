import { createEffect, createSignal, createUniqueId, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import "./TaskGifGallery.css";

// One window shell for GIF, documentation images and plain text.
export function TaskMediaDialog(props) {
  const titleId = createUniqueId();
  const [dialogPosition, setDialogPosition] = createSignal(null);
  const [maximized, setMaximized] = createSignal(true);
  const [dialogSize, setDialogSize] = createSignal(null);
  let dialog, dialogHeader, closeButton, drag, restoreBounds;
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
  }
  function toggleMaximized() {
    stopDrag();
    if (maximized()) {
      setMaximized(false);
      if (restoreBounds) {
        const width = Math.min(restoreBounds.width, window.innerWidth - 16);
        const height = Math.min(restoreBounds.height, window.innerHeight - 16);
        setDialogSize({ width, height });
        setDialogPosition({ left: Math.max(8, Math.min(restoreBounds.left, window.innerWidth - width - 8)),
          top: Math.max(8, Math.min(restoreBounds.top, window.innerHeight - height - 8)) });
      }
    } else { restoreBounds = dialog?.getBoundingClientRect(); setMaximized(true); }
  }
  function previewKeyDown(event) {
    if (!props.showNavigation || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || event.isComposing
      || event.target?.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(event.target?.tagName)) return;
    const direction = event.code === "ArrowLeft" ? -1 : event.code === "ArrowRight" ? 1 : 0;
    if (!direction) return;
    event.preventDefault(); event.stopPropagation();
    if (direction === -1 ? props.canPrevious : props.canNext) props.onNavigate?.(direction);
  }
  createEffect(() => {
    if (!dialog) return;
    if (props.open) {
      if (!dialog.open) {
        setDialogPosition(null); setDialogSize(null); setMaximized(true); restoreBounds = null;
        dialog.showModal(); closeButton?.focus();
      }
    } else {
      stopDrag();
      if (dialog.open) {
        dialog.close();
        const opener = props.opener?.();
        if (opener?.isConnected) opener.focus();
      }
    }
  });
  onMount(() => {
    window.addEventListener("resize", clampPreview);
    window.addEventListener("blur", stopDrag);
    onCleanup(() => {
      window.removeEventListener("resize", clampPreview);
      window.removeEventListener("blur", stopDrag);
    });
  });
  onCleanup(() => { stopDrag(); if (dialog?.open) dialog.close(); });

  return <Portal>
    <dialog ref={dialog} class="task-gif-dialog" aria-labelledby={titleId} onKeyDown={previewKeyDown}
      classList={{ "is-maximized": maximized() }}
      style={maximized() ? { left: "8px", top: "8px", right: "auto", bottom: "auto", margin: "0",
        width: "calc(100vw - 16px)", height: "calc(100dvh - 16px)" } : {
        ...(dialogPosition() ? { left: `${dialogPosition().left}px`, top: `${dialogPosition().top}px`, right: "auto", bottom: "auto", margin: "0" } : {}),
        ...(dialogSize() ? { width: `${dialogSize().width}px`, height: `${dialogSize().height}px` } : {}),
      }}
      onCancel={event => { event.preventDefault(); props.onClose(); }}
      onClose={() => { if (props.open && !dialog.open) props.onClose(); }}>
      <header ref={dialogHeader} class="task-gif-dialog-header" onPointerDown={startDrag} onPointerMove={moveDrag}
        onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}>
        <h2 id={titleId} title={props.title}>{props.title}</h2>
        <button type="button" title={maximized() ? "Восстановить размер" : "Максимальный размер окна"}
          aria-label={maximized() ? "Восстановить размер" : "Максимальный размер окна"}
          onClick={toggleMaximized}>{maximized() ? "❐" : "□"}</button>
        <button ref={closeButton} type="button" title="Закрыть" aria-label={props.closeLabel ?? "Закрыть просмотр"}
          onClick={() => props.onClose()}>×</button>
      </header>
      <div class="task-gif-preview-body">
        <Show when={props.showNavigation}>
          <button type="button" class="task-gif-navigation-button is-previous"
            title={props.previousLabel} aria-label={props.previousLabel} disabled={!props.canPrevious}
            onClick={() => props.onNavigate(-1)}>‹</button>
          <button type="button" class="task-gif-navigation-button is-next"
            title={props.nextLabel} aria-label={props.nextLabel} disabled={!props.canNext}
            onClick={() => props.onNavigate(1)}>›</button>
        </Show>
        {props.renderBody(maximized)}
      </div>
    </dialog>
  </Portal>;
}
