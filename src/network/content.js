const WEBHOOK_URL = 'https://n8n.matiboux.com/webhook/Romet/Games'
const FETCH_TIMEOUT_MS = 8000
const HEALTH_CHECK_TIMEOUT_MS = 5000
const CACHE_KEY_PREFIX = 'romet:cache:'

// --- Mode démo (room "2DEMO") ---
// Seule exception volontaire à la règle « toujours du contenu Grist en direct » : un jeu de
// données factices, utilisé uniquement quand on a explicitement rejoint la room spéciale
// 2DEMO (cf. room.js), pour pouvoir tester toutes les fonctionnalités sans dépendre du
// webhook ni d'un deuxième joueur réel.
let demoMode = false

export function setDemoMode(value) {
  demoMode = value
}

const DEMO_QUIZ = [
  { text: 'Ceci est une question de démo n°1 — quelle est la capitale de la France ?', choices: ['Lyon', 'Paris', 'Marseille', 'Nice'], answer: 'Paris' },
  { text: 'Question de démo n°2 — combien font 2 + 2 ?', choices: ['3', '4', '5', '6'], answer: '4' },
  { text: 'Question de démo n°3 — quelle couleur obtient-on en mélangeant bleu et jaune ?', choices: ['Rouge', 'Vert', 'Violet', 'Orange'], answer: 'Vert' },
  { text: 'Question de démo n°4 — combien de jours dans une semaine ?', choices: ['5', '6', '7', '8'], answer: '7' },
  { text: 'Question de démo n°5 — quel animal miaule ?', choices: ['Chien', 'Chat', 'Vache', 'Canard'], answer: 'Chat' },
  { text: 'Question de démo n°6 — quelle planète est la plus proche du Soleil ?', choices: ['Terre', 'Vénus', 'Mercure', 'Mars'], answer: 'Mercure' },
  { text: 'Question de démo n°7 — combien de continents sur Terre ?', choices: ['5', '6', '7', '8'], answer: '7' },
  { text: 'Question de démo n°8 — quelle est la monnaie du Japon ?', choices: ['Yen', 'Won', 'Yuan', 'Dollar'], answer: 'Yen' },
]

const DEMO_DRAW = ['chat', 'maison', 'soleil', 'guitare', 'fusée', 'dragon', 'pizza', 'robot', 'arbre', 'vélo', 'château', 'pirate']

const DEMO_GUESS = Array.from({ length: 10 }, (_, i) => ({
  imageUrl: `https://picsum.photos/seed/romet-demo-${i}/500/650`,
  answer: `Titre Démo ${i + 1}`,
  category: ['Film', 'Serie', 'Jeu'][i % 3],
  genre: 'Aventure',
  year: 2015 + i,
}))

const DEMO_WORDLE = ['TABLE', 'PORTE', 'VERRE', 'LIVRE', 'PLAGE', 'FLEUR', 'GENIE', 'MUSEE'].map((word) => ({ word }))
const DEMO_DEFINE = [
  { word: 'girafe', def: 'Le plus grand mammifère terrestre, reconnaissable à son très long cou.' },
  { word: 'horloge', def: 'Instrument qui indique et mesure le temps qui passe.' },
  { word: 'volcan', def: 'Relief formé par la remontée de magma en fusion.' },
  { word: 'boussole', def: "Instrument qui indique le nord grâce à une aiguille aimantée." },
  { word: 'oasis', def: "Point d'eau et de végétation isolé au milieu d'un désert." },
]
const DEMO_IMPOSTOR = DEMO_DRAW.map((word) => ({ word }))
const DEMO_PBAC = ['Prénom', 'Pays / Ville', 'Animal', 'Métier', 'Objet', 'Fruit ou légume', 'Film / Série', 'Sport', 'Couleur', 'Célébrité'].map((category) => ({ category }))

function demoContentFor(game) {
  if (game === 'quiz') return DEMO_QUIZ
  if (game === 'draw') return DEMO_DRAW.map((word) => ({ word }))
  if (game === 'guess') return DEMO_GUESS
  if (game === 'wordle') return DEMO_WORDLE
  if (game === 'define') return DEMO_DEFINE
  if (game === 'impostor') return DEMO_IMPOSTOR
  if (game === 'pbac') return DEMO_PBAC
  return []
}

// Nettoie d'anciennes entrées du cache de secours qui existait avant — on ne
// veut plus jamais servir de données qui ne viennent pas fraîchement du webhook.
for (const key of Object.keys(localStorage)) {
  if (key.startsWith(CACHE_KEY_PREFIX)) localStorage.removeItem(key)
}

/**
 * Vérifie rapidement si le webhook de contenu répond, pour bloquer l'accès au site
 * (écran de maintenance) s'il est injoignable.
 */
export async function checkWebhookHealth() {
  if (demoMode) return true
  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS)
  try {
    const res = await fetch(`${WEBHOOK_URL}?game=quiz&count=1`, { signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeoutHandle)
  }
}

/**
 * Récupère le contenu d'un mini-jeu depuis le webhook de contenu — toujours en direct,
 * jamais de repli sur des données mises en cache ou codées en dur.
 * Contrat : GET <WEBHOOK_URL>?game=<game>&count=<count>[&...extra] -> tableau JSON non vide.
 * `extra` ajoute des paramètres de requête additionnels (ex: { difficulty: 'easy' },
 * { category: 'Film' }) — à charge du serveur de contenu de filtrer dessus.
 * Lève une erreur si la requête échoue (réseau, timeout, statut, réponse vide) —
 * à charge de l'appelant (chaque jeu) d'annuler proprement la partie dans ce cas.
 */
export async function fetchGameContent(game, count, extra = {}) {
  if (demoMode) return demoContentFor(game)
  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const params = new URLSearchParams({ game, count: String(count), ...extra })
    const res = await fetch(`${WEBHOOK_URL}?${params}`, { signal: controller.signal })
    if (!res.ok) throw new Error('bad-status')
    const data = await res.json()
    if (!Array.isArray(data) || data.length === 0) throw new Error('empty')
    return data
  } finally {
    clearTimeout(timeoutHandle)
  }
}

const RETRY_DELAY_MS = 600

/**
 * Comme fetchGameContent, mais retente une fois (après un court délai) en cas
 * d'échec (réseau, timeout, statut, réponse vide) avant d'abandonner —
 * évite d'annuler toute la partie pour un simple raté ponctuel du webhook.
 */
export async function fetchGameContentRetrying(game, count, extra = {}, attempts = 2) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchGameContent(game, count, extra)
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }
  throw lastErr
}
