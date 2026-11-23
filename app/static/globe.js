// Dotted-Earth cover renderer (canvas 2D, orthographic projection).
// Nothing moves on its own: the globe only redraws when the visitor scrolls,
// drags or clicks. Land comes from a 1024×512 equirectangular bitmask
// (land-mask.bin, generated from Natural Earth 1:50m via world-atlas).
(() => {
  "use strict";

  const DEG = Math.PI / 180;
  const MASK_W = 1024, MASK_H = 512;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Deterministic PRNG so the dot texture is identical on every load.
  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const toWorld = (lat, lon) => {
    const p = lat * DEG, l = lon * DEG;
    return [Math.cos(p) * Math.sin(l), Math.sin(p), Math.cos(p) * Math.cos(l)];
  };
  const wrapLon = (l) => ((((l + 180) % 360) + 360) % 360) - 180;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function buildPoints(mask) {
    const rnd = mulberry32(7);
    const isLand = (lat, lon) => {
      const x = Math.min(MASK_W - 1, Math.floor(((lon + 180) / 360) * MASK_W));
      const y = Math.min(MASK_H - 1, Math.floor(((90 - lat) / 180) * MASK_H));
      const i = y * MASK_W + x;
      return (mask[i >> 3] >> (i & 7)) & 1;
    };
    // Fibonacci sphere with a little jitter gives an even, grainy texture.
    const N = 110000, golden = Math.PI * (3 - Math.sqrt(5));
    const J = Math.sqrt((4 * Math.PI) / N) * 0.45; // jitter ≈ half the dot spacing
    const land = [], sea = [];
    for (let i = 0; i < N; i++) {
      const y = Math.max(-1, Math.min(1, 1 - (2 * (i + 0.5)) / N + (rnd() - 0.5) * J));
      const r = Math.sqrt(1 - y * y);
      const th = golden * i + ((rnd() - 0.5) * J) / Math.max(r, 0.05);
      const X = Math.cos(th) * r, Z = Math.sin(th) * r;
      const lat = Math.asin(y) / DEG, lon = Math.atan2(X, Z) / DEG;
      if (isLand(lat, lon)) land.push(X, y, Z, 0.35 + Math.pow(rnd(), 0.6) * 0.65);
      else if (rnd() < 0.035) sea.push(X, y, Z, 0.25 + rnd() * 0.4);
    }
    // Atmosphere / satellite scatter just above the surface.
    const shell = [];
    for (let i = 0; i < 2600; i++) {
      const u = rnd() * 2 - 1, t = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      const rad = 1.008 + Math.pow(rnd(), 2.2) * 0.22;
      shell.push(s * Math.cos(t) * rad, u * rad, s * Math.sin(t) * rad, 0.1 + rnd() * 0.45);
    }
    // Orbits: tilted circles at several altitudes.
    const orbits = [];
    const specs = [
      [1.18, 52, 10], [1.32, 97, 70], [1.55, 28, 140], [1.9, 63, 210], [2.3, 8, 300],
      [2.75, 81, 40], [3.2, 45, 250], [1.42, 115, 330], [3.8, 33, 180],
    ];
    for (const [rad, inc, node] of specs) {
      const pts = [], i = inc * DEG, o = node * DEG;
      for (let k = 0; k <= 240; k++) {
        const a = (k / 240) * Math.PI * 2;
        const x = Math.cos(a), z = Math.sin(a) * Math.cos(i), y = Math.sin(a) * Math.sin(i);
        pts.push(rad * (x * Math.cos(o) - z * Math.sin(o)), rad * y, rad * (x * Math.sin(o) + z * Math.cos(o)));
      }
      orbits.push(pts);
    }
    return { land: new Float32Array(land), sea: new Float32Array(sea), shell: new Float32Array(shell), orbits };
  }

  class Globe {
    constructor(canvas, { onSelect } = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.view = { lat: 18, lon: 18 };
      this.hotspots = [];
      this.activeHotspot = null;
      this.selected = null;
      this.onSelect = onSelect;
      this.ready = false;
      this._raf = 0;
      this._tween = null;
      this._bindPointer();
      new ResizeObserver(() => this.resize()).observe(canvas);
      this.resize();
    }

    async load(url) {
      const buf = await (await fetch(url)).arrayBuffer();
      this.data = buildPoints(new Uint8Array(buf));
      this.ready = true;
      this.draw();
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const { width, height } = this.canvas.getBoundingClientRect();
      this.w = width; this.h = height; this.dpr = dpr;
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      const narrow = width < 820;
      this.cx = narrow ? width / 2 : width * 0.68;
      this.cy = narrow ? height * 0.34 : height * 0.52;
      this.R = narrow ? Math.min(width * 0.4, height * 0.25) : Math.min(height * 0.34, width * 0.215);
      this.draw();
    }

    setView(lat, lon) {
      this._tween = null;
      this.view = { lat: Math.max(-80, Math.min(80, lat)), lon: wrapLon(lon) };
      this.draw();
    }

    flyTo(lat, lon, ms = 750) {
      if (reduceMotion) return this.setView(lat, lon);
      const from = { ...this.view };
      const dLon = wrapLon(lon - from.lon);
      const t0 = performance.now();
      this._tween = (now) => {
        const t = Math.min(1, (now - t0) / ms), e = ease(t);
        this.view = { lat: from.lat + (lat - from.lat) * e, lon: wrapLon(from.lon + dLon * e) };
        return t < 1;
      };
      this.draw();
    }

    draw() {
      if (this._raf) return;
      this._raf = requestAnimationFrame((now) => {
        this._raf = 0;
        if (this._tween && !this._tween(now)) this._tween = null;
        this._render();
        if (this._tween) this.draw();
      });
    }

    // world -> view space (globe radius 1); z > 0 faces the viewer
    _rot() {
      const l = this.view.lon * DEG, p = this.view.lat * DEG;
      return [Math.cos(l), Math.sin(l), Math.cos(p), Math.sin(p)];
    }

    _render() {
      const { ctx, dpr, w, h } = this;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!this.ready) return;
      const [cl, sl, cp, sp] = this._rot();
      const { cx, cy, R } = this;
      const proj = (X, Y, Z) => {
        const x1 = X * cl - Z * sl, z1 = X * sl + Z * cl;
        return [x1, Y * cp - z1 * sp, Y * sp + z1 * cp];
      };

      // soft halo
      const g = ctx.createRadialGradient(cx, cy, R * 0.95, cx, cy, R * 1.35);
      g.addColorStop(0, "rgba(190, 215, 214, 0.07)");
      g.addColorStop(1, "rgba(190, 215, 214, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(cx - R * 1.4, cy - R * 1.4, R * 2.8, R * 2.8);

      // orbits (hidden where they pass behind Earth)
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(214, 226, 225, 0.11)";
      ctx.beginPath();
      for (const pts of this.data.orbits) {
        let pen = false;
        for (let k = 0; k < pts.length; k += 3) {
          const [x, y, z] = proj(pts[k], pts[k + 1], pts[k + 2]);
          const hidden = z < 0 && x * x + y * y < 1;
          const sx = cx + x * R, sy = cy - y * R;
          if (hidden) { pen = false; continue; }
          pen ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
          pen = true;
        }
      }
      ctx.stroke();

      // dots, bucketed by alpha to keep fillStyle changes low
      const BUCKETS = 10;
      const buckets = Array.from({ length: BUCKETS }, () => []);
      const push = (arr, base, size, faceOnly) => {
        for (let i = 0; i < arr.length; i += 4) {
          const [x, y, z] = proj(arr[i], arr[i + 1], arr[i + 2]);
          if (faceOnly ? z <= 0 : z < 0 && x * x + y * y < 1) continue;
          const face = faceOnly ? 0.22 + 0.78 * Math.pow(z, 0.55) : 1;
          const a = Math.min(0.999, arr[i + 3] * face * base);
          buckets[(a * BUCKETS) | 0].push(cx + x * R - size / 2, cy - y * R - size / 2, size);
        }
      };
      const dot = Math.max(1.4, R * 0.0085);
      push(this.data.sea, 0.5, dot * 0.8, true);
      push(this.data.land, 1, dot, true);
      push(this.data.shell, 0.8, 1.1, false);
      for (let b = 0; b < BUCKETS; b++) {
        const list = buckets[b];
        if (!list.length) continue;
        ctx.fillStyle = `rgba(222, 232, 231, ${((b + 0.5) / BUCKETS).toFixed(3)})`;
        ctx.beginPath();
        for (let i = 0; i < list.length; i += 3) ctx.rect(list[i], list[i + 1], list[i + 2], list[i + 2]);
        ctx.fill();
      }

      // hotspots
      for (const hs of this.hotspots) {
        const [x, y, z] = proj(...toWorld(hs.lat, hs.lon));
        if (z <= 0.05) continue;
        const sx = cx + x * R, sy = cy - y * R;
        const active = hs.id === this.activeHotspot;
        ctx.strokeStyle = active ? "rgba(233, 166, 90, 0.95)" : "rgba(222, 232, 231, 0.45)";
        ctx.fillStyle = active ? "#E9A65A" : "rgba(222, 232, 231, 0.7)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(sx, sy, active ? 9 : 5, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(sx, sy, 2, 0, Math.PI * 2); ctx.fill();
        if (active) {
          ctx.beginPath(); ctx.arc(sx, sy, 17, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(233, 166, 90, 0.35)"; ctx.stroke();
          ctx.font = '500 11px "IBM Plex Mono", ui-monospace, monospace';
          const coord = formatCoord(hs.lat, hs.lon);
          const bw = Math.max(ctx.measureText(hs.label.toUpperCase()).width, ctx.measureText(coord).width) + 16;
          ctx.fillStyle = "rgba(5, 6, 7, 0.82)";
          ctx.fillRect(sx + 16, sy - 17, bw, 34);
          ctx.strokeStyle = "rgba(233, 166, 90, 0.45)";
          ctx.strokeRect(sx + 16.5, sy - 16.5, bw - 1, 33);
          ctx.beginPath(); ctx.moveTo(sx + 9, sy); ctx.lineTo(sx + 16, sy); ctx.stroke();
          ctx.fillStyle = "rgba(233, 166, 90, 0.95)";
          ctx.fillText(hs.label.toUpperCase(), sx + 24, sy - 4);
          ctx.fillStyle = "rgba(222, 232, 231, 0.6)";
          ctx.fillText(coord, sx + 24, sy + 11);
        }
      }

      // visitor-selected point: crosshair
      if (this.selected) {
        const [x, y, z] = proj(...toWorld(this.selected.lat, this.selected.lon));
        if (z > 0) {
          const sx = cx + x * R, sy = cy - y * R;
          ctx.strokeStyle = "rgba(233, 166, 90, 0.9)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(sx - 14, sy); ctx.lineTo(sx - 5, sy); ctx.moveTo(sx + 5, sy); ctx.lineTo(sx + 14, sy);
          ctx.moveTo(sx, sy - 14); ctx.lineTo(sx, sy - 5); ctx.moveTo(sx, sy + 5); ctx.lineTo(sx, sy + 14);
          ctx.stroke();
        }
      }
    }

    _pick(clientX, clientY) {
      const r = this.canvas.getBoundingClientRect();
      const x = (clientX - r.left - this.cx) / this.R, y = -(clientY - r.top - this.cy) / this.R;
      const d = x * x + y * y;
      if (d > 1) return null;
      const z = Math.sqrt(1 - d);
      const [cl, sl, cp, sp] = this._rot();
      const y1 = y * cp + z * sp, z1 = -y * sp + z * cp;
      const X = x * cl + z1 * sl, Z = -x * sl + z1 * cl;
      return { lat: Math.asin(Math.max(-1, Math.min(1, y1))) / DEG, lon: Math.atan2(X, Z) / DEG };
    }

    _bindPointer() {
      const c = this.canvas;
      let start = null, last = null, dragging = false;
      c.addEventListener("pointerdown", (e) => {
        start = last = { x: e.clientX, y: e.clientY };
        dragging = false;
      });
      c.addEventListener("pointermove", (e) => {
        const hit = this._pick(e.clientX, e.clientY);
        c.style.cursor = dragging ? "grabbing" : hit ? "crosshair" : "default";
        if (!start) return;
        if (!dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) {
          dragging = true;
          c.setPointerCapture(e.pointerId);
        }
        if (dragging) {
          const k = 1 / this.R / DEG;
          this.setView(this.view.lat + (e.clientY - last.y) * k, this.view.lon - (e.clientX - last.x) * k);
          last = { x: e.clientX, y: e.clientY };
        }
      });
      const end = (e) => {
        if (start && !dragging) {
          const hit = this._pick(e.clientX, e.clientY);
          if (hit) {
            this.selected = hit;
            this.flyTo(hit.lat, hit.lon);
            this.onSelect && this.onSelect(hit);
          }
        }
        start = null; dragging = false;
      };
      c.addEventListener("pointerup", end);
      c.addEventListener("pointercancel", () => { start = null; dragging = false; });
    }
  }

  function formatCoord(lat, lon) {
    const f = (v, p, n) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? p : n}`;
    return `${f(lat, "N", "S")}  ${f(lon, "E", "W")}`;
  }

  window.DisasterGlobe = { Globe, formatCoord, wrapLon, ease };
})();
