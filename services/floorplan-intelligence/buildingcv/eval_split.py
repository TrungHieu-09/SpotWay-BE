"""Evaluate a trained checkpoint on a held-out split, reusing train.evaluate so numbers match training-time val."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
import torch.nn as nn
import yaml
from torch.utils.data import DataLoader

from .checkpoint import load_inference_checkpoint
from .data import CubiCasaDataset
from .labels import CLASS_NAMES, NUM_CLASSES
from .model import build_model
from .train import evaluate, format_iou, resolve_device


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--run-dir", required=True, type=Path)
    p.add_argument("--ckpt", default="best.pt")
    p.add_argument("--split", default="test", choices=("train", "val", "test"))
    p.add_argument("--device", default="auto")
    args = p.parse_args()

    cfg_path = args.run_dir / "config.yaml"
    ckpt_path = args.run_dir / args.ckpt
    with cfg_path.open() as f:
        cfg = yaml.safe_load(f)

    device = resolve_device(args.device)
    print(f"device: {device}")

    model = build_model(
        encoder_name=cfg["model"]["encoder_name"],
        encoder_weights=None,
        num_classes=NUM_CLASSES,
    ).to(device)
    state, epoch = load_inference_checkpoint(ckpt_path, device)
    model.load_state_dict(state)
    model.eval()
    print(f"loaded epoch {epoch if epoch is not None else '?'} from {ckpt_path}")

    H, W = cfg["data"]["image_size"]
    ds = CubiCasaDataset(
        data_dir=cfg["data"]["data_dir"],
        split=args.split,
        size=(H, W),
        normalize=cfg["data"]["normalize"],
        letterbox=cfg["data"].get("letterbox", False),
    )
    print(f"{args.split} samples: {len(ds)}")

    loader = DataLoader(
        ds,
        batch_size=cfg["optim"]["batch_size"],
        shuffle=False,
        num_workers=cfg["data"]["num_workers"],
        pin_memory=(device.type == "cuda"),
        persistent_workers=cfg["data"]["num_workers"] > 0,
    )

    metrics = evaluate(model, loader, nn.CrossEntropyLoss(), device)
    print(
        f"{args.split} — loss {metrics['loss']:.4f}   "
        f"pixel acc {metrics['pixel_acc']:.4f}   mIoU {metrics['miou']:.4f}"
    )
    print(f"  per-class IoU: {format_iou(metrics['iou'])}")

    out_path = args.run_dir / f"{args.split}_metrics.json"
    payload = {
        "split": args.split,
        "ckpt": args.ckpt,
        "epoch": epoch,
        "loss": metrics["loss"],
        "pixel_acc": metrics["pixel_acc"],
        "miou": metrics["miou"],
        "iou": dict(zip(CLASS_NAMES, metrics["iou"])),
    }
    out_path.write_text(json.dumps(payload, indent=2))
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
