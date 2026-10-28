import { validateProtocolScene } from "./protocolSceneData.js";
import { sceneRuntime, sceneRuntimeHash, sceneRuntimeLicense } from "./generated/sceneRuntime.js";

export const PROTOCOL_SCHEMA = "clark-viewer-protocol";
export const PROTOCOL_MAX_BYTES = 256 * 1024 * 1024;
export const PROTOCOL_SIZE_ERROR = "Протокол превышает 256 МиБ. Создайте отдельный протокол или уменьшите объём роликов.";
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const text = (value, limit = 10000) => typeof value === "string" && value.length <= limit;

export const canCommentProtocolBlock = block => block?.source !== "summary";

export function validateProtocol(doc) {
  if (doc?.schema !== PROTOCOL_SCHEMA || ![1, 2, 3].includes(doc.version) || !text(doc.id, 100) || !doc.id
    || !text(doc.taskPath) || !text(doc.createdAt, 100) || !text(doc.updatedAt, 100)
    || !Array.isArray(doc.blocks) || doc.blocks.length > 200) throw new Error("Это не поддерживаемый протокол Viewer версии 1, 2 или 3.");
  const ids = new Set();
  for (const block of doc.blocks) {
    if (!text(block?.id, 100) || !block.id || ids.has(block.id) || !text(block.title) || !text(block.comment)) {
      throw new Error("Некорректный блок протокола.");
    }
    ids.add(block.id);
    if (block.source !== undefined && (block.kind !== "text" || !["summary", "docs"].includes(block.source))) {
      throw new Error("Неизвестный источник текстового блока протокола.");
    }
    if (block.kind === "image") {
      if (!text(block.dataUrl, 16 * 1024 * 1024) || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(block.dataUrl)
        || !Number.isSafeInteger(block.width) || !Number.isSafeInteger(block.height) || block.width < 1 || block.height < 1
        || block.width > 8192 || block.height > 8192) throw new Error("Некорректное изображение протокола.");
    } else if (block.kind === "scene") {
      if (doc.version !== 3) throw new Error("3D-геометрия требует версии 3 протокола.");
      validateProtocolScene(block.scene);
      const poster = block.poster;
      if (!text(poster?.dataUrl, 16 * 1024 * 1024) || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(poster.dataUrl)
        || !Number.isSafeInteger(poster.width) || !Number.isSafeInteger(poster.height) || poster.width < 1 || poster.height < 1
        || poster.width > 8192 || poster.height > 8192) throw new Error("Некорректный снимок 3D-геометрии.");
    } else if (block.kind === "video") {
      if (doc.version < 2 || !text(block.filename, 512) || !/^[^<>:"/\\|?*\x00-\x1f]*\.webm$/i.test(block.filename)
        || !text(block.dataUrl, PROTOCOL_MAX_BYTES)
        || !/^data:video\/webm;base64,[A-Za-z0-9+/]+={0,2}$/.test(block.dataUrl)) throw new Error("Некорректная анимация WebM протокола.");
    } else if (block.kind === "text") {
      if (!text(block.text, 2 * 1024 * 1024)) throw new Error("Текстовый блок протокола превышает 2 МиБ.");
    } else if (block.kind === "table") {
      const table = block.table;
      if (!Array.isArray(table?.headers) || table.headers.length > 50 || !table.headers.every(value => text(value))
        || !Array.isArray(table.rows) || table.rows.length > 10000
        || !table.rows.every(row => Array.isArray(row) && row.length === table.headers.length && row.every(value => text(value)))) {
        throw new Error("Некорректная таблица протокола.");
      }
    } else throw new Error("Неизвестный тип блока протокола.");
  }
  return doc;
}

export function newProtocol(taskPath, blocks = [], date = new Date().toISOString()) {
  return validateProtocol({ schema: PROTOCOL_SCHEMA, version: blocks.some(block => block.kind === "scene") ? 3 : 2, id: crypto.randomUUID(), taskPath,
    createdAt: date, updatedAt: date, blocks });
}

export function appendProtocolBlocks(doc, blocks) {
  const ids = new Set(doc.blocks.map(block => block.id));
  const combined = [...doc.blocks, ...blocks.filter(block => {
    if (ids.has(block.id)) return false;
    ids.add(block.id); return true;
  })];
  return validateProtocol({ ...doc, version: combined.some(block => block.kind === "scene") ? 3
    : combined.some(block => block.kind === "video") ? Math.max(2, doc.version) : doc.version,
    blocks: [...combined.filter(block => block.kind !== "video" && block.source !== "docs"),
      ...combined.filter(block => block.source === "docs"), ...combined.filter(block => block.kind === "video")] });
}

function blockHtml(block, index) {
  const content = block.kind === "scene" ? `<div class="protocol-scene" data-protocol-scene="${index}"><img class="protocol-scene-poster" src="${block.poster.dataUrl}" width="${block.poster.width}" height="${block.poster.height}" alt="${esc(block.title)}"><button type="button" hidden>Открыть 3D</button><div role="status"></div><div class="protocol-scene-live"></div><p class="protocol-scene-fallback">Снимок системы для печати и просмотра без JavaScript. Интерактивный вид требует JavaScript и WebGL 2.</p></div>`
    : block.kind === "image" ? `<img src="${block.dataUrl}" width="${block.width}" height="${block.height}" alt="${esc(block.title)}">`
    : block.kind === "video" ? `<video data-protocol-video="${index}" src="${block.dataUrl}" controls preload="metadata" playsinline aria-label="${esc(block.filename)}"></video>`
      : block.kind === "text" ? `<pre>${esc(block.text)}</pre>`
      : `<div class="table-scroll"><table><thead><tr>${block.table.headers.map(value => `<th>${esc(value)}</th>`).join("")}</tr></thead><tbody>${block.table.rows.map(row => `<tr>${row.map(value => `<td>${esc(value)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  const comment = canCommentProtocolBlock(block) && block.comment.trim()
    ? `<p class="comment">${esc(block.comment)}</p>` : "";
  return `<section data-block-id="${esc(block.id)}"><h2>${esc(block.title)}</h2>${content}${comment}</section>`;
}

export function serializeProtocol(document) {
  const doc = validateProtocol(document);
  // Scene protocols allow only the bundled player's exact hash; all data is
  // escaped and no remote resources are allowed. Printed content works sans JS.
  // Each WebM is stored once in its native video element. JSON keeps only a
  // reference; the parser restores dataUrl without any source files or JS.
  const stored = { ...doc, blocks: doc.blocks.map((block, index) => {
    if (block.kind !== "video") return block;
    const { dataUrl, ...metadata } = block;
    return { ...metadata, mediaRef: index };
  }) };
  const json = JSON.stringify(stored).replace(/</g, "\\u003c");
  const interactive = doc.blocks.some(block => block.kind === "scene");
  const scriptPolicy = interactive ? ` script-src 'sha256-${sceneRuntimeHash}';` : "";
  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none';${scriptPolicy}">
<title>Протокол — ${esc(doc.taskPath)}</title><style>
*{box-sizing:border-box}body{margin:0;background:#eef1f4;color:#17202b;font:16px/1.5 Arial,sans-serif}main{max-width:1200px;margin:auto;padding:32px;background:white}h1{margin:0 0 12px}h2{font-size:1.15rem}header{border-bottom:2px solid #426886;padding-bottom:20px;overflow-wrap:anywhere}section{padding:20px 0;border-bottom:1px solid #ccd5dd;break-inside:avoid}img,video{max-width:100%;height:auto;display:block}video{min-width:min(320px,100%)}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f7;padding:16px;font:13px/1.5 monospace}.comment{white-space:pre-wrap;overflow-wrap:anywhere;color:#34485a}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bac6cf;padding:6px 10px;text-align:left;overflow-wrap:anywhere}footer{color:#5d6a76;font-size:13px;margin-top:20px}@media print{body,main{background:white}main{padding:0;max-width:none}.table-scroll{overflow:visible}}
.protocol-scene>button{font:inherit;margin:10px 0;padding:6px 12px;cursor:pointer}.protocol-scene-fallback{font-size:13px;color:#5d6a76}.protocol-scene [hidden]{display:none!important}@media print{.protocol-scene .protocol-scene-poster[hidden],.protocol-scene .protocol-scene-poster{display:block!important}.protocol-scene>button,.protocol-scene-live,.protocol-scene [role=status]{display:none!important}}
</style></head><body><main><header><h1>Протокол расчёта</h1><div>Путь к заданию: <strong>${esc(doc.taskPath)}</strong></div><div>Создан: ${esc(doc.createdAt)} · Изменён: ${esc(doc.updatedAt)}</div></header>
${doc.blocks.map(blockHtml).join("\n")}
<footer>Изображения, анимации и данные включены в этот файл. Состав блоков и комментарии задаются в Viewer.</footer>
</main><script type="application/json" id="clark-protocol-data">${json}</script>${interactive ? `<script>${sceneRuntime}</script><details><summary>Three.js · лицензия MIT</summary><pre>${esc(sceneRuntimeLicense)}</pre></details>` : ""}</body></html>\n`;
  if (new TextEncoder().encode(html).length > PROTOCOL_MAX_BYTES) throw new Error(PROTOCOL_SIZE_ERROR);
  return html;
}

export function parseProtocol(html) {
  if (typeof html !== "string" || new TextEncoder().encode(html).length > PROTOCOL_MAX_BYTES) throw new Error(PROTOCOL_SIZE_ERROR);
  const match = /<script type="application\/json" id="clark-protocol-data">([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error("Файл не содержит редактируемых блоков протокола Viewer. Выберите другой файл или новое имя.");
  let doc;
  try { doc = JSON.parse(match[1]); } catch { throw new Error("Повреждены данные протокола Viewer."); }
  if (doc?.version >= 2 && Array.isArray(doc.blocks)) {
    const sources = new Map();
    for (const tag of html.matchAll(/<video data-protocol-video="(\d+)" src="([^"]*)"/g)) {
      const index = Number(tag[1]), source = tag[2];
      if (sources.has(index) || !source) throw new Error("Повреждены встроенные анимации протокола.");
      sources.set(index, source);
    }
    doc.blocks = doc.blocks.map((block, index) => {
      if (block?.kind !== "video") return block;
      const { mediaRef, ...metadata } = block;
      if (mediaRef !== index || !sources.has(index)) throw new Error("В протоколе отсутствует встроенная анимация WebM.");
      return { ...metadata, dataUrl: sources.get(index) };
    });
  }
  return validateProtocol(doc);
}
