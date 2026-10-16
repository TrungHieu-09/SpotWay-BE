"""Save (input | ground-truth | prediction) triptychs for the first N samples in a split."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch
import yaml
from PIL import Image, ImageDraw, ImageFont

from .checkpoint import load_inference_checkpoint
from .data import IMAGENET_MEAN, IMAGENET_STD, CubiCasaDataset
from .labels import CLASS_COLORS, CLASS_NAMES, NUM_CLASSES
from .model import build_model

PANEL_TITLES = ("input", "ground truth", "prediction")
LABEL_HEIGHT = 24


def colorize(mask: np.ndarray) -> Image.Image:
    rgb = np.zeros((*mask.shape, 3), dtype=np.uint8)
    for idx, name in enumerate(CLASS_NAMES):
        rgb[mask == idx] = CLASS_COLORS[name]
    return Image.fromarray(rgb)


def denormalize(image_t: torch.Tensor) -> Image.Image:
    """Undo ImageNet normalization on a (3, H, W) float tensor → PIL RGB."""
    mean = torch.tensor(IMAGENET_MEAN).view(3, 1, 1)
    std = torch.tensor(IMAGENET_STD).view(3, 1, 1)
    img = (image_t * std + mean).clamp(0, 1)
    arr = (img.permute(1, 2, 0).cpu().numpy() * 255).astype(np.uint8)
    return Image.fromarray(arr)


def hconcat_with_titles(images: list[Image.Image], titles: list[str]) -> Image.Image:
    h = max(im.height for im in images)
    w = sum(im.width for im in images)
    out = Image.new("RGB", (w, h + LABEL_HEIGHT), (255, 255, 255))
    draw = ImageDraw.Draw(out)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 14)
    except OSError:
        font = ImageFont.load_default()
    x = 0
    for im, title in zip(images, titles):
        out.paste(im, (x, LABEL_HEIGHT))
        draw.text((x + 6, 4), title, fill=(20, 20, 20), font=font)
        x += im.width
    return out


def resolve_device(name: str) -> torch.device:
    if name != "auto":
        return torch.device(name)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--run-dir", required=True, type=Path,
                   help="path to a run dir containing the checkpoint and config.yaml")
    p.add_argument("--ckpt", default="best.pt",
                   help="checkpoint filename inside --run-dir (default: best.pt)")
    p.add_argument("--split", default="val", choices=("train", "val", "test"))
    p.add_argument("--num", type=int, default=8, help="how many samples to render")
    p.add_argument("--out", type=Path, default=None,
                   help="output dir (default: <run-dir>/predictions/<split>)")
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
        encoder_weights=None,  # weights come from the checkpoint
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

    out_dir = args.out or (args.run_dir / "predictions" / Path(args.ckpt).stem / args.split)
    out_dir.mkdir(parents=True, exist_ok=True)

    n = min(args.num, len(ds))
    print(f"rendering {n} {args.split} samples → {out_dir}")
    with torch.no_grad():
        for i in range(n):
            image_t, mask_t = ds[i]
            input_img = denormalize(image_t)
            gt_img = colorize(mask_t.numpy())

            logits = model(image_t.unsqueeze(0).to(device))
            pred = logits.argmax(dim=1).squeeze(0).cpu().numpy()
            pred_img = colorize(pred)

            panel = hconcat_with_titles(
                [input_img, gt_img, pred_img], list(PANEL_TITLES)
            )
            panel.save(out_dir / f"{i:03d}.png")
    print(f"done. open {out_dir} to view.")


if __name__ == "__main__":
    main()
