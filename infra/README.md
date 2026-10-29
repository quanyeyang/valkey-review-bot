# valkey-reviewer infrastructure

This CDK app deploys valkey-reviewer into one AWS account and region. All
values that differ between installations come from one JSON file, described
below. The code holds no account IDs, App IDs, registry IDs, routes or
secret names.

## Stacks

| Stack | Contents |
| --- | --- |
| `ValkeyReviewerSubstrate` | KMS key, prompt and skill bucket, reference to the GitHub App secret, one token broker Lambda per reviewer, the skills-repo token broker Lambda when `skillsRepo` is set, the ready-label Lambda when a route sets `readyLabel`, run heartbeat table |
| `ValkeyReviewAgent`, `ValkeyGlideReviewAgent` | One reviewer each: AgentCore runtime, its execution role, its concerns table, prompt and skill upload |
| `ValkeyReviewerCurator` | Curator runtime and its execution role, and the upload of `prompt.md`, `skill.md` and `skill-check.md` under `curator/` |
| `ValkeyReviewWebhook` | HTTP API, receiver Lambda, idempotency table, one queue and worker per route, the curator queue and worker, dead-letter queues |
| `ValkeyReviewerDecay` | Daily Lambda that decays concerns and queues skill checks and retirements on the curator queue |

Each runtime has its own role:

- A reviewer runs code from the pull request it reviews, and that code can
  use the reviewer's role. The role can:
  - call its models;
  - get objects under its own prefix in the assets bucket (no listing),
    with `kms:Decrypt` on the substrate key. The key also encrypts the
    concerns tables, but the role has no DynamoDB access to them;
  - read its own skills registry;
  - get, put and update any item in the shared heartbeat table;
  - invoke its own token broker, and the ready-label Lambda when a route
    sets `readyLabel`;
  - write its own runtime log groups
    (`/aws/bedrock-agentcore/runtimes/<runtime name>-*`, for example
    `valkey_review_runtime-*`);
  - pull from the CDK bootstrap container-assets repository
    (`ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` and
    `ecr:BatchCheckLayerAvailability`, plus `ecr:GetAuthorizationToken`
    on `*`). ECR cannot grant less than a whole repository, and that
    repository holds the images of every CDK app in the account and
    region that uses the same bootstrap qualifier.

  It has no Secrets Manager access, no concerns table access and no
  registry writes. GitHub tokens come from its token broker, which
  issues a short-lived token for one routed repository.
- The curator role can call its models, read its own prefix in the
  assets bucket (and list the bucket), read and write the concerns
  tables, create, update and read records in the reviewer registries and
  set their status (`agent-registry:UpdateRegistryRecordStatus`, which
  retires a skill), read its own registry, invoke the skills-repo broker
  when there is one, write its own runtime log groups and pull from the
  same container-assets repository. It runs on the `PUBLIC` network mode
  and holds no GitHub credentials. Its skill checks fetch the public
  upstream repositories from `github.com` with git, and read the skill
  files of the bot repository from `api.github.com` and
  `raw.githubusercontent.com`, all without credentials.

Other functions:

- The decay Lambda can scan, update and delete items in the concerns
  tables, use their key, and send messages to the curator queue
  (`sqs:SendMessage`, `sqs:GetQueueAttributes` and `sqs:GetQueueUrl`, on
  that queue only). It reads the GitHub releases API without credentials.
