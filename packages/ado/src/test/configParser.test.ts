import { describe, it, expect } from 'vitest';
import { parseAdoProjectsConfig, OrgConfig } from '../configParser';

describe('parseAdoProjectsConfig', () => {
  describe('legacy backward compatibility', () => {
    it('treats plain project names as projects under legacyOrganization', () => {
      const result = parseAdoProjectsConfig(['ProjectA', 'ProjectB'], 'myorg');
      expect(result).toEqual<OrgConfig[]>([
        { org: 'myorg', projects: ['ProjectA', 'ProjectB'] },
      ]);
    });

    it('returns whole-org config when projects is empty and legacyOrganization is set', () => {
      const result = parseAdoProjectsConfig([], 'myorg');
      expect(result).toEqual<OrgConfig[]>([
        { org: 'myorg', projects: [] },
      ]);
    });

    it('preserves single project under legacy org', () => {
      const result = parseAdoProjectsConfig(['OnlyProject'], 'myorg');
      expect(result).toEqual<OrgConfig[]>([
        { org: 'myorg', projects: ['OnlyProject'] },
      ]);
    });
  });

  describe('new format parsing', () => {
    it('parses org/project entries into grouped configs', () => {
      const result = parseAdoProjectsConfig(['orgA/Proj1', 'orgA/Proj2', 'orgB/Proj3'], '');
      expect(result).toEqual<OrgConfig[]>([
        { org: 'orgA', projects: ['Proj1', 'Proj2'] },
        { org: 'orgB', projects: ['Proj3'] },
      ]);
    });

    it('parses org-only entries as whole-org monitoring', () => {
      const result = parseAdoProjectsConfig(['myorg'], '');
      expect(result).toEqual<OrgConfig[]>([
        { org: 'myorg', projects: [] },
      ]);
    });

    it('handles mix of org-only and org/project entries', () => {
      const result = parseAdoProjectsConfig(['orgA', 'orgB/Proj1'], '');
      expect(result).toEqual<OrgConfig[]>([
        { org: 'orgA', projects: [] },
        { org: 'orgB', projects: ['Proj1'] },
      ]);
    });

    it('org-only entry overrides specific projects for the same org', () => {
      const result = parseAdoProjectsConfig(['myorg/Proj1', 'myorg'], '');
      expect(result).toEqual<OrgConfig[]>([
        { org: 'myorg', projects: [] },
      ]);
    });

    it('org-only entry before specific projects still monitors whole org', () => {
      const result = parseAdoProjectsConfig(['myorg', 'myorg/Proj1'], '');
      expect(result).toEqual<OrgConfig[]>([
        { org: 'myorg', projects: [] },
      ]);
    });
  });

  describe('new format with legacy org set', () => {
    it('uses new format when any entry contains a slash', () => {
      const result = parseAdoProjectsConfig(['orgA/Proj1'], 'legacyOrg');
      expect(result).toEqual<OrgConfig[]>([
        { org: 'orgA', projects: ['Proj1'] },
      ]);
    });

    it('treats plain entries as org-only when mixed with slash entries', () => {
      const result = parseAdoProjectsConfig(['orgA', 'orgB/Proj1'], 'legacyOrg');
      expect(result).toEqual<OrgConfig[]>([
        { org: 'orgA', projects: [] },
        { org: 'orgB', projects: ['Proj1'] },
      ]);
    });
  });

  describe('edge cases', () => {
    it('returns empty array when both projects and org are empty', () => {
      const result = parseAdoProjectsConfig([], '');
      expect(result).toEqual<OrgConfig[]>([]);
    });

    it('skips empty string entries', () => {
      const result = parseAdoProjectsConfig(['', 'orgA/Proj1', ''], '');
      expect(result).toEqual<OrgConfig[]>([
        { org: 'orgA', projects: ['Proj1'] },
      ]);
    });

    it('skips whitespace-only entries', () => {
      const result = parseAdoProjectsConfig(['   ', 'orgA/Proj1'], '');
      expect(result).toEqual<OrgConfig[]>([
        { org: 'orgA', projects: ['Proj1'] },
      ]);
    });

    it('trims whitespace from entries', () => {
      const result = parseAdoProjectsConfig(['  orgA/Proj1  '], '');
      expect(result).toEqual<OrgConfig[]>([
        { org: 'orgA', projects: ['Proj1'] },
      ]);
    });

    it('skips malformed entry with only slash', () => {
      const result = parseAdoProjectsConfig(['/'], '');
      expect(result).toEqual<OrgConfig[]>([]);
    });

    it('skips entry with trailing slash (no project)', () => {
      const result = parseAdoProjectsConfig(['org/'], '');
      expect(result).toEqual<OrgConfig[]>([]);
    });

    it('skips entry with leading slash (no org)', () => {
      const result = parseAdoProjectsConfig(['/project'], '');
      expect(result).toEqual<OrgConfig[]>([]);
    });

    it('handles entry with multiple slashes (first slash splits)', () => {
      const result = parseAdoProjectsConfig(['org/proj/extra'], '');
      expect(result).toEqual<OrgConfig[]>([
        { org: 'org', projects: ['proj/extra'] },
      ]);
    });

    it('deduplicates projects within the same org', () => {
      const result = parseAdoProjectsConfig(['org/Proj', 'org/Proj'], '');
      expect(result).toEqual<OrgConfig[]>([
        { org: 'org', projects: ['Proj'] },
      ]);
    });
  });
});
