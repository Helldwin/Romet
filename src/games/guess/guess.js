import { escapeHtml } from '../../util/html.js'
import { normalizeGuess } from '../../util/text.js'
import { fetchGameContent } from '../../network/content.js'
import { playDing, playWrong, playTick } from '../../util/sound.js'

const DEFAULT_QUESTION_DURATION_MS = 15000
const REVEAL_DURATION_MS = 3000
const HINT_AT_RATIO = 2 / 3

const CATEGORY_HINTS = { Film: 'ce Film', Série: 'cette Série', Jeux: 'ce Jeu', Jeu: 'ce Jeu' }
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F']

function categoryHint(category) {
  if (!category) return 'Devine'
  return `Devine ${CATEGORY_HINTS[category] ?? category}`
}

function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function buildLengthHint(word, revealed) {
  return word
    .split('')
    .map((ch, idx) => (ch === ' ' ? ' ' : revealed.has(idx) ? ch : '_'))
    .join(' ')
}

async function fetchQuestions(count, category) {
  const extra = category && category !== 'all' ? { category } : {}
  const data = await fetchGameContent('guess', count, extra)
  const items = data.filter((item) => item && item.imageUrl && isHttpUrl(item.imageUrl) && item.answer)
  if (items.length === 0) throw new Error('empty')
  return items.slice(0, count)
}

function isCorrect(item, value) {
  if (item.choices) return item.choices[value] === item.answer
  return normalizeGuess(String(value)) === normalizeGuess(item.answer)
}

