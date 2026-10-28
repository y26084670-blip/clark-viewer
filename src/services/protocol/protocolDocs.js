import { listTaskDocs, readTaskDocsText } from "../taskDocsService.js";

export async function readProtocolDocs(task, { signal } = {}) {
  const { documents } = await listTaskDocs(task.handle, { signal });
  const blocks = [];
  for (const entry of documents.filter(item => /\.(txt|md)$/i.test(item.name))) {
    signal?.throwIfAborted();
    try {
      const text = await readTaskDocsText(entry.handle, { signal });
      blocks.push({ id: crypto.randomUUID(), kind: "text", source: "docs",
        title: `Документ · DOCS/${entry.name}`, comment: "", text });
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`Не удалось включить документ DOCS «${entry.name}»: ${error.message ?? error}`);
    }
  }
  signal?.throwIfAborted();
  return blocks;
}
