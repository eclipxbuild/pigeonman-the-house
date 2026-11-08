import * as THREE from 'three'
import type { NavNode } from './houseWorld'

export type PigeonState = 'PATROL' | 'INVESTIGATE' | 'CHASE' | 'SEARCH' | 'ATTACK' | 'RETURN'
export type Difficulty = 'easy' | 'normal' | 'hard' | 'nightmare'
export type HeardEvent = { position: THREE.Vector3; strength: number; time: number; source?: string }

/** Deliberately contains no player-position, visibility, or line-of-sight input. */
export type PigeonAIInput = {
  now: number
  dt: number
  enemyPosition: THREE.Vector3
  hidden: boolean
  difficulty: Difficulty
  heard: readonly HeardEvent[]
}
export type PigeonAIOutput = {
  state: PigeonState
  targetNodeId: string
  target: THREE.Vector3
  speed: number
  alertness: number
  heartbeat: number
  caught: boolean
  changed: boolean
}

type Tuning = { speed: number; hearing: number; chase: number; search: number; searchTime: number; attack: number; soundTime: number }
const TUNING: Record<Difficulty, Tuning> = {
  easy: { speed: 2.25, hearing: 0.78, chase: 16, search: 1.2, searchTime: 7, attack: 1.05, soundTime: 7 },
  normal: { speed: 2.75, hearing: 1, chase: 22, search: 1.8, searchTime: 10, attack: 1.25, soundTime: 9 },
  hard: { speed: 3.25, hearing: 1.18, chase: 28, search: 2.5, searchTime: 13, attack: 1.45, soundTime: 12 },
  nightmare: { speed: 3.8, hearing: 1.38, chase: 34, search: 3.2, searchTime: 16, attack: 1.65, soundTime: 15 },
}
const isFootstep = (source?: string): source is 'footstep-walk' | 'footstep-run' =>
  source === 'footstep-walk' || source === 'footstep-run'

/** A deterministic planner. It hears only standing footsteps and never receives player coordinates. */
export class PigeonAI {
  private readonly nodes = new Map<string, NavNode>()
  private readonly orderedIds: string[] = []
  private readonly originId: string
  private currentNodeId: string
  private targetNodeId: string
  private patrolNodeId: string
  private state: PigeonState = 'PATROL'
  private stateSince = 0
  private lastKnown?: THREE.Vector3
  private lastKnownAt = -Infinity
  private lastRoom = ''
  private soundPosition?: THREE.Vector3
  private soundExpires = -Infinity
  private seenSounds = new Set<string>()
  private patrolPauseUntil = 0
  private lastUpdate = 0

  constructor(nodes: readonly NavNode[], startingNodeId: string) {
    for (const node of nodes) {
      if (!this.nodes.has(node.id)) {
        this.nodes.set(node.id, node)
        this.orderedIds.push(node.id)
      }
    }
    this.originId = this.nodes.has(startingNodeId) ? startingNodeId : (this.orderedIds[0] ?? '')
    this.currentNodeId = this.originId
    this.targetNodeId = this.originId
    this.patrolNodeId = this.originId
  }

  /** Dev-only diagnostics for verifying that silent movement does not create a new clue. */
  debugLastHeardPosition(): [number, number, number] | null {
    return this.lastKnown ? [this.lastKnown.x, this.lastKnown.y, this.lastKnown.z] : null
  }

