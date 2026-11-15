// 3D-Buehne: Fruchtfliege mit Kopfhoerern am DJ-Pult. Alles prozedural aus three.js-Grundkoerpern.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const AMBER = 0xf0b860, TEAL = 0x5fd6c0;
const GEAR_Y = 0.24;
const COL_X = [-0.17, 0.17];                               // Mixer-Kanalzuege Deck 1 / Deck 2
const KNOB_Z = { high: 0.36, mid: 0.2, low: 0.04 };
const FADER_Z = [-0.44, -0.16];                            // zu / offen
const JOG = [V(-1.02, GEAR_Y + 0.06, -0.12), V(1.02, GEAR_Y + 0.06, -0.12)];

export function createScene(el, deckCanvases) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.3;
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c0b10); scene.fog = new THREE.Fog(0x0c0b10, 9, 22);
  const cam = new THREE.PerspectiveCamera(42, 1, 0.1, 60); cam.position.set(2.7, 2.7, 3.9);
  const orbit = new OrbitControls(cam, renderer.domElement);
  orbit.target.set(0, 0.9, -0.4); orbit.enableDamping = true; orbit.autoRotate = true; orbit.autoRotateSpeed = 0.7;
  orbit.minDistance = 1.6; orbit.maxDistance = 12; orbit.maxPolarAngle = Math.PI * 0.495;
  renderer.domElement.addEventListener('pointerdown', () => { orbit.autoRotate = false; });

  // ---- Licht ----
  scene.add(new THREE.HemisphereLight(0x9aa2c8, 0x241c22, 1.0));
  const key = new THREE.SpotLight(0xfff0e0, 60, 0, 0.6, 0.6, 1.4); key.position.set(2.5, 7, 4.5); key.target.position.set(0, 0.8, -0.5);
  key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0005; scene.add(key, key.target);
  const rim = new THREE.DirectionalLight(0x6f86ff, 0.7); rim.position.set(-4, 3, -5); scene.add(rim);
  const strobeA = new THREE.PointLight(0xff3d8a, 0, 12, 1.6); strobeA.position.set(-3, 2.6, 1.5);
  const strobeB = new THREE.PointLight(0x3dc8ff, 0, 12, 1.6); strobeB.position.set(3, 2.6, 1.5); scene.add(strobeA, strobeB);

  const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.1, ...o });
  const mesh = (geo, mat, parent, x = 0, y = 0, z = 0, shadow = true) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = shadow; m.receiveShadow = true; (parent || scene).add(m); return m; };

  const floor = mesh(new THREE.PlaneGeometry(60, 60), std(0x15131a, { roughness: 0.95 }), scene, 0, 0, 0, false); floor.rotation.x = -Math.PI / 2;

  // ---- Pult ----
  const M = { body: std(0x16171c, { roughness: 0.5, metalness: 0.5 }), panel: std(0x0c0d10, { roughness: 0.4, metalness: 0.6 }), knob: std(0x2a2c33, { roughness: 0.35, metalness: 0.7 }), cap: std(0xd8dbe2, { roughness: 0.4 }) };
  const glow = (c, i = 1.6) => new THREE.MeshStandardMaterial({ color: 0x111111, emissive: c, emissiveIntensity: i, roughness: 0.4 });
  const jogs = [], screens = [];
  for (let d = 0; d < 2; d++) {
    const x = d ? 1.02 : -1.02, g = new THREE.Group(); g.position.set(x, 0, 0); scene.add(g);
    mesh(new THREE.BoxGeometry(1.0, GEAR_Y, 1.3), M.body, g, 0, GEAR_Y / 2, 0);
    mesh(new THREE.BoxGeometry(0.94, 0.01, 1.24), M.panel, g, 0, GEAR_Y + 0.005, 0, false);
    const jog = new THREE.Group(); jog.position.set(0, GEAR_Y, -0.12); g.add(jog);
    mesh(new THREE.CylinderGeometry(0.36, 0.38, 0.06, 48), M.knob, jog, 0, 0.03, 0);
    mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.012, 48), std(0x08090b, { roughness: 0.25, metalness: 0.8 }), jog, 0, 0.066, 0, false);
    mesh(new THREE.BoxGeometry(0.03, 0.006, 0.2), std(0xe8e8e8), jog, 0, 0.075, -0.15, false);
    const ring = mesh(new THREE.TorusGeometry(0.12, 0.012, 8, 40), glow(0x35b6ff, 2.2), g, 0, GEAR_Y + 0.075, -0.12, false); ring.rotation.x = Math.PI / 2;
    jogs.push(jog);
    const tex = new THREE.CanvasTexture(deckCanvases[d]); tex.colorSpace = THREE.SRGBColorSpace;
    const scr = mesh(new THREE.PlaneGeometry(0.62, 0.2), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }), g, 0, GEAR_Y + 0.07, 0.47, false);
    scr.rotation.x = -Math.PI / 2 + 0.5; screens.push(tex);
    mesh(new THREE.BoxGeometry(0.7, 0.1, 0.28), M.body, g, 0, GEAR_Y + 0.03, 0.5).rotation.x = 0.5;
    const s = d ? -1 : 1;
    mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.02, 24), glow(0x35e06a, 1.2), g, -0.36 * s, GEAR_Y + 0.012, -0.5, false);
    mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.02, 24), glow(0xff9b2e, 1.2), g, -0.36 * s, GEAR_Y + 0.012, -0.34, false);
    mesh(new THREE.BoxGeometry(0.03, 0.012, 0.36), M.panel, g, 0.4 * s, GEAR_Y + 0.012, -0.1, false);
    mesh(new THREE.BoxGeometry(0.07, 0.03, 0.04), M.cap, g, 0.4 * s, GEAR_Y + 0.025, -0.1);
    for (let i = 0; i < 4; i++) mesh(new THREE.BoxGeometry(0.06, 0.015, 0.04), glow([0xff3d8a, 0x35b6ff, 0x35e06a, 0xffd23d][i], 0.9), g, -0.27 + i * 0.09, GEAR_Y + 0.01, 0.27, false);
  }
  const mixer = new THREE.Group(); scene.add(mixer);
  mesh(new THREE.BoxGeometry(0.92, GEAR_Y + 0.02, 1.3), M.body, mixer, 0, (GEAR_Y + 0.02) / 2, 0);
  const TOP = GEAR_Y + 0.02;
  mesh(new THREE.BoxGeometry(0.86, 0.01, 1.24), M.panel, mixer, 0, TOP + 0.005, 0, false);
  const knobGeo = new THREE.CylinderGeometry(0.032, 0.038, 0.05, 20), tickGeo = new THREE.BoxGeometry(0.008, 0.006, 0.03);
  const knobs = [{}, {}], faders = [], meters = [[], []];
  for (let c = 0; c < 4; c++) {
    const x = [-0.34, COL_X[0], COL_X[1], 0.34][c], d = c === 1 ? 0 : c === 2 ? 1 : -1;
    const rows = [['trim', 0.52], ['high', KNOB_Z.high], ['mid', KNOB_Z.mid], ['low', KNOB_Z.low]];
    for (const [name, z] of rows) {
      const k = mesh(knobGeo, d >= 0 && name !== 'trim' ? std(d ? TEAL : AMBER, { roughness: 0.4, metalness: 0.3 }) : M.knob, mixer, x, TOP + 0.03, z);
      mesh(tickGeo, std(0xffffff), k, 0, 0.027, 0.018, false);
      if (d >= 0 && name !== 'trim') knobs[d][name] = k;
    }
    mesh(new THREE.BoxGeometry(0.014, 0.012, 0.34), std(0x000000), mixer, x, TOP + 0.008, -0.3, false);
    const f = mesh(new THREE.BoxGeometry(0.075, 0.035, 0.04), d >= 0 ? std(d ? TEAL : AMBER, { roughness: 0.4 }) : M.cap, mixer, x, TOP + 0.03, FADER_Z[0]);
    if (d >= 0) faders[d] = f;
  }
  for (let d = 0; d < 2; d++) for (let i = 0; i < 10; i++) meters[d].push(mesh(new THREE.BoxGeometry(0.022, 0.008, 0.026), glow(i > 7 ? 0xff4040 : i > 5 ? 0xffc23d : 0x35e06a, 0), mixer, d ? 0.03 : -0.03, TOP + 0.012, 0.0 + i * 0.036, false));
  mesh(new THREE.BoxGeometry(0.34, 0.012, 0.014), std(0x000000), mixer, 0, TOP + 0.008, -0.56, false);
  const xf = mesh(new THREE.BoxGeometry(0.04, 0.035, 0.075), M.cap, mixer, 0, TOP + 0.03, -0.56);

  // ---- Boxen ----
  const cones = [];
  for (const sx of [-1, 1]) {
    const g = new THREE.Group(); g.position.set(sx * 2.7, 0, -0.9); g.rotation.y = -sx * 0.45; scene.add(g);
    mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.2, 10), M.knob, g, 0, 0.6, 0);
    mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.04, 20), M.knob, g, 0, 0.02, 0);
    mesh(new THREE.BoxGeometry(0.72, 1.05, 0.55), std(0x101116, { roughness: 0.8 }), g, 0, 1.7, 0);
    const w = mesh(new THREE.CylinderGeometry(0.25, 0.14, 0.08, 32), std(0x25262c, { roughness: 0.5, metalness: 0.4 }), g, 0, 1.52, 0.28); w.rotation.x = Math.PI / 2; cones.push(w);
    mesh(new THREE.CylinderGeometry(0.09, 0.05, 0.05, 24), std(0x25262c, { metalness: 0.4 }), g, 0, 2.0, 0.28).rotation.x = Math.PI / 2;
  }

  // ---- Fliege ----
  const fly = new THREE.Group(); scene.add(fly);
  const C = { body: std(0xc27430, { roughness: 0.6 }), dark: std(0x7a431c, { roughness: 0.65 }), leg: std(0x6f3d22, { roughness: 0.6 }), eye: std(0xb81a1a, { roughness: 0.3, metalness: 0.15 }), hp: std(0x101116, { roughness: 0.35, metalness: 0.5 }) };
  const ball = (r, mat, parent, x, y, z, sx = 1, sy = 1, sz = 1) => { const m = mesh(new THREE.SphereGeometry(r, 28, 20), mat, parent, x, y, z); m.scale.set(sx, sy, sz); return m; };
  const thorax = ball(0.5, C.body, fly, 0, 1.72, -0.85, 0.95, 0.9, 1.25);
  for (let i = 0; i < 14; i++) { const b = mesh(new THREE.ConeGeometry(0.008, 0.22, 5), C.dark, fly, (i % 2 ? 1 : -1) * (0.1 + 0.07 * (i % 3)), 2.16 - 0.02 * (i % 4), -0.55 - i * 0.045, false); b.rotation.x = -0.5; }
  const abdomen = new THREE.Group(); abdomen.position.set(0, 1.78, -1.35); abdomen.rotation.x = -0.12; fly.add(abdomen);
  for (let i = 0; i < 6; i++) { const r = [0.44, 0.47, 0.46, 0.41, 0.33, 0.22][i]; ball(r, i % 2 ? C.dark : C.body, abdomen, 0, 0, -0.12 - i * 0.2, 1, 0.92, 0.42); }
  const head = new THREE.Group(); head.position.set(0, 1.62, -0.12); fly.add(head);
  ball(0.34, C.body, head, 0, 0, 0, 1.05, 0.95, 0.85);
  for (const sx of [-1, 1]) {
    ball(0.21, C.eye, head, sx * 0.2, 0.05, 0.14, 0.85, 1.15, 0.95);
    const a = mesh(new THREE.ConeGeometry(0.03, 0.16, 8), C.dark, head, sx * 0.07, 0.0, 0.33); a.rotation.x = 1.9;
    const cup = mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.12, 28), C.hp, head, sx * 0.4, 0.0, -0.05); cup.rotation.z = Math.PI / 2;
    const rg = mesh(new THREE.TorusGeometry(0.15, 0.018, 8, 32), glow(0x3d8bff, 1.8), head, sx * 0.465, 0.0, -0.05, false); rg.rotation.y = Math.PI / 2;
    mesh(new THREE.CylinderGeometry(0.205, 0.205, 0.04, 28), std(0xb01c1c, { roughness: 0.6 }), head, sx * 0.33, 0, -0.05).rotation.z = Math.PI / 2;
  }
  const band = mesh(new THREE.TorusGeometry(0.42, 0.035, 10, 40, Math.PI), C.hp, head, 0, 0.02, -0.05);
  mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.2, 8), C.dark, head, 0, -0.3, 0.16).rotation.x = 0.5;      // Ruessel
  const wingMat = new THREE.MeshStandardMaterial({ color: 0xe6ecff, transparent: true, opacity: 0.22, side: THREE.DoubleSide, roughness: 0.2, depthWrite: false });
  const wings = [];
  for (const sx of [-1, 1]) { const p = new THREE.Group(); p.position.set(sx * 0.22, 2.12, -0.95); fly.add(p); const w = new THREE.Mesh(new THREE.CircleGeometry(0.5, 28), wingMat); w.scale.set(0.42, 1, 1.6); w.rotation.x = -Math.PI / 2; w.position.set(sx * 0.12, 0, -0.85); p.add(w); wings.push(p); }

  // Beine: Huefte am Thorax, Zwei-Knochen-IK zum Ziel, Tarsus liegt auf dem Regler
  const segGeo = new THREE.CylinderGeometry(1, 0.75, 1, 8); segGeo.translate(0, 0.5, 0);
  const UP = V(0, 1, 0);
  const legs = [];
  const LEGS = [  // Huefte (relativ zur Fliege), Laengen, Ruheziel
    { hip: V(-0.3, 1.42, -0.52), a: 1.0, b: 1.15, rest: V(-0.5, TOP + 0.02, -0.6) }, { hip: V(0.3, 1.42, -0.52), a: 1.0, b: 1.15, rest: V(0.5, TOP + 0.02, -0.6) },
    { hip: V(-0.36, 1.4, -0.85), a: 1.05, b: 1.25, rest: V(-1.02, GEAR_Y + 0.02, -0.56) }, { hip: V(0.36, 1.4, -0.85), a: 1.05, b: 1.25, rest: V(1.02, GEAR_Y + 0.02, -0.56) },
    { hip: V(-0.32, 1.42, -1.15), a: 1.1, b: 1.35, rest: V(-1.15, 0, -2.2) }, { hip: V(0.32, 1.42, -1.15), a: 1.1, b: 1.35, rest: V(1.15, 0, -2.2) },
  ];
  LEGS.forEach((L, i) => {
    const mk = (r) => { const m = new THREE.Mesh(segGeo, C.leg); m.castShadow = true; m.userData.r = r; fly.add(m); return m; };
    legs.push({ ...L, sx: i % 2 ? 1 : -1, s1: mk(0.035), s2: mk(0.026), s3: mk(0.018), joint: ball(0.045, C.leg, fly, 0, 0, 0), pos: L.rest.clone(), goal: L.rest.clone(), lift: 0 });
  });
  const tmp = V(0, 0, 0), dir = V(0, 0, 0), pole = V(0, 0, 0), knee = V(0, 0, 0), ank = V(0, 0, 0), q = new THREE.Quaternion();
  const place = (m, p0, p1) => { dir.subVectors(p1, p0); const l = dir.length(); m.position.copy(p0); m.scale.set(m.userData.r, l, m.userData.r); m.quaternion.setFromUnitVectors(UP, dir.divideScalar(l || 1)); };
  function solveLeg(L, bodyY) {
    const hip = tmp.copy(L.hip); hip.y += bodyY;
    ank.copy(L.pos); ank.y += 0.1; ank.x += L.sx * 0.03;                 // kurzer Tarsus steht fast senkrecht auf dem Ziel
    dir.subVectors(ank, hip); let d = dir.length(); const max = L.a + L.b - 0.01; if (d > max) { ank.copy(hip).addScaledVector(dir, max / d); d = max; }
    dir.divideScalar(d);
    const along = (L.a * L.a - L.b * L.b + d * d) / (2 * d), h = Math.sqrt(Math.max(0, L.a * L.a - along * along));
    pole.set(L.sx * 0.9, 1, 0).addScaledVector(dir, -pole.dot(dir)).normalize();
    knee.copy(hip).addScaledVector(dir, along).addScaledVector(pole, h);
    place(L.s1, hip, knee); place(L.s2, knee, ank); place(L.s3, ank, L.pos); L.joint.position.copy(knee);
  }

  function ctrlPos(d, name, k, out) {
    if (name === 'fader') return out.set(COL_X[d], TOP + 0.05, FADER_Z[0] + (FADER_Z[1] - FADER_Z[0]) * k);
    if (name === 'jog') return out.copy(JOG[d]).setX(JOG[d].x + (d ? -0.2 : 0.2));
    return out.set(COL_X[d], TOP + 0.06, KNOB_Z[name]);
  }

  function resize() { const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
  new ResizeObserver(resize).observe(el); resize();

  let t = 0, bob = 0, flashV = 0, jogA = [0, 0];
  // s = { decks:[{knob,spin,level,focus}], beat (0..1 Phase), flash, spikes (0..1), xf (-1..1) }
  function update(dt, s) {
    t += dt;
    const pulse = Math.pow(1 - s.beat, 3) * s.energy;
    bob += (pulse - bob) * Math.min(1, dt * 18);
    const bodyY = -0.07 * bob;
    thorax.position.y = 1.72 + bodyY; abdomen.position.y = 1.78 + bodyY * 0.6; abdomen.rotation.x = -0.12 + 0.05 * bob;
    head.position.y = 1.62 + bodyY * 1.6; head.rotation.x = 0.32 + 0.16 * bob; head.rotation.y = 0.12 * Math.sin(t * 0.7) + 0.25 * s.xf;
    band.rotation.x = -0.25;
    const fl = Math.sin(t * 70) * (0.05 + 0.5 * s.spikes);
    wings[0].rotation.set(0.12, 0.2, -0.15 - fl); wings[1].rotation.set(0.12, -0.2, 0.15 + fl);
    if (s.flash > 0) flashV = s.flash; flashV *= Math.exp(-dt * 9);
    strobeA.intensity = 26 * flashV; strobeB.intensity = 26 * flashV;
    xf.position.x = 0.14 * s.xf;
    for (let d = 0; d < 2; d++) {
      const D = s.decks[d];
      for (const n of ['low', 'mid', 'high']) knobs[d][n].rotation.y = -(D.knob[n] - 0.5) * 4.7;
      faders[d].position.z = FADER_Z[0] + (FADER_Z[1] - FADER_Z[0]) * D.knob.fader;
      jogA[d] -= D.spin * dt * 3.5; jogs[d].rotation.y = jogA[d];
      const lv = Math.min(10, D.level * D.knob.fader * 30);
      for (let i = 0; i < 10; i++) meters[d][i].material.emissiveIntensity = i < lv ? 2 : 0.05;
      screens[d].needsUpdate = true;
      cones[d].position.z = 0.28 + 0.03 * bob;
      // Vorderbein -> Mixer-Regler, Mittelbein -> Jog-Wheel
      const front = legs[d], midL = legs[2 + d];
      if (D.focus) ctrlPos(d, D.focus, D.knob[D.focus] || 0, front.goal); else front.goal.copy(front.rest);
      if (D.jog) ctrlPos(d, 'jog', 0, midL.goal); else midL.goal.copy(midL.rest);
    }
    for (const L of legs) {
      const dist = L.pos.distanceTo(L.goal);
      L.lift += ((dist > 0.08 ? Math.min(0.35, dist * 0.6) : 0) - L.lift) * Math.min(1, dt * 10);   // Bein hebt beim Umgreifen ab
      L.pos.lerp(L.goal, Math.min(1, dt * 9));
      const y = L.pos.y; L.pos.y += L.lift; solveLeg(L, bodyY); L.pos.y = y;
    }
    orbit.update(); renderer.render(scene, cam);
  }
  return { update, orbit };
}
