import { joinRoom as trysteroJoinRoom, selfId } from 'trystero/torrent'

const APP_ID = 'romet-minigames'
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // sans caractères ambigus (0/O, 1/I/L)
const CODE_LENGTH = 5
const PING_INTERVAL_MS = 5000

let room = null
let selfInfo = null
let sendPresence = null
let sendPing = null
let pingHandle = null
const peers = new Map() // peerId -> { nickname, isHost, avatar, joinedAt }
const latencies = new Map() // peerId -> ms
const listeners = new Set()

export function getSelfId() {
  return selfId
}

export function getRoom() {
  return room
}

export function getPlayers() {
  const list = selfInfo ? [{ peerId: selfId, ...selfInfo, latency: 0 }] : []
  for (const [peerId, info] of peers) list.push({ peerId, ...info, latency: latencies.get(peerId) ?? null })
  return list
}

function notify() {
  for (const cb of listeners) cb(getPlayers())
}

export function onPlayersChange(cb) {
  listeners.add(cb)
  cb(getPlayers())
  return () => listeners.delete(cb)
}

// Si le pair qui vient de partir était l'hôte, le pair restant connecté depuis
// le plus longtemps se promeut lui-même hôte — calcul déterministe, chacun
// arrive indépendamment à la même conclusion sans coordination.
function maybePromoteSelf() {
  if (!selfInfo || selfInfo.isHost) return
  const remaining = getPlayers()
  if (remaining.length === 0) return
  const earliest = remaining.reduce((a, b) => (a.joinedAt <= b.joinedAt ? a : b))
  if (earliest.peerId === selfId) {
    selfInfo.isHost = true
    sendPresence(selfInfo)
    notify()
  }
}

function connect(code, nickname, isHost, avatar) {
  selfInfo = { nickname, isHost, avatar, joinedAt: Date.now() }
  peers.clear()
  latencies.clear()
  room = trysteroJoinRoom({ appId: APP_ID }, code)
  const [sendPresenceFn, receivePresence] = room.makeAction('presence')
  const [sendPingFn, receivePing] = room.makeAction('ping')
  const [sendPong, receivePong] = room.makeAction('pong')
  sendPresence = sendPresenceFn
  sendPing = sendPingFn

  room.onPeerJoin(() => sendPresence(selfInfo))
  room.onPeerLeave((peerId) => {
    const wasHost = peers.get(peerId)?.isHost
    peers.delete(peerId)
    latencies.delete(peerId)
    if (wasHost) maybePromoteSelf()
    notify()
  })

  receivePresence((data, peerId) => {
    peers.set(peerId, data)
    notify()
  })

  receivePing((data, peerId) => {
    sendPong({ t: data.t }, peerId)
  })

  receivePong((data, peerId) => {
    latencies.set(peerId, Date.now() - data.t)
    notify()
  })

  clearInterval(pingHandle)
  pingHandle = setInterval(() => sendPing({ t: Date.now() }), PING_INTERVAL_MS)

  return {
    code,
    get isHost() {
      return selfInfo?.isHost ?? isHost
    },
    leave() {
      clearInterval(pingHandle)
      pingHandle = null
      room.leave()
      room = null
      selfInfo = null
      peers.clear()
      latencies.clear()
      notify()
    },
  }
}

export function createRoom(nickname, avatar) {
  return connect(generateCode(), nickname, true, avatar)
}

export function joinRoom(code, nickname, avatar) {
  return connect(code, nickname, false, avatar)
}

function generateCode() {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return code
}
