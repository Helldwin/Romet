const WIDTH = 640
const ROW_HEIGHT = 44

export function downloadStandingsImage(standings, titles, nicknameOf, highlights) {
  const titleRows = titles?.length ?? 0
  const highlightRows = highlights?.length ?? 0
  const height = 140 + standings.length * ROW_HEIGHT + (titleRows > 0 ? 60 + titleRows * 36 : 0) + (highlightRows > 0 ? 60 + highlightRows * 36 : 0)

  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = height
  const ctx = canvas.getContext('2d')

  const gradient = ctx.createLinearGradient(0, 0, WIDTH, height)
  gradient.addColorStop(0, '#6C5CE7')
  gradient.addColorStop(1, '#FF6FD8')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, WIDTH, height)

  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 30px sans-serif'
  ctx.fillText('🏆 Classement de la soirée', 24, 55)

  let y = 100
  ctx.font = '22px sans-serif'
  standings.forEach((s, i) => {
    ctx.fillText(`${i + 1}. ${s.nickname} — ${s.points} pts`, 24, y)
    y += ROW_HEIGHT
  })

  if (titleRows > 0) {
    y += 20
    ctx.font = 'bold 22px sans-serif'
    ctx.fillText('Titres de la soirée', 24, y)
    y += 34
    ctx.font = '19px sans-serif'
    for (const t of titles) {
      ctx.fillText(`${t.emoji} ${t.label} — ${nicknameOf ? nicknameOf(t.peerId) : ''}`, 24, y)
      y += 36
    }
  }

  if (highlightRows > 0) {
    y += 20
    ctx.font = 'bold 22px sans-serif'
    ctx.fillText('Moments forts', 24, y)
    y += 34
    ctx.font = '19px sans-serif'
    for (const h of highlights) {
      ctx.fillText(h, 24, y)
      y += 36
    }
  }

  canvas.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'romet-classement.png'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  })
}
