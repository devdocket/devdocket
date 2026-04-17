# GitHub CLI — Backtick Safety

When posting **any** text to GitHub via `gh` CLI (PR descriptions, comments, review replies, issue comments), text containing backticks (`` ` ``) will be mangled by **both PowerShell and Python escape handling**. This applies to `--body`, `--fill`, `-f body=`, `gh pr comment`, `gh api`, etc.

## Required Pattern

1. Write the text to a file using the `create` tool (which has zero escape interpretation).
2. Pass the file to `gh` via `--body-file`.
3. Delete the temp file after.

## What NOT to Do

**Never** construct backtick-containing text inside Python strings, PowerShell strings, or inline shell arguments. The `create` tool is the only safe way to produce the file content.
