import { escapeHtml } from '../../util/html.js'
import { fetchGameContentRetrying } from '../../network/content.js'
import { shuffle } from '../../util/shuffle.js'
import { playDing, playWrong, playTick } from '../../util/sound.js'

// Mots secrets servis en direct par le webhook (game=impostor) — table Grist dédiée
// DB_IMPOSTOR (Mot), branche n8n dédiée (séparée de DB_DRAW pour éviter d'avoir toujours
// les mêmes mots entre le jeu de dessin et l'imposteur).
const CLUE_DURATION_MS = 30000
const VOTE_DURATION_MS = 15000
const REVEAL_DURATION_MS = 5000
const CAUGHT_POINTS = 3
const ESCAPE_POINTS = 6
const GOOD_VOTE_BONUS = 1

async function fetchWords(count, customItems = []) {
  const overfetch = Math.max(count * 4, 12)
  let data
  try {
    data = await fetchGameContentRetrying('impostor', overfetch)
  } catch (err) {
    if (customItems.length === 0) throw err
    data = []
  }
  data = [...customItems, ...data]
  const seen = new Set()
  const words = data
    .map((item) => item?.word)
    .filter((w) => typeof w === 'string' && w.trim() && !seen.has(w) && seen.add(w))
  if (words.length === 0) throw new Error('empty')
  return shuffle(words).slice(0, count)
}

