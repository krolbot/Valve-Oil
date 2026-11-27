// Home's Temperatures card: one row per heater (now, target, power, trend, and its last 10 minutes), then the sensors
// grouped by Box and printer. Chart, or a heater's little chart, opens the full chart.
import { useState } from 'react'
import { ChartLine, Flame } from 'lucide-react'
import { draftKeys, objectLabel, send } from '../control/common'
import { boxHeaterNumber, heaterGcode, targetError, targetRange, type HeaterConfig } from '../control/heaters'
import { heaterObjects } from '../TempChart'
import { bucketPoints } from '../temp-chart-points'
import { toast } from '../toast'
import { usePrinter } from '../../state/printer'
import { boxHeaterMax, useBox } from '../../state/box'
import { prettyName } from '../../lib/format'
import { TempActions } from './Deck'
import { TempHistoryDialog, type ChartGroup, type ChartSeries } from './TempHistory'
import { heaterTrend, sensorPlace, type Trend } from './temp-trend'
import { t } from '../../i18n'
import './deck.css'

const HEATER_COLORS = 8
const SENSOR_COLORS = 8
const SPARK_SECONDS = 600

function heaterLabel(obj: string) {
  if (obj === 'extruder') return t('app.heaters.nozzle')
  if (obj === 'heater_bed') return t('app.heaters.bed')
  const n = boxHeaterNumber(obj)
  return n != null ? t('app.heaters.box', { n }) : prettyName(obj)
}

type Sensor = { obj: string; label: string; group: string; color: string }

/** The card's sensors, in groups: each Box's (QIDI names them with the Box number), then the printer's. */
function useSensorGroups() {
  const objs = usePrinter((s) => s.objects.filter((o) => (o.startsWith('temperature_sensor ') || o.startsWith('temperature_fan ')) && !o.split(' ')[1].startsWith('_')))
  const climates = useBox().climates
  const byBox = new Map<number | null, Sensor[]>()
  objs.forEach((obj, i) => {
    const name = obj.slice(obj.indexOf(' ') + 1)
    const place = sensorPlace(name)
    const label = place.side
      ? t('home.temps.box_heater_side', { side: place.side })
      : place.box != null
        ? objectLabel(`temperature_sensor ${place.rest}`)
        : name === 'Chamber_Thermal_Protection_Sensor'
          ? t('home.temps.chamber_protection')
          : objectLabel(obj)
    const group = place.box != null ? t('app.heaters.box', { n: place.box }) : t('home.temps.printer')
    const list = byBox.get(place.box) ?? []
    list.push({ obj, label, group, color: `var(--series-${HEATER_COLORS + 1 + (i % SENSOR_COLORS)})` })
    byBox.set(place.box, list)
  })
  // A Box with a humidity sensor but no temperature sensors still gets its group, for the humidity.
  for (const c of climates) if (c.humidity != null && !byBox.has(c.box)) byBox.set(c.box, [])
  const boxes = [...byBox.keys()].filter((b): b is number => b != null).sort((a, b) => a - b)
  const groups = [...boxes, null]
    .filter((b) => byBox.has(b))
    .map((b) => {
      const humidity = b != null ? climates.find((c) => c.box === b)?.humidity : null
      return { box: b, label: b != null ? t('app.heaters.box', { n: b }) : t('home.temps.printer'), sensors: byBox.get(b)!, humidity: humidity ?? null }
    })
  return groups
}

