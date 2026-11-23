"""Related-news provider.

Providers are tried in order until one returns stories:
  1. NewsAPI (https://newsapi.org), when NEWS_API_KEY is set
  2. GDELT DOC 2.0, free and key-less, many outlets
  3. The Guardian Open Platform, using GUARDIAN_API_KEY or the public "test" key;
     reliable, with photos and standfirsts
Set NEWS_PROVIDER to "newsapi", "gdelt" or "guardian" to use only that one.

Stories without a photo get one from the article's own preview image (og:image).
Results are normalised to one shape and cached in memory.
"""

from __future__ import annotations

import html
import json
import re
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

CATEGORIES = ("cyclone", "earthquake", "flood", "wildfire")

# Search terms per class. Kept specific so results stay on-topic.
_TERMS = {
    "cyclone": ["cyclone", "hurricane", "typhoon"],
    "earthquake": ["earthquake", "seismic", "aftershock"],
    "flood": ["flood", "flooding", "flash flood"],
    "wildfire": ["wildfire", "bushfire", "forest fire"],
}

CACHE_TTL = int(os.environ.get("NEWS_CACHE_TTL", 15 * 60))
TIMEOUT = 15
# GDELT asks clients to send at most one request every 5 seconds.
GDELT_MIN_INTERVAL = float(os.environ.get("GDELT_MIN_INTERVAL", 5.5))
USER_AGENT = "OrbitWatch/1.0 (+news panel)"


class NewsError(RuntimeError):
    pass


def _or_query(terms: list[str]) -> str:
    quoted = [f'"{t}"' if " " in t else t for t in terms]
    return "(" + " OR ".join(quoted) + ")"


def _terms_for(category: str | None) -> list[str]:
    if category in _TERMS:
        return _TERMS[category]
    return [t for c in CATEGORIES for t in _TERMS[c]]


def _classify(text: str, fallback: str | None) -> str | None:
    text = text.lower()
    # The requested category wins when its terms appear (e.g. "cyclone triggers floods"
    # stays a flood story under the flood filter).
    if fallback in _TERMS and any(t in text for t in _TERMS[fallback]):
        return fallback
    for cat in CATEGORIES:
        if any(t in text for t in _TERMS[cat]):
            return cat
    return fallback


def _get_json(url: str, headers: dict[str, str] | None = None) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        raise NewsError(f"News provider returned HTTP {e.code}") from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise NewsError("Could not reach the news provider") from e
    try:
        # strict=False: GDELT titles occasionally contain raw control characters.
        return json.loads(body, strict=False)
    except json.JSONDecodeError as e:
        # GDELT answers rate-limit / query errors with plain text.
        raise NewsError(body.strip()[:200] or "Unexpected news response") from e


def _fetch_newsapi(category: str | None, limit: int, key: str) -> list[dict]:
    params = {
        "q": _or_query(_terms_for(category)),
        "searchIn": "title,description",
        "language": "en",
        "sortBy": "publishedAt",
        "pageSize": str(min(limit * 2, 100)),
    }
    url = "https://newsapi.org/v2/everything?" + urllib.parse.urlencode(params)
    data = _get_json(url, {"X-Api-Key": key})
    if data.get("status") != "ok":
        raise NewsError(data.get("message", "NewsAPI error"))
    out = []
    for a in data.get("articles", []):
        title = (a.get("title") or "").strip()
        if not title or title == "[Removed]" or not a.get("url"):
            continue
        summary = (a.get("description") or "").strip()
        out.append({
            "title": title,
            "summary": summary,
            "url": a["url"],
            "source": (a.get("source") or {}).get("name") or "",
            "published_at": a.get("publishedAt"),
            "image": a.get("urlToImage"),
            "category": _classify(f"{title} {summary}", category),
        })
    return out


def _gdelt_time(s: str | None) -> str | None:
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).isoformat()
    except ValueError:
        return None


_gdelt_gate = threading.Lock()
_gdelt_last = 0.0


def _gdelt_request(url: str) -> dict:
    """Call GDELT no faster than its published rate limit, retrying once if told to slow down."""
    global _gdelt_last
    with _gdelt_gate:
        for attempt in range(2):
            wait = _gdelt_last + GDELT_MIN_INTERVAL - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            try:
                return _get_json(url)
            except NewsError as e:
                if attempt == 0 and "limit requests" in str(e).lower():
                    continue
                raise
            finally:
                _gdelt_last = time.monotonic()
    raise NewsError("News provider is rate-limiting requests")


def _fetch_gdelt(category: str | None, limit: int) -> list[dict]:
    params = {
        "query": f"{_or_query(_terms_for(category))} sourcelang:english",
        "mode": "ArtList",
        "format": "json",
        "sort": "DateDesc",
        "timespan": "7d",
        "maxrecords": str(min(limit * 3, 75)),
    }
    url = "https://api.gdeltproject.org/api/v2/doc/doc?" + urllib.parse.urlencode(params)
    data = _gdelt_request(url)
    out = []
    for a in data.get("articles", []):
        title = (a.get("title") or "").strip()
        if not title or not a.get("url"):
            continue
        out.append({
            "title": title,
            "summary": "",
            "url": a["url"],
            "source": a.get("domain") or "",
            "published_at": _gdelt_time(a.get("seendate")),
            "image": a.get("socialimage") or None,
            "category": _classify(title, category),
        })
    return out


