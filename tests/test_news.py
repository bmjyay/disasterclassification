"""Offline tests for the news provider normalisation (no network needed)."""
import pytest

import app.news as news


GDELT = {"articles": [
    {"title": "Cyclone triggers floods along the coast", "url": "https://a.example/1",
     "domain": "a.example", "seendate": "20261123T101500Z", "socialimage": ""},
    {"title": "Cyclone triggers floods along the coast", "url": "https://b.example/dup",
     "domain": "b.example", "seendate": "20261123T091500Z"},
    {"title": "", "url": "https://c.example/empty"},
]}


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
