"""生成扩展图标：深色圆角方块 + 视频画面描边 + 右下角压住的画中画小窗（内含两行字幕）。
扁平、无渐变，先按 8 倍超采样绘制再降采样，保证 16px 也清晰。
"""
import os
from PIL import Image, ImageDraw

SS = 8
BG = (0, 122, 255, 255)       # #007AFF 蓝色底（与 popup 的 --pri-0 一致）
FRAME = (153, 203, 255, 255)  # #99cbff 视频画面描边（浅蓝，压在蓝底上才看得见）
FG = (242, 245, 255, 255)     # #f2f5ff 小窗与字幕底

SIZES = [16, 32, 48, 128]
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'icons')


def draw(size):
    S = size * SS
    u = lambda v: v * S
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 背景圆角方块
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=u(0.22), fill=BG)

    # 视频画面（描边，偏左上）
    d.rounded_rectangle(
        [u(0.14), u(0.13), u(0.74), u(0.62)],
        radius=u(0.06), outline=FRAME, width=int(round(u(0.055)))
    )

    # 画中画小窗（实心，右下，压住画面一角）
    d.rounded_rectangle([u(0.38), u(0.40), u(0.88), u(0.87)], radius=u(0.09), fill=FG)

    # 小窗里的两行字幕
    bh = u(0.07)
    d.rounded_rectangle([u(0.46), u(0.535), u(0.80), u(0.535) + bh], radius=bh / 2, fill=BG)
    d.rounded_rectangle([u(0.46), u(0.685), u(0.68), u(0.685) + bh], radius=bh / 2, fill=BG)

    return img.resize((size, size), Image.LANCZOS)


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for s in SIZES:
        path = os.path.join(OUT, 'icon%d.png' % s)
        draw(s).save(path)
        print('wrote', path)
