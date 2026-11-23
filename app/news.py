"""Related-news provider.

Uses NewsAPI (https://newsapi.org) when NEWS_API_KEY is set, otherwise falls back
to the free, key-less GDELT DOC 2.0 API. Results are normalised to one shape and
cached in memory so the page stays fast and well within provider rate limits.
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
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
TIMEOUT = 8
USER_AGENT = "DisasterLens/1.0 (+news panel)"


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
        return json.loads(body)
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
    data = _get_json(url)
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


class NewsService:
    def __init__(self):
        self._cache: dict[tuple, tuple[float, dict]] = {}
        self._lock = threading.Lock()

    @property
    def provider(self) -> str:
        return "newsapi" if os.environ.get("NEWS_API_KEY") else "gdelt"

    def get(self, category: str | None, limit: int = 9) -> dict:
        category = category if category in CATEGORIES else None
        limit = max(1, min(limit, 30))
        key = (self.provider, category, limit)
        now = time.time()
        with self._lock:
            hit = self._cache.get(key)
            if hit and now - hit[0] < CACHE_TTL:
                return hit[1]

        api_key = os.environ.get("NEWS_API_KEY")
        items = _fetch_newsapi(category, limit, api_key) if api_key else _fetch_gdelt(category, limit)
        result = {
            "category": category or "all",
            "provider": self.provider,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "articles": _dedupe(items, limit),
        }
        with self._lock:
            self._cache[key] = (now, result)
        return result
