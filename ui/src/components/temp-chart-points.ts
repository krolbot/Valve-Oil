/** A chart point: `i` is a sample index into the drawn values (a bucket's middle), `v` is null for a gap. */
export type ChartPoint = { i: number; v: number | null }

/**
 * Thins a heater's samples to one point per `stride` samples. Buckets are fixed to each sample's number in the whole
 * history (`first` is the number of `vals[0]`), not to its place in the window, so as the window slides a sample a
 * second, a full bucket draws the same point every time instead of a different sample of a noisy reading. Temperatures
 * draw a bucket's mean; targets draw its last value, so a target's step stays a step. Values of 0 or less are gaps:
 * Moonraker records 0 °C while Klipper restarts, and a target of 0 means the heater is off. Heater power passes
 * `zeroIsGap` false, since 0 is a heater that isn't heating.
 */
export function bucketPoints(vals: number[], first: number, stride: number, how: 'mean' | 'last', zeroIsGap = true): ChartPoint[] {
  const ok = (v: number) => (zeroIsGap ? v > 0 : Number.isFinite(v))
  const out: ChartPoint[] = []
  for (let i = 0; i < vals.length; ) {
    const end = Math.min(vals.length, i + stride - (((first + i) % stride) + stride) % stride)
    if (how === 'last') out.push({ i: end - 1, v: ok(vals[end - 1]) ? vals[end - 1] : null })
    else {
      let sum = 0
      let n = 0
      for (let k = i; k < end; k++)
        if (ok(vals[k])) {
          sum += vals[k]
          n++
        }
      out.push({ i: (i + end - 1) / 2, v: n ? sum / n : null })
    }
    i = end
  }
  return out
}

/**
 * A temperature chart's Y range: gridlines `step` apart from `bottom` to `top`, covering `lo` to `hi`, with at least two
 * steps. `lines` is about how many steps to aim for. The top gridline is at least a sixth of a step above the highest
 * reading, so a line never runs along the top of the chart or past it. A sensor at 30.3° with 5° steps tops out at 35°.
 */
export function chartRange(lo: number, hi: number, lines: number, steps: number[]) {
  const step = steps.find((s) => s >= Math.max(hi - lo, 6) / lines) ?? steps[steps.length - 1]
  const bottom = Math.max(0, Math.floor(lo / step) * step)
  const top = Math.max(bottom + 2 * step, Math.ceil((hi + step / 6) / step) * step)
  return { bottom, top, step }
}
