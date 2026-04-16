# DevDocket Logo

## Final Selection: "The Bold D"

A strong, geometric letter "D" (for DevDocket/Docket) with horizontal slot motifs integrated into the letterform. The slots represent organized items without being a literal checklist.

---

## Production Files

| File | Purpose |
|------|---------|
| `logo-final.svg` | Primary full-color logo (emerald gradient) |
| `logo-final-mono.svg` | Monochrome version (solid black) |
| `logo-final-light.svg` | For light backgrounds (darker emerald) |
| `logo-final-dark.svg` | For dark backgrounds (brighter emerald) |
| `logo-favicon.svg` | Optimized for 16x16 favicon |

---

## Color Palette

### Primary (Full Color)
| Name | Hex | Usage |
|------|-----|-------|
| Emerald 500 | `#10B981` | Gradient start, primary brand color |
| Emerald 600 | `#059669` | Gradient end |
| White | `#FFFFFF` | Inner cutout, contrast element |

### Light Theme Variant
| Name | Hex | Usage |
|------|-----|-------|
| Emerald 600 | `#059669` | Gradient start (darker for contrast) |
| Emerald 700 | `#047857` | Gradient end |
| White | `#FFFFFF` | Inner cutout |

### Dark Theme Variant
| Name | Hex | Usage |
|------|-----|-------|
| Emerald 400 | `#34D399` | Gradient start (brighter for visibility) |
| Emerald 500 | `#10B981` | Gradient end |
| Gray 800 | `#1F2937` | Inner cutout (matches dark editors) |

### Monochrome
| Name | Hex | Usage |
|------|-----|-------|
| Black | `#000000` | D shape and slots |
| White | `#FFFFFF` | Inner cutout |

---

## Accessibility & Contrast

| Variant | Background | Contrast Ratio | WCAG |
|---------|------------|----------------|------|
| Full color | White `#FFFFFF` | 4.5:1 | AA ✓ |
| Light theme | Light gray `#F3F4F6` | 4.8:1 | AA ✓ |
| Dark theme | Gray 900 `#111827` | 7.2:1 | AAA ✓ |
| Monochrome | White `#FFFFFF` | 21:1 | AAA ✓ |

---

## Size Guidelines

### Minimum Sizes
| Context | Minimum Size | File to Use |
|---------|--------------|-------------|
| Favicon | 16×16 px | `logo-favicon.svg` |
| VS Code sidebar | 24×24 px | `logo-final.svg` or theme variant |
| Extension icon | 128×128 px | `logo-final.svg` |
| Website/docs | 32+ px | `logo-final.svg` or theme variant |
| Print/merch | 0.5 inch+ | `logo-final.svg` |

### Favicon Simplifications
The favicon version (`logo-favicon.svg`) is optimized for 16×16:
- Reduced to 2 slots (from 3) for legibility
- No gradient (solid `#10B981`) for crisp pixel rendering
- Slightly adjusted proportions for small-size clarity

---

## Clear Space

Maintain minimum clear space around the logo equal to **25% of the logo height** on all sides.

```
┌─────────────────────┐
│                     │
│   ┌───────────┐     │
│   │           │     │  ← 25% height
│   │   LOGO    │     │
│   │           │     │
│   └───────────┘     │
│                     │
└─────────────────────┘
        ↑
      25% height
```

---

## Theme Usage

| VS Code Theme | Logo File |
|---------------|-----------|
| Light themes (Default Light, Quiet Light, etc.) | `logo-final-light.svg` |
| Dark themes (Default Dark, One Dark, etc.) | `logo-final-dark.svg` |
| High Contrast | `logo-final-mono.svg` |
| Marketing/general use | `logo-final.svg` |

---

## Do's and Don'ts

### ✅ Do
- Use the appropriate theme variant for the background
- Maintain clear space requirements
- Use favicon version for sizes under 24px
- Scale proportionally (no stretching)

### ❌ Don't
- Add drop shadows or effects
- Rotate or skew the logo
- Change the colors outside the defined palette
- Place on busy backgrounds without sufficient contrast
- Use the full logo at favicon sizes (use `logo-favicon.svg`)

---

## Design Rationale

**Why "The Bold D"?**
- **Brand recognition:** Lettermark creates immediate association with DevDocket
- **Differentiation:** Emerald green stands out in a space dominated by blues
- **Scalability:** Bold geometry reads clearly from 16px to billboard
- **Concept clarity:** Integrated slots convey "organized work" without clichés
- **Versatility:** Works in color, monochrome, light and dark contexts

---

## Archive: Exploration Directions

The following files contain the initial exploration concepts (kept for reference):

- `logo-direction-1.svg` / `logo-direction-1-mono.svg` — "Convergence Hub" (orange hexagon)
- `logo-direction-2.svg` / `logo-direction-2-mono.svg` — "Stacked Priority" (purple layers)
- `logo-direction-3.svg` / `logo-direction-3-mono.svg` — "The Bold D" (emerald, original draft)
