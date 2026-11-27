// Power-loss resume fakes, for Home's "Print interrupted" offer: a print a power cut stopped, QIDI Moonraker's
// recorded layer (`print_state.current_layer` in its settings table, read with server.database.config.select),
// printer.print.power_off_print, which resumes it as the touchscreen's Confirm does, and
// server.history.update.one_job_id, which the touchscreen's Cancel uses to mark the job cancelled.
//
// `--power-loss [layer]` starts the printer idle with an interrupted print on top of history, stopped at that layer (32
// unless given). `VO_POWER_LOSS [LAYER=32] [FILE=<path>]` cuts the power at any time: a running print stops, Klipper
// restarts, and the print is left interrupted, as Moonraker marks it when it starts again.
const FILE = 'gear_m2_32t.gcode.3mf'
const TOTAL_LAYERS = 240

export function install(fake) {
  const { args, state, now, set, broadcast, pushConsole, rpcError } = fake
  // What QIDI's Moonraker recorded for the last print: the file and layer power_off_print resumes from.
  let recorded = null
  let nextId = 0xf000

  const cutPower = (layer, filename) => {
    const ps = state.status.print_stats
    const running = ps && (ps.state === 'printing' || ps.state === 'paused')
    const file = filename ?? (running ? ps.filename : null) ?? FILE
    // The running print's job becomes the interrupted one; otherwise a new job for the file goes on top.
    const live = state.history.findIndex((j) => j.status === 'in_progress')
    const from = live >= 0 ? state.history.splice(live, 1)[0] : state.history.find((j) => j.filename === file)
    const duration = Math.round((layer / TOTAL_LAYERS) * 4320)
    state.history.unshift({
      ...(from ?? {}),
      // A copy, so the history fake's live tracker finishing the running job doesn't change it.
      job_id: from?.status === 'in_progress' ? from.job_id : (nextId++).toString(16).padStart(6, '0'),
      filename: file,
      status: 'interrupted',
      start_time: now() - duration - 600,
      end_time: now() - 600,
      print_duration: duration,
      total_duration: duration + 240,
      filament_used: from?.filament_used ?? 2400,
      exists: true,
    })
    recorded = { filename: file, layer }
    if (state.status.print_stats) {
      set('print_stats', { filename: '', state: 'standby', print_duration: 0, total_duration: 0, filament_used: 0, message: '', info: { current_layer: null, total_layer: null } })
      set('virtual_sdcard', { progress: 0, is_active: false, file_position: 0 })
      set('display_status', { progress: 0 })
      set('idle_timeout', { state: 'Idle' })
      set('pause_resume', { is_paused: false })
      set('toolhead', { homed_axes: '' })
      set('extruder', { target: 0 })
      set('heater_bed', { target: 0 })
    }
  }

  fake.wrap('server.database.config.select', (p, ws, next) =>
    p.section === 'print_state' && p.key === 'current_layer' && recorded ? { status: 'success', result: { 'print_state.current_layer': String(recorded.layer) } } : next(p, ws),
  )

  fake.handle({
    'printer.print.power_off_print': () => {
      // Klipper refuses it while printing, but not while a print is paused.
      if (state.status.print_stats.state === 'printing') throw rpcError('SD busy')
      if (!recorded) throw rpcError('No print to resume')
      pushConsole(`SDCARD_POWER_OFF_CONTINUES_PINT_FILE: resuming ${recorded.filename} at layer ${recorded.layer}`)
      const progress = recorded.layer / TOTAL_LAYERS
      set('print_stats', { filename: recorded.filename, state: 'printing', print_duration: 0, total_duration: 0, filament_used: 0, message: '', info: { current_layer: recorded.layer, total_layer: TOTAL_LAYERS } })
      set('virtual_sdcard', { progress, is_active: true })
      set('display_status', { progress })
      set('idle_timeout', { state: 'Printing' })
      set('toolhead', { homed_axes: 'xyz' })
      set('extruder', { target: 240 })
      set('heater_bed', { target: 90 })
      return 'ok'
    },
    // QIDI's Moonraker answers with a status dict and sends no history notification.
    'server.history.update.one_job_id': (p) => {
      const job = state.history.find((j) => j.job_id === p.job_id)
      if (!job) return { error: `Job ${p.job_id} not found` }
      if (p.update_fields !== 'status') return { error: `Field ${p.update_fields} can't be updated` }
      job.status = p.update_value
      return { result: 'success' }
    },
  })

  fake.gcode((C, p) => {
    if (C !== 'VO_POWER_LOSS') return false
    cutPower(Number(p.LAYER ?? 32), p.FILE)
    pushConsole(`// Power cut at layer ${recorded.layer} of ${recorded.filename}`)
    fake.restartKlipper(3)
    broadcast('notify_history_changed', [{ action: 'finished', job: state.history[0] }])
    return true
  })

  fake.commands({ VO_POWER_LOSS: 'Fake: cut the power, leaving a print interrupted (LAYER=32 FILE=<path>)' })

  if ('power-loss' in args) {
    const layer = Number(args['power-loss'])
    // Once the first scenario has set the printer up, as it is when it starts again after the cut.
    fake.status(() => {
      if (!recorded) cutPower(Number.isInteger(layer) && layer > 0 ? layer : 32)
    })
  }
}
