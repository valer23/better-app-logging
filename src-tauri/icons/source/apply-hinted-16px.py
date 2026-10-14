#!/usr/bin/env python3
"""Swap the hand-hinted 16 px rasters into icon.ico and icon.icns.

Run after `cargo tauri icon` has regenerated the set:

    python3 icons/source/apply-hinted-16px.py        (from src-tauri/)

The 32-unit grid of the 1024 masters lands on whole pixels at 32 px, but
every edge falls on a half pixel at 16 px, which smears the rows. So the
16 px entries come from two masters drawn on the 16 px grid instead:

  app-icon-16.svg        -> icon.ico (16 px entry)
  app-icon-macos-16.svg  -> icon.icns (16x16 slot: the is32 + s8mk pair)

Needs rsvg-convert (Homebrew librsvg). Standard library only.
"""
import struct
import subprocess
import sys
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
ICONS = HERE.parent


def render(svg: Path) -> bytes:
    return subprocess.run(
        ["rsvg-convert", "-w", "16", "-h", "16", str(svg)],
        check=True,
        capture_output=True,
    ).stdout


def decode_rgba(png: bytes) -> list[tuple[int, int, int, int]]:
    """Decode an 8-bit RGBA, non-interlaced 16x16 PNG into pixels."""
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat = 8, b""
    while pos < len(png):
        n, kind = struct.unpack(">I4s", png[pos : pos + 8])
        body = png[pos + 8 : pos + 8 + n]
        if kind == b"IHDR":
            w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
            assert (w, h, depth, ctype, interlace) == (16, 16, 8, 6, 0), "want 16x16 RGBA8"
        elif kind == b"IDAT":
            idat += body
        pos += 12 + n
    raw, stride, rows, prev = zlib.decompress(idat), 16 * 4, [], bytes(16 * 4)
    for y in range(16):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1 : (y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - 4] if i >= 4 else 0
            b = prev[i]
            c = prev[i - 4] if i >= 4 else 0
            if f == 1:
                line[i] = (line[i] + a) & 255
            elif f == 2:
                line[i] = (line[i] + b) & 255
            elif f == 3:
                line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 255
        prev = bytes(line)
        rows.append(prev)
    return [tuple(r[x * 4 : x * 4 + 4]) for r in rows for x in range(16)]


def rle(chan: bytes) -> bytes:
    """icns RLE: 0x00-0x7f = n+1 literals; 0x80-0xff = repeat next byte n-0x80+3 times."""
    out, i = bytearray(), 0
    while i < len(chan):
        run = 1
        while i + run < len(chan) and chan[i + run] == chan[i] and run < 130:
            run += 1
        if run >= 3:
            out += bytes([0x80 + run - 3, chan[i]])
            i += run
            continue
        j = i
        while (
            j < len(chan)
            and j - i < 128
            and not (j + 2 < len(chan) and chan[j] == chan[j + 1] == chan[j + 2])
        ):
            j += 1
        j = max(j, i + 1)
        out += bytes([j - i - 1]) + chan[i:j]
        i = j
    return bytes(out)


def patch_ico(png16: bytes) -> None:
    path = ICONS / "icon.ico"
    d = path.read_bytes()
    n = struct.unpack("<H", d[4:6])[0]
    entries = []
    for i in range(n):
        e = d[6 + 16 * i : 22 + 16 * i]
        size, off = struct.unpack("<II", e[8:16])
        entries.append([e, d[off : off + size]])
    hit = [x for x in entries if x[0][0] == 16]
    assert len(hit) == 1, "expected exactly one 16 px ico entry"
    hit[0][1] = png16
    out, off = bytearray(d[:6]), 6 + 16 * n
    for e, data in entries:
        out += e[:8] + struct.pack("<II", len(data), off)
        off += len(data)
    for _, data in entries:
        out += data
    path.write_bytes(out)


def patch_icns(px) -> None:
    path = ICONS / "icon.icns"
    d = path.read_bytes()
    assert d[:4] == b"icns"
    # straight (non-premultiplied) RGB planes, with the alpha in the mask
    new = {
        b"is32": b"".join(rle(bytes(p[c] for p in px)) for c in range(3)),
        b"s8mk": bytes(p[3] for p in px),
    }
    out, pos, seen = bytearray(), 8, set()
    while pos < len(d):
        kind, n = struct.unpack(">4sI", d[pos : pos + 8])
        if kind in new:
            out += kind + struct.pack(">I", 8 + len(new[kind])) + new[kind]
            seen.add(kind)
        else:
            out += d[pos : pos + n]
        pos += n
    assert seen == set(new), "icon.icns has no is32/s8mk 16 px slot"
    path.write_bytes(b"icns" + struct.pack(">I", 8 + len(out)) + out)


def main() -> int:
    ico_png = render(HERE / "app-icon-16.svg")
    mac_png = render(HERE / "app-icon-macos-16.svg")
    patch_ico(ico_png)
    patch_icns(decode_rgba(mac_png))
    print("patched icon.ico (16 px entry) and icon.icns (is32 + s8mk)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
