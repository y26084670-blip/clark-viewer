import { createViewportLens } from "../services/visualization/viewportLens.js";
import { createGeometryAxisRotationController } from "../services/visualization/geometryCameraView.js";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { disposeSurfaceObject, updateSurfaceLabel, updateSurfaceMesh } from "../services/visualization/surfaceChartResources.js";
import { updateSurfaceDecorations } from "../services/visualization/surfaceContours.js";
import { captureMovieCanvas } from "../services/movie/movieCanvas.js";
import { captureRenderedMovieFrame, createRenderedFrameGate, restoreMovieCamera, snapshotMovieCamera } from "../services/movie/renderedFrameGate.js";

export function SurfaceChart(props) {
  let host, renderer, scene, camera, controls, surface, observer, axes, decorations;
  const labelObjects = [];
  let viewportLens, axisRotation, controlsInteracting = false;
  let movieSnapshot = null, appliedFrameKey, disposed = false, contextLost = false, resizePending = false;
  let applyingView = false, lastView = null;
  const captureGate = createRenderedFrameGate();
  const [ready, setReady] = createSignal(false);
  const [error, setError] = createSignal("");
  const [limits, setLimits] = createSignal(null);
  const [hover, setHover] = createSignal("");
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const formatValue = value => Number(value.toPrecision(5)).toString();
  function draw() {
    if (!renderer || !scene || !camera || disposed || contextLost) return;
    try {
      if (viewportLens) viewportLens.render(scene, camera); else renderer.render(scene, camera);
      captureGate.rendered(appliedFrameKey);
    }
    catch (error) { setError(error.message); captureGate.fail(error); }
  }
  function cameraChanged() {
    setHover("");
    if (!applyingView && !movieSnapshot && props.onViewChange && camera && controls) {
      lastView = { position: camera.position.toArray(), quaternion: camera.quaternion.toArray(),
        up: camera.up.toArray(), target: controls.target.toArray(), zoom: camera.zoom };
      props.onViewChange(lastView);
    }
    draw();
  }
  createEffect(() => {
    const view = props.viewState;
    if (!ready() || !view || view === lastView || movieSnapshot) return;
    applyingView = true;
    try {
      camera.position.fromArray(view.position); camera.quaternion.fromArray(view.quaternion);
      camera.up.fromArray(view.up); camera.zoom = view.zoom; controls.target.fromArray(view.target);
      camera.updateProjectionMatrix(); rebuildControls(controls.target.clone()); lastView = view; draw();
    } finally { applyingView = false; }
  });
  function startControls() { controlsInteracting = true; setHover(""); }
  function endControls() { controlsInteracting = false; }
  function rebuildControls(target = new THREE.Vector3()) {
    controls?.removeEventListener("change", cameraChanged); controls?.dispose();
    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(target); controls.enableDamping = false; controls.screenSpacePanning = true;
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    controls.addEventListener("change", cameraChanged);
    controls.addEventListener("start", startControls); controls.addEventListener("end", endControls);
    controls.update();
  }
  function resize() {
    if (!renderer || !host) return;
    if (movieSnapshot) { resizePending = true; return; }
    resizePending = false;
    const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height);
    const aspect = width / height, halfWidth = 2.6 * Math.max(1, aspect), halfHeight = halfWidth / aspect;
    camera.left = -halfWidth; camera.right = halfWidth; camera.top = halfHeight; camera.bottom = -halfHeight;
    camera.updateProjectionMatrix(); draw();
  }
  function label(index, text, position) {
    const sprite = updateSurfaceLabel(labelObjects[index], text, position);
    if (!sprite.parent) scene.add(sprite);
    labelObjects[index] = sprite;
  }
  function view(direction) {
    if (movieSnapshot || !camera) return;
    setHover("");
    camera.up.set(0, 0, 1); camera.zoom = 1; camera.updateProjectionMatrix();
    const positions = { iso: [3.3, -4, 3], x: [4, 0, .01], y: [0, -4, .01], z: [0, -.001, 5] };
    applyingView = true;
    try {
      controls.target.set(0, 0, .3);
      // In the three-column view, horizontal field of view is the limiting one.
      // Fit the same model without cutting off its sides in a tall canvas.
      const fit = Math.max(1, host.clientHeight / Math.max(1, host.clientWidth));
      camera.position.fromArray(positions[direction]).sub(controls.target).multiplyScalar(fit).add(controls.target);
      rebuildControls(controls.target.clone());
    }
    finally { applyingView = false; }
    cameraChanged();
  }
  function pick(event) {
    if (movieSnapshot || controlsInteracting || axisRotation?.active || !surface?.visible || !props.grid) return;
    const rect = host.getBoundingClientRect();
    const point = viewportLens?.sourcePoint(event.clientX, event.clientY) ?? event;
    pointer.set((point.clientX - rect.left) / rect.width * 2 - 1, -(point.clientY - rect.top) / rect.height * 2 + 1);
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
      axisRotation?.stop(); viewportLens?.clear();
      draw();
      if (error()) throw new Error(error());
      setHover("");
      // Lock the camera and canvas; each frame respects the selected range mode.
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
    const boxWidth = Math.min(600, width - 16), x = width - boxWidth - 8, y = height - 137;
    context.fillStyle = "rgba(255,255,255,.9)"; context.fillRect(x, y, boxWidth, 129);
    context.font = "36px sans-serif"; context.textBaseline = "top";
    context.fillStyle = "#000000"; context.fillText(props.unit ?? "", x + 7, y + 5);
    const gradient = context.createLinearGradient(x + 7, 0, x + boxWidth - 7, 0);
    const color = new THREE.Color();
    for (let stop = 0; stop <= 20; stop++) {
      color.setHSL(.66 * (1 - stop / 20), .9, .48);
      gradient.addColorStop(stop / 20, color.getStyle());
    }
    context.fillStyle = gradient; context.fillRect(x + 7, y + 50, boxWidth - 14, 16);
    context.fillStyle = "#000000"; context.fillText(formatValue(range.min), x + 7, y + 77);
    context.textAlign = "right"; context.fillText(formatValue(range.max), x + boxWidth - 7, y + 77);
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
      camera = new THREE.OrthographicCamera(-2.6, 2.6, 2.6, -2.6, .01, 100);
      // OrbitControls computes its up-axis transform at construction time.
      camera.up.set(0, 0, 1); rebuildControls();
      if (renderer.domElement.ownerDocument) {
        viewportLens = createViewportLens({ THREE, renderer, enabled: () => !movieSnapshot && !contextLost, requestRender: draw });
        axisRotation = createGeometryAxisRotationController({
          element: renderer.domElement, getCamera: () => camera, getControls: () => controls,
          canStart: () => !disposed && !movieSnapshot && !contextLost && !error(),
          onStateChange: active => {
            controlsInteracting = active;
            if (!active && !disposed) rebuildControls(controls.target.clone());
          },
          onRotate: cameraChanged, onPointerMove: pick, onPointerLeave: () => setHover(""),
        });
      }
      scene.add(new THREE.AmbientLight(0xffffff, 2));
      const light = new THREE.DirectionalLight(0xffffff, 2); light.position.set(3, -4, 5); scene.add(light);
      axes = new THREE.AxesHelper(1.5); axes.position.set(-1.05, -1.05, -.05); scene.add(axes);
      observer = new ResizeObserver(resize); observer.observe(host);
      renderer.domElement.addEventListener("webglcontextlost", contextLostHandler);
      renderer.domElement.addEventListener("webglcontextrestored", contextRestoredHandler);
      if (!axisRotation) renderer.domElement.addEventListener("pointermove", pick);
      renderer.domElement.addEventListener("pointerleave", () => setHover(""));
      view("iso"); resize(); setReady(true);
      props.onViewReady?.({ view });
    } catch (error) { setError(`3D-поверхность недоступна: ${error.message}`); captureGate.fail(error); }
  });
  function applyGrid(grid, title, unit, frameKey) {
    if (!ready()) return;
    setHover("");
    if (!grid) {
      if (surface) surface.visible = false;
      if (decorations) decorations.visible = false;
      labelObjects.forEach(label => { label.visible = false; });
      setLimits(null); setError(""); appliedFrameKey = frameKey; draw(); return;
    }
    try {
      setError("");
      surface = updateSurfaceMesh(surface, grid);
      if (!surface.parent) scene.add(surface);
      decorations = updateSurfaceDecorations(decorations, surface, grid.values,
        { projections: props.projections ?? true, isolines: props.isolines ?? 0 });
      if (!decorations.parent) scene.add(decorations);
      const { min, max } = surface.userData.limits;
      const footprint = surface.userData.footprint;
      const { halfWidth: w, halfHeight: h } = footprint;
      const side = (axis, count, length) => footprint.physical
        ? `${axis}: 0 … ${Number(length.toPrecision(4))} мм` : `${axis}: 1 … ${count}`;
      axes.position.set(-w - .06, -h - .06, -.02);
      axes.scale.set((2 * w + .12) / 1.5, (2 * h + .12) / 1.5, 1.15);
      label(0, side(grid.axes[0], grid.width, footprint.length1), new THREE.Vector3(0, -h - .45, -.1));
      label(1, side(grid.axes[1], grid.height, footprint.length2), new THREE.Vector3(-w - 1.15, 0, -.25));
      label(2, `${title}, ${unit}`, new THREE.Vector3(-w - .1, -h - .1, 1.95));
      label(3, formatValue(min), new THREE.Vector3(-w - .25, -h - .2, 0));
      label(4, formatValue(max), new THREE.Vector3(-w - .25, -h - .2, 1.5));
      setLimits({ min, max }); appliedFrameKey = frameKey; draw();
    } catch (error) {
      if (surface) surface.visible = false;
      if (decorations) decorations.visible = false;
      labelObjects.forEach(label => { label.visible = false; });
      setLimits(null); setError(error.message); draw(); captureGate.fail(error);
    }
  }
  createEffect(() => applyGrid(props.grid, props.label, props.unit, props.captureFrameKey));
  onCleanup(() => {
    disposed = true; viewportLens?.dispose(); axisRotation?.dispose(); captureGate.close(); props.onCaptureReady?.(null);
    props.onViewReady?.(null);
    renderer?.domElement.removeEventListener("webglcontextlost", contextLostHandler);
    renderer?.domElement.removeEventListener("webglcontextrestored", contextRestoredHandler);
    observer?.disconnect(); controls?.removeEventListener("change", cameraChanged); controls?.dispose();
    disposeSurfaceObject(surface); disposeSurfaceObject(decorations); disposeSurfaceObject(axes); labelObjects.forEach(disposeSurfaceObject);
    renderer?.dispose(); renderer?.forceContextLoss(); renderer?.domElement.remove();
  });
  return <div class="surface-chart">
    <div ref={host} class="surface-canvas" title="ЛКМ — поворот; ПКМ — перенос; колесо — масштаб; левый Ctrl — линза от ×5, колесо — её увеличение; Ctrl/Alt+X/Y/Z — вращение вокруг оси" />
    <Show when={!props.grid}><div class="plot-empty">{props.emptyText || "Выберите площадку"}</div></Show>
    <Show when={limits()}><div class="surface-legend"><span>{formatValue(limits().min)}</span><div /><span>{formatValue(limits().max)} {props.unit}</span></div></Show>
    <Show when={error()}><div class="plot-error">{error()}</div></Show>
    <Show when={hover()}><div class="surface-hover">{hover()}</div></Show>
  </div>;
}
