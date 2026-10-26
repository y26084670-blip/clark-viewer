import { elementLayout, mapResultObjects } from "./resultMappings.js";
import { isFmm } from "./fmmCharacteristics.js";
import { pointAt, scalarAt } from "./resultPlots.js";
import { checkReadRange } from "./resultLayout.js";
import { relativeConductivityBases, relativeConductivityValues } from "./relativeConductivity.js";

export const ELEMENT_LINE_CHANNEL = Object.freeze({ key: "element-distance", kind: "distance",
  label: "Расстояние вдоль элемента", unit: "мм" });
export const supportsElementLine = channel => channel?.kind === "field" && channel.group === "elements";
const fullGrid = channel => ["HV", "AV"].includes(channel.file);
const number = value => String(Number(value.toPrecision(8)));
const coordinates = point => `(${point.map(number).join("; ")}) мм`;

export function elementLineObjects(task, channel) {
  if (!supportsElementLine(channel)) throw new Error("Для отрезка выберите локальную величину, сохранённую в ЭО элемента.");
  const metadata = task.metadata?.[channel.file];
  if (!metadata?.steps?.length || metadata.error) throw new Error(metadata?.error || "Нет сохранённых кадров этой величины.");
  return mapResultObjects(task, channel.file, metadata.header).filter(({ record }) =>
    (!channel.solvedOnly || record.targ === 0) && (!channel.fmmOnly || isFmm(record)));
}

export function elementLineLayout(record, channel) {
  return elementLayout(record, fullGrid(channel));
}

// Indices shown to the user are one-based, including the independently saved
// symmetry images. The even-sized middle is the lower of the two centre rows.
export function defaultElementLine(record, channel, previous = {}) {
  const { dimensions, copies } = elementLineLayout(record, channel);
  const direction = Number.isInteger(previous.direction) && dimensions[previous.direction] > 1
    ? previous.direction : dimensions.indexOf(Math.max(...dimensions));
  const valid = (value, maximum) => Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= maximum;
  return { element: record.id, direction,
    indices: dimensions.map((n, i) => valid(previous.indices?.[i], n) ? Number(previous.indices[i]) : Math.ceil(n / 2)),
    copies: copies.map((n, i) => valid(previous.copies?.[i], n) ? Number(previous.copies[i]) : 1) };
}

export function elementLineRequest(task, channel, spec, step) {
  const object = elementLineObjects(task, channel).find(item => item.record.id === Number(spec.element));
  if (!object) throw new Error("Выберите элемент из списка доступных для величины Y.");
  const layout = elementLineLayout(object.record, channel), direction = Number(spec.direction);
  if (!Number.isInteger(direction) || direction < 0 || direction > 2) throw new Error("Выберите направление i1, i2 или i3.");
  const length = layout.dimensions[direction];
  if (length < 2) throw new Error(`В направлении i${direction + 1} только один ЭО: для отрезка нужны хотя бы два центра.`);
  const indices = layout.dimensions.map((n, axis) => {
    if (axis === direction) return 0;
    const index = Number(spec.indices?.[axis]);
    if (!Number.isSafeInteger(index) || index < 1 || index > n) throw new Error(`Индекс i${axis + 1} должен быть от 1 до ${n}.`);
    return index - 1;
  });
  const copies = layout.copies.map((n, axis) => {
    const index = Number(spec.copies?.[axis] ?? 1);
    if (!Number.isSafeInteger(index) || index < 1 || index > n) throw new Error(`Образ ${["LS", "AS", "PS"][axis]} должен быть от 1 до ${n}.`);
    return index - 1;
  });
  step = Number(step);
  if (!Number.isSafeInteger(step) || !task.metadata[channel.file].steps.some(s => s.index === step)) {
    throw new Error("Выберите номер сохранённого момента времени для величины Y.");
  }
  const copyCount = layout.copies.reduce((a, b) => a * b, 1);
  const row = ((indices[0] * layout.dimensions[1] + indices[1]) * layout.dimensions[2] + indices[2]) * copyCount
    + (copies[0] * layout.copies[1] + copies[1]) * layout.copies[2] + copies[2];
  const every = layout.dimensions.slice(direction + 1).reduce((a, b) => a * b, copyCount);
  const count = (length - 1) * every + 1;
  checkReadRange(row, count, object.count, task.metadata[channel.file].header.stride, every);
  const fixed = indices.flatMap((i, axis) => axis === direction ? [] : [`i${axis + 1}=${i + 1}`]);
  const images = layout.copies.flatMap((n, i) => n > 1 ? [`${["LS", "AS", "PS"][i]}=${copies[i] + 1}`] : []);
  const label = `№${object.record.id} ${object.record.name || "Элемент"} · i${direction + 1} (${[...fixed, ...images].join(", ")})`;
  return { object, layout, direction, indices, length, label,
    request: { name: channel.file, step, start: object.start + row, count, every } };
}

