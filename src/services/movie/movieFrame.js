export const MOVIE_LIMITS = Object.freeze({
  width: 1280, height: 960, frames: 2000, bytes: 128 * 1024 * 1024,
  minDelayMs: 20, maxDelayMs: 60000, delayStepMs: 10,
});

export function validateMovieFrame(frame, delayMs) {
  const { width, height, data } = frame ?? {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width > MOVIE_LIMITS.width || height > MOVIE_LIMITS.height) {
    throw new Error(`Размер кадра должен быть не более ${MOVIE_LIMITS.width} × ${MOVIE_LIMITS.height}`);
  }
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)
      || !(data.buffer instanceof ArrayBuffer) || data.byteLength !== width * height * 4) {
    throw new Error("Кадр фильма должен содержать RGBA-данные всех пикселей");
  }
  if (!Number.isInteger(delayMs) || delayMs < MOVIE_LIMITS.minDelayMs
      || delayMs > MOVIE_LIMITS.maxDelayMs || delayMs % MOVIE_LIMITS.delayStepMs !== 0) {
    throw new Error("Интервал между кадрами должен быть от 20 до 60000 мс с шагом 10 мс");
  }
  return frame;
}
