export const GEOMETRY_MATERIAL_KINDS = Object.freeze({
    FMM_INSULATING: "fmm-insulating",
    FMM_CONDUCTIVE: "fmm-conductive",
    NONMAGNETIC_CONDUCTIVE: "nonmagnetic-conductive",
    HTSC_MAGNETIC: "htsc-magnetic",
    HTSC_CURRENT: "htsc-current",
    HTSC_BOTH: "htsc-both",
    PRESCRIBED_MAGNETIZATION: "prescribed-magnetization",
    PRESCRIBED_CURRENT: "prescribed-current",
    VIRTUAL: "virtual",
    NEUTRAL: "neutral",
});

const KINDS = new Set(Object.values(GEOMETRY_MATERIAL_KINDS));

// `copy` is the canonical category color. The original geometry is slightly
// darker so it remains distinguishable without assigning symmetry images a
// separate hue. Black/white edges maximize contrast with the actual fill.
// The palette's edge entry describes copies; original edges are resolved below.
export const GEOMETRY_MATERIAL_PALETTE = Object.freeze({
    [GEOMETRY_MATERIAL_KINDS.FMM_INSULATING]: Object.freeze({
        copy: 0x4b78e6,
        original: 0x3b60b8,
        edge: 0x000000,
    }),
    [GEOMETRY_MATERIAL_KINDS.FMM_CONDUCTIVE]: Object.freeze({
        copy: 0x3aad68,
        original: 0x2e8a53,
        edge: 0x000000,
    }),
    [GEOMETRY_MATERIAL_KINDS.NONMAGNETIC_CONDUCTIVE]: Object.freeze({
        copy: 0xdf5555,
        original: 0xb94444,
        edge: 0x000000,
    }),
    [GEOMETRY_MATERIAL_KINDS.HTSC_MAGNETIC]: Object.freeze({
        copy: 0x9b63df,
        original: 0x7d4fb5,
        edge: 0x000000,
    }),
    [GEOMETRY_MATERIAL_KINDS.HTSC_CURRENT]: Object.freeze({
        copy: 0xd5c5ff,
        original: 0xb2a2df,
        edge: 0x000000,
    }),
    [GEOMETRY_MATERIAL_KINDS.HTSC_BOTH]: Object.freeze({
        copy: 0x59616b,
        original: 0x424950,
        edge: 0xffffff,
    }),
    [GEOMETRY_MATERIAL_KINDS.PRESCRIBED_MAGNETIZATION]: Object.freeze({
        copy: 0x92dcf8,
        original: 0x70bad6,
        edge: 0x000000,
    }),
    [GEOMETRY_MATERIAL_KINDS.PRESCRIBED_CURRENT]: Object.freeze({
        copy: 0xffb2b2,
        original: 0xda9292,
        edge: 0x000000,
    }),
    [GEOMETRY_MATERIAL_KINDS.VIRTUAL]: Object.freeze({
        copy: 0xffffff,
        original: 0xd8d8d8,
        edge: 0x000000,
    }),
    [GEOMETRY_MATERIAL_KINDS.NEUTRAL]: Object.freeze({
        copy: 0x929da9,
        original: 0x747e89,
        edge: 0x000000,
    }),
});

function normalizedKind(kind) {
    return KINDS.has(kind) ? kind : GEOMETRY_MATERIAL_KINDS.NEUTRAL;
}

function enabled(value, fallback = true) {
    if (value === undefined || value === null) return fallback;
    return value === true || value === 1;
}

/**
 * Classifies one element record without mutating the BaseModel.
 *
 * `targ` has precedence over the material model because prescribed sources
 * and virtual volumes do not use the ordinary FMM/HTSC material semantics.
 */
export function classifyGeometryMaterial(record = {}, general = {}) {
    const targ = Number(record?.targ);

    if (targ === 3) return GEOMETRY_MATERIAL_KINDS.VIRTUAL;
    if (targ === 2) return GEOMETRY_MATERIAL_KINDS.PRESCRIBED_CURRENT;
    if (targ === 1) {
        return GEOMETRY_MATERIAL_KINDS.PRESCRIBED_MAGNETIZATION;
    }

    if (Number(record?.model) === 2) {
        // Canonical keys take precedence by presence, including explicit false.
        const magnetic = enabled(Object.hasOwn(general ?? {}, "htsMu") ? general.htsMu : general?.htcMu);
        const current = enabled(Object.hasOwn(general ?? {}, "htsRo") ? general.htsRo : general?.htcRo);

        if (magnetic && current) return GEOMETRY_MATERIAL_KINDS.HTSC_BOTH;
        if (magnetic) return GEOMETRY_MATERIAL_KINDS.HTSC_MAGNETIC;
        if (current) return GEOMETRY_MATERIAL_KINDS.HTSC_CURRENT;
        return GEOMETRY_MATERIAL_KINDS.NEUTRAL;
    }

    // model=1 has no separate requested viewer color; keeping it in this
    // total xapName/rv branch does not imply solver support for that model.
    const hasMaterial = String(record?.xapName ?? "").trim().length > 0;
    const conductive = Number(record?.rv) > 0;

    if (hasMaterial && conductive) {
        return GEOMETRY_MATERIAL_KINDS.FMM_CONDUCTIVE;
    }
    if (hasMaterial) return GEOMETRY_MATERIAL_KINDS.FMM_INSULATING;
    if (conductive) {
        return GEOMETRY_MATERIAL_KINDS.NONMAGNETIC_CONDUCTIVE;
    }
    return GEOMETRY_MATERIAL_KINDS.NEUTRAL;
}

export function geometryMaterialColor(kind, original = false) {
    const palette = GEOMETRY_MATERIAL_PALETTE[normalizedKind(kind)];
    return original ? palette.original : palette.copy;
}

export function contrastingGeometryEdgeColor(color) {
    const linear = (shift) => {
        const channel = ((color >> shift) & 0xff) / 255;
        return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
    };
    const luminance = 0.2126 * linear(16) + 0.7152 * linear(8) + 0.0722 * linear(0);
    const blackContrast = (luminance + 0.05) / 0.05;
    const whiteContrast = 1.05 / (luminance + 0.05);
    return whiteContrast > blackContrast ? 0xffffff : 0x000000;
}

export function geometryMaterialEdgeColor(kind, original = false) {
    return contrastingGeometryEdgeColor(geometryMaterialColor(kind, original));
}

export function geometryMaterialStyle(kind, original = false) {
    return {
        color: geometryMaterialColor(kind, original),
        edgeColor: geometryMaterialEdgeColor(kind, original),
    };
}
