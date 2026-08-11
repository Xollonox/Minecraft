// Sky dome vertex shader.
//
// The dome is a large inward-facing sphere that follows the camera, so it never
// needs the depth buffer and never clips. Only the *direction* from the camera
// matters, which is what the fragment shader receives.

varying vec3 vDirection;

void main() {
  // Object space direction is enough: the dome is centred on the camera and is
  // never rotated, so this is also the world direction.
  vDirection = normalize(position);

  // Keeping the dome in view space pinned to the camera means no matrix work is
  // needed to follow the player.
  vec4 viewPosition = viewMatrix * modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewPosition;
}
