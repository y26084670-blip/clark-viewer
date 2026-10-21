import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { createTaskImageGalleryController } from "../../services/taskImageGalleryController.js";
import { listTaskDocs, readTaskDocsDocument, readTaskDocsImage } from "../../services/taskDocsService.js";
import { createTaskDocsTextController } from "../../services/taskDocsTextController.js";
import { TaskImageGallery } from "./TaskImageGallery.jsx";
import { TaskMediaDialog } from "./TaskMediaDialog.jsx";

function staticHtmlPreview(source) {
  // A template is inert, so parsing cannot fetch resources or run code in Viewer.
  // The sandbox/CSP also isolate CSS, scripts, forms and all external resources.
  const template = document.createElement("template");
  template.innerHTML = source;
  template.content.querySelectorAll("base, meta, script, iframe, frame, frameset, object, embed, link, noscript")
    .forEach(node => node.remove());
  for (const node of template.content.querySelectorAll("[src], [srcset], [poster], [background]")) {
    if (!/^data:image\//i.test(node.getAttribute("src") ?? "")) node.removeAttribute("src");
    for (const name of ["srcset", "poster", "background"]) node.removeAttribute(name);
  }
  for (const node of template.content.querySelectorAll("[href], [xlink\\:href]")) {
    for (const name of ["href", "xlink:href"]) {
      const value = node.getAttribute(name);
      if (value && !value.startsWith("#")) node.removeAttribute(name);
    }
    node.removeAttribute("target");
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"></head><body>${template.innerHTML}</body></html>`;
}

export function TaskDocsGallery(props) {
  const [view, setView] = createSignal({ documents: [], selected: null, text: "", error: "", loading: false });
  const [expanded, setExpanded] = createSignal(null);
  const [documentCount, setDocumentCount] = createSignal(0);
  const controller = createTaskDocsTextController({ publish: setView, read: readTaskDocsDocument });
  const createDocsController = options => createTaskImageGalleryController({
    ...options, read: readTaskDocsImage, list: async (task, args) => {
      try {
        const result = await listTaskDocs(task, args);
        args.signal?.throwIfAborted();
        setDocumentCount(result.documents.length);
        return result.images;
      } catch (error) {
        if (!args.signal?.aborted) setDocumentCount(0);
        throw error;
      }
    },
  });
  let opener, previousTask, previousActive, previousRefreshKey, initialized = false;
  const disabled = () => props.active === false || props.visible === false || !props.taskHandle || props.disabled;
  const isHtml = () => /\.html?$/i.test(view().selected?.name ?? "");
  const isProtocol = () => /\.html$/i.test(view().selected?.name ?? "") && /<script\b[^>]*\bid=["']clark-protocol-data["']/i.test(view().text);
  const canEdit = () => isProtocol() && Boolean(props.onEditProtocol);
  const expandLabel = () => canEdit() ? "Открыть протокол для редактирования" : "Развернуть документ";
  const format = () => isHtml() ? "HTML · просмотр" : /\.md$/i.test(view().selected?.name ?? "") ? "исходный Markdown · UTF-8" : "обычный текст · UTF-8";
  const html = createMemo(() => isHtml() && props.active !== false && props.visible !== false && !view().loading && !view().error
    ? staticHtmlPreview(view().text) : "");
  const status = () => !props.taskHandle ? "Выберите задание" : view().loading ? "Чтение документа…"
    : view().error || (view().selected ? "" : "В DOCS нет документов TXT/MD/HTML");
  createEffect(on(() => [props.taskHandle, props.active], () => setDocumentCount(0)));
  createEffect(() => controller.setDisplayActive(props.visible !== false));
  createEffect(() => {
    const task = props.taskHandle, active = props.active !== false, refreshKey = props.refreshKey;
    const sameContext = initialized && task === previousTask && active === previousActive;
    controller.setContext(task, active);
    if (sameContext && refreshKey !== previousRefreshKey) controller.refresh();
    previousTask = task; previousActive = active; previousRefreshKey = refreshKey; initialized = true;
  });
  createEffect(() => {
    const request = expanded();
    if (request && (disabled() || request.task !== props.taskHandle || request.name !== view().selected?.name)) setExpanded(null);
  });
  onMount(() => {
    const refresh = () => controller.refresh();
    window.addEventListener("focus", refresh);
    onCleanup(() => window.removeEventListener("focus", refresh));
  });
  onCleanup(() => controller.dispose());

  return <>
    <TaskImageGallery taskHandle={props.taskHandle} active={props.active} visible={props.visible}
      disabled={props.disabled} refreshKey={props.refreshKey} onCountChange={count => props.onCountChange?.(count + documentCount())}
      label="DOCS" emptyMessage="В DOCS нет изображений PNG, JPEG или WebP"
      createController={createDocsController} onRefresh={() => controller.refresh()} />
    <section class="task-docs-text-panel" aria-label="Документы задания">
      <div class="task-docs-toolbar">
        <select aria-label="Документ DOCS" value={view().selected?.name ?? ""}
          disabled={disabled() || !view().documents.length} onChange={event => controller.select(event.currentTarget.value)}>
          <Show when={!view().documents.length}><option value="">Документы TXT/MD/HTML</option></Show>
          <For each={view().documents}>{entry => <option value={entry.name}>{entry.name}</option>}</For>
        </select>
        <button type="button" title={expandLabel()} aria-label={expandLabel()}
          disabled={disabled() || !view().selected || view().loading || Boolean(view().error)} onClick={event => {
            if (canEdit()) { props.onEditProtocol(view().selected.name, event.currentTarget); return; }
            opener = event.currentTarget; setExpanded({ task: props.taskHandle, name: view().selected.name });
          }}>⤢</button>
      </div>
      <div class="task-docs-status" role={view().error ? "alert" : "status"}>
        {status() || (canEdit() ? "Протокол Viewer · разверните для редактирования" : format())}
      </div>
      <Show when={isHtml()} fallback={<textarea class="task-media-text" aria-label="Содержимое документа DOCS" readOnly wrap="off"
        spellcheck={false} value={view().text} aria-busy={view().loading} />}>
        <Show when={html()}><iframe class="task-docs-html" title="HTML-документ DOCS" sandbox="" referrerPolicy="no-referrer" srcdoc={html()} /></Show>
      </Show>
    </section>
    <TaskMediaDialog open={Boolean(expanded())} title={view().selected ? `${view().selected.name} — ${format()}` : ""}
      opener={() => opener} onClose={() => setExpanded(null)} closeLabel="Закрыть просмотр документа"
      renderBody={() => <Show when={isHtml()} fallback={<textarea class="task-media-text task-docs-expanded" aria-label="Полный текст документа DOCS"
        readOnly wrap="off" spellcheck={false} value={view().text} aria-busy={view().loading} />}>
        <Show when={expanded() && html()}><iframe class="task-docs-html task-docs-expanded" title="Полный HTML-документ DOCS"
          sandbox="" referrerPolicy="no-referrer" srcdoc={html()} /></Show>
      </Show>} />
  </>;
}
