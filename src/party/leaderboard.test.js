import { describe, it, expect } from 'vitest'
import { applyRankings } from './leaderboard.js'

const players = [
  { peerId: 'a', nickname: 'Alice', avatar: { emoji: '🦄', color: '#fff' } },
  { peerId: 'b', nickname: 'Bob', avatar: { emoji: '🐱', color: '#000' } },
  { peerId: 'c', nickname: 'Carla', avatar: { emoji: '🐶', color: '#f00' } },
]

describe('applyRankings', () => {
  it('awards points by rank on an empty leaderboard', () => {
    const standings = applyRankings([], ['a', 'b', 'c'], players)
    expect(standings).toEqual([
      { peerId: 'a', nickname: 'Alice', avatar: players[0].avatar, points: 10 },
      { peerId: 'b', nickname: 'Bob', avatar: players[1].avatar, points: 8 },
      { peerId: 'c', nickname: 'Carla', avatar: players[2].avatar, points: 6 },
    ])
  })

  it('accumulates points across multiple rounds and keeps sort order', () => {
    let standings = applyRankings([], ['a', 'b'], players)
    standings = applyRankings(standings, ['b', 'a'], players)
    expect(standings[0]).toMatchObject({ peerId: 'a', points: 18 })
    expect(standings[1]).toMatchObject({ peerId: 'b', points: 18 })
  })

  it('gives 1 point fallback beyond the 5th rank', () => {
    const many = [
      { peerId: '1' }, { peerId: '2' }, { peerId: '3' },
      { peerId: '4' }, { peerId: '5' }, { peerId: '6' }, { peerId: '7' },
    ]
    const rankedIds = many.map((p) => p.peerId)
    const infoPlayers = many.map((p) => ({ peerId: p.peerId, nickname: p.peerId, avatar: null }))
    const standings = applyRankings([], rankedIds, infoPlayers)
    const byId = Object.fromEntries(standings.map((s) => [s.peerId, s.points]))
    expect(byId['1']).toBe(10)
    expect(byId['5']).toBe(2)
    expect(byId['6']).toBe(1)
    expect(byId['7']).toBe(1)
  })

  it('updates the nickname if it changed since the last round', () => {
    let standings = applyRankings([], ['a'], players)
    const renamed = [{ ...players[0], nickname: 'Alice2' }]
    standings = applyRankings(standings, ['a'], renamed)
    expect(standings[0].nickname).toBe('Alice2')
  })
})
