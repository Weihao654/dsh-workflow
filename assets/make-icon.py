"""Generates assets/icon-1024.png: four connected nodes = the four roles of the chain."""

from PIL import Image, ImageDraw, ImageFilter

S = 1024
BG = (11, 18, 32, 255)
TRACK = (34, 62, 88, 255)
NODES = [(56, 189, 248), (251, 191, 36), (52, 211, 153), (244, 114, 182)]

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

plate = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(plate).rounded_rectangle([0, 0, S - 1, S - 1], radius=230, fill=BG)
img.alpha_composite(plate)

CY, R = 512, 104
XS = [232, 420, 604, 792]

# soft glow so the dots keep some weight at 96px
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
for x, c in zip(XS, NODES):
    gd.ellipse([x - R, CY - R, x + R, CY + R], fill=c + (170,))
img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(56)))

d = ImageDraw.Draw(img)
d.line([XS[0], CY, XS[-1], CY], fill=TRACK, width=24)
for x, c in zip(XS, NODES):
    d.ellipse([x - R, CY - R, x + R, CY + R], fill=c + (255,))

img.save("assets/icon-1024.png")
img.resize((96, 96), Image.LANCZOS).save("assets/icon-96-preview.png")
print("wrote assets/icon-1024.png and assets/icon-96-preview.png")
