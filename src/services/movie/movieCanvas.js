import { MOVIE_LIMITS } from "./movieFrame.js";

export const MOVIE_CAPTION_HEIGHT = 32;

export function movieCanvasSize(sourceWidth, sourceHeight) {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth < 1 || sourceHeight < 1) {
    throw new Error("Текущий вид не имеет доступного изображения для записи");
  }
  const scale = Math.min(1, MOVIE_LIMITS.width / sourceWidth,
    (MOVIE_LIMITS.height - MOVIE_CAPTION_HEIGHT) / sourceHeight);
  return { width: Math.max(1, Math.floor(sourceWidth * scale)),
    height: Math.max(1, Math.floor(sourceHeight * scale)) + MOVIE_CAPTION_HEIGHT };
}

/** Synchronous: the WebGL image is copied in the same task as renderer.render.
 * Overlay coordinates begin below the caption and use the scaled content size.
 */
export function captureMovieCanvas(source, { caption = "", overlay,
  background = "#ffffff", canvasFactory = () => document.createElement("canvas") } = {}) {
  const { width, height } = movieCanvasSize(source?.width, source?.height);
  const canvas = canvasFactory();
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Браузер не предоставляет Canvas 2D для записи фильма");
  const contentHeight = height - MOVIE_CAPTION_HEIGHT;
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, MOVIE_CAPTION_HEIGHT, width, contentHeight);
  if (overlay) {
    context.save();
    context.translate(0, MOVIE_CAPTION_HEIGHT);
    context.beginPath(); context.rect(0, 0, width, contentHeight); context.clip();
    overlay(context, { width, height: contentHeight });
    context.restore();
  }
  context.fillStyle = "#17202e";
  context.fillRect(0, 0, width, MOVIE_CAPTION_HEIGHT);
  context.fillStyle = "#ffffff";
  context.font = "14px sans-serif";
  context.textBaseline = "middle";
  context.fillText(String(caption), 10, MOVIE_CAPTION_HEIGHT / 2, Math.max(1, width - 20));
  return context.getImageData(0, 0, width, height);
}

/** One frame for a row of rendered component views, including their own legends. */
export function combineMovieFrames(images, { caption = "", canvasFactory = () => document.createElement("canvas") } = {}) {
  if (!images.length || images.some(image => !image || image.width < 1 || image.height < 1)) {
    throw new Error("Не все компоненты поля готовы к записи");
  }
  const canvas = canvasFactory();
  canvas.width = images.reduce((sum, image) => sum + image.width, 0);
  canvas.height = Math.max(...images.map(image => image.height));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Браузер не предоставляет Canvas 2D для записи фильма");
  context.fillStyle = "#fafcfe"; context.fillRect(0, 0, canvas.width, canvas.height);
  let x = 0;
  for (const image of images) { context.putImageData(image, x, 0); x += image.width; }
  return captureMovieCanvas(canvas, { caption, background: "#fafcfe", canvasFactory });
}
