import { describe, it, expect } from 'vitest'
import { normalizeGuess } from './text.js'

describe('normalizeGuess', () => {
  it('lowercases and trims', () => {
    expect(normalizeGuess('  Paris  ')).toBe('paris')
  })

  it('strips accents', () => {
    expect(normalizeGuess('Éléphant')).toBe('elephant')
  })

  it('strips punctuation and spaces', () => {
    expect(normalizeGuess("L'Écureuil, roux !")).toBe('lecureuilroux')
  })

  it('treats accented and unaccented forms as equal', () => {
    expect(normalizeGuess('Chateau')).toBe(normalizeGuess('Château'))
  })

  it('returns empty string for empty input', () => {
    expect(normalizeGuess('')).toBe('')
  })
})
