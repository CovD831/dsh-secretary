# Thick Cutaway Walls, Asymmetric Topology & Diorama Lighting

## 1. Asymmetric Diorama Floorplan Rules
- **Footprint & Framing**: Target a compact world bounding box so `1×` overview fills **78%–84%** of a `1440×900` viewport (`margin ~120px` for HUD rails).
- **Break Symmetry**:
  - Left wing: deep open-plan engineering studio (`14×14` tiles) with 2×2 paired workstation islands, printer/cabinet nook, water cooler, whiteboard, and framed landscape art.
  - Center spine: stepped `4–5` tile warm plank corridor with navy-gold woven runner, secretary reception desk, potted plants, and wall sconces; front facade steps outward into a double-glass entrance vestibule with welcome mat.
  - Right upper wing: medium workshop / war-room (`11×10` tiles) with collaborative table cluster, large idea whiteboard, trophy bookshelf, and wide sunlit window.
  - Right lower wing: executive / secondary workspace (`11×11` tiles) with chamfered front-right corner wall, Persian rug, lounge armchair, bookshelf, and warm desk lamp.
  - Additional workspaces (`N > 3`): expand organically along L/T corridor branches (`H = E - V + 1 >= 1` when `N >= 4`), never degenerating into a long 1D strip.

## 2. 3D Thick Cutaway Wall Anatomy & Strict 3-Tier Height Law
- **Never Break Partition Walls at Doorways (`Anti-Pattern`)**: Interior partition walls must NEVER be split into islands at `door_wood` openings, and must NEVER be shorter than the doors (`52px`) or wall props mounted on them. Doors sit cleanly inside the lower portion of a continuous `68px` wall with uninterrupted plaster lintel and `#4A3428` walnut cap rail above.
- **Strict 3-Tier Architectural Height Hierarchy (`1x` base units)**:
  1. **Back Exterior Walls (`tier = 'back'`, `68px`)**: Full height on `NW`/`NE` back perimeter edges with `#4A3428` walnut cap rail (`5px`), two-tone directional plaster (`#D9C4A8` sunlit `SE`-facing vs `#BFA48C` shaded `SW`-facing), and dark walnut wainscoting (`#6B4A32` / `#4A3428`).
  2. **Interior Room-Dividing Walls (`tier = 'partition'`, `68px`)**: `68px` continuous full-height walls along interior room/corridor boundaries (merged collinearly across doorways; adjacent right-wing rooms share a single `68px` wall with `door-right-link` instead of a double-wall gap). Where a `partition` meets a front `cutaway` wall, its final 1 tile slopes smoothly `68px -> 34px`.
  3. **Front Cutaway Facade & Entrance Portal (`tier = 'cutaway'`, `34px`; `tier = 'portal'`, `54px`)**: `34px` front cutaway height (`facade_window` fits inside below the cap rail without occluding desks/actors behind it), stepping up to a `54px` timber portal around `door_glass` at `mainEntrance`.
- **Procedural Roguelike Room & Corridor Law**:
  - Compose worlds from **seeded (`mulberry32`) architectural prefab room shapes** (`l-alcove`, `stepped-zigzag`, `bay-window`, `chamfer-octagon`, `t-studio`, `courtyard-nook`) with clean straight segments (no `<3` tile jagged notches) + **modular furniture combo templates** and **4 seeded building skeletons** (`seed=1..4`).

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
