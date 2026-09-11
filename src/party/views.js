import { escapeHtml } from '../util/html.js'
import { avatarHtmlOf } from '../util/avatar.js'
import { downloadStandingsImage } from '../util/shareImage.js'

const MEDALS = ['🥇', '🥈', '🥉']
const REACTION_EMOJIS = ['👏', '😂', '😮', '❤️', '🔥']

function avatarHtml(avatar) {
  const { emoji, color } = avatarHtmlOf(avatar)
  return `<span class="avatar" style="background:${color}">${emoji}</span>`
}

export function renderVoteScreen(root, { options, tally, remaining, myVote, onVote, roundNumber, roundsCount }) {
  root.innerHTML = `
    <main class="screen">
      <h1>On joue à quoi ? 🎲</h1>
      <p class="muted">Manche ${roundNumber} / ${roundsCount}</p>
      <p class="muted timer-pill" id="vote-timer" aria-live="polite">⏱️ ${remaining}s</p>
      <div class="vote-grid">
        ${options
          .map(
            (o) => `
              <button class="vote-card${myVote === o.id ? ' selected' : ''}" data-id="${o.id}">
                <span class="vote-icon">${o.icon ?? '🎮'}</span>
                <h2>${escapeHtml(o.title)}</h2>
                <p>${escapeHtml(o.description)}</p>
                <span class="vote-count">${tally.get(o.id)?.size ?? 0} vote(s)</span>
              </button>
            `
          )
          .join('')}
      </div>
    </main>
  `

  root.querySelectorAll('.vote-card').forEach((btn) => {
    btn.addEventListener('click', () => onVote(btn.dataset.id))
  })
}

// Met à jour le timer et les compteurs sans recréer le DOM (évite de relancer
// l'animation d'apparition de l'écran à chaque tick / vote).
export function updateVoteScreen(root, { tally, remaining, myVote }) {
  const timerEl = root.querySelector('#vote-timer')
  if (timerEl) timerEl.textContent = `⏱️ ${remaining}s`

  root.querySelectorAll('.vote-card').forEach((btn) => {
    const id = btn.dataset.id
    const countEl = btn.querySelector('.vote-count')
    if (countEl) countEl.textContent = `${tally.get(id)?.size ?? 0} vote(s)`
    btn.classList.toggle('selected', myVote === id)
  })
}

export function renderResultsScreen(root, { rankings, players, standings, isHost, isFinal, roundNumber, roundsCount, titles, onContinue, onRestart }) {
  const playerOf = (peerId) => players.find((p) => p.peerId === peerId)
  const nicknameOf = (peerId) => standings.find((s) => s.peerId === peerId)?.nickname ?? playerOf(peerId)?.nickname ?? '???'

  const actionHtml = isFinal
    ? isHost
      ? '<button id="continue-btn">🔁 Rejouer une soirée</button>'
      : '<p class="muted">La soirée est terminée, merci d\'avoir joué !</p>'
    : isHost
      ? '<button id="continue-btn">Voter le prochain jeu 👉</button>'
      : '<p class="muted">En attente de l\'hôte pour continuer…</p>'

  const titlesHtml =
    isFinal && titles?.length
      ? `
        <h2>Titres de la soirée</h2>
        <ol class="leaderboard">
          ${titles.map((t) => `<li>${t.emoji} ${escapeHtml(t.label)} <span class="points">${escapeHtml(nicknameOf(t.peerId))}</span></li>`).join('')}
        </ol>
      `
      : ''

  root.innerHTML = `
    <main class="screen">
      <h1>${isFinal ? 'Fin de la soirée 🏆' : 'Résultats 🎉'}</h1>
      <p class="muted">Manche ${roundNumber} / ${roundsCount}</p>
      <ol class="podium">
        ${rankings
          .map((peerId, i) => {
            const p = playerOf(peerId)
            const nickname = p?.nickname ?? '???'
            return `<li>${avatarHtml(p?.avatar)} <span class="rank">${MEDALS[i] ?? `#${i + 1}`}</span> ${escapeHtml(nickname)}</li>`
          })
          .join('')}
      </ol>
      <h2>Classement général</h2>
      <ol class="leaderboard">
        ${standings.map((s) => `<li>${avatarHtml(s.avatar)} ${escapeHtml(s.nickname)} <span class="points">${s.points} pts</span></li>`).join('')}
      </ol>
      ${titlesHtml}
      ${isFinal ? '<button id="share-btn" class="btn-secondary">📸 Télécharger le classement</button>' : ''}
      ${actionHtml}
    </main>
  `

  const continueBtn = root.querySelector('#continue-btn')
  if (continueBtn) {
    continueBtn.addEventListener('click', isFinal ? onRestart : onContinue)
  }

  const shareBtn = root.querySelector('#share-btn')
  if (shareBtn) {
    shareBtn.addEventListener('click', () => downloadStandingsImage(standings, titles, nicknameOf))
  }
}

export function renderGameShell(root, standings, onReact) {
  root.innerHTML = `
    <div class="party-game-wrap">
      <aside class="leaderboard-widget">
        <h3>🏆 Classement</h3>
        <ol>
          ${standings.map((s) => `<li>${avatarHtml(s.avatar)} ${escapeHtml(s.nickname)} <span class="points">${s.points}</span></li>`).join('')}
        </ol>
      </aside>
      <div class="game-container"></div>
      <div class="reaction-bar">
        ${REACTION_EMOJIS.map((e) => `<button type="button" class="reaction-btn" data-emoji="${e}">${e}</button>`).join('')}
      </div>
    </div>
  `

  if (onReact) {
    root.querySelectorAll('.reaction-btn').forEach((btn) => {
      btn.addEventListener('click', () => onReact(btn.dataset.emoji))
    })
  }

  return root.querySelector('.game-container')
}

export function renderSpectating(root) {
  root.innerHTML = `
    <main class="screen">
      <h1>Partie en cours 👀</h1>
      <p class="muted">Une manche est déjà en train de se jouer — tu rejoins à la prochaine !</p>
    </main>
  `
}

export function showFloatingReaction(nickname, emoji) {
  const el = document.createElement('div')
  el.className = 'floating-reaction'
  el.style.left = `${15 + Math.random() * 65}%`
  el.innerHTML = `<span class="floating-reaction-emoji">${emoji}</span><span class="floating-reaction-name">${escapeHtml(nickname)}</span>`
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 1600)
}

export function renderCancelMessage(root, reason) {
  const message =
    reason === 'fetch-failed'
      ? 'Impossible de charger les questions pour ce jeu — on retourne au vote.'
      : reason === 'host-left'
        ? "L'hôte a quitté la partie en cours — un nouvel hôte a pris le relais, retour au vote."
        : 'La partie a été annulée.'

  const toast = document.createElement('p')
  toast.className = 'error cancel-toast'
  toast.textContent = message
  root.prepend(toast)
}

export function showComboToast(count) {
  const el = document.createElement('div')
  el.className = 'combo-toast'
  el.textContent = `🔥 ${count} bonnes réponses d'affilée !`
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 2200)
}
