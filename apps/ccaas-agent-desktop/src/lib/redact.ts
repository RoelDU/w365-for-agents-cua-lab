/** Remove token-like text (JWTs and "Bearer ..." values) before anything is shown or stored. */
const SECRET = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*|\bBearer\s+\S+/gi;

export function redactSecrets(text: string): string {
  return text.replace(SECRET, "[redacted]");
}
