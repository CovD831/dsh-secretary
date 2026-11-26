# 9-Slice Game HUD & Hybrid Asset Production Pipeline

## 1. 9-Slice HUD Anatomy (Screen-Space React Overlay)
All HUD containers use pixel-art 9-slice textures (`image-rendering: pixelated`, `border-image-slice: 12 fill` at `2×` integer pixel scale):

1. **Top Status & Time Bar (Left + Right Anchored, Open Center)**
   - **Top-Left Pod**: carved walnut & brass-riveted pill housing live SSE sun/pulse emblem + progress pips + active workspace badge (`< 28%` width).
   - **Top-Right Pod**: ticket/ruling counters + camera zoom toggle (`1× / 2×`) + settings/cabinet gear button.
   - Leave the top-center open above the building apex so the diorama roof peak breathes, matching classic management games.
2. **Left Character Mugshot Rail**
   - Vertical wood-framed track holding `48×48` pixel bust slots (Secretary + Room Leads / Active Workers) with `10px` status gem in bottom-right corner of each frame. Clicking focuses camera or opens worker transcript drawer.
3. **Bottom-Left Riveted Compass Minimap (Patrol Mode)**
   - `220×148` brass-riveted wood frame with `N` compass rose in top-left, 4-point star emblem in bottom-right, and color-coded room blocks (`sage`, `indigo`, `terracotta`, `courtyard`) showing miniature desk silhouettes and live actor pips.
   - Automatically yields to the **`384×480` Secretary Bust Portrait + Narrative Dialog Frame** when chatting, thinking, or resolving rulings/gate blocks.
4. **Bottom-Right 5-Icon Governance Dock**
   - Carved walnut dock holding 5 `36×36` tactile pixel icons (`门牌簿` sign, `规章册` ledger, `备忘手账` quill-book, `体检板` chart, `扩建/机要` star-crate) with hover bevel lift and pixel tooltip.

## 2. Asset Production Pipeline (`image-generator` + `game-assets` MeowArt)

### Budget & Security Guardrails
- **NEVER read `.env` or print `MEOWART_API_KEY` in commands, logs, or commits.** `~/.agents/skills/game-assets/meowart_api.py` loads credentials internally.
- Always pass `--api-base https://api.meowa.ai` and explicit `--work-dir /tmp/meow-work --output-dir <scratch>` when invoking `meowart_api.py` (default `api.meowart.ai` returns HTTP 308 and drops `Authorization`).
- **Check `credits-balance` before any MeowArt generation**: when credits are low (`<= 20`), produce multi-item spritesheets & 9-slice UI skins via built-in `image-generator` first, reserving MeowArt `pixel-gen-run` / `remove-background-run --method pixel` strictly for targeted hero sprites if needed.

### Deterministic Crisp-Pixel Sheet Recipe (from `game-assets` Skill)
1. **Batch on Standard Canvas (`1024×1024` `1:1` or `1376×768` `16:9`)**:
   - Generate related items together on one sheet (e.g., all 9-slice HUD frames + 8 HUD icons on one `1024×1024` white-background sheet; paired desk clusters + wall whiteboards + sconces + rugs on another) so lighting, stroke weight, and walnut-cream-brass materiality stay 100% unified.
2. **Hard-Alpha Defringe & Palette Quantization**:
   - Downsample by exact integer ratio (`NEAREST` / `BOX` block-majority) to native `1×` dimensions.
   - Enforce `alpha ∈ {0, 255}` (`semiTransparentCount === 0`), inward `1px` `#1A1412` / `#2C211B` outline verification (zero `#FFFFFF` / `#E8DCCB` JPEG halo fringes), and connected-component speck removal before writing `assets/office/` or `assets/office-ui/`.
