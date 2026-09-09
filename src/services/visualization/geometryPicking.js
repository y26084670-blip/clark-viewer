const SOURCE_LABELS = Object.freeze({
    elements: "Элемент",
    regions: "Область",
});

const COORDINATE_NAMES = Object.freeze(["X", "Y", "Z"]);
const EXPONENTIAL_UPPER_BOUND = 1e6;
const EXPONENTIAL_LOWER_BOUND = 1e-4;
const COORDINATE_SIGNIFICANT_DIGITS = 7;

function sourceLabel(source) {
    return SOURCE_LABELS[source?.schemaId] ?? "Объект";
}

function oneBasedIndex(value) {
    return Number.isSafeInteger(value) && value >= 0
        ? String(value + 1)
        : "?";
}

function sourceName(source) {
    return typeof source?.name === "string" ? source.name.trim() : "";
}

function displayedSymmetryIndex(value) {
    const index = Number(value);
    return Number.isSafeInteger(index) && index > 0 ? index + 1 : null;
}

export function formatSymmetryInstance(instance) {
    const labels = [];
    const axial = displayedSymmetryIndex(instance?.as);
    const periodic = displayedSymmetryIndex(instance?.ps);
    const local = displayedSymmetryIndex(instance?.ls);

    if (axial !== null) labels.push(`AS=${axial}`);
    if (periodic !== null) labels.push(`PS=${periodic}`);
    if (local !== null) labels.push(`LS=${local}`);
    if (Number(instance?.mirrorX) > 0) labels.push("EX");
    if (Number(instance?.mirrorY) > 0) labels.push("EY");

    return labels.length > 0 ? `[${labels.join(" ")}]` : "";
}

function sourceIdentity(source) {
    const prefix = `${sourceLabel(source)} №${oneBasedIndex(source?.recordIndex)}`;
    const name = sourceName(source);
    return name ? `${prefix} — ${name}` : prefix;
}

function trimExponential(value) {
    const [rawMantissa, rawExponent] = value.toLowerCase().split("e");
    const mantissa = rawMantissa
        .replace(/(\.\d*?[1-9])0+$/u, "$1")
        .replace(/\.0+$/u, "");
    const exponent = rawExponent.replace(/^([+-])0+(\d)/u, "$1$2");
    return `${mantissa}e${exponent}`;
}

function formatCoordinate(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "—";
    if (value === 0) return "0";

    const absolute = Math.abs(value);
    if (
        absolute >= EXPONENTIAL_UPPER_BOUND
        || absolute < EXPONENTIAL_LOWER_BOUND
    ) {
        return trimExponential(
            value.toExponential(COORDINATE_SIGNIFICANT_DIGITS - 1),
        );
    }

    return String(Number(value.toPrecision(COORDINATE_SIGNIFICANT_DIGITS)));
}

function formatCoordinates(coordinates) {
    return COORDINATE_NAMES.map(
        (name, index) => `${name}=${formatCoordinate(coordinates?.[index])}`,
    ).join("; ");
}

function tooltipDetails(instance, coordinates) {
    const symmetry = formatSymmetryInstance(instance);
    const coordinateText = coordinates == null
        ? ""
        : formatCoordinates(coordinates);
    return [symmetry, coordinateText].filter(Boolean).join(" ");
}

function tooltipText(title, instance, coordinates) {
    const details = tooltipDetails(instance, coordinates);
    return details ? `${title}\n${details}` : title;
}

/**
 * Formats the tooltip for a scene primitive source.
 * `source.recordIndex` follows the zero-based BaseModel convention.
 */
export function formatGeometryTooltip(source, instance, coordinates) {
    return tooltipText(sourceIdentity(source), instance, coordinates);
}

/**
 * Formats the tooltip for a vertex. Both record and vertex indices are
 * zero-based; coordinates can be an Array or any indexable typed array.
 */
export function formatVertexTooltip(
    source,
    vertexIndex,
    coordinates,
    instance,
) {
    const prefix = sourceIdentity(source);
    const vertex = oneBasedIndex(vertexIndex);
    return tooltipText(
        `${prefix}, вершина №${vertex}`,
        instance,
        coordinates,
    );
}

function positiveSafeInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
}

function gridCounts(grid, expectedLength) {
    const counts = grid?.counts;
    if (
        !counts
        || typeof counts.length !== "number"
        || counts.length !== expectedLength
    ) {
        return null;
    }

    const normalized = Array.from(counts);
    return normalized.every(positiveSafeInteger) ? normalized : null;
}

function gridPointMetadata(grid, pointIndex, sourcePointCount) {
    if (!Number.isSafeInteger(pointIndex) || pointIndex < 0) return null;

    if (grid?.kind === "element-cells") {
        const counts = gridCounts(grid, 3);
        if (!counts) return null;
        const [d1Count, d2Count, d3Count] = counts;
        const expectedCount = d1Count * d2Count * d3Count;
        if (
            !Number.isSafeInteger(expectedCount)
            || sourcePointCount !== expectedCount
            || pointIndex >= expectedCount
        ) {
            return null;
        }

        const d3Index = pointIndex % d3Count;
        const d12Index = Math.floor(pointIndex / d3Count);
        return {
            gridKind: grid.kind,
            d1Index: Math.floor(d12Index / d2Count),
            d2Index: d12Index % d2Count,
            d3Index,
        };
    }

    if (grid?.kind === "region-grid") {
        const counts = gridCounts(grid, 2);
        if (!counts) return null;
        const [d1Count, d2Count] = counts;
        const expectedCount = d1Count * d2Count;
        if (
            !Number.isSafeInteger(expectedCount)
            || sourcePointCount !== expectedCount
            || pointIndex >= expectedCount
        ) {
            return null;
        }

        return {
            gridKind: grid.kind,
            d1Index: Math.floor(pointIndex / d2Count),
            d2Index: pointIndex % d2Count,
        };
    }

    if (grid?.kind === "region-line") {
        const counts = gridCounts(grid, 2);
        if (!counts) return null;
        const [collapsedD1Count, d2Count] = counts;
        if (sourcePointCount !== d2Count || pointIndex >= d2Count) return null;

        return {
            gridKind: grid.kind,
            d2Index: pointIndex,
            collapsedD1Count,
        };
    }

    return null;
}

