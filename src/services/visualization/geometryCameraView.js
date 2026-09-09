export const GEOMETRY_CAMERA_COMMANDS = Object.freeze({
    FIT_ALL: "fit-all",
    VIEW_POSITIVE_X: "view-positive-x",
    VIEW_NEGATIVE_X: "view-negative-x",
    VIEW_POSITIVE_Y: "view-positive-y",
    VIEW_NEGATIVE_Y: "view-negative-y",
    VIEW_POSITIVE_Z: "view-positive-z",
    VIEW_NEGATIVE_Z: "view-negative-z",
});

const COMMAND_VALUES = new Set(Object.values(GEOMETRY_CAMERA_COMMANDS));

const KEYBOARD_COMMANDS = Object.freeze({
    x: Object.freeze({
        positive: GEOMETRY_CAMERA_COMMANDS.VIEW_POSITIVE_X,
        negative: GEOMETRY_CAMERA_COMMANDS.VIEW_NEGATIVE_X,
    }),
    y: Object.freeze({
        positive: GEOMETRY_CAMERA_COMMANDS.VIEW_POSITIVE_Y,
        negative: GEOMETRY_CAMERA_COMMANDS.VIEW_NEGATIVE_Y,
    }),
    z: Object.freeze({
        positive: GEOMETRY_CAMERA_COMMANDS.VIEW_POSITIVE_Z,
        negative: GEOMETRY_CAMERA_COMMANDS.VIEW_NEGATIVE_Z,
    }),
});

const CAMERA_FRAMES = Object.freeze({
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

export function geometryCameraCommandFromKeyboardEvent(event) {
    if (!event || event.altKey || event.metaKey || event.shiftKey) return null;

    const key = String(event.key ?? "").toLowerCase();
    if (key === "a") {
        return event.ctrlKey ? null : GEOMETRY_CAMERA_COMMANDS.FIT_ALL;
    }

    const commands = KEYBOARD_COMMANDS[key];
    if (!commands) return null;
    return event.ctrlKey ? commands.negative : commands.positive;
}

export function isGeometryCameraShortcutTarget(target) {
    if (target?.isContentEditable) return false;
    const tagName = String(target?.tagName ?? "").toLowerCase();
    return !["input", "select", "textarea"].includes(tagName);
}
