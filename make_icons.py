#!/usr/bin/env python3
"""生成扩展图标：圆角方块 + 白色“译”字"""
import os
from PIL import Image, ImageDraw, ImageFont

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, "icons")
os.makedirs(OUT, exist_ok=True)

FONT_PATHS = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
]

def load_font(size):
    for p in FONT_PATHS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()

for size in (16, 32, 48, 128):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = max(3, int(size * 0.22))
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=(47, 111, 237, 255))
    font = load_font(int(size * 0.62))
    text = "译"
    bbox = d.textbbox((0, 0), text, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((size - w) / 2 - bbox[0], (size - h) / 2 - bbox[1]), text, font=font, fill=(255, 255, 255, 255))
    img.save(os.path.join(OUT, f"icon{size}.png"))
    print(f"icon{size}.png OK")
