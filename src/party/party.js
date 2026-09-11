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
  renderIntroScreen,
  showFloatingReaction,
  showComboToast,
  showReactionCombo,
} from './views.js'
import { playTick, playFanfare, playIntroJingle, startAmbient, stopAmbient, setSoundTheme } from '../util/sound.js'
import { burstConfetti } from '../util/confetti.js'
import { saveHistoryEntry } from '../util/history.js'
import { getPersistedKeys, addPersistedKeys } from '../util/contentHistory.js'
import { recordSoireeResult } from '../util/tournament.js'
import { renderQrCode } from '../util/qr.js'

const VOTE_DURATION_MS = 15000
const VOTE_OPTIONS_COUNT = 3
const CANCEL_RETRY_DELAY_MS = 2500
const INTRO_DURATION_MS = 3000
const REACTION_COMBO_WINDOW_MS = 4000
const REACTION_COMBO_THRESHOLD = 3
const TITLES = {
  quiz: { emoji: '🧠', label: 'Cerveau du quiz' },
  draw: { emoji: '🎨', label: 'Picasso de la soirée' },
  guess: { emoji: '🖼️', label: 'Œil de lynx' },
  impostor: { emoji: '🕵️', label: 'Maître du bluff' },
  pbac: { emoji: '📝', label: 'Plume rapide' },
  wordle: { emoji: '🔤', label: 'Chasseur de mots' },
  define: { emoji: '📖', label: 'Dictionnaire vivant' },
}

export const DEFAULT_ROUNDS_COUNT = 3
export const DEFAULT_TURNS_PER_GAME = 5

let sendParty = null
let receiveParty = null
let registered = false

let root = null
let isHost = false
let isDisplay = false
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
let partyEliminated = new Set() // peerIds éliminés de la soirée (winCondition: 'elimination')
let roundHistory = [] // [{ roundNumber, gameId, standings }] — pour le dashboard stats final
let partyRecap = [] // [{ gameId, roundNumber, ...détail spécifique au jeu }] — revivre la soirée
let responseTimes = {} // peerId -> [elapsedMs] — pour le temps de réponse moyen dans le dashboard
let recentReactions = [] // [{ emoji, at }] — détection de combo de réactions
let lastComboAt = 0

// Contenu (questions/mots/images) déjà servi pendant la soirée en cours, par jeu —
// évite qu'un même item ressorte dans une manche suivante du même mini-jeu.
// Seul l'hôte alimente/consulte ces sets (lui seul appelle le webhook de contenu).
let usedContentKeys = { quiz: new Set(), draw: new Set(), guess: new Set() }

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

export function initParty(rootEl, hostFlag, displayFlag = false) {
  root = rootEl
  isHost = hostFlag
  isDisplay = displayFlag
  standings = []
  playedGameIds = new Set()
  gamesPlayed = 0
  gameWinners = []
  partyEliminated = new Set()
  roundHistory = []
  partyRecap = []
  responseTimes = {}
  recentReactions = []
  usedContentKeys = { quiz: new Set(), draw: new Set(), guess: new Set() }
  currentPhase = 'idle'
  knownPeerIds = new Set(getPlayers().map((p) => p.peerId))
  document.body.classList.toggle('display-mode', isDisplay)
  if (isDisplay) {
    showDisplayBadge()
    showPersistentQr()
  } else {
    hideDisplayBadge()
    hidePersistentQr()
  }
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
  partyEliminated = new Set()
  roundHistory = []
  partyRecap = []
  responseTimes = {}
  recentReactions = []
  unsubscribePlayers?.()
  unsubscribePlayers = null
  stopAmbient()
  document.body.classList.remove('display-mode')
  hideDisplayBadge()
  hidePersistentQr()
  isDisplay = false
  root = null
}

