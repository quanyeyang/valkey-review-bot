import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_CONFIG_PATH,
  type DeploymentConfig,
  loadDeploymentConfig,
  parseDeploymentConfig,
  readyLabelsByRepo,
  resolveConfigPath,
  tokenBrokerRepos,
} from '../lib/deployment-config';
import { ACCOUNT, fixture } from './helpers';

/** The error message for `raw`, or a failure if it parses. */
function problems(raw: unknown, env: { CDK_DEFAULT_ACCOUNT?: string } = {}): string {
  try {
    parseDeploymentConfig(raw, env);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected the configuration to be rejected');
}

function withChange(change: (raw: any) => void): any {
  const raw = fixture();
  change(raw);
  return raw;
}

describe('defaults', () => {
  test('a minimal configuration gets the product defaults', () => {
    const config = parseDeploymentConfig(fixture());
    expect(config.aws.bootstrapQualifier).toBe('hnb659fds');
    expect(config.models).toEqual({
      reviewer: { primary: 'us.anthropic.claude-opus-5-5', fallback: 'openai.gpt-6.1-sol', effort: 'high' },
      curator: { primary: 'us.anthropic.claude-opus-5-5', fallback: 'openai.gpt-6.1-sol', effort: 'medium', fallbackEffort: 'high' },
      summarizer: { primary: 'us.anthropic.claude-haiku-5-5', fallback: 'openai.gpt-6.1-sol' },
      safetyGate: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      profileRegions: ['us-east-1', 'us-east-2', 'us-west-2'],
      mantleRegion: 'us-east-1',
      mantleGrantRegions: ['us-east-1'],
      extraGrants: [],
    });
    expect(config.agents).toEqual({
      'valkey-review': { maxIterations: 150, maxTokens: 32768, allowBuild: true, allowWrite: true },
      'valkey-glide-review': { maxIterations: 150, maxTokens: 32768, allowBuild: true, allowWrite: true },
      curator: { maxIterations: 40, maxTokens: 16384, graduationThreshold: 4 },
    });
    expect(config.upstreamRepos).toEqual({ 'valkey-review': 'valkey-io/valkey', 'valkey-glide-review': 'valkey-io/valkey-glide' });
    expect(config.decay).toEqual({ halfLifeDays: 30, floor: 0.05, graduatedHalfLifeDays: 180 });
    // Report mode: nothing edits, retires or opens a pull request until the operator turns it on.
    expect(config.skillLifecycle).toEqual({
      checksPerDay: 10,
      recheckDays: 90,
      applyEdits: false,
      retireSkills: false,
      openPullRequests: false,
      maxRetirementsPerDay: 3,
      maxCheckRounds: 25,
      retireRefusedBackoffDays: 30,
    });
    expect(config).not.toHaveProperty('skillsRepo');
    expect(config.dailyReviewBudget).toBe(40);
    expect(config.maxAutomaticReviewsPerPr).toBe(3);
    expect(config.pushReviewDelaySeconds).toBe(300);
    expect(config.github.installationId).toBeUndefined();
    expect(config.github.knownBotLogins).toBeUndefined();
    expect(config.routes[0]).toEqual({
      id: 'valkey-review', reviewer: 'valkey-review', repo: 'example-org/valkey',
      threadReplyReview: false, skipDrafts: false, mentionOnly: false, authorAllowlist: [],
    });
    expect(config.routes[0]).not.toHaveProperty('readyLabel');
    expect(readyLabelsByRepo(config)).toEqual({});
  });

  test('the committed example parses and holds placeholders only', () => {
    const file = path.join(__dirname, '..', 'deploy.config.example.json');
    const config = parseDeploymentConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    expect(config.aws.account).toBe(ACCOUNT);
    expect(config.github.appId).toBe('123456');
    expect(config.github.botLogin).toBe('your-app-slug[bot]');
    expect(config.routes.length).toBeGreaterThan(0);
    for (const route of config.routes) expect(route.repo.startsWith('your-org/')).toBe(true);
    // Maintainers can answer the bot in its review threads on every route.
    for (const route of config.routes) expect({ route: route.id, threadReplyReview: route.threadReplyReview }).toEqual({ route: route.id, threadReplyReview: true });
    // The example ships in report mode.
    expect(config.skillLifecycle).toMatchObject({ applyEdits: false, retireSkills: false, openPullRequests: false });
    expect(config.skillsRepo?.repo.startsWith('your-org/')).toBe(true);
  });

  test('the committed example spells out every skill lifecycle and review round setting at its default', () => {
    const file = path.join(__dirname, '..', 'deploy.config.example.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const defaults = parseDeploymentConfig(fixture());
    expect(raw.skillLifecycle).toEqual(defaults.skillLifecycle);
    expect(raw.decay).toEqual(defaults.decay);
    expect(raw.maxAutomaticReviewsPerPr).toBe(defaults.maxAutomaticReviewsPerPr);
    expect(raw.pushReviewDelaySeconds).toBe(defaults.pushReviewDelaySeconds);
  });

  test("each reviewer's token broker covers exactly that reviewer's review routes", () => {
    const config = parseDeploymentConfig(fixture());
    expect(tokenBrokerRepos(config, 'valkey-review')).toEqual(['example-org/valkey', 'upstream-org/valkey']);
    expect(tokenBrokerRepos(config, 'valkey-glide-review')).toEqual(['example-org/valkey-glide']);
  });

  test('a repository named . or .. is refused, as the decay job and the curator refuse it', () => {
    const message = problems(withChange((raw) => {
      raw.upstreamRepos = { 'valkey-review': 'valkey-io/..', 'valkey-glide-review': 'valkey-io/.' };
      raw.routes[0].repo = 'example-org/..';
    }));
    expect(message).toContain('upstreamRepos.valkey-review must be owner/name');
    expect(message).toContain('upstreamRepos.valkey-glide-review must be owner/name');
    expect(message).toContain('routes[0].repo must be owner/name');
    expect(parseDeploymentConfig(withChange((raw) => { raw.upstreamRepos = { 'valkey-review': 'valkey-io/.valkey..x' }; }))
      .upstreamRepos['valkey-review']).toBe('valkey-io/.valkey..x');
  });

  test('an empty upstream repository means "use the pull request repository"', () => {
    const config = parseDeploymentConfig(withChange((raw) => { raw.upstreamRepos = { 'valkey-review': '' }; }));
    expect(config.upstreamRepos['valkey-review']).toBe('');
    expect(config.upstreamRepos['valkey-glide-review']).toBe('valkey-io/valkey-glide');
  });
});

describe('aws', () => {
  test('account must be 12 digits and region region-shaped', () => {
    const message = problems(withChange((raw) => { raw.aws = { account: '1234', region: 'uswest2' }; }));
    expect(message).toContain('aws.account must be a 12-digit AWS account ID');
    expect(message).toContain('aws.region must be an AWS region');
  });

  test('account must match the credentials the CDK CLI is using', () => {
    expect(problems(fixture(), { CDK_DEFAULT_ACCOUNT: '222222222222' }))
      .toContain('aws.account is 111111111111 but the current AWS credentials are for account 222222222222');
    expect(() => parseDeploymentConfig(fixture(), { CDK_DEFAULT_ACCOUNT: ACCOUNT })).not.toThrow();
  });

  test('bootstrap qualifier is validated', () => {
    expect(problems(withChange((raw) => { raw.aws.bootstrapQualifier = 'Not_Valid!'; }))).toContain('aws.bootstrapQualifier');
  });

  test('every problem is reported at once', () => {
    const message = problems({});
    for (const key of ['aws is required', 'github is required', 'skillsRegistries is required', 'routes is required']) {
      expect(message).toContain(key);
    }
  });

  test('unknown keys are rejected so typos do not pass silently', () => {
    expect(problems(withChange((raw) => { raw.dailyReviewBudgett = 3; }))).toContain('config.dailyReviewBudgett is not a known setting');
    expect(problems(withChange((raw) => { raw.models = { reviewer: { primay: 'x.y' } }; })))
      .toContain('models.reviewer.primay is not a known setting');
  });
});

describe('github', () => {
  test('app and installation ids are digits', () => {
    const message = problems(withChange((raw) => { raw.github.appId = 'abc'; raw.github.installationId = '12x'; }));
    expect(message).toContain('github.appId must be the numeric GitHub App ID');
    expect(message).toContain('github.installationId must be a numeric installation ID');
  });

  test('bot login ends with [bot]', () => {
    expect(problems(withChange((raw) => { raw.github.botLogin = 'example-reviewer'; }))).toContain('github.botLogin must end with [bot]');
  });

  test('secret name is required', () => {
    expect(problems(withChange((raw) => { delete raw.github.appSecretName; }))).toContain('github.appSecretName is required');
  });

  test('known bot logins must be logins', () => {
    expect(problems(withChange((raw) => { raw.github.knownBotLogins = ['ok-bot[bot]', 'not a login']; })))
      .toContain('github.knownBotLogins[1]');
  });
});

describe('skillsRegistries', () => {
  const arn = (partition: string, region: string, account: string) =>
    `arn:${partition}:agent-registry:${region}:${account}:registry/abc_123`;

  test('accepts IDs and ARNs in the deployment partition, region and account', () => {
    const config = parseDeploymentConfig(withChange((raw) => {
      raw.skillsRegistries.curator = arn('aws', 'us-west-2', ACCOUNT);
    }));
    expect(config.skillsRegistries.curator).toBe(arn('aws', 'us-west-2', ACCOUNT));
  });

  test.each([
    ['another account', arn('aws', 'us-west-2', '222222222222')],
    ['another region', arn('aws', 'us-east-1', ACCOUNT)],
    ['another partition', arn('aws-cn', 'us-west-2', ACCOUNT)],
  ])('rejects an ARN in %s', (_label, value) => {
    expect(problems(withChange((raw) => { raw.skillsRegistries['valkey-review'] = value; })))
      .toContain('skillsRegistries.valkey-review must be in partition aws, region us-west-2 and account 111111111111');
  });

  test('rejects values that are neither IDs nor agent-registry ARNs', () => {
    for (const value of ['has spaces', `arn:aws:bedrock-agentcore:us-west-2:${ACCOUNT}:registry/abc`, '']) {
      expect(problems(withChange((raw) => { raw.skillsRegistries['valkey-glide-review'] = value; })))
        .toContain('skillsRegistries.valkey-glide-review must be a registry ID');
    }
  });

  test('every registry is required', () => {
    expect(problems(withChange((raw) => { delete raw.skillsRegistries.curator; }))).toContain('skillsRegistries.curator is required');
  });
});

describe('routes', () => {
  test('at least one route', () => {
    expect(problems(withChange((raw) => { raw.routes = []; }))).toContain('routes must list at least one route');
  });

  test('route ids are unique, also after construct-id normalization', () => {
    expect(problems(withChange((raw) => { raw.routes[1].id = 'valkey-review'; }))).toContain('routes[1].id');
    expect(problems(withChange((raw) => { raw.routes[1].id = 'valkeyreview'; })))
      .toContain('routes[1].id "valkeyreview" collides with route "valkey-review"');
  });

  test('a repository has one route, across review and curator-only routes, ignoring case', () => {
    expect(problems(withChange((raw) => { raw.routes[1].repo = 'Example-Org/Valkey'; })))
      .toContain('routes[1].repo repeats repository Example-Org/Valkey');
    expect(problems(withChange((raw) => { raw.curatorOnlyRoutes[0].repo = 'example-org/valkey'; })))
      .toContain('curatorOnlyRoutes[0].repo repeats repository example-org/valkey');
  });

  test('repo is owner/name and reviewer is a known reviewer', () => {
    const message = problems(withChange((raw) => {
      raw.routes[0].repo = 'just-a-name';
      raw.routes[1].reviewer = 'valkey-other-review';
    }));
    expect(message).toContain('routes[0].repo must be owner/name');
    expect(message).toContain('routes[1].reviewer must be one of valkey-review, valkey-glide-review');
  });

  test('flags are booleans and the allowlist holds logins', () => {
    const message = problems(withChange((raw) => {
      raw.routes[0].skipDrafts = 'yes';
      raw.routes[0].authorAllowlist = ['bad login'];
    }));
    expect(message).toContain('routes[0].skipDrafts must be true or false');
    expect(message).toContain('routes[0].authorAllowlist[0]');
  });

  test('readyLabel is optional, 1 to 50 characters, and not whitespace-only or CR/LF', () => {
    expect(parseDeploymentConfig(withChange((raw) => { raw.routes[0].readyLabel = ''; })).routes[0])
      .not.toHaveProperty('readyLabel');
    const labeled = parseDeploymentConfig(withChange((raw) => { raw.routes[0].readyLabel = 'ready-for-human-review'; }));
    expect(labeled.routes[0].readyLabel).toBe('ready-for-human-review');
    expect(readyLabelsByRepo(labeled)).toEqual({ 'example-org/valkey': 'ready-for-human-review' });
    expect(problems(withChange((raw) => { raw.routes[0].readyLabel = '   '; }))).toContain('routes[0].readyLabel');
    expect(problems(withChange((raw) => { raw.routes[0].readyLabel = 'ready\nfor-review'; }))).toContain('routes[0].readyLabel');
    expect(problems(withChange((raw) => { raw.routes[0].readyLabel = 'x'.repeat(51); }))).toContain('routes[0].readyLabel');
  });
});

describe('models', () => {
  test('effort is one of the supported levels', () => {
    expect(problems(withChange((raw) => { raw.models = { reviewer: { effort: 'extreme' } }; })))
      .toContain('models.reviewer.effort must be one of low, medium, high, xhigh, max');
  });

  test('us.* profiles need a us-* region and us-* profile regions', () => {
    expect(problems(withChange((raw) => { raw.aws.region = 'eu-west-1'; })))
      .toContain('models.reviewer.primary is a us.* inference profile, which needs aws.region to be a us-* region outside GovCloud (got eu-west-1)');
    expect(problems(withChange((raw) => { raw.models = { profileRegions: ['us-east-1', 'eu-west-1'] }; })))
      .toContain('models.profileRegions contains eu-west-1');
  });

  /** Every Bedrock model setting on `profile`, with the openai.* fallbacks left as they are. */
  const allOn = (profile: string, profileRegions: string[]) => ({
    reviewer: { primary: profile },
    curator: { primary: profile },
    summarizer: { primary: profile },
    safetyGate: profile,
    profileRegions,
  });

  test.each([
    ['us-gov', 'us-gov-west-1', ['us-gov-west-1', 'us-gov-east-1']],
    ['eu', 'eu-central-1', ['eu-central-1', 'eu-west-1']],
    ['apac', 'ap-southeast-1', ['ap-southeast-1', 'ap-northeast-1']],
    ['jp', 'ap-northeast-1', ['ap-northeast-1', 'ap-northeast-3']],
    ['au', 'ap-southeast-2', ['ap-southeast-2', 'ap-southeast-4']],
    ['in', 'ap-south-1', ['ap-south-1', 'ap-south-2']],
    ['ca', 'ca-central-1', ['ca-central-1', 'ca-west-1']],
  ])('%s.* profiles are accepted in their own geography', (group, region, profileRegions) => {
    const config = parseDeploymentConfig(withChange((raw) => {
      raw.aws.region = region;
      raw.models = allOn(`${group}.anthropic.claude-haiku-5-5`, profileRegions);
    }));
    expect(config.models.safetyGate).toBe(`${group}.anthropic.claude-haiku-5-5`);
  });

  test.each([
    ['us', 'us-gov-west-1', 'a us-* region outside GovCloud'],
    ['us-gov', 'us-east-1', 'a us-gov-* region'],
    ['jp', 'eu-west-1', 'an ap-* region'],
    ['au', 'us-west-2', 'an ap-* region'],
    ['ca', 'us-east-1', 'a ca-* region'],
  ])('%s.* profiles are rejected from %s', (group, region, expected) => {
    const message = problems(withChange((raw) => {
      raw.aws.region = region;
      raw.models = allOn(`${group}.anthropic.claude-haiku-5-5`, [region]);
    }));
    expect(message).toContain(`models.safetyGate is a ${group}.* inference profile, which needs aws.region to be ${expected} (got ${region})`);
    expect(message).toContain(`models.profileRegions contains ${region}, which ${group}.* profile`);
  });

  test('profile regions must suit every profile group in use', () => {
    const message = problems(withChange((raw) => {
      raw.aws.region = 'ap-northeast-1';
      raw.models = { ...allOn('apac.anthropic.claude-haiku-5-5', ['ap-northeast-1', 'eu-west-1']), extraGrants: ['jp.anthropic.claude-haiku-5-5'] };
    }));
    expect(message).toContain('models.profileRegions contains eu-west-1, which apac.* profile');
    expect(message).toContain('models.profileRegions contains eu-west-1, which jp.* profile');
  });

  test('a first token that is not a region group is a model provider', () => {
    const config = parseDeploymentConfig(withChange((raw) => {
      raw.aws.region = 'eu-west-1';
      raw.models = { ...allOn('anthropic.claude-haiku-4-5-20251001-v1:0', []), extraGrants: ['constructor.not-a-group'] };
    }));
    expect(config.models.profileRegions).toEqual([]);
  });

  test('a geographic profile needs profile regions', () => {
    expect(problems(withChange((raw) => { raw.models = { profileRegions: [] }; })))
      .toContain('models.profileRegions must list the regions');
  });

  test('global profiles are rejected', () => {
    expect(problems(withChange((raw) => { raw.models = { summarizer: { primary: 'global.anthropic.claude-haiku-5-5' } }; })))
      .toContain('models.summarizer.primary uses a global inference profile');
  });

  test('openai.* models need a Mantle region that is also granted', () => {
    expect(problems(withChange((raw) => { raw.models = { mantleRegion: '' }; })))
      .toContain('models.mantleRegion is required because models.reviewer.fallback');
    expect(problems(withChange((raw) => { raw.models = { mantleRegion: 'us-east-2', mantleGrantRegions: ['us-east-1'] }; })))
      .toContain('models.mantleGrantRegions must include models.mantleRegion (us-east-2)');
  });

  test('without openai.* models the Mantle region may be empty', () => {
    const config = parseDeploymentConfig(withChange((raw) => {
      raw.models = {
        reviewer: { fallback: 'us.anthropic.claude-sonnet-5-5' },
        curator: { fallback: 'us.anthropic.claude-sonnet-5-5' },
        summarizer: { fallback: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' },
        mantleRegion: '',
      };
    }));
    expect(config.models.mantleRegion).toBe('');
    expect(config.models.mantleGrantRegions).toEqual([]);
  });

  test('the safety gate must be a Bedrock model', () => {
    expect(problems(withChange((raw) => { raw.models = { safetyGate: 'openai.gpt-6.1-sol' }; })))
      .toContain('models.safetyGate must be a Bedrock model');
  });

  test('model ids are shaped like Bedrock ids', () => {
    expect(problems(withChange((raw) => { raw.models = { extraGrants: ['no-dot'] }; }))).toContain('models.extraGrants[0]');
  });
});

describe('numbers', () => {
  test('agent limits, decay and budget are range-checked', () => {
    const message = problems(withChange((raw) => {
      raw.agents = { 'valkey-review': { maxIterations: 0 }, curator: { graduationThreshold: 2.5 } };
      raw.decay = { halfLifeDays: 0, floor: 1 };
      raw.dailyReviewBudget = -1;
    }));
    expect(message).toContain('agents.valkey-review.maxIterations must be an integer >= 1');
    expect(message).toContain('agents.curator.graduationThreshold must be an integer');
    expect(message).toContain('decay.halfLifeDays must be a number > 0');
    expect(message).toContain('decay.floor must be a number > 0 and < 1');
    expect(message).toContain('dailyReviewBudget must be an integer >= 0');
  });

  // The same ranges the agents enforce when they boot.
  const agentLimits: [string, number, number][] = [
    ['valkey-review.maxIterations', 1, 500],
    ['valkey-glide-review.maxIterations', 1, 500],
    ['curator.maxIterations', 1, 500],
    ['valkey-review.maxTokens', 1024, 200_000],
    ['valkey-glide-review.maxTokens', 1024, 200_000],
    ['curator.maxTokens', 1024, 200_000],
    ['curator.graduationThreshold', 2, 100],
  ];
  const withAgentSetting = (key: string, value: number) => withChange((raw) => {
    const [agent, setting] = key.split('.') as [string, string];
    raw.agents = { [agent]: { [setting]: value } };
  });
  const agentSetting = (config: DeploymentConfig, key: string): unknown => {
    const [agent, setting] = key.split('.') as [string, string];
    return (config.agents as any)[agent][setting];
  };

  test.each(agentLimits)('agents.%s accepts %d and %d', (key, min, max) => {
    expect(agentSetting(parseDeploymentConfig(withAgentSetting(key, min)), key)).toBe(min);
    expect(agentSetting(parseDeploymentConfig(withAgentSetting(key, max)), key)).toBe(max);
  });

  test.each(agentLimits)('agents.%s rejects values just outside %d to %d', (key, min, max) => {
    const expected = `agents.${key} must be an integer >= ${min} and <= ${max}`;
    expect(problems(withAgentSetting(key, min - 1))).toContain(`${expected} (got ${min - 1})`);
    expect(problems(withAgentSetting(key, max + 1))).toContain(`${expected} (got ${max + 1})`);
  });

  test('a zero budget is allowed and pauses automatic reviews', () => {
    expect(parseDeploymentConfig(withChange((raw) => { raw.dailyReviewBudget = 0; })).dailyReviewBudget).toBe(0);
  });

  // [path, min, max, integer]. The same ranges the decay job, the curator
  // and the receiver enforce, or narrower.
  const ranged: [string, number, number, boolean][] = [
    ['skillLifecycle.checksPerDay', 0, 100, true],
    ['skillLifecycle.recheckDays', 7, 3650, true],
    ['skillLifecycle.maxRetirementsPerDay', 1, 50, true],
    ['skillLifecycle.maxCheckRounds', 5, 100, true],
    ['skillLifecycle.retireRefusedBackoffDays', 1, 3650, true],
    ['maxAutomaticReviewsPerPr', 1, 20, true],
    ['pushReviewDelaySeconds', 0, 900, true],
  ];
  const withSetting = (key: string, value: unknown) => withChange((raw) => {
    const parts = key.split('.');
    let at = raw;
    for (const part of parts.slice(0, -1)) at = at[part] ??= {};
    at[parts.at(-1)!] = value;
  });
  const setting = (config: DeploymentConfig, key: string): unknown => key.split('.').reduce<any>((at, part) => at[part], config);

  test.each(ranged)('%s accepts %d and %d', (key, min, max) => {
    expect(setting(parseDeploymentConfig(withSetting(key, min)), key)).toBe(min);
    expect(setting(parseDeploymentConfig(withSetting(key, max)), key)).toBe(max);
  });

  test.each(ranged)('%s rejects values just outside %d to %d, and fractions', (key, min, max) => {
    const expected = `${key} must be an integer >= ${min} and <= ${max}`;
    expect(problems(withSetting(key, min - 1))).toContain(`${expected} (got ${min - 1})`);
    expect(problems(withSetting(key, max + 1))).toContain(`${expected} (got ${max + 1})`);
    expect(problems(withSetting(key, min + 0.5))).toContain(`${expected} (got ${min + 0.5})`);
    expect(problems(withSetting(key, String(min)))).toContain(`${expected} (got "${min}")`);
  });

  test.each(['applyEdits', 'retireSkills', 'openPullRequests'])('skillLifecycle.%s is a boolean', (key) => {
    expect(problems(withSetting(`skillLifecycle.${key}`, 'true'))).toContain(`skillLifecycle.${key} must be true or false`);
    // openPullRequests needs a skills repository to open them against.
    const on = withSetting(`skillLifecycle.${key}`, true);
    if (key === 'openPullRequests') on.skillsRepo = { repo: 'example-org/valkey-review-bot' };
    expect(setting(parseDeploymentConfig(on), `skillLifecycle.${key}`)).toBe(true);
  });

  test('skillLifecycle rejects unknown keys', () => {
    expect(problems(withSetting('skillLifecycle.applyEdit', true))).toContain('skillLifecycle.applyEdit is not a known setting');
    expect(problems(withChange((raw) => { raw.skillLifecycle = []; }))).toContain('skillLifecycle must be an object');
  });
});

describe('decay', () => {
  test('graduatedHalfLifeDays is a number above 0 and up to 3650', () => {
    expect(parseDeploymentConfig(withChange((raw) => { raw.decay = { graduatedHalfLifeDays: 3650 }; })).decay.graduatedHalfLifeDays).toBe(3650);
    expect(parseDeploymentConfig(withChange((raw) => { raw.decay = { halfLifeDays: 0.5, graduatedHalfLifeDays: 0.5 }; })).decay)
      .toEqual({ halfLifeDays: 0.5, floor: 0.05, graduatedHalfLifeDays: 0.5 });
    for (const value of [0, -1, 3651, '180']) {
      expect(problems(withChange((raw) => { raw.decay = { graduatedHalfLifeDays: value }; })))
        .toContain('decay.graduatedHalfLifeDays must be a number > 0 and <= 3650');
    }
  });

  test('a graduated skill decays no faster than the concerns that have not graduated', () => {
    const message = problems(withChange((raw) => { raw.decay = { halfLifeDays: 60, graduatedHalfLifeDays: 59 }; }));
    expect(message).toContain('decay.graduatedHalfLifeDays must be at least decay.halfLifeDays (got 59 and 60)');
    // The default graduated half-life is checked against a raised halfLifeDays too.
    expect(problems(withChange((raw) => { raw.decay = { halfLifeDays: 200 }; })))
      .toContain('decay.graduatedHalfLifeDays must be at least decay.halfLifeDays (got 180 and 200)');
    expect(parseDeploymentConfig(withChange((raw) => { raw.decay = { halfLifeDays: 60, graduatedHalfLifeDays: 60 }; })).decay.graduatedHalfLifeDays)
      .toBe(60);
  });

  test('an out-of-range half-life is reported once, not also as a comparison', () => {
    const message = problems(withChange((raw) => { raw.decay = { halfLifeDays: 5000, graduatedHalfLifeDays: 100 }; }));
    expect(message).toContain('decay.halfLifeDays must be a number > 0 and <= 3650');
    expect(message).not.toContain('must be at least decay.halfLifeDays');
  });

  test('unknown decay keys are rejected', () => {
    expect(problems(withChange((raw) => { raw.decay = { graduatedHalfLife: 90 }; }))).toContain('decay.graduatedHalfLife is not a known setting');
  });
});

describe('skillsRepo', () => {
  const withSkillsRepo = (value: unknown) => withChange((raw) => { raw.skillsRepo = value; });

  test('only repo is required; the branch is main and the App secret is the main one', () => {
    expect(parseDeploymentConfig(withSkillsRepo({ repo: 'example-org/valkey-review-bot' })).skillsRepo).toEqual({
      repo: 'example-org/valkey-review-bot', baseBranch: 'main', appSecretName: 'example/github-app',
    });
    expect(parseDeploymentConfig(withSkillsRepo({
      repo: 'example-org/valkey-review-bot', baseBranch: 'release/1.0', appSecretName: 'example/skills-app', signOff: 'Jane Doe <jane@example.com>',
    })).skillsRepo).toEqual({
      repo: 'example-org/valkey-review-bot', baseBranch: 'release/1.0', appSecretName: 'example/skills-app', signOff: 'Jane Doe <jane@example.com>',
    });
    expect(problems(withSkillsRepo({}))).toContain('skillsRepo.repo is required');
    expect(problems(withSkillsRepo('example-org/valkey-review-bot'))).toContain('skillsRepo must be an object');
    expect(problems(withSkillsRepo({ repo: 'example-org/x', branch: 'main' }))).toContain('skillsRepo.branch is not a known setting');
  });

  test.each(['just-a-name', 'example-org/..', 'example-org/.', 'example-org/a b'])('repo %j is rejected', (repo) => {
    expect(problems(withSkillsRepo({ repo }))).toContain('skillsRepo.repo must be owner/name of the bot repository');
  });

  test.each(['-main', 'a..b', 'a//b', 'a/.b', '.hidden', 'a/', 'a.', 'a.lock', 'a.lock/b', 'with space', 'a~b', 'a'.repeat(101), ''])(
    'baseBranch %j is rejected', (baseBranch) => {
      expect(problems(withSkillsRepo({ repo: 'example-org/x', baseBranch }))).toContain('skillsRepo.baseBranch must be a branch name');
    });

  test.each(['main', 'trunk', 'release/9.0', 'v2.x_maint', 'a'.repeat(100)])('baseBranch %j is accepted', (baseBranch) => {
    expect(parseDeploymentConfig(withSkillsRepo({ repo: 'example-org/x', baseBranch })).skillsRepo?.baseBranch).toBe(baseBranch);
  });

  test.each([
    'jane@example.com',
    'Jane Doe <jane>',
    'Jane Doe <jane@example.com',
    'Jane Doe<jane@example.com>',
    ' Jane <jane@example.com>',
    'Jane  <jane@example.com>',
    'Jane\tDoe <jane@example.com>',
    'Jane\nDoe <jane@example.com>',
    'Jane <ja ne@example.com>',
    'Jane <jane@@example.com>',
    `${'n'.repeat(101)} <jane@example.com>`,
    '',
  ])('signOff %j is rejected', (signOff) => {
    expect(problems(withSkillsRepo({ repo: 'example-org/x', signOff }))).toContain('skillsRepo.signOff must be one line of the form "Name <email>"');
  });

  test.each(['\u00a0\u00a0 <jane@example.com>', '\u3000 <jane@example.com>', 'Jane\u00a0 <jane@example.com>', '\u00a0Jane <jane@example.com>'])(
    'signOff %j with only whitespace or Unicode spaces at the ends of the name is rejected', (signOff) => {
      expect(problems(withSkillsRepo({ repo: 'example-org/x', signOff })))
        .toContain('skillsRepo.signOff has whitespace at either end of the name, or a name that is only whitespace');
    });

  test('openPullRequests without skillsRepo is rejected', () => {
    expect(problems(withChange((raw) => { delete raw.skillsRepo; raw.skillLifecycle = { ...(raw.skillLifecycle ?? {}), openPullRequests: true }; })))
      .toContain('skillLifecycle.openPullRequests is true but skillsRepo is not set, so there is no repository to open pull requests against');
  });

  test('appSecretName is a secret name', () => {
    expect(problems(withSkillsRepo({ repo: 'example-org/x', appSecretName: 'has spaces' })))
      .toContain('skillsRepo.appSecretName must be a Secrets Manager secret name');
  });

  // The curator checks the same settings when it boots and before every
  // pull request; whatever synthesis accepts, both checks must accept.
  test('every branch and sign-off synthesis accepts, the curator accepts too', () => {
    const curatorSrc = path.join(__dirname, '..', '..', 'agents', 'curator', 'src');
    const regexIn = (file: string, name: string): RegExp => {
      const text = fs.readFileSync(path.join(curatorSrc, file), 'utf8');
      const m = new RegExp(`const ${name} = /(.+)/([a-z]*);`).exec(text);
      if (!m) throw new Error(`no ${name} in ${file}`);
      return new RegExp(m[1]!, m[2]);
    };
    const curatorBranch = regexIn('config.ts', 'BRANCH_RE');
    const signOffs = [regexIn('config.ts', 'SIGN_OFF_RE'), regexIn('repo-skill-pr.ts', 'SIGN_OFF_RE')];
    const branches = ['main', 'trunk', 'release/9.0', 'v2.x_maint', 'a/b/c', 'a'.repeat(100)];
    for (const baseBranch of branches) {
      parseDeploymentConfig(withSkillsRepo({ repo: 'example-org/x', baseBranch }));
      expect({ baseBranch, ok: curatorBranch.test(baseBranch) }).toEqual({ baseBranch, ok: true });
    }
    for (const signOff of ['Jane Doe <jane@example.com>', 'J <j@e>', 'Jane (bot) <ops+bot@mail.example.org>', `${'n'.repeat(100)} <jane@example.com>`]) {
      parseDeploymentConfig(withSkillsRepo({ repo: 'example-org/x', signOff }));
      for (const re of signOffs) expect({ signOff, re: re.source, ok: re.test(signOff) }).toEqual({ signOff, re: re.source, ok: true });
    }
  });
});

describe('loading', () => {
  test('-c config wins over VALKEY_REVIEWER_CONFIG, which wins over the default file', () => {
    expect(resolveConfigPath('a.json', { VALKEY_REVIEWER_CONFIG: 'b.json' })).toBe(path.resolve('a.json'));
    expect(resolveConfigPath(undefined, { VALKEY_REVIEWER_CONFIG: 'b.json' })).toBe(path.resolve('b.json'));
    expect(resolveConfigPath(undefined, {})).toBe(DEFAULT_CONFIG_PATH);
    expect(DEFAULT_CONFIG_PATH).toBe(path.join(__dirname, '..', 'deploy.config.json'));
  });

  test('reads and validates the file, naming it in errors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-config-'));
    try {
      const good = path.join(dir, 'good.json');
      fs.writeFileSync(good, JSON.stringify(fixture()));
      expect(loadDeploymentConfig(good, {}).aws.account).toBe(ACCOUNT);

      const bad = path.join(dir, 'bad.json');
      fs.writeFileSync(bad, '{ not json');
      expect(() => loadDeploymentConfig(bad, {})).toThrow(`${bad} is not valid JSON`);

      expect(() => loadDeploymentConfig(good, { CDK_DEFAULT_ACCOUNT: '222222222222' })).toThrow(good);
      expect(() => loadDeploymentConfig(path.join(dir, 'missing.json'), {})).toThrow('Copy infra/deploy.config.example.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
