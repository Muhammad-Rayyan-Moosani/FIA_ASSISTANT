"""Perspective (homography) utilities: track-camera image  ->  2D overhead track map.

Uses OpenCV when installed and falls back to an equivalent NumPy implementation
(DLT solve + inverse-mapped nearest-neighbour warp) so the pipeline runs anywhere.
"""
from __future__ import annotations

import numpy as np

try:  # pragma: no cover - depends on environment
    import cv2
except ImportError:  # pragma: no cover
    cv2 = None


def compute_homography(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """3x3 H with dst ~ H @ src for >= 4 point correspondences (image px -> metres)."""
    src = np.asarray(src, dtype=np.float64).reshape(-1, 2)
    dst = np.asarray(dst, dtype=np.float64).reshape(-1, 2)
    if len(src) < 4 or len(src) != len(dst):
        raise ValueError("need >= 4 matching point pairs")
    if cv2 is not None:
        H, _ = cv2.findHomography(src, dst, method=0)
        if H is None:
            raise ValueError("degenerate point configuration")
        return H
    # Direct Linear Transform
    rows = []
    for (x, y), (u, v) in zip(src, dst):
        rows.append([-x, -y, -1, 0, 0, 0, u * x, u * y, u])
        rows.append([0, 0, 0, -x, -y, -1, v * x, v * y, v])
    _, s, vt = np.linalg.svd(np.asarray(rows))
    if s[-2] < 1e-9:
        raise ValueError("degenerate point configuration")
    H = vt[-1].reshape(3, 3)
    return H / H[2, 2]


def apply_homography(H: np.ndarray, pts: np.ndarray) -> np.ndarray:
    pts = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
    hom = np.c_[pts, np.ones(len(pts))] @ H.T
    return hom[:, :2] / hom[:, 2:3]


def overhead_transform(
    H_img_to_m: np.ndarray, dst_pts: np.ndarray, px_per_m: float, max_px: int
) -> tuple[np.ndarray, np.ndarray, tuple[int, int]]:
    """Build the metres -> overhead-pixel affine S and the combined image -> overhead H.

    Returns (H_img_to_overhead, S_m_to_px, (width, height)).
    """
    dst = np.asarray(dst_pts, dtype=np.float64).reshape(-1, 2)
    lo, hi = dst.min(axis=0), dst.max(axis=0)
    extent = np.maximum(hi - lo, 1e-6)
    scale = min(px_per_m, max_px / extent.max())
    w, h = (np.ceil(extent * scale).astype(int) + 1).tolist()
    # Flip Y so the map reads north-up (image rows grow downward).
    S = np.array([[scale, 0, -lo[0] * scale], [0, -scale, hi[1] * scale], [0, 0, 1]], dtype=np.float64)
    return S @ H_img_to_m, S, (w, h)


def warp_perspective(img: np.ndarray, H: np.ndarray, size: tuple[int, int]) -> tuple[np.ndarray, np.ndarray]:
    """Warp ``img`` with H into an image of ``size`` (w, h). Returns (warped, valid_mask)."""
    w, h = size
    if cv2 is not None:
        warped = cv2.warpPerspective(img, H, (w, h), flags=cv2.INTER_LINEAR)
        ones = np.full(img.shape[:2], 255, np.uint8)
        valid = cv2.warpPerspective(ones, H, (w, h), flags=cv2.INTER_NEAREST) > 0
        return warped, valid
    Hinv = np.linalg.inv(H)
    ys, xs = np.mgrid[0:h, 0:w]
    src = apply_homography(Hinv, np.c_[xs.ravel(), ys.ravel()])
    sx = np.rint(src[:, 0]).astype(np.int64)
    sy = np.rint(src[:, 1]).astype(np.int64)
    valid = (sx >= 0) & (sx < img.shape[1]) & (sy >= 0) & (sy < img.shape[0])
    out = np.zeros((h * w,) + img.shape[2:], dtype=img.dtype)
    out[valid] = img[sy[valid], sx[valid]]
    return out.reshape((h, w) + img.shape[2:]), valid.reshape(h, w)
