// Disaster Lens front-end. Plain JS, no build step, no animation.
(() => {
  "use strict";

  const CLASSES = ["cyclone", "earthquake", "flood", "wildfire"];
  const MAX_BYTES = 10 * 1024 * 1024;
  const $ = (id) => document.getElementById(id);

  const els = {
    status: $("status"),
    form: $("upload-form"),
    input: $("file-input"),
    dropzone: $("dropzone"),
    empty: $("dropzone-empty"),
    preview: $("dropzone-preview"),
    previewImg: $("preview-img"),
    previewName: $("preview-name"),
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
    footerProvider: $("footer-provider"),
    tpl: $("news-card-tpl"),
  };

  let selectedFile = null;
  let previewUrl = null;
  let newsRequest = 0;

  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const pct = (p) => (p * 100).toFixed(1) + "%";

  // ── Status ────────────────────────────────────────────────
  function setStatus(state, label) {
    els.status.dataset.state = state;
    els.status.querySelector(".status-label").textContent = label;
  }

  async function checkHealth() {
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      if (data.model_ready) setStatus("ready", "Model ready");
      else setStatus("missing", "No model loaded");
      const name = data.news_provider === "newsapi" ? "NewsAPI" : "GDELT";
      els.footerProvider.textContent = `News via ${name}`;
    } catch {
      setStatus("error", "Server unreachable");
    }
  }

  // ── Probability rows ──────────────────────────────────────
  function renderProbabilities(probs) {
    const entries = probs
      ? Object.entries(probs).sort((a, b) => b[1] - a[1])
      : CLASSES.map((c) => [c, 0]);
    els.probs.replaceChildren(
      ...entries.map(([cls, p], i) => {
        const li = document.createElement("li");
        li.className = "prob";
        li.dataset.class = cls;
        if (probs && i === 0) li.dataset.top = "true";
        li.innerHTML = `
          <div class="prob-labels">
            <span class="label-m"></span>
            <span class="mono-m"></span>
          </div>
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

  function resetResult(message = "Awaiting an image") {
    els.result.dataset.state = "empty";
    els.result.style.removeProperty("--pred");
    els.predLabel.textContent = "—";
    els.predConf.textContent = message;
    els.notice.hidden = true;
    renderProbabilities(null);
    for (const img of [els.imgOriginal, els.imgGradcam]) {
      img.hidden = true;
      img.removeAttribute("src");
    }
  }

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
    els.previewName.textContent = file.name;
    els.empty.hidden = true;
    els.preview.hidden = false;
    els.classifyBtn.disabled = false;
    resetResult("Ready to classify");
  }

  els.input.addEventListener("change", () => selectFile(els.input.files[0]));

  for (const type of ["dragenter", "dragover"]) {
    els.dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      els.dropzone.dataset.drag = "true";
    });
  }
  for (const type of ["dragleave", "drop"]) {
    els.dropzone.addEventListener(type, (e) => {
      e.preventDefault();
      els.dropzone.dataset.drag = "false";
    });
  }
  els.dropzone.addEventListener("drop", (e) => selectFile(e.dataTransfer.files[0]));

  // ── Classify ──────────────────────────────────────────────
  els.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!selectedFile) return;

    els.classifyBtn.disabled = true;
    els.classifyBtn.textContent = "Classifying…";
    els.result.dataset.state = "loading";
    els.predConf.textContent = "Analysing image…";
    els.notice.hidden = true;

    const body = new FormData();
    body.append("file", selectedFile);

    try {
      const res = await fetch("/api/predict", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        resetResult("No prediction");
        if (res.status === 503) {
          showNotice(
            "No trained model is loaded yet. Run <code>python train.py</code> to create " +
              "<code>best_model.pth</code>, then restart the server."
          );
          setStatus("missing", "No model loaded");
        } else {
          showNotice(escapeHtml(data.detail || "Something went wrong while classifying."), "error");
        }
        return;
      }
      renderPrediction(data);
      setNewsCategory(data.label, { fromPrediction: true });
    } catch {
      resetResult("No prediction");
      showNotice("Couldn't reach the server. Check that it is running and try again.", "error");
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

  // ── News ──────────────────────────────────────────────────
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
    try {
      const url = new URL(u);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch {
      return null;
    }
  }

  function renderSkeleton() {
    els.grid.setAttribute("aria-busy", "true");
    els.grid.replaceChildren(
      ...Array.from({ length: 3 }, () => {
        const d = document.createElement("div");
        d.className = "news-skeleton";
        d.setAttribute("aria-hidden", "true");
        d.innerHTML = "<span></span><span></span><span></span><span></span>";
        return d;
      })
    );
  }

  function renderNewsEmpty(message, retry) {
    const box = document.createElement("div");
    box.className = "news-empty";
    const p = document.createElement("p");
    p.className = "body-m";
    p.textContent = message;
    box.append(p);
    if (retry) {
      const b = document.createElement("button");
      b.className = "btn btn-secondary";
      b.type = "button";
      b.textContent = "Try again";
      b.addEventListener("click", retry);
      box.append(b);
    }
    els.grid.replaceChildren(box);
    els.grid.setAttribute("aria-busy", "false");
  }

  function renderNews(articles, category) {
    const cards = [];
    for (const a of articles) {
      const href = safeUrl(a.url);
      if (!href) continue;
      const node = els.tpl.content.firstElementChild.cloneNode(true);
      node.href = href;
      const cls = a.category || (category !== "all" ? category : null);
      const badge = node.querySelector(".badge");
      if (cls) {
        badge.dataset.class = cls;
        badge.querySelector(".badge-label").textContent = cls;
      } else {
        badge.remove();
      }
      const meta = [a.source, relativeTime(a.published_at)].filter(Boolean).join(" · ");
      node.querySelector(".news-source").textContent = meta;
      node.querySelector(".news-title").textContent = a.title;
      node.querySelector(".news-summary").textContent = a.summary || "";
      const img = safeUrl(a.image);
      if (img) {
        const wrap = node.querySelector(".news-image");
        const el = wrap.querySelector("img");
        el.src = img;
        el.addEventListener("error", () => wrap.remove(), { once: true });
        wrap.hidden = false;
      }
      cards.push(node);
    }
    if (!cards.length) {
      renderNewsEmpty("No recent articles for this category. Try another filter.");
      return;
    }
    els.grid.replaceChildren(...cards);
    els.grid.setAttribute("aria-busy", "false");
  }

  async function loadNews(category) {
    const req = ++newsRequest;
    renderSkeleton();
    try {
      const res = await fetch(`/api/news?category=${encodeURIComponent(category)}&limit=9`);
      const data = await res.json().catch(() => ({}));
      if (req !== newsRequest) return; // a newer request superseded this one
      if (!res.ok) throw new Error(data.detail || "News unavailable");
      renderNews(data.articles || [], category);
      const name = data.provider === "newsapi" ? "NewsAPI" : "GDELT";
      const when = data.fetched_at
        ? new Date(data.fetched_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
        : "";
      els.newsProvider.textContent = `Source: ${name}${when ? ` · fetched ${when}` : ""}`;
    } catch {
      if (req !== newsRequest) return;
      els.newsProvider.textContent = "";
      renderNewsEmpty("News is unavailable right now. The provider may be rate-limiting requests.", () =>
        loadNews(category)
      );
    }
  }

  function setNewsCategory(category, { fromPrediction = false } = {}) {
    for (const chip of els.chips.querySelectorAll(".chip")) {
      chip.setAttribute("aria-checked", String(chip.dataset.category === category));
      chip.tabIndex = chip.dataset.category === category ? 0 : -1;
    }
    els.newsSub.textContent =
      category === "all"
        ? "Recent reporting on natural disasters. Classify an image to focus on its category."
        : fromPrediction
          ? `Recent reporting matching the predicted class — ${category}.`
          : `Recent reporting on ${category === "flood" ? "floods" : category + "s"}.`;
    loadNews(category);
  }

  els.chips.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (chip) setNewsCategory(chip.dataset.category);
  });

  // Arrow-key navigation inside the radiogroup.
  els.chips.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const chips = [...els.chips.querySelectorAll(".chip")];
    const i = chips.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = chips[(i + (e.key === "ArrowRight" ? 1 : chips.length - 1)) % chips.length];
    next.focus();
    setNewsCategory(next.dataset.category);
  });

  // ── Init ──────────────────────────────────────────────────
  resetResult();
  checkHealth();
  setNewsCategory("all");
})();
