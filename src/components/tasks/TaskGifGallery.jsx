import { createTaskGifGalleryController } from "../../services/taskGifGalleryController.js";
import { subscribeTaskGifs } from "../../services/taskGifService.js";
import { TaskImageGallery } from "./TaskImageGallery.jsx";
import { TaskGifPlayer } from "./TaskGifPlayer.jsx";

export function TaskGifGallery(props) {
  return <TaskImageGallery {...props} label="GIF" emptyMessage="GIF-файлов нет" allowDelete
    createController={createTaskGifGalleryController} subscribe={subscribeTaskGifs}
    renderPreview={(preview, maximized) => <TaskGifPlayer url={preview()?.url} name={preview()?.entry.name} crossfade={maximized()} />} />;
}
