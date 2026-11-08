export type HorrorCue = 'player-footstep'|'enemy-footstep'|'coo'|'breath'|'door'|'pickup'|'puzzle'|'thump'|'chase-sting'|'jumpscare'|'escape'

type UpdateParams = { enemyDistance: number; chasing: boolean; paused: boolean; hidden: boolean }
type Voice = { nodes: AudioNode[]; source: AudioScheduledSourceNode; gain: GainNode }
type AudioContextConstructor = new () => AudioContext

const MAX_VOICES = 14
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
const random = (min: number, max: number): number => min + Math.random() * (max - min)

export class HorrorAudio {
  private context: AudioContext | null = null
  private masterSfx: GainNode | null = null
  private masterMusic: GainNode | null = null
  private voices: Voice[] = []
  private sfxLevel = 0.8
  private musicLevel = 0.45
  private muted = false
  private unlocked = false
  private ambience: { nodes: AudioNode[]; oscillators: OscillatorNode[]; gains: GainNode[] } | null = null
  private heartbeat: { nodes: AudioNode[]; oscillators: OscillatorNode[]; gains: GainNode[] } | null = null
  private chase: { nodes: AudioNode[]; oscillators: OscillatorNode[]; gains: GainNode[] } | null = null
  private eventTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private lastUpdate: UpdateParams | null = null
  private stopped = false

  unlock(): void {
    if (this.unlocked) {
      const context = this.context
      if (context?.state === 'suspended') void context.resume().catch(() => undefined)
      return
    }
    const scope = globalThis as typeof globalThis & { webkitAudioContext?: AudioContextConstructor }
    const Constructor = typeof globalThis.AudioContext === 'function' ? globalThis.AudioContext : scope.webkitAudioContext
    if (!Constructor) return
    try {
      const context = new Constructor()
      const sfx = context.createGain()
      const music = context.createGain()
      sfx.gain.value = 0
      music.gain.value = 0
      sfx.connect(context.destination)
      music.connect(context.destination)
      this.context = context
      this.masterSfx = sfx
      this.masterMusic = music
      this.unlocked = true
      this.stopped = false
      this.applyLevels()
      void context.resume().then(() => {
        if (this.lastUpdate) this.update(0, this.lastUpdate)
      }).catch(() => undefined)
    } catch {
      this.context = null
      this.masterSfx = null
      this.masterMusic = null
    }
  }

  setLevels(sfx: number, music: number, muted: boolean): void {
    this.sfxLevel = clamp(sfx, 0, 1)
    this.musicLevel = clamp(music, 0, 1)
    this.muted = Boolean(muted)
    this.applyLevels()
  }

