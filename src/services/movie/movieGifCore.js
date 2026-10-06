import * as gifenc from "gifenc";

import { MOVIE_LIMITS, validateMovieFrame } from "./movieFrame.js";

// The package exposes ESM to Vite and CommonJS to Node's worker tests.
const { GIFEncoder, quantize, applyPalette } = gifenc.GIFEncoder ? gifenc : gifenc.default;

// One session retains compressed GIF bytes only. Quantization and RGBA input
// belong to the current call and become collectible before the next frame.
export function createMovieGifSession({ maxBytes = MOVIE_LIMITS.bytes } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MOVIE_LIMITS.bytes) {
    throw new Error("Недопустимый предел размера GIF");
  }
  const gif = GIFEncoder({ initialCapacity: Math.min(4096, maxBytes) });
  let count = 0, width = 0, height = 0, ended = false, writtenBytes = 0, sessionRepeat;
  const guard = count => {
    if (writtenBytes + count > maxBytes) {
      throw new Error("Размер GIF превышает допустимые 128 МиБ; уменьшите число или размер кадров");
    }
    writtenBytes += count;
  };
  // gifenc exposes stream writes publicly. Guard every write, rather than
  // allowing a large final frame to cross the output limit before checking it.
  for (const [method, length] of [
    ["writeByte", () => 1],
    ["writeBytes", (data, _offset = 0, size = data.length) => size],
    ["writeBytesView", (data, _offset = 0, size = data.byteLength) => size],
  ]) {
    const write = gif.stream[method].bind(gif.stream);
    gif.stream[method] = (...args) => { guard(length(...args)); return write(...args); };
  }
  return {
    addFrame(frame, { delayMs, repeat = 0 } = {}) {
      if (ended) throw new Error("Запись GIF уже завершена");
      try {
        validateMovieFrame(frame, delayMs);
        if (repeat !== 0 && repeat !== -1) throw new Error("Некорректный режим повторения GIF");
        if (count && (sessionRepeat !== repeat || repeat === -1)) {
          throw new Error("Статический GIF содержит только один кадр; режим записи не меняется");
        }
        sessionRepeat = repeat;
        if (count >= MOVIE_LIMITS.frames) throw new Error("В фильме допускается не более 2000 кадров");
        if (count && (frame.width !== width || frame.height !== height)) {
          throw new Error("Размер вида изменился во время записи фильма");
        }
        width = frame.width; height = frame.height;
        // gifenc reads the complete underlying buffer; normalize subviews.
        const rgba = frame.data.byteOffset === 0 && frame.data.byteLength === frame.data.buffer.byteLength
          ? frame.data : frame.data.slice();
        const palette = quantize(rgba, 256, { format: "rgb565" });
        const indexed = applyPalette(rgba, palette, "rgb565");
        gif.writeFrame(indexed, width, height, { palette, delay: repeat === -1 ? 0 : delayMs, repeat, dispose: 1 });
        count++;
        return { frames: count, bytes: gif.bytesView().byteLength };
      } catch (error) {
        ended = true;
        throw error;
      }
    },
    finish() {
      if (ended) throw new Error("Запись GIF уже завершена");
      ended = true;
      if (!count) throw new Error("В фильме нет кадров");
      gif.finish();
      return gif.bytesView();
    },
  };
}
