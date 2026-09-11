import { escapeHtml } from '../util/html.js'
import { getRoom, getSelfId, getPlayers } from '../network/room.js'
import { avatarHtmlOf } from '../util/avatar.js'

let sendChat = null
let receiveChat = null
let container = null
let panelEl = null
let listEl = null
let badgeEl = null
let unreadCount = 0
let open = false

export function initChat() {
  if (container) return
  const room = getRoom()
  if (!room) return
  ;[sendChat, receiveChat] = room.makeAction('chat')
  receiveChat((data, peerId) => appendMessage(peerId, data.text))
  buildDom()
}

export function destroyChat() {
  container?.remove()
  container = null
  panelEl = null
  listEl = null
  badgeEl = null
  sendChat = null
  receiveChat = null
  unreadCount = 0
  open = false
}

function buildDom() {
  container = document.createElement('div')
  container.className = 'chat-dock'
  container.innerHTML = `
    <button type="button" class="chat-tab" id="chat-toggle" aria-label="Ouvrir le chat">
      <span class="chat-tab-icon">💬</span>
      <span class="chat-tab-label">Chat</span>
      <span class="chat-badge" id="chat-badge" hidden></span>
    </button>
    <div class="chat-scrim" id="chat-scrim" hidden></div>
    <div class="chat-panel" id="chat-panel" hidden>
      <div class="chat-header">
        <span>💬 Chat de la soirée</span>
        <button type="button" class="chat-close" id="chat-close" aria-label="Fermer le chat">✕</button>
      </div>
      <ul class="chat-messages" id="chat-messages"></ul>
      <form class="chat-form" id="chat-form">
        <input id="chat-input" type="text" maxlength="200" placeholder="Écris un message..." autocomplete="off" />
        <button type="submit" aria-label="Envoyer">➤</button>
      </form>
    </div>
  `
  document.body.appendChild(container)
  panelEl = container.querySelector('#chat-panel')
  listEl = container.querySelector('#chat-messages')
  badgeEl = container.querySelector('#chat-badge')

  container.querySelector('#chat-toggle').addEventListener('click', toggle)
  container.querySelector('#chat-close').addEventListener('click', toggle)
  container.querySelector('#chat-scrim').addEventListener('click', toggle)
  container.querySelector('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault()
    const input = container.querySelector('#chat-input')
    const text = input.value.trim()
    if (!text || !sendChat) return
    sendChat({ text })
    appendMessage(getSelfId(), text)
    input.value = ''
  })
}

function toggle() {
  open = !open
  panelEl.hidden = !open
  container.querySelector('#chat-scrim').hidden = !open
  container.classList.toggle('chat-dock-open', open)
  if (open) {
    unreadCount = 0
    updateBadge()
    container.querySelector('#chat-input').focus()
  }
}

function appendMessage(peerId, text) {
  if (!listEl) return
  const player = getPlayers().find((p) => p.peerId === peerId)
  const nickname = player?.nickname ?? '???'
  const { emoji, color } = avatarHtmlOf(player?.avatar)
  const isSelf = peerId === getSelfId()
  const li = document.createElement('li')
  li.className = `chat-line${isSelf ? ' is-self' : ''}`
  li.innerHTML = `
    <span class="avatar chat-line-avatar" style="background:${color}">${escapeHtml(emoji)}</span>
    <span class="chat-line-body">
      <span class="chat-line-name">${escapeHtml(nickname)}</span>
      <span class="chat-line-text">${escapeHtml(text)}</span>
    </span>
  `
  listEl.appendChild(li)
  listEl.scrollTop = listEl.scrollHeight

  if (!open && peerId !== getSelfId()) {
    unreadCount += 1
    updateBadge()
  }
}

function updateBadge() {
  if (!badgeEl) return
  badgeEl.hidden = unreadCount === 0
  badgeEl.textContent = String(unreadCount)
}
