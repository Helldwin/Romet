import { escapeHtml } from '../../util/html.js'
import { normalizeGuess } from '../../util/text.js'
import { shuffle } from '../../util/shuffle.js'
import { fetchGameContentRetrying } from '../../network/content.js'
import { playDing, playWrong, playTick } from '../../util/sound.js'

// Mots de 5 lettres servis en direct par le webhook (game=wordle) — table Grist dédiée
// DB_WORDLE (Mot), branche n8n dédiée. Les mots qui ne font pas 5 lettres sont filtrés
// côté client par sécurité (au cas où la table contiendrait des entrées erronées).
const WORD_LENGTH = 5
const MAX_GUESSES = 6
const ROUND_DURATION_MS = 90000
const REVEAL_DURATION_MS = 5000
const FIRST_SOLVER_BONUS = 15

async function pickWords(count, excludeWords, customItems = []) {
  const overfetch = Math.max(count * 4, 12)
  let data
  try {
    data = await fetchGameContentRetrying('wordle', overfetch)
  } catch (err) {
    if (customItems.length === 0) throw err
    data = []
  }
  data = [...customItems, ...data]

  const seen = new Set()
  const words = data
    .map((item) => item?.word?.toUpperCase())
    .filter((w) => typeof w === 'string' && w.length === WORD_LENGTH && !seen.has(w) && seen.add(w))
  if (words.length === 0) throw new Error('empty')

  const fresh = words.filter((w) => !excludeWords.has(w))
  const pool = fresh.length > 0 ? fresh : words
  return shuffle(pool).slice(0, count)
}

// Algorithme Wordle classique, gère correctement les lettres en double.
function computeFeedback(guess, secret) {
  const g = guess.split('')
  const s = secret.split('')
  const result = new Array(g.length).fill('absent')
  const remaining = [...s]
  for (let i = 0; i < g.length; i++) {
    if (g[i] === s[i]) {
      result[i] = 'correct'
      remaining[i] = null
    }
  }
  for (let i = 0; i < g.length; i++) {
    if (result[i] === 'correct') continue
    const idx = remaining.indexOf(g[i])
    if (idx !== -1) {
      result[i] = 'present'
      remaining[idx] = null
    }
  }
  return result
}

function rowHtml(letters, feedback) {
  return `<div class="wordle-row">${letters
    .map((ch, idx) => `<span class="wordle-cell wordle-${feedback ? feedback[idx] : 'empty'}">${escapeHtml(ch)}</span>`)
    .join('')}</div>`
}

function render(root, state, players, handlers) {
  const nicknameOf = (peerId) => players.find((p) => p.peerId === peerId)?.nickname ?? '???'

  if (state.phase === 'loading') {
    root.innerHTML = '<main class="screen"><h1>Préparation de la grille…</h1></main>'
    return
  }

  if (state.phase === 'play') {
    const rows = state.myGuesses.map((g) => rowHtml(g.letters, g.feedback))
    const emptyRowsCount = Math.max(0, MAX_GUESSES - state.myGuesses.length - (state.solved || state.exhausted ? 0 : 1))
    const currentRow = !state.solved && !state.exhausted ? rowHtml(Array.from({ length: WORD_LENGTH }, (_, i) => state.draft[i] ?? ''), null) : ''
    const emptyRows = Array.from({ length: emptyRowsCount }, () => rowHtml(Array(WORD_LENGTH).fill(''), null)).join('')

    root.innerHTML = `
      <main class="screen">
        <p class="muted">Manche ${state.i + 1} / ${state.total} — ${state.solvedCount}/${state.playerCount} ont fini</p>
        <div class="timer-bar"><div class="timer-bar-fill" id="wordle-timer-fill"></div></div>
        <h1>🔤 Wordle</h1>
        <div class="wordle-grid">${rows.join('')}${currentRow}${emptyRows}</div>
        ${
          state.solved
            ? `<p class="guess-sent-chip">✓ Trouvé en ${state.myGuesses.length} essai(s) !</p>`
            : state.exhausted
              ? '<p class="guess-sent-chip">Essais épuisés, en attente des autres…</p>'
              : `<form id="wordle-form" class="guess-answer-form">
                  <input id="wordle-input" type="text" maxlength="${WORD_LENGTH}" placeholder="Ton mot de ${WORD_LENGTH} lettres" autocomplete="off" style="text-transform:uppercase" />
                  <button type="submit">➤</button>
                </form>`
        }
      </main>
    `
    if (!state.solved && !state.exhausted) {
      root.querySelector('#wordle-form').addEventListener('submit', (e) => {
        e.preventDefault()
        const input = root.querySelector('#wordle-input')
        const word = normalizeGuess(input.value).toUpperCase()
        if (word.length !== WORD_LENGTH) return
        input.value = ''
        handlers.onGuess(word)
      })
    }
    startTicking(root, state.deadline)
    return
  }

  // phase === 'reveal'
  stopTicking()
  root.innerHTML = `
    <main class="screen">
      <p class="muted">Manche ${state.i + 1} / ${state.total}</p>
      <h1>Le mot était : ${escapeHtml(state.word)}</h1>
      <ol class="leaderboard">
        ${state.scores
          .slice()
          .sort((a, b) => b.points - a.points)
          .map((s) => `<li>${escapeHtml(nicknameOf(s.peerId))} <span class="points">${s.points} pts</span></li>`)
          .join('')}
      </ol>
    </main>
  `
}

