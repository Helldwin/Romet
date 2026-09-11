const WEBHOOK_URL = 'https://n8n.matiboux.com/webhook/Romet/Games'
const FETCH_TIMEOUT_MS = 8000
const HEALTH_CHECK_TIMEOUT_MS = 5000
const CACHE_KEY_PREFIX = 'romet:cache:'

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
