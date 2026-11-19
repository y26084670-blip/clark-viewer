// Keep the scene's lights unchanged: maps, geometry and vector layers share
// the same renderer. Only graph surfaces need stronger shape shading.
export const GRAPH_LIGHTING = Object.freeze({ ambient: 0.24, directional: 2.6 });

export function createGraphSurfaceMaterial(THREE, parameters) {
  const material = new THREE.MeshStandardMaterial(parameters);
  material.onBeforeCompile = shader => {
    const marker = "#include <lights_fragment_end>";
    // Retain Three.js' ordinary lighting if a future shader no longer exposes
    // this chunk. The currently pinned shader is verified in Node and WebGL.
    if (!shader.fragmentShader.includes(marker)) return;
    shader.uniforms.graphAmbientWeight = { value: GRAPH_LIGHTING.ambient };
    shader.uniforms.graphDirectionalWeight = { value: GRAPH_LIGHTING.directional };
    shader.fragmentShader = "uniform float graphAmbientWeight;\nuniform float graphDirectionalWeight;\n"
      + shader.fragmentShader.replace(marker, `${marker}
reflectedLight.indirectDiffuse *= graphAmbientWeight;
reflectedLight.directDiffuse *= graphDirectionalWeight;`);
  };
  material.customProgramCacheKey = () => "result-graph-shape-lighting-v1";
  return material;
}
