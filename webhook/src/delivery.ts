import { botMatcher, isAppLogin, type ReceiverConfig, type ReviewRoute } from './config.js';
import { curatorEnvelope, extractFeedback } from './feedback.js';
import { fetchReviewComment, type GitHubApi, type WebhookPayload } from './github.js';
import { classifyCommentBody, isAuthorReplyOutsideBotThread } from './heuristics.js';
import { detectMention, handleMention, type Mention, type Verdict } from './mention.js';
import type { AutomaticTrigger, ReviewEnvelope } from './review-envelope.js';
import { lowercaseHeaders, rawBody, verifySignature, type ApiGatewayEvent } from './signature.js';
import { releaseQuietly, type DeliveryStore } from './store.js';

/**
 * One webhook delivery, from signature check to queue message.
 *
 *   1. Verify X-Hub-Signature-256 over the raw body. On a mismatch, fetch
 *      the secret again once in case it was rotated.
 *   2. pull_request opened, reopened, ready_for_review or synchronize (new
 *      commits) on a review route: route gates, idempotency key
 *      repo#pr#head_sha (#reopened, #ready or #push appended for a
 *      reopen, ready_for_review and new commits), the pull request's
 *      pending marker, the pull request's cap on automatic reviews, the
 *      route's daily review budget, then the route's queue. The review
 *      holds the marker until its run starts and covers every push,
 *      reopen or ready_for_review that comes before then. A review of new
 *      commits first waits in the queue for pushReviewDelaySeconds.
 *      closed, and converted_to_draft on a skipDrafts route, never
 *      review; while a review waits, they release the key of a reopen,
 *      or ready_for_review, at that head, and give back the waiting
 *      review's round (pullRequestLeft).
 *   3. issue_comment, pull_request_review_comment, pull_request_review:
 *      an @mention of the bot is a review request (src/mention.ts).
 *      Everything else, and a thread reply even when it also starts a
 *      re-review, is checked as maintainer feedback and sent to the
 *      curator queue.
 *   4. After that routing, a ready-label reconcile is invoked (never a
 *      500) on pull_request synchronize/closed/converted_to_draft/
 *      ready_for_review/reopened, pull_request_review_thread
 *      resolved/unresolved, pull_request_review_comment created/deleted,
 *      and issue_comment created/deleted on a pull request. It still
 *      runs when review routing returns 500: GitHub does not retry a
 *      failed delivery, and a push that failed to queue must still drop
 *      the ready label. The thread event is not curator feedback.
 *
 * Status codes: 401 for a bad signature, 400 for a payload this code
 * cannot use, 500 when the work could not be queued. GitHub does not
 * retry failed deliveries; they can be redelivered from the App's
 * advanced settings. When queuing fails, the delivery's idempotency key
 * is released, and an automatic review gives back its round and pending
 * marker, so that a redelivery is processed again.
 */

export interface ApiGatewayResponse {
  readonly statusCode: number;
  readonly body: string;
}

export interface SendOptions {
  /** SQS per-message delay, at most 900 seconds. */
  readonly delaySeconds?: number;
}

export interface DeliveryDeps {
  /** The webhook secret. refresh=true fetches it again after a mismatch. */
  readonly webhookSecret: (refresh: boolean) => Promise<string>;
  readonly store: DeliveryStore;
  readonly sendMessage: (
    queueUrl: string,
    body: object,
    attributes: Readonly<Record<string, string | number>>,
    options?: SendOptions,
  ) => Promise<void>;
  /** A GitHub client authenticated as the installation. */
  readonly github: (installationId: number) => Promise<GitHubApi>;
  readonly approveInstruction: (instruction: string) => Promise<Verdict>;
  /**
   * Reconcile the ready-for-human-review label. Fire-and-forget: a
   * failure is logged and never fails the delivery.
   */
  readonly syncReadyLabel?: (args: {
    readonly installationId: number;
    readonly repo: string;
    readonly prNumber: number;
  }) => Promise<void>;
  readonly log?: (line: string) => void;
}

