import { describe, expect, it, vi } from 'vitest'

vi.mock('./printer', () => ({}))
import { powerLossOffer, recordedLayer } from './power-loss'
import type { HistoryJob } from './files'

const job = (status: string): HistoryJob => ({ job_id: '0000A3', filename: 'parts/bracket.gcode', status, start_time: 1, end_time: null, print_duration: 600, total_duration: 700, filament_used: 1200 })
// QIDI's Moonraker answers its settings table with a status, not an RPC error, and the value as a string.
const layer = (value: string | number) => ({ status: 'success', result: { 'print_state.current_layer': value } })

describe('powerLossOffer', () => {
  it('offers the resume for an interrupted newest job with a recorded layer above 1, between prints', () => {
    for (const state of ['standby', 'complete', 'cancelled', 'error'])
      expect(powerLossOffer(job('interrupted'), layer('32'), state, 'ready')).toEqual({ jobId: '0000A3', filename: 'parts/bracket.gcode', layer: 32 })
  })

  it('offers nothing while a print runs or is paused, which Klipper would refuse or misread, or while Klipper is not ready', () => {
    expect(powerLossOffer(job('interrupted'), layer('32'), 'printing', 'ready')).toBeNull()
    expect(powerLossOffer(job('interrupted'), layer('32'), 'paused', 'ready')).toBeNull()
    expect(powerLossOffer(job('interrupted'), layer('32'), 'standby', 'startup')).toBeNull()
    expect(powerLossOffer(job('interrupted'), layer('32'), undefined, 'unknown')).toBeNull()
  })

  it('offers nothing unless the touchscreen would: another status, no job, or layer 1 and below', () => {
    for (const status of ['completed', 'cancelled', 'error', 'klippy_shutdown', 'in_progress']) expect(powerLossOffer(job(status), layer('32'), 'standby', 'ready')).toBeNull()
    expect(powerLossOffer(undefined, layer('32'), 'standby', 'ready')).toBeNull()
    expect(powerLossOffer(job('interrupted'), layer('1'), 'standby', 'ready')).toBeNull()
    expect(powerLossOffer(job('interrupted'), layer('0'), 'standby', 'ready')).toBeNull()
  })

  it('offers nothing without a recorded layer: upstream Moonraker, a missing key, or a value that is not a layer', () => {
    // Upstream Moonraker has no settings table, so the read fails and the hook passes null.
    expect(powerLossOffer(job('interrupted'), null, 'standby', 'ready')).toBeNull()
    expect(powerLossOffer(job('interrupted'), { status: 'error', message: "Config item 'print_state.current_layer' not found" }, 'standby', 'ready')).toBeNull()
    expect(powerLossOffer(job('interrupted'), { status: 'success', result: {} }, 'standby', 'ready')).toBeNull()
    expect(powerLossOffer(job('interrupted'), layer(''), 'standby', 'ready')).toBeNull()
    expect(powerLossOffer(job('interrupted'), layer('abc'), 'standby', 'ready')).toBeNull()
  })
})

describe('recordedLayer', () => {
  it("reads QIDI's recorded layer, as a string or a number", () => {
    expect(recordedLayer(layer('32'))).toBe(32)
    expect(recordedLayer(layer(7))).toBe(7)
  })
})
