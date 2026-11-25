import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import {
  auditPaletteBuffer, colorIndex, PixelGrid, STATUS_COLOR_MAP,
  type PaletteAuditResult, type SecretaryMood, type StatusKind,
} from './palette.ts'
import {
  DIALOG_H, DIALOG_Y, DISPLAY_H, DISPLAY_W, generateRoomLayout,
  NATIVE_H, NATIVE_W, PORTRAIT_X, PORTRAIT_Y, type RoomPlan,
} from './layout.ts'
import {
  AI_MONITOR_ANCHORS, buildGateInterceptOverlay, buildMonitorScreen,
  buildSecretaryPortrait, GATE_TARGET_POS, loadAiRoomGrid,
} from './sprites.ts'

export interface DialogOptionSpec { label: string; consequence: string }
export interface DialogSpec {
  text: string
  options: readonly [DialogOptionSpec, DialogOptionSpec, DialogOptionSpec]
  postscript: string
  pendingCount: number
}

export interface RenderOptions {
  plan?: RoomPlan
  screenStates?: Partial<Record<string, StatusKind | 'off'>>
  mood?: SecretaryMood
  gateIntercept?: { targetActorId?: string; frame?: number }
  dialog?: DialogSpec
}

export interface NativeFrameResult {
  rgba: Uint8Array
  statusMask: Uint8Array
  width: number
  height: number
  plan: RoomPlan
  mood: SecretaryMood
  screenStates: Record<string, StatusKind | 'off'>
}

const DEFAULT_DIALOG: DialogSpec = {
  text: 'worker-1 在合并门前被路径闸拦截，改动越出了任务白名单。需要您拍板如何处理？',
  options: [
    { label: '退回重写范围', consequence: '保留任务，要求补齐测试后重提' },
    { label: '特批本次放行', consequence: '记入审计脊，允许本次合并' },
    { label: '暂停该工位', consequence: '挂起当前会话，转入人工复核' },
  ],
  postscript: '附言：已保留现场 diff 与 gate 判据日志，等待裁决…',
  pendingCount: 2,
}

const C = (hex: string): number => colorIndex(hex)

const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    tbl[n] = c >>> 0
  }
  return tbl
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]!) & 255]! ^ (c >>> 8)) >>> 0
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer)
  view.setUint32(0, data.length, false)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false)
  return out
}

export function encodePngRgba(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4)
    raw[rowStart] = 0
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), rowStart + 1)
  }
  const ihdr = new Uint8Array(13), iv = new DataView(ihdr.buffer)
  iv.setUint32(0, width, false); iv.setUint32(4, height, false)
  ihdr[8] = 8; ihdr[9] = 6
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const parts = [sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, { level: 6 })), pngChunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let off = 0
  for (const part of parts) { out.set(part, off); off += part.length }
  return out
}

export function upscaleNearest2x(srcRgba: Uint8Array, width: number, height: number): Uint8Array {
  const outW = width * 2, out = new Uint8Array(outW * height * 2 * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 4
      const r = srcRgba[si] ?? 0, g = srcRgba[si + 1] ?? 0, b = srcRgba[si + 2] ?? 0, a = srcRgba[si + 3] ?? 0
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const di = ((y * 2 + dy) * outW + (x * 2 + dx)) * 4
          out[di] = r; out[di + 1] = g; out[di + 2] = b; out[di + 3] = a
        }
      }
    }
  }
  return out
}

function drawDialogPixelFrame(g: PixelGrid, activeStatus: StatusKind, pendingCount: number): void {
  g.fillRect(0, DIALOG_Y, NATIVE_W, DIALOG_H, C('#201A18'))
  g.fillRect(0, DIALOG_Y, NATIVE_W, 1, C('#4A3C34'))
  g.fillRect(0, DIALOG_Y + DIALOG_H - 1, NATIVE_W, 1, C('#4A3C34'))
  g.fillRect(2, DIALOG_Y + 2, NATIVE_W - 4, 1, C('#C9A46A'))
  g.fillRect(2, DIALOG_Y + DIALOG_H - 3, NATIVE_W - 4, 1, C('#C9A46A'))
  g.fillRect(220, 320, 480, 44, C('#302722'))
  g.fillRect(226, 328, 320, 4, C('#E8DCCB'))
  g.fillRect(226, 344, 240, 4, C('#D8D0C0'))

  const dotColor = C(STATUS_COLOR_MAP[activeStatus].bright)
  for (let i = 0; i < 3; i++) {
    const ox = 220 + i * 160
    g.fillRect(ox, 372, 156, 36, C('#302722'))
    g.fillRect(ox, 372, 156, 1, C('#4A3C34'))
    g.fillRect(ox, 373, 156, 1, i === 0 ? C('#C9A46A') : C('#4A3C34'))
    g.fillRect(ox + 6, 380, 4, 4, i === 0 ? dotColor : C('#C9A46A'), i === 0)
    g.fillRect(ox + 14, 380, 88, 3, C('#E8DCCB'))
    g.fillRect(ox + 14, 392, 118, 2, C('#9C8069'))
  }
  g.fillRect(220, 418, 240, 18, C('#302722')); g.fillRect(226, 426, 160, 2, C('#9C8069'))
  g.fillRect(472, 418, 88, 18, C('#302722')); g.fillRect(478, 424, 6, 6, dotColor, true)
  g.fillRect(488, 426, Math.min(60, 16 + pendingCount * 8), 3, C('#C9A46A'))
  g.fillRect(570, 418, 130, 18, C('#302722')); g.fillRect(578, 425, 84, 3, C('#E8DCCB'))
}

