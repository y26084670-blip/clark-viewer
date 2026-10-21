// Native OPFS exercises actual File/Blob decoding. The OS picker and its
// readwrite permission prompt are outside this fixture's scope.
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { TaskMediaPanel } from "../../src/components/tasks/TaskMediaPanel.jsx";
import { newProtocol, serializeProtocol } from "../../src/services/protocol/protocolDocument.js";
import "../../src/App.css";

const storage = await navigator.storage.getDirectory();
try { await storage.removeEntry("task-media-fixture", { recursive: true }); } catch (error) { if (error.name !== "NotFoundError") throw error; }
const root = await storage.getDirectoryHandle("task-media-fixture", { create: true });
async function put(task, path, data) {
  const parts = path.split("/"); const name = parts.pop(); let directory = task;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
  const file = await directory.getFileHandle(name, { create: true });
  const stream = await file.createWritable(); await stream.write(data); await stream.close();
}
const first = await root.getDirectoryHandle("Sketch", { create: true });
const second = await root.getDirectoryHandle("TextOnly", { create: true });
const htmlOnly = await root.getDirectoryHandle("HtmlOnly", { create: true });
const empty = await root.getDirectoryHandle("Empty", { create: true });
const canvas = document.createElement("canvas"); canvas.width = 360; canvas.height = 220;
const context = canvas.getContext("2d");
context.fillStyle = "#dceaf3"; context.fillRect(0, 0, 360, 220);
context.strokeStyle = "#185f96"; context.lineWidth = 12; context.strokeRect(70, 45, 220, 130);
context.fillStyle = "#19222b"; context.font = "20px Arial"; context.fillText("d = 10 mm", 130, 115);
const blob = type => new Promise(resolve => canvas.toBlob(resolve, type));
await put(first, "DOCS/01_sketch.png", await blob("image/png"));
await put(first, "DOCS/02_model.jpeg", await blob("image/jpeg"));
await put(first, "DOCS/03_sections.webp", await blob("image/webp"));
for (let i = 4; i <= 18; i++) await put(first, `DOCS/${String(i).padStart(2, "0")}_detail.png`, await blob("image/png"));
await put(first, "DOCS/19_broken.png", "This is not a PNG");
const readme = Array.from({ length: 150 }, (_, index) => `Строка ${index + 1}: исходный эскиз, модель, сечения; ${"данные ".repeat(30)}`).join("\n");
await put(first, "DOCS/README.txt", readme);
await put(first, "DOCS/README.md", "# Исходный Markdown\n<script>window.injected = true</script>\n[JSON](../data.json)");
await put(first, "DOCS/notes.txt", "Пояснения к JSON за пределами DOCS.");
await put(first, "DOCS/data.json", "{}");
await put(first, "DOCS/nested/hidden.png", await blob("image/png"));
await put(second, "DOCS/README.md", "# Только текст\nДокументация без изображений.");
const protocol = serializeProtocol(newProtocol("Workspace/Project/Sketch", [
  { id: "sketch", kind: "image", title: "Снимок поля", comment: "Прежний комментарий", dataUrl: canvas.toDataURL("image/png"), width: 360, height: 220 },
  { id: "values", kind: "table", title: "Значения", comment: "Таблица", table: { headers: ["J", "E"], rows: [["1", "2"]] } },
]));
await put(first, "DOCS/protocol.html", protocol);
await put(htmlOnly, "DOCS/protocol.html", protocol);
await put(first, "DOCS/legacy.HTM", `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=/forbidden-redirect">
  <style>h1{color:rgb(1, 2, 3)}</style><link rel="stylesheet" href="/forbidden-style"></head><body>
  <h1>Обычный HTML</h1><script>parent.injected = true</script><img src="/forbidden-image">
  <iframe src="/forbidden-frame"></iframe><a href="/forbidden-link">Внешняя ссылка</a></body></html>`);
