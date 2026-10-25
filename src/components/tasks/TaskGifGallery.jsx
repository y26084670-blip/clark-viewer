import { createSignal, For, Show } from "solid-js";
import { createTaskGifGalleryController } from "../../services/taskGifGalleryController.js";
import { subscribeTaskGifs } from "../../services/taskGifService.js";
import { TaskImageGallery } from "./TaskImageGallery.jsx";
import { TaskGifPlayer } from "./TaskGifPlayer.jsx";

const WEBM_SPEEDS = [0.1, 0.3, 0.5, 1, 2];

export function TaskGifGallery(props) {
  const [speed, setSpeed] = createSignal(1);
  return <TaskImageGallery {...props} label="GIF / WebM" emptyMessage="GIF/WebM-файлов нет" allowDelete
    createController={createTaskGifGalleryController} subscribe={subscribeTaskGifs}
    onPreviewChange={() => setSpeed(1)}
    renderPreviewHeader={preview => <Show when={/\.webm$/i.test(preview()?.entry.name)}>
      <label class="task-webm-speed">Скорость
        <select aria-label="Скорость воспроизведения WebM" value={speed()} disabled={!preview()?.url}
          onChange={event => setSpeed(Number(event.currentTarget.value))}>
          <For each={WEBM_SPEEDS}>{value => <option value={value}>{String(value).replace(".", ",")}×</option>}</For>
        </select>
      </label>
    </Show>}
    renderPreview={(preview, maximized) => <Show when={/\.webm$/i.test(preview()?.entry.name)}
      fallback={<TaskGifPlayer url={preview()?.url} name={preview()?.entry.name} crossfade={maximized()} />}>
      <video class="task-webm-player" src={preview()?.url} autoplay loop muted controls controlsList="noplaybackrate" playsinline
        prop:playbackRate={speed()} onLoadedMetadata={event => { event.currentTarget.playbackRate = speed(); }}
        aria-label={preview()?.entry.name} />
    </Show>} />;
}
