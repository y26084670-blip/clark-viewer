import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { disposeSurfaceObject, updateSurfaceLabel, updateSurfaceMesh } from "../services/visualization/surfaceChartResources.js";
import { captureMovieCanvas } from "../services/movie/movieCanvas.js";
import { captureRenderedMovieFrame, createRenderedFrameGate, restoreMovieCamera, snapshotMovieCamera } from "../services/movie/renderedFrameGate.js";

export function SurfaceChart(props) {
  let host, renderer, scene, camera, controls, surface, observer, axes;
  const labelObjects = [];
  let movieSnapshot = null, appliedFrameKey, disposed = false, contextLost = false, resizePending = false;
  const captureGate = createRenderedFrameGate();
  const [ready, setReady] = createSignal(false);
  const [error, setError] = createSignal("");
  const [limits, setLimits] = createSignal(null);
  const [hover, setHover] = createSignal("");
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  function draw() {
    if (!renderer || !scene || !camera || disposed || contextLost) return;
    try { renderer.render(scene, camera); captureGate.rendered(appliedFrameKey); }
    catch (error) { setError(error.message); captureGate.fail(error); }
  }
  function cameraChanged() { setHover(""); draw(); }
  function resize() {
    if (!renderer || !host) return;
    if (movieSnapshot) { resizePending = true; return; }
    resizePending = false;
    const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix(); draw();
  }
  function label(index, text, position) {
    const sprite = updateSurfaceLabel(labelObjects[index], text, position);
    if (!sprite.parent) scene.add(sprite);
    labelObjects[index] = sprite;
  }
  function view(direction) {
    if (movieSnapshot || !camera) return;
    setHover("");
    camera.up.set(0, 0, 1);
    const positions = { iso: [3.3, -4, 3], x: [4, 0, .01], y: [0, -4, .01], z: [0, -.001, 5] };
    camera.position.fromArray(positions[direction]); controls.target.set(0, 0, .3); controls.update(); draw();
  }
  function pick(event) {
    if (movieSnapshot || !surface?.visible || !props.grid) return;
    const rect = host.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(surface)[0];
    if (!hit) { setHover(""); return; }
    // Report the nearest saved vertex of the hit triangle, not always face.a.
    const positions = surface.geometry.getAttribute("position");
    const vertex = new THREE.Vector3();
    let index = hit.face.a, distance = Infinity;
    for (const candidate of [hit.face.a, hit.face.b, hit.face.c]) {
      vertex.fromBufferAttribute(positions, candidate);
      const next = vertex.distanceToSquared(hit.point);
      if (next < distance) { distance = next; index = candidate; }
    }
    const grid = props.grid;
    const i = Math.floor(index / grid.height), j = index % grid.height;
    const xyz = Array.from(grid.coordinates.subarray(index * 3, index * 3 + 3));
    setHover(`${grid.axes[0]}=${i + 1}, ${grid.axes[1]}=${j + 1}; LS=${(grid.copy ?? 0) + 1}; xyz=(${xyz.map(v => v.toPrecision(6)).join(", ")}) мм; ${grid.values[index].toPrecision(8)} ${props.unit}`);
  }
  const captureAdapter = {
    prepare({ signal } = {}) {
      signal?.throwIfAborted();
      if (movieSnapshot) return;
      if (!ready() || disposed || contextLost || error() || !surface?.visible) throw new Error(error() || "Поверхность ещё не готова");
      draw();
      if (error()) throw new Error(error());
      setHover("");
      // Lock the camera and canvas; each frame keeps the normal automatic field scale.
      movieSnapshot = snapshotMovieCamera(camera, controls);
    },
    renderReady(expectedKey, { signal } = {}) {
      if (disposed || contextLost || error()) return Promise.reject(new Error(error() || "Поверхность недоступна"));
      return captureGate.wait(expectedKey, { signal });
    },
    capture(expectedKey, { caption } = {}) {
      if (!movieSnapshot || disposed || contextLost || error()) throw new Error(error() || "Захват поверхности не подготовлен");
      return captureRenderedMovieFrame(captureGate, expectedKey, draw, () =>
        captureMovieCanvas(renderer.domElement, { caption, overlay: drawMovieLegend, background: "#fafcfe" }));
    },
    restore() {
      if (!movieSnapshot) return;
      const snapshot = movieSnapshot; movieSnapshot = null;
      if (disposed || !camera || !controls) return;
      restoreMovieCamera(camera, controls, snapshot);
      applyGrid(props.grid, props.label, props.unit, props.captureFrameKey);
      if (resizePending) resize();
    },
  };
  function drawMovieLegend(context, { width, height }) {
    const range = limits();
    if (!range) return;
    const boxWidth = Math.min(300, width - 16), x = width - boxWidth - 8, y = height - 61;
    context.fillStyle = "rgba(255,255,255,.9)"; context.fillRect(x, y, boxWidth, 53);
    context.font = "12px sans-serif"; context.textBaseline = "top";
    context.fillStyle = "#20262d"; context.fillText(props.unit ?? "", x + 7, y + 5);
    const gradient = context.createLinearGradient(x + 7, 0, x + boxWidth - 7, 0);
    const color = new THREE.Color();
    for (let stop = 0; stop <= 20; stop++) {
      color.setHSL(.66 * (1 - stop / 20), .9, .48);
      gradient.addColorStop(stop / 20, color.getStyle());
    }
    context.fillStyle = gradient; context.fillRect(x + 7, y + 22, boxWidth - 14, 10);
    context.fillStyle = "#20262d"; context.fillText(range.min.toPrecision(6), x + 7, y + 36);
    context.textAlign = "right"; context.fillText(range.max.toPrecision(6), x + boxWidth - 7, y + 36);
    context.textAlign = "left";
  }
  function contextLostHandler(event) {
    event.preventDefault(); contextLost = true;
    const error = new Error("Контекст WebGL потерян"); setError(error.message); captureGate.fail(error);
  }
  function contextRestoredHandler() {
    contextLost = false;
    applyGrid(props.grid, props.label, props.unit, props.captureFrameKey);
  }
  onMount(() => {
    props.onCaptureReady?.(captureAdapter);
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      host.append(renderer.domElement); scene = new THREE.Scene(); scene.background = new THREE.Color(0xfafcfe);
      camera = new THREE.PerspectiveCamera(40, 1, .01, 100);
      controls = new OrbitControls(camera, renderer.domElement); controls.addEventListener("change", cameraChanged);
      scene.add(new THREE.AmbientLight(0xffffff, 2));
      const light = new THREE.DirectionalLight(0xffffff, 2); light.position.set(3, -4, 5); scene.add(light);
      axes = new THREE.AxesHelper(1.5); axes.position.set(-1.05, -1.05, -.05); scene.add(axes);
      observer = new ResizeObserver(resize); observer.observe(host);
      renderer.domElement.addEventListener("webglcontextlost", contextLostHandler);
      renderer.domElement.addEventListener("webglcontextrestored", contextRestoredHandler);
      renderer.domElement.addEventListener("pointermove", pick);
      renderer.domElement.addEventListener("pointerleave", () => setHover(""));
      view("iso"); resize(); setReady(true);
    } catch (error) { setError(`3D-поверхность недоступна: ${error.message}`); captureGate.fail(error); }
  });
  function applyGrid(grid, title, unit, frameKey) {
    if (!ready()) return;
    setHover("");
    if (!grid) {
      if (surface) surface.visible = false;
      labelObjects.forEach(label => { label.visible = false; });
      setLimits(null); setError(""); appliedFrameKey = frameKey; draw(); return;
    }
    try {
      setError("");
      surface = updateSurfaceMesh(surface, grid);
      if (!surface.parent) scene.add(surface);
      const { min, max } = surface.userData.limits;
      // Surface axes are grid node indices; physical xyz is shown on hover.
      label(0, `${grid.axes[0]}: 1 … ${grid.width}`, new THREE.Vector3(0, -1.2, -.12));
      label(1, `${grid.axes[1]}: 1 … ${grid.height}`, new THREE.Vector3(-1.35, 0, -.12));
      label(2, `${title}, ${unit}`, new THREE.Vector3(0, 0, 1.85));
      label(3, min.toPrecision(6), new THREE.Vector3(-1.25, -1.25, 0));
      label(4, max.toPrecision(6), new THREE.Vector3(-1.25, -1.25, 1.5));
      setLimits({ min, max }); appliedFrameKey = frameKey; draw();
    } catch (error) {
      if (surface) surface.visible = false;
      labelObjects.forEach(label => { label.visible = false; });
      setLimits(null); setError(error.message); draw(); captureGate.fail(error);
    }
  }
  createEffect(() => applyGrid(props.grid, props.label, props.unit, props.captureFrameKey));
  onCleanup(() => {
    disposed = true; captureGate.close(); props.onCaptureReady?.(null);
    renderer?.domElement.removeEventListener("webglcontextlost", contextLostHandler);
    renderer?.domElement.removeEventListener("webglcontextrestored", contextRestoredHandler);
    observer?.disconnect(); controls?.removeEventListener("change", cameraChanged); controls?.dispose();
    disposeSurfaceObject(surface); disposeSurfaceObject(axes); labelObjects.forEach(disposeSurfaceObject);
    renderer?.dispose(); renderer?.forceContextLoss(); renderer?.domElement.remove();
  });
  return <div class="surface-chart">
    <div class="surface-view-buttons"><button onClick={() => view("iso")}>Вписать</button>
      <button onClick={() => view("x")}>Вид X</button><button onClick={() => view("y")}>Вид Y</button><button onClick={() => view("z")}>Вид Z</button></div>
    <div ref={host} class="surface-canvas" />
    <Show when={!props.grid}><div class="plot-empty">{props.emptyText || "Выберите площадку"}</div></Show>
    <Show when={limits()}><div class="surface-legend"><span>{limits().min.toPrecision(6)}</span><div /><span>{limits().max.toPrecision(6)} {props.unit}</span></div></Show>
    <Show when={error()}><div class="plot-error">{error()}</div></Show>
    <Show when={hover()}><div class="surface-hover">{hover()}</div></Show>
  </div>;
}
