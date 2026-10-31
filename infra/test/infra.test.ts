import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Match } from 'aws-cdk-lib/assertions';
import { bedrockModelArns, modelAccessStatements } from '../lib/bedrock-arns';
import { parseDeploymentConfig } from '../lib/deployment-config';
import { routeMaps } from '../lib/webhook-stack';
import {
  ACCOUNT,
  actionsOf,
  fixture,
  functionEnv,
  functionIds,
  functionRoleId,
  resourceStrings,
  roleOfFunction,
  runtimeEnv,
  runtimeRoleId,
  type Statement,
  statementsForRole,
  synth,
  type Synthesized,
} from './helpers';

let s: Synthesized;
beforeAll(() => {
  s = synth();
});

const reviewerTemplate = (id: 'valkey-review' | 'valkey-glide-review') => s.template(s.stacks.reviewers.get(id)!);
const reviewerStatements = (id: 'valkey-review' | 'valkey-glide-review'): Statement[] => {
  const t = reviewerTemplate(id);
  return statementsForRole(t, runtimeRoleId(t));
};
const curatorStatements = (): Statement[] => {
  const t = s.template(s.stacks.curator);
  return statementsForRole(t, runtimeRoleId(t));
};
const bySid = (statements: Statement[], sid: string) => statements.filter((st) => st.Sid === sid);
const registryArn = (id: string) => `arn:aws:agent-registry:us-west-2:${ACCOUNT}:registry/${id}`;

/** Every IAM policy statement in every stack, with the stack and the roles it is attached to. */
function allStatements(x: Synthesized): { stack: string; roles: string[]; statement: Statement }[] {
  return x.allStacks.flatMap((stack) => Object.values<any>(x.template(stack).findResources('AWS::IAM::Policy'))
    .flatMap((policy) => (policy.Properties.PolicyDocument.Statement as Statement[]).map((statement) => ({
      stack: stack.stackName,
      roles: (policy.Properties.Roles ?? []).map((r: any) => r.Ref as string),
      statement,
    }))));
}

describe('no deployment-specific literals', () => {
  test('the only account id in any template is the configured one', () => {
    for (const stack of s.allStacks) {
      const json = JSON.stringify(s.template(stack).toJSON());
      const unexpected = [...new Set(json.match(/(?<![0-9A-Za-z])\d{12}(?![0-9A-Za-z])/g) ?? [])].filter((a) => a !== ACCOUNT);
      expect({ stack: stack.stackName, unexpected }).toEqual({ stack: stack.stackName, unexpected: [] });
    }
  });

  test('a second account synthesizes without the first one anywhere', () => {
    const other = synth({ ...fixture(), aws: { account: '222222222222', region: 'us-west-2' } });
    for (const stack of other.allStacks) {
      expect(JSON.stringify(other.template(stack).toJSON())).not.toContain(ACCOUNT);
    }
  });

  test('no stack sets an explicit export name', () => {
    for (const stack of s.allStacks) {
      for (const [id, output] of Object.entries<any>(s.template(stack).toJSON().Outputs ?? {})) {
        if (output.Export) expect(`${id}:${output.Export.Name}`).toMatch(/^ExportsOutput.*:.*:ExportsOutput/);
      }
    }
  });

  test('no AgentCore memory and no deprecated log retention resources', () => {
    for (const stack of s.allStacks) {
      const t = s.template(stack);
      t.resourceCountIs('AWS::BedrockAgentCore::Memory', 0);
      t.resourceCountIs('Custom::LogRetention', 0);
    }
  });
});

