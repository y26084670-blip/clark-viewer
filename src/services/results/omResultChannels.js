const LIMIT = 64 * 1024 * 1024;
const localName = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes("..");
async function textFile(directory, name, optional = false) {
  if (!localName(name)) throw new Error("Недопустимое имя файла результатов");
  try {
    const file = await (await directory.getFileHandle(name)).getFile();
    if (file.size > LIMIT) throw new Error(`${name}: файл превышает 64 МБ`);
    return (await file.text()).replace(/^\uFEFF/, "");
  } catch (error) { if (optional && error.name === "NotFoundError") return null; throw error; }
}
export function parseResultTable(text, columns) {
  const lines = text.trim().split(/\r?\n/), header = lines.shift().split("\t");
  if (new Set(header).size !== header.length || header[0] !== "step" || header[1] !== "time_s") throw new Error("Таблица результатов: ожидаются уникальные столбцы step, time_s и параметры");
  for (const column of columns) if (!header.includes(column.column)) throw new Error(`Нет столбца ${column.column}`);
  const rows = lines.map((line, i) => {
    const tokens = line.split("\t");
    const row = tokens.map(Number);
    if (tokens.some(x => !x.trim()) || row.length !== header.length || row.some(x => !Number.isFinite(x))
      || !Number.isSafeInteger(row[0]) || row[0] < 0) throw new Error(`Некорректная строка результатов ${i + 2}`);
    return row;
  });
  rows.forEach((row, i) => {
    if (i && (row[0] <= rows[i - 1][0] || row[1] <= rows[i - 1][1])) throw new Error("Шаги и время результатов должны возрастать");
  });
  if (!rows.length) throw new Error("В таблице результатов нет принятых шагов");
  return { header, rows };
}
export function validateChannelSource(manifest, table, task) {
  if (manifest?.schema !== "clark-result-channels/1" || !Array.isArray(manifest.channels) || !manifest.channels.length
    || manifest.channels.length > 10000 || !localName(manifest.dataFile)) throw new Error("Неподдерживаемое описание каналов результата");
  const keys = new Set();
  for (const c of manifest.channels) {
    if (!c || typeof c.column !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.column) || keys.has(c.column)
      || ["step", "time_s"].includes(c.column) || typeof c.label !== "string" || c.label.length > 256
      || typeof c.unit !== "string" || c.unit.length > 80) throw new Error("Некорректное имя, подпись или единица канала");
    keys.add(c.column);
  }
  const grid = task.general;
  if (!manifest.grid || manifest.grid.steps !== grid.countTimeSteps || !Number.isFinite(manifest.grid.dt)
    || Math.abs(manifest.grid.dt - grid.timeStep) > 1e-12 * Math.max(Math.abs(grid.timeStep), 1e-12)) {
    throw new Error("Временная сетка дополнительных параметров не совпадает с заданием");
  }
  const ids = new Set(Object.values(task.metadata ?? {}).map(x => x.ranges?.runId).filter(Boolean));
  if (manifest.fieldRunId && ids.size && (ids.size !== 1 || !ids.has(manifest.fieldRunId))) {
    throw new Error("Параметры ОМ и полевые результаты относятся к разным запускам");
  }
  table.rows.forEach(row => {
    const expected = row[0] * grid.timeStep;
    if (row[0] > grid.countTimeSteps || Math.abs(row[1] - expected) > 1e-12 * Math.max(Math.abs(expected), Math.abs(grid.timeStep), 1e-12)) {
      throw new Error("Время строки дополнительных параметров не соответствует шагу задания");
    }
  });
  if (manifest.complete && (table.rows.length !== grid.countTimeSteps + 1 || table.rows.some((r, i) => r[0] !== i))) {
    throw new Error("Результат объявлен полным, но содержит не все временные узлы");
  }
  return { manifest, table, warning: [manifest.complete ? "" : "Неполный результат: доступны только сохранённые шаги.",
    manifest.fieldRunId && ids.size ? "" : "Связь с полевым запуском не подтверждена. Единицы берутся только из описания каналов."].filter(Boolean).join(" ") };
}
export async function readChannelSource(directory, task) {
  const json = await textFile(directory, "results.json", true);
  let manifest;
  if (json) manifest = JSON.parse(json);
  else {
    const run = JSON.parse(await textFile(directory, "run.json"));
    const text = await textFile(directory, "currents.tsv");
    manifest = { schema: "clark-result-channels/1", model: run.model, version: run.version, grid: run.grid,
      dataFile: "currents.tsv", complete: run.complete, channels: text.trim().split(/\r?\n/, 1)[0].split("\t").slice(2)
        .map(column => ({ column, label: column, unit: "" })) };
    return { ...validateChannelSource(manifest, parseResultTable(text, manifest.channels), task), directory };
  }
  const table = parseResultTable(await textFile(directory, manifest.dataFile), manifest.channels ?? []);
  return { ...validateChannelSource(manifest, table, task), directory };
}
export async function loadLatestOMChannels(task) {
  let output, latest;
  try {
    output = await task.handle.getDirectoryHandle("outputOM");
    const text = await textFile(output, "latest.json", true);
    if (text === null) return null;
    latest = JSON.parse(text);
  } catch (error) { if (error.name === "NotFoundError") return null; throw error; }
  if (latest.schema !== 1 || !localName(latest.directory)) throw new Error("Некорректный указатель последнего расчёта ОМ");
  return readChannelSource(await output.getDirectoryHandle(latest.directory), task);
}
