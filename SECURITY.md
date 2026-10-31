## Reporting a Vulnerability

If you believe you've discovered a security vulnerability, please contact the Valkey team at security@lists.valkey.io.
Please *DO NOT* create an issue.
We follow a responsible disclosure procedure, so depending on the severity of the issue we may notify Valkey vendors about the issue before releasing it publicly.
If you would like to be added to our list of vendors, please reach out to the Valkey team at maintainers@lists.valkey.io.

## What a deployment holds

The reviewer checks out and builds code from the pull requests it reviews, so the
review runtime is treated as running untrusted code. The design keeps credentials
away from it:

- The GitHub App private key and webhook secret are stored in AWS Secrets
  Manager. Only the webhook receiver, the token brokers and the ready-label
  Lambda (when a route sets `readyLabel`) can read them. The
  receiver verifies deliveries and acts as the App for permission checks,
  acknowledgement comments and reading pull requests. Its installation tokens
  ask for `pull_requests: write`, `issues: read` and `metadata: read` only, so
  they never carry `contents`. It never runs code from a pull request.
- Each reviewer has its own token broker. A review runtime asks its broker for a
  short-lived installation token limited to one of that reviewer's routed
  repositories, with `pull_requests: write` and `metadata: read`. The broker asks
  GitHub, as the App, for the App's installation on that repository and refuses
  the request unless it is the installation the runtime named, owned by the
  repository's owner. The runtime cannot read the App key, and cannot get tokens
  for repositories that are not routed to that reviewer. No reviewer token
  carries `contents` permission, and the reviewer App needs none.
- When a route sets `readyLabel`, a separate ready-label Lambda mints its own
  short-lived token with `pull_requests: write` and `metadata: read`, reconciles
  one configured label on that pull request, and never returns a token.
  Reviewer runtimes and the receiver invoke it with
  `{ installation_id, repo, pr_number }` only. The label name and repository
  allowlist come from the environment. `pull_requests: write` can add a label
  that already exists; GitHub answers 403 when the label is not in the
  repository, and the function logs that instead of creating it. The reviewer
  token already has `pull_requests: write` for the repository under review, so
  this function guards the automatic decision. It does not take away that
  token's ability to set an existing label.
- When the deployment proposes edits to the reviewers' built-in skill files,
  a separate skills-repo token broker gives the curator, and only the curator,
  a short-lived token for the bot's own repository, with `contents: write`,
  `pull_requests: write` and `metadata: read`. The repository comes from the
  deployment configuration, never from the request, and the broker refuses it
  unless the App's installation there is owned by the repository's owner. With
  that token the curator's code writes only `skill-check/<reviewer>/<release>`
  branches and their pull requests. The token itself could push to any branch
  of that repository that its branch protection rules allow, so protect the base
  branch and require reviews on it. The curator runs no code from a pull
  request or from upstream, has no shell, and its model never sees the token.
  Use a small App of its own for this, installed only on the bot repository.
  The receiver and the reviewer brokers ask for explicit permissions without
  `contents`, so with the reviewer App here none of their tokens carries it.
  But every account the reviewer App is installed on would have to grant it
  Contents write, and its private key, which the receiver and the reviewer
  brokers can read, could then mint `contents: write` tokens for every
  repository the App is installed on.
- Git authenticates each fetch with a per-process header. No token is written to
  the repository's `.git/config`.
