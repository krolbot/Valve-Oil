// Resuming a print a power cut stopped, as QIDI's touchscreen offers it with "Power loss detected. Resume printing?".
//
// Moonraker marks a job `interrupted` when it starts and finds one still in progress. QIDI's touchscreen offers the
// resume when the newest job in history is interrupted and the layer QIDI's Moonraker recorded for it
// (`print_state.current_layer` in its settings table) is above 1. Resuming is `printer.print.power_off_print`, which
// has Klipper reload QIDI's cached copy of the file and carry on a little before where the power went off; discarding
// marks the job cancelled, so neither this page nor the touchscreen offers it again. Upstream Moonraker has neither, so
// a printer without them is never offered a resume.
import { useEffect, useState } from 'react'
import { client, printer, usePrinter, type KlippyState } from './printer'
import type { HistoryJob } from './files'
import { createStore, useStore } from '../lib/store'

export const RECORDED_LAYER_SECTION = 'print_state'
export const RECORDED_LAYER_KEY = 'current_layer'

export type PowerLossOffer = { jobId: string; filename: string; layer: number }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The layer QIDI's Moonraker recorded for the print, from its settings table's answer, or null without one. */
export function recordedLayer(response: unknown): number | null {
  if (!isRecord(response) || response.status !== 'success' || !isRecord(response.result)) return null
  const value = response.result[`${RECORDED_LAYER_SECTION}.${RECORDED_LAYER_KEY}`]
  if ((typeof value !== 'string' || !value.trim()) && typeof value !== 'number') return null
  const layer = Number(value)
  return Number.isInteger(layer) ? layer : null
}

/**
 * Whether the resume may be sent: Klipper is ready and no print is running or paused. Klipper refuses it with "SD busy"
 * while printing but not while paused, so a paused print has to be ruled out here.
 */
export function canResume(printState: string | undefined, klippy: KlippyState) {
  return klippy === 'ready' && (printState === 'standby' || printState === 'complete' || printState === 'cancelled' || printState === 'error')
}

/**
 * The resume to offer, as QIDI's touchscreen decides it: the newest job was interrupted, the recorded layer is above
 * 1, and Klipper could take the resume now.
 */
export function powerLossOffer(newest: HistoryJob | null | undefined, layerResponse: unknown, printState: string | undefined, klippy: KlippyState): PowerLossOffer | null {
  if (newest?.status !== 'interrupted' || !canResume(printState, klippy)) return null
  const layer = recordedLayer(layerResponse)
  if (layer == null || layer <= 1) return null
  return { jobId: newest.job_id, filename: newest.filename, layer }
}

// Jobs resumed or discarded from this page, hidden at once rather than when history is next read.
const handled = createStore<string[]>([])

/** The resume to offer for the newest job in history, read again when history changes and when Klipper is ready. */
export function usePowerLossOffer(newest: HistoryJob | null | undefined): PowerLossOffer | null {
  const klippy = usePrinter((s) => s.klippy)
  const printState = usePrinter((s) => s.status.print_stats?.state as string | undefined)
  const historyRev = usePrinter((s) => s.historyRev)
  const gone = useStore(handled, (h) => h)
  const interrupted = newest?.status === 'interrupted' ? newest.job_id : null
  const [answer, setAnswer] = useState<{ jobId: string; response: unknown } | null>(null)
  useEffect(() => {
    if (!interrupted || klippy !== 'ready') return
    let live = true
    client
      .call('server.database.config.select', { section: RECORDED_LAYER_SECTION, key: RECORDED_LAYER_KEY })
      // Upstream Moonraker has no settings table: no recorded layer, so no resume.
      .catch(() => null)
      .then((response) => live && setAnswer({ jobId: interrupted, response }))
    return () => {
      live = false
    }
  }, [interrupted, klippy, historyRev])
  if (!interrupted || gone.includes(interrupted) || answer?.jobId !== interrupted) return null
  return powerLossOffer(newest, answer.response, printState, klippy)
}

/** Whether Klipper would take the resume right now, checked again just before it's sent. */
export function resumeAllowedNow() {
  const s = printer.get()
  return canResume(s.status.print_stats?.state, s.klippy)
}

/** Resumes the print, as the touchscreen's Confirm does. Klipper heats up and carries on from the recorded layer. */
export async function resumePowerLoss(offer: PowerLossOffer) {
  await client.call('printer.print.power_off_print')
  handled.set((h) => [...h, offer.jobId])
}

/** Marks the job cancelled, as the touchscreen's Cancel does, so it isn't offered again here or on the touchscreen. */
export async function discardPowerLoss(offer: PowerLossOffer) {
  const response = await client.call<unknown>('server.history.update.one_job_id', { job_id: offer.jobId, update_fields: 'status', update_value: 'cancelled' })
  if (isRecord(response) && response.error != null) throw new Error(String(response.error))
  handled.set((h) => [...h, offer.jobId])
  // Moonraker sends no history notification for this change.
  printer.set((s) => ({ ...s, historyRev: s.historyRev + 1 }))
}