  update(input: PigeonAIInput): PigeonAIOutput {
    const tuning = TUNING[input.difficulty]
    const dt = Number.isFinite(input.dt) ? Math.max(0, Math.min(input.dt, 0.25)) : 0
    const now = Number.isFinite(input.now) ? input.now : this.lastUpdate
    this.lastUpdate = now
    const startNode = this.nearestNode(input.enemyPosition) ?? this.nodes.get(this.originId)
    if (startNode) this.currentNodeId = startNode.id
    const previousState = this.state

    // The monster has no visual sensor. Non-footstep events are rejected even if a caller passes one.
    let bestSound: HeardEvent | undefined
    let bestScore = 0
    for (const event of input.heard) {
      if (!isFootstep(event.source) || !Number.isFinite(event.time) || event.time > now + 0.05 || now - event.time > 6 || !Number.isFinite(event.strength)) continue
      const signature = `${event.source}:${event.time}`
      if (this.seenSounds.has(signature)) continue
      const age = Math.max(0, now - event.time)
      const score = Math.max(0, event.strength) * tuning.hearing * Math.exp(-age / 4)
      if (score > bestScore) { bestScore = score; bestSound = event }
    }

    let caught = false
    if (bestSound && bestScore >= 0.35) {
      this.seenSounds.add(`${bestSound.source}:${bestSound.time}`)
      this.soundPosition = bestSound.position.clone()
      this.lastKnown = bestSound.position.clone()
      this.lastKnownAt = bestSound.time
      this.lastRoom = this.nearestNode(bestSound.position)?.roomId ?? ''
      this.soundExpires = now + tuning.soundTime
      const age = Math.max(0, now - bestSound.time)
      const distanceToFootstep = input.enemyPosition.distanceTo(bestSound.position)
      // A catch requires a fresh footstep in reach. Silent crouching/hiding cannot reveal a player.
      if (!input.hidden && age <= 0.65 && distanceToFootstep <= tuning.attack) {
        this.setState('ATTACK', now)
        caught = true
      } else if (bestSound.source === 'footstep-run') {
        this.setState('CHASE', now)
      } else {
        this.setState('INVESTIGATE', now)
      }
    }

    if (this.seenSounds.size > 256) this.seenSounds = new Set([...this.seenSounds].slice(-128))

    if (this.state === 'ATTACK' && !caught) {
      this.setState(this.soundPosition && now <= this.soundExpires ? 'INVESTIGATE' : 'SEARCH', now)
    }
    if ((this.state === 'CHASE' || this.state === 'INVESTIGATE') && this.soundPosition) {
      const soundNode = this.nearestNode(this.soundPosition)
      const clueHasGoneQuiet = now - this.lastKnownAt > 2.5
      if (now > this.soundExpires || (soundNode && this.currentNodeId === soundNode.id && clueHasGoneQuiet)) {
        this.soundPosition = undefined
        this.setState('SEARCH', now)
      }
    }
    if (this.state === 'SEARCH' && now - this.stateSince >= tuning.searchTime) {
      this.lastKnown = undefined
      this.soundPosition = undefined
      this.setState('RETURN', now)
    }

    if (this.state === 'PATROL') {
      if (now >= this.patrolPauseUntil && this.currentNodeId === this.patrolNodeId) {
        this.patrolNodeId = this.choosePatrolNode()
        const index = Math.max(0, this.orderedIds.indexOf(this.currentNodeId))
        this.patrolPauseUntil = now + 0.6 + (index % 4) * 0.35
      }
    } else if (this.state === 'RETURN') {
      if (this.currentNodeId === this.originId) this.setState('PATROL', now)
    }

    let desiredId = this.patrolNodeId
    let speed = tuning.speed
    const audibleNode = this.nearestNode(this.soundPosition ?? this.lastKnown ?? input.enemyPosition)
    if (this.state === 'INVESTIGATE') {
      desiredId = audibleNode?.id ?? this.currentNodeId
      speed *= 1.02
    } else if (this.state === 'CHASE') {
      desiredId = audibleNode?.id ?? this.currentNodeId
      speed *= 1.32
    } else if (this.state === 'ATTACK') {
      desiredId = audibleNode?.id ?? this.currentNodeId
      speed = 0
    } else if (this.state === 'SEARCH') {
      desiredId = this.searchWaypoint()
      speed *= 0.92
    } else if (this.state === 'RETURN') {
      desiredId = this.originId
      speed *= 0.95
    }

    if (this.state === 'PATROL' && now < this.patrolPauseUntil) desiredId = this.currentNodeId
    this.targetNodeId = this.nextHop(this.currentNodeId, desiredId) ?? this.currentNodeId
    const targetNode = this.nodes.get(this.targetNodeId) ?? this.nodes.get(this.currentNodeId) ?? this.nodes.get(this.originId)
    const target = targetNode ? targetNode.position.clone() : new THREE.Vector3()
    const clueDistance = this.lastKnown ? input.enemyPosition.distanceTo(this.lastKnown) : Infinity
    const proximity = clueDistance < tuning.chase ? 1 - clueDistance / tuning.chase : 0
    const alertness = THREE.MathUtils.clamp((this.state === 'SEARCH' ? 0.48 : this.state === 'CHASE' ? 0.82 : this.state === 'INVESTIGATE' ? 0.58 : this.state === 'ATTACK' ? 1 : 0.08) + proximity * 0.25, 0, 1)
    const heartbeat = this.state === 'ATTACK' ? 1 : this.state === 'CHASE' ? 0.72 + proximity * 0.25 : this.state === 'SEARCH' ? 0.4 + proximity * 0.4 : this.state === 'INVESTIGATE' ? proximity * 0.38 : 0
    void dt
    return { state: this.state, targetNodeId: this.targetNodeId, target, speed, alertness, heartbeat, caught, changed: previousState !== this.state }
  }

