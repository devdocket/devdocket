/**
 * Versioning for the DevDocket extension API contract.
 *
 * Third-party provider/action extensions can declare a minimum contract
 * version via {@link DevDocketProvider.minContractVersion} or
 * {@link DevDocketAction.minContractVersion}. The core extension exposes
 * its implemented contract version via {@link DevDocketApi.contractVersion}.
 *
 * Bump rules (semver):
 * - patch: internal fixes that do not change the contract.
 * - minor: additive changes (new optional fields, new methods).
 * - major: breaking changes (removed/renamed members, required parameters).
 *
 * See `.github/instructions/api-surface.instructions.md`.
 *
 * @module
 */

/**
 * The current DevDocket extension API contract version.
 *
 * Exposed at runtime as {@link DevDocketApi.contractVersion} so provider
 * extensions can perform compatibility checks before calling optional APIs.
 */
export const CONTRACT_VERSION = '1.0.0';

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * Compare two semver-shaped version strings (`major.minor.patch`).
 *
 * Pre-release / build metadata suffixes are ignored. Returns a negative
 * number when `a < b`, zero when equal, positive when `a > b`. If either
 * input cannot be parsed, returns `NaN`.
 */
export function compareContractVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) {
    return Number.NaN;
  }
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

/**
 * Returns `true` if `current` satisfies `required` — i.e. `current >= required`.
 *
 * Treats an unparseable `required` as not satisfied (defensive default).
 * An unparseable `current` is also treated as not satisfied.
 */
export function isContractVersionSatisfied(current: string, required: string): boolean {
  const cmp = compareContractVersions(current, required);
  if (Number.isNaN(cmp)) {
    return false;
  }
  return cmp >= 0;
}
