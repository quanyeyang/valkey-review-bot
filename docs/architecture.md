# Architecture

This document describes how the reviewer works, following the code. Paths are
relative to the repository root. Deployment settings are documented in the
[configuration reference](../infra/README.md#configuration-reference), Lambda
environment variables in [webhook/README.md](../webhook/README.md), and the
security model in [SECURITY.md](../SECURITY.md).

## 1. Components and flows

| Component | Code | Runs as |
| --- | --- | --- |
| Receiver | `webhook/src/receiver.ts`, logic in `webhook/src/delivery.ts` | Lambda behind an API Gateway HTTP API (`POST /webhook`) |
| Invoker | `webhook/src/invoker.ts`, `webhook/src/watchdog.ts` | One Lambda per review route and one for the curator, each fed by its own SQS queue |
| Token broker | `webhook/src/token-broker.ts`, checks in `webhook/src/broker.ts` | One Lambda per reviewer, invoked by that reviewer's runtime |
| Skills-repo token broker | `webhook/src/skills-repo-broker.ts` | One Lambda, created when `skillsRepo` is set, invoked by the curator only |
| Ready-label reconciler | `webhook/src/ready-label-broker.ts`, logic in `webhook/src/ready-label.ts` | One Lambda, created when a route sets `readyLabel`, invoked by reviewer runtimes and the receiver. Never returns a token. |
| Reviewers | `agents/common`, plus `agents/valkey-review` or `agents/valkey-glide-review` | One Bedrock AgentCore runtime and container image per reviewer |
| Curator | `agents/curator`: feedback in `src/agent.ts`, skill maintenance in `src/maintenance.ts` | Its own AgentCore runtime |
| Decay job and skill-maintenance scheduler | `ops/src/decay.ts`, `ops/src/releases.ts` | Lambda on a daily EventBridge schedule |
| Infrastructure | `infra/lib/*.ts` | CDK app; the stacks are listed in [infra/README.md](../infra/README.md#stacks) |

```text
GitHub App webhook
  |
  v
HTTP API -> receiver -+-> route queue -> route worker -> reviewer runtime -> GitHub (review, state comment)
                      |   (one per route)    ^               |    |
                      |                      |               |    +-> token broker (repo-scoped token)
                      |                      |               |    +-> ready-label Lambda (issues:write, never returned)
                      |                      +-- heartbeat --+
                      |                          table
                      |
                      +-> curator queue -> curator worker -> curator runtime -> concerns table
                                ^                                    |       -> reviewer's skills registry
                                |                                    +-> upstream default branch (anonymous git fetch)
  decay job (daily) ------------+                                    +-> skills-repo broker -> pull request on the bot repository
  (concerns tables, GitHub releases API)
```

### Automatic pull request review

1. A pull request on a review route is opened, reopened or gets new
   commits (`synchronize`), or, on a `skipDrafts` route, is marked ready for
   review. GitHub sends a `pull_request` delivery to the HTTP API.
2. The receiver checks the signature, applies the route's gates, claims the
   idempotency key, takes the pull request's pending marker and one of its
   automatic review rounds, and takes a slot from the route's daily budget
   (`pullRequest` in `webhook/src/delivery.ts`). It sends a review envelope
   (`webhook/src/review-envelope.ts`) to the route's queue, with an SQS
   delay when new commits started it.
3. The route's worker waits while another review of the same pull request
   runs, at most until the review's run budget is used up. Then it writes
   the run's start record, removes the pending marker, calls
   `InvokeAgentRuntime` on the route's reviewer runtime with the envelope
   as the payload and reads the event stream (`handleOne` in
   `webhook/src/invoker.ts`).
4. The runtime (`bootstrap` in `agents/common/src/run-agent.ts`) starts a
   heartbeat record, gets a token from its token broker and reads the pull
   request. If the pull request was closed or merged since, or is a draft
   on a `skipDrafts` route, the run ends there, posts nothing and is
   recorded completed. Otherwise it fetches the pull request into the clone
   in its image, loads graduated skills and runs the model with its tools.
5. The model ends with `post_review` (a `COMMENT` review with inline
   comments) or `skip_review`. Both rewrite the pull request's review state
   comment. After a successful write, the runtime invokes the ready-label
   Lambda when `READY_LABEL_FUNCTION` is set. New commits, draft/close/
   reopen, thread resolve/unresolve, a human reply on a review comment
   (created or deleted), and an issue comment on the pull request also
   invoke it from the receiver, including when review routing returned
   500. The function adds the configured label when the PR is open and
   not a draft, this App has a completed review at the current head,
   every thread this App started is resolved or has a later human reply,
   and any PR-wide concern has been answered; the agent may still say
   needs_work. Otherwise it removes that label.
6. The runtime marks the heartbeat `completed` and sends a `done` event, and
   SQS deletes the message. If the worker's 15 minute limit ends its read
   first, later receives of the message decide from the heartbeat whether to
   wait, stop or retry (section 3).

### Review on @mention

1. A user tags the bot (`@<app-slug>`) in a pull request comment or a review
   comment. GitHub sends `issue_comment` or `pull_request_review_comment`
   with action `created`.
2. The receiver detects the tag (`detectMention` in `webhook/src/mention.ts`),
   requires a review route and push permission, claims the comment, reads the
   pull request (it must be open) and posts an acknowledgement comment.
3. The instruction (the comment without the tag) goes through a safety check
   on a Bedrock model. A denial edits the acknowledgement into a decline and
   nothing is queued.
4. The envelope adds the instruction, the requester, the acknowledgement
   comment id (`status_comment_id`), a run nonce and, for inline tags, the
   file and line. It goes to the route's queue and does not use the daily
   budget.
5. The worker and runtime proceed as above. The runtime turns the
   acknowledgement into a status comment, puts the instruction in the first
   message as the main directive, and replaces the status comment with its
   reply at the end.
6. A tag in a reply inside a review thread starts a run only on routes with
   `threadReplyReview`. If the App started that thread, the instruction quotes
   the App's comment and asks the run to answer the reply from the code at
   the current head: verify a claimed fix (confirm it, or say what remains),
   re-check a disputed finding (withdraw it if the reply is right, or show
   the evidence), or answer a question. In a thread someone else started the
   reply is an ordinary summons, except a reply that only says "done",
   "fixed" or "updated", which starts nothing there. The reply is handled as
   feedback either way.

### Curator feedback

1. An owner, member or collaborator comments on a pull request, replies in a
   review thread or submits a review.
2. The receiver drops summons, untrusted authors, unrouted repositories and
   noise (`extractFeedback` in `webhook/src/feedback.ts`,
   `classifyCommentBody` in `webhook/src/heuristics.ts`). For a thread reply
   it reads the thread's first comment and attaches it when the App wrote it.
3. It claims the feedback id and sends a curator envelope to the curator
   queue.
4. The curator worker invokes the curator runtime
   (`agents/curator/src/agent.ts`). The runtime repeats the trust check, binds
   its tools to the reviewer's concerns table and skills registry, and runs
   the model.
5. The model makes at most one change to the concerns store. When the record
   it reinforced has enough reinforcements, it publishes the record as a skill
   to the reviewer's registry, and every later review loads it. A correction
   to a graduated record (`update_concern`) can publish a new text of its
   live skill, starting from the published one (`get_skill`).

### Skill maintenance

1. Once a day the decay job (`ops/src/decay.ts`) reads the highest GA
   release of each reviewer's upstream from the GitHub releases API,
   without credentials (`latestReleaseTag` in `ops/src/releases.ts`).
2. It scans each concerns table, decays every score, deletes records that
   never graduated once they fall below the floor, and picks the graduated
   skills that are due for a check or a retirement.
3. Within per-reviewer caps it claims each one on its record and sends a
   maintenance message to the curator queue: `check` for a registry skill,
   `retire`, or once per release `repo_check` for the reviewer's skill file
   in this repository.
4. The curator worker invokes the curator runtime, which runs the message
   (`handleMaintenance` in `agents/curator/src/maintenance.ts`). A check
   fetches the upstream default branch into a fresh directory and looks up
   the names the skill cites. Only when names are flagged does a bounded,
   read-only model audit run.
5. Depending on the outcome and the settings, the curator records the
   result, edits the registry skill in suppress-and-add form, deprecates a
   retired skill, or opens a pull request against the bot's repository for
   a repo skill file. Every run logs `[maintenance]` report lines
   (section 6).

## 2. The receiver

### Signature check

`verifySignature` (`webhook/src/signature.ts`) computes the HMAC-SHA256 of
the raw body bytes with `webhook_secret` and compares it with
`X-Hub-Signature-256` in constant time. The secret is cached for five minutes
(`createAppSecretSource` in `webhook/src/github.ts`). On a mismatch the
receiver fetches it again, at most once a minute, so a rotated secret is
picked up without letting forged requests drive Secrets Manager calls. A bad
signature gets 401. Payload fields are logged only after the signature
checks out; each delivery logs one `[delivery]` line with a `decision=` value,
which `scripts/dump-hour.sh` summarizes.

### Events and actions

`dispatch` in `webhook/src/delivery.ts`:

- `ping`: answered with 200.
- `pull_request`: the automatic review path. `opened`, `reopened`,
  `synchronize` (new commits) and `ready_for_review` can start a review.
  `closed`, and `converted_to_draft` on a `skipDrafts` route, never review;
  while a review waits they release the key of a later reopen or
  `ready_for_review` at that head (`pullRequestLeft`), so that event is not
  dropped as a duplicate if the waiting review is skipped, and give back
  the waiting review's round.
- `issue_comment` and `pull_request_review_comment`: @mention detection,
  then the feedback path.
- `pull_request_review`: the feedback path only (action `submitted`). A tag
  in a review body does not start a review.
- Anything else is skipped with 200. A payload without a repository or an
  installation id (from the payload, or `INSTALLATION_ID`), or one that is not
  JSON, gets 400. A failure to queue or any unexpected error gets 500.

A user counts as a bot (`botMatcher` in `webhook/src/config.ts`) when its type
is `Bot`, its login ends in `[bot]`, it is the App's own login, or it is on the
known-bots list. The same test applies to pull request authors, mention
authors and feedback authors.

### Gates for automatic reviews

In order (`pullRequest`):

1. The action is one of the four above.
2. The pull request author is not a bot.
3. The repository has a review route (case-insensitive).
4. The route is not `mentionOnly`.
5. Drafts: on `skipDrafts` routes a draft is skipped when opened or pushed
   to, and reviewed on `ready_for_review`. Other routes review on open and
   on new commits, draft or not, and ignore `ready_for_review`.
6. When the route's `authorAllowlist` is not empty, the author is on it.
7. The idempotency key is new.
8. No other automatic review of the pull request waits: the receiver takes
   the pull request's pending marker (`markReviewPending` in
   `webhook/src/store.ts`). When another review holds it, this event joins
   that review and is skipped as `auto-review-pending`.
9. The pull request has an automatic review round left
   (`takeAutoReview`), else `auto-review-cap`.
10. The route's daily budget has a slot.

The pending marker, `pending#owner/name#pr`, is a conditional put with a
random id. The review holds it from step 8 until its worker starts the run,
so at most one automatic review of a pull request waits at a time. A push,
reopen or `ready_for_review` while it waits uses no round or budget, and
the run reviews the head the pull request has when it starts. A review of
new commits waits in the queue for `PUSH_REVIEW_DELAY_SECONDS` (default 300,
at most 900), so a burst of pushes becomes one review. The marker expires
an hour after that delay, or after the worker's latest extension, in case
no worker removes it.

The round counter, `autoreviews#owner/name#pr`, is an atomic `ADD`
conditioned on the count being below `MAX_AUTOMATIC_REVIEWS_PER_PR`
(default 3, 1 to 20), counting the first review. It expires 180 days after
the pull request's latest automatic review. @mentions and thread replies
take no round. Open pull requests at the time of the deploy start with no
counter, so one an earlier version reviewed when it opened can get the cap
in reviews of new commits on top of that review
([Upgrading](../infra/README.md#upgrading-a-deployment-that-already-reviews-pull-requests)).

A review that is not queued (at the cap, at the budget, or on a failed
send) gives back what it took, newest first: the round, the marker and the
idempotency key. A send that errors after SQS accepted the message gives them back for
a review that still runs, so the pull request can get one review more than
the cap.

A queued review that the runtime is going to skip gives back its round,
but not its budget slot. When `closed`, or `converted_to_draft` on a
`skipDrafts` route, finds a review waiting, `pullRequestLeft` sets
`roundGivenBack` on the pending marker (`markRoundGivenBack`, conditional,
so once per marker) and returns the round. An event that later joins the
waiting review clears the mark and takes the round again
(`clearRoundGivenBack`), since the pull request is back and the review
runs. The worker gives nothing back: a review it gives up on, past the run
budget or in the dead-letter queue, keeps its round and slot, because the
worker's grant on the idempotency table covers `pending#` keys only. In
the seconds between the worker starting a review and the runtime reading
the pull request, a leaving event finds no review waiting, so a review the
runtime then skips keeps its round; and a pull request that left while the
review waited and comes back in those seconds gets that review without a
round.

### Gates for @mentions

`detectMention` accepts a created comment whose author is not a bot and that
tags the bot outside quotes and code (`mentionPattern` matches `@` plus the
login without `[bot]`, at a word boundary). After the tag is removed the
comment must be more than an acknowledgement or emoji. An `issue_comment`
must be on a pull request. A review comment with `in_reply_to_id` is a thread
reply; anything else is a summons. A thread reply that only says "done",
"fixed" or "updated" (`FIX_CLAIM_RE`) is not taken for an acknowledgement but
marked as a fix claim (`fixClaim`): it starts a run only in a thread the App
started, and is skipped as `mention:fix-claim-outside-app-thread` in any
other, before any acknowledgement is posted.

`handleMention` and `startRun` then check, in order: a review route exists
(summons on other repositories are dropped; thread replies run only on
`threadReplyReview` routes), the author has push permission (the collaborator
permission endpoint; any failure counts as no permission, and an
unauthorized tag gets no reply), the claim `mention#<surface>-<comment id>`
is new, and the pull request is open.

The safety gate (`createSafetyGate`) sends at most 4,000 characters of
instruction to the model in `HAIKU_MODEL_ID` through Converse, between two
random marker lines, with a 5 second timeout. No verdict, an unparsable
verdict, an error or a timeout all deny. The gate allows a reply that says one
of the bot's findings is fixed, argues that it is wrong or asks about it,
unless part of the reply attempts something it denies. A bare tag has no
instruction, skips the gate, and gets a standard full review. Failures a redelivery could fix
(reading the pull request, reading the thread's first comment for a fix
claim, posting the acknowledgement, queuing) release the claim and return
500; a failed queue send also edits the acknowledgement to say so.

### Daily review budget

`takeReviewSlot` (`webhook/src/store.ts`) increments the item
`budget#<route id>#<YYYY-MM-DD>` (UTC) in the idempotency table, on condition
that it is below `DAILY_REVIEW_BUDGET` (default 40; 0 pauses automatic
reviews). The slot is taken after the idempotency claim, the pending marker
and the round. When the budget is used up, all three are given back, so a
redelivery after the day resets can still review. A slot whose queue send
then fails is not returned. Only automatic reviews count, reviews of new
commits included. An event that joins a waiting review, or meets the cap,
takes no slot.

### Idempotency

`claim` is a conditional put on `key` with a 24 hour TTL. The keys are:

- `owner/name#<pr>#<head sha>` for automatic reviews, with `#reopened`,
  `#ready` or `#push` appended for a reopen, `ready_for_review` and new
  commits. Each trigger has its own key, so the review one trigger asks
  for is never dropped as the duplicate of another trigger's review of the
  same head. The cost: the first reopen at a head that was already
  reviewed reviews it again and uses a round;
- `mention#issue_comment-<id>` or `mention#review_comment-<id>`;
- `curator#rc-<id>`, `curator#ic-<id>` or `curator#pr-<id>` for review
  comments, issue comments and reviews.

An existing key is a duplicate and is skipped with 200. When the work cannot
be queued, the key is released and the receiver answers 500. GitHub does not
retry failed deliveries; an operator can redeliver from the App's advanced
settings. The same table also holds the daily budget counters, the round
counters and the pending markers described above; none of them is a claim.

### Feedback forwarded to the curator

A delivery reaches the curator queue only when all of these hold:

- It is a created `issue_comment` on a pull request, a created
  `pull_request_review_comment`, or a submitted `pull_request_review`. Edits
  and deletions never count.
- The author has a login, is not a bot, and has `author_association` `OWNER`,
  `MEMBER` or `COLLABORATOR`.
- It is not a summons. A thread reply that started a run still counts.
- The repository has a curator route: every review route plus the
  `curatorOnlyRoutes`.
- `classifyCommentBody` does not call it noise. It drops empty text,
  acknowledgements, "same"/"ditto", emoji-only and URL-only comments, test
  markers, mostly quoted replies, short @pings, and anything with fewer than
  four words of the author's own prose. A `?` in that prose or a suggestion
  block keeps a comment regardless of the quote, ping and length rules.
- For a thread reply, the receiver reads the thread's first comment. A reply
  by the pull request author in a thread the App did not start is dropped
  (`isAuthorReplyOutsideBotThread`). When the App started the thread, its
  comment goes into the envelope. If the lookup fails, the reply is forwarded
  without it.

## 3. Queues and the invoker

### Queues and workers

`infra/lib/webhook-stack.ts` gives each review route its own SQS queue,
dead-letter queue and worker, and the curator one of each, so a backlog on one
route does not hold up another. Workers take one message at a time, report
partial batch failures, and run for at most 15 minutes. Queues use a 16 minute
visibility timeout and 14 day retention. Concurrency limits are listed under
[Operational limits](../infra/README.md#operational-limits).

The worker forwards the message body unchanged (adding `use_fallback_model`
on a retry) to `InvokeAgentRuntime` and reads the server-sent event stream to
the end. It logs `tool_use`, `status` and `error` frames; only a `done` frame
counts as success. A stream that closes without one is an error, so the
message returns after the visibility timeout.

### Heartbeat watchdog

The runtime writes one item per run to the heartbeat table (`createHeartbeat`
in `agents/common/src/heartbeat.ts`): `last_activity` in milliseconds,
`status` (`running`, `completed` or `failed`), the model, and a 24 hour TTL.
It writes at most once a minute while agent events arrive, writes
`completed` as soon as a terminal tool succeeds, and writes the final status
after any write still in flight. The key is
`owner/name#<pr>#<head sha>`, plus `#<nonce>` when the envelope has one:
`reopened` for a reopen, `ready` for a draft marked ready, `push` for new
commits, `m<comment id>` for an @mention run. The nonce keeps a completed
automatic review from making the watchdog drop a later run on the same head.
`heartbeatRunKey` in `webhook/src/review-envelope.ts` and the run key in
`run-agent.ts` must produce the same string.

The worker writes the first record of a run itself, just before it invokes
the runtime: status `running`, `last_activity` and the SQS message id, with
a conditional `UpdateItem` that is refused while the key holds a fresh
running record (fresh as defined below) or a completed one this message
wrote (`claimRunStart` in `webhook/src/invoker.ts`). So another review of
the pull request sees the run at once, not only after the runtime's first
heartbeat, and only one
receive of a message starts the run. A receive that loses is left on the
queue and decides from the heartbeat at its next receive. The runtime's own
writes keep the message id.

An automatic review does not start while another review of the same pull
request runs, so two automatic runs of a pull request do not overlap. Before
it runs, on any attempt, the worker scans the heartbeat table for the
running records whose key starts with `owner/name#<pr>#`. While one is fresh,
the message waits like a live run of its own, and the worker moves its
pending marker's expiry to an hour from then, so later events keep joining
it. Once the message is older than the run budget it stops waiting and
runs, with the warning `[watchdog] ... waited for <run key> ... past the
run budget ...; running it anyway`, so a run that never ends cannot hold
the pull request's automatic reviews back for good. @mention runs, thread
replies included, never wait: a maintainer is watching their status
comment.

Any reviewer runtime can write any heartbeat record, and code from a pull
request can use a reviewer runtime's role ([SECURITY.md](../SECURITY.md)).
So a record is fresh only when a run could have written it (`isFresh` in
`webhook/src/watchdog.ts`): its `last_activity` is no older than
`HEARTBEAT_STALE_MINUTES` and at most 60 seconds (`CLOCK_SKEW_MS`) ahead
of the worker's clock, and its `ttl` is set and at most 24 hours plus 60
seconds ahead. The scan, the check of the review's own record and
`claimRunStart`'s condition all apply this test, so a forged record counts
as live only while something keeps rewriting it.

A worker stops reading when its 15 minute limit ends, and the message comes
back after the visibility timeout. For a review message, `decide` in
`webhook/src/watchdog.ts` returns:

- first receive, a later receive that still holds its pending marker, a
  run key with no record, or a start record with another message's
  `message_id` (the review never ran): invoke on the primary model, at any
  age. Another message's record can be an earlier run of a reopen or ready
  key that was released and used again;
- heartbeat `completed`: delete, at any age;
- message older than the run budget (from `SentTimestamp`): delete it and log
  `[abandoned]`;
- no `last_activity`, status `failed`, last activity older than
  `HEARTBEAT_STALE_MINUTES` (default 12), or a record that is not fresh:
  invoke again on the fallback model;
- otherwise the run is alive: report the message as failed without invoking,
  and check again after the next visibility timeout.

A record without `message_id`, from before start records or from a worker
that may not write them, is judged by its heartbeat alone. An invoke of an
automatic review then still waits for another live run of the pull
request, as above.

A review worker without `HEARTBEAT_TABLE` refuses every message, because
every redelivery would otherwise look like a dead run.

### Primary and fallback model

The first attempt runs on `BEDROCK_MODEL_ID`, and so does a later receive
of a review that never ran. Every attempt the watchdog starts after a dead
run sets `use_fallback_model`, and the runtime switches to
`FALLBACK_MODEL_ID`. Slowness alone never triggers this, only a failed or
stale heartbeat, a record with no `last_activity`, or one that is not
fresh. Within one attempt the reviewer retries transient model errors on
the same model (section 4). The curator works differently: it
falls back per model call inside one invocation (section 6).

### Run budget and dead-letter queues

`RUN_BUDGET_MINUTES` defaults to 90 and is not overridden by the CDK app. It
counts from the message's `SentTimestamp`, so the push delay and any wait for
another review come out of it: a review still waiting for another run at
the end of the budget runs then, with a warning, and one that starts late
is watched only until the budget ends. With a 16 minute visibility timeout
a healthy long review is received at most seven times, so review queues
dead-letter after eight receives. Curator
messages have no heartbeat: every receive invokes the curator, the curator
queue dead-letters after three receives, and the worker deletes a curator
message seen more than three times (which only happens without a redrive
policy). The webhook stack outputs every dead-letter queue name for alarms.

## 4. A review run inside the runtime

### Startup and model

When the container starts, `bootstrap` reads its settings (`loadEnv` in
`agents/common/src/config.ts`) and loads `prompt.md` and `skill.md` from the
assets bucket once. The base system prompt is the prompt, then a "Skill:
institutional memory" section with the skill file. Suppressed pieces in it
are labelled the same way as in graduated skills (`baseSystemPrompt`; see
[Publishing skills](#publishing-skills-to-aws-agent-registry)).

Each invocation validates the payload against `requestSchema` and picks the
model. IDs that start with `openai.` go through the Bedrock Mantle
OpenAI-compatible endpoint in `MANTLE_REGION` (`createMantleModel` in
`agents/common/src/models.ts`); any other ID goes through Converse
(`createConverseModel`). Both get `REASONING_EFFORT` and `MAX_TOKENS`. The run
then writes its first heartbeat, gets a token (failing at once if the broker
refuses), opens the status comment on @mention runs, prepares the workspace,
loads graduated skills, assembles the tools and starts the loop.

### Workspace preparation

`prepareWorkspace` in `agents/common/src/workspace.ts`:

- Works in the clone baked into the image (`/workspace/valkey` or
  `/workspace/valkey-glide`, cloned with `--filter=blob:limit=1m`). A warm
  container is reused across runs, so the clone may hold the previous run's
  state.
- Reads the pull request. An automatic review (the envelope has a
  `trigger`) stops here when the pull request is no longer open, or is a
  draft and `skip_drafts` is set (`automaticReviewSkipReason`); the run
  posts nothing and is recorded completed. An automatic review can wait a
  long time first: the push delay, and any other review of the pull
  request. @mention runs go ahead in any state.
- Then runs the git work in parallel with listing
  reviews, review comments, issue comments and changed files (at most 3,000).
- Points `origin` at the pull request's base repository with a URL that holds
  no credentials, force-fetches `pull/<n>/head`, runs `git reset --hard` and
  `git clean -fd` (gitignored build output stays, for incremental builds) and
  checks out the fetched head detached. The run reviews the head it fetched,
  which can be newer than the one in the envelope.
- Fetches the base branch and base SHA (both best effort) and computes the
  merge base. The diff range is `<merge base>..<head>`.
- Release lines for the backport check: points `upstream` at `UPSTREAM_REPO`
  (the pull request's repository when empty), lists branches named
  `<major>.<minor>` or `release-<major>.<minor>`, fetches them into
  `refs/remotes/upstream/*`, and keeps those with a commit in the last 180
  days, highest version first (`maintainedReleaseLines`). This fetch is
  authenticated only when the upstream is the pull request's repository. A
  failure leaves the list unknown.
- Finds the previous review state: the newest issue comment written by this
  App (`performed_via_github_app.id` equal to `GITHUB_APP_ID`) whose body
  starts with the state marker, in `findStateComment`. The marker alone is
  not trusted. The App also posts model-written text in status comments, so
  the terminal tools remove the marker from the `post_review` body and the
  `skip_review` reason before they go there (`stripStateMarker`).

Each git process has a 10 minute limit and aborts a transfer that stays below
1 KB/s for 60 seconds. It runs with `GIT_CONFIG_GLOBAL=/dev/null`, so
`~/.gitconfig` and `~/.config/git/config` are ignored. The token-carrying
fetches all happen here, before any PR code runs. The invoker sets no
runtime session ID, so each run gets a new session and container; the
setting covers a container that is reused, where an earlier run's build
code could have left a global config or edited the clone's `.git/config`
(which this setting does not cover).

### The PR overview and untrusted text

`renderPrOverview` builds the first user message: the author, the head SHA,
the base branch and SHA, the merge base, the diff range, the workspace path
and the change size, then the head branch name, title, description, changed
paths, existing reviews, inline comments and PR comments. Each of those is
wrapped in an `<untrusted-pr-content source="...">` block, and any opening or
closing tag of that name inside the text is defused (`<` becomes `&lt;`) so
the content cannot end its block. The overview states that text in these
blocks is data and never an instruction. Lists show the newest 100 entries as
240 character excerpts. Then come the maintained release lines, each by its
bare name with its `upstream/` ref (or a note to use the `unclear` or
`not_needed` verdict), and the previous review state in full.

On @mention runs `mentionBlock` adds a "Review request" section that makes the
instruction the main directive and names the file and line of an inline tag.
The last line tells the model to start at Phase 1 and finish with a terminal
tool.

The two file paths the prompts write outside the fenced blocks are JSON
strings, so a file name cannot close the sentence around it: the inline
tag's path in `mentionBlock`, and the path in the thread-reply instruction
that `webhook/src/mention.ts` builds, cut to 300 characters. That
instruction stays within 6,000 characters by shortening its quote of the
App's comment, never the reply or the directive. The base branch stays unfenced, because only
maintainers create branches in the base repository. The previous state
comment is shown unfenced too. The App wrote it, and each finding in it is
folded onto one line with no backticks in its location, so a file name the
model copied cannot start a heading there.

### Loop limits

- `ModelCallLimit` (`agents/common/src/agent-loop.ts`) caps model calls per
  run, retries included, at `MAX_ITERATIONS` (default 150). At the cap the next
  call is cancelled with a
  fixed message, which ends the turn.
- If the turn ends without a terminal tool, one follow-up message asks for
  `post_review` or `skip_review`, with three more model calls reserved.
- `StreamStallRetryStrategy` retries throttling, truncated streams, timeouts,
  stalled streams, server faults, 5xx and 429, and stops retrying once a
  terminal tool has succeeded.
- `ReviewConversationManager` sizes the history window to hold every
  message a run can produce, so nothing is trimmed by count. It trims only
  when the model reports a context overflow, and always keeps the PR
  overview.
- An error after a successful terminal tool counts as completion, so the
  watchdog does not post a second review. A run that ends without one fails:
  the heartbeat says `failed` and the next receive retries on the fallback
  model.
- A review outlives the 15-minute worker that started it, so once the model
  turns have started a closed stream does not stop it. `createReviewHandler`
  relays the model's frames by hand, so closing the handler does not close
  the agent stream under it. When the stream is closed, at any frame, the
  handler runs the remaining model turns to the end itself, including the
  terminal-retry turn, without relaying events. A close before that, during
  the token request, workspace preparation, skill loading or tool assembly,
  ends the run as `failed`.
  The heartbeat also beats from agent hooks (before each model call and
  after each tool call), so the watchdog still sees a live run. When the
  handler exits, the run is recorded as `completed` if a terminal tool
  succeeded and `failed` otherwise. A drained run that ends without one
  logs its model call count and the first 400 characters of its final
  text; one that ends in an error logs the error.
- While a run is in progress, `asBusyTask` keeps it registered as an async
  task of the `BedrockAgentCoreApp`, so the runtime's `/ping` reports
  `HealthyBusy` and AgentCore does not stop the session at its 15-minute
  idle timeout after the worker has gone. The reviewer runtimes end a
  session two hours after it starts at the latest (`lifecycleConfiguration`
  in `infra/lib/valkey-review-agent-stack.ts`), above the watchdog's
  90-minute run budget. The curator reports `HealthyBusy` during
  maintenance runs only, and has no lifecycle configuration (section 6).

### Tools

There is no shell tool. `assembleCommonTools` (`agents/common/src/tools/index.ts`)
builds the common set, and each reviewer adds its build tool when
`ALLOW_BUILD` is true. The GLIDE reviewer removes `lsp`, because its image has
no language server.

| Tool | Code | What it is limited to |
| --- | --- | --- |
| `read`, `grep`, `glob` | `tools/harness.ts` | Files under the workspace root. Paths matching `.env*`, `.aws/`, `id_rsa*`, `*.pem`, `*.key`, `node_modules/` and `.git/` are refused as a `read` target or a search root, and `grep` drops matches in such files. `glob` checks only its search root, so it can still list the names of matching files. |
| `lsp` (Valkey) | `tools/harness.ts` | clangd for `.c` and `.h`, from a fixed manifest. A `.lsp.json` in the checkout is ignored. There is no compilation database, so `references` and `workspaceSymbol` cover only the files clangd has opened and the headers they include; the prompt finds callers with `git grep`. |
| `write`, `edit`, `multi_edit` | `tools/harness.ts` | Only when `ALLOW_WRITE` is true; workspace files only. A target whose real location (the realpath of its nearest existing ancestor) is outside the workspace or matches the refused patterns, for example `.git/` reached through a symlink, is refused. For testing assumptions; nothing is committed or pushed, and the next run resets the tree. |
| `git` | `tools/git.ts` | Read-only subcommands (`log`, `show`, `blame`, `diff`, `status`, `rev-parse`, `rev-list`, `cat-file`, `ls-tree`, `ls-files`, `grep`, `shortlog`, `describe`, `branch`, `tag`, `reflog`, `merge-base`, `name-rev`). `checkGitArgs` rejects options that write files, run helpers or pagers, read files outside the repository, or override config (`-c`); `git diff` refuses absolute paths and paths that climb out with `..`; `branch` and `tag` only list and `reflog` only reads. `--no-ext-diff` and `--no-textconv` are added. No credentials, no system or global gitconfig (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`), 60 seconds, 500 KB. |
| `gh_api_read` | `tools/gh.ts` | `GET` through `gh api`, only under `repos/<PR repository or upstream>/`, only for allowlisted pull request, review, comment, commit, contents and check-run endpoints (`checkGhApiPath`). Paths with `..`, `%`, backslashes, whitespace or `#` are refused. 30 seconds, 2 MB. |
| `post_review`, `skip_review` | `tools/gh.ts` | Terminal tools, described below. |
| `make` (Valkey) | `agents/valkey-review/src/tools/make.ts` | Targets `all`, `valkey-server`, `valkey-cli`, `valkey-benchmark`, `valkey-sentinel`, `test-unit`, `clean`, `Makefile.dep`; an allowlist of variables with a restricted character set; `-j` 1 to 16; run from the repository root or `src/`. 8 minutes, 1 MB (see below). |
| `build` (GLIDE) | `agents/valkey-glide-review/src/tools/build.ts` | `cargo`, `gradle` (`./gradlew`), `go`, `npm` and `npx`, each with allowed actions and blocked tokens (`checkBuildArgs` in `build-policy.ts`): no publish, install or login, exact Gradle task names only, `go mod` limited to `graph`, `verify` and `why`, no `npm run` script that rewrites sources or deletes lock files, and no `npx` option that writes files. Working directory inside the checkout. 8 minutes, 1 MB (see below). |

Paths under `tools/` are in `agents/common/src/tools/`. The tool tables in
each `config/prompt.md` describe the same set to the model.

`git`, `gh_api_read`, `make` and `build` run their command through
`runBounded` (`tools/spawn.ts`), in a process group of its own. The time and
output limits apply to everything in that group, such as sub-makes and test
binaries: at either limit the whole group gets SIGTERM, then SIGKILL after a
grace period (3 seconds for `make` and `build`, 2 seconds otherwise). A
process that starts its own session or group is not stopped.

### Review phases

Both reviewer prompts follow the same workflow headings:

- Phase 1: Orient (at most 5 tool calls)
- Phase 1b: Question the approach
- Phase 2: Select candidate claims
- Phase 3: Gather evidence
- Phase 4: Experiment
- Phase 4b: Backport check
- Phase 5: Compose and post
- The review state, then Completion criteria

The GLIDE prompt adds a "Grep hazards" section and two worked examples.

### Terminal tools

`post_review` and `skip_review` share one `TerminalGate`: one of them can
succeed per run, a second call (including a concurrent one) is refused, and a
call that wrote nothing gives the gate back so the model can retry. Both
validate their input before writing anything: text fields and the rendered
state are capped at 60,000 characters, and the state must pass
`validateReviewState`.

- `post_review` creates a review with event `COMMENT` at the head SHA the run
  checked out, with the inline comments. The bot cannot approve or request
  changes. On automatic runs a non-empty `body` becomes the review body. On
  @mention runs the body goes to the status comment instead, and no review
  object is created when there are no inline comments. It then writes the
  state comment.
- `skip_review` writes only the state comment.

A failed review submission gives the gate back. A failed state comment write
does not: it is reported in the result as `state_comment_error` and the call
still completes, so a run never ends without a terminal tool because of it.

A successful call reports back through `onTerminal`, which is how the run
knows the review is done. `run-agent.ts` refuses to start the loop if the
reviewer's `assembleTools` did not wire that callback.

### The review state comment

`agents/common/src/review-state.ts`. Each pull request has one state comment,
marked with `<!-- valkey-reviewer:state -->` and rewritten by every run. The
model fills `reviewStateSchema`:

- `status`: `needs_work` or `ready_for_human_review`;
- `summary`, `risk` (`low`, `medium`, `high`) and `risk_reason`;
- `findings`: location, summary, `blocking`, `resolved`; findings from the
  previous state are carried forward;
- `backport`: `verdict` (`needed`, `not_needed`, `unclear`), `branches`,
  `reason`;
- `direction`: an alternative approach, or empty.

`validateReviewState` rejects `ready_for_human_review` with open blocking
findings or a non-empty `direction`, and a `needed` backport with no branches
or with branches outside the maintained release lines found for this run.
`renderReviewState` produces the comment, so its shape is the same across runs
and models. `createStateCommentWriter` edits the previous comment, or creates
a new one when the old one returns 404 or a 403 that is not rate limiting; a
retried terminal call edits the comment the run already created.

### The status comment on @mention runs

`agents/common/src/status-comment.ts`. The runtime edits the receiver's
acknowledgement comment:

1. At the start, a line saying the review is under way. On a fallback run it
   says another agent took over, without naming models.
2. Every 15 minutes, a timestamped line describing current activity, written
   by the summarizer model from the latest tool calls (primary, then
   fallback, each through Mantle for `openai.*` ids and Converse otherwise; a
   fixed sentence if both fail).
3. At the end, the terminal tool replaces the whole body with the reply (or
   the skip reason) and a link to the state comment.

Edits run one at a time and never fail the review. A failed run stops the
progress edits without a final edit.

## 5. Credentials

### Token broker

The GitHub App secret (`app_id`, `private_key`, `webhook_secret`) lives in
Secrets Manager. Only the receiver, the token brokers and the ready-label
Lambda (when a route sets `readyLabel`) can read it (the
skills-repo broker only when `skillsRepo.appSecretName` names this secret,
which is the default). The
receiver uses the webhook secret to verify deliveries and acts as the
installation for @mention handling and thread lookups, with tokens that ask
for `pull_requests: write`, `issues: read` and `metadata: read` only
(`RECEIVER_TOKEN_PERMISSIONS` in `webhook/src/github.ts`). The reviewer
runtimes never see the secret. Each reviewer has its own broker (one instance of
`webhook/src/token-broker.ts` per reviewer, created in
`infra/lib/substrate-stack.ts`), and each runtime role may invoke only its
own. The runtime calls it with `{ installation_id, repo }`.

`createTokenBroker` in `webhook/src/broker.ts` refuses a malformed request
and any repository that is not one of its reviewer's review routes
(`ALLOWED_REPOS_JSON`, built by `tokenBrokerRepos(config, reviewerId)` in
`infra/lib/deployment-config.ts`; curator-only repositories are excluded).
It then asks GitHub, as the App, for the App's installation on the
repository (`GET /repos/{owner}/{name}/installation`), and refuses the
request when there is none, when it is not the caller's `installation_id`,
or when its account is not the repository's owner. GitHub resolves
repository names inside the installation a token is requested from, so
without this check another installation of the App could give a token for
a same-named repository of another owner. The broker then returns an installation token for that one
repository with `pull_requests: write` and `metadata: read`, and its
expiry. The installation check adds one GitHub call per token.

### Ready-label Lambda

When a route sets `readyLabel`, substrate creates one Lambda
(`webhook/src/ready-label-broker.ts`) that the reviewer runtimes and the
receiver may invoke. It never returns a token. The payload is
`{ installation_id, repo, pr_number }`; the label name comes from
`READY_LABEL_BY_REPO_JSON`. It uses the same installation and owner checks
as the token broker, then mints `issues: write`, `pull_requests: read` and
`metadata: read` (`LABEL_PERMISSIONS` in `webhook/src/ready-label.ts`) and
adds or removes that one label. A missing repository label is logged
(`missing-label`) and not created. Failed GitHub or Secrets Manager
calls reject the Lambda invoke so the async Event retry can run them
again; they never fail the webhook or the review. An older reconcile
that raced a push re-reads the head before and after a mutation and
does not leave the label on the new commit.

The reviewer token stays `pull_requests: write` + `metadata: read`. Pull
request code that steals it cannot label arbitrary issues.

### Skills-repo token broker

The curator proposes edits to the reviewers' skill files in this repository
by pull request (see [Repo skill pull requests](#repo-skill-pull-requests)).
For that it invokes the skills-repo broker (`webhook/src/skills-repo-broker.ts`,
created in `infra/lib/substrate-stack.ts` only when `skillsRepo` is set).
Only the curator role may invoke it. The request carries an optional
`purpose`, which is only logged. The repository comes from the broker's
`SKILLS_REPO` variable, and the App from the secret `SKILLS_REPO_APP_SECRET_NAME`
names, so a caller cannot pick either. The broker looks up the App's
installation on that repository as the App, refuses when there is none or
when its account is not the repository's owner, and returns a token for
that one repository with `contents: write`, `pull_requests: write` and
`metadata: read`. Besides writing its logs, its role can only read that one
secret (`secretsmanager:GetSecretValue`). The curator caches the token until five minutes before it
expires, and neither logs it nor shows it to a model.

### Token scope and refresh

`createTokenSource` (`agents/common/src/github-auth.ts`) caches the token and
asks the broker again five minutes before it expires, with one refresh in
flight at a time, so runs longer than the token's one hour lifetime keep
working. `createOctokit` attaches the current token to every REST request. The
`gh_api_read` tool passes it to its `gh` process only.

### Git authentication

`gitAuthEnv` in `agents/common/src/workspace.ts` authenticates each fetch
through `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0` and `GIT_CONFIG_VALUE_0`,
setting `http.https://github.com/.extraheader` for that process only. Remote
URLs carry no credentials and nothing is written to `.git/config`. An upstream
other than the pull request's repository is fetched anonymously. The
model-facing `git` tool runs with no credentials at all.

### Build process environment

`buildChildEnv` (`agents/common/src/tools/child-env.ts`) gives `make` and
`build` the runtime's environment minus every variable whose name starts with
`AWS_`, `AMAZON_`, `GH_` or `GITHUB_`, or contains `TOKEN`, `SECRET`,
`PASSWORD`, `CREDENTIAL` or `PRIVATE_KEY`. `resolveInside` requires the
working directory to resolve inside the checkout. Commands run from an
argument list, never through a shell.

### Runtime roles

Each runtime has its own role (`infra/lib/valkey-review-agent-stack.ts`,
`infra/lib/curator-agent-stack.ts`, both built on `createRuntimeRole` in
`infra/lib/grants.ts`). A reviewer can call its models, get objects under
its own prefix in the assets bucket (no listing) and decrypt them with the
substrate key, read its own skills registry, get, put and update any item
in the shared heartbeat table, invoke its own token broker (and the
ready-label Lambda when a route sets `readyLabel`), write its own
runtime log groups, and pull from the CDK bootstrap container-assets
repository, which holds the images of every CDK app in the account and
region that uses the same bootstrap qualifier. It has no Secrets Manager
access, no concerns table access and no registry writes. The curator can
call its models, read its own prefix in the assets bucket (and list the
bucket), read and write the concerns tables, create, update and read
records in the reviewer registries and set their status (a retirement
sets `DEPRECATED`), read its own registry, invoke the skills-repo broker
when there is one, write its own runtime log groups and pull from the
same repository. It holds no GitHub credentials. Its maintenance runs make
anonymous HTTPS calls to GitHub: git fetches of the public upstream
repositories, and reads of the skill files in the bot's repository
(`api.github.com` and `raw.githubusercontent.com`). With a token from the
skills-repo broker they write a branch and a pull request in the bot's
repository, and nothing else. The decay Lambda, which is not a runtime,
can scan, update and delete items in the concerns tables and send messages
to the curator queue, and calls the GitHub releases API without
credentials. [infra/README.md](../infra/README.md#stacks) lists the grants
in more detail.

## 6. The curator

### Envelope and trust check

The receiver sends a `CuratorEnvelope` (`webhook/src/feedback.ts`):
`reviewer_id`, `feedback_id`, `kind` (`review_comment_reply`,
`issue_comment_reply` or `resolution` for a submitted review), `human_body`,
`actor`, `actor_association`, `repo`, `pr_number`, `pr_author`, `bot_comment`
(the App's comment for a reply in its thread, plus the feedback's path and
line) and `installation_id`. The curator's `requestSchema`
(`agents/curator/src/feedback.ts`) also accepts `body` as an older name for
`human_body`.

`untrustedReason` repeats the receiver's check: no actor, a login ending in
`[bot]`, or an association other than `OWNER`, `MEMBER` or `COLLABORATOR`
ends the run without calling the model. `reviewer_id` selects the concerns
table (`CONCERNS_TABLES_JSON`) and skills registry (`SKILLS_REGISTRIES_JSON`);
an unknown id is an error.

The decay job sends maintenance messages to the same queue
(`MaintenanceMessage` in `ops/src/decay.ts`). The runtime accepts either
kind (`curatorRequestSchema` in `agents/curator/src/maintenance.ts`) and
tells them apart by `maintenance_id`. A maintenance message carries only
identifiers and a GA tag: `maintenance_id` (at most 200 characters),
`reason` (`check`, `retire` or `repo_check`), `reviewer_id`, `area_bucket`,
`record_id` and `dry_run`; `record_name` (a registry record name) and
`seen_updated_at` for a check or a retirement; `release_tag` (a GA tag, or
empty for a check when the release is unknown) for a check or a repo check;
`retire_reason` (`decayed` or `obsolete`) for a retirement. No skill text,
repository or URL: the curator maps `reviewer_id` to its upstream from
`UPSTREAM_REPOS_JSON`. A message that fails the schema is refused.

### The run

- System prompt: `agents/curator/config/prompt.md` with
  `{{GRADUATION_THRESHOLD}}` filled in, then the curator's `skill.md`. Its
  workflow has two phases: "Phase 1: decide" and "Phase 2: graduate".
- First message (`renderFeedbackMessage`): all GitHub content sits in one
  block between `<<<FEEDBACK <marker>` and `>>>END <marker>`, with a random
  marker per run, and is described as data, not instructions.
- Model (`createCuratorModel` in `agents/common/src/model-fallback.ts`): a
  primary and a fallback, each built from its own model id (Mantle for
  `openai.*`, Converse otherwise). If a model call fails, that call is retried
  on the fallback and the rest of the run stays there. Each primary call is buffered
  so no tool call is acted on before it completes.
- Loop (`curate` in `agents/curator/src/curate.ts`): tools run one at a time.
  The loop ends after the tool round that calls `curator_done`, or after
  `MAX_ITERATIONS` rounds (default 40). The SDK's printer is off: the
  model's output reaches the log only as quoted lines, one per block
  (`[model] text "..."`, `[model] reasoning "..."`, `[model] tool "<name>"`,
  from `ModelEcho`), and the run's end line quotes its decision, summary
  and actions (`feedbackDoneLine`).
- Stream: the curator runtime has none of the reviewers' closed-stream
  handling and keeps AgentCore's default session lifecycle. A maintenance
  run is registered as an async task, so `/ping` reports `HealthyBusy`
  while it runs; a feedback run is not. If its stream closes before the
  `done` frame, the worker reports the message as failed and SQS delivers
  it again, up to three receives.
- Limits (`CuratorRun` in `agents/curator/src/tools/run.ts`): one change to
  the concerns store per run, one skill submission per run, nothing after
  `curator_done`. A call that fails or changes nothing frees its slot.
  `resolution` feedback can only bump an existing record, without edits.
- Tools: `list_concerns`, `get_concern`, `create_concern`, `bump_concern`,
  `update_concern`, `merge_concerns`, `delete_concern`,
  `list_skill_authoring`, `get_skill`, `submit_skill` and `curator_done`.
  Every tool refuses an `area_bucket` that starts with `#`: such buckets
  hold the skill lifecycle's own items, never concern records.

### Maintenance runs

`handleMaintenance` runs one maintenance message. It acts only while the
record's `maintenance_id` (read with a consistent read) is the message's;
any other value means a stale or duplicate message, and nothing is
written. Every write that changes the skill's state is also conditioned on
`graduated_record_name` being the message's `record_name`. A finished run
removes the claim (`maintenance_id`, `maintenance_requested_at`,
`maintenance_reason`) in its last write. An outcome to retry later keeps
it, and the decay job asks again once it is 7 days old
(`MAINTENANCE_RETRY_DAYS`): an inconclusive check, a registry record that
is still `CREATING` or `UPDATING`, an ambiguous deprecation, or a run that
throws.

- `retire` runs without a model ([Retirement](#retirement)).
- `check` runs the deterministic check and, when names are flagged, an
  audit ([Skill checks](#skill-checks)).
- `repo_check` checks the reviewer's skill file in this repository
  ([Repo skill pull requests](#repo-skill-pull-requests)).

The audit is a second use of the `curate` loop with its own tools and
prompt: `read`, `grep` and `glob` from the reviewers' harness, confined to
the checkout, without write tools or `lsp`; the read-only `git` tool in the
checkout; and `report_skill_check`, which ends it (`assembleCheckTools` in
`agents/curator/src/check-run.ts`). It has no shell, network, concerns or
registry tool. The system prompt is `agents/curator/config/skill-check.md`,
loaded from `curator/skill-check.md` (`CHECK_PROMPT_S3_KEY`) with its
limits filled in from the code. The first message gives the upstream, the
default branch, the checked commit, the base (the last check's commit),
the release, and each flagged name with its status, then the skill between
`<<<SKILL <marker>` and `>>>END <marker>` and the diff excerpts between
`<<<DIFF <marker>` and `>>>END <marker>`, with a random marker per run. The
audit ends at an accepted report, after `CHECK_MAX_ROUNDS` tool rounds
(default 25), or 12 minutes after the run started, below the worker's 15.
The models are the curator's, with the same per-call fallback.

Report mode. A message with `dry_run`, or a setting that is off
(`CHECK_APPLY_EDITS`, `RETIRE_SKILLS`, `CHECK_OPEN_PULL_REQUESTS`), never
writes the registry or opens a pull request. A dry run also leaves the
outcome, verification, names and standing alone: it writes only an
audit's result to `pending_revision` (reason `dry run`, never in place of
a real check's result) and releases the claim. Its decision says what a
real run would do: `would-accurate`, `would-revise`, `would-suspect`,
`would-obsolete`, `would-retire` or `would-record-retirement`.

Each run logs one report line per outcome, `[maintenance] <check|retire|repo_check>
reviewer=... outcome=... dry_run=... maintenance=...`, one
`[maintenance] edit` line per proposed edit with its evidence, original and
replacement, and `[maintenance] audit <status> rounds=... refusals=...`
after an audit. A check or repo check line carries an `advisory` field
when the skill's description cites names that are absent (see
[Skill checks](#skill-checks)). Strings in these lines, and in the
`[model]` lines of the audit, are JSON-quoted and stripped of invisible
format and separator characters (`quoted` in
`agents/curator/src/log-text.ts`), so text from a table or a model cannot
break a line or pass for a report line. The entrypoint ends with
`[curator] maintenance <status> reason=... decision=...`.

### Concern records

`agents/curator/src/tools/concerns-ddb.ts`. One table per reviewer, keyed by
`area_bucket` (for example a directory or file) and `record_id` (a random
UUID). A record holds `area` (globs it applies to), `subject`, `concern`,
`context` (the maintainer's "why", at most 4,000 characters, appended to by
edits), `reinforcement_count`, `reinforcers`, `decay_score`, `created_at`,
`updated_at` (last reinforcement), `edited_at`, and after graduation
`graduated_record_name` and `graduated_at`. The decay job adds `decayed_at`.
Every write is conditioned on the state it was computed from. `list_concerns`
returns the 20 most reinforced records in a bucket, live records before
tombstones. The model sees how many people reinforced a record, never their
logins (`recordView`).

A graduated record also carries its skill's lifecycle:

| Attributes | Meaning | Written by |
| --- | --- | --- |
| `skill_generation`, `previous_record_name` | The generation of the published skill (1 when absent) and the retired name a later generation replaced | `submit_skill` |
| `retired_at`, `retired_reason`, `retired_from_status` | The skill is retired (`decayed`, `obsolete` or `operator`); the record stays as a tombstone | Retire and check runs, `submit_skill` |
| `verified_release`, `verified_at`, `verified_sha`, `verified_ref` | The release and time of the last completed check, and the default-branch commit it confirmed (`<branch>@<sha12>` in `verified_ref`) | Check runs |
| `audit_names`, `lost_names`, `ignored_names` | The baseline: cited names present at `verified_sha` (at most 300); baseline names found missing since; absent names an audit judged accurate (at most 100) | Check runs |
| `stale_names`, `stale_since` | Names still lost or new and absent, unresolved (at most 50), and since when | Check runs |
| `check_outcome`, `check_note` | `clean`, `accurate`, `revised`, `suspect`, `obsolete`, `inconclusive` or `error`, and a note of at most 500 characters built by code from counts and the skill's own names, ending with an advisory while names only the description cites are absent | Check runs |
| `obsolete_release` | The release at which the subject was found gone; `decay_score` is set to 0 with it. A publish that removes it sets `decay_score` back to 1.0 and `decayed_at` to now | Check runs; `submit_skill` removes it |
| `pending_revision` | An audit's result that was not applied: `at`, `verdict`, `reason`, `summary` (at most 400 characters), `edits` (`original`, `replacement`, `evidence` citations) and `problems` | Check runs |
| `previous_skill_md`, `revised_at` | The text before the last applied edit, for rollback | Check runs |
| `partial_checks`, `partial_check_id` | Checks in a row whose diff was read only in part | Check runs |
| `maintenance_id`, `maintenance_requested_at`, `maintenance_reason` | The claim of a queued maintenance message | Decay job; the curator removes it |
| `maintenance_deprecating`, `retire_refused_at` | A deprecation this lifecycle started, and when the registry last refused one | Retire runs |

`recordView` shows the model only `skill_state` (`live` or `retired`),
`retired_reason`, `verified_release`, `verified_at`, `check_outcome`,
`check_note` and `stale_names`. It never shows `audit_names`,
`ignored_names`, `verified_sha`, `pending_revision`, `previous_skill_md` or
the maintenance attributes.

Each concerns table also holds one item that is not a concern record, at
`area_bucket` `#maintenance` and `record_id` `repo-skill`: the claim and the
last check of the reviewer's repo skill file, with the same check
attributes plus `skills_repo_sha`, the commit of the file it read.

### Reinforcers and graduation threshold

A reinforcer is `actor#repo#pr`, lowercased (`reinforcerKey`), so each person
counts once per pull request.

- `create_concern` starts a record at count 1 with that reinforcer.
- `bump_concern` adds 1 and the reinforcer only when the reinforcer is not
  already in the set; a repeat returns `reinforced: false`. It resets
  `decay_score` to 1.0 and sets `updated_at`.
- `merge_concerns` gives the target the merged fields, the union of both
  reinforcer sets and a combined count in which a person who reinforced both
  records counts once, resets its decay, and deletes the source in the same
  transaction. The transaction fails if either record changed since it was
  read. A graduated record can only be the target.
- `delete_concern` refuses graduated records.

`GRADUATION_THRESHOLD` (default 4) is the count a record needs before it may
graduate. The curator accepts values from 2 to 100.

### Publishing skills to AWS Agent Registry

`submit_skill` (`agents/curator/src/tools/submit-skill.ts`) accepts only the
record this run bumped or merged into, or a graduated record whose live
skill this run corrected with `update_concern` (an update, never a first
graduation), and only when its stored count meets the threshold. It accepts
at most 40,000 characters of `skill_md` (`GRADUATED_SKILL_MAX_CHARS`), half
the reviewers' load budget, so every published skill can be loaded. The record name is the record's existing
`graduated_record_name`. A first graduation uses a slug of the subject (at
most 60 characters), or, when another skill already holds that name, the
slug with a suffix derived from the record id; if both are taken the call
fails and asks for another subject. The tool claims the name on the record
with a conditional write, sets the frontmatter `name` to it
(`withRecordName`), then calls `upsertSkill`
(`agents/common/src/skills-registry.ts`), which updates the `SKILL` record
with that name or creates one. The markdown goes in
`descriptors.agentSkillsDefinition.additionalData.skillMd.data` and gets
minimal frontmatter if it has none; `upsertSkill` refuses markdown over the
registry's limit of 102,400 characters. The description notes the source
`record_id`. Finally `graduated_at` is set, and the lifecycle attributes of a
retirement or a pending check (`retired_*`, `stale_*`, `obsolete_release`,
`pending_revision`, `retire_refused_at`) are removed. When the record had
`obsolete_release`, that write also sets `decay_score` back to 1.0 and
`decayed_at` to now, the standing the obsolete finding took. Without it the
next decay pass would see a score below the floor and retire the corrected
skill as decayed before any check of the new text. The name claim is
conditioned on `obsolete_release` as read, so a finding recorded in between
makes the submission fail instead of being cleared with its score at 0.

For a record that published before, the model first reads the published
text with `get_skill`, which returns the registry record in any status. The
release check may have corrected that text, so the new text starts from it.
It must keep every suppressed block of the published text byte for byte and
may add none: only the release check writes suppression markers. Claiming
the update also removes any maintenance claim on the record, which voids a
check or retirement queued for the old text, and an update is refused while
a check run is applying an edit to the same skill.

Retired skills. `upsertSkill` refuses a record that is `DEPRECATED` or
`REJECTED` (`SkillRetiredError`) and changes nothing, because `DEPRECATED`
is final: such a record can never be updated or set back. It prefers a
live record when several share a name, and has an `updateOnly` mode, used
by check runs, that never creates one. A reinforcement of a tombstone whose
`retired_reason` is `decayed` or `obsolete` therefore publishes a new
generation under a new name, `suffixedName(slug, "<record_id>#g<n>")`, and
sets `skill_generation`. A skill an operator retired (`retired_reason`
`operator`, or a `REJECTED` record) is never published again. An operator
can restore such a record by removing `retired_reason`; the next eligible
reinforcement then publishes a new generation.

`list_skill_authoring` returns up to 10 skills from the curator's own registry
(sources in `agents/curator/skills/`, published with
`scripts/publish-curator-skills.mjs`). Without that registry the curator
follows the prompt's inline rules.

On the reviewer side, `loadGraduatedSkills`
(`agents/common/src/graduated-skills.ts`) runs after workspace preparation.
It skips records in status `CREATING`, `CREATE_FAILED`, `UPDATE_FAILED`,
`DEPRECATED` or `REJECTED`, takes the 30 most recently updated, and caps their
combined markdown at 80,000 characters (`GRADUATED_SKILLS_MAX_CHARS`). Newest
skills come first; a skill that does not fit is skipped and later ones are
still tried, and the number of skills left out is logged. All registry calls
share one 10 second deadline. Any failure means no graduated skills
for that run. `renderGraduatedSkills` appends them to the system prompt
under a fixed introduction: several maintainers confirmed each rule, each is
re-checked against the upstream default branch after releases, a rule is a
reason to look and the code at the PR head wins. For each skill it strips
the frontmatter, puts the description on one `Scope:` line without its
record-id sentence, demotes the skill's own headings one level outside
fenced blocks, and drops the record-id citation. A suppressed piece is kept,
with its markers replaced by the labels `**Superseded in <release>.**` (and a
sentence saying it describes code before that release and matters only for
backports to older release lines) and `**End of superseded text.**`. Only
well-formed blocks, as `parseSuppressed` in
`agents/common/src/skill-check/edits.ts` reads them, are labelled. The
baked-in `skill.md` gets the same labels. Concerns below the threshold never
reach a reviewer. `scripts/registry-skills.mjs` lists skills, deprecates one
to retire it, lists orphans (live skills that no concern record names, which
the lifecycle never reaches), and adopts them: `adopt --apply` writes for
each orphan the concern record the curator would hold had it graduated the
skill, at the graduation threshold and with `graduated_record_name` set, so
the decay job decays it and queues its first check.

### Decay

`infra/lib/decay-cron-stack.ts` runs `ops/src/decay.ts` every 24 hours.
`decayTable` scans each concerns table and multiplies each score by
`0.5 ^ (elapsed / half-life)`, where elapsed time counts from the later of
`updated_at` and `decayed_at`. Every write is conditioned on the
`updated_at`, `decayed_at` and `decay_score` the scan saw, so a record
reinforced, or scored by the curator, during the pass is skipped.

- A record that never graduated decays on `DECAY_HALF_LIFE_SECONDS` (30
  days) and is deleted below the floor (0.05), after about 130 days without
  reinforcement. The delete is also conditioned on the record still not
  having graduated.
- A live graduated record decays on `DECAY_GRADUATED_HALF_LIFE_SECONDS` (180
  days) and is never deleted: it is its skill's provenance. Below the floor
  it is a retirement candidate, after about 778 days (180 x log2(20))
  without reinforcement. Otherwise it is a check candidate when a check is
  due: it was never checked; it was published again since its last check
  (`graduated_at` after `verified_at`); the release tag is known and differs
  from `verified_release`; the last check is older than
  `SKILL_RECHECK_SECONDS` (90 days); or the pass was started with
  `recheck_all`.
- A record with a maintenance request younger than 7 days is in flight and
  gets only its score.
- A tombstone (`retired_at` set) is left as it is.
- An item in a bucket that starts with `#` is not a concern record. The
  pass keeps the `#maintenance` / `repo-skill` item for the repo skill check,
  leaves any other one alone and logs it as `reserved-bucket`.

After the scan:

1. Retirement candidates, lowest score first. With `RETIRE_SKILLS` off (the
   default), without a queue or in a dry run, each is logged as
   `would-retire` and gets its score. Otherwise the first
   `MAX_RETIREMENTS_PER_DAY` (3) per reviewer are claimed and sent with
   `retire_reason` `obsolete` when `obsolete_release` is set, else
   `decayed`, and the rest are logged as `deferred`. A record whose
   retirement the curator refused is not asked again for
   `RETIRE_REFUSED_BACKOFF_SECONDS` (30 days), logged as `retire-backoff`,
   and can still be checked meanwhile.
2. The repo skill check, once per release: when the release tag is known and
   differs from the `verified_release` of the `#maintenance` item, or the
   pass has `recheck_all`, and no request for it is younger than 7 days, a
   `repo_check` is claimed and sent first.
3. Check candidates: never checked first, then published again, then the
   oldest check. With the repo check, at most `SKILL_CHECKS_PER_DAY` (10)
   per reviewer; the rest are `deferred` to the next pass. Each message is
   delayed 60 seconds more than the one before, up to the SQS limit of 900,
   so checks do not crowd out feedback on the shared queue.

A claim is one conditional `UpdateItem` that also stores the decayed score
and sets `maintenance_id` (`<reason>#<reviewer>#<record_id>#<time of the
pass>`), `maintenance_requested_at` and `maintenance_reason`, conditioned on
the state as read, the record's name and no `retired_at`. When the send
fails, the claim is removed again and the record is asked for at the next
pass.

Checks are queued only with a curator queue, `SKILL_CHECKS_PER_DAY` above 0
and an upstream for the reviewer; the release lookup is skipped otherwise.
The lookup is one anonymous `GET /repos/<upstream>/releases?per_page=50`
per distinct upstream per pass, with a 10 second timeout
(`latestReleaseTag`). Drafts, prereleases and tags that are not `X.Y.Z` or
`vX.Y.Z` are dropped and the highest version wins, whatever its date, so
`9.2.0-rc1` and `rust/v0.9.0` never count and `8.1.10` after `9.1.2` does not
move it. Nothing is stored per repository: a day on which the API fails
(rate limits on shared Lambda addresses, 5xx, a timeout) only skips the
release trigger, and the next pass catches up, because each record compares
its own `verified_release`.

The scheduled event sets nothing. A manual invoke can pass
`{"recheck_all": true}`, which makes every live graduated skill due (still
within the caps), and `{"dry_run": true}`, which logs every retirement
candidate as `would-retire` and sends checks with `dry_run: true`. A dry run
still writes the routine scores and still deletes ungraduated records below
the floor, as the next scheduled pass would. Each table's pass ends with

```text
[decay] <table> scanned= decayed= deleted= skipped= errors= kept_retired= checks_requested= retire_requested= would_retire= deferred= retire_backoff= reserved=
```

and each request logs its own line: `check-requested`,
`repo-check-requested`, `retire-requested`, and for retirements that are
not requested `would-retire`, `deferred` (over the cap) or `retire-backoff`.
Checks over the cap are only counted. `[release] <repo> tag=<tag>`, or a
warning, shows the lookup.

### Skill checks

A `check` message makes the curator check one registry skill against the
upstream default branch (`check` in `agents/curator/src/maintenance.ts`).

1. Read the record with a consistent read and the registry record by name
   (`getSkillByName`). Skip a stale message, a renamed or retired record.
   A registry record that is gone or `DEPRECATED` is recorded as retired
   (`decayed` or `obsolete` when this lifecycle's deprecation marker is on
   the record, else `operator`), `REJECTED` always as `operator`; one that
   is gone and whose publication was never recorded gives `error`. One that
   is `CREATING` or `UPDATING` gives `inconclusive`, and the check is
   retried. A reviewer with no upstream is skipped.
2. Make the checkout (`prepareUpstreamCheckout` in
   `agents/common/src/skill-check/upstream.ts`) in a fresh directory under
   `/tmp/skill-check`, removed afterwards: `git init`, `ls-remote --symref`
   for the default branch, a depth-1 blob-less fetch of its tip and a
   checkout, which fetches the tip's blobs in one batch; then, best effort,
   the commit of the last check (`verified_sha`) and the blobs of the files
   that changed since. The URL is `https://github.com/<upstream>.git`, with
   no credentials. The repository is new, so it has no hooks. git runs with
   no system or global config, no prompts, a low-speed abort, and an
   environment without `AWS_`, `AMAZON_`, `GH_`, `GITHUB_` or `GIT_`
   variables or any name holding `TOKEN`, `SECRET`, `PASSWORD`,
   `CREDENTIAL` or `PRIVATE_KEY`. Each git call has a 10 minute limit (3
   minutes for the base) and runs in its own process group, killed whole at
   the limit. No upstream code runs.
3. Extract the cited names (`extractNames` in `skill-check/names.ts`):
   inline code spans of 2 to 120 characters outside the frontmatter, fenced
   blocks and suppressed pieces, plus path-like and `A::b` words of the
   description. A span becomes a path, directory, glob, prefix (`REPL_STATE_*`),
   qualified name (`a::b`, `a.b`, `a->b`), symbol (at least 4 characters with
   an underscore or an inner capital, or all capitals of at least 5) or
   config name (`kebab-case`). Anything else is dropped. At most 300 names
   per skill. A check never edits the frontmatter, so a name only the
   description cites (`descriptionOnlyNames`) cannot be corrected by one.
   It counts for presence, for the obsolete evidence and for the standing
   penalty, but is never flagged, lost or new and absent: it never refuses
   `accurate`, never starts an audit, and never goes into `lost_names`,
   `stale_names` or `ignored_names`. While one is absent and no earlier
   audit judged it accurate, every `check_note` ends with an advisory that
   names it, for the operator and for a later re-publication.
4. Run the deterministic check (`checkSkill` in `skill-check/check.ts`),
   with git plumbing only:
   - presence at the tip: `git ls-tree` for paths, directories and globs (a
     path whose first component is at the top of the tree must match
     exactly; any other matches as a tail, so `server.c` finds `src/server.c`),
     and `git grep -w -F` for symbols, configs and the components of
     qualified names, 10 patterns per call and 4 calls at a time;
   - `lost`: names of the baseline (`audit_names`) now absent, and names lost
     at an earlier check that the skill still cites. A loss lowers standing
     once: the name leaves `audit_names` for `lost_names`;
   - `new_absent`: other cited names, absent and not in `ignored_names`;
   - `touched`, only with a base: rare names (1 to 40 occurrences at the
     tip) on a changed line or in a hunk header of `git diff <base> <tip>`,
     and cited full paths that changed. At most 200 files per diff call, 4
     MiB per call and 64 MiB per check; up to 3 hunks per name and 24,000
     characters of excerpts go to the audit.
5. Nothing flagged and the whole diff read: `clean`. The record is
   confirmed without a model: `verified_*` move to the checked commit and
   `audit_names` to the names present.
6. Otherwise the audit runs ([Maintenance runs](#maintenance-runs)) and ends
   with `report_skill_check`: a `verdict` (`accurate`, `revise`, `obsolete`
   or `unsure`), a `summary` of at most 400 characters for the operator, and
   for `revise` at most 6 `edits`, each `{original, replacement, evidence}`.
   A report is refused with reasons, and the model tries again, when it says
   `accurate` while a lost name is missing, `revise` without edits, edits
   with another verdict, or edits that break the edit contract below. After
   2 refusals the next report is accepted as it is, but edits that break the
   contract are never applied.

The edit contract (`validateEdits` in `skill-check/edits.ts`). An edit never
overwrites a fact. It wraps the stale piece in markers and adds the
replacement after them:

```text
<!-- suppressed: superseded in <release>, <YYYY-MM-DD>; <reason>; evidence: <repo>@<sha>:<path>:<line> -->
<the original piece, unchanged>
<!-- /suppressed -->
<the replacement piece>
```

- `original` is 1 to 5 whole lines of the skill body, at most 800
  characters, found exactly once. It cannot be in the frontmatter, a fenced
  block or a suppressed block, and edits do not overlap or nest.
- `original` holds a flagged name.
- Split on runs of `[A-Za-z0-9_./:*>-]`, the text between tokens is the
  same in both and the token count is equal: no word, sentence or
  punctuation is added or removed, and the line count is the same.
- A changed token is a flagged code name in a backtick span, replaced by a
  code name of the same sort (a path for a path, an identifier for an
  identifier, a config name for a config name); or a number on a line that
  holds a flagged name. Words outside code spans never change, so "NEVER
  flag" cannot become "ALWAYS flag".
- Each edit cites 1 to 5 lines of the checked commit, and every new name or
  number appears as a word on a cited line. A number's cited line must also
  hold a code name from the edited line.
- The marker's reason is generated from the changed names
  (`` `a` is now `b` ``, joined by `; `), never from the model.
- The edits grow the skill by at most 4,000 characters, markers included,
  and the result stays within 40,000 characters (`GRADUATED_SKILL_MAX_CHARS`;
  102,400 for a repo skill file).

`<release>` is the message's GA tag, or `<branch>@<12-char sha>` of the
checked commit when the release was unknown.

Outcomes:

| Outcome | When | What is written |
| --- | --- | --- |
| `clean` | Nothing flagged, diff read in full | Verification moves; `stale_names`, `lost_names` and `pending_revision` cleared |
| `accurate` | The audit judged every flagged name fine, and no name is lost | Verification moves; the new absent names join `ignored_names` |
| `revised` | Valid `revise` edits and `CHECK_APPLY_EDITS` on | First a claim write saves `previous_skill_md` and `revised_at` and removes `maintenance_id`, so only one copy of the message reaches the registry; then `UpdateRegistryRecord` (update only) with the edited text; then the new text's names are checked in the same checkout and the verification moves |
| `suspect` | Valid edits with `CHECK_APPLY_EDITS` off, `unsure`, `obsolete` without evidence, or a report accepted after refusals | `pending_revision`, `stale_names`, `lost_names`; `verified_release` and `verified_at` move, `verified_sha` does not, and the baseline only loses the lost names |
| `obsolete` | `obsolete`, and deterministic evidence: at least 3 baseline names with fewer than half kept, or no file left in the record's `area`. Each area entry is tested as a file and as a directory (`<e>/**`, or `**/<e>/**` for a name without `/`), with a leading `/` or `./` and a trailing `/` dropped. The area counts only when every entry is a path glob that can be tested: an entry with any other character (a space, braces, brackets) or an empty, `.` or `..` component means the area cannot back an obsolete verdict | `obsolete_release` and `decay_score` 0; the next decay pass asks for the retirement. A reinforcement since the read makes it `suspect` instead |
| `inconclusive` | No report by the round cap or the deadline, a model or git failure, a registry record being written, or nothing flagged but part of the diff unread | `check_outcome` and `check_note`; the claim stays, so the check runs again after 7 days |
| `error` | A failure retrying cannot fix, such as a registry record that was never published | Recorded with the release, so the check is due only at the next trigger |

A check with names still lost lowers the record's standing: `decay_score`
is multiplied by the share of baseline names kept, conditioned on the score
and `updated_at` as read. When a reinforcement won the race, the write is
retried once without the penalty.

The base. Only git's answer that the remote no longer has the base commit
(after a force-push, say) gives a presence-only check that may confirm. Any
other failure to fetch the base (a timeout, a network error) leaves the
check incomplete, and an incomplete check never moves `verified_sha`. A
check whose diff ran past the budget counts in `partial_checks`; after 2 such
checks in a row, the third confirms and its `check_note` says so. The
operator's way out of a check that stays incomplete is to remove
`verified_sha` from the record, which makes the next check a first check.

### Retirement

A `retire` message runs without a model (`retire` in `maintenance.ts`).

1. Skip a stale message, a renamed or retired record, a `decayed` retirement
   whose record was reinforced since (`updated_at` differs from
   `seen_updated_at`), and an `obsolete` one whose `obsolete_release` is gone
   (published again since).
2. Read the registry record. Gone: record the tombstone with the message's
   reason. `DEPRECATED`: the same when this lifecycle's marker shows it was
   its own deprecation, else `operator`. `REJECTED`: `operator`. `CREATING`
   or `UPDATING`: keep the claim and retry later.
3. With `RETIRE_SKILLS` off or in a dry run, log `would-retire` and stop.
4. Set `maintenance_deprecating` on the record, then call `deprecateSkill`:
   `UpdateRegistryRecordStatus` to `DEPRECATED` with the reason
   `valkey-reviewer: retired (<reason>) <date>; last reinforced <date>`.
5. Write the tombstone: `retired_at`, `retired_reason` and
   `retired_from_status`, with the claim and the marker removed.

Reviewers stop loading the skill at their next run, because `loadSkills`
skips `DEPRECATED` records, and that frees room in the 30-skill,
80,000-character window. When the registry refuses the transition
(`ValidationException`) and a fresh read shows the record neither retired
nor being written, the run logs `[maintenance] retire-refused <name>
status=<s>`, sets `retire_refused_at` and releases the claim; the decay job
then waits 30 days before it asks again. A deprecation that fails in any
other way leaves the claim and the marker, and the redelivered message
finds out what happened.

Any run removes a leftover `maintenance_deprecating` when it releases the
claim after it read the registry record as `DRAFT`, `PENDING_APPROVAL` or
`APPROVED` (after its last `deprecateSkill` call, if it made one): no
deprecation is under way then. That covers a skip, a report-mode or
dry-run end, a refused retirement read back live, and on the revise path
its first write, the one that removes `maintenance_id`. Every other
release keeps the marker.

### Repo skill pull requests

The reviewers' built-in skill files (`agents/<reviewer>/config/skill.md`)
ship with this repository, so they are never edited in place. A
`repo_check` message, sent once per GA release, checks one of them the same
way as a registry skill, with two differences: `obsolete` is not a verdict
for it, and its edits are proposed by pull request
(`agents/curator/src/repo-skill-pr.ts`).

- Without `skillsRepo` the check is recorded as `skipped`. With it, the
  curator reads the file anonymously from `skillsRepo.repo` at
  `skillsRepo.baseBranch` (`GET /repos/<repo>/commits/<branch>`, then
  `raw.githubusercontent.com`), so the bot's repository must be public.
- Valid `revise` edits with `CHECK_OPEN_PULL_REQUESTS` on and a token broker
  configured are proposed; otherwise the result is `suspect` and the edits
  wait in the item's `pending_revision`.
- The proposal is deterministic code. It refuses any path but
  `agents/<reviewer>/config/skill.md` of a configured reviewer (never the
  curator's), and any new content that is not the read content plus
  suppress-and-add edits that keep the edit contract, re-derived from the two
  texts. The model never sees the token and never calls GitHub.
- Branch `skill-check/<reviewer>/<release>` (a `<branch>@<sha>` label becomes
  `<branch>-<sha>`) points at one commit on the base branch tip that holds the
  new file. Title: `Supersede stale facts in the <reviewer> skill for
  <release>`. The commit message lists the changes and the evidence, and the
  pull request body shows the evidence as links. Both are built from the
  validated blocks only, never from model text. The commit is made with the
  broker's token, so GitHub authors it as the App's bot user, and it is
  signed off as `skillsRepo.signOff`, or as that bot identity when it is not
  set.
- A re-run for the same reviewer and release updates the same branch and
  pull request. A branch that holds commits the check did not make, such as
  a maintainer's fixups, is never rebuilt: the proposal is `refused` and the
  run records `error`. When the file changed on the base branch since the
  check read it, nothing is pushed (`base-moved`), and the next pass checks
  the new text.
- When maintainers closed a pull request from the branch without merging,
  nothing more is proposed for that release (`declined`); the next release
  proposes on a new branch. The only ref ever written is the
  `skill-check/` branch.

Outcomes of a repo check add `proposed`, `declined` and `skipped` to those of
a registry check. The item records the checked file's commit in
`skills_repo_sha`.

## 7. Where state lives

| Store | Holds | Written by | Read by |
| --- | --- | --- | --- |
| Idempotency table (DynamoDB, webhook stack) | Delivery keys (24 hour TTL), daily budget counters `budget#<route>#<date>` (3 day TTL), round counters `autoreviews#owner/name#<pr>` (180 days from the latest automatic review) and pending markers `pending#owner/name#<pr>` (an hour after the queue delay) | Receiver; review workers extend and delete pending markers | Receiver, review workers (pending markers) |
| `valkey_reviewer_run_heartbeat` (DynamoDB, substrate stack) | One item per run key: `last_activity`, `status`, `model`, `message_id`, 24 hour TTL | Reviewer runtimes; review workers write each run's start record | Review workers |
| `valkey_review_concerns`, `valkey_glide_review_concerns` (DynamoDB, reviewer stacks) | Concern records with their skill lifecycle attributes (tombstones included), and the `#maintenance` / `repo-skill` item. Customer-managed KMS key, point-in-time recovery, retained on stack deletion | Curator, decay job, `scripts/skill-check.mjs` (claims), `scripts/registry-skills.mjs adopt --apply` (records for orphaned skills) | Curator, decay job, `scripts/concerns-dump.sh`, `scripts/skill-check.mjs`, `scripts/registry-skills.mjs orphans` and `adopt` |
| Assets bucket (S3, substrate stack) | `<agent>/prompt.md` and `<agent>/skill.md` for each reviewer, and `curator/prompt.md`, `curator/skill.md` and `curator/skill-check.md`. KMS encrypted and versioned | CDK deploy | Each runtime reads its own prefix at container start |
| Reviewer skills registries (AWS Agent Registry, one per reviewer) | Graduated `SKILL` records, retired ones `DEPRECATED` | Curator (`submit_skill`, check edits, retirement) | That reviewer, the curator |
| Curator registry (AWS Agent Registry) | Skill-writing guidance | `scripts/publish-curator-skills.mjs` | Curator (`list_skill_authoring`) |
| GitHub App secret (Secrets Manager) | `app_id`, `private_key`, `webhook_secret`. Created by the operator and referenced by name, so a deploy never replaces it | Operator | Receiver, token brokers, the ready-label Lambda when a route sets `readyLabel`, and the skills-repo broker when `skillsRepo.appSecretName` names it |
| Skills-repo App secret (Secrets Manager, optional) | `app_id` and `private_key` of the App that opens skill pull requests, when it is not the main App | Operator | Skills-repo broker |
| SQS queues | Envelopes in flight (14 days), and dead-lettered messages | Receiver, SQS redrive | Workers, operators |
| GitHub | Reviews, the review state comment (the carry-over between runs), status comments, and the optional ready-for-human-review label | Reviewer runtimes, receiver (acknowledgements), ready-label Lambda | Reviewer runtimes, people |
| Bot repository on GitHub (`skillsRepo.repo`) | The reviewers' repo skill files, and `skill-check/<reviewer>/<release>` branches and pull requests | Maintainers; the curator writes only `skill-check/` branches and their pull requests | Curator (anonymous reads), maintainers |
| Container image | The repository clone each run fetches into. Warm containers keep gitignored build output between runs | Image build | Reviewer runtime |

The registries and the secret are created outside the CDK app; see
[Before the first deployment](../infra/README.md#before-the-first-deployment).
