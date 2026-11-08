import { afterEach, describe, expect, it } from 'vitest'
import { CONFIG, DEFAULT_CONFIG } from '../src/game/config'
import { tuning } from '../src/game/tuning'

const defaults = Object.fromEntries(tuning.controls.map(control => [control.id, control.default]))

afterEach(() => {
  tuning.apply(defaults)
  tuning.activate('jump')
  tuning.activate('run')
})

describe('PIGEONMAN preview tuning', () => {
  it('validates the whole patch before committing and preserves immutable source defaults', () => {
    const before = tuning.read()
    for (const patch of [
      { 'player.walkSpeed': 8, 'camera.fov': 999 },
      { 'player.walkSpeed': 6 },
      { 'player.walkSpeed': 3.15 },
      { 'player.walkSpeed': '4' },
      { 'camera.fov': Infinity },
      { unknown: 4 },
      { 'player.walkSpeed': 4.5, 'player.sprintSpeed': 4.4 },
    ]) {
      expect(() => tuning.apply(patch)).toThrow()
      expect(tuning.read()).toEqual(before)
    }
    tuning.apply({ 'player.walkSpeed': 4.1, 'player.sprintSpeed': 5.8 })
    expect(CONFIG.player.walkSpeed).toBe(4.1)
    expect(CONFIG.player.sprintSpeed).toBe(5.8)
    expect(DEFAULT_CONFIG.player.walkSpeed).toBe(3.2)
  })

  it('updates LIVE movement, camera and flashlight controls, and holds action/run values to their boundary', () => {
    tuning.apply({ 'player.walkSpeed': 3.8, 'camera.fov': 90, 'horror.flashlightDrain': 1.2 })
    expect(CONFIG.player.walkSpeed).toBe(3.8)
    expect(CONFIG.camera.fov).toBe(90)
    expect(CONFIG.horror.flashlightDrain).toBe(1.2)

    tuning.apply({ 'player.jumpSpeed': 5.6, 'enemy.speedMultiplier': 1.25, 'enemy.hearingMultiplier': 1.15 })
    expect(CONFIG.player.jumpSpeed).toBe(DEFAULT_CONFIG.player.jumpSpeed)
    expect(CONFIG.enemy.speedMultiplier).toBe(DEFAULT_CONFIG.enemy.speedMultiplier)
    expect(CONFIG.enemy.hearingMultiplier).toBe(DEFAULT_CONFIG.enemy.hearingMultiplier)
    tuning.activate('jump')
    expect(CONFIG.player.jumpSpeed).toBe(5.6)
    expect(CONFIG.enemy.speedMultiplier).toBe(DEFAULT_CONFIG.enemy.speedMultiplier)
    tuning.activate('run')
    expect(CONFIG.enemy.speedMultiplier).toBe(1.25)
    expect(CONFIG.enemy.hearingMultiplier).toBe(1.15)
  })
})

describe('preview run eligibility', () => {
  it('ignores camera and unapplied next-run values, but latches changed live gameplay until a clean run', () => {
    tuning.activate('run')
    tuning.apply({ 'camera.fov': 90, 'enemy.speedMultiplier': 1.2 })
    expect(tuning.unranked).toBe(false)
    tuning.apply({ 'horror.flashlightDrain': 1.1 })
    expect(tuning.unranked).toBe(true)
    tuning.apply(defaults)
    expect(tuning.unranked).toBe(true)
    tuning.activate('run')
    expect(tuning.unranked).toBe(false)
  })

  it('marks next-action gameplay only at its boundary and cannot erase an affected run with Reset', () => {
    tuning.activate('run')
    tuning.apply({ 'player.jumpSpeed': 5.5 })
    expect(tuning.unranked).toBe(false)
    tuning.activate('jump')
    expect(tuning.unranked).toBe(true)
    tuning.apply(defaults)
    tuning.activate('jump')
    expect(tuning.unranked).toBe(true)
    tuning.activate('run')
    expect(tuning.unranked).toBe(false)
    tuning.apply({ 'enemy.speedMultiplier': 1.35 })
    expect(tuning.unranked).toBe(false)
    tuning.activate('run')
    expect(tuning.unranked).toBe(true)
  })
})
