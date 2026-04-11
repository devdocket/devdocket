/**
 * Describes a single ADO organization and which projects to monitor within it.
 * An empty `projects` array means monitor the entire organization.
 */
export interface OrgConfig {
  org: string;
  projects: string[];
}

/**
 * Parses the `workcenterAdo.projects` and (deprecated) `workcenterAdo.organization`
 * settings into a list of per-organization configurations.
 *
 * New-format entries in `projects`:
 *   - `<org>` — monitor an entire organization
 *   - `<org>/<project>` — monitor a specific project
 *
 * Legacy backward compatibility: if no entry in `projects` contains `/` and
 * `legacyOrganization` is non-empty, entries are treated as project names
 * under that organization.
 */
export function parseAdoProjectsConfig(
  projects: string[],
  legacyOrganization: string,
): OrgConfig[] {
  const hasNewFormatEntry = projects.some(p => p.includes('/'));

  // Legacy mode: no entry contains '/' and the deprecated org setting is present
  if (!hasNewFormatEntry && legacyOrganization) {
    return [{ org: legacyOrganization, projects: projects.map(p => p.trim()).filter(Boolean) }];
  }

  // Nothing to monitor
  if (projects.length === 0) {
    return [];
  }

  // New format parsing
  const orgMap = new Map<string, { projects: string[]; wholeOrg: boolean }>();

  for (const entry of projects) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }

    const slashIndex = trimmed.indexOf('/');
    if (slashIndex === -1) {
      // Org-only entry: monitor entire organization
      const existing = orgMap.get(trimmed);
      if (existing) {
        existing.wholeOrg = true;
      } else {
        orgMap.set(trimmed, { projects: [], wholeOrg: true });
      }
    } else {
      const org = trimmed.substring(0, slashIndex);
      const project = trimmed.substring(slashIndex + 1);
      if (!org || !project) {
        continue; // skip malformed entries like "/", "org/", or "/project"
      }

      const existing = orgMap.get(org);
      if (existing) {
        if (!existing.wholeOrg && !existing.projects.includes(project)) {
          existing.projects.push(project);
        }
      } else {
        orgMap.set(org, { projects: [project], wholeOrg: false });
      }
    }
  }

  return [...orgMap.entries()].map(([org, config]) => ({
    org,
    projects: config.wholeOrg ? [] : config.projects,
  }));
}
