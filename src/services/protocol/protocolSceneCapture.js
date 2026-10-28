import { buildProtocolScene } from "./protocolSceneData.js";
import { loadTaskInput } from "../taskLoadService.js";

export async function readProtocolScene(task, { signal } = {}) {
  signal?.throwIfAborted();
  let input = task;
  if (!task.general || !Array.isArray(task.elements)) {
    try { input = await loadTaskInput(task.handle); }
    catch (error) { if (error.name === "NotFoundError") return null; throw error; }
  }
  signal?.throwIfAborted();
  const scene = buildProtocolScene(input);
  if (!scene) return null;
  const { mountProtocolScene } = await import("./protocolScenePlayer.js");
  signal?.throwIfAborted();
  const host = document.createElement("div");
  Object.assign(host.style, { position: "fixed", left: "-10000px", top: "0", width: "800px" });
  document.body.append(host);
  let player;
  try {
    player = mountProtocolScene(host, scene, { interactive: false });
    signal?.throwIfAborted();
    const poster = player.capture();
    return { id: crypto.randomUUID(), kind: "scene", title: "3D-геометрия системы",
      comment: "Исходная геометрия со всеми заданными образами симметрии. Вращение, масштаб и видимость доступны в интерактивном виде.", scene, poster };
  } finally { player?.dispose(); host.remove(); }
}
