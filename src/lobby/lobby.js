import { createRoom, joinRoom, onPlayersChange } from '../network/room.js'
import { escapeHtml } from '../util/html.js'
import { AVATAR_EMOJIS, AVATAR_COLORS, DEFAULT_AVATAR, avatarHtmlOf } from '../util/avatar.js'
import { latencyClass } from '../util/latency.js'
import { initParty, startParty, resetParty, DEFAULT_ROUNDS_COUNT, DEFAULT_TURNS_PER_GAME } from '../party/party.js'
import { initChat, destroyChat } from '../party/chat.js'
import { isMuted, setMuted } from '../util/sound.js'
import { getHistory } from '../util/history.js'
import { renderQrCode } from '../util/qr.js'
import { checkWebhookHealth } from '../network/content.js'

const NICKNAME_KEY = 'romet:nickname'
const AVATAR_EMOJI_KEY = 'romet:avatar-emoji'
const AVATAR_COLOR_KEY = 'romet:avatar-color'
const THEME_KEY = 'romet:theme'
const SESSION_KEY = 'romet:session'

const CODE_LENGTH = 5
const MIN_PLAYERS_TO_START = 2
const ROUNDS_MIN = 1
const ROUNDS_MAX = 12
const TURNS_MIN = 1
const TURNS_MAX = 20

applyStoredTheme()

