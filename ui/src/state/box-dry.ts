// Box drying times. QIDI's BOX_START_DRYING takes a length in hours, but the time left it reports (box_extras
// boxes[N].end_time) stays where it started on the Plus 5, so Valve Oil keeps its own record of each dry it starts:
// when, and for how long, in Moonraker's database, where every browser reads the same one. A dry started elsewhere,
// such as on the touchscreen, has no record and shows no time.
import { useEffect, useRef, useState } from 'react'
import { VALVE_OIL_UI, deleteItem, getItem, postItem, reloadItem, useDbItem } from './database'
import type { BoxClimate } from './box-model'

const KEY = 'box_dry'

export type DryRun = { start: number; hours: number; temp: number }
type DryRuns = Record<string, DryRun>

/** Records a dry, then runs the command that starts it. */
export async function startDryRun(box: number, temp: number, hours: number, start: () => unknown) {
  const runs = (await getItem<DryRuns>(VALVE_OIL_UI, KEY)) ?? {}
  await postItem<DryRuns>(VALVE_OIL_UI, KEY, { ...runs, [box]: { start: Date.now() / 1000, hours, temp } })
  return start()
}

/** Forgets a Box's dry, then runs the command that stops it. */
export async function stopDryRun(box: number, stop: () => unknown) {
  const runs = (await getItem<DryRuns>(VALVE_OIL_UI, KEY)) ?? {}
  const { [box]: _gone, ...rest } = runs
  await (Object.keys(rest).length ? postItem<DryRuns>(VALVE_OIL_UI, KEY, rest) : deleteItem(VALVE_OIL_UI, KEY).catch(() => undefined))
  return stop()
}

/**
 * Seconds left in a Box's dry, or null when it isn't drying or Valve Oil didn't start it. A record only counts for a
 * dry at its temperature that hasn't run past its end by more than a few minutes, so a stale one from an earlier dry
 * doesn't give a new one a time. The time counts down like a kitchen timer, up to the whole minute and never past the
 * length asked for, so a dry shows that length the moment it starts.
 */
export function dryLeft(run: DryRun | undefined, c: BoxClimate | undefined, now: number): { left: number; hours: number } | null {
  if (!c || !c.drying || !run || run.temp !== c.target) return null
  const total = run.hours * 3600
  const left = run.start + total - now
  return left > -300 ? { left: Math.min(total, Math.max(0, Math.ceil(left / 60) * 60)), hours: run.hours } : null
}

/** dryLeft for a Box, from the clock at each render, which runs again every 15 seconds while the Box dries. */
export function useDryLeft(c: BoxClimate | undefined): { left: number; hours: number } | null {
  const [runs] = useDbItem<DryRuns>(VALVE_OIL_UI, KEY, {})
  const [, tick] = useState(0)
  const drying = !!c?.drying
  // A dry another browser started: read the records again when this one sees drying begin.
  const was = useRef(drying)
  useEffect(() => {
    if (drying && !was.current) void reloadItem(VALVE_OIL_UI, KEY)
    was.current = drying
  }, [drying])
  useEffect(() => {
    if (!drying) return
    const t = setInterval(() => tick((n) => n + 1), 15_000)
    return () => clearInterval(t)
  }, [drying])
  return dryLeft(c ? runs[c.box] : undefined, c, Date.now() / 1000)
}
