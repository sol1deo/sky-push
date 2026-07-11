/* =============================================================================
 * SKY PUSH — human characters (stylized, PEAK-ish)
 * Two visual layers per player, built from the same simple shapes:
 *   FK puppet  — jointed body driven by procedural animation (run, aim, jump,
 *                slide, taunt) and holding its weapon in third person.
 *   Ragdoll    — an 11-particle verlet skeleton with stick constraints and
 *                world collision. Headshots and airborne hits swap the FK
 *                puppet for the ragdoll, then blend back on recovery.
 * Everything is code-built: no downloads, works from file://.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.Characters = (function () {
  const SKINS = ['#f2c49b', '#8d5a3a', '#e8b08c', '#6b4630', '#f7d7b0', '#a06a42'];
  const PANTS = ['#2c3654', '#3a3140', '#274236', '#40303c', '#2d3a52'];
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const _q = new THREE.Quaternion();

  function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function lam(c) { return new THREE.MeshLambertMaterial({ color: c }); }

  // particle indices
  const HEAD = 0, CHEST = 1, PELV = 2, ELBL = 3, HANDL = 4, ELBR = 5, HANDR = 6,
        KNEL = 7, FOOTL = 8, KNER = 9, FOOTR = 10;

  class Avatar {
    constructor(pawn, scene) {
      this.pawn = pawn;
      this.scene = scene;
      const h = hash(pawn.name);
      this.skinMat = lam(SKINS[h % SKINS.length]);
      this.jacketMat = lam(pawn.color);
      this.pantsMat = lam(PANTS[h % PANTS.length]);
      this.darkMat = lam(new THREE.Color(pawn.color).multiplyScalar(0.55));
      this.shoeMat = lam('#e8e8ee');

      this.facingYaw = 0; this.facingVel = 0;
      this.phase = 0; this.emoteT = 0; this.armSpin = 0;
      this.gunKind = null;
      this.ragActive = false;
      this.standupT = 0;

      // rigged GLTF character (Quaternius) when the asset pack has loaded;
      // the primitive FK puppet below remains the file:// fallback
      this.isGltf = false;
      if (SKY.GFX && SKY.GFX.charReady()) {
        try { this._buildGltfPuppet(h); this.isGltf = true; } catch (e) {}
      }
      if (!this.isGltf) this._buildPuppet();
      this._buildRagdollProxy();

      this.root.visible = !pawn.isLocal;
      this.proxyRoot.visible = false;
      if (!pawn.isLocal) {
        this.nameSpr = SKY.U.makeTextSprite(pawn.name, { color: '#ffffff', px: 40, scale: 0.009 });
        scene.add(this.nameSpr);
      }
    }

    /* ==================== FK puppet ==================== */
    _buildPuppet() {
      const root = new THREE.Group();
      root.rotation.order = 'YXZ';
      this.scene.add(root);
      this.root = root;

      const cap = (r, l, mat) => {
        const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, l, 4, 8), mat);
        m.castShadow = true;
        return m;
      };
      const box = (x, y, z, mat) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(x, y, z), mat);
        m.castShadow = true;
        return m;
      };

      // hips + pelvis
      const hips = new THREE.Group();
      hips.position.set(0, 0.94, 0);
      const pelvis = box(0.36, 0.2, 0.24, this.pantsMat);
      pelvis.position.y = -0.02;
      hips.add(pelvis);
      root.add(hips);

      // torso (jacket)
      const torso = new THREE.Group();
      torso.position.set(0, 0.1, 0);
      const jacket = box(0.42, 0.5, 0.26, this.jacketMat);
      jacket.position.y = 0.3;
      const zipper = box(0.05, 0.44, 0.02, this.darkMat);
      zipper.position.set(0, 0.29, -0.135);
      torso.add(jacket, zipper);
      hips.add(torso);

      // head + beanie + face
      const head = new THREE.Group();
      head.position.set(0, 0.66, 0);
      const skull = new THREE.Mesh(new THREE.SphereGeometry(0.165, 14, 12), this.skinMat);
      skull.castShadow = true;
      const beanie = new THREE.Mesh(
        new THREE.SphereGeometry(0.175, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), this.darkMat);
      beanie.position.y = 0.03;
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.178, 0.178, 0.05, 12), this.darkMat);
      brim.position.y = 0.045;
      const eyeMat = lam('#1b2233');
      for (const sx of [0.06, -0.06]) {
        const e = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 6), eyeMat);
        e.position.set(sx, 0.02, -0.15);
        head.add(e);
      }
      head.add(skull, beanie, brim);
      torso.add(head);

      // arms: shoulder group -> upper arm mesh, elbow group -> forearm + hand
      const mkArm = (side) => {
        const sh = new THREE.Group();
        sh.position.set(0.27 * side, 0.5, 0);
        const upper = cap(0.062, 0.2, this.jacketMat);
        upper.position.y = -0.15;
        sh.add(upper);
        const elb = new THREE.Group();
        elb.position.set(0, -0.3, 0);
        const fore = cap(0.055, 0.18, this.skinMat);
        fore.position.y = -0.13;
        const hand = new THREE.Mesh(new THREE.SphereGeometry(0.068, 8, 8), this.skinMat);
        hand.position.y = -0.27;
        hand.castShadow = true;
        elb.add(fore, hand);
        sh.add(elb);
        torso.add(sh);
        return { sh, elb };
      };
      this.armL = mkArm(1);
      this.armR = mkArm(-1);

      // legs: hip group -> thigh, knee group -> shin + shoe
      const mkLeg = (side) => {
        const hip = new THREE.Group();
        hip.position.set(0.115 * side, -0.1, 0);
        const thigh = cap(0.075, 0.22, this.pantsMat);
        thigh.position.y = -0.17;
        hip.add(thigh);
        const knee = new THREE.Group();
        knee.position.set(0, -0.36, 0);
        const shin = cap(0.062, 0.2, this.pantsMat);
        shin.position.y = -0.14;
        const shoe = box(0.13, 0.09, 0.24, this.shoeMat);
        shoe.position.set(0, -0.31, -0.04);
        knee.add(shin, shoe);
        hip.add(knee);
        hips.add(hip);
        return { hip, knee };
      };
      this.legL = mkLeg(1);
      this.legR = mkLeg(-1);

      this.hips = hips; this.torso = torso; this.head = head;

      // third-person gun in the right hand (arm points -Z when raised, so the
      // barrel needs -90° about X to align with the forearm)
      this.gunHolder = new THREE.Group();
      this.gunHolder.position.set(0, -0.28, -0.02);
      this.gunHolder.rotation.x = -Math.PI / 2;
      this.armR.elb.add(this.gunHolder);

      // ragdoll seed markers (world positions read at ragdoll start)
      const mark = (parent, x, y, z) => {
        const o = new THREE.Object3D();
        o.position.set(x, y, z);
        parent.add(o);
        return o;
      };
      this.markers = {
        head: mark(head, 0, 0, 0),
        chest: mark(torso, 0, 0.42, 0),
        pelvis: mark(hips, 0, 0, 0),
        elbL: this.armL.elb, handL: mark(this.armL.elb, 0, -0.27, 0),
        elbR: this.armR.elb, handR: mark(this.armR.elb, 0, -0.27, 0),
        kneL: this.legL.knee, footL: mark(this.legL.knee, 0, -0.32, 0),
        kneR: this.legR.knee, footR: mark(this.legR.knee, 0, -0.32, 0),
      };
    }

    /* ==================== rigged GLTF puppet ==================== */
    _buildGltfPuppet(h) {
      const inst = SKY.GFX.charInstance(h);
      if (!inst) throw new Error('char not ready');
      const root = new THREE.Group();
      root.rotation.order = 'YXZ';
      this.scene.add(root);
      this.root = root;

      const model = new THREE.Group();
      model.add(inst.root);
      // UACP characters face +Z natively; game forward is -Z
      model.rotation.y = Math.PI;
      const k = 1.72 / inst.height;
      model.scale.setScalar(k);
      root.add(model);
      this.model = model;

      // player-color identity: recolor the outfit's main material
      const col = new THREE.Color(this.pawn.color);
      inst.root.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if ((m.name || '') === inst.tint) {
            m.color.copy(col).multiplyScalar(0.92);
            m.emissive = col.clone().multiplyScalar(0.1);
          }
        }
      });

      // GLTFLoader sanitizes node names ('Fist.R' -> 'FistR') — try both
      const bone = (name) => inst.root.getObjectByName(name) ||
        inst.root.getObjectByName(name.replace(/\./g, ''));
      this.bTorso = bone('Torso');
      this.bHead = bone('Head');
      this.bHandR = bone('Fist.R');

      // third-person gun in the right fist (orientation measured on the rig)
      this.gunHolder = new THREE.Group();
      this.gunHolder.rotation.set(Math.PI / 2, 0, 0);
      this.gunHolder.position.set(0, 0.05, 0.02);
      this.gunHolder.scale.setScalar(1 / k);   // undo model scale so guns keep world size
      if (this.bHandR) this.bHandR.add(this.gunHolder);

      // ragdoll seed markers = actual bones
      this.markers = {
        head: this.bHead || root, chest: this.bTorso || root, pelvis: bone('Hips') || root,
        elbL: bone('LowerArm.L') || root, handL: bone('Fist.L') || root,
        elbR: bone('LowerArm.R') || root, handR: this.bHandR || root,
        kneL: bone('LowerLeg.L') || root, footL: bone('Foot.L') || root,
        kneR: bone('LowerLeg.R') || root, footR: bone('Foot.R') || root,
      };

      // animation set — every UACP character carries its own clips
      this.mixer = new THREE.AnimationMixer(inst.root);
      const clipOf = (name) => {
        for (const c of inst.clips) if (c.name === name) return c;
        return null;
      };
      const act = (clipName) => {
        const clip = clipOf(clipName);
        if (!clip) return null;
        const a = this.mixer.clipAction(clip);
        a.play();
        a.setEffectiveWeight(0);
        return a;
      };
      this.acts = {
        idle: act('Idle'),
        run: act('Run'),
        air: act('Jump'),
        slide: act('Roll'),
        dance: act('Victory'),
      };
      if (this.acts.idle) this.acts.idle.setEffectiveWeight(1);
      // air = Jump held near its apex; slide = Roll frozen in the tuck
      if (this.acts.air) {
        this.airApex = this.acts.air.getClip().duration * 0.45;
        this.acts.air.setLoop(THREE.LoopOnce);
        this.acts.air.clampWhenFinished = true;
      }
      if (this.acts.slide) {
        this.slideTuck = this.acts.slide.getClip().duration * 0.3;
        this.acts.slide.setLoop(THREE.LoopOnce);
        this.acts.slide.clampWhenFinished = true;
      }
      this.wasGrounded = true;
    }

    _animGltf(dt) {
      const p = this.pawn;
      const spd = p.speedH();
      const A = this.acts;

      if (!p.grounded && this.wasGrounded && A.air) A.air.reset().play();
      this.wasGrounded = p.grounded;

      // pick the dominant locomotion state
      let want = 'idle';
      if (this.emoteT > 0) { this.emoteT -= dt; want = 'dance'; }
      else if (p.sliding) want = 'slide';
      else if (!p.grounded) want = 'air';
      else if (spd > 0.6) want = 'run';

      for (const key in A) {
        const a = A[key];
        if (!a) continue;
        const target = key === want ? 1 : 0;
        const w = a.getEffectiveWeight();
        a.setEffectiveWeight(w + (target - w) * Math.min(1, 10 * dt));
      }
      // stride speed follows actual velocity
      if (A.run) A.run.timeScale = SKY.U.clamp(spd / 5.5, 0.7, 2.1);
      // hold poses: Jump pauses at its apex, Roll freezes in the tuck
      if (A.air && A.air.time > this.airApex && !p.grounded) A.air.time = this.airApex;
      if (A.slide && A.slide.time > this.slideTuck) A.slide.time = this.slideTuck;

      this.mixer.update(dt);

      // aim pitch layered on top of whatever the mixer posed
      const pitch = SKY.U.clamp(p.pitch, -1.2, 1.2);
      if (this.bTorso) this.bTorso.rotation.x += pitch * 0.4;
      if (this.bHead) this.bHead.rotation.x += pitch * 0.35;
    }

    setWeapon(kind) {
      if (this.gunKind === kind) return;
      this.gunKind = kind;
      while (this.gunHolder.children.length) this.gunHolder.remove(this.gunHolder.children[0]);
      while (this.proxyGunHolder.children.length) this.proxyGunHolder.remove(this.proxyGunHolder.children[0]);
      const g1 = SKY.Effects.buildWeaponMesh(kind);
      g1.scale.setScalar(this.isGltf ? 1.05 : 1.25);
      this.gunHolder.add(g1);
      const g2 = SKY.Effects.buildWeaponMesh(kind);
      g2.scale.setScalar(1.25);
      g2.rotation.x = Math.PI / 2;   // proxy forearm's +Y points at the hand
      g2.position.y = 0.25;
      this.proxyGunHolder.add(g2);
    }

    /* ==================== ragdoll ==================== */
    _buildRagdollProxy() {
      const pr = new THREE.Group();
      this.scene.add(pr);
      this.proxyRoot = pr;
      const seg = (r, l, mat) => {
        const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, l, 4, 8), mat);
        m.castShadow = true;
        pr.add(m);
        return { mesh: m, rest: l + r * 2 };
      };
      this.pTorso = seg(0.17, 0.34, this.jacketMat);
      this.pUpArmL = seg(0.06, 0.2, this.jacketMat);
      this.pFoArmL = seg(0.055, 0.2, this.skinMat);
      this.pUpArmR = seg(0.06, 0.2, this.jacketMat);
      this.pFoArmR = seg(0.055, 0.2, this.skinMat);
      this.pThighL = seg(0.075, 0.24, this.pantsMat);
      this.pShinL = seg(0.062, 0.24, this.pantsMat);
      this.pThighR = seg(0.075, 0.24, this.pantsMat);
      this.pShinR = seg(0.062, 0.24, this.pantsMat);
      // head proxy
      const hg = new THREE.Group();
      const skull = new THREE.Mesh(new THREE.SphereGeometry(0.165, 12, 10), this.skinMat);
      skull.castShadow = true;
      const beanie = new THREE.Mesh(
        new THREE.SphereGeometry(0.175, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), this.darkMat);
      beanie.position.y = 0.03;
      hg.add(skull, beanie);
      pr.add(hg);
      this.pHead = hg;
      // gun stays in the right hand while ragdolling (cinema!)
      this.proxyGunHolder = new THREE.Group();
      this.pFoArmR.mesh.add(this.proxyGunHolder);

      // verlet state
      this.pts = []; this.prev = [];
      for (let i = 0; i < 11; i++) { this.pts.push(new THREE.Vector3()); this.prev.push(new THREE.Vector3()); }
      this.sticks = [];  // filled at seed time with live rest lengths
    }

    startRagdoll() {
      const p = this.pawn;
      this.ragActive = true;
      this.root.visible = false;
      this.proxyRoot.visible = !p.isLocal;
      this.root.updateMatrixWorld(true);
      const M = this.markers;
      const seedFrom = [M.head, M.chest, M.pelvis, M.elbL, M.handL, M.elbR, M.handR,
                        M.kneL, M.footL, M.kneR, M.footR];
      const dt0 = 1 / 60;
      for (let i = 0; i < 11; i++) {
        seedFrom[i].getWorldPosition(this.pts[i]);
        // inherit body velocity + the hit impulse + a little chaos
        this.prev[i].copy(this.pts[i])
          .addScaledVector(p.vel, -dt0)
          .addScaledVector(p.ragdollImpulse, -dt0 * SKY.U.rand(0.5, 1.4));
        this.prev[i].x += SKY.U.rand(-0.01, 0.01);
        this.prev[i].z += SKY.U.rand(-0.01, 0.01);
      }
      // sticks: [a, b, rest, stiffness]
      const S = (a, b, k) => this.sticks.push([a, b, this.pts[a].distanceTo(this.pts[b]), k || 1]);
      this.sticks.length = 0;
      S(HEAD, CHEST); S(CHEST, PELV);
      S(CHEST, ELBL); S(ELBL, HANDL); S(CHEST, ELBR); S(ELBR, HANDR);
      S(PELV, KNEL); S(KNEL, FOOTL); S(PELV, KNER); S(KNER, FOOTR);
      S(HEAD, PELV, 0.5); S(KNEL, KNER, 0.4); S(ELBL, ELBR, 0.3);
    }

    endRagdoll() {
      this.ragActive = false;
      this.proxyRoot.visible = false;
      this.root.visible = !this.pawn.isLocal;
      // stand-up illusion: come back crouched and rise
      this.facingYaw = this.pawn.yaw; this.facingVel = 0;
      this.root.scale.y = 0.45;
      this.standupT = SKY.TUNING.ragdoll.standupTime;
    }

    _stepRagdoll(dt) {
      const R = SKY.TUNING.ragdoll;
      dt = Math.min(dt, 1 / 30);
      const p = this.pawn;
      const g = SKY.TUNING.move.gravity * 0.9 * dt * dt;
      for (let i = 0; i < 11; i++) {
        const pt = this.pts[i], pv = this.prev[i];
        const vx = (pt.x - pv.x) * R.damping, vy = (pt.y - pv.y) * R.damping, vz = (pt.z - pv.z) * R.damping;
        pv.copy(pt);
        pt.x += vx; pt.y += vy - g; pt.z += vz;
      }
      // weak pull so the visual body tracks the gameplay capsule
      _v.set(p.pos.x, p.pos.y + 0.9, p.pos.z);
      const pull = Math.min(1, 2.5 * dt);
      this.pts[PELV].lerp(_v, pull);
      this.pts[CHEST].lerp(_v2.set(p.pos.x, p.pos.y + 1.2, p.pos.z), pull * 0.7);

      for (let iter = 0; iter < 3; iter++) {
        for (const [a, b, rest, k] of this.sticks) {
          const A = this.pts[a], B = this.pts[b];
          _v.copy(B).sub(A);
          const d = _v.length() || 1e-6;
          const corr = (d - rest) / d * 0.5 * k;
          A.addScaledVector(_v, corr);
          B.addScaledVector(_v, -corr);
        }
      }
      for (let i = 0; i < 11; i++) {
        const r = i === HEAD ? 0.15 : 0.08;
        if (SKY.World.collidePoint(this.pts[i], r)) {
          // ground friction
          const pv = this.prev[i], pt = this.pts[i];
          pv.x = pt.x - (pt.x - pv.x) * (1 - R.friction);
          pv.z = pt.z - (pt.z - pv.z) * (1 - R.friction);
        }
      }
      this._poseProxy();
    }

    _poseProxy() {
      const P = this.pts;
      // torso frame (for shoulder / hip offsets)
      _v.copy(P[CHEST]).sub(P[PELV]).normalize();          // up
      _v2.set(-Math.sin(this.pawn.yaw), 0, -Math.cos(this.pawn.yaw));
      const right = _v2.cross(_v).normalize();             // right-ish
      const shL = P[CHEST].clone().addScaledVector(right, 0.22);
      const shR = P[CHEST].clone().addScaledVector(right, -0.22);
      const hipL = P[PELV].clone().addScaledVector(right, 0.11);
      const hipR = P[PELV].clone().addScaledVector(right, -0.11);

      this._seg(this.pTorso, P[PELV], P[CHEST]);
      this._seg(this.pUpArmL, shL, P[ELBL]);
      this._seg(this.pFoArmL, P[ELBL], P[HANDL]);
      this._seg(this.pUpArmR, shR, P[ELBR]);
      this._seg(this.pFoArmR, P[ELBR], P[HANDR]);
      this._seg(this.pThighL, hipL, P[KNEL]);
      this._seg(this.pShinL, P[KNEL], P[FOOTL]);
      this._seg(this.pThighR, hipR, P[KNER]);
      this._seg(this.pShinR, P[KNER], P[FOOTR]);
      // head
      this.pHead.position.copy(P[HEAD]);
      _v.copy(P[HEAD]).sub(P[CHEST]).normalize();
      this.pHead.quaternion.setFromUnitVectors(_up, _v);
    }

    _seg(s, A, B) {
      s.mesh.position.copy(A).add(B).multiplyScalar(0.5);
      _v.copy(B).sub(A);
      const len = _v.length() || 1e-6;
      s.mesh.quaternion.setFromUnitVectors(_up, _v.multiplyScalar(1 / len));
      s.mesh.scale.y = SKY.U.clamp(len / s.rest, 0.6, 1.4);
    }

    /* world position of the held gun's barrel tip (bullet spawn point).
       Returns null when there's no gun yet (or for the hidden local puppet). */
    gunTipWorld(out) {
      const holder = this.ragActive ? this.proxyGunHolder : this.gunHolder;
      const gun = holder.children[0];
      if (!gun) return null;
      const tip = gun.getObjectByName('tip');
      if (!tip) return null;
      return tip.getWorldPosition(out);
    }

    /* ==================== per-frame ==================== */
    playEmote() { this.emoteT = 1.25; }

    update(dt) {
      const p = this.pawn;
      if (this.nameSpr) {
        this.nameSpr.visible = p.alive;
        const ny = this.ragActive ? this.pts[CHEST].y + 0.8 : p.pos.y + p.height + 0.55;
        const nx = this.ragActive ? this.pts[CHEST].x : p.pos.x;
        const nz = this.ragActive ? this.pts[CHEST].z : p.pos.z;
        this.nameSpr.position.set(nx, ny, nz);
      }
      if (!p.alive) {
        this.root.visible = false;
        this.proxyRoot.visible = false;
        this.ragActive = false;
        return;
      }
      if (p.weapon !== this.gunKind) this.setWeapon(p.weapon);

      if (p.ragdoll) {
        if (!this.ragActive) this.startRagdoll();
        this._stepRagdoll(dt);
        return;
      }
      if (this.ragActive) this.endRagdoll();
      if (p.isLocal) return;
      this.root.visible = true;

      const root = this.root;
      root.position.copy(p.pos);

      // stand-up rise + crouch squash (the rigged model has a real slide
      // pose, so it only uses the scale for the stand-up rise)
      this.standupT = Math.max(0, this.standupT - dt);
      const squash = this.isGltf ? 1 : p.height / SKY.TUNING.move.standHeight;
      root.scale.y = SKY.U.damp(root.scale.y, squash, this.standupT > 0 ? 6 : 14, dt);

      const spd = p.speedH();
      const tumbling = !p.grounded && p.tumbleVel.lengthSq() > 0.1;
      if (tumbling) {
        root.rotation.x += p.tumbleVel.x * dt;
        root.rotation.z += p.tumbleVel.z * dt;
        root.rotation.y += p.tumbleVel.y * dt;
      } else {
        const err = SKY.U.angDelta(this.facingYaw, p.yaw);
        this.facingVel += err * 55 * dt;
        this.facingVel -= this.facingVel * 7 * dt;
        this.facingYaw += this.facingVel * dt;
        root.rotation.y = this.facingYaw;
        root.rotation.x = SKY.U.damp(root.rotation.x, 0, 10, dt);
        root.rotation.z = SKY.U.damp(root.rotation.z, 0, 10, dt);
      }

      if (this.isGltf) { this._animGltf(dt); return; }

      // torso lean into motion + aim pitch on the head
      // (+rotation.x on a limb hanging along -Y swings it FORWARD, toward -Z)
      const fx = -Math.sin(this.facingYaw), fz = -Math.cos(this.facingYaw);
      const fwdSpd = p.vel.x * fx + p.vel.z * fz;
      this.torso.rotation.x = SKY.U.damp(this.torso.rotation.x,
        p.sliding ? 0.4 : SKY.U.clamp(-fwdSpd * 0.018, -0.3, 0.3), 8, dt);
      this.head.rotation.x = SKY.U.damp(this.head.rotation.x, p.pitch * 0.55, 10, dt);

      // ---- legs ----
      const L = this.legL, Rr = this.legR;
      if (p.sliding) {
        L.hip.rotation.x = SKY.U.damp(L.hip.rotation.x, 1.15, 10, dt);
        Rr.hip.rotation.x = SKY.U.damp(Rr.hip.rotation.x, 0.9, 10, dt);
        L.knee.rotation.x = Rr.knee.rotation.x = -0.3;
      } else if (p.grounded) {
        this.phase += dt * spd * 1.8;
        const swing = Math.sin(this.phase) * SKY.U.clamp(spd * 0.1, 0, 0.9);
        L.hip.rotation.x = swing;
        Rr.hip.rotation.x = -swing;
        L.knee.rotation.x = -Math.max(0, -Math.sin(this.phase - 0.6)) * 0.9;
        Rr.knee.rotation.x = -Math.max(0, Math.sin(this.phase - 0.6)) * 0.9;
      } else {
        L.hip.rotation.x = SKY.U.damp(L.hip.rotation.x, 0.55, 8, dt);
        Rr.hip.rotation.x = SKY.U.damp(Rr.hip.rotation.x, -0.25, 8, dt);
        L.knee.rotation.x = SKY.U.damp(L.knee.rotation.x, -0.9, 8, dt);
        Rr.knee.rotation.x = SKY.U.damp(Rr.knee.rotation.x, -0.5, 8, dt);
      }

      // ---- arms: right holds the gun along the aim, left supports/flails ----
      const aR = this.armR, aL = this.armL;
      aR.sh.rotation.x = SKY.U.damp(aR.sh.rotation.x, 1.5 + p.pitch * 0.85, 12, dt);
      aR.sh.rotation.y = SKY.U.damp(aR.sh.rotation.y, 0.12, 12, dt);
      aR.elb.rotation.x = SKY.U.damp(aR.elb.rotation.x, -0.15, 12, dt);

      if (this.emoteT > 0) {                       // taunt: big wave
        this.emoteT -= dt;
        aL.sh.rotation.x = 2.7 + Math.sin(performance.now() * 0.012) * 0.45;
        aL.sh.rotation.y = -0.2;
        aL.elb.rotation.x = 0.4;
        this.head.rotation.x = Math.sin(performance.now() * 0.016) * 0.2;
      } else if (!p.grounded && (p.vel.y < -14 || p.fellScreamed)) {
        this.armSpin += dt * 16;                   // panic windmill
        aL.sh.rotation.x = this.armSpin;
        aL.elb.rotation.x = 0.5;
      } else {
        aL.sh.rotation.x = SKY.U.damp(aL.sh.rotation.x % (Math.PI * 2), 1.25, 10, dt);
        aL.sh.rotation.y = SKY.U.damp(aL.sh.rotation.y, -0.5, 10, dt);
        aL.elb.rotation.x = SKY.U.damp(aL.elb.rotation.x, 0.5, 10, dt);
      }
    }

    dispose() {
      this.scene.remove(this.root);
      this.scene.remove(this.proxyRoot);
      if (this.nameSpr) this.scene.remove(this.nameSpr);
    }
  }

  return {
    init() { /* nothing to preload — characters are code-built */ },
    create(pawn, scene) { return new Avatar(pawn, scene); },
  };
})();
