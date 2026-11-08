import * as THREE from 'three'
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js'
import type { Input } from '../engine/input'
import { Physics, RAPIER } from '../engine/physics'
import type { Renderer } from '../engine/renderer'
import type { Quality } from '../engine/save'
import { HouseWorld, type HideSpot, type HouseTarget } from './houseWorld'
import { PigeonAI, type Difficulty, type PigeonState, type HeardEvent } from './pigeonAI'
import { ALL_ITEMS, ITEM_INFO, createPuzzleState, formatDuration, interactPuzzle, randomizeItems, scoreEscape, type ItemId, type PuzzleState, type EscapeRoute } from './horrorRules'
import type { HorrorAudio } from './horrorAudio'
import { CONFIG } from './config'
import { tuning } from './tuning'

export type GameMode = 'title' | 'playing' | 'paused' | 'caught' | 'escaped'
export type EscapeResult = { route: EscapeRoute; difficulty: Difficulty; elapsed: number; score: number; unranked: boolean }
export type GameHooks = {
  onHud?(hud: HorrorHUD): void
  onSave?(snapshot: HorrorSave | null): void
  onCaught?(reason: string): void
  onJumpscare?(active: boolean): void
  onVictory?(result: EscapeResult): void
  onMessage?(message: string): void
}
export type HorrorHUD = { prompt: string; state: string; inventory: Array<{id: ItemId; label: string; selected: boolean}>; stamina: number; flashlight: boolean; battery: number; elapsed: string; hidden: boolean; chase: boolean; heartbeat: number; difficulty: Difficulty }
export type HorrorSave = { version: 1; seed: number; difficulty: Difficulty; elapsed: number; position: [number,number,number]; yaw: number; pitch: number; stamina: number; flashlightOn: boolean; flashlightCharge: number; inventory: ItemId[]; selected: ItemId|null; picked: ItemId[]; drops: Array<{id: ItemId; position:[number,number,number]}>; puzzle: PuzzleState; atticDoorOpen: boolean; hidden: boolean; hideId?: string|null; crouched: boolean; mode?: 'playing' }
export type HorrorSettings = { fov?: number; sensitivity?: number; quality?: Quality; flashlightDrain?: number; cameraMovement?: number }
type Settings = HorrorSettings
type WorldItem = { id: ItemId; mesh: THREE.Mesh; position: THREE.Vector3 }
type InteractionCandidate = { kind: 'item'; value: WorldItem; distance: number } | { kind: 'hide'; value: HideSpot; distance: number } | { kind: 'target'; value: HouseTarget; distance: number }
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,Number.isFinite(v)?v:a))
const validDifficulty=(x:unknown):x is Difficulty=>x==='easy'||x==='normal'||x==='hard'||x==='nightmare'

