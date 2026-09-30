#!/usr/bin/env python3
"""
Regenerates every raster icon from the two SVG sources in this folder.

Only needed when logo.svg or logo-small.svg changes. The outputs are committed,
so building or running the app never needs Python. Requires: python3 and
`pip install playwright` with its Chromium (Chromium does the SVG rendering,
so the PNGs match what a browser draws).

Outputs
  icon.png                      512 px, Linux AppImage + BrowserWindow icon
  icon.ico                      Windows: 16/24/32/48 from logo-small, 64/128/256 from logo
  icon.icns                     macOS: same art on a transparent margin (Apple's icon grid)
  ../../apps/<page>/public/favicon.svg       browser tab icon for the LAN pages
  ../../apps/remote/public/apple-touch-icon.png   180 px home-screen icon for phones

Usage:  python3 assets/icons/make-icons.py
"""
import base64
import re
import struct
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DETAILED = (HERE / "logo.svg").read_text()
SMALL = (HERE / "logo-small.svg").read_text()

# Below this size the fine detail (caption text lines, halo) turns to mush.
SMALL_BELOW = 64


def pick(size: int) -> str:
    return SMALL if size < SMALL_BELOW else DETAILED


def padded(svg: str) -> str:
    """Same art inside a transparent margin: macOS icons are ~80% of the canvas."""
    return svg.replace('viewBox="0 0 1024 1024"', 'viewBox="-112 -112 1248 1248"', 1)


def square_opaque(svg: str) -> str:
    """Full-bleed square for iOS, which applies its own rounded mask."""
    svg = re.sub(r'<rect id="edge"[^>]*/>\s*', "", svg)
    return re.sub(r'rx="2\d\d"', 'rx="0"', svg)


def render_all(jobs):
    """jobs: {key: (svg_text, px)} -> {key: png bytes}, transparent background."""
    out = {}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for key, (svg, px) in jobs.items():
            page = browser.new_page(viewport={"width": px, "height": px}, device_scale_factor=1)
            data = base64.b64encode(svg.encode()).decode()
            page.set_content(
                "<style>html,body{margin:0;background:transparent}img{display:block}</style>"
                f'<img src="data:image/svg+xml;base64,{data}" width="{px}" height="{px}">'
            )
            out[key] = page.screenshot(omit_background=True, clip={"x": 0, "y": 0, "width": px, "height": px})
            page.close()
        browser.close()
    return out


def write_ico(path: Path, pngs: dict) -> None:
    sizes = sorted(pngs)
    header = struct.pack("<HHH", 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    entries, blobs = b"", b""
    for s in sizes:
        blob = pngs[s]
        # A width/height byte of 0 means 256.
        entries += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(blob), offset)
        blobs += blob
        offset += len(blob)
    path.write_bytes(header + entries + blobs)


# Modern PNG-carrying ICNS chunk types -> pixel size.
ICNS_TYPES = {
    "icp4": 16, "icp5": 32, "ic11": 32, "ic12": 64,
    "ic07": 128, "ic13": 256, "ic08": 256, "ic14": 512, "ic09": 512, "ic10": 1024,
}


def write_icns(path: Path, pngs: dict) -> None:
    chunks = b""
    for kind, px in ICNS_TYPES.items():
        chunks += kind.encode() + struct.pack(">I", 8 + len(pngs[px])) + pngs[px]
    path.write_bytes(b"icns" + struct.pack(">I", 8 + len(chunks)) + chunks)


def main() -> None:
    win_sizes = [16, 24, 32, 48, 64, 128, 256]
    mac_sizes = sorted(set(ICNS_TYPES.values()))

    jobs = {("png", 512): (DETAILED, 512), ("touch", 180): (square_opaque(DETAILED), 180)}
    jobs.update({("win", s): (pick(s), s) for s in win_sizes})
    jobs.update({("mac", s): (padded(pick(s)), s) for s in mac_sizes})
    png = render_all(jobs)

    (HERE / "icon.png").write_bytes(png[("png", 512)])
    write_ico(HERE / "icon.ico", {s: png[("win", s)] for s in win_sizes})
    write_icns(HERE / "icon.icns", {s: png[("mac", s)] for s in mac_sizes})

    for page in ("remote", "stage", "live"):
        (ROOT / "apps" / page / "public" / "favicon.svg").write_text(SMALL)
    (ROOT / "apps" / "remote" / "public" / "apple-touch-icon.png").write_bytes(png[("touch", 180)])
    print("icons regenerated")


if __name__ == "__main__":
    main()
