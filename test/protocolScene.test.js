import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { general, elements, regions } from "./fixtures/protocolScene.js";
import { normalizeTaskInput } from "../src/services/taskLoadService.js";
import { buildProtocolScene, validateProtocolScene } from "../src/services/protocol/protocolSceneData.js";
import { appendProtocolBlocks, newProtocol, parseProtocol, serializeProtocol } from "../src/services/protocol/protocolDocument.js";

const model = () => normalizeTaskInput({ general, elements, regions, moves: [], amps: [], mhj: [] });
const sceneBlock = () => ({ id: "scene", kind: "scene", title: "3D", comment: "", scene: buildProtocolScene(model()),
  poster: { width: 1, height: 1, dataUrl: "data:image/png;base64,iVBORw0KGgo=" } });

test("protocol geometry detaches all local/axial/periodic/mirror images with material colors and source names", () => {
  const input = model(), before = structuredClone(input), scene = buildProtocolScene(input);
  assert.deepEqual(input, before);
  assert.equal(scene.objects.length, 2);
  assert.equal(scene.objects[0].instances.length, 32);
  assert.equal(scene.objects[1].instances.length, 4);
  assert.equal(scene.objects[0].instances.filter(item => item.original).length, 1);
  assert.match(scene.objects[0].label, /ВТСП <полоска>/);
  assert.notEqual(scene.objects[0].color, scene.objects[0].copyColor);
  assert.equal(scene.objects[0].instances[1].matrix[0], -1, "X mirror must remain the innermost image");
  assert.equal(scene.objects[0].instances[2].matrix[5], -1, "Y mirror is the next nested loop");
  input.elements[0].name = "changed"; input.elements[0].geo[0][0] = 999;
  assert.match(scene.objects[0].label, /ВТСП/); assert.equal(scene.objects[0].positions[0], 1);
  assert.deepEqual(validateProtocolScene(scene), scene);
});

test("invalid or partially skipped geometry cannot silently enter a protocol", () => {
  const input = model(); input.elements[0].geoType = 999;
  assert.throws(() => buildProtocolScene(input), /всю геометрию/);
  assert.equal(buildProtocolScene({ elements: [], regions: [] }), null);
  for (const mutate of [
    value => { value.objects[0].positions[0] = Infinity; },
    value => { value.objects[0].indices[0] = 999999; },
    value => { value.objects[0].instances[0].matrix[15] = 0; },
    value => { value.objects[0].color = -1; },
    value => { value.objects[1].id = value.objects[0].id; },
    value => { value.bounds.min[0] = value.bounds.max[0] + 1; },
    value => { value.objects[0].instances = Array(20_001).fill(value.objects[0].instances[0]); },
  ]) {
    const value = buildProtocolScene(model()); mutate(value); assert.throws(() => validateProtocolScene(value));
  }
});

test("scene format 3 preserves geometry/poster, uses the exact bundled script hash and escapes all labels", () => {
  const block = sceneBlock(); block.scene.objects[0].label = '</script><img src=x onerror="window.injected=1">';
  const doc = newProtocol("Task", [block]), html = serializeProtocol(doc);
  assert.equal(doc.version, 3); assert.deepEqual(parseProtocol(html), doc);
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const hash = createHash("sha256").update(script).digest("base64");
  assert.ok(html.includes(`script-src 'sha256-${hash}'`));
  assert.equal(html.includes('img src=x onerror="window.injected=1"'), false);
  assert.match(html, /connect-src|default-src 'none'/);
  assert.match(html, /Three\.js · лицензия MIT/);
  assert.throws(() => serializeProtocol({ ...doc, version: 2 }), /версии 3/);
});

test("old versions remain valid and adding a scene upgrades without losing media or editable identity", () => {
  const old = { ...newProtocol("Task", []), version: 1 };
  assert.deepEqual(parseProtocol(serializeProtocol(old)), old);
  const video = { id: "movie", kind: "video", title: "Movie", comment: "", filename: "a.webm", dataUrl: "data:video/webm;base64,AAAA" };
  const version2 = appendProtocolBlocks(old, [video]);
  const version3 = appendProtocolBlocks(version2, [sceneBlock()]);
  assert.equal(version2.version, 2); assert.equal(version3.version, 3);
  assert.equal(version3.id, old.id); assert.equal(version3.blocks.at(-1).kind, "video");
  assert.deepEqual(parseProtocol(serializeProtocol(version3)), version3);
});
