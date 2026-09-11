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

export function renderResultsScreen(
  root,
  {
    rankings,
    players,
    standings,
    teamStandings,
    eliminatedIds,
    roundHistory,
    partyRecap,
    responseTimes,
    isHost,
    isFinal,
    roundNumber,
    roundsCount,
    winCondition,
    playlistMode,
    titles,
    onContinue,
    onRestart,
    onBonusPoint,
  }
) {
  const playerOf = (peerId) => players.find((p) => p.peerId === peerId)
  const nicknameOf = (peerId) => standings.find((s) => s.peerId === peerId)?.nickname ?? playerOf(peerId)?.nickname ?? '???'

  const actionHtml = isFinal
    ? isHost
      ? '<button id="continue-btn">🔁 Rejouer une soirée</button>'
      : '<p class="muted">La soirée est terminée, merci d\'avoir joué !</p>'
    : isHost
      ? `<button id="continue-btn">${playlistMode === 'manual' ? 'Jeu suivant 👉' : 'Voter le prochain jeu 👉'}</button>`
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

  const teamsHtml = teamStandings?.length
    ? `
      <h2>🛡️ Classement par équipe</h2>
      <ol class="leaderboard team-standings">
        ${teamStandings
          .map(
            (t) => `<li><span class="team-dot" style="background:${escapeHtml(t.color)}"></span>${escapeHtml(t.name)} <span class="points">${t.points} pts</span></li>`
          )
          .join('')}
      </ol>
    `
    : ''

  const eliminatedThisRound = (eliminatedIds ?? []).filter((id) => rankings.includes(id))
  const eliminationHtml =
    winCondition === 'elimination' && eliminatedThisRound.length && !isFinal
      ? `<p class="error">💀 ${eliminatedThisRound.map((id) => escapeHtml(nicknameOf(id))).join(', ')} éliminé(e) de la soirée !</p>`
      : ''

  const statsHtml = isFinal && roundHistory?.length ? renderStatsDashboard(roundHistory, players, responseTimes) : ''
  const recapHtml = isFinal && partyRecap?.length ? renderRecap(partyRecap, players) : ''

  root.innerHTML = `
    <main class="screen">
      <h1>${isFinal ? 'Fin de la soirée 🏆' : 'Résultats 🎉'}</h1>
      <p class="muted">Manche ${roundNumber} / ${roundsCount}</p>
      ${eliminationHtml}
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
        ${standings
          .map(
            (s) =>
              `<li${eliminatedIds?.includes(s.peerId) ? ' class="is-eliminated"' : ''}>${avatarHtml(s.avatar)} ${escapeHtml(s.nickname)}${eliminatedIds?.includes(s.peerId) ? ' 💀' : ''} <span class="points">${s.points} pts</span>${
                isHost ? `<button type="button" class="bonus-btn" data-peer="${s.peerId}" title="Ajouter un point bonus (ex : faute de frappe)">+1</button>` : ''
              }</li>`
          )
          .join('')}
      </ol>
      ${teamsHtml}
      ${titlesHtml}
      ${statsHtml}
      ${recapHtml}
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
    shareBtn.addEventListener('click', () => downloadStandingsImage(standings, titles, nicknameOf, deriveHighlights(partyRecap, nicknameOf)))
  }

  if (onBonusPoint) {
    root.querySelectorAll('.bonus-btn').forEach((btn) => {
      btn.addEventListener('click', () => onBonusPoint(btn.dataset.peer, 1))
    })
  }

  if (isFinal && partyRecap?.length) wireRecapReplays(root, partyRecap)
}

const GAME_LABELS = { quiz: '🧠 Quiz', draw: '🎨 Dessin', guess: '🖼️ Devine', impostor: '🕵️ Imposteur', pbac: '📝 Petit Bac', wordle: '🔤 Wordle', define: '📖 Définition' }

// Quelques moments marquants piochés dans le récap pour enrichir l'image de classement
// exportable (au-delà du simple tableau de scores).
const MAX_HIGHLIGHTS = 4
function deriveHighlights(partyRecap, nicknameOf) {
  if (!partyRecap?.length) return []
  const highlights = []
  for (const e of partyRecap) {
    if (highlights.length >= MAX_HIGHLIGHTS) break
    if (e.type === 'draw') highlights.push(`🎨 "${e.answer}" dessiné par ${e.drawerNickname ?? '???'}`)
    else if (e.type === 'impostor') highlights.push(`🕵️ Imposteur ${e.caught ? 'démasqué' : 'jamais démasqué'} : ${nicknameOf(e.imposteurId)}`)
  }
  return highlights
}

function buildRecapGroups(partyRecap) {
  const groups = []
  for (const entry of partyRecap) {
    let group = groups.find((g) => g.gameId === entry.gameId && g.roundNumber === entry.roundNumber)
    if (!group) {
      group = { gameId: entry.gameId, roundNumber: entry.roundNumber, entries: [] }
      groups.push(group)
    }
    group.entries.push(entry)
  }
  return groups
}

function renderRecap(partyRecap, players) {
  const nicknameOf = (peerId) => players.find((p) => p.peerId === peerId)?.nickname ?? '???'
  const groups = buildRecapGroups(partyRecap)
  let replayIdx = 0

  const entryHtml = (e) => {
    if (e.type === 'draw') {
      const hasReplay = Array.isArray(e.strokes) && e.strokes.length > 0
      const btnHtml = hasReplay
        ? `<button type="button" class="btn-secondary recap-replay-btn" data-recap-idx="${replayIdx++}">▶️ Revoir le dessin</button><canvas class="recap-replay-canvas" width="500" height="350" hidden></canvas>`
        : ''
      return `<div class="recap-entry">
        ${e.imageUrl ? `<img class="recap-drawing" src="${escapeHtml(e.imageUrl)}" alt="Dessin : ${escapeHtml(e.answer)}" />` : ''}
        <p>✏️ ${escapeHtml(e.drawerNickname ?? '???')} devait faire deviner <strong>${escapeHtml(e.answer)}</strong></p>
        ${btnHtml}
      </div>`
    }
    if (e.type === 'guess') {
      return `<div class="recap-entry">${e.imageUrl ? `<img class="recap-drawing" src="${escapeHtml(e.imageUrl)}" alt="${escapeHtml(e.answer)}" />` : ''}<p>Réponse : <strong>${escapeHtml(e.answer)}</strong></p></div>`
    }
    if (e.type === 'impostor') {
      return `<div class="recap-entry"><p>Mot secret : <strong>${escapeHtml(e.prompt)}</strong> — Imposteur : ${escapeHtml(nicknameOf(e.imposteurId))} (${e.caught ? 'démasqué ✅' : 'pas démasqué 😈'})</p></div>`
    }
    if (e.type === 'quiz' || e.type === 'define') {
      return `<div class="recap-entry"><p>${escapeHtml(e.prompt)}</p><p>Réponse : <strong>${escapeHtml(e.answer)}</strong></p></div>`
    }
    return `<div class="recap-entry"><p>${escapeHtml(e.prompt ?? '')} ${e.answer ? `— <strong>${escapeHtml(e.answer)}</strong>` : ''}</p></div>`
  }

  return `
    <details class="card recap-details">
      <summary>🎬 Revivre la soirée</summary>
      ${groups
        .map(
          (g) => `
            <details class="recap-round">
              <summary>Manche ${g.roundNumber} — ${GAME_LABELS[g.gameId] ?? g.gameId}</summary>
              ${g.entries.map(entryHtml).join('')}
            </details>
          `
        )
        .join('')}
    </details>
  `
}

// Rejoue l'historique des traits d'un dessin sur un canvas, en accéléré (~3s), pour le
// récap de fin de soirée — appelé après insertion du DOM (le canvas doit déjà exister).
function playStrokeReplay(canvas, strokes) {
  const c = canvas.getContext('2d')
  c.clearRect(0, 0, canvas.width, canvas.height)
  const allSegments = strokes.flatMap((stroke) => stroke.segments.map((seg) => ({ ...seg, color: stroke.color })))
  if (allSegments.length === 0) return
  const REPLAY_DURATION_MS = 3000
  const stepMs = Math.max(4, REPLAY_DURATION_MS / allSegments.length)
  let i = 0
  const drawNext = () => {
    if (i >= allSegments.length) return
    const seg = allSegments[i]
    c.beginPath()
    c.moveTo(seg.x0, seg.y0)
    c.lineTo(seg.x1, seg.y1)
    c.strokeStyle = seg.color
    c.lineWidth = seg.color === '#ffffff' ? 16 : 3
    c.lineCap = 'round'
    c.stroke()
    i += 1
    setTimeout(drawNext, stepMs)
  }
  drawNext()
}

// Attache les écouteurs des boutons "Revoir le dessin" du récap — à appeler juste après
// avoir inséré le HTML de renderRecap dans le DOM.
function wireRecapReplays(root, partyRecap) {
  const groups = buildRecapGroups(partyRecap)
  const drawEntriesWithStrokes = groups.flatMap((g) => g.entries).filter((e) => e.type === 'draw' && Array.isArray(e.strokes) && e.strokes.length > 0)

  root.querySelectorAll('.recap-replay-btn').forEach((btn) => {
    const entry = drawEntriesWithStrokes[Number(btn.dataset.recapIdx)]
    if (!entry) return
    btn.addEventListener('click', () => {
      const canvas = btn.nextElementSibling
      if (!canvas) return
      canvas.hidden = false
      btn.disabled = true
      playStrokeReplay(canvas, entry.strokes)
      setTimeout(() => {
        btn.disabled = false
      }, 3000)
    })
  })
}

function renderStatsDashboard(roundHistory, players, responseTimes) {
  const nicknameOf = (peerId) => players.find((p) => p.peerId === peerId)?.nickname ?? '???'
  const gameLabel = { quiz: '🧠', draw: '🎨', guess: '🖼️', impostor: '🕵️', pbac: '📝', wordle: '🔤', define: '📖' }
  const allPeerIds = roundHistory.at(-1)?.standings.map((s) => s.peerId) ?? []

  const avgResponseMs = (peerId) => {
    const times = responseTimes?.[peerId]
    if (!times?.length) return null
    return Math.round(times.reduce((a, b) => a + b, 0) / times.length)
  }

  return `
    <details class="card stats-dashboard">
      <summary>📊 Statistiques de la soirée</summary>
      <div class="stats-table-wrap">
        <table class="stats-table">
          <thead>
            <tr>
              <th>Joueur</th>
              ${roundHistory.map((r) => `<th title="${escapeHtml(r.gameId ?? '')}">${gameLabel[r.gameId] ?? '🎮'}${r.roundNumber}</th>`).join('')}
              ${responseTimes ? '<th title="Temps de réponse moyen">⏱️ moy.</th>' : ''}
            </tr>
          </thead>
          <tbody>
            ${allPeerIds
              .map((peerId) => {
                const cells = roundHistory
                  .map((r) => `<td>${r.standings.find((s) => s.peerId === peerId)?.points ?? 0}</td>`)
                  .join('')
                const avg = avgResponseMs(peerId)
                const avgCell = responseTimes ? `<td>${avg != null ? `${(avg / 1000).toFixed(1)}s` : '—'}</td>` : ''
                return `<tr><td>${escapeHtml(nicknameOf(peerId))}</td>${cells}${avgCell}</tr>`
              })
              .join('')}
          </tbody>
        </table>
      </div>
    </details>
  `
}

export function renderGameShell(root, standings, onReact, isDisplay, onSkip) {
  root.innerHTML = `
    <div class="party-game-wrap">
      <aside class="leaderboard-widget">
        <h3>🏆 Classement</h3>
        <ol>
          ${standings.map((s) => `<li>${avatarHtml(s.avatar)} ${escapeHtml(s.nickname)} <span class="points">${s.points}</span></li>`).join('')}
        </ol>
        ${isDisplay && onSkip ? '<button type="button" id="regie-skip-btn" class="btn-secondary" title="Passer la manche en cours">⏭️ Passer la manche</button>' : ''}
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

  const skipBtn = root.querySelector('#regie-skip-btn')
  if (skipBtn && onSkip) {
    skipBtn.addEventListener('click', () => {
      if (confirm('Passer cette manche et revenir au vote ?')) onSkip()
    })
  }

  return root.querySelector('.game-container')
}

// Écran d'intro façon "générique" avant le lancement de la soirée, affiché brièvement
// sur toutes les fenêtres (surtout pensé pour l'écran de présentation).
export function renderIntroScreen(root, title) {
  root.innerHTML = `
    <main class="screen intro-screen">
      <h1 class="intro-title">${escapeHtml(title)}</h1>
      <p class="muted">La soirée commence…</p>
    </main>
  `
}

// Combo de réactions géantes : plusieurs joueurs envoient le même emoji en même temps.
// Bien plus visible que la réaction flottante classique, surtout sur l'écran présentateur.
export function showReactionCombo(emoji, count) {
  const el = document.createElement('div')
  el.className = 'reaction-combo'
  el.innerHTML = `<span class="reaction-combo-emoji">${emoji}</span><span class="reaction-combo-count">x${count} !</span>`
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 1800)
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
        : reason === 'host-skip'
          ? "Le présentateur a passé cette manche — retour au vote."
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
