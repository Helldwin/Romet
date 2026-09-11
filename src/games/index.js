import quiz from './quiz/quiz.js'
import draw from './draw/draw.js'
import guess from './guess/guess.js'
import impostor from './impostor/impostor.js'
import pbac from './pbac/pbac.js'
import wordle from './wordle/wordle.js'
import define from './define/define.js'

// Contrat d'un jeu : { id, title, description, minPlayers, mount(ctx) }
// ctx = { root, room, selfId, isHost, getPlayers(), onPlayersChange(cb), onGameEnd(rankings), onGameCancel(reason) }
// mount() retourne { destroy() }. Seul l'hôte doit appeler onGameEnd/onGameCancel.
export const GAMES = [quiz, draw, guess, impostor, pbac, wordle, define]

export function getGame(id) {
  return GAMES.find((g) => g.id === id) ?? null
}
