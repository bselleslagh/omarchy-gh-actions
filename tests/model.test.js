const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const Model = {};
vm.runInNewContext(read('Model.js').replace(/^\.pragma library$/m, ''), Model);

// vm objects have another realm's prototypes, which deepEqual treats as different.
const plain = value => JSON.parse(JSON.stringify(value));

const NOW = Date.parse('2026-11-05T12:00:00Z');
const repo = 'acme/app';
const iso = ms => new Date(ms).toISOString();

function run(id, fields = {}) {
  return Model.normalizeRun({
    id,
    name: 'CI',
    status: 'in_progress',
    conclusion: null,
    branch: 'main',
    actor: 'teammate',
    trigger: 'teammate',
    url: `https://github.com/${repo}/actions/runs/${id}`,
    created: iso(NOW - 600000),
    started: iso(NOW - 600000),
    updated: iso(NOW - 1000),
    attempt: 1,
    ...fields,
  }, repo);
}

const done = (id, conclusion, fields = {}) => run(id, {status: 'completed', conclusion, ...fields});
const ctx = (extra = {}) => ({now: NOW, me: 'ben', autoWatchMine: true, ...extra});

function subscribed(rule = 'watched') {
  let state = Model.addRepo(Model.emptyState(), repo);
  if (rule !== 'watched') state.repos = [{name: repo, rule}];
  // The first fetch only sets the baseline.
  return Model.reconcile(state, repo, [], ctx()).state;
}

const kinds = result => plain(result.events.map(event => event.kind));

test('gh --include output is split into status, headers and body', () => {
  const parsed = Model.parseResponse('HTTP/2.0 200 OK\nEtag: W/"abc"\nX-Ratelimit-Remaining: 12\nX-Ratelimit-Reset: 99\n\n{"runs":[]}\n');
  assert.equal(parsed.code, 200);
  assert.equal(parsed.etag, 'W/"abc"');
  assert.equal(parsed.remaining, 12);
  assert.equal(parsed.reset, 99);
  assert.equal(parsed.body.trim(), '{"runs":[]}');
});

test('a 304 is success even though gh exits 1', () => {
  const parsed = Model.parseResponse('HTTP/2.0 304 Not Modified\nEtag: W/"abc"\n\n');
  assert.equal(parsed.code, 304);
  assert.equal(Model.classify(parsed, 1, ''), '');
});

test('failures are told apart', () => {
  assert.equal(Model.classify(Model.parseResponse(''), 127, ''), 'missing');
  assert.equal(Model.classify(Model.parseResponse('HTTP/2.0 401 Unauthorized\n\n'), 1, ''), 'auth');
  assert.equal(Model.classify(Model.parseResponse(''), 4, ''), 'auth');
  assert.equal(Model.classify(Model.parseResponse(''), 1, 'please run: gh auth login'), 'auth');
  assert.equal(Model.classify(Model.parseResponse('HTTP/2.0 404 Not Found\n\n'), 1, ''), 'notfound');
  assert.equal(Model.classify(Model.parseResponse('HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 0\n\n'), 1, ''), 'rate');
  assert.equal(Model.classify(Model.parseResponse('HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 50\n\n'), 1, ''), 'notfound');
  assert.equal(Model.classify(Model.parseResponse('HTTP/2.0 502 Bad Gateway\n\n'), 1, ''), 'network');
  assert.equal(Model.classify(Model.parseResponse(''), 1, 'dial tcp: timeout'), 'network');
});

test('rate-limit pauses are bounded', () => {
  const reset = Math.floor((NOW + 600000) / 1000);
  assert.equal(Model.pauseUntil({retryAfter: 0, remaining: 0, reset}, NOW), reset * 1000);
  assert.equal(Model.pauseUntil({retryAfter: 0, remaining: 5, reset: 0}, NOW), NOW + 60000);
  assert.equal(Model.pauseUntil({retryAfter: 999999, remaining: 0, reset: 0}, NOW), NOW + 3600000);
});

test('the etag header is only sent when there is one', () => {
  const request = Model.listRequest(repo);
  assert.equal(Model.ghArgv(request, '').includes('--header'), false);
  assert.deepEqual(plain(Model.ghArgv(request, 'W/"x"').slice(-2)), ['--header', 'If-None-Match: W/"x"']);
  assert.equal(request.path, 'repos/acme/app/actions/runs?per_page=30');
});