export function initLobby(root) {
  let currentRoom = null
  let unsubscribe = null
  let hostPartyConfig = null

  let selectedEmoji = localStorage.getItem(AVATAR_EMOJI_KEY) ?? DEFAULT_AVATAR.emoji
  let selectedColor = localStorage.getItem(AVATAR_COLOR_KEY) ?? DEFAULT_AVATAR.color

  const params = new URLSearchParams(location.search)
  const prefillCode = (params.get('room') ?? '').toUpperCase()

  boot()

  async function boot() {
    root.innerHTML = '<main class="screen"><h1>Chargement… 🕹️</h1></main>'
    const healthy = await checkWebhookHealth()
    if (!healthy) {
      renderMaintenance()
      return
    }

    const session = readSession()
    if (session) {
      resumeSession(session)
    } else {
      renderHome(prefillCode)
    }
  }

  function renderMaintenance() {
    root.innerHTML = `
      <main class="screen">
        <div class="brand">
          <span class="brand-emoji">🛠️</span>
          <h1>Site en maintenance</h1>
          <p class="muted">On ne peut pas joindre le serveur de jeu pour le moment. Réessaie dans quelques minutes !</p>
        </div>
        <button id="retry-btn">Réessayer</button>
      </main>
    `
    root.querySelector('#retry-btn').addEventListener('click', boot)
  }

  window.addEventListener('online', () => {
    if (currentRoom) attemptReconnect()
  })

  function currentAvatar() {
    return { emoji: selectedEmoji, color: selectedColor }
  }

  function resumeSession(sess) {
    root.innerHTML = '<main class="screen"><h1>Reconnexion… 🔄</h1></main>'
    selectedEmoji = sess.avatar?.emoji ?? selectedEmoji
    selectedColor = sess.avatar?.color ?? selectedColor
    try {
      currentRoom = joinRoom(sess.roomCode, sess.nickname, currentAvatar())
      enterLobby()
    } catch {
      clearSession()
      renderHome()
    }
  }

  function attemptReconnect() {
    const sess = readSession()
    if (!sess) return
    if (unsubscribe) unsubscribe()
    resetParty()
    destroyChat()
    if (currentRoom) {
      try {
        currentRoom.leave()
      } catch {
        // déjà déconnecté
      }
    }
    resumeSession(sess)
  }

  function renderHome(prefillCode = '') {
    const history = getHistory()

    root.innerHTML = `
      <main class="screen">
        <div class="brand">
          <div class="brand-toolbar">
            <button type="button" id="theme-toggle" class="icon-btn" aria-label="Changer de thème">${currentThemeIcon()}</button>
            <button type="button" id="mute-toggle" class="icon-btn" aria-label="Couper le son">${isMuted() ? '🔇' : '🔊'}</button>
          </div>
          <span class="brand-emoji">🕹️</span>
          <h1>Romet Le Jeu</h1>
          <p class="muted">Crée une salle, partage le code, et lancez la soirée !</p>
        </div>

        <label class="field">
          Ton pseudo
          <input id="nickname" type="text" maxlength="20" placeholder="Ton pseudo" value="${escapeHtml(localStorage.getItem(NICKNAME_KEY) ?? '')}" />
        </label>

        <div class="field">
          <span>Ton avatar</span>
          <div class="avatar-picker">
            <div class="emoji-grid" id="emoji-grid">
              ${AVATAR_EMOJIS.map((e) => `<button type="button" class="emoji-opt${e === selectedEmoji ? ' selected' : ''}" data-emoji="${e}" aria-label="Avatar ${e}" aria-pressed="${e === selectedEmoji}">${e}</button>`).join('')}
            </div>
            <div class="color-grid" id="color-grid">
              ${AVATAR_COLORS.map((c) => `<button type="button" class="color-opt${c === selectedColor ? ' selected' : ''}" data-color="${c}" style="background:${c}" aria-label="Couleur ${c}" aria-pressed="${c === selectedColor}"></button>`).join('')}
            </div>
          </div>
        </div>

        <section class="card card-accent-b">
          <h2>🔑 Rejoindre une partie</h2>
          <label class="field">
            Code de la partie
            <input id="code" type="text" maxlength="${CODE_LENGTH}" placeholder="ABCDE" value="${escapeHtml(prefillCode)}" />
          </label>
          <button id="join-btn" class="btn-secondary">Rejoindre</button>
        </section>

        <button type="button" id="show-create-btn">✨ Créer une partie</button>

        <section class="card card-accent-a" id="create-card" hidden>
          <h2>✨ Créer une partie</h2>
          <label class="field">
            Nombre de mini-jeux
            <input id="rounds-count" type="number" min="${ROUNDS_MIN}" max="${ROUNDS_MAX}" value="${DEFAULT_ROUNDS_COUNT}" />
          </label>
          <label class="field">
            Tours par jeu
            <input id="turns-per-game" type="number" min="${TURNS_MIN}" max="${TURNS_MAX}" value="${DEFAULT_TURNS_PER_GAME}" />
          </label>
          <label class="field">
            Temps par question (quiz / devine l'image)
            <input id="question-duration" type="number" min="5" max="30" placeholder="Par défaut" />
          </label>
          <label class="field">
            Difficulté du quiz
            <select id="difficulty">
              <option value="random">Aléatoire</option>
              <option value="easy">Facile</option>
              <option value="medium">Moyen</option>
              <option value="hard">Difficile</option>
            </select>
          </label>
          <label class="field">
            Catégorie "Devine l'image"
            <select id="category">
              <option value="all">Toutes</option>
              <option value="Film">Films</option>
              <option value="Série">Séries</option>
              <option value="Jeux">Jeux vidéo</option>
            </select>
          </label>
          <label class="field checkbox-field">
            <input type="checkbox" id="elimination-mode" />
            💀 Mode élimination (quiz)
          </label>
          <button id="create-btn">Créer une partie</button>
        </section>

        <p id="error" class="error" hidden></p>

        ${
          history.length
            ? `<details class="card">
                <summary>📜 Historique des soirées (${history.length})</summary>
                <ol class="leaderboard">
                  ${history
                    .map((h) => {
                      const date = new Date(h.date).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
                      const winner = h.standings?.[0]
                      return `<li>${date} — 🏆 ${winner ? escapeHtml(winner.nickname) : '???'} <span class="points">${winner?.points ?? 0} pts</span></li>`
                    })
                    .join('')}
                </ol>
              </details>`
            : ''
        }
      </main>
    `

    const nicknameInput = root.querySelector('#nickname')
    const codeInput = root.querySelector('#code')
    const errorEl = root.querySelector('#error')
    const roundsInput = root.querySelector('#rounds-count')
    const turnsInput = root.querySelector('#turns-per-game')
    const questionDurationInput = root.querySelector('#question-duration')
    const difficultyInput = root.querySelector('#difficulty')
    const categoryInput = root.querySelector('#category')
    const eliminationInput = root.querySelector('#elimination-mode')

    root.querySelector('#theme-toggle').addEventListener('click', () => {
      toggleTheme()
      root.querySelector('#theme-toggle').textContent = currentThemeIcon()
    })

    root.querySelector('#mute-toggle').addEventListener('click', (e) => {
      setMuted(!isMuted())
      e.currentTarget.textContent = isMuted() ? '🔇' : '🔊'
    })

    root.querySelectorAll('.emoji-opt').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedEmoji = btn.dataset.emoji
        localStorage.setItem(AVATAR_EMOJI_KEY, selectedEmoji)
        root.querySelectorAll('.emoji-opt').forEach((b) => {
          b.classList.toggle('selected', b === btn)
          b.setAttribute('aria-pressed', String(b === btn))
        })
      })
    })

    root.querySelectorAll('.color-opt').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedColor = btn.dataset.color
        localStorage.setItem(AVATAR_COLOR_KEY, selectedColor)
        root.querySelectorAll('.color-opt').forEach((b) => {
          b.classList.toggle('selected', b === btn)
          b.setAttribute('aria-pressed', String(b === btn))
        })
      })
    })

    codeInput.addEventListener('input', () => {
      codeInput.value = codeInput.value.toUpperCase()
    })

    root.querySelector('#show-create-btn').addEventListener('click', (e) => {
      root.querySelector('#create-card').hidden = false
      e.currentTarget.hidden = true
    })

    const readNickname = () => {
      const value = nicknameInput.value.trim()
      if (!value) {
        showError('Choisis un pseudo avant de continuer.')
        return null
      }
      localStorage.setItem(NICKNAME_KEY, value)
      return value
    }

    const showError = (msg) => {
      errorEl.textContent = msg
      errorEl.hidden = false
    }

    root.querySelector('#create-btn').addEventListener('click', () => {
      const nickname = readNickname()
      if (!nickname) return
      const durationSeconds = parseInt(questionDurationInput.value)
      hostPartyConfig = {
        roundsCount: clamp(parseInt(roundsInput.value) || DEFAULT_ROUNDS_COUNT, ROUNDS_MIN, ROUNDS_MAX),
        turnsPerGame: clamp(parseInt(turnsInput.value) || DEFAULT_TURNS_PER_GAME, TURNS_MIN, TURNS_MAX),
        questionDuration: durationSeconds ? clamp(durationSeconds, 5, 30) * 1000 : undefined,
        difficulty: difficultyInput.value,
        category: categoryInput.value,
        eliminationMode: eliminationInput.checked,
      }
      currentRoom = createRoom(nickname, currentAvatar())
      enterLobby()
    })

    root.querySelector('#join-btn').addEventListener('click', () => {
      const nickname = readNickname()
      if (!nickname) return
      const code = codeInput.value.trim().toUpperCase()
      if (code.length !== CODE_LENGTH) {
        showError(`Le code doit faire ${CODE_LENGTH} caractères.`)
        return
      }
      currentRoom = joinRoom(code, nickname, currentAvatar())
      enterLobby()
    })

    if (prefillCode) {
      codeInput.focus()
    } else {
      nicknameInput.focus()
    }
  }

  function enterLobby() {
    saveSession({ roomCode: currentRoom.code, nickname: localStorage.getItem(NICKNAME_KEY), avatar: currentAvatar() })

    const url = new URL(location.href)
    url.searchParams.set('room', currentRoom.code)
    window.history.replaceState(null, '', url)

    root.innerHTML = `
      <main class="screen">
        <h1>Salle d'attente 🎈</h1>
        <div class="room-code">
          <span class="room-code-label">Code de la partie</span>
          <span class="room-code-value">${escapeHtml(currentRoom.code)}</span>
          <canvas id="room-qr"></canvas>
          <button id="copy-btn">🔗 Copier le lien d'invitation</button>
        </div>
        <ul id="players" class="players"></ul>
        ${currentRoom.isHost ? '<button id="start-btn" disabled>🚀 Lancer la soirée</button>' : '<p class="muted">En attente que l\'hôte lance la soirée…</p>'}
        <button id="leave-btn" class="leave">Quitter</button>
      </main>
    `

    const qrCanvas = root.querySelector('#room-qr')
    renderQrCode(qrCanvas, url.toString()).catch(() => {
      qrCanvas.remove()
    })

    root.querySelector('#copy-btn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url.toString())
      } catch {
        // API presse-papiers indisponible, on ignore silencieusement
      }
    })

    root.querySelector('#leave-btn').addEventListener('click', leaveLobby)

    if (currentRoom.isHost) {
      root.querySelector('#start-btn').addEventListener('click', () => startParty(hostPartyConfig))
    }

    initParty(root, currentRoom.isHost)
    initChat()
    unsubscribe = onPlayersChange(renderPlayers)
  }

  function renderPlayers(players) {
    const list = root.querySelector('#players')
    if (!list) return
    list.innerHTML = players
      .map((p) => {
        const { emoji, color } = avatarHtmlOf(p.avatar)
        return `
          <li>
            <span class="avatar" style="background:${color}">${emoji}</span>
            ${escapeHtml(p.nickname)}
            <span class="latency-dot ${latencyClass(p.latency)}" title="latence"></span>
            ${p.isHost ? ' <span class="badge">hôte</span>' : ''}
          </li>
        `
      })
      .join('')

    const startBtn = root.querySelector('#start-btn')
    if (startBtn) startBtn.disabled = players.length < MIN_PLAYERS_TO_START
  }

  function leaveLobby() {
    if (unsubscribe) unsubscribe()
    unsubscribe = null
    resetParty()
    destroyChat()
    if (currentRoom) currentRoom.leave()
    currentRoom = null
    clearSession()

    const url = new URL(location.href)
    url.searchParams.delete('room')
    window.history.replaceState(null, '', url)

    renderHome()
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

// --- Thème ---

function applyStoredTheme() {
  const theme = localStorage.getItem(THEME_KEY)
  if (theme) document.documentElement.dataset.theme = theme
}

function currentThemeIcon() {
  // Sombre est le thème par défaut (aucun attribut posé) ; "light" est l'exception explicite.
  return document.documentElement.dataset.theme === 'light' ? '🌙' : '☀️'
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
  document.documentElement.dataset.theme = next
  localStorage.setItem(THEME_KEY, next)
}

// --- Session (reprise après refresh / reconnexion réseau) ---

function readSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveSession(session) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {
    // sessionStorage indisponible — pas grave, juste pas de reprise auto
  }
}

function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY)
  } catch {
    // rien à faire
  }
}
