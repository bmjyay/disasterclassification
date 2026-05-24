"""
Disaster Image Classifier
=========================
Fine-tunes ResNet-50 on the Cyclone/Wildfire/Flood/Earthquake dataset.

Dataset: https://www.kaggle.com/datasets/mikolajbabula/disaster-images-dataset-cnn-model

Usage:
    python train.py                                         
    python train.py --train-dir path/to/train --test-dir path/to/test
    python train.py --epochs 20
    python train.py --eval-only --checkpoint best_model.pth
"""

import argparse
import os
import time
import copy

import torch
import torch.nn as nn
import torch.optim as optim
from torch.optim.lr_scheduler import StepLR
from torch.utils.data import DataLoader, random_split
from torchvision import datasets, models, transforms
from sklearn.metrics import classification_report, confusion_matrix
import matplotlib.pyplot as plt
import seaborn as sns
import numpy as np

# ── Constants ──────────────────────────────────────────────────────────────────
CLASS_NAMES = ["cyclone", "earthquake", "flood", "wildfire"]  # auto-updated at runtime
NUM_CLASSES = 4
IMG_SIZE    = 224
SEED        = 42

torch.manual_seed(SEED)


# ── Data transforms ────────────────────────────────────────────────────────────
def get_transforms():
    normalize = transforms.Normalize(
        mean=[0.485, 0.456, 0.406],
        std =[0.229, 0.224, 0.225]
    )
    train_tf = transforms.Compose([
        transforms.RandomResizedCrop(IMG_SIZE),
        transforms.RandomHorizontalFlip(),
        transforms.ColorJitter(brightness=0.2, contrast=0.2, saturation=0.2),
        transforms.ToTensor(),
        normalize,
    ])
    val_tf = transforms.Compose([
        transforms.Resize(256),
        transforms.CenterCrop(IMG_SIZE),
        transforms.ToTensor(),
        normalize,
    ])
    return train_tf, val_tf


# ── Dataset loaders ────────────────────────────────────────────────────────────
def load_data(train_dir: str, test_dir: str, batch_size: int = 32):
    """
    Loads train/val/test splits from explicit directory paths.
    Automatically detects class names from folder names.
    train_dir and test_dir should each contain one subfolder per class.
    """
    global CLASS_NAMES, NUM_CLASSES
    train_tf, val_tf = get_transforms()

    full_train = datasets.ImageFolder(train_dir, transform=train_tf)
    test_ds    = datasets.ImageFolder(test_dir,  transform=val_tf)

    CLASS_NAMES = full_train.classes
    NUM_CLASSES = len(CLASS_NAMES)
    print(f"Classes detected: {CLASS_NAMES}")

    n_val   = int(0.2 * len(full_train))
    n_train = len(full_train) - n_val
    train_ds, val_ds = random_split(
        full_train, [n_train, n_val],
        generator=torch.Generator().manual_seed(SEED)
    )
    val_ds.dataset = copy.deepcopy(full_train)
    val_ds.dataset.transform = val_tf

    loaders = {
        "train": DataLoader(train_ds, batch_size=batch_size, shuffle=True,  num_workers=0, pin_memory=False),
        "val":   DataLoader(val_ds,   batch_size=batch_size, shuffle=False, num_workers=0, pin_memory=False),
        "test":  DataLoader(test_ds,  batch_size=batch_size, shuffle=False, num_workers=0, pin_memory=False),
    }
    sizes = {"train": n_train, "val": n_val, "test": len(test_ds)}
    print(f"Dataset sizes -> train: {n_train}  val: {n_val}  test: {len(test_ds)}")
    return loaders, sizes


# ── Model ──────────────────────────────────────────────────────────────────────
def build_model(num_classes: int, freeze_backbone: bool = True):
    model = models.resnet50(weights=models.ResNet50_Weights.IMAGENET1K_V1)
    if freeze_backbone:
        for param in model.parameters():
            param.requires_grad = False
    in_features = model.fc.in_features
    model.fc = nn.Sequential(
        nn.Dropout(p=0.3),
        nn.Linear(in_features, num_classes)
    )
    return model


