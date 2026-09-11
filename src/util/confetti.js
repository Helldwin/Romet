const COLORS = ['#FF6B6B', '#FFA94D', '#FFD43B', '#69DB7C', '#4DABF7', '#DA77F2', '#FF9FF3']
const PARTICLE_COUNT = 120
const DURATION_MS = 2200

export function burstConfetti() {
  const canvas = document.createElement('canvas')
  canvas.style.position = 'fixed'
  canvas.style.inset = '0'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.pointerEvents = 'none'
  canvas.style.zIndex = '9999'
  canvas.width = window.innerWidth
  canvas.height = window.innerHeight
  document.body.appendChild(canvas)

  const ctx = canvas.getContext('2d')
  const particles = Array.from({ length: PARTICLE_COUNT }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.3,
    w: 6 + Math.random() * 6,
    h: 8 + Math.random() * 8,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    vx: -2 + Math.random() * 4,
    vy: 2 + Math.random() * 3,
    rotation: Math.random() * Math.PI,
    vr: -0.2 + Math.random() * 0.4,
  }))

  const start = performance.now()

  function frame(now) {
    const elapsed = now - start
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    for (const p of particles) {
      p.x += p.vx
      p.y += p.vy
      p.vy += 0.05
      p.rotation += p.vr

      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.rotate(p.rotation)
      ctx.fillStyle = p.color
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h)
      ctx.restore()
    }

    if (elapsed < DURATION_MS) {
      requestAnimationFrame(frame)
    } else {
      canvas.remove()
    }
  }

  requestAnimationFrame(frame)
}
