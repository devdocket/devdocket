# Connect a Provider

Providers automatically discover work items from external sources and surface them in the **Incoming** tier of the **DevDocket** sidebar.

## Sample Providers

### GitHub Provider
Discovers:
- Issues assigned to you
- Issues and PRs that mention you
- Pull requests you authored, are assigned to, or have been requested to review

Each item shows badges in the editor for upstream state (Open / Closed) and PR review status (Approved / Changes requested / etc.) so you can prioritize at a glance.

**Setup:**
1. Install the **DevDocket GitHub** extension (if not already installed)
2. Authenticate with GitHub when prompted
3. Configure which repositories to watch via settings

### Azure DevOps Provider
Discovers:
- Work items assigned to you
- Pull requests you need to review
- Pull requests you authored

**Setup:**
1. Install the **DevDocket Azure DevOps** extension
2. Configure your organization and project
3. Authenticate when prompted

---

**Tip:** Once a provider is connected, browse everything it knows about under the **Sources** tab of the DevDocket sidebar — even items that haven't surfaced in your Incoming tier yet.

[Open Extensions](command:workbench.view.extensions)
