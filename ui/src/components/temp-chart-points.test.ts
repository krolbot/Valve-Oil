import { describe, expect, it } from 'vitest'
import { bucketPoints, chartRange, type ChartPoint } from './temp-chart-points'

// A nozzle holding 220° with a reading that wobbles by up to a degree each second.
const history = Array.from({ length: 1300 }, (_, k) => 220 + Math.sin(k * 2.7) + ((k * 7919) % 13) / 13 - 0.5)

/** The points a 600-sample window ending at sample `end` draws, keyed by their sample number in the whole history. */
function drawn(end: number, stride: number, how: 'mean' | 'last' = 'mean') {
  const first = end - 600
  return new Map(bucketPoints(history.slice(first, end), first, stride, how).map((p: ChartPoint) => [first + p.i, p.v]))
}

describe('temperature chart buckets', () => {
  it.each([2, 4, 5])('draws the same points for full buckets after the window slides a second (stride %i)', (stride) => {
    for (const end of [700, 701, 1003]) {
      const before = drawn(end, stride)
      const after = drawn(end + 1, stride)
      // The window's first and last buckets can be partial; every bucket between them is unchanged.
      const keys = [...before.keys()].slice(1, -1)
      expect(keys.length).toBeGreaterThan(100)
      for (const k of keys) expect(after.get(k)).toBe(before.get(k))
    }
  })

  it('leaves a gap only where every reading in a bucket is 0, and keeps a target step a step', () => {
    const temps = [200, 201, 0, 0, 0, 0, 0, 202]
    expect(bucketPoints(temps, 0, 2, 'mean').map((p) => p.v)).toEqual([200.5, null, null, 202])
    const targets = [0, 0, 220, 220, 220, 0]
    expect(bucketPoints(targets, 1, 2, 'last').map((p) => p.v)).toEqual([null, 220, 220, null])
  })
})

describe('temperature chart range', () => {
  it('keeps the top gridline above the highest reading', () => {
    // The Max 4's sensors, 22.4° to 30.3°: 2° steps, and the top at 32°, not 30°.
    expect(chartRange(22.4, 30.3, 4, [2, 5, 10, 20, 25, 50, 100])).toEqual({ bottom: 22, top: 32, step: 2 })
    // The same in 5° steps tops out at 35°.
    expect(chartRange(22.4, 30.3, 2, [5, 10])).toEqual({ bottom: 20, top: 35, step: 5 })
  })

  it('adds a step when a reading sits on or just under a gridline', () => {
    expect(chartRange(20, 60, 3, [5, 10, 20, 25, 50, 100]).top).toBe(80)
    expect(chartRange(20, 99.5, 3, [5, 10, 20, 25, 50, 100]).top).toBe(150)
  })

  it('leaves the top where it is when there is room under it', () => {
    expect(chartRange(20, 55, 3, [5, 10, 20, 25, 50, 100]).top).toBe(60)
  })

  it('draws at least two steps for a flat line', () => {
    const r = chartRange(24.5, 24.6, 4, [2, 5, 10])
    expect(r.top - r.bottom).toBeGreaterThanOrEqual(2 * r.step)
    expect(r.top).toBeGreaterThan(24.6)
  })
})
