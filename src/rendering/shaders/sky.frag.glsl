// Procedural sky dome.
//
// Everything is driven by three uniforms that `SkySystem` interpolates over the
// day/night cycle — zenith, horizon and a sun tint — plus the sun and moon
// directions. Building the gradient in the shader rather than from a texture
// means sunrise and sunset are continuous rather than a cross-fade between
// baked images, and it costs nothing per frame to change the time of day.
//
// Stars are hashed directly from the view direction so there is no star texture
// and no geometry: a cheap 3D hash thresholded to leave sparse bright points,
// faded in as the sun sets.

// Note on includes: Three's own fragment prefix already contains
// `colorspace_pars_fragment` and, whenever tone mapping is active,
// `tonemapping_pars_fragment`. Including either of them here would redefine their
// functions and fail to compile. Only the *call-site* chunks
// (`<tonemapping_fragment>` and `<colorspace_fragment>`) belong in the body.

#include <common>

uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform vec3 uGroundColor;
uniform vec3 uSunDirection;
uniform vec3 uMoonDirection;
uniform vec3 uSunColor;
uniform vec3 uSunGlowColor;
uniform float uStarIntensity;
uniform float uStarDensity;
uniform float uHorizonSharpness;
uniform float uBrightness;

varying vec3 vDirection;

/** Cheap 3D value hash in [0,1). */
float hash31(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec3 direction = normalize(vDirection);
  float height = direction.y;

  // ---- gradient ------------------------------------------------------------
  // Two-stage blend: ground haze below the horizon, horizon-to-zenith above.
  float above = clamp(height, 0.0, 1.0);
  float horizonBlend = pow(1.0 - above, uHorizonSharpness);
  vec3 color = mix(uZenithColor, uHorizonColor, horizonBlend);

  float below = clamp(-height * 3.0, 0.0, 1.0);
  color = mix(color, uGroundColor, below);

  // ---- stars ---------------------------------------------------------------
  if (uStarIntensity > 0.001 && height > -0.05) {
    // Quantise the direction into cells and light up a sparse subset.
    vec3 cell = floor(direction * uStarDensity);
    float noise = hash31(cell);
    if (noise > 0.9925) {
      vec3 cellCentre = (cell + 0.5) / uStarDensity;
      float distance = length(direction - normalize(cellCentre));
      float twinkle = 0.65 + 0.35 * sin(noise * 90.0 + uStarIntensity * 12.0);
      float point = smoothstep(0.006, 0.0, distance);
      float fade = smoothstep(-0.05, 0.15, height);
      color += vec3(point * twinkle * uStarIntensity * fade);
    }
  }

  // ---- sun -----------------------------------------------------------------
  float sunAngle = dot(direction, uSunDirection);
  // Broad atmospheric glow, then a hard disc.
  float glow = pow(max(sunAngle, 0.0), 220.0);
  color += uSunGlowColor * glow * 0.9;
  float sunDisc = smoothstep(0.9985, 0.9992, sunAngle);
  color = mix(color, uSunColor * 1.6, sunDisc);

  // Low-angle scattering: the sky reddens near the sun when it is at the horizon.
  float sunsetAmount = smoothstep(0.35, 0.0, abs(uSunDirection.y));
  float towardsSun = pow(max(sunAngle * 0.5 + 0.5, 0.0), 5.0);
  color += uSunGlowColor * sunsetAmount * towardsSun * 0.5;

  // ---- moon ----------------------------------------------------------------
  float moonAngle = dot(direction, uMoonDirection);
  float moonDisc = smoothstep(0.9990, 0.99955, moonAngle);
  float moonGlow = pow(max(moonAngle, 0.0), 900.0) * 0.35;
  // A dark crescent bite so the moon is not a plain circle.
  vec3 moonOffset = normalize(uMoonDirection + vec3(0.012, 0.006, 0.0));
  float crescent = smoothstep(0.99955, 0.9990, dot(direction, moonOffset));
  vec3 moonColor = vec3(0.92, 0.94, 1.0);
  color += moonColor * (moonDisc * (1.0 - crescent * 0.85) + moonGlow) * uStarIntensity;

  color *= uBrightness;

  gl_FragColor = vec4(color, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
