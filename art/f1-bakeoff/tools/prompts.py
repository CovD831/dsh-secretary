# DEPS: 无
# RESPONSIBILITY: 三来源共用的冻结提示词（规格第 5 节模板）
# MODULE: f1-bakeoff.tools
# ---
PREFIX = (
    "isometric 2:1 pixel art, cozy cutaway office, warm walnut and cream palette, "
    "native-resolution pixel clusters, 1px dark outline at final 1x, low-saturation environment, "
    "no anti-aliasing, no gradients, no text, transparent background, single asset centered, "
    "4x render with 4px square blocks; palette limited to the attached 46 swatches."
)

ASSETS = {
    "tile": {
        "native": (32, 16),
        "prompt": PREFIX + " seamless 2:1 isometric wood plank floor tile, 32x16 native, "
        "warm walnut boards with subtle grain and two-tone ordered dithering, "
        "1px #1A1412 edge outline, transparent background, flat lighting.",
    },
    "worker": {
        "native": (24, 32),
        "prompt": PREFIX + " a seated office worker at a compact walnut workstation, "
        "isometric 2:1 view, 24x32 native sprite, navy shirt #3F5A78, dark hair #2A2220, "
        "typing on keyboard facing a monitor, 1px dark outline, transparent background.",
    },
    "portrait": {
        "native": (192, 240),
        "prompt": PREFIX + " bust portrait of a warm attentive secretary, neutral expression, "
        "3/4 view, navy blouse #3F5A78 and cream collar #D8D0C0, 192x240 native, "
        "1px outline, transparent background.",
    },
}