describe('reviewer role', () => {
  test.each(['valkey-review', 'valkey-glide-review'] as const)('%s cannot read secrets, write registries or touch concerns', (id) => {
    const statements = reviewerStatements(id);
    expect(statements.length).toBeGreaterThan(0);
    const actions = statements.flatMap(actionsOf);
    expect(actions.filter((a) => a.startsWith('secretsmanager:'))).toEqual([]);
    expect(actions.filter((a) => a.startsWith('agent-registry:'))).toEqual(['agent-registry:GetRegistryRecord', 'agent-registry:ListRegistryRecords']);
    for (const st of statements.filter((x) => actionsOf(x).some((a) => a.startsWith('dynamodb:')))) {
      const resources = JSON.stringify(st.Resource);
      expect(resources).toContain('RunHeartbeatTable');
      expect(resources).not.toContain('ConcernsTable');
    }
  });

  test('reads only its own registry and its own asset prefix, and may invoke the broker', () => {
    const valkey = reviewerStatements('valkey-review');
    expect(resourceStrings(bySid(valkey, 'ReadSkillsRegistry')))
      .toEqual([registryArn('valkeyRegistry1'), `${registryArn('valkeyRegistry1')}/record/*`]);
    expect(JSON.stringify(valkey)).not.toContain('glideRegistry1');
    const s3 = valkey.filter((st) => actionsOf(st).some((a) => a.startsWith('s3:')));
    expect(s3.map((st) => st.Sid)).toEqual(['ReadAgentAssets']);
    expect(actionsOf(s3[0]!)).toEqual(['s3:GetObject']);
    expect(JSON.stringify(s3[0]!.Resource)).toContain('/valkey-review/*');
    const kms = valkey.filter((st) => actionsOf(st).some((a) => a.startsWith('kms:')));
    expect(kms.flatMap(actionsOf)).toEqual(['kms:Decrypt']);
    expect(JSON.stringify(kms[0]!.Resource)).toContain('SubstrateKey');
    const invoke = valkey.filter((st) => actionsOf(st).includes('lambda:InvokeFunction'));
    expect(JSON.stringify(invoke)).toContain('TokenBrokerValkeyReviewFn');
    expect(JSON.stringify(invoke)).not.toContain('TokenBrokerValkeyGlideReviewFn');
    expect(JSON.stringify(invoke)).not.toContain('ReadyLabelFn');
  });

  test('the curator writes only its own runtime log groups', () => {
    const group = `arn:aws:logs:us-west-2:${ACCOUNT}:log-group:/aws/bedrock-agentcore/runtimes/valkey_reviewer_curator_runtime-*`;
    expect(resourceStrings(bySid(curatorStatements(), 'RuntimeLogs'))).toEqual([group, `${group}:*`]);
  });

  test.each(['valkey-review', 'valkey-glide-review'] as const)('%s sessions end two hours after they start at the latest', (id) => {
    const runtime = Object.values<any>(reviewerTemplate(id).findResources('AWS::BedrockAgentCore::Runtime'))[0];
    expect(runtime.Properties.LifecycleConfiguration).toEqual({ IdleRuntimeSessionTimeout: 900, MaxLifetime: 7200 });
  });

  test.each([
    ['valkey-review', 'valkey_review_runtime'],
    ['valkey-glide-review', 'valkey_glide_review_runtime'],
  ] as const)('%s writes only its own runtime log groups', (id, runtimeName) => {
    const group = `arn:aws:logs:us-west-2:${ACCOUNT}:log-group:/aws/bedrock-agentcore/runtimes/${runtimeName}-*`;
    expect(resourceStrings(bySid(reviewerStatements(id), 'RuntimeLogs'))).toEqual([group, `${group}:*`]);
    expect(Object.values<any>(reviewerTemplate(id).findResources('AWS::BedrockAgentCore::Runtime'))[0].Properties.AgentRuntimeName)
      .toBe(runtimeName);
    const logs = reviewerStatements(id).filter((st) => actionsOf(st).some((a) => a.startsWith('logs:')));
    expect(logs.map((st) => st.Sid)).toEqual(['RuntimeLogs']);
  });

  test('pulls images from the repository of the configured bootstrap qualifier', () => {
    const custom = synth({ ...fixture(), aws: { account: ACCOUNT, region: 'us-west-2', bootstrapQualifier: 'abc123' } });
    const t = custom.template(custom.stacks.reviewers.get('valkey-review')!);
    const pull = statementsForRole(t, runtimeRoleId(t)).find((st) => actionsOf(st).includes('ecr:BatchGetImage'))!;
    expect(pull.Resource).toBe(`arn:aws:ecr:us-west-2:${ACCOUNT}:repository/cdk-abc123-container-assets-${ACCOUNT}-us-west-2`);
  });

  test('runtime environment follows the configuration contract', () => {
    const env = runtimeEnv(reviewerTemplate('valkey-glide-review'));
    expect(Object.keys(env).sort()).toEqual([
      'ALLOW_BUILD', 'ALLOW_WRITE', 'ASSETS_BUCKET', 'AWS_REGION', 'BEDROCK_MODEL_ID', 'FALLBACK_MODEL_ID',
      'GITHUB_APP_ID', 'HEARTBEAT_TABLE', 'MANTLE_REGION', 'MAX_ITERATIONS', 'MAX_TOKENS', 'PROMPT_S3_KEY',
      'REASONING_EFFORT', 'SKILLS_REGISTRY_ID', 'SKILL_S3_KEY', 'SUMMARIZER_FALLBACK_MODEL_ID', 'SUMMARIZER_MODEL_ID',
      'TOKEN_BROKER_FUNCTION', 'UPSTREAM_REPO', 'WORKSPACE_ROOT',
    ]);
    expect(env).toMatchObject({
      BEDROCK_MODEL_ID: 'us.anthropic.claude-opus-5-5',
      FALLBACK_MODEL_ID: 'openai.gpt-6.1-sol',
      REASONING_EFFORT: 'high',
      MANTLE_REGION: 'us-east-1',
      GITHUB_APP_ID: '123456',
      SKILLS_REGISTRY_ID: 'glideRegistry1',
      WORKSPACE_ROOT: '/workspace/valkey-glide',
      UPSTREAM_REPO: 'valkey-io/valkey-glide',
      ALLOW_BUILD: 'true',
      MAX_ITERATIONS: '150',
    });
  });

  test('the runtime is created after its role policy', () => {
    const t = reviewerTemplate('valkey-review');
    const runtime = Object.values<any>(t.findResources('AWS::BedrockAgentCore::Runtime'))[0];
    expect(runtime.DependsOn).toEqual(expect.arrayContaining([expect.stringMatching(/^RuntimeRoleDefaultPolicy/)]));
  });
});

