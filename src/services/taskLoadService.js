import { fromStorage } from "./model/arrayShape.js";
import { RESULT_FILES } from "./results/resultLayout.js";

const emptyResults = "нет данных по результатам или расчет не проводился";
export async function readOptionalText(directory, name, fallback = "") {
  try { return await (await (await directory.getFileHandle(name)).getFile()).text(); }
  catch (error) { if (error.name === "NotFoundError") return fallback; throw error; }
}

export function parseRecords(text, name) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const records = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const record = JSON.parse(line);
      if (!record || Array.isArray(record) || typeof record !== "object") throw new Error("ожидался объект");
      records.push(record);
    } catch (error) { throw new Error(`${name}, строка ${i + 1}: ${error.message}`); }
  });
  return records;
}

export function geometryRecord(raw, index) {
  const record = { ...raw, id: index + 1, recordIndex: index };
  for (const key of ["geo", "dr", "dp"]) {
    if (!Array.isArray(raw[key])) throw new Error(`Объект №${index + 1}: отсутствует ${key}`);
    record[key] = fromStorage(raw[key], { nColumns: key === "geo" ? 3 : 1, order: "row" });
  }
  for (const [key, fallback] of Object.entries({ vi: [0, 0, 0], r0: [0, 0, 0], yl: 0, ya: 0, tx: 0, ls: 1, as: 1, ps: 1, kya: 0, kyp: 0 })) {
    const value = raw.sym?.[key] ?? fallback;
    record[`sym${key[0].toUpperCase()}${key.slice(1)}`] = Array.isArray(value) ? value.map(x => [x]) : value;
  }
  return record;
}

export function normalizeTaskInput({ general, elements, regions, moves, amps, mhj }) {
  if (!general || !Number.isSafeInteger(general.countTimeSteps) || general.countTimeSteps < 0
      || !Number.isFinite(general.timeStep) || general.timeStep < 0
      || (general.countTimeSteps > 0 && general.timeStep === 0)) {
    throw new Error("general.txt: неверное число интервалов или шаг времени");
  }
  return { general, elements: elements.map(geometryRecord), regions: regions.map(geometryRecord),
    moves: moves.map(move => ({ ...move,
      angle: fromStorage(move.angle ?? [], { nColumns: 4 }),
      position: fromStorage(move.position ?? [], { nColumns: 4 }) })),
    amps: amps.map(amp => ({ ...amp, impuls: fromStorage(amp.impuls ?? [], { nColumns: 2 }) })),
    mhj: mhj.map(row => ({ v: fromStorage(row.v ?? [], { nColumns: 3 }) })) };
}

export async function loadTaskInput(handle) {
  const input = await handle.getDirectoryHandle("input3XX");
  const names = ["general.txt", "kvs.txt", "tks.txt", "moves.txt", "amplitudes.txt", "mhj.txt"];
  const texts = await Promise.all(names.map(name => readOptionalText(input, name)));
  if (!texts[0].trim() || !texts[1].trim()) throw new Error("Не найдены general.txt или kvs.txt в input3XX");
  const general = JSON.parse(texts[0].replace(/^\uFEFF/, ""));
  return normalizeTaskInput({ general, elements: parseRecords(texts[1], names[1]),
    regions: parseRecords(texts[2], names[2]), moves: parseRecords(texts[3], names[3]),
    amps: parseRecords(texts[4], names[4]), mhj: parseRecords(texts[5], names[5]) });
}

export async function readTaskSummaries(handle) {
  async function read(directory, name, fallback) {
    try { return await readOptionalText(await handle.getDirectoryHandle(directory), name, fallback); }
    catch (error) { if (error.name === "NotFoundError") return fallback; throw error; }
  }
  const [input, output] = await Promise.all([
    read("input3XX", "_summary.txt", "нет информации"),
    read("output3XX", "_summary_out.txt", emptyResults),
  ]);
  return { input, output };
}

export async function loadTask(handle) {
  const task = await loadTaskInput(handle);
  const files = {};
  let output;
  try { output = await handle.getDirectoryHandle("output3XX"); }
  catch (error) { if (error.name !== "NotFoundError") throw error; }
  if (output) await Promise.all(RESULT_FILES.map(async name => {
    try { files[name] = await (await output.getFileHandle(`${name}.h5`)).getFile(); }
    catch (error) { if (error.name !== "NotFoundError") throw error; }
  }));
  return { ...task, name: handle.name, handle, files };
}
