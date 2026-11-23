// OrbitWatch front-end. Plain JS, no build step.
// Motion is tied to the visitor's own scrolling, dragging and clicking; the only
// self-running effects are the upload ripples (on hover, drag and drop), and those
// are switched off for visitors who prefer reduced motion.
(() => {
  "use strict";

  const CLASSES = ["cyclone", "earthquake", "flood", "wildfire"];
  const MAX_BYTES = 10 * 1024 * 1024;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const smooth = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const pct = (p) => (p * 100).toFixed(1) + "%";

  const els = {
    form: $("upload-form"),
    input: $("file-input"),
    dropzone: $("dropzone"),
    empty: $("dropzone-empty"),
    preview: $("dropzone-preview"),
    previewImg: $("preview-img"),
    previewName: $("preview-name"),
    ripples: $("ripples"),
    classifyBtn: $("classify-btn"),
    result: $("result"),
    predLabel: $("pred-label"),
    predConf: $("pred-confidence"),
    notice: $("result-notice"),
    probs: $("probabilities"),
    imgOriginal: $("img-original"),
    imgGradcam: $("img-gradcam"),
    chips: $("chips"),
    grid: $("news-grid"),
    newsSub: $("news-sub"),
    newsProvider: $("news-provider"),
    storyCount: $("story-count"),
    radarTpl: $("radar-item-tpl"),
    storyTpl: $("story-card-tpl"),
    more: $("more-stories"),
    moreGrid: $("more-grid"),
    moreCount: $("more-count"),
    widget: $("float-widget"),
    widgetThumb: $("float-thumb"),
    widgetKicker: $("float-kicker"),
    widgetTitle: $("float-title"),
    widgetAction: $("float-action"),
  };

  let selectedFile = null;
  let previewUrl = null;
  let newsRequest = 0;
  let globeRef = null;
  let lastPrediction = null;

  // ── Theme (day / night) ───────────────────────────────────
  const root = document.documentElement;
  const toggle = $("mode-toggle");
  function applyTheme(theme, persist) {
    root.dataset.theme = theme;
    const next = theme === "day" ? "night" : "day";
    toggle.setAttribute("aria-label", `Switch to ${next} mode`);
    toggle.title = `Switch to ${next} mode`;
    if (persist) { try { localStorage.setItem("ow-theme", theme); } catch (e) {} }
    if (globeRef) {
      const cs = getComputedStyle(root);
      globeRef.setTheme({ dot: cs.getPropertyValue("--globe-dot").trim(), labelBg: cs.getPropertyValue("--globe-label").trim() });
    }
  }
  toggle.addEventListener("click", () => applyTheme(root.dataset.theme === "day" ? "night" : "day", true));
  applyTheme(root.dataset.theme || "day", false);

  // ── Probability rows ──────────────────────────────────────
  function renderProbabilities(probs) {
    const entries = probs ? Object.entries(probs).sort((a, b) => b[1] - a[1]) : CLASSES.map((c) => [c, 0]);
    els.probs.replaceChildren(
      ...entries.map(([cls, p], i) => {
        const li = document.createElement("li");
        li.className = "prob";
        li.dataset.class = cls;
        if (probs && i === 0) li.dataset.top = "true";
        li.innerHTML = `<div class="prob-labels"><span class="label-m"></span><span class="mono-m"></span></div>
          <div class="prob-track" role="presentation"><div class="prob-bar"></div></div>`;
        li.querySelector(".label-m").textContent = cls;
        li.querySelector(".mono-m").textContent = probs ? pct(p) : "—";
        li.querySelector(".prob-bar").style.width = probs ? `${Math.max(p * 100, 1.2)}%` : "0";
        return li;
      })
    );
  }

  function showNotice(html, tone = "warn") {
    els.notice.innerHTML = html;
    els.notice.dataset.tone = tone;
    els.notice.hidden = false;
  }

  function resetResult(label = "Awaiting an image", sub = "Choose a photograph above to see what the model makes of it.") {
    els.result.dataset.state = "empty";
    els.result.style.removeProperty("--pred");
    els.predLabel.textContent = label;
    els.predConf.textContent = sub;
    els.notice.hidden = true;
    renderProbabilities(null);
    for (const img of [els.imgOriginal, els.imgGradcam]) { img.hidden = true; img.removeAttribute("src"); }
  }

  // ── Ripples ───────────────────────────────────────────────
  els.ripples.innerHTML = "<i></i><i></i><i></i>";
  function burst() {
    if (reduceMotion) return;
    els.ripples.classList.remove("burst");
    void els.ripples.offsetWidth; // restart the one-shot animation
    els.ripples.classList.add("burst");
    setTimeout(() => els.ripples.classList.remove("burst"), 2200);
  }

  // ── Floating widget ───────────────────────────────────────
  let predictionVisible = false;
  function setWidget(state) {
    els.widget.dataset.state = state;
    if (state === "ready") {
      els.widgetKicker.textContent = "Ready";
      els.widgetTitle.textContent = selectedFile ? selectedFile.name : "Your image";
      els.widgetAction.textContent = "Classify";
    } else if (state === "loading") {
      els.widgetKicker.textContent = "Analysing";
      els.widgetTitle.textContent = "Reading the scene…";
      els.widgetAction.textContent = "View";
    } else if (state === "done" && lastPrediction) {
      els.widgetKicker.textContent = "Prediction";
      els.widgetTitle.textContent = `${cap(lastPrediction.label)} · ${pct(lastPrediction.confidence)}`;
      els.widgetAction.textContent = "View ↓";
    } else if (state === "error") {
      els.widgetKicker.textContent = "No prediction";
      els.widgetTitle.textContent = "See the note below";
      els.widgetAction.textContent = "View ↓";
    }
    updateWidgetVisibility();
  }
  let widgetDismissed = false;
  function updateWidgetVisibility() {
    els.widget.hidden = !selectedFile || predictionVisible || widgetDismissed;
  }
  $("float-close").addEventListener("click", () => { widgetDismissed = true; updateWidgetVisibility(); });
  els.widgetAction.addEventListener("click", () => {
    if (els.widget.dataset.state === "ready") els.form.requestSubmit();
    else $("prediction").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
  });
  new IntersectionObserver((entries) => {
    predictionVisible = entries[0].isIntersecting;
    updateWidgetVisibility();
  }, { threshold: 0.25 }).observe($("prediction"));

  // ── File selection ────────────────────────────────────────
  function selectFile(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showNotice("Please choose an image file (JPG, PNG or WebP).", "error");
      return;
    }
    if (file.size > MAX_BYTES) {
      showNotice("That image is larger than 10 MB. Try a smaller or compressed version.", "error");
      return;
    }
    selectedFile = file;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    els.previewImg.src = previewUrl;
    els.widgetThumb.src = previewUrl;
    els.previewName.textContent = file.name;
    els.empty.hidden = true;
    els.preview.hidden = false;
    els.classifyBtn.disabled = false;
    resetResult("Ready when you are", "Press Classify image to read this scene.");
    burst();
    widgetDismissed = false;
    setWidget("ready");
  }

  els.input.addEventListener("change", () => selectFile(els.input.files[0]));
  for (const type of ["dragenter", "dragover"]) {
    els.dropzone.addEventListener(type, (e) => { e.preventDefault(); els.dropzone.dataset.drag = "true"; });
  }
  for (const type of ["dragleave", "drop"]) {
    els.dropzone.addEventListener(type, (e) => { e.preventDefault(); els.dropzone.dataset.drag = "false"; });
  }
  els.dropzone.addEventListener("drop", (e) => selectFile(e.dataTransfer.files[0]));

  // ── Classify ──────────────────────────────────────────────
  els.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!selectedFile) return;
    els.classifyBtn.disabled = true;
    els.classifyBtn.textContent = "Classifying…";
    els.result.dataset.state = "loading";
    els.predLabel.textContent = "Reading the scene…";
    els.predConf.textContent = "This takes a moment on a CPU.";
    els.notice.hidden = true;
    setWidget("loading");

    const body = new FormData();
    body.append("file", selectedFile);
    try {
      const res = await fetch("/api/predict", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        resetResult("No prediction", "The image could not be classified.");
        if (res.status === 503) {
          showNotice("No trained model is loaded yet. Run <code>python train.py</code> to create <code>best_model.pth</code>, then restart the server.");
        } else {
          showNotice(escapeHtml(data.detail || "Something went wrong while classifying."), "error");
        }
        setWidget("error");
        return;
      }
      lastPrediction = data;
      widgetDismissed = false;
      renderPrediction(data);
      setWidget("done");
      setNewsCategory(data.label, { fromPrediction: true });
    } catch {
      resetResult("No prediction", "The server could not be reached.");
      showNotice("Couldn't reach the server. Check that it is running and try again.", "error");
      setWidget("error");
    } finally {
      els.classifyBtn.disabled = false;
      els.classifyBtn.textContent = "Classify image";
    }
  });

  function renderPrediction(data) {
    els.result.dataset.state = "done";
    els.result.style.setProperty("--pred", `var(--${data.label})`);
    els.predLabel.textContent = data.label;
    els.predConf.textContent = `${pct(data.confidence)} confidence`;
    renderProbabilities(data.probabilities);
    els.imgOriginal.src = data.original;
    els.imgOriginal.alt = "The image as the model saw it";
    els.imgGradcam.src = data.gradcam;
    els.imgGradcam.alt = `Grad-CAM heatmap showing the regions that led to the ${data.label} prediction`;
    els.imgOriginal.hidden = false;
    els.imgGradcam.hidden = false;
  }

  // ── Journal (news) ────────────────────────────────────────
  function relativeTime(iso) {
    if (!iso) return "";
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (!isFinite(diff)) return "";
    if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))}m ago`;
    if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
    if (diff < 86400 * 7) return `${Math.round(diff / 86400)}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function safeUrl(u) {
    try { const url = new URL(u); return url.protocol === "http:" || url.protocol === "https:" ? url.href : null; }
    catch { return null; }
  }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function mediaFor(article, cls, captionText) {
    const box = el("a", "feature-media");
    box.href = safeUrl(article.url);
    box.target = "_blank";
    box.rel = "noopener noreferrer";
    const tile = el("span", "tile");
    tile.dataset.class = cls || "flood";
    box.append(tile);
    const img = safeUrl(article.image);
    if (img) {
      const im = el("img");
      im.alt = "";
      im.loading = "lazy";
      im.referrerPolicy = "no-referrer";
      im.src = img;
      im.addEventListener("error", () => im.remove(), { once: true });
      box.append(im);
    }
    const cap = el("span", "media-caption");
    cap.append(el("span", null, captionText), el("span", null, "↗"));
    box.append(cap);
    return box;
  }

  function renderSkeleton() {
    els.grid.setAttribute("aria-busy", "true");
    const col = () => { const d = el("div", "skeleton"); d.style.minHeight = "420px"; return d; };
    els.grid.replaceChildren(col(), col(), col());
  }
  function renderNewsEmpty(message, retry) {
    const box = el("div", "news-empty");
    box.append(el("p", null, message));
    if (retry) {
      const b = el("button", "btn btn-box", "Try again");
      b.type = "button";
      b.addEventListener("click", retry);
      box.append(b);
    }
    els.grid.replaceChildren(box);
    els.grid.setAttribute("aria-busy", "false");
  }

  function renderJournal(articles, category) {
    const list = articles.filter((a) => safeUrl(a.url));
    if (!list.length) { renderNewsEmpty("No recent stories for this category. Try another filter."); return; }
    const [lead, ...rest] = list;
    const leadCls = lead.category || (category !== "all" ? category : null);

    const copy = el("div", "feature-copy");
    copy.append(el("span", "eyebrow strong", "The big picture"));
    const h = el("h3", "feature-title");
    const a = el("a", null, lead.title);
    a.href = safeUrl(lead.url); a.target = "_blank"; a.rel = "noopener noreferrer";
    h.append(a);
    copy.append(h);
    copy.append(el("p", "feature-sum",
      lead.summary || `Reported by ${lead.source || "a news outlet"}${lead.published_at ? `, ${relativeTime(lead.published_at)}` : ""}. Open the story for the full report.`));
    const link = el("a", "feature-link", `Read on ${lead.source || "the source"}  →`);
    link.href = safeUrl(lead.url); link.target = "_blank"; link.rel = "noopener noreferrer";
    copy.append(link);
    const foot = el("div", "feature-foot");
    foot.append(el("span", null, lead.source || "News"), el("span", null, leadCls ? cap(leadCls) : "Natural hazards"));
    copy.append(foot);

    const media = mediaFor(lead, leadCls, "A shift in perspective");

    const radar = el("div", "radar");
    const head = el("div", "radar-head");
    const shown = rest.slice(0, 3);
    head.append(el("span", "eyebrow strong", "On our radar"), el("span", "eyebrow", shown.length ? `01 — 0${shown.length}` : ""));
    radar.append(head);
    for (const item of shown) {
      const node = els.radarTpl.content.firstElementChild.cloneNode(true);
      node.href = safeUrl(item.url);
      const cls = item.category || (category !== "all" ? category : null);
      const thumb = node.querySelector(".radar-thumb");
      const tile = el("span", "tile");
      tile.dataset.class = cls || "flood";
      tile.style.position = "absolute"; tile.style.inset = "0";
      thumb.prepend(tile);
      const img = safeUrl(item.image);
      if (img) {
        const im = node.querySelector("img");
        im.src = img; im.hidden = false;
        im.addEventListener("error", () => im.remove(), { once: true });
      }
      node.querySelector(".radar-kicker").textContent = [cls ? cls + "s" : "News", item.source].filter(Boolean).join(" / ");
      node.querySelector(".radar-title").textContent = item.title;
      node.querySelector(".radar-time").textContent = relativeTime(item.published_at);
      radar.append(node);
    }
    if (!shown.length) radar.append(el("p", "feature-sum", "More stories will appear here as they are reported."));
    const note = el("p", "radar-note");
    note.innerHTML = "A considered selection.<br>A broader understanding.";
    radar.append(note);

    els.grid.replaceChildren(copy, media, radar);
    els.grid.setAttribute("aria-busy", "false");
    renderMore(rest.slice(3), category);
  }

  // Remaining stories as photo cards under the band.
  function renderMore(items, category) {
    const cards = items.slice(0, 6).map((item) => {
      const node = els.storyTpl.content.firstElementChild.cloneNode(true);
      node.href = safeUrl(item.url);
      const cls = item.category || (category !== "all" ? category : null);
      node.querySelector(".tile").dataset.class = cls || "flood";
      const img = safeUrl(item.image);
      if (img) {
        const im = node.querySelector("img");
        im.src = img; im.hidden = false;
        im.addEventListener("error", () => im.remove(), { once: true });
      }
      node.querySelector(".story-kicker").textContent = [cls ? cls + "s" : "News", item.source].filter(Boolean).join(" / ");
      node.querySelector(".story-time").textContent = relativeTime(item.published_at);
      node.querySelector(".story-title").textContent = item.title;
      node.querySelector(".story-sum").textContent = item.summary || "";
      return node;
    });
    els.moreGrid.replaceChildren(...cards);
    els.moreCount.textContent = cards.length ? `${String(cards.length).padStart(2, "0")} more` : "";
    els.more.hidden = !cards.length;
  }
  const PROVIDER_NAMES = { newsapi: "NewsAPI", gdelt: "GDELT", guardian: "The Guardian" };

  async function loadNews(category) {
    const req = ++newsRequest;
    renderSkeleton();
    els.more.hidden = true;
    try {
      const res = await fetch(`/api/news?category=${encodeURIComponent(category)}&limit=9`);
      const data = await res.json().catch(() => ({}));
      if (req !== newsRequest) return;
      if (!res.ok) throw new Error(data.detail || "News unavailable");
      const articles = data.articles || [];
      renderJournal(articles, category);
      if (category === "all") els.storyCount.textContent = String(articles.length).padStart(2, "0");
      const name = PROVIDER_NAMES[data.provider] || data.provider;
      els.newsProvider.textContent = data.stale ? `Via ${name} · saved stories` : `Via ${name}`;
    } catch {
      if (req !== newsRequest) return;
      els.newsProvider.textContent = "";
      renderNewsEmpty("The journal is unavailable right now. The news provider may be rate-limiting requests.", () => loadNews(category));
    }
  }

  function setNewsCategory(category, { fromPrediction = false } = {}) {
    for (const t of els.chips.querySelectorAll(".tab")) {
      t.setAttribute("aria-checked", String(t.dataset.category === category));
      t.tabIndex = t.dataset.category === category ? 0 : -1;
    }
    els.newsSub.textContent =
      category === "all"
        ? "Recent reporting on cyclones, earthquakes, floods and wildfires. Classify an image to follow its category."
        : fromPrediction
          ? `Recent reporting that matches your image: ${category === "flood" ? "floods" : category + "s"}.`
          : `Recent reporting on ${category === "flood" ? "floods" : category + "s"}.`;
    loadNews(category);
  }
  els.chips.addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (t) setNewsCategory(t.dataset.category);
  });
  els.chips.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const tabs = [...els.chips.querySelectorAll(".tab")];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    setNewsCategory(next.dataset.category);
  });

  // ── Classify stage: zoom into the full stop, open the grid, assemble the control ──
  function initClassifyStage() {
    const sec = $("classify");
    const stage = $("classify-stage");
    const intro = $("intro-layer");
    const period = $("period");
    const portal = $("portal");
    const canvas = $("assemble");
    const ctx = canvas.getContext("2d");
    if (reduceMotion) { sec.dataset.formed = "true"; return { formedOffset: () => sec.offsetTop }; }

    let geo = null;
    let particles = [];
    let lastQ = -1;

    function measure() {
      intro.style.transform = "none";
      const s = stage.getBoundingClientRect();
      const p = period.getBoundingClientRect();
      const i = intro.getBoundingClientRect();
      // centre of the full stop's visible dot (lower part of the glyph box)
      const px = p.left + p.width / 2 - s.left;
      const py = p.top + p.height * 0.72 - s.top;
      geo = {
        px, py,
        ox: px - (i.left - s.left), oy: py - (i.top - s.top),
        maxR: Math.hypot(Math.max(px, s.width - px), Math.max(py, s.height - py)) + 4,
      };
      intro.style.transformOrigin = `${geo.ox}px ${geo.oy}px`;
      buildParticles();
    }

    // Sample the formed control (icon ring, title, button) into dot targets.
    function buildParticles() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const box = canvas.getBoundingClientRect();
      if (!box.width) return;
      canvas.width = Math.round(box.width * dpr);
      canvas.height = Math.round(box.height * dpr);
      const off = document.createElement("canvas");
      off.width = Math.ceil(box.width); off.height = Math.ceil(box.height);
      const o = off.getContext("2d");
      o.fillStyle = "#000"; o.strokeStyle = "#000";
      const targets = { ring: [], text: [], fill: [] };
      const nodes = els.empty.querySelectorAll("[data-target]");
      const rects = [];
      for (const n of nodes) {
        const r = n.getBoundingClientRect();
        const x = r.left - box.left, y = r.top - box.top;
        const kind = n.dataset.target;
        o.clearRect(0, 0, off.width, off.height);
        if (kind === "ring") {
          o.lineWidth = 2; o.beginPath(); o.arc(x + r.width / 2, y + r.height / 2, r.width / 2 - 1, 0, Math.PI * 2); o.stroke();
          o.lineWidth = 2; o.beginPath();
          const cx = x + r.width / 2, cy = y + r.height / 2;
          o.moveTo(cx, cy + 9); o.lineTo(cx, cy - 9); o.moveTo(cx - 6, cy - 3); o.lineTo(cx, cy - 9); o.lineTo(cx + 6, cy - 3); o.stroke();
        } else if (kind === "text") {
          const cs = getComputedStyle(n);
          o.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          o.textBaseline = "middle"; o.textAlign = "center";
          o.fillText(n.textContent, x + r.width / 2, y + r.height / 2);
        } else {
          o.beginPath(); o.roundRect ? o.roundRect(x, y, r.width, r.height, 4) : o.rect(x, y, r.width, r.height); o.fill();
        }
        const data = o.getImageData(0, 0, off.width, off.height).data;
        const step = kind === "fill" ? 5 : kind === "text" ? 3 : 3;
        for (let yy = Math.max(0, Math.floor(y) - 4); yy < Math.min(off.height, y + r.height + 4); yy += step) {
          for (let xx = Math.max(0, Math.floor(x) - 4); xx < Math.min(off.width, x + r.width + 4); xx += step) {
            if (data[(yy * off.width + xx) * 4 + 3] > 120) targets[kind].push(xx, yy);
          }
        }
        rects.push(r);
      }
      let seed = 11;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      particles = [];
      const add = (list, kind, keep) => {
        for (let k = 0; k < list.length; k += 2) {
          if (rnd() > keep) continue;
          particles.push({
            tx: list[k], ty: list[k + 1], kind,
            sx: rnd() * box.width, sy: rnd() * box.height,
            d: rnd() * 0.45, s: kind === "fill" ? 2.2 : 1.6,
          });
        }
      };
      add(targets.ring, "ring", 1);
      add(targets.text, "text", Math.min(1, 1600 / Math.max(1, targets.text.length / 2)));
      add(targets.fill, "fill", 1);
      geo.dpr = dpr;
    }

    function drawDots(a) {
      const { dpr } = geo;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (a <= 0 || a >= 1 || !els.preview.hidden) return;
      const cs = getComputedStyle(root);
      const ink = cs.getPropertyValue("--text").trim();
      const acc = cs.getPropertyValue("--accent").trim();
      for (const p of particles) {
        const t = smooth((a - p.d) / (1 - 0.45));
        const x = p.sx + (p.tx - p.sx) * t, y = p.sy + (p.ty - p.sy) * t;
        ctx.globalAlpha = 0.25 + 0.75 * t;
        ctx.fillStyle = p.kind === "fill" ? acc : ink;
        ctx.fillRect(x, y, p.s, p.s);
      }
      ctx.globalAlpha = 1;
    }

    function progress() {
      const r = sec.getBoundingClientRect();
      return clamp(-r.top / (sec.offsetHeight - window.innerHeight));
    }

    function paint() {
      if (!geo) measure();
      const q = progress();
      if (q === lastQ) return;
      lastQ = q;
      const z = smooth((q - 0.04) / 0.42);
      // zoom into the full stop
      intro.style.transform = `scale(${1 + Math.pow(z, 2.2) * 26})`;
      intro.style.opacity = String(1 - smooth((q - 0.16) / 0.22));
      // the full stop opens into the grid
      const rad = 3 + Math.pow(z, 2.4) * geo.maxR;
      portal.style.clipPath = `circle(${rad}px at ${geo.px}px ${geo.py}px)`;
      // the control assembles from dots
      const a = clamp((q - 0.5) / 0.3);
      drawDots(a);
      const ui = smooth((a - 0.82) / 0.18);
      els.empty.style.opacity = String(els.preview.hidden ? ui : 1);
      [...els.empty.children].forEach((c) => (c.style.opacity = ""));
      sec.dataset.formed = String(a >= 0.82 || !els.preview.hidden);
      portal.style.pointerEvents = rad > 60 ? "auto" : "none";
    }

    window.addEventListener("scroll", paint, { passive: true });
    window.addEventListener("resize", () => { geo = null; lastQ = -1; paint(); });
    document.fonts && document.fonts.ready.then(() => { geo = null; lastQ = -1; paint(); });
    paint();

    return { formedOffset: () => sec.offsetTop + (sec.offsetHeight - window.innerHeight) * 0.9 };
  }

  // Links to #classify land on the formed upload control rather than the start of the zoom.
  function bindClassifyLinks(stage) {
    document.querySelectorAll('a[href="#classify"]').forEach((a) =>
      a.addEventListener("click", (e) => {
        e.preventDefault();
        window.scrollTo({ top: stage.formedOffset(), behavior: "auto" });
        history.replaceState(null, "", "#classify");
      })
    );
  }

  // ── Cover: globe + scroll chapters ───────────────────────
  function initCover() {
    const cover = $("top");
    const canvas = $("globe");
    if (!cover || !canvas || !window.DisasterGlobe) return;
    const { Globe, formatCoord, wrapLon } = window.DisasterGlobe;
    const chapters = [...cover.querySelectorAll(".chapter")];
    const ticks = [...cover.querySelectorAll(".chapter-ticks li")];
    const selection = $("selection");
    const stops = chapters.map((c) => ({ lat: +c.dataset.lat, lon: +c.dataset.lon, hotspot: c.dataset.hotspot }));

    if (window.matchMedia("(hover: none)").matches) {
      const hint = cover.querySelector(".hint-text");
      if (hint) hint.textContent = "Scroll to begin, or tap Earth to fly there";
    }

    const globe = new Globe(canvas, {
      onSelect: ({ lat, lon }) => {
        selection.hidden = false;
        selection.textContent = `Target · ${formatCoord(lat, lon)}`;
        const pc = $("panel-coords");
        if (pc) pc.textContent = formatCoord(lat, lon);
      },
    });
    globe.hotspots = chapters
      .filter((c) => c.dataset.hotspot)
      .map((c) => ({ id: c.dataset.hotspot, label: c.dataset.hotspot, lat: +c.dataset.lat, lon: +c.dataset.lon }));
    globe.load("/static/land-mask.bin").catch(() => canvas.remove());
    globeRef = globe;
    applyTheme(root.dataset.theme, false);

    // ── Gradient panel that grows out of the scroll-hint mouse ──
    const reveal = $("reveal");
    const mouse = $("mouse");
    const copy = $("cover-copy");
    const intro = chapters[0];
    // base, base2, mid, core per chapter: intro, cyclone, earthquake, flood, wildfire, your turn
    const PALETTES = [
      ["#8F9C98", "#A9B3AE", "#C9C3AE", "#C48A78"],
      ["#8C98A3", "#A8B2BA", "#C2C7CE", "#8E9DB4"],
      ["#9A9387", "#B3AB9C", "#CFC4AE", "#A9826A"],
      ["#8A9C99", "#A7B6B2", "#C3CEC8", "#7E9C9E"],
      ["#9E978B", "#B8B0A0", "#D6C8AA", "#C08372"],
      ["#8F9C98", "#A9B3AE", "#C9C3AE", "#C48A78"],
    ].map((pal) => pal.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))));
    const mix = (a, b, t) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(",")})`;
    let geo = null;
    function measure() {
      const stage = cover.querySelector(".cover-stage").getBoundingClientRect();
      const m = mouse.getBoundingClientRect();
      const c = copy.getBoundingClientRect();
      const pad = window.innerWidth < 820 ? 20 : 44;
      const left = Math.max(8, c.left - stage.left - pad);
      geo = {
        from: { x: m.left - stage.left + 2, y: m.top - stage.top + 2, w: m.width - 4, h: m.height - 4, r: 7 },
        to: {
          x: left, y: c.top - stage.top - pad,
          w: Math.min(stage.width - left - 8, c.width + pad * 2), h: c.height + pad * 2, r: 3,
        },
      };
    }
    function paintReveal(p) {
      if (!geo) measure();
      const r = Math.max(0, Math.min(1, p / 0.7));
      const e = window.DisasterGlobe.ease(r);
      const { from: a, to: b } = geo;
      const L = (k) => a[k] + (b[k] - a[k]) * e;
      Object.assign(reveal.style, {
        left: `${L("x")}px`, top: `${L("y")}px`, width: `${L("w")}px`, height: `${L("h")}px`,
        borderRadius: `${L("r")}px`,
      });
      const i = Math.min(PALETTES.length - 2, Math.floor(p));
      const t = Math.min(1, Math.max(0, p - i));
      ["--base", "--base2", "--mid", "--core"].forEach((v, k) =>
        reveal.style.setProperty(v, mix(PALETTES[i][k], PALETTES[i + 1][k], t))
      );
      // intro copy steps aside while the panel opens; chapter copy lands in ink once it has
      intro.style.opacity = String(Math.max(0, 1 - r * 2.2));
      cover.dataset.oncard = String(r > 0.55);
    }
    window.addEventListener("resize", () => { geo = null; lastProgress = -1; onScroll(); });
    document.fonts && document.fonts.ready.then(() => { geo = null; lastProgress = -1; onScroll(); });

    let current = -1;
    let lastProgress = -1;
    function onScroll() {
      const rect = cover.getBoundingClientRect();
      const span = cover.offsetHeight - window.innerHeight;
      const p = Math.max(0, Math.min(1, -rect.top / span)) * (stops.length - 1);
      if (p === lastProgress) return;
      lastProgress = p;

      const i = Math.min(stops.length - 2, Math.floor(p));
      const f = window.DisasterGlobe.ease(Math.min(1, Math.max(0, p - i)));
      const a = stops[i], b = stops[i + 1];
      globe.setView(a.lat + (b.lat - a.lat) * f, a.lon + wrapLon(b.lon - a.lon) * f);

      paintReveal(p);

      const idx = Math.round(p);
      if (idx !== current) {
        current = idx;
        chapters.forEach((c, k) => (c.dataset.active = String(k === idx)));
        ticks.forEach((t, k) => (t.dataset.active = String(k === idx)));
        globe.activeHotspot = stops[idx].hotspot || null;
        globe.draw();
      }
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // ── Header: solid after the cover, tab follows the visible section ──
  function initHeader() {
    const header = $("site-header");
    const cover = $("top");
    const links = [...document.querySelectorAll(".nav a[data-section]")];
    const sections = links.map((a) => document.getElementById(a.dataset.section));
    function update() {
      const coverEnd = cover ? cover.offsetTop + cover.offsetHeight - window.innerHeight : 0;
      header.dataset.solid = String(window.scrollY > coverEnd - 1);
      const probe = window.scrollY + window.innerHeight * 0.35;
      let active = null;
      sections.forEach((s, i) => { if (s && s.offsetTop <= probe) active = i; });
      if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 2) active = sections.length - 1;
      links.forEach((a, i) => {
        if (i === active) a.setAttribute("aria-current", "true");
        else a.removeAttribute("aria-current");
      });
    }
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();
  }

  // ── "Scroll down" typed out next to the arrow ─────────────
  function initTypewriter() {
    const node = document.querySelector(".typewriter-text");
    if (!node) return;
    const word = "Scroll down";
    if (reduceMotion) { node.textContent = word; return; }
    let i = 0, dir = 1;
    (function tick() {
      i += dir;
      node.textContent = word.slice(0, i);
      let wait = dir > 0 ? 95 : 45;
      if (i === word.length) { dir = -1; wait = 2200; }
      else if (i === 0) { dir = 1; wait = 600; }
      setTimeout(tick, wait);
    })();
  }

  // ── Init ──────────────────────────────────────────────────
  initTypewriter();
  initCover();
  const stage = initClassifyStage();
  bindClassifyLinks(stage);
  initHeader();
  resetResult();
  setNewsCategory("all");
})();
