import assert from "node:assert/strict";
import test from "node:test";
import { loadTaskInput } from "../src/services/taskLoadService.js";
import { buildGeometryScene } from "../src/services/visualization/geometrySceneModel.js";
import { buildGeometryTimeModel } from "../src/services/visualization/geometryTimeModel.js";

const missing = () => Object.assign(new Error("Missing"), { name: "NotFoundError" });
function fixture() {
    const files = new Map([
        ["general.txt", JSON.stringify({ countTimeSteps: 1, timeStep: 1 })],
        ["kvs.txt", JSON.stringify({ geoType: 2, geo: [4, 2, 3, ...Array(21).fill(0)],
            dr: [0, 0, 0], dp: [2, 2, 3], sym: {} })],
    ]);
    let marker = false;
    const input = { async getFileHandle(name, options) {
        assert.notEqual(options?.create, true);
        if (name === "_2d.e3d") {
            if (!marker) throw missing();
            if (marker instanceof Error) throw marker;
            return { getFile() { throw new Error("marker contents must never be read"); } };
        }
        if (!files.has(name)) throw missing();
        return { async getFile() { return { text: async () => files.get(name) }; } };
    } };
    return { setMarker: value => { marker = value; }, task: {
        async getDirectoryHandle(name) { assert.equal(name, "input3XX"); return input; },
    } };
}

test("Viewer reads only marker presence for 2D and refreshes it on each input load", async () => {
    const f = fixture();
    let model = await loadTaskInput(f.task);
    assert.equal(model.planar2D, false); assert.equal(buildGeometryScene(model).planar2D, false);
    f.setMarker(true);
    model = await loadTaskInput(f.task);
    assert.equal(model.planar2D, true); assert.equal(buildGeometryScene(model).planar2D, true);
    // Geometry and time transforms cannot independently reclassify the saved marker.
    model.elements[0].indMove = 1;
    const moved = buildGeometryTimeModel(model, [{angle: [[0, 0, 0, 0]], position: [[0, 7, 0, 0]]}], 0);
    assert.equal(buildGeometryScene(moved.model).planar2D, true);
    f.setMarker(false);
    assert.equal(buildGeometryScene(await loadTaskInput(f.task)).planar2D, false);
});

test("an inaccessible marker never asserts 2D or prevents viewing readable task input", async () => {
    const f = fixture();
    for (const name of ["NotAllowedError", "TypeMismatchError"]) {
        f.setMarker(Object.assign(new Error(name), { name }));
        assert.equal((await loadTaskInput(f.task)).planar2D, false);
    }
});