- Build and test processes the reviewer starts get an environment with AWS,
  GitHub, token and secret variables removed, and start in the checked-out
  workspace. They are not otherwise sandboxed inside the container. They run as
  the same user as the runtime, so assume code from a pull request can obtain
  the run's installation token, and, through the runtime role, new tokens from
  the reviewer's broker for as long as the session lives (at most two hours).
  Those tokens carry only `pull_requests: write` and `metadata: read`, for one
  of the repositories routed to that reviewer at a time. Their scope and the
  broker's repository list, not their secrecy, are what limit them. The same
  code can use the runtime's own AWS role, which allows:
  - its models;
  - `s3:GetObject` on its own prefix in the assets bucket (no bucket listing),
    and `kms:Decrypt` on the substrate key, which also encrypts the concerns
    tables (the role has no DynamoDB access to them);
  - read access to its own skills registry;
  - `GetItem`, `PutItem` and `UpdateItem` on any item of the shared run
    heartbeat table. A forged record can make the watchdog drop or retry
    another run. The workers count a running record as live only if it
    looks like one a run wrote (`last_activity` at most 60 seconds ahead of
    the worker's clock, and a `ttl` at most 24 hours and 60 seconds ahead)
    and something rewrote it within `HEARTBEAT_STALE_MINUTES`. While PR code
    keeps rewriting such a record: under another run key of a pull request,
    it holds back that pull request's automatic reviews, each until its run
    budget is used up, after which the review runs anyway; under a review's
    own run key, it keeps that review from starting, and the review can end
    without running, in the dead-letter queue or as `[abandoned]`;
  - invoke on its own token broker, and on the ready-label Lambda when a
    route sets `readyLabel`;
  - log writes to its own runtime log groups
    (`/aws/bedrock-agentcore/runtimes/<runtime name>-*`);
  - image pulls from the CDK bootstrap container-assets repository. ECR cannot
    grant less than a whole repository, and that repository holds the images of
    every CDK app in the account and region that uses the same bootstrap
    qualifier.

  Deploy the reviewer into an AWS account used for nothing else, so that the
  repository holds only this app's images.
- The reviewer has no shell tool. It works through file tools and argument-list
  wrappers for `git`, the GitHub REST API (GET only, limited to the repository
  under review and its upstream), and the project's build tool.
- Feedback that can change the reviewer's instructions (curator skills) is only
  accepted from repository owners, members and collaborators. A correction
  through feedback can change a published skill only after it graduated past
  the threshold, and the feedback model can neither write nor change the
  suppression markers in a skill.
- The only other change to a skill's text is the curator's release check. It
  can replace a backticked code name, or a number on a line that names a
  flagged code name, with one that appears on a cited line of the public
  upstream default branch, and it keeps the original piece byte for byte in a
  suppressed block. It cannot add or remove a word, sentence or punctuation,
  code checks every edit and its cited lines before anything is written, and
  the marker's reason is generated from the changed names. It can retire a
  skill only on deterministic evidence: most of the skill's names gone, or no
  file left in its area. Edits, retirements and pull requests are each off
  until the operator turns them on, and per-day caps bound how many skills
  are checked and retired.
- For those checks the curator fetches the public upstream default branch
  without credentials into a fresh git repository (no hooks, no system or
  global git config, an environment without AWS, GitHub or token variables),
  reads it with read-only file and git tools, and runs none of its code. Its
  audit model reads code that upstream contributors wrote, so the skill text
  and the code excerpts reach it in blocks fenced by a random marker, as data.
  It can only end with a structured report, which code validates. Its
  summary goes only to the operator's `pending_revision` and to the logs;
  the note on the record, the marker text and a pull request's summary and
  evidence are built by code. Every piece of model text the curator logs
  (its replies and reasoning, the names of the tools it calls, an audit's
  or a feedback run's summary, ids it passed to tools) is one JSON-quoted
  string with invisible characters removed, on a `[model]` line or as a
  field of the curator's own lines, so it can neither start a line nor
  pass for a `[maintenance]` report line. The decay job reads only the
  public releases list, and a release tag must be a GA tag (`X.Y.Z` or
  `vX.Y.Z`) before it reaches a record or a message.
- Of the deployed functions, only the receiver and the decay job can send to
  the curator queue; the reviewer roles cannot. A maintenance message carries
  identifiers and a release tag only, no text, repository or URL. The curator
  acts on one only while the skill's record holds that message's claim, which
  only the decay job and the operator's `scripts/skill-check.mjs` set, so a
  forged message changes nothing.

If you find a way around any of these, please report it as described above.
