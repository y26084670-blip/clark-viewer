import * as THREE from "three";
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createResultLayerReader } from "/src/services/results/resultLayerRequests.js";
import { ThreeGeometryViewport, updateResultLayers, resultLayerRoots } from "/src/components/geometry/ThreeGeometryViewport.jsx";
import { buildGeometryScene } from "/src/services/visualization/geometrySceneModel.js";
import { createMovieGifEncoder } from "/src/services/movie/movieGifEncoder.js";
import "/src/components/geometry/ResultsGeometryViewport.css";
import { buildResultVolumeField } from "/src/services/visualization/resultVolumeField.js";
import { updateResultVolumeMeshes, disposeResultVolumeMesh } from "/src/services/visualization/resultVolumeRenderer.js";
import { createViewCube, installViewCubeControls, syncViewCubeCamera } from "/src/services/visualization/geometryViewCube.js";

window.runFullResultsCheck = async () => {
  const counts = [25_001, 6001], reads = [];
  const task = {
    elements: [{ id: 1, recordIndex: 0, targ: 0, rv: 1, xapName: "steel", dp: [[counts[0]], [1], [1]],
      symLs: 1, symAs: 1, symPs: 1, symKya: 0, symKyp: 0 }],
    regions: [{ id: 1, recordIndex: 0, dp: [[counts[1]], [1]], symLs: 1 }],
    metadata: Object.fromEntries(["JE", "HS"].map((name, i) => [name,
      { steps: [0], header: { inds1: [1], numbs: [counts[i]] } }])),
    reader: { async read(request) {
      reads.push(request);
      const stride = request.name === "JE" ? 9 : 6, values = new Float64Array(request.count * stride);
      for (let row = 0; row < request.count; row++) {
        values.set([row % 160, Math.floor(row / 160), request.name === "JE" ? 0 : 4,
          row === request.count - 1 ? 7 : 1, 0, 0], row * stride);
      }
      return { values, count: request.count, stride, start: request.start, every: request.every };
    } },
  };
  const reader = createResultLayerReader();
  const result = await reader.read({ task, time: 0, layers: [
    { key: "elements", quantityKey: "J", selected: [1] },
    { key: "regions", quantityKey: "Bs", selected: [1] },
  ] });
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(800, 600); renderer.setClearColor(0xffffff);
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-110, 110, 85, -85, .1, 1000);
  camera.position.set(80, 80, 300); camera.lookAt(80, 80, 0);
  let states = new Map();
  const modes = [];
  try {
    for (const mode of ["thin", "solid", "points"]) {
      states = updateResultLayers(THREE, states, result.layers,
        { filters: {}, style: mode === "solid" ? "solid" : "thin", colorMap: mode === "points", scale: 1 });
      for (const root of resultLayerRoots(states)) scene.add(root);
      renderer.render(scene, camera);
      const displayed = result.layers.map(layer => {
        const root = states.get(layer.key).vectorRoot;
        if (mode === "solid") return root.getObjectByName("prescribed-source-magnetization-shaft").count;
        if (mode === "thin") return root.getObjectByName("prescribed-source-magnetization").geometry.drawRange.count / 2;
        return root.children.find(child => child.isPoints).geometry.drawRange.count;
      });
      modes.push({ mode, displayed, glError: renderer.getContext().getError() });
    }
    updateResultLayers(THREE, states, []);
    const positions = [], values = [];
    for (let x = 0; x < 193; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) {
      positions.push(x, y, z); values.push(1);
    }
    const volume = buildResultVolumeField({ domains: [{ key: "long", dimensions: [193, 2, 2],
      positions: Float64Array.from(positions), values: Float64Array.from(values) }] });
    const root = new THREE.Group(); scene.add(root);
    updateResultVolumeMeshes(THREE, root, volume.domains, { minimum: 0, maximum: 2 });
    const along = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 1000);
    along.position.set(250, .5, .5); along.lookAt(96, .5, .5);
    renderer.render(scene, along);
    const gl = renderer.getContext(), pixel = new Uint8Array(4);
    gl.readPixels(400, 300, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    const report = { counts, reads: reads.map(r => ({ count: r.count, every: r.every })),
      errors: result.errors, modes, lastCurrent: result.layers[0].scene.vectors.at(-1).magnitude,
      volume: { dimensions: volume.domains[0].dimensions, pixel: Array.from(pixel), glError: gl.getError() } };
    for (const mesh of root.children) disposeResultVolumeMesh(mesh);
    scene.remove(root);
    const cube = createViewCube(THREE), cubeScene = new THREE.Scene(); cubeScene.add(cube);
    const cubeCamera = new THREE.OrthographicCamera(-1.35, 1.35, 1.35, -1.35, .1, 20);
    const controls = { target: new THREE.Vector3(80, 80, 0) };
    camera.position.set(180, 180, 100); camera.up.set(0, 0, 1); camera.lookAt(controls.target); camera.updateMatrixWorld();
    renderer.autoClear = false;
    const renderCube = () => {
      syncViewCubeCamera(cubeCamera, camera);
      renderer.setViewport(0, 0, 800, 600); renderer.clear();
      renderer.setViewport(8, 8, 120, 120); renderer.render(cubeScene, cubeCamera);
    };
    let sceneClicks = 0;
    const cubeControls = installViewCubeControls({ THREE, element: renderer.domElement, root: cube,
      viewCamera: cubeCamera, getCamera: () => camera, getControls: () => controls,
      getSize: () => 120, onChange: renderCube });
    renderer.domElement.addEventListener("click", () => { sceneClicks++; });
    renderCube();
    window.fullResultsCube = {
      project(direction) {
        const point = new THREE.Vector3(...direction).multiplyScalar(.65).project(cubeCamera);
        const bounds = renderer.domElement.getBoundingClientRect();
        return [bounds.left + 8 + (point.x + 1) * 60, bounds.top + 600 - 8 - (point.y + 1) * 60];
      },
      snapshot: () => ({ direction: camera.position.clone().sub(controls.target).normalize().toArray(),
        distance: camera.position.distanceTo(controls.target), target: controls.target.toArray(), zoom: camera.zoom, sceneClicks }),
    };
    window.closeFullResultsCheck = () => {
      cubeControls.dispose();
      cube.traverse(object => {
        object.geometry?.dispose();
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          material?.map?.dispose(); material?.dispose();
        }
      });
      renderer.dispose();
    };
    return report;
  } catch (error) { renderer.dispose(); throw error; }
  finally { reader.close(); }
};

