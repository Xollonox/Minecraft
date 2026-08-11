// Water fragment shader.
//
// Deliberately no real-time reflections: a stable Fresnel blend towards the sky
// colour plus a specular highlight reads convincingly at voxel scale and costs a
// handful of instructions, whereas a planar reflection pass doubles the scene
// draw count and breaks the moment the camera goes under the surface.
//
// The "reflective" quality level strengthens the Fresnel term and the highlight
// rather than adding a second render pass.

// Note on includes: Three's own fragment prefix already contains
// `colorspace_pars_fragment` and, whenever tone mapping is active,
// `tonemapping_pars_fragment`. Including either of them here would redefine their
// functions and fail to compile. Only the *call-site* chunks
// (`<tonemapping_fragment>` and `<colorspace_fragment>`) belong in the body.

#include <common>

uniform sampler2D uAtlas;
uniform float uTime;
uniform float uOpacity;
uniform float uReflectivity;

uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
uniform vec3 uHorizonColor;
uniform vec3 uWaterTint;
uniform float uCaveAmbient;

uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFogStrength;
uniform float uBrightness;

// `cameraPosition` is provided automatically by Three's shader prefix.
uniform float uUvScroll;

// Water tile bounds in the atlas, as `[u0, v0, u1, v1]`, plus the two guard
// values from `AtlasLayout`: `.x` is the tile's visual period (a copy of the
// tile repeats every `.x` UV because the padding is a wrapped copy of it) and
// `.y` is how far a sample may leave the content rect and still hit that
// padding.
//
// These exist because the animated scroll below used to be added to `vUv`
// unbounded. The atlas has 64 cells but only ~42 painted tiles, so a drifting
// sample eventually reached an unpainted cell — which is filled with the
// "missing tile" colour — and `ClampToEdgeWrapping` then pinned it there. That
// is what turned water pink after a few seconds of play.
uniform vec4 uWaterTileRect;
uniform vec2 uWaterUvGuard;

varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPosition;
varying float vSkyLight;
varying float vViewDepth;
varying float vSurface;

void main() {
  // Scroll the tile diagonally, then fold the offset back into a single tile
  // period. The padding around each cell is a wrapped copy of the tile, so an
  // offset of exactly one period is visually identical to no offset at all:
  // folding is therefore invisible, keeps mip and anisotropic taps landing on
  // matching texels, and bounds the offset to +/- half a period.
  float period = uWaterUvGuard.x;
  vec2 offset = vec2(uUvScroll * 0.35, uUvScroll * 0.21);
  offset = mod(offset + 0.5 * period, period) - 0.5 * period;
  vec2 scrolled = vUv + offset;

  // Belt and braces: even with a stale uniform or float drift, never sample
  // outside this tile's padded cell. Escaping the cell is what produced the
  // magenta water bug, so the guarantee is enforced here rather than assumed.
  scrolled = clamp(
    scrolled,
    uWaterTileRect.xy - uWaterUvGuard.y,
    uWaterTileRect.zw + uWaterUvGuard.y
  );
  vec4 texel = texture2D(uAtlas, scrolled);

  vec3 normal = normalize(vWorldNormal);
  vec3 viewDirection = normalize(cameraPosition - vWorldPosition);

  float sky = vSkyLight * vSkyLight * 0.4 + vSkyLight * 0.6;

  // Diffuse-ish base.
  float ndotl = max(dot(normal, uSunDirection), 0.0);
  vec3 base = texel.rgb * uWaterTint;
  vec3 lighting = uSkyAmbient * sky + uSunColor * (ndotl * sky * 0.6) + vec3(uCaveAmbient);
  vec3 color = base * lighting;

  // Fresnel: a glancing view picks up more of the sky.
  float fresnel = pow(1.0 - clamp(dot(normal, viewDirection), 0.0, 1.0), 4.0);
  fresnel *= uReflectivity * vSurface;
  color = mix(color, mix(uHorizonColor, uSkyAmbient, 0.5) * max(sky, 0.15), fresnel);

  // Specular glint from the sun, only on the moving surface.
  vec3 halfVector = normalize(uSunDirection + viewDirection);
  float specular = pow(max(dot(normal, halfVector), 0.0), 96.0);
  color += uSunColor * specular * uReflectivity * vSurface * sky;

  // Two moving interference fields form fine caustic bands. They are strongest
  // on vertical faces and in shallow-looking bright water, adding depth without
  // a second scene render.
  float causticA = sin(vWorldPosition.x * 2.7 + uTime * 1.8)
                 * sin(vWorldPosition.z * 2.3 - uTime * 1.35);
  float causticB = sin((vWorldPosition.x + vWorldPosition.z) * 1.65 - uTime * 1.1);
  float caustics = pow(clamp(causticA * 0.5 + causticB * 0.25 + 0.5, 0.0, 1.0), 4.0);
  color += vec3(0.16, 0.34, 0.31) * caustics * uReflectivity * (0.25 + 0.75 * (1.0 - vSurface));

  // Fine whitecaps on animated crests. Keeping the threshold high prevents a
  // lake from reading as uniformly soapy while still giving High/Ultra water a
  // visibly richer silhouette in motion.
  float crest = sin(vWorldPosition.x * 1.8 + uTime * 2.1)
              + sin(vWorldPosition.z * 2.05 - uTime * 1.7);
  float foam = smoothstep(1.62, 1.94, crest) * vSurface * uReflectivity;
  color = mix(color, vec3(0.82, 0.94, 0.96) * max(sky, 0.3), foam * 0.38);

  color *= uBrightness;

  float fog = smoothstep(uFogNear, uFogFar, vViewDepth) * uFogStrength;
  color = mix(color, uFogColor, fog);

  // Alpha rises slightly at glancing angles, which is what makes a lake read as
  // deep in the distance and shallow at your feet.
  float alpha = mix(uOpacity, min(1.0, uOpacity + 0.18), fresnel);

  gl_FragColor = vec4(color, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
