import { readProtocolDownload } from "./protocolDownloads.js";

const cancelled = () => Object.assign(new Error("Открытие протокола отменено"), { name: "AbortError" });

function element(document, tag, text, attributes = {}) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

// Reserve the tab before the first await. The original document stays intact in
// an iframe: scripts, CSP hashes, embedded media and downloaded bytes are preserved.
export async function openProtocolWindow(entry, {
  signal, openWindow = () => window.open("", "_blank"), read = readProtocolDownload,
} = {}) {
  if (signal?.aborted) throw cancelled();
  const tab = openWindow();
  if (!tab) throw new Error("Браузер заблокировал окно протокола. Разрешите его открытие и повторите нажатие.");
  const pending = new AbortController();
  let url;
  const release = () => {
    pending.abort();
    signal?.removeEventListener("abort", abort);
    tab.removeEventListener("pagehide", release);
    if (url) { tab.URL.revokeObjectURL(url); url = undefined; }
  };
  const abort = () => { release(); if (!tab.closed) tab.close(); };
  try {
    tab.opener = null;
    signal?.addEventListener("abort", abort, { once: true });
    tab.addEventListener("pagehide", release, { once: true });
    const document = tab.document;
    document.title = `Протокол — ${entry.name}`;
    document.head.append(element(document, "meta", undefined, { charset: "utf-8" }), element(document, "style", `
      * { box-sizing: border-box; }
      html, body { margin: 0; width: 100%; height: 100%; }
      body { display: flex; flex-direction: column; font: 14px Arial, sans-serif; color: #19222b; background: #f3f5f7; }
      header { display: flex; align-items: center; gap: 12px; padding: 8px 14px; border-bottom: 1px solid #a4afb9; }
      h1 { flex: 1; min-width: 0; margin: 0; font-size: 16px; font-weight: 400; overflow-wrap: anywhere; }
      a { flex: none; padding: 7px 12px; border: 1px solid #a4afb9; border-radius: 4px; color: inherit; background: white; text-decoration: none; }
      a:hover { background: #e7edf2; }
      a:focus-visible { outline: 2px solid #2184d1; outline-offset: 2px; }
      p { padding: 0 14px; }
      iframe { display: block; flex: 1; min-height: 0; width: 100%; border: 0; background: white; }
    `));
    const header = element(document, "header");
    header.append(element(document, "h1", entry.name));
    document.body.replaceChildren(header, element(document, "p", "Открытие протокола…", { role: "status" }));
    const { name, blob } = await read(entry, { signal: pending.signal });
    if (pending.signal.aborted || tab.closed) throw cancelled();
    // The report tab owns the URL, so closing or changing the Editor/Viewer does
    // not invalidate an already opened report or its native download link.
    // A File-backed Blob can become unreadable after external deletion/rewrite.
    // Snapshot its bytes once so the open report's download stays independent.
    const bytes = await blob.arrayBuffer();
    if (pending.signal.aborted || tab.closed) throw cancelled();
    url = tab.URL.createObjectURL(new tab.Blob([bytes], { type: blob.type }));
    header.append(element(document, "a", "Загрузить", { href: url, download: name, title: "Загрузить HTML-протокол" }));
    document.body.replaceChildren(header, element(document, "iframe", undefined, { src: url, title: name }));
    signal?.removeEventListener("abort", abort);
    return tab;
  } catch (error) {
    abort();
    throw error;
  }
}
