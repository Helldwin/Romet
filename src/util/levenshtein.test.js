import { describe, it, expect } from 'vitest'
import { levenshtein } from './levenshtein.js'

describe('levenshtein', () => {
  it('is 0 for identical strings', () => {
    expect(levenshtein('chat', 'chat')).toBe(0)
  })

  it('counts a single substitution', () => {
    expect(levenshtein('chat', 'chet')).toBe(1)
  })

  it('counts insertions/deletions', () => {
    expect(levenshtein('chat', 'chats')).toBe(1)
    expect(levenshtein('chats', 'chat')).toBe(1)
  })

  it('handles empty strings', () => {
    expect(levenshtein('', 'abc')).toBe(3)
    expect(levenshtein('abc', '')).toBe(3)
  })
})
