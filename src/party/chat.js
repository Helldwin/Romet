import { escapeHtml } from '../util/html.js'
import { getRoom, getSelfId, getPlayers } from '../network/room.js'

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
  container.className = 'chat-widget'
  container.innerHTML = `
    <button type="button" class="chat-toggle" id="chat-toggle" aria-label="Ouvrir le chat">
      💬<span class="chat-badge" id="chat-badge" hidden></span>
    </button>
    <div class="chat-panel" id="chat-panel" hidden>
      <div class="chat-header">Chat</div>
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
  if (open) {
    unreadCount = 0
    updateBadge()
    container.querySelector('#chat-input').focus()
  }
}

function appendMessage(peerId, text) {
  if (!listEl) return
  const nickname = getPlayers().find((p) => p.peerId === peerId)?.nickname ?? '???'
  const li = document.createElement('li')
  li.innerHTML = `<strong>${escapeHtml(nickname)}</strong> ${escapeHtml(text)}`
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
