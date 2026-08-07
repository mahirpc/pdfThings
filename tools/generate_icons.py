# Regenerates icons/icon-192.png, icon-512.png, and icon-maskable-512.png.
# Requires Pillow: pip install Pillow
# Run from the project root: python3 tools/generate_icons.py
from PIL import Image, ImageDraw
INK = (18, 22, 29, 255)        # near-black ink background
PAPER = (244, 242, 236, 255)   # paper white
TEAL = (27, 122, 114, 255)     # primary ink-stamp teal
AMBER = (214, 158, 46, 255)    # secondary amber accent

def rounded_square(size, radius_ratio):
    img = Image.new("RGBA", (size, size), (0,0,0,0))
    d = ImageDraw.Draw(img)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size-1, size-1], radius=r, fill=INK)

    # paper sheet (slightly rotated look achieved via parallelogram-ish polygon)
    pad = size * 0.20
    fold = size * 0.14
    x0, y0 = pad, pad * 0.85
    x1 = size - pad * 1.15
    y1 = size - pad * 0.75
    d.polygon([
        (x0, y0),
        (x1 - fold, y0),
        (x1, y0 + fold),
        (x1, y1),
        (x0, y1),
    ], fill=PAPER)
    # folded corner
    d.polygon([
        (x1 - fold, y0),
        (x1, y0 + fold),
        (x1 - fold, y0 + fold),
    ], fill=(214, 210, 198, 255))

    # text lines on paper
    line_x0 = x0 + size*0.07
    line_x1 = x1 - size*0.10
    ly = y0 + size*0.16
    lh = size*0.045
    gap = size*0.075
    widths = [1.0, 0.82, 0.6]
    for w in widths:
        d.rounded_rectangle([line_x0, ly, line_x0 + (line_x1-line_x0)*w, ly+lh],
                             radius=lh/2, fill=(60, 64, 72, 255))
        ly += gap

    # stamp badge (teal circle) overlapping bottom-right of the paper
    cx, cy = x1 - size*0.06, y1 - size*0.06
    rad = size * 0.20
    d.ellipse([cx-rad, cy-rad, cx+rad, cy+rad], fill=TEAL, outline=AMBER, width=max(2, int(size*0.012)))
    # simple checkmark inside stamp
    d.line([(cx-rad*0.45, cy+rad*0.05), (cx-rad*0.10, cy+rad*0.40), (cx+rad*0.50, cy-rad*0.35)],
           fill=PAPER, width=max(3, int(size*0.045)), joint="curve")
    return img

for size, name in [(192, "icon-192.png"), (512, "icon-512.png")]:
    img = rounded_square(size, 0.22)
    img.save(f"icons/{name}")

# maskable icon: needs safe zone padding (content within ~80% center circle), full-bleed background
def maskable(size):
    img = Image.new("RGBA", (size, size), (0,0,0,0))
    d = ImageDraw.Draw(img)
    d.rectangle([0,0,size,size], fill=INK)
    inner = rounded_square(int(size*0.72), 0.20)
    off = (size - inner.width)//2
    img.paste(inner, (off, off), inner)
    return img

maskable(512).save("icons/icon-maskable-512.png")
print("icons written")
