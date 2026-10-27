import { calculateResultGraphs } from "../services/visualization/resultGraphField.js";
self.onmessage = ({ data }) => {
  try {
    const result = calculateResultGraphs(data.input);
    self.postMessage({ id: data.id, result }, [...new Set(result.flatMap(g => (g.surfaces ?? []).flatMap(s => [s.positions.buffer, s.normals.buffer, s.values.buffer, s.indices.buffer])))]);
  } catch (error) { self.postMessage({ id: data.id, error: error.message ?? String(error) }); }
};
