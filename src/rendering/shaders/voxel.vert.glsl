// Voxel terrain vertex shader.
//
// Inputs beyond the usual position/normal/uv:
//
//   alight  vec4, normalised. Packed by the chunk mesher as
//           x = ambient occlusion * per-face flat shade
//           y = sky light      (0..1, already attenuated down the column)
//           z = block light    (0..1, strongest emitter touching the vertex)
//           w = sway class     (multiply by 255: 0 none, 1 leaves, 2 grass)
//
// Vertex animation is applied to the *local* position before the world matrix so
// that the shadow coordinates computed below match the displaced geometry —
// otherwise waving leaves would cast static shadows.

#include <common>
#include <shadowmap_pars_vertex>

attribute vec4 alight;

uniform float uTime;
uniform float uLeafSway;
uniform float uGrassSway;

varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPosition;
varying float vAmbientOcclusion;
varying float vSkyLight;
varying float vBlockLight;
varying float vViewDepth;

void main() {
  vUv = uv;
  vAmbientOcclusion = alight.x;
  vSkyLight = alight.y;
  vBlockLight = alight.z;

  // Three's shadow chunks expect these exact names in scope.
  vec3 objectNormal = normal;
  vec3 transformedNormal = normalMatrix * objectNormal;

  vec3 localPosition = position;

  float swayClass = alight.w * 255.0;
  if (swayClass > 0.5) {
    // Phase from the *undisplaced* world position so neighbouring chunks agree
    // and the motion is continuous across chunk borders.
    vec3 basePosition = (modelMatrix * vec4(position, 1.0)).xyz;
    float strength = swayClass > 1.5 ? uGrassSway : uLeafSway;

    if (strength > 0.0) {
      float phase = basePosition.x * 0.62 + basePosition.z * 0.55 + uTime * 1.6;
      // Grass is anchored at the ground, so displacement scales with height
      // inside the block. Leaves move as a whole.
      float anchor = swayClass > 1.5 ? clamp(fract(basePosition.y), 0.0, 1.0) : 1.0;
      float amount = strength * anchor;
      localPosition.x += sin(phase) * amount;
      localPosition.z += cos(phase * 0.83 + 1.7) * amount;
      localPosition.y += sin(phase * 1.31) * amount * 0.3;
    }
  }

  vec4 worldPosition = modelMatrix * vec4(localPosition, 1.0);
  vWorldPosition = worldPosition.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);

  #include <shadowmap_vertex>

  vec4 viewPosition = viewMatrix * worldPosition;
  vViewDepth = -viewPosition.z;
  gl_Position = projectionMatrix * viewPosition;
}
