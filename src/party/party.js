import { getRoom, getSelfId, getPlayers, onPlayersChange } from '../network/room.js'
import { GAMES, getGame } from '../games/index.js'
import { applyRankings } from './leaderboard.js'
import {
  renderVoteScreen,
  updateVoteScreen,
  renderResultsScreen,
  renderGameShell,
  renderCancelMessage,
  renderSpectating,
  showFloatingReaction,
  showComboToast,
} from './views.js'
import { playTick, playFanfare, startAmbient, stopAmbient } from '../util/sound.js'
import { burstConfetti } from '../util/confetti.js'
import { saveHistoryEntry } from '../util/history.js'

const VOTE_DURATION_MS = 15000
const VOTE_OPTIONS_COUNT = 3
const CANCEL_RETRY_DELAY_MS = 2500
const TITLES = {
  quiz: { emoji: '🧠', label: 'Cerveau du quiz' },
  draw: { emoji: '🎨', label: 'Picasso de la soirée' },
  guess: { emoji: '🖼️', label: 'Œil de lynx' },
}

export const DEFAULT_ROUNDS_COUNT = 3
export const DEFAULT_TURNS_PER_GAME = 5

let sendParty = null
let receiveParty = null
let registered = false

let root = null
let isHost = false
let standings = []
let currentInstance = null
let currentGameId = null
let currentPhase = 'idle' // 'vote' | 'game' | 'results' | 'cancelled' | 'spectating'
let lastVotePayload = null
let lastResultsPayload = null
let unsubscribePlayers = null
let knownPeerIds = new Set()

let partyConfig = { roundsCount: DEFAULT_ROUNDS_COUNT, turnsPerGame: DEFAULT_TURNS_PER_GAME }
let playedGameIds = new Set()
let gamesPlayed = 0
let gameWinners = [] // [{ gameId, peerId }]
let comboCount = 0

let voteOptions = []
let voteDeadline = 0
let voteTally = new Map()
let myVote = null
let voteTickHandle = null
let voteResolveHandle = null

function ensureChannel() {
  if (registered) return
  const room = getRoom()
  if (!room) return
  ;[sendParty, receiveParty] = room.makeAction('party')
  receiveParty(handleMessage)
  registered = true
}

export function initParty(rootEl, hostFlag) {
  root = rootEl
  isHost = hostFlag
  standings = []
  playedGameIds = new Set()
  gamesPlayed = 0
  gameWinners = []
  currentPhase = 'idle'
  knownPeerIds = new Set(getPlayers().map((p) => p.peerId))
  ensureChannel()

  unsubscribePlayers?.()
  unsubscribePlayers = onPlayersChange(handlePlayersChange)
}

export function resetParty() {
  registered = false
  sendParty = null
  receiveParty = null
  clearInterval(voteTickHandle)
  clearTimeout(voteResolveHandle)
  voteTickHandle = null
  voteResolveHandle = null
  if (currentInstance) currentInstance.destroy()
  currentInstance = null
  currentGameId = null
  currentPhase = 'idle'
  standings = []
  playedGameIds = new Set()
  gamesPlayed = 0
  gameWinners = []
  comboCount = 0
  unsubscribePlayers?.()
  unsubscribePlayers = null
  stopAmbient()
  root = null
}

export function startParty(config) {
  if (!isHost) return
  partyConfig = {
    roundsCount: config?.roundsCount || DEFAULT_ROUNDS_COUNT,
    turnsPerGame: config?.turnsPerGame || DEFAULT_TURNS_PER_GAME,
    questionDuration: config?.questionDuration || undefined,
    difficulty: config?.difficulty || 'random',
    category: config?.category || 'all',
    eliminationMode: config?.eliminationMode ?? false,
  }
  gamesPlayed = 0
  playedGameIds = new Set()
  gameWinners = []
  comboCount = 0
  sendParty({ type: 'config', config: partyConfig })
  hostStartVote()
}

export function sendReaction(emoji) {
  if (!sendParty) return
  sendParty({ type: 'react', emoji })
  showFloatingReaction(getPlayers().find((p) => p.peerId === getSelfId())?.nickname ?? '', emoji)
}

function handleAnswerResult(correct) {
  if (correct) {
    comboCount += 1
    if (comboCount >= 5 && comboCount % 5 === 0) showComboToast(comboCount)
  } else {
    comboCount = 0
  }
}

// --- Réaction aux changements de présence : migration d'hôte + arrivée tardive ---

function handlePlayersChange(players) {
  for (const p of players) {
    if (!knownPeerIds.has(p.peerId)) {
      knownPeerIds.add(p.peerId)
      if (isHost && p.peerId !== getSelfId() && currentPhase !== 'idle') {
        sendSyncTo(p.peerId)
      }
    }
  }

  const me = players.find((p) => p.peerId === getSelfId())
  if (me && me.isHost && !isHost) {
    isHost = true
    handleBecameHost()
  }
}

