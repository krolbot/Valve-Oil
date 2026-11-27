// The Temperatures card's full chart: every heater and sensor the card shows, over the time the page keeps, with heater
// power in a lane underneath. Opened from the card's Chart button, or from a heater's little chart with that heater
// picked: its line is drawn on top and the others fade.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Dialog } from '../ui'
import { TEMP_POINTS, usePrinter } from '../../state/printer'
import { useStored } from '../../lib/browser'
import { bucketPoints, chartRange } from '../temp-chart-points'
import { t } from '../../i18n'

/** A line on the chart. Sensors carry the group the card lists them under (Box 1, Printer). */
export type ChartSeries = { obj: string; label: string; color: string; heater: boolean; group?: string }
/** A sensor group's heading on the legend, with its note (a Box's humidity). */
export type ChartGroup = { label: string; note?: string }

/** Windows in seconds: 10, 30, and 60 minutes, up to the history kept, and all of it when that falls between. */
export function chartWindows(kept = TEMP_POINTS) {
  const out = [600, 1800, 3600].filter((s) => s <= kept)
  if (kept > 600 && kept < 3600 && !out.includes(kept)) out.push(kept)
  return out
}

const ago = (s: number) => (s < 60 ? t('app.chart.seconds_ago', { s }) : t('common.time.minutes_ago', { m: Math.round(s / 60) }))

export function TempHistoryDialog({ series, groups, picked: firstPick, onClose }: { series: ChartSeries[]; groups: ChartGroup[]; picked: string | null; onClose: () => void }) {
  const windows = chartWindows()
  const [stored, setStored] = useStored('vo-temp-chart-window', String(windows[windows.length - 1]))
  const win = windows.includes(Number(stored)) ? Number(stored) : windows[windows.length - 1]
  const [power, setPower] = useStored<'1' | '0'>('vo-temp-chart-power', '1')
  // Every heater shows when the chart opens; sensors start hidden.
  const [hidden, setHidden] = useState(() => new Set(series.filter((x) => !x.heater).map((x) => x.obj)))
  const [picked, setPicked] = useState(firstPick)
  const show = (obj: string) => setHidden((h) => new Set([...h].filter((o) => o !== obj)))
  const hide = (obj: string) => {
    setHidden((h) => new Set([...h, obj]))
    setPicked((p) => (p === obj ? null : p))
  }
  const title = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="mr-auto">{t('app.chart.title')}</span>
      <button type="button" className={`tcx-chip ${power === '1' ? 'on' : ''}`} aria-pressed={power === '1'} onClick={() => setPower(power === '1' ? '0' : '1')}>
        {t('home.temps.power')}
      </button>
      {windows.length > 1 && (
        <div className="tcx-seg" role="group" aria-label={t('home.temps.window')}>
          {windows.map((w) => (
            <button key={w} type="button" aria-pressed={w === win} className={w === win ? 'on' : ''} onClick={() => setStored(String(w))}>
              {t('common.time.minutes', { m: w / 60 })}
            </button>
          ))}
        </div>
      )}
    </div>
  )
  return (
    <Dialog open onClose={onClose} title={title} size="full">
      <div className="tcx-body">
        <HistoryChart series={series.filter((x) => !hidden.has(x.obj))} picked={picked && !hidden.has(picked) ? picked : null} power={power === '1'} win={win} />
        <Legend
          series={series}
          groups={groups}
          hidden={hidden}
          picked={picked}
          onShow={show}
          onHide={hide}
          onPick={(obj) => setPicked((p) => (p === obj ? null : obj))}
        />
      </div>
    </Dialog>
  )
}

// Two taps on the same line this close together are a double tap.
const DOUBLE_TAP_MS = 350

/**
 * Every heater and sensor, by group. A tap shows a hidden line, and on a shown line highlights it, or stops
 * highlighting it. A double tap (or Delete) hides it. The first tap of a double tap still highlights for a moment.
 */
