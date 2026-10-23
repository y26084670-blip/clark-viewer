import { QUANTITIES } from "./resultMappings.js";
import { readObjectFrames } from "./resultRequests.js";
import { resultVolumeDomains, scalarScene, vectorScene } from "./resultPlots.js";
import { buildResultVolumeField } from "../visualization/resultVolumeField.js";
import { buildResultSurfaceField, isResultSurfaceDomain } from "../visualization/resultSurfaceField.js";
import { attachResultVolumeSupport } from "./resultVolumeSupport.js";

/** Both interpolation and node fallback retain the complete saved grid. */
export async function readResultVolumeFrame(request, previousVolumeFields = null, processor = null) {
  const quantity = QUANTITIES[request.quantityKey];
  const frames = await readObjectFrames(request);
  const result = { scene: quantity.components === 1 ? null : vectorScene(frames, quantity, request.task),
    scalarScene: quantity.components === 1 ? scalarScene(frames, quantity, request.task) : null, sampled: false };
  const savedDomains = resultVolumeDomains(frames, quantity, result.scene ?? result.scalarScene, request.task);
  // The worker transfers grid buffers. Compute the saved range before transfer.
  let minimum = Infinity, maximum = -Infinity;
  for (const domain of savedDomains) for (const value of domain.values) if (Number.isFinite(value)) {
    minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
  }
  const surfaceFields = buildResultSurfaceField({ domains: savedDomains.filter(isResultSurfaceDomain) });
  const domains = attachResultVolumeSupport(savedDomains.filter(domain => !isResultSurfaceDomain(domain)),
    { task: request.task, quantity, time: request.time });
  const built = !domains.length ? { domains: [], fallbackPoints: [], fallbackDomainKeys: [], notice: "" }
    : processor ? await processor.process(domains)
    : buildResultVolumeField({ domains, previous: previousVolumeFields });
  const notice = [built.notice, surfaceFields.notice].filter(Boolean).join(". ");
  const volumeFields = { ...built, surfaces: surfaceFields.surfaces,
    fallbackPoints: [...built.fallbackPoints, ...surfaceFields.fallbackPoints],
    fallbackDomainKeys: [...built.fallbackDomainKeys ?? [], ...surfaceFields.fallbackDomainKeys],
    minimum: Number.isFinite(minimum) ? minimum : 0, maximum: Number.isFinite(maximum) ? maximum : 0, notice };
  return { ...result, volumeFields, volumeNotice: notice };
}
