// Tournoi multi-soirées — persisté en localStorage sur l'appareil de l'hôte/présentateur
// (pas de backend : les soirées d'un même tournoi doivent être créées depuis le même
// appareil). Les joueurs sont regroupés par pseudo (pas par peerId, qui change à chaque
// session Trystero) — deux personnes avec le même pseudo seront donc comptées ensemble,
// limite acceptée pour une fonctionnalité 100% côté client.
const STORAGE_KEY = 'romet:tournaments'

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function writeAll(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    // stockage indisponible, tant pis
  }
}

const ELO_BASE = 1000
const ELO_K = 32

function eloExpected(ratingA, ratingB) {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400))
}

// Élo multi-joueurs : chaque soirée est traitée comme une ronde de duels deux-à-deux entre
// tous les participants (le mieux classé "gagne" chaque duel, égalité de points = nul) ;
// le K est divisé par le nombre d'adversaires pour garder une amplitude raisonnable quand
// beaucoup de joueurs sont présents à la même soirée.
function applyEloForSoiree(tournament, standings) {
  const n = standings.length
  if (n < 2) return
  const keys = standings.map((s) => s.nickname)
  const startRatings = new Map(keys.map((k) => [k, tournament.players[k]?.elo ?? ELO_BASE]))
  const deltas = new Map(keys.map((k) => [k, 0]))
  const k = ELO_K / (n - 1)

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = keys[i]
      const b = keys[j]
      const ra = startRatings.get(a)
      const rb = startRatings.get(b)
      const expectedA = eloExpected(ra, rb)
      const actualA = standings[i].points === standings[j].points ? 0.5 : 1
      deltas.set(a, deltas.get(a) + k * (actualA - expectedA))
      deltas.set(b, deltas.get(b) + k * (1 - actualA - (1 - expectedA)))
    }
  }

  for (const key of keys) {
    const player = tournament.players[key]
    if (player) player.elo = Math.round(startRatings.get(key) + deltas.get(key))
  }
}

export function listTournamentNames() {
  return Object.keys(readAll()).sort()
}

export function getTournament(name) {
  return readAll()[name] ?? null
}

// standings : [{ nickname, points, avatar }] — résultat final d'une soirée
export function recordSoireeResult(tournamentName, standings, roundsCount) {
  const trimmed = (tournamentName ?? '').trim()
  if (!trimmed || !standings?.length) return

  const data = readAll()
  const tournament = data[trimmed] ?? { players: {}, soireesPlayed: 0, createdAt: Date.now() }

  for (const s of standings) {
    const key = s.nickname
    const existing = tournament.players[key] ?? { nickname: s.nickname, avatar: s.avatar, points: 0, soirees: 0, elo: ELO_BASE }
    existing.points += s.points
    existing.soirees += 1
    existing.avatar = s.avatar ?? existing.avatar
    if (existing.elo == null) existing.elo = ELO_BASE
    tournament.players[key] = existing
  }
  applyEloForSoiree(tournament, standings)
  tournament.soireesPlayed += 1
  tournament.lastPlayedAt = Date.now()
  tournament.lastRoundsCount = roundsCount

  data[trimmed] = tournament
  writeAll(data)
}

export function tournamentStandings(name) {
  const tournament = getTournament(name)
  if (!tournament) return []
  return Object.values(tournament.players).sort((a, b) => b.points - a.points)
}

export function tournamentEloStandings(name) {
  const tournament = getTournament(name)
  if (!tournament) return []
  return Object.values(tournament.players)
    .map((p) => ({ ...p, elo: p.elo ?? ELO_BASE }))
    .sort((a, b) => b.elo - a.elo)
}

export function deleteTournament(name) {
  const data = readAll()
  delete data[name]
  writeAll(data)
}
