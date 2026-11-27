// Home's Fans and lights card: the switches and lights' power always on top, then a Fans tab (the fans Valve Oil UI
// sets, temperature fans, and the fans Klipper runs) and a Light control tab (each light's color, brightness, and, on
// QIDI's printers, its effect). Both tabs keep the taller one's height, so switching never moves the page.
import { useEffect, useRef, type ReactNode } from 'react'
import { Fan, Info, LampCeiling, Lightbulb, Snowflake, ToggleRight, Volume2 } from 'lucide-react'
import { Segmented } from '../ui'
import { ColorInput, Note, Slider, objectLabel, send } from '../control/common'
import { FAN_TYPES, FanRow, LED_TYPES, LedRow, PIN_TYPES, PinRow, QIDI_FAN_ORDER, fanLabel, fanSpeedGcode, ledChannels, nameOf, setLedGcode, typeOf, useOutputs } from '../control/Outputs'
import { TemperatureFanRow } from '../control/Thermals'
import { useHasCommand, usePrinter } from '../../state/printer'
import { useStored } from '../../lib/browser'
import { t, type MessageKey } from '../../i18n'
import { EFFECTS, LIGHT_MACRO, SPEEDS, effectDef, effectPeriod, hueOf, lightEffectGcode, lightState, previewColor, rgbHex, type LightState } from './light-effects'

const SWATCHES = ['#ffffff', '#ffd9a0', '#f2b05a', '#ff3b30', '#34c759', '#2a78d6', '#af52de']
const pctOrOff = (v: number) => (v > 0 ? `${v}%` : t('common.off'))

type Tab = 'fans' | 'lights'

export function OutputsDeck() {
  const fans = useOutputs(FAN_TYPES)
  const pins = useOutputs(PIN_TYPES)
  const leds = useOutputs(LED_TYPES)
  const settings = usePrinter((s) => s.settings)
  const hasM106Macro = usePrinter((s) => s.objects.includes('gcode_macro M106'))
  const running = usePrinter((s) => fans.filter((o) => ['fan', 'fan_generic'].includes(typeOf(o)) && ((s.status[o]?.speed as number | undefined) ?? 0) > 0))
  const effectLight = useEffectLight(leds)
  const [stored, setTab] = useStored<Tab>('vo-home-outputs-tab', 'fans')

  const rank = (o: string) => (QIDI_FAN_ORDER.includes(nameOf(o)) ? QIDI_FAN_ORDER.indexOf(nameOf(o)) : 99)
  const settable = fans.filter((o) => ['fan', 'fan_generic'].includes(typeOf(o))).sort((a, b) => rank(a) - rank(b))
  const tempFans = fans.filter((o) => typeOf(o) === 'temperature_fan')
  const auto = fans.filter((o) => !settable.includes(o) && !tempFans.includes(o))
  const isPwm = (o: string) => settings[o.toLowerCase()]?.pwm === true || typeOf(o) !== 'output_pin'
  const switches = pins.filter((o) => !isPwm(o) && !settings[o.toLowerCase()]?.static_value)
  const pwmPins = pins.filter((o) => isPwm(o))
  const hasLights = leds.length > 0 || pwmPins.length > 0
  const tab: Tab = hasLights ? stored : 'fans'

  const fansOff = () => {
    for (const o of running) send(fanSpeedGcode(o, 0, hasM106Macro))
  }

  return (
    <section className="card oc-card">
      <h3 className="card-title">
        <Fan size={14} /> {t('control.screen.tab_outputs')}
        <span className="aside flex items-center gap-1.5">
          {tab === 'fans' && running.length > 0 && (
            <button type="button" className="btn btn-sm px-2! py-0.5! text-[11.5px]" onClick={fansOff}>
              {t('home.outputs.fans_off')}
            </button>
          )}
          {hasLights && (
            <Segmented
              label={t('control.screen.tab_outputs')}
              value={tab}
              onChange={setTab}
              options={[
                { value: 'fans', label: t('home.outputs.tab_fans') },
                { value: 'lights', label: t('home.outputs.tab_lights') },
              ]}
            />
          )}
        </span>
      </h3>
      {(switches.length > 0 || leds.length > 0) && (
        <div className="oc-quick">
          {switches.map((o) => (
            <SwitchPill key={o} obj={o} />
          ))}
          {leds.map((o) => (o === effectLight ? <EffectPowerPill key={o} obj={o} /> : <LedPowerPill key={o} obj={o} />))}
        </div>
      )}
      <div className="oc-panes">
        <Pane active={tab === 'fans'}>
          <div className="grid gap-2.5">
            {settable.map((o) => (
              <FanRow key={o} obj={o} inline />
            ))}
            {tempFans.length > 0 && (
              <div className="-my-1.5 grid">
                {tempFans.map((o) => (
                  <TemperatureFanRow key={o} obj={o} />
                ))}
              </div>
            )}
          </div>
          {auto.length > 0 && (
            <div className="deck-sec mt-3! pt-2!">
              <div className="section-label mb-1 flex items-center gap-1.5">
                {t('home.outputs.klipper_runs')}
                <span className="text-ink-3" title={t('control.outputs.fans_note')}>
                  <Info size={12} />
                </span>
              </div>
              <div className="oc-auto">
                {auto.map((o) => (
                  <AutoFan key={o} obj={o} />
                ))}
              </div>
            </div>
          )}
        </Pane>
        {hasLights && (
          <Pane active={tab === 'lights'}>
            <div className="grid gap-3">
              {pwmPins.map((o) => (
                <PinRow key={o} obj={o} />
              ))}
              {leds.map((o) => (
                <div key={o} className="oc-light">
                  {o === effectLight ? <EffectLight obj={o} /> : <LedRow obj={o} />}
                </div>
              ))}
            </div>
          </Pane>
        )}
      </div>
    </section>
  )
}

