// HEADER/RANGES v1. Numeric tables are [object, channel] on disk (C order),
// i.e. [channel, object] in Julia. All bounds already use display units.
const ROOT = "HEADER/RANGES";
const definitions = {
  MH: [["M", "kA/m", 3], ["H", "kA/m", 3], ["MHdot", "J/m^3", 1]],
  JE: [["J", "A/mm^2", 3], ["E", "V/m", 3], ["JEdot", "W/mm^3", 1]],
  HS: [["Bs", "T", 3]], AS: [["As", "T*m", 3]],
  HV: [["Bv", "T", 3]], AV: [["Av", "T*m", 3]], Q: [["Q", "MW/m^3", 1]],
};
const unavailable = (reason, state = "unavailable") => ({ available: false, state, reason });
const scalar = value => (Array.isArray(value) || ArrayBuffer.isView(value)) && value.length === 1 ? value[0] : value;
const safeInteger = value => {
  const number = Number(scalar(value));
  if (!Number.isSafeInteger(number)) throw new Error("ожидалось безопасное целое число");
  return number;
};
const vector = value => {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) throw new Error("ожидался массив");
  return Array.from(value);
};

export function resultRangeChannels(name) {
  return (definitions[name] ?? []).flatMap(([key, unit, components]) =>
    (components === 3 ? ["x", "y", "z", "norm"] : ["value"])
      .map(component => ({ id: `${key}.${component}`, unit })));
}

/** A damaged/unsupported optional index never prevents opening the result file. */
export function readResultRanges(handle, { name, header, steps }) {
  try {
    if (!handle.get(ROOT)) return unavailable("В файле нет готовых диапазонов", "missing");
    const dataset = path => {
      const result = handle.get(`${ROOT}/${path}`);
      if (!result) throw new Error(`нет ${path}`);
      return result;
    };
    const value = path => scalar(dataset(path).value);
    if (safeInteger(value("schema_version")) !== 1 || safeInteger(value("quantity_definition_version")) !== 1) {
      return unavailable("Неподдержанная версия диапазонов", "unsupported");
    }
    const state = value("state");
    if (state !== "complete" && state !== "partial") return unavailable("Диапазоны не опубликованы или устарели", String(state));
    const revision = safeInteger(value("data_revision"));
    if (revision < 0 || safeInteger(value("indexed_revision")) !== revision) return unavailable("Поколение диапазонов не совпадает с результатами", "stale");
    const runId = value("run_id");
    if (typeof runId !== "string" || !runId.trim()) throw new Error("нет идентификатора расчёта");
    const expectedKind = ["HS", "AS"].includes(name) ? "regions" : ["HV", "AV"].includes(name) ? "virtual" : "elements";
    if (value("object_kind") !== expectedKind) throw new Error("неверный тип объектов");
    const array = (path, length) => {
      const data = dataset(path);
      if (data.shape?.length !== 1 || data.shape[0] !== length) throw new Error(`неверная форма ${path}`);
      const result = vector(data.value);
      if (result.length !== length) throw new Error(`неверный размер ${path}`);
      return result;
    };
    const objectIds = array("object_ids", header.numbs.length).map(safeInteger);
    if (new Set(objectIds).size !== objectIds.length || objectIds.some(id => id <= 0)) throw new Error("неверные идентификаторы объектов");
    const channels = resultRangeChannels(name);
    if (!channels.length) throw new Error("неизвестное семейство результатов");
    const channelIds = array("channel_ids", channels.length);
    const channelUnits = array("channel_units", channels.length);
    if (channels.some((channel, i) => channel.id !== channelIds[i] || channel.unit !== channelUnits[i])) {
      throw new Error("каналы или единицы не соответствуют контракту");
    }
    const stepDataset = dataset("step_ids");
    if (stepDataset.shape?.length !== 1 || stepDataset.shape[0] > steps.length) throw new Error("неверная форма step_ids");
    const stepIds = array("step_ids", stepDataset.shape[0]).map(safeInteger);
    const lastStep = safeInteger(value("last_step"));
    const timeStep = Number(value("time_step"));
    if (lastStep < 0 || !Number.isFinite(timeStep) || timeStep < 0) throw new Error("неверная временная сетка");
    const savedIds = new Set(steps.map(step => step.index));
    if (stepIds.some((id, i) => id < 0 || id > lastStep || !savedIds.has(id) || i > 0 && id <= stepIds[i - 1])) {
      throw new Error("набор временных шагов не совпадает с результатами");
    }
    if (state === "complete" && (stepIds.length !== steps.length || stepIds.length !== lastStep + 1
        || stepIds.some((id, i) => id !== i))) throw new Error("неполный временной цикл помечен полным");
    const times = array("times", stepIds.length).map(Number);
    if (times.some((time, i) => !Number.isFinite(time)
        || Math.abs(time - stepIds[i] * timeStep) > 1e-12 * Math.max(1, Math.abs(time)))) throw new Error("неверные моменты времени");
    const size = objectIds.length * channels.length;
    const matrix = (path, integers = false) => {
      const data = dataset(`global/${path}`);
      if (data.shape?.length !== 2 || data.shape[0] !== objectIds.length || data.shape[1] !== channels.length) {
        throw new Error(`неверный порядок осей global/${path}`);
      }
      const raw = data.value;
      if (!integers && !(raw instanceof Float64Array)) throw new Error(`global/${path} должен быть Float64`);
      const values = vector(raw).map(integers ? safeInteger : Number);
      if (values.length !== size) throw new Error(`неверный размер global/${path}`);
      return values;
    };
    const minimum = matrix("min"), maximum = matrix("max");
    const validCount = matrix("valid_count", true), invalidCount = matrix("invalid_count", true);
    for (let i = 0; i < size; i++) {
      const total = header.numbs[Math.floor(i / channels.length)] * stepIds.length;
      const count = validCount[i] + invalidCount[i];
      if (!Number.isSafeInteger(total) || !Number.isSafeInteger(count) || validCount[i] < 0 || invalidCount[i] < 0
          || count !== 0 && count !== total) throw new Error("неверные счётчики значений");
      if (validCount[i] === 0) {
        if (!Number.isNaN(minimum[i]) || !Number.isNaN(maximum[i])) throw new Error("пустой диапазон не помечен NaN");
      } else if (!Number.isFinite(minimum[i]) || !Number.isFinite(maximum[i]) || minimum[i] > maximum[i]) {
        throw new Error("некорректные границы диапазона");
      }
      if (channelIds[i % channels.length].endsWith(".norm") && minimum[i] < 0) {
        throw new Error("отрицательный модуль в диапазоне");
      }
    }
    return { available: true, state, runId, revision, objectIds, channelIds, channelUnits, stepIds, times,
      minimum, maximum, validCount, invalidCount };
  } catch (error) {
    return unavailable(`Диапазоны ${name}.h5: ${error.message ?? error}`, "invalid");
  }
}