test('a cached etag is only sent while its data is still held', () => {
  const list = Model.listRequest(repo);
  const jobs = Model.jobsRequest(repo, 1);
  const etags = {[list.path]: 'L', [jobs.path]: 'J'};
  assert.equal(Model.etagFor(list, etags, {}, {}), '');
  assert.equal(Model.etagFor(list, etags, {}, {[repo]: {}}), 'L');
  assert.equal(Model.etagFor(jobs, etags, {}, {}), '');
  assert.equal(Model.etagFor(jobs, etags, {[`${repo}#1`]: {}}, {}), 'J');
  assert.equal(Model.etagFor({...jobs, then: {}}, etags, {[`${repo}#1`]: {}}, {}), '');
});

test('repo names cannot escape the API path', () => {
  for (const good of ['acme/app', 'a.b/c_d-e', 'Some-Org/Repo42']) assert.equal(Model.validRepo(good), true, good);
  for (const bad of ['', 'acme', 'a/b/c', '../x', 'x/..', './x', 'a b/c', 'a/b?x=1', 'a/b#c', 42, null])
    assert.equal(Model.validRepo(bad), false, String(bad));
});

test('only plain github.com links survive', () => {
  assert.equal(Model.safeUrl('https://github.com/a/b/actions/runs/1'), 'https://github.com/a/b/actions/runs/1');
  for (const bad of ['http://github.com/a', 'https://github.com.evil.test/a', 'https://evil.test/https://github.com/',
    'javascript:alert(1)', 'https://github.com/a b', 'https://github.com/a\nb', 42, null])
    assert.equal(Model.safeUrl(bad), '', String(bad));
});

test('run data is bounded and invalid runs are dropped', () => {
  const long = 'x'.repeat(1000);
  assert.equal(run(1, {name: long}).name.length, 200);
  assert.equal(run(1, {name: 'a\n\tb'}).name, 'a b');
  assert.equal(run(1, {name: null, title: 'Fallback'}).name, 'Fallback');
  assert.equal(run(1, {url: 'https://evil.test/'}).url, '');
  assert.equal(Model.normalizeRun({id: 'nope'}, repo), null);
  assert.equal(Model.normalizeRun({id: -1}, repo), null);
  assert.equal(Model.normalizeRuns({runs: [{id: 1}, {id: 'x'}, null]}, repo).length, 1);
  assert.equal(Model.normalizeRuns('nonsense', repo).length, 0);
});

test('phases follow GitHub status and conclusion', () => {
  const cases = [
    ['queued', null, 'queued'], ['requested', null, 'queued'], ['pending', null, 'queued'],
    ['in_progress', null, 'running'], ['waiting', null, 'waiting'],
    ['completed', 'success', 'passed'], ['completed', 'failure', 'failed'], ['completed', 'timed_out', 'failed'],
    ['completed', 'startup_failure', 'failed'], ['completed', 'cancelled', 'cancelled'],
    ['completed', 'action_required', 'waiting'], ['completed', 'skipped', 'other'], ['completed', 'neutral', 'other'],
  ];
  for (const [status, conclusion, want] of cases)
    assert.equal(Model.phase(run(1, {status, conclusion})), want, `${status}/${conclusion}`);
});

test('job summary counts finished, failed and remaining jobs', () => {
  const summary = Model.jobSummary({total: 4, jobs: [
    {name: 'a', status: 'completed', conclusion: 'success'},
    {name: 'b', status: 'completed', conclusion: 'failure', step: 'Push schema'},
    {name: 'c', status: 'in_progress', conclusion: null},
    {name: 'd', status: 'queued', conclusion: null},
  ]});
  assert.deepEqual(plain(summary.segments), ['done', 'failed', 'active', 'idle']);
  assert.equal(summary.finished, 2);
  assert.equal(summary.left, 2);
  assert.deepEqual(plain(summary.failed), ['b']);
  assert.equal(summary.step, 'Push schema');
});

test('a failure in a huge matrix still shows in the compressed blocks', () => {
  const states = Array(100).fill('done');
  states[57] = 'failed';
  const out = Model.segments(states, 14);
  assert.equal(out.length, 14);
  assert.equal(out.filter(state => state === 'failed').length, 1);
  assert.equal(Model.segments(['done', 'idle'], 14).length, 2);
});