let displayBadgeEl = null
function showDisplayBadge() {
  if (displayBadgeEl) return
  displayBadgeEl = document.createElement('div')
  displayBadgeEl.className = 'display-badge'
  displayBadgeEl.textContent = '📱 Suivez la partie et répondez depuis vos téléphones !'
  document.body.appendChild(displayBadgeEl)
}
function hideDisplayBadge() {
  displayBadgeEl?.remove()
  displayBadgeEl = null
}

// QR code permanent en coin d'écran (mode présentateur) : permet aux retardataires de
// rejoindre en cours de soirée, pas seulement depuis la salle d'attente.
let persistentQrEl = null
function showPersistentQr() {
  if (persistentQrEl) return
  const room = getRoom()
  if (!room?.code) return
  persistentQrEl = document.createElement('div')
  persistentQrEl.className = 'persistent-qr'
  persistentQrEl.innerHTML = `<canvas></canvas><span class="persistent-qr-code">${room.code}</span>`
  document.body.appendChild(persistentQrEl)
  const url = new URL(location.href)
  url.searchParams.set('room', room.code)
  renderQrCode(persistentQrEl.querySelector('canvas'), url.toString()).catch(() => {
    persistentQrEl?.remove()
    persistentQrEl = null
  })
}
function hidePersistentQr() {
  persistentQrEl?.remove()
  persistentQrEl = null
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
    playlistMode: config?.playlistMode || 'vote', // 'vote' | 'manual'
    gameOrder: config?.gameOrder || [],
    winCondition: config?.winCondition || 'rounds', // 'rounds' | 'score' | 'elimination'
    scoreTarget: config?.scoreTarget || 50,
    teams: config?.teams || null, // [{ id, name, color, peerIds }] ou null si pas d'équipes
    customContent: config?.customContent || { quiz: [], draw: [], guess: [] },
    tournamentName: config?.tournamentName || '',
    soundTheme: config?.soundTheme || 'classique',
    handicap: config?.handicap || 'none', // 'none' | 'light' | 'strong'
    partyTitle: config?.partyTitle || '',
  }
  gamesPlayed = 0
  playedGameIds = new Set()
  gameWinners = []
  comboCount = 0
  partyEliminated = new Set()
  roundHistory = []
  partyRecap = []
  responseTimes = {}
  usedContentKeys = { quiz: new Set(), draw: new Set(), guess: new Set() }
  setSoundTheme(partyConfig.soundTheme)
  sendParty({ type: 'config', config: partyConfig })
  if (partyConfig.partyTitle) {
    sendParty({ type: 'intro', title: partyConfig.partyTitle })
    enterIntro(partyConfig.partyTitle)
    setTimeout(hostStartRound, INTRO_DURATION_MS)
  } else {
    hostStartRound()
  }
}

function enterIntro(title) {
  playIntroJingle()
  renderIntroScreen(root, title)
}

export function sendReaction(emoji) {
  if (!sendParty) return
  sendParty({ type: 'react', emoji })
  showFloatingReaction(getPlayers().find((p) => p.peerId === getSelfId())?.nickname ?? '', emoji)
  registerReaction(emoji)
}

// Présentateur uniquement ("régie") : force la fin de la manche en cours (bug de contenu,
// jeu qui traîne...) et repart sur le vote/jeu suivant, comme un game-cancel manuel.
export function skipCurrentGame() {
  if (!isHost || currentPhase !== 'game') return
  if (currentInstance) {
    currentInstance.destroy()
    currentInstance = null
  }
  handleGameCancel('host-skip')
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
      if (partyConfig.soundTheme) setSoundTheme(partyConfig.soundTheme)
      break
    case 'intro':
      enterIntro(msg.title)
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
      registerReaction(msg.emoji)
      break
    case 'bonus':
      applyBonusPoints(msg.peerId, msg.amount, false)
      break
    case 'sync':
      applySync(msg)
      break
  }
}

