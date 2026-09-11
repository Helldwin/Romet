import quiz from './quiz/quiz.js'
import draw from './draw/draw.js'
import guess from './guess/guess.js'

// Contrat d'un jeu : { id, title, description, minPlayers, mount(ctx) }
// ctx = { root, room, selfId, isHost, getPlayers(), onPlayersChange(cb), onGameEnd(rankings), onGameCancel(reason) }
// mount() retourne { destroy() }. Seul l'hôte doit appeler onGameEnd/onGameCancel.
export const GAMES = [quiz, draw, guess]

export function getGame(id) {
  return GAMES.find((g) => g.id === id) ?? null
}