describe('curator role', () => {
  test('writes only the reviewer registries and only reads its own', () => {
    const statements = curatorStatements();
    const writers = statements.filter((st) => actionsOf(st).some((a) => /^agent-registry:(Create|Update|Delete)/.test(a)));
    expect(resourceStrings(writers).sort()).toEqual([
      registryArn('glideRegistry1'), `${registryArn('glideRegistry1')}/record/*`,
      registryArn('valkeyRegistry1'), `${registryArn('valkeyRegistry1')}/record/*`,
    ]);
    const own = statements.filter((st) => JSON.stringify(st.Resource).includes('curatorRegistry1'));
    expect(own.flatMap(actionsOf).sort()).toEqual(['agent-registry:GetRegistryRecord', 'agent-registry:ListRegistryRecords']);
  });

  test('reads and writes both concerns tables with their KMS key, and has no secrets', () => {
    const statements = curatorStatements();
    const concerns = bySid(statements, 'ConcernsReadWrite')[0]!;
    expect(JSON.stringify(concerns.Resource)).toContain('ValkeyReviewAgent');
    expect(JSON.stringify(concerns.Resource)).toContain('ValkeyGlideReviewAgent');
    expect(statements.some((st) => actionsOf(st).includes('kms:GenerateDataKey*')
      && JSON.stringify(st.Resource).includes('SubstrateKey'))).toBe(true);
    expect(statements.flatMap(actionsOf).filter((a) => a.startsWith('secretsmanager:'))).toEqual([]);
  });

  test('the curator runtime is updated only after its prompts are uploaded', () => {
    const t = s.template(s.stacks.curator);
    const runtime = Object.values<any>(t.findResources('AWS::BedrockAgentCore::Runtime'))[0];
    const uploads = Object.keys(t.findResources('Custom::CDKBucketDeployment')).filter((id) => id.startsWith('CuratorAssets'));
    expect(uploads.length).toBe(1);
    expect(runtime.DependsOn).toEqual(expect.arrayContaining(uploads));
  });

  test('each runtime uses the role defined in its own stack', () => {
    for (const stack of [s.stacks.reviewers.get('valkey-review')!, s.stacks.reviewers.get('valkey-glide-review')!, s.stacks.curator]) {
      const t = s.template(stack);
      const runtime = Object.values<any>(t.findResources('AWS::BedrockAgentCore::Runtime'))[0];
      expect(runtime.Properties.RoleArn).toEqual({ 'Fn::GetAtt': [runtimeRoleId(t), 'Arn'] });
    }
  });

  test('outputs the registry ids the skills scripts read with --stack', () => {
    const curatorOutputs = s.template(s.stacks.curator).toJSON().Outputs;
    expect(curatorOutputs.CuratorSkillsRegistryId.Value).toBe('curatorRegistry1');
    // registry-skills.mjs reads SkillsRegistryId first, so the curator stack must not have one.
    expect(curatorOutputs).not.toHaveProperty('SkillsRegistryId');
    expect(reviewerTemplate('valkey-review').toJSON().Outputs.SkillsRegistryId.Value).toBe('valkeyRegistry1');
    expect(reviewerTemplate('valkey-glide-review').toJSON().Outputs.SkillsRegistryId.Value).toBe('glideRegistry1');
  });

  test('runtime environment carries the curator settings', () => {
    expect(runtimeEnv(s.template(s.stacks.curator))).toMatchObject({
      BEDROCK_MODEL_ID: 'us.anthropic.claude-opus-5-5',
      FALLBACK_MODEL_ID: 'openai.gpt-6.1-sol',
      REASONING_EFFORT: 'medium',
      FALLBACK_REASONING_EFFORT: 'high',
      MANTLE_REGION: 'us-east-1',
      GRADUATION_THRESHOLD: '4',
      CURATOR_SKILLS_REGISTRY_ID: 'curatorRegistry1',
      SKILLS_REGISTRIES_JSON: JSON.stringify({ 'valkey-review': 'valkeyRegistry1', 'valkey-glide-review': 'glideRegistry1' }),
      PROMPT_S3_KEY: 'curator/prompt.md',
      SKILL_S3_KEY: 'curator/skill.md',
    });
  });

  test('skill maintenance runs in report mode by default, with no skills repository', () => {
    const env = runtimeEnv(s.template(s.stacks.curator));
    expect(env).toMatchObject({
      UPSTREAM_REPOS_JSON: JSON.stringify({ 'valkey-review': 'valkey-io/valkey', 'valkey-glide-review': 'valkey-io/valkey-glide' }),
      CHECK_PROMPT_S3_KEY: 'curator/skill-check.md',
      CHECK_MAX_ROUNDS: '25',
      CHECK_APPLY_EDITS: 'false',
      RETIRE_SKILLS: 'false',
      CHECK_OPEN_PULL_REQUESTS: 'false',
    });
    expect(Object.keys(env).filter((k) => k.startsWith('SKILLS_REPO'))).toEqual([]);
    // The checkout directory keeps the image's default.
    expect(env).not.toHaveProperty('SKILL_CHECK_DIR');
    expect(curatorStatements().flatMap(actionsOf).filter((a) => a.startsWith('lambda:'))).toEqual([]);
  });

  test('ships the audit prompt next to its prompt and skill', () => {
    const t = s.template(s.stacks.curator);
    const deployment = Object.values<any>(t.findResources('Custom::CDKBucketDeployment'))[0];
    expect(deployment.Properties.DestinationBucketKeyPrefix).toBe('curator/');
    const [key] = deployment.Properties.SourceObjectKeys as string[];
    const staged = path.join((s.stacks.curator.node.root as cdk.App).outdir, `asset.${key!.replace(/\.zip$/, '')}`);
    expect(fs.readdirSync(staged).sort()).toEqual(['prompt.md', 'skill-check.md', 'skill.md']);
  });

  test('maintenance may set record status on the reviewer registries, and only there', () => {
    expect(actionsOf(bySid(curatorStatements(), 'WriteReviewerSkills')[0]!).sort()).toEqual([
      'agent-registry:CreateRegistryRecord',
      'agent-registry:GetRegistryRecord',
      'agent-registry:ListRegistryRecords',
      'agent-registry:UpdateRegistryRecord',
      'agent-registry:UpdateRegistryRecordStatus',
    ]);
    const holders = allStatements(s).filter(({ statement }) => actionsOf(statement).includes('agent-registry:UpdateRegistryRecordStatus'));
    const curatorRole = runtimeRoleId(s.template(s.stacks.curator));
    expect(holders.map(({ stack, roles }) => ({ stack, roles }))).toEqual([{ stack: s.stacks.curator.stackName, roles: [curatorRole] }]);
    expect(resourceStrings(holders.map(({ statement }) => statement)).sort()).toEqual([
      registryArn('glideRegistry1'), `${registryArn('glideRegistry1')}/record/*`,
      registryArn('valkeyRegistry1'), `${registryArn('valkeyRegistry1')}/record/*`,
    ]);
    for (const stack of s.allStacks.filter((st) => st !== s.stacks.curator)) {
      expect(JSON.stringify(s.template(stack).toJSON())).not.toContain('UpdateRegistryRecordStatus');
    }
  });
});

