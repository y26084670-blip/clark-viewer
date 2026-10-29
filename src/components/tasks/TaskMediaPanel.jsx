import { createMemo, createSignal, createUniqueId } from "solid-js";
import { TaskGifGallery } from "./TaskGifGallery.jsx";
import { TaskDocsGallery } from "./TaskDocsGallery.jsx";
import "./TaskMediaPanel.css";

export function TaskMediaPanel(props) {
  const id = createUniqueId();
  const [tab, setTab] = createSignal("gif");
  const [gifCount, setGifCount] = createSignal(0), [docsCount, setDocsCount] = createSignal(0);
  const [gifLoading, setGifLoading] = createSignal(false), [docsLoading, setDocsLoading] = createSignal(false);
  const [gifRevision, setGifRevision] = createSignal(0), [docsRevision, setDocsRevision] = createSignal(0);
  const gifRefreshKey = createMemo(() => [props.refreshKey, gifRevision()]);
  const docsRefreshKey = createMemo(() => [props.refreshKey, docsRevision()]);
  const [busy, setBusy] = createSignal(false);
  const disabled = () => props.disabled || busy();
  const refreshDisabled = () => disabled() || props.active === false || !props.taskHandle;
  function busyChanged(value) { setBusy(value); props.onBusyChange?.(value); }
  let gifButton, docsButton;
  function tabKeyDown(event) {
    if (event.target !== gifButton && event.target !== docsButton) return;
    if (disabled() || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    let next;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") next = tab() === "gif" ? "docs" : "gif";
    else if (event.key === "Home") next = "gif";
    else if (event.key === "End") next = "docs";
    if (!next) return;
    event.preventDefault(); event.stopPropagation(); setTab(next);
    (next === "gif" ? gifButton : docsButton)?.focus();
  }
  return <section class="task-results-panel task-media-panel" aria-label="Результаты и документация выбранного задания">
    <div class="task-media-tabs" role="tablist" aria-label="Материалы выбранного задания" onKeyDown={tabKeyDown}>
      <div class="task-media-tab" classList={{ "is-active": tab() === "gif" }} role="presentation">
      <button ref={gifButton} type="button" role="tab" id={`${id}-gif-tab`} aria-controls={`${id}-gif-panel`}
        aria-selected={tab() === "gif"} tabIndex={tab() === "gif" ? 0 : -1} disabled={disabled()}
        onClick={() => setTab("gif")}>GIF ({gifCount()})</button>
      <button type="button" class="task-media-refresh" title="Обновить список GIF / WebM" aria-label="Обновить список GIF / WebM"
        aria-controls={`${id}-gif-panel`} disabled={refreshDisabled() || gifLoading()}
        onClick={() => setGifRevision(value => value + 1)}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 8a6 6 0 1 0 0 5M16 3v5h-5" /></svg>
      </button>
      </div>
      <div class="task-media-tab" classList={{ "is-active": tab() === "docs" }} role="presentation">
      <button ref={docsButton} type="button" role="tab" id={`${id}-docs-tab`} aria-controls={`${id}-docs-panel`}
        aria-selected={tab() === "docs"} tabIndex={tab() === "docs" ? 0 : -1} disabled={disabled()}
        onClick={() => setTab("docs")}>DOCS ({docsCount()})</button>
      <button type="button" class="task-media-refresh" title="Обновить список DOCS" aria-label="Обновить список DOCS"
        aria-controls={`${id}-docs-panel`} disabled={refreshDisabled() || docsLoading()}
        onClick={() => setDocsRevision(value => value + 1)}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 8a6 6 0 1 0 0 5M16 3v5h-5" /></svg>
      </button>
      </div>
    </div>
    <div class="task-media-page" role="tabpanel" id={`${id}-gif-panel`} aria-labelledby={`${id}-gif-tab`} hidden={tab() !== "gif"}>
      <TaskGifGallery taskHandle={props.taskHandle} active={props.active} visible={tab() === "gif"}
        disabled={disabled()} refreshKey={gifRefreshKey()} onLoadingChange={setGifLoading} onBusyChange={busyChanged} onCountChange={setGifCount} />
      <textarea class="task-media-text task-results-text" readOnly wrap="off" spellcheck={false}
        aria-label="Сводка результатов расчёта выбранного задания" value={props.resultsSummary ?? ""} />
    </div>
    <div class="task-media-page" role="tabpanel" id={`${id}-docs-panel`} aria-labelledby={`${id}-docs-tab`} hidden={tab() !== "docs"}>
      <TaskDocsGallery taskHandle={props.taskHandle} active={props.active} visible={tab() === "docs"}
        disabled={disabled()} refreshKey={docsRefreshKey()} onLoadingChange={setDocsLoading} onBusyChange={busyChanged} onCountChange={setDocsCount} onEditProtocol={props.onEditProtocol} />
    </div>
    <footer class="task-panel-caption task-media-caption">{tab() === "gif" ? "результаты" : "документация"}</footer>
  </section>;
}
