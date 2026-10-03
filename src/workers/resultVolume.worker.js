import { buildResultVolumeField, ResultVolumeLimitError } from "../services/visualization/resultVolumeField.js";

// Only the previous spatial plan is retained. Values and masks are transferred
// to the renderer; transferred buffers are never used to interpolate a new step.
let previous = null;
self.onmessage = ({ data }) => {
  try {
    const built = buildResultVolumeField({ domains: data.domains, previous });
    previous = built;
    const domains = built.domains.map(({ key, dimensions, bounds, values, mask }) => ({ key, dimensions, bounds, values, mask }));
    const result = { domains, minimum: built.minimum, maximum: built.maximum,
      fallbackDomainKeys: built.fallbackDomainKeys, notice: built.notice };
    self.postMessage({ id: data.id, result }, domains.flatMap(domain => [domain.values.buffer, domain.mask.buffer]));
  } catch (error) {
    previous = null;
    self.postMessage({ id: data.id, error: error.message ?? String(error), limit: error instanceof ResultVolumeLimitError });
  }
};
