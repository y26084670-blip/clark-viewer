import { createSignal, createUniqueId } from "solid-js";
import { TaskGifGallery } from "./TaskGifGallery.jsx";
import { TaskDocsGallery } from "./TaskDocsGallery.jsx";
import "./TaskMediaPanel.css";

export function TaskMediaPanel(props) {
  const id = createUniqueId();
  const [tab, setTab] = createSignal("gif");
  const [gifCount, setGifCount] = createSignal(0), [docsCount, setDocsCount] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const disabled = () => props.disabled || busy();
  function busyChanged(value) { setBusy(value); props.onBusyChange?.(value); }
  let gifButton, docsButton;
  function tabKeyDown(event) {
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
      <button ref={gifButton} type="button" role="tab" id={`${id}-gif-tab`} aria-controls={`${id}-gif-panel`}
        aria-selected={tab() === "gif"} tabIndex={tab() === "gif" ? 0 : -1} disabled={disabled()}
        onClick={() => setTab("gif")}>GIF ({gifCount()})</button>
      <button ref={docsButton} type="button" role="tab" id={`${id}-docs-tab`} aria-controls={`${id}-docs-panel`}
        aria-selected={tab() === "docs"} tabIndex={tab() === "docs" ? 0 : -1} disabled={disabled()}
        onClick={() => setTab("docs")}>DOCS ({docsCount()})</button>
    </div>
    <div class="task-media-page" role="tabpanel" id={`${id}-gif-panel`} aria-labelledby={`${id}-gif-tab`} hidden={tab() !== "gif"}>
      <TaskGifGallery taskHandle={props.taskHandle} active={props.active} visible={tab() === "gif"}
        disabled={disabled()} refreshKey={props.refreshKey} onBusyChange={busyChanged} onCountChange={setGifCount} />
      <textarea class="task-media-text task-results-text" readOnly wrap="off" spellcheck={false}
        aria-label="Сводка результатов расчёта выбранного задания" value={props.resultsSummary ?? ""} />
    </div>
    <div class="task-media-page" role="tabpanel" id={`${id}-docs-panel`} aria-labelledby={`${id}-docs-tab`} hidden={tab() !== "docs"}>
      <TaskDocsGallery taskHandle={props.taskHandle} active={props.active} visible={tab() === "docs"}
        disabled={disabled()} refreshKey={props.refreshKey} onCountChange={setDocsCount} />
    </div>
    <footer class="task-panel-caption task-media-caption">{tab() === "gif" ? "результаты" : "документация"}</footer>
  </section>;
}
