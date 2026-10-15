import { listTaskTestProtocols, readTaskTestProtocol } from "./taskTestProtocolService.js";

const cancelled = () => Object.assign(new Error("Открытие протоколов отменено"), { name: "AbortError" });

function element(document, tag, text, attributes = {}) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function prepareWindow(tab, label) {
  const document = tab.document;
  document.title = `Протоколы тестов — ${label}`;
  const style = element(document, "style", `
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; height: 100%; }
    body { display: flex; flex-direction: column; font: 14px Arial, sans-serif; color: #19222b; background: #f3f5f7; }
    header { padding: 10px 14px; border-bottom: 1px solid #a4afb9; }
    h1 { margin: 0 0 6px; font-size: 18px; overflow-wrap: anywhere; }
    p { margin: 6px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    nav { display: flex; flex-wrap: wrap; gap: 5px; padding: 8px; max-height: 30vh; overflow: auto; }
    button { padding: 7px 10px; border: 1px solid #a4afb9; border-radius: 3px; font: inherit; cursor: pointer; overflow-wrap: anywhere; }
    button[aria-selected="true"] { background: #254b6b; color: white; }
    button:focus-visible, a:focus-visible { outline: 2px solid #2184d1; outline-offset: 2px; }
    main { flex: 1; min-height: 0; }
    section, iframe { width: 100%; height: 100%; border: 0; }
    section[hidden] { display: none; }
    iframe { display: block; background: white; }
    .errors { color: #9c2924; }
  `);
  document.head.append(style);
  const header = element(document, "header");
  header.append(element(document, "h1", `Протоколы тестов — ${label}`));
  header.append(element(document, "p", "Поиск HTML-протоколов в comparison…", { role: "status" }));
  document.body.replaceChildren(header);
  return header;
}

function showProtocols(tab, header, reports, failures) {
  const document = tab.document;
  header.lastChild.textContent = `Открыто протоколов: ${reports.length}`;
  if (failures.length) header.append(element(document, "p", failures.join("\n"), { class: "errors", role: "alert" }));
  const separate = element(document, "a", "Открыть текущий протокол отдельно", { target: "_blank", rel: "noopener" });
  header.append(separate);
  const tabs = element(document, "nav", undefined, { role: "tablist", "aria-label": "HTML-протоколы тестов" });
  const main = element(document, "main");
  const buttons = [], panels = [];
  const select = index => {
    buttons.forEach((button, i) => {
      button.setAttribute("aria-selected", String(i === index));
      button.tabIndex = i === index ? 0 : -1;
      panels[i].hidden = i !== index;
    });
    separate.href = reports[index].url;
  };
  reports.forEach((report, index) => {
    const button = element(document, "button", `comparison/${report.path}`, {
      type: "button", role: "tab", id: `protocol-tab-${index}`, "aria-controls": `protocol-panel-${index}`,
    });
    button.addEventListener("click", () => select(index));
    button.addEventListener("keydown", event => {
      const target = { ArrowRight: (index + 1) % reports.length, ArrowLeft: (index + reports.length - 1) % reports.length,
        Home: 0, End: reports.length - 1 }[event.key];
      if (target === undefined) return;
      event.preventDefault(); select(target); buttons[target].focus();
    });
    const panel = element(document, "section", undefined, {
      role: "tabpanel", id: `protocol-panel-${index}`, "aria-labelledby": button.id,
    });
    panel.append(element(document, "iframe", undefined, { src: report.url, title: `comparison/${report.path}` }));
    buttons.push(button); panels.push(panel); tabs.append(button); main.append(panel);
  });
  select(0);
  document.body.append(tabs, main);
}

// A single window is reserved in the click handler. Every report is loaded in
// its own document, so batch opening does not depend on multiple-popup permission.
export function createTaskTestProtocolWindow({
  openWindow = () => window.open("", "_blank"),
  list = listTaskTestProtocols, read = readTaskTestProtocol,
  createUrl = blob => URL.createObjectURL(blob), revokeUrl = url => URL.revokeObjectURL(url),
} = {}) {
  const sessions = new Set();
  let disposed = false;

  function release(session, close = false) {
    session.abort.abort();
    session.tab.removeEventListener("pagehide", session.onClose);
    for (const url of session.urls) revokeUrl(url);
    session.urls.length = 0;
    sessions.delete(session);
    if (close && !session.tab.closed) session.tab.close();
  }
  function assertOpen(session) {
    if (disposed || session.abort.signal.aborted || session.tab.closed) throw cancelled();
  }

  return {
    async open(taskHandle, { label = taskHandle?.name ?? "Задание" } = {}) {
      if (disposed) throw cancelled();
      for (const previous of sessions) if (previous.tab.closed) release(previous);
      // Must precede the first await to retain the click's browser activation.
      const tab = openWindow();
      if (!tab) throw new Error("Браузер заблокировал окно протоколов. Разрешите его открытие и повторите щелчок по T.");
      const session = { tab, urls: [], abort: new AbortController(), ready: false };
      session.onClose = () => release(session);
      sessions.add(session);
      try {
        tab.opener = null;
        tab.addEventListener("pagehide", session.onClose, { once: true });
        const header = prepareWindow(tab, label);
        const entries = await list(taskHandle, { signal: session.abort.signal });
        assertOpen(session);
        if (!entries.length) throw new Error("В comparison нет HTML-протоколов.");
        const reports = [], failures = [];
        for (const entry of entries) {
          try {
            const blob = await read(entry.handle, { signal: session.abort.signal });
            assertOpen(session);
            const url = createUrl(blob); session.urls.push(url);
            reports.push({ ...entry, url });
          } catch (error) {
            assertOpen(session);
            failures.push(`Не удалось открыть comparison/${entry.path}: ${error?.message ?? String(error)}`);
          }
        }
        if (!reports.length) throw new Error(failures.join("\n"));
        assertOpen(session);
        showProtocols(tab, header, reports, failures);
        session.ready = true;
        return { opened: reports.length, failures };
      } catch (error) {
        release(session, true);
        throw error;
      }
    },
    dispose() {
      disposed = true;
      for (const session of sessions) release(session, !session.ready);
    },
  };
}
