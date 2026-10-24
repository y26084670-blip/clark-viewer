export const VIEW_CUBE_SIZE = 120;
export const VIEW_CUBE_MARGIN = 8;
// The former white face centre occupied half the original cube edge.
export const VIEW_CUBE_EDGE = .8;
const HALF = VIEW_CUBE_EDGE / 2;
const FACE_LABELS = [
  ["X", "#f05252"], ["−X", "#f05252"],
  ["Y", "#4bc26b"], ["−Y", "#4bc26b"],
  ["Z", "#4c8ff2"], ["−Z", "#4c8ff2"],
];

function faceTexture(THREE, [axis, color]) {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d");
  context.fillStyle = color; context.fillRect(0, 0, 256, 256);
  context.textAlign = "center"; context.textBaseline = "middle";
  context.fillStyle = context.strokeStyle = "#ffff00";
  context.font = "900 144px Arial, sans-serif";
  context.lineWidth = 4; context.lineJoin = "round";
  const metrics = context.measureText(axis), scale = Math.min(1, 208 / metrics.width);
  context.strokeText(axis, 116, 136, 208);
  context.fillText(axis, 116, 136, 208);
  // Keep the orientation dot beside the lower right of the letter on every face.
  context.beginPath();
  context.arc(116 + metrics.actualBoundingBoxRight * scale + 14,
    136 + metrics.actualBoundingBoxDescent - 7, 9, 0, Math.PI * 2);
  context.fill();
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createViewCube(THREE) {
  const root = new THREE.Group(); root.name = "screen-view-cube";
  const geometry = new THREE.BoxGeometry(HALF * 2, HALF * 2, HALF * 2);
  // BoxGeometry assumes Y-up; orient the face lettering for the Viewer Z-up views.
  const positions = geometry.getAttribute("position"), uv = geometry.getAttribute("uv");
  for (let face = 0; face < 6; face++) {
    const normal = new THREE.Vector3().setComponent(Math.floor(face / 2), face % 2 ? -1 : 1);
    const up = face < 4 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, face % 2 ? -1 : 1, 0);
    const right = new THREE.Vector3().crossVectors(up, normal);
    for (let index = face * 4; index < face * 4 + 4; index++) {
      const point = new THREE.Vector3().fromBufferAttribute(positions, index);
      uv.setXY(index, point.dot(right) / (HALF * 2) + .5, point.dot(up) / (HALF * 2) + .5);
    }
  }
  const cube = new THREE.Mesh(geometry,
    FACE_LABELS.map(label => new THREE.MeshBasicMaterial({ map: faceTexture(THREE, label) })));
  cube.name = "view-cube-faces";
  const highlight = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({
    color: 0xffbe48, transparent: true, opacity: .5, depthWrite: false,
  }));
  highlight.name = "view-cube-hover"; highlight.visible = false; highlight.raycast = () => {};
  root.add(cube, highlight); root.userData.cube = cube; root.userData.highlight = highlight;
  return root;
}

export function viewCubeDirection(point) {
  return [point.x, point.y, point.z].map(value => Math.abs(value) >= HALF / 2 - 1e-9 ? Math.sign(value) : 0);
}

export function viewCubeRayDirection(THREE, ray) {
  // Analytic box picking includes exact shared edges/corners even when triangle
  // intersection would lose a hit through floating-point rounding.
  const box = new THREE.Box3(new THREE.Vector3(-HALF, -HALF, -HALF), new THREE.Vector3(HALF, HALF, HALF));
  const point = ray.intersectBox(box, new THREE.Vector3());
  return point ? viewCubeDirection(point) : null;
}

export function highlightViewCube(root, direction) {
  const highlight = root.userData.highlight;
  highlight.visible = Boolean(direction);
  if (!direction) return;
  highlight.position.fromArray(direction.map(value => value * HALF * .75));
  highlight.scale.fromArray(direction.map(value => value ? HALF * .5 + .012 : HALF));
}

export function syncViewCubeCamera(viewCamera, camera) {
  viewCamera.quaternion.copy(camera.quaternion);
  viewCamera.position.set(0, 0, 5).applyQuaternion(camera.quaternion);
  viewCamera.up.copy(camera.up); viewCamera.updateMatrixWorld();
}

