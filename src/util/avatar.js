export const AVATAR_COLORS = ['#FF6B6B', '#FFA94D', '#FFD43B', '#69DB7C', '#38D9A9', '#4DABF7', '#748FFC', '#DA77F2', '#F783AC']

export const AVATAR_EMOJIS = [
  '😀', '😎', '🤪', '🥳', '🦄', '🐱', '🐶', '🦊',
  '🐸', '🐼', '🦁', '🐵', '🐙', '🦖', '👻', '🤖',
]

export const DEFAULT_AVATAR = { emoji: AVATAR_EMOJIS[0], color: AVATAR_COLORS[0] }

export function avatarHtmlOf(avatar) {
  const { emoji, color } = avatar ?? DEFAULT_AVATAR
  return { emoji: emoji ?? DEFAULT_AVATAR.emoji, color: color ?? DEFAULT_AVATAR.color }
}