export function TempsCard({ className = '' }: { className?: string }) {
  const heaters = usePrinter((s) => heaterObjects(s.objects))
  const groups = useSensorGroups()
  const [chart, setChart] = useState<{ picked: string | null } | null>(null)
  const series: ChartSeries[] = [
    ...heaters.map((obj, i) => ({ obj, label: heaterLabel(obj), color: `var(--series-${(i % HEATER_COLORS) + 1})`, heater: true })),
    ...groups.flatMap((g) => g.sensors.map((s) => ({ obj: s.obj, label: s.label, color: s.color, heater: false, group: s.group }))),
  ]
  const chartGroups: ChartGroup[] = groups.map((g) => ({ label: g.label, note: g.humidity != null ? t('home.temps.humidity_note', { pct: g.humidity }) : undefined }))
  return (
    <section className={`card tc ${className}`}>
      <h3 className="card-title">
        <Flame size={14} /> {t('control.screen.tab_temps')}
        <span className="aside flex gap-1.5">
          <TempActions />
          <button type="button" className="btn btn-sm px-2! py-0.5! text-[11.5px]" onClick={() => setChart({ picked: null })}>
            <ChartLine size={12} /> {t('home.temps.chart')}
          </button>
        </span>
      </h3>
      <table className="tc-tab">
        <thead>
          <tr>
            <th className="c-sw" aria-hidden />
            <th className="l">{t('home.temps.col_heater')}</th>
            <th className="c-now">{t('home.temps.col_now')}</th>
            <th className="c-tg">{t('home.temps.col_target')}</th>
            <th className="tc-pw">{t('home.temps.power')}</th>
            <th className="tc-trend">{t('home.temps.col_trend')}</th>
            <th className="tc-hist">{t('common.time.minutes', { m: SPARK_SECONDS / 60 })}</th>
          </tr>
        </thead>
        <tbody>
          {series
            .filter((x) => x.heater)
            .map((x) => (
              <HeaterRow key={x.obj} obj={x.obj} label={x.label} color={x.color} onChart={() => setChart({ picked: x.obj })} />
            ))}
        </tbody>
      </table>
      {groups.length > 0 && (
        <div
          className={`tc-groups ${groups.length === 1 ? 'solo' : groups.length <= 3 ? 'row' : ''}`}
          // On a wide enough card, up to three groups share one row, the printer's wider for its longer names.
          style={{ '--tc-cols': groups.map((g) => (g.box == null ? 'minmax(0, 1.45fr)' : 'minmax(0, 1fr)')).join(' ') } as React.CSSProperties}
        >
          {groups.map((g) => (
            <div key={g.label} className="tc-group">
              <h4>{g.label}</h4>
              <div className="rows">
                {g.sensors.map((s) => (
                  <SensorRow key={s.obj} obj={s.obj} label={s.label} />
                ))}
                {g.humidity != null && (
                  <div className="tc-sensor">
                    <span className="k">{t('home.temps.humidity')}</span>
                    <span className="num v">{g.humidity}%</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {chart && <TempHistoryDialog series={series} groups={chartGroups} picked={chart.picked} onClose={() => setChart(null)} />}
    </section>
  )
}

function trendText(tr: Trend | null) {
  if (!tr) return ''
  if (tr.kind === 'holding') return t('home.temps.trend_holding')
  if (tr.kind === 'steady') return t('home.temps.trend_steady')
  if (tr.kind === 'eta') return tr.seconds < 90 ? t('common.time.seconds', { s: Math.max(5, Math.round(tr.seconds / 5) * 5) }) : t('common.time.minutes', { m: Math.round(tr.seconds / 60) })
  const r = Math.abs(tr.perMin)
  return t('home.temps.trend_rate', { rate: `${tr.perMin > 0 ? '+' : '−'}${r.toFixed(r < 10 ? 1 : 0)}` })
}

function HeaterRow({ obj, label, color, onChart }: { obj: string; label: string; color: string; onChart: () => void }) {
  const st = usePrinter((s) => s.status[obj] ?? {})
  const cfg = usePrinter((s) => s.settings[obj.toLowerCase()] as HeaterConfig | undefined)
  const history = usePrinter((s) => s.temps[obj])
  const box = useBox()
  const n = boxHeaterNumber(obj)
  const limit = n != null ? boxHeaterMax(box, n, Infinity) : Infinity
  const target = Math.round((st.target as number | undefined) ?? 0)
  const range = targetRange(cfg, Number.isFinite(limit) ? limit : null, target)
  const power = st.power as number | undefined
  const temp = st.temperature as number | undefined
  const on = target > 0
  const temps = history?.temperatures ?? []
  const set = (v: number) => {
    const err = targetError(v, range)
    if (err) return toast(err, 'error')
    send(heaterGcode(obj, v))
  }
  return (
    <tr className={on ? 'on' : ''} style={{ '--c': color } as React.CSSProperties}>
      <td className="sw" aria-hidden>
        <i />
      </td>
      <td className="nm">{label}</td>
      <td className="now num">{temp != null ? `${temp.toFixed(1)}°` : '—'}</td>
      <td className="tg">
        <TargetField label={label} value={target} disabled={range.locked} onSet={set} />
      </td>
      <td className="tc-pw num">
        {on && power != null ? (
          <>
            {Math.round(power * 100)}%
            <span className="pbar" aria-hidden>
              <span style={{ width: `${Math.round(power * 100)}%` }} />
            </span>
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="tc-trend">{trendText(heaterTrend(temps, target))}</td>
      <td className="tc-hist">
        <button type="button" className="spark" onClick={onChart} title={t('home.temps.chart_for', { name: label })} aria-label={t('home.temps.chart_for', { name: label })}>
          <Spark vals={temps.slice(-SPARK_SECONDS)} first={(history?.end ?? temps.length) - Math.min(temps.length, SPARK_SECONDS)} color={color} />
        </button>
      </td>
    </tr>
  )
}

/** A heater's last 10 minutes, scaled to its own range so a heater holding steady still shows its wobble. */
function Spark({ vals, first, color }: { vals: number[]; first: number; color: string }) {
  const W = 64
  const H = 20
  const pts = bucketPoints(vals, first, Math.max(1, Math.ceil(SPARK_SECONDS / (W / 2))), 'mean')
  const vs = pts.map((p) => p.v).filter((v): v is number => v != null)
  let lo = Math.min(...vs)
  let hi = Math.max(...vs)
  if (!vs.length) [lo, hi] = [0, 1]
  if (hi - lo < 2) [lo, hi] = [(lo + hi) / 2 - 1, (lo + hi) / 2 + 1]
  // The line ends at the right edge; a history shorter than 10 minutes starts partway across.
  const x = (i: number) => W - ((vals.length - 1 - i) / (SPARK_SECONDS - 1)) * W
  const y = (v: number) => H - 2 - ((v - lo) / (hi - lo)) * (H - 4)
  let d = ''
  let drawing = false
  for (const p of pts) {
    if (p.v == null) {
      drawing = false
      continue
    }
    d += `${drawing ? 'L' : 'M'}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`
    drawing = true
  }
  return (
    <svg width={W} height={H} aria-hidden>
      <path d={d} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/** The target: plain text until you hover or click it, "off" when the heater is off. Enter sets it; 0 turns it off. */
function TargetField({ label, value, disabled, onSet }: { label: string; value: number; disabled?: boolean; onSet: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft == null) return
    const v = Math.round(Number(draft))
    setDraft(null)
    if (draft.trim() !== '' && Number.isFinite(v) && v !== value) onSet(v)
  }
  return (
    <label className={`tc-tgt ${value > 0 ? 'set' : ''}`} title={disabled ? undefined : t('home.temps.target_hint', { name: label.toLowerCase() })}>
      <span className="arrow">→</span>
      <input
        className="num"
        inputMode="numeric"
        aria-label={t('control.target_stepper.target', { name: label })}
        disabled={disabled}
        placeholder={t('app.temps.off')}
        value={draft ?? (value > 0 ? String(value) : '')}
        onFocus={(e) => (setDraft(value > 0 ? String(value) : ''), e.target.select())}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={draftKeys(setDraft)}
      />
      {(value > 0 || draft != null) && <span className="unit">°</span>}
    </label>
  )
}

function SensorRow({ obj, label }: { obj: string; label: string }) {
  const st = usePrinter((s) => s.status[obj] ?? {})
  const temp = st.temperature as number | undefined
  const fan = obj.startsWith('temperature_fan ')
  return (
    <div className="tc-sensor" title={fan && typeof st.target === 'number' ? t('home.temps.fan_title', { name: label, pct: Math.round(((st.speed as number) ?? 0) * 100), target: Math.round(st.target) }) : label}>
      <span className="k">{label}</span>
      <span className="num v">
        {temp != null ? `${temp.toFixed(1)}°` : '—'}
        {fan && typeof st.speed === 'number' && <small> · {Math.round(st.speed * 100)}%</small>}
      </span>
    </div>
  )
}
