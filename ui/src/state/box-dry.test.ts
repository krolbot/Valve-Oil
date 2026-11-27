import { describe, expect, it, vi } from 'vitest'

vi.mock('./database', () => ({ VALVE_OIL_UI: 'valve_oil_ui' }))
import { dryLeft, type DryRun } from './box-dry'
import type { BoxClimate } from './box-model'

const drying: BoxClimate = { box: 1, humidity: 30, temperature: 58, target: 60, heater: 'heater_box1', drying: true }
const run: DryRun = { start: 1_000_000, hours: 8, temp: 60 }

describe('dryLeft', () => {
  it('shows the length asked for the moment the dry starts', () => {
    expect(dryLeft(run, drying, run.start)).toEqual({ left: 8 * 3600, hours: 8 })
    expect(dryLeft(run, drying, run.start + 1)).toEqual({ left: 8 * 3600, hours: 8 })
  })

  it('never shows more than the length asked for, whatever the clock says', () => {
    // A tab open since before the dry started once showed 10h 41m for an 8-hour dry.
    expect(dryLeft(run, drying, run.start - (2 * 3600 + 41 * 60))!.left).toBe(8 * 3600)
  })

  it('counts down to the whole minute', () => {
    expect(dryLeft(run, drying, run.start + 61)!.left).toBe(8 * 3600 - 60)
    expect(dryLeft(run, drying, run.start + 8 * 3600 - 1)!.left).toBe(60)
    expect(dryLeft(run, drying, run.start + 8 * 3600)!.left).toBe(0)
  })

  it('shows Ending for a few minutes past the end, then nothing', () => {
    expect(dryLeft(run, drying, run.start + 8 * 3600 + 200)!.left).toBe(0)
    expect(dryLeft(run, drying, run.start + 8 * 3600 + 300)).toBeNull()
  })

  it('has no time for a Box that isn’t drying, a dry at another temperature, or one Valve Oil didn’t start', () => {
    expect(dryLeft(run, { ...drying, drying: false }, run.start)).toBeNull()
    expect(dryLeft(run, { ...drying, target: 45 }, run.start)).toBeNull()
    expect(dryLeft(undefined, drying, run.start)).toBeNull()
    expect(dryLeft(run, undefined, run.start)).toBeNull()
  })
})
