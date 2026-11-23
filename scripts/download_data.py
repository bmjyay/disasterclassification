"""Download the disaster image dataset from Kaggle into data/.

Reads KAGGLE_USERNAME and KAGGLE_KEY from `.env` (or the environment, or an
existing ~/.kaggle/kaggle.json), downloads and unzips the dataset, then prints
the train/test folders and the command to train on them.

    python scripts/download_data.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.config import load_env  # noqa: E402

DATASET = "mikolajbabula/disaster-images-dataset-cnn-model"
DATA_DIR = ROOT / "data"


def find_split(name: str) -> Path | None:
    """Find a folder called train/test that holds one sub-folder per class."""
    for path in sorted(DATA_DIR.rglob("*")):
        if path.is_dir() and path.name.lower() == name and sum(p.is_dir() for p in path.iterdir()) >= 2:
            return path
    return None


def main() -> int:
    load_env()
    has_json = (Path.home() / ".kaggle" / "kaggle.json").is_file()
    if not (os.environ.get("KAGGLE_USERNAME") and os.environ.get("KAGGLE_KEY")) and not has_json:
        print("Kaggle credentials not found.\n"
              "Add KAGGLE_USERNAME and KAGGLE_KEY to .env (see .env.example), then run this again.")
        return 1

    try:
        from kaggle.api.kaggle_api_extended import KaggleApi
    except ImportError:
        print("The kaggle package is missing. Run: pip install -r requirements.txt")
        return 1

    api = KaggleApi()
    try:
        api.authenticate()
    except Exception as e:  # bad or missing credentials
        print(f"Kaggle rejected the credentials: {e}")
        return 1

    DATA_DIR.mkdir(exist_ok=True)
    print(f"Downloading {DATASET} into {DATA_DIR} ...")
    api.dataset_download_files(DATASET, path=str(DATA_DIR), unzip=True, quiet=False)

    train, test = find_split("train"), find_split("test")
    if not train or not test:
        print("Downloaded, but could not find train/ and test/ folders. Look inside data/ and pass them to train.py.")
        return 0
    rel = lambda p: p.relative_to(ROOT).as_posix()  # noqa: E731
    classes = ", ".join(sorted(p.name for p in train.iterdir() if p.is_dir()))
    print(f"\nReady.\n  train: {rel(train)}\n  test:  {rel(test)}\n  classes: {classes}\n")
    print(f"Train with:\n  python train.py --train-dir {rel(train)} --test-dir {rel(test)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
