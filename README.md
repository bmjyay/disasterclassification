# disasterclassification
# Disaster Image Classifier
* Aerial/Satellite Calamity Detection via Transfer Learning (ResNet-50 + Grad-CAM)

---

## Project Overview
Fine-tunes a pretrained ResNet-50 to classify aerial/ground images into four natural
disaster categories: **Cyclone, Earthquake, Flood, Wildfire**. Includes Grad-CAM
visualizations to explain model decisions.

---

## Setup

### 1. Install dependencies
```bash
pip install -r requirements.txt
```

### 2. Download the dataset
**Dataset:** Cyclone Wildfire Flood Earthquake Database  
**Kaggle URL:** https://www.kaggle.com/datasets/mikolajbabula/disaster-images-dataset-cnn-model

**Option A – Kaggle CLI (recommended)**
```bash
# First-time setup: place your kaggle.json API key in ~/.kaggle/
kaggle datasets download -d mikolajbabula/disaster-images-dataset-cnn-model
unzip disaster-images-dataset-cnn-model.zip -d data/
```

**Option B – Manual**
1. Sign in to Kaggle, go to the dataset URL above, click Download.
2. Unzip into the `data/` folder.

### 3. Verify folder structure
```
data/
├── train/
│   ├── Cyclone/       (~500 images)
│   ├── Earthquake/    (~500 images)
│   ├── Flood/         (~500 images)
│   └── Wildfire/      (~500 images)
└── test/
    ├── Cyclone/
    ├── Earthquake/
    ├── Flood/
    └── Wildfire/
```
> **Note:** Class folder names are case-sensitive. Rename if they differ from above.

---

## Running the Code

### Train from scratch
```bash
python train.py
```
Runs 15 epochs by default.  
Saves: `best_model.pth`, `learning_curves.png`, `confusion_matrix.png`, `gradcam.png`

### Custom options
```bash
python train.py --epochs 20 --batch-size 16 --lr 0.001 --data-dir data/
```

### Evaluate a saved checkpoint (skip training)
```bash
python train.py --eval-only --checkpoint best_model.pth
```

---

## Web App — OrbitWatch

A calm, single-page interface for the classifier with a related-news feed.
The design lives in Figma: https://www.figma.com/design/GJHwVd8FZcXvEcDm6sNXMc
(tokens, components and the desktop screen; CSS custom properties in
`app/static/styles.css` mirror the Figma variables one-to-one).

- **Classify** – drag & drop or choose a photo; get the predicted class, per-class
  probabilities and a Grad-CAM attention map next to the crop the model saw.
- **Related news** – recent coverage filtered by category. After a prediction the feed
  switches to the predicted class automatically.
- **Static by design** – no transitions or motion; light and dark themes follow the OS.

### Run it
```bash
pip install -r requirements.txt
python train.py                      # produces best_model.pth (skip if you already have one)
uvicorn app.server:app --reload      # then open http://localhost:8000
```
Without a checkpoint the UI still loads and the news feed works; classification shows
a notice explaining how to train a model.

### News provider
| Setting | Provider |
|---|---|
| `NEWS_API_KEY` set | [NewsAPI](https://newsapi.org) `/v2/everything` (titles + descriptions + images) |
| not set (default) | [GDELT DOC 2.0](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/) – free, no key |

```bash
export NEWS_API_KEY=your_key_here   # optional
```
Results are cached in memory for 15 minutes (`NEWS_CACHE_TTL` seconds to change).

### Configuration
| Env var | Default | Purpose |
|---|---|---|
| `MODEL_CHECKPOINT` | `best_model.pth` | Path to trained weights |
| `CLASS_NAMES` | `cyclone,earthquake,flood,wildfire` | Class order used in training (alphabetical folder order) |
| `NEWS_API_KEY` | – | Use NewsAPI instead of GDELT |

### API
| Endpoint | Description |
|---|---|
| `GET /api/health` | Model availability, classes, news provider |
| `POST /api/predict` | Multipart `file` → label, confidence, probabilities, Grad-CAM (data URLs) |
| `GET /api/news?category=flood&limit=9` | Normalised articles: title, summary, url, source, published_at, image, category |
| `GET /api/docs` | Interactive OpenAPI docs |

### Tests
```bash
python -m pytest tests
```

---

## What the Code Does

| Component | Details |
|---|---|
| **Model** | ResNet-50 with ImageNet pretrained weights |
| **Head** | Dropout(0.3) → Linear(2048 → 4) |
| **Phase 1** | Epochs 0–4: only head trains (backbone frozen) |
| **Phase 2** | Epochs 5+: full fine-tuning at 10× lower LR |
| **Loss** | Cross-entropy |
| **Optimizer** | Adam with StepLR scheduler (γ=0.5, step=5) |
| **Augmentation** | RandomResizedCrop, HorizontalFlip, ColorJitter |
| **Explainability** | Grad-CAM on ResNet layer4 |

---

## Outputs

| File | Description |
|---|---|
| `best_model.pth` | Saved model weights (best val accuracy) |
| `learning_curves.png` | Train/val loss and accuracy over epochs |
| `confusion_matrix.png` | Per-class confusion matrix on test set |
| `gradcam.png` | 4 test images with Grad-CAM heatmap overlays |
| Console | Full classification report (precision, recall, F1) |

---

## Expected Results
With 15 epochs on a GPU (or ~45 min CPU):

| Metric | Expected Range |
|---|---|
| Test accuracy | 85–92% |
| Macro F1 | 0.84–0.91 |
| Wildfire F1 | Typically highest |
| Earthquake F1 | Typically lowest (visually subtle) |

---

## Hardware Notes
- **GPU (recommended):** ~8–12 min total training time
- **CPU only:** ~40–60 min; reduce `--batch-size 16` if memory is tight
- Tested on: Python 3.10, PyTorch 2.1, CUDA 11.8