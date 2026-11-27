// What a heater's temperature is doing, for the Temperatures card's Trend column, and how its sensors group by Box.

/**
 * `holding`: within 1.5° of its target. `eta`: moving toward its target, about `seconds` away at the last half
 * minute's speed. `rate`: moving by `perMin` degrees a minute otherwise. `steady`: moving less than 0.2° a minute.
 */
export type Trend = { kind: 'holding' } | { kind: 'eta'; seconds: number } | { kind: 'rate'; perMin: number } | { kind: 'steady' }

const AVG = 5 // samples averaged at each end, so one noisy reading doesn't swing the result
const SPAN = 30 // seconds between the two averages; samples are a second apart

/** The trend from a heater's samples, one a second, newest last. Null until there are enough, or across a gap. */
export function heaterTrend(temps: number[], target: number): Trend | null {
  if (temps.length < SPAN + AVG) return null
  const recent = temps.slice(-AVG)
  const before = temps.slice(-SPAN - AVG, -SPAN)
  // Moonraker records 0 °C while Klipper restarts.
  if (temps.slice(-SPAN - AVG).some((v) => !(v > 0))) return null
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
  const now = mean(recent)
  const perMin = ((now - mean(before)) * 60) / SPAN
  if (target > 0) {
    const left = target - now
    if (Math.abs(left) <= 1.5) return { kind: 'holding' }
    // Heating slows near the target, so this is a little early; an hour or more reads as a rate instead.
    if (left * perMin > 0.5) {
      const seconds = (left / perMin) * 60
      if (seconds < 3600) return { kind: 'eta', seconds }
    }
  }
  if (Math.abs(perMin) < 0.2) return { kind: 'steady' }
  return { kind: 'rate', perMin }
}

/**
 * A sensor's Box and what's left of its name without the Box: QIDI names them `heater_temp_a_box1`, `Box1_MCU`, and
 * `box1_env`. `side` is A or B for a Box heater's two thermistors. A sensor without a Box number gets `box` null.
 */
export function sensorPlace(name: string): { box: number | null; rest: string; side: 'A' | 'B' | null } {
  const m = name.match(/^(.*?)(?:^|_)box_?(\d+)(?:_|$)(.*)$/i)
  if (!m) return { box: null, rest: name, side: null }
  const rest = [m[1], m[3]].filter(Boolean).join('_')
  const side = rest.match(/^heater_temp_([ab])$/i)
  return { box: Number(m[2]), rest, side: side ? (side[1].toUpperCase() as 'A' | 'B') : null }
}
