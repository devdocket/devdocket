import { isValidUrlSegment } from '@devdocket/shared';
import { logger } from './logger';

/**
 * Describes a single ADO organization and which projects to monitor within it.
 * An empty `projects` array means monitor the entire organization.
 */
export interface OrgConfig {
  org: string;
  projects: string[];
}

/**
 * Parses the `devdocketAdo.projects` setting into a list of per-organization
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

/**
 * Returns the effective project list for an org config after validating
 * individual project name segments.
 *
 * - Projects that fail URL-segment validation are skipped with a warning.
 * - Returns `null` when projects were explicitly configured but every one
 *   is invalid — the caller should skip this org entirely.
 * - Returns `['']` when no projects are configured (whole-org monitoring).
 * - Returns the filtered valid project list otherwise.
 *
 * @param orgConfig - The org configuration to validate.
 * @param logLabel  - A short label used in the "skipping …" log message,
 *                    e.g. `'fetch'` or `'PR fetch'`.
 */
export function resolveProjectList(orgConfig: OrgConfig, logLabel: string): string[] | null {
  const validProjects: string[] = [];
  for (const project of orgConfig.projects) {
    if (project === '' || isValidUrlSegment(project)) {
      validProjects.push(project);
    } else {
      logger.warn('Skipping invalid ADO project name', project);
    }
  }

  if (orgConfig.projects.length > 0 && validProjects.length === 0) {
    logger.warn(`All configured ADO projects are invalid for org ${orgConfig.org} — skipping ${logLabel}`);
    return null;
  }

  return validProjects.length > 0 ? validProjects : [''];
}