export function renderNativeFrame(opts: RenderOptions = {}): NativeFrameResult {
  const plan = opts.plan ?? generateRoomLayout({ workspaceId: 'ws-main', workspaceOrder: 0, seed: 1 })
  const gate = opts.gateIntercept
  const mood: SecretaryMood = gate ? 'concerned' : (opts.mood ?? 'neutral')
  const screenStates: Record<string, StatusKind | 'off'> = {
    executive: 'working', 'ws-1': 'off', 'ws-2': gate ? 'needsDecision' : 'stuck', 'ws-3': 'done', ...opts.screenStates,
  }
  if (gate) screenStates['ws-2'] = 'needsDecision'

  const g = new PixelGrid(NATIVE_W, NATIVE_H)
  g.fillRect(0, 0, NATIVE_W, NATIVE_H, C('#201A18'))
  g.blit(loadAiRoomGrid(), 0, 0)

  for (const sc of AI_MONITOR_ANCHORS) {
    g.blit(buildMonitorScreen(screenStates[sc.suiteId] ?? 'off'), sc.x, sc.y)
  }

  if (gate) {
    const ov = buildGateInterceptOverlay(gate.frame ?? 0)
    g.blit(ov.scanline, GATE_TARGET_POS.scanX, GATE_TARGET_POS.scanY)
    g.blit(ov.box, GATE_TARGET_POS.boxX, GATE_TARGET_POS.boxY)
  }

  drawDialogPixelFrame(g, gate ? 'needsDecision' : 'working', (opts.dialog ?? DEFAULT_DIALOG).pendingCount)
  g.blit(buildSecretaryPortrait(mood), PORTRAIT_X, PORTRAIT_Y)
  return { rgba: g.toRgba(), statusMask: g.statusMask, width: NATIVE_W, height: NATIVE_H, plan, mood, screenStates }
}

export function renderStatusFilmStrip(): { rgba: Uint8Array; width: number; height: number } {
  const states: readonly StatusKind[] = ['working', 'stuck', 'needsDecision', 'done']
  const scale = 4, pad = 6, cellW = 20 * scale, cellH = 16 * scale
  const width = pad * 2 + states.length * cellW + (states.length - 1) * pad, height = pad * 2 + cellH
  const g = new PixelGrid(width, height)
  g.fillRect(0, 0, width, height, C('#201A18'))
  g.fillRect(1, 1, width - 2, 1, C('#C9A46A')); g.fillRect(1, height - 2, width - 2, 1, C('#C9A46A'))
  states.forEach((st, i) => {
    const scr = buildMonitorScreen(st), ox = pad + i * (cellW + pad)
    for (let y = 0; y < scr.height; y++) for (let x = 0; x < scr.width; x++) {
      const idx = scr.get(x, y)
      if (idx !== 0) g.fillRect(ox + x * scale, pad + y * scale, scale, scale, idx, true)
    }
  })
  return { rgba: g.toRgba(), width, height }
}

const toDataUri = (rgba: Uint8Array, w: number, h: number) =>
  `data:image/png;base64,${Buffer.from(encodePngRgba(rgba, w, h)).toString('base64')}`

