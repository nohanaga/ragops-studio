/**
 * Compute a SHA-256 content hash for skill code.
 *
 * Uses the Web Crypto API (SubtleCrypto) which is available in all
 * modern browsers and returns a hex-encoded digest string.
 */
export async function computeCodeHash(code: string): Promise<string> {
  const data = new TextEncoder().encode(code)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}