# ── Training loop ──────────────────────────────────────────────────────────────
def train_model(model, loaders, sizes, device, num_epochs=15, lr=1e-3, checkpoint="best_model.pth"):
    """
    Phase 1 (epochs 0-4):  only the new head trains (backbone frozen).
    Phase 2 (epoch 5+):    unfreeze all layers, lower LR for fine-tuning.
    Best model is saved to disk after every improvement.
    """
    criterion = nn.CrossEntropyLoss()
    optimizer = optim.Adam(filter(lambda p: p.requires_grad, model.parameters()), lr=lr)
    scheduler = StepLR(optimizer, step_size=5, gamma=0.5)

    history = {"train_loss": [], "val_loss": [], "train_acc": [], "val_acc": []}
    best_acc = 0.0
    best_wts = copy.deepcopy(model.state_dict())
    UNFREEZE_EPOCH = 5

    for epoch in range(num_epochs):
        if epoch == UNFREEZE_EPOCH:
            print("\n[Phase 2] Unfreezing backbone for fine-tuning ...")
            for param in model.parameters():
                param.requires_grad = True
            optimizer = optim.Adam(model.parameters(), lr=lr / 10)
            scheduler = StepLR(optimizer, step_size=5, gamma=0.5)

        t0 = time.time()
        for phase in ["train", "val"]:
            model.train() if phase == "train" else model.eval()
            running_loss = 0.0
            running_correct = 0

            for inputs, labels in loaders[phase]:
                inputs, labels = inputs.to(device), labels.to(device)
                optimizer.zero_grad()

                with torch.set_grad_enabled(phase == "train"):
                    outputs = model(inputs)
                    loss    = criterion(outputs, labels)
                    preds   = outputs.argmax(dim=1)
                    if phase == "train":
                        loss.backward()
                        optimizer.step()

                running_loss    += loss.item() * inputs.size(0)
                running_correct += (preds == labels).sum().item()

            epoch_loss = running_loss    / sizes[phase]
            epoch_acc  = running_correct / sizes[phase]
            history[f"{phase}_loss"].append(epoch_loss)
            history[f"{phase}_acc"].append(epoch_acc)

            if phase == "val" and epoch_acc > best_acc:
                best_acc = epoch_acc
                best_wts = copy.deepcopy(model.state_dict())
                torch.save(best_wts, checkpoint)
                print(f"  -> Saved best model (val_acc={epoch_acc:.4f})")

        scheduler.step()
        elapsed = time.time() - t0
        print(
            f"Epoch {epoch+1:02d}/{num_epochs}  "
            f"train_loss={history['train_loss'][-1]:.4f}  train_acc={history['train_acc'][-1]:.4f}  "
            f"val_loss={history['val_loss'][-1]:.4f}  val_acc={history['val_acc'][-1]:.4f}  "
            f"({elapsed:.1f}s)"
        )

    print(f"\nBest val accuracy: {best_acc:.4f}")
    model.load_state_dict(best_wts)
    return model, history


# ── Evaluation ─────────────────────────────────────────────────────────────────
def evaluate(model, loader, device):
    model.eval()
    all_preds, all_labels = [], []

    with torch.no_grad():
        for inputs, labels in loader:
            inputs = inputs.to(device)
            preds  = model(inputs).argmax(dim=1).cpu()
            all_preds.extend(preds.numpy())
            all_labels.extend(labels.numpy())

    print("\n-- Classification Report --")
    print(classification_report(all_labels, all_preds, target_names=CLASS_NAMES))

    cm = confusion_matrix(all_labels, all_preds)
    plt.figure(figsize=(7, 6))
    sns.heatmap(cm, annot=True, fmt="d", cmap="Blues",
                xticklabels=CLASS_NAMES, yticklabels=CLASS_NAMES)
    plt.title("Confusion Matrix - Test Set")
    plt.ylabel("True Label")
    plt.xlabel("Predicted Label")
    plt.tight_layout()
    plt.savefig("confusion_matrix.png", dpi=150)
    print("Saved -> confusion_matrix.png")


# ── Learning curves ────────────────────────────────────────────────────────────
def plot_history(history):
    epochs = range(1, len(history["train_loss"]) + 1)
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 4))
    ax1.plot(epochs, history["train_loss"], label="Train")
    ax1.plot(epochs, history["val_loss"],   label="Val")
    ax1.set_title("Loss"); ax1.set_xlabel("Epoch"); ax1.legend()
    ax2.plot(epochs, history["train_acc"], label="Train")
    ax2.plot(epochs, history["val_acc"],   label="Val")
    ax2.set_title("Accuracy"); ax2.set_xlabel("Epoch"); ax2.legend()
    plt.tight_layout()
    plt.savefig("learning_curves.png", dpi=150)
    print("Saved -> learning_curves.png")


