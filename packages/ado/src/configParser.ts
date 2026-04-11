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
 * Legacy backward compatibility: if `projects` contains no valid
 * `<org>/<project>` entries and `legacyOrganization` is non-empty, entries are
 * treated as project names under that organization. Malformed entries
 * such as `/`, `org/`, `/project`, and multi-slash entries like `org/proj/extra`
 * are ignored when determining whether to use legacy mode.
 */
export function parseAdoProjectsConfig(
  projects: string[],
  legacyOrganization: string,
): OrgConfig[] {
  const trimmedLegacyOrg = legacyOrganization.trim();

  // Determine whether entries use new org/project format by checking for
  // valid slash-separated entries (exactly one slash with non-empty parts)
  const hasNewFormatEntry = projects.some(p => {
    const t = p.trim();
    const idx = t.indexOf('/');
    return idx > 0 && idx < t.length - 1 && t.lastIndexOf('/') === idx;
  });

  // Legacy mode: no entry contains a valid '/' and the deprecated org setting is present
  if (!hasNewFormatEntry && trimmedLegacyOrg) {
    return [{ org: trimmedLegacyOrg, projects: [...new Set(projects.map(p => p.trim()).filter(Boolean))] }];
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