test('clicking watches a run, clicking again stops and stays stopped', () => {
  const mine = run(1, {actor: 'ben'});
  let state = Model.toggleWatch(subscribed(), mine);
  assert.ok(state.watched[mine.key]);
  state = Model.toggleWatch(state, mine);
  assert.equal(state.watched[mine.key], undefined);
  // Auto-watch must not take back a run the user chose to stop watching.
  const result = Model.reconcile(state, repo, [mine], ctx());
  assert.equal(result.state.watched[mine.key], undefined);
  const finished = Model.reconcile(result.state, repo, [done(1, 'success', {actor: 'ben'})], ctx());
  assert.deepEqual(kinds(finished), []);
});

test('runs you start are watched automatically, unless turned off', () => {
  const mine = run(1, {actor: 'ben'});
  assert.ok(Model.reconcile(subscribed(), repo, [mine], ctx()).state.watched[mine.key]);
  assert.equal(Model.reconcile(subscribed(), repo, [mine], ctx({autoWatchMine: false})).state.watched[mine.key], undefined);
  assert.equal(Model.reconcile(subscribed(), repo, [run(2)], ctx()).state.watched[`${repo}#2`], undefined);
  // A re-run you trigger on someone else's run counts as yours.
  const rerun = run(3, {trigger: 'ben'});
  assert.ok(Model.reconcile(subscribed(), repo, [rerun], ctx()).state.watched[rerun.key]);
});

test('a watched run notifies once when it finishes and is then dropped', () => {
  let state = Model.toggleWatch(subscribed(), run(1));
  let result = Model.reconcile(state, repo, [done(1, 'success')], ctx());
  assert.deepEqual(kinds(result), ['passed']);
  assert.equal(result.events[0].final, true);
  assert.equal(result.state.watched[`${repo}#1`], undefined);
  result = Model.reconcile(result.state, repo, [done(1, 'success')], ctx());
  assert.deepEqual(kinds(result), []);
});

test('a failed watched run counts as unseen until acknowledged', () => {
  const state = Model.toggleWatch(subscribed(), run(1));
  const result = Model.reconcile(state, repo, [done(1, 'failure')], ctx());
  assert.deepEqual(kinds(result), ['failed']);
  assert.ok(result.state.unseen[`${repo}#1`]);
  assert.equal(Object.keys(Model.acknowledge(result.state).unseen).length, 0);
});

test('repo rules decide about runs you did not click', () => {
  const finished = [done(1, 'failure')];
  const passed = [done(2, 'success')];
  assert.deepEqual(kinds(Model.reconcile(subscribed('watched'), repo, finished, ctx())), []);
  assert.deepEqual(kinds(Model.reconcile(subscribed('failures'), repo, finished, ctx())), ['failed']);
  assert.deepEqual(kinds(Model.reconcile(subscribed('failures'), repo, passed, ctx())), []);
  assert.deepEqual(kinds(Model.reconcile(subscribed('all'), repo, passed, ctx())), ['passed']);
});

test('subscribing does not replay history', () => {
  const state = Model.addRepo(Model.emptyState(), repo);
  state.repos = [{name: repo, rule: 'all'}];
  const result = Model.reconcile(state, repo, [done(1, 'failure'), done(2, 'success')], ctx());
  assert.deepEqual(kinds(result), []);
  assert.equal(result.state.recent.length, 2);
  // Those two are handled, so the next fetch stays quiet too.
  assert.deepEqual(kinds(Model.reconcile(result.state, repo, [done(1, 'failure')], ctx())), []);
});

test('a run you started that finished between two fetches still notifies', () => {
  const result = Model.reconcile(subscribed(), repo, [done(1, 'failure', {actor: 'ben'})], ctx());
  assert.deepEqual(kinds(result), ['failed']);
});

test('what finished during a restart or sleep is reported on return', () => {
  const state = Model.toggleWatch(subscribed(), run(1));
  const back = Model.parseState(JSON.stringify(state));
  const later = NOW + 3 * 24 * 3600 * 1000;
  const result = Model.reconcile(back, repo, [done(1, 'success')], {now: later, me: 'ben', autoWatchMine: true});
  // A watched run is always reported, however long ago it finished.
  assert.deepEqual(kinds(result), ['passed']);
});

test('old runs nobody watched never notify, even under the all-runs rule', () => {
  const old = done(1, 'failure', {updated: iso(NOW - 3 * 24 * 3600 * 1000)});
  const result = Model.reconcile(subscribed('all'), repo, [old], ctx());
  assert.deepEqual(kinds(result), []);
  assert.equal(result.state.recent.length, 0);
});