- Each review worker can invoke its route's runtime, read the heartbeat
  table and update its items (the run's start record), and get, update
  and delete the receiver's `pending#` items in the idempotency table
  (the grant is limited to that key prefix). The curator worker can only
  invoke the curator runtime.
- The skills-repo broker can read only its App secret
  (`secretsmanager:GetSecretValue` on that secret). Only the curator role
  may invoke it.

Deploy into an AWS account used for nothing else, or at least give this
app a bootstrap qualifier of its own (`aws.bootstrapQualifier`), so that
the container-assets repository holds only this app's images.

Model permissions are derived from the `models` settings. Mantle
permissions are granted only when an `openai.*` model is configured.

## Before the first deployment

1. Install Node.js 24 or later, Docker and the AWS CLI. `cdk deploy`
   builds the three agent images for linux/arm64. On an x86 machine
   Docker needs arm64 emulation (buildx with QEMU; Docker Desktop
   includes it), or deploy from an arm64 machine. The operator scripts in
   `scripts/` use the AWS CLI.
2. Bootstrap CDK in the target account and region, preferably an account
   used for nothing else (see [Stacks](#stacks)):
   `npx cdk bootstrap aws://ACCOUNT/REGION`. If you use a custom qualifier,
   pass `--qualifier` and set `aws.bootstrapQualifier` to the same value.
3. Create a GitHub App. Give it at least Pull requests (read and write),
   Issues (read) and Metadata (read). The token broker requests only Pull
   requests and Metadata; Issues (read) is what lets the App subscribe to
   `issue_comment`. Subscribe it to the `pull_request`,
   `pull_request_review`, `pull_request_review_comment` and
   `issue_comment` events, and install it on the repositories you route.
   Reviews need no Contents permission. The pull requests that propose
   edits to the reviewers' skill files need an App with Contents on the
   bot's repository: this App by default, or a dedicated one; see
   [The skills-repo App](#the-skills-repo-app).
   If a route sets `readyLabel`, the App also needs Issues (write), and
   you must subscribe it to `pull_request_review_thread`. Approve the new
   permission on each existing installation after deploying. Create the
   label in each repository yourself; the bot never creates it.
4. Store the App credentials in Secrets Manager, in the target account and
   region, under the name you set in `github.appSecretName`. The secret is a
   JSON object:
   ```json
   { "app_id": "123456", "private_key": "-----BEGIN RSA PRIVATE KEY-----\n...", "webhook_secret": "..." }
   ```
5. Create three registries in AWS Agent Registry in the same account and
   region: one per reviewer and one for the curator. This app does not
   create them. Put their IDs or ARNs under `skillsRegistries`.
6. Make sure the account can invoke every model in `models`.
7. Copy `deploy.config.example.json` to `deploy.config.json` and fill it in.
   `deploy.config.json` is ignored by git. The example sets
   `skillsRepo.repo` to the placeholder `your-org/valkey-review-bot`. Set it
   to your bot repository, or remove the `skillsRepo` block until you set
   up [the skills-repo App](#the-skills-repo-app). While it is set, the
   substrate stack creates the skills-repo broker and the curator may
   invoke it, even with `skillLifecycle.openPullRequests` off, and every
   release's repo skill check reads the file from that repository. A
   placeholder repository makes each of those checks end inconclusive.

## Commands

From the repository root:

```sh
(cd webhook && npm ci) && (cd ops && npm ci)
cd infra
npm ci
npm run typecheck
npm test                            # unit tests; no AWS access needed
npx cdk synth
npx cdk deploy --all
```

`cdk synth` bundles the Lambda functions from `webhook/` and `ops/` with
esbuild, so those packages need their dependencies installed first.
`npm test` skips the bundling and needs only `infra/`.

The app reads its configuration from the first of:

1. `-c config=PATH` on the cdk command line,
2. the `VALKEY_REVIEWER_CONFIG` environment variable,
3. `infra/deploy.config.json`.

Relative paths resolve against the current directory. The file is validated
before any stack is built, and every problem is reported at once. If the
AWS credentials in use belong to a different account than `aws.account`,
synthesis stops.

After the first deployment, set the App's webhook URL to the `ApiUrl`
output of `ValkeyReviewWebhook` and its webhook secret to the
`webhook_secret` value from step 4.

Then publish the curator's reference skills to its registry. From the
repository root:

```sh
(cd agents/common && npm ci)
node scripts/publish-curator-skills.mjs --stack ValkeyReviewerCurator --region REGION
```

The script runs the registry code in `agents/common`, so that package
needs its dependencies. `--stack` reads the `CuratorSkillsRegistryId`
output with the AWS CLI. Each reviewer stack has a `SkillsRegistryId`
output, which `scripts/registry-skills.mjs --stack` reads.

## Configuration reference

Unknown keys are rejected, so a misspelled key fails instead of being
ignored. Keys with a default may be left out.

### `aws`

| Key | Default | Meaning |
| --- | --- | --- |
| `account` | required | 12-digit account ID. Must equal the account of the current AWS credentials when the CDK CLI reports one. |
| `region` | required | Region for every stack, for example `us-west-2`. |
| `bootstrapQualifier` | `hnb659fds` | CDK bootstrap qualifier. Selects the bootstrap bucket, roles and container repository. |

### `github`

| Key | Default | Meaning |
| --- | --- | --- |
| `appId` | required | Numeric GitHub App ID. |
| `botLogin` | required | The App's bot login, ending in `[bot]`, for example `your-app-slug[bot]`. Used to recognize the bot's own comments and @mentions. |
| `appSecretName` | required | Secrets Manager secret name (see step 4 above). |
| `installationId` | none | Numeric installation ID. Only used when a webhook payload carries no installation. |
| `knownBotLogins` | receiver's built-in list | Logins of other bots to ignore. See [Known bot logins](#known-bot-logins). |

#### Known bot logins

The receiver ignores bot authors. Their pull requests get no automatic
review, their comments and reviews are not maintainer feedback, and
their @mentions do not summon the bot. An author is a bot when GitHub
reports the user type `Bot`, when the login ends in `[bot]`, when the
login is `botLogin`, or when the login is in the known bot list. Logins
are compared case-insensitively.

The stack passes `knownBotLogins` to the receiver as the comma-separated
`KNOWN_BOT_LOGINS` variable. A non-empty list replaces the built-in list
(`DEFAULT_KNOWN_BOT_LOGINS` in `webhook/src/config.ts`), so copy any
built-in logins you still want.
Leave the key out, or set it to `[]`, to keep the built-in list. The
variable is then not set at all, because the receiver would read an empty
value as an empty list.

### `skillsRegistries`

All three are required. Each value is a registry ID (letters, digits, `_`,
`-`, up to 64 characters) or an `agent-registry` registry ARN in the same
partition, region and account as `aws`.

| Key | Meaning |
| --- | --- |
| `valkey-review` | Graduated skills for the Valkey reviewer. |
| `valkey-glide-review` | Graduated skills for the Valkey GLIDE reviewer. |
| `curator` | The curator's own reference material, such as how to write a skill. |

### `routes`

A list with at least one entry. Each route connects one repository to one
reviewer. The token broker issues tokens only for these repositories.

| Key | Default | Meaning |
| --- | --- | --- |
| `id` | required | Route name: letters, digits and hyphens. It names the route's queue and worker, so keep it stable once deployed. Ids must stay unique after hyphens are removed. |
| `reviewer` | required | `valkey-review` or `valkey-glide-review`. |
| `repo` | required | `owner/name`, spelled as GitHub shows it. A repository can appear in one route only (compared case-insensitively). |
| `threadReplyReview` | `false` | A maintainer tagging the bot in a reply inside any review thread starts a review. In a thread the bot started, that review answers the reply from the code: it verifies a claimed fix, re-checks a disputed finding (and withdraws it if the reply is right), or answers a question. In any other thread the tag is an ordinary summons. When `false`, tags in review-thread replies start nothing (the replies are still feedback). Enable it on every route where maintainers should be able to answer the bot; the example does so on both routes. |
| `skipDrafts` | `false` | Draft pull requests are not reviewed when opened or pushed to; the review runs when the draft is marked ready. |
| `mentionOnly` | `false` | No automatic reviews, on open, reopen or new commits. Reviews run only when a maintainer tags the bot. |
| `authorAllowlist` | `[]` | When not empty, only pull requests by these logins get automatic reviews. |
| `readyLabel` | empty | GitHub label this route projects readiness onto (1–50 characters, no CR/LF, not whitespace-only). Empty turns the feature off. The label is added only when the PR is open and not a draft, this App's state comment says **Ready for human review.** at the current head, and every review thread this App started is resolved or has a later human reply. Anything else removes that one label. The operator creates the label in the repository; a missing label is logged, not created. Requires Issues (write) on the App and a subscription to `pull_request_review_thread`. |

### `curatorOnlyRoutes`

Default `[]`. Repositories the curator learns from but where no reviewer
ever runs. Each entry has `reviewer` and `repo` as above. A repository
cannot be both a route and a curator-only route.

### `upstreamRepos`

The canonical repository of each reviewer's project. The reviewer fetches
its release branches for backport checks. The skill lifecycle uses it too:
its GitHub releases trigger skill checks, and the checks read its default
branch. It must be public, because both are read without credentials. An
empty string means "use the pull request's repository" for backport checks
and turns skill checks off for that reviewer; decay and retirement still
apply. A repository named `.` or `..` is refused.

| Key | Default |
| --- | --- |
| `valkey-review` | `valkey-io/valkey` |
| `valkey-glide-review` | `valkey-io/valkey-glide` |

### `models`

Model IDs are Bedrock model IDs or inference profile IDs. IDs that start
with `openai.` are called through Bedrock Mantle. An ID that starts with a
region-group token and a dot, such as `us.anthropic.claude-opus-5-5`, is a
cross-Region inference profile. Any other ID is a foundation model, called
and granted in `aws.region` only.

The role that calls a profile gets the profile ARN in `aws.region` and the
foundation model in `aws.region` and in every `profileRegions` entry.
`aws.region` and every `profileRegions` entry must also pass the region
check for the profile's group:

| Prefix | Regions allowed |
| --- | --- |
| `us.` | `us-*`, except `us-gov-*` |
| `us-gov.` | `us-gov-*` |
| `eu.` | `eu-*` |
| `apac.`, `jp.`, `au.`, `in.` | `ap-*` |
| `ca.` | `ca-*` |

The check uses region names only. It catches a profile from the wrong
geography, but it cannot tell whether Bedrock serves a given profile from,
or routes it to, a given region; for example, `jp.*` profiles run in only
some `ap-*` regions. Bedrock sets those per profile and per calling
region. To find them, call `aws bedrock get-inference-profile` in
`aws.region` and list the regions of the model ARNs it returns in
`profileRegions`. If you use profiles from more than one group,
`profileRegions` must pass the check for each of them.

Global profiles (`global.*`) are rejected. They can route a request to any
commercial region, which `profileRegions` cannot bound. To use a region
group that is not in the table, add it to `PROFILE_GEOGRAPHIES` in
`lib/deployment-config.ts`; until then its IDs are treated as foundation
models.

| Key | Default | Meaning |
| --- | --- | --- |
| `reviewer.primary` | `us.anthropic.claude-opus-5-5` | Reviewer model. |
| `reviewer.fallback` | `openai.gpt-6.1-sol` | Used when a review is retried after the primary failed. |
| `reviewer.effort` | `high` | Effort for both reviewer models. One of `low`, `medium`, `high`, `xhigh`, `max`. |
| `curator.primary` | `us.anthropic.claude-opus-5-5` | Curator model. |
| `curator.fallback` | `openai.gpt-6.1-sol` | Curator model after a primary failure. |
| `curator.effort` | `medium` | Effort for `curator.primary`. |
| `curator.fallbackEffort` | `high` | Effort for `curator.fallback`. |
| `summarizer.primary` | `us.anthropic.claude-haiku-5-5` | Writes the one-line progress note in the status comment of a summoned review. |
| `summarizer.fallback` | `openai.gpt-6.1-sol` | Used when the summarizer primary fails. |
| `safetyGate` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Screens maintainer instructions in @mentions before a review is queued. Must be a Bedrock model; the receiver calls it through the Converse API. |
| `profileRegions` | `["us-east-1", "us-east-2", "us-west-2"]` | Regions an inference profile may send a request to. Each gets a foundation-model grant. |
| `mantleRegion` | `us-east-1` | Region the Mantle client calls. Required when any model is `openai.*`; may be `""` otherwise. |
| `mantleGrantRegions` | `[mantleRegion]` | Regions where Mantle inference is granted. Must include `mantleRegion`. Add a region here before you move `mantleRegion` to it. |
| `extraGrants` | `[]` | More model IDs granted to the reviewer and curator roles, for example a model you may roll back to. |

### `agents`

| Key | Default | Meaning |
| --- | --- | --- |
| `valkey-review.maxIterations`, `valkey-glide-review.maxIterations` | `150` | Maximum model calls per review, retries included (1 to 500). |
| `valkey-review.maxTokens`, `valkey-glide-review.maxTokens` | `32768` | Output token limit per model call (1024 to 200000). |
| `valkey-review.allowBuild`, `valkey-glide-review.allowBuild` | `true` | Lets the reviewer run the repository's build and tests. |
| `valkey-review.allowWrite`, `valkey-glide-review.allowWrite` | `true` | Lets the reviewer write files in its checkout, for example a test that checks a claim. |
| `curator.maxIterations` | `40` | Maximum tool rounds per feedback event (1 to 500). |
| `curator.maxTokens` | `16384` | Output token limit per model call (1024 to 200000). |
| `curator.graduationThreshold` | `4` | Distinct reinforcements a concern needs before the curator may write it to a reviewer's skills registry (2 to 100). |

The ranges are the ones the curator checks when it starts, so a value it
would reject fails synthesis instead. The reviewers use the same ranges.

### `decay`

| Key | Default | Meaning |
| --- | --- | --- |
| `halfLifeDays` | `30` | Days it takes the `decay_score` of an unreinforced record that never graduated to halve. Passed to the decay Lambda as `DECAY_HALF_LIFE_SECONDS`. Greater than 0 and at most 3650. |
| `floor` | `0.05` | Records that never graduated are deleted when their `decay_score` falls below this; graduated records are retired instead. Greater than 0 and less than 1. |
| `graduatedHalfLifeDays` | `180` | Half-life of records that graduated into a skill: the skill's standing. Passed as `DECAY_GRADUATED_HALF_LIFE_SECONDS`. Greater than 0, at most 3650, and at least `halfLifeDays`. |

The curator sets a record's `decay_score` to 1 each time a maintainer
reinforces the concern. Once a day the decay Lambda (`ops/src/decay.ts`)
multiplies the score by `0.5 ^ (elapsed / halfLife)`, where `elapsed` is
the time since the score was last set. A record nobody reinforces falls
below the floor after `halfLife * log2(1 / floor)` days.

- A record that never graduated is deleted then. With the defaults that is
  `30 * log2(20)`, about 130 days.
- A graduated record is never deleted. Below the floor its skill is
  retired, when `skillLifecycle.retireSkills` is on, and the record stays
  as a tombstone. With the defaults that is `180 * log2(20)`, about 778
  days. A release check that finds names missing also lowers the score,
  and one that finds the skill's subject gone sets it to 0.

Scores lowered under an earlier half-life keep their value; the new one
applies from the next pass.

### `skillLifecycle`

How the decay job schedules skill maintenance and what the curator may
change. Every switch that changes a skill, retires one or opens a pull
request is off by default: report mode. See
[Skill lifecycle operations](#skill-lifecycle-operations) before turning
one on.

| Key | Default | Meaning |
| --- | --- | --- |
| `checksPerDay` | `10` | Check requests per reviewer per daily pass, the repo skill check included (0 to 100). `0` turns checks off. Passed to the decay Lambda as `SKILL_CHECKS_PER_DAY`. |
| `recheckDays` | `90` | A check is also due when the last one is older than this (7 to 3650). `SKILL_RECHECK_SECONDS`. |
| `applyEdits` | `false` | Write validated edits to the registry skills. When `false`, they are kept in the record's `pending_revision` for the operator. Curator `CHECK_APPLY_EDITS`. |
| `retireSkills` | `false` | Deprecate skills that decayed below the floor or whose subject is gone. When `false`, the decay job logs them as `would-retire`. `RETIRE_SKILLS`, on both the decay Lambda and the curator. |
| `openPullRequests` | `false` | Propose edits to the reviewers' repo skill files by pull request against `skillsRepo.repo`. `true` without `skillsRepo` fails validation, so synthesis stops. Curator `CHECK_OPEN_PULL_REQUESTS`. |
| `maxRetirementsPerDay` | `3` | Retire requests per reviewer per pass (1 to 50). `MAX_RETIREMENTS_PER_DAY`. |
| `maxCheckRounds` | `25` | Tool rounds of one audit (5 to 100). Curator `CHECK_MAX_ROUNDS`. |
| `retireRefusedBackoffDays` | `30` | After the registry refused a retirement, the decay job waits this long before it asks again (1 to 3650). `RETIRE_REFUSED_BACKOFF_SECONDS`. |

### `skillsRepo`

Optional. The bot's own repository, where the reviewers' repo skill files
(`agents/<reviewer>/config/skill.md`) live. When it is absent, the repo
skill check of each release is recorded as skipped, no skills-repo broker
is created, and nothing is ever proposed. When it is set, the curator reads
the files from it without credentials, so it must be public.

| Key | Default | Meaning |
| --- | --- | --- |
| `repo` | required | `owner/name` of the bot repository, for example `valkey-io/valkey-review-bot`. Passed to the curator and the broker as `SKILLS_REPO`. |
| `baseBranch` | `main` | The branch the files are read from and pull requests target: at most 100 characters, a name git accepts. `SKILLS_REPO_BASE_BRANCH`. |
| `appSecretName` | `github.appSecretName` | Secrets Manager secret of the App that opens the pull requests, with `app_id` and `private_key` (the same JSON shape as the main App secret; `webhook_secret` is not needed). See [The skills-repo App](#the-skills-repo-app). Passed to the broker as `SKILLS_REPO_APP_SECRET_NAME`. |
| `signOff` | the App's bot identity | `Name <email>` on one line for the commit's `Signed-off-by` line. The name is 1 to 100 characters, with no control characters, no `<` or `>`, and no space or other whitespace at either end. `SKILLS_REPO_SIGN_OFF`. |

### `dailyReviewBudget`

Default `40`. Automatic reviews allowed per route per UTC day, reviews of
new commits included. Reviews beyond it are skipped and logged. Reviews
summoned by a maintainer are not counted, and neither are events that join
a waiting review. A queued review keeps its slot even if it is skipped
later, for example because the pull request was closed. `0` pauses
automatic reviews.

### `maxAutomaticReviewsPerPr`

Default `3`, from 1 to 20. Automatic reviews one pull request can get,
counting the first: on open, reopen, `ready_for_review` and new commits.
Further events are skipped as `auto-review-cap`. @mentions and thread
replies are not counted. A review still waiting when the pull request is
closed, or turned back into a draft on a `skipDrafts` route, gives its
round back, and takes it again if the pull request comes back before the
review starts. A review the worker gives up on, past the run budget or in
the dead-letter queue, keeps its round. Passed to the receiver as
`MAX_AUTOMATIC_REVIEWS_PER_PR`. The count lives in the idempotency table and
expires 180 days after the pull request's latest automatic review.

### `pushReviewDelaySeconds`

Default `300`, from 0 to 900 (the SQS limit). How long a review that new
commits started waits in the queue. Pushes, reopens and `ready_for_review`
events while it waits join it, so a burst gets one review of the newest
head. Passed to the receiver as `PUSH_REVIEW_DELAY_SECONDS`. The delay comes
out of the review's 90-minute run budget.

## Upgrading and rolling back

### Upgrading a deployment that already reviews pull requests

Earlier versions reviewed a pull request only when it was opened, reopened
or marked ready, and kept no round counter. After the upgrade:

- Reviews of new commits start at once on every open pull request. A pull
  request that was open at the deploy has no round counter, so one that the
  earlier receiver reviewed when it opened can still get
  `maxAutomaticReviewsPerPr` reviews of new commits, one more than the cap.
  These reviews share each route's `dailyReviewBudget` with new pull
  requests, and an event that finds the budget used up is not reviewed
  until the pull request's next push or a manual redelivery. On busy
  repositories, set a lower `maxAutomaticReviewsPerPr` (with 1, new pull
  requests get no reviews of new commits) or a higher `dailyReviewBudget`
  for the first weeks, and watch the receiver's `[auto-review]` and
  `[budget]` lines.
- In the first hour after `ValkeyReviewWebhook` is deployed,
  `[auto-review] ... joins the waiting review; skipped` lines for a pull
  request opened, reopened or marked ready during the update are
  expected. The receiver and the workers update in parallel, a worker of
  the earlier version does not remove the pending marker of a review the
  new receiver queued, and the marker expires an hour later. Until then,
  new commits on that pull request are not reviewed.

Then roll out the skill lifecycle in report mode
([below](#rollout-in-report-mode)).

### Rolling back

A straight `npx cdk deploy --all` of an earlier version fails at its first
stack. This version adds two cross-stack imports: `ValkeyReviewerDecay`
imports the curator queue from `ValkeyReviewWebhook`, and, with
`skillsRepo` set, `ValkeyReviewerCurator` imports the skills-repo broker
from `ValkeyReviewerSubstrate`. An earlier version deploys the substrate
and webhook stacks first, and CloudFormation refuses to delete an export
that another stack still imports. From a checkout of the earlier version:

1. Remove from `deploy.config.json` the keys that version does not know,
   since its parser rejects unknown keys: `skillLifecycle`, `skillsRepo`,
   `maxAutomaticReviewsPerPr`, `pushReviewDelaySeconds` and
   `decay.graduatedHalfLifeDays`.
2. Deploy the two importing stacks first, which drops the imports, then
   the rest:
   ```sh
   npx cdk deploy ValkeyReviewerDecay ValkeyReviewerCurator --exclusively
   npx cdk deploy --all
   ```

The earlier decay job decays every concern record on `decay.halfLifeDays`
and deletes it below the floor, graduated records and tombstones included.
Their skills stay in the registries, and reviewers keep loading the live
ones.

## Skill lifecycle operations

The daily decay job schedules skill checks and retirements, and the
curator runs them (see
[docs/architecture.md](../docs/architecture.md#skill-maintenance)). The
commands below run from the repository root. The scripts need Node.js 24
or later and, except `skill-facts.mjs --file`, the AWS CLI. Those that call
the registry (`registry-skills.mjs`, `publish-curator-skills.mjs` and
`skill-facts.mjs --name`) also need `npm ci` in `agents/common`.

### Rollout in report mode

The defaults are report mode: `applyEdits`, `retireSkills` and
`openPullRequests` are `false`. In report mode the scheduled passes still
run real checks: the curator records each outcome on the record
(`check_outcome`, `check_note`, `stale_names`, `verified_*`), lowers the
standing of skills whose names are missing, and keeps proposed edits in
`pending_revision`. It changes no skill text, retires nothing and opens no
pull request. A dry run (below) records even less.

1. Deploy with the defaults: `npx cdk deploy --all`. From the first pass,
   graduated records are no longer deleted. Only skills whose concern
   record names them (`graduated_record_name`) get checks: up to
   `checksPerDay` (10) of them per reviewer get their first check each
   day, and the model runs only for skills with flagged names. Skills
   published by hand, outside the curator, get none until step 3 adopts
   them.
2. Publish the curator's reference skills again, since
   `agents/curator/skills/` changed:
   `node scripts/publish-curator-skills.mjs --stack ValkeyReviewerCurator --region REGION`.
3. Bring the skills the lifecycle does not reach into it. `orphans` lists
   the live skills that no concern record names: skills published by
   hand, and skills whose concern record the old decay job deleted.
   Reviewers load them, but nothing decays, checks or retires them.
   `adopt` writes for each one the concern record the curator would hold
   had it graduated the skill. Without `--apply` it only prints what it
   would write:
   ```sh
   node scripts/registry-skills.mjs orphans --stack ValkeyReviewAgent --region REGION
   node scripts/registry-skills.mjs adopt --stack ValkeyReviewAgent --curator-stack ValkeyReviewerCurator --region REGION
   node scripts/registry-skills.mjs adopt --stack ValkeyReviewAgent --curator-stack ValkeyReviewerCurator --region REGION --apply
   ```
   Do the same for `ValkeyGlideReviewAgent`. A skill that cites no
   directory, only bare file names such as `server.c`, goes to the bucket
   `--bucket` names (default `**`, which the curator never lists, so
   maintainers could not reinforce it): pass the project's main source
   directory, for example `--bucket src` for Valkey and
   `--bucket glide-core` for GLIDE. Read the `would-adopt` lines
   before `--apply`: each shows the record's `area`, and if no upstream
   file matches it, a check can confirm an `obsolete` verdict and retire
   the skill. Do not deprecate orphans instead: `DEPRECATED` is final, and
   the skill can never be edited or brought back. An adopted skill is
   retired by the lifecycle only when it decays or its subject is gone,
   and only with `retireSkills` on. Adopt needs
   `cloudformation:DescribeStacks`, `agent-registry:ListRegistryRecords`
   and `agent-registry:GetRegistryRecord` on the registry,
   `dynamodb:Scan` on the concerns table and use of its key,
   `dynamodb:PutItem` on the table for `--apply`, and
   `bedrock-agentcore:GetAgentRuntime` on the curator runtime for
   `--curator-stack`, which reads its graduation threshold
   (`--threshold N` instead needs none).
4. Run a report-only pass and review it (the next two sections).
5. Turn the switches on one at a time
   ([Turning on edits, retirements and pull requests](#turning-on-edits-retirements-and-pull-requests)).

### A report-only pass on demand

Two ways, both with `dry_run: true`. A dry run makes no registry change
and opens no pull request, whatever the settings say. It records only an
audit's proposed edits in `pending_revision`, logs what a real run would
do (`would-revise`, `would-retire` and so on), and releases each claim,
so the next real pass checks the same skills again.

- The decay Lambda, with a manual event. Its function name is the
  `DecayFnName` output of `ValkeyReviewerDecay`:
  ```sh
  aws lambda invoke --function-name DECAY_FN_NAME \
    --cli-binary-format raw-in-base64-out --cli-read-timeout 360 \
    --payload '{"recheck_all":true,"dry_run":true}' decay-result.json
  ```
  `recheck_all` makes every live graduated skill due, still within
  `checksPerDay` and `maxRetirementsPerDay` per reviewer. It also queues
  the repo skill check of each reviewer whose upstream GA release it
  resolved in that pass (none when checks are off, the release lookup
  fails, or the upstream has no GA release). The pass otherwise does
  what the next scheduled pass would do: it writes the decayed scores and
  deletes ungraduated records below the floor. Retirement candidates are
  only logged. The read timeout covers the function's 5-minute limit, so
  the CLI does not retry, and invoke again, while the pass runs.
- `scripts/skill-check.mjs`, which queues checks of registry skills only,
  claimed the way the decay job claims them, taken in its order, 60 seconds
  apart:
  ```sh
  node scripts/skill-check.mjs --stack ValkeyReviewAgent --webhook-stack ValkeyReviewWebhook --release 9.1.2 --plan
  node scripts/skill-check.mjs --stack ValkeyReviewAgent --webhook-stack ValkeyReviewWebhook --release 9.1.2
  node scripts/skill-check.mjs --stack ValkeyReviewAgent --webhook-stack ValkeyReviewWebhook --name SKILL_NAME
  ```
  `--plan` only prints what it would queue. `--limit N` (default 10, the
  decay job's code default, not your `checksPerDay`) caps the run; checks
  come on top of that day's decay checks and share the curator queue with
  maintainer feedback. `--release` names the GA release the check is for
  (the decay job's `[release]` line shows it); without it, edits are
  labelled with the checked commit. `--apply` sends `dry_run: false`, so
  the settings decide again. A record with a request younger than 7 days
  is skipped. It needs `cloudformation:DescribeStacks`, `dynamodb:Scan` and
  `dynamodb:UpdateItem` on the concerns table, use of the
  `SubstrateKeyArn` key and `sqs:SendMessage` on the curator queue.

### Reviewing the reports

- The curator's log group: one `[maintenance] check|retire|repo_check`
  line per run with its `outcome` (or `would-...` in a dry run), counts of
  lost, new-and-absent and touched names, the note, and an `advisory`
  field when the skill's description cites names that are absent (which
  only a re-publication can change); one `[maintenance] edit` line per
  proposed edit with its `evidence`, `original` and `replacement`; and
  the run's end, `[curator] maintenance <status> reason=... decision=...`.
  Between them, `[model] text "..."`, `[model] reasoning "..."` and
  `[model] tool "<name>"` lines show what the audit model wrote, quoted.
  They are not report lines.
- The decay job's log group: `[release] <repo> tag=<tag>`, one
  `check-requested`, `repo-check-requested` or `retire-requested` line per
  message, `would-retire` and `deferred` for retirements that were not
  requested, and the summary line per table:
  `[decay] <table> scanned= decayed= deleted= skipped= errors= kept_retired= checks_requested= retire_requested= would_retire= deferred= retire_backoff= reserved=`.
- The records themselves:
  ```sh
  scripts/concerns-dump.sh --stack ValkeyReviewAgent --stack ValkeyGlideReviewAgent --region REGION
  ```
  For each graduated record it prints the skill state, the last check, the
  stale names, a maintenance request in flight, and the pending edit: its
  verdict, reason and summary, then each edit's evidence, the suppressed
  piece (`-`) and its replacement (`+`). The repo skill check of each
  reviewer is printed first, as `repo skill.md check (#maintenance repo-skill)`.
  It needs `jq`, `dynamodb:Scan` and `kms:Decrypt` on the key.

Review the pending edits of at least one release before you turn on
`applyEdits`, and the `would-retire` lines before `retireSkills`.

### Turning on edits, retirements and pull requests

Each is one key in `skillLifecycle`. After a change, deploy the stacks that
read it: `npx cdk deploy ValkeyReviewerCurator ValkeyReviewerDecay`.

- `applyEdits: true`: validated edits are written to the registry skill in
  suppress-and-add form. The text before each edit is kept in
  `previous_skill_md`, and the table has point-in-time recovery.
- `retireSkills: true`: skills below the floor, and skills a check found
  obsolete, are deprecated, at most `maxRetirementsPerDay` per reviewer a
  day. A record created in the registry settles in `DRAFT`, `DRAFT` to
  `DEPRECATED` works, and `DEPRECATED` is final: the record cannot be edited
  or brought back. A retired skill returns only under a new name, when a
  maintainer reinforces its concern again.
- `openPullRequests: true`: needs `skillsRepo` and
  [the skills-repo App](#the-skills-repo-app); without `skillsRepo` the
  configuration fails validation. Pull requests open on
  `skill-check/<reviewer>/<release>` branches of `skillsRepo.repo`. Close one
  to reject it; nothing more is proposed for that release.

### The skills-repo App

The pull requests that propose edits to `agents/<reviewer>/config/skill.md`
are opened by a GitHub App through the skills-repo broker. Use a small App
of its own, installed only on the bot repository:

1. Create a GitHub App with the repository permissions Contents (read and
   write), Pull requests (read and write) and Metadata (read). It needs no
   webhook and no events.
2. Install it on the bot repository only, from the account that owns it
   (for example `valkey-io` for `valkey-io/valkey-review-bot`). The broker
   refuses a token unless the installation's account owns the repository.
   The repository must be public, because the curator reads the skill
   files without credentials.
3. Store `{ "app_id": "...", "private_key": "..." }` in Secrets Manager in
   the deployment's account and region, and set `skillsRepo.appSecretName`
   to its name.
4. Set `skillsRepo.repo` (and `baseBranch` if it is not `main`), and
   optionally `signOff`. Deploy.

The broker asks GitHub for a token limited to that one repository, with
`contents: write`, `pull_requests: write` and `metadata: read`, whatever
else the App may do. Without `appSecretName` the main App is used, which
works but widens what the main App holds. It needs Contents (read and
write), and each account it is installed on, such as `valkey-io` for
`valkey-io/valkey`, must approve that new permission. Its private key,
which the receiver and the reviewer brokers can read, could then mint
`contents: write` tokens for every repository the App is installed on.

The receiver and the reviewer brokers ask for explicit permissions without
Contents either way: the receiver for `pull_requests: write`,
`issues: read` and `metadata: read` (`RECEIVER_TOKEN_PERMISSIONS` in
`webhook/src/github.ts`), and the reviewer brokers for
`pull_requests: write` and `metadata: read`. So their tokens, and the
reviewer runtimes, never get Contents permission. The ready-label Lambda,
when a route sets `readyLabel`, asks for `issues: write`,
`pull_requests: read` and `metadata: read` itself and never returns that
token.

The commits are made with the broker's token, so GitHub authors them as
the App's bot user. Their `Signed-off-by` line is `skillsRepo.signOff`, or
that bot identity when `signOff` is not set.

To remove `skillsRepo` later, deploy in two steps. The curator stack
imports the broker's name and ARN from the substrate stack, so
`cdk deploy --all`, which deploys the substrate stack first, would fail to
delete the broker's exports:

```sh
npx cdk deploy ValkeyReviewerCurator --exclusively
npx cdk deploy --all
```

### Checking a skill file against the upstream

The repo skill files ship by pull request, and the curator checks them once
per release. To check one yourself, for example before a pull request that
changes it:

```sh
node scripts/skill-facts.mjs --file agents/valkey-review/config/skill.md --repo valkey-io/valkey
node scripts/skill-facts.mjs --file agents/valkey-glide-review/config/skill.md --repo valkey-io/valkey-glide
```

It makes an anonymous checkout of the default branch tip in a temporary
directory and prints the cited names and the ones that are absent. Exit
status: 0 when clean, 2 when not, 1 on error. `--ref BRANCH` checks another
branch, `--checkout DIR --rev REV` a clone you already have (not a partial
clone), `--names` lists every name with its kind and count, and `--json`
prints the whole result. `--repo valkey-io/valkey --name SKILL --stack ValkeyReviewAgent`
instead reproduces the curator's deterministic check of a registry skill, with
the record's baseline, ignored names and last checked commit (one of `--repo`,
`--url` or `--checkout` is always required).

### Restoring a retired skill

A skill an operator deprecated (with `registry-skills.mjs deprecate`, or in
the console) is recorded with `retired_reason` `operator`, and the curator
never publishes it again. To allow it, remove that reason from its record;
`concerns-dump.sh` shows the bucket and record id:

```sh
aws dynamodb update-item --table-name CONCERNS_TABLE \
  --key '{"area_bucket":{"S":"BUCKET"},"record_id":{"S":"RECORD_ID"}}' \
  --update-expression 'REMOVE retired_reason' \
  --condition-expression 'retired_reason = :operator' \
  --expression-attribute-values '{":operator":{"S":"operator"}}'
```

The next reinforcement that reaches the threshold publishes it under a new
generation name. A skill the lifecycle retired (`decayed` or `obsolete`)
needs nothing: a reinforcement brings it back the same way.

### A check that stays incomplete

A check whose base commit cannot be fetched, other than because the
upstream no longer has it, never confirms the skill, so the same check
comes back. If a skill keeps ending `inconclusive` for that reason, remove
`verified_sha` from its record. The next check is then a first check, by
presence only:

```sh
aws dynamodb update-item --table-name CONCERNS_TABLE \
  --key '{"area_bucket":{"S":"BUCKET"},"record_id":{"S":"RECORD_ID"}}' \
  --update-expression 'REMOVE verified_sha'
```

The same works for the repo skill item, with the key
`{"area_bucket":{"S":"#maintenance"},"record_id":{"S":"repo-skill"}}`.

### Settings as the functions see them

The CDK app turns the configuration into environment variables. The
curator logs its maintenance settings when it starts:
`[boot] skill maintenance upstreams={...} audit_prompt=loaded apply_edits=false retire_skills=false open_pull_requests=false skills_repo=...`.

Decay Lambda (`ops/src/decay.ts`):

| Variable | From | Meaning |
| --- | --- | --- |
| `CONCERNS_TABLES_JSON` | the reviewer stacks | Reviewer id to concerns table. |
| `DECAY_HALF_LIFE_SECONDS`, `DECAY_FLOOR`, `DECAY_GRADUATED_HALF_LIFE_SECONDS` | `decay` | Unset: 30 days, 0.05 and 180 days. |
| `UPSTREAM_REPOS_JSON` | `upstreamRepos` | Only the reviewers with an upstream; the others get no checks. |
| `CURATOR_QUEUE_URL` | the webhook stack | Without it the pass decays as usual, queues nothing and logs a warning. |
| `SKILL_CHECKS_PER_DAY`, `SKILL_RECHECK_SECONDS`, `RETIRE_SKILLS`, `MAX_RETIREMENTS_PER_DAY`, `RETIRE_REFUSED_BACKOFF_SECONDS` | `skillLifecycle` | Unset: 10, 90 days, `false`, 3 and 30 days. |

Curator runtime (`agents/curator/src/config.ts`), besides its feedback
settings:

| Variable | From | Meaning |
| --- | --- | --- |
| `UPSTREAM_REPOS_JSON` | `upstreamRepos` | As for the decay Lambda. |
| `CHECK_PROMPT_S3_KEY` | the stack | `curator/skill-check.md`, which the stack uploads. A missing object stops the runtime at boot; an unset key makes every flagged skill end inconclusive. The runtime depends on the upload of `prompt.md`, `skill.md` and `skill-check.md`, so a new runtime version never starts before the objects exist. |
| `CHECK_MAX_ROUNDS`, `CHECK_APPLY_EDITS`, `RETIRE_SKILLS`, `CHECK_OPEN_PULL_REQUESTS` | `skillLifecycle` | Unset: 25 and `false`. |
| `SKILLS_REPO`, `SKILLS_REPO_BASE_BRANCH`, `SKILLS_REPO_SIGN_OFF`, `SKILLS_REPO_TOKEN_FUNCTION` | `skillsRepo` and the broker | Set only with `skillsRepo` (`SKILLS_REPO_SIGN_OFF` only with `signOff`). With `CHECK_OPEN_PULL_REQUESTS=true` and `SKILLS_REPO` set, a missing token function stops the runtime at boot. |
| `SKILL_CHECK_DIR` | not set | Where checkouts are made; default `/tmp/skill-check`. |

### Log lines to watch

| Line | Meaning |
| --- | --- |
| `[release] <repo>: GET releases returned 403` (or `failed`) | No release trigger that day, usually the anonymous rate limit on shared Lambda addresses. Checks catch up on a later day. |
| `[decay] CURATOR_QUEUE_URL is not set` | The decay Lambda queues nothing. |
| `[decay] reserved-bucket ...` | An item in a `#` bucket that is not the repo skill item; left alone. |
| `[maintenance] retire-refused <name> status=<s>` | The registry refused a deprecation. The record is not asked again for `retireRefusedBackoffDays`. |
| `[maintenance] base-unavailable` | The last check's commit could not be fetched; the check cannot confirm. |
| `[maintenance] partial-advance` | A check confirmed after 2 checks in a row whose diff was read only in part. |
| `[submit_skill] ... is still marked retired while its skill ... is live` | A re-publication was not recorded. The next reinforcement finishes it. |
| `[auto-review] ... cap=<n> reached; skipped` | A pull request used its automatic reviews (`maxAutomaticReviewsPerPr`). |
| `[auto-review] ... released <key> and gave back its round in case that review is skipped` | The pull request was closed, or turned back into a draft, while a review waited. |
| `[auto-review] ... round=<n>/<cap> taken again by the waiting review` | It came back before that review started, so the review runs and counts. |
| `[watchdog] ... waited for <run key> ... past the run budget ...; running it anyway` | A review waited for another review of its pull request until its run budget was used up. A run key that keeps showing up here is a run that does not end or a forged heartbeat record ([SECURITY.md](../SECURITY.md#what-a-deployment-holds)). |
| `decision=skipped:mention:fix-claim-outside-app-thread` | A reply of only "done", "fixed" or "updated" in a review thread the App did not start. Nothing runs. |
| `decision=err:mention:parent-fetch-failed` | The thread's first comment could not be read for such a reply. The delivery got 500 and can be redelivered. |
| `[pending] ... could not clear` | A pending marker stays until it expires, and automatic reviews of that pull request are skipped until then. |

## Operational limits

These are constants in `lib/webhook-stack.ts`, except the session limits,
which are in `lib/valkey-review-agent-stack.ts`, and the skill lifecycle
limits, which are in the code named below:

- Review workers: at most 5 concurrent per route. Curator worker: at most 2,
  shared by maintainer feedback and skill maintenance. The decay job spaces
  each reviewer's check messages 60 seconds apart (at most 900 seconds,
  the SQS limit) so they do not crowd out feedback.
- Reviewer runtime sessions: 15-minute idle timeout and 2-hour maximum
  lifetime. While a review runs, the runtime reports `HealthyBusy` on
  `/ping`, so the idle timeout does not stop it after the worker has
  gone. The 2-hour limit is above the 90-minute run budget and ends a
  session that hangs. The curator runtime keeps AgentCore's defaults, and
  reports `HealthyBusy` only while a skill maintenance run is in progress.
- Receiver: 10 reserved concurrent executions. Reserving concurrency needs
  enough unreserved account concurrency; a new account with a low Lambda
  quota may need an increase first.
- HTTP API: 20 requests per second, burst 40. GitHub does not retry a
  throttled delivery by itself; you can redeliver it from the App's
  advanced settings.
- Dead-letter queues: a review queue message moves to its dead-letter
  queue after 8 receives (`maxReceiveCount: 8`), and a curator message
  after 3 (`maxReceiveCount: 3`). The stack outputs each dead-letter
  queue name; alarm on `AWS/SQS` `ApproximateNumberOfMessagesVisible`
  above 0 for those queues.
  - Reviews often outlive the 15-minute worker. The runtime keeps working
    after the worker times out, and the worker uses redelivery as a
    watchdog. The queue hides a message for 16 minutes, so it comes back
    every 16 minutes. On each receive after the first, the worker reads
    the run heartbeat. It acks a finished run, waits again for a live
    one, and retries a dead one on the fallback model. A message older
    than the run budget (`RUN_BUDGET_MINUTES`, default 90, in
    `webhook/src/config.ts`) is acked and dropped. A healthy long review
    is therefore received at most `ceil(90 / 16) + 1 = 7` times. The
    limit of 8 leaves one spare receive, so the run budget ends the
    message instead of the dead-letter queue. A review that waited for
    another review of its pull request until the budget was used up runs
    at that receive, the seventh at most, and the next receive acks it.
  - The curator has no watchdog. Each receive invokes it again. Three
    receives give a feedback event or a maintenance message two retries
    for a passing failure, such as throttling, and then stop one that
    keeps failing from spending more model calls. A maintenance message
    that dead-letters keeps its claim on the record, so the decay job asks
    again after 7 days.
- Automatic reviews (`webhook/src/store.ts`): a pending marker expires an
  hour after its review's queue delay or the worker's latest extension, and
  a pull request's round counter 180 days after its latest automatic
  review.
- Skill maintenance requests (`ops/src/decay.ts`): a record with a request
  younger than 7 days gets no new one, so a check that keeps its claim
  (inconclusive) runs again after 7 days. The decay Lambda has 5 minutes.
- One skill check (`agents/curator/src/maintenance.ts` and
  `agents/common/src/skill-check/`):
  - the audit ends after `skillLifecycle.maxCheckRounds` tool rounds or 12
    minutes from the start of the run, below the worker's 15;
  - each git call has 10 minutes, the base fetch and its blob batch 3
    minutes each, and git output is capped at 64 MiB per call;
  - at most 300 cited names per skill, looked up 10 `git grep` patterns per
    call, 4 calls at a time;
  - a touched name has at most 40 occurrences at the tip; diffs are read
    200 files per call, at most 4 MiB per call and 64 MiB per check; the
    audit sees at most 3 hunks per name and 24,000 characters of excerpts;
  - at most 6 edits, each 1 to 5 whole lines and 800 characters with 1 to
    5 cited lines, at most 4,000 characters of growth, and 40,000
    characters for the edited registry skill; the audit's report is
    refused at most 2 times;
  - the record keeps at most 300 `audit_names`, 100 `ignored_names` and 50
    `stale_names`, a 500-character `check_note` and a 400-character
    summary in `pending_revision`;
  - 2 checks in a row whose diff was read only in part let the third
    confirm.
- The GitHub releases API is read without credentials, once per distinct
  upstream per pass, with a 10 second timeout. Unauthenticated requests
  are limited per source address, and Lambda addresses are shared, so a
  lookup can fail on some days; checks then catch up later.
