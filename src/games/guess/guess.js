import { escapeHtml } from '../../util/html.js'
import { normalizeGuess } from '../../util/text.js'
import { fetchGameContentRetrying } from '../../network/content.js'
import { shuffle } from '../../util/shuffle.js'
import { playDing, playWrong, playTick } from '../../util/sound.js'

const DEFAULT_QUESTION_DURATION_MS = 15000
const REVEAL_DURATION_MS = 3000
const HINT_AT_RATIO = 2 / 3

const CATEGORY_HINTS = { Film: 'ce Film', Serie: 'cette Série', Jeu: 'ce Jeu' }
const CATEGORY_PILLS = { Film: '🎬 Film', Serie: '📺 Série', Jeu: '🎮 Jeu' }
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F']

function categoryHint(category) {
  if (!category) return 'Devine'
  return `Devine ${CATEGORY_HINTS[category] ?? category}`
}

function categoryPill(category) {
  return category ? (CATEGORY_PILLS[category] ?? category) : null
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

async function fetchQuestions(count, category, excludeAnswers, customItems = []) {
  const extra = category && category !== 'all' ? { category } : {}
  const overfetch = Math.max(count * 3, count + 10)
  let data
  try {
    data = await fetchGameContentRetrying('guess', overfetch, extra)
  } catch (err) {
    if (customItems.length === 0) throw err
    data = []
  }
  data = [...customItems, ...data]

  const seen = new Set()
  const valid = data.filter((item) => {
    if (!item || !item.imageUrl || !isHttpUrl(item.imageUrl) || !item.answer) return false
    if (seen.has(item.answer)) return false
    seen.add(item.answer)
    return true
  })
  if (valid.length === 0) throw new Error('empty')

  const fresh = valid.filter((item) => !excludeAnswers.has(item.answer))
  const pool = fresh.length > 0 ? fresh : valid

  return shuffle(pool).slice(0, count)
}

const ANSWER_POOL_SIZE = 250

// Récupère une grosse liste de titres possibles (juste les noms, pas les questions du round)
// pour alimenter l'autocomplétion — volontairement plus large que la manche en cours pour ne
// pas donner d'indice sur la bonne réponse par élimination.
async function fetchAnswerPool(category) {
  const extra = category && category !== 'all' ? { category } : {}
  try {
    const data = await fetchGameContentRetrying('guess', ANSWER_POOL_SIZE, extra, 1)
    const names = data.filter((item) => item?.answer).map((item) => item.answer)
    return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'fr'))
  } catch {
    return []
  }
}

