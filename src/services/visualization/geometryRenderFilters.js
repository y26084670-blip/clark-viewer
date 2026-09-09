export const GEOMETRY_SOURCE_CATEGORIES = Object.freeze({
    ELEMENTS: "elements",
    REGIONS: "regions",
});

export const OBJECT_VISIBILITY_MODES = Object.freeze({
    ALL: "all",
    SELECTED: "selected",
    NONE: "none",
});

export const DEFAULT_OBJECT_MODES = Object.freeze({
    [GEOMETRY_SOURCE_CATEGORIES.ELEMENTS]: OBJECT_VISIBILITY_MODES.ALL,
    [GEOMETRY_SOURCE_CATEGORIES.REGIONS]: OBJECT_VISIBILITY_MODES.ALL,
});

export const DEFAULT_SYMMETRY_FILTERS = Object.freeze({
    local: true,
    axial: true,
    periodic: true,
    mirror: true,
});

const SOURCE_CATEGORIES = new Set(Object.values(GEOMETRY_SOURCE_CATEGORIES));

export function sourceCategory(source) {
    const schemaId = source?.source?.schemaId ?? source?.schemaId;
    return SOURCE_CATEGORIES.has(schemaId) ? schemaId : null;
}

function selectionContains(selection, recordIndex) {
    if (selection instanceof Set) return selection.has(recordIndex);
    if (Array.isArray(selection)) return selection.includes(recordIndex);
    return false;
}

export function primitiveVisible(
    primitive,
    objectModes = DEFAULT_OBJECT_MODES,
    selections = {},
) {
    const category = sourceCategory(primitive);
    if (!category) return false;

    const mode = objectModes?.[category]
        ?? DEFAULT_OBJECT_MODES[category];

    if (mode === OBJECT_VISIBILITY_MODES.NONE) return false;
    if (mode === OBJECT_VISIBILITY_MODES.ALL) return true;
    if (mode !== OBJECT_VISIBILITY_MODES.SELECTED) return false;

    const recordIndex = primitive?.source?.recordIndex;
    return Number.isSafeInteger(recordIndex)
        && recordIndex >= 0
        && selectionContains(selections?.[category], recordIndex);
}

export function instanceVisible(
    instance,
    symmetryFilters = DEFAULT_SYMMETRY_FILTERS,
) {
    const usesLocal = Number(instance?.ls) > 0;
    const usesAxial = Number(instance?.as) > 0;
    const usesPeriodic = Number(instance?.ps) > 0;
    const usesMirror = Number(instance?.mirrorX) > 0
        || Number(instance?.mirrorY) > 0;

    return (!usesLocal || symmetryFilters?.local !== false)
        && (!usesAxial || symmetryFilters?.axial !== false)
        && (!usesPeriodic || symmetryFilters?.periodic !== false)
        && (!usesMirror || symmetryFilters?.mirror !== false);
}
