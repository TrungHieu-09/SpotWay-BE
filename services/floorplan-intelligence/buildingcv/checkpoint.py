"""Load model weights from .safetensors (HF distribution) or training .pt."""

from __future__ import annotations

from pathlib import Path

import torch


def load_inference_checkpoint(
    path: Path, device: torch.device
) -> tuple[dict[str, torch.Tensor], int | None]:
    """Return (state_dict, epoch). Optimizer state in .pt files is ignored."""
    if path.suffix == ".safetensors":
        from safetensors import safe_open
        from safetensors.torch import load_file

        # safetensors load_file accepts "cpu" / "cuda"; for mps we load on cpu
        # and let load_state_dict move tensors to the model's device.
        target = "cuda" if device.type == "cuda" else "cpu"
        state = load_file(str(path), device=target)
        with safe_open(str(path), framework="pt") as f:
            meta = f.metadata() or {}
        epoch = int(meta["epoch"]) if meta.get("epoch") else None
        return state, epoch

    ckpt = torch.load(path, map_location=device, weights_only=False)
    return ckpt["model"], ckpt.get("epoch")