describe('skills repository', () => {
  // Defaults: the main App's secret, base branch main, no sign-off.
  let plain: Synthesized;
  // Everything set, with a separate App and pull requests on.
  let custom: Synthesized;
  beforeAll(() => {
    plain = synth({ ...fixture(), skillsRepo: { repo: 'example-org/valkey-review-bot' } });
    custom = synth({
      ...fixture(),
      skillsRepo: {
        repo: 'example-org/valkey-review-bot',
        baseBranch: 'trunk',
        appSecretName: 'example/skills-app',
        signOff: 'Bot Owner <owner@example.com>',
      },
      skillLifecycle: { openPullRequests: true },
    });
  });

  const brokerOf = (x: Synthesized) => {
    const t = x.template(x.stacks.substrate);
    const ids = functionIds(t, 'SkillsRepoTokenBrokerFn');
    return { t, ids, statements: () => statementsForRole(t, roleOfFunction(t, ids[0]!)) };
  };
  const mentionsBroker = (st: Statement) => JSON.stringify(st.Resource).includes('SkillsRepoTokenBrokerFn');

  test('its token broker exists only when skillsRepo is configured', () => {
    expect(brokerOf(s).ids).toEqual([]);
    expect(s.stacks.substrate.skillsRepoTokenBroker).toBeUndefined();
    expect(s.template(s.stacks.substrate).toJSON().Outputs).not.toHaveProperty('SkillsRepoTokenBrokerFunctionName');

    const { t, ids } = brokerOf(plain);
    expect(ids).toHaveLength(1);
    const fn = (t.findResources('AWS::Lambda::Function')[ids[0]!] as any).Properties;
    expect(fn).toMatchObject({ Runtime: 'nodejs24.x', Architectures: ['arm64'], Timeout: 15, MemorySize: 256 });
    expect(fn.Environment.Variables).toEqual({ SKILLS_REPO: 'example-org/valkey-review-bot', SKILLS_REPO_APP_SECRET_NAME: 'example/github-app' });
    expect(t.toJSON().Outputs.SkillsRepoTokenBrokerFunctionName.Value).toEqual({ Ref: ids[0] });
    expect(functionEnv(custom.template(custom.stacks.substrate), 'SkillsRepoTokenBrokerFn'))
      .toEqual({ SKILLS_REPO: 'example-org/valkey-review-bot', SKILLS_REPO_APP_SECRET_NAME: 'example/skills-app' });
  });

  test('the broker may read its App secret and nothing else', () => {
    const secretArn = (name: string) => `arn:aws:secretsmanager:us-west-2:${ACCOUNT}:secret:${name}-??????`;
    expect(brokerOf(plain).statements()).toEqual([{
      Sid: 'ReadSkillsRepoAppSecret', Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: secretArn('example/github-app'),
    }]);
    expect(brokerOf(custom).statements()).toEqual([{
      Sid: 'ReadSkillsRepoAppSecret', Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: secretArn('example/skills-app'),
    }]);
    // Agent roles and the decay job still hold no secrets.
    for (const stack of [...custom.stacks.reviewers.values(), custom.stacks.curator, custom.stacks.decay]) {
      expect(JSON.stringify(custom.template(stack).toJSON())).not.toContain('secretsmanager:');
    }
  });

  test('only the curator role may invoke the broker', () => {
    for (const x of [plain, custom]) {
      const holders = allStatements(x).filter(({ statement }) => mentionsBroker(statement));
      const curatorRole = runtimeRoleId(x.template(x.stacks.curator));
      expect(holders.map(({ stack, roles }) => ({ stack, roles }))).toEqual([{ stack: x.stacks.curator.stackName, roles: [curatorRole] }]);
      expect(holders.flatMap(({ statement }) => actionsOf(statement))).toEqual(['lambda:InvokeFunction']);
      // The function itself and its versions, nothing else.
      const resources = resourceStrings(holders.map(({ statement }) => statement));
      expect(resources).toHaveLength(2);
      for (const r of resources) expect(r).toContain('SkillsRepoTokenBrokerFn');
      // No resource policy lets another principal in.
      for (const stack of x.allStacks) {
        const permissions = Object.values<any>(x.template(stack).findResources('AWS::Lambda::Permission'));
        expect(permissions.filter((p) => JSON.stringify(p).includes('SkillsRepoTokenBroker'))).toEqual([]);
      }
      // The reviewer runtimes keep invoke on their own brokers only, and
      // their brokers do not cover the bot repository.
      for (const id of ['valkey-review', 'valkey-glide-review'] as const) {
        const t = x.template(x.stacks.reviewers.get(id)!);
        expect(JSON.stringify(statementsForRole(t, runtimeRoleId(t)))).not.toContain('SkillsRepoTokenBroker');
      }
      const substrate = x.template(x.stacks.substrate);
      for (const fn of ['TokenBrokerValkeyReviewFn', 'TokenBrokerValkeyGlideReviewFn']) {
        expect(functionEnv(substrate, fn).ALLOWED_REPOS_JSON).not.toContain('valkey-review-bot');
      }
    }
  });

  test('the curator gets the repository settings and the broker name', () => {
    const plainEnv = runtimeEnv(plain.template(plain.stacks.curator));
    expect(plainEnv).toMatchObject({
      SKILLS_REPO: 'example-org/valkey-review-bot',
      SKILLS_REPO_BASE_BRANCH: 'main',
      CHECK_OPEN_PULL_REQUESTS: 'false',
    });
    expect(plainEnv).not.toHaveProperty('SKILLS_REPO_SIGN_OFF');
    expect(JSON.stringify(plainEnv.SKILLS_REPO_TOKEN_FUNCTION)).toMatch(/ExportsOutputRefSkillsRepoTokenBrokerFn/);

    expect(runtimeEnv(custom.template(custom.stacks.curator))).toMatchObject({
      SKILLS_REPO: 'example-org/valkey-review-bot',
      SKILLS_REPO_BASE_BRANCH: 'trunk',
      SKILLS_REPO_SIGN_OFF: 'Bot Owner <owner@example.com>',
      CHECK_OPEN_PULL_REQUESTS: 'true',
    });
  });
});

describe('token broker', () => {
  test("each broker's allowed repositories equal its reviewer's review routes", () => {
    const t = s.template(s.stacks.substrate);
    for (const [reviewer, fn] of [['valkey-review', 'TokenBrokerValkeyReviewFn'], ['valkey-glide-review', 'TokenBrokerValkeyGlideReviewFn']] as const) {
      const env = functionEnv(t, fn);
      expect(env.ALLOWED_REPOS_JSON).toBe(JSON.stringify(s.config.routes.filter((r) => r.reviewer === reviewer).map((r) => r.repo)));
      expect(env.GITHUB_APP_ID).toBe('123456');
    }
  });

  test('is the only reader of the GitHub App secret outside the webhook receiver', () => {
    for (const stack of [s.stacks.reviewers.get('valkey-review')!, s.stacks.reviewers.get('valkey-glide-review')!, s.stacks.curator, s.stacks.decay]) {
      expect(JSON.stringify(s.template(stack).toJSON())).not.toContain('secretsmanager:');
    }
    const t = s.template(s.stacks.substrate);
    for (const fn of ['TokenBrokerValkeyReviewFn', 'TokenBrokerValkeyGlideReviewFn']) {
      const broker = statementsForRole(t, functionRoleId(t, fn));
      expect(broker.flatMap(actionsOf)).toContain('secretsmanager:GetSecretValue');
      expect(JSON.stringify(broker)).toContain(':secret:example/github-app-??????');
    }
  });
});

