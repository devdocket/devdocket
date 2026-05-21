import { postMessage } from '../../shared/messaging';

interface OnboardingEmptyStateProps {
  description: string;
  titleId: string;
}

export function OnboardingEmptyState({ description, titleId }: OnboardingEmptyStateProps) {
  return (
    <section class="onboarding-empty-state" aria-labelledby={titleId}>
      <h2 id={titleId} class="onboarding-empty-state-title">Nothing here yet.</h2>
      <p class="onboarding-empty-state-description">{description}</p>
      <div class="onboarding-empty-state-actions">
        <button
          type="button"
          class="onboarding-empty-state-button"
          onClick={() => postMessage({ type: 'createItem' })}
        >
          Create Work Item
        </button>
        <button
          type="button"
          class="onboarding-empty-state-button onboarding-empty-state-button-secondary"
          onClick={() => postMessage({ type: 'browseProviderExtensions' })}
        >
          Browse Provider Extensions
        </button>
        <button
          type="button"
          class="onboarding-empty-state-button onboarding-empty-state-button-secondary"
          onClick={() => postMessage({ type: 'openWalkthrough' })}
        >
          Open Walkthrough
        </button>
      </div>
    </section>
  );
}