function render(root, state, players, onAnswer) {
  const nicknameOf = (peerId) => players.find((p) => p.peerId === peerId)?.nickname ?? '???'
  const fastestHtml = state.fastest
    ? `<p class="muted">⚡ Plus rapide : ${escapeHtml(state.fastest.nickname)} (${state.fastest.elapsedMs} ms)</p>`
    : ''

  if (state.phase === 'loading') {
    root.innerHTML = '<main class="screen"><h1>Chargement des images…</h1></main>'
    return
  }

  if (state.phase === 'question') {
    const answerBlock = state.choices
      ? `<div class="quiz-choices">
          ${state.choices
            .map(
              (c, idx) =>
                `<button class="quiz-choice${state.answered === idx ? ' selected' : ''}" data-idx="${idx}" ${state.answered !== null ? 'disabled' : ''}><span class="choice-letter">${LETTERS[idx]}</span>${escapeHtml(c)}</button>`
            )
            .join('')}
        </div>`
      : `<p class="muted length-hint">${escapeHtml(state.lengthHint ?? '')}</p>
        <form id="guess-form">
          ${
            state.answered !== null
              ? `<p class="muted">Réponse envoyée : ${escapeHtml(String(state.answered))}</p>`
              : '<input id="guess-input" type="text" placeholder="Ta réponse..." autocomplete="off" /><button type="submit">Valider</button>'
          }
        </form>`

    root.innerHTML = `
      <main class="screen">
        <p class="muted">Image ${state.i + 1} / ${state.total}</p>
        <div class="timer-bar"><div class="timer-bar-fill" id="guess-timer-fill"></div></div>
        <h1>${escapeHtml(categoryHint(state.category))}${state.genre ? ` <span class="genre-badge">${escapeHtml(state.genre)}</span>` : ''}</h1>
        <div class="guess-image-wrap">
          <img class="guess-image revealing" style="animation-duration:${state.questionDuration}ms;transform-origin:${state.revealOrigin}" src="${escapeHtml(state.imageUrl)}" alt="Devine" />
        </div>
        ${answerBlock}
      </main>
    `

    if (state.choices && state.answered === null) {
      root.querySelectorAll('.quiz-choice').forEach((btn) => {
        btn.addEventListener('click', () => onAnswer(Number(btn.dataset.idx)))
      })
    } else if (!state.choices && state.answered === null) {
      root.querySelector('#guess-form').addEventListener('submit', (e) => {
        e.preventDefault()
        const input = root.querySelector('#guess-input')
        const text = input.value.trim()
        if (!text) return
        onAnswer(text)
      })
    }
    startTicking(root, state.deadline)
    return
  }

  // phase === 'reveal'
  stopTicking()
  if (state.answered !== null && state.answered !== undefined) {
    if (isCorrect({ choices: state.choices, answer: state.answer }, state.answered)) playDing()
    else playWrong()
  }
  root.innerHTML = `
    <main class="screen">
      <p class="muted">Image ${state.i + 1} / ${state.total}${state.genre ? ` · ${escapeHtml(state.genre)}` : ''}</p>
      <img class="guess-image" src="${escapeHtml(state.imageUrl)}" alt="Réponse" />
      <h1>Réponse : ${escapeHtml(state.answer)}</h1>
      ${fastestHtml}
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
  const fill = root.querySelector('#guess-timer-fill')
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
  id: 'guess',
  icon: '🖼️',
  title: "Devine l'image",
  description: "Une image, un titre à deviner — questions fournies par l'hôte.",
  minPlayers: 2,

  mount(ctx) {
    const [sendAnswer, receiveAnswer] = ctx.room.makeAction('guess-a')
    const [sendQuestion, receiveQuestion] = ctx.room.makeAction('guess-q')
    const [sendReveal, receiveReveal] = ctx.room.makeAction('guess-r')
    const [sendHint, receiveHint] = ctx.room.makeAction('guess-h')

    const questionDuration = ctx.questionDuration ?? DEFAULT_QUESTION_DURATION_MS

    let items = []
    let scores = new Map()
    let fastest = null
    let roundIndex = -1
    let currentTotal = 0
    let currentItem = null
    let questionStartedAt = 0
    let questionDeadline = 0
    let revealOrigin = '50% 50%'
    let lengthHint = ''
    let revealedIndices = new Set()
    let hintTimeoutHandle = null
    let answersThisRound = new Map() // peerId -> { value, at }
    let localAnswer = null
    let timeoutHandle = null

    const renderState = (state) => render(ctx.root, { ...state, fastest, questionDuration, revealOrigin, lengthHint }, ctx.getPlayers(), submitAnswer)

    function submitAnswer(value) {
      if (localAnswer !== null || roundIndex < 0) return
      localAnswer = value
      sendAnswer({ i: roundIndex, value })
      if (ctx.isHost) recordAnswer(ctx.selfId, roundIndex, value)
      renderState({
        phase: 'question',
        i: roundIndex,
        total: currentTotal,
        imageUrl: currentItem?.imageUrl,
        choices: currentItem?.choices ?? null,
        category: currentItem?.category,
        genre: currentItem?.genre,
        deadline: questionDeadline,
        answered: value,
      })
    }

    function recordAnswer(peerId, i, value) {
      if (i !== roundIndex || answersThisRound.has(peerId)) return
      answersThisRound.set(peerId, { value, at: Date.now() })
    }

    receiveAnswer((data, peerId) => {
      if (!ctx.isHost) return
      recordAnswer(peerId, data.i, data.value)
    })

    receiveQuestion((data) => {
      if (ctx.isHost) return
      roundIndex = data.i
      currentTotal = data.total
      currentItem = { imageUrl: data.imageUrl, choices: data.choices, category: data.category, genre: data.genre }
      localAnswer = null
      revealOrigin = data.revealOrigin
      lengthHint = data.lengthHint ?? ''
      questionDeadline = data.deadline
      renderState({
        phase: 'question',
        i: data.i,
        total: data.total,
        imageUrl: data.imageUrl,
        choices: data.choices ?? null,
        category: data.category,
        genre: data.genre,
        deadline: data.deadline,
        answered: null,
      })
    })

    receiveHint((data) => {
      if (ctx.isHost) return
      if (data.i !== roundIndex) return
      lengthHint = data.lengthHint
      const hintEl = ctx.root.querySelector('.length-hint')
      if (hintEl) hintEl.textContent = lengthHint
    })

    receiveReveal((data) => {
      if (ctx.isHost) return
      fastest = data.fastest ?? fastest
      if (localAnswer !== null) ctx.onAnswerResult?.(isCorrect({ choices: data.choices, answer: data.answer }, localAnswer))
      renderState({
        phase: 'reveal',
        i: data.i,
        total: data.total,
        imageUrl: data.imageUrl,
        choices: data.choices,
        answer: data.answer,
        genre: data.genre,
        scores: data.scores,
        answered: localAnswer,
      })
    })

    function startRound(i) {
      roundIndex = i
      if (i >= items.length) {
        const rankings = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([peerId]) => peerId)
        ctx.onGameEnd(rankings)
        return
      }

      const item = items[i]
      currentTotal = items.length
      currentItem = { imageUrl: item.imageUrl, choices: item.choices, category: item.category, genre: item.genre }
      localAnswer = null
      answersThisRound = new Map()
      questionStartedAt = Date.now()
      questionDeadline = questionStartedAt + questionDuration
      revealOrigin = `${20 + Math.random() * 60}% ${20 + Math.random() * 60}%`
      revealedIndices = new Set()
      lengthHint = item.choices ? '' : buildLengthHint(item.answer, revealedIndices)

      const questionPayload = {
        i,
        total: items.length,
        imageUrl: item.imageUrl,
        choices: item.choices ?? null,
        category: item.category,
        genre: item.genre,
        deadline: questionDeadline,
        revealOrigin,
        lengthHint,
      }
      sendQuestion(questionPayload)
      renderState({ phase: 'question', ...questionPayload, answered: null })

      timeoutHandle = setTimeout(() => revealRound(i), questionDuration)

      if (!item.choices) {
        clearTimeout(hintTimeoutHandle)
        hintTimeoutHandle = setTimeout(() => {
          const hidden = item.answer.split('').map((_, idx) => idx).filter((idx) => item.answer[idx] !== ' ' && !revealedIndices.has(idx))
          if (hidden.length === 0) return
          revealedIndices.add(hidden[Math.floor(Math.random() * hidden.length)])
          lengthHint = buildLengthHint(item.answer, revealedIndices)
          sendHint({ i, lengthHint })
          const hintEl = ctx.root.querySelector('.length-hint')
          if (hintEl) hintEl.textContent = lengthHint
        }, questionDuration * HINT_AT_RATIO)
      }
    }

    function revealRound(i) {
      const item = items[i]
      const correctEntries = []
      if (localAnswer !== null) ctx.onAnswerResult?.(isCorrect(item, localAnswer))
      for (const [peerId, entry] of answersThisRound) {
        if (isCorrect(item, entry.value)) correctEntries.push({ peerId, at: entry.at })
      }
      correctEntries.sort((a, b) => a.at - b.at)
      for (const entry of correctEntries) {
        const elapsed = entry.at - questionStartedAt
        const points = Math.max(50, 100 - Math.floor(elapsed / 100))
        scores.set(entry.peerId, (scores.get(entry.peerId) ?? 0) + points)
        if (!fastest || elapsed < fastest.elapsedMs) {
          fastest = { peerId: entry.peerId, nickname: ctx.getPlayers().find((p) => p.peerId === entry.peerId)?.nickname ?? '???', elapsedMs: elapsed }
        }
      }

      const scoreList = [...scores.entries()].map(([peerId, points]) => ({ peerId, points }))
      const revealPayload = { i, total: items.length, imageUrl: item.imageUrl, choices: item.choices, answer: item.answer, genre: item.genre, scores: scoreList, fastest }
      sendReveal(revealPayload)
      renderState({ phase: 'reveal', ...revealPayload, answered: localAnswer })

      timeoutHandle = setTimeout(() => startRound(i + 1), REVEAL_DURATION_MS)
    }

    if (ctx.isHost) {
      renderState({ phase: 'loading' })
      fetchQuestions(ctx.turnsPerGame, ctx.category)
        .then((data) => {
          items = data
          scores = new Map(ctx.getPlayers().map((p) => [p.peerId, 0]))
          startRound(0)
        })
        .catch(() => {
          ctx.onGameCancel('fetch-failed')
        })
    } else {
      ctx.root.innerHTML = '<main class="screen"><h1>Chargement des images…</h1></main>'
    }

    return {
      destroy() {
        clearTimeout(timeoutHandle)
        clearTimeout(hintTimeoutHandle)
        stopTicking()
        receiveAnswer(() => {})
        receiveQuestion(() => {})
        receiveReveal(() => {})
        receiveHint(() => {})
      },
    }
  },
}
