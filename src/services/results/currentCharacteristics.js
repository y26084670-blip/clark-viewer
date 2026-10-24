import { elementLayout } from "./resultMappings.js";
import { resultObjects } from "./resultRequests.js";
import { fmmAxis } from "./fmmCharacteristics.js";
import { buildGeometryTimeModel } from "../visualization/geometryTimeModel.js";

// Solver contract: src/core/02_model_hts.jl::HTS_JCval, HTS_JSP_ro;
// src/vsolver/02_current_material.jl. E in V/m, J in A/mm², conductivity in MS/m.
// j2_n is the exponent of resistivity: the exponent of E(J) is j2_n + 1.
const defaults = { j_HC0: 1000, JC0: 500, JCa: 2, JCb: 1, j_type: 1,
  j_gmin: 1, j1_delta: .1, j2_n: 21, KHabc: 1 };
const libraries = new WeakMap();
const number = value => String(Number(value.toPrecision(7)));

export function parseCurrentCharacteristic(text) {
  const data = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!data || Array.isArray(data) || typeof data !== "object") throw new Error("Ожидался объект характеристики ВТСП");
  const p = { ...defaults, ...data };
  if (![p.j_HC0, p.KHabc, p.j_gmin].every(value => Number.isFinite(value) && value > 0)
    || !Number.isFinite(p.JC0) || p.JC0 < 0 || ![p.JCa, p.JCb].every(Number.isFinite)
    || ![1, 2].includes(p.j_type)
    || (p.j_type === 1 ? !(Number.isFinite(p.j1_delta) && p.j1_delta > 0)
      : !(Number.isInteger(p.j2_n) && p.j2_n >= 0))) {
    throw new Error("Недопустимые параметры заданной зависимости J(E)");
  }
  return p;
}

export async function loadCurrentMaterial(task, name) {
  if (typeof name !== "string" || !name.trim() || /[\\/:\0]/.test(name) || [".", ".."].includes(name)) {
    throw new Error("Некорректное имя характеристики ВТСП");
  }
  let cache = libraries.get(task);
  if (!cache) { cache = new Map(); libraries.set(task, cache); }
  if (!cache.has(name)) cache.set(name, (async () => {
    const input = await task.handle.getDirectoryHandle("input3XX");
    const lib = await input.getDirectoryHandle("xapLibHTS");
    const file = await (await lib.getFileHandle(`${name}.txt`)).getFile();
    return parseCurrentCharacteristic(await file.text());
  })());
  return cache.get(name);
}

export function criticalCurrent(p, effectiveField) {
  const arg = Math.abs(effectiveField / p.j_HC0);
  if (!(arg < 1)) return 0;
  const power = arg ** p.JCa;
  const value = p.JC0 * (p.JCb >= 0 ? Math.max(0, 1 - power) ** p.JCb : (1 + power) ** p.JCb);
  if (!Number.isFinite(value) || value < 0) throw new Error("Некорректное значение Jc(B)");
  return value;
}

export function currentFieldBounds(p, frame, record, projectedRecord = record) {
  const layout = elementLayout(record);
  if (frame.count !== layout.count || (frame.every ?? 1) !== 1 || frame.stride < 9
    || frame.values.length < frame.count * frame.stride) throw new Error("Сетка MH для заданной J(E) не совпадает с элементом");
  const axes = Array.from({ length: layout.copies[0] }, (_, ls) => fmmAxis(projectedRecord, ls));
  let jcMin = Infinity, jcMax = -Infinity, factorMin = Infinity, factorMax = -Infinity;
  for (let row = 0; row < frame.count; row++) {
    const k = row * frame.stride;
    const b = [0, 1, 2].map(i => frame.values[k + 3 + i] + frame.values[k + 6 + i]);
    const ls = Math.floor(row / (layout.copies[1] * layout.copies[2])) % layout.copies[0], a = axes[ls];
    const parallel = b[0] * a[0] + b[1] * a[1] + b[2] * a[2];
    const transverse = Math.hypot(b[1] * a[2] - b[2] * a[1], b[2] * a[0] - b[0] * a[2], b[0] * a[1] - b[1] * a[0]);
    const effective = Math.hypot(parallel, transverse / p.KHabc);
    if (!Number.isFinite(effective)) throw new Error("MH содержит нечисловое поле для заданной J(E)");
    const jc = criticalCurrent(p, effective), factor = Math.max(0, 1 - Math.abs(parallel) / p.j_HC0);
    jcMin = Math.min(jcMin, jc); jcMax = Math.max(jcMax, jc);
    factorMin = Math.min(factorMin, factor); factorMax = Math.max(factorMax, factor);
  }
  return { jcMin, jcMax, factorMin, factorMax };
}

const logAddExp = (a, b) => Math.max(a, b) + Math.log1p(Math.exp(-Math.abs(a - b)));

