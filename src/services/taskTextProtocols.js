import { elementLayout, mapResultObjects, sourceRecords, regionLayout } from "./results/resultMappings.js";
import { loadCurrentMaterial } from "./results/currentCharacteristics.js";
import { fmmAxis } from "./results/fmmCharacteristics.js";
import { buildGeometryTimeModel } from "./visualization/geometryTimeModel.js";

// Names and formatting belong to this fixed set, never to a filename from the UI.
// Reference: solver c05e927, src/vsolver/01_protocol.jl.
export const TEXT_PROTOCOLS = Object.freeze([
  { name: "prot-source-J.txt", family: "JE" },
  { name: "prot-source-M.txt", family: "MH" },
  { name: "prot-field-vtsp.txt", family: "VTSP" },
  { name: "prot-field.txt", family: "HS" },
  { name: "prot-fieldV.txt", family: "HV" },
].map(Object.freeze));
export const TEXT_PROTOCOL_FAMILIES = Object.freeze(["JE", "MH", "HS", "HV"]);
const missing = error => error?.name === "NotFoundError";
const integer = (value, width) => String(value).padStart(width);
const exponent = (mantissa, power) => `${mantissa}E${power < 0 ? "-" : "+"}${String(Math.abs(power)).padStart(2, "0")}`;

// Decimal ties use round-to-even, like Printf. Work from the exact binary
// rational so decimal formatting does not introduce a second rounding.
const binary = new DataView(new ArrayBuffer(8));
function roundedDigits(value, decimals) {
  binary.setFloat64(0, value);
  const bits = binary.getBigUint64(0), exp = Number((bits >> 52n) & 2047n);
  let numerator = (bits & ((1n << 52n) - 1n)) + (exp ? 1n << 52n : 0n);
  let denominator = 1n;
  const shift = (exp || 1) - 1023 - 52;
  if (shift >= 0) numerator <<= BigInt(shift); else denominator <<= BigInt(-shift);
  if (decimals >= 0) numerator *= 10n ** BigInt(decimals); else denominator *= 10n ** BigInt(-decimals);
  const whole = numerator / denominator, rest = numerator % denominator;
  return whole + (rest * 2n > denominator || (rest * 2n === denominator && whole % 2n) ? 1n : 0n);
}
function decimalParts(value, precision) {
  const absolute = Math.abs(value);
  let power = absolute ? Number(absolute.toExponential().split("e")[1]) : 0;
  const stylePower = power;
  let digits = roundedDigits(absolute, precision - 1 - power).toString();
  if (digits.length > precision) { power++; digits = digits.slice(0, precision); }
  return { power, stylePower, digits: digits.padStart(precision, "0"), sign: value < 0 || Object.is(value, -0) ? "-" : "" };
}
export function protocolNumber(value, kind = "E") {
  if (!Number.isFinite(value)) return (Number.isNaN(value) ? "NaN" : value < 0 ? "-Inf" : "Inf").padStart(kind === "G" ? 14 : 13);
  if (kind === "f") {
    const digits = roundedDigits(Math.abs(value), 6).toString().padStart(7, "0");
    return `${value < 0 || Object.is(value, -0) ? "-" : ""}${digits.slice(0, -6)}.${digits.slice(-6)}`.padStart(13);
  }
  const { power, stylePower, digits, sign } = decimalParts(value, kind === "E" ? 7 : 6);
  let text;
  if (kind === "E") text = exponent(`${digits[0]}.${digits.slice(1)}`, power);
  // Julia Printf chooses G's notation before rounding (999999.5 -> 1000000).
  else if (stylePower < -4 || stylePower >= 6) text = exponent(`${digits[0]}.${digits.slice(1)}`.replace(/\.?0+$/, ""), power);
  else {
    const point = power + 1;
    text = point <= 0 ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length ? digits + "0".repeat(point - digits.length)
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
    if (text.includes(".")) text = text.replace(/\.?0+$/, "");
  }
  return (sign + text).padStart(kind === "G" ? 14 : 13);
}
const values = (items, kind = "E") => Array.from(items, value => `\t${protocolNumber(value, kind)}`).join("");
const volumeIndices = (record, index) => " " + [record.id, index.i1 + 1, index.i2 + 1, index.i3 + 1,
  index.ls + 1, index.as + 1, index.ps + 1].map(value => integer(value, 4)).join("");
