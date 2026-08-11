// Water vertex shader.
//
// The mesher already drops an open water surface to 0.875 of a block, so this
// only adds the motion: two crossing sine waves displace the *top* vertices
// only. Side vertices at the bottom of a block must stay put or the water would
// visibly separate from the lake bed.
//
// The wave phase is derived from the world position, so adjacent chunks stay in
// phase and there is no seam down a chunk border.

attribute vec4 alight;

uniform float uTime;
uniform float uWaveHeight;
uniform float uWaveSpeed;

varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPosition;
varying float vSkyLight;
varying float vViewDepth;
varying float vSurface;

void main() {
  vUv = uv;
  vSkyLight = alight.y;

  vec3 localPosition = position;
  vec3 worldBase = (modelMatrix * vec4(position, 1.0)).xyz;

  // Only the upper edge of a water quad moves. `fract` of the block-local height
  // is ~0.875 on a surface vertex and 0 on a bottom vertex.
  float heightInBlock = fract(worldBase.y);
  vSurface = step(0.4, heightInBlock);

  vec3 waveNormal = vec3(0.0, 1.0, 0.0);
  if (vSurface > 0.5 && uWaveHeight > 0.0) {
    float phase = uTime * uWaveSpeed;
    float waveA = sin(worldBase.x * 0.9 + phase * 1.6);
    float waveB = sin(worldBase.z * 1.13 - phase * 1.27);
    float waveC = sin((worldBase.x + worldBase.z) * 0.47 + phase * 0.9);
    localPosition.y += (waveA + waveB + waveC * 0.6) * uWaveHeight;

    // Analytic derivative of the same sum, so the shading matches the motion.
    float slopeX = cos(worldBase.x * 0.9 + phase * 1.6) * 0.9
                 + cos((worldBase.x + worldBase.z) * 0.47 + phase * 0.9) * 0.47 * 0.6;
    float slopeZ = cos(worldBase.z * 1.13 - phase * 1.27) * 1.13
                 + cos((worldBase.x + worldBase.z) * 0.47 + phase * 0.9) * 0.47 * 0.6;
    waveNormal = normalize(vec3(-slopeX * uWaveHeight * 6.0, 1.0, -slopeZ * uWaveHeight * 6.0));
  }

  vec4 worldPosition = modelMatrix * vec4(localPosition, 1.0);
  vWorldPosition = worldPosition.xyz;

  vec3 geometryNormal = normalize(mat3(modelMatrix) * normal);
  // Side faces keep their own normal; the surface uses the wave normal.
  vWorldNormal = geometryNormal.y > 0.5 ? waveNormal : geometryNormal;

  vec4 viewPosition = viewMatrix * worldPosition;
  vViewDepth = -viewPosition.z;
  gl_Position = projectionMatrix * viewPosition;
}
