import { escapeHtml } from '../../util/html.js'
import { normalizeGuess } from '../../util/text.js'
import { shuffle } from '../../util/shuffle.js'
import { fetchGameContentRetrying } from '../../network/content.js'
import { playDing, playWrong, playTick } from '../../util/sound.js'

// Contenu (mot + définition) servi en direct par le webhook (game=define), comme les autres
// jeux — table Grist dédiée DB_DEFINE (Mot, Definition), branche n8n dédiée.
const HINT_INTERVAL_MS = 12000
const ROUND_DURATION_MS = 45000
const REVEAL_DURATION_MS = 3500

function buildHint(word, revealed) {
  return word
    .split('')
    .map((ch, idx) => (ch === ' ' || ch === '-' ? ch : revealed.has(idx) ? ch : '_'))
    .join(' ')
}

async function fetchEntries(count, excludeWords, customItems = []) {
  const overfetch = Math.max(count * 3, count + 10)
  let data
  try {
    data = await fetchGameContentRetrying('define', overfetch)
  } catch (err) {
    if (customItems.length === 0) throw err
    data = []
  }
  data = [...customItems, ...data]

  const seen = new Set()
  const valid = data.filter((e) => {
    if (!e || !e.word || !e.def) return false
    if (seen.has(e.word)) return false
    seen.add(e.word)
    return true
  })
  if (valid.length === 0) throw new Error('empty')

  const fresh = valid.filter((e) => !excludeWords.has(e.word))
  const pool = fresh.length > 0 ? fresh : valid
  return shuffle(pool).slice(0, count)
}

