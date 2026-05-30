import { describe, it, expect } from 'vitest';
import {
  CONTRACT_VERSION,
  compareContractVersions,
  isContractVersionSatisfied,
} from '../contractVersion';

describe('CONTRACT_VERSION', () => {
  it('is exposed as a semver string', () => {
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+(?:[-+].*)?$/);
  });
});

describe('compareContractVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareContractVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareContractVersions('1.0.0', '2.0.0')).toBeLessThan(0);
    expect(compareContractVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareContractVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareContractVersions('1.2.3', '1.2.4')).toBeLessThan(0);
  });

  it('ignores pre-release and build metadata suffixes', () => {
    expect(compareContractVersions('1.2.3-beta.1', '1.2.3')).toBe(0);
    expect(compareContractVersions('1.2.3+build.5', '1.2.3')).toBe(0);
  });

  it('returns NaN for unparseable inputs', () => {
    expect(Number.isNaN(compareContractVersions('not-a-version', '1.0.0'))).toBe(true);
    expect(Number.isNaN(compareContractVersions('1.0.0', 'x.y.z'))).toBe(true);
  });
});

describe('isContractVersionSatisfied', () => {
  it('is true when current >= required', () => {
    expect(isContractVersionSatisfied('1.0.0', '1.0.0')).toBe(true);
    expect(isContractVersionSatisfied('1.2.0', '1.1.0')).toBe(true);
    expect(isContractVersionSatisfied('2.0.0', '1.99.99')).toBe(true);
  });

  it('is false when current < required', () => {
    expect(isContractVersionSatisfied('1.0.0', '1.0.1')).toBe(false);
    expect(isContractVersionSatisfied('1.0.0', '2.0.0')).toBe(false);
  });

  it('is false when either version is unparseable', () => {
    expect(isContractVersionSatisfied('garbage', '1.0.0')).toBe(false);
    expect(isContractVersionSatisfied('1.0.0', 'garbage')).toBe(false);
  });
});
