const MUTED_KEY = 'romet:muted'
const THEME_KEY = 'romet:sound-theme'

export const SOUND_THEMES = {
  classique: { label: '🎵 Classique', chord: [261.63, 329.63, 392.0], type: 'sine' },
  chill: { label: '🌙 Chill', chord: [220, 277.18, 329.63], type: 'sine' },
  arcade: { label: '👾 Rétro arcade', chord: [523.25, 659.25, 783.99, 1046.5], type: 'square' },
  intense: { label: '🔥 Intense', chord: [146.83, 174.61, 220], type: 'sawtooth' },
}

let ctx = null
let muted = localStorage.getItem(MUTED_KEY) === '1'
let soundTheme = SOUND_THEMES[localStorage.getItem(THEME_KEY)] ? localStorage.getItem(THEME_KEY) : 'classique'
let ambientHandle = null
let ambientPhase = null

function getCtx() {
  if (!ctx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext
    ctx = new AudioCtx()
  }
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

export function isMuted() {
  return muted
}

export function setMuted(value) {
  muted = value
  localStorage.setItem(MUTED_KEY, value ? '1' : '0')
  if (value) stopAmbient()
}

export function getSoundTheme() {
  return soundTheme
}

export function setSoundTheme(theme) {
  if (!SOUND_THEMES[theme]) return
  soundTheme = theme
  localStorage.setItem(THEME_KEY, theme)
  if (ambientHandle) {
    const phase = ambientPhase
    stopAmbient()
    startAmbient(phase)
  }
}

function tone(freq, duration, type = 'sine', gainValue = 0.15, delay = 0) {
  if (muted) return
  try {
    const audioCtx = getCtx()
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.type = type
    osc.frequency.value = freq
    osc.connect(gain)
    gain.connect(audioCtx.destination)
    const t0 = audioCtx.currentTime + delay
    gain.gain.setValueAtTime(0, t0)
    gain.gain.linearRampToValueAtTime(gainValue, t0 + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration)
    osc.start(t0)
    osc.stop(t0 + duration + 0.02)
  } catch {
    // AudioContext indisponible (ex: avant toute interaction utilisateur) — on ignore
  }
}

export function playDing() {
  tone(880, 0.15, 'sine', 0.2)
  tone(1318.5, 0.2, 'sine', 0.15, 0.05)
}

export function playWrong() {
  tone(220, 0.25, 'sawtooth', 0.12)
}

export function playTick() {
  tone(1000, 0.05, 'square', 0.05)
}

export function playClick() {
  tone(600, 0.05, 'square', 0.06)
}

export function playFanfare() {
  const notes = [523.25, 659.25, 783.99, 1046.5]
  notes.forEach((freq, i) => tone(freq, 0.3, 'triangle', 0.18, i * 0.12))
}

// phase: 'vote' (par défaut, rythme normal) | 'game' (plus discret, en fond pendant le jeu)
export function startAmbient(phase = 'vote') {
  if (muted || ambientHandle) return
  ambientPhase = phase
  const { chord, type } = SOUND_THEMES[soundTheme] ?? SOUND_THEMES.classique
  const intervalMs = phase === 'game' ? 2200 : 1500
  const gainValue = phase === 'game' ? 0.02 : 0.035
  let i = 0
  ambientHandle = setInterval(() => {
    if (muted) return
    tone(chord[i % chord.length], 1.4, type, gainValue)
    i++
  }, intervalMs)
}

export function stopAmbient() {
  clearInterval(ambientHandle)
  ambientHandle = null
  ambientPhase = null
}

export function playIntroJingle() {
  const { chord, type } = SOUND_THEMES[soundTheme] ?? SOUND_THEMES.classique
  chord.forEach((freq, i) => tone(freq, 0.5, type, 0.16, i * 0.15))
  tone(chord[0] * 2, 0.6, type, 0.14, chord.length * 0.15)
}
