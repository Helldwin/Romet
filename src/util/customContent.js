// Parseurs du contenu perso que l'hôte peut ajouter à la création de la soirée
// (cf. lobby.js, carte "Créer une partie"). Format volontairement simple, une entrée
// par ligne, tolérant aux espaces superflus ; toute ligne invalide est ignorée.

export function parseCustomQuiz(text) {
  return (text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [question, choicesRaw, answer] = line.split('|').map((s) => s?.trim())
      if (!question || !choicesRaw || !answer) return null
      const choices = choicesRaw
        .split(';')
        .map((c) => c.trim())
        .filter(Boolean)
      if (choices.length < 2 || !choices.includes(answer)) return null
      return { text: question, choices, answer }
    })
    .filter(Boolean)
}

export function parseCustomDraw(text) {
  return (text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((word) => ({ word }))
}

function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function parseCustomGuess(text) {
  return (text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [answer, imageUrl, category, genre] = line.split('|').map((s) => s?.trim())
      if (!answer || !imageUrl || !isHttpUrl(imageUrl)) return null
      return { answer, imageUrl, category: category || undefined, genre: genre || undefined }
    })
    .filter(Boolean)
}
