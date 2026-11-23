"""FastAPI server for OrbitWatch.

Run with:
    uvicorn app.server:app --reload
then open http://localhost:8000
"""

from __future__ import annotations

import io
import os
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, UnidentifiedImageError

from .config import load_env

load_env()  # read .env before anything below looks at settings

from .model import Classifier, ModelUnavailable  # noqa: E402
from .news import CATEGORIES, NewsError, NewsService  # noqa: E402

STATIC = Path(__file__).parent / "static"
MAX_UPLOAD_BYTES = 10 * 1024 * 1024

app = FastAPI(title="OrbitWatch", docs_url="/api/docs", openapi_url="/api/openapi.json")
classifier = Classifier()
news = NewsService()


@app.get("/api/health")
def health():
    return {
        "model_ready": classifier.available,
        "classes": classifier.classes,
        "news_provider": news.provider,
        "news_chain": news.chain,
        # which keys are configured (never the values)
        "keys": {k: bool(os.environ.get(k)) for k in ("NEWS_API_KEY", "GUARDIAN_API_KEY", "KAGGLE_USERNAME", "KAGGLE_KEY")},
    }


@app.post("/api/predict")
async def predict(file: UploadFile = File(...)):
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "That image is larger than 10 MB.")
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except (UnidentifiedImageError, OSError):
        raise HTTPException(415, "That file doesn't look like an image we can read.")
    try:
        result = classifier.predict(image)
    except ModelUnavailable as e:
        raise HTTPException(503, str(e))
    return result.__dict__


@app.get("/api/news")
def get_news(
    category: str = Query("all", description="all | " + " | ".join(CATEGORIES)),
    limit: int = Query(9, ge=1, le=30),
):
    try:
        return news.get(category.lower(), limit)
    except NewsError as e:
        raise HTTPException(502, str(e))


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
