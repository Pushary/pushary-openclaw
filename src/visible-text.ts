const WINDOWS_LINE_BREAK = /\r\n/g
const HIDDEN_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F­؜᠎​-‏‪-‮⁠-⁩﻿\u{E0000}-\u{E007F}]/gu
const CODE_POINT_DIGITS = 4

const visibleCodeOf = (character: string): string =>
  `\\u{${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(CODE_POINT_DIGITS, '0')}}`

export const withHiddenCharactersShown = (text: string): string =>
  text.replace(WINDOWS_LINE_BREAK, '\n').replace(HIDDEN_CHARACTERS, visibleCodeOf)