function render(root, state, players, onAnswer) {
  const nicknameOf = (peerId) => players.find((p) => p.peerId === peerId)?.nickname ?? '???'
  const fastestHtml = state.fastest
    ? `<p class="muted">⚡ Plus rapide : ${escapeHtml(state.fastest.nickname)} (${state.fastest.elapsedMs} ms)</p>`
    : ''

  if (state.phase === 'loading') {
    root.innerHTML = '<main class="screen"><h1>Préparation des définitions…</h1></main>'
    return
  }

  if (state.phase === 'question') {
    root.innerHTML = `
      <main class="screen">
        <p class="muted">Définition ${state.i + 1} / ${state.total}</p>
        <div class="timer-bar"><div class="timer-bar-fill" id="define-timer-fill"></div></div>
        <h1>📖 Quel est ce mot ?</h1>
        <p class="impostor-word define-def">${escapeHtml(state.def)}</p>
        <p class="muted length-hint">${escapeHtml(state.lengthHint ?? '')}</p>
        <div class="guess-answer-wrap">
          <form id="define-form" class="guess-answer-form">
            ${
              state.answered !== null
                ? `<p class="guess-sent-chip">✓ Réponse envoyée : ${escapeHtml(String(state.answered))}</p>`
                : '<span class="guess-form-icon">📖</span><input id="define-input" type="text" placeholder="Ton mot..." autocomplete="off" /><button type="submit">➤</button>'
            }
          </form>
        </div>
      </main>
    `
    if (state.answered === null) {
      root.querySelector('#define-form').addEventListener('submit', (e) => {
        e.preventDefault()
        const input = root.querySelector('#define-input')
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
    normalizeGuess(String(state.answered)) === normalizeGuess(state.word) ? playDing() : playWrong()
  }
  root.innerHTML = `
    <main class="screen">
      <p class="muted">Définition ${state.i + 1} / ${state.total}</p>
      <h1>Le mot était : ${escapeHtml(state.word)}</h1>
      <p class="impostor-word define-def">${escapeHtml(state.def)}</p>
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
  const fill = root.querySelector('#define-timer-fill')
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
  id: 'define',
  icon: '📖',
  title: 'Définition Mystère',
  description: 'Devine le mot à partir de sa définition — des lettres se révèlent si personne ne trouve.',
  minPlayers: 2,

  mount(ctx) {
    const [sendAnswer, receiveAnswer] = ctx.room.makeAction('def-a')
    const [sendQuestion, receiveQuestion] = ctx.room.makeAction('def-q')
    const [sendHint, receiveHint] = ctx.room.makeAction('def-h')
    const [sendReveal, receiveReveal] = ctx.room.makeAction('def-r')

    const questionDuration = ctx.questionDuration ?? ROUND_DURATION_MS

    let entries = []
    let scores = new Map()
    let fastest = null
    let roundIndex = -1
    let currentTotal = 0
    let currentEntry = null
    let questionStartedAt = 0
    let questionDeadline = 0
    let lengthHint = ''
    let revealedIndices = new Set()
    let hintTimeoutHandle = null
    let answersThisRound = new Map()
    let localAnswer = null
    let timeoutHandle = null

    const renderState = (state) => render(ctx.root, { ...state, fastest, lengthHint }, ctx.getPlayers(), submitAnswer)

    function submitAnswer(value) {
      if (localAnswer !== null || roundIndex < 0) return
      localAnswer = value
      sendAnswer({ i: roundIndex, value })
      if (ctx.isHost) recordAnswer(ctx.selfId, roundIndex, value)
      renderState({ phase: 'question', i: roundIndex, total: currentTotal, def: currentEntry?.def, deadline: questionDeadline, answered: value })
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
      currentEntry = { def: data.def, word: data.word }
      localAnswer = null
      lengthHint = data.lengthHint ?? ''
      questionDeadline = data.deadline
      renderState({ phase: 'question', i: data.i, total: data.total, def: data.def, deadline: data.deadline, answered: null })
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
      if (localAnswer !== null) ctx.onAnswerResult?.(normalizeGuess(String(localAnswer)) === normalizeGuess(data.word))
      renderState({ phase: 'reveal', i: data.i, total: data.total, def: data.def, word: data.word, scores: data.scores, answered: localAnswer })
    })

    function startRound(i) {
      roundIndex = i
      if (i >= entries.length) {
        const rankings = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([peerId]) => peerId)
        ctx.onGameEnd(rankings)
        return
      }

      const entry = entries[i]
      currentTotal = entries.length
      currentEntry = entry
      localAnswer = null
      answersThisRound = new Map()
      questionStartedAt = Date.now()
      questionDeadline = questionStartedAt + questionDuration
      revealedIndices = new Set()
      lengthHint = buildHint(entry.word, revealedIndices)

      const payload = { i, total: currentTotal, def: entry.def, deadline: questionDeadline, lengthHint }
      sendQuestion(payload)
      renderState({ phase: 'question', ...payload, answered: null })

      timeoutHandle = setTimeout(() => revealRound(i), questionDuration)

      clearTimeout(hintTimeoutHandle)
      const scheduleHint = () => {
        hintTimeoutHandle = setTimeout(() => {
          const hidden = entry.word.split('').map((_, idx) => idx).filter((idx) => !/[ -]/.test(entry.word[idx]) && !revealedIndices.has(idx))
          if (hidden.length <= 1) return
          revealedIndices.add(hidden[Math.floor(Math.random() * hidden.length)])
          lengthHint = buildHint(entry.word, revealedIndices)
          sendHint({ i, lengthHint })
          const hintEl = ctx.root.querySelector('.length-hint')
          if (hintEl) hintEl.textContent = lengthHint
          scheduleHint()
        }, HINT_INTERVAL_MS)
      }
      scheduleHint()
    }

    function revealRound(i) {
      clearTimeout(timeoutHandle)
      clearTimeout(hintTimeoutHandle)
      const entry = entries[i]
      ctx.onRoundRecap?.({ type: 'define', prompt: entry.def, answer: entry.word })
      ctx.onResponseTimes?.([...answersThisRound].map(([peerId, a]) => ({ peerId, elapsedMs: a.at - questionStartedAt })))
      const correctEntries = []
      if (localAnswer !== null) ctx.onAnswerResult?.(normalizeGuess(String(localAnswer)) === normalizeGuess(entry.word))
      for (const [peerId, a] of answersThisRound) {
        if (normalizeGuess(a.value) === normalizeGuess(entry.word)) correctEntries.push({ peerId, at: a.at })
      }
      correctEntries.sort((a, b) => a.at - b.at)
      for (const entryScore of correctEntries) {
        const elapsed = entryScore.at - questionStartedAt
        const points = Math.max(50, 100 - Math.floor(elapsed / 100))
        scores.set(entryScore.peerId, (scores.get(entryScore.peerId) ?? 0) + points)
        if (!fastest || elapsed < fastest.elapsedMs) {
          fastest = { peerId: entryScore.peerId, nickname: ctx.getPlayers().find((p) => p.peerId === entryScore.peerId)?.nickname ?? '???', elapsedMs: elapsed }
        }
      }

      const scoreList = [...scores.entries()].map(([peerId, points]) => ({ peerId, points }))
      const payload = { i, total: currentTotal, def: entry.def, word: entry.word, scores: scoreList, fastest }
      sendReveal(payload)
      renderState({ phase: 'reveal', ...payload, answered: localAnswer })

      timeoutHandle = setTimeout(() => startRound(i + 1), REVEAL_DURATION_MS)
    }

    if (ctx.isHost) {
      renderState({ phase: 'loading' })
      fetchEntries(ctx.turnsPerGame, new Set(ctx.getUsedKeys?.() ?? []), ctx.customContent ?? [])
        .then((data) => {
          entries = data
          ctx.markUsedKeys?.(data.map((e) => e.word))
          scores = new Map(ctx.getPlayers().map((p) => [p.peerId, 0]))
          startRound(0)
        })
        .catch(() => {
          ctx.onGameCancel('fetch-failed')
        })
    } else {
      ctx.root.innerHTML = '<main class="screen"><h1>Préparation des définitions…</h1></main>'
    }

    return {
      destroy() {
        clearTimeout(timeoutHandle)
        clearTimeout(hintTimeoutHandle)
        stopTicking()
        receiveAnswer(() => {})
        receiveQuestion(() => {})
        receiveHint(() => {})
        receiveReveal(() => {})
      },
    }
  },
}
