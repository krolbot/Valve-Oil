// The RGB light's effects, run by QIDI's neopixel module on the main board (NEOPIXEL_MODE) through Valve Oil's
// VO_LIGHT_EFFECT macro (installer/klipper/macros/lights.cfg). The macro's variables are the light's state: QIDI's
// module doesn't report the effect it's running.

export const LIGHT_MACRO = 'gcode_macro VO_LIGHT_EFFECT'

export type Effect = 'status' | 'solid' | 'breathe' | 'flow' | 'rainbow' | 'comet' | 'spread' | 'flash'
export type Speed = 'slow' | 'normal' | 'fast'
export type LightState = { effect: Effect | 'off'; red: number; green: number; blue: number; brightness: number; speed: Speed; direction: number }

/** Each effect's period at normal speed (ms, as in the macro), and whether it takes a color and a direction. */
export const EFFECTS: { id: Effect; period: number; color: boolean; direction: boolean }[] = [
  { id: 'solid', period: 0, color: true, direction: false },
  { id: 'breathe', period: 5000, color: true, direction: false },
  { id: 'flow', period: 3000, color: true, direction: true },
  { id: 'rainbow', period: 6000, color: false, direction: true },
  { id: 'comet', period: 1500, color: true, direction: true },
  { id: 'spread', period: 3000, color: true, direction: true },
  { id: 'flash', period: 1000, color: true, direction: false },
  { id: 'status', period: 0, color: false, direction: false },
]
export const effectDef = (id: string) => EFFECTS.find((e) => e.id === id)
export const SPEEDS: Speed[] = ['slow', 'normal', 'fast']
const SPEED_FACTOR: Record<Speed, number> = { slow: 2, normal: 1, fast: 0.5 }

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** The light's state from the macro's status; before it arrives, QIDI's status light, which Klipper starts with. */
export function lightState(status: Record<string, unknown> | undefined): LightState {
  const s = status ?? {}
  const effect = s.effect === 'off' || effectDef(String(s.effect)) ? (s.effect as LightState['effect']) : 'status'
  const speed = SPEEDS.includes(s.speed as Speed) ? (s.speed as Speed) : 'normal'
  return { effect, red: num(s.red, 255), green: num(s.green, 255), blue: num(s.blue, 255), brightness: num(s.brightness, 100), speed, direction: num(s.direction, 1) ? 1 : 0 }
}

/** VO_LIGHT_EFFECT with what changes; the macro keeps the rest. `on` brings back the last effect. */
export function lightEffectGcode(change: Partial<Omit<LightState, 'effect'>> & { effect?: LightState['effect'] | 'on' }) {
  const parts = ['VO_LIGHT_EFFECT']
  if (change.effect) parts.push(`EFFECT=${change.effect}`)
  for (const [key, param] of [['red', 'RED'], ['green', 'GREEN'], ['blue', 'BLUE'], ['brightness', 'BRIGHTNESS'], ['direction', 'DIRECTION']] as const) {
    const v = change[key]
    if (v != null) parts.push(`${param}=${Math.round(v)}`)
  }
  if (change.speed) parts.push(`SPEED=${change.speed}`)
  return parts.join(' ')
}

/** A color picked as hex, at full brightness: brightness is its own setting. */
export function hueOf(hex: string): [number, number, number] {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0)
  const max = Math.max(...c) || 1
  return [0, 1, 2].map((i) => Math.round((c[i] / max) * 255)) as [number, number, number]
}
export const rgbHex = (c: readonly number[]) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

export const effectPeriod = (effect: string, speed: Speed) => (effectDef(effect)?.period ?? 0) * SPEED_FACTOR[speed]

// ---- the preview: an approximation of each effect on n LEDs at time t (ms) ----
function hsl(h: number): number[] {
  h = ((h % 360) + 360) % 360
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    return 255 * (0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1)))
  }
  return [f(0), f(8), f(4)]
}

// QIDI's status light: an ice-blue breath when idle, white filling with progress while printing.
const STATUS_COLOR = [140, 225, 255]

/** One LED's color, or null when it's dark. `progress` is the print's, while printing. */
export function previewColor(effect: string, i: number, n: number, t: number, rgb: readonly number[], brightness: number, period: number, direction: number, progress: number | null): number[] | null {
  const b = brightness / 100
  const col = (k: number) => rgb.map((v) => v * k * b)
  const ph = period ? (t % period) / period : 0
  const dim = 0.03
  switch (effect) {
    case 'solid':
      return col(1)
    case 'breathe':
      return col(0.06 + 0.94 * (0.5 - 0.5 * Math.cos(2 * Math.PI * ph)))
    case 'flow': {
      const x = i / n + (direction ? -ph : ph)
      return col(0.12 + 0.88 * Math.pow((Math.sin(2 * Math.PI * x) + 1) / 2, 2))
    }
    case 'rainbow':
      return hsl((i / n) * 360 + (direction ? -1 : 1) * ph * 360).map((v) => v * b)
    case 'comet': {
      const tail = Math.max(3, n * 0.35)
      const d = ph * (n + tail) - 1 - (direction ? i : n - 1 - i)
      return d < 0 || d > tail ? col(dim) : col(Math.pow(1 - d / tail, 1.6))
    }
    case 'spread': {
      const c = (n - 1) / 2
      const reach = (direction ? ph : 1 - ph) * (c + 1.5)
      const d = Math.abs(i - c)
      return d <= reach ? col(0.35 + 0.65 * (1 - (reach - d) / (c + 1.5))) : col(dim)
    }
    case 'flash':
      return ph < 0.5 ? col(1) : col(dim)
    case 'status': {
      if (progress != null) return i < Math.max(1, Math.round(progress * n)) ? [255, 255, 255] : null
      const p = (t % 5000) / 5000
      return STATUS_COLOR.map((v) => v * (0.06 + 0.94 * (0.5 - 0.5 * Math.cos(2 * Math.PI * p))))
    }
    default:
      return null
  }
}
