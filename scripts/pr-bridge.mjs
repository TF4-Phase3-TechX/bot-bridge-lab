import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mainSyncDecision, pairDecision } from './pr-bridge-policy.mjs';

const source = 'Vihnnnn/bot-bridge-lab';
const target = 'TF4-Phase3-TechX/bot-bridge-lab';
const bot = 'techx-vihnnnn-bridge-lab[bot]';
const sourceToken = process.env.SOURCE_TOKEN;
const targetToken = process.env.BRIDGE_APP_TOKEN;
const report = { source, target, pairs: [], run: `https://github.com/${source}/actions/runs/${process.env.GITHUB_RUN_ID}` };
const shaPattern = /^[a-f0-9]{40}$/;
function requireSha(value) {
  if (!shaPattern.test(value)) throw new Error('Invalid commit SHA');
  return value;
}
function git(args, token, allowed = [0]) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(env)) {
    if (/TOKEN|PRIVATE_KEY|^GIT_TRACE|^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete env[key];
  }
  if (token) {
    env.GIT_CONFIG_COUNT = '2';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'; env.GIT_CONFIG_VALUE_0 = '';
    env.GIT_CONFIG_KEY_1 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_1 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  const result = spawnSync('git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', ...args], { env, encoding: 'utf8' });
  if (!allowed.includes(result.status)) throw new Error(`Git ${args[0]} failed (exit ${result.status}); no force update attempted`);
  return { text: result.stdout.trim(), status: result.status };
}
const ancestor = (a, b) => git(['merge-base', '--is-ancestor', requireSha(a), requireSha(b)], null, [0, 1]).status === 0;
async function api(repo, path, { method = 'GET', body } = {}) {
  const token = repo === source ? sourceToken : targetToken;
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${repo}${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function list(repo, path) {
  const values = [];
  for (let page = 1; ; page++) {
    const batch = await api(repo, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    values.push(...batch);
    if (batch.length < 100) return values;
  }
}
async function statusComment(pr, content) {
  const marker = '<!-- b-authoritative-bridge-status -->';
  const body = `${marker}\n${content}`;
  const comments = await list(source, `/issues/${pr}/comments`);
  const old = comments.find(x => x.user.login === 'github-actions[bot]' && x.body.startsWith(marker));
  if (old?.body === body) return;
  await api(source, old ? `/issues/comments/${old.id}` : `/issues/${pr}/comments`, { method: old ? 'PATCH' : 'POST', body: { body } });
}
async function run() {
  if (process.env.GITHUB_REPOSITORY !== source || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Controller must run from source main');
  if (!sourceToken || !targetToken) throw new Error('Missing scoped tokens');
  const aUrl = `https://github.com/${source}.git`, bUrl = `https://github.com/${target}.git`;
  git(['fetch', '--no-tags', aUrl, '+refs/heads/main:refs/remotes/bridge/a-main'], sourceToken);
  git(['fetch', '--no-tags', bUrl, '+refs/heads/main:refs/remotes/bridge/b-main'], targetToken);
  const aSha = git(['rev-parse', 'refs/remotes/bridge/a-main']).text;
  const bSha = git(['rev-parse', 'refs/remotes/bridge/b-main']).text;
  report.sourceBefore = aSha; report.targetMain = bSha;
  report.mainSync = mainSyncDecision({ equal: aSha === bSha, aIsAncestor: ancestor(aSha, bSha) });
  if (report.mainSync === 'stop') throw new Error('A/main contains history not accepted by B. Maintainer reconciliation required.');
  if (report.mainSync === 'fast-forward') {
    // GITHUB_TOKEN has no Workflows permission. Stop rather than silently elevating it.
    const workflowDiff = git(['diff', '--name-only', aSha, bSha, '--', '.github/workflows/']).text;
    if (workflowDiff) throw new Error('B changed workflow files: sync requires a maintainer or a dedicated App A with Workflows write');
    git(['push', aUrl, `${requireSha(bSha)}:refs/heads/main`], sourceToken);
  }
  report.sourceAfter = (await api(source, '/git/ref/heads/main')).object.sha;
  if (report.sourceAfter !== bSha) throw new Error('A main changed concurrently; retry after inspection');

  const prs = await list(source, '/pulls?state=all&sort=created&direction=desc');
  const targetPRs = await list(target, '/pulls?state=all&sort=created&direction=desc');
  for (const initial of prs) {
    if (initial.base.ref !== 'main' || initial.head.repo?.full_name !== source) continue;
    const marker = `<!-- b-authoritative-bridge:${source}#${initial.number} -->`;
    let matches = targetPRs.filter(p => p.body?.startsWith(marker) && p.user.login === bot);
    if (matches.length > 1) throw new Error(`Multiple B PRs mapped to A#${initial.number}`);
    let b = matches[0];
    if (!b && initial.state !== 'open') continue;
    let a = await api(source, `/pulls/${initial.number}`);
    if (a.draft && !b) continue;
    if (b) b = await api(target, `/pulls/${b.number}`);
    const aHead = requireSha(a.head.sha);
    git(['fetch', '--no-tags', aUrl, `refs/pull/${a.number}/head`], sourceToken);
    const fetched = git(['rev-parse', 'FETCH_HEAD']).text;
    if (fetched !== aHead) { report.pairs.push({ a: a.number, state: 'source-changed-retry' }); continue; }
    const included = ancestor(aHead, bSha);
    if (b) {
      const decision = pairDecision({ merged: Boolean(b.merged_at), closed: b.state === 'closed', sourceClosed: a.state === 'closed', headIncluded: included });
      if (decision !== 'pending') {
        const row = { a: a.number, b: b.number, state: decision, sourceHead: aHead, mergeCommit: b.merge_commit_sha };
        report.pairs.push(row);
        if (decision === 'withdrawn') {
          await api(target, `/pulls/${b.number}`, { method: 'PATCH', body: { state: 'closed' } });
        }
        const message = decision === 'accepted'
          ? `Accepted in [B PR #${b.number}](${b.html_url}).\n\nB merge commit: \`${b.merge_commit_sha}\`.\n\nA/main synchronized to B/main: \`${bSha}\`. Original source head \`${aHead}\` is included; no independent merge was performed at A.`
          : decision === 'new-commits-pending'
            ? `B merged [PR #${b.number}](${b.html_url}), but current A head \`${aHead}\` contains unaccepted commits. Main is synchronized only to accepted B history. Submit the remaining changes in a new PR from current main; this PR is not marked complete.`
            : `Bridge status: **${decision}**. [B PR #${b.number}](${b.html_url}). No unaccepted code is added to either main; this pair will not be recreated automatically.`;
        await statusComment(a.number, message);
        // Refresh immediately before closing, so a newer source head is not silently discarded.
        a = await api(source, `/pulls/${a.number}`);
        if (a.state === 'open' && a.head.sha === aHead && ['accepted', 'rejected'].includes(decision)) {
          await api(source, `/pulls/${a.number}`, { method: 'PATCH', body: { state: 'closed' } });
        }
        continue;
      }
    }
    if (a.state !== 'open' || a.draft) continue;
    if (included) { await statusComment(a.number, `Source head \`${aHead}\` is already in B/main. No new destination PR is needed.`); continue; }
    git(['merge-base', aHead, bSha]);
    const branch = `incoming/a-pr-${a.number}`;
    if (!b || b.head.sha !== aHead) {
      git(['push', bUrl, `${aHead}:refs/heads/${branch}`], targetToken);
    }
    const body = `${marker}\nContribution from [A PR #${a.number}](${a.html_url}).\n\nSource head: \`${aHead}\`.\n\nB is the source of truth. Review and merge here with a merge commit. The controller will fast-forward A/main to the accepted B history and complete the source PR. Original Git commits are transported unchanged.`;
    if (!b) {
      b = await api(target, '/pulls', { method: 'POST', body: { title: `A PR #${a.number}: ${a.title}`, head: branch, base: 'main', body } });
    } else if (b.body !== body || b.title !== `A PR #${a.number}: ${a.title}`) {
      b = await api(target, `/pulls/${b.number}`, { method: 'PATCH', body: { title: `A PR #${a.number}: ${a.title}`, body } });
    }
    const reviews = await list(target, `/pulls/${b.number}/reviews`);
    const latestReviews = new Map();
    for (const review of reviews) latestReviews.set(review.user.login, `${review.user.login}: ${review.state}`);
    await statusComment(a.number, `Waiting for B approval: [PR #${b.number}](${b.html_url}).\n\nTransferred source head: \`${aHead}\`.\n\nB mergeability: \`${b.mergeable_state ?? 'pending'}\`. Reviews: ${[...latestReviews.values()].join('; ') || 'none yet'}.\n\nA/main remains at accepted B history \`${bSha}\`. Continue changes on this feature branch; do not merge this PR at A.`);
    report.pairs.push({ a: a.number, b: b.number, state: 'pending', sourceHead: aHead, url: b.html_url });
  }
}
try { await run(); report.passed = true; }
catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
finally {
  const summary = ['# B-authoritative PR bridge', '', `Result: **${report.passed ? 'PASS' : 'FAIL'}**`, '',
    `A/main before: \`${report.sourceBefore ?? 'unknown'}\``, `B/main: \`${report.targetMain ?? 'unknown'}\``,
    `A/main after: \`${report.sourceAfter ?? 'unknown'}\``, `Main sync: **${report.mainSync ?? 'not-started'}**`, '',
    '| A PR | B PR | State | Source head |', '|---|---|---|---|',
    ...report.pairs.map(p => `| [#${p.a}](https://github.com/${source}/pull/${p.a}) | ${p.b ? `[#${p.b}](https://github.com/${target}/pull/${p.b})` : '—'} | ${p.state} | \`${p.sourceHead ?? ''}\` |`),
    report.error ? `\nStopped: ${report.error}` : '', ''].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(JSON.stringify(report, null, 2));
}