/**
 * Resolves a point from a combined position buffer. Element points use
 * D1/D2/D3 order with D3 changing fastest. Region points use D1/D2 order
 * with D2 changing fastest. A line region stores only the unique D2 points
 * and reports how many coincident D1 positions were collapsed.
 */
export function pointHitMetadata(range, globalIndex) {
    if (
        !range
        || !Number.isSafeInteger(globalIndex)
        || globalIndex < range.start
        || globalIndex >= range.end
        || !positiveSafeInteger(range.sourcePointCount)
        || !Array.isArray(range.instances)
    ) {
        return null;
    }

    const localIndex = globalIndex - range.start;
    const instanceIndex = Math.floor(localIndex / range.sourcePointCount);
    const instance = range.instances[instanceIndex];
    if (!instance) return null;

    const pointIndex = localIndex % range.sourcePointCount;
    const gridMetadata = gridPointMetadata(
        range.grid,
        pointIndex,
        range.sourcePointCount,
    );
    if (!gridMetadata) return null;

    return { instance, pointIndex, ...gridMetadata };
}

function formatGridIndices(metadata) {
    if (metadata?.gridKind === "element-cells") {
        return `D1=${oneBasedIndex(metadata.d1Index)}; `
            + `D2=${oneBasedIndex(metadata.d2Index)}; `
            + `D3=${oneBasedIndex(metadata.d3Index)}`;
    }

    if (metadata?.gridKind === "region-grid") {
        return `D1=${oneBasedIndex(metadata.d1Index)}; `
            + `D2=${oneBasedIndex(metadata.d2Index)}`;
    }

    if (metadata?.gridKind === "region-line") {
        const collapsedD1Count = metadata.collapsedD1Count;
        const d1 = positiveSafeInteger(collapsedD1Count)
            ? (collapsedD1Count === 1 ? "1" : `1…${collapsedD1Count}`)
            : "?";
        return `D1=${d1}; D2=${oneBasedIndex(metadata.d2Index)}`;
    }

    return "";
}

/**
 * Formats an element elementary-volume center or a region discretization
 * node. Coordinates are expected to be precomputed in Float64 precision.
 */
export function formatDiscretizationPointTooltip(source, metadata, coordinates) {
    const prefix = sourceIdentity(source);
    const pointLabel = source?.schemaId === "elements" ? "центр ЭО" : "узел";
    const gridIndices = formatGridIndices(metadata);
    const title = `${prefix}, ${pointLabel}`
        + (gridIndices ? ` (${gridIndices})` : "");
    return tooltipText(title, metadata?.instance, coordinates);
}

export function geometryHitInstance(hit) {
    const pick = hit?.object?.userData?.pick;
    const instances = pick?.instances;
    const span = pick?.span;
    if (!Array.isArray(instances) || !Number.isSafeInteger(span) || span <= 0) {
        return null;
    }

    const hitIndex = pick.kind === "mesh" ? hit?.faceIndex : hit?.index;
    if (!Number.isSafeInteger(hitIndex) || hitIndex < 0) return null;

    return instances[Math.floor(hitIndex / span)] ?? null;
}

export function vertexHitMetadata(range, globalIndex) {
    if (
        !range ||
        !Number.isSafeInteger(globalIndex) ||
        globalIndex < range.start ||
        globalIndex >= range.end ||
        !Number.isSafeInteger(range.sourceVertexCount) ||
        range.sourceVertexCount <= 0 ||
        !Array.isArray(range.instances)
    ) {
        return null;
    }

    const localIndex = globalIndex - range.start;
    const instanceIndex = Math.floor(localIndex / range.sourceVertexCount);
    const instance = range.instances[instanceIndex];
    if (!instance) return null;

    return {
        instance,
        vertexIndex: localIndex % range.sourceVertexCount,
    };
}

/**
 * Finds a metadata range containing `globalIndex` in a sorted range list.
 * Ranges use a half-open interval: `{ start, end, ...metadata }` means
 * `start <= globalIndex < end`.
 */
export function findVertexMetadataRange(ranges, globalIndex) {
    if (
        !Array.isArray(ranges)
        || !Number.isSafeInteger(globalIndex)
        || globalIndex < 0
    ) {
        return null;
    }

    let lower = 0;
    let upper = ranges.length - 1;

    while (lower <= upper) {
        const middle = lower + Math.floor((upper - lower) / 2);
        const range = ranges[middle];
        const start = range?.start;
        const end = range?.end;

        if (
            !Number.isSafeInteger(start)
            || !Number.isSafeInteger(end)
            || start < 0
            || end <= start
        ) {
            return null;
        }

        if (globalIndex < start) {
            upper = middle - 1;
        } else if (globalIndex >= end) {
            lower = middle + 1;
        } else {
            return range;
        }
    }

    return null;
}

// Both vertex and discretization point buffers use the same half-open range
// lookup contract. Keep the existing export and provide a semantically named
// entry point for point buffers.
export const findPointMetadataRange = findVertexMetadataRange;