/** One tab's content. Both sit in the same grid cell, so the card is as tall as the taller; the hidden one is inert. */
function Pane({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div className={active ? '' : 'oc-hidden'} inert={!active} aria-hidden={!active}>
      {children}
    </div>
  )
}

/**
 * The light QIDI's neopixel module runs effects on: the printer's one neopixel, when Klipper has NEOPIXEL_MODE and
 * Valve Oil's macro is installed. QIDI's module registers NEOPIXEL_MODE without a light name, so it allows only one.
 */
function useEffectLight(leds: string[]) {
  const hasMode = useHasCommand('NEOPIXEL_MODE')
  const hasMacro = usePrinter((s) => s.objects.includes(LIGHT_MACRO))
  const neopixels = leds.filter((o) => typeOf(o) === 'neopixel')
  return hasMode && hasMacro && neopixels.length === 1 ? neopixels[0] : null
}

function AutoFan({ obj }: { obj: string }) {
  const speed = usePrinter((s) => (s.status[obj]?.speed as number | undefined) ?? 0)
  const rpm = usePrinter((s) => s.status[obj]?.rpm as number | null | undefined)
  return (
    <>
      <span className="truncate text-ink-3">{fanLabel(obj)}</span>
      <span className="num text-right text-ink-3">{typeof rpm === 'number' && rpm > 0 ? t('control.outputs.rpm', { rpm: rpm.toFixed(0) }) : ''}</span>
      <b className={`num text-right ${speed > 0 ? 'text-accent-ink' : 'text-ink-3'}`}>{speed > 0 ? `${Math.round(speed * 100)}%` : t('common.off')}</b>
    </>
  )
}

// ---- the switches and the lights' power, always shown ----
const PIN_ICONS: Record<string, ReactNode> = { caselight: <LampCeiling size={13} />, polar_cooler: <Snowflake size={13} />, beeper: <Volume2 size={13} /> }
const PIN_NAMES: Record<string, MessageKey> = { caselight: 'home.outputs.case_light' }
const pinLabel = (obj: string) => (PIN_NAMES[nameOf(obj)] ? t(PIN_NAMES[nameOf(obj)]) : objectLabel(obj))