function sendSyncTo(peerId) {
  if (currentPhase === 'vote' && lastVotePayload) {
    sendParty({ type: 'sync', phase: 'vote', payload: lastVotePayload }, peerId)
  } else if (currentPhase === 'results' && lastResultsPayload) {
    sendParty({ type: 'sync', phase: 'results', payload: lastResultsPayload }, peerId)
  } else if (currentPhase === 'game') {
    sendParty({ type: 'sync', phase: 'game' }, peerId)
  }
}

function handleBecameHost() {
  if (currentPhase === 'game') {
    if (currentInstance) {
      currentInstance.destroy()
      currentInstance = null
    }
    handleGameCancel('host-left')
  } else if (currentPhase === 'vote') {
    clearTimeout(voteResolveHandle)
    voteResolveHandle = setTimeout(resolveVote, Math.max(0, voteDeadline - Date.now()))
  } else if (currentPhase === 'results' && lastResultsPayload) {
    enterResults(lastResultsPayload)
  }
}

// --- Messages réseau ---

function handleMessage(msg, peerId) {
  switch (msg.type) {
    case 'config':
      partyConfig = msg.config
      break
    case 'vote-start':
      enterVote(msg)
      break
    case 'vote-cast':
      registerVote(msg.gameId, peerId)
      break
    case 'game-start':
      enterGame(msg.gameId)
      break
    case 'game-end':
      enterResults(msg)
      break
    case 'game-cancel':
      enterCancelled(msg.reason)
      break
    case 'react':
      showFloatingReaction(getPlayers().find((p) => p.peerId === peerId)?.nickname ?? '', msg.emoji)
      break
    case 'sync':
      applySync(msg)
      break
  }
}

function applySync(msg) {
  if (currentPhase !== 'idle') return // on est déjà synchronisé (ex: on a rejoint avant le message)
  if (msg.phase === 'vote') enterVote(msg.payload)
  else if (msg.phase === 'results') enterResults(msg.payload)
  else if (msg.phase === 'game') enterSpectating()
}

// --- Vote ---

function pickVoteOptions() {
  let pool = GAMES.filter((g) => !playedGameIds.has(g.id))
  if (pool.length === 0) {
    playedGameIds = new Set()
    pool = GAMES
  }
  const shuffled = [...pool].sort(() => Math.random() - 0.5)
  return shuffled
    .slice(0, Math.min(VOTE_OPTIONS_COUNT, shuffled.length))
    .map((g) => ({ id: g.id, icon: g.icon, title: g.title, description: g.description }))
}

function hostStartVote() {
  const payload = {
    options: pickVoteOptions(),
    deadline: Date.now() + VOTE_DURATION_MS,
    roundNumber: gamesPlayed + 1,
    roundsCount: partyConfig.roundsCount,
  }
  sendParty({ type: 'vote-start', ...payload })
  enterVote(payload)
}

function enterVote(payload) {
  const { options, deadline, roundNumber, roundsCount } = payload
  currentPhase = 'vote'
  lastVotePayload = payload
  if (currentInstance) {
    currentInstance.destroy()
    currentInstance = null
  }
  voteOptions = options
  voteDeadline = deadline
  voteTally = new Map(options.map((o) => [o.id, new Set()]))
  myVote = null

  stopAmbient()
  startAmbient()

  const initialRemaining = Math.max(0, Math.ceil((voteDeadline - Date.now()) / 1000))
  renderVoteScreen(root, {
    options: voteOptions,
    tally: voteTally,
    remaining: initialRemaining,
    myVote,
    onVote: castVote,
    roundNumber,
    roundsCount,
  })

  clearInterval(voteTickHandle)
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((voteDeadline - Date.now()) / 1000))
    updateVoteScreen(root, { tally: voteTally, remaining, myVote })
    if (remaining > 0 && remaining <= 5) playTick()
    if (remaining <= 0) clearInterval(voteTickHandle)
  }
  voteTickHandle = setInterval(tick, 500)

  if (isHost) {
    clearTimeout(voteResolveHandle)
    voteResolveHandle = setTimeout(resolveVote, Math.max(0, deadline - Date.now()))
  }
}

function castVote(gameId) {
  myVote = gameId
  registerVote(gameId, getSelfId())
  sendParty({ type: 'vote-cast', gameId })
}

function registerVote(gameId, peerId) {
  for (const set of voteTally.values()) set.delete(peerId)
  voteTally.get(gameId)?.add(peerId)

  const remaining = Math.max(0, Math.ceil((voteDeadline - Date.now()) / 1000))
  updateVoteScreen(root, { tally: voteTally, remaining, myVote })

  if (isHost) {
    const totalVoted = new Set([...voteTally.values()].flatMap((s) => [...s])).size
    if (totalVoted >= getPlayers().length) {
      clearTimeout(voteResolveHandle)
      resolveVote()
    }
  }
}

