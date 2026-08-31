#!/usr/bin/env python3
"""
Gera icones PNG simples para a extensao (16x16, 48x48, 128x128) sem
depender de nenhuma biblioteca externa (sem Pillow). Desenha um circulo
solido com uma seta de download, usando apenas a stdlib (zlib + struct).

Uso: python3 scripts/gen_icons.py
"""
import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "extension" / "icons"
OUT_DIR.mkdir(parents=True, exist_ok=True)

BG = (0x2F, 0x6F, 0xED, 255)      # azul
FG = (0xFF, 0xFF, 0xFF, 255)      # branco


def make_pixels(size: int):
    cx = cy = size / 2
    radius = size / 2 - 1
    pixels = [[BG for _ in range(size)] for _ in range(size)]

    for y in range(size):
        for x in range(size):
            dx = x + 0.5 - cx
            dy = y + 0.5 - cy
            if dx * dx + dy * dy > radius * radius:
                pixels[y][x] = (0, 0, 0, 0)  # transparente fora do circulo

    # seta de download: um retangulo vertical (haste) + triangulo (ponta)
    stem_w = max(2, size // 8)
    stem_top = size * 0.22
    stem_bottom = size * 0.55
    stem_x0 = cx - stem_w / 2
    stem_x1 = cx + stem_w / 2

    for y in range(size):
        for x in range(size):
            if pixels[y][x][3] == 0:
                continue
            if stem_x0 <= x + 0.5 <= stem_x1 and stem_top <= y <= stem_bottom:
                pixels[y][x] = FG

    tri_top = stem_bottom
    tri_bottom = size * 0.72
    tri_half_w = size * 0.22

    for y in range(size):
        if not (tri_top <= y <= tri_bottom):
            continue
        t = (y - tri_top) / max(1.0, (tri_bottom - tri_top))
        half_w = tri_half_w * (1 - t)
        x0 = cx - half_w
        x1 = cx + half_w
        for x in range(size):
            if pixels[y][x][3] == 0:
                continue
            if x0 <= x + 0.5 <= x1:
                pixels[y][x] = FG

    # base (linha horizontal) representando a bandeja/download concluido
    base_y0 = size * 0.80
    base_y1 = size * 0.86
    base_x0 = size * 0.20
    base_x1 = size * 0.80
    for y in range(size):
        if not (base_y0 <= y <= base_y1):
            continue
        for x in range(size):
            if pixels[y][x][3] == 0:
                continue
            if base_x0 <= x + 0.5 <= base_x1:
                pixels[y][x] = FG

    return pixels


def write_png(path: Path, pixels):
    size = len(pixels)
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # sem filtro
        for (r, g, b, a) in row:
            raw += bytes((r, g, b, a))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)

    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", idat))
        f.write(chunk(b"IEND", b""))


def main():
    for size in (16, 48, 128):
        pixels = make_pixels(size)
        out_path = OUT_DIR / f"icon{size}.png"
        write_png(out_path, pixels)
        print(f"gerado: {out_path}")


if __name__ == "__main__":
    main()
