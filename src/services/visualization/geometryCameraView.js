export const GEOMETRY_AXIS_ROTATION = Object.freeze({
    X: "x",
    Y: "y",
    Z: "z",
});

export const GEOMETRY_CAMERA_COMMANDS = Object.freeze({
    FIT_ALL: "fit-all",
    RESET_OBLIQUE: "reset-oblique",
    VIEW_POSITIVE_X: "view-positive-x",
    VIEW_NEGATIVE_X: "view-negative-x",
    VIEW_POSITIVE_Y: "view-positive-y",
    VIEW_NEGATIVE_Y: "view-negative-y",
    VIEW_POSITIVE_Z: "view-positive-z",
    VIEW_NEGATIVE_Z: "view-negative-z",
});

const COMMAND_VALUES = new Set(Object.values(GEOMETRY_CAMERA_COMMANDS));

const KEYBOARD_COMMANDS = Object.freeze({
    KeyX: Object.freeze({
        positive: GEOMETRY_CAMERA_COMMANDS.VIEW_POSITIVE_X,
        negative: GEOMETRY_CAMERA_COMMANDS.VIEW_NEGATIVE_X,
    }),
    KeyY: Object.freeze({
        positive: GEOMETRY_CAMERA_COMMANDS.VIEW_POSITIVE_Y,
        negative: GEOMETRY_CAMERA_COMMANDS.VIEW_NEGATIVE_Y,
    }),
    KeyZ: Object.freeze({
        positive: GEOMETRY_CAMERA_COMMANDS.VIEW_POSITIVE_Z,
        negative: GEOMETRY_CAMERA_COMMANDS.VIEW_NEGATIVE_Z,
    }),
});

export const INITIAL_GEOMETRY_CAMERA_FRAME = Object.freeze({
    offset: Object.freeze([1, 1, 1]),
    up: Object.freeze([0, 0, 1]),
});

const CAMERA_FRAMES = Object.freeze({
    [GEOMETRY_CAMERA_COMMANDS.RESET_OBLIQUE]: INITIAL_GEOMETRY_CAMERA_FRAME,
    [GEOMETRY_CAMERA_COMMANDS.VIEW_POSITIVE_X]: Object.freeze({
        offset: Object.freeze([-1, 0, 0]),
        up: Object.freeze([0, 0, 1]),
    }),
    [GEOMETRY_CAMERA_COMMANDS.VIEW_NEGATIVE_X]: Object.freeze({
        offset: Object.freeze([1, 0, 0]),
        up: Object.freeze([0, 0, 1]),
    }),
    [GEOMETRY_CAMERA_COMMANDS.VIEW_POSITIVE_Y]: Object.freeze({
        offset: Object.freeze([0, -1, 0]),
        up: Object.freeze([0, 0, 1]),
    }),
    [GEOMETRY_CAMERA_COMMANDS.VIEW_NEGATIVE_Y]: Object.freeze({
        offset: Object.freeze([0, 1, 0]),
        up: Object.freeze([0, 0, 1]),
    }),
    [GEOMETRY_CAMERA_COMMANDS.VIEW_POSITIVE_Z]: Object.freeze({
        offset: Object.freeze([0, 0, -1]),
        up: Object.freeze([0, -1, 0]),
    }),
    [GEOMETRY_CAMERA_COMMANDS.VIEW_NEGATIVE_Z]: Object.freeze({
        offset: Object.freeze([0, 0, 1]),
        up: Object.freeze([0, 1, 0]),
    }),
});

export function normalizeGeometryCameraCommand(value) {
    return typeof value === "string" && COMMAND_VALUES.has(value)
        ? value
        : null;
}

export function geometryCameraFrame(value) {
    const command = normalizeGeometryCameraCommand(value);
    const frame = command ? CAMERA_FRAMES[command] : null;
    if (!frame) return null;

    return {
        offset: [...frame.offset],
        up: [...frame.up],
    };
}

/** Orient around the existing target; preserve distance, zoom and frustum.
 * The caller alone decides whether to fit afterward (Ctrl+A, not axis views).
 */
export function orientGeometryCamera(camera, controls, command) {
    const frame = geometryCameraFrame(command);
    if (!frame || !camera?.position || !controls?.target) return false;
    const distance = camera.position.distanceTo(controls.target);
    const norm = Math.hypot(...frame.offset);
    if (!Number.isFinite(distance) || !(distance > 0) || !(norm > 0)) return false;
    camera.up.fromArray(frame.up);
    camera.position.fromArray(frame.offset).multiplyScalar(distance / norm).add(controls.target);
    camera.lookAt(controls.target);
    return true;
}

/** Small numeric view state only: no retained scene, renderer or result buffers. */
export function snapshotGeometryCamera(camera, controls, projection) {
    return {
        projection, position: camera.position.toArray(), quaternion: camera.quaternion.toArray(),
        up: camera.up.toArray(), target: controls.target.toArray(), zoom: camera.zoom,
        near: camera.near, far: camera.far,
        ...(camera.isOrthographicCamera ? { halfHeight: (camera.top - camera.bottom) / 2 }
            : { fov: camera.fov }),
    };
}