// A segment is defined by the first/last saved centres, not by the element's
// vertices or by equally spaced ordinal numbers. Reject a curved/reversing row
// rather than silently calling its arc length the length of a straight segment.
export function elementLineDistances(positions, coordinateBytes = 8) {
  if (positions.length < 2 || positions.some(p => p.length !== 3 || !p.every(Number.isFinite))) {
    throw new Error("Некорректные координаты центров ЭО.");
  }
  const start = positions[0], end = positions.at(-1), delta = end.map((x, i) => x - start[i]);
  const length = Math.hypot(...delta);
  if (!(length > 0 && Number.isFinite(length))) throw new Error("Начальный и конечный центры ЭО совпадают.");
  const epsilon = coordinateBytes === 4 ? 2 ** -23 : Number.EPSILON;
  let scale = length;
  for (const p of positions) for (const x of p) scale = Math.max(scale, Math.abs(x));
  const tolerance = Math.max(length * 1e-9, 32 * epsilon * scale);
  const unit = delta.map(x => x / length);
  const distances = positions.map(p => {
    const offset = p.map((x, i) => x - start[i]), s = offset.reduce((a, x, i) => a + x * unit[i], 0);
    if (Math.hypot(...offset.map((x, i) => x - s * unit[i])) > tolerance) {
      throw new Error("Центры ЭО выбранного ряда не лежат на одном прямом отрезке. Выберите другое направление.");
    }
    return s;
  });
  distances[0] = 0; distances[distances.length - 1] = length;
  if (distances.some((s, i) => s < 0 || s > length || (i && s <= distances[i - 1]))) {
    throw new Error("Центры ЭО не идут последовательно от начала к концу отрезка.");
  }
  return { distances, start, end, length };
}

export async function readElementLineProfile(task, channel, spec, y, readFrame = request => task.reader.read(request)) {
  const selection = elementLineRequest(task, channel, spec, y.step);
  const { request, object } = selection;
  let frame = await readFrame(request);
  if (frame.count !== selection.length || frame.stride !== task.metadata[channel.file].header.stride
    || frame.values.length !== frame.count * frame.stride || frame.stride < 4) {
    throw new Error("Срез результата не совпадает с выбранным рядом ЭО.");
  }
  if (channel.relativeConductivity) frame = { ...frame,
    relativeConductivityValues: relativeConductivityValues(frame, object.record, await relativeConductivityBases(task)) };
  const positions = Array.from({ length: frame.count }, (_, row) => pointAt(frame, row));
  const segment = elementLineDistances(positions, frame.values.BYTES_PER_ELEMENT);
  const time = request.step * task.general.timeStep;
  if (!Number.isFinite(time)) throw new Error("Некорректное значение времени.");
  const component = y.component ?? "norm";
  if (!["norm", "0", "1", "2"].includes(component)) throw new Error("Неверная компонента величины.");
  const points = segment.distances.map((x, row) => {
    const value = scalarAt(frame, row, channel.quantity, component);
    const undefinedSigma = channel.relativeConductivity && Number.isNaN(value);
    if (!Number.isFinite(value) && !undefinedSigma) throw new Error("Результат содержит нечисловые значения.");
    return { x, y: undefinedSigma ? null : value, step: request.step, time,
      position: positions[row], node: row + 1, volumeNumber: request.start + row * request.every + 1 };
  });
  const prefix = `${selection.label} · №${request.step}, t=${number(time)} с`;
  return { points, length: segment.length, label: selection.label,
    annotations: [`${prefix}: начало ${coordinates(segment.start)}`,
      `Конец ${coordinates(segment.end)}; L=${number(segment.length)} мм`],
    tooltip: point => [`${selection.label}; i${selection.direction + 1}=${point.node}; узел файла №${point.volumeNumber}`,
      `s=${number(point.x)} мм; XYZ=${coordinates(point.position)}`, `Момент №${request.step}; t=${number(time)} с`,
      point.y === null ? "При |E| = 0 значение σ/j_gmin не определено" : `${channel.label}=${number(point.y)} ${channel.unit}`] };
}
