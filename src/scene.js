import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ING } from './state.js';

const FACE_MODEL_URL = './assets/models/face-model.glb';

// gaussian bump helper used throughout the facial sculpt
const g = (v, s) => Math.exp(-(v * v) / (2 * s * s));
const sc = (v) => (v < 0 ? 0 : v);

// cheap deterministic hash-noise for skin micro-texture (no external assets)
function hashNoise(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123;
  return s - Math.floor(s);
}


export class SkinScene {
  constructor(mount, { onReady, onPourTick } = {}) {
    this.mount = mount;
    this.onReady = onReady || (() => {});
    this.onPourTick = onPourTick || (() => {});
    this.threeReady = false;
    this.playing = false;
    this.playT = 0;
    this.wet = 0;
    this._waitId = setInterval(() => {
      if (this.mount.clientWidth) { clearInterval(this._waitId); this.initThree(); }
    }, 40);
  }

  dispose() {
    clearInterval(this._waitId);
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._ro) this._ro.disconnect();
    if (this.renderer) this.renderer.dispose();
  }

  lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

  // ---------- procedural textures ----------
  softTexture() {
    const s = 128, cv = document.createElement('canvas'); cv.width = cv.height = s;
    const x = cv.getContext('2d'), grad = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(.55, 'rgba(255,255,255,.55)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = grad; x.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(cv);
  }

  // subtle pore / micro-texture bump+roughness map so the skin isn't perfectly smooth
  skinDetailTextures() {
    const s = 512;
    const bumpCv = document.createElement('canvas'); bumpCv.width = bumpCv.height = s;
    const roughCv = document.createElement('canvas'); roughCv.width = roughCv.height = s;
    const bctx = bumpCv.getContext('2d'), rctx = roughCv.getContext('2d');
    const bimg = bctx.createImageData(s, s), rimg = rctx.createImageData(s, s);
    for (let py = 0; py < s; py++) {
      for (let px = 0; px < s; px++) {
        const i = (py * s + px) * 4;
        // layered noise: fine pores + broader mottling
        const fine = hashNoise(px * 0.9, py * 0.9, 1.7);
        const mid = hashNoise(px * 0.06, py * 0.06, 5.2);
        const v = Math.max(0, Math.min(255, 128 + (fine - 0.5) * 70 + (mid - 0.5) * 40));
        bimg.data[i] = bimg.data[i + 1] = bimg.data[i + 2] = v; bimg.data[i + 3] = 255;
        const rv = Math.max(0, Math.min(255, 150 + (fine - 0.5) * 60 + (mid - 0.5) * 50));
        rimg.data[i] = rimg.data[i + 1] = rimg.data[i + 2] = rv; rimg.data[i + 3] = 255;
      }
    }
    bctx.putImageData(bimg, 0, 0); rctx.putImageData(rimg, 0, 0);
    const bump = new THREE.CanvasTexture(bumpCv), rough = new THREE.CanvasTexture(roughCv);
    bump.wrapS = bump.wrapT = rough.wrapS = rough.wrapT = THREE.RepeatWrapping;
    bump.repeat.set(3, 3); rough.repeat.set(3, 3);
    return { bump, rough };
  }

  // ---------- real face model (uploaded scan), procedural sculpt as fallback ----------
  loadFaceModel() {
    return new Promise((resolve) => {
      new GLTFLoader().load(FACE_MODEL_URL, (gltf) => {
        let mesh = null;
        gltf.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
        if (!mesh) { resolve(null); return; }
        const src = mesh.material;
        this.headMat = new THREE.MeshPhysicalMaterial({
          map: src && src.map ? src.map : null,
          color: 0xffffff,
          roughness: (src && src.roughness) ?? 0.65,
          metalness: 0,
          clearcoat: 0.22, clearcoatRoughness: 0.55,
          sheen: 0.25, sheenRoughness: 0.75, sheenColor: new THREE.Color(0xf3d9c2),
        });
        mesh.material = this.headMat;
        mesh.updateMatrixWorld(true);
        this.scene.add(gltf.scene);
        resolve(mesh);
      }, undefined, () => resolve(null));
    });
  }

  // ---------- head sculpt (fallback when no uploaded model is present) ----------
  buildProceduralHead() {
    const geo = new THREE.SphereGeometry(1, 220, 220);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      // cranium — modest elongation (excess height/y-stretch is what makes a
      // sculpted sphere read as an "egg"; real heads are closer to round)
      x *= 0.76; y *= 1.06; z *= 0.90;
      // smooth jaw + chin taper (wider at top, narrowing to a soft chin)
      if (y < 0) { const t = -y; x *= (1 - 0.30 * t * t); z *= (1 - 0.10 * t * t); }
      // jawline definition — sharpen the lower cheek->jaw transition
      if (y < -0.18 && y > -0.55) { const t = (-y - 0.18) / 0.37; x *= (1 - 0.05 * t); }
      // jaw corner (gonion) — a subtle outward bump so the jaw reads as an
      // angular corner rather than a smooth cone down to the chin
      if (y < 0) x += 0.048 * g(y + 0.33, 0.085) * Math.sign(x || 1);
      // crown narrows
      if (y > 0.45) { const t = y - 0.45; x *= (1 - 0.20 * t); z *= (1 - 0.06 * t); }
      // temple hollow (just above/beside the eyes, before the crown)
      if (z > 0) z -= 0.014 * g(Math.abs(x) - 0.31, 0.05) * g(y - 0.22, 0.09);

      const front = Math.max(0, Math.min(1, z / 0.9));
      const f2 = front * front;
      if (z > 0) {
        // flatten the ball into a facial plane (gentle)
        z -= 0.05 * f2 * g(x, 0.44);
        // flatten the forehead specifically — an unbroken round curve from
        // crown into brow is the single biggest "egg" cue
        z -= 0.032 * g(y - 0.42, 0.30) * g(x, 0.34) * front;
        // brow ridge
        z += 0.050 * g(y - 0.21, 0.10) * g(x, 0.27) * front;
        // nose — a soft vertical ridge from bridge (0.17) to tip (-0.07)
        const noseProfile = (y < 0.22 && y > -0.18) ? Math.cos(((y - 0.02) / 0.22) * (Math.PI / 2)) : 0;
        z += 0.215 * g(x, 0.058) * sc(noseProfile) * front;
        // rounded nose tip
        z += 0.075 * g(x, 0.056) * g(y + 0.055, 0.05) * front;
        // nostril wings
        z += 0.024 * g(Math.abs(x) - 0.075, 0.03) * g(y + 0.105, 0.026) * front;
        // cheekbones
        z += 0.038 * g(Math.abs(x) - 0.26, 0.12) * g(y + 0.02, 0.15) * front;
        // nasolabial fold — subtle crease from nose wing toward mouth corner
        z -= 0.014 * g(Math.abs(x) - 0.135, 0.028) * g(y + 0.19, 0.09) * front;
        // eye sockets — clearly readable but smooth
        z -= 0.055 * g(Math.abs(x) - 0.185, 0.058) * g(y - 0.01, 0.048) * front;
        // upper eyelid crease (reads as a lid, not a bald socket)
        z -= 0.022 * g(Math.abs(x) - 0.185, 0.06) * g(y - 0.055, 0.022) * front;
        z += 0.012 * g(Math.abs(x) - 0.185, 0.06) * g(y - 0.03, 0.018) * front; // lid roll
        // lower eyelid subtle bag
        z += 0.008 * g(Math.abs(x) - 0.185, 0.062) * g(y + 0.035, 0.02) * front;
        // soft upper-lid brow shadow bridging to nose (avoids a bald forehead)
        z -= 0.020 * g(x, 0.045) * g(y - 0.10, 0.05) * front;
        // lips — separate upper/lower volumes + cupid's bow
        z += 0.036 * g(x, 0.145) * g(y + 0.285, 0.032) * front;   // upper lip
        z += 0.044 * g(x, 0.145) * g(y + 0.335, 0.036) * front;   // lower lip (fuller)
        z += 0.014 * g(Math.abs(x) - 0.028, 0.014) * g(y + 0.268, 0.014) * front; // cupid's bow peaks
        z -= 0.018 * g(x, 0.13) * g(y + 0.335, 0.012) * front;    // mouth line
        z -= 0.012 * g(x, 0.024) * g(y + 0.155, 0.022) * front;   // philtrum
        // chin bump
        z += 0.026 * g(x, 0.10) * g(y + 0.50, 0.07) * front;
        // fine skin micro-texture (very small, breaks up perfect smoothness at silhouette too)
        z += 0.0016 * (hashNoise(x * 40, y * 40, 0) - 0.5) * front;
      }
      p.setXYZ(i, x, y, z);
    }
    geo.computeVertexNormals();

    const { bump, rough } = this.skinDetailTextures();
    this.headMat = new THREE.MeshPhysicalMaterial({
      color: 0xe7c7ac, roughness: 0.62, clearcoat: 0.28, clearcoatRoughness: 0.55,
      reflectivity: 0.35, bumpMap: bump, bumpScale: 0.0022, roughnessMap: rough,
      sheen: 0.35, sheenRoughness: 0.7, sheenColor: new THREE.Color(0xf3d9c2),
    });
    this.headMesh = new THREE.Mesh(geo, this.headMat);
    this.headMesh.position.y = 0.15;
    this.headMesh.updateMatrixWorld(true);
    this.scene.add(this.headMesh);
    this.headYOffset = 0.15;
  }

  // ---------- eyes (painted decals — avoids 3D eyeballs poking through the sculpted shell) ----------
  eyeTexture(mirrored) {
    const w = 256, h = 160, cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const x = cv.getContext('2d');
    x.clearRect(0, 0, w, h);
    if (mirrored) { x.translate(w, 0); x.scale(-1, 1); }
    const cx = w / 2, cy = h / 2 + 6;
    // almond sclera
    x.beginPath();
    x.moveTo(w * 0.06, cy);
    x.quadraticCurveTo(cx, cy - h * 0.34, w * 0.94, cy);
    x.quadraticCurveTo(cx, cy + h * 0.22, w * 0.06, cy);
    x.closePath();
    x.fillStyle = '#f4efe4'; x.fill();
    // upper lid line (darker, defines the lash line)
    x.beginPath();
    x.moveTo(w * 0.05, cy);
    x.quadraticCurveTo(cx, cy - h * 0.36, w * 0.95, cy);
    x.lineWidth = 7; x.strokeStyle = 'rgba(58,42,28,0.85)'; x.lineCap = 'round'; x.stroke();
    // lash flick at outer corner
    x.beginPath(); x.moveTo(w * 0.95, cy); x.quadraticCurveTo(w * 1.0, cy - 8, w * 1.03, cy - 14);
    x.lineWidth = 4; x.strokeStyle = 'rgba(58,42,28,0.7)'; x.stroke();
    // iris + pupil
    const irisR = h * 0.165;
    const grad = x.createRadialGradient(cx, cy, 1, cx, cy, irisR);
    grad.addColorStop(0, '#6b4a30'); grad.addColorStop(0.7, '#4a3220'); grad.addColorStop(1, '#2c1d12');
    x.beginPath(); x.arc(cx, cy, irisR, 0, Math.PI * 2); x.fillStyle = grad; x.fill();
    x.beginPath(); x.arc(cx, cy, irisR * 0.42, 0, Math.PI * 2); x.fillStyle = '#0b0806'; x.fill();
    x.beginPath(); x.arc(cx - irisR * 0.32, cy - irisR * 0.32, irisR * 0.18, 0, Math.PI * 2); x.fillStyle = 'rgba(255,255,255,.85)'; x.fill();
    // soft lower lid shadow
    x.beginPath();
    x.moveTo(w * 0.1, cy + 4);
    x.quadraticCurveTo(cx, cy + h * 0.2, w * 0.9, cy + 4);
    x.lineWidth = 3; x.strokeStyle = 'rgba(120,90,70,0.25)'; x.stroke();
    return new THREE.CanvasTexture(cv);
  }

  browTexture() {
    const w = 220, h = 70, cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const x = cv.getContext('2d');
    x.beginPath();
    x.moveTo(w * 0.03, h * 0.62);
    x.quadraticCurveTo(w * 0.45, h * 0.05, w * 0.97, h * 0.42);
    x.quadraticCurveTo(w * 0.55, h * 0.42, w * 0.03, h * 0.72);
    x.closePath();
    const grad = x.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'rgba(42,29,18,0.75)'); grad.addColorStop(0.5, 'rgba(34,23,14,1)'); grad.addColorStop(1, 'rgba(42,29,18,0.5)');
    x.fillStyle = grad; x.fill();
    return new THREE.CanvasTexture(cv);
  }

  buildEyes() {
    const group = new THREE.Group();
    const eyeTexL = this.eyeTexture(false), eyeTexR = this.eyeTexture(true);
    const browTex = this.browTexture();
    const orient = (mesh, hp) => { mesh.position.copy(hp.point).addScaledVector(hp.normal, 0.007); mesh.lookAt(hp.point.clone().add(hp.normal)); };

    for (const side of [-1, 1]) {
      const eyeHit = this.faceHit([side * 0.185 - 0.01, side * 0.185 + 0.01], [0.005, 0.015], 60);
      if (eyeHit) {
        const eye = new THREE.Mesh(new THREE.PlaneGeometry(0.155, 0.10),
          new THREE.MeshBasicMaterial({ map: side < 0 ? eyeTexL : eyeTexR, transparent: true, depthWrite: false }));
        orient(eye, eyeHit);
        group.add(eye);
      }
      const browHit = this.faceHit([side * 0.185 - 0.02, side * 0.185 + 0.02], [0.085, 0.10], 60);
      if (browHit) {
        const brow = new THREE.Mesh(new THREE.PlaneGeometry(0.19, 0.06),
          new THREE.MeshBasicMaterial({ map: browTex, transparent: true, depthWrite: false }));
        // billboard toward the camera's default facing (+Z) rather than the local
        // surface normal — the brow ridge slopes steeply enough that following the
        // normal here turns the decal edge-on and nearly invisible from the front.
        brow.position.set(browHit.point.x, browHit.point.y, browHit.point.z + 0.035);
        if (side < 0) brow.scale.x = -1;
        group.add(brow);
      }
    }
    this.scene.add(group);
    this.eyesGroup = group;
  }

  // ---------- ears (single tucked, embedded shape — avoids stray rings/slivers) ----------
  buildEars() {
    const group = new THREE.Group();
    for (const side of [-1, 1]) {
      const rc = new THREE.Raycaster();
      const originX = side * 1.4;
      rc.set(new THREE.Vector3(originX, 0.15 - 0.02, 0.02), new THREE.Vector3(-side, 0, 0));
      const hit = rc.intersectObject(this.headMesh, false)[0];
      if (!hit) continue;
      const normal = hit.face.normal.clone().transformDirection(this.headMesh.matrixWorld);
      const anchor = hit.point.clone();

      const ear = new THREE.Group();
      const shell = new THREE.Mesh(new THREE.SphereGeometry(0.115, 20, 20), this.headMat);
      shell.scale.set(0.62, 1, 0.42);
      ear.add(shell);
      const lobe = new THREE.Mesh(new THREE.SphereGeometry(0.034, 14, 14), this.headMat);
      lobe.position.set(0, -0.105, 0.01);
      lobe.scale.set(0.85, 1.05, 0.75);
      ear.add(lobe);
      // shallow concha dimple (subtle darker inset) for a touch of realistic depth
      const dimple = new THREE.Mesh(new THREE.CircleGeometry(0.038, 16),
        new THREE.MeshStandardMaterial({ color: 0xcf9d7c, roughness: 0.7, transparent: true, opacity: 0.55, depthWrite: false }));
      dimple.position.set(side * -0.012, 0.01, 0.038);
      ear.add(dimple);

      ear.position.copy(anchor).addScaledVector(normal, -0.025);
      ear.lookAt(anchor.clone().add(normal));
      group.add(ear);
    }
    this.scene.add(group);
    this.earsGroup = group;
  }

  buildPedestal(bottomY = -0.86, withNeck = true) {
    if (withNeck) {
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 0.7, 48), this.headMat);
      neck.position.y = bottomY; this.scene.add(neck);
    }
    const plm = new THREE.MeshStandardMaterial({ color: 0xd9c8b2, roughness: 0.92 });
    const topY = bottomY - (withNeck ? 0.38 : 0.02);
    const plinthTop = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.12, 48), plm);
    plinthTop.position.y = topY; this.scene.add(plinthTop);
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.66, 0.92, 0.5, 48), plm);
    plinth.position.y = topY - 0.31; this.scene.add(plinth);
    const st = this.softTexture();
    const sm = new THREE.MeshBasicMaterial({ map: st, transparent: true, color: 0x4a3722, opacity: 0.3, depthWrite: false });
    const shad = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 3.0), sm);
    shad.rotation.x = -Math.PI / 2; shad.position.y = topY - 0.55; this.scene.add(shad);
  }

  faceHit(xr, yr, tries) {
    const rc = new THREE.Raycaster();
    for (let k = 0; k < (tries || 40); k++) {
      const x = xr[0] + Math.random() * (xr[1] - xr[0]);
      const y = this.headYOffset + yr[0] + Math.random() * (yr[1] - yr[0]);
      rc.set(new THREE.Vector3(x, y, 4), new THREE.Vector3(0, 0, -1));
      const hit = rc.intersectObject(this.headMesh, false)[0];
      if (hit) {
        const n = hit.face.normal.clone().transformDirection(this.headMesh.matrixWorld);
        if (n.z > 0.35) return { point: hit.point.clone(), normal: n };
      }
    }
    return null;
  }

  pourHit() {
    const rc = new THREE.Raycaster();
    for (let k = 0; k < 40; k++) {
      const x = (Math.random() - 0.5) * 0.92;
      const z = 0.05 + Math.random() * 0.8;
      rc.set(new THREE.Vector3(x, 3.5, z), new THREE.Vector3(0, -1, 0));
      const hit = rc.intersectObject(this.headMesh, false)[0];
      if (hit && hit.point.y > -0.35) {
        const n = hit.face.normal.clone().transformDirection(this.headMesh.matrixWorld);
        return { point: hit.point.clone(), normal: n };
      }
    }
    return null;
  }

  buildFeatures() {
    this.featGroup = new THREE.Group(); this.scene.add(this.featGroup);
    this.soft = this.softTexture();
    const orient = (mesh, h) => { mesh.position.copy(h.point).addScaledVector(h.normal, 0.006); mesh.lookAt(h.point.clone().add(h.normal)); };

    // coordinate ranges differ between the procedural sculpt and the uploaded
    // scan (different proportions/scale) — calibrated against each mesh by
    // raycasting known landmarks (brow, nose tip, mouth, chin, cheeks).
    const P = this.usingRealModel
      ? {
          acneX: [-0.42, 0.42], acneY: [-0.22, 0.58],
          spotX: [-0.48, 0.48], spotY: [-0.05, 0.4], spotMinAbsX: 0.14,
          scarX: [-0.42, 0.42], scarY: [-0.2, 0.15], scarMinAbsX: 0.12,
          lineForeheadX: [-0.35, 0.35], lineForeheadY: [0.42, 0.56],
          lineCornerX: [0.20, 0.40], lineCornerY: [0.36, 0.42],
          redPatches: [[-0.26, 0.06], [0.26, 0.06], [0, 0.24], [-0.20, 0.32], [0.20, 0.32]],
          redSize: [0.26, 0.24],
          eyeCenters: [[-0.10, 0.40], [0.10, 0.40]],
        }
      : {
          acneX: [-0.5, 0.5], acneY: [-0.55, 0.6],
          spotX: [-0.55, 0.55], spotY: [-0.35, 0.28], spotMinAbsX: 0.16,
          scarX: [-0.5, 0.5], scarY: [-0.45, 0.12], scarMinAbsX: 0.14,
          lineForeheadX: [-0.42, 0.42], lineForeheadY: [0.24, 0.52],
          lineCornerX: [0.24, 0.5], lineCornerY: [0.0, 0.16],
          redPatches: [[-0.4, -0.08], [0.4, -0.08], [0, -0.05], [-0.3, 0.14], [0.3, 0.14]],
          redSize: [0.34, 0.30],
          eyeCenters: [],
        };
    // keep blemishes off the eyes themselves — the procedural head's socket
    // geometry naturally discourages this, but the real scan's eye area is a
    // normal continuous surface so it needs an explicit exclusion
    const nearEye = (h) => P.eyeCenters.some(([ex, ey]) => Math.abs(h.point.x - ex) < 0.13 && Math.abs(h.point.y - ey) < 0.09);

    this.acnePool = [];
    for (let i = 0; i < 26; i++) {
      const h = this.faceHit(P.acneX, P.acneY); if (!h || nearEye(h)) continue;
      const r = 0.022 + Math.random() * 0.016;
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 12), new THREE.MeshStandardMaterial({ color: 0xc85b4e, roughness: 0.5, emissive: 0x5a1712, emissiveIntensity: 0.25 }));
      m.position.copy(h.point).addScaledVector(h.normal, r * 0.5); m.scale.setScalar(0.001); m.visible = false;
      this.featGroup.add(m); this.acnePool.push(m);
    }
    this.spotPool = [];
    for (let i = 0; i < 16; i++) {
      const h = this.faceHit(P.spotX, P.spotY); if (!h || nearEye(h)) continue;
      if (Math.abs(h.point.x) < P.spotMinAbsX) continue;
      const s = 0.09 + Math.random() * 0.07;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshBasicMaterial({ map: this.soft, transparent: true, color: 0x8a5636, opacity: 0, depthWrite: false }));
      orient(m, h); m.visible = false; this.featGroup.add(m); this.spotPool.push(m);
    }
    this.scarPool = [];
    for (let i = 0; i < 12; i++) {
      const h = this.faceHit(P.scarX, P.scarY); if (!h) continue;
      if (Math.abs(h.point.x) < P.scarMinAbsX) continue;
      const s = 0.05 + Math.random() * 0.04;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshBasicMaterial({ map: this.soft, transparent: true, color: 0x7c4a38, opacity: 0, depthWrite: false }));
      orient(m, h); m.visible = false; this.featGroup.add(m); this.scarPool.push(m);
    }
    this.linePool = [];
    for (let i = 0; i < 8; i++) {
      const h = i < 5 ? this.faceHit(P.lineForeheadX, P.lineForeheadY) : this.faceHit(P.lineCornerX, P.lineCornerY);
      if (!h) continue;
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.008, 0.004), new THREE.MeshBasicMaterial({ color: 0x6e4c38, transparent: true, opacity: 0 }));
      m.position.copy(h.point).addScaledVector(h.normal, 0.004); m.lookAt(h.point.clone().add(h.normal));
      m.rotateZ(Math.random() * 0.5 - 0.25); m.visible = false; this.featGroup.add(m); this.linePool.push(m);
    }
    this.redPool = [];
    for (const [rx, ry] of P.redPatches) {
      const h = this.faceHit([rx - 0.06, rx + 0.06], [ry - 0.06, ry + 0.06], 60); if (!h) continue;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(P.redSize[0], P.redSize[1]), new THREE.MeshBasicMaterial({ map: this.soft, transparent: true, color: 0xd06a5a, opacity: 0, depthWrite: false }));
      orient(m, h); m.visible = false; this.featGroup.add(m); this.redPool.push(m);
    }
  }

  poolUpdate(pool, count, maxOp) {
    for (let i = 0; i < pool.length; i++) {
      const f = Math.max(0, Math.min(1, count - i));
      const m = pool[i];
      if (f <= 0.001) { m.visible = false; continue; }
      m.visible = true;
      if (m.geometry.type === 'SphereGeometry') m.scale.setScalar(0.4 + 0.6 * f);
      else { m.material.opacity = maxOp * f; m.scale.setScalar(0.6 + 0.4 * f); }
    }
  }

  applySheen() {
    const w = this.wet || 0;
    this.headMat.roughness = Math.max(0.07, (this.curRough ?? 0.55) - w * 0.42);
    this.headMat.clearcoat = Math.min(1, (this.curClear ?? 0.3) + w * 0.55);
  }

  // full state = { skinType, conditions, ingredient, months, poured }
  sync(state, computeState) {
    this.lastState = state;
    if (!this.threeReady) return;
    const eff = state.poured ? state.months : 0;
    const v = computeState({ skinType: state.skinType, conditions: state.conditions, ingredient: state.ingredient }, eff);
    // the procedural head has a flat base material color to tint; the real
    // scan already has its true tone baked into its texture, so tint from
    // white (no-op at baseline) instead of overwriting its natural color
    const base = this.usingRealModel ? [255, 255, 255] : [233, 196, 168];
    const rednessTarget = this.usingRealModel ? [255, 120, 105] : [214, 120, 104];
    const dullTarget = this.usingRealModel ? [220, 206, 194] : [198, 183, 170];
    const rednessStrength = this.usingRealModel ? 0.9 : 0.6;
    let col = this.lerp3(base, rednessTarget, Math.min(1, (v.redness - 15) / 70) * rednessStrength);
    col = this.lerp3(col, dullTarget, Math.min(1, (60 - v.hydration) / 60) * 0.18);
    this.headMat.color.setRGB(col[0] / 255, col[1] / 255, col[2] / 255);
    this.curRough = Math.max(0.12, Math.min(0.9, 0.82 - v.sebum / 170 - v.glow * 0.12 - v.hydration / 650));
    this.curClear = Math.max(0, Math.min(1, v.sebum / 130 + v.glow * 0.25));
    this.applySheen();
    this.poolUpdate(this.acnePool, v.acne, 1);
    this.poolUpdate(this.spotPool, v.pigment / 11, Math.min(1, v.pigment / 85));
    this.poolUpdate(this.scarPool, v.scars / 14, Math.min(1, v.scars / 80) * 0.65);
    this.poolUpdate(this.linePool, v.lines / 16, Math.min(1, v.lines / 78) * 0.85);
    const redOpacityMax = this.usingRealModel ? 0.6 : 0.42;
    for (const m of this.redPool) { const o = Math.min(1, (v.redness - 22) / 70) * redOpacityMax; m.visible = o > 0.01; m.material.opacity = o; }
  }

  async initThree() {
    const w = this.mount.clientWidth || 800, h = this.mount.clientHeight || 600;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, w / h, 0.1, 100);
    this.camera.position.set(2.3, 1.0, 6.4);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setSize(w, h); this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.mount.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0.05, 0);
    this.controls.minDistance = 2.0; this.controls.maxDistance = 7.5;
    this.controls.minPolarAngle = Math.PI * 0.14; this.controls.maxPolarAngle = Math.PI * 0.82;

    this.scene.add(new THREE.HemisphereLight(0xfff3e6, 0x6b563f, 0.5));
    const key = new THREE.DirectionalLight(0xfff4ea, 1.2); key.position.set(-2.4, 2.8, 2.6); this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffe6cf, 0.3); fill.position.set(3, 0.3, 1.8); this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffdcc4, 0.7); rim.position.set(2, 1.8, -3); this.scene.add(rim);

    const realMesh = await this.loadFaceModel();
    if (realMesh) {
      this.headMesh = realMesh;
      this.usingRealModel = true;
      this.headYOffset = 0;
      const box = new THREE.Box3().setFromObject(realMesh);
      this.buildPedestal(box.min.y, false);
      this.controls.target.set(0, 0.12, 0);
    } else {
      this.buildProceduralHead();
      this.usingRealModel = false;
      this.buildPedestal(-0.86, true);
      this.buildEyes();
      this.buildEars();
    }
    this.buildFeatures();
    this.pourGroup = new THREE.Group(); this.scene.add(this.pourGroup);
    this.droplets = []; this.splats = []; this.wet = 0;
    this.clock = new THREE.Clock();
    this.threeReady = true;
    this.onReady();

    this._ro = new ResizeObserver(() => {
      const ww = this.mount.clientWidth, hh = this.mount.clientHeight;
      if (!ww || !hh) return;
      this.camera.aspect = ww / hh; this.camera.updateProjectionMatrix(); this.renderer.setSize(ww, hh);
    });
    this._ro.observe(this.mount);
    this.animate();
  }

  clearPour() {
    if (!this.pourGroup) return;
    while (this.pourGroup.children.length) {
      const c = this.pourGroup.children.pop();
      if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose();
      this.pourGroup.remove(c);
    }
    this.droplets = []; this.splats = [];
  }

  pour(ingredientKey) {
    if (!this.threeReady || this.pouring) return;
    this.clearPour();
    const tint = new THREE.Color(ING[ingredientKey].color);
    const N = 32;
    for (let i = 0; i < N; i++) {
      const land = this.pourHit();
      if (!land) continue;
      const r = 0.02 + Math.random() * 0.03;
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 12),
        new THREE.MeshPhysicalMaterial({ color: tint, roughness: 0.12, metalness: 0, transmission: 0.5, transparent: true, opacity: 0.92, ior: 1.4 }));
      m.position.set(land.point.x + (Math.random() - 0.5) * 0.05, 1.7 + Math.random() * 0.9, land.point.z + (Math.random() - 0.5) * 0.05);
      m.visible = false;
      this.pourGroup.add(m);
      this.droplets.push({ mesh: m, vy: 0, landY: land.point.y + r * 0.4, point: land.point, normal: land.normal, delay: i * 0.05, landed: false });
    }
    this.pourElapsed = 0; this.pourTint = tint; this.pouring = true;
    this.onPourTick({ pouring: true, poured: false, months: 0, playing: false });
  }

  spawnSplat(point, normal, tint) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.soft, transparent: true, color: tint, opacity: 0.85, depthWrite: false }));
    m.position.copy(point).addScaledVector(normal, 0.008); m.lookAt(point.clone().add(normal));
    m.scale.setScalar(0.02); this.pourGroup.add(m);
    this.splats.push({ mesh: m, t: 0 });
  }

  finishPour() {
    this.pouring = false; this.wet = 1;
    this.playing = true; this.playT = 0;
    this.onPourTick({ pouring: false, poured: true, months: 0, playing: true });
  }

  stepPour(dt) {
    if (!this.droplets.length && !this.splats.length && !this.pouring) return;
    this.pourElapsed += dt;
    let remaining = 0;
    for (const d of this.droplets) {
      if (this.pourElapsed < d.delay) { remaining++; continue; }
      if (d.landed) continue;
      d.mesh.visible = true;
      d.vy -= 5.0 * dt; d.mesh.position.y += d.vy * dt;
      if (d.mesh.position.y <= d.landY) {
        d.mesh.position.y = d.landY; d.landed = true; d.mesh.visible = false;
        this.spawnSplat(d.point, d.normal, this.pourTint);
      } else remaining++;
    }
    for (let i = this.splats.length - 1; i >= 0; i--) {
      const s = this.splats[i]; s.t += dt;
      const k = s.t / 0.7;
      s.mesh.scale.setScalar(0.02 + k * 0.16);
      s.mesh.material.opacity = Math.max(0, 0.85 * (1 - k));
      if (k >= 1) { s.mesh.geometry.dispose(); s.mesh.material.dispose(); this.pourGroup.remove(s.mesh); this.splats.splice(i, 1); }
    }
    if (this.pouring && remaining === 0 && this.pourElapsed > 0.8) this.finishPour();
  }

  animate() {
    this._raf = requestAnimationFrame(() => this.animate());
    const dt = Math.min(0.05, this.clock.getDelta());
    this.controls.update();
    this.stepPour(dt);
    if (this.wet > 0) { this.wet = Math.max(0, this.wet - dt / 2.5); this.applySheen(); }
    if (this.playing && this.lastState && this.lastState.poured) {
      this.playT = (this.playT || 0) + dt * (6 / 7);
      let mo = this.playT;
      if (mo >= 6) { mo = 6; this.playing = false; this.onPourTick({ months: 6, playing: false }); }
      else this.onPourTick({ months: mo });
    }
    this.renderer.render(this.scene, this.camera);
  }
}
