export const PROTOCOL_SCHEMA = "clark-viewer-protocol";
export const PROTOCOL_MAX_BYTES = 64 * 1024 * 1024;
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const text = (value, limit = 10000) => typeof value === "string" && value.length <= limit;

export function validateProtocol(doc) {
  if (doc?.schema !== PROTOCOL_SCHEMA || doc.version !== 1 || !text(doc.id, 100) || !doc.id
    || !text(doc.taskPath) || !text(doc.createdAt, 100) || !text(doc.updatedAt, 100)
    || !Array.isArray(doc.blocks) || doc.blocks.length > 200) throw new Error("Это не поддерживаемый протокол Viewer версии 1.");
  const ids = new Set();
  for (const block of doc.blocks) {
    if (!text(block?.id, 100) || !block.id || ids.has(block.id) || !text(block.title) || !text(block.comment)) {
      throw new Error("Некорректный блок протокола.");
    }
    ids.add(block.id);
    if (block.kind === "image") {
      if (!text(block.dataUrl, 16 * 1024 * 1024) || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(block.dataUrl)
        || !Number.isSafeInteger(block.width) || !Number.isSafeInteger(block.height) || block.width < 1 || block.height < 1
        || block.width > 8192 || block.height > 8192) throw new Error("Некорректное изображение протокола.");
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
  return validateProtocol({ schema: PROTOCOL_SCHEMA, version: 1, id: crypto.randomUUID(), taskPath,
    createdAt: date, updatedAt: date, blocks });
}

export function appendProtocolBlocks(doc, blocks) {
  const ids = new Set(doc.blocks.map(block => block.id));
  return validateProtocol({ ...doc, blocks: [...doc.blocks, ...blocks.filter(block => {
    if (ids.has(block.id)) return false;
    ids.add(block.id); return true;
  })] });
}

function blockHtml(block) {
  const content = block.kind === "image" ? `<img src="${block.dataUrl}" width="${block.width}" height="${block.height}" alt="${esc(block.title)}">`
    : block.kind === "text" ? `<pre>${esc(block.text)}</pre>`
      : `<div class="table-scroll"><table><thead><tr>${block.table.headers.map(value => `<th>${esc(value)}</th>`).join("")}</tr></thead><tbody>${block.table.rows.map(row => `<tr>${row.map(value => `<td>${esc(value)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  return `<section data-block-id="${esc(block.id)}"><h2>${esc(block.title)}</h2>${content}<p class="comment">${esc(block.comment)}</p></section>`;
}

export function serializeProtocol(document) {
  const doc = validateProtocol(document);
  // No executable code or remote resources. Escaping '<' also prevents JSON
  // values from ending the data script. The printed content works without JS.
  const json = JSON.stringify(doc).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Протокол — ${esc(doc.taskPath)}</title><style>
*{box-sizing:border-box}body{margin:0;background:#eef1f4;color:#17202b;font:16px/1.5 Arial,sans-serif}main{max-width:1200px;margin:auto;padding:32px;background:white}h1{margin:0 0 12px}h2{font-size:1.15rem}header{border-bottom:2px solid #426886;padding-bottom:20px;overflow-wrap:anywhere}section{padding:20px 0;border-bottom:1px solid #ccd5dd;break-inside:avoid}img{max-width:100%;height:auto;display:block}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f7;padding:16px;font:13px/1.5 monospace}.comment{white-space:pre-wrap;overflow-wrap:anywhere;color:#34485a}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bac6cf;padding:6px 10px;text-align:left;overflow-wrap:anywhere}footer{color:#5d6a76;font-size:13px;margin-top:20px}@media print{body,main{background:white}main{padding:0;max-width:none}.table-scroll{overflow:visible}}
</style></head><body><main><header><h1>Протокол расчёта</h1><div>Путь к заданию: <strong>${esc(doc.taskPath)}</strong></div><div>Создан: ${esc(doc.createdAt)} · Изменён: ${esc(doc.updatedAt)}</div></header>
${doc.blocks.map(blockHtml).join("\n")}
<footer>Изображения и данные включены в этот файл. Изменение состава и комментариев: Viewer → Инструменты → Создать протокол → Открыть существующий.</footer>
</main><script type="application/json" id="clark-protocol-data">${json}</script></body></html>\n`;
  if (new TextEncoder().encode(html).length > PROTOCOL_MAX_BYTES) throw new Error("Протокол превышает 64 МиБ. Удалите часть блоков или создайте отдельный протокол.");
  return html;
}

export function parseProtocol(html) {
  if (typeof html !== "string" || new TextEncoder().encode(html).length > PROTOCOL_MAX_BYTES) throw new Error("Протокол превышает 64 МиБ.");
  const match = /<script type="application\/json" id="clark-protocol-data">([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error("Файл не содержит редактируемых блоков протокола Viewer. Выберите другой файл или новое имя.");
  let doc;
  try { doc = JSON.parse(match[1]); } catch { throw new Error("Повреждены данные протокола Viewer."); }
  return validateProtocol(doc);
}
