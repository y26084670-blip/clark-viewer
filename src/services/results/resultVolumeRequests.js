import { QUANTITIES } from "./resultMappings.js";
import { readObjectFrames, resultObjects } from "./resultRequests.js";
import { resultVolumeDomains, scalarScene, vectorScene } from "./resultPlots.js";
import { buildResultVolumeField, ResultVolumeLimitError, VOLUME_MAX_DOMAINS } from "../visualization/resultVolumeField.js";
import { attachResultVolumeSupport } from "./resultVolumeSupport.js";

export const VOLUME_MAX_NODES = 100_000;
const POINT_BUDGET = 5000;

function scenes(frames, quantity) {
  return { scene: quantity.components === 1 ? null : vectorScene(frames, quantity),
    scalarScene: quantity.components === 1 ? scalarScene(frames, quantity) : null,
    sampled: frames.some(item => item.frame.count < item.originalCount) };
}

/** Full HDF5 rows are required for interpolation. Limits fall back explicitly to
 * the normal bounded node display; a stride sample is never treated as a grid.
 * Only spatial weights may be reused: scalar values always come from this step.
 */
export async function readResultVolumeFrame(request, previousVolumeFields = null, processor = null) {
  const quantity = QUANTITIES[request.quantityKey];
  const objects = resultObjects(request.task, request.quantityKey).filter(item => request.selected.includes(item.record.id));
  const count = objects.reduce((sum, item) => sum + item.count, 0);
  try {
    if (count > VOLUME_MAX_NODES) {
      throw new ResultVolumeLimitError(`Объёмная карта требует ${count.toLocaleString("ru-RU")} узлов; предел — ${VOLUME_MAX_NODES.toLocaleString("ru-RU")}`);
    }
    const frames = await readObjectFrames({ ...request, budget: null });
    const result = scenes(frames, quantity);
    const savedDomains = resultVolumeDomains(frames, quantity, result.scene ?? result.scalarScene);
    if (savedDomains.length > VOLUME_MAX_DOMAINS) {
      throw new ResultVolumeLimitError(`Для объёмной карты допускается не более ${VOLUME_MAX_DOMAINS} отдельных образов`);
    }
    const domains = attachResultVolumeSupport(savedDomains,
      { task: request.task, quantity, time: request.time });
    const volumeFields = processor ? await processor.process(domains)
      : buildResultVolumeField({ domains, previous: previousVolumeFields });
    return { ...result, volumeFields, volumeNotice: volumeFields.notice };
  } catch (error) {
    if (!(error instanceof ResultVolumeLimitError)) throw error;
    const frames = await readObjectFrames({ ...request, budget: POINT_BUDGET });
    const result = scenes(frames, quantity);
    const fallbackPoints = result.scene?.vectors ?? result.scalarScene?.points ?? [];
    let minimum = Infinity, maximum = -Infinity;
    for (const point of fallbackPoints) {
      const value = point.value ?? point.magnitude;
      minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
    }
    const notice = `${error.message}. Показана цветовая карта узлов${result.sampled ? " (выборка)" : ""}.`;
    return { ...result, volumeFields: { domains: [], fallbackPoints,
      minimum: Number.isFinite(minimum) ? minimum : 0, maximum: Number.isFinite(maximum) ? maximum : 0, notice }, volumeNotice: notice };
  }
}
