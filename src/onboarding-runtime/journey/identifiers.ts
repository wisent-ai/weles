// The shapes every identifier in a journey bundle, progress record or event has to take.
export const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/
export const SHA256 = /^[0-9a-f]{64}$/
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
