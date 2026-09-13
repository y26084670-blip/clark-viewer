import { elementLayout, regionLayout } from "./resultMappings.js";

// Sample spatial nodes independently in every saved symmetry image. A stride
// over the complete object can otherwise skip whole images in inner LS/AS/PS
// loops. Observation areas store LS as the outer loop instead.
export function planResultSampling(objects, quantity, budget) {
  if (!Number.isSafeInteger(budget) || budget < 1) throw new Error("Некорректный предел числа векторов");
  const regions = quantity.group === "regions";
  const plans = objects.map(object => {
    const layout = regions ? regionLayout(object.record)
      : elementLayout(object.record, quantity.file === "HV" || quantity.file === "AV");
    if (layout.count !== object.count) throw new Error("Сетка объекта не совпадает с данными");
    const images = regions ? layout.copies : layout.copies.reduce((a, b) => a * b, 1);
    return { object, images, nodes: object.count / images };
  });
  const imageCount = plans.reduce((sum, plan) => sum + plan.images, 0);
  if (imageCount > budget) {
    throw new Error(`Выбрано ${imageCount} сохранённых образов при пределе ${budget} векторов. Сократите выделение, чтобы показать каждый образ.`);
  }
  const images = plans.flatMap(plan => Array.from({ length: plan.images }, (_, image) => ({ plan, image, allowance: 0 })));
  let remaining = budget;
  let active = images;
  while (remaining && active.length) {
    const share = Math.max(1, Math.floor(remaining / active.length));
    for (const entry of active) {
      const add = Math.min(share, entry.plan.nodes - entry.allowance, remaining);
      entry.allowance += add;
      remaining -= add;
    }
    active = active.filter(entry => entry.allowance < entry.plan.nodes);
  }
  for (const plan of plans) plan.ranges = [];
  for (const { plan, image, allowance } of images) {
    const spatialStep = Math.ceil(plan.nodes / allowance);
    const samples = Math.ceil(plan.nodes / spatialStep);
    const every = spatialStep * (regions ? 1 : plan.images);
    const localStart = regions ? image * plan.nodes : image;
    plan.ranges.push({ start: plan.object.start + localStart, count: (samples - 1) * every + 1, every });
  }
  return plans.map(({ object, ranges }) => {
    // Keep the ordinary contiguous read when all nodes fit, avoiding a
    // separate HDF5 request for each image of a small object.
    const count = ranges.reduce((sum, range) => sum + Math.ceil(range.count / range.every), 0);
    return { object, ranges: count === object.count ? [{ start: object.start, count: object.count, every: 1 }] : ranges };
  });
}
