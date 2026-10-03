import assert from "node:assert/strict";
import test from "node:test";
import { OBJECT_VISIBILITY_MODES, instanceVisible, primitiveVisible }
    from "../src/services/visualization/geometryRenderFilters.js";
import { readObjectFrames, resultDisplaySelection }
    from "../src/services/results/resultRequests.js";
import { readResultVolumeFrame } from "../src/services/results/resultVolumeRequests.js";
import { createResultFrameController } from "../src/services/results/resultFrameController.js";
import { sourcesFields3DSetup } from "../scripts/test-support/sourcesFields3DSetup.js";

function primitive(schemaId, recordIndex) {
    return { source: { schemaId, recordIndex } };
}

test("except-selected mode complements each category using original record indices", () => {
    const modes = { elements: OBJECT_VISIBILITY_MODES.EXCEPT_SELECTED,
        regions: OBJECT_VISIBILITY_MODES.SELECTED };
    const selections = { elements: new Set([0, 2]), regions: [0, 1] };
    assert.deepEqual([0, 1, 2, 3].filter(index => primitiveVisible(
        primitive("elements", index), modes, selections)), [1, 3]);
    assert.deepEqual([0, 1, 2, 3].filter(index => primitiveVisible(
        primitive("regions", index), modes, selections)), [0, 1]);
    modes.regions = OBJECT_VISIBILITY_MODES.EXCEPT_SELECTED;
    assert.deepEqual([0, 1, 2, 3].filter(index => primitiveVisible(
        primitive("regions", index), modes, selections)), [2, 3]);
});

test("except-selected with no selection shows all records; selecting all hides all", () => {
    for (const category of ["elements", "regions"]) {
        const modes = { [category]: OBJECT_VISIBILITY_MODES.EXCEPT_SELECTED };
        for (const selection of [[], new Set(), undefined]) {
            assert.equal(primitiveVisible(primitive(category, 0), modes,
                { [category]: selection }), true);
        }
        for (const selection of [[0, 1], new Set([0, 1])]) {
            assert.equal(primitiveVisible(primitive(category, 0), modes,
                { [category]: selection }), false);
            assert.equal(primitiveVisible(primitive(category, 1), modes,
                { [category]: selection }), false);
        }
    }
});

test("except-selected rejects malformed sources and combines with symmetry filtering", () => {
    const modes = { elements: OBJECT_VISIBILITY_MODES.EXCEPT_SELECTED };
    for (const index of [-1, 0.5, NaN, Infinity, "0", undefined]) {
        assert.equal(primitiveVisible({ source: { schemaId: "elements", recordIndex: index } }, modes), false);
    }
    assert.equal(primitiveVisible(primitive("other", 0), modes), false);
    const candidates = [
        { ...primitive("elements", 0), instance: { ls: 0 } },
        { ...primitive("elements", 1), instance: { ls: 0 } },
        { ...primitive("elements", 1), instance: { ls: 1 } },
    ];
    const visible = candidates.filter(item => primitiveVisible(item, modes, { elements: [0] })
        && instanceVisible(item.instance, { local: false }));
    assert.deepEqual(visible, [candidates[1]]);
});

test("3D result selection reads the complement without changing list selection or IDs", () => {
    const records = [{ id: 2 }, { id: 4 }, { id: 8 }], selected = [4, 99];
    assert.deepEqual(resultDisplaySelection(records, selected, "exceptSelected"), [2, 8]);
    assert.deepEqual(selected, [4, 99]);
    assert.deepEqual(resultDisplaySelection(records, [], "exceptSelected"), [2, 4, 8]);
    assert.deepEqual(resultDisplaySelection(records, [2, 4, 8], "exceptSelected"), []);
    for (const mode of ["all", "selected", "none", undefined]) {
        assert.equal(resultDisplaySelection(records, selected, mode), selected);
    }
});

test("3D empty complements publish an empty coherent frame without inspecting HDF5 metadata", async () => {
    let metadataReads = 0;
    const task = { elements: [{ id: 1, targ: 0 }, { id: 2, targ: 0 }], regions: [{ id: 1 }],
        get metadata() { metadataReads++; throw new Error("No results are required"); } };
    for (const settings of [
        { elementsMode: "exceptSelected" },
        { resultElementsQuantity: "none", resultRegionsQuantity: "Bs", regionsMode: "exceptSelected" },
        { elementsMode: "exceptSelected", resultVectorColorMap: true, resultVectorScale: 10 },
    ]) {
        const hook = sourcesFields3DSetup({ task, elements: [1, 2], regions: [1], time: 7 }, settings);
        assert.equal(hook.hasRequestedResults(), false);
        assert.equal(hook.timeIndex(), 7);
        assert.deepEqual(hook.resultLayers(), []);
        let run, state;
        const controller = createResultFrameController({ load: request => hook.load(request),
            publish: next => { state = next; }, schedule: callback => { run = callback; return 1; }, cancel() {},
        });
        controller.request(hook.request());
        await run();
        assert.equal(state.frame.request.time, 7);
        assert.ok(state.frame.value.layers.every(layer => ["disabled", "empty"].includes(layer.state)));
        assert.equal(state.loading, false);
        assert.equal(state.error, "");
        controller.close(); hook.close();
    }
    const ordinary = sourcesFields3DSetup({ task, elements: [1], regions: [], time: 3 }, { elementsMode: "exceptSelected" });
    assert.deepEqual(ordinary.request().layers.find(layer => layer.key === "elements").selected, [2]);
    assert.equal(ordinary.request().time, 3);
    assert.equal(metadataReads, 0);
    ordinary.close();
});

test("ordinary and volume 3D requests load unselected HDF5 records with original source metadata", async () => {
    const elements = [1, 2].map(id => ({ id, recordIndex: id - 1, targ: 0,
        xapName: "steel", dp: [[2], [2], [2]], symLs: 1, symAs: 1, symPs: 1,
        symKya: 0, symKyp: 0 }));
    const reads = [];
    const task = { elements, regions: [], metadata: { MH: { steps: [0],
        header: { numbs: [8, 8], inds1: [1, 9] } } }, reader: { read: async request => {
        reads.push(request);
        assert.equal(request.start, 8);
        assert.equal(request.count, 8);
        const values = [];
        for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) {
            values.push(10 + x, y, z, 1 + x + y + z, 0, 0, 0, 0, 0);
        }
        return { values: new Float64Array(values), stride: 9, count: 8, start: 8, every: 1 };
    } } };
    const selected = resultDisplaySelection(elements, [1], "exceptSelected");
    const request = { task, quantityKey: "M", selected, time: 0 };
    const frames = await readObjectFrames(request);
    assert.deepEqual(frames.map(frame => frame.record.id), [2]);
    const volume = await readResultVolumeFrame(request);
    assert.equal(volume.volumeFields.domains.length, 1);
    assert.equal(volume.volumeFields.domains[0].source.recordIndex, 1);
    assert.equal(volume.scene.vectors.length, 8);
    for (const item of [...volume.scene.vectors, ...volume.volumeFields.domains]) {
        assert.equal(primitiveVisible(item, { elements: "exceptSelected" }, { elements: [0] }), true);
        assert.equal(item.source.recordIndex, 1);
    }
    assert.equal(reads.length, 2);
});
