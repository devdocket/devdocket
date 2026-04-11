import { describe, it, expect } from 'vitest';
import { parseAdoProjectsConfig, type OrgConfig } from '../configParser';

describe('parseAdoProjectsConfig', () => {
  describe('legacy backward compatibility', () => {
    it('treats plain project names as projects under legacyOrganization', () => {
      const result = parseAdoProjectsConfig(['ProjectA', 'ProjectB'], 'myorg');
      expect(result).toEqual([
        { org: 'myorg', projects: ['ProjectA', 'ProjectB'] },
      ] satisfies OrgConfig[]);
    });

    it('returns whole-org config when projects is empty and legacyOrganization is set', () => {
      const result = parseAdoProjectsConfig([], 'myorg');
      expect(result).toEqual([
        { org: 'myorg', projects: [] },
      ] satisfies OrgConfig[]);
    });

    it('preserves single project under legacy org', () => {
      const result = parseAdoProjectsConfig(['OnlyProject'], 'myorg');
      expect(result).toEqual([
        { org: 'myorg', projects: ['OnlyProject'] },
      ] satisfies OrgConfig[]);
    });

    it('trims whitespace-only legacy org to empty (no providers)', () => {
      const result = parseAdoProjectsConfig([], '   ');
      expect(result).toEqual([] satisfies OrgConfig[]);
    });

    it('trims whitespace from legacy org value', () => {
      const result = parseAdoProjectsConfig(['Proj'], '  myorg  ');
      expect(result).toEqual([
        { org: 'myorg', projects: ['Proj'] },
      ] satisfies OrgConfig[]);
    });
  });

  describe('new format parsing', () => {
    it('parses org/project entries into grouped configs', () => {
      const result = parseAdoProjectsConfig(['orgA/Proj1', 'orgA/Proj2', 'orgB/Proj3'], '');
      expect(result).toEqual([
        { org: 'orgA', projects: ['Proj1', 'Proj2'] },
        { org: 'orgB', projects: ['Proj3'] },
      ] satisfies OrgConfig[]);
    });

    it('parses org-only entries as whole-org monitoring', () => {
      const result = parseAdoProjectsConfig(['myorg'], '');
      expect(result).toEqual([
        { org: 'myorg', projects: [] },
      ] satisfies OrgConfig[]);
    });

    it('handles mix of org-only and org/project entries', () => {
      const result = parseAdoProjectsConfig(['orgA', 'orgB/Proj1'], '');
      expect(result).toEqual([
        { org: 'orgA', projects: [] },
        { org: 'orgB', projects: ['Proj1'] },
      ] satisfies OrgConfig[]);
    });

    it('org-only entry overrides specific projects for the same org', () => {
      const result = parseAdoProjectsConfig(['myorg/Proj1', 'myorg'], '');
      expect(result).toEqual([
        { org: 'myorg', projects: [] },
      ] satisfies OrgConfig[]);
    });

    it('org-only entry before specific projects still monitors whole org', () => {
      const result = parseAdoProjectsConfig(['myorg', 'myorg/Proj1'], '');
      expect(result).toEqual([
        { org: 'myorg', projects: [] },
      ] satisfies OrgConfig[]);
    });
  });

  describe('new format with legacy org set', () => {
    it('uses new format when any entry contains a slash', () => {
      const result = parseAdoProjectsConfig(['orgA/Proj1'], 'legacyOrg');
      expect(result).toEqual([
        { org: 'orgA', projects: ['Proj1'] },
      ] satisfies OrgConfig[]);
    });

    it('treats plain entries as org-only when mixed with slash entries', () => {
      const result = parseAdoProjectsConfig(['orgA', 'orgB/Proj1'], 'legacyOrg');
      expect(result).toEqual([
        { org: 'orgA', projects: [] },
        { org: 'orgB', projects: ['Proj1'] },
      ] satisfies OrgConfig[]);
    });
  });

  describe('edge cases', () => {
    it('returns empty array when both projects and org are empty', () => {
      const result = parseAdoProjectsConfig([], '');
      expect(result).toEqual([] satisfies OrgConfig[]);
    });

    it('skips empty string entries', () => {
      const result = parseAdoProjectsConfig(['', 'orgA/Proj1', ''], '');
      expect(result).toEqual([
        { org: 'orgA', projects: ['Proj1'] },
      ] satisfies OrgConfig[]);
    });

    it('skips whitespace-only entries', () => {
      const result = parseAdoProjectsConfig(['   ', 'orgA/Proj1'], '');
      expect(result).toEqual([
        { org: 'orgA', projects: ['Proj1'] },
      ] satisfies OrgConfig[]);
    });

    it('trims whitespace from entries', () => {
      const result = parseAdoProjectsConfig(['  orgA/Proj1  '], '');
      expect(result).toEqual([
        { org: 'orgA', projects: ['Proj1'] },
      ] satisfies OrgConfig[]);
    });

    it('skips malformed entry with only slash', () => {
      const result = parseAdoProjectsConfig(['/'], '');
      expect(result).toEqual([] satisfies OrgConfig[]);
    });

    it('skips entry with trailing slash (no project)', () => {
      const result = parseAdoProjectsConfig(['org/'], '');
      expect(result).toEqual([] satisfies OrgConfig[]);
    });

    it('skips entry with leading slash (no org)', () => {
      const result = parseAdoProjectsConfig(['/project'], '');
      expect(result).toEqual([] satisfies OrgConfig[]);
    });

    it('malformed slash-only entry does not disable legacy fallback', () => {
      const result = parseAdoProjectsConfig(['ProjectA', '/'], 'myorg');
      // '/' is not a valid new-format entry, so legacy mode applies.
      // The '/' passes through as a project name; downstream validation handles it.
      expect(result).toEqual([
        { org: 'myorg', projects: ['ProjectA', '/'] },
      ] satisfies OrgConfig[]);
    });

    it('trims org and project parts after splitting', () => {
      const result = parseAdoProjectsConfig(['org / proj'], '');
      expect(result).toEqual([
        { org: 'org', projects: ['proj'] },
      ] satisfies OrgConfig[]);
    });

    it('handles entry with multiple slashes (first slash splits)', () => {
      const result = parseAdoProjectsConfig(['org/proj/extra'], '');
      expect(result).toEqual([
        { org: 'org', projects: ['proj/extra'] },
      ] satisfies OrgConfig[]);
    });

    it('deduplicates projects within the same org', () => {
      const result = parseAdoProjectsConfig(['org/Proj', 'org/Proj'], '');
      expect(result).toEqual([
        { org: 'org', projects: ['Proj'] },
      ] satisfies OrgConfig[]);
    });
  });
});