/** Owns the navigable survival-horror simulation. */
export class Game {
  mode: GameMode='title'
  readonly physics: Physics
  readonly world: HouseWorld
  readonly camera=new THREE.PerspectiveCamera(74,1,.05,90)
  private readonly scene: THREE.Scene
  private readonly playerBody: RAPIER.RigidBody
  private collider: RAPIER.Collider
  private readonly controller: RAPIER.KinematicCharacterController
  private readonly pigeon: THREE.Object3D
  private ai: PigeonAI
  private readonly enemy=new THREE.Vector3(9,.05,9); private readonly enemyBody:RAPIER.RigidBody; private readonly enemyCollider:RAPIER.Collider; private readonly enemyController:RAPIER.KinematicCharacterController
  private readonly inventory=new Set<ItemId>()
  private readonly picked=new Set<ItemId>()
  private readonly drops: Array<{id:ItemId;position:THREE.Vector3}> = []
  private items: WorldItem[]=[]
  private yaw=0; private pitch=0; private stamina=100; private charge=100; private flashlightOn=false
  private crouched=false; private hiddenSpot:HideSpot|null=null; private cameraY=.25; private elapsed=0; private sim=0; private seed=1; private difficulty:Difficulty='normal'; private puzzle:PuzzleState=createPuzzleState(); private atticDoorOpen=false
  private enemyYaw=0; private colliderCrouched=false; private enemyState:PigeonState='PATROL'; private heartbeat=0; private prompt=''; private message=''; private lastStep=0; private caughtTimer=0; private caughtAge=0; private caughtReason='Pigeonman caught you.'; private readonly caughtPlayer=new THREE.Vector3(); private readonly caughtEnemy=new THREE.Vector3(); private victoryTimer=0; private fov=74; private cameraMovement=1; private unranked=false
  private readonly direction=new THREE.Vector3(); private readonly heard:HeardEvent[]=[]; private readonly glow:THREE.SpotLight
  constructor(private readonly renderer:Renderer, private readonly input:Input, private readonly audio:HorrorAudio, pigeonTemplate:THREE.Object3D, private readonly hooks:GameHooks={}) {
    this.physics=new Physics(-22); this.world=new HouseWorld(this.physics,1); this.scene=this.world.scene
    const desc=RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.world.spawn.x,this.world.spawn.y,this.world.spawn.z)
    this.playerBody=this.physics.world.createRigidBody(desc)
    this.collider=this.physics.world.createCollider(RAPIER.ColliderDesc.capsule(.48,.27).setFriction(0),this.playerBody)
    this.controller=this.physics.world.createCharacterController(.04); this.controller.setSlideEnabled(true); this.controller.setMaxSlopeClimbAngle(.72); this.controller.setMinSlopeSlideAngle(.85)
    this.pigeon=skeletonClone(pigeonTemplate)
    this.pigeon.name='Pigeonman'; this.pigeon.scale.setScalar(1); this.pigeon.traverse(o=>{if((o as THREE.SkinnedMesh).isSkinnedMesh)(o as THREE.SkinnedMesh).frustumCulled=false})
    const box=new THREE.Box3().setFromObject(this.pigeon); if(Number.isFinite(box.min.y)){const modelScale=1.9/Math.max(.001,box.max.y-box.min.y);this.pigeon.scale.setScalar(modelScale);this.pigeon.position.y=-box.min.y*modelScale}
    this.scene.add(this.pigeon); this.enemyBody=this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(9,.95,9)); this.enemyCollider=this.physics.world.createCollider(RAPIER.ColliderDesc.capsule(.72,.30).setFriction(0),this.enemyBody); this.enemyController=this.physics.world.createCharacterController(.05); this.enemyController.setSlideEnabled(true); this.enemyController.setMaxSlopeClimbAngle(.78); this.ai=new PigeonAI(this.world.navNodes,'foyer')
    this.glow=new THREE.SpotLight('#d7e7ff',0,22,Math.PI/5,.5,1.25); this.glow.castShadow=false; this.scene.add(this.glow,this.glow.target)
    this.camera.rotation.order='YXZ'; this.camera.fov=CONFIG.camera.fov; this.camera.updateProjectionMatrix()
    this.resetItems()
  }
  startAttempt(difficulty:Difficulty):void { if(!validDifficulty(difficulty))difficulty='normal'; tuning.activate('run'); this.unranked=tuning.unranked; this.seed=Math.floor(Math.random()*0x7fffffff)||1; this.difficulty=difficulty; this.resetRun(); this.mode='playing'; this.emit('The house is quiet. Find a way out.'); this.save() }
  continueAttempt(save:HorrorSave):boolean { if(!this.validSave(save))return false; this.seed=save.seed;this.difficulty=save.difficulty;this.resetRun();this.elapsed=save.elapsed;this.playerBody.setTranslation({x:save.position[0],y:save.position[1],z:save.position[2]},true);this.yaw=save.yaw;this.pitch=save.pitch;this.stamina=save.stamina;this.flashlightOn=save.flashlightOn;this.charge=save.flashlightCharge;save.inventory.forEach(i=>this.inventory.add(i));save.picked.forEach(i=>this.picked.add(i));this.puzzle={...save.puzzle};this.atticDoorOpen=save.atticDoorOpen;for(const [key,id] of [['basementDoorOpen','basement-door'],['secretPassageOpen','secret-passage'],['frontDoorOpen','front-exit'],['garageDoorOpen','garage-exit']] as const)if(this.puzzle[key])this.world.openDoor(id);if(this.atticDoorOpen)this.world.openDoor('attic-door');this.crouched=save.hidden?true:save.crouched;this.hiddenSpot=save.hidden?(this.world.hideSpots.find(h=>h.id===save.hideId)??null):null;this.selected=save.selected&&this.inventory.has(save.selected)?save.selected:null;this.drops.splice(0,this.drops.length,...save.drops.map(d=>({id:d.id,position:new THREE.Vector3(...d.position)})));this.resetItems();this.mode='playing';this.refreshHud();return true }
  restart(difficulty:Difficulty):void{this.startAttempt(difficulty)}
  selectItem(itemName:string):boolean{const entry=ALL_ITEMS.find(id=>ITEM_INFO[id].name===itemName||id===itemName);if(!entry||!this.inventory.has(entry))return false;this.selected=entry;this.refreshHud();return true}
  pause():void{if(this.mode==='playing'){this.mode='paused';this.audio.update(0,{enemyDistance:this.enemy.distanceTo(this.playerPosition()),chasing:false,paused:true,hidden:!!this.hiddenSpot})}}
  resume():void{if(this.mode==='paused'){this.mode='playing';this.input.takeLook();this.input.endFrame()}}
  toTitle():void{if(this.mode==='playing'||this.mode==='paused')this.hooks.onSave?.(this.makeSave());this.mode='title';this.input.takeLook()}
  setSettings(settings:Settings):void {if(settings.fov!==undefined){this.fov=clamp(settings.fov,55,95);CONFIG.camera.fov=this.fov;this.camera.fov=this.fov;this.camera.updateProjectionMatrix()}if(settings.cameraMovement!==undefined)this.cameraMovement=clamp(settings.cameraMovement,.2,3);if(settings.flashlightDrain!==undefined)CONFIG.horror.flashlightDrain=clamp(settings.flashlightDrain,.25,1.8);if(settings.quality)this.setQuality(settings.quality)}
  setQuality(q:Quality):void{this.renderer.applyQuality(q);this.world.scene.traverse(o=>{const m=(o as THREE.Mesh).material;for(const x of Array.isArray(m)?m:m?[m]:[])x.needsUpdate=true})}
  snapshot():HorrorSave|null{return this.mode==='playing'?this.makeSave():null}
  hud():HorrorHUD{return {prompt:this.prompt,state:this.message||this.enemyState,inventory:[...this.inventory].map(id=>({id,label:ITEM_INFO[id].name,selected:id===this.selected})),stamina:this.stamina,flashlight:this.flashlightOn,battery:this.charge,elapsed:formatDuration(this.elapsed),hidden:!!this.hiddenSpot,chase:this.enemyState==='CHASE'||this.enemyState==='ATTACK',heartbeat:this.heartbeat,difficulty:this.difficulty}}
  debugState(){const p=this.playerPosition();return {mode:this.mode,elapsed:this.elapsed,player:[p.x,p.y,p.z] as [number,number,number],enemy:[this.enemy.x,this.enemy.y,this.enemy.z] as [number,number,number],enemyState:this.enemyState,crouched:this.crouched,heard:this.heard.map(e=>e.source),lastAudible:this.ai.debugLastHeardPosition(),inventory:[...this.inventory],itemsRemaining:this.items.filter(i=>!this.picked.has(i.id)).length}}
  step(dt:number):void {
    const d=clamp(dt,0,.05); if(!d)return; this.sim+=d; if(this.mode==='caught'){this.caughtTimer-=d;this.caughtAge+=d;if(this.caughtTimer<=0){this.mode='title';this.hooks.onJumpscare?.(false);this.hooks.onCaught?.(this.caughtReason)}return} if(this.mode==='escaped'){this.victoryTimer-=d;if(this.victoryTimer<=0)this.mode='title';return} if(this.mode!=='playing'){this.input.consume('interact');this.input.consume('jump');return}
    this.elapsed+=d; const wasCrouched=this.crouched; const requestedCrouch=this.input.held('crouch'); const p=this.playerPosition(); const look=this.input.takeLook(); this.yaw-=look.x*this.cameraMovement;this.pitch=clamp(this.pitch-look.y*this.cameraMovement,-1.48,1.48)
    if(!this.hiddenSpot&&this.input.consume('flashlight')){this.flashlightOn=!this.flashlightOn&&this.charge>0;this.emit(this.flashlightOn?'Flashlight on.':'Flashlight off.');this.noise(p,.18,'switch')}
    if(this.flashlightOn){this.charge=Math.max(0,this.charge-CONFIG.horror.flashlightDrain*d);if(this.charge===0)this.flashlightOn=false}
    if(this.input.consume('drop'))this.dropSelected(p)
    for(let n=1;n<=9;n++)if(this.input.consumeCode(`Digit${n}`)){const id=[...this.inventory][n-1]; if(id)this.selected=id}
    if(!this.hiddenSpot)this.crouched=requestedCrouch; const speed=this.crouched?1.45:this.input.held('sprint')&&this.stamina>0?CONFIG.player.sprintSpeed:CONFIG.player.walkSpeed
    const sprint=!this.hiddenSpot&&this.input.held('sprint')&&!this.crouched&&this.stamina>0;this.stamina=clamp(this.stamina+(sprint?-25:14)*d,0,100)
    const fw=new THREE.Vector3(-Math.sin(this.yaw),0,-Math.cos(this.yaw)),rt=new THREE.Vector3(Math.cos(this.yaw),0,-Math.sin(this.yaw));const move=this.hiddenSpot?new THREE.Vector3():fw.multiplyScalar(this.input.move.y).add(rt.multiplyScalar(this.input.move.x));if(move.lengthSq()>1)move.normalize()
    let vel=new THREE.Vector3(move.x*speed,0,move.z*speed);const t=this.playerBody.translation();let vy=0;if(wasCrouched!==this.crouched){this.setPlayerCapsule(this.crouched);t.y=this.playerBody.translation().y;this.lastY=t.y}else{vy=(t.y-this.lastY)/d;this.lastY=t.y;if(Math.abs(vy)<.03)vy=0}
    if(this.input.consume('jump')&&!this.hiddenSpot&&!this.crouched&&this.controller.computedGrounded())vy=CONFIG.player.jumpSpeed
    vel.y=vy+CONFIG.player.gravity*d;vel.y=Math.max(vel.y,-20)
    this.controller.computeColliderMovement(this.collider,{x:vel.x*d,y:vel.y*d,z:vel.z*d});const delta=this.controller.computedMovement();this.playerBody.setNextKinematicTranslation({x:t.x+delta.x,y:t.y+delta.y,z:t.z+delta.z})
    if(!this.hiddenSpot&&!this.crouched&&move.lengthSq()>.1){if(this.sim-this.lastStep>(sprint?.27:.48)){this.lastStep=this.sim;this.audio.cue('player-footstep',sprint?.82:.48);this.noise(p,sprint?1.1:.72,sprint?'footstep-run':'footstep-walk')}}
    if(this.hiddenSpot){if(this.input.consume('interact')){const spot=this.hiddenSpot;this.hiddenSpot=null;this.crouched=true;this.setPlayerCapsule(false);this.crouched=false;const standingY=spot.exit.y-.17;this.playerBody.setTranslation({x:spot.exit.x,y:standingY,z:spot.exit.z},true);this.lastY=standingY;this.emit('You leave your hiding place.')}} else if(this.input.consume('interact'))this.interact(p)
    const now=this.sim;const baseHear={easy:13,normal:20,hard:24,nightmare:28}[this.difficulty];this.heard.splice(0,this.heard.length,...this.heard.filter(e=>now-e.time<6&&e.position.distanceTo(this.enemy)<baseHear*(e.source==='footstep-run'?1.45:1)*CONFIG.enemy.hearingMultiplier));const enemy=this.enemy;const out=this.ai.update({now,dt:d,enemyPosition:enemy,hidden:!!this.hiddenSpot,difficulty:this.difficulty,heard:this.heard});this.enemyState=out.state;this.heartbeat=out.heartbeat
    const target=out.target;const nearest=this.world.navNodes.reduce((a,b)=>b.position.distanceToSquared(target)<a.position.distanceToSquared(target)?b:a,this.world.navNodes[0]);const nextTarget=nearest?.position??target;const et=this.enemyBody.translation();const enemyMove=new THREE.Vector3(nextTarget.x-et.x,nextTarget.y+.9-et.y,nextTarget.z-et.z);if(enemyMove.length()>.12){enemyMove.normalize().multiplyScalar(out.speed*CONFIG.enemy.speedMultiplier*d);this.enemyController.computeColliderMovement(this.enemyCollider,{x:enemyMove.x,y:enemyMove.y,z:enemyMove.z});const em=this.enemyController.computedMovement();this.enemyBody.setNextKinematicTranslation({x:et.x+em.x,y:et.y+em.y,z:et.z+em.z});if(Math.hypot(em.x,em.z)>.001)this.enemyYaw=Math.atan2(-em.x,-em.z)}
    if(out.changed){if(out.state==='CHASE'||out.state==='ATTACK')this.audio.cue('chase-sting',.8);if(out.state==='SEARCH')this.audio.cue('coo',.35)}if(this.sim%1<d)this.audio.cue('enemy-footstep',out.state==='CHASE'?.6:.28)
    if(out.caught){this.mode='caught';this.caughtTimer=1.2;this.caughtAge=0;this.caughtReason='Pigeonman caught you.';this.caughtPlayer.copy(p);this.caughtEnemy.copy(enemy);this.audio.cue('jumpscare');this.hooks.onJumpscare?.(true);this.emit('Pigeonman found you.');this.hooks.onSave?.(null)}
    this.physics.step(d);this.physics.sync(1);const enemyPos=this.enemyBody.translation();this.enemy.set(enemyPos.x,enemyPos.y-.9,enemyPos.z);this.world.update(this.elapsed,d);this.updateItems(p);this.updatePrompt(p);this.audio.update(d,{enemyDistance:enemy.distanceTo(p),chasing:out.state==='CHASE'||out.state==='ATTACK',paused:false,hidden:!!this.hiddenSpot});this.refreshHud();if(Math.floor(this.elapsed*2)!==Math.floor((this.elapsed-d)*2))this.save()
  }
  render(_alpha: number, frameSeconds: number): void {
    this.physics.sync(1)
    const p = this.playerPosition()
    this.cameraY = THREE.MathUtils.damp(this.cameraY, this.hiddenSpot ? .10 : this.crouched ? .32 : .68, 12, frameSeconds)
    this.camera.position.set(p.x, p.y + this.cameraY, p.z)
    if (this.mode === 'caught') this.renderCaught(p)
    else {
      this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ')
      this.pigeon.position.set(this.enemy.x, this.enemy.y, this.enemy.z)
      this.pigeon.rotation.y = this.enemyYaw
      this.camera.fov = CONFIG.camera.fov
      this.camera.updateProjectionMatrix()
    }
    this.direction.set(0, 0, -1).applyQuaternion(this.camera.quaternion)
    this.glow.position.copy(this.camera.position)
    this.glow.target.position.copy(this.camera.position).addScaledVector(this.direction, 2)
    this.glow.intensity = this.flashlightOn ? 12 : 0
    this.renderer.render(this.scene, this.camera)
  }

  private renderCaught(player: THREE.Vector3): void {
    const progress = clamp(this.caughtAge / 1.2, 0, 1)
    const eased = progress * progress * (3 - 2 * progress)
    const away = new THREE.Vector3(this.caughtEnemy.x - this.caughtPlayer.x, 0, this.caughtEnemy.z - this.caughtPlayer.z)
    const startDistance = away.length()
    if (startDistance < .05) away.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw))
    else away.normalize()
    const distance = THREE.MathUtils.lerp(Math.max(.68, startDistance), .50, eased)
    this.enemy.set(player.x + away.x * distance, player.y - .87, player.z + away.z * distance)
    this.enemyBody.setTranslation({ x: this.enemy.x, y: player.y, z: this.enemy.z }, true)
    this.pigeon.position.copy(this.enemy)
    const toPlayer = new THREE.Vector3(player.x - this.enemy.x, 0, player.z - this.enemy.z)
    this.enemyYaw = Math.atan2(-toPlayer.x, -toPlayer.z)
    const shake = 1 - progress * .38
    this.camera.lookAt(this.enemy.x, this.enemy.y + 1.48, this.enemy.z)
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
    this.camera.position.addScaledVector(right, Math.sin(this.caughtAge * 77) * .045 * shake)
    this.camera.position.y += Math.sin(this.caughtAge * 101) * .028 * shake
    this.camera.rotateZ(Math.sin(this.caughtAge * 59) * .055 * shake)
    this.camera.fov = Math.max(44, CONFIG.camera.fov - 25 * eased)
    this.camera.updateProjectionMatrix()
  }
  private selected:ItemId|null=null; private lastY=0
  private setPlayerCapsule(crouch:boolean):void{const t=this.playerBody.translation();const bottom=t.y-(this.colliderCrouched?.51:.75);this.physics.world.removeCollider(this.collider,true);this.collider=this.physics.world.createCollider(RAPIER.ColliderDesc.capsule(crouch?.24:.48,.27).setFriction(0),this.playerBody);const center=bottom+(crouch?.51:.75);this.playerBody.setTranslation({x:t.x,y:center,z:t.z},true);this.colliderCrouched=crouch;this.lastY=center}
  private playerPosition():THREE.Vector3{const t=this.playerBody.translation();return new THREE.Vector3(t.x,t.y,t.z)}
  private validSave(s:HorrorSave):boolean{try{const keys=Object.keys(createPuzzleState()) as (keyof PuzzleState)[];return !!s&&s.version===1&&Number.isInteger(s.seed)&&s.seed>0&&validDifficulty(s.difficulty)&&Number.isFinite(s.elapsed)&&s.elapsed>=0&&s.elapsed<1e7&&Array.isArray(s.position)&&s.position.length===3&&s.position.every(Number.isFinite)&&Math.abs(s.position[0])<40&&s.position[1]>-8&&s.position[1]<12&&Math.abs(s.position[2])<30&&Number.isFinite(s.yaw)&&Math.abs(s.yaw)<1000&&Number.isFinite(s.pitch)&&Math.abs(s.pitch)<=1.49&&Number.isFinite(s.stamina)&&s.stamina>=0&&s.stamina<=100&&typeof s.flashlightOn==='boolean'&&Number.isFinite(s.flashlightCharge)&&s.flashlightCharge>=0&&s.flashlightCharge<=100&&Array.isArray(s.inventory)&&s.inventory.every(i=>ALL_ITEMS.includes(i))&&new Set(s.inventory).size===s.inventory.length&&Array.isArray(s.picked)&&s.picked.every(i=>ALL_ITEMS.includes(i))&&new Set(s.picked).size===s.picked.length&&s.puzzle&&keys.every(k=>typeof s.puzzle[k]==='boolean')&&typeof s.atticDoorOpen==='boolean'&&typeof s.hidden==='boolean'&&typeof s.crouched==='boolean'&&(s.hideId===undefined||s.hideId===null||this.world.hideSpots.some(h=>h.id===s.hideId))&&(!s.hidden||this.world.hideSpots.some(h=>h.id===s.hideId))&&((s.selected===null)||ALL_ITEMS.includes(s.selected))&&Array.isArray(s.drops)&&s.drops.length<=ALL_ITEMS.length&&s.drops.every((d,i)=>!!d&&typeof d==='object'&&ALL_ITEMS.includes(d.id)&&Array.isArray(d.position)&&d.position.length===3&&d.position.every(Number.isFinite)&&Math.abs(d.position[0])<40&&d.position[1]>-8&&d.position[1]<12&&Math.abs(d.position[2])<30&&s.drops.slice(0,i).every(q=>q.id!==d.id))}catch{return false}}
  private makeSave():HorrorSave{return {version:1,seed:this.seed,difficulty:this.difficulty,elapsed:this.elapsed,position:[...this.playerPosition().toArray()] as [number,number,number],yaw:this.yaw,pitch:this.pitch,stamina:this.stamina,flashlightOn:this.flashlightOn,flashlightCharge:this.charge,inventory:[...this.inventory],selected:this.selected,picked:[...this.picked],drops:this.drops.map(x=>({id:x.id,position:[x.position.x,x.position.y,x.position.z]})),puzzle:{...this.puzzle},atticDoorOpen:this.atticDoorOpen,hidden:!!this.hiddenSpot,hideId:this.hiddenSpot?.id??null,crouched:this.crouched,mode:'playing'}}
  private save():void{if(this.mode==='playing')this.hooks.onSave?.(this.makeSave())}
  private resetRun():void{this.world.resetDoors();this.inventory.clear();this.picked.clear();this.drops.length=0;this.selected=null;this.puzzle=createPuzzleState();this.atticDoorOpen=false;this.elapsed=0;this.stamina=100;this.charge=100;this.flashlightOn=false;this.hiddenSpot=null;this.crouched=false;this.colliderCrouched=false;this.yaw=this.world.spawnYaw;this.pitch=0;this.enemy.set(9,.05,9);this.enemyBody.setTranslation({x:9,y:.95,z:9},true);this.playerBody.setTranslation({x:this.world.spawn.x,y:this.world.spawn.y,z:this.world.spawn.z},true);this.setPlayerCapsule(false);this.lastY=this.world.spawn.y;this.sim=0;this.heard.length=0;this.lastStep=0;this.enemyYaw=0;this.resetItems();this.ai=new PigeonAI(this.world.navNodes,'foyer');this.enemyState='PATROL';this.heartbeat=0}
  private resetItems():void{for(const item of this.items){this.scene.remove(item.mesh);item.mesh.geometry.dispose();(item.mesh.material as THREE.Material).dispose()}this.items=[];for(const {item:id,position:pos} of randomizeItems(this.seed,this.world.itemSpots)){const mesh=new THREE.Mesh(new THREE.BoxGeometry(.22,.16,.14),new THREE.MeshStandardMaterial({color:0xc29b55,metalness:.55,roughness:.4,emissive:0x251600}));mesh.position.copy(pos);mesh.name=`item:${id}`;mesh.castShadow=true;this.scene.add(mesh);this.items.push({id,mesh,position:pos.clone()})}this.applyDrops()}
  private applyDrops():void{for(const drop of this.drops){const mesh=new THREE.Mesh(new THREE.BoxGeometry(.2,.13,.13),new THREE.MeshStandardMaterial({color:0xb99a60,metalness:.4}));mesh.position.copy(drop.position);mesh.name=`drop:${drop.id}`;mesh.userData.dropInstance=true;this.scene.add(mesh);this.items.push({id:drop.id,mesh,position:drop.position.clone()})}}
  private updateItems(p:THREE.Vector3):void{for(const item of this.items){if(item.mesh.userData.dropInstance?item.position.distanceTo(p)>.85:this.picked.has(item.id)||item.position.distanceTo(p)>.85)continue;if(this.input.consume('interact')){this.inventory.add(item.id);if(!item.mesh.userData.dropInstance)this.picked.add(item.id);else this.drops.splice(this.drops.findIndex(x=>x.id===item.id&&x.position.equals(item.position)),1);this.selected??=item.id;item.mesh.visible=false;this.audio.cue('pickup');this.emit(`Picked up ${ITEM_INFO[item.id].name}.`);this.noise(p,.15,'pickup');this.save();break}}}
  private updatePrompt(p: THREE.Vector3): void {
    if (this.hiddenSpot) { this.prompt = 'E — Leave hiding place'; return }
    let best = Infinity
    let prompt = ''
    for (const item of this.items) {
      if (!item.mesh.userData.dropInstance && this.picked.has(item.id)) continue
      const d = p.distanceTo(item.position)
      if (d < 1.3 && d < best) { best = d; prompt = `E — Pick up ${ITEM_INFO[item.id].name}` }
    }
    for (const spot of this.world.hideSpots) {
      const d = p.distanceTo(spot.entry)
      if (d < 1.7 && d < best) { best = d; prompt = `E — Hide: ${spot.label}` }
    }
    for (const target of this.world.targets) {
      const d = p.distanceTo(target.position)
      if (d < 2.5 && d < best) { best = d; prompt = `E — ${target.label}` }
    }
    this.prompt = prompt
  }

  private interact(p: THREE.Vector3): void {
    if (this.hiddenSpot) {
      const spot = this.hiddenSpot
      this.hiddenSpot = null
      this.crouched = true
      this.setPlayerCapsule(false)
      this.crouched = false
      const standingY = spot.exit.y - 0.17
      this.playerBody.setTranslation({ x: spot.exit.x, y: standingY, z: spot.exit.z }, true)
      this.lastY = standingY
      this.emit('You leave your hiding place.')
      return
    }

    const candidates: InteractionCandidate[] = []
    for (const target of this.world.targets) {
      const distance = p.distanceTo(target.position)
      if (distance < 2.5) candidates.push({ kind: 'target', value: target, distance })
    }
    for (const spot of this.world.hideSpots) {
      const distance = p.distanceTo(spot.entry)
      if (distance < 1.7) candidates.push({ kind: 'hide', value: spot, distance })
    }
    for (const item of this.items) {
      if (!item.mesh.userData.dropInstance && this.picked.has(item.id)) continue
      const distance = p.distanceTo(item.position)
      if (distance < 1.3) candidates.push({ kind: 'item', value: item, distance })
    }
    const closest = candidates.reduce<InteractionCandidate | null>((best, candidate) =>
      !best || candidate.distance < best.distance ? candidate : best, null)
    if (!closest) { this.emit('Nothing within reach.'); return }

    if (closest.kind === 'hide') {
      const spot = closest.value
      this.hiddenSpot = spot
      this.crouched = true
      const floor = this.world.nearestRoom(spot.position).floor
      this.playerBody.setTranslation({ x: spot.position.x, y: floor + 0.75, z: spot.position.z }, true)
      this.setPlayerCapsule(true)
      this.yaw = spot.yaw
      this.emit(`Hiding: ${spot.label}. Press E to leave.`)
      return
    }

    if (closest.kind === 'item') {
      const item = closest.value
      this.inventory.add(item.id)
      if (item.mesh.userData.dropInstance) {
        this.drops.splice(this.drops.findIndex(drop => drop.id === item.id && drop.position.equals(item.position)), 1)
      } else this.picked.add(item.id)
      this.selected ??= item.id
      item.mesh.visible = false
      this.audio.cue('pickup')
      this.emit(`Picked up ${ITEM_INFO[item.id].name}.`)
      this.noise(p, 0.15, 'pickup')
      this.save()
      return
    }

    const target = closest.value
    if (target.kind === 'attic-door') {
      if (!this.atticDoorOpen) {
        if (!this.inventory.has('hammer')) { this.emit('The attic latch is nailed shut. A hammer could break it.'); return }
        this.atticDoorOpen = this.openDoor(target.id)
      }
      this.emit('The attic stair opens.')
      return
    }

    const puzzleTarget: Record<string, Parameters<typeof interactPuzzle>[1] | undefined> = {
      'front-exit': 'front-exit',
      'basement-door': 'basement-door',
      'secret-passage': 'secret-passage',
      'basement-panel': 'basement-panel',
      'garage-chain': 'garage-chain',
      'garage-exit': 'garage-exit',
    }
    const key = puzzleTarget[target.kind]
    if (!key) { this.emit('It will not move.'); return }
    const resolution = interactPuzzle(this.puzzle, key, this.selected, this.inventory)
    this.puzzle = resolution.state
    for (const item of resolution.consumed) this.inventory.delete(item)
    if (resolution.openedDoor) this.openDoor(resolution.openedDoor)
    this.emit(resolution.message)
    this.audio.cue('puzzle')
    this.noise(p, 0.4, 'puzzle')
    if (resolution.escaped) this.escape(resolution.escaped)
    this.save()
  }
  private dropSelected(p:THREE.Vector3):void{if(!this.selected||!this.inventory.has(this.selected)){this.emit('Select an item first.');return}const id=this.selected;this.inventory.delete(id);const at=p.clone().add(new THREE.Vector3(-Math.sin(this.yaw),0,-Math.cos(this.yaw)).multiplyScalar(.8));this.drops.push({id,position:at});this.items.push({id,position:at,mesh:new THREE.Mesh(new THREE.BoxGeometry(.2,.13,.13),new THREE.MeshStandardMaterial({color:0xb99a60}))});const item=this.items[this.items.length-1];item.mesh.position.copy(at);item.mesh.userData.dropInstance=true;this.scene.add(item.mesh);this.selected=null;this.noise(at,1.25,`drop-${id}-${this.sim.toFixed(2)}`);this.audio.cue('thump');this.emit(`${ITEM_INFO[id].name} dropped.`);this.save()}
  private openDoor(id:string):boolean{const opened=this.world.openDoor(id);if(opened){this.audio.cue('door',.9);this.noise(this.playerPosition(),.52,'door')}return opened}
  private escape(route:EscapeRoute):void{if(this.mode!=='playing')return;this.mode='escaped';this.victoryTimer=1.4;this.audio.cue('escape');this.hooks.onSave?.(null);this.hooks.onVictory?.({route,difficulty:this.difficulty,elapsed:this.elapsed,score:scoreEscape(this.difficulty,this.elapsed),unranked:this.unranked||tuning.unranked})}
  private noise(p:THREE.Vector3,strength:number,source:string):void{if(source!=='footstep-walk'&&source!=='footstep-run')return;this.heard.push({position:p.clone(),strength:strength*CONFIG.enemy.hearingMultiplier,time:this.sim,source})}
  private emit(message:string):void{this.message=message;this.hooks.onMessage?.(message);this.refreshHud()}
  private refreshHud():void{this.hooks.onHud?.(this.hud())}
}
