// Extension: fix-issue
// Enforces the issue-fixing workflow: worktree creation, build, test, PR.
// Injects workflow guidance via additionalContext and blocks writes to the
// main working tree via onPreToolUse.

import { joinSession } from "@github/copilot-sdk/extension";
import { execSync } from "node:child_process";

// Extracts all issue references: #N, issue N, issue #N, or GitHub issue URLs
const ISSUE_REF_PATTERN =
    /(?:(?:issue\s+#?|#)(\d+)|github\.com\/[^/]+\/[^/]+\/issues\/(\d+))/gi;

// Matches an action verb that signals fix intent
const FIX_INTENT_PATTERN =
    /\b(?:fix|resolve|address|close|implement|work\s+on|tackle)\b/i;

let isFixingIssue = false;
let mainTreePath = null;
let defaultBranch = null;

function getDefaultBranch(cwd) {
    if (defaultBranch) return defaultBranch;
    try {
        // Check for dev first (this repo's convention), then fall back to main
        const branches = execSync("git branch --list dev main", { cwd, encoding: "utf8" }).trim();
        if (branches.includes("dev")) {
            defaultBranch = "dev";
        } else if (branches.includes("main")) {
            defaultBranch = "main";
        } else {
            defaultBranch = "dev";
        }
    } catch {
        defaultBranch = "dev";
    }
    return defaultBranch;
}

function normalizePath(p) {
    return p.replace(/\\/g, "/").toLowerCase();
}

function isUnderMainTree(filePath) {
    if (!mainTreePath) return false;
    const norm = normalizePath(filePath);
    const main = normalizePath(mainTreePath);
    return norm.startsWith(main + "/") || norm === main;
}

/** Extract all unique issue numbers from a prompt. */
function extractIssueNumbers(prompt) {
    const numbers = new Set();
    let match;
    // Reset lastIndex since the regex has the global flag
    ISSUE_REF_PATTERN.lastIndex = 0;
    while ((match = ISSUE_REF_PATTERN.exec(prompt)) !== null) {
        numbers.add(match[1] || match[2]);
    }
    return [...numbers];
}

function buildSingleIssueWorkflow(issueNumber, branch) {
    return `## Fix-Issue Workflow — MANDATORY

Follow these steps IN ORDER when fixing issue #${issueNumber}.
Do NOT skip any step. Do NOT modify files in the main working tree.

### Step 1: Read the issue
\`\`\`
gh issue view ${issueNumber} --repo devdocket/devdocket --comments
\`\`\`
Read BOTH the body AND all comments — comments often contain updated requirements.

### Step 2: Create a worktree and feature branch
\`\`\`
git worktree add ../devdocket-<slug>-${issueNumber} -b <slug>-${issueNumber} ${branch}
\`\`\`
Replace \`<slug>\` with a short kebab-case description of the fix.
Then \`cd\` into the worktree. ALL subsequent work happens there.

### Step 3: Install dependencies
Run \`npm install\` in the worktree root.

### Step 4: Read instruction files
Check if any \`.github/instructions/*.instructions.md\` files match the files you will modify. Read them before making changes.

### Step 5: Implement the fix
Explore, understand, and implement in the worktree.
Build: \`npm run build\`
Test: \`npm run test\`

### Step 6: Commit
Write a descriptive commit message. Do NOT include the issue number in the commit message.

### Step 7: Create PR
Invoke the \`create-pr\` skill to open a PR. The PR description must reference \`Closes #${issueNumber}\`.`;
}

function buildBatchWorkflow(issueNumbers, branch) {
    const issueList = issueNumbers.map((n) => `#${n}`).join(", ");
    const perIssueSteps = issueNumbers
        .map(
            (n, i) => `
### Issue #${n} (${i + 1} of ${issueNumbers.length})

1. Read the issue: \`gh issue view ${n} --repo devdocket/devdocket --comments\`
2. Create its worktree: \`git worktree add ../devdocket-<slug>-${n} -b <slug>-${n} ${branch}\`
3. Install dependencies: \`cd ../devdocket-<slug>-${n} && npm install\`
4. Read applicable \`.github/instructions/*.instructions.md\` files
5. Implement, build (\`npm run build\`), and test (\`npm run test\`) in the worktree
6. Commit (do NOT include the issue number in the commit message)
7. Create PR via the \`create-pr\` skill (description must reference \`Closes #${n}\`)`,
        )
        .join("\n");

    return `## Batch Fix-Issue Workflow — MANDATORY

Fixing ${issueNumbers.length} issues: ${issueList}.
Each issue gets its own worktree and PR. Do NOT modify files in the main working tree.

**Process each issue independently, one at a time.** Complete the full cycle
(worktree → implement → test → PR) for one issue before starting the next.
Replace \`<slug>\` with a short kebab-case description of each fix.
${perIssueSteps}`;
}

const session = await joinSession({
    hooks: {
        onUserPromptSubmitted: async (input) => {
            mainTreePath = input.cwd;

            const hasFix = FIX_INTENT_PATTERN.test(input.prompt);
            const issueNumbers = hasFix ? extractIssueNumbers(input.prompt) : [];

            // Reset when user moves on to a non-fix task
            isFixingIssue = hasFix && issueNumbers.length > 0;

            if (!isFixingIssue) return;

            const branch = getDefaultBranch(input.cwd);
            const workflow =
                issueNumbers.length === 1
                    ? buildSingleIssueWorkflow(issueNumbers[0], branch)
                    : buildBatchWorkflow(issueNumbers, branch);

            return { additionalContext: workflow };
        },

        onPreToolUse: async (input) => {
            if (!isFixingIssue) return;
            if (input.toolName !== "edit" && input.toolName !== "create") return;

            const filePath = input.toolArgs?.path;
            if (!filePath) return;

            if (isUnderMainTree(filePath)) {
                return {
                    permissionDecision: "deny",
                    permissionDecisionReason:
                        `Blocked: You are fixing an issue but trying to modify a file ` +
                        `in the main working tree (${mainTreePath}). ` +
                        `Create a worktree first, then make all changes there.`,
                };
            }
        },
    },
});