test('a run that is re-run is a new attempt and can notify again', () => {
  let state = Model.toggleWatch(subscribed(), run(1));
  state = Model.reconcile(state, repo, [done(1, 'failure')], ctx()).state;
  state = Model.toggleWatch(state, run(1, {attempt: 2}));
  const result = Model.reconcile(state, repo, [done(1, 'success', {attempt: 2})], ctx());
  assert.deepEqual(kinds(result), ['passed']);
});

test('a failing job warns once, while the run is still going', () => {
  const key = `${repo}#1`;
  const summary = Model.jobSummary({jobs: [
    {name: 'build', status: 'completed', conclusion: 'failure'},
    {name: 'test', status: 'in_progress', conclusion: null},
  ]});
  let result = Model.applyJobs(Model.toggleWatch(subscribed(), run(1)), key, summary);
  assert.deepEqual(kinds(result), ['failing']);
  assert.ok(result.state.unseen[key]);
  result = Model.applyJobs(result.state, key, summary);
  assert.deepEqual(kinds(result), []);
  // Nobody asked about this run, so it stays quiet.
  assert.deepEqual(kinds(Model.applyJobs(subscribed(), key, summary)), []);
});

test('the final result replaces the early warning', () => {
  const key = `${repo}#1`;
  let state = Model.toggleWatch(subscribed(), run(1));
  state = Model.setNotifId(state, key, 77);
  const result = Model.reconcile(state, repo, [done(1, 'failure')], ctx());
  assert.equal(result.events[0].replaceId, 77);
});

test('a re-run resets the warnings', () => {
  const key = `${repo}#1`;
  const summary = Model.jobSummary({jobs: [{name: 'x', status: 'completed', conclusion: 'failure'}]});
  let state = Model.applyJobs(Model.toggleWatch(subscribed(), run(1)), key, summary).state;
  state = Model.reconcile(state, repo, [run(1, {attempt: 2})], ctx()).state;
  assert.equal(state.watched[key].failingSent, false);
  assert.deepEqual(kinds(Model.applyJobs(state, key, summary)), ['failing']);
});

test('a run waiting for approval notifies once per wait', () => {
  let state = Model.toggleWatch(subscribed(), run(1));
  let result = Model.reconcile(state, repo, [run(1, {status: 'waiting'})], ctx());
  assert.deepEqual(kinds(result), ['waiting']);
  result = Model.reconcile(result.state, repo, [run(1, {status: 'waiting'})], ctx());
  assert.deepEqual(kinds(result), []);
  state = Model.reconcile(result.state, repo, [run(1)], ctx()).state;
  assert.deepEqual(kinds(Model.reconcile(state, repo, [run(1, {status: 'waiting'})], ctx())), ['waiting']);
});

test('removing a repo removes everything about it', () => {
  let state = Model.toggleWatch(subscribed(), run(1));
  state = Model.reconcile(state, repo, [done(2, 'failure')], ctx({autoWatchMine: false})).state;
  state = Model.removeRepo(state, repo);
  assert.equal(state.repos.length, 0);
  assert.equal(Object.keys(state.watched).length, 0);
  assert.equal(Object.keys(state.seen).length, 0);
  assert.equal(state.recent.length, 0);
  assert.equal(state.baselined[repo], undefined);
});

test('repos are not added twice, and rules cycle', () => {
  let state = Model.addRepo(Model.emptyState(), repo);
  assert.equal(Model.addRepo(state, 'ACME/App').repos.length, 1);
  assert.equal(Model.addRepo(state, '../bad').repos.length, 1);
  assert.equal(state.repos[0].rule, 'watched');
  state = Model.cycleRule(state, repo);
  assert.equal(state.repos[0].rule, 'failures');
  state = Model.cycleRule(state, repo);
  assert.equal(state.repos[0].rule, 'all');
  state = Model.cycleRule(state, repo);
  assert.equal(state.repos[0].rule, 'watched');
});

test('state on disk is validated and bad content falls back to empty', () => {
  assert.deepEqual(plain(Model.parseState('not json')), plain(Model.emptyState()));
  assert.deepEqual(plain(Model.parseState('null')), plain(Model.emptyState()));
  const parsed = Model.parseState(JSON.stringify({
    repos: [{name: '../evil', rule: 'watched'}, {name: 'a/b', rule: 'bogus'}],
    watched: {
      'a/b#1': {repo: 'a/b', id: 1, name: 'ok', url: 'https://evil.test/'},
      'mismatch': {repo: 'a/b', id: 2},
    },
  }));
  assert.deepEqual(plain(parsed.repos), [{name: 'a/b', rule: 'watched'}]);
  assert.deepEqual(Object.keys(parsed.watched), ['a/b#1']);
  assert.equal(parsed.watched['a/b#1'].url, '');
});

