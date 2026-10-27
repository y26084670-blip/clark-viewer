export const GRAPH_COMPONENT_COLORS = ["#ff0000", "#00ff00", "#0000ff"];
export function graphProfileSeries(profile) {
  if (!profile?.positions) return [];
  return Array.from({ length: profile.components }, (_, component) => ({
    key: profile.components === 3 ? "XYZ"[component] : "scalar",
    label: profile.components === 3 ? `${profile.label} · ${"XYZ"[component]}` : profile.label,
    legendLabel: profile.components === 3 ? "XYZ"[component] : profile.label,
    color: profile.components === 3 ? GRAPH_COMPONENT_COLORS[component] : "#1776bd",
    points: Array.from(profile.distances, (x, n) => ({ x, y: profile.values[n * 3 + component] })),
  }));
}
export function graphProfileDescription(profile) {
  if (!profile) return "Данные сечения недоступны";
  const direction = d => profile.plane == null ? `направление ${d + 1}` : `DV${d + 1}`;
  return [profile.source.name, `№${profile.source.recordIndex + 1}`,
    profile.plane == null ? "Площадка" : `Срез DV${profile.plane + 1}: ${profile.discrete}/${profile.discreteCount}`,
    `Сечение ${direction(profile.transverseDirection)}: ${profile.index + 1}/${profile.count}`,
    `Вдоль ${direction(profile.direction)}`].join(" · ");
}

/** Small preview paths; the expanded chart and table always use all samples. */
export function graphProfileThumbnail(series, hidden = []) {
  let low = Infinity, high = -Infinity, length = 0;
  for (const s of series) if (!hidden.includes(s.key)) for (const p of s.points) if (Number.isFinite(p.y)) { low = Math.min(low, p.y); high = Math.max(high, p.y); length = Math.max(length, p.x); }
  const scale = high > low ? high - low : 1;
  return series.filter(s => !hidden.includes(s.key)).map(s => {
    let path = "", connected = false;
    const stride = Math.max(1, Math.ceil(s.points.length / 1200));
    for (let n = 0; n < s.points.length; n++) {
      const p = s.points[n]; if (!Number.isFinite(p.y)) { connected = false; continue; }
      if (n % stride && n !== s.points.length - 1) continue;
      const x = length ? 12 + 176 * p.x / length : 100, y = high > low ? 76 - 64 * (p.y - low) / scale : 44;
      path += `${connected ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`; connected = true;
      if (s.points.length === 1) path += `l.1,0`;
    }
    return { key: s.key, color: s.color, path };
  });
}