  private setState(state: PigeonState, now: number): void {
    if (state === this.state) return
    this.state = state
    this.stateSince = now
  }

  private nearestNode(position: THREE.Vector3): NavNode | undefined {
    let nearest: NavNode | undefined
    let distance = Infinity
    for (const node of this.nodes.values()) {
      const d = node.position.distanceToSquared(position)
      if (d < distance) { distance = d; nearest = node }
    }
    return nearest
  }

  /** BFS over actual links: the returned hop never cuts through an unlinked wall. */
  private nextHop(startId: string, goalId: string): string | undefined {
    if (!this.nodes.has(startId) || !this.nodes.has(goalId)) return undefined
    if (startId === goalId) return goalId
    const queue = [startId]
    const firstHop = new Map<string, string>()
    const visited = new Set([startId])
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const currentId = queue[cursor]
      const current = this.nodes.get(currentId)
      if (!current) continue
      for (const link of current.links) {
        if (visited.has(link) || !this.nodes.has(link)) continue
        visited.add(link)
        firstHop.set(link, currentId === startId ? link : (firstHop.get(currentId) ?? link))
        if (link === goalId) return firstHop.get(link)
        queue.push(link)
      }
    }
    let closest = startId
    let best = Infinity
    for (const id of visited) {
      const node = this.nodes.get(id)
      const goal = this.nodes.get(goalId)
      if (node && goal) {
        const d = node.position.distanceToSquared(goal.position)
        if (d < best) { best = d; closest = id }
      }
    }
    return closest === startId ? startId : (firstHop.get(closest) ?? startId)
  }

  private choosePatrolNode(): string {
    const reachable = this.reachableFrom(this.currentNodeId)
    const candidates = reachable.filter(id => id !== this.currentNodeId)
    if (candidates.length === 0) return this.currentNodeId
    const current = this.nodes.get(this.currentNodeId)
    const rooms = [...new Set(candidates.map(id => this.nodes.get(id)?.roomId ?? ''))]
    const otherRoom = current ? rooms.find(room => room && room !== current.roomId) : undefined
    const pool = otherRoom ? candidates.filter(id => this.nodes.get(id)?.roomId === otherRoom) : candidates
    const index = Math.max(0, this.orderedIds.indexOf(this.currentNodeId))
    this.patrolNodeId = pool[index % pool.length] ?? candidates[0]
    return this.patrolNodeId
  }

  private reachableFrom(startId: string): string[] {
    const found: string[] = []
    const queue = [startId]
    const seen = new Set(queue)
    for (let i = 0; i < queue.length; i += 1) {
      const node = this.nodes.get(queue[i])
      if (!node) continue
      for (const id of node.links) if (!seen.has(id) && this.nodes.has(id)) { seen.add(id); queue.push(id); found.push(id) }
    }
    return found
  }

  private searchWaypoint(): string {
    if (!this.lastKnown) return this.currentNodeId
    const center = this.nearestNode(this.lastKnown)
    if (!center) return this.currentNodeId
    const reachable = this.reachableFrom(center.id).filter(id => id !== center.id)
    const local = reachable.filter(id => {
      const node = this.nodes.get(id)
      return node?.roomId === this.lastRoom || this.nodes.get(center.id)?.roomId === this.lastRoom
    })
    const pool = local.length ? local : reachable
    if (!pool.length) return center.id
    const elapsed = Math.max(0, this.lastUpdate - this.stateSince)
    const index = Math.floor(elapsed / 2) % pool.length
    return pool[index] ?? center.id
  }
}
