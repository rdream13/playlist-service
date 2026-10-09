"""CLIP zero-shot classification against a configurable category label list.

Model is loaded lazily (first call only) since importing torch/open_clip and loading
weights is slow (a few seconds) - we don't want to pay that cost at server startup for
requests that never touch the tagging pipeline.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

_model = None
_preprocess = None
_tokenizer = None

_MODEL_NAME = "ViT-B-32"
_PRETRAINED = "openai"


def _load():
    global _model, _preprocess, _tokenizer
    if _model is None:
        import open_clip  # deferred: heavy import, only needed when tagging actually runs
        import torch

        model, _, preprocess = open_clip.create_model_and_transforms(_MODEL_NAME, pretrained=_PRETRAINED)
        model.eval()
        with torch.no_grad():
            pass
        _model = model
        _preprocess = preprocess
        _tokenizer = open_clip.get_tokenizer(_MODEL_NAME)
    return _model, _preprocess, _tokenizer


def classify_frame(image_path: Path, labels: list[str], threshold: float = 0.3) -> Optional[str]:
    """Returns the single best-matching label if its softmax score clears `threshold`, else None."""
    if not labels:
        return None

    import torch
    from PIL import Image

    model, preprocess, tokenizer = _load()
    image = preprocess(Image.open(image_path).convert("RGB")).unsqueeze(0)
    text = tokenizer(labels)

    with torch.no_grad():
        image_features = model.encode_image(image)
        text_features = model.encode_text(text)
        image_features = image_features / image_features.norm(dim=-1, keepdim=True)
        text_features = text_features / text_features.norm(dim=-1, keepdim=True)
        probs = (100.0 * image_features @ text_features.T).softmax(dim=-1)[0]

    best_index = int(torch.argmax(probs).item())
    best_score = float(probs[best_index].item())
    if best_score >= threshold:
        return labels[best_index]
    return None
