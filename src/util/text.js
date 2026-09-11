const COMBINING_MARKS_START = 0x0300
const COMBINING_MARKS_END = 0x036f

export function normalizeGuess(str) {
  return Array.from(str.normalize('NFD'))
    .filter((ch) => {
      const code = ch.codePointAt(0)
      return code < COMBINING_MARKS_START || code > COMBINING_MARKS_END
    })
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim()
}