const volumeColumns = "   NV  D1  D2  D3  LS  AS  PS        x              y              z";

export function protocolTimestamp(date = new Date()) {
  const n = (value, width = 2) => String(value).padStart(width, "0");
  return ` Date: ${n(date.getFullYear(), 4)}.${n(date.getMonth() + 1)}.${n(date.getDate())} Time: ${n(date.getHours())}:${n(date.getMinutes())}'${n(date.getSeconds())}.${n(date.getMilliseconds(), 3)}\"`;
}
export function protocolHeader(family, step, first, count, timestamp = protocolTimestamp()) {
  if (family === "JE" || family === "MH") {
    const title = family === "JE" ? "Плотность токов проводимости (А/кв.мм)" : "Намагниченность (кА/м)";
    const columns = family === "JE" ? "             Jx             Jy             Jz             Ex             Ey             Ez"
      : "             Mx             My             Mz             Hx             Hy             Hz";
    return `\n iDTK${integer(step, 5)}${first ? `               ${title}\n${volumeColumns}${columns}` : ""}\n`;
  }
  if (family === "VTSP") return first ? `${count}\n${volumeColumns}              H              M          B/mu0             Jc              E              J             RO\n iDTK${integer(step, 5)}     Электрофизическое состояние ВТСП\n` : ` iDTK${integer(step, 5)}\n`;
  if (!first) return `\n iDTK=${integer(step, 5)}\n`;
  return family === "HS" ? `${timestamp}\n\n               Индукция магнитного поля в заданных точках (Тл). iDTK=${integer(step, 5)}\n   ii   TK   ls  n12  n14             x               y               z            Bx              By              Bz\n`
    : `${timestamp}\n\n               Индукция магнитного поля внутри заданной области (Тл). iDTK=${integer(step, 5)}\n   ii   KV   i1   i2   i3  las asv psv      x            y            z           Bx             By             Bz\n`;
}

export function protocolRow(family, object, localRow, globalRow, data) {
  const { record, layout } = object;
  if (family === "MH" || family === "JE") return volumeIndices(record, layout.indices(localRow))
    + values(data.subarray(0, 6)) + (record.targ === 0 ? "  " + values(data.subarray(6, 9)) : "") + "\n";
  let indices;
  if (family === "HS") {
    const ls = Math.floor(localRow / layout.planeCount), point = localRow % layout.planeCount;
    indices = [globalRow + 1, record.id, ls + 1, Math.floor(point / layout.n2) + 1, point % layout.n2 + 1];
  } else {
    const row = layout.indices(localRow);
    indices = [globalRow + 1, record.id, row.i1 + 1, row.i2 + 1, row.i3 + 1, row.ls + 1, row.as + 1, row.ps + 1];
  }
  return indices.map(value => integer(value, 5)).join("") + values(data.subarray(0, 3), "f") + values(data.subarray(3, 6), "G") + "\n";
}