function resolveVote() {
  clearTimeout(voteResolveHandle)
  clearInterval(voteTickHandle)
  stopAmbient()

  let winnerId = voteOptions[0]?.id
  let best = -1
  for (const [gameId, set] of voteTally) {
    const n = set.size + (Math.random() * 0.01) // léger bruit pour départager aléatoirement les égalités
    if (n > best) {
      best = n
      winnerId = gameId
    }
  }

  sendParty({ type: 'game-start', gameId: winnerId })
  enterGame(winnerId)
}

// --- Jeu ---

function enterGame(gameId) {
  currentPhase = 'game'
  clearInterval(voteTickHandle)
  clearTimeout(voteResolveHandle)
  stopAmbient()
  if (currentInstance) {
    currentInstance.destroy()
    currentInstance = null
  }

  const game = getGame(gameId)
  if (!game) return
  currentGameId = gameId

  const container = renderGameShell(root, standings, sendReaction)

  const ctx = {
    root: container,
    room: getRoom(),
    selfId: getSelfId(),
    isHost,
    turnsPerGame: partyConfig.turnsPerGame,
    questionDuration: partyConfig.questionDuration,
    difficulty: partyConfig.difficulty,
    category: partyConfig.category,
    eliminationMode: partyConfig.eliminationMode,
    getPlayers,
    onPlayersChange,
    getStandings: () => standings,
    onAnswerResult: handleAnswerResult,
    onGameEnd(rankings) {
      if (!isHost) return
      handleGameEnd(rankings)
    },
    onGameCancel(reason) {
      if (!isHost) return
      handleGameCancel(reason)
    },
  }

  currentInstance = game.mount(ctx)
}

function enterSpectating() {
  currentPhase = 'game'
  if (currentInstance) {
    currentInstance.destroy()
    currentInstance = null
  }
  renderSpectating(root)
}

function handleGameEnd(rankings) {
  if (currentGameId) {
    playedGameIds.add(currentGameId)
    if (rankings[0]) gameWinners.push({ gameId: currentGameId, peerId: rankings[0] })
  }
  gamesPlayed += 1
  standings = applyRankings(standings, rankings, getPlayers())
  const isFinal = gamesPlayed >= partyConfig.roundsCount

  const payload = {
    rankings,
    standings,
    isFinal,
    roundNumber: gamesPlayed,
    roundsCount: partyConfig.roundsCount,
    titles: isFinal ? computeTitles() : null,
  }
  sendParty({ type: 'game-end', ...payload })
  enterResults(payload)
}

function computeTitles() {
  const titles = []
  if (standings.length > 0) titles.push({ emoji: '🏆', label: 'MVP de la soirée', peerId: standings[0].peerId })
  if (standings.length > 1) titles.push({ emoji: '🐌', label: 'Lanterne rouge', peerId: standings[standings.length - 1].peerId })

  for (const gameId of Object.keys(TITLES)) {
    const wins = gameWinners.filter((w) => w.gameId === gameId)
    if (wins.length === 0) continue
    const counts = new Map()
    for (const w of wins) counts.set(w.peerId, (counts.get(w.peerId) ?? 0) + 1)
    const [topPeerId] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
    titles.push({ ...TITLES[gameId], peerId: topPeerId })
  }

  return titles
}

function handleGameCancel(reason) {
  sendParty({ type: 'game-cancel', reason })
  enterCancelled(reason)
}

function enterResults(payload) {
  const { rankings, standings: newStandings, isFinal, roundNumber, roundsCount, titles } = payload
  currentPhase = 'results'
  lastResultsPayload = payload
  standings = newStandings
  if (currentInstance) {
    currentInstance.destroy()
    currentInstance = null
  }

  if (isFinal) {
    playFanfare()
    burstConfetti()
    saveHistoryEntry({ date: Date.now(), standings, roundsCount, titles })
  }

  renderResultsScreen(root, {
    rankings,
    players: getPlayers(),
    standings,
    isHost,
    isFinal,
    roundNumber,
    roundsCount,
    titles,
    onContinue: () => {
      if (isHost) hostStartVote()
    },
    onRestart: () => {
      if (isHost) startParty(partyConfig)
    },
  })
}

function enterCancelled(reason) {
  currentPhase = 'cancelled'
  if (currentInstance) {
    currentInstance.destroy()
    currentInstance = null
  }
  root.innerHTML = '<main class="screen"><h1>Jeu annulé</h1></main>'
  renderCancelMessage(root, reason)
  if (isHost) {
    setTimeout(hostStartVote, CANCEL_RETRY_DELAY_MS)
  }
}