# ── Grad-CAM ───────────────────────────────────────────────────────────────────
class GradCAM:
    def __init__(self, model):
        self.model       = model
        self.gradients   = None
        self.activations = None
        target_layer = model.layer4[-1]
        target_layer.register_forward_hook(self._save_activation)
        target_layer.register_full_backward_hook(self._save_gradient)

    def _save_activation(self, module, input, output):
        self.activations = output.detach()

    def _save_gradient(self, module, grad_input, grad_output):
        self.gradients = grad_output[0].detach()

    def generate(self, input_tensor, class_idx=None):
        self.model.eval()
        output = self.model(input_tensor)
        if class_idx is None:
            class_idx = output.argmax(dim=1).item()
        self.model.zero_grad()
        output[0, class_idx].backward()
        weights = self.gradients.mean(dim=[2, 3], keepdim=True)
        cam     = (weights * self.activations).sum(dim=1, keepdim=True)
        cam     = torch.relu(cam)
        cam     = torch.nn.functional.interpolate(
            cam, size=(IMG_SIZE, IMG_SIZE), mode="bilinear", align_corners=False
        )
        cam = cam.squeeze().cpu().numpy()
        cam = (cam - cam.min()) / (cam.max() - cam.min() + 1e-8)
        return cam, class_idx


def visualize_gradcam(model, loader, device, n_samples=4):
    _, val_tf = get_transforms()
    inv_normalize = transforms.Normalize(
        mean=[-0.485/0.229, -0.456/0.224, -0.406/0.225],
        std =[1/0.229, 1/0.224, 1/0.225]
    )
    cam_gen = GradCAM(model)
    inputs, labels = next(iter(loader))
    inputs = inputs[:n_samples].to(device)
    labels = labels[:n_samples]

    fig, axes = plt.subplots(2, n_samples, figsize=(4 * n_samples, 8))
    for i in range(n_samples):
        inp = inputs[i:i+1]
        cam, pred_idx = cam_gen.generate(inp)
        img = inv_normalize(inputs[i].cpu()).permute(1, 2, 0).clamp(0, 1).numpy()
        axes[0, i].imshow(img)
        axes[0, i].set_title(f"True: {CLASS_NAMES[labels[i]]}", fontsize=9)
        axes[0, i].axis("off")
        axes[1, i].imshow(img)
        axes[1, i].imshow(cam, cmap="jet", alpha=0.45)
        axes[1, i].set_title(f"Pred: {CLASS_NAMES[pred_idx]}", fontsize=9)
        axes[1, i].axis("off")

    plt.suptitle("Grad-CAM Visualizations", fontsize=13)
    plt.tight_layout()
    plt.savefig("gradcam.png", dpi=150)
    print("Saved -> gradcam.png")


# ── Entry point ────────────────────────────────────────────────────────────────
def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--train-dir",  default="data/DisasterModel/train", help="Directory containing per-class train folders")
    p.add_argument("--test-dir",   default="data/DisasterModel/test",  help="Directory containing per-class test folders")
    p.add_argument("--epochs",     type=int,   default=15)
    p.add_argument("--batch-size", type=int,   default=32)
    p.add_argument("--lr",         type=float, default=1e-3)
    p.add_argument("--checkpoint", default="best_model.pth")
    p.add_argument("--eval-only",  action="store_true")
    return p.parse_args()


def main():
    args   = parse_args()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Using device: {device}")

    loaders, sizes = load_data(args.train_dir, args.test_dir, args.batch_size)
    model = build_model(NUM_CLASSES, freeze_backbone=True).to(device)

    if args.eval_only:
        model.load_state_dict(torch.load(args.checkpoint, map_location=device))
        print(f"Loaded checkpoint from {args.checkpoint}")
    else:
        model, history = train_model(
            model, loaders, sizes, device,
            num_epochs=args.epochs, lr=args.lr, checkpoint=args.checkpoint
        )
        plot_history(history)

    evaluate(model, loaders["test"], device)
    visualize_gradcam(model, loaders["test"], device)


if __name__ == "__main__":
    main()