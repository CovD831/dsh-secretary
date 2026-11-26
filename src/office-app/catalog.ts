export type AssetLayer = 'floor' | 'wall' | 'entity'
export type PropKind = 'doorplate' | 'ledger' | 'notebook' | 'corkboard' | 'cabinet'
export type StatusKind = 'working' | 'stuck' | 'needsDecision' | 'done'

export interface OfficeAssetMeta {
  id: string
  name: { zh: string; en: string }
  spriteUrl: string
  layer: AssetLayer
  nativeSize: readonly [number, number]
  footprint: readonly [number, number]
  anchor: readonly [number, number]
  backgroundRows?: number
  surface?: boolean
  mirror?: boolean
  screenGlowAnchors?: readonly { dx: number; dy: number }[]
  propKind?: PropKind
}

export const HIGHLIGHT_GOLD = '#C9A46A'

export const STATUS_GLOW_COLORS: Record<StatusKind, { bright: string; dark: string }> = {
  working: { bright: '#2FA8E0', dark: '#17688F' },
  stuck: { bright: '#F2A93B', dark: '#A86A17' },
  needsDecision: { bright: '#E8544E', dark: '#9E2F2C' },
  done: { bright: '#3FCB6B', dark: '#247A42' },
}

export const PROP_LABELS: Record<PropKind, { zh: string; en: string }> = {
  doorplate: { zh: '工作区门牌簿', en: 'Workspace Doorplate' },
  ledger: { zh: '门禁规章册', en: 'Access Rulebook' },
  notebook: { zh: '皮质备忘手账', en: 'Leather Memo Notebook' },
  corkboard: { zh: '体检与校准图', en: 'Health & Calibration Board' },
  cabinet: { zh: '机要文件柜', en: 'Classified File Cabinet' },
}

