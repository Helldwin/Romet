import { createRoom, joinRoom, onPlayersChange, isDemoRoomCode, createDemoRoom, DEMO_ROOM_CODE } from '../network/room.js'
import { escapeHtml } from '../util/html.js'
import { AVATAR_EMOJIS, AVATAR_COLORS, DEFAULT_AVATAR, avatarHtmlOf } from '../util/avatar.js'
import { latencyClass } from '../util/latency.js'
import { initParty, startParty, resetParty, DEFAULT_ROUNDS_COUNT, DEFAULT_TURNS_PER_GAME } from '../party/party.js'
import { initChat, destroyChat } from '../party/chat.js'
import { isMuted, setMuted, SOUND_THEMES } from '../util/sound.js'
import { getHistory } from '../util/history.js'
import { renderQrCode } from '../util/qr.js'
import { checkWebhookHealth, setDemoMode } from '../network/content.js'
import { GAMES } from '../games/index.js'
import { parseCustomQuiz, parseCustomDraw, parseCustomGuess } from '../util/customContent.js'
import { listTournamentNames, tournamentStandings, tournamentEloStandings } from '../util/tournament.js'
import { computeProfileStats, computeAchievements } from '../util/profile.js'

const TEAM_DEFS = [
  { id: 'red', name: 'Équipe Rouge', color: '#FB7185' },
  { id: 'blue', name: 'Équipe Bleue', color: '#4DABF7' },
]

const NICKNAME_KEY = 'romet:nickname'
const AVATAR_EMOJI_KEY = 'romet:avatar-emoji'
const AVATAR_COLOR_KEY = 'romet:avatar-color'
const THEME_KEY = 'romet:theme'
const SESSION_KEY = 'romet:session'
const STREAMER_KEY = 'romet:streamer-mode'

const CODE_LENGTH = 5
const MIN_PLAYERS_TO_START = 2
const ROUNDS_MIN = 1
const ROUNDS_MAX = 12
const TURNS_MIN = 1
const TURNS_MAX = 20

applyStoredTheme()
applyStoredStreamerMode()

function isStreamerMode() {
  return document.body.classList.contains('streamer-mode')
}

function setStreamerMode(value) {
  document.body.classList.toggle('streamer-mode', value)
  try {
    localStorage.setItem(STREAMER_KEY, value ? '1' : '')
  } catch {
    // stockage indisponible, tant pis — le réglage ne survivra pas au refresh
  }
}

function applyStoredStreamerMode() {
  try {
    if (localStorage.getItem(STREAMER_KEY)) document.body.classList.add('streamer-mode')
  } catch {
    // rien à faire
  }
}

