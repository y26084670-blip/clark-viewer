import {
  AmbientLight, BufferGeometry, Color, DirectionalLight, DoubleSide, Float32BufferAttribute,
  Group, LineBasicMaterial, LineSegments, Mesh, MeshLambertMaterial, OrthographicCamera,
  Points, PointsMaterial, Scene, Vector3, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export const protocolSceneCss = `
.protocol-scene-player{font:14px/1.4 Arial,sans-serif;color:#eef3f7;background:#202932;border:1px solid #697c8b;border-radius:4px;overflow:hidden}
.protocol-scene-toolbar{display:flex;gap:5px;flex-wrap:wrap;padding:8px}
.protocol-scene-player button{font:inherit;color:#17202b;background:#eef3f7;border:1px solid #8796a4;border-radius:3px;padding:5px 9px;cursor:pointer}
.protocol-scene-player button:focus-visible,.protocol-scene-player input:focus-visible{outline:2px solid #58b9ff;outline-offset:2px}
.protocol-scene-body{display:grid;grid-template-columns:minmax(0,1fr) 210px}
.protocol-scene-viewport{height:420px;min-width:0;position:relative;touch-action:none}
.protocol-scene-viewport canvas{display:block;width:100%;height:100%}
.protocol-scene-objects{max-height:420px;overflow:auto;border-left:1px solid #697c8b;padding:8px}
.protocol-scene-objects label{display:flex;align-items:flex-start;gap:6px;margin-bottom:8px;overflow-wrap:anywhere}
.protocol-scene-hint{padding:6px 8px;font-size:12px;color:#d3dfe8}
@media(max-width:650px){.protocol-scene-body{grid-template-columns:1fr}.protocol-scene-objects{max-height:130px;border-left:0;border-top:1px solid #697c8b}.protocol-scene-viewport{height:340px}}
@media print{.protocol-scene-player{display:none!important}}
`;

// Shared by poster capture and the bundled offline player; no file/network APIs.
export function mountProtocolScene(host, data, { interactive = true } = {}) {
  let renderer, controls, observer;
  const geometries = [], materials = [], listeners = [], groups = [];
  const scene = new Scene();
  const center = data.bounds.min.map((value, i) => value / 2 + data.bounds.max[i] / 2);
  const span = Math.max(...data.bounds.max.map((value, i) => value - data.bounds.min[i]));
  const scale = span > 0 ? span : 1;
  const camera = new OrthographicCamera(-1, 1, 1, -1, .01, 100);
  camera.up.set(0, 0, 1);
  const wrapper = document.createElement("div"); wrapper.className = "protocol-scene-player";
  const style = document.createElement("style"); style.textContent = protocolSceneCss; wrapper.append(style);
  const toolbar = document.createElement("div"); toolbar.className = "protocol-scene-toolbar";
  const body = document.createElement("div"); body.className = "protocol-scene-body";
  const viewport = document.createElement("div"); viewport.className = "protocol-scene-viewport";
  viewport.setAttribute("aria-label", "Интерактивная 3D-геометрия системы");
  const list = document.createElement("div"); list.className = "protocol-scene-objects";
  list.setAttribute("aria-label", "Видимость объектов системы");
  body.append(viewport); if (interactive) body.append(list); else body.style.gridTemplateColumns = "1fr";
  if (interactive) wrapper.append(toolbar); wrapper.append(body);
  if (interactive) {
    const hint = document.createElement("div"); hint.className = "protocol-scene-hint";
    hint.textContent = "Левая кнопка — вращение; колесо — масштаб; правая кнопка — перемещение. Исходная геометрия, все заданные образы симметрии.";
    wrapper.append(hint);
  }
  host.append(wrapper);
  function listen(node, type, callback) { node.addEventListener(type, callback); listeners.push(() => node.removeEventListener(type, callback)); }
  function dispose() {
    observer?.disconnect(); controls?.dispose(); listeners.forEach(remove => remove());
    geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose());
    renderer?.dispose(); renderer?.forceContextLoss(); wrapper.remove();
  }
  try {
    renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.setClearColor(0x141a20);
    viewport.append(renderer.domElement); renderer.domElement.setAttribute("aria-label", "3D-сцена системы");
    scene.add(new AmbientLight(0xffffff, 2));
    const light = new DirectionalLight(0xffffff, 2.2); light.position.set(3, -4, 5); scene.add(light);
    const positions = (values, matrix) => {
      const output = [];
      for (let i = 0; i < values.length; i += 3) for (let axis = 0; axis < 3; axis++) {
        output.push((matrix[axis] * values[i] + matrix[4 + axis] * values[i + 1]
          + matrix[8 + axis] * values[i + 2] + matrix[12 + axis] - center[axis]) / scale);
      }
      return output;
    };
    for (const object of data.objects) {
      const group = new Group(), vertices = [], faces = [], colors = [], edges = [];
      for (const instance of object.instances) {
        const offset = vertices.length / 3, transformed = positions(object.positions, instance.matrix);
        for (const value of transformed) vertices.push(value);
        object.indices.forEach(index => faces.push(index + offset));
        const color = new Color(instance.original ? object.color : object.copyColor);
        for (let i = 0; i < transformed.length / 3; i++) colors.push(color.r, color.g, color.b);
        const edgeVertices = positions(object.edgePositions, instance.matrix);
        object.edgeIndices.forEach(index => edges.push(...edgeVertices.slice(index * 3, index * 3 + 3)));
      }
      if (object.kind !== "region-line" && faces.length) {
        const geometry = new BufferGeometry(); geometry.setAttribute("position", new Float32BufferAttribute(vertices, 3));
        geometry.setAttribute("color", new Float32BufferAttribute(colors, 3)); geometry.setIndex(faces); geometry.computeVertexNormals();
        const material = new MeshLambertMaterial({ vertexColors: true, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
        geometries.push(geometry); materials.push(material); group.add(new Mesh(geometry, material));
      }
      const edgeGeometry = new BufferGeometry(); edgeGeometry.setAttribute("position", new Float32BufferAttribute(edges, 3));
      const edgeMaterial = new LineBasicMaterial({ color: object.kind === "region-line" ? object.color : object.edgeColor });
      geometries.push(edgeGeometry); materials.push(edgeMaterial); group.add(new LineSegments(edgeGeometry, edgeMaterial));
      if (!edges.some((value, index) => index % 6 < 3 && value !== edges[index + 3])) {
        const pointPositions = [];
        for (const instance of object.instances) pointPositions.push(...positions(object.positions.slice(0, 3), instance.matrix));
        const pointGeometry = new BufferGeometry(); pointGeometry.setAttribute("position", new Float32BufferAttribute(pointPositions, 3));
        const pointMaterial = new PointsMaterial({ color: object.color, size: 6, sizeAttenuation: false });
        geometries.push(pointGeometry); materials.push(pointMaterial); group.add(new Points(pointGeometry, pointMaterial));
      }
      scene.add(group); groups.push(group);
      if (interactive) {
        const label = document.createElement("label"), input = document.createElement("input"), text = document.createElement("span");
        input.type = "checkbox"; input.checked = true; input.setAttribute("aria-label", object.label);
        text.textContent = object.label; label.append(input, text); list.append(label);
        listen(input, "change", () => { group.visible = input.checked; render(); });
      }
    }
    if (interactive) {
      listen(renderer.domElement, "webglcontextlost", event => {
        event.preventDefault(); host.dispatchEvent(new CustomEvent("protocol-scene-error", { detail: "WebGL недоступен. Показан сохранённый снимок." }));
      });
    }
    function render() { renderer.render(scene, camera); }
    function resize() {
      const width = Math.max(1, viewport.clientWidth), height = Math.max(1, viewport.clientHeight), aspect = width / height;
      camera.updateMatrixWorld();
      let halfHeight = 0;
      for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) {
        const point = new Vector3(...[x, y, z].map((side, axis) =>
          ((side ? data.bounds.max[axis] : data.bounds.min[axis]) - center[axis]) / scale));
        point.applyMatrix4(camera.matrixWorldInverse);
        halfHeight = Math.max(halfHeight, Math.abs(point.x) / aspect, Math.abs(point.y));
      }
      halfHeight = Math.max(halfHeight * 1.12, .01);
      camera.left = -halfHeight * aspect; camera.right = halfHeight * aspect; camera.top = halfHeight; camera.bottom = -halfHeight;
      camera.updateProjectionMatrix(); renderer.setSize(width, height, false); render();
    }
    function orient(direction) {
      controls?.removeEventListener("change", render); controls?.dispose(); camera.zoom = 1;
      camera.up.set(...(Math.abs(direction[2]) === 1 && direction[0] === 0 && direction[1] === 0 ? [0, 1, 0] : [0, 0, 1]));
      camera.position.copy(new Vector3(...direction).normalize().multiplyScalar(5)); camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
      if (interactive) {
        controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = false;
        controls.target.set(0, 0, 0); controls.minZoom = .02; controls.maxZoom = 200;
        controls.addEventListener("change", render); controls.update();
      }
      resize();
    }
    if (interactive) {
      for (const [name, direction] of [["Исходный вид", [1, -1, .8]], ["X", [1, 0, 0]], ["−X", [-1, 0, 0]],
        ["Y", [0, 1, 0]], ["−Y", [0, -1, 0]], ["Z", [0, 0, 1]], ["−Z", [0, 0, -1]]]) {
        const button = document.createElement("button"); button.type = "button"; button.textContent = name;
        listen(button, "click", () => orient(direction)); toolbar.append(button);
      }
      for (const [name, visible] of [["Показать все", true], ["Скрыть все", false]]) {
        const button = document.createElement("button"); button.type = "button"; button.textContent = name;
        listen(button, "click", () => { groups.forEach(group => { group.visible = visible; });
          list.querySelectorAll("input").forEach(input => { input.checked = visible; }); render(); }); toolbar.append(button);
      }
    }
    orient([1, -1, .8]); resize();
    observer = new ResizeObserver(resize); observer.observe(viewport);
    return { dispose, capture: () => { render(); return { dataUrl: renderer.domElement.toDataURL("image/png"),
      width: renderer.domElement.width, height: renderer.domElement.height }; } };
  } catch (error) { dispose(); throw error; }
}
