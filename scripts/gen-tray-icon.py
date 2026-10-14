#!/usr/bin/env python3
"""Generates assets/tray-icon.png (64x64): a ">_" prompt on a rounded dark tile.
Stdlib only (zlib + struct), so the icon is reproducible without image tooling."""
import struct, zlib, pathlib

S = 64
BG, FG, CLEAR = (30, 34, 43, 255), (120, 220, 160, 255), (0, 0, 0, 0)

def inside_rounded(x, y, r=12):
    cx = min(max(x, r), S - 1 - r)
    cy = min(max(y, r), S - 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

def on_chevron(x, y):
    # ">" from (14,18) to (30,32) to (14,46), 5px thick
    for (x0, y0, x1, y1) in ((14, 18, 30, 32), (30, 32, 14, 46)):
        dx, dy = x1 - x0, y1 - y0
        t = max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)))
        if (x - (x0 + t * dx)) ** 2 + (y - (y0 + t * dy)) ** 2 <= 2.5 ** 2:
            return True
    return False

def pixel(x, y):
    if not inside_rounded(x, y):
        return CLEAR
    if on_chevron(x, y) or (34 <= x <= 50 and 42 <= y <= 46):
        return FG
    return BG

raw = b"".join(b"\x00" + b"".join(bytes(pixel(x, y)) for x in range(S)) for y in range(S))
def chunk(t, d):
    return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
out = pathlib.Path(__file__).resolve().parent.parent / "assets" / "tray-icon.png"
out.write_bytes(png)
print(f"wrote {out} ({len(png)} bytes)")
