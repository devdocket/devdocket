# DevDocket Logo Options

Three strategic directions for the DevDocket logo redesign. Each is designed to work as a VS Code extension icon (128x128 → 16x16) and scale to larger applications.

---

## Direction 1: "Convergence Hub"

**Files:** `logo-direction-1.svg`, `logo-direction-1-mono.svg`

**Concept:** A hexagonal shape (evoking tech/developer aesthetic) with three lines converging into a central hub. Represents work items from multiple sources flowing into one organized center.

**Colors:**
- Primary gradient: `#FF6B35` → `#F7931E` (vibrant orange)
- Accent: `#FFFFFF` (white)

**Rationale:**
- Hexagon is distinctly "tech" without being cliché
- Convergence motif directly visualizes DevDocket's core value proposition
- Bold orange differentiates from the sea of blues in the developer tools space
- Simple geometry scales well to small sizes

**Trade-offs:**
- More abstract — may require explanation
- Orange is energetic but less "serious" than blue competitors

---

## Direction 2: "Stacked Priority"

**Files:** `logo-direction-2.svg`, `logo-direction-2-mono.svg`

**Concept:** Three stacked horizontal layers with depth, the topmost being the most prominent with subtle item indicators. Represents a prioritized queue/docket with clear focus on what's next.

**Colors:**
- Primary gradient: `#6366F1` → `#A855F7` (indigo to purple)
- Mid layer: `#8B5CF6`
- Accent: `#FFFFFF`

**Rationale:**
- Stacking metaphor is intuitive for "docket" or "queue"
- Purple/indigo is modern, stands out from blue competitors while remaining professional
- Depth creates visual interest even at small sizes
- The accent marks on the top layer hint at content without being a literal task list

**Trade-offs:**
- Horizontal orientation may feel less balanced as a square icon
- Could be mistaken for a generic "layers" icon

---

## Direction 3: "The Bold D"

**Files:** `logo-direction-3.svg`, `logo-direction-3-mono.svg`

**Concept:** A strong, geometric letter "D" (for DevDocket/Docket) with horizontal slot motifs integrated into the letterform. The slots represent organized items without being a literal checklist.

**Colors:**
- Primary gradient: `#10B981` → `#059669` (emerald green)
- Accent: `#FFFFFF`

**Rationale:**
- Lettermark creates immediate brand recognition ("D" for DevDocket)
- Green is distinctive in the space (not blue, not orange-like Linear)
- Integrated slots convey "organized list" without clipboard cliché
- Bold, chunky geometry is highly legible at all sizes
- Works exceptionally well in monochrome

**Trade-offs:**
- Lettermark may feel less "iconic" than abstract symbols
- Green could be associated with "success/go" rather than "productivity"

---

## Recommendation

**Direction 3 ("The Bold D")** offers the strongest combination of:
- Brand recognition (lettermark)
- Differentiation (green, not blue)
- Scalability (excellent at 16px and 128px)
- Concept clarity (slots = organized work)

However, **Direction 1** may resonate better if the "hub for multiple sources" message is most important, and **Direction 2** works well if the "prioritized queue" metaphor is preferred.

---

## Technical Notes

- All SVGs use `viewBox="0 0 128 128"` for consistent scaling
- Monochrome versions use pure black (`#000000`) with white accents
- All designs use rounded corners and simple paths for clean rendering at small sizes
- Gradients add dimension at large sizes but degrade gracefully to flat colors
