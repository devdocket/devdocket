/**
 * Describes a single ADO organization and which projects to monitor within it.
 * An empty `projects` array means monitor the entire organization.
 */
export interface OrgConfig {
  org: string;
  projects: string[];
}

/**
 * Parses the `workcenterAdo.projects` setting into a list of per-organization
 * configurations.
 *
 * Entries in `projects`:
 *   - `<org>` — monitor an entire organization
 *   - `<org>/<project>` — monitor a specific project
 *
 * Malformed entries such as `/`, `org/`, `/project`, and multi-slash entries
 * like `org/proj/extra` are silently skipped.
 */
export function parseAdoProjectsConfig(
  projects: string[],
): OrgConfig[] {
  if (projects.length === 0) {
    return [];
  }

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
      const org = trimmed.substring(0, slashIndex).trim();
      const project = trimmed.substring(slashIndex + 1).trim();
      if (!org || !project || project.includes('/')) {
        continue; // skip malformed entries like "/", "org/", "/project", or "org/proj/extra"
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