export const OFFICE_CATALOG: Record<string, OfficeAssetMeta> = {
  floor_wood: {
    id: 'floor_wood',
    name: { zh: '胡桃木地板', en: 'Walnut Floor Tile' },
    spriteUrl: '/assets/office/floor_wood.png',
    layer: 'floor',
    nativeSize: [32, 16],
    footprint: [1, 1],
    anchor: [16, 8],
  },
  rug_woven: {
    id: 'rug_woven',
    name: { zh: '编织地毯', en: 'Woven Rug' },
    spriteUrl: '/assets/office/rug_woven.png',
    layer: 'floor',
    nativeSize: [64, 32],
    footprint: [2, 2],
    anchor: [32, 16],
    backgroundRows: 2,
  },
  wall_segment: {
    id: 'wall_segment',
    name: { zh: '剖面墙段', en: 'Cutaway Wall' },
    spriteUrl: '/assets/office/wall_segment.png',
    layer: 'wall',
    nativeSize: [80, 56],
    footprint: [2, 0],
    anchor: [40, 52],
  },
  door_glass: {
    id: 'door_glass',
    name: { zh: '双开玻璃门', en: 'Double Glass Door' },
    spriteUrl: '/assets/office/door_glass.png',
    layer: 'wall',
    nativeSize: [80, 56],
    footprint: [2, 0],
    anchor: [40, 52],
  },
  doorplate: {
    id: 'doorplate',
    name: PROP_LABELS.doorplate,
    spriteUrl: '/assets/office/doorplate.png',
    layer: 'wall',
    nativeSize: [24, 16],
    footprint: [1, 0],
    anchor: [12, 12],
    propKind: 'doorplate',
  },
  window_day: {
    id: 'window_day',
    name: { zh: '采光木窗', en: 'Daylight Window' },
    spriteUrl: '/assets/office/window_day.png',
    layer: 'wall',
    nativeSize: [64, 48],
    footprint: [2, 0],
    anchor: [32, 44],
  },
  clock_wall: {
    id: 'clock_wall',
    name: { zh: '圆形挂钟', en: 'Wall Clock' },
    spriteUrl: '/assets/office/clock_wall.png',
    layer: 'wall',
    nativeSize: [24, 24],
    footprint: [1, 0],
    anchor: [12, 12],
  },
  corkboard: {
    id: 'corkboard',
    name: PROP_LABELS.corkboard,
    spriteUrl: '/assets/office/corkboard.png',
    layer: 'wall',
    nativeSize: [80, 56],
    footprint: [2, 0],
    anchor: [40, 52],
    propKind: 'corkboard',
  },
  reception_desk: {
    id: 'reception_desk',
    name: { zh: '前台接待桌', en: 'Reception Desk' },
    spriteUrl: '/assets/office/reception_desk.png',
    layer: 'entity',
    nativeSize: [80, 56],
    footprint: [3, 2],
    anchor: [40, 50],
    surface: true,
    mirror: true,
    propKind: 'ledger',
  },
  exec_desk: {
    id: 'exec_desk',
    name: { zh: '队长双屏桌', en: 'Lead Dual-Monitor Desk' },
    spriteUrl: '/assets/office/exec_desk.png',
    layer: 'entity',
    nativeSize: [96, 64],
    footprint: [4, 2],
    anchor: [48, 56],
    surface: true,
    mirror: true,
    screenGlowAnchors: [{ dx: -10, dy: -26 }, { dx: 8, dy: -24 }],
  },
  worker_desk: {
    id: 'worker_desk',
    name: { zh: '工蜂单屏工位', en: 'Worker Workstation' },
    spriteUrl: '/assets/office/worker_desk.png',
    layer: 'entity',
    nativeSize: [64, 48],
    footprint: [2, 2],
    anchor: [32, 42],
    surface: true,
    mirror: true,
    screenGlowAnchors: [{ dx: 0, dy: -19 }],
  },
  bookshelf: {
    id: 'bookshelf',
    name: { zh: '木质书架', en: 'Bookshelf' },
    spriteUrl: '/assets/office/bookshelf.png',
    layer: 'entity',
    nativeSize: [64, 56],
    footprint: [2, 1],
    anchor: [32, 50],
    mirror: true,
  },
  file_cabinet: {
    id: 'file_cabinet',
    name: PROP_LABELS.cabinet,
    spriteUrl: '/assets/office/file_cabinet.png',
    layer: 'entity',
    nativeSize: [64, 56],
    footprint: [2, 1],
    anchor: [32, 50],
    mirror: true,
    propKind: 'cabinet',
  },
  water_cooler: {
    id: 'water_cooler',
    name: { zh: '饮水机', en: 'Water Cooler' },
    spriteUrl: '/assets/office/water_cooler.png',
    layer: 'entity',
    nativeSize: [32, 48],
    footprint: [1, 1],
    anchor: [16, 44],
  },
  plant_pot: {
    id: 'plant_pot',
    name: { zh: '绿植盆栽', en: 'Potted Plant' },
    spriteUrl: '/assets/office/plant_pot.png',
    layer: 'entity',
    nativeSize: [32, 48],
    footprint: [1, 1],
    anchor: [16, 44],
  },
  char_secretary: {
    id: 'char_secretary',
    name: { zh: '秘书', en: 'Secretary' },
    spriteUrl: '/assets/office/char_secretary.png',
    layer: 'entity',
    nativeSize: [32, 48],
    footprint: [1, 1],
    anchor: [16, 44],
    mirror: true,
  },
  char_lead: {
    id: 'char_lead',
    name: { zh: '队长', en: 'Lead' },
    spriteUrl: '/assets/office/char_lead.png',
    layer: 'entity',
    nativeSize: [32, 48],
    footprint: [1, 1],
    anchor: [16, 44],
    mirror: true,
  },
  char_worker: {
    id: 'char_worker',
    name: { zh: '工蜂', en: 'Worker' },
    spriteUrl: '/assets/office/char_worker.png',
    layer: 'entity',
    nativeSize: [32, 48],
    footprint: [1, 1],
    anchor: [16, 44],
    mirror: true,
  },
}