export function characteristicCurrent(p, e, jc, fieldFactor = 1) {
  if (e === 0) return 0;
  if (!(e > 0 && Number.isFinite(e) && jc > 0 && Number.isFinite(jc))) throw new Error("J(E) не определена при Jc = 0 или некорректном E");
  if (p.j_type === 2) {
    // Logarithmic evaluation avoids overflow/underflow of (J/Jc)^n.
    return Math.exp((Math.log(e) + Math.log(p.j_gmin) + p.j2_n * Math.log(jc)) / (p.j2_n + 1));
  }
  const target = Math.log(e), logJc = Math.log(jc), logG = Math.log(p.j_gmin);
  // Above Jc (or at the critical field), the limited tanh law is exactly ohmic.
  if (target + logG >= logJc || fieldFactor === 0) return Math.exp(target + logG);
  let lo = target + logG, hi = logJc;
  for (let iteration = 0; iteration < 100; iteration++) {
    const mid = (lo + hi) / 2;
    const u = fieldFactor * Math.max(0, 1 - Math.exp(mid - logJc)) / p.j1_delta;
    const logE = mid + Math.LN2 - logG - logAddExp(0, u);
    if (logE < target) lo = mid; else hi = mid;
  }
  return Math.exp((lo + hi) / 2);
}

export function currentCharacteristicSeries(record, observed, { conductivity, property, bounds } = {}) {
  let minE = Infinity, maxE = 0;
  for (const point of observed.points) if (point.e > 0) { minE = Math.min(minE, point.e); maxE = Math.max(maxE, point.e); }
  const nominal = property ? bounds.jcMax / property.j_gmin : 1;
  // Fit the observed field interval; the zero frame uses the material's nominal scale.
  if (!maxE) { maxE = nominal; minE = nominal / 1e6; }
  if (!(minE > 0 && maxE > 0 && Number.isFinite(maxE))) throw new Error("Нет положительного диапазона E для заданной J(E)");
  const lo = Math.log(Math.max(Number.MIN_VALUE, minE / 10)), hi = Math.log(maxE) + Math.log(1.1);
  const fields = [0, ...Array.from({ length: 193 }, (_, i) => Math.exp(lo + (hi - lo) * i / 192))];
  const variable = property && (bounds.jcMin !== bounds.jcMax || (property.j_type === 1 && bounds.factorMin !== bounds.factorMax));
  const states = property ? (variable
    ? [{ jc: bounds.jcMin, factor: bounds.factorMin, label: "нижняя граница" }, { jc: bounds.jcMax, factor: bounds.factorMax, label: "верхняя граница" }]
    : [{ jc: bounds.jcMin, factor: bounds.factorMin, label: "" }]) : [{ label: "" }];
  if (property && !(bounds.jcMin > 0)) throw new Error("Для части узлов Jc = 0: закон E = 0 не задаёт однозначную J(E)");
  if (!property && !(Number.isFinite(conductivity) && conductivity > 0)) throw new Error("Недопустимая электропроводность");
  return states.map(state => {
    const description = property ? (property.j_type === 2 ? `E ∝ J^${property.j2_n + 1}` : "tanh") : `σ = ${number(conductivity)} МСм/м`;
    const label = `№${record.id} · заданная J(E): ${description}${state.label ? ` · ${state.label}` : ""}`;
    const points = fields.map(e => {
      const j = property ? characteristicCurrent(property, e, state.jc, state.factor) : conductivity * e;
      if (!Number.isFinite(j)) throw new Error("Переполнение заданной зависимости J(E)");
      return { x: e, y: j, e, j };
    });
    return { label, points, showLine: true, pointRadius: 0, borderWidth: 2,
      tooltip: point => [label, `|E|=${number(point.e)} В/м; |J|=${number(point.j)} А/мм²`,
        ...(property ? [`Jc=${number(state.jc)} А/мм²; j_gmin=${number(property.j_gmin)} МСм/м`] : [])] };
  });
}

export async function readCurrentCharacteristics(task, entries, time) {
  let projection, magneticObjects;
  const results = await Promise.all(entries.map(async ({ record, series }) => {
    try {
      if ((record.model ?? 0) === 0) return { series: currentCharacteristicSeries(record, series, { conductivity: record.rv }) };
      if (record.model !== 2) throw new Error(`Модель материала ${record.model} не поддерживает заданную J(E)`);
      if ((task.general.htsRo ?? task.general.htcRo ?? true) === false) throw new Error("Токовая подсистема ВТСП отключена");
      const property = await loadCurrentMaterial(task, record.xapName);
      magneticObjects ??= resultObjects(task, "M");
      const object = magneticObjects.find(item => item.record.id === record.id);
      if (!object) throw new Error("Нет сохранённого MH для локальной зависимости Jc(B)");
      projection ??= buildGeometryTimeModel(task, task.moves, time);
      const diagnostic = projection.diagnostics.find(item => item.schemaId === "general"
        || (item.schemaId === "elements" && item.recordIndex === record.recordIndex));
      if (diagnostic) throw new Error(diagnostic.message);
      const frame = await task.reader.read({ name: "MH", step: time, start: object.start, count: object.count, every: 1 });
      const bounds = currentFieldBounds(property, frame, record, projection.model.elements[record.recordIndex]);
      return { series: currentCharacteristicSeries(record, series, { property, bounds }),
        note: bounds.jcMin !== bounds.jcMax || (property.j_type === 1 && bounds.factorMin !== bounds.factorMax)
          ? `№${record.id}: границы заданной J(E) по диапазону локального поля на текущем шаге` : "" };
    } catch (error) { return { series: [], note: `№${record.id}: заданная J(E) недоступна — ${error.message}` }; }
  }));
  return { series: results.flatMap(result => result.series), warnings: [], notes: results.map(result => result.note).filter(Boolean) };
}
