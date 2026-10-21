// Reuse the renderers' export lifecycle so scales, legends and WebGL buffers
// match the displayed view and are restored even if capture fails.
export function protocolImage(frame) {
  const canvas = document.createElement("canvas");
  canvas.width = frame.width; canvas.height = frame.height;
  canvas.getContext("2d").putImageData(frame, 0, 0);
  return { kind: "image", dataUrl: canvas.toDataURL("image/png"), width: frame.width, height: frame.height };
}

export async function captureProtocolMovie(adapter, options) {
  if (!adapter) throw new Error("Дождитесь готовности графика.");
  const context = adapter.getContext();
  try {
    await adapter.prepare(options);
    return protocolImage(await adapter.capture(context.originalTime, options));
  } finally { await adapter.restore(context.originalTime); }
}

export async function captureProtocolRenderer(renderer, key, options) {
  if (!renderer || !key) throw new Error("Дождитесь готовности графика.");
  try {
    await renderer.renderReady(key, options);
    await renderer.prepare(options);
    return protocolImage(await renderer.capture(key, options));
  } finally { await renderer.restore(); }
}

export function protocolMoment(task, index) {
  return `Шаг ${index}; t = ${Number((index * (task?.general.timeStep ?? 0)).toPrecision(8))} с`;
}
