import { createTaskImageGalleryController } from "./taskImageGalleryController.js";
import { listTaskGifs, readTaskGif, deleteTaskGif } from "./taskGifService.js";

export function createTaskGifGalleryController(options = {}) {
  return createTaskImageGalleryController({
    list: listTaskGifs, read: readTaskGif, remove: deleteTaskGif,
    decodeError: "Не удалось отобразить GIF.", ...options,
  });
}