test('state survives a save and load', () => {
  let state = Model.toggleWatch(subscribed(), run(1));
  state = Model.reconcile(state, repo, [done(2, 'success')], ctx()).state;
  assert.deepEqual(plain(Model.parseState(JSON.stringify(state))), plain(state));
});

test('watched runs that aged out of the fetched page stay listed', () => {
  const previous = [run(1), run(2)];
  const watched = {[`${repo}#1`]: {}};
  const merged = Model.mergeActive(previous, [run(3), done(4, 'success')], watched);
  assert.deepEqual(plain(merged.map(item => item.id)), [3, 1]);
});

test('rows are grouped by repo and Mine narrows them', () => {
  let state = Model.addRepo(Model.addRepo(Model.emptyState(), repo), 'acme/other');
  state.me = 'ben';
  const live = {[repo]: [run(1, {actor: 'ben'}), run(2)], 'acme/other': [Model.normalizeRun({id: 3, status: 'queued'}, 'acme/other')]};
  assert.deepEqual(plain(Model.runRows(state, live, {}, '').map(row => row.type)), ['header', 'run', 'run', 'header', 'run']);
  state = {...state, mineOnly: true};
  assert.deepEqual(plain(Model.runRows(state, live, {}, '').map(row => row.key)), [`header:${repo}`, `${repo}#1`]);
  // A run you clicked is yours to see, whoever started it.
  state = Model.toggleWatch(state, run(2));
  assert.equal(Model.runRows(state, live, {}, '').length, 3);
});

test('a failing job marks the run row and opening a run adds its jobs', () => {
  const state = Model.addRepo(Model.emptyState(), repo);
  const key = `${repo}#1`;
  const summary = Model.jobSummary({jobs: [{name: 'x', status: 'completed', conclusion: 'failure'}]});
  const rows = Model.runRows(state, {[repo]: [run(1)]}, {[key]: summary}, key);
  assert.deepEqual(plain(rows.map(row => row.type)), ['header', 'run', 'job', 'actions']);
  assert.equal(rows[1].display, 'failed');
});

test('repo search finds your repos, hides subscribed ones and accepts a full name', () => {
  const state = Model.addRepo(Model.emptyState(), 'acme/app');
  const choices = ['acme/app', 'acme/api', 'other/thing'];
  assert.deepEqual(plain(Model.repoRows(state, choices, 'acme', {}).map(row => row.repo)), ['acme/api']);
  assert.deepEqual(plain(Model.repoRows(state, choices, 'x/y', {}).map(row => row.repo)), ['x/y']);
  assert.deepEqual(plain(Model.repoRows(state, choices, 'acme/app', {})), []);
  assert.deepEqual(plain(Model.repoRows(state, [], '', {'acme/app': 'notfound'})[0].error), 'notfound');
});

test('bar state picks the most urgent thing', () => {
  const base = {unseen: 0, waiting: 0, problem: '', active: 0, watchedActive: 0};
  const state = input => Model.barState({...base, ...input}).state;
  assert.equal(state({}), 'quiet');
  assert.equal(state({active: 5}), 'running');
  assert.equal(state({active: 5, watchedActive: 1}), 'watching');
  assert.equal(state({active: 5, problem: 'network'}), 'problem');
  assert.equal(state({active: 5, waiting: 1, problem: 'network'}), 'waiting');
  assert.equal(state({active: 5, waiting: 1, unseen: 2}), 'failed');
  assert.equal(Model.barState({...base, unseen: 2}).count, 2);
});

test('the bar label stays a single glyph when vertical or empty', () => {
  const running = {state: 'running', count: 5};
  assert.equal(Model.barLabel(running, true), Model.GLYPHS.idle);
  assert.equal(Model.barLabel({state: 'quiet', count: 0}, false), Model.GLYPHS.idle);
  assert.equal(Model.barLabel(running, false), `${Model.GLYPHS.idle} 5`);
  assert.equal(Model.barLabel({state: 'watching', count: 5}, false), `${Model.GLYPHS.idle} 5 ${Model.GLYPHS.bell}`);
});

