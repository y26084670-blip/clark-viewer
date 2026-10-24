import { unpackKvVertices } from "../solver/geometryKv.js";
import { unpackTkVertices } from "../solver/geometryTk.js";

// Arithmetic mean of the element's directional cell sizes. Average the four
// boundary edges of each direction, then divide by that direction's EO count.
// This depends on one element's geometry, never on the selected scene or field.
export function meanResultCellSize(record, group = "elements") {
  if (!record?.geo || !record.dp) return null;
  const geo = Array.from(record.geo).flat(), counts = Array.from(record.dp).flat();
  const planar = group === "regions";
  const { vertices, err } = planar ? unpackTkVertices(geo, record.geoType) : unpackKvVertices(geo, record.geoType);
  if (err || !vertices.every(p => p.every(Number.isFinite))) return null;
  const edges = planar ? [[[0, 1], [3, 2]], [[0, 3], [1, 2]]]
    : [[[0, 1], [2, 3], [4, 5], [6, 7]], [[0, 2], [1, 3], [4, 6], [5, 7]],
      [[0, 4], [1, 5], [2, 6], [3, 7]]];
  let sum = 0, directions = 0;
  for (const [axis, pairs] of edges.entries()) {
    const intervals = counts[axis] - (planar ? 1 : 0);
    if (!(intervals > 0)) continue;
    const length = pairs.reduce((total, [a, b]) => total + Math.hypot(...vertices[a].map((v, i) => v - vertices[b][i])), 0) / pairs.length;
    sum += length / intervals; directions++;
  }
  const size = sum / directions;
  return Number.isFinite(size) && size > 0 ? size : null;
}
