const MUTED_KEY = 'romet:muted'

let ctx = null
let muted = localStorage.getItem(MUTED_KEY) === '1'
let ambientHandle = null

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

export function startAmbient() {
  if (muted || ambientHandle) return
  const chord = [261.63, 329.63, 392.0]
  let i = 0
  ambientHandle = setInterval(() => {
    if (muted) return
    tone(chord[i % chord.length], 1.4, 'sine', 0.035)
    i++
  }, 1500)
}

export function stopAmbient() {
  clearInterval(ambientHandle)
  ambientHandle = null
}
