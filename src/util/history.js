const HISTORY_KEY = 'romet:history'
const MAX_ENTRIES = 10

export function getHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    const data = raw ? JSON.parse(raw) : []
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

export function saveHistoryEntry(entry) {
  try {
    const history = getHistory()
    history.unshift(entry)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_ENTRIES)))
  } catch {
    // localStorage indisponible/quota dépassé — pas grave
  }
}