// Si plusieurs joueurs envoient la même réaction en peu de temps, une animation combo plus
// spectaculaire s'affiche (surtout visible sur l'écran de présentation).
function registerReaction(emoji) {
  const now = Date.now()
  recentReactions = recentReactions.filter((r) => now - r.at < REACTION_COMBO_WINDOW_MS)
  recentReactions.push({ emoji, at: now })
  const count = recentReactions.filter((r) => r.emoji === emoji).length
  if (count >= REACTION_COMBO_THRESHOLD && now - lastComboAt > REACTION_COMBO_WINDOW_MS) {
    lastComboAt = now
    showReactionCombo(emoji, count)
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

// Enchaîne soit sur un vote façon Mario Kart (par défaut), soit directement sur le
// prochain jeu de la playlist manuelle choisie par l'hôte à la création de la soirée.
function hostStartRound() {
  if (partyConfig.playlistMode === 'manual' && partyConfig.gameOrder.length > 0) {
    const gameId = partyConfig.gameOrder[gamesPlayed % partyConfig.gameOrder.length]
    sendParty({ type: 'game-start', gameId })
    enterGame(gameId)
  } else {
    hostStartVote()
  }
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
  startAmbient('game')
  if (currentInstance) {
    currentInstance.destroy()
    currentInstance = null
  }

  const game = getGame(gameId)
  if (!game) return
  currentGameId = gameId

  const container = renderGameShell(root, standings, sendReaction, isDisplay, skipCurrentGame)

  const ctx = {
    root: container,
    room: getRoom(),
    selfId: getSelfId(),
    isHost,
    isDisplay,
    turnsPerGame: partyConfig.turnsPerGame,
    questionDuration: partyConfig.questionDuration,
    difficulty: partyConfig.difficulty,
    category: partyConfig.category,
    eliminationMode: partyConfig.eliminationMode,
    customContent: partyConfig.customContent?.[gameId] ?? [],
    getPlayers,
    onPlayersChange,
    getStandings: () => standings,
    // Fusionne le contenu déjà servi cette soirée (mémoire) avec celui des soirées
    // précédentes sur cet appareil (localStorage, cf. util/contentHistory.js).
    getUsedKeys: () => [...new Set([...(usedContentKeys[gameId] ?? []), ...getPersistedKeys(gameId)])],
    markUsedKeys: (keys) => {
      if (!usedContentKeys[gameId]) usedContentKeys[gameId] = new Set()
      for (const k of keys) usedContentKeys[gameId].add(k)
      addPersistedKeys(gameId, keys)
    },
    onAnswerResult: handleAnswerResult,
    onRoundRecap(entry) {
      if (!isHost) return
      partyRecap.push({ gameId, roundNumber: gamesPlayed + 1, ...entry })
    },
    onResponseTimes(entries) {
      if (!isHost) return
      for (const e of entries) {
        if (!responseTimes[e.peerId]) responseTimes[e.peerId] = []
        responseTimes[e.peerId].push(e.elapsedMs)
      }
    },
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

  // Handicap : un petit bonus pour le dernier de la manche générale, pour resserrer l'écart
  // entre joueurs de niveaux différents — façon "carapace bleue" version douce.
  if (partyConfig.handicap && partyConfig.handicap !== 'none' && standings.length > 1) {
    const bonus = partyConfig.handicap === 'strong' ? 5 : 2
    const lastPeerId = standings[standings.length - 1].peerId
    standings = standings.map((s) => (s.peerId === lastPeerId ? { ...s, points: s.points + bonus } : s)).sort((a, b) => b.points - a.points)
  }

  roundHistory.push({ roundNumber: gamesPlayed, gameId: currentGameId, standings: standings.map((s) => ({ ...s })) })

  if (partyConfig.winCondition === 'elimination') {
    const remaining = standings.filter((s) => !partyEliminated.has(s.peerId))
    if (remaining.length > 1) partyEliminated.add(remaining[remaining.length - 1].peerId)
  }

  const isFinal = computeIsFinal()
  const teamStandings = computeTeamStandings()

  const payload = {
    rankings,
    standings,
    teamStandings,
    eliminatedIds: [...partyEliminated],
    roundHistory,
    partyRecap,
    responseTimes,
    isFinal,
    roundNumber: gamesPlayed,
    roundsCount: partyConfig.roundsCount,
    winCondition: partyConfig.winCondition,
    titles: isFinal ? computeTitles() : null,
  }
  sendParty({ type: 'game-end', ...payload })
  enterResults(payload)
}

function computeIsFinal() {
  if (partyConfig.winCondition === 'score') {
    return standings.some((s) => s.points >= partyConfig.scoreTarget) || gamesPlayed >= partyConfig.roundsCount
  }
  if (partyConfig.winCondition === 'elimination') {
    const remainingCount = getPlayers().length - partyEliminated.size
    return remainingCount <= 1 || gamesPlayed >= partyConfig.roundsCount
  }
  return gamesPlayed >= partyConfig.roundsCount
}

function computeTeamStandings() {
  if (!partyConfig.teams?.length) return null
  const pointsByPeer = new Map(standings.map((s) => [s.peerId, s.points]))
  return partyConfig.teams
    .map((team) => ({
      id: team.id,
      name: team.name,
      color: team.color,
      peerIds: team.peerIds,
      points: team.peerIds.reduce((sum, id) => sum + (pointsByPeer.get(id) ?? 0), 0),
    }))
    .sort((a, b) => b.points - a.points)
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
  const { rankings, standings: newStandings, teamStandings, eliminatedIds, roundHistory: history, partyRecap: recap, responseTimes: times, isFinal, roundNumber, roundsCount, winCondition, titles } = payload
  currentPhase = 'results'
  lastResultsPayload = payload
  standings = newStandings
  if (history) roundHistory = history
  if (recap) partyRecap = recap
  if (times) responseTimes = times
  if (eliminatedIds) partyEliminated = new Set(eliminatedIds)
  if (currentInstance) {
    currentInstance.destroy()
    currentInstance = null
  }

  if (isFinal) {
    playFanfare()
    burstConfetti()
    saveHistoryEntry({ date: Date.now(), standings, roundsCount, titles })
    if (isHost && partyConfig.tournamentName) {
      recordSoireeResult(partyConfig.tournamentName, standings, roundsCount)
    }
  }

  renderCurrentResults()
}

function renderCurrentResults() {
  if (!lastResultsPayload) return
  const { rankings, teamStandings, eliminatedIds, isFinal, roundNumber, roundsCount, winCondition, titles } = lastResultsPayload
  renderResultsScreen(root, {
    rankings,
    players: getPlayers(),
    standings,
    teamStandings,
    eliminatedIds: eliminatedIds ?? [],
    roundHistory: roundHistory ?? [],
    partyRecap,
    responseTimes,
    isHost,
    isFinal,
    roundNumber,
    roundsCount,
    winCondition,
    playlistMode: partyConfig.playlistMode,
    titles,
    onContinue: () => {
      if (isHost) hostStartRound()
    },
    onRestart: () => {
      if (isHost) startParty(partyConfig)
    },
    onBonusPoint: (peerId, amount) => {
      if (isHost) applyBonusPoints(peerId, amount, true)
    },
  })
}

// Points bonus manuels attribués par l'hôte (ex: faute de frappe évidente à l'écrit) —
// rejoue simplement l'écran de résultats avec le classement mis à jour, sans retrig
// les effets de fin de soirée (confetti/fanfare/historique déjà joués une fois).
function applyBonusPoints(peerId, amount, isLocalTrigger) {
  standings = standings.map((s) => (s.peerId === peerId ? { ...s, points: s.points + amount } : s))
  if (lastResultsPayload) lastResultsPayload = { ...lastResultsPayload, standings }
  if (isLocalTrigger) sendParty({ type: 'bonus', peerId, amount })
  if (currentPhase === 'results') renderCurrentResults()
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
    setTimeout(hostStartRound, CANCEL_RETRY_DELAY_MS)
  }
}