function Legend({ series, groups, hidden, picked, onShow, onHide, onPick }: { series: ChartSeries[]; groups: ChartGroup[]; hidden: Set<string>; picked: string | null; onShow: (obj: string) => void; onHide: (obj: string) => void; onPick: (obj: string) => void }) {
  const live = usePrinter((s) => Object.fromEntries(series.map((x) => [x.obj, `${s.status[x.obj]?.temperature ?? ''}|${s.status[x.obj]?.target ?? ''}`])))
  // Counted here rather than from the click's `detail`, which touch browsers don't all count.
  const lastTap = useRef<{ obj: string; at: number } | null>(null)
  const tap = (obj: string) => {
    const now = performance.now()
    const double = lastTap.current?.obj === obj && now - lastTap.current.at < DOUBLE_TAP_MS
    lastTap.current = double ? null : { obj, at: now }
    if (double) onHide(obj)
    else if (hidden.has(obj)) onShow(obj)
    else onPick(obj)
  }
  const row = (x: ChartSeries) => {
    const off = hidden.has(x.obj)
    const [temp, target] = live[x.obj].split('|').map((v) => (v === '' ? null : Number(v)))
    return (
      <button
        key={x.obj}
        type="button"
        className={`tcx-lg ${off ? 'off' : ''} ${picked === x.obj && !off ? 'sel' : ''}`}
        style={{ '--c': x.color } as React.CSSProperties}
        aria-pressed={!off && picked === x.obj}
        title={t('home.temps.line_title', { name: x.label })}
        onClick={() => tap(x.obj)}
        onKeyDown={(e) => {
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault()
            onHide(x.obj)
          }
        }}
      >
        <i aria-hidden />
        <span className="nm">{x.label}</span>
        <span className="num v">
          {temp != null ? `${temp.toFixed(1)}°` : '—'}
          {target ? <small>→ {Math.round(target)}°</small> : null}
        </span>
      </button>
    )
  }
  const section = (label: ReactNode, rows: ChartSeries[], note?: string) =>
    rows.length > 0 && (
      <div key={String(label)}>
        <h4>
          {label}
          {note && <span>{note}</span>}
        </h4>
        {rows.map(row)}
      </div>
    )
  return (
    <div className="tcx-legend">
      {section(t('home.temps.heaters'), series.filter((x) => x.heater))}
      {groups.map((g) => section(g.label, series.filter((x) => !x.heater && x.group === g.label), g.note))}
      <p className="hint">{t('home.temps.legend_hint')}</p>
    </div>
  )
}