export function initLobby(root) {
  let currentRoom = null
  let unsubscribe = null
  let hostPartyConfig = null
  let teamsEnabled = false
  let teamAssignments = new Map() // peerId -> 'red' | 'blue'

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
    } else if (prefillCode) {
      renderJoinOnly(prefillCode)
    } else {
      renderHome()
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
        <button type="button" id="demo-btn" class="btn-secondary">🎮 Essayer le mode démo</button>
      </main>
    `
    root.querySelector('#retry-btn').addEventListener('click', boot)
    root.querySelector('#demo-btn').addEventListener('click', () => enterDemoMode('Testeur'))
  }

  function enterDemoMode(nickname) {
    setDemoMode(true)
    currentRoom = createDemoRoom(nickname || 'Testeur', currentAvatar())
    enterLobby()
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

  function brandToolbarHtml() {
    return `
      <div class="brand-toolbar">
        <button type="button" id="theme-toggle" class="icon-btn" aria-label="Changer de thème">${currentThemeIcon()}</button>
        <button type="button" id="mute-toggle" class="icon-btn" aria-label="Couper le son">${isMuted() ? '🔇' : '🔊'}</button>
      </div>
    `
  }

  function wireBrandToolbar() {
    root.querySelector('#theme-toggle').addEventListener('click', () => {
      toggleTheme()
      root.querySelector('#theme-toggle').textContent = currentThemeIcon()
    })
    root.querySelector('#mute-toggle').addEventListener('click', (e) => {
      setMuted(!isMuted())
      e.currentTarget.textContent = isMuted() ? '🔇' : '🔊'
    })
  }

  function avatarPickerHtml() {
    return `
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
    `
  }

  function wireAvatarPicker() {
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
  }

  // Profil joueur persistant (#14) : pas de nouveau stockage — juste un résumé calculé à la
  // volée depuis l'historique des soirées déjà présent sur cet appareil, pour le pseudo
  // actuellement enregistré (avatar + pseudo sont déjà persistés via NICKNAME_KEY/AVATAR_*_KEY).
  function profileHtml() {
    const nickname = localStorage.getItem(NICKNAME_KEY)
    if (!nickname) return ''
    const stats = computeProfileStats(nickname)
    if (stats.soireesPlayed === 0) return ''
    const achievements = computeAchievements(nickname)
    return `
      <details class="card">
        <summary>🎖️ Mon profil — ${escapeHtml(nickname)}</summary>
        <p class="muted">${stats.soireesPlayed} soirée${stats.soireesPlayed > 1 ? 's' : ''} · ${stats.wins} victoire${stats.wins > 1 ? 's' : ''} · ${stats.podiums} podium${stats.podiums > 1 ? 's' : ''} · ${stats.avgPoints} pts en moyenne</p>
        ${
          achievements.length
            ? `<div class="achievement-list">${achievements.map((a) => `<span class="achievement-badge" title="${escapeHtml(a.label)}">${a.emoji} ${escapeHtml(a.label)}</span>`).join('')}</div>`
            : ''
        }
      </details>
    `
  }

  function tournamentsHtml() {
    const names = listTournamentNames()
    if (names.length === 0) return ''
    return `
      <details class="card">
        <summary>🏆 Tournois (${names.length})</summary>
        ${names
          .map((name) => {
            const standings = tournamentStandings(name)
            const eloStandings = tournamentEloStandings(name)
            return `
              <div class="tournament-block">
                <h3>${escapeHtml(name)}</h3>
                <ol class="leaderboard">
                  ${standings
                    .map((p) => `<li>${escapeHtml(p.nickname)} <span class="points">${p.points} pts</span> <span class="muted">(${p.soirees} soirée${p.soirees > 1 ? 's' : ''})</span></li>`)
                    .join('')}
                </ol>
                <details>
                  <summary class="hint-text">📈 Classement Élo</summary>
                  <ol class="leaderboard">
                    ${eloStandings.map((p) => `<li>${escapeHtml(p.nickname)} <span class="points">${p.elo}</span></li>`).join('')}
                  </ol>
                </details>
              </div>
            `
          })
          .join('')}
        <p class="muted hint-text">Suivi gardé sur cet écran uniquement (pas synchronisé entre appareils).</p>
      </details>
    `
  }

  // Page d'accueil par défaut : uniquement "Créer une partie" (= devenir l'écran de
  // présentation). Rejoindre une partie se fait uniquement via le QR code / lien affiché
  // une fois la partie créée (cf. renderJoinOnly), ou via le petit lien secondaire ici pour
  // qui a un code sans avoir scanné.
  function renderHome() {
    const history = getHistory()

    root.innerHTML = `
      <main class="screen">
        <div class="brand">
          ${brandToolbarHtml()}
          <span class="brand-emoji">🕹️</span>
          <h1>Romet Le Jeu</h1>
          <p class="muted">Crée la partie sur cet écran (TV, ordi...) — chacun rejoint ensuite depuis son téléphone en scannant le QR code.</p>
        </div>

        <section class="card card-accent-a" id="create-card">
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
              <option value="Serie">Séries</option>
              <option value="Jeu">Jeux vidéo</option>
            </select>
          </label>
          <label class="field checkbox-field">
            <input type="checkbox" id="elimination-mode" />
            💀 Mode élimination (quiz)
          </label>

          <label class="field">
            Enchaînement des jeux
            <select id="playlist-mode">
              <option value="vote">Vote façon Mario Kart</option>
              <option value="manual">Playlist manuelle</option>
            </select>
          </label>
          <div class="field" id="playlist-builder" hidden>
            <span>Ajoute les jeux dans l'ordre voulu (clic pour ajouter)</span>
            <div class="pill-picker" id="playlist-picker">
              ${GAMES.map((g) => `<button type="button" class="pill-btn" data-game="${g.id}">${g.icon} ${escapeHtml(g.title)}</button>`).join('')}
            </div>
            <ol class="playlist-order" id="playlist-order"></ol>
          </div>

          <label class="field">
            Condition de victoire
            <select id="win-condition">
              <option value="rounds">Nombre de manches</option>
              <option value="score">Score cible</option>
              <option value="elimination">Élimination progressive</option>
            </select>
          </label>
          <label class="field" id="score-target-field" hidden>
            Score cible à atteindre
            <input id="score-target" type="number" min="10" max="500" value="50" />
          </label>

          <details class="field custom-content-details">
            <summary>➕ Contenu perso (optionnel)</summary>
            <label class="field">
              Questions de quiz <span class="hint-text">une par ligne : Question | ChoixA;ChoixB;ChoixC | BonneRéponse</span>
              <textarea id="custom-quiz" rows="2" placeholder="Quelle est la couleur du cheval blanc d'Henri IV ? | Blanc;Noir;Marron | Blanc"></textarea>
            </label>
            <label class="field">
              Mots à dessiner <span class="hint-text">un par ligne</span>
              <textarea id="custom-draw" rows="2" placeholder="pizza"></textarea>
            </label>
            <label class="field">
              Images à deviner <span class="hint-text">une par ligne : Titre | URL image | Catégorie | Genre</span>
              <textarea id="custom-guess" rows="2" placeholder="Mon jeu préféré | https://... | Jeu | Action"></textarea>
            </label>
          </details>

          <label class="field">
            🏆 Nom du tournoi <span class="hint-text">optionnel — les scores finaux s'additionnent d'une soirée à l'autre sur cet écran (par pseudo)</span>
            <input id="tournament-name" type="text" maxlength="40" placeholder="Ex : Soirées du samedi" />
          </label>

          <label class="field">
            🎵 Thème sonore
            <select id="sound-theme">
              ${Object.entries(SOUND_THEMES).map(([id, t]) => `<option value="${id}">${escapeHtml(t.label)}</option>`).join('')}
            </select>
          </label>
          <label class="field">
            ⚖️ Handicap <span class="hint-text">un petit bonus de points pour le dernier de chaque manche, pour resserrer les écarts</span>
            <select id="handicap">
              <option value="none">Aucun</option>
              <option value="light">Léger (+2 pts)</option>
              <option value="strong">Fort (+5 pts)</option>
            </select>
          </label>
          <label class="field">
            🎬 Titre de la soirée <span class="hint-text">optionnel — affiché en générique avant le lancement</span>
            <input id="party-title" type="text" maxlength="40" placeholder="Ex : Soirée Jeux #12" />
          </label>

          <button id="create-btn">📺 Créer la partie</button>
        </section>

        <button type="button" id="show-join-btn" class="btn-secondary">🔑 J'ai déjà un code</button>
        <section class="card card-accent-b" id="join-card" hidden>
          <h2>🔑 Rejoindre une partie</h2>
          <label class="field">
            Ton pseudo
            <input id="nickname" type="text" maxlength="20" placeholder="Ton pseudo" value="${escapeHtml(localStorage.getItem(NICKNAME_KEY) ?? '')}" />
          </label>
          ${avatarPickerHtml()}
          <label class="field">
            Code de la partie
            <input id="code" type="text" maxlength="${CODE_LENGTH}" placeholder="ABCDE" />
          </label>
          <button id="join-btn" class="btn-secondary">Rejoindre</button>
          <p class="muted hint-text">Pour tester le site sans ami sous la main, entre le code <strong>${DEMO_ROOM_CODE}</strong> (mode démo, données factices).</p>
        </section>

        ${profileHtml()}

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

        ${tournamentsHtml()}
      </main>
    `

    wireBrandToolbar()
    wireAvatarPicker()

    const errorEl = root.querySelector('#error')
    const showError = (msg) => {
      errorEl.textContent = msg
      errorEl.hidden = false
    }

    const roundsInput = root.querySelector('#rounds-count')
    const turnsInput = root.querySelector('#turns-per-game')
    const questionDurationInput = root.querySelector('#question-duration')
    const difficultyInput = root.querySelector('#difficulty')
    const categoryInput = root.querySelector('#category')
    const eliminationInput = root.querySelector('#elimination-mode')
    const playlistModeInput = root.querySelector('#playlist-mode')
    const playlistBuilder = root.querySelector('#playlist-builder')
    const playlistOrderEl = root.querySelector('#playlist-order')
    const winConditionInput = root.querySelector('#win-condition')
    const scoreTargetField = root.querySelector('#score-target-field')
    const scoreTargetInput = root.querySelector('#score-target')
    const customQuizInput = root.querySelector('#custom-quiz')
    const customDrawInput = root.querySelector('#custom-draw')
    const customGuessInput = root.querySelector('#custom-guess')

    let gameOrder = []

    function renderPlaylistOrder() {
      playlistOrderEl.innerHTML = gameOrder
        .map((id, i) => {
          const g = GAMES.find((game) => game.id === id)
          return `<li><button type="button" class="playlist-remove" data-idx="${i}">✕</button> ${i + 1}. ${g?.icon ?? '🎮'} ${escapeHtml(g?.title ?? id)}</li>`
        })
        .join('')
      playlistOrderEl.querySelectorAll('.playlist-remove').forEach((btn) => {
        btn.addEventListener('click', () => {
          gameOrder.splice(Number(btn.dataset.idx), 1)
          renderPlaylistOrder()
        })
      })
    }

    playlistModeInput.addEventListener('change', () => {
      playlistBuilder.hidden = playlistModeInput.value !== 'manual'
    })

    root.querySelectorAll('#playlist-picker .pill-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        gameOrder.push(btn.dataset.game)
        renderPlaylistOrder()
      })
    })

    winConditionInput.addEventListener('change', () => {
      scoreTargetField.hidden = winConditionInput.value !== 'score'
    })

    root.querySelector('#create-btn').addEventListener('click', () => {
      const durationSeconds = parseInt(questionDurationInput.value)
      hostPartyConfig = {
        roundsCount: clamp(parseInt(roundsInput.value) || DEFAULT_ROUNDS_COUNT, ROUNDS_MIN, ROUNDS_MAX),
        turnsPerGame: clamp(parseInt(turnsInput.value) || DEFAULT_TURNS_PER_GAME, TURNS_MIN, TURNS_MAX),
        questionDuration: durationSeconds ? clamp(durationSeconds, 5, 30) * 1000 : undefined,
        difficulty: difficultyInput.value,
        category: categoryInput.value,
        eliminationMode: eliminationInput.checked,
        playlistMode: playlistModeInput.value,
        gameOrder: [...gameOrder],
        winCondition: winConditionInput.value,
        scoreTarget: clamp(parseInt(scoreTargetInput.value) || 50, 10, 500),
        customContent: {
          quiz: parseCustomQuiz(customQuizInput.value),
          draw: parseCustomDraw(customDrawInput.value),
          guess: parseCustomGuess(customGuessInput.value),
        },
        tournamentName: root.querySelector('#tournament-name').value.trim(),
        soundTheme: root.querySelector('#sound-theme').value,
        handicap: root.querySelector('#handicap').value,
        partyTitle: root.querySelector('#party-title').value.trim(),
        // teams (id/name/color/peerIds) calculées juste avant le lancement dans onStart,
        // une fois qu'on connaît les joueurs réellement présents dans la salle d'attente.
      }
      currentRoom = createRoom(currentAvatar())
      enterLobby()
    })

    root.querySelector('#show-join-btn').addEventListener('click', (e) => {
      root.querySelector('#join-card').hidden = false
      e.currentTarget.hidden = true
      root.querySelector('#nickname').focus()
    })

    const nicknameInput = root.querySelector('#nickname')
    const codeInput = root.querySelector('#code')
    codeInput.addEventListener('input', () => {
      codeInput.value = codeInput.value.toUpperCase()
    })

    root.querySelector('#join-btn').addEventListener('click', () => {
      const nickname = nicknameInput.value.trim()
      if (!nickname) {
        showError('Choisis un pseudo avant de continuer.')
        return
      }
      localStorage.setItem(NICKNAME_KEY, nickname)
      const code = codeInput.value.trim().toUpperCase()
      if (isDemoRoomCode(code)) {
        enterDemoMode(nickname)
        return
      }
      if (code.length !== CODE_LENGTH) {
        showError(`Le code doit faire ${CODE_LENGTH} caractères.`)
        return
      }
      currentRoom = joinRoom(code, nickname, currentAvatar())
      enterLobby()
    })
  }

  // Écran atteint via le QR code / lien de partage (?room=CODE) : uniquement rejoindre,
  // pas d'option pour créer une autre partie ici.
  function renderJoinOnly(prefillCode) {
    root.innerHTML = `
      <main class="screen">
        <div class="brand">
          ${brandToolbarHtml()}
          <span class="brand-emoji">🎉</span>
          <h1>Rejoindre la partie</h1>
          <p class="muted">Code : <strong>${escapeHtml(prefillCode)}</strong></p>
        </div>

        <label class="field">
          Ton pseudo
          <input id="nickname" type="text" maxlength="20" placeholder="Ton pseudo" value="${escapeHtml(localStorage.getItem(NICKNAME_KEY) ?? '')}" autofocus />
        </label>
        ${avatarPickerHtml()}
        <label class="field">
          Code de la partie
          <input id="code" type="text" maxlength="${CODE_LENGTH}" value="${escapeHtml(prefillCode)}" />
        </label>
        <button id="join-btn">Rejoindre la partie</button>
        <p id="error" class="error" hidden></p>

        ${profileHtml()}
      </main>
    `

    wireBrandToolbar()
    wireAvatarPicker()

    const nicknameInput = root.querySelector('#nickname')
    const codeInput = root.querySelector('#code')
    const errorEl = root.querySelector('#error')
    codeInput.addEventListener('input', () => {
      codeInput.value = codeInput.value.toUpperCase()
    })

    root.querySelector('#join-btn').addEventListener('click', () => {
      const nickname = nicknameInput.value.trim()
      if (!nickname) {
        errorEl.textContent = 'Choisis un pseudo avant de continuer.'
        errorEl.hidden = false
        return
      }
      localStorage.setItem(NICKNAME_KEY, nickname)
      const code = codeInput.value.trim().toUpperCase()
      if (isDemoRoomCode(code)) {
        enterDemoMode(nickname)
        return
      }
      if (code.length !== CODE_LENGTH) {
        errorEl.textContent = `Le code doit faire ${CODE_LENGTH} caractères.`
        errorEl.hidden = false
        return
      }
      currentRoom = joinRoom(code, nickname, currentAvatar())
      enterLobby()
    })

    nicknameInput.focus()
  }

  function enterLobby() {
    if (!isDemoRoomCode(currentRoom.code)) {
      saveSession({ roomCode: currentRoom.code, nickname: localStorage.getItem(NICKNAME_KEY), avatar: currentAvatar() })
    }

    const url = new URL(location.href)
    url.searchParams.set('room', currentRoom.code)
    window.history.replaceState(null, '', url)

    const isDisplay = currentRoom.isDisplay

    root.innerHTML = `
      <main class="screen">
        <div class="brand-toolbar lobby-toolbar">
          <button type="button" id="streamer-toggle" class="icon-btn" aria-label="Mode streamer" title="Mode streamer (masque le code de la room)">${isStreamerMode() ? '🙈' : '🎥'}</button>
        </div>
        <h1>${isDisplay ? 'Écran de présentation 📺' : "Salle d'attente 🎈"}</h1>
        <div class="room-code">
          <span class="room-code-label">Code de la partie</span>
          <span class="room-code-value">${escapeHtml(currentRoom.code)}</span>
          <canvas id="room-qr"></canvas>
          <button id="copy-btn">🔗 Copier le lien d'invitation</button>
        </div>
        <ul id="players" class="players"></ul>
        ${
          currentRoom.isHost
            ? `
              <label class="field checkbox-field">
                <input type="checkbox" id="teams-toggle" />
                🛡️ Jouer par équipes
              </label>
              <button id="start-btn" disabled>🚀 Lancer la soirée</button>
            `
            : '<p class="muted">En attente que l\'hôte lance la soirée…</p>'
        }
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

    root.querySelector('#streamer-toggle').addEventListener('click', (e) => {
      setStreamerMode(!isStreamerMode())
      e.currentTarget.textContent = isStreamerMode() ? '🙈' : '🎥'
    })

    const teamsToggle = root.querySelector('#teams-toggle')
    if (teamsToggle) {
      teamsToggle.checked = teamsEnabled
      teamsToggle.addEventListener('change', () => {
        teamsEnabled = teamsToggle.checked
        renderPlayers(onPlayersChangeSnapshot())
      })
    }

    if (currentRoom.isHost) {
      root.querySelector('#start-btn').addEventListener('click', () => {
        if (teamsEnabled) hostPartyConfig.teams = buildTeams(onPlayersChangeSnapshot())
        startParty(hostPartyConfig)
      })
    }

    initParty(root, currentRoom.isHost, isDisplay)
    initChat()
    unsubscribe = onPlayersChange(renderPlayers)
  }

  let lastPlayersSnapshot = []
  function onPlayersChangeSnapshot() {
    return lastPlayersSnapshot
  }

  function buildTeams(players) {
    return TEAM_DEFS.map((def) => ({
      ...def,
      peerIds: players.filter((p, i) => (teamAssignments.get(p.peerId) ?? TEAM_DEFS[i % TEAM_DEFS.length].id) === def.id).map((p) => p.peerId),
    }))
  }

  function renderPlayers(players) {
    lastPlayersSnapshot = players
    const list = root.querySelector('#players')
    if (!list) return
    list.innerHTML = players
      .map((p, i) => {
        const { emoji, color } = avatarHtmlOf(p.avatar)
        const team = teamsEnabled ? teamAssignments.get(p.peerId) ?? TEAM_DEFS[i % TEAM_DEFS.length].id : null
        const teamDef = team ? TEAM_DEFS.find((t) => t.id === team) : null
        return `
          <li>
            <span class="avatar" style="background:${color}">${emoji}</span>
            ${escapeHtml(p.nickname)}
            <span class="latency-dot ${latencyClass(p.latency)}" title="latence"></span>
            ${p.isHost ? ' <span class="badge">hôte</span>' : ''}
            ${teamDef ? `<button type="button" class="team-dot-btn" data-peer="${p.peerId}" style="background:${teamDef.color}" title="${escapeHtml(teamDef.name)} — clique pour changer d'équipe"></button>` : ''}
          </li>
        `
      })
      .join('')

    if (teamsEnabled && currentRoom?.isHost) {
      list.querySelectorAll('.team-dot-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const peerId = btn.dataset.peer
          const current = teamAssignments.get(peerId) ?? TEAM_DEFS[0].id
          const nextIdx = (TEAM_DEFS.findIndex((t) => t.id === current) + 1) % TEAM_DEFS.length
          teamAssignments.set(peerId, TEAM_DEFS[nextIdx].id)
          renderPlayers(players)
        })
      })
    }

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
    setDemoMode(false)
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
