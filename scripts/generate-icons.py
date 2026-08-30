#!/usr/bin/env python3
"""
Generate the extension's icons.

Chrome requires raster icons for the toolbar action and the extensions page; it
does not accept SVG there. Rather than checking in four opaque binaries nobody
can modify, the icons are generated from this script so they can be changed and
regenerated consistently.

    python3 scripts/generate-icons.py

Requires Pillow. The output lands in src/public/icon/, which WXT copies to the
build root verbatim.

THE DESIGN: a rounded blue tile with two filled form fields and a check mark -
"a form, filled correctly". Deliberately almost featureless, because 16px is the
size users actually look at (the toolbar) and any detail turns to mud there.
"""
from PIL import Image, ImageDraw

BG = (37, 99, 235, 255)  # matches the primary button colour in the UI
FG = (255, 255, 255, 255)
SIZES = (16, 32, 48, 128)

# PIL has no anti-aliased drawing, so everything is rendered at 4x and
# downsampled with LANCZOS. Drawing directly at 16px produces ragged edges.
SUPERSAMPLE = 4


def render(size: int) -> Image.Image:
    s = size * SUPERSAMPLE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    draw.rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * 0.22), fill=BG)

    # A 16-unit grid, so the proportions are identical at every output size.
    unit = s / 16.0

    for top, width in ((4.0, 8.0), (7.0, 5.5)):
        y = top * unit
        draw.rounded_rectangle(
            (3 * unit, y, (3 + width) * unit, y + 1.6 * unit),
            radius=int(0.8 * unit),
            fill=FG,
        )

    stroke = max(1, int(1.5 * unit))
    draw.line([(4.2 * unit, 11.2 * unit), (6.4 * unit, 13.2 * unit)], fill=FG, width=stroke)
    draw.line([(6.4 * unit, 13.2 * unit), (12.0 * unit, 6.8 * unit)], fill=FG, width=stroke)

    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    for size in SIZES:
        path = f"src/public/icon/{size}.png"
        render(size).save(path)
        print("wrote", path)
