import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export function SurfaceChart(props) {
  let host, renderer, scene, camera, controls, surface, gridLines, observer, axes;
  let labelObjects = [];
  const [ready, setReady] = createSignal(false);
  const [error, setError] = createSignal("");
  const [limits, setLimits] = createSignal(null);
  const [hover, setHover] = createSignal("");
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  function draw() { if (renderer && scene && camera) renderer.render(scene, camera); }
  function resize() {
    if (!renderer || !host) return;
    const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix(); draw();
  }
  function dispose(object) {
    if (!object) return;
    scene.remove(object); object.geometry?.dispose(); object.material?.map?.dispose(); object.material?.dispose();
  }
  function label(text, position) {
    const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 64;
    const context = canvas.getContext("2d");
    context.fillStyle = "#20262d"; context.font = "24px sans-serif"; context.textAlign = "center";
    context.fillText(text, 256, 40);
    const material = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false });
    const sprite = new THREE.Sprite(material); sprite.position.copy(position); sprite.scale.set(1.5, .19, 1);
    scene.add(sprite); labelObjects.push(sprite);
  }
  function view(direction) {
    if (!camera) return;
    camera.up.set(0, 0, 1);
    const positions = { iso: [3.3, -4, 3], x: [4, 0, .01], y: [0, -4, .01], z: [0, -.001, 5] };
    camera.position.fromArray(positions[direction]); controls.target.set(0, 0, .3); controls.update(); draw();
  }
  function pick(event) {
    if (!surface || !props.grid) return;
    const rect = host.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(surface)[0];
    if (!hit) { setHover(""); return; }
    const index = hit.face.a;
    const grid = props.grid;
    const i = Math.floor(index / grid.height), j = index % grid.height;
    const xyz = Array.from(grid.coordinates.subarray(index * 3, index * 3 + 3));
    setHover(`${grid.axes[0]}=${i + 1}, ${grid.axes[1]}=${j + 1}; xyz=(${xyz.map(v => v.toPrecision(6)).join(", ")}); ${grid.values[index].toPrecision(8)} ${props.unit}`);
  }
  onMount(() => {
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      host.append(renderer.domElement); scene = new THREE.Scene(); scene.background = new THREE.Color(0xfafcfe);
      camera = new THREE.PerspectiveCamera(40, 1, .01, 100);
      controls = new OrbitControls(camera, renderer.domElement); controls.addEventListener("change", draw);
      scene.add(new THREE.AmbientLight(0xffffff, 2));
      const light = new THREE.DirectionalLight(0xffffff, 2); light.position.set(3, -4, 5); scene.add(light);
      axes = new THREE.AxesHelper(1.5); axes.position.set(-1.05, -1.05, -.05); scene.add(axes);
      observer = new ResizeObserver(resize); observer.observe(host);
      renderer.domElement.addEventListener("pointermove", pick);
      renderer.domElement.addEventListener("pointerleave", () => setHover(""));
      view("iso"); resize(); setReady(true);
    } catch (error) { setError(`3D-поверхность недоступна: ${error.message}`); }
  });
  createEffect(() => {
    const grid = props.grid; const title = props.label; const unit = props.unit;
    if (!ready()) return;
    dispose(surface); surface = null; dispose(gridLines); gridLines = null;
    labelObjects.forEach(dispose); labelObjects = []; setHover(""); setLimits(null);
    if (!grid) { draw(); return; }
    try {
      setError("");
      let min = Infinity, max = -Infinity;
      for (const value of grid.values) { min = Math.min(min, value); max = Math.max(max, value); }
      const span = max - min || Math.max(Math.abs(min), 1);
      const positions = new Float32Array(grid.values.length * 3), colors = new Float32Array(positions.length);
      const color = new THREE.Color();
      for (let i = 0; i < grid.width; i++) for (let j = 0; j < grid.height; j++) {
        const k = i * grid.height + j;
        positions.set([2 * i / (grid.width - 1) - 1, 2 * j / (grid.height - 1) - 1, (grid.values[k] - min) / span * 1.5], k * 3);
        color.setHSL(.66 * (1 - (grid.values[k] - min) / span), .9, .48); color.toArray(colors, k * 3);
      }
      const indices = [];
      for (let i = 0; i < grid.width - 1; i++) for (let j = 0; j < grid.height - 1; j++) {
        const a = i * grid.height + j, b = a + grid.height;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
      surface = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })); scene.add(surface);
      // Surface axes are grid node indices; physical xyz is shown on hover.
      label(`${grid.axes[0]}: 1 … ${grid.width}`, new THREE.Vector3(0, -1.2, -.12));
      label(`${grid.axes[1]}: 1 … ${grid.height}`, new THREE.Vector3(-1.35, 0, -.12));
      label(`${title}, ${unit}`, new THREE.Vector3(0, 0, 1.85));
      label(min.toPrecision(6), new THREE.Vector3(-1.25, -1.25, 0));
      label(max.toPrecision(6), new THREE.Vector3(-1.25, -1.25, 1.5));
      setLimits({ min, max }); draw();
    } catch (error) { setError(error.message); }
  });
  onCleanup(() => {
    observer?.disconnect(); controls?.removeEventListener("change", draw); controls?.dispose();
    dispose(surface); dispose(gridLines); dispose(axes); labelObjects.forEach(dispose);
    renderer?.dispose(); renderer?.forceContextLoss(); renderer?.domElement.remove();
  });
  return <div class="surface-chart">
    <div class="surface-view-buttons"><button onClick={() => view("iso")}>Вписать</button>
      <button onClick={() => view("x")}>Вид X</button><button onClick={() => view("y")}>Вид Y</button><button onClick={() => view("z")}>Вид Z</button></div>
    <div ref={host} class="surface-canvas" />
    <Show when={!props.grid}><div class="plot-empty">{props.emptyText || "Выберите виртуальный элемент"}</div></Show>
    <Show when={limits()}><div class="surface-legend"><span>{limits().min.toPrecision(6)}</span><div /><span>{limits().max.toPrecision(6)} {props.unit}</span></div></Show>
    <Show when={error()}><div class="plot-error">{error()}</div></Show>
    <Show when={hover()}><div class="surface-hover">{hover()}</div></Show>
  </div>;
}