/** Reduce selected MODEL objects, not individual cells. No unit conversion here. */
export function resultCycleRange(ranges, quantityKey, objectIds, { component = "norm", allowPartial = false } = {}) {
  if (!ranges?.available) return unavailable(ranges?.reason ?? "Готовые диапазоны отсутствуют", ranges?.state);
  if (ranges.state !== "complete" && !allowPartial) return unavailable("Есть диапазоны только по доступным шагам", "partial");
  if (!Array.isArray(objectIds) || !objectIds.length) return unavailable("Нет выбранных объектов", "empty");
  const suffix = ["0", "1", "2"].includes(String(component)) ? ["x", "y", "z"][Number(component)] : component;
  const channel = ranges.channelIds.indexOf(`${quantityKey}.${suffix}`);
  const index = channel >= 0 ? channel : ranges.channelIds.indexOf(`${quantityKey}.value`);
  if (index < 0) return unavailable("Канал диапазона отсутствует", "missing");
  let minimum = Infinity, maximum = -Infinity, count = 0;
  for (const id of new Set(objectIds)) {
    const object = ranges.objectIds.indexOf(id);
    if (object < 0) return unavailable(`Нет диапазонов объекта №${id}`, "missing");
    const offset = object * ranges.channelIds.length + index;
    if (ranges.invalidCount[offset] > 0) return unavailable(`NaN/Inf в ${quantityKey}, объект №${id}`, "invalid");
    if (ranges.validCount[offset] === 0) continue;
    minimum = Math.min(minimum, ranges.minimum[offset]);
    maximum = Math.max(maximum, ranges.maximum[offset]);
    count += ranges.validCount[offset];
  }
  if (!count) return unavailable("Для выбранных объектов нет этой величины", "empty");
  return { available: true, state: ranges.state, minimum, maximum, unit: ranges.channelUnits[index],
    runId: ranges.runId, revision: ranges.revision, stepCount: ranges.stepIds.length };
}
