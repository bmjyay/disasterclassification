/* Disaster Watch: scroll story + explorable satellite globe (globe.gl). */
(function () {
  "use strict";

  const O = window.Orbits;
  const TEX = "https://cdn.jsdelivr.net/npm/three-globe@2.45.3/example/img/";
  const IMAGERY_URL = (x, y, l) =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${l}/${y}/${x}`;
  const IMAGERY_CREDIT = "Imagery © Esri, Maxar, Earthstar Geographics";
  const EARTH_TEXTURE = TEX + "earth-blue-marble.jpg";
  // Darkens the Blue Marble texture for a matte, less saturated planet.
  const GLOBE_TINT = 0.8;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const flyMs = (ms) => (reduceMotion ? 0 : ms);

  const DISASTER_COLORS = {
    cyclone: "#8299a8", earthquake: "#a8876a", flood: "#6d8596", wildfire: "#a9654f",
  };

  // Camera + highlight for each scroll chapter.
  const CHAPTERS = {
    hero:          { pov: { lat: 18, lng: 20, altitude: 2.6 }, rotate: true, sats: "none" },
    constellation: { pov: { lat: 15, lng: 60, altitude: 3.6 }, rotate: true, sats: "all" },
    cyclone: {
      pov: { lat: 15, lng: 90, altitude: 1.5 },
      site: { lat: 20.1, lng: 92.9, kind: "cyclone", label: "Cyclone Mocha landfall" },
      highlight: ["met9", "insat", "fy4b", "himawari9", "gpm", "metopc", "noaa20"],
    },
    earthquake: {
      pov: { lat: 35, lng: 37, altitude: 1.4 },
      site: { lat: 37.17, lng: 37.03, kind: "earthquake", label: "M7.8 epicentre" },
      highlight: ["s1a", "s1c", "alos2", "nisar", "wv3", "gps0", "gps1", "galileo"],
    },
    flood: {
      pov: { lat: 24, lng: 68, altitude: 1.4 },
      site: { lat: 26.5, lng: 68.0, kind: "flood", label: "Flooded lower Indus valley" },
      highlight: ["s1a", "s1c", "iceye", "swot", "s2a", "s2b", "dove", "gpm"],
    },
    wildfire: {
      pov: { lat: 22, lng: -152, altitude: 1.4 },
      site: { lat: 20.88, lng: -156.68, kind: "wildfire", label: "Lahaina" },
      highlight: ["goes18", "snpp", "noaa20", "noaa21", "terra", "aqua", "landsat8", "s2a", "iss"],
    },
    model:  { pov: { lat: 10, lng: 0, altitude: 2.8 }, rotate: true, sats: "dim" },
    outro:  { pov: { lat: 20, lng: -40, altitude: 2.4 }, rotate: true, sats: "all" },
  };

  // ── State ────────────────────────────────────────────────────────────────
  const state = {
    exploring: false,
    chapter: null,
    speed: 60,
    simTime: Date.now(),
    lastFrame: performance.now(),
    hiddenCats: new Set(),
    highlight: null,          // Set of ids, or null for all
    selected: null,           // selected satellite object
    following: false,
    clickedPoint: null,
    imageryOk: null,          // null = untested
    useImagery: true,
  };

  // ── Satellite DOM markers ──────────────────────────────────────────────
  const tooltip = document.getElementById("tooltip");

  const sats = O.SATELLITES.map((s) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "sat";
    el.style.setProperty("--c", O.CATEGORIES[s.cat].color);
    el.setAttribute("aria-label", s.name);
    el.innerHTML = `<span class="sat-dot"></span><span class="sat-label">${s.name}</span>`;
    el.addEventListener("click", (e) => { e.stopPropagation(); selectSatellite(s.id); });
    el.addEventListener("pointerenter", (e) => showTooltip(e, s));
    el.addEventListener("pointerleave", hideTooltip);
    return { type: "sat", sat: s, el, lat: 0, lng: 0, alt: 0, altKm: 0 };
  });
  const satById = Object.fromEntries(sats.map((d) => [d.sat.id, d]));

  const siteMarker = (() => {
    const el = document.createElement("div");
    el.className = "site";
    el.innerHTML = `<span class="site-pulse"></span><span class="site-label"></span>`;
    return { type: "site", el, lat: 0, lng: 0, alt: 0.005 };
  })();

  const pinMarker = (() => {
    const el = document.createElement("div");
    el.className = "pin";
    return { type: "pin", el, lat: 0, lng: 0, alt: 0.002 };
  })();

  function showTooltip(e, s) {
    const cat = O.CATEGORIES[s.cat];
    tooltip.innerHTML = `<strong>${s.name}</strong><span style="color:${cat.color}">${cat.label}</span>`;
    tooltip.hidden = false;
    const r = e.currentTarget.getBoundingClientRect();
    tooltip.style.left = `${r.left + r.width / 2}px`;
    tooltip.style.top = `${r.top - 8}px`;
  }
  function hideTooltip() { tooltip.hidden = true; }

  // ── Globe ────────────────────────────────────────────────────────────────
  const globeEl = document.getElementById("globe");
  const world = Globe({ animateIn: false })(globeEl)
    .globeImageUrl(EARTH_TEXTURE)
    .bumpImageUrl(TEX + "earth-topology.png")
    .backgroundColor("#070708")
    .atmosphereColor("#9fb0bf")
    .atmosphereAltitude(0.12)
    .onGlobeReady(() => requestAnimationFrame(() => requestAnimationFrame(runIntro)))
    .htmlElementsData([])
    .htmlLat("lat").htmlLng("lng").htmlAltitude("alt")
    .htmlElement((d) => d.el)
    .htmlTransitionDuration(0)
    .htmlElementVisibilityModifier((el, visible) => el.classList.toggle("occluded", !visible))
    .pathsData([])
    .pathPoints("pts")
    .pathPointLat((p) => p[0]).pathPointLng((p) => p[1]).pathPointAlt((p) => p[2])
    .pathColor((d) => d.color)
    .pathStroke((d) => d.stroke)
    .pathDashLength((d) => d.dash || 1)
    .pathDashGap((d) => (d.dash ? d.dash : 0))
    .pathTransitionDuration(0)
    .ringsData([])
    .ringColor((d) => (t) => hexA(d.color, 0.6 * (1 - t)))
    .ringMaxRadius((d) => d.r)
    .ringPropagationSpeed((d) => d.speed)
    .ringRepeatPeriod((d) => d.period)
    .onGlobeClick(({ lat, lng }) => onGround(lat, lng))
    .onZoom(updateAttribution);

  world.renderer().setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Matte surface: dim the texture, kill the specular highlight, soften the fill light.
  const globeMat = world.globeMaterial();
  globeMat.color.setRGB(GLOBE_TINT, GLOBE_TINT, GLOBE_TINT * 1.02);
  if (globeMat.specular) globeMat.specular.setRGB(0.04, 0.04, 0.04);
  globeMat.shininess = 2;
  globeMat.bumpScale = 3;
  for (const light of world.lights()) {
    if (light.isAmbientLight) light.intensity *= 0.6;
  }
  const controls = world.controls();
  controls.enableZoom = false;
  controls.autoRotate = !reduceMotion;
  controls.autoRotateSpeed = 0.35;
  controls.enableDamping = true;

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, a).toFixed(3)})`;
  }

  function layout() {
    world.width(window.innerWidth).height(window.innerHeight);
    // Keep story cards from covering the globe: cards sit left on wide screens,
    // along the bottom on narrow ones.
    const wide = window.innerWidth > 900;
    if (state.exploring) world.globeOffset([0, 0]);
    else if (wide) world.globeOffset([window.innerWidth * 0.17, 0]);
    else world.globeOffset([0, -window.innerHeight * 0.24]);
  }
  window.addEventListener("resize", layout);
  layout();

  // ── Simulation loop ─────────────────────────────────────────────────────
  let lastPaths = 0;
  function tick(now) {
    const dt = now - state.lastFrame;
    state.lastFrame = now;
    state.simTime += dt * state.speed;
    const date = new Date(state.simTime);

    for (const d of sats) {
      const p = O.propagate(d.sat, date);
      d.lat = p.lat; d.lng = p.lng; d.altKm = p.altKm;
      d.alt = O.displayAltitude(p.altKm);
    }
    world.htmlElementsData(world.htmlElementsData());

    if (state.selected && state.following) {
      const pov = world.pointOfView();
      world.pointOfView({ lat: state.selected.lat, lng: state.selected.lng, altitude: pov.altitude }, 0);
    }
    // Orbit rings drift as the Earth turns underneath; refresh a few times a second.
    if (now - lastPaths > 400) { lastPaths = now; refreshPaths(date); }
    if (state.clickedPoint && !document.getElementById("info").hidden && now - lastInfo > 1000) {
      lastInfo = now; renderLocationInfo();
    }
    requestAnimationFrame(tick);
  }
  let lastInfo = 0;

  function visibleSats() {
    return sats.filter((d) => !state.hiddenCats.has(d.sat.cat));
  }

  function refreshHtml() {
    const items = [];
    if (state.chapter !== "hero" || state.exploring) items.push(...visibleSats());
    if (siteMarker.active) items.push(siteMarker);
    if (state.clickedPoint) items.push(pinMarker);
    for (const d of sats) {
      const hl = !state.highlight || state.highlight.has(d.sat.id);
      d.el.classList.toggle("dim", !hl || state.dimAll === true);
      d.el.classList.toggle("hl", !!state.highlight && hl);
      d.el.classList.toggle("selected", state.selected === d);
    }
    world.htmlElementsData(items);
  }

  function refreshPaths(date) {
    const paths = [];
    const tracked = state.selected
      ? [state.selected]
      : state.highlight ? sats.filter((d) => state.highlight.has(d.sat.id)) : [];
    for (const d of tracked) {
      if (state.hiddenCats.has(d.sat.cat)) continue;
      const color = O.CATEGORIES[d.sat.cat].color;
      paths.push({ pts: O.orbitPath(d.sat, date), color: hexA(color, 0.35), stroke: 0.4 });
    }
    if (state.selected) {
      const d = state.selected;
      const r = O.footprintRadiusDeg(d.altKm);
      paths.push({ pts: O.circlePath(d.lat, d.lng, Math.min(r, 80)), color: hexA(O.CATEGORIES[d.sat.cat].color, 0.6), stroke: 0.3, dash: 0.02 });
    }
    world.pathsData(paths);
  }

  // ── Story chapters ──────────────────────────────────────────────────────
  const chapterEls = [...document.querySelectorAll("[data-chapter]")];
  const progress = document.querySelector(".progress");
  for (const el of chapterEls) {
    const a = document.createElement("a");
    a.href = `#${el.id}`;
    a.dataset.target = el.dataset.chapter;
    a.setAttribute("aria-label", el.querySelector("h1, h2").textContent);
    progress.appendChild(a);
  }

  // Satellite chips for each disaster chapter.
  for (const el of chapterEls) {
    const cfg = CHAPTERS[el.dataset.chapter];
    const box = el.querySelector("[data-sats]");
    if (!box || !cfg.highlight) continue;
    box.innerHTML = cfg.highlight
      .map((id) => satById[id].sat)
      .filter((s, i, arr) => arr.findIndex((t) => t.name === s.name) === i)
      .map((s) => `<button type="button" class="chip" data-sat="${s.id}" style="--c:${O.CATEGORIES[s.cat].color}">
          <span class="chip-dot"></span><span><strong>${s.name}</strong><small>${shortRole(s)}</small></span></button>`)
      .join("");
  }
  function shortRole(s) { return s.disaster.split(/[.;](?:\s|$)/)[0]; }

  document.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-sat]");
    if (chip) { selectSatellite(chip.dataset.sat); return; }
    if (e.target.closest("[data-enter-explore]")) enterExplore();
  });

  function activateChapter(name, instant = false) {
    if (state.exploring || state.chapter === name) return;
    state.chapter = name;
    const cfg = CHAPTERS[name];
    for (const a of progress.children) a.classList.toggle("on", a.dataset.target === name);
    for (const el of chapterEls) el.classList.toggle("active", el.dataset.chapter === name);

    state.selected = null;
    state.following = false;
    closeInfo();
    state.highlight = cfg.highlight ? new Set(cfg.highlight) : null;
    state.dimAll = cfg.sats === "dim";
    controls.autoRotate = !!cfg.rotate && !reduceMotion && state.introDone;

    if (cfg.site) {
      siteMarker.active = true;
      siteMarker.lat = cfg.site.lat; siteMarker.lng = cfg.site.lng;
      siteMarker.el.style.setProperty("--c", DISASTER_COLORS[cfg.site.kind]);
      siteMarker.el.querySelector(".site-label").textContent = cfg.site.label;
      world.ringsData([{ lat: cfg.site.lat, lng: cfg.site.lng, color: DISASTER_COLORS[cfg.site.kind], r: 4, speed: 1.2, period: 2400 }]);
    } else {
      siteMarker.active = false;
      world.ringsData([]);
    }
    refreshHtml();
    refreshPaths(new Date(state.simTime));
    world.pointOfView(cfg.pov, instant ? 0 : flyMs(2200));
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) activateChapter(e.target.dataset.chapter);
  }, { rootMargin: "-45% 0px -45% 0px" });
  chapterEls.forEach((el) => io.observe(el));

  // ── Legend ───────────────────────────────────────────────────────────────
  for (const ul of document.querySelectorAll("[data-legend]")) {
    const interactive = ul.hasAttribute("data-interactive");
    ul.innerHTML = Object.entries(O.CATEGORIES).map(([key, c]) => {
      const n = sats.filter((d) => d.sat.cat === key).length;
      return interactive
        ? `<li><button type="button" class="legend-item" data-cat="${key}" aria-pressed="true" style="--c:${c.color}">
             <span class="legend-dot"></span><span class="legend-name">${c.label}</span><span class="legend-n">${n}</span></button>
             <p class="legend-blurb">${c.blurb}</p></li>`
        : `<li style="--c:${c.color}"><span class="legend-dot"></span><span><strong>${c.label}</strong><small>${c.short}</small></span></li>`;
    }).join("");
  }
  document.querySelector(".legend-panel").addEventListener("click", (e) => {
    const b = e.target.closest(".legend-item");
    if (!b) return;
    const cat = b.dataset.cat;
    if (state.hiddenCats.has(cat)) state.hiddenCats.delete(cat); else state.hiddenCats.add(cat);
    b.setAttribute("aria-pressed", String(!state.hiddenCats.has(cat)));
    b.parentElement.classList.toggle("open", !state.hiddenCats.has(cat) && !b.parentElement.classList.contains("open"));
    if (state.selected && state.hiddenCats.has(state.selected.sat.cat)) closeInfo();
    refreshHtml();
    refreshPaths(new Date(state.simTime));
  });

  // ── Info panel ──────────────────────────────────────────────────────────
  const info = document.getElementById("info");

  function selectSatellite(id) {
    const d = satById[id];
    if (!d) return;
    state.selected = d;
    state.following = false;
    const s = d.sat, cat = O.CATEGORIES[s.cat];
    const altKm = s.geo ? O.GEO_ALT_KM : s.alt;
    const period = O.periodMinutes(s);
    const periodTxt = period > 1400 ? "24 h (stays over one spot)" : period > 300
      ? `${(period / 60).toFixed(1)} h` : `${Math.round(period)} min`;
    const orbit = s.geo ? `Geostationary over ${fmtLng(s.lng)}`
      : `${s.inc}° inclination${Math.abs(s.inc - 98) < 1.2 ? " (sun-synchronous)" : ""}`;
    info.innerHTML = `
      <button class="close" type="button" aria-label="Close">×</button>
      <p class="eyebrow" style="color:${cat.color}"><span class="legend-dot" style="--c:${cat.color}"></span>${cat.label}</p>
      <h3>${s.name}</h3>
      <p>${s.purpose}</p>
      <div class="callout" style="--c:${cat.color}"><strong>In a disaster</strong>${s.disaster}</div>
      <dl>
        <dt>Altitude</dt><dd>${altKm.toLocaleString()} km</dd>
        <dt>Orbit</dt><dd>${orbit}</dd>
        <dt>Period</dt><dd>${periodTxt}</dd>
        <dt>Instruments</dt><dd>${s.instruments}</dd>
        <dt>Operator</dt><dd>${s.operator} · since ${s.launched}</dd>
      </dl>
      <p class="fine">${cat.blurb}</p>
      <div class="actions">
        <button class="btn btn-primary" type="button" data-follow>Follow</button>
        <button class="btn btn-ghost" type="button" data-fly>Fly to</button>
      </div>
      <p class="fine">Orbit plane and phase are illustrative; altitude and inclination are real. The dashed circle is the area it can see.</p>`;
    info.hidden = false;
    info.querySelector(".close").onclick = closeInfo;
    info.querySelector("[data-fly]").onclick = () =>
      world.pointOfView({ lat: d.lat, lng: d.lng, altitude: Math.max(1.2, d.alt + 0.9) }, flyMs(1400));
    const followBtn = info.querySelector("[data-follow]");
    followBtn.onclick = () => {
      state.following = !state.following;
      followBtn.textContent = state.following ? "Stop following" : "Follow";
      if (state.following) {
        controls.autoRotate = false;
        world.pointOfView({ lat: d.lat, lng: d.lng, altitude: Math.max(1.2, d.alt + 0.9) }, flyMs(900));
      }
    };
    state.clickedPoint = null;
    refreshHtml();
    refreshPaths(new Date(state.simTime));
  }

  function closeInfo() {
    info.hidden = true;
    state.selected = null;
    state.following = false;
    state.clickedPoint = null;
    refreshHtml();
    refreshPaths(new Date(state.simTime));
  }

  function fmtLat(v) { return `${Math.abs(v).toFixed(2)}° ${v >= 0 ? "N" : "S"}`; }
  function fmtLng(v) { return `${Math.abs(v).toFixed(2)}° ${v >= 0 ? "E" : "W"}`; }

  function onGround(lat, lng) {
    if (!state.exploring) enterExplore();
    state.selected = null;
    state.following = false;
    state.clickedPoint = { lat, lng };
    pinMarker.lat = lat; pinMarker.lng = lng;
    const alt = Math.min(world.pointOfView().altitude, state.useImagery && state.imageryOk ? 0.35 : 0.9);
    world.pointOfView({ lat, lng, altitude: alt }, flyMs(1600));
    renderLocationInfo();
    refreshHtml();
    refreshPaths(new Date(state.simTime));
  }

  function renderLocationInfo() {
    const { lat, lng } = state.clickedPoint;
    const date = new Date(state.simTime);
    const sun = O.subsolarPoint(date);
    const sunAngle = O.centralAngleDeg(lat, lng, sun.lat, sun.lng);
    const daylight = sunAngle < 90;
    const solarH = ((date.getUTCHours() + date.getUTCMinutes() / 60 + lng / 15) % 24 + 24) % 24;
    const clock = `${String(Math.floor(solarH)).padStart(2, "0")}:${String(Math.floor((solarH % 1) * 60)).padStart(2, "0")}`;

    const overhead = visibleSats()
      .map((d) => ({ d, ang: O.centralAngleDeg(lat, lng, d.lat, d.lng), r: O.footprintRadiusDeg(d.altKm) }))
      .filter((x) => x.ang < x.r)
      .sort((a, b) => a.d.altKm - b.d.altKm);

    const canImage = overhead.filter((x) => x.d.sat.cat === "radar" || (daylight && x.d.sat.cat === "optical"));
    info.innerHTML = `
      <button class="close" type="button" aria-label="Close">×</button>
      <p class="eyebrow">Selected location</p>
      <h3>${fmtLat(lat)}, ${fmtLng(lng)}</h3>
      <dl>
        <dt>Local solar time</dt><dd>${clock}</dd>
        <dt>Sunlight</dt><dd>${daylight ? "☀ Daylight: optical cameras can see the ground"
                                         : "☾ Night: only thermal and radar sensors are useful"}</dd>
      </dl>
      <h4>Above the horizon now <span class="count">${overhead.length}</span></h4>
      ${overhead.length ? `<div class="sat-list compact">${overhead.map(({ d }) => `
        <button type="button" class="chip" data-sat="${d.sat.id}" style="--c:${O.CATEGORIES[d.sat.cat].color}">
          <span class="chip-dot"></span><span><strong>${d.sat.name}</strong>
          <small>${O.CATEGORIES[d.sat.cat].label} · ${d.altKm.toLocaleString()} km</small></span></button>`).join("")}</div>`
        : `<p class="fine">No satellites from this sample are in view. Speed up time and watch them arrive.</p>`}
      <p class="fine">${canImage.length
        ? `${canImage.length} of these could image this spot right now.`
        : "None of the imaging satellites in view can photograph this spot right now."}
        Shown: satellites more than 10° above the horizon.</p>`;
    info.hidden = false;
    info.querySelector(".close").onclick = closeInfo;
  }

  // ── Explore mode ────────────────────────────────────────────────────────
  const exploreUi = document.querySelector(".explore-ui");
  let storyScroll = 0;

  function enterExplore() {
    if (state.exploring) return;
    storyScroll = window.scrollY;
    state.exploring = true;
    document.body.classList.add("exploring");
    exploreUi.setAttribute("aria-hidden", "false");
    controls.enableZoom = true;
    controls.autoRotate = false;
    state.highlight = null;
    state.dimAll = false;
    siteMarker.active = false;
    world.ringsData([]);
    layout();
    applyImagery();
    refreshHtml();
    refreshPaths(new Date(state.simTime));
  }

  function exitExplore() {
    state.exploring = false;
    document.body.classList.remove("exploring");
    exploreUi.setAttribute("aria-hidden", "true");
    controls.enableZoom = false;
    closeInfo();
    world.globeTileEngineUrl(null);
    updateAttribution();
    layout();
    window.scrollTo(0, storyScroll);
    const name = state.chapter;
    state.chapter = null;
    activateChapter(name || "hero");
  }

  document.getElementById("explore-btn").addEventListener("click", () =>
    state.exploring ? exitExplore() : enterExplore());
  document.getElementById("exit-explore").addEventListener("click", exitExplore);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!info.hidden) closeInfo(); else if (state.exploring) exitExplore();
  });

  document.querySelector(".seg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-speed]");
    if (!b) return;
    state.speed = Number(b.dataset.speed);
    for (const x of b.parentElement.children) x.classList.toggle("on", x === b);
  });

  document.querySelector(".zoom").addEventListener("click", (e) => {
    const b = e.target.closest("[data-zoom]");
    if (!b) return;
    const pov = world.pointOfView();
    const f = b.dataset.zoom === "in" ? 0.55 : 1.8;
    world.pointOfView({ altitude: Math.min(6, Math.max(0.02, pov.altitude * f)) }, flyMs(500));
  });

  const imageryToggle = document.getElementById("imagery-toggle");
  imageryToggle.addEventListener("change", () => {
    state.useImagery = imageryToggle.checked;
    applyImagery();
  });

  // Probe one imagery tile first so a blocked tile server falls back to the texture.
  function applyImagery() {
    if (!state.exploring) return;
    if (!state.useImagery) { world.globeTileEngineUrl(null); updateAttribution(); return; }
    if (state.imageryOk === true) { world.globeTileEngineUrl(IMAGERY_URL); updateAttribution(); return; }
    if (state.imageryOk === false) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { state.imageryOk = true; applyImagery(); };
    img.onerror = () => {
      state.imageryOk = false;
      imageryToggle.checked = false;
      imageryToggle.disabled = true;
      imageryToggle.parentElement.title = "Imagery server unreachable; showing the Blue Marble texture";
    };
    img.src = IMAGERY_URL(0, 0, 0);
  }

  function updateAttribution() {
    const on = state.exploring && state.useImagery && state.imageryOk;
    document.getElementById("attribution").textContent = on
      ? IMAGERY_CREDIT : "Earth texture: NASA Blue Marble";
  }


  // ── Intro: pixels assemble into the Earth ────────────────────────────────
  /* Samples the Earth texture on a coarse screen grid covering the globe's disc,
   * scatters those "pixels" across the viewport and flies them into place, then
   * cross-fades to the WebGL globe. Each pixel's lat/lng comes from intersecting
   * its camera ray with the sphere, so the mosaic matches the rendered globe. */
  function loadTexturePixels(url, w, h) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        resolve(ctx.getImageData(0, 0, w, h).data);
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  function buildMosaic(tex, tw, th, step) {
    const pov = world.pointOfView();
    const center = world.getScreenCoords(pov.lat, pov.lng, 0);
    const d = 1 + pov.altitude;
    const f = (window.innerHeight / 2) / Math.tan((world.camera().fov * Math.PI) / 360);
    const a = -pov.lat * Math.PI / 180, b = pov.lng * Math.PI / 180;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    const discR = f * Math.tan(Math.asin(1 / d)) + step;
    const pixels = [];
    for (let dy = -discR; dy <= discR; dy += step) {
      for (let dx = -discR; dx <= discR; dx += step) {
        const len = Math.hypot(dx, dy, f);
        const vx = dx / len, vy = -dy / len, vz = -f / len;
        const bq = d * vz, disc = bq * bq - (d * d - 1);
        if (disc < 0) continue;
        const t = -bq - Math.sqrt(disc);
        const x = t * vx, y = t * vy, z = d + t * vz;
        // Rotate from camera frame to globe frame.
        const y1 = y * ca - z * sa, z1 = y * sa + z * ca;
        const X = x * cb + z1 * sb, Z = -x * sb + z1 * cb;
        const lat = Math.asin(Math.max(-1, Math.min(1, y1))) * 180 / Math.PI;
        const lng = Math.atan2(X, Z) * 180 / Math.PI;
        const u = Math.min(tw - 1, Math.floor(((lng + 180) / 360) * tw));
        const v = Math.min(th - 1, Math.floor(((90 - lat) / 180) * th));
        const k = (v * tw + u) * 4;
        const shade = GLOBE_TINT * (0.55 + 0.55 * Math.max(0, z));
        pixels.push({
          x: center.x + dx, y: center.y + dy,
          r: tex[k] * shade | 0, g: tex[k + 1] * shade | 0, b: tex[k + 2] * shade | 0,
        });
      }
    }
    return pixels;
  }

  async function runIntro() {
    if (state.introStarted) return;
    state.introStarted = true;
    if (reduceMotion) return finishIntro();
    let tex;
    const TW = 1024, TH = 512;
    try { tex = await loadTexturePixels(EARTH_TEXTURE, TW, TH); } catch (e) { return finishIntro(); }

    const W = window.innerWidth, H = window.innerHeight;
    const step = W < 600 ? 4 : 5;
    const pixels = buildMosaic(tex, TW, TH, step);
    const canvas = document.createElement("canvas");
    canvas.className = "intro-canvas";
    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width = W * dpr; canvas.height = H * dpr;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const cx = pixels.reduce((s, p) => s + p.x, 0) / pixels.length;
    const cy = pixels.reduce((s, p) => s + p.y, 0) / pixels.length;
    for (const p of pixels) {
      const ang = Math.random() * Math.PI * 2;
      const dist = Math.hypot(W, H) * (0.25 + Math.random() * 0.6);
      p.sx = cx + Math.cos(ang) * dist;
      p.sy = cy + Math.sin(ang) * dist;
      // Pixels near the centre settle first, the limb last.
      p.delay = Math.hypot(p.x - cx, p.y - cy) / (step * 120) + Math.random() * 0.35;
      p.color = `rgb(${p.r},${p.g},${p.b})`;
    }
    const maxDelay = Math.max(...pixels.map((p) => p.delay));
    const FLY = 1.5, total = maxDelay + FLY;
    const size = step - 1;
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const t0 = performance.now();

    function frame(now) {
      const t = (now - t0) / 1000;
      ctx.clearRect(0, 0, W, H);
      for (const p of pixels) {
        const k = Math.min(1, Math.max(0, (t - p.delay) / FLY));
        ctx.globalAlpha = 0.3 + 0.7 * k;
        const e = ease(k);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.sx + (p.x - p.sx) * e - size / 2, p.sy + (p.y - p.sy) * e - size / 2, size, size);
      }
      if (t < total) return requestAnimationFrame(frame);
      ctx.globalAlpha = 1;
      finishIntro(canvas);
    }
    document.body.classList.add("intro-running");
    requestAnimationFrame(frame);
  }

  function finishIntro(canvas) {
    state.introStarted = true;
    state.introDone = true;
    document.body.classList.remove("intro-running");
    document.body.classList.add("intro-done");
    const cfg = CHAPTERS[state.chapter];
    if (!state.exploring && cfg) controls.autoRotate = !!cfg.rotate && !reduceMotion;
    if (canvas) {
      canvas.classList.add("fade");
      setTimeout(() => canvas.remove(), 1200);
    }
  }

  refreshHtml();
  updateAttribution();
  activateChapter("hero", true);
  requestAnimationFrame(tick);
  // If the texture never reports ready, show the globe anyway.
  setTimeout(() => { if (!state.introStarted) finishIntro(); }, 8000);

  // Debug/test hook.
  window.DisasterWatch = { world, state, enterExplore, exitExplore, selectSatellite, onGround };
})();
