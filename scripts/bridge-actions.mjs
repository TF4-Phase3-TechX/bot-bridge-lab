import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';

// Trusted lab automation. No application builds, package installs, or Git hooks.
const source = 'Vihnnnn/bot-bridge-lab';
const target = 'TF4-Phase3-TechX/bot-bridge-lab';
const bot = 'techx-vihnnnn-bridge-lab[bot]';
const token = process.env.BRIDGE_APP_TOKEN;
const sourceToken = process.env.SOURCE_READ_TOKEN;
if (process.env.GITHUB_REPOSITORY !== source || process.env.GITHUB_REF !== 'refs/heads/main') {
  throw new Error('Bridge is restricted to the source repository main branch');
}
if (!token || !sourceToken) throw new Error('Both scoped tokens are required');

const evidence = {
  capturedAt: new Date().toISOString(), source, target,
  runUrl: `https://github.com/${source}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  checks: [], commits: [],
};
function check(name, passed, details) {
  evidence.checks.push({ name, passed, details });
  if (!passed) throw new Error(name);
}
function git(args, authenticated = false) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  delete env.BRIDGE_APP_TOKEN; delete env.SOURCE_READ_TOKEN;
  for (const name of Object.keys(env)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(name) || /^GIT_TRACE/.test(name)) delete env[name];
  }
  if (authenticated) {
    env.GIT_CONFIG_COUNT = '2';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'; env.GIT_CONFIG_VALUE_0 = '';
    env.GIT_CONFIG_KEY_1 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_1 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  return execFileSync('git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', ...args], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
async function api(path, { auth = token, method = 'GET', body, allow = [] } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method, headers: { Authorization: `Bearer ${auth}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok && !allow.includes(response.status)) throw new Error(`GitHub API ${method} ${path}: ${response.status}`);
  return { status: response.status, data };
}
function identity(sha) {
  const fields = git(['show', '-s', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI', sha]).split('\0');
  return { author: { name: fields[0], email: fields[1], date: fields[2] },
    committer: { name: fields[3], email: fields[4], date: fields[5] } };
}
function sameIdentity(a, b) {
  return a.name === b.name && a.email === b.email && Date.parse(a.date) === Date.parse(b.date);
}

try {
  const { data: installationRepos } = await api('/installation/repositories');
  check('App token restricted to destination lab', installationRepos.total_count === 1 && installationRepos.repositories[0].full_name === target);
  const denied = await api(`/repos/${target}`, { auth: sourceToken, allow: [404] });
  check('Source GITHUB_TOKEN cannot read destination', denied.status === 404, { status: denied.status });
  const { data: repo } = await api(`/repos/${target}`);
  check('Destination is private and standalone', repo.private && !repo.fork);
  evidence.sourceSha = git(['rev-parse', 'HEAD']);
  const targetUrl = `https://github.com/${target}.git`;
  git(['fetch', '--no-tags', targetUrl, '+refs/heads/main:refs/remotes/bridge/main'], true);
  evidence.targetBeforeSha = git(['rev-parse', 'refs/remotes/bridge/main']);
  git(['merge-base', 'HEAD', 'refs/remotes/bridge/main']);
  const commits = git(['rev-list', '--reverse', 'refs/remotes/bridge/main..HEAD']).split('\n').filter(Boolean);
  check('Lab transfer is bounded to 50 commits', commits.length <= 50, { count: commits.length });
  if (commits.length === 0) {
    evidence.outcome = 'no-new-commits';
  } else {
    const branch = `incoming/actions-${evidence.sourceSha}`;
    // Immutable branch per source SHA: retry can safely repeat this push without force.
    git(['push', targetUrl, `HEAD:refs/heads/${branch}`], true);
    const { data: existing } = await api(`/repos/${target}/pulls?state=all&head=${encodeURIComponent(target.split('/')[0] + ':' + branch)}`);
    let pr = existing.find(p => p.head.ref === branch);
    if (pr) {
      check('Existing PR has the expected source head', pr.head.sha === evidence.sourceSha);
      check('Existing PR is open or merged', pr.state === 'open' || pr.merged_at !== null);
      evidence.outcome = 'reused-pr';
    } else {
      const body = [
        `Original commits from ${source}; transported unchanged by GitHub App.`, '',
        `Source SHA: ${evidence.sourceSha}`, `Workflow run: ${evidence.runUrl}`, '',
        'Author and committer metadata are preserved. No developer access is granted to B.', '',
        ...commits.map(sha => `- ${sha}`),
      ].join('\n');
      ({ data: pr } = await api(`/repos/${target}/pulls`, {
        method: 'POST', body: { title: `Actions bridge: ${evidence.sourceSha.slice(0, 7)}`, head: branch, base: 'main', body },
      }));
      evidence.outcome = 'created-pr';
    }
    check('PR created by expected App', pr.user.login === bot && pr.user.type === 'Bot');
    evidence.pr = { number: pr.number, url: pr.html_url, actor: pr.user.login, branch, head: pr.head.sha };
    for (const sha of commits) {
      const local = identity(sha);
      const { data: remote } = await api(`/repos/${target}/commits/${sha}`);
      check(`Original SHA and identity preserved: ${sha.slice(0, 7)}`, remote.sha === sha &&
        sameIdentity(local.author, remote.commit.author) && sameIdentity(local.committer, remote.commit.committer));
      evidence.commits.push({ sha, ...local, targetAuthor: remote.author?.login ?? null, targetUrl: remote.html_url });
    }
  }
  evidence.passed = true;
} catch (error) {
  // Do not log subprocess environments, tokens, or raw error objects.
  evidence.passed = false;
  evidence.error = error instanceof Error ? error.message.replaceAll(token, '[REDACTED]').replaceAll(sourceToken, '[REDACTED]') : 'Bridge failed';
  process.exitCode = 1;
} finally {
  mkdirSync('bridge-evidence', { recursive: true });
  writeFileSync('bridge-evidence/result.json', JSON.stringify(evidence, null, 2) + '\n');
  const summary = [ '# Cross-org bridge evidence', '',
    `Result: **${evidence.passed ? 'PASS' : 'FAIL'}** — ${evidence.outcome ?? 'failed'}`, '',
    `Source: \`${source}\``, `Destination: \`${target}\``,
    `Source SHA: \`${evidence.sourceSha ?? 'unavailable'}\``, '',
    evidence.pr ? `PR: [#${evidence.pr.number}](${evidence.pr.url}) — actor \`${evidence.pr.actor}\`` : 'No PR created.', '',
    '| Check | Result |', '|---|---|', ...evidence.checks.map(c => `| ${c.name} | ${c.passed ? 'PASS' : 'FAIL'} |`), '',
    ...evidence.commits.map(c => `- [${c.sha.slice(0, 7)}](${c.targetUrl}) — author: **${c.targetAuthor ?? c.author.name}**`), '',
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(JSON.stringify(evidence, null, 2));
}
