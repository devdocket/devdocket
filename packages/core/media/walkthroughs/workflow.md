# Understanding the DevDocket Workflow

The **DevDocket** sidebar is your unified work hub. It has two tabs:

## My Work

Your active workflow, organized into tiers. The tiers appear in this order so the most actionable work stays near the top.

### ↓ Incoming
New items discovered by providers (GitHub issues, pull requests, ADO work items, etc.). Click an item to preview it without committing, then **Accept** to move it to **Ready to Start**, **Start** to send it directly to **In Progress**, or **Dismiss** if it's not relevant. A blue dot marks items you haven't seen yet.

### ▶ In Progress
What you're actively working on (the **In Progress** state). Drag to reorder. Hover actions let you **✓ Complete** or **⏸ Pause**.

### ○ Ready to Start
Your personal backlog of items waiting to be picked up. Items here are in the **New** state. Drag to reorder by priority. Hover actions let you **▶ Start** (move into In Progress) or **⏸ Pause** (set aside without starting).

### ⏸ Paused
Items you've temporarily set aside. Hover **▶ Resume** to bring one back — it returns to whichever tier it was paused from (In Progress or Ready to Start).

### ✓ Done
Completed items. Hover **↩ Requeue** to move something back to Ready to Start, or use the **Clear** action in the header to clean things up.

## Sources

A browsable library of everything providers know about, grouped by provider and sub-group (typically by repo). Click an item to preview it and accept it into your workflow.

## CI Watches (separate panel)

A floating panel that monitors GitHub Actions and Azure DevOps Pipelines runs and pull request status. Open it from the **Watches** status-bar item in the bottom bar — click the eye icon next to the watch count.

---

**The typical lifecycle of an item:**

1. A provider discovers an item → appears in **Incoming**
2. You triage it → moves to **Ready to Start** (or directly to **In Progress** with the Start action)
3. You begin work → moves to **In Progress**
4. (optional) You set it aside temporarily → moves to **Paused**
5. You finish → moves to **Done**

You can also create manual items via the **+** button — they go straight to **Ready to Start**.