export function orientViewCubeCamera(camera, controls, direction) {
  const norm = Math.hypot(...direction), distance = camera.position.distanceTo(controls.target);
  if (!(norm > 0) || !Number.isFinite(norm) || !(distance > 0)) return false;
  camera.position.fromArray(direction).multiplyScalar(distance / norm).add(controls.target);
  camera.up.set(0, 0, 1);
  if (!direction[0] && !direction[1]) camera.up.set(0, Math.sign(direction[2]), 0);
  camera.lookAt(controls.target); camera.updateMatrixWorld();
  return true;
}

/** Capture cube gestures before OrbitControls and result picking see them. */
export function installViewCubeControls({ THREE, element, root, viewCamera, getCamera, getControls,
  getSize, canInteract = () => true, onChange, onHover }) {
  const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let gesture = null, hovered = null, cubeClick = false;
  const viewportPoint = event => {
    const bounds = element.getBoundingClientRect(), size = getSize();
    const x = event.clientX - bounds.left - VIEW_CUBE_MARGIN;
    const y = event.clientY - bounds.top - bounds.height + VIEW_CUBE_MARGIN + size;
    return { x, y, size, inside: x >= 0 && y >= 0 && x <= size && y <= size };
  };
  const hit = event => {
    const p = viewportPoint(event);
    if (!p.inside) return null;
    syncViewCubeCamera(viewCamera, getCamera()); root.updateMatrixWorld(true);
    ndc.set(p.x / p.size * 2 - 1, 1 - p.y / p.size * 2);
    raycaster.setFromCamera(ndc, viewCamera);
    return viewCubeRayDirection(THREE, raycaster.ray);
  };
  const consume = event => { event.preventDefault(); event.stopImmediatePropagation(); };
  const setHover = direction => {
    const key = direction?.join(",") ?? null;
    if (key === hovered) return;
    hovered = key;
    highlightViewCube(root, direction); onHover?.(direction); onChange?.(false);
    element.style.cursor = direction ? "pointer" : "";
  };
  const hover = event => setHover(canInteract() ? hit(event) : null);
  const down = event => {
    if (gesture) { consume(event); return; }
    cubeClick = viewportPoint(event).inside;
    if (!cubeClick) return;
    consume(event);
    if (event.button !== 0 || !canInteract()) return;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, direction: hit(event) };
    element.setPointerCapture?.(event.pointerId);
  };
  const move = event => {
    if (!gesture) { hover(event); return; }
    consume(event);
    if (event.pointerId !== gesture.id) return;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (!canInteract()) return;
    if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
    gesture.moved = true; gesture.x = event.clientX; gesture.y = event.clientY;
    const camera = getCamera(), controls = getControls();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const turn = new THREE.Quaternion().setFromAxisAngle(camera.up.clone().normalize(), -dx * .008)
      .multiply(new THREE.Quaternion().setFromAxisAngle(right, -dy * .008));
    camera.position.sub(controls.target).applyQuaternion(turn).add(controls.target);
    camera.up.applyQuaternion(turn); camera.lookAt(controls.target); camera.updateMatrixWorld();
    setHover(null); onChange?.(true);
  };
  const up = event => {
    if (!gesture) return;
    consume(event);
    if (event.pointerId !== gesture.id) return;
    if (event.type === "pointerup" && !gesture.moved && gesture.direction && canInteract()
        && orientViewCubeCamera(getCamera(), getControls(), gesture.direction)) onChange?.(true);
    const id = gesture.id; gesture = null;
    if (element.hasPointerCapture?.(id)) element.releasePointerCapture(id);
    hover(event);
  };
  const leave = () => { if (!gesture) setHover(null); };
  // Pointer capture can end outside the cube. Its resulting click must still
  // stay out of result picking; the next scene pointerdown resets this flag.
  const block = event => {
    if (viewportPoint(event).inside || (cubeClick && (event.type === "click" || event.type === "dblclick"))) consume(event);
  };
  const handlers = { pointerdown: down, pointermove: move, pointerup: up, pointercancel: up,
    lostpointercapture: up, pointerleave: leave, click: block, dblclick: block, contextmenu: block, wheel: block };
  for (const [type, handler] of Object.entries(handlers)) element.addEventListener(type, handler, { capture: true, passive: false });
  return { hit, dispose() {
    if (gesture && element.hasPointerCapture?.(gesture.id)) element.releasePointerCapture(gesture.id);
    gesture = null; element.style.cursor = "";
    for (const [type, handler] of Object.entries(handlers)) element.removeEventListener(type, handler, true);
  } };
}
