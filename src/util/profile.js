import { getHistory } from './history.js'

// Stats globales calculées à la volée depuis l'historique des soirées déjà stocké sur cet
// appareil (util/history.js) — pas de nouveau stockage, juste une lecture agrégée par pseudo.
// Comme les peerId sont éphémères (un par session P2P), on ne peut recouper les titres
// qu'à l'intérieur d'une même entrée d'historique (peerId <-> nickname y sont cohérents).
export function computeProfileStats(nickname) {
  const history = getHistory()
  let soireesPlayed = 0
  let wins = 0
  let podiums = 0
  let totalPoints = 0
  const titleCounts = new Map()

  for (const entry of history) {
    const standings = entry.standings ?? []
    const rank = standings.findIndex((s) => s.nickname === nickname)
    if (rank === -1) continue
    const mine = standings[rank]
    soireesPlayed += 1
    totalPoints += mine.points ?? 0
    if (rank === 0) wins += 1
    if (rank < 3) podiums += 1

    for (const t of entry.titles ?? []) {
      if (t.peerId !== mine.peerId) continue
      const current = titleCounts.get(t.label) ?? { emoji: t.emoji, label: t.label, count: 0 }
      current.count += 1
      titleCounts.set(t.label, current)
    }
  }

  return {
    soireesPlayed,
    wins,
    podiums,
    avgPoints: soireesPlayed ? Math.round(totalPoints / soireesPlayed) : 0,
    titles: [...titleCounts.values()].sort((a, b) => b.count - a.count),
  }
}

const ACHIEVEMENT_DEFS = [
  { emoji: '🎮', label: 'Vétéran', check: (s) => s.soireesPlayed >= 10 },
  { emoji: '🏆', label: 'Première victoire', check: (s) => s.wins >= 1 },
  { emoji: '👑', label: 'Habitué du podium', check: (s) => s.podiums >= 5 },
  { emoji: '🧠', label: '10 quiz gagnés', check: (s) => (s.titles.find((t) => t.label === 'Cerveau du quiz')?.count ?? 0) >= 10 },
  { emoji: '🕵️', label: 'Maître du bluff x5', check: (s) => (s.titles.find((t) => t.label === 'Maître du bluff')?.count ?? 0) >= 5 },
  { emoji: '🎨', label: 'Picasso x5', check: (s) => (s.titles.find((t) => t.label === 'Picasso de la soirée')?.count ?? 0) >= 5 },
]

export function computeAchievements(nickname) {
  const stats = computeProfileStats(nickname)
  return ACHIEVEMENT_DEFS.filter((a) => a.check(stats)).map(({ emoji, label }) => ({ emoji, label }))
}
