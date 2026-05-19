#!/usr/bin/env python3
r"""Generate committed VS Code Marketplace icons for DevDocket extensions.

Run from the repository root with: python scripts\generate-marketplace-icons.py
The output PNGs are committed so Marketplace packaging does not need Pillow.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SIZE = 128
SCALE = 4
CANVAS = SIZE * SCALE
GREEN_START = (0x10, 0xB9, 0x81, 0xFF)
GREEN_END = (0x05, 0x96, 0x69, 0xFF)
WHITE = (0xFF, 0xFF, 0xFF, 0xFF)


def scaled_point(point: tuple[float, float]) -> tuple[int, int]:
    return (round(point[0] * SCALE), round(point[1] * SCALE))


def scaled_box(box: tuple[float, float, float, float]) -> tuple[int, int, int, int]:
    return tuple(round(value * SCALE) for value in box)  # type: ignore[return-value]


def cubic_points(
    p0: tuple[float, float],
    p1: tuple[float, float],
    p2: tuple[float, float],
    p3: tuple[float, float],
    steps: int = 36,
) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    for step in range(steps + 1):
        t = step / steps
        inv = 1 - t
        x = inv**3 * p0[0] + 3 * inv**2 * t * p1[0] + 3 * inv * t**2 * p2[0] + t**3 * p3[0]
        y = inv**3 * p0[1] + 3 * inv**2 * t * p1[1] + 3 * inv * t**2 * p2[1] + t**3 * p3[1]
        points.append((x, y))
    return points


def outer_shape_points() -> list[tuple[int, int]]:
    points: list[tuple[float, float]] = [(24, 12), (24, 116), (70, 116)]
    points.extend(cubic_points((70, 116), (102, 116), (116, 92), (116, 64))[1:])
    points.extend(cubic_points((116, 64), (116, 36), (102, 12), (70, 12))[1:])
    return [scaled_point(point) for point in points]


def inner_shape_points() -> list[tuple[int, int]]:
    points: list[tuple[float, float]] = [(44, 32), (44, 96), (66, 96)]
    points.extend(cubic_points((66, 96), (86, 96), (96, 82), (96, 64))[1:])
    points.extend(cubic_points((96, 64), (96, 46), (86, 32), (66, 32))[1:])
    return [scaled_point(point) for point in points]


def diagonal_gradient() -> Image.Image:
    pixels: list[tuple[int, int, int, int]] = []
    denominator = (CANVAS - 1) * 2
    for y in range(CANVAS):
        for x in range(CANVAS):
            t = (x + y) / denominator
            pixels.append(tuple(round(GREEN_START[i] + (GREEN_END[i] - GREEN_START[i]) * t) for i in range(4)))
    gradient = Image.new("RGBA", (CANVAS, CANVAS))
    gradient.putdata(pixels)
    return gradient


def draw_base_mark() -> Image.Image:
    image = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    gradient = diagonal_gradient()

    outer_mask = Image.new("L", (CANVAS, CANVAS), 0)
    ImageDraw.Draw(outer_mask).polygon(outer_shape_points(), fill=255)
    image.alpha_composite(Image.composite(gradient, Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0)), outer_mask))

    inner_mask = Image.new("L", (CANVAS, CANVAS), 0)
    ImageDraw.Draw(inner_mask).polygon(inner_shape_points(), fill=255)
    image.alpha_composite(Image.composite(Image.new("RGBA", (CANVAS, CANVAS), WHITE), Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0)), inner_mask))

    bar_mask = Image.new("L", (CANVAS, CANVAS), 0)
    bar_draw = ImageDraw.Draw(bar_mask)
    for box in ((50, 44, 80, 51), (50, 60, 72, 67), (50, 76, 76, 83)):
        bar_draw.rounded_rectangle(scaled_box(box), radius=2 * SCALE, fill=255)
    image.alpha_composite(Image.composite(gradient, Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0)), bar_mask))

    return image.resize((SIZE, SIZE), Image.Resampling.LANCZOS)


def draw_badge_background(draw: ImageDraw.ImageDraw, color: tuple[int, int, int, int]) -> None:
    draw.rounded_rectangle(scaled_box((80, 80, 124, 124)), radius=4 * SCALE, fill=color, outline=WHITE, width=3 * SCALE)


def line(draw: ImageDraw.ImageDraw, points: list[tuple[float, float]], width: float) -> None:
    draw.line([scaled_point(point) for point in points], fill=WHITE, width=round(width * SCALE), joint="curve")


def ellipse(draw: ImageDraw.ImageDraw, center: tuple[float, float], radius: float) -> None:
    cx, cy = center
    draw.ellipse(scaled_box((cx - radius, cy - radius, cx + radius, cy + radius)), fill=WHITE)


def draw_github_glyph(draw: ImageDraw.ImageDraw) -> None:
    draw.arc(scaled_box((90, 90, 115, 115)), start=35, end=325, fill=WHITE, width=5 * SCALE)
    line(draw, [(103, 102), (116, 102)], width=5)
    line(draw, [(114, 102), (114, 110)], width=5)


def draw_ado_glyph(draw: ImageDraw.ImageDraw) -> None:
    line(draw, [(91, 114), (102, 90), (113, 114)], width=5)
    line(draw, [(96, 105), (108, 105)], width=5)


def draw_branch_glyph(draw: ImageDraw.ImageDraw) -> None:
    line(draw, [(94, 113), (94, 92)], width=4)
    line(draw, [(94, 101), (112, 93)], width=4)
    ellipse(draw, (94, 92), 4)
    ellipse(draw, (94, 113), 4)
    ellipse(draw, (112, 93), 4)


def draw_sparkle(draw: ImageDraw.ImageDraw, center: tuple[float, float], radius: float) -> None:
    cx, cy = center
    points = [(cx, cy - radius), (cx + radius * 0.35, cy - radius * 0.35), (cx + radius, cy), (cx + radius * 0.35, cy + radius * 0.35), (cx, cy + radius), (cx - radius * 0.35, cy + radius * 0.35), (cx - radius, cy), (cx - radius * 0.35, cy - radius * 0.35)]
    draw.polygon([scaled_point(point) for point in points], fill=WHITE)


def draw_ai_glyph(draw: ImageDraw.ImageDraw) -> None:
    draw_sparkle(draw, (103, 103), 15)
    draw_sparkle(draw, (91, 91), 5)
    draw_sparkle(draw, (116, 89), 4)


def save_icon(name: str, badge_color: tuple[int, int, int, int], glyph) -> None:
    icon = draw_base_mark().resize((CANVAS, CANVAS), Image.Resampling.NEAREST)
    draw = ImageDraw.Draw(icon)
    draw_badge_background(draw, badge_color)
    glyph(draw)
    output = icon.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    output.save(ROOT / "packages" / name / "resources" / "icon.png", "PNG", compress_level=9, optimize=False)


def main() -> None:
    shutil.copyfile(ROOT / "branding" / "logo.png", ROOT / "packages" / "core" / "resources" / "icon.png")
    save_icon("github", (0x24, 0x29, 0x2E, 0xFF), draw_github_glyph)
    save_icon("ado", (0x00, 0x78, 0xD4, 0xFF), draw_ado_glyph)
    save_icon("start-git-work", (0x6F, 0x42, 0xC1, 0xFF), draw_branch_glyph)
    save_icon("ai-reviewer", (0x7C, 0x3A, 0xED, 0xFF), draw_ai_glyph)


if __name__ == "__main__":
    main()