function HistoryChart({ series, picked, power, win }: { series: ChartSeries[]; picked: string | null; power: boolean; win: number }) {
  const temps = usePrinter((s) => s.temps)
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 420 })
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.max(240, e.contentRect.width), h: Math.max(220, e.contentRect.height) }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Each line's samples in the window, newest last; `first` is the first one's number in the whole history.
  const data = series.map((x) => {
    const h = temps[x.obj]
    const all = h?.temperatures ?? []
    const end = h?.end ?? all.length
    const vals = all.slice(-win)
    return { x, vals, first: end - vals.length, targets: x.heater ? (h?.targets ?? []).slice(-win) : [], powers: x.heater ? (h?.powers ?? []).slice(-win) : [] }
  })
  const lane = power && data.some((d) => d.powers.length > 0)
  const W = size.w
  const H = size.h
  const pad = { l: 40, r: 10, t: 8, b: 20 }
  const PH = lane ? Math.min(80, Math.round(H * 0.18)) : 0
  const gap = lane ? 24 : 0
  const iw = W - pad.l - pad.r
  const ih = H - pad.t - pad.b - gap - PH

  let lo = Infinity
  let hi = -Infinity
  for (const d of data)
    for (const vals of [d.vals, d.targets])
      for (const v of vals)
        if (v > 0) {
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
  if (lo > hi) [lo, hi] = [20, 40]
  const { bottom, top, step } = chartRange(lo, hi, 4, [2, 5, 10, 20, 25, 50, 100])
  // Every line ends at "now" on the right; a sample `age` seconds old sits that far back.
  const xAge = (age: number) => pad.l + iw - (age / (win - 1)) * iw
  const yAt = (v: number) => pad.t + ih - ((v - bottom) / (top - bottom)) * ih
  const laneTop = pad.t + ih + gap
  const yPower = (p: number) => laneTop + PH - Math.max(0, Math.min(1, p)) * PH
  const stride = Math.max(1, Math.floor(win / (iw / 2)))
  const path = (vals: number[], first: number, how: 'mean' | 'last', y: (v: number) => number, zeroIsGap = true) => {
    let d = ''
    let on = false
    for (const p of bucketPoints(vals, first, stride, how, zeroIsGap)) {
      if (p.v != null) {
        d += `${on ? 'L' : 'M'}${xAge(vals.length - 1 - p.i).toFixed(1)} ${y(p.v).toFixed(1)}`
        on = true
      } else on = false
    }
    return d
  }
  const longest = Math.max(0, ...data.map((d) => d.vals.length))
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const age = Math.round(((pad.l + iw - (e.clientX - r.left)) / iw) * (win - 1))
    setHover(age >= 0 && age < longest ? age : null)
  }
  const minutes = win / 60
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ x: pad.l + f * iw, now: f === 1, text: f === 1 ? t('app.chart.now') : t('app.chart.minutes_back', { m: Math.round(minutes * (1 - f)) }) }))
  // The picked line goes last, on top of the rest.
  const order = [...data.filter((d) => d.x.obj !== picked), ...data.filter((d) => d.x.obj === picked)]
  const faded = (obj: string) => (picked && obj !== picked ? 0.45 : 1)
  const at = (vals: number[], age: number) => vals[vals.length - 1 - age]

  return (
    <div ref={box} className="tcx-chart">
      <svg width={W} height={H} className="absolute inset-0 block touch-none" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={t('app.chart.aria')}>
        {Array.from({ length: (top - bottom) / step + 1 }, (_, i) => bottom + i * step).map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={yAt(v)} y2={yAt(v)} stroke="var(--line)" />
            <text x={pad.l - 6} y={yAt(v) + 3.5} textAnchor="end" fontSize={10.5} fill="var(--ink-3)" className="num">
              {v}°
            </text>
          </g>
        ))}
        {lane && (
          <g>
            <text x={pad.l} y={laneTop - 7} fontSize={10.5} fontWeight={600} fill="var(--ink-3)">
              {t('home.temps.power')}
            </text>
            {[0, 0.5, 1].map((p) => (
              <g key={p}>
                <line x1={pad.l} x2={W - pad.r} y1={yPower(p)} y2={yPower(p)} stroke="var(--line)" strokeDasharray={p === 0.5 ? '2 4' : undefined} />
                <text x={pad.l - 6} y={yPower(p) + 3.5} textAnchor="end" fontSize={10.5} fill="var(--ink-3)" className="num">
                  {p * 100}%
                </text>
              </g>
            ))}
          </g>
        )}
        {ticks.map((tick) => (
          <text key={tick.x} x={tick.x} y={H - 5} textAnchor={tick.now ? 'end' : tick.x === pad.l ? 'start' : 'middle'} fontSize={10.5} fill="var(--ink-3)">
            {tick.text}
          </text>
        ))}
        {order.map((d) => (
          <path key={`${d.x.obj}-t`} d={path(d.targets, d.first, 'last', yAt)} fill="none" stroke={d.x.color} strokeOpacity={d.x.obj === picked ? 0.85 : 0.45} strokeWidth={1.25} strokeDasharray="4 4" />
        ))}
        {lane &&
          order.map((d) => d.powers.some((p) => p > 0.005) && <path key={`${d.x.obj}-p`} d={path(d.powers, d.first, 'mean', yPower, false)} fill="none" stroke={d.x.color} strokeWidth={d.x.obj === picked ? 1.8 : 1.2} opacity={picked && d.x.obj !== picked ? 0.35 : 0.85} />)}
        {order.map((d) => (
          <path key={d.x.obj} d={path(d.vals, d.first, 'mean', yAt)} fill="none" stroke={d.x.color} strokeWidth={d.x.obj === picked ? 2.6 : d.x.heater ? 2 : 1.4} opacity={faded(d.x.obj)} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {hover != null && (
          <g>
            <line x1={xAge(hover)} x2={xAge(hover)} y1={pad.t} y2={lane ? laneTop + PH : pad.t + ih} stroke="var(--ink-3)" strokeDasharray="2 3" />
            {data.map((d) => {
              const v = at(d.vals, hover)
              return v > 0 ? <circle key={d.x.obj} cx={xAge(hover)} cy={yAt(v)} r={3.5} fill={d.x.color} stroke="var(--surface)" strokeWidth={1.5} /> : null
            })}
          </g>
        )}
      </svg>
      {hover != null && (
        <div
          className="tcx-tip"
          style={{ transform: `translateX(clamp(0px, calc(${xAge(hover)}px ${xAge(hover) > W / 2 ? '- 14px - 100%' : '+ 14px'}), calc(${W}px - 100%)))` }}
        >
          <div className="when">{hover === 0 ? t('app.chart.now') : ago(hover)}</div>
          {data.map((d) => {
            const v = at(d.vals, hover)
            const tg = at(d.targets, hover)
            const p = at(d.powers, hover)
            return (
              <div key={d.x.obj} className="l" style={{ '--c': d.x.color } as React.CSSProperties}>
                <i />
                <span>{d.x.group && !d.x.heater ? `${d.x.group} · ${d.x.label}` : d.x.label}</span>
                <b className="num">
                  {v > 0 ? `${v.toFixed(1)}°` : '—'}
                  {tg > 0 && <small> → {Math.round(tg)}°</small>}
                  {p > 0.005 && <em> {Math.round(p * 100)}%</em>}
                </b>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
