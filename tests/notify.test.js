// notify.pl against a real D-Bus: a private session bus from dbus-run-session,
// with tests/fake-notifications.py standing in for the shell's daemon. Skipped
// where dbus-run-session or python's dbus and gi modules are missing.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const helper = path.join(root, 'notify.pl');
const fake = path.join(__dirname, 'fake-notifications.py');
const Model = {};
vm.runInNewContext(fs.readFileSync(path.join(root, 'Model.js'), 'utf8').replace(/^\.pragma library$/m, ''), Model);
const strings = JSON.parse(fs.readFileSync(path.join(root, 'i18n/en.json'), 'utf8'));
const t = key => strings[key];

const hasBus = spawnSync('dbus-run-session', ['--', 'python3', '-I', '-c', 'import dbus, gi'], {encoding: 'utf8'}).status === 0;
const skip = hasBus ? false : 'needs dbus-run-session and python3 dbus + gi';

function deliver(payload, extra = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gha-notify-'));
  const file = path.join(dir, 'payload.json');
  fs.writeFileSync(file, payload);
  const out = spawnSync('dbus-run-session', ['--', 'python3', '-I', fake, helper, file, ...extra], {encoding: 'utf8', timeout: 30000});
  fs.rmSync(dir, {recursive: true, force: true});
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
}

function privateFailure() {
  const run = Model.normalizeRun({
    id: 99, name: 'Deploy SecretProduct', status: 'completed', conclusion: 'failure',
    branch: 'feature/secret-launch', url: 'https://github.com/secret-org/secret-repo/actions/runs/99',
    created: '2026-11-05T12:00:00Z',
  }, 'secret-org/secret-repo');
  const summary = Model.jobSummary({total: 4, jobs: [
    {name: 'migrate_secret_db', status: 'completed', conclusion: 'failure'},
  ]});
  return Model.notificationFor({kind: 'failed', run}, summary, t);
}

test('the card gets the whole notification while the command line shows none of it', {skip}, () => {
  const note = privateFailure();
  const seen = deliver(Model.notifyPayload(note, 0));
  assert.equal(seen.exit, 0);
  assert.equal(seen.stdout, '42\n');
  assert.equal(seen.calls.length, 1);
  const call = seen.calls[0];
  assert.equal(call.app, 'GitHub Actions');
  assert.equal(call.summary, 'Deploy SecretProduct failed');
  assert.equal(call.body, '1 of 4 failed: migrate_secret_db\nsecret-org/secret-repo · feature/secret-launch');
  assert.equal(call.timeout, -1);
  assert.deepEqual(call.actions, []);
  assert.equal(call.hints.urgency, 2);
  assert.equal(call.hintTypes.urgency, 'Byte');
  assert.equal(call.hints['omarchy-glyph'], Model.GLYPHS.failed);
  assert.deepEqual(JSON.parse(call.hints['omarchy-exec-argv']), ['xdg-open', note.url]);
  assert.deepEqual(JSON.parse(call.hints['omarchy-actions']), [{label: 'Open logs', argv: ['xdg-open', note.url]}]);

  // Read from /proc while the helper waited for its answer.
  assert.deepEqual(call.cmdline, ['perl', '--', helper]);
  const visible = call.cmdline.join(' ');
  for (const secret of ['Secret', 'secret', 'migrate', 'feature'])
    assert.equal(visible.replace(helper, '').includes(secret), false, `${secret} in ${visible}`);
});

test('a warning is replaced in place and its id comes back', {skip}, () => {
  const seen = deliver(Model.notifyPayload({title: 'CI is failing', body: 'x', urgency: 'normal', glyph: '', url: ''}, 17));
  assert.equal(seen.exit, 0);
  assert.equal(seen.calls[0].replaces, 17);
  assert.equal(seen.stdout, '17\n');
  assert.equal(seen.calls[0].hints.urgency, 1);
  assert.equal('omarchy-exec-argv' in seen.calls[0].hints, false);
});

test('text the bus would refuse is cleaned rather than dropped', {skip}, () => {
  // A name cut to length mid-emoji leaves half a surrogate pair.
  const cut = Model.notificationFor({kind: 'passed', run: {name: 'x'.repeat(299) + '🚀', repo: 'a/b', branch: '', url: ''}}, null, t);
  const seen = deliver(Model.notifyPayload({...cut, body: 'a\u0000b \udc00 é'}, 0));
  assert.equal(seen.exit, 0);
  assert.equal(seen.calls[0].summary, 'x'.repeat(299) + '\ufffd passed');
  assert.equal(seen.calls[0].body, 'ab \ufffd é');
  const odd = deliver(JSON.stringify({summary: 's', urgency: 9, replaceId: -4, hints: {'Bad Key': 'x', ok: 'y', n: 5}}) + '\n');
  assert.equal(odd.exit, 0);
  assert.equal(odd.calls[0].replaces, 0);
  assert.equal(odd.calls[0].hints.urgency, 1);
  assert.deepEqual(Object.keys(odd.calls[0].hints).sort(), ['n', 'ok', 'urgency']);
});

test('with no notification daemon it says nothing was shown', {skip}, () => {
  const seen = deliver(Model.notifyPayload(privateFailure(), 0), ['--no-server']);
  assert.equal(seen.exit, 1);
  assert.equal(Model.notifyFailed(seen.exit), true);
});

test('with no session bus, or input that is not a payload, it fails closed', () => {
  const env = {...process.env, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/bus', XDG_RUNTIME_DIR: '/nonexistent'};
  const payload = Model.notifyPayload(privateFailure(), 0);
  assert.equal(spawnSync('perl', ['--', helper], {input: payload, env}).status, 1);
  for (const input of ['', 'not json\n', '[1,2]\n', 'x'.repeat(70000) + '\n'])
    assert.equal(spawnSync('perl', ['--', helper], {input, env}).status, 1, JSON.stringify(input.slice(0, 20)));
});