export function restoreGeometryCamera(camera, controls, state) {
    const finiteArray = (value, size) => Array.isArray(value) && value.length === size && value.every(Number.isFinite);
    if (!state || (state.projection === "orthographic") !== Boolean(camera.isOrthographicCamera)
        || !finiteArray(state.position, 3) || !finiteArray(state.quaternion, 4)
        || !finiteArray(state.up, 3) || !finiteArray(state.target, 3)
        || !(state.zoom > 0) || !Number.isFinite(state.zoom)
        || !(state.far > state.near) || !Number.isFinite(state.near) || !Number.isFinite(state.far)
        || (camera.isOrthographicCamera ? !(state.halfHeight > 0) || !Number.isFinite(state.halfHeight)
            : !(state.fov > 0 && state.fov < 180))) return false;
    camera.position.fromArray(state.position);
    camera.quaternion.fromArray(state.quaternion).normalize();
    camera.up.fromArray(state.up);
    controls.target.fromArray(state.target);
    camera.zoom = state.zoom; camera.near = state.near; camera.far = state.far;
    if (camera.isOrthographicCamera) {
        const aspect = Math.abs((camera.right - camera.left) / (camera.top - camera.bottom));
        camera.top = state.halfHeight; camera.bottom = -state.halfHeight;
        camera.left = -state.halfHeight * aspect; camera.right = state.halfHeight * aspect;
    } else camera.fov = state.fov;
    camera.updateProjectionMatrix();
    controls.update?.();
    return true;
}

export function geometryCameraCommandFromKeyboardEvent(event, options) {
    if (!event || event.defaultPrevented || event.isComposing
        || event.altKey || event.metaKey || event.shiftKey
        || !isGeometryCameraShortcutTarget(event.target, options)) return null;

    if (event.code === "KeyA") {
        return event.ctrlKey ? GEOMETRY_CAMERA_COMMANDS.RESET_OBLIQUE : GEOMETRY_CAMERA_COMMANDS.FIT_ALL;
    }

    const commands = KEYBOARD_COMMANDS[event.code];
    if (!commands) return null;
    return event.ctrlKey ? null : commands.positive; // Ctrl+axis belongs to mouse rotation.
}

export function isGeometryCameraShortcutTarget(target, {allowControls=false}={}) {
    if (target?.isContentEditable) return false;
    const tagName = String(target?.tagName ?? "").toLowerCase();
    if(allowControls && tagName==="select")return true;
    if(allowControls && tagName==="input")return ["range","checkbox","radio","button","submit","reset"].includes(target.type);
    return !["input", "select", "textarea"].includes(tagName);
}


function axisFromModifiedKeyboardEvent(event, modifier, options) {
    if (!event || event.defaultPrevented || event.isComposing
        || event.metaKey
        || !isGeometryCameraShortcutTarget(event.target, options)) return null;
    const valid = modifier === "alt"
        ? (event.ctrlKey || event.altKey) && !event.shiftKey && !(event.ctrlKey && event.altKey)
        : event.shiftKey && !event.altKey && !event.ctrlKey;
    if (!valid) return null;
    if (event.code === "KeyX") return GEOMETRY_AXIS_ROTATION.X;
    if (event.code === "KeyY") return GEOMETRY_AXIS_ROTATION.Y;
    if (event.code === "KeyZ") return GEOMETRY_AXIS_ROTATION.Z;
    return null;
}

export function geometryAxisRotationFromKeyboardEvent(event, options) {
    return axisFromModifiedKeyboardEvent(event, "alt", options);
}

export function geometryOriginAxisRotationFromKeyboardEvent(event, options) {
    return axisFromModifiedKeyboardEvent(event, "shift", options);
}