function filterSuggestions(pool, query) {
  const q = normalizeGuess(query)
  if (!q) return []
  return pool.filter((name) => normalizeGuess(name).includes(q)).slice(0, 6)
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
    const pill = categoryPill(state.category)
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
        <div class="guess-answer-wrap">
          <form id="guess-form" class="guess-answer-form">
            ${
              state.answered !== null
                ? `<p class="guess-sent-chip">✓ Réponse envoyée : ${escapeHtml(String(state.answered))}</p>`
                : '<span class="guess-form-icon">🔍</span><input id="guess-input" type="text" placeholder="Ton titre..." autocomplete="off" /><button type="submit">➤</button>'
            }
          </form>
          ${state.answered === null ? '<ul id="guess-suggestions" class="guess-suggestions" hidden></ul>' : ''}
        </div>`

    root.innerHTML = `
      <main class="screen">
        <p class="muted">Image ${state.i + 1} / ${state.total}</p>
        <div class="timer-bar"><div class="timer-bar-fill" id="guess-timer-fill"></div></div>
        <h1>${escapeHtml(categoryHint(state.category))}</h1>
        <div class="guess-cover">
          <div class="guess-cover-badges">
            ${pill ? `<span class="guess-pill">${escapeHtml(pill)}</span>` : ''}
            ${state.genre ? `<span class="guess-pill guess-pill-genre">${escapeHtml(state.genre)}</span>` : ''}
          </div>
          <div class="guess-image-wrap">
            <img class="guess-image revealing" style="animation-duration:${state.questionDuration}ms;transform-origin:${state.revealOrigin}" src="${escapeHtml(state.imageUrl)}" alt="Devine" />
          </div>
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

      const input = root.querySelector('#guess-input')
      const suggestionsEl = root.querySelector('#guess-suggestions')
      const pool = state.answerPool ?? []
      if (input && suggestionsEl && pool.length > 0) {
        input.addEventListener('input', () => {
          const matches = filterSuggestions(pool, input.value)
          if (matches.length === 0) {
            suggestionsEl.hidden = true
            suggestionsEl.innerHTML = ''
            return
          }
          suggestionsEl.innerHTML = matches
            .map((name) => `<li class="guess-suggestion-item" data-name="${escapeHtml(name)}">${escapeHtml(name)}</li>`)
            .join('')
          suggestionsEl.hidden = false
        })
        // mousedown (avant le blur de l'input) pour que le clic sur une suggestion marche
        suggestionsEl.addEventListener('mousedown', (e) => {
          const li = e.target.closest('.guess-suggestion-item')
          if (!li) return
          e.preventDefault()
          suggestionsEl.hidden = true
          onAnswer(li.dataset.name)
        })
        input.addEventListener('blur', () => {
          setTimeout(() => {
            suggestionsEl.hidden = true
          }, 120)
        })
      }
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
  const revealPill = categoryPill(state.category)
  root.innerHTML = `
    <main class="screen">
      <p class="muted">Image ${state.i + 1} / ${state.total}</p>
      <div class="guess-cover guess-cover-reveal">
        <img class="guess-image" src="${escapeHtml(state.imageUrl)}" alt="Réponse" />
        <div class="guess-reveal-caption">
          <h1>${escapeHtml(state.answer)}</h1>
          <div class="guess-cover-badges">
            ${revealPill ? `<span class="guess-pill">${escapeHtml(revealPill)}</span>` : ''}
            ${state.genre ? `<span class="guess-pill guess-pill-genre">${escapeHtml(state.genre)}</span>` : ''}
            ${state.year ? `<span class="guess-pill guess-pill-year">${escapeHtml(String(state.year))}</span>` : ''}
          </div>
        </div>
      </div>
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
    const [sendPool, receivePool] = ctx.room.makeAction('guess-p')

    const questionDuration = ctx.questionDuration ?? DEFAULT_QUESTION_DURATION_MS

    let items = []
    let answerPool = []
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

    const renderState = (state) =>
      render(ctx.root, { ...state, fastest, questionDuration, revealOrigin, lengthHint, answerPool }, ctx.getPlayers(), submitAnswer)

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

    receivePool((data) => {
      if (ctx.isHost) return
      answerPool = data ?? []
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
        category: data.category,
        genre: data.genre,
        year: data.year,
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
      ctx.onRoundRecap?.({ type: 'guess', prompt: item.category, answer: item.answer, imageUrl: item.imageUrl })
      ctx.onResponseTimes?.([...answersThisRound].map(([peerId, entry]) => ({ peerId, elapsedMs: entry.at - questionStartedAt })))
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
      const revealPayload = {
        i,
        total: items.length,
        imageUrl: item.imageUrl,
        choices: item.choices,
        answer: item.answer,
        category: item.category,
        genre: item.genre,
        year: item.year,
        scores: scoreList,
        fastest,
      }
      sendReveal(revealPayload)
      renderState({ phase: 'reveal', ...revealPayload, answered: localAnswer })

      timeoutHandle = setTimeout(() => startRound(i + 1), REVEAL_DURATION_MS)
    }

    if (ctx.isHost) {
      renderState({ phase: 'loading' })
      fetchQuestions(ctx.turnsPerGame, ctx.category, new Set(ctx.getUsedKeys?.() ?? []), ctx.customContent ?? [])
        .then(async (data) => {
          items = data
          ctx.markUsedKeys?.(data.map((item) => item.answer))
          scores = new Map(ctx.getPlayers().map((p) => [p.peerId, 0]))
          // Pool plus large que la manche en cours, uniquement pour l'autocomplétion —
          // ne doit pas se limiter aux quelques titres réellement en jeu.
          answerPool = await fetchAnswerPool(ctx.category)
          sendPool(answerPool)
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
        receivePool(() => {})
      },
    }
  },
}