function Pill({ on, icon, label, onClick }: { on: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" className={`choice ${on ? 'on' : ''}`} aria-pressed={on} onClick={onClick}>
      {icon}
      {label}
    </button>
  )
}

function SwitchPill({ obj }: { obj: string }) {
  const value = usePrinter((s) => (s.status[obj]?.value as number | undefined) ?? 0)
  const scale = usePrinter((s) => (s.settings[obj.toLowerCase()]?.scale as number | undefined) ?? 1)
  const name = nameOf(obj)
  return <Pill on={value > 0} icon={PIN_ICONS[name] ?? <ToggleRight size={13} />} label={pinLabel(obj)} onClick={() => send(`SET_PIN PIN=${name} VALUE=${value > 0 ? 0 : scale}`)} />
}

function LedPowerPill({ obj }: { obj: string }) {
  const data = usePrinter((s) => (s.status[obj]?.color_data?.[0] as number[] | undefined) ?? [0, 0, 0, 0])
  const cfg = usePrinter((s) => s.settings[obj.toLowerCase()])
  const channels = ledChannels(typeOf(obj), cfg).toLowerCase()
  const on = data.some((v) => v > 0)
  // On is full white: a light without a white channel gets red, green, and blue at full.
  const full = channels.includes('w') ? { r: 0, g: 0, b: 0, w: 1 } : { r: 1, g: 1, b: 1, w: 0 }
  return <Pill on={on} icon={<Lightbulb size={13} />} label={objectLabel(obj)} onClick={() => send(setLedGcode(nameOf(obj), channels, on ? { r: 0, g: 0, b: 0, w: 0 } : full))} />
}

function EffectPowerPill({ obj }: { obj: string }) {
  const light = useLight()
  const on = light.effect !== 'off'
  return <Pill on={on} icon={<Lightbulb size={13} />} label={objectLabel(obj)} onClick={() => send(lightEffectGcode({ effect: on ? 'off' : 'on' }))} />
}

// ---- the effect light ----
const useLight = () => lightState(usePrinter((s) => s.status[LIGHT_MACRO]))

function effectName(effect: string) {
  return effect === 'off' ? t('common.off') : t(`home.outputs.effect_${effect}` as MessageKey)
}

