import * as THREE from 'three'
import { Physics, RAPIER } from '../engine/physics'

export type RoomInfo = { id: string; name: string; floor: number; center: THREE.Vector3; kind: string }
export type NavNode = { id: string; roomId: string; position: THREE.Vector3; links: string[] }
export type HideSpot = { id: string; label: string; position: THREE.Vector3; entry: THREE.Vector3; exit: THREE.Vector3; yaw: number; kind: 'bed' | 'wardrobe' | 'furniture' | 'storage'; mesh: THREE.Object3D }
export type TargetKind = 'front-exit' | 'basement-door' | 'attic-door' | 'basement-panel' | 'garage-chain' | 'garage-exit' | 'secret-passage'
export type HouseTarget = { id: string; label: string; kind: TargetKind; position: THREE.Vector3; object: THREE.Object3D; collider: RAPIER.Collider | null; opened: boolean }

type DoorMotion = { target: HouseTarget; start: THREE.Vector3; end: THREE.Vector3; startYaw: number; endYaw: number; progress: number; duration: number }

/** Compact procedural interior: dimensions are metres; floor surfaces are at y=0. */
export class HouseWorld {
  readonly scene = new THREE.Scene()
  readonly spawn = new THREE.Vector3(-12.5, 0.92, -8)
  readonly spawnYaw = -Math.PI / 2
  readonly rooms: RoomInfo[] = []
  readonly navNodes: NavNode[] = []
  readonly hideSpots: HideSpot[] = []
  readonly targets: HouseTarget[] = []
  readonly itemSpots: THREE.Vector3[] = []
  private readonly gatedNavigation = new Map<string, Array<[string, string]>>()
  private readonly rng: () => number
  private readonly flickers: { light: THREE.PointLight; base: number; phase: number; amplitude: number }[] = []
  private readonly dust: THREE.Points
  private readonly motions: DoorMotion[] = []
  private readonly initialDoors = new Map<string, { position: THREE.Vector3; yaw: number }>()
  private readonly wood: THREE.MeshStandardMaterial
  private readonly darkWood: THREE.MeshStandardMaterial
  private readonly plaster: THREE.MeshStandardMaterial
  private readonly trim: THREE.MeshStandardMaterial
  private readonly fabric: THREE.MeshStandardMaterial
  private readonly rug: THREE.MeshStandardMaterial

  constructor(private readonly physics: Physics, seed: number) {
    this.rng = seeded(seed)
    this.scene.background = new THREE.Color('#090b10')
    this.scene.fog = new THREE.FogExp2('#11131a', 0.014)
    this.wood = mat('#493326', 0.88); this.darkWood = mat('#241912', 0.92)
    this.plaster = mat('#716357', 0.96); this.trim = mat('#33251e', 0.9)
    this.fabric = mat('#53464a', 1)
    this.rug = mat('#4b2928', 1)
    this.scene.add(new THREE.HemisphereLight('#a6b4ce', '#17100c', 0.42))
    const key = new THREE.DirectionalLight('#a8b8db', 0.4); key.position.set(-10, 18, -5); key.castShadow = true
    key.shadow.mapSize.set(1024, 1024); key.shadow.camera.left = -24; key.shadow.camera.right = 24; key.shadow.camera.top = 24; key.shadow.camera.bottom = -24
    this.scene.add(key)
    this.buildGroundFloor()
    this.buildWing()
    this.decorateRooms()
    this.addTargets()
    this.buildNavigation()
    this.addItemSpots()
    this.addPracticalLights()
    this.dust = this.makeDust()
    this.scene.add(this.dust)
  }

  node(id: string): NavNode | undefined { return this.navNodes.find(n => n.id === id) }

  nearestRoom(p: THREE.Vector3): RoomInfo {
    return this.rooms.reduce((best, room) => distanceSq(p, room.center) < distanceSq(p, best.center) ? room : best, this.rooms[0])
  }