let tickHandle = null
function startTicking(root, deadline) {
  stopTicking()
  const fill = root.querySelector('#wordle-timer-fill')
  const startedTotal = Math.max(1, deadline - Date.now())
  const tick = () => {
    const remainingMs = Math.max(0, deadline - Date.now())
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, (remainingMs / startedTotal) * 100))}%`
    const remainingS = Math.ceil(remainingMs / 1000)
    if (remainingMs > 0 && remainingMs <= 3000 && remainingS !== tick.lastS) {
      playTick()
      tick.lastS = remainingS
    }
    if (remainingMs <= 0) stopTicking()
  }
  tick()
  tickHandle = setInterval(tick, 100)
}
function stopTicking() {
  clearInterval(tickHandle)
  tickHandle = null
}

export default {
  id: 'wordle',
  icon: '🔤',
  title: 'Wordle',
  description: 'Devine le mot de 5 lettres en 6 essais — vert = bien placé, jaune = mal placé.',
  minPlayers: 2,

  mount(ctx) {
    const [sendRound, receiveRound] = ctx.room.makeAction('wdl-r')
    const [sendDone, receiveDone] = ctx.room.makeAction('wdl-d')
    const [sendReveal, receiveReveal] = ctx.room.makeAction('wdl-rv')

    let words = []
    let scores = new Map()
    let roundIndex = -1
    let currentTotal = 0
    let currentWord = ''
    let myGuesses = []
    let solved = false
    let exhausted = false
    let firstSolverId = null
    let doneThisRound = new Set()
    let finishedReports = new Map() // peerId -> { solved, guesses } (hôte uniquement)
    let roundDeadline = 0
    let timeoutHandle = null

    const renderState = (state) =>
      render(ctx.root, { ...state, playerCount: ctx.getPlayers().length, solvedCount: doneThisRound.size, draft: {} }, ctx.getPlayers(), { onGuess: submitGuess })

    function submitGuess(word) {
      if (solved || exhausted || roundIndex < 0) return
      const feedback = computeFeedback(word, currentWord)
      myGuesses.push({ letters: word.split(''), feedback })
      if (word === currentWord) {
        solved = true
        sendDone({ round: roundIndex, solved: true, guesses: myGuesses.length })
        if (ctx.isHost) recordDone(ctx.selfId, roundIndex, true, myGuesses.length)
      } else if (myGuesses.length >= MAX_GUESSES) {
        exhausted = true
        sendDone({ round: roundIndex, solved: false, guesses: myGuesses.length })
        if (ctx.isHost) recordDone(ctx.selfId, roundIndex, false, myGuesses.length)
      }
      renderState({ phase: 'play', i: roundIndex, total: currentTotal, myGuesses, solved, exhausted, deadline: roundDeadline })
    }

    function recordDone(peerId, i, wasSolved, guesses) {
      if (i !== roundIndex || doneThisRound.has(peerId)) return
      doneThisRound.add(peerId)
      finishedReports.set(peerId, { solved: wasSolved, guesses })
      if (wasSolved && !firstSolverId) firstSolverId = peerId
      if (ctx.isHost && doneThisRound.size >= ctx.getPlayers().length) {
        clearTimeout(timeoutHandle)
        finalizeScores(roundIndex)
      }
    }

    receiveRound((data) => {
      if (ctx.isHost) return
      roundIndex = data.round
      currentTotal = data.total
      currentWord = data.word
      myGuesses = []
      solved = false
      exhausted = false
      doneThisRound = new Set()
      roundDeadline = data.deadline
      renderState({ phase: 'play', i: data.round, total: data.total, myGuesses: [], solved: false, exhausted: false, deadline: data.deadline })
    })

    receiveDone((data, peerId) => {
      if (!ctx.isHost) return
      recordDone(peerId, data.round, data.solved, data.guesses)
    })

    receiveReveal((data) => {
      if (ctx.isHost) return
      scores = new Map(data.scores.map((s) => [s.peerId, s.points]))
      ctx.onAnswerResult?.(solved)
      renderState({ phase: 'reveal', i: data.round, total: data.total, word: data.word, scores: data.scores })
    })

    function startRound(i) {
      roundIndex = i
      if (i >= words.length) {
        const rankings = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([peerId]) => peerId)
        ctx.onGameEnd(rankings)
        return
      }

      currentTotal = words.length
      currentWord = words[i]
      myGuesses = []
      solved = false
      exhausted = false
      doneThisRound = new Set()
      finishedReports = new Map()
      firstSolverId = null
      roundDeadline = Date.now() + ROUND_DURATION_MS

      const payload = { round: i, total: words.length, word: currentWord, deadline: roundDeadline }
      sendRound(payload)
      renderState({ phase: 'play', i, total: words.length, myGuesses: [], solved: false, exhausted: false, deadline: roundDeadline })

      timeoutHandle = setTimeout(() => finalizeScores(i), ROUND_DURATION_MS)
    }

    // Points : plus on résout en peu d'essais, plus on gagne (max 70 pour un coup de chance
    // au 1er essai, min 10 dès qu'on trouve) ; +bonus au tout premier à résoudre ; 0 si non résolu.
    function finalizeScores(i) {
      clearTimeout(timeoutHandle)
      ctx.onRoundRecap?.({ type: 'wordle', prompt: 'Mot à deviner', answer: currentWord })
      const players = ctx.getPlayers()
      let bonusGiven = false
      for (const p of players) {
        const report = finishedReports.get(p.peerId)
        let points = 0
        if (report?.solved) {
          points = Math.max(10, 70 - (report.guesses - 1) * 10)
          if (p.peerId === firstSolverId && !bonusGiven) {
            points += FIRST_SOLVER_BONUS
            bonusGiven = true
          }
        }
        scores.set(p.peerId, (scores.get(p.peerId) ?? 0) + points)
      }

      const scoreList = players.map((p) => ({ peerId: p.peerId, points: scores.get(p.peerId) ?? 0 }))
      const payload = { round: i, total: words.length, word: currentWord, scores: scoreList }
      sendReveal(payload)
      renderState({ phase: 'reveal', ...payload })

      timeoutHandle = setTimeout(() => startRound(i + 1), REVEAL_DURATION_MS)
    }

    if (ctx.isHost) {
      renderState({ phase: 'loading' })
      pickWords(ctx.turnsPerGame, new Set(ctx.getUsedKeys?.() ?? []), ctx.customContent ?? [])
        .then((data) => {
          words = data
          ctx.markUsedKeys?.(data)
          scores = new Map(ctx.getPlayers().map((p) => [p.peerId, 0]))
          startRound(0)
        })
        .catch(() => {
          ctx.onGameCancel('fetch-failed')
        })
    } else {
      ctx.root.innerHTML = '<main class="screen"><h1>Préparation de la grille…</h1></main>'
    }

    return {
      destroy() {
        clearTimeout(timeoutHandle)
        stopTicking()
        receiveRound(() => {})
        receiveDone(() => {})
        receiveReveal(() => {})
      },
    }
  },
}
