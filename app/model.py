"""Inference wrapper around the fine-tuned ResNet-50 from train.py.

Loads the checkpoint lazily (once), runs a prediction and produces a Grad-CAM
overlay as a PNG data URL so the browser can show it without extra requests.
"""

from __future__ import annotations

import base64
import io
import os
import threading
from dataclasses import dataclass

import numpy as np
import torch
from PIL import Image

from train import IMG_SIZE, GradCAM, build_model, get_transforms

DEFAULT_CLASSES = ["cyclone", "earthquake", "flood", "wildfire"]


def _class_names() -> list[str]:
    raw = os.environ.get("CLASS_NAMES")
    if raw:
        return [c.strip().lower() for c in raw.split(",") if c.strip()]
    return DEFAULT_CLASSES


class ModelUnavailable(RuntimeError):
    """Raised when no trained checkpoint is present."""


@dataclass
class Prediction:
    label: str
    confidence: float
    probabilities: dict[str, float]
    original: str  # data URL (224x224 centre crop the model saw)
    gradcam: str   # data URL (overlay)


# A calm warm ramp for the attention overlay (transparent -> amber -> terracotta).
_RAMP = np.array(
    [[244, 208, 120], [232, 150, 84], [196, 88, 58], [150, 46, 40]], dtype=np.float32
)


def _colorize(cam: np.ndarray) -> np.ndarray:
    pos = np.clip(cam, 0, 1) * (len(_RAMP) - 1)
    lo = np.floor(pos).astype(int)
    hi = np.minimum(lo + 1, len(_RAMP) - 1)
    t = (pos - lo)[..., None]
    return _RAMP[lo] * (1 - t) + _RAMP[hi] * t


def _to_data_url(arr: np.ndarray) -> str:
    buf = io.BytesIO()
    Image.fromarray(arr.astype(np.uint8)).save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


class Classifier:
    def __init__(self, checkpoint: str | None = None):
        self.checkpoint = checkpoint or os.environ.get("MODEL_CHECKPOINT", "best_model.pth")
        self.classes = _class_names()
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self._model = None
        self._cam = None
        self._lock = threading.Lock()
        _, self._tf = get_transforms()

    @property
    def available(self) -> bool:
        return self._model is not None or os.path.exists(self.checkpoint)

    def _load(self):
        if self._model is not None:
            return
        if not os.path.exists(self.checkpoint):
            raise ModelUnavailable(
                f"No checkpoint found at '{self.checkpoint}'. Train one with "
                "`python train.py` or set MODEL_CHECKPOINT."
            )
        model = build_model(len(self.classes), freeze_backbone=False, pretrained=False)
        state = torch.load(self.checkpoint, map_location=self.device)
        model.load_state_dict(state)
        model.to(self.device).eval()
        self._model = model
        self._cam = GradCAM(model)

    def predict(self, image: Image.Image) -> Prediction:
        with self._lock:  # Grad-CAM hooks keep per-call state
            self._load()
            image = image.convert("RGB")
            x = self._tf(image).unsqueeze(0).to(self.device)

            with torch.no_grad():
                probs = torch.softmax(self._model(x), dim=1)[0].cpu().numpy()
            idx = int(probs.argmax())

            x.requires_grad_(True)
            cam, _ = self._cam.generate(x, class_idx=idx)

        # Reconstruct the exact crop the model saw for a faithful overlay.
        crop = image.resize(
            (int(image.width * 256 / min(image.size)), int(image.height * 256 / min(image.size)))
        )
        left = (crop.width - IMG_SIZE) // 2
        top = (crop.height - IMG_SIZE) // 2
        crop = np.asarray(crop.crop((left, top, left + IMG_SIZE, top + IMG_SIZE)), dtype=np.float32)

        alpha = (np.clip(cam, 0, 1) ** 1.3 * 0.7)[..., None]
        overlay = crop * (1 - alpha) + _colorize(cam) * alpha

        return Prediction(
            label=self.classes[idx],
            confidence=float(probs[idx]),
            probabilities={c: float(p) for c, p in zip(self.classes, probs)},
            original=_to_data_url(crop),
            gradcam=_to_data_url(overlay),
        )
