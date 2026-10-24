import { Show } from "solid-js";
import { createTaskGifGalleryController } from "../../services/taskGifGalleryController.js";
import { subscribeTaskGifs } from "../../services/taskGifService.js";
import { TaskImageGallery } from "./TaskImageGallery.jsx";
import { TaskGifPlayer } from "./TaskGifPlayer.jsx";

export function TaskGifGallery(props) {
  return <TaskImageGallery {...props} label="GIF / WebM" emptyMessage="GIF/WebM-файлов нет" allowDelete
    createController={createTaskGifGalleryController} subscribe={subscribeTaskGifs}
    renderPreview={(preview, maximized) => <Show when={/\.webm$/i.test(preview()?.entry.name)}
      fallback={<TaskGifPlayer url={preview()?.url} name={preview()?.entry.name} crossfade={maximized()} />}>
      <video class="task-webm-player" src={preview()?.url} controls playsinline aria-label={preview()?.entry.name} />
    </Show>} />;
}
