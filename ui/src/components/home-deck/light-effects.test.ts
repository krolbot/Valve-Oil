import { describe, it, expect } from 'vitest'
import { hueOf, lightEffectGcode, lightState } from './light-effects'

describe('lightState', () => {
  it("is QIDI's status light until the macro's status arrives, as Klipper starts with it", () => {
    expect(lightState(undefined)).toMatchObject({ effect: 'status', brightness: 100, speed: 'normal' })
  })

  it('takes what the macro last set', () => {
    expect(lightState({ effect: 'comet', red: 0, green: 128, blue: 255, brightness: 40, speed: 'fast', direction: 0 })).toEqual({ effect: 'comet', red: 0, green: 128, blue: 255, brightness: 40, speed: 'fast', direction: 0 })
  })

  it('shows an effect it does not know as the status light rather than as off', () => {
    expect(lightState({ effect: 'disco' }).effect).toBe('status')
  })
})

describe('lightEffectGcode', () => {
  it('sends only what changes, so the macro keeps the rest', () => {
    expect(lightEffectGcode({ effect: 'rainbow' })).toBe('VO_LIGHT_EFFECT EFFECT=rainbow')
    expect(lightEffectGcode({ effect: 'solid', red: 255, green: 127.6, blue: 0 })).toBe('VO_LIGHT_EFFECT EFFECT=solid RED=255 GREEN=128 BLUE=0')
    expect(lightEffectGcode({ speed: 'slow', direction: 0 })).toBe('VO_LIGHT_EFFECT DIRECTION=0 SPEED=slow')
  })
})

describe('hueOf', () => {
  it('scales a picked color to full brightness, since brightness is set apart', () => {
    expect(hueOf('#7f3f00')).toEqual([255, 126, 0])
    expect(hueOf('#000000')).toEqual([0, 0, 0])
  })
})