describe('ready label', () => {
  const labeledFixture = () => {
    const raw = fixture();
    raw.routes[0].readyLabel = 'ready-for-human-review';
    return raw;
  };

  test('the function is absent when every readyLabel is empty', () => {
    expect(functionIds(s.template(s.stacks.substrate), 'ReadyLabelFn')).toEqual([]);
    expect(s.stacks.substrate.readyLabelFn).toBeUndefined();
    expect(functionEnv(s.template(s.stacks.webhook), 'ReceiverFn')).not.toHaveProperty('READY_LABEL_FUNCTION');
    expect(runtimeEnv(reviewerTemplate('valkey-review'))).not.toHaveProperty('READY_LABEL_FUNCTION');
  });

  test('reviewer still has no secretsmanager; may invoke token broker and ReadyLabelFn; cannot invoke the other reviewer\'s broker', () => {
    const labeled = synth(labeledFixture());
    const t = labeled.template(labeled.stacks.reviewers.get('valkey-review')!);
    const statements = statementsForRole(t, runtimeRoleId(t));
    expect(statements.flatMap(actionsOf).filter((a) => a.startsWith('secretsmanager:'))).toEqual([]);
    const invoke = statements.filter((st) => actionsOf(st).includes('lambda:InvokeFunction'));
    expect(JSON.stringify(invoke)).toContain('TokenBrokerValkeyReviewFn');
    expect(JSON.stringify(invoke)).toContain('ReadyLabelFn');
    expect(JSON.stringify(invoke)).not.toContain('TokenBrokerValkeyGlideReviewFn');
    expect(runtimeEnv(t)).toHaveProperty('READY_LABEL_FUNCTION');
  });

  test('the function reads the App secret, and only reviewers and the receiver may invoke it', () => {
    const labeled = synth(labeledFixture());
    const substrate = labeled.template(labeled.stacks.substrate);
    const fnEnv = functionEnv(substrate, 'ReadyLabelFn');
    expect(fnEnv).toMatchObject({
      GITHUB_APP_ID: '123456',
      BOT_LOGIN: 'example-reviewer[bot]',
      ALLOWED_REPOS_JSON: JSON.stringify(['example-org/valkey']),
      READY_LABEL_BY_REPO_JSON: JSON.stringify({ 'example-org/valkey': 'ready-for-human-review' }),
    });
    const readyFns = Object.entries(substrate.findResources('AWS::Lambda::Function'))
      .filter(([id]) => id.startsWith('ReadyLabelFn'));
    expect(readyFns).toHaveLength(1);
    expect((readyFns[0]![1] as any).Properties.ReservedConcurrentExecutions).toBe(1);
    substrate.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
    });
    const dlqOutput = Object.entries(substrate.toJSON().Outputs ?? {}).find(([id]) => id.startsWith('ReadyLabelDeadLetterQueueName'));
    expect(dlqOutput).toBeDefined();
    expect(JSON.stringify(dlqOutput?.[1])).toContain('ApproximateNumberOfMessagesVisible');
    expect(statementsForRole(substrate, functionRoleId(substrate, 'ReadyLabelFn')).flatMap(actionsOf))
      .toContain('secretsmanager:GetSecretValue');

    const holders = allStatements(labeled).filter(({ statement }) => JSON.stringify(statement.Resource).includes('ReadyLabelFn'));
    const roles = new Set(holders.flatMap(({ roles }) => roles));
    expect(roles.has(runtimeRoleId(labeled.template(labeled.stacks.reviewers.get('valkey-review')!)))).toBe(true);
    expect(roles.has(runtimeRoleId(labeled.template(labeled.stacks.reviewers.get('valkey-glide-review')!)))).toBe(true);
    expect(roles.has(functionRoleId(labeled.template(labeled.stacks.webhook), 'ReceiverFn'))).toBe(true);
    expect(roles.has(runtimeRoleId(labeled.template(labeled.stacks.curator)))).toBe(false);
    expect(functionEnv(labeled.template(labeled.stacks.webhook), 'ReceiverFn')).toHaveProperty('READY_LABEL_FUNCTION');
  });
});

