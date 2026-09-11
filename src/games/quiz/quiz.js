import { escapeHtml } from '../../util/html.js'
import { fetchGameContentRetrying } from '../../network/content.js'
import { shuffle } from '../../util/shuffle.js'
import { playDing, playWrong, playTick } from '../../util/sound.js'

const DEFAULT_QUESTION_DURATION_MS = 10000
const REVEAL_DURATION_MS = 3500
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F']
const STREAK_BONUS_AT = 3
const STEAL_POINTS = 2

async function fetchQuestions(count, difficulty, excludeTexts, customItems = []) {
  const extra = difficulty && difficulty !== 'random' ? { difficulty } : {}
  const overfetch = Math.max(count * 3, count + 10)
  let data
  try {
    data = await fetchGameContentRetrying('quiz', overfetch, extra)
  } catch (err) {
    if (customItems.length === 0) throw err
    data = []
  }
  data = [...customItems, ...data]

  const seen = new Set()
  const valid = data.filter((q) => {
    if (!q || !q.text || !Array.isArray(q.choices) || !q.choices.includes(q.answer)) return false
    if (seen.has(q.text)) return false
    seen.add(q.text)
    return true
  })
  if (valid.length === 0) throw new Error('empty')

  // Priorité aux questions pas encore posées cette soirée ; si le pool frais
  // ne suffit pas, on complète avec des questions déjà vues plutôt que d'échouer.
  const fresh = valid.filter((q) => !excludeTexts.has(q.text))
  const pool = fresh.length > 0 ? fresh : valid

  return shuffle(pool)
    .slice(0, count)
    .map((q) => ({ ...q, choices: shuffle(q.choices) }))
}

