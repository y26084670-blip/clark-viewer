export const VIEWPORT_LENS_RADIUS = 300;
export const VIEWPORT_LENS_DIAMETER = VIEWPORT_LENS_RADIUS * 2;
export const VIEWPORT_LENS_MAGNIFICATION = 5;

// Uniform magnification inside a circular aperture. Picking uses the same
// mapping as the displayed image, in CSS pixels.
export function lensSourcePoint(x, y, centreX, centreY, radius = VIEWPORT_LENS_RADIUS, magnification = VIEWPORT_LENS_MAGNIFICATION) {
  const dx = x - centreX, dy = y - centreY, t = Math.hypot(dx, dy) / radius;
  if (!(t < 1)) return { x, y };
  return { x: centreX + dx / magnification, y: centreY + dy / magnification };
}

export function createViewportLens({ THREE, renderer, enabled = () => true, requestRender = () => {} }) {
  const element = renderer.domElement, owner = element.ownerDocument, win = owner?.defaultView;
  let inside = false, control = false, x = 0, y = 0, disposed = false;
  let texture, scene, camera, material, quad;
  let magnification = VIEWPORT_LENS_MAGNIFICATION;
  // A slider or checkbox may retain focus after the pointer returns to 3D.
  // Neither that focus nor the presence/magnitude of sources gates the lens.
  const active = () => !disposed && inside && control && enabled() && !owner?.hidden;
  function move(event) {
    const wasActive = active(), rect = element.getBoundingClientRect();
    x = event.clientX - rect.left; y = event.clientY - rect.top;
    inside = x >= 0 && y >= 0 && x < rect.width && y < rect.height;
    control = event.ctrlKey === true;
    if (!wasActive && active()) magnification = VIEWPORT_LENS_MAGNIFICATION;
    if (wasActive || active()) requestRender();
  }
  function key(event) {
    const wasActive = active();
    control = event.ctrlKey === true;
    if (!wasActive && active()) magnification = VIEWPORT_LENS_MAGNIFICATION;
    if (wasActive !== active()) requestRender();
  }
  function clear() {
    const wasActive = inside && control; inside = false; control = false;
    if (wasActive) requestRender();
  }
  function visibility() { if (owner.hidden) clear(); }
  function wheel(event) {
    if (!active()) return;
    // Capture before OrbitControls: Ctrl+wheel must never zoom the main camera
    // or the browser page. Trackpads and line/page wheel units work alike.
    event.preventDefault(); event.stopImmediatePropagation();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 150 : 1);
    const next = magnification * Math.exp(-Math.max(-1000, Math.min(1000, delta)) * .002);
    if (Number.isFinite(next)) magnification = Math.max(1, next);
    requestRender();
  }
  element.addEventListener("wheel", wheel, { capture: true, passive: false });
  element.addEventListener("pointerenter", move);
  element.addEventListener("pointermove", move);
  element.addEventListener("pointerleave", clear);
  owner?.addEventListener("keydown", key, true);
  owner?.addEventListener("keyup", key, true);
  owner?.addEventListener("visibilitychange", visibility);
  win?.addEventListener("blur", clear);

  function allocate() {
    material = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending,
      uniforms: { image: { value: null }, resolution: { value: new THREE.Vector2() },
        centre: { value: new THREE.Vector2() }, radius: { value: VIEWPORT_LENS_RADIUS },
        rim: { value: 1 }, magnification: { value: VIEWPORT_LENS_MAGNIFICATION } },
      vertexShader: "varying vec2 uvScreen; void main(){ uvScreen=uv; gl_Position=vec4(position.xy,0.,1.); }",
      fragmentShader: `
        uniform sampler2D image;
        uniform vec2 resolution, centre;
        uniform float radius, rim, magnification;
        varying vec2 uvScreen;
        void main() {
          vec2 pixel = uvScreen * resolution;
          vec2 offset = pixel - centre;
          float distance = length(offset);
          if (distance >= radius) discard;
          vec2 source = (centre + offset / magnification) / resolution;
          gl_FragColor = texture2D(image, source);
          // Keep the active aperture visible even over zero-valued/empty fields.
          if (distance >= radius - rim) gl_FragColor = vec4(.65, .72, .8, 1.);
        }`,
    });
    scene = new THREE.Scene(); camera = new THREE.Camera();
    quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false; scene.add(quad);
  }
  return {
    get active() { return active(); },
    get magnification() { return magnification; }, clear,
    sourcePoint(clientX, clientY) {
      if (!active()) return { clientX, clientY };
      const rect = element.getBoundingClientRect();
      const point = lensSourcePoint(clientX - rect.left, clientY - rect.top, x, y, VIEWPORT_LENS_DIAMETER / 2, magnification);
      return { clientX: point.x + rect.left, clientY: point.y + rect.top };
    },
    render(sourceScene, sourceCamera) {
      if (!active()) { renderer.render(sourceScene, sourceCamera); return; }
      const rect = element.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) { renderer.render(sourceScene, sourceCamera); return; }
      if (!material) allocate();
      material.uniforms.magnification.value = magnification;
      const size = renderer.getDrawingBufferSize(material.uniforms.resolution.value);
      if (texture?.image.width !== size.x || texture?.image.height !== size.y) {
        texture?.dispose();
        texture = new THREE.FramebufferTexture(size.x, size.y);
        texture.minFilter = texture.magFilter = THREE.LinearFilter;
        material.uniforms.image.value = texture;
      }
      material.uniforms.centre.value.set(x * size.x / rect.width, (rect.height - y) * size.y / rect.height);
      material.uniforms.radius.value = VIEWPORT_LENS_DIAMETER / 2 * size.x / rect.width;
      material.uniforms.rim.value = size.x / rect.width;
      // Copy the already rendered image, including its antialiasing, transparency
      // and output colors. Leave every pixel outside the lens untouched.
      renderer.render(sourceScene, sourceCamera);
      renderer.copyFramebufferToTexture(texture);
      const previousAutoClear = renderer.autoClear;
      try {
        renderer.autoClear = false;
        renderer.render(scene, camera);
      } finally { renderer.autoClear = previousAutoClear; }
    },
    dispose() {
      clear(); disposed = true;
      element.removeEventListener("wheel", wheel, true);
      element.removeEventListener("pointerenter", move);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerleave", clear);
      owner?.removeEventListener("keydown", key, true);
      owner?.removeEventListener("keyup", key, true);
      owner?.removeEventListener("visibilitychange", visibility);
      win?.removeEventListener("blur", clear);
      texture?.dispose(); quad?.geometry.dispose(); material?.dispose();
    },
  };
}