describe('webhook', () => {
  test('every work queue has a dead-letter queue', () => {
    const t = s.template(s.stacks.webhook);
    const queues = Object.entries<any>(t.findResources('AWS::SQS::Queue'));
    const work = queues.filter(([, q]) => q.Properties.RedrivePolicy);
    const dlqIds = new Set(work.map(([, q]) => q.Properties.RedrivePolicy.deadLetterTargetArn['Fn::GetAtt'][0]));
    expect(work.length).toBe(s.config.routes.length + 1);
    expect(dlqIds.size).toBe(work.length);
    expect(work.length + dlqIds.size).toBe(queues.length);
    const curator = work.find(([id]) => id.startsWith('CuratorQueue'))!;
    expect(curator[1].Properties.RedrivePolicy.maxReceiveCount).toBe(3);
    for (const [id, q] of work.filter(([qid]) => qid.startsWith('DeliveryQueue'))) {
      expect({ id, max: q.Properties.RedrivePolicy.maxReceiveCount }).toEqual({ id, max: 8 });
    }
    expect([...s.stacks.webhook.deadLetterQueues.keys()].sort())
      .toEqual(['curator', 'valkey-glide-review', 'valkey-review', 'valkey-review-upstream']);
  });

  test('keeps the queue construct ids so updates do not replace queues', () => {
    const ids = Object.keys(s.template(s.stacks.webhook).findResources('AWS::SQS::Queue'));
    for (const prefix of ['DeliveryQueuevalkeyreview', 'DeliveryQueuevalkeyglidereview', 'DeliveryQueuevalkeyreviewupstream', 'CuratorQueue']) {
      expect(ids.some((id) => id.startsWith(prefix))).toBe(true);
    }
  });

  test('workers and receiver are concurrency-capped and the API is throttled', () => {
    const t = s.template(s.stacks.webhook);
    const scaling = Object.entries<any>(t.findResources('AWS::Lambda::EventSourceMapping'))
      .map(([id, m]) => [id.startsWith('CuratorWorkerFn') ? 'curator' : 'review', m.Properties.ScalingConfig.MaximumConcurrency]);
    expect(scaling.filter(([kind]) => kind === 'review').map(([, max]) => max)).toEqual([5, 5, 5]);
    expect(scaling.filter(([kind]) => kind === 'curator').map(([, max]) => max)).toEqual([2]);
    t.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
      ReservedConcurrentExecutions: 10,
      Environment: { Variables: Match.objectLike({ BOT_LOGIN: 'example-reviewer[bot]' }) },
    }));
    t.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
    });
  });

  test('receiver settings come from the configuration', () => {
    const env = functionEnv(s.template(s.stacks.webhook), 'ReceiverFn');
    expect(env).toMatchObject({
      BOT_LOGIN: 'example-reviewer[bot]',
      HAIKU_MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      DAILY_REVIEW_BUDGET: '40',
      MAX_AUTOMATIC_REVIEWS_PER_PR: '3',
      PUSH_REVIEW_DELAY_SECONDS: '300',
    });
    expect(env).not.toHaveProperty('INSTALLATION_ID');
    expect(env).not.toHaveProperty('KNOWN_BOT_LOGINS');

    const custom = synth({
      ...fixture(),
      github: { ...fixture().github, installationId: '42', knownBotLogins: ['one[bot]', 'two'] },
      dailyReviewBudget: 7,
      maxAutomaticReviewsPerPr: 20,
      pushReviewDelaySeconds: 0,
    });
    expect(functionEnv(custom.template(custom.stacks.webhook), 'ReceiverFn')).toMatchObject({
      INSTALLATION_ID: '42',
      KNOWN_BOT_LOGINS: 'one[bot],two',
      DAILY_REVIEW_BUDGET: '7',
      MAX_AUTOMATIC_REVIEWS_PER_PR: '20',
      PUSH_REVIEW_DELAY_SECONDS: '0',
    });
  });

  const idempotencyId = () => Object.keys(s.template(s.stacks.webhook).findResources('AWS::DynamoDB::Table'))
    .find((id) => id.startsWith('IdempotencyTable'))!;
  const reviewWorkers = () => functionIds(s.template(s.stacks.webhook), 'WorkerFn');
  const workerStatements = (id: string) => {
    const t = s.template(s.stacks.webhook);
    return statementsForRole(t, roleOfFunction(t, id));
  };

  test('review workers may read, extend and delete pending markers, and no other idempotency item', () => {
    expect(reviewWorkers()).toHaveLength(s.config.routes.length);
    const t = s.template(s.stacks.webhook);
    for (const id of reviewWorkers()) {
      expect((t.findResources('AWS::Lambda::Function')[id] as any).Properties.Environment.Variables.IDEMPOTENCY_TABLE)
        .toEqual({ Ref: idempotencyId() });
      const onTable = workerStatements(id).filter((st) => JSON.stringify(st.Resource).includes(idempotencyId()));
      expect(onTable).toEqual([{
        Sid: 'PendingReviewMarkers',
        Effect: 'Allow',
        Action: ['dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem'],
        Resource: { 'Fn::GetAtt': [idempotencyId(), 'Arn'] },
        Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['pending#*'] } },
      }]);
    }
  });

  test('review workers write only through UpdateItem in the heartbeat table, for the start record', () => {
    for (const id of reviewWorkers()) {
      const onHeartbeat = workerStatements(id).filter((st) => JSON.stringify(st.Resource).includes('RunHeartbeatTable'));
      const actions = onHeartbeat.flatMap(actionsOf);
      expect(actions).toEqual(expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:Scan', 'dynamodb:UpdateItem']));
      expect(actions.filter((a) => /^dynamodb:(Put|Delete|BatchWrite|Update)/.test(a))).toEqual(['dynamodb:UpdateItem']);
    }
  });

  test('the curator worker reads no table and has no pending markers', () => {
    const t = s.template(s.stacks.webhook);
    const env = functionEnv(t, 'CuratorWorkerFn');
    expect(Object.keys(env)).toEqual(['RUNTIME_ARN']);
    const statements = statementsForRole(t, functionRoleId(t, 'CuratorWorkerFn'));
    expect(statements.flatMap(actionsOf).filter((a) => a.startsWith('dynamodb:'))).toEqual([]);
  });

  test('outputs what the operator scripts read, and exposes the curator queue', () => {
    const scripts = path.join(__dirname, '..', '..', 'scripts');
    const skillCheck = fs.readFileSync(path.join(scripts, 'skill-check.mjs'), 'utf8');
    expect(skillCheck).toContain("output(values['webhook-stack'], 'CuratorQueueUrl')");
    expect(skillCheck).toContain("output(values.stack, 'ConcernsTableName')");

    const queueId = Object.keys(s.template(s.stacks.webhook).findResources('AWS::SQS::Queue')).find((id) => id.startsWith('CuratorQueue'))!;
    expect(s.template(s.stacks.webhook).toJSON().Outputs.CuratorQueueUrl.Value).toEqual({ Ref: queueId });
    expect(s.stacks.webhook.curatorQueue.node.id).toBe('CuratorQueue');
    for (const id of ['valkey-review', 'valkey-glide-review'] as const) {
      expect(reviewerTemplate(id).toJSON().Outputs).toHaveProperty('ConcernsTableName');
    }
    // The manual decay pass is invoked by function name.
    expect(s.template(s.stacks.decay).toJSON().Outputs).toHaveProperty('DecayFnName');
  });

  test('an empty knownBotLogins list keeps the receiver built-in list', () => {
    const custom = synth({ ...fixture(), github: { ...fixture().github, knownBotLogins: [] } });
    expect(custom.config.github.knownBotLogins).toEqual([]);
    expect(functionEnv(custom.template(custom.stacks.webhook), 'ReceiverFn')).not.toHaveProperty('KNOWN_BOT_LOGINS');
  });

  test('route maps: review routes by repository, curator map adds curator-only repositories', () => {
    const config = parseDeploymentConfig(fixture());
    const maps = routeMaps(config.routes, config.curatorOnlyRoutes, (id) => `https://queue/${id}`);
    expect(maps.review).toEqual({
      'example-org/valkey': { routeId: 'valkey-review', queueUrl: 'https://queue/valkey-review', reviewerId: 'valkey-review' },
      'example-org/valkey-glide': {
        routeId: 'valkey-glide-review', queueUrl: 'https://queue/valkey-glide-review', reviewerId: 'valkey-glide-review',
        skipDrafts: true, threadReplyReview: true,
      },
      'upstream-org/valkey': {
        routeId: 'valkey-review-upstream', queueUrl: 'https://queue/valkey-review-upstream', reviewerId: 'valkey-review',
        authorAllowlist: ['some-maintainer'], mentionOnly: true,
      },
    });
    expect(maps.curator).toEqual({
      'example-org/valkey': { reviewerId: 'valkey-review' },
      'example-org/valkey-glide': { reviewerId: 'valkey-glide-review' },
      'upstream-org/valkey': { reviewerId: 'valkey-review' },
      'upstream-org/valkey-glide': { reviewerId: 'valkey-glide-review' },
    });
    const env = functionEnv(s.template(s.stacks.webhook), 'ReceiverFn');
    expect(JSON.parse(env.CURATOR_ROUTE_MAP_JSON as string)).toEqual(maps.curator);
  });
});