interface Outcome {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

interface Target {
  readonly repo: string;
  readonly installationId: number;
}

const FEEDBACK_EVENTS: ReadonlySet<string> = new Set(['issue_comment', 'pull_request_review_comment', 'pull_request_review']);
const THREAD_EVENT = 'pull_request_review_thread';
/** pull_request / thread / review-comment actions that can change the ready label. */
const READY_LABEL_PULL_ACTIONS: ReadonlySet<string> = new Set([
  'synchronize', 'closed', 'converted_to_draft', 'ready_for_review', 'reopened',
]);
const READY_LABEL_THREAD_ACTIONS: ReadonlySet<string> = new Set(['resolved', 'unresolved']);
const READY_LABEL_COMMENT_ACTIONS: ReadonlySet<string> = new Set(['created', 'deleted']);
/** The pull_request actions that start an automatic review, and the trigger each sends. */
const REVIEW_TRIGGERS: ReadonlyMap<string, AutomaticTrigger> = new Map([
  ['opened', 'opened'],
  ['reopened', 'reopened'],
  ['ready_for_review', 'ready_for_review'],
  ['synchronize', 'push'],
]);
/**
 * What each trigger appends to its review's idempotency key and run
 * nonce, and so to the run's heartbeat key. An opened pull request's
 * review appends nothing.
 */
const TRIGGER_NONCES: ReadonlyMap<AutomaticTrigger, string> = new Map([
  ['reopened', 'reopened'],
  ['ready_for_review', 'ready'],
  ['push', 'push'],
]);
/**
 * The pull_request actions after which the runtime skips a waiting
 * automatic review, each with the trigger that asks for the review
 * again: closed until reopened, and, on skipDrafts routes,
 * converted_to_draft until ready_for_review.
 */
const LEAVING_ACTIONS: ReadonlyMap<string, AutomaticTrigger> = new Map([
  ['closed', 'reopened'],
  ['converted_to_draft', 'ready_for_review'],
]);

/** The idempotency key of an automatic review: repo#pr#head_sha, then the trigger's nonce. */
function reviewKey(repo: string, prNumber: number, headSha: string, trigger: AutomaticTrigger): string {
  const nonce = TRIGGER_NONCES.get(trigger);
  return `${repo}#${prNumber}#${headSha}${nonce ? `#${nonce}` : ''}`;
}

const skip = (reason: string): Outcome => ({ status: 200, body: { ok: true, skipped: reason } });
const fail = (status: number, error: string): Outcome => ({ status, body: { error } });

/** The decision= value of the delivery log line, which scripts/dump-hour.sh tallies. */
function decisionOf(outcome: Outcome): string {
  const b = outcome.body;
  if (b.skipped) return `skipped:${b.skipped}`;
  if (b.enqueued) return `enqueued:${b.enqueued}`;
  if (b.error) return `err:${b.error}`;
  return b.ok ? 'ok' : 'unknown';
}

/** Log values are single tokens so the key=value line splits on spaces. */
function token(value: unknown): string {
  return value === undefined || value === null || value === '' ? '-' : String(value).replace(/\s+/g, '_');
}

export function createDeliveryHandler(
  config: ReceiverConfig,
  deps: DeliveryDeps,
): (event: ApiGatewayEvent) => Promise<ApiGatewayResponse> {
  const isBotAuthor = botMatcher(config.botLogin, config.knownBotLogins);
  const log = deps.log ?? ((line: string) => console.log(line));
  const release = (key: string): Promise<void> => deps.store.release(key);

  async function returnAutoReviewQuietly(repo: string, prNumber: number): Promise<void> {
    try {
      await deps.store.returnAutoReview(repo, prNumber);
    } catch (err) {
      console.error(`[store] could not give back an automatic review of ${repo}#${prNumber}; the pull request has one fewer`, err);
    }
  }

  /**
   * pullRequestLeft: gives back the round of the review that waits as the
   * pull request leaves, which the runtime is going to skip. True when
   * this call gave it back.
   */
  async function giveBackWaitingRoundQuietly(repo: string, prNumber: number, action: string): Promise<boolean> {
    try {
      if (!(await deps.store.markRoundGivenBack(repo, prNumber))) return false;
      await deps.store.returnAutoReview(repo, prNumber);
      return true;
    } catch (err) {
      console.error(`[store] could not give back the round of the review of ${repo}#${prNumber} that waits after ${action}; if that review is skipped, it still uses its round`, err);
      return false;
    }
  }

  /**
   * An event that joins a waiting review whose round pullRequestLeft gave
   * back: the pull request is back, so the review runs, and takes its
   * round again.
   */
  async function retakeWaitingRoundQuietly(routeId: string, repo: string, prNumber: number): Promise<void> {
    const cap = config.maxAutomaticReviewsPerPr;
    try {
      if (!(await deps.store.clearRoundGivenBack(repo, prNumber))) return;
      const round = await deps.store.takeAutoReview(repo, prNumber, cap);
      if (round === 0) {
        console.warn(`[auto-review] route=${routeId} repo=${repo} pr=${prNumber} cap=${cap} reached; the waiting review runs without a round`);
      } else {
        log(`[auto-review] route=${routeId} repo=${repo} pr=${prNumber} round=${round}/${cap} taken again by the waiting review`);
      }
    } catch (err) {
      console.error(`[store] could not take the round of the waiting review of ${repo}#${prNumber} again; the pull request has one more`, err);
    }
  }

  async function clearPendingQuietly(repo: string, prNumber: number, marker: string): Promise<void> {
    try {
      await deps.store.clearReviewPending(repo, prNumber, marker);
    } catch (err) {
      console.error(`[store] could not clear the pending marker of ${repo}#${prNumber}; automatic reviews are skipped until it expires`, err);
    }
  }

  async function signatureMatches(body: Buffer, header: string | undefined): Promise<boolean> {
    if (!header) return false;
    const secret = await deps.webhookSecret(false);
    if (verifySignature(body, header, secret)) return true;
    const fresh = await deps.webhookSecret(true);
    return fresh !== secret && verifySignature(body, header, fresh);
  }

  async function enqueueClaimed(
    key: string,
    queueUrl: string,
    body: object,
    attributes: Readonly<Record<string, string | number>>,
  ): Promise<Outcome> {
    try {
      await deps.sendMessage(queueUrl, body, attributes);
    } catch (err) {
      await releaseQuietly(release, key);
      throw err;
    }
    return { status: 200, body: { ok: true, enqueued: key } };
  }

  /**
   * closed, and converted_to_draft on a skipDrafts route. If an
   * automatic review of the pull request waits, and starts before the
   * pull request is reopened or marked ready, the runtime skips it and
   * records its run completed. The reopen or ready_for_review that then
   * asks for the review again at this head must not be dropped as the
   * duplicate of an earlier one, so while a review waits, that event's
   * key is released. The waiting review's round is given back too, once
   * per marker, so a skipped review does not use up one of the pull
   * request's automatic reviews. Its budget slot is not: the day may
   * have changed since. If the pull request comes back before the review
   * starts, the event joins it, and the review takes its round again
   * (pullRequest). The head is then reviewed, but the key is free, so one
   * more close and reopen (or draft and ready) at that head reviews it
   * again and uses a round.
   *
   * With no review waiting the key stays, so closing and reopening a
   * pull request (to run CI again, say), or a draft marked ready again,
   * at a head that was already reviewed does not use a round each time.
   * What remains: an event in the seconds between the worker starting a
   * review and the runtime reading the pull request finds no review
   * waiting, yet the runtime skips that review. A reopen or
   * ready_for_review at this head whose key is already taken is then
   * dropped, and the skipped review keeps its round. In the same seconds
   * the other way round, a pull request that comes back after the worker
   * started a review whose round was given back, but before the runtime
   * reads it, gets that review without a round.
   *
   * The event itself never reviews: it is acknowledged as skipped, and a
   * store error is logged instead of failing the delivery.
   */
  async function pullRequestLeft(payload: WebhookPayload, target: Target, action: string, back: AutomaticTrigger): Promise<Outcome> {
    const { repo } = target;
    const outcome = skip(`action=${action}`);
    const pr = payload.pull_request;
    const prNumber = pr?.number;
    const headSha = pr?.head?.sha;
    if (isBotAuthor(pr?.user) || typeof prNumber !== 'number' || !headSha) return outcome;
    // A merged pull request cannot be reopened.
    if (action === 'closed' && pr?.merged === true) return outcome;
    const route = config.reviewRoutes.get(repo.toLowerCase());
    if (!route || route.mentionOnly) return outcome;
    // Other routes neither review on ready_for_review nor skip a draft.
    if (back === 'ready_for_review' && !route.skipDrafts) return outcome;

    const key = reviewKey(repo, prNumber, headSha, back);
    try {
      if (!(await deps.store.hasPendingReview(repo, prNumber))) return outcome;
      await release(key);
    } catch (err) {
      console.error(`[store] could not release ${key} after ${action}; if the waiting review is skipped, a ${back} event at this head is dropped as a duplicate`, err);
      return outcome;
    }
    const gaveBack = await giveBackWaitingRoundQuietly(repo, prNumber, action);
    log(`[auto-review] route=${route.routeId} repo=${repo} pr=${prNumber} head=${headSha} ${action} while a review waits; released ${key}${gaveBack ? ' and gave back its round' : ''} in case that review is skipped`);
    return outcome;
  }

  async function pullRequest(payload: WebhookPayload, target: Target): Promise<Outcome> {
    const { repo } = target;
    const action = payload.action ?? '';
    const back = LEAVING_ACTIONS.get(action);
    if (back) return pullRequestLeft(payload, target, action, back);
    // Narrowed further per route below; anything else never reviews.
    const trigger = REVIEW_TRIGGERS.get(action);
    if (!trigger) return skip(`action=${action}`);

    // Dependency bumps and other automated PRs are not reviewed.
    const pr = payload.pull_request;
    if (isBotAuthor(pr?.user)) return skip(`bot-author=${token(pr?.user?.login)}`);

    const prNumber = pr?.number;
    const headSha = pr?.head?.sha;
    if (typeof prNumber !== 'number' || !headSha) return fail(400, 'missing-pr-fields');

    const route = config.reviewRoutes.get(repo.toLowerCase());
    if (!route) return skip(`unrouted-repo=${repo}`);
    if (route.mentionOnly) return skip(`mention-only-route=${route.routeId}`);

    // skipDrafts routes review a draft when it is marked ready
    // (ready_for_review, which always has draft=false), and skip new
    // commits on a draft. Other routes review on open and on new commits,
    // draft or not, and ignore ready_for_review.
    if (route.skipDrafts) {
      if (pr?.draft === true) return skip('draft');
    } else if (action === 'ready_for_review') {
      return skip(`action=${action}`);
    }

    if (route.authorAllowlist.length > 0) {
      const author = (pr?.user?.login ?? '').toLowerCase();
      if (!route.authorAllowlist.includes(author)) return skip(`author-not-allowed=${token(author)}`);
    }

    // Each trigger has its own key and heartbeat nonce (TRIGGER_NONCES),
    // except that opened has none. The key is kept for 24 hours, so one
    // review must not stand in for the review another trigger asks for:
    //   - A draft's head may already have been reviewed while the PR was
    //     briefly open as non-draft, and that review must not stand in
    //     for the one it gets when marked ready.
    //   - The runtime skips an automatic review, and records its run
    //     completed, when by the time the run starts the PR is closed, or
    //     a draft on a skipDrafts route. A reopen at that head must not
    //     then be dropped as the duplicate of a skipped review (opened,
    //     or new commits), nor its run be taken for done by the worker.
    // The cost: a reopen at a head that was already reviewed is reviewed
    // again, and uses a round. Only the first reopen at a head does; a
    // later one is its duplicate, unless pullRequestLeft released its key
    // because the pull request was closed while a review waited. That is
    // also how a skipped review of a reopen or ready_for_review, which
    // holds that trigger's own key, does not drop the next one.
    const pushed = trigger === 'push';
    const nonce = TRIGGER_NONCES.get(trigger);
    const key = reviewKey(repo, prNumber, headSha, trigger);
    if (!(await deps.store.claim(key, { action }))) return skip('duplicate');

    // What this review has taken so far, given back newest first when it
    // is not queued, so a redelivery can try again. Each step logs its
    // own failure instead of throwing.
    const taken: (() => Promise<void>)[] = [() => releaseQuietly(release, key)];
    const giveBack = async (): Promise<void> => {
      for (let undo = taken.pop(); undo; undo = taken.pop()) await undo();
    };

    // A skipped delivery relies on the marker's owner, the waiting review,
    // to cover its head. The owner takes the marker before its cap and
    // budget checks and gives it back when it does not queue (a store
    // error or a failed send, as well as the cap and the budget). So the
    // skipped delivery's key is released, and a redelivery of it is
    // processed instead of being dropped as a duplicate. What remains:
    // GitHub does not redeliver on its own, so in that case this head is
    // reviewed only after a manual redelivery or the next push; and a
    // redelivery that comes after the waiting review has started queues
    // another review of this head. A review that waits for another review
    // of the pull request past its run budget is not dropped: the worker
    // runs it then (src/watchdog.ts).
    const joinWaitingReview = async (): Promise<Outcome> => {
      await giveBack();
      await retakeWaitingRoundQuietly(route.routeId, repo, prNumber);
      log(`[auto-review] route=${route.routeId} repo=${repo} pr=${prNumber} head=${headSha} joins the waiting review; skipped`);
      return skip('auto-review-pending');
    };

    try {
      // Every automatic review holds the pull request's pending marker
      // from here until the worker starts its run, so at most one waits
      // at a time. A push, reopen or ready_for_review that comes while one
      // waits joins it instead of using a round: the runtime reviews the
      // head as it is when the run starts. A review of new commits also
      // waits in the queue first, so that a burst of pushes gets one
      // review. An event after the waiting review has started queues the
      // next review.
      //
      // A marker can outlive its review. Until it expires, an hour after
      // its delay, every automatic review of the pull request then joins
      // a review that is not waiting any more. That happens when:
      //   - the review worker lacks IDEMPOTENCY_TABLE, or GetItem on that
      //     table: the review runs and leaves its marker;
      //   - the worker lacks DeleteItem on it: the review never runs, and
      //     dead-letters;
      //   - this function stops (a timeout) after taking the marker and
      //     before the send, or before giving the marker back;
      //   - the worker hits a store error while it lets go of the marker
      //     of a review it drops, which it logs.
      // A worker without UpdateItem on that table only lets a waiting
      // review's marker expire. infra/lib/webhook-stack.ts must give each
      // review worker IDEMPOTENCY_TABLE and all three grants on it.
      const marker = await deps.store.markReviewPending(repo, prNumber, pushed ? config.pushReviewDelaySeconds : 0);
      if (marker === null) return await joinWaitingReview();
      taken.push(() => clearPendingQuietly(repo, prNumber, marker));

      const cap = config.maxAutomaticReviewsPerPr;
      const round = await deps.store.takeAutoReview(repo, prNumber, cap);
      if (round === 0) {
        await giveBack();
        log(`[auto-review] route=${route.routeId} repo=${repo} pr=${prNumber} cap=${cap} reached; skipped`);
        return skip('auto-review-cap');
      }
      taken.push(() => returnAutoReviewQuietly(repo, prNumber));

      if (!(await deps.store.takeReviewSlot(route.routeId, config.dailyReviewBudget))) {
        // Given back so a redelivery after the budget resets can still review.
        await giveBack();
        console.warn(`[budget] route=${route.routeId} daily budget of ${config.dailyReviewBudget} reviews used up; skipped ${repo}#${prNumber}`);
        return skip(`budget-exhausted=${route.routeId}`);
      }

      // A failed send below still uses its budget slot. Failures are rare
      // and the count only has to bound spend. A send that errors after
      // SQS accepted the message (a timeout, say) gives back the round and
      // the marker of a review that will still run: the pull request can
      // then get one automatic review more than the cap, and the worker,
      // finding no marker, runs that review like any other.
      //
      // trigger and skip_drafts let the runtime skip the run if the pull
      // request is closed, or a draft on this route, by the time it starts.
      const envelope: ReviewEnvelope = {
        repo,
        pr_number: prNumber,
        installation_id: target.installationId,
        head_sha: headSha,
        ...(nonce ? { run_nonce: nonce } : {}),
        pending_marker: marker,
        trigger,
        skip_drafts: route.skipDrafts,
      };
      const delay = pushed ? { delaySeconds: config.pushReviewDelaySeconds } : undefined;
      await deps.sendMessage(route.queueUrl, envelope, { repo, pr_number: prNumber, action }, delay);
      log(`[auto-review] route=${route.routeId} repo=${repo} pr=${prNumber} round=${round}/${cap} queued${delay ? ` delay=${delay.delaySeconds}s` : ''}`);
    } catch (err) {
      await giveBack();
      throw err;
    }
    return { status: 200, body: { ok: true, enqueued: key } };
  }

  async function mention(m: Mention, route: ReviewRoute, target: Target): Promise<Outcome> {
    return handleMention(m, target, {
      botLogin: config.botLogin,
      github: await deps.github(target.installationId),
      claim: (key) => deps.store.claim(key, { action: 'mention' }),
      release,
      approveInstruction: deps.approveInstruction,
      enqueue: (envelope) => deps.sendMessage(route.queueUrl, envelope, {
        repo: target.repo,
        pr_number: envelope.pr_number,
        action: 'mention',
      }),
    });
  }

  async function feedback(eventType: string, payload: WebhookPayload, target: Target): Promise<Outcome> {
    const { repo } = target;
    if (!config.curatorQueueUrl) return skip('curator-queue-not-wired');
    const extracted = extractFeedback(eventType, payload, isBotAuthor);
    if ('skip' in extracted) return skip(extracted.skip);
    const route = config.curatorRoutes.get(repo.toLowerCase());
    if (!route) return skip(`unrouted-repo=${repo}`);
    const { item } = extracted;

    const noise = classifyCommentBody(item.body);
    if (noise.noise) return skip(`noise:${noise.reason}`);

    // A reply in a review thread: the thread's first comment says whether
    // the App started the thread, and if it did, the curator gets the
    // App's comment next to the reply. If the lookup fails the reply
    // still goes to the curator, without the App's comment.
    let botCommentBody = '';
    if (item.parentCommentId !== undefined) {
      try {
        const api = await deps.github(target.installationId);
        const parent = await fetchReviewComment(api, repo, item.parentCommentId);
        if (parent) {
          const parentIsApp = isAppLogin(parent.author, config.botLogin);
          if (isAuthorReplyOutsideBotThread({ commenterLogin: item.actor, prAuthorLogin: item.prAuthor, parentIsApp })) {
            return skip('noise:author-reply-to-non-bot');
          }
          if (parentIsApp) botCommentBody = parent.body;
        }
      } catch (err) {
        console.warn(`[feedback] could not read comment ${item.parentCommentId} on ${repo}; forwarding without it`, err);
      }
    }

    const key = `curator#${item.feedbackId}`;
    if (!(await deps.store.claim(key, { eventType }))) return skip('duplicate-feedback');
    const envelope = curatorEnvelope({
      item,
      reviewerId: route.reviewerId,
      repo,
      installationId: target.installationId,
      botCommentBody,
    });
    return enqueueClaimed(key, config.curatorQueueUrl, envelope, {
      repo,
      reviewer_id: route.reviewerId,
      feedback_id: item.feedbackId,
      kind: item.kind,
    });
  }

  /**
   * After review/mention routing. Never raises into the delivery: a
   * failed invoke is logged and the delivery's status stands. Runs even
   * when routing returned 500, so a queue failure on push still drops
   * a stale ready label.
   */
  async function maybeSyncReadyLabel(eventType: string, payload: WebhookPayload, target: Target): Promise<void> {
    if (!deps.syncReadyLabel) return;
    const action = payload.action ?? '';
    const sync = (eventType === 'pull_request' && READY_LABEL_PULL_ACTIONS.has(action))
      || (eventType === THREAD_EVENT && READY_LABEL_THREAD_ACTIONS.has(action))
      || (eventType === 'pull_request_review_comment' && READY_LABEL_COMMENT_ACTIONS.has(action))
      || (eventType === 'issue_comment' && READY_LABEL_COMMENT_ACTIONS.has(action) && payload.issue?.pull_request);
    if (!sync) return;
    const prNumber = payload.pull_request?.number ?? payload.issue?.number;
    if (typeof prNumber !== 'number') return;
    const route = config.reviewRoutes.get(target.repo.toLowerCase());
    if (!route?.readyLabel) return;
    try {
      await deps.syncReadyLabel({ installationId: target.installationId, repo: target.repo, prNumber });
    } catch (err) {
      console.error(`[ready-label] invoke failed repo=${target.repo} pr=${prNumber}`, err);
    }
  }

  async function dispatch(eventType: string, payload: WebhookPayload): Promise<Outcome> {
    if (eventType === 'ping') return { status: 200, body: { ok: true, ping: true } };
    if (eventType !== 'pull_request' && eventType !== THREAD_EVENT && !FEEDBACK_EVENTS.has(eventType)) {
      return skip(`event=${token(eventType)}`);
    }

    const repo = payload.repository?.full_name;
    if (!repo) return fail(400, 'missing-repository');
    const installationId = payload.installation?.id ?? config.installationId;
    if (typeof installationId !== 'number') return fail(400, 'missing-installation');
    const target = { repo, installationId };

    let outcome: Outcome;
    try {
      if (eventType === 'pull_request') {
        outcome = await pullRequest(payload, target);
      } else if (eventType === THREAD_EVENT) {
        // Thread resolve/unresolve never starts a review and is not curator
        // feedback; it only recomputes the ready label.
        outcome = skip(`action=${payload.action ?? ''}`);
      } else {
        // A summons is a command, not feedback: it ends here. A thread reply
        // may start a re-review and then still goes to the curator.
        const m = detectMention(eventType, payload, { botLogin: config.botLogin, isBotAuthor });
        if (m) {
          const route = config.reviewRoutes.get(repo.toLowerCase());
          if (m.kind === 'summon') {
            outcome = route ? await mention(m, route, target) : skip(`mention:unrouted-repo=${repo}`);
          } else if (route?.threadReplyReview) {
            outcome = await mention(m, route, target);
            if (outcome.status < 500) {
              log(`[mention] repo=${repo} pr=${m.prNumber} decision=${decisionOf(outcome)}`);
              outcome = await feedback(eventType, payload, target);
            }
          } else {
            outcome = await feedback(eventType, payload, target);
          }
        } else {
          outcome = await feedback(eventType, payload, target);
        }
      }
    } catch (err) {
      console.error('[receiver] delivery failed', err);
      outcome = fail(500, 'internal');
    }
    await maybeSyncReadyLabel(eventType, payload, target);
    return outcome;
  }

  return async (event) => {
    const headers = lowercaseHeaders(event);
    const body = rawBody(event);
    // Fields from the payload are logged only once the signature checks out.
    let fields: string | undefined;
    let outcome: Outcome;
    try {
      if (!(await signatureMatches(body, headers['x-hub-signature-256']))) {
        outcome = fail(401, 'bad-signature');
      } else {
        const eventType = headers['x-github-event'] ?? '';
        let payload: WebhookPayload | undefined;
        try {
          const parsed: unknown = JSON.parse(body.toString('utf8'));
          if (typeof parsed === 'object' && parsed !== null) payload = parsed as WebhookPayload;
        } catch {
          // Reported as bad-json below.
        }
        fields = [
          `event=${token(eventType)}`,
          `action=${token(payload?.action)}`,
          `repo=${token(payload?.repository?.full_name)}`,
          `actor=${token(payload?.sender?.login)}`,
        ].join(' ');
        outcome = payload ? await dispatch(eventType, payload) : fail(400, 'bad-json');
      }
    } catch (err) {
      console.error('[receiver] delivery failed', err);
      outcome = fail(500, 'internal');
    }
    log(`[delivery] ${fields ? `${fields} ` : ''}status=${outcome.status} decision=${token(decisionOf(outcome))}`);
    return { statusCode: outcome.status, body: JSON.stringify(outcome.body) };
  };
}
