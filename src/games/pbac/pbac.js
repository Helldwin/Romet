import { escapeHtml } from '../../util/html.js'
import { normalizeGuess } from '../../util/text.js'
import { shuffle } from '../../util/shuffle.js'
import { fetchGameContentRetrying } from '../../network/content.js'
import { playDing, playTick } from '../../util/sound.js'

// Catégories servies en direct par le webhook (game=pbac) — table Grist dédiée DB_PBAC
// (Categorie), branche n8n dédiée. Pas de notion de "bonne réponse" à valider : seule la
// 1ère lettre compte, le reste est jugé par les autres joueurs eux-mêmes (esprit classique).
const CATEGORIES_PER_ROUND = 5
const FALLBACK_CATEGORIES = ['Prénom', 'Pays / Ville', 'Animal', 'Métier', 'Objet', 'Fruit ou légume', 'Film / Série', 'Sport', 'Couleur', 'Célébrité']

async function fetchCategories(customItems = []) {
  let data
  try {
    data = await fetchGameContentRetrying('pbac', 30)
  } catch {
    data = []
  }
  const labels = [...customItems, ...data]
    .map((item) => item?.category)
    .filter((c, idx, arr) => typeof c === 'string' && c.trim() && arr.indexOf(c) === idx)
  const pool = labels.length >= CATEGORIES_PER_ROUND ? labels : FALLBACK_CATEGORIES
  return pool.map((label) => ({ id: normalizeGuess(label), label }))
}
const LETTERS = 'ABCDEFGHIJLMNOPRSTV'.split('') // lettres rares (K,Q,U,W,X,Y,Z) exclues
const ROUND_DURATION_MS = 60000
const REVEAL_DURATION_MS = 6000
const POINTS_UNIQUE = 3
const POINTS_SHARED = 1

function normalizeAnswer(text) {
  return normalizeGuess(text ?? '')
}

function isValidForLetter(text, letter) {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return false
  return normalizeAnswer(trimmed[0]) === normalizeAnswer(letter)
}

