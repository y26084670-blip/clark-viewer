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

export function geometryCameraCommandFromKeyboardEvent(event, options) {
    if (!event || event.defaultPrevented || event.isComposing
        || event.altKey || event.metaKey || event.shiftKey
        || !isGeometryCameraShortcutTarget(event.target, options)) return null;

    if (event.code === "KeyA") {
        return event.ctrlKey ? GEOMETRY_CAMERA_COMMANDS.RESET_OBLIQUE : GEOMETRY_CAMERA_COMMANDS.FIT_ALL;
    }

    const commands = KEYBOARD_COMMANDS[event.code];
    if (!commands) return null;
    return event.ctrlKey ? commands.negative : commands.positive;
}

export function isGeometryCameraShortcutTarget(target, {allowControls=false}={}) {
    if (target?.isContentEditable) return false;
    const tagName = String(target?.tagName ?? "").toLowerCase();
    if(allowControls && tagName==="select")return true;
    if(allowControls && tagName==="input")return ["range","checkbox","radio","button","submit","reset"].includes(target.type);
    return !["input", "select", "textarea"].includes(tagName);
}


export function geometryAxisRotationFromKeyboardEvent(event, options) {
    if (!event || event.defaultPrevented || event.isComposing
        || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || !isGeometryCameraShortcutTarget(event.target, options)) return null;
    if (event.code === "KeyX") return GEOMETRY_AXIS_ROTATION.X;
    if (event.code === "KeyY") return GEOMETRY_AXIS_ROTATION.Y;
    if (event.code === "KeyZ") return GEOMETRY_AXIS_ROTATION.Z;
    return null;
}

export function rotateGeometryCameraAroundAxis(camera, controls, axis, angle) {
    if (!camera?.position || !camera?.up || !controls?.target
        || !Number.isFinite(angle) || angle === 0
        || !Object.values(GEOMETRY_AXIS_ROTATION).includes(axis)) return false;
    const offset = camera.position.clone().sub(controls.target);
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
    camera.position.copy(controls.target).add(offset);
    camera.lookAt(controls.target);
    controls.update?.();
    return true;
}
