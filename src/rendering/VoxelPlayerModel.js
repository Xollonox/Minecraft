/** Original, procedurally built voxel-player avatar used by third-person views. */
import * as THREE from 'three';

export const VOXEL_PLAYER_PROPORTIONS = Object.freeze({
  height:1.8,
  head:0.45,
  torso:Object.freeze([0.45, .675, .225]),
  arm:Object.freeze([.225, .675, .225]),
  leg:Object.freeze([.225, .675, .225]),
  torsoY:1.0125,
});

function standard(color, options = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness:options.roughness ?? .82,
    metalness:options.metalness ?? 0,
    emissive:options.emissive ?? 0x000000,
    emissiveIntensity:options.emissiveIntensity ?? 0,
  });
}

/**
 * Builds a detailed but original block-character. No downloaded skin or
 * proprietary texture is used: every colour and facial pixel is authored here.
 */
export function createVoxelPlayerModel() {
  const group = new THREE.Group();
  group.name = 'voxel-player-avatar';

  const materials = {
    skin:standard(0xc98f67),
    skinLight:standard(0xe0aa7e),
    skinShade:standard(0xaa704e),
    hair:standard(0x352218),
    hairLight:standard(0x52352a),
    shirt:standard(0x168f91),
    shirtLight:standard(0x31b8b1),
    shirtShade:standard(0x0f666d),
    trousers:standard(0x334b9b),
    trousersShade:standard(0x24356f),
    boots:standard(0x282a32),
    eyeWhite:standard(0xe9f0e8),
    iris:standard(0x315b71),
    mouth:standard(0x633b34),
  };
  const geometries = [];
  const mesh = (name, size, material, position = [0,0,0]) => {
    const geometry = new THREE.BoxGeometry(...size);
    geometries.push(geometry);
    const part = new THREE.Mesh(geometry, material);
    part.name = name;
    part.position.set(...position);
    part.castShadow = true;
    part.receiveShadow = true;
    return part;
  };

  const torsoGroup = new THREE.Group();
  torsoGroup.name = 'player-torso-pivot';
  torsoGroup.position.y = VOXEL_PLAYER_PROPORTIONS.torsoY;
  torsoGroup.add(
    mesh('player-torso', [.45,.675,.225], materials.shirt),
    mesh('player-shirt-front', [.25,.18,.018], materials.shirtLight, [0,.12,.121]),
    mesh('player-shirt-hem', [.45,.08,.018], materials.shirtShade, [0,-.295,.121])
  );

  const headGroup = new THREE.Group();
  headGroup.name = 'player-head-pivot';
  headGroup.position.y = .3375;
  headGroup.add(
    mesh('player-head', [.45,.45,.45], materials.skin, [0,.225,0]),
    mesh('player-hair-cap', [.462,.075,.462], materials.hair, [0,.422,0]),
    mesh('player-hair-fringe', [.46,.10,.025], materials.hairLight, [0,.355,.232]),
    mesh('player-hair-left', [.055,.25,.025], materials.hair, [-.202,.285,.232]),
    mesh('player-hair-right', [.055,.18,.025], materials.hair, [.202,.32,.232]),
    mesh('player-eye-left-white', [.115,.062,.018], materials.eyeWhite, [-.115,.255,.234]),
    mesh('player-eye-right-white', [.115,.062,.018], materials.eyeWhite, [.115,.255,.234]),
    mesh('player-eye-left-iris', [.048,.062,.022], materials.iris, [-.082,.255,.247]),
    mesh('player-eye-right-iris', [.048,.062,.022], materials.iris, [.148,.255,.247]),
    mesh('player-nose', [.07,.09,.052], materials.skinLight, [0,.178,.249]),
    mesh('player-mouth', [.105,.03,.021], materials.mouth, [0,.093,.237]),
    mesh('player-ear-left', [.035,.11,.11], materials.skinShade, [-.242,.22,0]),
    mesh('player-ear-right', [.035,.11,.11], materials.skinShade, [.242,.22,0])
  );
  torsoGroup.add(headGroup);

  const makeArm = (side) => {
    const sign = side === 'left' ? -1 : 1;
    const arm = new THREE.Group();
    arm.name = `player-${side}-arm-pivot`;
    arm.position.set(sign * .3375, .3375, 0);
    arm.add(
      mesh(`player-${side}-sleeve`, [.225,.25,.225], side === 'left' ? materials.shirtLight : materials.shirt, [0,-.125,0]),
      mesh(`player-${side}-forearm`, [.225,.425,.225], side === 'left' ? materials.skinLight : materials.skin, [0,-.4625,0])
    );
    const socket = new THREE.Group();
    socket.name = `player-${side}-hand-socket`;
    socket.position.y = -.69;
    arm.add(socket);
    return { arm, socket };
  };
  const left = makeArm('left');
  const right = makeArm('right');
  torsoGroup.add(left.arm, right.arm);

  const makeLeg = (side) => {
    const sign = side === 'left' ? -1 : 1;
    const leg = new THREE.Group();
    leg.name = `player-${side}-leg-pivot`;
    leg.position.set(sign * .1125, -.3375, 0);
    leg.add(
      mesh(`player-${side}-leg`, [.225,.675,.225], side === 'left' ? materials.trousers : materials.trousersShade, [0,-.3375,0]),
      mesh(`player-${side}-boot`, [.23,.13,.27], materials.boots, [0,-.61,.025])
    );
    return leg;
  };
  const legLeft = makeLeg('left');
  const legRight = makeLeg('right');
  torsoGroup.add(legLeft, legRight);
  group.add(torsoGroup);

  const shadowGeometry = new THREE.CircleGeometry(.42, 20);
  geometries.push(shadowGeometry);
  const shadowMaterial = new THREE.MeshBasicMaterial({
    color:0x000000, transparent:true, opacity:.24, depthWrite:false,
  });
  const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
  shadow.name = 'player-contact-shadow';
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = .012;
  shadow.renderOrder = 1;
  group.add(shadow);

  group.userData.avatarStyle = 'original-teal-voxel';
  group.userData.proportions = VOXEL_PLAYER_PROPORTIONS;

  return {
    group, torsoGroup, headGroup,
    armLeft:left.arm, armRight:right.arm,
    legLeft, legRight,
    rightHandSocket:right.socket,
    shadow,
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      for (const material of [...Object.values(materials), shadowMaterial]) material.dispose();
    },
  };
}

export default createVoxelPlayerModel;