function render(root, state, players, handlers) {
  const nicknameOf = (peerId) => players.find((p) => p.peerId === peerId)?.nickname ?? '???'

  if (state.phase === 'loading') {
    root.innerHTML = '<main class="screen"><h1>Préparation du petit bac…</h1></main>'
    return
  }

  if (state.phase === 'fill') {
    root.innerHTML = `
      <main class="screen">
        <p class="muted">Manche ${state.i + 1} / ${state.total} — ${state.answeredCount}/${state.playerCount} ont validé</p>
        <div class="timer-bar"><div class="timer-bar-fill" id="pbac-timer-fill"></div></div>
        <h1>Lettre : ${escapeHtml(state.letter)}</h1>
        ${
          state.mySent
            ? '<p class="guess-sent-chip">✓ Réponses envoyées, en attente des autres…</p>'
            : `<form id="pbac-form" class="pbac-form">
                ${state.categories
                  .map(
                    (c) => `
                      <label class="field pbac-field">
                        ${escapeHtml(c.label)}
                        <input type="text" data-cat="${c.id}" maxlength="30" placeholder="${escapeHtml(state.letter)}..." autocomplete="off" />
                      </label>
                    `
                  )
                  .join('')}
                <button type="submit">Valider mes réponses</button>
              </form>`
        }
      </main>
    `
    if (!state.mySent) {
      root.querySelector('#pbac-form').addEventListener('submit', (e) => {
        e.preventDefault()
        const answers = {}
        root.querySelectorAll('#pbac-form input[data-cat]').forEach((input) => {
          answers[input.dataset.cat] = input.value.trim()
        })
        handlers.onSubmit(answers)
      })
    }
    startTicking(root, state.deadline)
    return
  }

  // phase === 'reveal'
  stopTicking()
  if (state.myPoints > 0) playDing()
  root.innerHTML = `
    <main class="screen">
      <p class="muted">Manche ${state.i + 1} / ${state.total} — Lettre ${escapeHtml(state.letter)}</p>
      <h1>Résultats 📝</h1>
      <div class="pbac-results">
        ${state.categories
          .map((c) => {
            const rows = players
              .map((p) => {
                const answer = state.answers[p.peerId]?.[c.id] ?? ''
                const valid = isValidForLetter(answer, state.letter)
                const points = valid ? (state.duplicateCounts[c.id]?.[normalizeAnswer(answer)] > 1 ? POINTS_SHARED : POINTS_UNIQUE) : 0
                return `<li class="${valid ? '' : 'pbac-invalid'}"><strong>${escapeHtml(p.nickname)}</strong> ${escapeHtml(answer || '—')} <span class="points">${points > 0 ? `+${points}` : '0'}</span></li>`
              })
              .join('')
            return `<div class="pbac-category"><h3>${escapeHtml(c.label)}</h3><ul>${rows}</ul></div>`
          })
          .join('')}
      </div>
      <h2>Scores</h2>
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
  const fill = root.querySelector('#pbac-timer-fill')
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
  id: 'pbac',
  icon: '📝',
  title: 'Petit Bac',
  description: 'Une lettre, plusieurs catégories — trouvez des mots avant les autres, les réponses uniques rapportent plus.',
  minPlayers: 2,

  mount(ctx) {
    const [sendRound, receiveRound] = ctx.room.makeAction('pbac-r')
    const [sendAnswer, receiveAnswer] = ctx.room.makeAction('pbac-a')
    const [sendReveal, receiveReveal] = ctx.room.makeAction('pbac-rv')

    let scores = new Map()
    let roundIndex = -1
    let categoryPool = []
    let currentLetter = ''
    let currentCategories = []
    let answersThisRound = new Map() // peerId -> { catId: text }
    let mySent = false
    let answeredCount = 0
    let roundDeadline = 0
    let timeoutHandle = null
    let usedLetters = new Set()

    const renderState = (state) =>
      render(ctx.root, { ...state, playerCount: ctx.getPlayers().length }, ctx.getPlayers(), { onSubmit: submitAnswers })

    function submitAnswers(answers) {
      if (mySent || roundIndex < 0) return
      mySent = true
      sendAnswer({ round: roundIndex, answers })
      if (ctx.isHost) recordAnswer(ctx.selfId, roundIndex, answers)
      renderState({ phase: 'fill', i: roundIndex, total: ctx.turnsPerGame, letter: currentLetter, categories: currentCategories, mySent: true, answeredCount, deadline: roundDeadline })
    }

    function recordAnswer(peerId, i, answers) {
      if (i !== roundIndex || answersThisRound.has(peerId)) return
      answersThisRound.set(peerId, answers)
      answeredCount = answersThisRound.size
      if (ctx.isHost && answeredCount >= ctx.getPlayers().length) {
        clearTimeout(timeoutHandle)
        revealRound(roundIndex)
      }
    }

    receiveRound((data) => {
      if (ctx.isHost) return
      roundIndex = data.round
      currentLetter = data.letter
      currentCategories = data.categories
      mySent = false
      answersThisRound = new Map()
      answeredCount = 0
      roundDeadline = data.deadline
      renderState({ phase: 'fill', i: data.round, total: data.total, letter: data.letter, categories: data.categories, mySent: false, answeredCount: 0, deadline: data.deadline })
    })

    receiveAnswer((data, peerId) => {
      if (!ctx.isHost) return
      recordAnswer(peerId, data.round, data.answers)
    })

    receiveReveal((data) => {
      if (ctx.isHost) return
      const myPoints = (data.scores.find((s) => s.peerId === ctx.selfId)?.points ?? 0) - (scores.get(ctx.selfId) ?? 0)
      scores = new Map(data.scores.map((s) => [s.peerId, s.points]))
      ctx.onAnswerResult?.(myPoints > 0)
      renderState({
        phase: 'reveal',
        i: data.round,
        total: data.total,
        letter: data.letter,
        categories: data.categories,
        answers: data.answers,
        duplicateCounts: data.duplicateCounts,
        scores: data.scores,
        myPoints,
      })
    })

    function startRound(i) {
      roundIndex = i
      if (i >= ctx.turnsPerGame) {
        const rankings = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([peerId]) => peerId)
        ctx.onGameEnd(rankings)
        return
      }

      const letterPool = LETTERS.filter((l) => !usedLetters.has(l))
      currentLetter = letterPool.length > 0 ? letterPool[Math.floor(Math.random() * letterPool.length)] : LETTERS[Math.floor(Math.random() * LETTERS.length)]
      usedLetters.add(currentLetter)
      currentCategories = shuffle(categoryPool).slice(0, CATEGORIES_PER_ROUND)
      answersThisRound = new Map()
      roundDeadline = Date.now() + ROUND_DURATION_MS
      mySent = false
      answeredCount = 0

      const payload = { round: i, total: ctx.turnsPerGame, letter: currentLetter, categories: currentCategories, deadline: roundDeadline }
      sendRound(payload)
      renderState({ phase: 'fill', ...payload, mySent: false, answeredCount: 0 })

      timeoutHandle = setTimeout(() => revealRound(i), ROUND_DURATION_MS)
    }

    function revealRound(i) {
      clearTimeout(timeoutHandle)
      const players = ctx.getPlayers()
      const answers = {}
      for (const p of players) answers[p.peerId] = answersThisRound.get(p.peerId) ?? {}
      ctx.onRoundRecap?.({ type: 'pbac', prompt: `Lettre ${currentLetter}`, answer: currentCategories.map((c) => c.label).join(', ') })

      // Compte les doublons (réponses valides normalisées identiques) par catégorie.
      const duplicateCounts = {}
      for (const cat of currentCategories) {
        const counts = {}
        for (const p of players) {
          const answer = answers[p.peerId]?.[cat.id]
          if (!isValidForLetter(answer, currentLetter)) continue
          const key = normalizeAnswer(answer)
          counts[key] = (counts[key] ?? 0) + 1
        }
        duplicateCounts[cat.id] = counts
      }

      const myPreviousPoints = scores.get(ctx.selfId) ?? 0
      for (const p of players) {
        let points = 0
        for (const cat of currentCategories) {
          const answer = answers[p.peerId]?.[cat.id]
          if (!isValidForLetter(answer, currentLetter)) continue
          const key = normalizeAnswer(answer)
          points += duplicateCounts[cat.id][key] > 1 ? POINTS_SHARED : POINTS_UNIQUE
        }
        scores.set(p.peerId, (scores.get(p.peerId) ?? 0) + points)
      }

      const scoreList = [...scores.entries()].map(([peerId, points]) => ({ peerId, points }))
      const payload = { round: i, total: ctx.turnsPerGame, letter: currentLetter, categories: currentCategories, answers, duplicateCounts, scores: scoreList }
      sendReveal(payload)
      renderState({ phase: 'reveal', ...payload, myPoints: (scoreList.find((s) => s.peerId === ctx.selfId)?.points ?? 0) - myPreviousPoints })

      timeoutHandle = setTimeout(() => startRound(i + 1), REVEAL_DURATION_MS)
    }

    if (ctx.isHost) {
      renderState({ phase: 'loading' })
      fetchCategories(ctx.customContent ?? [])
        .then((pool) => {
          categoryPool = pool
          scores = new Map(ctx.getPlayers().map((p) => [p.peerId, 0]))
          startRound(0)
        })
        .catch(() => {
          ctx.onGameCancel('fetch-failed')
        })
    } else {
      ctx.root.innerHTML = '<main class="screen"><h1>Préparation du petit bac…</h1></main>'
    }

    return {
      destroy() {
        clearTimeout(timeoutHandle)
        stopTicking()
        receiveRound(() => {})
        receiveAnswer(() => {})
        receiveReveal(() => {})
      },
    }
  },
}