  cue(cue: HorrorCue, intensity = 1): void {
    const context = this.context
    const master = this.masterSfx
    if (!context || !master || !this.unlocked || context.state !== 'running' || this.muted || this.stopped) return
    if (this.voices.length >= MAX_VOICES) this.finishVoice(this.voices[0], context.currentTime)
    const now = context.currentTime
    const power = clamp(intensity, 0.08, 1.5)
    const gain = context.createGain()
    const filter = context.createBiquadFilter()
    const nodes: AudioNode[] = [gain, filter]
    gain.gain.setValueAtTime(0.0001, now)
    filter.connect(gain)
    gain.connect(master)
    let duration = 0.45
    let type: OscillatorType = 'sine'
    let startHz = 140
    let endHz = 90
    let peak = 0.24 * power
    let noise = false
    let secondTone: { hz: number; peak: number; type: OscillatorType } | null = null

    switch (cue) {
      case 'player-footstep': duration = 0.16; type = 'triangle'; startHz = 105; endHz = 48; peak = 0.22 * power; noise = true; filter.type = 'lowpass'; filter.frequency.value = 620; break
      case 'enemy-footstep': duration = 0.28; type = 'sawtooth'; startHz = 72; endHz = 32; peak = 0.34 * power; noise = true; filter.type = 'lowpass'; filter.frequency.value = 420; break
      case 'coo': duration = 0.72; type = 'sine'; startHz = 390; endHz = 175; peak = 0.17 * power; secondTone = { hz: 196, peak: 0.06 * power, type: 'triangle' }; filter.type = 'lowpass'; filter.frequency.value = 1100; break
      case 'breath': duration = 0.8; noise = true; peak = 0.18 * power; filter.type = 'bandpass'; filter.frequency.value = 720; filter.Q.value = 0.65; break
      case 'door': duration = 0.8; type = 'sawtooth'; startHz = 92; endHz = 43; peak = 0.22 * power; noise = true; filter.type = 'lowpass'; filter.frequency.value = 520; break
      case 'pickup': duration = 0.34; type = 'sine'; startHz = 520; endHz = 1040; peak = 0.17 * power; secondTone = { hz: 780, peak: 0.09 * power, type: 'sine' }; filter.type = 'lowpass'; filter.frequency.value = 2400; break
      case 'puzzle': duration = 0.5; type = 'triangle'; startHz = 300; endHz = 580; peak = 0.15 * power; secondTone = { hz: 450, peak: 0.07 * power, type: 'sine' }; filter.type = 'lowpass'; filter.frequency.value = 1800; break
      case 'thump': duration = 0.45; type = 'sine'; startHz = 78; endHz = 34; peak = 0.4 * power; noise = true; filter.type = 'lowpass'; filter.frequency.value = 300; break
      case 'chase-sting': duration = 0.85; type = 'sawtooth'; startHz = 165; endHz = 82; peak = 0.24 * power; secondTone = { hz: 112, peak: 0.12 * power, type: 'triangle' }; filter.type = 'lowpass'; filter.frequency.value = 720; break
      case 'jumpscare': duration = 0.95; type = 'sawtooth'; startHz = 220; endHz = 42; peak = 0.42 * power; secondTone = { hz: 56, peak: 0.28 * power, type: 'square' }; noise = true; filter.type = 'lowpass'; filter.frequency.value = 1400; break
      case 'escape': duration = 1.1; type = 'triangle'; startHz = 220; endHz = 880; peak = 0.24 * power; secondTone = { hz: 330, peak: 0.11 * power, type: 'sine' }; filter.type = 'lowpass'; filter.frequency.value = 2400; break
    }
    peak = clamp(peak, 0.001, 0.48)
    const attack = Math.min(0.045, duration * 0.18)
    const decayAt = now + duration * 0.48
    const end = now + duration
    gain.gain.linearRampToValueAtTime(peak, now + attack)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * 0.38), decayAt)
    gain.gain.exponentialRampToValueAtTime(0.0001, end)

    const oscillator = context.createOscillator()
    oscillator.type = type
    oscillator.frequency.setValueAtTime(clamp(startHz * (0.92 + Math.random() * 0.16), 30, 2400), now)
    oscillator.frequency.exponentialRampToValueAtTime(clamp(endHz * (0.92 + Math.random() * 0.16), 25, 2400), end)
    oscillator.connect(filter)
    nodes.push(oscillator)
    const sources: AudioScheduledSourceNode[] = [oscillator]
    if (secondTone) {
      const osc2 = context.createOscillator()
      const g2 = context.createGain()
      g2.gain.value = clamp(secondTone.peak / peak, 0.02, 1)
      osc2.type = secondTone.type
      osc2.frequency.value = clamp(secondTone.hz * (0.9 + Math.random() * 0.2), 25, 2400)
      osc2.connect(g2).connect(filter)
      nodes.push(osc2, g2)
      sources.push(osc2)
    }
    if (noise) {
      const buffer = context.createBuffer(1, Math.max(1, Math.ceil(context.sampleRate * duration)), context.sampleRate)
      const data = buffer.getChannelData(0)
      for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length * 0.28)
      const source = context.createBufferSource()
      const noiseGain = context.createGain()
      const noisePeak = peak * (cue === 'breath' ? 0.55 : 0.32)
      noiseGain.gain.setValueAtTime(0.0001, now)
      noiseGain.gain.linearRampToValueAtTime(noisePeak, now + attack)
      noiseGain.gain.exponentialRampToValueAtTime(Math.max(0.0001, noisePeak * 0.38), decayAt)
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, end)
      source.buffer = buffer
      source.connect(noiseGain).connect(filter)
      nodes.push(source, noiseGain)
      sources.push(source)
    }
    const voice: Voice = { nodes, source: oscillator, gain }
    this.voices.push(voice)
    let remaining = sources.length
    for (const source of sources) {
      source.onended = () => {
        remaining -= 1
        if (remaining === 0) this.finishVoice(voice)
      }
      try { source.start(now); source.stop(end) } catch { this.finishVoice(voice, now) }
    }
  }

  update(dt: number, params: UpdateParams): void {
    void dt
    this.lastUpdate = { ...params }
    const context = this.context
    if (!context || !this.unlocked || context.state !== 'running') return
    if (params.paused || this.stopped) {
      this.clearTimers()
      this.fadeLayer(this.ambience, context.currentTime, 0, 0.15)
      this.fadeLayer(this.heartbeat, context.currentTime, 0, 0.1)
      this.fadeLayer(this.chase, context.currentTime, 0, 0.15)
      return
    }
    this.ensureAmbient()
    const now = context.currentTime
    const hiddenScale = params.hidden ? 0.22 : 1
    this.fadeLayer(this.ambience, now, 1, 0.45)
    const distance = clamp(params.enemyDistance, 0, 100)
    const proximity = clamp(1 - distance / 22, 0, 1) * hiddenScale
    if (proximity > 0.035 && !this.muted) this.ensureHeartbeat(proximity)
    else this.fadeLayer(this.heartbeat, now, 0, 0.25)
    if (params.chasing && !params.hidden) {
      this.ensureChase()
      this.fadeLayer(this.chase, now, 1, 0.3)
    } else this.fadeLayer(this.chase, now, 0, 0.35)
    if (!this.eventTimer && !this.muted) this.scheduleAmbientEvent()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    const context = this.context
    if (context) {
      this.fadeLayer(this.ambience, context.currentTime, 0, 0.06)
      this.fadeLayer(this.heartbeat, context.currentTime, 0, 0.06)
      this.fadeLayer(this.chase, context.currentTime, 0, 0.06)
      for (const voice of [...this.voices]) this.finishVoice(voice, context.currentTime)
    }
    this.ambience = null
    this.heartbeat = null
    this.chase = null
  }

  private applyLevels(): void {
    const context = this.context
    if (!context) return
    const now = context.currentTime
    const targetSfx = this.muted ? 0 : this.sfxLevel
    const targetMusic = this.muted ? 0 : this.musicLevel
    for (const [param, target] of [[this.masterSfx?.gain, targetSfx], [this.masterMusic?.gain, targetMusic]] as const) {
      if (!param) continue
      param.cancelScheduledValues(now)
      param.setTargetAtTime(target, now, 0.025)
    }
  }

  private makeLayer(): { nodes: AudioNode[]; oscillators: OscillatorNode[]; gains: GainNode[] } | null {
    const context = this.context
    if (!context || !this.masterMusic) return null
    const oscillators: OscillatorNode[] = []
    const gains: GainNode[] = []
    const nodes: AudioNode[] = []
    try {
      for (let i = 0; i < 2; i += 1) {
        const osc = context.createOscillator()
        const gain = context.createGain()
        osc.type = i === 0 ? 'sine' : 'triangle'
        gain.gain.value = 0
        osc.connect(gain).connect(this.masterMusic)
        osc.start()
        oscillators.push(osc)
        gains.push(gain)
        nodes.push(osc, gain)
      }
      return { nodes, oscillators, gains }
    } catch {
      for (const node of nodes) { try { node.disconnect() } catch { /* already disconnected */ } }
      return null
    }
  }

  private ensureAmbient(): void {
    if (this.ambience) return
    const layer = this.makeLayer()
    if (!layer) return
    layer.oscillators[0].frequency.value = 43
    layer.oscillators[1].frequency.value = 57
    layer.gains[0].gain.value = 0.09
    layer.gains[1].gain.value = 0.025
    this.ambience = layer
  }

  private ensureHeartbeat(level: number): void {
    if (!this.heartbeat) {
      this.heartbeat = this.makeLayer()
      if (!this.heartbeat) return
      this.heartbeat.oscillators[0].frequency.value = 48
      this.heartbeat.oscillators[1].frequency.value = 62
      this.heartbeat.gains.forEach(g => { g.gain.value = 0.0001 })
    }
    const layer = this.heartbeat
    const context = this.context
    if (!layer || !context) return
    const now = context.currentTime
    layer.gains[0].gain.setTargetAtTime(0.025 + level * 0.16, now, 0.09)
    layer.gains[1].gain.setTargetAtTime(0.01 + level * 0.07, now, 0.09)
    if (!this.heartbeatTimer) {
      const beat = (): void => {
        this.heartbeatTimer = null
        if (!this.lastUpdate || this.lastUpdate.paused || this.stopped || !this.context) return
        const p = this.lastUpdate
        const intensity = clamp(1 - clamp(p.enemyDistance, 0, 100) / 22, 0, 1) * (p.hidden ? 0.22 : 1)
        if (intensity > 0.035 && !this.muted) {
          this.cue('thump', clamp(0.23 + intensity * 0.44, 0.1, 0.7))
          this.heartbeatTimer = setTimeout(beat, 1050 - intensity * 390 + random(-45, 45))
        }
      }
      this.heartbeatTimer = setTimeout(beat, 180)
    }
  }

  private ensureChase(): void {
    if (this.chase) return
    this.chase = this.makeLayer()
    if (!this.chase) return
    this.chase.oscillators[0].type = 'sawtooth'
    this.chase.oscillators[0].frequency.value = 54
    this.chase.oscillators[1].type = 'sine'
    this.chase.oscillators[1].frequency.value = 81
    this.chase.gains[0].gain.value = 0.0001
    this.chase.gains[1].gain.value = 0.0001
  }

  private scheduleAmbientEvent(): void {
    const delay = random(17000, 36000)
    this.eventTimer = setTimeout(() => {
      this.eventTimer = null
      const state = this.lastUpdate
      if (!state || state.paused || this.stopped || this.muted) return
      if (!state.hidden && Math.random() < 0.58) this.cue('coo', random(0.28, 0.55))
      else this.cue('thump', random(0.2, 0.42))
      this.scheduleAmbientEvent()
    }, delay)
  }

  private fadeLayer(layer: { nodes: AudioNode[]; oscillators: OscillatorNode[]; gains: GainNode[] } | null, now: number, level: number, time: number): void {
    if (!layer) return
    const ctx = this.context
    if (!ctx) return
    const scale = level === 0 ? 0.0001 : level
    for (const gain of layer.gains) {
      gain.gain.cancelScheduledValues(now)
      gain.gain.setTargetAtTime(scale * (level === 1 ? 0.12 : 1), now, Math.max(0.01, time / 3))
    }
  }

  private clearTimers(): void {
    if (this.eventTimer) clearTimeout(this.eventTimer)
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
    this.eventTimer = null
    this.heartbeatTimer = null
  }

  private finishVoice(voice: Voice, at?: number): void {
    const index = this.voices.indexOf(voice)
    if (index < 0) return
    this.voices.splice(index, 1)
    for (const node of voice.nodes) {
      if ('stop' in node && typeof (node as AudioScheduledSourceNode).stop === 'function') {
        try { (node as AudioScheduledSourceNode).stop(at) } catch { /* source has already ended */ }
      }
      try { node.disconnect() } catch { /* already disconnected */ }
    }
  }
}
