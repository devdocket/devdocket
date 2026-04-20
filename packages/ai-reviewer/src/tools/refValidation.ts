/** Strict allowlist for git ref names interpolated into commands and LLM prompts. */
const SAFE_REF = /^[a-zA-Z0-9._\/-]+$/;

/** Returns true if the ref contains only safe characters for git refs. */
export function isValidRef(ref: string): boolean {
  return !!ref && SAFE_REF.test(ref);
}