test('times read as you would expect', () => {
  assert.equal(Model.clock(167000), '02:47');
  assert.equal(Model.clock(3723000), '1:02:03');
  assert.equal(Model.span(401000), '6m 41s');
  assert.equal(Model.span(3723000), '1h 2m');
  assert.equal(Model.ago(720000), '12m');
});

const strings = JSON.parse(read('i18n/en.json'));
const t = key => {
  assert.equal(typeof strings[key], 'string', key);
  return strings[key];
};

test('notifications say what happened and link to the run', () => {
  const summary = Model.jobSummary({total: 8, jobs: [
    {name: 'deploy_convex', status: 'completed', conclusion: 'failure'},
    {name: 'deploy_web', status: 'completed', conclusion: 'failure'},
  ]});
  const failed = Model.notificationFor({kind: 'failed', run: done(1, 'failure')}, summary, t);
  assert.equal(failed.title, 'CI failed');
  assert.equal(failed.urgency, 'critical');
  assert.equal(failed.body, `2 of 8 failed: deploy_convex, deploy_web\n${repo} · main`);
  const passed = Model.notificationFor({kind: 'passed', run: done(1, 'success')}, Model.jobSummary({total: 3, jobs: []}), t);
  assert.equal(passed.urgency, 'normal');
  assert.equal(passed.detail, 'All 3 jobs passed');
  for (const kind of ['failing', 'waiting', 'cancelled', 'other'])
    assert.ok(Model.notificationFor({kind, run: run(1)}, null, t).title, kind);
});

test('notification text cannot carry markup or pose as an option', () => {
  const hostile = run(1, {name: '--exec=rm <img src="https://evil.test/x">', branch: '<b>x</b>'});
  const note = Model.notificationFor({kind: 'failed', run: hostile}, null, t);
  assert.doesNotMatch(note.title, /[<>]/);
  assert.doesNotMatch(note.body, /[<>]/);
  assert.match(note.title, /^[^-]/);
  const argv = plain(Model.notifyArgv(note, 0));
  assert.equal(argv[argv.indexOf('-p') + 1], note.title);
});

test('the notification argv only opens a validated link', () => {
  const note = Model.notificationFor({kind: 'passed', run: run(1)}, null, t);
  const argv = plain(Model.notifyArgv(note, 9));
  assert.deepEqual(argv.slice(argv.indexOf('--action')), ['--action', 'Open run', 'xdg-open', '--with', note.url]);
  assert.deepEqual(argv.slice(argv.indexOf('-r'), argv.indexOf('-r') + 2), ['-r', '9']);
  const unsafe = Model.notificationFor({kind: 'passed', run: run(1, {url: 'https://evil.test/'})}, null, t);
  assert.equal(plain(Model.notifyArgv(unsafe, 0)).includes('--action'), false);
});

test('theme colors come from the active theme and fall back when missing', () => {
  const colors = Model.themeColors('accent = "#111111"\ngreen = "#9ece6a"\nyellow="#e0af68"\n');
  assert.deepEqual(plain(colors), {green: '#9ece6a', yellow: '#e0af68'});
  assert.deepEqual(plain(Model.themeColors('color2 = "#00ff00"\ncolor3 = "#ffff00"\n')), {green: '#00ff00', yellow: '#ffff00'});
  assert.deepEqual(plain(Model.themeColors('')), {green: '', yellow: ''});
});

test('no shipped QML can render GitHub data as rich text or hardcode a color', () => {
  const stripComments = source => source.replace(/^\s*\/\/.*$/gm, '');
  for (const file of fs.readdirSync(root).filter(name => name.endsWith('.qml'))) {
    const code = stripComments(read(file));
    assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b/, `${file} hardcodes a color`);
    const parts = code.split(/(?:^|\s)Text\s*\{/);
    for (const part of parts.slice(1))
      assert.match(part.slice(0, 200), /textFormat:\s*Text\.PlainText/, `${file} has a Text without PlainText`);
  }
});

test('no QML property reuses a name every Item already has', () => {
  // A child item reading such a name gets its own built-in one: a segment bar
  // named its input "states" and its Repeater drew nothing.
  for (const file of fs.readdirSync(root).filter(name => name.endsWith('.qml'))) {
    const clash = read(file).match(/\bproperty\s+\S+\s+(states|state|data|children|resources|transitions)\s*:/);
    assert.equal(clash, null, `${file} declares a property named "${clash && clash[1]}"`);
  }
});
