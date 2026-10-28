import { mountProtocolScene } from "./protocolScenePlayer.js";

// The only executable script embedded in a protocol. Its exact hash is in CSP.
const data = JSON.parse(document.getElementById("clark-protocol-data").textContent);
for (const host of document.querySelectorAll("[data-protocol-scene]")) {
  const block = data.blocks[Number(host.dataset.protocolScene)];
  if (block?.kind !== "scene") continue;
  const button = host.querySelector("button"), poster = host.querySelector("img"), status = host.querySelector("[role=status]");
  const target = host.querySelector(".protocol-scene-live");
  let player;
  button.hidden = false;
  function stop(message = "") { player?.dispose(); player = null; poster.hidden = false; button.textContent = "Открыть 3D"; status.textContent = message; }
  button.addEventListener("click", () => {
    if (player) { stop(); return; }
    try {
      player = mountProtocolScene(target, block.scene); poster.hidden = true; button.textContent = "Закрыть 3D"; status.textContent = "";
    } catch { stop("Интерактивный вид требует WebGL 2. Показан сохранённый снимок системы."); }
  });
  target.addEventListener("protocol-scene-error", event => stop(event.detail));
  window.addEventListener("pagehide", () => player?.dispose());
}
