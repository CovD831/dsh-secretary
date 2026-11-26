# Thick Cutaway Walls, Asymmetric Topology & Diorama Lighting

## 1. Asymmetric Diorama Floorplan Rules
- **Footprint & Framing**: Target a compact world bounding box so `1×` overview fills **78%–84%** of a `1440×900` viewport (`margin ~120px` for HUD rails).
- **Break Symmetry**:
  - Left wing: deep open-plan engineering studio (`14×14` tiles) with 2×2 paired workstation islands, printer/cabinet nook, water cooler, whiteboard, and framed landscape art.
  - Center spine: stepped `4–5` tile warm plank corridor with navy-gold woven runner, secretary reception desk, potted plants, and wall sconces; front facade steps outward into a double-glass entrance vestibule with welcome mat.
  - Right upper wing: medium workshop / war-room (`11×10` tiles) with collaborative table cluster, large idea whiteboard, trophy bookshelf, and wide sunlit window.
  - Right lower wing: executive / secondary workspace (`11×11` tiles) with chamfered front-right corner wall, Persian rug, lounge armchair, bookshelf, and warm desk lamp.
  - Additional workspaces (`N > 3`): expand organically along L/T corridor branches (`H = E - V + 1 >= 1` when `N >= 4`), never degenerating into a long 1D strip.

## 2. 3D Thick Cutaway Wall Anatomy
- **Top Cut Plane (`6–8px` display)**: dark walnut `#3A2E28` / `#4A3428` with `1px` `#1A1412` outer outline and `1px` `#7A6150` inner bevel so every sliced wall reads as solid timber-framed architecture, never paper-thin cardboard.
- **Directional Plaster Shading**:
  - `SE`-facing interior wall (`back` wall along `u`): warm cream `#D9C4A8` / `#BFA48C` over walnut wainscot `#6B4A32`.
  - `SW`-facing interior wall (`left` wall along `v`): 1-step cooler/darker `#BFA48C` / `#9C8069` over `#4A3428` to establish directional light from upper-left/window side.
- **Front Cutaway Facade**: `28–36px` tall exterior brick/wood wainscot along the front perimeter (including `45°` chamfered corner segments and low sill windows) so the building has a grounded architectural front rather than raw floor tiles hanging in void.
- **Doors**: Every room doorway renders a recessed walnut doorframe + open/closed paneled wood door leaf + brass knob, never an empty gap in a wall line.

## 3. Dual Lighting & Shadow Specification
1. **Wall-Base AO (`L2`, `blendMode = 'multiply'`, alpha `0.28–0.38`)**:
   - Paint a `10–14px` soft stepped pixel shadow band along interior wall bases and room corners.
2. **Entity Contact Shadows (`L2`, `blendMode = 'multiply'`, alpha `0.32`)**:
   - Every furniture sprite and character renders a crisp quantized isometric oval/diamond shadow offset `(+2px, +2px)` toward `SE` beneath its footprint before `L4` draws the sprite.
3. **Warm Interior Light Pools (`L5`, `blendMode = 'add'` or warm alpha `0.18–0.28`)**:
   - **Wall Sconces**: warm `#F2A93B` / `#E8DCCB` 3-step dithered pixel halo on wall + `2×2` tile warm floor pool.
   - **Desk Lamps**: focused warm circle on desktop + adjacent floor.
   - **Sunlit Windows**: diagonal warm sunbeam parallelogram across `2×3` floor tiles with subtle dust-mote pixel sparkle.
   - **4-State Monitor Glows**: strictly reserve high-chroma status hues (`#2FA8E0` working, `#F2A93B` stuck, `#E8544E` needsDecision, `#3FCB6B` done) for monitor screens, status pips, and gate intercept badges.
