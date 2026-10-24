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

export function setLensProjection(THREE, detail, source, width, height, x, y, magnification) {
  const centreX = 2 * x / width - 1, centreY = 1 - 2 * y / height;
  const crop = new THREE.Matrix4().set(magnification, 0, 0, (1 - magnification) * centreX,
    0, magnification, 0, (1 - magnification) * centreY, 0, 0, 1, 0, 0, 0, 0, 1);
  detail.projectionMatrix.multiplyMatrices(crop, source.projectionMatrix);
  detail.projectionMatrixInverse.copy(detail.projectionMatrix).invert();
}

export function createViewportLens({ THREE, renderer, enabled = () => true, requestRender = () => {},
  renderDetails = (scene, camera) => renderer.render(scene, camera) }) {
  const element = renderer.domElement, owner = element.ownerDocument, win = owner?.defaultView;
  let inside = false, leftControl = false, x = 0, y = 0, disposed = false;
  let texture, scene, camera, material, quad, detailCamera;
  let magnification = VIEWPORT_LENS_MAGNIFICATION;
  // A slider or checkbox may retain focus after the pointer returns to 3D.
  // Neither that focus nor the presence/magnitude of sources gates the lens.
  const active = () => !disposed && inside && leftControl && enabled() && !owner?.hidden;
  function move(event) {
    const wasActive = active(), rect = element.getBoundingClientRect();
    x = event.clientX - rect.left; y = event.clientY - rect.top;
    inside = x >= 0 && y >= 0 && x < rect.width && y < rect.height;
    // Pointer events cannot distinguish the two Ctrl keys. Only keyboard
    // events may activate the lens; pointer events can clear a missed release.
    if (!event.ctrlKey) leftControl = false;
    if (!wasActive && active()) magnification = VIEWPORT_LENS_MAGNIFICATION;
    if (wasActive || active()) requestRender();
  }
  function key(event) {
    if (event.code !== "ControlLeft") return;
    const wasActive = active();
    leftControl = event.type === "keydown";
    if (!wasActive && active()) magnification = VIEWPORT_LENS_MAGNIFICATION;
    if (wasActive !== active()) requestRender();
  }
  function leave() {
    const wasActive = active(); inside = false;
    if (wasActive) requestRender();
  }
  function clear() {
    leave(); leftControl = false;
  }
  function visibility() { if (owner.hidden) clear(); }
  function wheel(event) {
    if (!active()) return;
    // Capture before OrbitControls: left Ctrl+wheel never zooms the main camera
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
  element.addEventListener("pointerleave", leave);
  owner?.addEventListener("keydown", key, true);
  owner?.addEventListener("keyup", key, true);
  owner?.addEventListener("visibilitychange", visibility);
  win?.addEventListener("blur", clear);

  function allocate() {
    material = new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending,
      uniforms: { image: { value: null }, resolution: { value: new THREE.Vector2() },
        centre: { value: new THREE.Vector2() }, radius: { value: VIEWPORT_LENS_RADIUS },
        rim: { value: 1 } },
      vertexShader: "varying vec2 uvScreen; void main(){ uvScreen=uv; gl_Position=vec4(position.xy,0.,1.); }",
      fragmentShader: `
        uniform sampler2D image;
        uniform vec2 resolution, centre;
        uniform float radius, rim;
        varying vec2 uvScreen;
        void main() {
          vec2 pixel = uvScreen * resolution;
          vec2 offset = pixel - centre;
          float distance = length(offset);
          if (distance < radius - rim) discard;
          // Restore only the surroundings, one source pixel to one output pixel.
          gl_FragColor = texture2D(image, uvScreen);
          if (distance < radius) gl_FragColor = vec4(.65, .72, .8, 1.);

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
      const size = renderer.getDrawingBufferSize(material.uniforms.resolution.value);
      const pixelRatio = size.x / rect.width;
      if (texture?.image.width !== size.x || texture?.image.height !== size.y) {
        texture?.dispose(); texture = new THREE.FramebufferTexture(size.x, size.y);
        texture.minFilter = texture.magFilter = THREE.NearestFilter;
        material.uniforms.image.value = texture;
      }
      material.uniforms.centre.value.set(x * pixelRatio, (rect.height - y) * size.y / rect.height);
      material.uniforms.radius.value = VIEWPORT_LENS_RADIUS * pixelRatio;
      material.uniforms.rim.value = pixelRatio;
      renderer.render(sourceScene, sourceCamera);
      renderer.copyFramebufferToTexture(texture);
      if (!detailCamera || detailCamera.type !== sourceCamera.type) detailCamera = sourceCamera.clone();
      else detailCamera.copy(sourceCamera, false);
      setLensProjection(THREE, detailCamera, sourceCamera, rect.width, rect.height, x, y, magnification);
      const previousAutoClear = renderer.autoClear, previousScissor = renderer.getScissor(new THREE.Vector4());
      const previousScissorTest = renderer.getScissorTest();
      try {
        // Render GEOMETRY again in the same antialiased framebuffer. This also
        // preserves the original transparency/tone mapping exactly. Scissor
        // limits fragment work; the saved image only restores circle corners.
        const left = Math.max(0, x - VIEWPORT_LENS_RADIUS), top = Math.max(0, y - VIEWPORT_LENS_RADIUS);
        const right = Math.min(rect.width, x + VIEWPORT_LENS_RADIUS), bottom = Math.min(rect.height, y + VIEWPORT_LENS_RADIUS);
        renderer.setScissor(left, rect.height - bottom, right - left, bottom - top);
        renderer.setScissorTest(true); renderer.autoClear = true;
        renderDetails(sourceScene, detailCamera);
        renderer.autoClear = false; renderer.render(scene, camera);
      } finally {
        renderer.setScissor(previousScissor); renderer.setScissorTest(previousScissorTest);
        renderer.autoClear = previousAutoClear;
      }
    },
    dispose() {
      clear(); disposed = true;
      element.removeEventListener("wheel", wheel, true);
      element.removeEventListener("pointerenter", move);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerleave", leave);
      owner?.removeEventListener("keydown", key, true);
      owner?.removeEventListener("keyup", key, true);
      owner?.removeEventListener("visibilitychange", visibility);
      win?.removeEventListener("blur", clear);
      texture?.dispose(); quad?.geometry.dispose(); material?.dispose();
    },
  };
}
