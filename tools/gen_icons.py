# -*- coding: utf-8 -*-
"""生成扩展图标（16/48/128）：圆角方块 + 白色问号。运行：python tools/gen_icons.py"""
import os

from PIL import Image, ImageDraw, ImageFont

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, "icons")


def load_font(size):
    candidates = [
        r"C:\Windows\Fonts\seguisb.ttf",   # Segoe UI Semibold
        r"C:\Windows\Fonts\msyhbd.ttc",    # 微软雅黑 Bold
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\arial.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def make(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = max(2, int(size * 0.24))
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=(79, 110, 247, 255))
    font = load_font(int(size * 0.68))
    text = "?"
    bbox = d.textbbox((0, 0), text, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((size - w) / 2 - bbox[0], (size - h) / 2 - bbox[1]), text, font=font, fill=(255, 255, 255, 255))
    img.save(os.path.join(OUT, "icon%d.png" % size))
    print("written icon%d.png" % size)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for s in (16, 48, 128):
        make(s)
