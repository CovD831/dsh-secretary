# Thick Cutaway Walls, Asymmetric Topology & Diorama Lighting

## 1. Asymmetric Diorama Floorplan Rules
- **Footprint & Framing**: Target a compact world bounding box so `1×` overview fills **78%–84%** of a `1440×900` viewport (`margin ~120px` for HUD rails).
- **Break Symmetry**:
  - Left wing: deep open-plan engineering studio (`14×14` tiles) with 2×2 paired workstation islands, printer/cabinet nook, water cooler, whiteboard, and framed landscape art.
  - Center spine: stepped `4–5` tile warm plank corridor with navy-gold woven runner, secretary reception desk, potted plants, and wall sconces; front facade steps outward into a double-glass entrance vestibule with welcome mat.
  - Right upper wing: medium workshop / war-room (`11×10` tiles) with collaborative table cluster, large idea whiteboard, trophy bookshelf, and wide sunlit window.
  - Right lower wing: executive / secondary workspace (`11×11` tiles) with chamfered front-right corner wall, Persian rug, lounge armchair, bookshelf, and warm desk lamp.
  - Additional workspaces (`N > 3`): expand organically along L/T corridor branches (`H = E - V + 1 >= 1` when `N >= 4`), never degenerating into a long 1D strip.

## 2. 3D Thick Cutaway Wall Anatomy & Unified Solid Height Law
- **100% Solid Walls & Never Break at Doorways (`Anti-Pattern`)**: Never use semi-transparent ghost walls, and never split partition walls into islands at `door_wood` openings. Doors (`50px`) sit cleanly inside the continuous `56px` solid wall with uninterrupted plaster lintel and `#4A3428` walnut cap rail above.
- **Two-Tier Architectural Cutaway (`56px` / `34px`, Vertex-Height Continuous)**:
  1. **Single-Valued Vertex Height Field `H(u, v)` + Corner Miter Caps**: Back walls (`tier = 'back'`) and partitions (`tier = 'partition'`) share `56px` (`UNIFIED_WALL_H`), exterior camera-facing front walls (`cutaway` | `portal`) step down to `34px` (`CUTAWAY_WALL_H`) via clean 1-tile architectural shoulders (`56→34`) so `100%` of wall vertices share one unique height and every 90° joint locks cleanly with a `t×t` isometric miter cap — zero floating walls or V-notches.
  2. **Clean Architectural Rooms (`28×20`) & Paired Dual-Side Desk Chairs**: Rooms stay clean, readable architectural rectangles (optional gentle SE chamfers on `bottomRight`), `desk_cluster` renders both its visible NE monitor chair and a SW knee-well back-view chair, and every desk obeys `isDeskWallClear` (`>=1` tile from side walls, `>=2` tiles pull-back clearance on seating sides).
  3. **Curated Seeds (`#1`–`#6`) & Universal Interior Layout Laws**:
     - Cycle cleanly across the `6` curated building seeds (`#1`→`#6`→`#1`).
     - Enforce **door `2×3` inward sightline clearance** (`buildDoorEntryZones`), **anti-door-facing seating** (`isSeatFacingDoor`), **armrest-side lamp pairing** (`armrestCellsFor`), `<= 35%` furniture occupancy, `1`-tile halo clearance, aligned desk matrices, wall-mount exclusion for tall props, and focal-anchored non-chamfer area rugs.

## 3. Dual Lighting & Shadow Specification
1. **Wall-Base AO (`L2`, `blendMode = 'multiply'`, alpha `0.24`)**:
   - Paint true `2:1` isometric wall-floor shadow ribbons (`0.36` tiles deep) along all back and left interior partition bases.
2. **Entity Contact Shadows (`L2`, `blendMode = 'multiply'`, alpha `0.36`)**:
   - Project crisp `2:1` isometric footprint quads inset slightly under every entity and swivel chair (plus a soft directional drop shadow offset toward `SE`) before `L4` draws sprites so furniture sits firmly grounded on floorboards.
3. **Warm Interior Light Pools (`L5`, `blendMode = 'add'` or warm alpha `0.18–0.28`)**:
   - **Wall Sconces**: warm `#F2A93B` / `#E8DCCB` 3-step dithered pixel halo on wall + `2×2` tile warm floor pool.
   - **Desk Lamps**: focused warm circle on desktop + adjacent floor.
   - **Sunlit Windows**: diagonal warm sunbeam parallelogram across `2×3` floor tiles with subtle dust-mote pixel sparkle.
   - **4-State Monitor Glows**: strictly reserve high-chroma status hues (`#2FA8E0` working, `#F2A93B` stuck, `#E8544E` needsDecision, `#3FCB6B` done) for monitor screens, status pips, and gate intercept badges.
