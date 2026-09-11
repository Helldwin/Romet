import { escapeHtml } from '../../util/html.js'
import { normalizeGuess } from '../../util/text.js'
import { fetchGameContentRetrying } from '../../network/content.js'
import { shuffle } from '../../util/shuffle.js'
import { playDing } from '../../util/sound.js'
import { levenshtein } from '../../util/levenshtein.js'
import { avatarHtmlOf } from '../../util/avatar.js'

const CHOOSE_DURATION_MS = 8000
const BASE_TURN_DURATION_MS = 45000
const MS_PER_LETTER = 2000
const MAX_TURN_DURATION_MS = 90000
const REVEAL_DURATION_MS = 4000
const HINT_INTERVAL_MS = 15000
const CANVAS_W = 500
const CANVAS_H = 350
const GUESS_POINTS = [3, 2]
const GUESS_POINTS_FALLBACK = 1
const STROKE_THROTTLE_MS = 40
const CLOSE_GUESS_DISTANCE = 2
const CANVAS_BG = '#ffffff'
const COLORS = ['#2B2250', '#FF5C7A', '#4DABF7', '#2FBF71', '#FFA94D', '#DA77F2']

function computeTurnDuration(word) {
  return Math.min(MAX_TURN_DURATION_MS, BASE_TURN_DURATION_MS + word.length * MS_PER_LETTER)
}

function buildHint(word, revealed) {
  return word
    .split('')
    .map((ch, idx) => (ch === ' ' ? ' ' : revealed.has(idx) ? ch : '_'))
    .join(' ')
}

async function fetchWords(count, excludeWords, customItems = []) {
  const overfetch = Math.max(count * 3, count + 15)
  let data
  try {
    data = await fetchGameContentRetrying('draw', overfetch)
  } catch (err) {
    if (customItems.length === 0) throw err
    data = []
  }
  data = [...customItems, ...data]

  const seen = new Set()
  const valid = data
    .map((item) => item?.word)
    .filter((word) => typeof word === 'string' && word.trim() && !seen.has(word) && seen.add(word))
  if (valid.length === 0) throw new Error('empty')

  const fresh = valid.filter((word) => !excludeWords.has(word))
  const pool = fresh.length > 0 ? fresh : valid

  return shuffle(pool).slice(0, count)
}

