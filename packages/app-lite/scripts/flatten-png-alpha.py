#!/usr/bin/env python3
"""Rewrite PNGs as truecolor RGB, dropping the alpha channel.

App Store Connect rejects app icons that "can't be transparent nor contain an
alpha channel", and `tauri icon` always emits 8-bit RGBA because the `image`
crate encodes the Rgba8 buffer it builds -- even when the source PNG has no
alpha and the iOS entries are composited onto an opaque background. Xcode's
`actool` does not strip it either, so the channel reaches the .app and the
upload is rejected.

The generated artwork is fully opaque, so dropping the channel is a pure
format change: every pixel keeps its RGB value.

Stdlib only, by necessity -- the macOS runner has python3 but no image
libraries (no Pillow, ImageMagick, or pngcrush that preserves colour).

Usage: flatten-png-alpha.py FILE [FILE ...]
"""

from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

SIG = b"\x89PNG\r\n\x1a\n"


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def _unfilter(raw: bytes, width: int, height: int, bpp: int) -> bytes:
    """Reverse the per-scanline PNG filters, yielding raw pixel bytes."""
    stride = width * bpp
    out = bytearray(stride * height)
    prev = bytearray(stride)
    pos = 0
    for y in range(height):
        ftype = raw[pos]
        pos += 1
        line = bytearray(raw[pos : pos + stride])
        pos += stride
        if ftype == 0:
            pass
        elif ftype == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ftype == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                c = prev[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + _paeth(a, prev[i], c)) & 0xFF
        else:
            raise ValueError(f"unknown PNG filter type {ftype}")
        out[y * stride : (y + 1) * stride] = line
        prev = line
    return bytes(out)


def _chunk(ctype: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + ctype
        + data
        + struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF)
    )


def flatten(path: Path) -> bool:
    """Drop the alpha channel in place. Returns True if the file was rewritten."""
    data = path.read_bytes()
    if not data.startswith(SIG):
        raise ValueError(f"{path}: not a PNG")

    pos = 8
    idat = bytearray()
    ihdr = None
    keep: list[tuple[bytes, bytes]] = []
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        ctype = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            ihdr = body
        elif ctype == b"IDAT":
            idat += body
        elif ctype == b"IEND":
            break
        elif ctype in (b"gAMA", b"sRGB", b"cHRM", b"pHYs"):
            keep.append((ctype, body))

    if ihdr is None:
        raise ValueError(f"{path}: missing IHDR")
    width, height, depth, color, comp, filt, interlace = struct.unpack(
        ">IIBBBBB", ihdr
    )
    if interlace:
        raise ValueError(f"{path}: interlaced PNGs are not supported")
    if depth != 8:
        raise ValueError(f"{path}: unsupported bit depth {depth}")
    if color == 2:
        return False  # already truecolor RGB
    if color != 6:
        raise ValueError(f"{path}: unsupported colour type {color}")

    pixels = _unfilter(zlib.decompress(bytes(idat)), width, height, 4)
    # Drop the alpha byte of every pixel: RGB, fully opaque by construction.
    stride = width * 3
    rows = bytearray()
    for y in range(height):
        base = y * width * 4
        rgb = bytearray(width * 3)
        rgb[0::3] = pixels[base : base + width * 4 : 4]
        rgb[1::3] = pixels[base + 1 : base + width * 4 : 4]
        rgb[2::3] = pixels[base + 2 : base + width * 4 : 4]
        rows += b"\x00" + bytes(rgb)  # filter type 0 (None)
        assert len(rgb) == stride

    out = bytearray(SIG)
    out += _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, comp, filt, 0))
    for ctype, body in keep:
        out += _chunk(ctype, body)
    out += _chunk(b"IDAT", zlib.compress(bytes(rows), 9))
    out += _chunk(b"IEND", b"")
    path.write_bytes(bytes(out))
    return True


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    changed = 0
    for name in argv[1:]:
        if flatten(Path(name)):
            changed += 1
    print(f"flattened {changed} of {len(argv) - 1} file(s) to RGB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
