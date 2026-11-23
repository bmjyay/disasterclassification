"""Offline tests for the news provider normalisation (no network needed)."""
import pytest

import app.news as news

REAL_PREVIEW = news._preview_image  # captured before the autouse stub replaces it


GDELT = {"articles": [
    {"title": "Cyclone triggers floods along the coast", "url": "https://a.example/1",
     "domain": "a.example", "seendate": "20261123T101500Z", "socialimage": ""},
    {"title": "Cyclone triggers floods along the coast", "url": "https://b.example/dup",
     "domain": "b.example", "seendate": "20261123T091500Z"},
    {"title": "", "url": "https://c.example/empty"},
]}


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    monkeypatch.setattr(news, "GDELT_MIN_INTERVAL", 0)
    monkeypatch.setattr(news, "_preview_image", lambda url: None)
    monkeypatch.delenv("NEWS_PROVIDER", raising=False)


@pytest.fixture
def svc(monkeypatch):
    monkeypatch.delenv("NEWS_API_KEY", raising=False)
    calls = []
    monkeypatch.setattr(news, "_get_json", lambda url, headers=None: calls.append(url) or GDELT)
    s = news.NewsService()
    s.calls = calls
    return s


def test_gdelt_normalised_deduped_and_cached(svc):
    out = svc.get("flood", limit=5)
    assert out["provider"] == "gdelt"
    assert [a["url"] for a in out["articles"]] == ["https://a.example/1"]
    art = out["articles"][0]
    assert art["category"] == "flood"  # requested category wins when it matches
    assert art["published_at"].startswith("2026-11-23T10:15")
    assert art["image"] is None
    svc.get("flood", limit=5)
    assert len(svc.calls) == 1  # served from cache


def test_unknown_category_means_all(svc):
    out = svc.get("volcano")
    assert out["category"] == "all"
    assert out["articles"][0]["category"] == "cyclone"


def test_newsapi_used_when_key_set(monkeypatch):
    monkeypatch.setenv("NEWS_API_KEY", "test")
    seen = {}

    def fake(url, headers=None):
        seen["url"], seen["headers"] = url, headers
        return {"status": "ok", "articles": [
            {"title": "[Removed]", "url": "https://x"},
            {"title": "Wildfire spreads", "description": "Crews respond.", "url": "https://n.example/w",
             "source": {"name": "Example"}, "publishedAt": "2026-11-23T08:00:00Z", "urlToImage": None},
        ]}

    monkeypatch.setattr(news, "_get_json", fake)
    out = news.NewsService().get("wildfire")
    assert out["provider"] == "newsapi"
    assert seen["headers"] == {"X-Api-Key": "test"}
    assert [a["title"] for a in out["articles"]] == ["Wildfire spreads"]
    assert out["articles"][0]["summary"] == "Crews respond."


def test_rate_limit_retry_and_stale_fallback(monkeypatch):
    monkeypatch.delenv("NEWS_API_KEY", raising=False)
    monkeypatch.setattr(news.time, "sleep", lambda s: None)
    replies = iter([news.NewsError("Please limit requests to one every 5 seconds"), GDELT])

    def flaky(url, headers=None):
        r = next(replies)
        if isinstance(r, Exception):
            raise r
        return r

    monkeypatch.setattr(news, "_get_json", flaky)
    svc = news.NewsService()
    out = svc.get(None)  # first call is rate-limited, the retry succeeds
    assert out["articles"] and "stale" not in out

    def down(url, headers=None):
        raise news.NewsError("Could not reach the news provider")

    monkeypatch.setattr(news, "_get_json", down)
    monkeypatch.setattr(news, "CACHE_TTL", 0)
    assert svc.get(None)["stale"] is True  # same query served from the last good result
    cyc = svc.get("cyclone")  # never fetched: filtered from cached "all" stories
    assert cyc["stale"] is True and [x["category"] for x in cyc["articles"]] == ["cyclone"]


def test_error_when_nothing_cached(monkeypatch):
    monkeypatch.delenv("NEWS_API_KEY", raising=False)
    monkeypatch.setattr(news.time, "sleep", lambda s: None)

    def down(url, headers=None):
        raise news.NewsError("Could not reach the news provider")

    monkeypatch.setattr(news, "_get_json", down)
    with pytest.raises(news.NewsError):
        news.NewsService().get("wildfire")


GUARDIAN = {"response": {"status": "ok", "results": [
    {"webTitle": "Wildfire forces evacuations", "webUrl": "https://www.theguardian.com/w/1",
     "webPublicationDate": "2026-11-23T08:00:00Z",
     "fields": {"thumbnail": "https://i.guim.co.uk/img/w.jpg", "trailText": "<strong>Crews</strong> &amp; residents"}},
]}}


def test_guardian_used_when_gdelt_fails(monkeypatch):
    monkeypatch.delenv("NEWS_API_KEY", raising=False)

    def fake(url, headers=None):
        if "gdeltproject" in url:
            raise news.NewsError("Please limit requests to one every 5 seconds")
        assert "api-key=test" in url
        return GUARDIAN

    monkeypatch.setattr(news.time, "sleep", lambda s: None)
    monkeypatch.setattr(news, "_get_json", fake)
    out = news.NewsService().get("wildfire")
    assert out["provider"] == "guardian"
    art = out["articles"][0]
    assert art["summary"] == "Crews & residents"
    assert art["image"] == "https://i.guim.co.uk/img/w.jpg"
    assert art["category"] == "wildfire"


def test_missing_images_filled_from_preview(monkeypatch):
    monkeypatch.delenv("NEWS_API_KEY", raising=False)
    monkeypatch.setattr(news, "_get_json", lambda url, headers=None: GDELT)
    monkeypatch.setattr(news, "_preview_image", lambda url: url + "/og.jpg")
    out = news.NewsService().get("flood")
    assert out["articles"][0]["image"] == "https://a.example/1/og.jpg"


def test_preview_image_parses_og_tag(monkeypatch):
    class Resp:
        headers = {"Content-Type": "text/html; charset=utf-8"}
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self, n): return b'<html><head><meta content="/img/p.jpg" property="og:image"></head>'

    monkeypatch.setattr(news.urllib.request, "urlopen", lambda req, timeout: Resp())
    news._image_cache.clear()
    assert REAL_PREVIEW("https://site.example/story") == "https://site.example/img/p.jpg"


def test_env_file_loader(tmp_path, monkeypatch):
    from app.config import load_env
    env = tmp_path / ".env"
    env.write_text(
        "# comment\nNEWS_API_KEY=abc123\nGUARDIAN_API_KEY=\"quoted key\"\n"
        "export KAGGLE_USERNAME=someone  # trailing note\nEMPTY=\nKAGGLE_KEY=from-file\n"
    )
    for k in ("NEWS_API_KEY", "GUARDIAN_API_KEY", "KAGGLE_USERNAME", "EMPTY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("KAGGLE_KEY", "already-set")  # real env wins over the file
    loaded = load_env(env)
    import os
    assert os.environ["NEWS_API_KEY"] == "abc123"
    assert os.environ["GUARDIAN_API_KEY"] == "quoted key"
    assert os.environ["KAGGLE_USERNAME"] == "someone"
    assert os.environ["KAGGLE_KEY"] == "already-set"
    assert "EMPTY" not in os.environ and "KAGGLE_KEY" not in loaded
    for k in ("NEWS_API_KEY", "GUARDIAN_API_KEY", "KAGGLE_USERNAME"):
        monkeypatch.delenv(k, raising=False)
