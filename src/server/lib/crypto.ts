import crypto from 'node:crypto'
import { config } from '../config.js'

const ALGO = 'aes-256-gcm'

/** Encrypts a JSON-serialisable value with AES-256-GCM. Output: base64(iv | tag | ciphertext). */
export function encrypt(value: unknown): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, config.encryptionKey, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
}

export function decrypt<T>(payload: string): T {
  const buf = Buffer.from(payload, 'base64')
  const decipher = crypto.createDecipheriv(ALGO, config.encryptionKey, buf.subarray(0, 12))
  decipher.setAuthTag(buf.subarray(12, 28))
  const plaintext = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()])
  return JSON.parse(plaintext.toString('utf8')) as T
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url')
}

/** Separate key for cookie signing, derived so a single secret is enough to configure. */
export const cookieSecret = Buffer.from(crypto.hkdfSync('sha256', config.encryptionKey, Buffer.alloc(0), 'skyload-cookies', 32)).toString('base64')

/** PKCE S256 challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}
