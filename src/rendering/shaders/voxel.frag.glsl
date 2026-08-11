// Voxel terrain fragment shader.
//
// Lighting is computed here rather than delegated to Three's light loop, because
// voxel lighting is not a generic scene-lighting problem: the sun contribution
// has to be gated by the baked sky-light value so that a cave stays dark even
// though the sun is technically above it. Three's `directDiffuse` accumulation
// has no notion of that.
//
//   final = texel * (skyAmbient + sun * NdotL * shadow) * skyLight
//         + texel * (blockLight + pointLights)
//         + texel * caveAmbient
//   all scaled by baked ambient occlusion, then fogged.
//
// Shadows are read through Three's own shadow chunks so a real directional
// shadow map works, and the whole block compiles out when shadows are disabled
// (no shadow-casting light in the scene means `USE_SHADOWMAP` is undefined).

// Note on includes: Three's own fragment prefix already contains
// `colorspace_pars_fragment` and, whenever tone mapping is active,
// `tonemapping_pars_fragment`. Including either of them here would redefine their
// functions and fail to compile. Only the *call-site* chunks
// (`<tonemapping_fragment>` and `<colorspace_fragment>`) belong in the body.

#include <common>
#include <packing>
#include <shadowmap_pars_fragment>

uniform sampler2D uAtlas;
uniform float uAlphaTest;
uniform float uOpacity;

uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
uniform vec3 uGroundAmbient;
uniform float uCaveAmbient;
uniform float uBlockLightBoost;
uniform vec3 uBlockLightColor;

uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFogStrength;

uniform float uBrightness;
uniform float uSaturation;

uniform int uPointLightCount;
uniform vec4 uPointLights[MAX_POINT_LIGHTS];
uniform vec3 uPointLightColor;

varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPosition;
varying float vAmbientOcclusion;
varying float vSkyLight;
varying float vBlockLight;
varying float vViewDepth;

void main() {
  vec4 texel = texture2D(uAtlas, vUv);

  // Cutout layers discard rather than blend, so foliage keeps crisp edges and
  // still writes depth correctly.
  if (texel.a < uAlphaTest) discard;

  vec3 normal = normalize(vWorldNormal);

  // ---- sun -----------------------------------------------------------------
  float ndotl = max(dot(normal, uSunDirection), 0.0);

  float shadowFactor = 1.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    DirectionalLightShadow shadowData = directionalLightShadows[ 0 ];
    shadowFactor = getShadow(
      directionalShadowMap[ 0 ],
      shadowData.shadowMapSize,
      shadowData.shadowIntensity,
      shadowData.shadowBias,
      shadowData.shadowRadius,
      vDirectionalShadowCoord[ 0 ]
    );
  #endif

  // ---- ambient -------------------------------------------------------------
  // A cheap hemisphere: sky colour from above, bounced ground colour from below.
  float hemisphere = normal.y * 0.5 + 0.5;
  vec3 ambient = mix(uGroundAmbient, uSkyAmbient, hemisphere);

  // Sky light gates both ambient and direct sun. Squaring it slightly deepens
  // the falloff into overhangs and cave mouths.
  float sky = vSkyLight * vSkyLight * 0.35 + vSkyLight * 0.65;

  vec3 lighting = ambient * sky + uSunColor * (ndotl * shadowFactor * sky);

  // ---- emissive blocks -----------------------------------------------------
  lighting += uBlockLightColor * (vBlockLight * uBlockLightBoost);

  // ---- nearby emissive blocks as point lights ------------------------------
  // A small, sorted set of the closest emitters; enough to make a torch-lit
  // corridor read correctly without a full light propagation pass.
  for (int i = 0; i < MAX_POINT_LIGHTS; i++) {
    if (i >= uPointLightCount) break;
    vec4 light = uPointLights[i];
    vec3 toLight = light.xyz - vWorldPosition;
    float distance = length(toLight);
    float attenuation = clamp(1.0 - distance * light.w, 0.0, 1.0);
    if (attenuation <= 0.0) continue;
    attenuation *= attenuation;
    float facing = max(dot(normal, toLight / max(distance, 0.0001)), 0.0) * 0.75 + 0.25;
    lighting += uPointLightColor * (attenuation * facing);
  }

  // ---- cave floor ----------------------------------------------------------
  // Without a small floor an unlit cave is pure black and unnavigable.
  lighting += vec3(uCaveAmbient);

  // Baked occlusion multiplies everything, including torch light, which is what
  // makes corners read as corners.
  lighting *= vAmbientOcclusion;

  // ---- sun specular + sky rim ----------------------------------------------
  // A tight, faint sun gloss keeps wet-looking materials (leaves, ice, water
  // edges) alive at noon, and a sky-tinted Fresnel rim lifts silhouettes at
  // grazing angles. Both are gated by sky light and shadow so caves stay flat.
  vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
  vec3 sunHalfVector = normalize(uSunDirection + viewDirection);
  float sunSpecular = pow(max(dot(normal, sunHalfVector), 0.0), 40.0);
  lighting += uSunColor * (sunSpecular * 0.16 * ndotl * shadowFactor * sky);
  float skyRim = pow(1.0 - max(dot(normal, viewDirection), 0.0), 4.0);
  lighting += uSkyAmbient * (skyRim * 0.18 * sky);

  vec3 color = texel.rgb * lighting * uBrightness;

  // ---- grade ---------------------------------------------------------------
  float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luminance), color, uSaturation);

  // ---- fog ----------------------------------------------------------------
  // Linear in distance but eased, which keeps nearby geometry crisp while the
  // render-distance boundary disappears smoothly instead of popping.
  float fog = smoothstep(uFogNear, uFogFar, vViewDepth) * uFogStrength;
  color = mix(color, uFogColor, fog);

  // Screen-space dither hides the 8-bit banding that shows up in dusk skies
  // and long fog gradients. One texel of noise, invisible up close.
  float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  color += vec3((dither - 0.5) * (1.5 / 255.0));

  gl_FragColor = vec4(color, texel.a * uOpacity);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