function render(root, state, players, handlers) {
  const nicknameOf = (peerId) => players.find((p) => p.peerId === peerId)?.nickname ?? '???'

  if (state.phase === 'loading') {
    root.innerHTML = '<main class="screen"><h1>Préparation de la ronde…</h1></main>'
    return
  }

  if (state.phase === 'clue') {
    root.innerHTML = `
      <main class="screen">
        <p class="muted">Manche ${state.i + 1} / ${state.total}</p>
        <div class="timer-bar"><div class="timer-bar-fill" id="imp-timer-fill"></div></div>
        <h1>${state.isImpostor ? "🕵️ Tu es l'IMPOSTEUR" : '🔎 Le mot secret'}</h1>
        <p class="impostor-word">${state.isImpostor ? 'Bluffe sans te faire démasquer !' : escapeHtml(state.word)}</p>
        <ul class="impostor-clues" id="impostor-clues">
          ${state.clues.map((c) => `<li><strong>${escapeHtml(nicknameOf(c.peerId))}</strong> ${escapeHtml(c.text)}</li>`).join('')}
        </ul>
        ${
          state.myClueSent
            ? '<p class="guess-sent-chip">✓ Indice envoyé, en attente des autres…</p>'
            : `<form id="impostor-clue-form" class="guess-answer-form">
                <input id="impostor-clue-input" type="text" maxlength="60" placeholder="Ton indice en un mot ou une phrase courte..." autocomplete="off" />
                <button type="submit">➤</button>
              </form>`
        }
      </main>
    `
    if (!state.myClueSent) {
      root.querySelector('#impostor-clue-form').addEventListener('submit', (e) => {
        e.preventDefault()
        const input = root.querySelector('#impostor-clue-input')
        const text = input.value.trim()
        if (!text) return
        handlers.onClue(text)
      })
    }
    startTicking(root, state.deadline)
    return
  }

  if (state.phase === 'vote') {
    root.innerHTML = `
      <main class="screen">
        <p class="muted">Manche ${state.i + 1} / ${state.total}</p>
        <div class="timer-bar"><div class="timer-bar-fill" id="imp-timer-fill"></div></div>
        <h1>🗳️ Qui est l'imposteur ?</h1>
        <ul class="impostor-clues">
          ${state.clues.map((c) => `<li><strong>${escapeHtml(nicknameOf(c.peerId))}</strong> ${escapeHtml(c.text)}</li>`).join('')}
        </ul>
        ${
          state.myVoteSent
            ? '<p class="guess-sent-chip">✓ Vote envoyé</p>'
            : `<div class="vote-grid impostor-vote-grid">
                ${players
                  .filter((p) => p.peerId !== state.selfId)
                  .map((p) => `<button type="button" class="vote-card impostor-suspect" data-peer="${p.peerId}"><h2>${escapeHtml(p.nickname)}</h2></button>`)
                  .join('')}
              </div>`
        }
      </main>
    `
    if (!state.myVoteSent) {
      root.querySelectorAll('.impostor-suspect').forEach((btn) => {
        btn.addEventListener('click', () => handlers.onVote(btn.dataset.peer))
      })
    }
    startTicking(root, state.deadline)
    return
  }

  // phase === 'reveal'
  stopTicking()
  const caught = state.imposteurId === state.mostVotedId
  if (state.selfId === state.imposteurId) {
    caught ? playWrong() : playDing()
  } else {
    caught ? playDing() : playWrong()
  }
  root.innerHTML = `
    <main class="screen">
      <p class="muted">Manche ${state.i + 1} / ${state.total}</p>
      <h1>${caught ? "🎉 L'imposteur a été démasqué !" : "😈 L'imposteur s'en sort !"}</h1>
      <p class="impostor-word">Le mot était : <strong>${escapeHtml(state.word)}</strong></p>
      <p class="muted">🕵️ Imposteur : ${escapeHtml(nicknameOf(state.imposteurId))}</p>
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
  const fill = root.querySelector('#imp-timer-fill')
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
  id: 'impostor',
  icon: '🕵️',
  title: 'Imposteur',
  description: "Un joueur reçoit un mot différent des autres — indices, débat, et vote pour le démasquer.",
  minPlayers: 3,

  mount(ctx) {
    const [sendAssign, receiveAssign] = ctx.room.makeAction('imp-a')
    const [sendClue, receiveClue] = ctx.room.makeAction('imp-c')
    const [sendStartVote, receiveStartVote] = ctx.room.makeAction('imp-sv')
    const [sendVote, receiveVote] = ctx.room.makeAction('imp-v')
    const [sendReveal, receiveReveal] = ctx.room.makeAction('imp-r')

    let words = []
    let currentTotal = 0
    let scores = new Map()
    let roundIndex = -1
    let currentWord = null
    let imposteurId = null
    let lastImposteurId = null
    let cluesThisRound = []
    let votesThisRound = new Map() // voterId -> votedForId
    let clueDeadline = 0
    let voteDeadline = 0
    let myClueSent = false
    let myVoteSent = false
    let myIsImpostor = false
    let timeoutHandle = null

    const renderState = (state) =>
      render(
        ctx.root,
        { ...state, selfId: ctx.selfId },
        ctx.getPlayers(),
        { onClue: submitClue, onVote: submitVote }
      )

    function submitClue(text) {
      if (myClueSent) return
      myClueSent = true
      sendClue({ round: roundIndex, text })
      if (ctx.isHost) recordClue(ctx.selfId, roundIndex, text)
      rerenderClue()
    }

    function recordClue(peerId, i, text) {
      if (i !== roundIndex || cluesThisRound.some((c) => c.peerId === peerId)) return
      cluesThisRound.push({ peerId, text })
      if (ctx.isHost && cluesThisRound.length >= ctx.getPlayers().length) {
        clearTimeout(timeoutHandle)
        startVote(roundIndex)
      }
    }

    function rerenderClue() {
      if (roundIndex < 0) return
      renderState({ phase: 'clue', i: roundIndex, total: currentTotal, word: currentWord, isImpostor: myIsImpostor, clues: cluesThisRound, myClueSent, deadline: clueDeadline })
    }

    function submitVote(votedFor) {
      if (myVoteSent) return
      myVoteSent = true
      sendVote({ round: roundIndex, votedFor })
      if (ctx.isHost) recordVote(ctx.selfId, roundIndex, votedFor)
      rerenderVote()
    }

    function recordVote(peerId, i, votedFor) {
      if (i !== roundIndex || votesThisRound.has(peerId)) return
      votesThisRound.set(peerId, votedFor)
      if (ctx.isHost && votesThisRound.size >= ctx.getPlayers().length) {
        clearTimeout(timeoutHandle)
        revealRound(roundIndex)
      }
    }

    function rerenderVote() {
      renderState({ phase: 'vote', i: roundIndex, total: currentTotal, clues: cluesThisRound, myVoteSent, deadline: voteDeadline })
    }

    receiveAssign((data) => {
      if (ctx.isHost) return
      roundIndex = data.round
      currentTotal = data.total
      currentWord = data.word
      myIsImpostor = data.isImpostor
      myClueSent = false
      cluesThisRound = []
      clueDeadline = data.deadline
      renderState({ phase: 'clue', i: data.round, total: data.total, word: data.word, isImpostor: data.isImpostor, clues: [], myClueSent: false, deadline: data.deadline })
    })

    receiveClue((data, peerId) => {
      if (ctx.isHost) recordClue(peerId, data.round, data.text)
      else if (data.round === roundIndex) {
        if (!cluesThisRound.some((c) => c.peerId === peerId)) cluesThisRound.push({ peerId, text: data.text })
        rerenderClue()
      }
    })

    receiveStartVote((data) => {
      if (ctx.isHost) return
      if (data.round !== roundIndex) return
      votesThisRound = new Map()
      myVoteSent = false
      voteDeadline = data.deadline
      rerenderVote()
    })

    receiveVote((data, peerId) => {
      if (ctx.isHost) recordVote(peerId, data.round, data.votedFor)
    })

    receiveReveal((data) => {
      if (ctx.isHost) return
      ctx.onAnswerResult?.(myIsImpostor ? data.imposteurId !== data.mostVotedId : data.imposteurId === data.mostVotedId)
      renderState({
        phase: 'reveal',
        i: data.round,
        total: data.total,
        word: data.word,
        imposteurId: data.imposteurId,
        mostVotedId: data.mostVotedId,
        scores: data.scores,
      })
    })

    function startRound(i) {
      roundIndex = i
      if (i >= words.length) {
        const rankings = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([peerId]) => peerId)
        ctx.onGameEnd(rankings)
        return
      }

      const players = ctx.getPlayers()
      let candidates = players.filter((p) => p.peerId !== lastImposteurId)
      if (candidates.length === 0) candidates = players
      const chosen = candidates[Math.floor(Math.random() * candidates.length)]
      imposteurId = chosen.peerId
      lastImposteurId = imposteurId
      currentTotal = words.length
      currentWord = words[i]
      cluesThisRound = []
      myClueSent = false
      clueDeadline = Date.now() + CLUE_DURATION_MS

      for (const p of players) {
        const isImpostor = p.peerId === imposteurId
        const payload = { round: i, total: currentTotal, word: isImpostor ? null : currentWord, isImpostor, deadline: clueDeadline }
        if (p.peerId === ctx.selfId) {
          myIsImpostor = isImpostor
          renderState({ phase: 'clue', ...payload, clues: [], myClueSent: false })
        } else {
          sendAssign(payload, p.peerId)
        }
      }

      timeoutHandle = setTimeout(() => startVote(i), CLUE_DURATION_MS)
    }

    function startVote(i) {
      if (i !== roundIndex) return
      clearTimeout(timeoutHandle)
      votesThisRound = new Map()
      myVoteSent = false
      voteDeadline = Date.now() + VOTE_DURATION_MS
      sendStartVote({ round: i, deadline: voteDeadline })
      rerenderVote()
      timeoutHandle = setTimeout(() => revealRound(i), VOTE_DURATION_MS)
    }

    function revealRound(i) {
      clearTimeout(timeoutHandle)
      const tally = new Map()
      for (const votedFor of votesThisRound.values()) tally.set(votedFor, (tally.get(votedFor) ?? 0) + 1)
      let mostVotedId = null
      let best = -1
      for (const [peerId, n] of tally) {
        if (n > best) {
          best = n
          mostVotedId = peerId
        }
      }
      const caught = mostVotedId === imposteurId
      ctx.onRoundRecap?.({ type: 'impostor', prompt: currentWord, imposteurId, caught })

      for (const p of ctx.getPlayers()) {
        let points = 0
        if (p.peerId === imposteurId) {
          points = caught ? 0 : ESCAPE_POINTS
        } else {
          points = caught ? CAUGHT_POINTS : 0
          if (votesThisRound.get(p.peerId) === imposteurId) points += GOOD_VOTE_BONUS
        }
        scores.set(p.peerId, (scores.get(p.peerId) ?? 0) + points)
      }

      const scoreList = [...scores.entries()].map(([peerId, points]) => ({ peerId, points }))
      const payload = { round: i, total: currentTotal, word: currentWord, imposteurId, mostVotedId, scores: scoreList }
      sendReveal(payload)
      renderState({ phase: 'reveal', ...payload })

      timeoutHandle = setTimeout(() => startRound(i + 1), REVEAL_DURATION_MS)
    }

    if (ctx.isHost) {
      renderState({ phase: 'loading' })
      fetchWords(ctx.turnsPerGame, ctx.customContent ?? [])
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
      ctx.root.innerHTML = '<main class="screen"><h1>Préparation de la ronde…</h1></main>'
    }

    return {
      destroy() {
        clearTimeout(timeoutHandle)
        stopTicking()
        receiveAssign(() => {})
        receiveClue(() => {})
        receiveStartVote(() => {})
        receiveVote(() => {})
        receiveReveal(() => {})
      },
    }
  },
}