export function renderF1ProofHtml(opts: RenderOptions = {}): string {
  const dlg = opts.dialog ?? DEFAULT_DIALOG
  const normal = renderNativeFrame({ ...opts, gateIntercept: undefined })
  const gate = renderNativeFrame({ ...opts, gateIntercept: { targetActorId: 'worker-1', frame: 1 } })
  const normal2x = upscaleNearest2x(normal.rgba, NATIVE_W, NATIVE_H)
  const gate2x = upscaleNearest2x(gate.rgba, NATIVE_W, NATIVE_H)
  const film = renderStatusFilmStrip()
  const moodImgs = (['neutral', 'working', 'happy', 'concerned'] as const).map((m) => {
    const p = buildSecretaryPortrait(m)
    return { mood: m, uri: toDataUri(p.toRgba(), p.width, p.height) }
  })

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>F1 Pixel Proof (1440×900)</title><style>
body{margin:0;background:#14100E;color:#E8DCCB;font-family:"PingFang SC","Noto Sans SC",sans-serif;padding:24px}
.stage{position:relative;width:${DISPLAY_W}px;height:${DISPLAY_H}px;border:2px solid #4A3C34;box-shadow:0 0 0 1px #C9A46A;overflow:hidden}
canvas{image-rendering:pixelated;display:block;width:${DISPLAY_W}px;height:${DISPLAY_H}px}
.dlg-text{position:absolute;left:440px;top:640px;width:960px;height:88px;font-size:28px;line-height:40px;color:#E8DCCB;background:#302722;padding:4px 12px;box-sizing:border-box}
.opts{position:absolute;left:440px;top:744px;display:flex;gap:8px}
.opt{width:312px;height:72px;background:#302722;border:2px solid #4A3C34;box-sizing:border-box;padding:8px 12px}
.opt b{display:block;font-size:20px;color:#E8DCCB}.opt span{font-size:14px;color:#C9A46A}
.bar{position:absolute;top:836px;height:36px;display:flex;align-items:center;font-size:15px;background:#302722;padding:0 10px;box-sizing:border-box}
.bar-post{left:440px;width:480px;color:#BFA48C}.bar-cnt{left:944px;width:176px;color:#C9A46A}.bar-hist{left:1140px;width:260px;color:#E8DCCB}
.tray{display:flex;gap:20px;align-items:center;margin-top:18px}img.px{image-rendering:pixelated;border:2px solid #4A3C34}
button{background:#302722;color:#E8DCCB;border:2px solid #C9A46A;padding:8px 16px;cursor:pointer;font-size:15px}
</style></head><body><div style="margin-bottom:12px;display:flex;gap:12px;align-items:center">
<button onclick="setMode('normal')">正常态（三态亮灯）</button><button onclick="setMode('gate')">Gate 拦截态（0.6s 扫描）</button>
<span id="statusLabel">当前：正常态</span></div><div class="stage"><canvas id="cv" width="${DISPLAY_W}" height="${DISPLAY_H}"></canvas>
<div class="dlg-text">${dlg.text}</div><div class="opts">${dlg.options.map((o) => `<div class="opt"><b>${o.label}</b><span>${o.consequence}</span></div>`).join('')}</div>
<div class="bar bar-post">${dlg.postscript}</div><div class="bar bar-cnt">剩余待办：${dlg.pendingCount} 项</div>
<div class="bar bar-hist">历史回看 · 最近裁决 3 条</div></div><div class="tray">
<div><div>四态屏幕灯带（工作/卡住/待裁/完成）</div><img class="px" src="${toDataUri(film.rgba, film.width, film.height)}"></div>
${moodImgs.map((m) => `<div><div>${m.mood}</div><img class="px" width="192" height="240" src="${m.uri}"></div>`).join('')}
</div><script>
const srcs={normal:"${toDataUri(normal2x, DISPLAY_W, DISPLAY_H)}",gate:"${toDataUri(gate2x, DISPLAY_W, DISPLAY_H)}"};
const cv=document.getElementById('cv'),ctx=cv.getContext('2d');ctx.imageSmoothingEnabled=false;
function setMode(m){const img=new Image();img.onload=()=>{ctx.imageSmoothingEnabled=false;ctx.drawImage(img,0,0)};
img.src=srcs[m];document.getElementById('statusLabel').textContent=m==='gate'?'当前：Gate 拦截态 (0.6s)':'当前：正常态'}
setMode('normal');
</script></body></html>`
}

export function writeF1ProofBundle(outDir: string): {
  proofPng: string; gatePng: string; htmlPath: string; auditNormal: PaletteAuditResult; auditGate: PaletteAuditResult
} {
  mkdirSync(outDir, { recursive: true })
  const normal = renderNativeFrame()
  const gate = renderNativeFrame({ gateIntercept: { targetActorId: 'worker-1', frame: 1 } })
  const proofPng = join(outDir, 'f1-office-proof-1440x900.png')
  const gatePng = join(outDir, 'f1-gate-intercept-1440x900.png')
  const htmlPath = join(outDir, 'f1-proof-preview.html')
  writeFileSync(proofPng, encodePngRgba(upscaleNearest2x(normal.rgba, NATIVE_W, NATIVE_H), DISPLAY_W, DISPLAY_H))
  writeFileSync(gatePng, encodePngRgba(upscaleNearest2x(gate.rgba, NATIVE_W, NATIVE_H), DISPLAY_W, DISPLAY_H))
  writeFileSync(htmlPath, renderF1ProofHtml())
  return {
    proofPng, gatePng, htmlPath,
    auditNormal: auditPaletteBuffer(normal.rgba, NATIVE_W, NATIVE_H, normal.statusMask),
    auditGate: auditPaletteBuffer(gate.rgba, NATIVE_W, NATIVE_H, gate.statusMask),
  }
}
