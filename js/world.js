/* =============================================================================
 * SKY PUSH — collision world
 * All level geometry is oriented boxes (OBBs) so ramps/banked surfaces are just
 * rotated boxes. Pawns are resolved as stacked spheres (a poor man's capsule),
 * which is plenty robust for greybox and gives correct slope normals.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.World = (function () {
  const _v = new THREE.Vector3();
  const _d = new THREE.Vector3();
  const _q = new THREE.Vector3();
  const _n = new THREE.Vector3();

  const api = {
    solids: [],        // static + moving collision boxes
    movers: [],        // subset of solids with a path function
    pads: [],          // jump pad triggers
    spawnPoints: [],   // { pos: V3, yaw }
    roamPoints: [],    // V3 targets bots wander between
    recoveryAnchors: [], // V3 points bots aim grapples at when falling
    itemPoints: [],    // custom-map pickup spawn spots (empty = use roamPoints)
    vents: [],         // air-vent updraft columns { x,y,z, radius, height, force }
    waters: [],        // swimmable volumes { x,z, half, level, depth, opts }
    terrains: [],      // sculpted heightfields (see addTerrain)
    killY: -22,

    reset() {
      api.solids.length = 0; api.movers.length = 0; api.pads.length = 0;
      api.spawnPoints.length = 0; api.roamPoints.length = 0; api.recoveryAnchors.length = 0;
      api.itemPoints.length = 0; api.vents.length = 0;
      api.waters.length = 0; api.terrains.length = 0;
      api.teamSpawns = { atk: [], def: [] };   // legacy (team maps)
      api.bombSites = [];                       // legacy (kept: map defs still set it)
    },

    /* ---------------- water volumes (fx:sea) ----------------
     * A square column under the sea surface: swim physics + the underwater
     * screen/audio treatment key off "is this point inside a water volume". */
    addWater(w) {
      const W = {
        x: w.x, z: w.z, half: w.half, level: w.level,
        depth: w.depth !== undefined ? w.depth : 60,   // how far down it stays water
        amp: w.amp || 0, kw: w.kw || 0,                // wave field (visual match)
        currents: w.currents || null,                  // seeded danger/escape jets
        opts: w.opts || {},
      };
      api.waters.push(W);
      return W;
    },
    /* the VISUAL wave height at (x,z) — same formula/clock the sea mesh
       animates with. Display-only (per-client clock): the camera's
       "am I underwater" test uses it; PHYSICS always uses the flat level
       so every peer simulates identically. */
    surfaceAt(w, x, z) {
      if (!w.amp || !w.kw) return w.level;
      const t = performance.now() * 0.0009;
      const lx = x - w.x, lz = z - w.z, kw = w.kw;
      const h =
        Math.sin(lx * kw + t * 1.9) * 0.55 +
        Math.sin(lz * kw * 0.8 + t * 1.4) * 0.3 +
        Math.sin((lx + lz) * kw * 0.45 - t * 2.3) * 0.35 +
        Math.sin(lx * kw * 2.3 - t * 3.1) * Math.sin(lz * kw * 2.1 + t * 2.6) * 0.14;
      return w.level + w.amp * h;
    },
    waterAt(x, y, z, waves) {
      for (const w of api.waters) {
        const top = waves ? api.surfaceAt(w, x, z) : w.level;
        if (y > top || y < w.level - w.depth) continue;
        if (Math.abs(x - w.x) > w.half || Math.abs(z - w.z) > w.half) continue;
        return w;
      }
      return null;
    },

    /* ---------------- sculpted terrain heightfields ----------------
     * grid: (segs+1)² heights over a size×size square centered on (x,z).
     * Pawns/ragdolls collide by height sample; raycast marches the ray.  */
    addTerrain(t) {
      const sx = t.sx !== undefined ? t.sx : t.size;
      const sz = t.sz !== undefined ? t.sz : t.size;
      const T = {
        x: t.x, z: t.z, sx, sz, segs: t.segs,
        cellX: sx / t.segs, cellZ: sz / t.segs,
        h: t.heights,               // Float32Array, row-major, (segs+1)²
        y: t.y || 0,                // base height offset
        mesh: t.mesh || null,
      };
      api.terrains.push(T);
      return T;
    },
    /* bilinear height at world (x,z) — -Infinity outside every terrain */
    terrainHeight(x, z) {
      let best = -Infinity;
      for (const T of api.terrains) {
        const lx = (x - T.x + T.sx / 2) / T.cellX;
        const lz = (z - T.z + T.sz / 2) / T.cellZ;
        if (lx < 0 || lz < 0 || lx > T.segs || lz > T.segs) continue;
        const ix = Math.min(T.segs - 1, Math.floor(lx));
        const iz = Math.min(T.segs - 1, Math.floor(lz));
        const fx = lx - ix, fz = lz - iz;
        const n = T.segs + 1;
        const h00 = T.h[iz * n + ix],     h10 = T.h[iz * n + ix + 1];
        const h01 = T.h[(iz + 1) * n + ix], h11 = T.h[(iz + 1) * n + ix + 1];
        const h = (h00 * (1 - fx) + h10 * fx) * (1 - fz) +
                  (h01 * (1 - fx) + h11 * fx) * fz;
        const y = T.y + h;
        if (y > best) best = y;
      }
      return best;
    },
    /* terrain surface normal from central differences */
    terrainNormal(x, z, out) {
      const e = 0.35;
      const hx1 = api.terrainHeight(x + e, z), hx0 = api.terrainHeight(x - e, z);
      const hz1 = api.terrainHeight(x, z + e), hz0 = api.terrainHeight(x, z - e);
      if (!isFinite(hx1) || !isFinite(hx0) || !isFinite(hz1) || !isFinite(hz0)) {
        return out.set(0, 1, 0);
      }
      return out.set(hx0 - hx1, 2 * e, hz0 - hz1).normalize();
    },

    /* Register a collision box. rot* in radians.
       path(time)->V3 OR move(dt, solid) (stateful, mutates solid.c) makes it a mover. */
    addSolid(opts) {
      const e = new THREE.Euler(opts.rotX || 0, opts.rotY || 0, opts.rotZ || 0, 'XYZ');
      const q = new THREE.Quaternion().setFromEuler(e);
      const s = {
        c: new THREE.Vector3(opts.x, opts.y, opts.z),
        h: new THREE.Vector3(opts.sx / 2, opts.sy / 2, opts.sz / 2),
        ax: new THREE.Vector3(1, 0, 0).applyQuaternion(q),
        ay: new THREE.Vector3(0, 1, 0).applyQuaternion(q),
        az: new THREE.Vector3(0, 0, 1).applyQuaternion(q),
        mesh: opts.mesh || null,
        isMover: !!(opts.path || opts.move),
        path: opts.path || null,
        move: opts.move || null,
        delta: new THREE.Vector3(),   // per-tick displacement (movers carry pawns)
        tag: opts.tag || '',
      };
      api.solids.push(s);
      if (s.isMover) api.movers.push(s);
      return s;
    },

    removeSolid(s) {
      let i = api.solids.indexOf(s);
      if (i >= 0) api.solids.splice(i, 1);
      i = api.movers.indexOf(s);
      if (i >= 0) api.movers.splice(i, 1);
    },

    addPad(x, y, z, radius, launchVec) {
      api.pads.push({ x, y, z, r: radius, launch: launchVec });
    },

    /* advance movers along their paths */
    update(dt, time) {
      for (const m of api.movers) {
        _v.copy(m.c);
        if (m.move) m.move(dt, m);
        else m.c.copy(m.path(time));
        m.delta.copy(m.c).sub(_v);
        // wrap-around teleports must NOT drag riders across the map
        if (m.delta.lengthSq() > 25) m.delta.set(0, 0, 0);
        if (m.mesh) m.mesh.position.copy(m.c);
      }
    },

    /* -----------------------------------------------------------------
     * closest point on solid `s` to point `p` -> writes into `out`.
     * Returns true if p is INSIDE the box (out then holds push-out info
     * in outNormal/outDepth via the shared _n vector + returned depth).
     * ----------------------------------------------------------------- */
    _closest(s, p, out, inside) {
      _d.copy(p).sub(s.c);
      const lx = _d.dot(s.ax), ly = _d.dot(s.ay), lz = _d.dot(s.az);
      if (Math.abs(lx) < s.h.x && Math.abs(ly) < s.h.y && Math.abs(lz) < s.h.z) {
        // inside: find shallowest face to push out of
        const px = s.h.x - Math.abs(lx), py = s.h.y - Math.abs(ly), pz = s.h.z - Math.abs(lz);
        if (py <= px && py <= pz) { inside.n.copy(s.ay).multiplyScalar(Math.sign(ly) || 1); inside.depth = py; }
        else if (px <= pz)        { inside.n.copy(s.ax).multiplyScalar(Math.sign(lx) || 1); inside.depth = px; }
        else                      { inside.n.copy(s.az).multiplyScalar(Math.sign(lz) || 1); inside.depth = pz; }
        return true;
      }
      const cx = SKY.U.clamp(lx, -s.h.x, s.h.x);
      const cy = SKY.U.clamp(ly, -s.h.y, s.h.y);
      const cz = SKY.U.clamp(lz, -s.h.z, s.h.z);
      out.copy(s.c)
        .addScaledVector(s.ax, cx)
        .addScaledVector(s.ay, cy)
        .addScaledVector(s.az, cz);
      return false;
    },

    _inside: { n: new THREE.Vector3(), depth: 0 },

    /* -----------------------------------------------------------------
     * Resolve a pawn (feet position `pos`, current `height`, radius r).
     * Mutates pos & vel. Returns ground contact info.
     * ----------------------------------------------------------------- */
    resolvePawn(pos, vel, radius, height) {
      let grounded = false;
      const groundNormal = _resN.set(0, 1, 0);
      let groundSolid = null;

      // sphere centers along the capsule axis (feet sphere first: it finds ground)
      const offs = height > radius * 3.2
        ? [radius, height * 0.5, height - radius]
        : [radius, height - radius];

      for (let iter = 0; iter < 2; iter++) {
        for (const off of offs) {
          _v.set(pos.x, pos.y + off, pos.z);
          for (const s of api.solids) {
            const inside = api._closest(s, _v, _q, api._inside);
            if (inside) {
              _n.copy(api._inside.n);
              const push = api._inside.depth + radius;
              pos.addScaledVector(_n, push);
              _v.addScaledVector(_n, push);
              const vn = vel.dot(_n);
              if (vn < 0) vel.addScaledVector(_n, -vn);
            } else {
              _d.copy(_v).sub(_q);
              const d2 = _d.lengthSq();
              if (d2 >= radius * radius || d2 === 0) continue;
              const dist = Math.sqrt(d2);
              _n.copy(_d).multiplyScalar(1 / dist);
              const push = radius - dist;
              pos.addScaledVector(_n, push);
              _v.addScaledVector(_n, push);
              const vn = vel.dot(_n);
              if (vn < 0) vel.addScaledVector(_n, -vn);
            }
            if (_n.y > 0.72) { grounded = true; groundNormal.copy(_n); groundSolid = s; }
          }
        }
      }
      // sculpted terrain: feet never sink below the heightfield
      if (api.terrains.length) {
        const th = api.terrainHeight(pos.x, pos.z);
        if (isFinite(th) && pos.y < th) {
          pos.y = th;
          api.terrainNormal(pos.x, pos.z, _n);
          const vn = vel.dot(_n);
          if (vn < 0) vel.addScaledVector(_n, -vn);
          if (_n.y > 0.55) { grounded = true; groundNormal.copy(_n); groundSolid = null; }
        }
      }
      return { grounded, groundNormal, groundSolid };
    },

    /* push a lone sphere out of all solids (ragdoll particles).
       Mutates p. Returns true if it rested on a walkable surface. */
    collidePoint(p, r) {
      let grounded = false;
      for (const s of api.solids) {
        const inside = api._closest(s, p, _q, api._inside);
        if (inside) {
          p.addScaledVector(api._inside.n, api._inside.depth + r);
          if (api._inside.n.y > 0.5) grounded = true;
        } else {
          _d.copy(p).sub(_q);
          const d2 = _d.lengthSq();
          if (d2 < r * r && d2 > 1e-8) {
            const d = Math.sqrt(d2);
            p.addScaledVector(_d, (r - d) / d);
            if (_d.y / d > 0.5) grounded = true;
          }
        }
      }
      if (api.terrains.length) {
        const th = api.terrainHeight(p.x, p.z);
        if (isFinite(th) && p.y - r < th) { p.y = th + r; grounded = true; }
      }
      return grounded;
    },

    /* -----------------------------------------------------------------
     * Raycast against all solids (slab test in each box's local frame).
     * Returns { t, point, normal, solid } or null.
     * skipTerrain: solids only (grapple rope-snap ignores heightfields).
     * ----------------------------------------------------------------- */
    raycast(origin, dir, maxDist, skipTerrain) {
      let best = null;
      for (const s of api.solids) {
        _d.copy(origin).sub(s.c);
        const ox = _d.dot(s.ax), oy = _d.dot(s.ay), oz = _d.dot(s.az);
        const dx = dir.dot(s.ax), dy = dir.dot(s.ay), dz = dir.dot(s.az);
        let tmin = 0, tmax = maxDist, axis = -1, sign = 1;
        let ok = true;
        const o = [ox, oy, oz], d = [dx, dy, dz], h = [s.h.x, s.h.y, s.h.z];
        for (let i = 0; i < 3; i++) {
          if (Math.abs(d[i]) < 1e-9) {
            if (Math.abs(o[i]) > h[i]) { ok = false; break; }
          } else {
            let t1 = (-h[i] - o[i]) / d[i];
            let t2 = (h[i] - o[i]) / d[i];
            let sgn = -1;
            if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; sgn = 1; }
            if (t1 > tmin) { tmin = t1; axis = i; sign = sgn; }
            if (t2 < tmax) tmax = t2;
            if (tmin > tmax) { ok = false; break; }
          }
        }
        if (!ok || axis === -1) continue;
        if (best && tmin >= best.t) continue;
        const ax = axis === 0 ? s.ax : (axis === 1 ? s.ay : s.az);
        best = {
          t: tmin,
          point: origin.clone().addScaledVector(dir, tmin),
          normal: ax.clone().multiplyScalar(sign),
          solid: s,
        };
      }
      // heightfields: coarse march, then a short bisection to sharpen the hit
      if (api.terrains.length && !skipTerrain) {
        const limit = best ? best.t : maxDist;
        const step = 0.45;
        let prevT = 0;
        const oh = api.terrainHeight(origin.x, origin.z);
        let prevInside = isFinite(oh);
        let prevAbove = prevInside ? origin.y - oh : 1;
        for (let t = step; t <= limit + step; t += step) {
          const tt = Math.min(t, limit);
          const px = origin.x + dir.x * tt, py = origin.y + dir.y * tt, pz = origin.z + dir.z * tt;
          const th = api.terrainHeight(px, pz);
          const inside = isFinite(th);
          const above = inside ? py - th : 1;
          // only a real above→below crossing counts — a ray entering the
          // footprint from OUTSIDE below surface level is not a hit (that
          // used to raise a phantom wall around every terrain's edge)
          if (prevInside && inside && prevAbove > 0 && above <= 0) {
            let lo = prevT, hi = tt;
            for (let i = 0; i < 5; i++) {
              const mid = (lo + hi) / 2;
              const mh = api.terrainHeight(origin.x + dir.x * mid, origin.z + dir.z * mid);
              (origin.y + dir.y * mid) - (isFinite(mh) ? mh : 1e9) > 0 ? lo = mid : hi = mid;
            }
            const hitT = (lo + hi) / 2;
            if (!best || hitT < best.t) {
              const hp = origin.clone().addScaledVector(dir, hitT);
              best = { t: hitT, point: hp,
                normal: api.terrainNormal(hp.x, hp.z, new THREE.Vector3()).clone(),
                solid: null, terrain: true };
            }
            break;
          }
          prevAbove = above;
          prevInside = inside;
          prevT = tt;
          if (tt >= limit) break;
        }
      }
      return best;
    },

    /* line-of-sight helper */
    los(a, b) {
      _d.copy(b).sub(a);
      const dist = _d.length();
      if (dist < 0.001) return true;
      _d.multiplyScalar(1 / dist);
      return api.raycast(a, _d, dist - 0.05) === null;
    },

    /* jump pad triggers — returns the pad hit (for FX) or null */
    checkPads(pawn) {
      if (pawn.padLockT > 0) return null;
      for (const p of api.pads) {
        const dx = pawn.pos.x - p.x, dz = pawn.pos.z - p.z;
        if (dx * dx + dz * dz > p.r * p.r) continue;
        if (pawn.pos.y < p.y - 0.6 || pawn.pos.y > p.y + 0.9) continue;
        pawn.vel.y = p.launch.y;
        pawn.vel.x = pawn.vel.x * 0.5 + p.launch.x;
        pawn.vel.z = pawn.vel.z * 0.5 + p.launch.z;
        pawn.grounded = false;
        pawn.padLockT = 0.4;
        return p;
      }
      return null;
    },
  };

  const _resN = new THREE.Vector3();
  return api;
})();
