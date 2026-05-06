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