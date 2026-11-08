export class ChainError extends Error {
  constructor(code, message, extra) {
    super(message)
    this.name = 'ChainError'
    this.code = code
    this.extra = extra
  }
}

export function fail(code, message, extra) {
  throw new ChainError(code, message, extra)
}
