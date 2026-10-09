"""YOLO object detection -> tag names, via ultralytics.

Model is loaded lazily (first call only), same rationale as clip_tagger: importing
ultralytics/torch is slow and shouldn't cost anything for requests that never tag.
"""
from __future__ import annotations

from pathlib import Path

_model = None

_WEIGHTS = "yolov8n.pt"  # smallest/fastest ultralytics checkpoint, auto-downloaded on first use


def _load():
    global _model
    if _model is None:
        from ultralytics import YOLO  # deferred: heavy import

        _model = YOLO(_WEIGHTS)
    return _model


def detect_objects(image_path: Path, confidence: float = 0.4, max_tags: int = 5) -> list[str]:
    model = _load()
    results = model.predict(source=str(image_path), verbose=False, conf=confidence)
    names = model.names

    detected: list[str] = []
    seen = set()
    for result in results:
        for box in result.boxes:
            class_id = int(box.cls[0])
            name = names.get(class_id, str(class_id)) if isinstance(names, dict) else names[class_id]
            if name not in seen:
                seen.add(name)
                detected.append(name)
            if len(detected) >= max_tags:
                break
        if len(detected) >= max_tags:
            break
    return detected