function EffectLight({ obj }: { obj: string }) {
  const light = useLight()
  const count = usePrinter((s) => (s.settings[obj.toLowerCase()]?.chain_count as number | undefined) ?? 25)
  const progress = usePrinter((s) => (s.status.print_stats?.state === 'printing' ? ((s.status.display_status?.progress as number | undefined) ?? 0) : null))
  const on = light.effect !== 'off'
  const def = effectDef(light.effect)
  const label = objectLabel(obj)
  const rgb = [light.red, light.green, light.blue]
  const set = (change: Parameters<typeof lightEffectGcode>[0]) => send(lightEffectGcode(change))
  // A color is for effects that take one; picked while off, with the status light, or with rainbow, it shows solid.
  const pickColor = (hex: string) => {
    const [red, green, blue] = hueOf(hex)
    set({ effect: def?.color ? light.effect : 'solid', red, green, blue })
  }
  const speed = on && def && def.period > 0 ? light.speed : null
  const summary = speed ? `${effectName(light.effect)} · ${t(`home.outputs.speed_${speed}` as MessageKey)}` : effectName(light.effect)
  return (
    <div className="grid gap-2.5">
      <div className="flex items-baseline gap-2">
        <span className="font-semibold">{label}</span>
        <span className="text-[12px] text-ink-3">{summary}</span>
      </div>
      <LedStrip count={count} light={light} effect={light.effect} progress={progress} />
      <div className="oc-fxs" role="group" aria-label={t('home.outputs.effect_named', { name: label })}>
        {EFFECTS.map((e) => (
          <button key={e.id} type="button" className={`oc-fx ${light.effect === e.id ? 'on' : ''}`} aria-pressed={light.effect === e.id} onClick={() => set({ effect: e.id })}>
            <LedStrip count={7} light={light} effect={e.id} progress={null} mini />
            <span>{effectName(e.id)}</span>
          </button>
        ))}
      </div>
      {light.effect === 'status' ? (
        <Note>{t('home.outputs.status_note')}</Note>
      ) : (
        <>
          <div className="oc-row">
            <span className="section-label">{t('home.outputs.color')}</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {SWATCHES.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`led-swatch ${on && def?.color && rgbHex(rgb) === rgbHex(hueOf(s)) ? 'on' : ''}`}
                  style={{ background: s }}
                  onClick={() => pickColor(s)}
                  aria-label={t('control.outputs.set_color', { name: label, color: s })}
                  title={s}
                />
              ))}
              <label className="btn btn-sm relative ml-1 cursor-pointer overflow-hidden">
                {t('control.outputs.custom')}
                <ColorInput value={rgbHex(rgb)} onPick={pickColor} label={t('control.outputs.pick_color')} />
              </label>
            </div>
          </div>
          <div className="oc-row">
            <span className="section-label">{t('control.outputs.brightness')}</span>
            <Slider
              label={t('control.outputs.brightness_named', { name: label })}
              value={on ? light.brightness : 0}
              onCommit={(v) => set(v === 0 ? { effect: 'off' } : { effect: on ? light.effect : 'on', brightness: v })}
              format={pctOrOff}
            />
          </div>
          {on && def && def.period > 0 && (
            <div className="oc-row">
              <span className="section-label">{t('home.outputs.speed')}</span>
              <div className="flex flex-wrap items-center gap-1.5">
                <Segmented
                  label={t('home.outputs.speed')}
                  value={light.speed}
                  onChange={(v) => set({ speed: v })}
                  options={SPEEDS.map((v) => ({ value: v, label: t(`home.outputs.speed_${v}` as MessageKey) }))}
                />
                {def.direction && (
                  <button type="button" className={`choice ${light.direction === 0 ? 'on' : ''}`} aria-pressed={light.direction === 0} onClick={() => set({ direction: light.direction ? 0 : 1 })}>
                    {t('home.outputs.reverse')}
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * A row of LEDs showing an approximation of the effect, animated in the browser: the real one runs on the printer's
 * main board and nothing reports it back. Still when the browser asks for less motion.
 */
function LedStrip({ count, light, effect, progress, mini }: { count: number; light: LightState; effect: string; progress: number | null; mini?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const rgb = effectDef(effect)?.color === false && effect !== 'rainbow' ? [255, 255, 255] : [light.red, light.green, light.blue]
  const brightness = effect === 'status' ? 100 : light.brightness
  const period = effectPeriod(effect, light.speed) || 3000
  const { direction } = light
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const cells = Array.from(el.children) as HTMLElement[]
    const draw = (time: number) => {
      cells.forEach((cell, i) => {
        const c = previewColor(effect, i, cells.length, time, rgb, brightness, period, direction, progress)
        cell.style.background = c ? `rgb(${c.map((v) => Math.round(Math.max(v, 18))).join(' ')})` : ''
      })
    }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return void draw(period * 0.4)
    let frame = requestAnimationFrame(function step(time) {
      draw(time)
      frame = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(frame)
    // rgb is rebuilt each render; its parts are the dependencies.
  }, [effect, light.red, light.green, light.blue, brightness, period, direction, progress, count])
  return (
    <div ref={ref} className={`led-strip ${mini ? 'mini' : ''}`} aria-hidden>
      {Array.from({ length: Math.max(1, Math.min(count, 60)) }, (_, i) => (
        <i key={i} />
      ))}
    </div>
  )
}