export function planTextProtocols(task, metadata) {
  const families = {};
  for (const name of TEXT_PROTOCOL_FAMILIES) {
    if (!sourceRecords(task, name).length) continue;
    const meta = metadata[name];
    if (!meta || meta.error || !meta.steps?.length) throw new Error(meta?.error || `${name}.h5: нет сохранённых результатов`);
    const objects = mapResultObjects(task, name, meta.header).map(object => ({ ...object,
      layout: name === "HS" ? regionLayout(object.record) : elementLayout(object.record, name === "HV") }));
    if (meta.steps.some(step => step.index > task.general.countTimeSteps)) {
      const lastStep = meta.steps.reduce((last, step) => Math.max(last, step.index), 0);
      throw new Error(`${name}.h5: шаги не соответствуют input3XX (максимальный номер шага). Ожидается: не более ${task.general.countTimeSteps}, фактически: ${lastStep}.`);
    }
    families[name] = { name, objects, steps: meta.steps, count: objects.reduce((sum, o) => sum + o.count, 0) };
  }
  const hts = (families.MH?.objects ?? []).filter(o => o.record.targ === 0 && o.record.model === 2);
  if (hts.length) {
    const currents = new Map((families.JE?.objects ?? []).map(o => [o.record.id, o]));
    const objects = hts.map(o => {
      const je = currents.get(o.record.id);
      if (!je || je.count !== o.count) {
        throw new Error(`ВТСП №${o.record.id}: сетки MH и JE не совпадают (число точек). Ожидается: ${o.count} (MH), фактически: ${je ? je.count : "объект отсутствует"} (JE).`);
      }
      return { ...o, je };
    });
    const mhSteps = families.MH.steps, jeSteps = families.JE.steps;
    if (mhSteps.length !== jeSteps.length) {
      throw new Error(`ВТСП: сохранённые шаги MH и JE не совпадают (число сохранённых шагов). Ожидается: ${mhSteps.length} (MH), фактически: ${jeSteps.length} (JE).`);
    }
    const mismatch = mhSteps.findIndex((step, index) => step.index !== jeSteps[index].index);
    if (mismatch !== -1) {
      throw new Error(`ВТСП: сохранённые шаги MH и JE не совпадают (номер шага в позиции ${mismatch + 1}). Ожидается: ${mhSteps[mismatch].index} (MH), фактически: ${jeSteps[mismatch].index} (JE).`);
    }
    families.VTSP = { name: "VTSP", objects, steps: families.MH.steps, count: objects.reduce((sum, o) => sum + o.count, 0) };
  }
  const plans = TEXT_PROTOCOLS.filter(p => families[p.family]).map(p => ({ ...p, ...families[p.family], name: p.name }));
  if (!plans.length) throw new Error("В задании нет сохранённых результатов для текстовых протоколов");
  return plans;
}

export function vtspProtocolRow(object, localRow, mh, je, axis, property) {
  const real = mh instanceof Float32Array ? Math.fround : value => value;
  const dot = offset => real(real(real(mh[offset] * real(axis[0])) + real(mh[offset + 1] * real(axis[1]))) + real(mh[offset + 2] * real(axis[2])));
  const h = dot(6), m = dot(3), b = real(h + m);
  const j = real(Math.hypot(...je.subarray(3, 6))), e = real(Math.hypot(...je.subarray(6, 9)));
  const arg = Math.abs(real(b / real(property.j_HC0)));
  let jc = 0;
  if (arg < 1) {
    const power = real(arg ** real(property.JCa)), beta = real(property.JCb);
    const shape = beta >= 0 ? real(Math.max(0, real(1 - power)) ** beta) : real(1 / real(real(1 + power) ** -beta));
    jc = real(real(property.JC0) * shape);
  }
  return volumeIndices(object.record, object.layout.indices(localRow)) + values(mh.subarray(0, 3))
    + values([h, m, b, jc, e, j, j === 0 ? 0 : real(e / j)]) + "\n";
}

export async function textProtocolWriteAccess(handle) {
  if (handle?.kind !== "directory") throw new Error("Выберите задание");
  const request = handle.requestPermission ?? handle.queryPermission;
  if (request && await request.call(handle, { mode: "readwrite" }) !== "granted") {
    throw new Error("Нет разрешения на запись текстовых протоколов");
  }
}
// Only the selected task's five derived files count, including empty files.
// Metadata checks must neither read result data nor request write access.
export async function listExistingTextProtocols(handle, { signal } = {}) {
  signal?.throwIfAborted();
  let output;
  try { output = await handle.getDirectoryHandle("output3XX"); }
  catch (error) { if (missing(error)) return []; throw error; }
  const found = [];
  for (const { name } of TEXT_PROTOCOLS) {
    signal?.throwIfAborted();
    try { await output.getFileHandle(name); found.push(name); }
    catch (error) { if (!missing(error)) throw error; }
  }
  signal?.throwIfAborted();
  return found;
}

export async function deleteTextProtocols(handle, { check = () => {}, onProgress = () => {} } = {}) {
  let output;
  try { output = await handle.getDirectoryHandle("output3XX"); }
  catch (error) { if (missing(error)) return { deleted: [] }; throw error; }
  const deleted = [];
  for (const { name } of TEXT_PROTOCOLS) {
    check(); onProgress(`Удаление: ${name}`);
    try {
      await output.getFileHandle(name); // A directory with this name must never be removed.
      await output.removeEntry(name); deleted.push(name);
    } catch (error) { if (!missing(error)) throw new Error(`${name}: ${error.message}. Удалено файлов: ${deleted.length}`); }
  }
  return { deleted };
}

