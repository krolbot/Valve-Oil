import { describe, expect, it } from 'vitest'
import { heaterTrend, sensorPlace } from './temp-trend'

// One sample a second: `start` and `perSec` degrees a second after it.
const ramp = (n: number, start: number, perSec: number) => Array.from({ length: n }, (_, i) => start + i * perSec)

describe('heater trend', () => {
  it('needs 35 seconds of samples', () => {
    expect(heaterTrend(ramp(34, 100, 1), 220)).toBeNull()
    expect(heaterTrend(ramp(35, 100, 1), 220)).not.toBeNull()
  })

  it('gives the time to the target while heating toward it', () => {
    // 1°/s, last five average 157°: 63° left at 60°/min is 63 s.
    const t = heaterTrend(ramp(60, 100, 1), 220)
    expect(t?.kind).toBe('eta')
    expect(t?.kind === 'eta' && Math.round(t.seconds)).toBe(63)
  })

  it('gives the time while cooling toward a lower target', () => {
    expect(heaterTrend(ramp(60, 260, -0.5), 220)?.kind).toBe('eta')
  })

  it('holds within 1.5° of the target', () => {
    expect(heaterTrend(ramp(60, 219, 0), 220)).toEqual({ kind: 'holding' })
  })

  it('gives a rate when moving away from the target or off', () => {
    const away = heaterTrend(ramp(60, 150, -0.2), 220)
    expect(away?.kind).toBe('rate')
    expect(away?.kind === 'rate' && away.perMin).toBeCloseTo(-12)
    expect(heaterTrend(ramp(60, 30, 0.01), 0)).toEqual({ kind: 'rate', perMin: expect.closeTo(0.6) })
  })

  it('reads a heater off and barely moving as steady', () => {
    expect(heaterTrend(ramp(60, 25, 0.001), 0)).toEqual({ kind: 'steady' })
  })

  it('gives a rate rather than an hour or more', () => {
    // 0.25°/min with 30° to go is two hours.
    expect(heaterTrend(ramp(60, 20, 0.25 / 60), 50)?.kind).toBe('rate')
  })

  it('has nothing across a Klipper restart', () => {
    const temps = ramp(60, 100, 1)
    temps[50] = 0
    expect(heaterTrend(temps, 220)).toBeNull()
  })
})

describe('sensor place', () => {
  it.each([
    ['heater_temp_a_box1', 1, 'heater_temp_a', 'A'],
    ['heater_temp_b_box12', 12, 'heater_temp_b', 'B'],
    ['Box2_MCU', 2, 'MCU', null],
    ['box1_env', 1, 'env', null],
  ])('%s is in Box %i', (name, box, rest, side) => {
    expect(sensorPlace(name)).toEqual({ box, rest, side })
  })

  it.each(['Toolhead_MCU', 'Chamber_Thermal_Protection_Sensor', 'mailbox1', 'AP_Board_SOC'])('%s is the printer', (name) => {
    expect(sensorPlace(name).box).toBeNull()
  })
})