/** Own one viewport's axis gesture, using CSS coordinates outside pointer lock. */
export function createGeometryAxisRotationController({
    element, getCamera, getControls, canStart = () => true,
    onStateChange = () => {}, onRotate = () => {},
    onPointerMove = () => {}, onPointerLeave = () => {},
}) {
    const owner = element.ownerDocument, win = owner.defaultView;
    let axis = null, pivot = "target", inside = false, previous = null, dragAxis = null;
    let motionX = 0, motionY = 0;
    let ownedControls = null, previousEnabled = true, disposed = false;
    const point = event => Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
        ? { x: event.clientX, y: event.clientY, id: event.pointerId } : null;
    const available = () => !disposed && !owner.hidden && !owner.querySelector("dialog[open]") && canStart();
    const modifierHeld = event => !event.metaKey && (pivot === "origin"
        ? event.shiftKey && !event.altKey && !event.ctrlKey
        : (event.altKey || event.ctrlKey) && !event.shiftKey && !(event.altKey && event.ctrlKey));
    function resetDirection() { dragAxis = null; motionX = motionY = 0; }
    function stop() {
        if (!axis) return;
        axis = null; resetDirection();
        if (getControls() === ownedControls) ownedControls.enabled = previousEnabled;
        ownedControls = null;
        if (!disposed) onStateChange(false);
    }
    function keyDown(event) {
        if (!inside || !available()) { stop(); return; }
        const targetAxis = geometryAxisRotationFromKeyboardEvent(event, { allowControls: true });
        const originAxis = geometryOriginAxisRotationFromKeyboardEvent(event, { allowControls: true });
        const nextAxis = targetAxis ?? originAxis, nextPivot = originAxis ? "origin" : "target";
        if (!nextAxis) {
            if (axis && !modifierHeld(event)) stop();
            return;
        }
        const controls = getControls();
        if (!controls || !getCamera()) return;
        event.preventDefault();
        if (axis === nextAxis && pivot === nextPivot) return;
        const wasActive = Boolean(axis);
        if (!wasActive) {
            ownedControls = controls; previousEnabled = controls.enabled;
            controls.enabled = false;
        }
        axis = nextAxis; pivot = nextPivot; resetDirection();
        if (!wasActive) onStateChange(true);
    }
    function keyUp(event) { if (axis && !modifierHeld(event)) stop(); }
    function pointerEnter(event) { inside = true; previous = point(event); resetDirection(); }
    function pointerMove(event) {
        inside = true;
        const before = previous;
        previous = point(event);
        if (!available()) { stop(); previous = null; return; }
        if (axis && !modifierHeld(event)) stop();
        if (!axis) { onPointerMove(event); return; }
        event.preventDefault();
        if (!before || !previous || before.id !== previous.id) { resetDirection(); return; }
        const dx = previous.x - before.x, dy = previous.y - before.y;
        if (dx === 0 && dy === 0) return;
        // Remember direction over about 8 CSS pixels, rather than locking it to
        // the first tiny movement. A 2:1 margin keeps diagonal input from jittering.
        const distance = Math.hypot(dx, dy), keep = Math.exp(-distance / 8);
        motionX = motionX * keep + Math.abs(dx) / distance * (1 - keep);
        motionY = motionY * keep + Math.abs(dy) / distance * (1 - keep);
        if (!dragAxis) dragAxis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
        else if (motionX > motionY * 2) dragAxis = "x";
        else if (motionY > motionX * 2) dragAxis = "y";
        const movement = dragAxis === "x" ? dx : -dy;
        const camera = getCamera(), controls = getControls(), origin = pivot === "origin";
        if (!camera || !controls) { stop(); return; }
        if (rotateGeometryCameraAroundAxis(camera, controls, axis, movement * 0.006, {
            pivot: origin ? new camera.position.constructor() : controls.target,
            rotateTarget: origin, updateControls: false,
        })) onRotate();
    }
    function pointerLeave() {
        inside = false; previous = null; resetDirection(); onPointerLeave();
    }
    function blur() { inside = false; previous = null; stop(); }
    element.addEventListener("pointerenter", pointerEnter);
    element.addEventListener("pointermove", pointerMove);
    element.addEventListener("pointerleave", pointerLeave);
    owner.addEventListener("keydown", keyDown, true);
    owner.addEventListener("keyup", keyUp, true);
    win?.addEventListener("blur", blur);
    return {
        get active() { return Boolean(axis); },
        stop,
        dispose() {
            disposed = true; stop(); previous = null;
            element.removeEventListener("pointerenter", pointerEnter);
            element.removeEventListener("pointermove", pointerMove);
            element.removeEventListener("pointerleave", pointerLeave);
            owner.removeEventListener("keydown", keyDown, true);
            owner.removeEventListener("keyup", keyUp, true);
            win?.removeEventListener("blur", blur);
        },
    };
}

export function rotateGeometryCameraAroundAxis(camera, controls, axis, angle, {
    pivot = controls?.target,
    rotateTarget = false,
    updateControls = true,
} = {}) {
    if (!camera?.position || !camera?.up || !controls?.target
        || !Number.isFinite(angle) || angle === 0
        || !Object.values(GEOMETRY_AXIS_ROTATION).includes(axis)) return false;
    if (!pivot) return false;
    const offset = camera.position.clone().sub(pivot);
    if (!(offset.lengthSq() > 0)) return false;
    const basis = axis === GEOMETRY_AXIS_ROTATION.X ? [1,0,0]
        : axis === GEOMETRY_AXIS_ROTATION.Y ? [0,1,0] : [0,0,1];
    const quaternion = camera.quaternion?.constructor
        ? new camera.quaternion.constructor().setFromAxisAngle(
            new camera.position.constructor(...basis),
            angle,
          )
        : null;
    if (!quaternion) return false;
    offset.applyQuaternion(quaternion);
    camera.up.applyQuaternion(quaternion).normalize();
    camera.position.copy(pivot).add(offset);
    if (rotateTarget) {
        const targetOffset = controls.target.clone().sub(pivot).applyQuaternion(quaternion);
        controls.target.copy(pivot).add(targetOffset);
    }
    camera.lookAt(controls.target);
    if (updateControls) controls.update?.();
    return true;
}