describe('decay', () => {
  const decayStatements = (x: Synthesized) => {
    const t = x.template(x.stacks.decay);
    return statementsForRole(t, functionRoleId(t, 'DecayFn'));
  };

  test('may use the concerns table key, with settings from the configuration', () => {
    const custom = synth({
      ...fixture(),
      decay: { halfLifeDays: 10, floor: 0.1, graduatedHalfLifeDays: 365 },
      upstreamRepos: { 'valkey-review': '' },
      skillsRepo: { repo: 'example-org/valkey-review-bot' },
      skillLifecycle: {
        checksPerDay: 0, recheckDays: 30, retireSkills: true, maxRetirementsPerDay: 7, retireRefusedBackoffDays: 14,
        applyEdits: true, openPullRequests: true, maxCheckRounds: 60,
      },
    });
    const t = custom.template(custom.stacks.decay);
    const statements = decayStatements(custom);
    expect(statements.some((st) => actionsOf(st).includes('kms:Decrypt') && JSON.stringify(st.Resource).includes('SubstrateKey'))).toBe(true);
    const ddb = bySid(statements, 'ConcernsDecay')[0]!;
    expect(actionsOf(ddb).sort()).toEqual(['dynamodb:DeleteItem', 'dynamodb:Scan', 'dynamodb:UpdateItem']);
    expect(functionEnv(t, 'DecayFn')).toMatchObject({
      DECAY_HALF_LIFE_SECONDS: String(10 * 86400),
      DECAY_FLOOR: '0.1',
      DECAY_GRADUATED_HALF_LIFE_SECONDS: String(365 * 86400),
      // A reviewer whose upstream is empty gets no checks.
      UPSTREAM_REPOS_JSON: JSON.stringify({ 'valkey-glide-review': 'valkey-io/valkey-glide' }),
      SKILL_CHECKS_PER_DAY: '0',
      SKILL_RECHECK_SECONDS: String(30 * 86400),
      RETIRE_SKILLS: 'true',
      MAX_RETIREMENTS_PER_DAY: '7',
      RETIRE_REFUSED_BACKOFF_SECONDS: String(14 * 86400),
    });
    // The curator runs what the decay job queues, under the same switch.
    expect(runtimeEnv(custom.template(custom.stacks.curator))).toMatchObject({
      UPSTREAM_REPOS_JSON: JSON.stringify({ 'valkey-glide-review': 'valkey-io/valkey-glide' }),
      RETIRE_SKILLS: 'true',
      CHECK_APPLY_EDITS: 'true',
      CHECK_OPEN_PULL_REQUESTS: 'true',
      CHECK_MAX_ROUNDS: '60',
    });
  });

  test('the defaults: 180-day graduated half-life, ten checks a day, retirement off', () => {
    const env = functionEnv(s.template(s.stacks.decay), 'DecayFn');
    expect(Object.keys(env).sort()).toEqual([
      'CONCERNS_TABLES_JSON', 'CURATOR_QUEUE_URL', 'DECAY_FLOOR', 'DECAY_GRADUATED_HALF_LIFE_SECONDS', 'DECAY_HALF_LIFE_SECONDS',
      'MAX_RETIREMENTS_PER_DAY', 'RETIRE_REFUSED_BACKOFF_SECONDS', 'RETIRE_SKILLS', 'SKILL_CHECKS_PER_DAY', 'SKILL_RECHECK_SECONDS',
      'UPSTREAM_REPOS_JSON',
    ]);
    expect(env).toMatchObject({
      DECAY_HALF_LIFE_SECONDS: String(30 * 86400),
      DECAY_GRADUATED_HALF_LIFE_SECONDS: '15552000',
      UPSTREAM_REPOS_JSON: JSON.stringify({ 'valkey-review': 'valkey-io/valkey', 'valkey-glide-review': 'valkey-io/valkey-glide' }),
      SKILL_CHECKS_PER_DAY: '10',
      SKILL_RECHECK_SECONDS: '7776000',
      RETIRE_SKILLS: 'false',
      MAX_RETIREMENTS_PER_DAY: '3',
      RETIRE_REFUSED_BACKOFF_SECONDS: '2592000',
    });
  });

  test('sends maintenance requests to the curator queue, and to no other queue', () => {
    const queueUrl = JSON.stringify(functionEnv(s.template(s.stacks.decay), 'DecayFn').CURATOR_QUEUE_URL);
    expect(queueUrl).toMatch(/ValkeyReviewWebhook:ExportsOutputRefCuratorQueue/);

    const statements = decayStatements(s);
    const sqs = statements.filter((st) => actionsOf(st).some((a) => a.startsWith('sqs:')));
    expect(sqs).toHaveLength(1);
    expect(actionsOf(sqs[0]!).sort()).toEqual(['sqs:GetQueueAttributes', 'sqs:GetQueueUrl', 'sqs:SendMessage']);
    const [resource] = resourceStrings(sqs);
    expect(resourceStrings(sqs)).toHaveLength(1);
    expect(resource).toMatch(/ValkeyReviewWebhook:ExportsOutputFnGetAttCuratorQueue[A-Z0-9]+Arn/);
    expect(resource).not.toMatch(/Dlq|DeliveryQueue/);
    // No registry, secret, model or function access: the curator does the rest.
    expect(statements.flatMap(actionsOf).filter((a) => /^(agent-registry|secretsmanager|bedrock|lambda|s3):/.test(a))).toEqual([]);
    expect([...new Set(statements.flatMap(actionsOf))].sort()).toEqual([
      'dynamodb:DeleteItem', 'dynamodb:Scan', 'dynamodb:UpdateItem',
      'kms:Decrypt', 'kms:DescribeKey', 'kms:Encrypt', 'kms:GenerateDataKey*', 'kms:ReEncrypt*',
      'sqs:GetQueueAttributes', 'sqs:GetQueueUrl', 'sqs:SendMessage',
    ]);
  });
});

