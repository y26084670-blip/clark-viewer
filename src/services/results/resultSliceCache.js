// One 3D time step. MH/JE contain XYZ and both vector quantities in every row.
// Keep raw, immutable slices; worker interpolation transfers separate grid buffers.
const DEFAULT_BYTES = 64 * 1024 * 1024;

export function createResultSliceCache(task, maxBytes = DEFAULT_BYTES) {
  const retained = new Map(), pending = new Map();
  let bytes = 0;
  return async function readSlice(slice) {
    if (slice.name !== "MH" && slice.name !== "JE") return task.reader.read(slice);
    const key = [slice.name, slice.step, slice.start, slice.count, slice.every ?? 1].join(":");
    if (retained.has(key)) {
      const frame = retained.get(key);
      retained.delete(key); retained.set(key, frame);
      return frame;
    }
    if (pending.has(key)) return pending.get(key);
    const read = task.reader.read(slice);
    pending.set(key, read);
    try {
      const frame = await read;
      const size = frame.values.buffer.byteLength;
      if (size > maxBytes || !size) return frame;
      while (bytes + size > maxBytes) {
        const oldest = retained.keys().next().value;
        bytes -= retained.get(oldest).values.buffer.byteLength;
        retained.delete(oldest);
      }
      retained.set(key, frame); bytes += size;
      return frame;
    } finally { pending.delete(key); }
  };
}
