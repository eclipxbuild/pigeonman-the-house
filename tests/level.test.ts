import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { initPhysics, Physics } from '../src/engine/physics'
import { HouseWorld } from '../src/game/houseWorld'
import { ALL_ITEMS } from '../src/game/horrorRules'

let physics: Physics
let house: HouseWorld

beforeAll(async () => { await initPhysics() })
beforeEach(() => {
  physics = new Physics()
  house = new HouseWorld(physics, 907)
})
afterEach(() => { physics.dispose() })

function reachable(start: string): Set<string> {
  const seen = new Set([start])
  const queue = [start]
  for (let i = 0; i < queue.length; i += 1) {
    const node = house.node(queue[i])
    for (const id of node?.links ?? []) if (!seen.has(id)) { seen.add(id); queue.push(id) }
  }
  return seen
}

describe('abandoned house navigation and hide layout', () => {
  it('contains the required rooms and connects the full ground-floor patrol loop', () => {
    const roomIds = new Set(house.rooms.map(room => room.id))
    for (const id of ['bed-west', 'bed-north', 'living', 'kitchen', 'dining', 'study', 'storage', 'bath', 'foyer', 'basement', 'garage', 'attic', 'passage']) {
      expect(roomIds.has(id), `missing room ${id}`).toBe(true)
    }
    expect(house.rooms.filter(room => room.kind === 'bedroom').length).toBeGreaterThanOrEqual(2)

    const start = reachable('foyer')
    for (const id of ['bed-west', 'bed-north', 'living', 'kitchen', 'dining', 'study', 'storage', 'bath', 'foyer']) expect(start.has(id), `ground room ${id} is disconnected`).toBe(true)
    expect(start.has('basement-ramp-top')).toBe(false)
    expect(start.has('upper-ramp-mid')).toBe(false)
  })

  it('unlocks only the intended navigation gates and closes them cleanly for a new attempt', () => {
    expect(house.openDoor('basement-door')).toBe(true)
    expect(reachable('foyer').has('basement-ramp-top')).toBe(true)
    expect(reachable('foyer').has('garage')).toBe(true)

    expect(house.openDoor('attic-door')).toBe(true)
    expect(reachable('foyer').has('attic')).toBe(true)
    expect(house.openDoor('secret-passage')).toBe(true)
    expect(reachable('foyer').has('secret-passage')).toBe(true)

    house.resetDoors()
    const closed = reachable('foyer')
    expect(closed.has('basement-ramp-top')).toBe(false)
    expect(closed.has('upper-ramp-mid')).toBe(false)
    expect(closed.has('secret-passage')).toBe(false)
    expect(house.targets.filter(target => target.opened).length).toBe(0)
  })

  it('offers enough unique accessible item positions and working hides across floors', () => {
    expect(house.itemSpots.length).toBeGreaterThanOrEqual(ALL_ITEMS.length)
    expect(new Set(house.itemSpots.map(p => `${p.x}:${p.y}:${p.z}`)).size).toBe(house.itemSpots.length)
    expect(house.hideSpots.map(spot => spot.id)).toEqual(expect.arrayContaining(['under-bed', 'wardrobe-hide', 'sofa-hide']))
    expect(house.hideSpots.some(spot => spot.kind === 'storage' && spot.position.y < 0)).toBe(true)
    for (const spot of house.hideSpots) {
      expect([...spot.position.toArray(), ...spot.entry.toArray(), ...spot.exit.toArray()].every(Number.isFinite)).toBe(true)
    }
  })
})