// Exercise the production viewport, its OrbitControls and movie capture together.
window.mountFullViewportCheck = () => {
  document.body.replaceChildren();
  const host = document.createElement("div"); host.style.cssText = "width:800px;height:600px";
  document.body.appendChild(host);
  const scene = buildGeometryScene({ elements: [{ id: 1, name: "ViewCube check", geoType: 2,
    geo: [[4, 3, 2]], dp: [[2], [2], [2]], targ: 0, rv: 1, xapName: "steel",
    dr: [[0], [0], [0]], symVi: [[0], [0], [0]], symR0: [[0], [0], [0]],
    symLs: 1, symAs: 1, symPs: 1, symYl: 0, symYa: 0, symTx: 0 }], regions: [] });
  if (scene.diagnostics.length) throw new Error(JSON.stringify(scene.diagnostics));
  let state = null, adapter = null, projection;
  const errors = [];
  const dispose = render(() => {
    const [read, write] = createSignal("orthographic"); projection = write;
    return createComponent(ThreeGeometryViewport, { scene, filters: {}, captureFrameKey: "full",
      get projection() { return read(); }, onCameraStateChange: value => { state = value; },
      onCaptureReady: value => { adapter = value; }, onError: message => { if (message) errors.push(message); } });
  }, host);
  window.fullViewport = {
    state: () => state, projection, errors,
    project(direction) {
      const camera = new THREE.PerspectiveCamera(); camera.quaternion.fromArray(state.quaternion);
      const cubeCamera = new THREE.OrthographicCamera(-1.35, 1.35, 1.35, -1.35, .1, 20);
      syncViewCubeCamera(cubeCamera, camera);
      const point = new THREE.Vector3(...direction).multiplyScalar(.65).project(cubeCamera);
      const bounds = host.querySelector("canvas").getBoundingClientRect();
      return [bounds.left + 8 + (point.x + 1) * 60, bounds.bottom - 8 - (point.y + 1) * 60];
    },
    async movie() {
      const encoder = createMovieGifEncoder();
      try {
        adapter.prepare(); await adapter.renderReady("full");
        const first = adapter.capture("full"), second = adapter.capture("full");
        let cubePixels = 0;
        for (let y = first.height - 128; y < first.height - 8; y++) for (let x = 8; x < 128; x++) {
          const offset = (y * first.width + x) * 4;
          if (first.data[offset] > 100 && first.data[offset + 1] > 100 && first.data[offset + 2] > 100) cubePixels++;
        }
        await encoder.addFrame(first, { delayMs: 100 }); await encoder.addFrame(second, { delayMs: 100 });
        const blob = await encoder.finish();
        return { cubePixels, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
      } finally { encoder.close(); adapter.restore(); }
    },
    close: () => { dispose(); host.remove(); },
  };
};