  update(elapsed: number, dt: number): void {
    const step = Math.min(Math.max(dt, 0), 0.08)
    for (const f of this.flickers) {
      const wave = Math.sin(elapsed * (5.3 + f.phase) + f.phase) * 0.5 + Math.sin(elapsed * 13.1 + f.phase * 2) * 0.18
      f.light.intensity = f.base * (1 + wave * f.amplitude)
    }
    const pos = this.dust.geometry.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, pos.getY(i) + step * (0.025 + (i % 7) * 0.002))
      if (pos.getY(i) > 3.7) pos.setY(i, 0.18 + (i % 11) * 0.27)
    }
    pos.needsUpdate = true
    for (const motion of this.motions) {
      if (motion.progress >= 1) continue
      motion.progress = Math.min(1, motion.progress + step / motion.duration)
      const eased = THREE.MathUtils.smoothstep(motion.progress, 0, 1)
      motion.target.object.position.lerpVectors(motion.start, motion.end, eased)
      motion.target.object.rotation.y = motion.startYaw + (motion.endYaw - motion.startYaw) * eased
    }
  }

  resetDoors(): void {
    this.motions.length = 0
    for (const target of this.targets) {
      for (const [from, to] of this.gatedNavigation.get(target.id) ?? []) {
        const a = this.node(from); if (a) a.links = a.links.filter(link => link !== to)
        const b = this.node(to); if (b) b.links = b.links.filter(link => link !== from)
      }
      const initial = this.initialDoors.get(target.id); if (!initial) continue
      if (target.collider) this.physics.world.removeCollider(target.collider, true)
      target.object.position.copy(initial.position); target.object.rotation.y = initial.yaw
      target.opened = false
      const mesh = target.object as THREE.Mesh; const size = mesh.geometry as THREE.BoxGeometry
      target.collider = this.physics.addStaticBox(initial.position, new THREE.Vector3(size.parameters.width, size.parameters.height, size.parameters.depth), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, initial.yaw, 0)))
    }
  }
  openDoor(id: string): boolean {
    const target = this.targets.find(t => t.id === id)
    if (!target || target.opened) return false
    target.opened = true
    if (target.collider) {
      this.physics.world.removeCollider(target.collider, true)
      target.collider = null
    }
    const obj = target.object
    const isBookcase = target.kind === 'secret-passage'
    for (const [from, to] of this.gatedNavigation.get(id) ?? []) { this.link(from, to); this.link(to, from) }
    const geometry = (obj as THREE.Mesh).geometry as THREE.BoxGeometry
    const sideOpening = geometry.parameters.depth > geometry.parameters.width
    const slide = isBookcase ? new THREE.Vector3(-1.45, 0, 0) : sideOpening ? new THREE.Vector3(0.78, 0, 0) : new THREE.Vector3(0, 0, 0.78)
    const motion: DoorMotion = {
      target, start: obj.position.clone(), end: obj.position.clone().add(slide),
      startYaw: obj.rotation.y, endYaw: obj.rotation.y + (isBookcase ? -0.42 : -Math.PI / 2), progress: 0, duration: 0.8,
    }
    this.motions.push(motion)
    return true
  }

  private buildGroundFloor(): void {
    this.box('ground floor', new THREE.Vector3(0, -0.2, 0), new THREE.Vector3(29, 0.4, 29), this.wood, true)
    // A stairwell cutout above the rising attic ramp keeps its walking headroom clear.
    this.box('north ceiling', new THREE.Vector3(0, 3.25, -3.35), new THREE.Vector3(29, 0.35, 22.3), this.darkWood, false)
    this.box('south ceiling', new THREE.Vector3(0, 3.25, 12.35), new THREE.Vector3(29, 0.35, 4.3), this.darkWood, false)
    this.box('west stairwell ceiling', new THREE.Vector3(-5.25, 3.25, 9), new THREE.Vector3(18.5, 0.35, 2.4), this.darkWood, false)
    // Exterior shell, with centered south entry and west-east/north-south room connections.
    this.wallX(-14.5, 0, 29, 3.25)
    this.wallX(14.5, -5.625, 17.75, 3.25); this.wallX(14.5, 6.325, 3.15, 3.25); this.wallX(14.5, 12.3, 4.4, 3.25)
    this.wallZ(-14.5, 0, 29, 3.25)
    this.wallZ(14.5, -7.7, 13.6, 3.25); this.wallZ(14.5, 7.7, 13.6, 3.25)
    this.box('front entry lintel', new THREE.Vector3(0, 2.67, 14.5), new THREE.Vector3(1.8, 1.16, 0.2), this.plaster, true)
    // Internal partitions align 2.55m door gaps with the room-navigation graph.
    for (const x of [-4.83, 4.83]) {
      this.wallX(x, -9, 9.7, 3.05, 2.55); this.wallX(x, 0, 8.3, 3.05, 2.55); this.wallX(x, 9, 9.7, 3.05, 2.55)
    }
    for (const z of [-4.83, 4.83]) {
      this.wallZ(z, -9, 9.7, 3.05, 2.55); this.wallZ(z, 0, 8.3, 3.05, 2.55); this.wallZ(z, 9, 9.7, 3.05, 2.55)
    }
    // Upper and lower narrow cross-corridors are real connected circulation lanes.
    this.addRoom('bed-west', 'Bedroom', -9, -9, 'bedroom'); this.addRoom('living', 'Living room', -9, 0, 'living')
    this.addRoom('bed-north', 'Bedroom', -9, 9, 'bedroom'); this.addRoom('kitchen', 'Kitchen', 0, -9, 'kitchen')
    this.addRoom('dining', 'Dining room', 0, 0, 'dining'); this.addRoom('study', 'Study', 0, 9, 'study')
    this.addRoom('storage', 'Storage', 9, -9, 'storage'); this.addRoom('bath', 'Bathroom', 9, 0, 'bathroom')
    this.addRoom('foyer', 'Foyer', 9, 9, 'foyer')
    // Southern porch/step is outside; no collision blocks the door gap.
    this.box('porch', new THREE.Vector3(0, -0.08, 15.7), new THREE.Vector3(5.8, 0.16, 3.2), this.trim, true)
  }

  private buildWing(): void {
    const wingX = 25
    this.room('basement', 'Basement', -3, wingX, 1, 'basement', wingX, 7)
    this.room('garage', 'Garage', -3, wingX, 1, 'garage', wingX, 17)
    this.box('basement slab', new THREE.Vector3(wingX, -3.2, 7), new THREE.Vector3(9, 0.4, 8), this.wood, true)
    this.box('garage slab', new THREE.Vector3(wingX, -3.2, 17), new THREE.Vector3(9, 0.4, 10), this.wood, true)
    this.shellRoom(wingX, -3, 7, 9, 8, { west: { center: 4, width: 2.3 }, south: { center: wingX, width: 2.3 } })
    this.shellRoom(wingX, -3, 17, 9, 10, { north: { center: wingX, width: 2.3 }, south: { center: wingX, width: 4.8 }, east: { center: 17, width: 2.1 } })
    // A 3m drop over 5.7m horizontal distance remains walkable and physically joined.
    this.ramp(new THREE.Vector3(14.8, 0, 4), new THREE.Vector3(20.5, -3, 4), 2.3, 0.18)

    // The attic shares the footprint above the service wing; its stairwell is cut through the ceiling.
    this.room('attic', 'Attic', 3, wingX, 1, 'attic', wingX, 9)
    this.box('attic floor', new THREE.Vector3(wingX, 3, 9), new THREE.Vector3(9, 0.35, 9), this.wood, true)
    this.shellRoom(wingX, 3, 9, 9, 9, { west: { center: 9, width: 2.3 }, north: { center: wingX, width: 2.8 } })
    this.ramp(new THREE.Vector3(4.4, 0, 9), new THREE.Vector3(20.5, 3, 9), 2.2, 0.14)

    this.room('passage', 'Secret passage', 3, wingX, 1, 'passage', wingX, 17)
    this.box('passage floor', new THREE.Vector3(wingX, 3, 17), new THREE.Vector3(9, 0.35, 5), this.darkWood, true)
    this.shellRoom(wingX, 3, 17, 9, 5, { south: { center: wingX, width: 2.8 } })

    this.box('lower ramp rail', new THREE.Vector3(17.65, -0.25, 5.2), new THREE.Vector3(6.6, 0.8, 0.16), this.trim, true)
    this.box('upper stair rail', new THREE.Vector3(12, 2.45, 10.18), new THREE.Vector3(14, 0.75, 0.16), this.trim, true)
    // Stop a ground-floor shortcut under the elevated ramp, while leaving the sloped walkway clear.
    this.box('stairwell lower barrier', new THREE.Vector3(14.5, 0.5, 9), new THREE.Vector3(0.2, 1, 2.2), this.trim, true)
  }

  private decorateRooms(): void {
    // Room-fit furniture leaves central door lanes clear; all blocking visible solids receive boxes.
    this.furniture('sofa', -10.2, 0.55, 0.2, 3.2, 1.1, 1.1, this.fabric)
    this.furniture('coffee table', -8.8, 0.42, -2.0, 1.8, 0.5, 1.0, this.wood)
    this.furniture('kitchen counter', 0, 0.9, -10.8, 5.4, 1.8, 0.7, this.darkWood)
    this.furniture('dining table', 0, 0.8, 0, 3.2, 1.5, 1.2, this.wood)
    this.furniture('study desk', 0, 0.8, 10.7, 2.5, 1.5, 1, this.wood)
    const wardrobe = new THREE.Group(); wardrobe.name='wardrobe'; this.scene.add(wardrobe)
    wardrobe.add(this.furniture('wardrobe back',-11.8,1.05,-12.3,1.4,2.1,.12,this.darkWood))
    wardrobe.add(this.furniture('wardrobe left',-12.45,1.05,-11.8,.12,2.1,1.1,this.darkWood))
    wardrobe.add(this.furniture('wardrobe right',-11.15,1.05,-11.8,.12,2.1,1.1,this.darkWood))
    wardrobe.add(this.furniture('wardrobe crown',-11.8,2.12,-11.8,1.4,.16,1.1,this.darkWood))
    wardrobe.add(this.furniture('wardrobe base',-11.8,.12,-11.8,1.4,.16,1.1,this.darkWood))
    const bedA=new THREE.Group(); bedA.name='bed A'; this.scene.add(bedA)
    bedA.add(this.furniture('bed A mattress',-8.8,.98,-10.2,2.3,.18,3.0,this.fabric))
    for(const [x,z] of [[-9.82,-11.55],[-7.78,-11.55],[-9.82,-8.85],[-7.78,-8.85]]) bedA.add(this.furniture('bed A leg',x,.43,z,.13,.86,.13,this.wood))
    const pillow=this.box('bed A pillow',new THREE.Vector3(-8.8,1.11,-11.15),new THREE.Vector3(1.15,.14,.58),this.fabric,false); bedA.add(pillow)
    const bedB=new THREE.Group(); bedB.name='bed B'; this.scene.add(bedB)
    bedB.add(this.furniture('bed B mattress',-11.7,.98,9.5,2.5,.18,3.0,this.fabric))
    for(const [x,z] of [[-12.82,8.15],[-10.58,8.15],[-12.82,10.85],[-10.58,10.85]]) bedB.add(this.furniture('bed B leg',x,.43,z,.13,.86,.13,this.wood))
    this.furniture('storage shelves', 10.7, 1.1, -10.6, 2.2, 2.2, 0.75, this.wood)
    this.furniture('bath vanity', 11.5, 0.8, 0, 1.4, 1.3, 0.7, this.wood)
    this.furniture('basement crates', 22.7, -2.1, 8.2, 1.2, 1.8, 1.2, this.darkWood)
    this.furniture('attic trunk', 22.1, 3.6, -10.3, 1.6, 1.2, 1.1, this.darkWood)
    // Rugs, trim bands, framed art and cobweb strands.
    for (const [x, z, w, d] of [[-9, 0, 5.2, 4], [0, 0, 5.4, 4.6], [9, 9, 4.8, 3.8], [0, 9, 4.3, 3.5]]) {
      const rug = new THREE.Mesh(new THREE.BoxGeometry(w, 0.025, d), this.rug); rug.position.set(x, 0.015, z); rug.receiveShadow = true; this.scene.add(rug)
    }
    for (const [x, z] of [[-14.46, -9], [-4.8, -14.46], [4.8, 14.46], [14.46, 0]]) this.picture(x, z)
    for (let i = 0; i < 12; i++) {
      const x = (this.rng() - 0.5) * 26, z = (this.rng() - 0.5) * 26
      this.line(new THREE.Vector3(x, 2.85, z), new THREE.Vector3(x + (this.rng() - 0.5) * 1.1, 2.35, z + 0.8), '#91877a', 0.009)
    }
    const blood = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.008, 0.16), mat('#391b1a', 1)); blood.position.set(-13.1, 0.025, 4.2); blood.rotation.y = 0.35; this.scene.add(blood)
    this.addHide('under-bed','Under the bedroom bed',new THREE.Vector3(-8.8,.37,-10.2),new THREE.Vector3(-8.8,.92,-8.35),new THREE.Vector3(-8.8,.92,-8.35),0,'bed',this.findFurniture('bed A'))
    this.addHide('wardrobe-hide','Inside the old wardrobe',new THREE.Vector3(-11.8,.95,-11.8),new THREE.Vector3(-11.8,.92,-11.1),new THREE.Vector3(-11.8,.92,-11.1),Math.PI,'wardrobe',this.findFurniture('wardrobe'))
    this.addHide('sofa-hide','Behind the living-room sofa',new THREE.Vector3(-11.5,.9,.2),new THREE.Vector3(-12.25,.9,.2),new THREE.Vector3(-12.25,.9,.2),Math.PI/2,'furniture',this.findFurniture('sofa'))
    this.addHide('basement-crates-hide','Behind basement storage crates',new THREE.Vector3(23.6,-2.25,8.6),new THREE.Vector3(24.05,-2.05,9.0),new THREE.Vector3(24.05,-2.05,9.0),Math.PI,'storage',this.findFurniture('basement crates'))
  }

  private addTargets(): void {
    this.makeDoor('front-exit', 'Front exit', 'front-exit', new THREE.Vector3(0, 1.05, 14.42), new THREE.Vector3(1.65, 2.1, 0.16), 0)
    this.makeDoor('basement-door', 'Locked basement door', 'basement-door', new THREE.Vector3(14.38, 1.05, 4), new THREE.Vector3(0.16, 2.1, 1.5), 0)
    this.makeDoor('attic-door', 'Attic stair door', 'attic-door', new THREE.Vector3(3.6, 1.05, 9), new THREE.Vector3(0.16, 2.1, 1.5), 0)
    this.makeDoor('basement-panel', 'Basement breaker panel', 'basement-panel', new THREE.Vector3(29.36, -1.7, 5.05), new THREE.Vector3(0.16, 1.2, 0.9), 0)
    this.makeDoor('garage-chain', 'Chained garage shutter', 'garage-chain', new THREE.Vector3(25, -1.65, 22), new THREE.Vector3(4.8, 2.7, 0.18), 0)
    this.makeDoor('garage-exit', 'Garage final exit', 'garage-exit', new THREE.Vector3(29.36, -1.8, 17), new THREE.Vector3(0.16, 2.4, 2.1), 0)
    this.makeDoor('secret-passage', 'Hidden bookcase passage', 'secret-passage', new THREE.Vector3(25, 4.15, 13.55), new THREE.Vector3(2.8, 2.3, 0.45), 0, true)
    // Door surround trim is fixed geometry; door leaves are removed only via openDoor.
    for (const t of this.targets) this.frameDoor(t)
  }

  private buildNavigation(): void {
    const entries: [string, string, number, number, number][] = [
      ['bed-west', 'bed-west', -7.1, 0.05, -9], ['living', 'living', -7.1, 0.05, 1.6], ['bed-north', 'bed-north', -9, 0.05, 9],
      ['kitchen', 'kitchen', 0, 0.05, -9], ['dining', 'dining', 2.05, 0.05, 1.75], ['study', 'study', 0, 0.05, 9],
      ['storage', 'storage', 9, 0.05, -9], ['bath', 'bath', 9, 0.05, 0], ['foyer', 'foyer', 9, 0.05, 9],
      ['hall-north', 'foyer', 0, 0.05, 6.7], ['hall-center', 'dining', 2.05, 0.05, -1.35], ['hall-south', 'dining', 0, 0.05, -6.7],
      ['east-hall-north', 'foyer', 9, 0.05, 6.2], ['east-hall-south', 'foyer', 9, 0.05, 3.2], ['basement-door-landing', 'foyer', 13.2, 0.05, 3.2],
      ['basement-ramp-top', 'basement', 15.1, -0.16, 4], ['basement-ramp-mid', 'basement', 16.8, -1.05, 4], ['basement-ramp-bottom', 'basement', 19.3, -2.35, 4],
      ['basement-entry', 'basement', 21.7, -2.95, 4], ['basement', 'basement', 25, -2.95, 7], ['basement-link', 'basement', 25, -2.95, 11.5], ['garage', 'garage', 25, -2.95, 17], ['garage-doorway', 'garage', 25, -2.95, 21],
      ['study-stair-base', 'study', 4.1, 0.05, 9], ['upper-ramp-mid', 'study', 10.5, 1.14, 9], ['attic-landing', 'attic', 17.3, 2.4, 9], ['attic', 'attic', 25, 3.05, 9], ['secret-passage', 'passage', 25, 3.05, 17],
    ]
    for (const [id, roomId, x, y, z] of entries) this.navNodes.push({ id, roomId, position: new THREE.Vector3(x, y, z), links: [] })
    const edges = [
      ['bed-west','living'], ['living','bed-north'], ['bed-west','kitchen'], ['living','dining'], ['bed-north','study'],
      ['kitchen','dining'], ['dining','study'], ['kitchen','storage'], ['dining','bath'], ['study','foyer'], ['storage','bath'], ['bath','foyer'],
      ['foyer','hall-north'], ['hall-north','hall-center'], ['hall-center','hall-south'], ['hall-south','living'], ['hall-north','study'],
      ['foyer','east-hall-north'], ['east-hall-north','east-hall-south'], ['east-hall-south','basement-door-landing'],
      ['basement-ramp-top','basement-ramp-mid'], ['basement-ramp-mid','basement-ramp-bottom'], ['basement-ramp-bottom','basement-entry'], ['basement-entry','basement'], ['basement','basement-link'], ['basement-link','garage'],
      ['study','study-stair-base'], ['upper-ramp-mid','attic-landing'], ['attic-landing','attic'],
    ]
    for (const [a, b] of edges) { this.link(a, b); this.link(b, a) }
    this.gatedNavigation.set('basement-door', [['basement-door-landing', 'basement-ramp-top']])
    this.gatedNavigation.set('garage-chain', [['garage', 'garage-doorway']])
    this.gatedNavigation.set('attic-door', [['study-stair-base', 'upper-ramp-mid']])
    this.gatedNavigation.set('secret-passage', [['attic', 'secret-passage']])
  }

  private addItemSpots(): void {
    const spots = [[-12,0],[-6,2],[-6,-12],[-13,11],[3.6,-12],[2,-7],[2,3],[2,11],[8,-12],[12,-5],[12,3],[12,11],[-2,12],[0,6],[-12,-4]]
    for (const [x,z] of spots) this.itemSpots.push(new THREE.Vector3(x, 0.35, z))
  }

  private addPracticalLights(): void {
    const positions: [number, number, number, string, number, number][] = [
      [-8,2.55,1,'#e8a96b',1.1,0.07], [0,2.55,-8,'#e4b578',1.0,0.09], [0,2.55,1,'#d3935d',1.2,0.1],
      [9,2.5,8,'#e6b77b',0.95,0.08], [0,2.55,10,'#a8badb',0.7,0.16], [10,2.5,-9,'#b6c9df',0.65,0.14],
      [20,-1.5,7,'#c08a55',0.8,0.15], [20,-1.45,17,'#9fb4cf',0.85,0.12], [20,4.7,-8,'#d49a62',0.8,0.1],
      [-9,2.55,-9,'#d6a06c',1.05,0.12], [-9,2.55,9,'#bf885f',0.95,0.14], [9,2.55,0,'#d9a979',1.05,0.12],
      [20,4.7,9,'#d4a46c',0.9,0.12], [20,4.7,17,'#9eabc4',0.85,0.16],
    ]
    positions.forEach(([x,y,z,color,intensity,amplitude]) => {
      const light = new THREE.PointLight(color, intensity, 12, 2); light.position.set(x,y,z); light.castShadow = false; this.scene.add(light)
      this.flickers.push({ light, base: intensity, phase: this.rng() * 8, amplitude })
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.6 }))
      lamp.position.copy(light.position); this.scene.add(lamp)
    })
  }

  private makeDust(): THREE.Points {
    const positions = new Float32Array(120 * 3)
    for (let i = 0; i < 120; i++) { positions[i*3] = (this.rng() - .5) * 27; positions[i*3+1] = .2 + this.rng() * 3; positions[i*3+2] = (this.rng() - .5) * 27 }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    return new THREE.Points(geometry, new THREE.PointsMaterial({ color: '#d6c4a4', size: 0.035, transparent: true, opacity: 0.34, depthWrite: false }))
  }

  private addRoom(id: string, name: string, x: number, z: number, kind: string): void { this.rooms.push({ id, name, floor: 0, center: new THREE.Vector3(x, 0, z), kind }) }
  private room(id: string, name: string, floor: number, _x: number, _z: number, kind: string, cx: number, cz: number): void { this.rooms.push({ id, name, floor, center: new THREE.Vector3(cx, floor, cz), kind }) }
  private shellRoom(
    cx: number, floor: number, cz: number, w: number, d: number,
    openings: Partial<Record<'west' | 'east' | 'north' | 'south', { center: number; width: number }>> = {},
  ): void {
    const y = floor + 1.5
    const wallAlongZ = (x: number, wallName: string, opening?: { center: number; width: number }): void => {
      const start = cz - d / 2; const end = cz + d / 2
      if (!opening) { this.box(wallName, new THREE.Vector3(x, y, cz), new THREE.Vector3(.2, 3, d), this.plaster, true); return }
      const gapStart = THREE.MathUtils.clamp(opening.center - opening.width / 2, start, end)
      const gapEnd = THREE.MathUtils.clamp(opening.center + opening.width / 2, start, end)
      const left = gapStart - start; const right = end - gapEnd
      if (left > .1) this.box(wallName, new THREE.Vector3(x, y, start + left / 2), new THREE.Vector3(.2, 3, left), this.plaster, true)
      if (right > .1) this.box(wallName, new THREE.Vector3(x, y, gapEnd + right / 2), new THREE.Vector3(.2, 3, right), this.plaster, true)
      this.box('wing door lintel', new THREE.Vector3(x, floor + 2.7, (gapStart + gapEnd) / 2), new THREE.Vector3(.22, .6, Math.max(.1, gapEnd - gapStart)), this.trim, true)
    }
    const wallAlongX = (z: number, wallName: string, opening?: { center: number; width: number }): void => {
      const start = cx - w / 2; const end = cx + w / 2
      if (!opening) { this.box(wallName, new THREE.Vector3(cx, y, z), new THREE.Vector3(w, 3, .2), this.plaster, true); return }
      const gapStart = THREE.MathUtils.clamp(opening.center - opening.width / 2, start, end)
      const gapEnd = THREE.MathUtils.clamp(opening.center + opening.width / 2, start, end)
      const left = gapStart - start; const right = end - gapEnd
      if (left > .1) this.box(wallName, new THREE.Vector3(start + left / 2, y, z), new THREE.Vector3(left, 3, .2), this.plaster, true)
      if (right > .1) this.box(wallName, new THREE.Vector3(gapEnd + right / 2, y, z), new THREE.Vector3(right, 3, .2), this.plaster, true)
      this.box('wing door lintel', new THREE.Vector3((gapStart + gapEnd) / 2, floor + 2.7, z), new THREE.Vector3(Math.max(.1, gapEnd - gapStart), .6, .22), this.trim, true)
    }
    wallAlongZ(cx - w / 2, 'wing west wall', openings.west)
    wallAlongZ(cx + w / 2, 'wing east wall', openings.east)
    wallAlongX(cz - d / 2, 'wing north wall', openings.north)
    wallAlongX(cz + d / 2, 'wing south wall', openings.south)
  }
  private wallX(x: number, z: number, length: number, height: number, gap = 0): void {
    const segment = (len: number, center: number) => { if (len > .1) this.box('plaster partition', new THREE.Vector3(x, height/2, center), new THREE.Vector3(.2,height,len), this.plaster, true) }
    if (gap) { segment((length-gap)/2, z-(length+gap)/4); segment((length-gap)/2, z+(length+gap)/4); this.box('partition lintel', new THREE.Vector3(x,height-.28,z), new THREE.Vector3(.2,.56,gap), this.plaster, true) }
    else segment(length,z)
  }
  private wallZ(z: number, x: number, length: number, height: number, gap = 0): void {
    const segment = (len: number, center: number) => { if (len > .1) this.box('plaster partition', new THREE.Vector3(center,height/2,z), new THREE.Vector3(len,height,.2), this.plaster, true) }
    if (gap) { segment((length-gap)/2, x-(length+gap)/4); segment((length-gap)/2, x+(length+gap)/4); this.box('partition lintel', new THREE.Vector3(x,height-.28,z), new THREE.Vector3(gap,.56,.2), this.plaster, true) }
    else segment(length,x)
  }
  private box(name: string, center: THREE.Vector3, size: THREE.Vector3, material: THREE.Material, collider: boolean, rotation?: THREE.Quaternion): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x,size.y,size.z), material); mesh.name=name; mesh.position.copy(center); if (rotation) mesh.quaternion.copy(rotation); mesh.castShadow=true; mesh.receiveShadow=true; this.scene.add(mesh)
    if (collider) this.physics.addStaticBox(center,size,rotation)
    return mesh
  }
  private furniture(name: string, x:number,y:number,z:number,w:number,h:number,d:number,material:THREE.Material): THREE.Mesh {
    return this.box(name,new THREE.Vector3(x,y,z),new THREE.Vector3(w,h,d),material,true)
  }
  private ramp(a: THREE.Vector3,b: THREE.Vector3,width:number,thickness:number): void {
    const delta=b.clone().sub(a); const horizontal=Math.hypot(delta.x,delta.z); const angle=Math.atan2(delta.y,horizontal); const center=a.clone().add(b).multiplyScalar(.5); center.y -= .05
    const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(0,0,angle))
    this.box('walkable sloped ramp',center,new THREE.Vector3(Math.hypot(horizontal,delta.y),thickness,width),this.wood,true,q)
  }
  private makeDoor(id:string,label:string,kind:TargetKind,position:THREE.Vector3,size:THREE.Vector3,yaw:number,bookcase=false):void {
    const material=bookcase?this.darkWood:this.wood; const obj=new THREE.Mesh(new THREE.BoxGeometry(size.x,size.y,size.z),material)
    obj.name=id; obj.position.copy(position); obj.rotation.y=yaw; obj.castShadow=true; obj.receiveShadow=true; this.scene.add(obj)
    const rot=new THREE.Quaternion().setFromEuler(new THREE.Euler(0,yaw,0)); const collider=this.physics.addStaticBox(position,size,rot)
    const interactionOffset = size.x < size.z ? new THREE.Vector3(-0.9,0.15,0) : new THREE.Vector3(0,0.15,0.9)
    this.targets.push({id,label,kind,position:position.clone().add(interactionOffset),object:obj,collider,opened:false})
    this.initialDoors.set(id, { position: position.clone(), yaw })
    if (bookcase) { const books=new THREE.Mesh(new THREE.BoxGeometry(2.5,1.8,.08),mat('#58432e')); books.position.set(0,0,.27); obj.add(books) }
  }
  private frameDoor(t:HouseTarget):void {
    const p=t.object.position
    if (t.kind === 'basement-panel') return
    const mesh=t.object as THREE.Mesh; const geometry=mesh.geometry as THREE.BoxGeometry
    const side=geometry.parameters.depth>geometry.parameters.width
    const span=side?geometry.parameters.depth:geometry.parameters.width
    const half=span/2+.08
    if (side) {
      const b=new THREE.Mesh(new THREE.BoxGeometry(.18,2.2,.14),this.trim); b.position.set(p.x-.11,p.y,p.z-half); this.scene.add(b)
      const c=b.clone(); c.position.z=p.z+half; this.scene.add(c)
      const top=new THREE.Mesh(new THREE.BoxGeometry(.18,.14,span+.22),this.trim); top.position.set(p.x-.11,p.y+1.1,p.z); this.scene.add(top)
    } else {
      const b=new THREE.Mesh(new THREE.BoxGeometry(.14,2.2,.18),this.trim); b.position.set(p.x-half,p.y,p.z-.11); this.scene.add(b)
      const c=b.clone(); c.position.x=p.x+half; this.scene.add(c)
      const top=new THREE.Mesh(new THREE.BoxGeometry(span+.22,.14,.18),this.trim); top.position.set(p.x,p.y+1.1,p.z-.11); this.scene.add(top)
    }
  }
  private addHide(id:string,label:string,position:THREE.Vector3,entry:THREE.Vector3,exit:THREE.Vector3,yaw:number,kind:HideSpot['kind'],mesh:THREE.Object3D):void { this.hideSpots.push({id,label,position,entry,exit,yaw,kind,mesh}) }
  private findFurniture(name:string):THREE.Object3D { return this.scene.getObjectByName(name) ?? this.scene }
  private link(a:string,b:string):void { const n=this.node(a), target=this.node(b); if(n&&target&&!n.links.includes(b))n.links.push(b) }
  private picture(x:number,z:number):void { const m=new THREE.Mesh(new THREE.BoxGeometry(.9,.65,.08),mat('#463427')); m.position.set(x,2,z); this.scene.add(m); const art=new THREE.Mesh(new THREE.BoxGeometry(.68,.44,.025),mat('#75604a')); art.position.set(x,2,z+.05); this.scene.add(art) }
  private line(a:THREE.Vector3,b:THREE.Vector3,color:string,width:number):void { const geo=new THREE.BufferGeometry().setFromPoints([a,b]); const line=new THREE.Line(geo,new THREE.LineBasicMaterial({color,transparent:true,opacity:.45,linewidth:width})); this.scene.add(line) }
}

function mat(color:string,roughness=0.9,metalness=0):THREE.MeshStandardMaterial { return new THREE.MeshStandardMaterial({color,roughness,metalness}) }
function distanceSq(a:THREE.Vector3,b:THREE.Vector3):number { return a.distanceToSquared(b) }
function seeded(seed:number):()=>number { let a=seed>>>0; return ()=>{a=(a+0x6d2b79f5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296} }
