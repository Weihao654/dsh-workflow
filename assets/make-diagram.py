"""Generates assets/architecture.png: the role chain and the six steps of one round."""

from PIL import Image, ImageDraw, ImageFont
import numpy as np

W, H = 1600, 900
BG = (11, 18, 32)
FG = (226, 232, 240)
DIM = (148, 163, 184)
NODES = [(56, 189, 248), (251, 191, 36), (52, 211, 153), (244, 114, 182)]
FONT = "C:/Windows/Fonts/msyh.ttc"
BOLD = "C:/Windows/Fonts/msyhbd.ttc"


def f(path, size):
    return ImageFont.truetype(path, size)


img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

d.text((80, 64), "角色链 · 一轮六步", font=f(BOLD, 56), fill=FG)
d.text((80, 140), "计划 → 实施 → 编码 → 复核 → 交付：每一步都有工具拦着，不靠自觉", font=f(FONT, 28), fill=DIM)

# chain
labels = [("用户", (100, 300)), ("plan", (330, 240)), ("work", (620, 300)), ("code", (900, 240)), ("review", (1180, 300))]
colors = [(226, 232, 240), NODES[0], NODES[1], NODES[2], NODES[3]]

for i, ((name, (x, y)), c) in enumerate(zip(labels, colors)):
    box = [x, y, x + 210, y + 110]
    d.rounded_rectangle(box, radius=24, outline=c, width=5, fill=(17, 26, 43))
    tw = d.textlength(name, font=f(BOLD, 44))
    d.text((x + 105 - tw / 2, y + 28), name, font=f(BOLD, 44), fill=c)
    if i + 1 < len(labels):
        nx, ny = labels[i + 1][1]
        y0, y1 = y + 55, ny + 55
        d.line([x + 210, y0, nx, y1], fill=(51, 65, 85), width=5)
        d.polygon([(nx - 16, y1 - 9), (nx, y1), (nx - 16, y1 + 9)], fill=(51, 65, 85))

d.text((100, 430), "门禁只由根会话弹卡（plan；方式 B 里 work 当根也行）", font=f(FONT, 26), fill=DIM)

# six steps
steps = ["核对基线", "收敛方案与授权", "连续实施（唯一 T0）", "限定修正（累计计数）", "独立终审（证据分层）", "交付并关闭"]
x0, y0, bw, gap = 100, 540, 220, 18
for i, s in enumerate(steps):
    x = x0 + i * (bw + gap)
    d.rounded_rectangle([x, y0, x + bw, y0 + 150], radius=18, fill=(17, 26, 43), outline=(45, 60, 82), width=3)
    d.text((x + 20, y0 + 20), f"{i + 1}", font=f(BOLD, 34), fill=NODES[i % 4])
    d.multiline_text((x + 20, y0 + 70), s.replace("（", "\n（"), font=f(FONT, 24), fill=FG, spacing=6)

d.text((100, 760), "L1 = 四个 preset 各带工具集    L2 = 九个 chain_* 工具守住事实（T0 / 计数 / 证据 / 门禁 / 审计文件）",
       font=f(FONT, 26), fill=DIM)

img.save("assets/architecture.png")
print("wrote assets/architecture.png", img.size)

# --- sanity check the icon ---------------------------------------------------
icon = Image.open("assets/icon-1024.png").convert("RGBA")
small = np.array(icon.resize((96, 96), Image.LANCZOS))
print("96px corner alpha:", small[0, 0, 3], small[95, 95, 3])
print("96px center alpha:", small[48, 48, 3])
for name, c in zip(["plan", "work", "code", "review"], NODES):
    mask = (np.abs(small[:, :, :3].astype(int) - np.array(c)).sum(axis=2) < 60) & (small[:, :, 3] > 200)
    ys, xs = np.nonzero(mask)
    print(f"  {name}: {mask.sum()} px, centroid=({xs.mean():.0f},{ys.mean():.0f})" if mask.sum() else f"  {name}: MISSING")