export async function createTextProtocols(task, metadata, reader, output, {
  check = () => {}, onProgress = () => {}, chunkSize = 2048, timestamp = protocolTimestamp(),
} = {}) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 16384) throw new Error("Недопустимый размер блока");
  const plans = planTextProtocols(task, metadata), writers = [], created = [];
  const materials = new Map();
  for (const object of plans.find(p => p.family === "VTSP")?.objects ?? []) {
    check(); materials.set(object.record.id, await loadCurrentMaterial(task, object.record.xapName));
  }
  try {
    // File System Access writes to temporary backing files. Finish formatting all
    // five before closing any stream, so read/format/cancel failures keep old files.
    for (const plan of plans) {
      check();
      let existed = true, file;
      try { file = await output.getFileHandle(plan.name); }
      catch (error) { if (!missing(error)) throw error; existed = false; file = await output.getFileHandle(plan.name, { create: true }); }
      const entry = { name: plan.name, existed, stream: null, closed: false };
      writers.push(entry);
      entry.stream = await file.createWritable({ keepExistingData: false });
      const write = text => { check(); return entry.stream.write(text); };
      for (let s = 0; s < plan.steps.length; s++) {
        const step = plan.steps[s].index;
        check(); onProgress(`${plan.name}: шаг ${s + 1} из ${plan.steps.length} (iDTK=${step})`);
        await write(protocolHeader(plan.family, step, s === 0, plan.count, timestamp));
        const projection = plan.family === "VTSP" ? buildGeometryTimeModel(task, task.moves, step) : null;
        for (const object of plan.objects) {
          const record = object.record;
          if (projection?.diagnostics.some(d => d.schemaId === "general" || (d.schemaId === "elements" && d.recordIndex === record.recordIndex))) {
            throw new Error(`ВТСП №${record.id}: невозможно восстановить положение материала на шаге ${step}`);
          }
          const axes = projection ? Array.from({ length: object.layout.copies[0] }, (_, ls) => fmmAxis(projection.model.elements[record.recordIndex], ls)) : null;
          for (let start = 0; start < object.count; start += chunkSize) {
            check();
            const count = Math.min(chunkSize, object.count - start), name = plan.family === "VTSP" ? "MH" : plan.family;
            const frame = await reader.read({ name, step, start: object.start + start, count });
            const je = axes ? await reader.read({ name: "JE", step, start: object.je.start + start, count }) : null;
            const lines = [];
            for (let i = 0; i < count; i++) {
              const data = frame.values.subarray(i * frame.stride, (i + 1) * frame.stride), local = start + i;
              lines.push(axes ? vtspProtocolRow(object, local, data, je.values.subarray(i * je.stride, (i + 1) * je.stride),
                axes[object.layout.indices(local).ls], materials.get(record.id))
                : protocolRow(plan.family, object, local, object.start + local, data));
            }
            await write(lines.join(""));
          }
        }
      }
    }
    check(); onProgress("Сохранение протоколов…", { committing: true });
    for (const entry of writers) { await entry.stream.close(); entry.closed = true; created.push(entry.name); }
    // Remove stale members of the same derived set when this task has no such data.
    for (const { name } of TEXT_PROTOCOLS) if (!created.includes(name)) {
      try { await output.getFileHandle(name); await output.removeEntry(name); }
      catch (error) { if (!missing(error)) throw error; }
    }
    return { created, skipped: TEXT_PROTOCOLS.filter(p => !created.includes(p.name)).map(p => p.name) };
  } catch (error) {
    for (const entry of writers) if (!entry.closed) {
      try { await entry.stream?.abort(); } catch { /* Preserve the original failure. */ }
      if (!entry.existed) { try { await output.removeEntry(entry.name); } catch { /* Best effort for a new empty placeholder. */ } }
    }
    if (created.length) throw new Error(`${error.message}. Уже сохранено: ${created.join(", ")}`);
    throw error;
  }
}
