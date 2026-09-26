from __future__ import annotations

import io
import json

import numpy as np
from PIL import Image

from app.services.homography import apply_homography, compute_homography, warp_perspective

SRC = [[0, 0], [399, 0], [399, 299], [0, 299]]
DST = [[0, 60], [80, 60], [80, 0], [0, 0]]  # metres, north-up; 1 source px ≈ 0.2 m


def test_homography_roundtrip():
    src = np.array([[100, 400], [700, 420], [520, 150], [260, 140]], float)
    dst = np.array([[0, 0], [30, 0], [30, 80], [0, 80]], float)
    H = compute_homography(src, dst)
    assert np.allclose(apply_homography(H, src), dst, atol=1e-6)
    assert np.allclose(apply_homography(np.linalg.inv(H), dst), src, atol=1e-6)


def test_warp_identity():
    img = np.random.default_rng(0).integers(0, 255, (20, 30, 3), dtype=np.uint8)
    out, valid = warp_perspective(img, np.eye(3), (30, 20))
    assert valid.all() and np.array_equal(out, img)


def _png(img: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(img).save(buf, format="PNG")
    return buf.getvalue()


def _asphalt() -> np.ndarray:
    base = np.random.default_rng(1).normal(90, 6, (300, 400)).clip(0, 255).astype(np.uint8)
    return np.stack([base, base, base], axis=-1)


def _post(client, img, **extra):
    return client.post(
        "/api/v1/umap/vision-check",
        files={"file": ("frame.png", _png(img), "image/png")},
        data={"src_points": json.dumps(SRC), "dst_points": json.dumps(DST), **extra},
    )


def test_detects_water_sheen_and_maps_to_metres(client):
    img = _asphalt()
    img[130:170, 180:220] = 245  # bright specular patch centred on px (200, 150)
    r = _post(client, img)
    assert r.status_code == 200, r.text
    body = r.json()
    water = [d for d in body["detections"] if d["hazard_type"] == "water_sheen"]
    assert len(water) == 1
    p = water[0]["map_coordinates"]
    assert abs(p["x"] - 40.1) < 1.0 and abs(p["y"] - 29.9) < 1.0
    assert 50 < water[0]["area_m2"] < 75  # 40x40 px ≈ 8x8 m
    assert body["events"] and body["events"][0]["severity_level"] == "WATCH"


def test_detects_oil_and_debris(client):
    img = _asphalt()
    img[40:70, 40:120] = 20                 # dark oil streak
    img[200:230, 300:330] = [220, 30, 30]   # red bodywork debris
    kinds = {d["hazard_type"] for d in _post(client, img, fuse="false").json()["detections"]}
    assert {"oil_streak", "debris"} <= kinds


def test_clean_surface_has_no_detections(client):
    body = _post(client, _asphalt()).json()
    assert body["detections"] == [] and body["events"] == []


def test_bad_points_rejected(client):
    r = client.post(
        "/api/v1/umap/vision-check",
        files={"file": ("f.png", _png(_asphalt()), "image/png")},
        data={"src_points": "[[0,0],[1,1]]", "dst_points": json.dumps(DST)},
    )
    assert r.status_code == 422


def test_undecodable_image(client):
    r = client.post(
        "/api/v1/umap/vision-check",
        files={"file": ("f.png", b"not an image", "image/png")},
        data={"src_points": json.dumps(SRC), "dst_points": json.dumps(DST)},
    )
    assert r.status_code == 422
