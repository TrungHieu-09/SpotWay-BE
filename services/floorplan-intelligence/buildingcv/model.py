"""UNet with a pretrained ResNet encoder, built from config keys."""

from __future__ import annotations

import segmentation_models_pytorch as smp
import torch.nn as nn

from .labels import NUM_CLASSES


def build_model(
    encoder_name: str = "resnet34",
    encoder_weights: str | None = "imagenet",
    num_classes: int = NUM_CLASSES,
    in_channels: int = 3,
) -> nn.Module:
    """UNet with `encoder_name` as the backbone. Returns raw logits."""
    return smp.Unet(
        encoder_name=encoder_name,
        encoder_weights=encoder_weights,
        in_channels=in_channels,
        classes=num_classes,
    )