describe('model grants', () => {
  const opusProfile = `arn:aws:bedrock:us-west-2:${ACCOUNT}:inference-profile/us.anthropic.claude-opus-5-5`;
  const fm = (region: string, model: string) => `arn:aws:bedrock:${region}::foundation-model/${model}`;

  test('reviewer: primary and summarizer profiles in every profile region, plus Mantle', () => {
    const statements = reviewerStatements('valkey-review');
    expect(resourceStrings(bySid(statements, 'BedrockInvoke')).sort()).toEqual([
      fm('us-east-1', 'anthropic.claude-haiku-5-5'), fm('us-east-1', 'anthropic.claude-opus-5-5'),
      fm('us-east-2', 'anthropic.claude-haiku-5-5'), fm('us-east-2', 'anthropic.claude-opus-5-5'),
      `arn:aws:bedrock:us-west-2:${ACCOUNT}:inference-profile/us.anthropic.claude-haiku-5-5`, opusProfile,
      fm('us-west-2', 'anthropic.claude-haiku-5-5'), fm('us-west-2', 'anthropic.claude-opus-5-5'),
    ].sort());
    expect(actionsOf(bySid(statements, 'BedrockInvoke')[0]!).sort()).toEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']);
    expect(resourceStrings(bySid(statements, 'BedrockMantleInference')))
      .toEqual([`arn:aws:bedrock-mantle:us-east-1:${ACCOUNT}:project/default`]);
    expect(statements.flatMap(actionsOf).filter((a) => a.startsWith('bedrock:Converse'))).toEqual([]);
  });

  test('curator: only its own models', () => {
    const resources = resourceStrings(bySid(curatorStatements(), 'BedrockInvoke'));
    expect(resources).toContain(opusProfile);
    expect(resources.some((r) => r.includes('haiku'))).toBe(false);
  });

  test('safety gate: InvokeModel on the configured model only', () => {
    const t = s.template(s.stacks.webhook);
    const gate = bySid(statementsForRole(t, functionRoleId(t, 'ReceiverFn')), 'InvokeSafetyModel')[0]!;
    expect(gate.Action).toBe('bedrock:InvokeModel');
    expect(resourceStrings([gate]).sort()).toEqual([
      `arn:aws:bedrock:us-west-2:${ACCOUNT}:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`,
      ...['us-east-1', 'us-east-2', 'us-west-2'].map((r) => fm(r, 'anthropic.claude-haiku-4-5-20251001-v1:0')),
    ].sort());
  });

  test('no Mantle grants without an openai.* model; extra grants reach both agent roles', () => {
    const custom = synth({
      ...fixture(),
      models: {
        reviewer: { fallback: 'us.anthropic.claude-sonnet-5-5' },
        curator: { fallback: 'us.anthropic.claude-sonnet-5-5' },
        summarizer: { fallback: 'anthropic.claude-haiku-4-5-20251001-v1:0' },
        mantleRegion: '',
        profileRegions: ['us-west-2', 'us-east-1'],
        extraGrants: ['us.anthropic.claude-opus-5'],
      },
    });
    for (const stack of [custom.stacks.reviewers.get('valkey-review')!, custom.stacks.curator]) {
      const t = custom.template(stack);
      const statements = statementsForRole(t, runtimeRoleId(t));
      expect(statements.flatMap(actionsOf)
        .filter((a) => a.startsWith('bedrock-mantle:') || a.endsWith(':CallWithBearerToken'))).toEqual([]);
      const resources = resourceStrings(bySid(statements, 'BedrockInvoke'));
      expect(resources).toContain(`arn:aws:bedrock:us-west-2:${ACCOUNT}:inference-profile/us.anthropic.claude-opus-5`);
      expect(resources).toContain(fm('us-east-1', 'anthropic.claude-opus-5'));
      expect(resources.some((r) => r.includes('us-east-2'))).toBe(false);
    }
    const reviewer = custom.template(custom.stacks.reviewers.get('valkey-review')!);
    // A plain foundation model ID is granted in the stack region only.
    expect(resourceStrings(bySid(statementsForRole(reviewer, runtimeRoleId(reviewer)), 'BedrockInvoke')))
      .toContain(fm('us-west-2', 'anthropic.claude-haiku-4-5-20251001-v1:0'));
    expect(runtimeEnv(reviewer).MANTLE_REGION).toBe('us-west-2');
  });

  test('a profile grant always covers the stack region', () => {
    const custom = synth({ ...fixture(), models: { profileRegions: ['us-east-1', 'us-east-2'] } });
    const t = custom.template(custom.stacks.curator);
    expect(resourceStrings(bySid(statementsForRole(t, runtimeRoleId(t)), 'BedrockInvoke')).sort()).toEqual([
      fm('us-east-1', 'anthropic.claude-opus-5-5'), fm('us-east-2', 'anthropic.claude-opus-5-5'),
      opusProfile, fm('us-west-2', 'anthropic.claude-opus-5-5'),
    ].sort());
  });

  test('ARNs follow the stack partition', () => {
    const app = new cdk.App({ context: { '@aws-cdk/core:enablePartitionLiterals': true } });
    const stack = new cdk.Stack(app, 'GovStack', { env: { account: ACCOUNT, region: 'us-gov-west-1' } });
    expect(bedrockModelArns(stack, 'anthropic.claude-haiku-4-5-20251001-v1:0', []))
      .toEqual(['arn:aws-us-gov:bedrock:us-gov-west-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0']);
    const mantle = modelAccessStatements(stack, ['openai.gpt-6.1-sol'], { profileRegions: [], mantleGrantRegions: ['us-gov-west-1'] })
      .map((st) => st.toStatementJson());
    expect(mantle.map((st) => st.Sid)).toEqual(['BedrockMantleBearerToken', 'BedrockMantleInference']);
    expect(mantle[1].Resource).toBe(`arn:aws-us-gov:bedrock-mantle:us-gov-west-1:${ACCOUNT}:project/default`);
  });
});

describe('inference profile ids', () => {
  const stackIn = (region: string) => {
    const app = new cdk.App({ context: { '@aws-cdk/core:enablePartitionLiterals': true } });
    return new cdk.Stack(app, 'ModelStack', { env: { account: ACCOUNT, region } });
  };
  const model = 'anthropic.claude-haiku-5-5';

  test.each([
    ['us', 'us-east-1', ['us-east-1', 'us-west-2'], 'aws'],
    ['eu', 'eu-west-1', ['eu-west-1', 'eu-central-1'], 'aws'],
    ['apac', 'ap-southeast-1', ['ap-southeast-1', 'ap-northeast-2'], 'aws'],
    ['jp', 'ap-northeast-1', ['ap-northeast-1', 'ap-northeast-3'], 'aws'],
    ['au', 'ap-southeast-2', ['ap-southeast-2', 'ap-southeast-4'], 'aws'],
    ['in', 'ap-south-1', ['ap-south-1', 'ap-south-2'], 'aws'],
    ['ca', 'ca-central-1', ['ca-central-1', 'ca-west-1'], 'aws'],
    ['us-gov', 'us-gov-west-1', ['us-gov-west-1', 'us-gov-east-1'], 'aws-us-gov'],
  ])('%s.* grants the profile and the foundation model in each profile region', (group, region, profileRegions, partition) => {
    const id = `${group}.${model}`;
    expect(bedrockModelArns(stackIn(region), id, profileRegions)).toEqual([
      `arn:${partition}:bedrock:${region}:${ACCOUNT}:inference-profile/${id}`,
      ...profileRegions.map((r) => `arn:${partition}:bedrock:${r}::foundation-model/${model}`),
    ]);
  });

  test('global.* also grants the foundation model with no region, which Bedrock checks for global routing', () => {
    expect(bedrockModelArns(stackIn('us-west-2'), `global.${model}`, ['us-east-1'])).toEqual([
      `arn:aws:bedrock:us-west-2:${ACCOUNT}:inference-profile/global.${model}`,
      `arn:aws:bedrock:us-west-2::foundation-model/${model}`,
      `arn:aws:bedrock:us-east-1::foundation-model/${model}`,
      `arn:aws:bedrock:::foundation-model/${model}`,
    ]);
  });

  test.each([
    'anthropic.claude-haiku-4-5-20251001-v1:0',
    'amazon.nova-pro-v1:0',
    'meta.llama3-1-70b-instruct-v1:0',
    'constructor.not-a-group',
  ])('%s is a foundation model in the stack region', (id) => {
    expect(bedrockModelArns(stackIn('eu-west-1'), id, ['eu-central-1'])).toEqual([`arn:aws:bedrock:eu-west-1::foundation-model/${id}`]);
  });
});
