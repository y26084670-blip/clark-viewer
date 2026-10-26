import { calculateResultGraphs } from "../services/visualization/resultGraphField.js";
self.onmessage = ({ data }) => {
  try {
    const result = calculateResultGraphs(data.input);
    self.postMessage({ id: data.id, result }, result.flatMap(g => g.error ? [] : [g.distances.buffer, g.values.buffer]));
  } catch (error) { self.postMessage({ id: data.id, error: error.message ?? String(error) }); }
};
