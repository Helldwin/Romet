const RANK_POINTS = [10, 8, 6, 4, 2]
const FALLBACK_POINTS = 1

function pointsForRank(rank) {
  return RANK_POINTS[rank] ?? FALLBACK_POINTS
}

/**
 * @param {Array<{peerId: string, nickname: string, avatar, points: number}>} standings état actuel
 * @param {string[]} rankings peerId ordonnés du 1er au dernier pour la partie qui vient de finir
 * @param {Array<{peerId: string, nickname: string, avatar}>} players joueurs connus (pour le pseudo/avatar)
 * @returns nouvel état, trié par points décroissants
 */
export function applyRankings(standings, rankings, players) {
  const infoById = new Map(players.map((p) => [p.peerId, p]))
  const byId = new Map(standings.map((s) => [s.peerId, s]))

  rankings.forEach((peerId, rank) => {
    const info = infoById.get(peerId)
    const existing = byId.get(peerId) ?? {
      peerId,
      nickname: info?.nickname ?? '???',
      avatar: info?.avatar,
      points: 0,
    }
    if (info) {
      existing.nickname = info.nickname
      existing.avatar = info.avatar
    }
    existing.points += pointsForRank(rank)
    byId.set(peerId, existing)
  })

  return Array.from(byId.values()).sort((a, b) => b.points - a.points)
}
