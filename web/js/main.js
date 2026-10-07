/* Disaster Watch: scroll story + explorable satellite globe (globe.gl). */
(function () {
  "use strict";

  const O = window.Orbits;
  const TEX = "https://cdn.jsdelivr.net/npm/three-globe@2.45.3/example/img/";
  const IMAGERY_URL = (x, y, l) =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${l}/${y}/${x}`;
  const IMAGERY_CREDIT = "Imagery © Esri, Maxar, Earthstar Geographics";
  // Water mask (water = white, land = black) used to place the land particles.
  const LAND_MASK = TEX + "earth-water.png";
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  let particleZoom = 1;
  const PARTICLE_STYLE = {
    landBright: { color: "rgba(214,226,228,0.95)", size: 1.7 },
    landDim:    { color: "rgba(150,170,174,0.7)",  size: 1.2 },
    ocean:      { color: "rgba(118,138,144,0.35)", size: 1.0 },
    shell:      { color: "rgba(170,186,190,0.28)", size: 1.0 },
  };
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
    .backgroundColor("#060708")
    .atmosphereColor("#8fa3a8")
    .atmosphereAltitude(0.09)
    .particlesData([])
    .particlesList("points")
    .particleLat((p) => p[0]).particleLng((p) => p[1]).particleAltitude((p) => p[2])
    .particlesSize((d) => PARTICLE_STYLE[d.kind].size * DPR * particleZoom)
    .particlesSizeAttenuation(false)
    .particlesColor((d) => PARTICLE_STYLE[d.kind].color)
    .particleLabel(() => "")
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
    .onZoom(syncSurface);

  world.renderer().setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // A near-black, matte sphere; the planet itself is drawn by particles.
  const globeMat = world.globeMaterial();
  globeMat.color.setRGB(0.004, 0.005, 0.006);
  if (globeMat.specular) globeMat.specular.setRGB(0.02, 0.02, 0.02);
  globeMat.shininess = 1;
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
    // The opening view shows only the orbit web; satellites appear once the story starts.
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
    if (!state.selected && !state.highlight && state.chapter !== null) {
      // A faint web of every orbit, the planet's "wiring diagram".
      const seen = new Set();
      for (const d of visibleSats()) {
        const key = d.sat.geo ? "geo" : `${d.sat.alt}|${d.sat.inc}|${d.sat.raan}`;
        if (seen.has(key)) continue;
        seen.add(key);
        paths.push({ pts: O.orbitPath(d.sat, date), color: "rgba(190,205,208,0.15)", stroke: null });
      }
      world.pathsData(paths);
      return;
    }
    const tracked = state.selected
      ? [state.selected]
      : sats.filter((d) => state.highlight.has(d.sat.id));
    for (const d of tracked) {
      if (state.hiddenCats.has(d.sat.cat)) continue;
      const color = O.CATEGORIES[d.sat.cat].color;
      paths.push({ pts: O.orbitPath(d.sat, date), color: hexA(color, 0.5), stroke: null });
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
    syncSurface();
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

  // Probe one imagery tile first so a blocked tile server keeps the particle globe.
  function applyImagery() {
    if (!state.exploring) return;
    if (state.useImagery && state.imageryOk === null) {
      state.imageryOk = "pending";
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => { state.imageryOk = true; syncSurface(); };
      img.onerror = () => {
        state.imageryOk = false;
        imageryToggle.checked = false;
        imageryToggle.disabled = true;
        imageryToggle.parentElement.title = "Imagery server unreachable; showing the particle globe";
      };
      img.src = IMAGERY_URL(0, 0, 0);
    }
    syncSurface();
  }

  /* From afar the planet is particles; zoomed in while exploring it switches to
   * photographic tiles (with hysteresis so it doesn't flicker at the threshold). */
  function syncSurface() {
    const alt = world.pointOfView().altitude;
    // Grow the dots as the camera closes in so the land stays solid.
    const z = Math.min(2.6, Math.max(1, 1.6 / Math.sqrt(alt)));
    if (Math.abs(z - particleZoom) > 0.05) {
      particleZoom = z;
      world.particlesSize(world.particlesSize());
    }
    const want = state.exploring && state.useImagery && state.imageryOk === true &&
      alt < (state.tilesOn ? 1.15 : 0.9);
    if (want !== !!state.tilesOn) {
      state.tilesOn = want;
      world.globeTileEngineUrl(want ? IMAGERY_URL : null);
      setParticles(want ? [] : particleSets);
      document.body.classList.toggle("imagery", want);
    }
    updateAttribution();
  }

  function updateAttribution() {
    document.getElementById("attribution").textContent = state.tilesOn
      ? IMAGERY_CREDIT : "Land data: NASA Blue Marble";
  }


  // ── Particle Earth ───────────────────────────────────────────────────────
  /* Points on a Fibonacci sphere, kept where the mask says land (plus a sparse
   * scattering over ocean and a thin dust shell above the surface). */
  let particleSets = [];

  function loadMask(url, w, h) {
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

  /* Hit-testing 150k points on every mouse move is slow and they aren't
   * interactive, so take them out of raycasting (clicks still reach the globe). */
  function setParticles(sets) {
    world.particlesData(sets);
    requestAnimationFrame(() => world.scene().traverse((o) => { if (o.isPoints) o.raycast = () => {}; }));
  }

  function buildParticles(mask, mw, mh) {
    const N = window.innerWidth < 700 ? 90000 : 150000;
    const golden = Math.PI * (3 - Math.sqrt(5));
    const sets = { landBright: [], landDim: [], ocean: [], shell: [] };
    for (let i = 0; i < N; i++) {
      const y = 1 - (2 * (i + 0.5)) / N;
      const lat = Math.asin(y) * 180 / Math.PI + (Math.random() - 0.5) * 0.3;
      const lng = O.wrapLng(((i * golden) % (2 * Math.PI)) * 180 / Math.PI + (Math.random() - 0.5) * 0.3);
      const u = Math.min(mw - 1, Math.floor(((lng + 180) / 360) * mw));
      const v = Math.min(mh - 1, Math.max(0, Math.floor(((90 - lat) / 180) * mh)));
      const water = mask[(v * mw + u) * 4] > 128;
      if (!water) (Math.random() < 0.38 ? sets.landBright : sets.landDim).push([lat, lng, 0.002]);
      else if (Math.random() < 0.035) sets.ocean.push([lat, lng, 0.001]);
    }
    for (let i = 0; i < 2600; i++) {
      const lat = Math.asin(2 * Math.random() - 1) * 180 / Math.PI;
      sets.shell.push([lat, Math.random() * 360 - 180, 0.006 + Math.pow(Math.random(), 3) * 0.12]);
    }
    return Object.entries(sets).map(([kind, points]) => ({ kind, points }));
  }

  // ── Dust drifting off the limb (screen-space overlay) ─────────────────────
  const dust = { canvas: null, ctx: null, parts: [], last: 0 };

  function globeScreenDisc() {
    const pov = world.pointOfView();
    const c = world.getScreenCoords(pov.lat, pov.lng, 0);
    const d = 1 + pov.altitude;
    const f = (window.innerHeight / 2) / Math.tan((world.camera().fov * Math.PI) / 360);
    return { x: c.x, y: c.y, r: f * Math.tan(Math.asin(1 / d)), d };
  }

  function startDust() {
    if (reduceMotion) return;
    const canvas = document.createElement("canvas");
    canvas.className = "dust-canvas";
    document.body.appendChild(canvas);
    dust.canvas = canvas;
    dust.ctx = canvas.getContext("2d");
    const size = () => {
      canvas.width = window.innerWidth * DPR; canvas.height = window.innerHeight * DPR;
      dust.ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    };
    window.addEventListener("resize", size);
    size();
    requestAnimationFrame(stepDust);
  }

  function spawnDust(disc) {
    // Leave from the right-hand limb and drift away like dust in a breeze.
    const th = (Math.random() - 0.5) * Math.PI * 0.95;
    const rr = disc.r * (0.86 + Math.random() * 0.16);
    const k = disc.r / 300;
    return {
      x: disc.x + Math.cos(th) * rr, y: disc.y + Math.sin(th) * rr,
      vx: (0.12 + Math.random() * 0.55) * k, vy: (Math.sin(th) * 0.12 + (Math.random() - 0.5) * 0.08) * k,
      life: 0, max: 3 + Math.random() * 6, s: Math.random() < 0.2 ? 1.6 : 1.1,
    };
  }

  function stepDust(now) {
    const dt = Math.min(0.05, (now - (dust.last || now)) / 1000);
    dust.last = now;
    const ctx = dust.ctx, W = window.innerWidth, H = window.innerHeight;
    ctx.clearRect(0, 0, W, H);
    const disc = globeScreenDisc();
    // Only when the whole planet is in frame, and not while exploring.
    const target = !state.exploring && state.introDone && disc.d > 2.1 ? 1 : 0;
    dust.vis = (dust.vis || 0) + (target - (dust.vis || 0)) * Math.min(1, dt * 2);
    const want = Math.round(1800 * dust.vis);
    while (dust.parts.length < want) {
      const p = spawnDust(disc);
      p.life = Math.random() * p.max;
      p.x += p.vx * 60 * p.life; p.y += p.vy * 60 * p.life;
      dust.parts.push(p);
    }
    if (dust.parts.length > want) dust.parts.length = want;
    for (let i = 0; i < dust.parts.length; i++) {
      let p = dust.parts[i];
      p.life += dt;
      if (p.life > p.max) { p = dust.parts[i] = spawnDust(disc); }
      p.x += p.vx * 60 * dt; p.y += p.vy * 60 * dt;
      const fade = 1 - p.life / p.max;
      ctx.globalAlpha = 0.8 * fade * Math.sqrt(fade) * dust.vis;
      ctx.fillStyle = "#c8d4d6";
      ctx.fillRect(p.x, p.y, p.s, p.s);
    }
    requestAnimationFrame(stepDust);
  }

  // ── Intro: dust streams in and condenses into the planet ──────────────────
  /* Projects the visible particles to screen, starts each one somewhere in a
   * dust cloud trailing off to the right, and flies it home. The 2D frame then
   * cross-fades to the identical WebGL particle globe. */
  function runIntro() {
    if (state.introStarted) return;
    state.introStarted = true;
    if (reduceMotion) return finishIntro();

    const W = window.innerWidth, H = window.innerHeight;
    const pov = world.pointOfView();
    const horizon = Math.cos(Math.acos(1 / (1 + pov.altitude)));
    const p0 = pov.lat * Math.PI / 180, l0 = pov.lng * Math.PI / 180;
    const pts = [];
    for (const set of particleSets) {
      if (set.kind === "shell") continue;
      const { color, size } = PARTICLE_STYLE[set.kind];
      const [r, g, b, a] = color.match(/[\d.]+/g).map(Number);
      for (const [lat, lng] of set.points) {
        const p = lat * Math.PI / 180, l = lng * Math.PI / 180;
        const cosc = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(l - l0);
        if (cosc < horizon + 0.01) continue;
        const sc = world.getScreenCoords(lat, lng, 0.002);
        pts.push({ x: sc.x, y: sc.y, c: `rgb(${r},${g},${b})`, a, s: size });
      }
    }
    if (!pts.length) return finishIntro();

    const canvas = document.createElement("canvas");
    canvas.className = "intro-canvas";
    canvas.width = W * DPR; canvas.height = H * DPR;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    ctx.scale(DPR, DPR);

    for (const p of pts) {
      if (Math.random() < 0.8) {
        p.sx = p.x + W * (0.25 + Math.random() * 0.95);
        p.sy = p.y + (Math.random() - 0.5) * H * 0.55;
      } else {
        p.sx = Math.random() * W * 1.2;
        p.sy = Math.random() * H;
      }
      p.delay = Math.random() * 1.1;
    }
    const FLY = 1.9, total = 1.1 + FLY;
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const t0 = performance.now();
    pts.sort((a, b) => (a.c < b.c ? -1 : 1));   // fewer fillStyle switches

    function frame(now) {
      const t = (now - t0) / 1000;
      ctx.clearRect(0, 0, W, H);
      let lastC = null;
      for (const p of pts) {
        const k = Math.min(1, Math.max(0, (t - p.delay) / FLY));
        const e = ease(k);
        if (p.c !== lastC) { ctx.fillStyle = p.c; lastC = p.c; }
        ctx.globalAlpha = p.a * (0.25 + 0.75 * k);
        ctx.fillRect(p.sx + (p.x - p.sx) * e - p.s / 2, p.sy + (p.y - p.sy) * e - p.s / 2, p.s, p.s);
      }
      if (t < total) return requestAnimationFrame(frame);
      finishIntro(canvas);
    }
    requestAnimationFrame(frame);
  }

  function finishIntro(canvas) {
    state.introStarted = true;
    state.introDone = true;
    document.body.classList.add("intro-done");
    const cfg = CHAPTERS[state.chapter];
    if (!state.exploring && cfg) controls.autoRotate = !!cfg.rotate && !reduceMotion;
    if (canvas) {
      canvas.classList.add("fade");
      setTimeout(() => canvas.remove(), 1200);
    }
  }

  loadMask(LAND_MASK, 800, 400)
    .then((mask) => {
      particleSets = buildParticles(mask, 800, 400);
      setParticles(particleSets);
      // Two frames so the camera and renderer have settled before projecting.
      requestAnimationFrame(() => requestAnimationFrame(runIntro));
    })
    .catch(() => finishIntro());
  startDust();

  refreshHtml();
  updateAttribution();
  activateChapter("hero", true);
  requestAnimationFrame(tick);
  // If the land data never loads, show the globe anyway.
  setTimeout(() => { if (!state.introStarted) finishIntro(); }, 8000);

  // Debug/test hook.
  window.DisasterWatch = { world, state, enterExplore, exitExplore, selectSatellite, onGround };
})();