export default {
  id: 'draw',
  icon: '🎨',
  title: "Dessine c'est deviner",
  description: "Chacun son tour de dessiner un mot fourni par l'hôte, les autres devinent.",
  minPlayers: 2,

  mount(ctx) {
    const [sendTurn, receiveTurn] = ctx.room.makeAction('draw-t')
    const [sendStroke, receiveStroke] = ctx.room.makeAction('draw-s')
    const [sendGuess, receiveGuess] = ctx.room.makeAction('draw-g')
    const [sendCorrect, receiveCorrect] = ctx.room.makeAction('draw-c')
    const [sendEnd, receiveEnd] = ctx.room.makeAction('draw-e')
    const [sendUndo, receiveUndo] = ctx.room.makeAction('draw-u')
    const [sendHint, receiveHint] = ctx.room.makeAction('draw-h')
    const [sendWordPick, receiveWordPick] = ctx.room.makeAction('draw-w')
    const [sendLike, receiveLike] = ctx.room.makeAction('draw-v')

    // état hôte uniquement
    let turnOrder = []
    let wordPool = []
    let effectiveTurns = ctx.turnsPerGame
    let scores = new Map()
    let currentDrawerId = null
    let currentWord = null
    let foundOrder = []
    let revealedIndices = new Set()
    let hintHandle = null
    let choiceTimeoutHandle = null
    let wordChosenForRound = -1
    let bestDrawing = null // { drawerId, nickname, word, likes }

    // état partagé (tous les clients)
    let turnRound = -1
    let myRole = null // 'drawer' | 'guesser' | 'found'
    let deadline = 0
    let timeoutHandle = null
    let tickHandle = null
    let canvasEl = null
    let canvasCtx = null
    let chatListEl = null
    let inputEl = null
    let timerEl = null
    let drawing = false
    let lastPos = null
    let pendingStart = null
    let lastSendAt = 0
    let currentColor = COLORS[0]
    let isEraser = false
    let strokeHistory = [] // [{ color, segments: [{x0,y0,x1,y1}] }]
    let likedThisTurn = false
    let scoresLocal = new Map(ctx.getPlayers().map((p) => [p.peerId, 0]))
    let foundPeerIdsLocal = new Set()
    let sidebarEl = null

    const nicknameOf = (peerId) => ctx.getPlayers().find((p) => p.peerId === peerId)?.nickname ?? '???'
    const hostPeerId = () => ctx.getPlayers().find((p) => p.isHost)?.peerId

    function scalePos(e) {
      const rect = canvasEl.getBoundingClientRect()
      const x = ((e.clientX - rect.left) / rect.width) * CANVAS_W
      const y = ((e.clientY - rect.top) / rect.height) * CANVAS_H
      return { x, y }
    }

    function drawSegment(x0, y0, x1, y1, color) {
      if (!canvasCtx) return
      canvasCtx.beginPath()
      canvasCtx.moveTo(x0, y0)
      canvasCtx.lineTo(x1, y1)
      canvasCtx.strokeStyle = color
      canvasCtx.lineWidth = color === CANVAS_BG ? 16 : 3
      canvasCtx.lineCap = 'round'
      canvasCtx.stroke()
    }

    function recordSegment(x0, y0, x1, y1, color, isNewStroke) {
      if (isNewStroke || strokeHistory.length === 0) strokeHistory.push({ color, segments: [] })
      strokeHistory[strokeHistory.length - 1].segments.push({ x0, y0, x1, y1 })
      drawSegment(x0, y0, x1, y1, color)
    }

    function redrawAll() {
      if (!canvasCtx) return
      canvasCtx.clearRect(0, 0, CANVAS_W, CANVAS_H)
      for (const stroke of strokeHistory) {
        for (const seg of stroke.segments) drawSegment(seg.x0, seg.y0, seg.x1, seg.y1, stroke.color)
      }
    }

    function onPointerDown(e) {
      drawing = true
      lastPos = scalePos(e)
      pendingStart = lastPos
      lastSendAt = 0
    }
    function onPointerMove(e) {
      if (!drawing) return
      const pos = scalePos(e)
      const color = isEraser ? CANVAS_BG : currentColor
      const now = Date.now()
      if (now - lastSendAt >= STROKE_THROTTLE_MS) {
        recordSegment(pendingStart.x, pendingStart.y, pos.x, pos.y, color, lastSendAt === 0)
        sendStroke({ x0: pendingStart.x, y0: pendingStart.y, x1: pos.x, y1: pos.y, color, newStroke: lastSendAt === 0 })
        pendingStart = pos
        lastSendAt = now
      } else {
        drawSegment(lastPos.x, lastPos.y, pos.x, pos.y, color)
      }
      lastPos = pos
    }
    function onPointerUp() {
      if (drawing && pendingStart && lastPos && (pendingStart.x !== lastPos.x || pendingStart.y !== lastPos.y)) {
        const color = isEraser ? CANVAS_BG : currentColor
        recordSegment(pendingStart.x, pendingStart.y, lastPos.x, lastPos.y, color, lastSendAt === 0)
        sendStroke({ x0: pendingStart.x, y0: pendingStart.y, x1: lastPos.x, y1: lastPos.y, color, newStroke: lastSendAt === 0 })
      }
      drawing = false
    }

    function onUndo() {
      if (strokeHistory.length === 0) return
      strokeHistory.pop()
      redrawAll()
      sendUndo({})
    }

    function appendChatLine(text, className = '') {
      if (!chatListEl) return
      const li = document.createElement('li')
      if (className) li.className = className
      li.textContent = text
      chatListEl.appendChild(li)
      chatListEl.scrollTop = chatListEl.scrollHeight
    }

    function updateTimer() {
      if (!timerEl) return
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      timerEl.textContent = `${remaining}s`
    }

    function renderSidebarHtml() {
      const players = [...ctx.getPlayers()].sort((a, b) => (scoresLocal.get(b.peerId) ?? 0) - (scoresLocal.get(a.peerId) ?? 0))
      return players
        .map((p) => {
          const isDrawer = p.peerId === currentDrawerId
          const found = foundPeerIdsLocal.has(p.peerId)
          const statusIcon = isDrawer ? '✏️' : found ? '✅' : ''
          const { emoji, color } = avatarHtmlOf(p.avatar)
          return `
            <li class="draw-player${isDrawer ? ' is-drawer' : ''}${found ? ' has-found' : ''}${p.peerId === ctx.selfId ? ' is-me' : ''}">
              <span class="avatar draw-player-avatar" style="background:${color}">${escapeHtml(emoji)}</span>
              <span class="draw-player-name">${escapeHtml(p.nickname)}</span>
              <span class="draw-player-status">${statusIcon}</span>
              <span class="draw-player-score">${scoresLocal.get(p.peerId) ?? 0}</span>
            </li>
          `
        })
        .join('')
    }

    function updateSidebar() {
      if (sidebarEl) sidebarEl.innerHTML = renderSidebarHtml()
    }

    function buildShell({ role, wordDisplay }) {
      clearInterval(tickHandle)
      window.removeEventListener('pointerup', onPointerUp)
      strokeHistory = []
      likedThisTurn = false
      foundPeerIdsLocal = new Set()

      const headerText =
        role === 'drawer'
          ? `Tu dessines : ${escapeHtml(wordDisplay)}`
          : role === 'found'
            ? 'Bravo, tu as trouvé le mot !'
            : `Devine le mot (${wordDisplay})`

      ctx.root.innerHTML = `
        <main class="screen draw-screen">
          <p class="muted draw-round-label">Manche ${turnRound + 1} / ${effectiveTurns}</p>
          <div class="draw-layout">
            <aside class="draw-sidebar">
              <ul id="draw-sidebar-list" class="draw-sidebar-list">${renderSidebarHtml()}</ul>
            </aside>
            <div class="draw-main">
              <div class="draw-header">
                <h1 id="draw-heading">${headerText}</h1>
                <span id="draw-timer" class="timer-pill muted"></span>
              </div>
              ${
                role === 'drawer'
                  ? `<div class="draw-tools">
                      ${COLORS.map((c, idx) => `<button type="button" class="color-swatch${idx === 0 ? ' active' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}
                      <button type="button" id="eraser-btn" class="color-swatch eraser">🧽</button>
                      <button type="button" id="undo-btn" class="btn-secondary">↩️ Annuler</button>
                    </div>`
                  : ''
              }
              <canvas id="draw-canvas" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
              <ul id="draw-chat" class="draw-chat"></ul>
              ${role === 'guesser' ? '<form id="draw-guess-form"><input id="draw-guess-input" type="text" placeholder="Ta réponse..." maxlength="40" autocomplete="off" /><button type="submit">➤</button></form>' : ''}
            </div>
          </div>
        </main>
      `

      canvasEl = ctx.root.querySelector('#draw-canvas')
      canvasCtx = canvasEl.getContext('2d')
      chatListEl = ctx.root.querySelector('#draw-chat')
      timerEl = ctx.root.querySelector('#draw-timer')
      sidebarEl = ctx.root.querySelector('#draw-sidebar-list')

      if (role === 'drawer') {
        canvasEl.addEventListener('pointerdown', onPointerDown)
        canvasEl.addEventListener('pointermove', onPointerMove)
        window.addEventListener('pointerup', onPointerUp)
        ctx.root.querySelectorAll('.color-swatch[data-color]').forEach((btn) => {
          btn.addEventListener('click', () => {
            currentColor = btn.dataset.color
            isEraser = false
            ctx.root.querySelectorAll('.color-swatch').forEach((b) => b.classList.toggle('active', b === btn))
          })
        })
        ctx.root.querySelector('#eraser-btn').addEventListener('click', (e) => {
          isEraser = true
          ctx.root.querySelectorAll('.color-swatch').forEach((b) => b.classList.toggle('active', b === e.currentTarget))
        })
        ctx.root.querySelector('#undo-btn').addEventListener('click', onUndo)
      }

      if (role === 'guesser') {
        const form = ctx.root.querySelector('#draw-guess-form')
        inputEl = ctx.root.querySelector('#draw-guess-input')
        form.addEventListener('submit', (e) => {
          e.preventDefault()
          const text = inputEl.value.trim()
          if (!text) return
          submitGuess(text)
          inputEl.value = ''
        })
      }

      updateTimer()
      tickHandle = setInterval(updateTimer, 500)
    }

    function renderChoosing(options) {
      clearInterval(tickHandle)
      ctx.root.innerHTML = `
        <main class="screen">
          <p class="muted draw-round-label">Manche ${turnRound + 1} / ${effectiveTurns}</p>
          <h1>Choisis un mot à dessiner 🎨</h1>
          <div class="timer-bar"><div class="timer-bar-fill" id="choose-timer-fill"></div></div>
          <div class="vote-grid word-pick-grid">
            ${options.map((w) => `<button type="button" class="vote-card word-pick" data-word="${escapeHtml(w)}"><h2>${escapeHtml(w)}</h2></button>`).join('')}
          </div>
        </main>
      `
      ctx.root.querySelectorAll('.word-pick').forEach((btn) => {
        btn.addEventListener('click', () => {
          ctx.root.querySelectorAll('.word-pick').forEach((b) => (b.disabled = true))
          btn.classList.add('selected')
          if (ctx.isHost) {
            startTurn(turnRound, btn.dataset.word)
          } else {
            sendWordPick({ round: turnRound, word: btn.dataset.word })
          }
        })
      })
      startChooseTicking(ctx.root.querySelector('#choose-timer-fill'), Date.now() + CHOOSE_DURATION_MS)
    }

    function renderWaitingChoice(drawerNickname) {
      clearInterval(tickHandle)
      ctx.root.innerHTML = `
        <main class="screen">
          <p class="muted draw-round-label">Manche ${turnRound + 1} / ${effectiveTurns}</p>
          <h1>🎨 ${escapeHtml(drawerNickname)} choisit un mot…</h1>
          <div class="timer-bar"><div class="timer-bar-fill" id="choose-timer-fill"></div></div>
        </main>
      `
      startChooseTicking(ctx.root.querySelector('#choose-timer-fill'), Date.now() + CHOOSE_DURATION_MS)
    }

    function startChooseTicking(fill, deadlineAt) {
      clearInterval(tickHandle)
      if (!fill) return
      const total = CHOOSE_DURATION_MS
      const tick = () => {
        const remaining = Math.max(0, deadlineAt - Date.now())
        fill.style.width = `${Math.max(0, Math.min(100, (remaining / total) * 100))}%`
        if (remaining <= 0) clearInterval(tickHandle)
      }
      tick()
      tickHandle = setInterval(tick, 100)
    }

    function enterTurnLocally(data) {
      turnRound = data.round
      currentDrawerId = data.drawerId
      deadline = data.deadline
      foundOrder = []
      myRole = data.drawerId === ctx.selfId ? 'drawer' : 'guesser'
      const wordDisplay = myRole === 'drawer' ? data.word : data.hint
      buildShell({ role: myRole, wordDisplay })
    }

    function enterRevealLocally(data) {
      clearInterval(tickHandle)
      window.removeEventListener('pointerup', onPointerUp)
      const sorted = [...data.scores].sort((a, b) => b.points - a.points)
      const bestHtml = data.bestDrawing
        ? `<p class="muted">🏅 Dessin le plus apprécié : "${escapeHtml(data.bestDrawing.word)}" par ${escapeHtml(data.bestDrawing.nickname)} (${data.bestDrawing.likes} 👍)</p>`
        : ''
      ctx.root.innerHTML = `
        <main class="screen">
          <h1>Le mot était : ${escapeHtml(data.word)}</h1>
          ${myRole !== 'drawer' && data.drawerId !== ctx.selfId ? `<button type="button" id="like-btn" class="btn-secondary" ${likedThisTurn ? 'disabled' : ''}>👍 J'aime ce dessin</button>` : ''}
          <ol class="leaderboard">
            ${sorted.map((s) => `<li>${escapeHtml(nicknameOf(s.peerId))} <span class="points">${s.points} pts</span></li>`).join('')}
          </ol>
          ${bestHtml}
        </main>
      `
      ctx.root.querySelector('#like-btn')?.addEventListener('click', (e) => {
        if (likedThisTurn) return
        likedThisTurn = true
        e.target.disabled = true
        if (ctx.isHost) {
          if (bestDrawing) bestDrawing.likes += 1
        } else {
          sendLike({ round: turnRound })
        }
      })
    }

    function submitGuess(text) {
      if (ctx.isHost) {
        handleGuess(ctx.selfId, text)
      } else {
        sendGuess({ round: turnRound, text }, hostPeerId())
      }
    }

    function onGuessRelayed(peerId, text, close) {
      appendChatLine(`${close ? '🔥 ' : ''}${nicknameOf(peerId)} : ${text}`, close ? 'close-line' : '')
    }

    function onCorrectMarked(peerId) {
      appendChatLine(`${nicknameOf(peerId)} a trouvé le mot !`, 'found-line')
      foundPeerIdsLocal.add(peerId)
      updateSidebar()
      if (peerId === ctx.selfId && myRole === 'guesser') {
        myRole = 'found'
        playDing()
        if (inputEl) {
          inputEl.disabled = true
          inputEl.placeholder = 'Tu as trouvé !'
        }
      }
    }

    function handleGuess(peerId, text) {
      if (turnRound === -1 || peerId === currentDrawerId || foundOrder.includes(peerId)) return

      if (normalizeGuess(text) === normalizeGuess(currentWord)) {
        foundOrder.push(peerId)
        const points = GUESS_POINTS[foundOrder.length - 1] ?? GUESS_POINTS_FALLBACK
        scores.set(peerId, (scores.get(peerId) ?? 0) + points)
        sendCorrect({ round: turnRound, peerId })
        onCorrectMarked(peerId)

        const guesserIds = ctx.getPlayers().map((p) => p.peerId).filter((id) => id !== currentDrawerId)
        if (foundOrder.length >= guesserIds.length) {
          clearTimeout(timeoutHandle)
          endTurn(turnRound)
        }
      } else {
        const dist = levenshtein(normalizeGuess(text), normalizeGuess(currentWord))
        const close = dist > 0 && dist <= CLOSE_GUESS_DISTANCE
        sendGuess({ round: turnRound, peerId, text, close })
        onGuessRelayed(peerId, text, close)
      }
    }

    function startChoosing(i) {
      const drawerId = turnOrder[i % turnOrder.length]
      // Retire définitivement les mots proposés de la pool (choisis ou non) pour
      // qu'aucun mot ne soit jamais reproposé dans la même partie de dessin.
      const options = wordPool.splice(0, Math.min(3, wordPool.length))
      currentDrawerId = drawerId
      turnRound = i
      wordChosenForRound = -1

      if (drawerId === ctx.selfId) {
        renderChoosing(options)
      } else {
        sendTurn({ round: i, phase: 'choosing', drawerId, options, effectiveTurns }, drawerId)
        const others = ctx.getPlayers().map((p) => p.peerId).filter((id) => id !== drawerId && id !== ctx.selfId)
        if (others.length) sendTurn({ round: i, phase: 'waiting', drawerId, drawerNickname: nicknameOf(drawerId), effectiveTurns }, others)
        renderWaitingChoice(nicknameOf(drawerId))
      }

      clearTimeout(choiceTimeoutHandle)
      choiceTimeoutHandle = setTimeout(() => {
        const fallback = options[Math.floor(Math.random() * options.length)]
        startTurn(i, fallback)
      }, CHOOSE_DURATION_MS)
    }

    function startTurn(i, word) {
      if (wordChosenForRound === i) return
      wordChosenForRound = i
      clearTimeout(choiceTimeoutHandle)
      const drawerId = turnOrder[i % turnOrder.length]
      const turnDuration = computeTurnDuration(word)
      const turnDeadline = Date.now() + turnDuration
      currentDrawerId = drawerId
      currentWord = word
      foundOrder = []
      revealedIndices = new Set()
      bestDrawing = { drawerId, nickname: nicknameOf(drawerId), word, likes: 0 }

      const hint = buildHint(word, revealedIndices)
      const others = ctx.getPlayers().map((p) => p.peerId).filter((id) => id !== drawerId)
      if (drawerId !== ctx.selfId) sendTurn({ round: i, phase: 'drawing', drawerId, word, hint, deadline: turnDeadline, effectiveTurns }, drawerId)
      if (others.length) sendTurn({ round: i, phase: 'drawing', drawerId, hint, deadline: turnDeadline, effectiveTurns }, others)

      enterTurnLocally({ round: i, drawerId, word, hint, deadline: turnDeadline })
      timeoutHandle = setTimeout(() => endTurn(i), turnDuration)

      clearInterval(hintHandle)
      hintHandle = setInterval(() => {
        const hidden = word.split('').map((_, idx) => idx).filter((idx) => word[idx] !== ' ' && !revealedIndices.has(idx))
        if (hidden.length <= 1) return
        revealedIndices.add(hidden[Math.floor(Math.random() * hidden.length)])
        const newHint = buildHint(word, revealedIndices)
        sendHint({ round: i, hint: newHint })
        if (drawerId !== ctx.selfId) applyHint(i, newHint)
      }, HINT_INTERVAL_MS)
    }

    function applyHint(round, hint) {
      if (round !== turnRound || myRole === 'drawer') return
      const heading = ctx.root.querySelector('#draw-heading')
      if (heading) heading.textContent = `Devine le mot (${hint})`
    }

    function endTurn(i) {
      clearTimeout(timeoutHandle)
      clearInterval(hintHandle)
      if (foundOrder.length > 0) {
        scores.set(currentDrawerId, (scores.get(currentDrawerId) ?? 0) + foundOrder.length)
      }
      const scoreList = [...scores.entries()].map(([peerId, points]) => ({ peerId, points }))
      scoresLocal = new Map(scoreList.map((s) => [s.peerId, s.points]))
      const payload = { round: i, word: currentWord, drawerId: currentDrawerId, scores: scoreList, bestDrawing }
      // Capture du canvas de l'hôte (miroir fidèle du dessin, qu'il soit lui-même le dessinateur
      // ou juste un spectateur qui a reçu tous les traits) pour le récap de fin de soirée.
      ctx.onRoundRecap?.({
        type: 'draw',
        prompt: currentWord,
        answer: currentWord,
        imageUrl: canvasEl?.toDataURL('image/jpeg', 0.6),
        drawerNickname: nicknameOf(currentDrawerId),
        strokes: strokeHistory,
      })
      sendEnd(payload)
      enterRevealLocally(payload)
      timeoutHandle = setTimeout(() => advanceTurn(i + 1), REVEAL_DURATION_MS)
    }

    function advanceTurn(i) {
      if (i >= effectiveTurns) {
        const rankings = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([peerId]) => peerId)
        ctx.onGameEnd(rankings)
        return
      }
      startChoosing(i)
    }

    receiveTurn((data) => {
      if (ctx.isHost) return
      if (data.effectiveTurns) effectiveTurns = data.effectiveTurns
      if (data.phase === 'choosing') {
        turnRound = data.round
        currentDrawerId = data.drawerId
        renderChoosing(data.options)
      } else if (data.phase === 'waiting') {
        turnRound = data.round
        currentDrawerId = data.drawerId
        renderWaitingChoice(data.drawerNickname)
      } else if (data.phase === 'drawing') {
        enterTurnLocally({ round: data.round, drawerId: data.drawerId, word: data.word, hint: data.hint, deadline: data.deadline })
      }
    })

    receiveWordPick((data, peerId) => {
      if (!ctx.isHost || peerId !== currentDrawerId || data.round !== turnRound) return
      startTurn(data.round, data.word)
    })

    receiveHint((data) => {
      if (ctx.isHost) return
      applyHint(data.round, data.hint)
    })

    receiveStroke((data) => {
      if (myRole === 'drawer') return
      recordSegment(data.x0, data.y0, data.x1, data.y1, data.color ?? '#2B2250', data.newStroke)
    })

    receiveUndo(() => {
      if (myRole === 'drawer') return
      strokeHistory.pop()
      redrawAll()
    })

    receiveGuess((data, peerId) => {
      if (ctx.isHost) {
        handleGuess(peerId, data.text)
      } else {
        onGuessRelayed(data.peerId, data.text, data.close)
      }
    })

    receiveCorrect((data) => {
      if (ctx.isHost) return
      onCorrectMarked(data.peerId)
    })

    receiveEnd((data) => {
      if (ctx.isHost) return
      scoresLocal = new Map(data.scores.map((s) => [s.peerId, s.points]))
      enterRevealLocally(data)
    })

    receiveLike((data, peerId) => {
      if (!ctx.isHost || data.round !== turnRound || !bestDrawing) return
      bestDrawing.likes += 1
      void peerId
    })

    if (ctx.isHost) {
      turnOrder = ctx.getPlayers().map((p) => p.peerId)
      scores = new Map(turnOrder.map((id) => [id, 0]))
      ctx.root.innerHTML = '<main class="screen"><h1>Chargement des mots…</h1></main>'
      fetchWords(Math.max(ctx.turnsPerGame * 3, 6), new Set(ctx.getUsedKeys?.() ?? []), ctx.customContent ?? [])
        .then((words) => {
          wordPool = words
          ctx.markUsedKeys?.(words)
          // La pool peut être plus petite que prévu (peu de contenu frais dispo) :
          // on ajuste discrètement le nombre de tours plutôt que de planter en cours de partie.
          effectiveTurns = Math.max(1, Math.min(ctx.turnsPerGame, Math.floor(wordPool.length / 3)))
          startChoosing(0)
        })
        .catch(() => {
          ctx.onGameCancel('fetch-failed')
        })
    } else {
      ctx.root.innerHTML = '<main class="screen"><h1>En attente du premier tour…</h1></main>'
    }

    return {
      destroy() {
        clearTimeout(timeoutHandle)
        clearTimeout(choiceTimeoutHandle)
        clearInterval(tickHandle)
        clearInterval(hintHandle)
        window.removeEventListener('pointerup', onPointerUp)
        receiveTurn(() => {})
        receiveStroke(() => {})
        receiveGuess(() => {})
        receiveCorrect(() => {})
        receiveEnd(() => {})
        receiveUndo(() => {})
        receiveHint(() => {})
        receiveWordPick(() => {})
        receiveLike(() => {})
      },
    }
  },
}