def _dedupe(items: list[dict], limit: int) -> list[dict]:
    seen, out = set(), []
    for it in items:
        key = it["title"].lower()[:80]
        if key in seen:
            continue
        seen.add(key)
        out.append(it)
        if len(out) >= limit:
            break
    return out


_TAG = re.compile(r"<[^>]+>")


def _strip_html(text: str) -> str:
    return html.unescape(_TAG.sub("", text or "")).strip()


def _fetch_guardian(category: str | None, limit: int) -> list[dict]:
    params = {
        "q": " OR ".join(f'"{t}"' if " " in t else t for t in _terms_for(category)),
        "query-fields": "headline,standfirst",
        "order-by": "newest",
        "page-size": str(min(limit * 2, 50)),
        "show-fields": "thumbnail,trailText",
        "api-key": os.environ.get("GUARDIAN_API_KEY", "test"),
    }
    url = "https://content.guardianapis.com/search?" + urllib.parse.urlencode(params)
    data = _get_json(url).get("response", {})
    if data.get("status") != "ok":
        raise NewsError(data.get("message", "Guardian API error"))
    out = []
    for a in data.get("results", []):
        title = (a.get("webTitle") or "").strip()
        if not title or not a.get("webUrl"):
            continue
        fields = a.get("fields") or {}
        summary = _strip_html(fields.get("trailText", ""))
        out.append({
            "title": title,
            "summary": summary,
            "url": a["webUrl"],
            "source": "The Guardian",
            "published_at": a.get("webPublicationDate"),
            "image": fields.get("thumbnail") or None,
            "category": _classify(f"{title} {summary}", category),
        })
    return out


# ── Preview images ─────────────────────────────────────────────────────────────
_OG = re.compile(
    r"""<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*>""", re.I
)
_CONTENT = re.compile(r"""content=["']([^"']+)["']""", re.I)
_image_cache: dict[str, str | None] = {}


def _preview_image(page_url: str) -> str | None:
    """Return the article's og:image / twitter:image, or None. Reads at most 300 KB."""
    if page_url in _image_cache:
        return _image_cache[page_url]
    found = None
    try:
        req = urllib.request.Request(page_url, headers={"User-Agent": "Mozilla/5.0 (compatible; OrbitWatch/1.0)"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            if "html" in resp.headers.get("Content-Type", "html"):
                head = resp.read(300_000).decode("utf-8", errors="replace")
                for tag in _OG.findall(head):
                    m = _CONTENT.search(tag)
                    if m:
                        candidate = urllib.parse.urljoin(page_url, html.unescape(m.group(1).strip()))
                        if candidate.startswith(("http://", "https://")):
                            found = candidate
                            break
    except Exception:
        found = None
    _image_cache[page_url] = found
    return found


def _fill_images(items: list[dict], max_lookups: int = 9) -> None:
    missing = [it for it in items if not it.get("image")][:max_lookups]
    if not missing:
        return
    with ThreadPoolExecutor(max_workers=6) as pool:
        for it, img in zip(missing, pool.map(lambda it: _preview_image(it["url"]), missing)):
            it["image"] = img


_FETCHERS = {
    "newsapi": lambda cat, n: _fetch_newsapi(cat, n, os.environ["NEWS_API_KEY"]),
    "gdelt": _fetch_gdelt,
    "guardian": _fetch_guardian,
}


class NewsService:
    def __init__(self, fill_images: bool = True):
        self._cache: dict[tuple, tuple[float, dict]] = {}
        self._lock = threading.Lock()
        self._fill_images = fill_images

    @property
    def chain(self) -> list[str]:
        forced = os.environ.get("NEWS_PROVIDER", "").lower()
        if forced in _FETCHERS and (forced != "newsapi" or os.environ.get("NEWS_API_KEY")):
            return [forced]
        return (["newsapi"] if os.environ.get("NEWS_API_KEY") else []) + ["gdelt", "guardian"]

    @property
    def provider(self) -> str:
        return self.chain[0]

    def get(self, category: str | None, limit: int = 9) -> dict:
        category = category if category in CATEGORIES else None
        limit = max(1, min(limit, 30))
        key = (category, limit)
        now = time.time()
        with self._lock:
            hit = self._cache.get(key)
            if hit and now - hit[0] < CACHE_TTL:
                return hit[1]

        errors = []
        for name in self.chain:
            try:
                items = _dedupe(_FETCHERS[name](category, limit), limit)
            except NewsError as e:
                errors.append(f"{name}: {e}")
                continue
            if not items:
                errors.append(f"{name}: no results")
                continue
            if self._fill_images:
                _fill_images(items)
            result = {
                "category": category or "all",
                "provider": name,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "articles": items,
            }
            with self._lock:
                self._cache[key] = (now, result)
            return result

        fallback = self._fallback(category, limit)
        if fallback is not None:
            return fallback
        raise NewsError("; ".join(errors) or "No news provider available")

    def _fallback(self, category: str | None, limit: int) -> dict | None:
        """Serve the last good stories when every provider fails: same query first,
        otherwise cached "all" stories filtered to the requested category."""
        with self._lock:
            entries = list(self._cache.items())
        same = [v for k, (_, v) in entries if k[0] == category]
        if same:
            return {**same[0], "stale": True}
        if category:
            pool = [a for k, (_, v) in entries if k[0] is None for a in v["articles"] if a.get("category") == category]
            if pool:
                return {
                    "category": category, "provider": entries[0][1][1]["provider"], "stale": True,
                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                    "articles": _dedupe(pool, limit),
                }
        return None