const gif = Uint8Array.from(atob("R0lGODlhUAA8APAAAB5GtOagPCH5BABGAAAALAAAAABQADwAAAhxAAEIHEiwoMGDCBMqXMiwocOHECNKnEixosWLGDNq3Mixo8ePIEOKHEmypMmTKFOqXMmypcuXMGPKnEmzps2bOHPq3Mmzp8+fQIMKHUq0qNGjSJMqXcq0qdOnUKNKnUq1qtWrWLNq3cq1q9evYMO+DAgAIfkEAEYAAAAsAAAAAFAAPACAHka05qA8CHEAAwgcSLCgwYMIEypcyLChw4cQI0qcSLGixYsYM2rcyLGjx48gQ4ocSbKkyZMoU6pcybKly5cwY8qcSbOmzZs4c+rcybOnz59AgwodSrSo0aNIkypdyrSp06dQo0qdSrWq1atYs2rdyrWr169gw74MCAAh+QQARgAAACwAAAAAUAA8AIAeRrTmoDwIcQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3KtKnTp1CjSp1KtarVq1izat3KtavXr2DDvgwIADs="), char => char.charCodeAt(0));
await put(first, "output3XX/demo/one.gif", gif); await put(first, "output3XX/demo/two.gif", gif);

const metrics = { reads: [], permission: [], busy: [], edits: [], liveURLs: new Set() };
const nativeRead = FileSystemFileHandle.prototype.getFile;
FileSystemFileHandle.prototype.getFile = function() { metrics.reads.push(this.name); return nativeRead.call(this); };
const nativeCreateURL = URL.createObjectURL.bind(URL), nativeRevokeURL = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = file => { const url = nativeCreateURL(file); metrics.liveURLs.add(url); return url; };
URL.revokeObjectURL = url => { metrics.liveURLs.delete(url); nativeRevokeURL(url); };
let permission = "granted";
const task = directory => ({ kind: "directory", name: directory.name,
  getDirectoryHandle: (...args) => directory.getDirectoryHandle(...args),
  requestPermission: options => { metrics.permission.push(options); return Promise.resolve(permission); },
});
const tasks = { first: task(first), second: task(second), htmlOnly: task(htmlOnly), empty: task(empty), restricted: {
  kind: "directory", name: "Restricted", getDirectoryHandle: async () => { throw new DOMException("Нет доступа", "NotAllowedError"); },
} };
function Fixture() {
  const [selected, setSelected] = createSignal(tasks.first), [active, setActive] = createSignal(true);
  const [revision, setRevision] = createSignal(0), [mounted, setMounted] = createSignal(true), [busy, setBusy] = createSignal(false);
  window.mediaFixture = {
    pick: name => setSelected(tasks[name]), active: setActive, refresh: () => setRevision(value => value + 1),
    mount: setMounted, permission: value => { permission = value; },
    stats: () => ({ ...metrics, liveURLs: [...metrics.liveURLs] }),
    put: (path, data) => put(first, path, data),
    exists: async name => { try { await (await first.getDirectoryHandle("output3XX")).getDirectoryHandle("demo").then(dir => dir.getFileHandle(name)); return true; }
      catch (error) { if (error.name === "NotFoundError") return false; throw error; } },
  };
  return <div style={{ height: "100dvh", display: "flex", "flex-direction": "column" }}>
    <div style={{ height: "90px", "flex-shrink": "0", padding: "12px", background: "#e1e7ed" }}>
      <strong>Выбор задания — GIF / DOCS</strong><p>Тестовое задание «{selected()?.name}»</p>
    </div>
    <div style={{ position: "relative", flex: "1", "min-height": "0" }}>
      <div class="tasks-layout">
        <section class="task-browser-panel"><div class="task-browser-content">Исходный эскиз и документация</div></section>
        <section class="task-summary-panel"><div class="task-geometry-preview" /><textarea readOnly value="Сводка исходных данных" /><footer>исходные данные</footer></section>
        <Show when={mounted()}><TaskMediaPanel taskHandle={selected()} active={active()} refreshKey={revision()}
          onEditProtocol={name => metrics.edits.push({ task: selected().name, name })}
          disabled={busy()} onBusyChange={value => { metrics.busy.push(value); setBusy(value); }}
          resultsSummary="Сводка результатов расчёта" /></Show>
      </div>
    </div>
  </div>;
}
render(() => <Fixture />, document.getElementById("root"));
window.mediaReady = true;
