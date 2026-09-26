"""Measure faces in frames with OpenCV's YuNet detector (local, no cloud).

stdin:  {"model": "<path to face_detection_yunet_2023mar.onnx>", "frames": ["a.jpg", ...], "min_score": 0.6}
stdout: {"frames": [{"frame": "a.jpg", "w": 960, "h": 540, "faces": [[x0, y0, x1, y1, score], ...]}, ...]}
Coordinates are normalised to 0..1 of the image.
"""

import json
import sys

import cv2
import numpy as np


def read_image(path: str):
    # cv2.imread can't open non-ASCII paths on Windows (Arabic titles, emoji); decode from bytes instead.
    try:
        return cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
    except (OSError, ValueError):
        return None


def main():
    # Windows pipes default to the ANSI code page; paths here are UTF-8.
    req = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    min_score = float(req.get("min_score", 0.6))
    detector = None
    out = []
    for path in req["frames"]:
        img = read_image(path)
        if img is None:
            out.append({"frame": path, "w": 0, "h": 0, "faces": []})
            continue
        h, w = img.shape[:2]
        if detector is None:
            detector = cv2.FaceDetectorYN.create(req["model"], "", (w, h), min_score, 0.3, 5000)
        detector.setInputSize((w, h))
        _, faces = detector.detect(img)
        boxes = []
        if faces is not None:
            for f in faces:
                x, y, bw, bh, score = float(f[0]), float(f[1]), float(f[2]), float(f[3]), float(f[14])
                boxes.append([
                    round(max(0.0, x / w), 4), round(max(0.0, y / h), 4),
                    round(min(1.0, (x + bw) / w), 4), round(min(1.0, (y + bh) / h), 4),
                    round(score, 3),
                ])
        out.append({"frame": path, "w": w, "h": h, "faces": boxes})
    sys.stdout.buffer.write(json.dumps({"frames": out}, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    main()
