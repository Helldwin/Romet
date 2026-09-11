// Historique du contenu déjà servi, persisté d'une soirée à l'autre (localStorage) pour
// réduire encore les répétitions au-delà de la seule session en cours (cf. usedContentKeys
// dans party.js, qui ne couvre que la soirée courante). Volontairement simple (liste de
// chaînes bornée) plutôt qu'IndexedDB — largement suffisant pour ce volume de données.
const STORAGE_KEY = 'romet:content-history'
const MAX_PER_GAME = 500

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function writeAll(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    // stockage indisponible (quota, navigation privée...) — tant pis, pas bloquant
  }
}

export function getPersistedKeys(gameId) {
  return readAll()[gameId] ?? []
}

export function addPersistedKeys(gameId, keys) {
  if (!keys.length) return
  const data = readAll()
  const existing = new Set(data[gameId] ?? [])
  for (const k of keys) existing.add(k)
  data[gameId] = [...existing].slice(-MAX_PER_GAME)
  writeAll(data)
}
