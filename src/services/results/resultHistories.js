import { checkReadRange } from "./resultLayout.js";

// solver FieldV writes the total coil linkage in Wb, including turns and signs.
// FieldS writes one total force (N) and moment (N·m) about general.polusForce*.
export const HISTORY_QUANTITIES = {
  flux: { label: "Потокосцепление", unit: "Вб", file: "PSI" },
  force: { label: "Сила", unit: "Н", file: "FM" },
  moment: { label: "Момент", unit: "Н·м", file: "FM" },
};

const number = value => String(Number(value.toPrecision(8)));

// A coil can consist of several KV/TK with opposite signed indCoil values.
// NCOIL is the largest absolute index; missing intermediate indices stay gaps.
export function measurementCoils(task) {
  const coils = new Map();
  for (const [schemaId, records] of [["elements", task?.elements ?? []], ["regions", task?.regions ?? []]]) {
    for (const record of records) {
      if (schemaId === "elements" && record.targ !== 3) continue;
      const index = record.indCoil ?? 0;
      if (!Number.isSafeInteger(index)) throw new Error(`Объект №${record.id}: неверный номер измерительной катушки`);
      if (index === 0) continue;
      const id = Math.abs(index);
      if (!coils.has(id)) coils.set(id, { id, name: `Катушка №${id}`, members: [] });
      coils.get(id).members.push({ schemaId, id: record.id, name: record.name ?? "", indCoil: index, wCoil: record.wCoil });
    }
  }
  return [...coils.values()].sort((a, b) => a.id - b.id);
}

function historyMetadata(task, name, expectedPoints) {
  const metadata = task?.metadata?.[name];
  if (!metadata) throw new Error(`${name}.h5 отсутствует в output3XX`);
  if (metadata.error) throw new Error(metadata.error);
  if (!metadata.steps?.length) throw new Error(`${name}.h5: нет сохранённых шагов`);
  if (!Number.isSafeInteger(metadata.pointCount) || metadata.pointCount < 0) {
    throw new Error(`${name}.h5: не определено число строк результатов`);
  }
  if (metadata.pointCount !== expectedPoints) {
    const expected = name === "FM" ? "одна строка суммарных силы и момента"
      : `${expectedPoints} строк по наибольшему номеру измерительной катушки`;
    throw new Error(`${name}.h5: найдено ${metadata.pointCount} строк; ожидается ${expected}`);
  }
  if (typeof task?.reader?.history !== "function") throw new Error("Модуль чтения результатов недоступен");
  return metadata;
}

function validateHistory(history, stride, timeStep, name) {
  if (!Number.isFinite(timeStep) || timeStep < 0) throw new Error("Шаг времени должен быть конечным неотрицательным числом секунд");
  if (!history || history.stride !== stride || !Array.isArray(history.steps)
      || !(history.values instanceof Float32Array || history.values instanceof Float64Array || Array.isArray(history.values))
      || history.values.length !== history.steps.length * stride) {
    throw new Error(`${name}.h5: несогласованный формат истории результатов`);
  }
  if (!history.steps.length) throw new Error(`${name}.h5: нет сохранённых шагов`);
  let previous = -1;
  for (const step of history.steps) {
    if (!Number.isSafeInteger(step) || step <= previous) throw new Error(`${name}.h5: неверные номера шагов времени`);
    if (step > 0 && timeStep === 0) throw new Error("Для ненулевых шагов результатов шаг времени должен быть положительным");
    if (!Number.isFinite(step * timeStep)) throw new Error(`${name}.h5: время выходит за числовой диапазон`);
    previous = step;
  }
  for (const value of history.values) {
    if (!Number.isFinite(value)) throw new Error(`${name}.h5: история содержит нечисловые или бесконечные значения`);
  }
}

function validateReadHistory(history, metadata, stride, task, name) {
  validateHistory(history, stride, task.general?.timeStep, name);
  if (history.steps.length !== metadata.steps.length
      || history.steps.some((step, i) => step !== metadata.steps[i].index)) {
    throw new Error(`${name}.h5: шаги прочитанной истории не совпадают с метаданными`);
  }
}

export async function readFluxHistories({ task, selected = [] }) {
  const coils = measurementCoils(task);
  const metadata = historyMetadata(task, "PSI", coils.at(-1)?.id ?? 0);
  const records = coils.filter(record => selected.includes(record.id));
  // Ctrl+A reads many complete histories; apply the same 64 MB budget to
  // their combined result before submitting any requests to the worker.
  const valueCount = records.length * metadata.steps.length;
  checkReadRange(0, valueCount, valueCount, 1);
  return Promise.all(records.map(async record => {
    const history = await task.reader.history({ name: "PSI", point: record.id - 1 });
    validateReadHistory(history, metadata, 1, task, "PSI");
    return { record, history };
  }));
}

export async function readForceMomentHistory(task) {
  const metadata = historyMetadata(task, "FM", 1);
  const history = await task.reader.history({ name: "FM", point: 0 });
  validateReadHistory(history, metadata, 6, task, "FM");
  return history;
}

export function fluxHistorySeries({ record, history }, timeStep) {
  validateHistory(history, 1, timeStep, "PSI");
  const quantity = HISTORY_QUANTITIES.flux;
  const points = history.steps.map((step, i) => ({ x: step * timeStep, y: history.values[i], step }));
  return { label: record.name || `Катушка №${record.id}`, points,
    tooltip: point => [`t = ${number(point.x)} с; шаг ${point.step}`,
      `${quantity.label} = ${number(point.y)} ${quantity.unit}`] };
}

export function forceMomentHistorySeries(history, timeStep, quantity = "force", component = "norm") {
  if (!["force", "moment"].includes(quantity)) throw new Error("Выберите силу или момент");
  const axis = ["0", "1", "2"].indexOf(String(component));
  if (component !== "norm" && axis < 0) throw new Error("Выберите модуль или компоненту X, Y, Z");
  validateHistory(history, 6, timeStep, "FM");
  const descriptor = HISTORY_QUANTITIES[quantity], componentLabel = component === "norm" ? "Модуль" : `Компонента ${"XYZ"[axis]}`;
  const points = history.steps.map((step, i) => {
    const offset = i * 6 + (quantity === "moment" ? 3 : 0);
    const y = component === "norm" ? Math.hypot(history.values[offset], history.values[offset + 1], history.values[offset + 2])
      : history.values[offset + axis];
    if (!Number.isFinite(y)) throw new Error("FM.h5: модуль вектора выходит за числовой диапазон");
    return { x: step * timeStep, y, step };
  });
  return { label: `${descriptor.label} · ${componentLabel}`, points,
    tooltip: point => [`t = ${number(point.x)} с; шаг ${point.step}`,
      `${descriptor.label} (${componentLabel.toLowerCase()}) = ${number(point.y)} ${descriptor.unit}`] };
}
