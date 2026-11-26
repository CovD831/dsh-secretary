---
name: pixel-diorama-frontend
description: >-
  Architectural and aesthetic standard for building commercial-grade 2:1 isometric
  pixel management game frontends (Cozy Diorama + PixiJS v8 7-layer lighting/AO
  pipeline + 9-slice bitmap game HUD). Activate whenever designing, generating
  assets for, implementing, or reviewing the Pixel Office frontend, game HUD,
  isometric rooms, furniture suites, or sprite pipelines.
---

# Pixel Diorama Game Frontend Skill

Use this skill to build and audit **commercial-grade cozy 2:1 isometric pixel management game interfaces**—preventing "programmer CSS wireframe + flat repetitive tilemap" anti-patterns.

## 1. Five Non-Negotiable Laws (Why It Looks Like a Real Game)

1. **Diorama Composition Over Infinite Flat Wallpaper**
   - Frame the multi-room building as a **compact cutaway architectural diorama occupying ~78%–84% of the viewport** at default overview.
   - Surround the perimeter with a tight 1–2 tile stone curb, entry mat, and clustered topiary shrubs, then fade smoothly into a **dark stage vignette backdrop** so warm-lit interiors pop like a tabletop miniature. Never fill 60% of the screen with repetitive single-tile grass wallpaper.
2. **Asymmetric Interlocking Rooms & Thick Cutaway Walls**
   - **Ban symmetric double-loaded barracks** (never place two identical columns of equal-sized rectangular boxes across a straight uniform hallway). Offset room depths, stagger doorway phases by ±1–2 tiles, and include chamfered/stepped front facade walls with inset windows.
   - Every wall must show **3D architectural thickness**: a dark walnut top-cut cap (`6–8px`), distinct lit (`SE`) vs shaded (`SW`) plaster faces, recessed solid wood doorframes with actual doors, and a low cutaway front lip so rooms feel enclosed yet readable.
3. **Two Dedicated Lighting Passes (Multiply AO + Warm Point Glows)**
   - Flat unshaded sprites look pasted-on. Every scene MUST include:
     - **Pass A — Contact AO & Drop Shadows (`multiply`)**: continuous dark ambient-occlusion strips along all wall-floor seams plus grounded isometric contact shadows beneath every desk, chair, cabinet, plant, and character (`shadowCount === propCount + actorCount`).
     - **Pass B — Warm Interior Lighting (`screen` / soft radial alpha)**: warm amber pools cast by corridor wall sconces, brass desk lamps, sunlit windows, and 4-state monitor glows.
4. **Suite Clusters & Room-Identity Floor Zoning**
   - Never scatter lone single desks across bare floors. Place **cohesive multi-prop suites** (2–4 desk clusters with dual monitors, keyboards, mugs, desk lamps, paper stacks, printers, water coolers, wall whiteboards with sticky notes, framed art, bookshelves).
   - Give each room a **distinct floor/rug identity** (e.g., sage woven rug in main dev studio, indigo rug in workshop/discussion room, terracotta Persian rug in study/exec room, narrow planks + navy-gold runner in central lobby).
5. **9-Slice Bitmap Game HUD & Icon-First Controls (Zero Web Admin Borders)**
   - **Ban raw CSS `border: 2px solid` admin boxes and plain text button strips.**
   - Every HUD bar, roster slot, minimap frame, and action dock must use **9-slice pixel art frames** (`border-image` or `NineSliceSprite`) with rounded carved wood corners, brass corner rivets, top-edge highlight bevels, and recessed inner troughs.
   - Left rail = **framed character mugshot cards** with status pips; bottom-left = **riveted compass minimap (`N` badge + miniature room/desk silhouettes)**; top & bottom-right = **tactile pixel icon buttons** (only surface concise text in tooltips, drawers, or the bottom narrative secretary bar).

## 2. Standard 7-Layer PixiJS v8 + React HUD Architecture

Keep world rendering inside a `PixiJS v8` canvas (`roundPixels: true`, `TextureSource.defaultOptions.scaleMode = 'nearest'`, integer camera zoom) and screen-space UI in a detached React 9-slice overlay:

- **`L0` Stage Vignette**: dark warm-slate backdrop + subtle radial vignette.
- **`L1` Baseplate & Zoned Floors**: stone apron, room-specific wood/tile floors, room-distinct rugs, lobby runner, threshold mats.
- **`L2` Multiply AO & Shadows**: wall-base AO ribbons + per-entity/actor grounded contact shadows.
- **`L3` Structural Cutaway Shell**: back/left full cutaway walls, interior thick partition walls with top caps & doorframes, front chamfered low facade walls with windows & double glass entry doors.
- **`L4` Y-Sorted Entity Domain (`sortableChildren = true`, `zIndex = Math.round(footY)`)**: multi-tile desk clusters, wall props, exterior shrubs, seated typing / breathing / walking characters.
- **`L5` Warm Light & Status Glows**: wall sconce cones, desk lamp pools, window sunbeams, and high-saturation 4-state monitor glows (`working`, `stuck`, `needsDecision`, `done`).
- **`L6` Detached React 9-Slice HUD**: top status/time/camera bar, left mugshot roster, bottom-left compass minimap, bottom-right 5-icon governance dock, and smart-collapsible `384×480` secretary portrait dialog.

Read detailed specs when implementing:
- Walls, chamfered facade, AO & lighting math: [diorama-lighting-and-walls.md](./references/diorama-lighting-and-walls.md)
- 9-slice HUD anatomy & hybrid MeowArt + `image-generator` asset pipeline: [nine-slice-hud-and-assets.md](./references/nine-slice-hud-and-assets.md)

## 3. Mandatory Verification Gate (Quantitative + Visual)

Before claiming any pixel frontend phase complete:
1. Run the self-contained density & composition audit on the live `1440×900` screenshot:
   ```bash
   python3 .agents/skills/pixel-diorama-frontend/scripts/measure_diorama_density.py --require-grade=C <screenshot.png>
   ```
   - Target **Grade C (Reference Commercial Game)**: dioramas ROI `edge_density >= 0.46`, `block_median >= 0.42`, `small_step >= 0.28`.
2. Inspect the live screenshot directly via `read_file` against `~/.claude/skills/critique/SKILL.md` anti-slop rules: zero white/gray fringes (`semiTransparentCount === 0`), zero clipped nameplates, zero generic web borders, and 3-second glanceability across all rooms.
