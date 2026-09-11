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

// Les pairs "écran" (mode TV, cf. #1 V2) ne sont pas des joueurs : ils ne comptent pas
// dans le minimum de joueurs, ne reçoivent pas de tour, ne marquent pas de points — mais
// ils restent des pairs WebRTC normaux et reçoivent donc bien toutes les diffusions de jeu.
export function getPlayers() {
  const list = selfInfo && !selfInfo.isDisplay ? [{ peerId: selfId, ...selfInfo, latency: 0 }] : []
  for (const [peerId, info] of peers) {
    if (info.isDisplay) continue
    list.push({ peerId, ...info, latency: latencies.get(peerId) ?? null })
  }
  return list
}

export function isSelfDisplay() {
  return Boolean(selfInfo?.isDisplay)
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
  if (!selfInfo || selfInfo.isHost || selfInfo.isDisplay) return
  const remaining = getPlayers()
  if (remaining.length === 0) return
  const earliest = remaining.reduce((a, b) => (a.joinedAt <= b.joinedAt ? a : b))
  if (earliest.peerId === selfId) {
    selfInfo.isHost = true
    sendPresence(selfInfo)
    notify()
  }
}

function connect(code, nickname, isHost, avatar, isDisplay = false) {
  selfInfo = { nickname, isHost, avatar, joinedAt: Date.now(), isDisplay }
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
    get isDisplay() {
      return Boolean(selfInfo?.isDisplay)
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

// Créer une partie = devenir le·la présentateur·ice de l'écran partagé (code + QR + réglages),
// pas un·e joueur·euse — tout le monde d'autre rejoint ensuite via le QR code sur son téléphone.
export function createRoom(avatar) {
  return connect(generateCode(), 'Présentateur', true, avatar, true)
}

export function joinRoom(code, nickname, avatar, opts = {}) {
  return connect(code, nickname, false, avatar, opts.isDisplay ?? false)
}

// --- Mode démo : room spéciale "2DEMO" ---
// Permet de tester tous les jeux/fonctionnalités seul, sans dépendre du webhook ni d'un
// deuxième joueur réel. Simule 2 "bots" (affichage seulement, ils ne jouent pas) pour
// satisfaire le minimum de joueurs, et une room Trystero factice qui n'émet vers personne
// (exactement comme un vrai broadcast Trystero, qu'on ne se renvoie jamais à soi-même).
export const DEMO_ROOM_CODE = '2DEMO'

const DEMO_BOTS = [
  { peerId: 'demo-bot-alice', nickname: 'Bot Alice', avatar: { emoji: '🤖', color: '#4DABF7' } },
  { peerId: 'demo-bot-bob', nickname: 'Bot Bob', avatar: { emoji: '🤖', color: '#FFA94D' } },
]

export function isDemoRoomCode(code) {
  return (code ?? '').toUpperCase() === DEMO_ROOM_CODE
}

export function createDemoRoom(nickname, avatar) {
  selfInfo = { nickname, isHost: true, avatar, joinedAt: Date.now() }
  peers.clear()
  latencies.clear()
  DEMO_BOTS.forEach((bot, i) => {
    peers.set(bot.peerId, { nickname: bot.nickname, isHost: false, avatar: bot.avatar, joinedAt: i + 1 })
  })

  room = {
    makeAction() {
      let handler = () => {}
      const send = () => {} // aucun pair réseau réel en mode démo, rien à envoyer
      const receive = (fn) => {
        handler = fn
        void handler
      }
      return [send, receive]
    },
    onPeerJoin() {},
    onPeerLeave() {},
  }

  clearInterval(pingHandle)
  pingHandle = null
  notify()

  return {
    code: DEMO_ROOM_CODE,
    get isHost() {
      return true
    },
    get isDisplay() {
      return false
    },
    leave() {
      room = null
      selfInfo = null
      peers.clear()
      latencies.clear()
      notify()
    },
  }
}

function generateCode() {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return code
}