function render(root, state, players, handlers) {
  const nicknameOf = (peerId) => players.find((p) => p.peerId === peerId)?.nickname ?? '???'

  if (state.phase === 'loading') {
    root.innerHTML = '<main class="screen"><h1>Chargement des questions…</h1></main>'
    return
  }

  const fastestHtml = state.fastest
    ? `<p class="muted">⚡ Plus rapide : ${escapeHtml(state.fastest.nickname)} (${state.fastest.elapsedMs} ms)</p>`
    : ''

  if (state.phase === 'question') {
    if (state.eliminatedIds?.includes(state.selfId)) {
      root.innerHTML = `
        <main class="screen">
          <p class="muted">Question ${state.i + 1} / ${state.total}</p>
          <h1>💀 Tu es éliminé pour cette manche</h1>
          <p class="muted">Regarde la suite, tu joueras au prochain jeu !</p>
        </main>
      `
      return
    }

    root.innerHTML = `
      <main class="screen">
        <p class="muted">Question ${state.i + 1} / ${state.total} — ${state.answeredCount}/${state.playerCount} ont répondu</p>
        <div class="timer-bar"><div class="timer-bar-fill" id="quiz-timer-fill"></div></div>
        ${state.image ? `<img class="guess-image" src="${escapeHtml(state.image)}" alt="" />` : ''}
        <h1>${escapeHtml(state.text)}</h1>
        <div class="quiz-choices">
          ${state.choices
            .map(
              (c, idx) =>
                `<button class="quiz-choice${state.answered === idx ? ' selected' : ''}" data-idx="${idx}" ${state.answered !== null ? 'disabled' : ''}><span class="choice-letter">${LETTERS[idx]}</span>${escapeHtml(c)}</button>`
            )
            .join('')}
        </div>
      </main>
    `
    if (state.answered === null) {
      root.querySelectorAll('.quiz-choice').forEach((btn) => {
        btn.addEventListener('click', () => handlers.onAnswer(Number(btn.dataset.idx)))
      })
    }
    startTicking(root, state.deadline)
    return
  }

  // phase === 'reveal'
  stopTicking()
  if (state.answered !== null) {
    if (state.answered === state.correct) playDing()
    else playWrong()
  }
  const maxCount = Math.max(1, ...(state.distribution ?? [1]))
  root.innerHTML = `
    <main class="screen">
      <p class="muted">Question ${state.i + 1} / ${state.total}</p>
      ${state.image ? `<img class="guess-image" src="${escapeHtml(state.image)}" alt="" />` : ''}
      <h1>${escapeHtml(state.text)}</h1>
      <div class="quiz-choices">
        ${state.choices
          .map((c, idx) => {
            const count = state.distribution?.[idx] ?? 0
            const pct = Math.round((count / maxCount) * 100)
            return `
              <button class="quiz-choice${idx === state.correct ? ' correct' : ''}${idx === state.answered && idx !== state.correct ? ' wrong' : ''}" disabled>
                <span class="choice-letter">${LETTERS[idx]}</span>${escapeHtml(c)}
                <span class="choice-bar" style="width:${pct}%"></span>
                <span class="choice-count">${count}</span>
              </button>
            `
          })
          .join('')}
      </div>
      ${fastestHtml}
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
  const fill = root.querySelector('#quiz-timer-fill')
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
  id: 'quiz',
  icon: '🧠',
  title: 'Quiz éclair',
  description: "Des questions à choix multiples fournies par l'hôte, réponds vite et bien.",
  minPlayers: 2,

  mount(ctx) {
    const [sendAnswer, receiveAnswer] = ctx.room.makeAction('quiz-a')
    const [sendQuestion, receiveQuestion] = ctx.room.makeAction('quiz-q')
    const [sendReveal, receiveReveal] = ctx.room.makeAction('quiz-r')
    const [sendProgress, receiveProgress] = ctx.room.makeAction('quiz-p')

    const questionDuration = ctx.questionDuration ?? DEFAULT_QUESTION_DURATION_MS
    const eliminationMode = ctx.eliminationMode ?? false

    let questions = []
    let scores = new Map()
    let streaks = new Map()
    let eliminated = new Set()
    let fastest = null // { peerId, nickname, elapsedMs }
    let roundIndex = -1
    let currentTotal = 0
    let currentQuestion = null
    let questionStartedAt = 0
    let questionDeadline = 0
    let answersThisRound = new Map() // peerId -> { choice, at }
    let localAnswer = null
    let answeredCount = 0
    let timeoutHandle = null

    const renderState = (state) =>
      render(ctx.root, { ...state, selfId: ctx.selfId, playerCount: ctx.getPlayers().length, fastest }, ctx.getPlayers(), {
        onAnswer: submitAnswer,
      })

    function submitAnswer(choice) {
      if (localAnswer !== null || roundIndex < 0 || !currentQuestion) return
      localAnswer = choice
      sendAnswer({ i: roundIndex, choice })
      if (ctx.isHost) recordAnswer(ctx.selfId, roundIndex, choice)
      renderState({
        phase: 'question',
        i: roundIndex,
        total: currentTotal,
        text: currentQuestion.text,
        image: currentQuestion.image,
        choices: currentQuestion.choices,
        answered: choice,
        answeredCount,
        deadline: questionDeadline,
        eliminatedIds: [...eliminated],
      })
    }

    function rerenderQuestion() {
      if (roundIndex < 0 || !currentQuestion) return
      renderState({
        phase: 'question',
        i: roundIndex,
        total: currentTotal,
        text: currentQuestion.text,
        image: currentQuestion.image,
        choices: currentQuestion.choices,
        answered: localAnswer,
        answeredCount,
        deadline: questionDeadline,
        eliminatedIds: [...eliminated],
      })
    }

    function recordAnswer(peerId, i, choice) {
      if (i !== roundIndex || answersThisRound.has(peerId) || eliminated.has(peerId)) return
      answersThisRound.set(peerId, { choice, at: Date.now() })
      answeredCount = answersThisRound.size
      sendProgress({ i, count: answeredCount })
      if (roundIndex === i) rerenderQuestion()
    }

    receiveAnswer((data, peerId) => {
      if (!ctx.isHost) return
      recordAnswer(peerId, data.i, data.choice)
    })

    receiveProgress((data) => {
      if (ctx.isHost) return
      if (data.i !== roundIndex) return
      answeredCount = data.count
      rerenderQuestion()
    })

    receiveQuestion((data) => {
      if (ctx.isHost) return
      roundIndex = data.i
      currentTotal = data.total
      currentQuestion = { text: data.text, choices: data.choices, image: data.image }
      localAnswer = null
      answeredCount = 0
      questionDeadline = data.deadline
      renderState({
        phase: 'question',
        i: data.i,
        total: data.total,
        text: data.text,
        image: data.image,
        choices: data.choices,
        answered: null,
        answeredCount: 0,
        deadline: data.deadline,
        eliminatedIds: data.eliminatedIds ?? [],
      })
    })

    receiveReveal((data) => {
      if (ctx.isHost) return
      fastest = data.fastest ?? fastest
      if (localAnswer !== null) ctx.onAnswerResult?.(localAnswer === data.correct)
      renderState({
        phase: 'reveal',
        i: data.i,
        total: data.total,
        text: data.text,
        image: data.image,
        choices: data.choices,
        correct: data.correct,
        distribution: data.distribution,
        answered: localAnswer,
        scores: data.scores,
      })
    })

    function startRound(i) {
      roundIndex = i
      if (i >= questions.length) {
        const survivors = ctx.getPlayers().map((p) => p.peerId).filter((id) => !eliminated.has(id))
        const rankedSurvivors = survivors.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))
        const rankedEliminated = [...eliminated].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))
        ctx.onGameEnd([...rankedSurvivors, ...rankedEliminated])
        return
      }

      const q = questions[i]
      currentTotal = questions.length
      currentQuestion = { text: q.text, choices: q.choices, image: q.image }
      localAnswer = null
      answersThisRound = new Map()
      answeredCount = 0
      questionStartedAt = Date.now()
      questionDeadline = questionStartedAt + questionDuration

      const payload = { i, total: currentTotal, text: q.text, image: q.image, choices: q.choices, deadline: questionDeadline, eliminatedIds: [...eliminated] }
      sendQuestion(payload)
      renderState({ phase: 'question', ...payload, answered: null, answeredCount: 0 })

      timeoutHandle = setTimeout(() => revealRound(i), questionDuration)
    }

    function revealRound(i) {
      const q = questions[i]
      const correctIndex = q.choices.indexOf(q.answer)
      const distribution = q.choices.map(() => 0)
      ctx.onRoundRecap?.({ type: 'quiz', prompt: q.text, choices: q.choices, answer: q.answer })
      ctx.onResponseTimes?.([...answersThisRound].map(([peerId, entry]) => ({ peerId, elapsedMs: entry.at - questionStartedAt })))
      const correctEntries = []
      if (localAnswer !== null) ctx.onAnswerResult?.(localAnswer === correctIndex)

      for (const [peerId, entry] of answersThisRound) {
        distribution[entry.choice] = (distribution[entry.choice] ?? 0) + 1
        if (q.choices[entry.choice] === q.answer) {
          correctEntries.push({ peerId, at: entry.at })
        } else if (eliminationMode) {
          eliminated.add(peerId)
        }
      }
      correctEntries.sort((a, b) => a.at - b.at)

      correctEntries.forEach((entry, idx) => {
        const elapsed = entry.at - questionStartedAt
        const base = Math.max(50, 100 - Math.floor(elapsed / 50))
        const streak = (streaks.get(entry.peerId) ?? 0) + 1
        streaks.set(entry.peerId, streak)
        const streakBonus = streak >= STREAK_BONUS_AT ? Math.floor(base * 0.5) : 0
        let points = base + streakBonus
        if (idx === 0 && scores.size > 1) {
          const [lastPeerId] = [...scores.entries()].sort((a, b) => a[1] - b[1])[0] ?? []
          if (lastPeerId && lastPeerId !== entry.peerId) {
            scores.set(lastPeerId, Math.max(0, (scores.get(lastPeerId) ?? 0) - STEAL_POINTS))
            points += STEAL_POINTS
          }
        }
        scores.set(entry.peerId, (scores.get(entry.peerId) ?? 0) + points)

        if (!fastest || elapsed < fastest.elapsedMs) {
          fastest = { peerId: entry.peerId, nickname: ctx.getPlayers().find((p) => p.peerId === entry.peerId)?.nickname ?? '???', elapsedMs: elapsed }
        }
      })

      // joueurs qui n'ont pas répondu du tout : streak cassée, éliminés si mode actif
      for (const p of ctx.getPlayers()) {
        if (!answersThisRound.has(p.peerId) && !eliminated.has(p.peerId)) {
          streaks.set(p.peerId, 0)
          if (eliminationMode) eliminated.add(p.peerId)
        }
      }

      const scoreList = [...scores.entries()].map(([peerId, points]) => ({ peerId, points }))
      const payload = {
        i,
        total: questions.length,
        text: q.text,
        image: q.image,
        choices: q.choices,
        correct: correctIndex,
        distribution,
        scores: scoreList,
        fastest,
      }
      sendReveal(payload)
      renderState({ phase: 'reveal', ...payload, answered: localAnswer })

      timeoutHandle = setTimeout(() => startRound(i + 1), REVEAL_DURATION_MS)
    }

    if (ctx.isHost) {
      renderState({ phase: 'loading' })
      fetchQuestions(ctx.turnsPerGame, ctx.difficulty, new Set(ctx.getUsedKeys?.() ?? []), ctx.customContent ?? [])
        .then((data) => {
          questions = data
          ctx.markUsedKeys?.(data.map((q) => q.text))
          scores = new Map(ctx.getPlayers().map((p) => [p.peerId, 0]))
          startRound(0)
        })
        .catch(() => {
          ctx.onGameCancel('fetch-failed')
        })
    } else {
      ctx.root.innerHTML = '<main class="screen"><h1>Chargement des questions…</h1></main>'
    }

    return {
      destroy() {
        clearTimeout(timeoutHandle)
        stopTicking()
        receiveAnswer(() => {})
        receiveQuestion(() => {})
        receiveReveal(() => {})
        receiveProgress(() => {})
      },
    }
  },
}
