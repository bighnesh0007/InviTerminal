#!/usr/bin/env python3
"""Generates the app icon (">_" on a rounded dark tile) at every size the desktop needs:
assets/tray-icon.png (64) and build/icons/<N>x<N>.png (electron-builder / hicolor theme).
Stdlib only (zlib + struct), so the icons are reproducible without image tooling."""
import pathlib, struct, zlib

BG, FG, CLEAR = (30, 34, 43, 255), (120, 220, 160, 255), (0, 0, 0, 0)
ROOT = pathlib.Path(__file__).resolve().parent.parent


def render(S: int) -> bytes:
    k = S / 64  # all geometry is designed on a 64px grid

    def inside_rounded(x, y, r=12 * k):
        cx = min(max(x, r), S - 1 - r)
        cy = min(max(y, r), S - 1 - r)
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

    def on_chevron(x, y):
        for (x0, y0, x1, y1) in ((14, 18, 30, 32), (30, 32, 14, 46)):
            x0, y0, x1, y1 = x0 * k, y0 * k, x1 * k, y1 * k
            dx, dy = x1 - x0, y1 - y0
            t = max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)))
            if (x - (x0 + t * dx)) ** 2 + (y - (y0 + t * dy)) ** 2 <= (2.5 * k) ** 2:
                return True
        return False

    def pixel(px, py):
        x, y = px + 0.5, py + 0.5  # sample at pixel centres so small sizes stay symmetric
        if not inside_rounded(x, y):
            return CLEAR
        if on_chevron(x, y) or (34 * k <= x <= 50 * k and 42 * k <= y <= 46 * k):
            return FG
        return BG

    raw = b"".join(b"\x00" + b"".join(bytes(pixel(x, y)) for x in range(S)) for y in range(S))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


outputs = {ROOT / "assets" / "tray-icon.png": 64}
for n in (16, 32, 48, 64, 128, 256, 512):
    outputs[ROOT / "build" / "icons" / f"{n}x{n}.png"] = n
for path, size in outputs.items():
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(render(size))
    print(f"wrote {path.relative_to(ROOT)} ({size}px)")
