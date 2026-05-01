import { BaseAdoPrProvider } from './baseAdoPrProvider';
import { OrgConfig } from './configParser';

/**
 * DevDocket provider that discovers Azure DevOps pull requests where the
 * current user is listed as a reviewer.
 */
export class AdoPrReviewProvider extends BaseAdoPrProvider {
  readonly id = 'ado-pr-reviews';
  readonly label = 'Azure DevOps PR Reviews';

  protected readonly searchCriteriaParam = 'reviewerId' as const;
  protected readonly itemReason = 'review_requested';
  protected readonly logLabel = 'PR reviews';

  constructor(orgConfigs: OrgConfig[]) {
    super(orgConfigs);
  }
}
