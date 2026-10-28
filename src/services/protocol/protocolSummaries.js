const MAX_SUMMARY_BYTES = 2 * 1024 * 1024;
const resultFilesMarker = text => /^[ \t]*Файлы результатов\s*:/imu.exec(text);

export function trimResultFilesDescription(text) {
  const marker = resultFilesMarker(text);
  return marker ? text.slice(0, marker.index).trimEnd() : text;
}

export async function readProtocolSummaries(task, { signal } = {}) {
  const blocks = [];
  for (const [directory, name, title, trim] of [
    ["input3XX", "_summary.txt", "Сводка исходных данных · input3XX/_summary.txt", false],
    ["output3XX", "_summary_out.txt", "Сводка расчёта · output3XX/_summary_out.txt", true],
  ]) {
    signal?.throwIfAborted();
    try {
      const handle = await task.handle.getDirectoryHandle(directory, { create: false });
      const file = await (await handle.getFileHandle(name, { create: false })).getFile();
      if (!trim && file.size > MAX_SUMMARY_BYTES) throw new Error(`${directory}/${name} превышает 2 МиБ.`);
      // The discarded result-file description can be arbitrarily large. Read
      // only the prefix needed for the summary, never its remaining tail.
      const text = (await (trim ? file.slice(0, MAX_SUMMARY_BYTES) : file).text()).replace(/^\uFEFF/, "");
      if (file.size > MAX_SUMMARY_BYTES && !resultFilesMarker(text)) throw new Error(`${directory}/${name}: сводка до раздела «Файлы результатов:» превышает 2 МиБ.`);
      signal?.throwIfAborted();
      blocks.push({ id: crypto.randomUUID(), kind: "text", source: "summary", title, comment: "",
        text: trim ? trimResultFilesDescription(text) : text });
    } catch (error) { signal?.throwIfAborted(); if (error.name !== "NotFoundError") throw error; }
  }
  return blocks;
}
