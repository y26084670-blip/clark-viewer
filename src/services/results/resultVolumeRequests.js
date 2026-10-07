import { QUANTITIES } from "./resultMappings.js";
import { readObjectFrames, resultObjects } from "./resultRequests.js";
import { resultVolumeDomains, scalarScene, vectorScene } from "./resultPlots.js";
import { buildResultVolumeField, ResultVolumeLimitError, VOLUME_MAX_DOMAINS } from "../visualization/resultVolumeField.js";
import { buildResultSurfaceField, isResultSurfaceDomain } from "../visualization/resultSurfaceField.js";
import { attachResultVolumeSupport } from "./resultVolumeSupport.js";

export const VOLUME_MAX_NODES = 100_000;
const POINT_BUDGET = 5000;

function scenes(frames, quantity, task) {
  return { scene: quantity.components === 1 ? null : vectorScene(frames, quantity, task),
    scalarScene: quantity.components === 1 ? scalarScene(frames, quantity, task) : null,
    sampled: frames.some(item => item.frame.count < item.originalCount) };
}

// Fallback nodes share the frame's visible-point budget with the other layers.
// Retain at least one point per saved image, then sample spatially inside it.
export function boundedVolumeFallbackPoints(points, budget) {
  if (points.length <= budget) return points;
  const groups = new Map();
  for (const point of points) {
    const key = `${point.source.schemaId}:${point.source.recordIndex}:${point.instance.ls}:${point.instance.as}:${point.instance.ps}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(point);
  }
  if (groups.size > budget) throw new Error(`Для показа всех образов требуется не менее ${groups.size} узлов; доступно ${budget}`);
  const entries = [...groups.values()].map(points => ({ points, allowance: 1 }));
  let remaining = budget - entries.length, active = entries.filter(entry => entry.points.length > 1);
  while (remaining && active.length) {
    const share = Math.max(1, Math.floor(remaining / active.length));
    for (const entry of active) {
      const add = Math.min(share, entry.points.length - entry.allowance, remaining);
      entry.allowance += add; remaining -= add;
    }
    active = active.filter(entry => entry.allowance < entry.points.length);
  }
  return entries.flatMap(({ points, allowance }) => {
    const every = Math.ceil(points.length / allowance);
    return points.filter((_, index) => index % every === 0);
  });
}

/** Full HDF5 rows are required for interpolation. Limits fall back explicitly to
 * the normal bounded node display; a stride sample is never treated as a grid.
 * Only spatial weights may be reused: scalar values always come from this step.
 */
export async function readResultVolumeFrame(request, previousVolumeFields = null, processor = null) {
  const quantity = QUANTITIES[request.quantityKey];
  const objects = resultObjects(request.task, request.quantityKey).filter(item => request.selected.includes(item.record.id));
  const count = objects.reduce((sum, item) => sum + item.count, 0);
  const fallbackBudget = request.fallbackBudget ?? POINT_BUDGET;
  try {
    if (request.volumeDisabledReason) throw new ResultVolumeLimitError(request.volumeDisabledReason);
    if (count > VOLUME_MAX_NODES) {
      throw new ResultVolumeLimitError(`Объёмная карта требует ${count.toLocaleString("ru-RU")} узлов; предел — ${VOLUME_MAX_NODES.toLocaleString("ru-RU")}`);
    }
    const frames = await readObjectFrames({ ...request, budget: null });
    const result = scenes(frames, quantity, request.task);
    const savedDomains = resultVolumeDomains(frames, quantity, result.scene ?? result.scalarScene, request.task);
    if (savedDomains.length > VOLUME_MAX_DOMAINS) {
      throw new ResultVolumeLimitError(`Для объёмной карты допускается не более ${VOLUME_MAX_DOMAINS} отдельных образов`);
    }
    // The volume processor transfers these buffers to its worker. Read their
    // range now, and do not mix an empty branch's default zero into the range.
    let minimum = Infinity, maximum = -Infinity;
    for (const domain of savedDomains) for (const value of domain.values) if (Number.isFinite(value)) {
      minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
    }
    // Saved 2D observation grids have an exact surface topology. Keep them out
    // of the volume processor: no voxels, fabricated thickness or support hull.
    const surfaceFields = buildResultSurfaceField({ domains: savedDomains.filter(isResultSurfaceDomain) });
    const domains = attachResultVolumeSupport(savedDomains.filter(domain => !isResultSurfaceDomain(domain)),
      { task: request.task, quantity, time: request.time });
    const built = !domains.length ? { domains: [], fallbackPoints: [], fallbackDomainKeys: [], notice: "" }
      : processor ? await processor.process(domains)
      : buildResultVolumeField({ domains, previous: previousVolumeFields });
    const allFallbackPoints = [...built.fallbackPoints, ...surfaceFields.fallbackPoints];
    const fallbackPoints = boundedVolumeFallbackPoints(allFallbackPoints, fallbackBudget);
    const sampled = fallbackPoints.length < allFallbackPoints.length;
    const notice = [built.notice, surfaceFields.notice, sampled ? "Цветные узлы показаны выборкой в общем пределе кадра" : ""].filter(Boolean).join(". ");
    const volumeFields = { ...built, surfaces: surfaceFields.surfaces, fallbackPoints,
      fallbackDomainKeys: [...built.fallbackDomainKeys ?? [], ...surfaceFields.fallbackDomainKeys],
      minimum: Number.isFinite(minimum) ? minimum : 0, maximum: Number.isFinite(maximum) ? maximum : 0, notice };
    return { ...result, sampled: result.sampled || sampled, volumeFields, volumeNotice: notice };
  } catch (error) {
    if (!(error instanceof ResultVolumeLimitError)) throw error;
    const frames = await readObjectFrames({ ...request, budget: fallbackBudget });
    const result = scenes(frames, quantity, request.task);
    const fallbackPoints = result.scene?.vectors ?? result.scalarScene?.points ?? [];
    let minimum = Infinity, maximum = -Infinity;
    for (const point of fallbackPoints) {
      const value = point.value ?? point.magnitude;
      minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
    }
    const notice = `${error.message}. Показана цветовая карта узлов${result.sampled ? " (выборка)" : ""}.`;
    return { ...result, volumeFields: { domains: [], surfaces: [], fallbackPoints,
      minimum: Number.isFinite(minimum) ? minimum : 0, maximum: Number.isFinite(maximum) ? maximum : 0, notice }, volumeNotice: notice };
  }
}
