.pragma library

// Everything here is a pure function over plain data, so it can be tested with
// node. Service.qml owns the processes and files, Panel.qml owns the pixels.
// All GitHub data is untrusted: it is bounded and validated on the way in.

var RULES = ["watched", "failures", "all"]
var MAX_REPOS = 50
var MAX_RECENT = 50
var MAX_SEGMENTS = 14
var RECENT_WINDOW_MS = 24 * 3600 * 1000
var SEEN_TTL_MS = 48 * 3600 * 1000
var MAX_RESPONSE_CHARS = 4 * 1024 * 1024

function cp(code) { return String.fromCodePoint(code) }

var GLYPHS = {
  idle: cp(0xF040D),      // play-circle-outline
  running: cp(0xF0772),   // loading
  queued: cp(0xF0150),    // clock-outline
  waiting: cp(0xF03E6),   // pause-circle-outline
  passed: cp(0xF05E1),    // check-circle-outline
  failed: cp(0xF015A),    // close-circle-outline
  cancelled: cp(0xF073A), // cancel
  other: cp(0xF05E1),
  bell: cp(0xF009A),
  bellOff: cp(0xF009C),
  problem: cp(0xF002A)    // alert-outline
}

// ---------- GitHub requests ----------

var RUN_FIELDS = "{id,name,title:.display_title,status,conclusion,branch:.head_branch,"
  + "actor:.actor.login,trigger:.triggering_actor.login,url:.html_url,created:.created_at,"
  + "started:.run_started_at,updated:.updated_at,attempt:.run_attempt}"
var JOBS_FILTER = "{total:.total_count,jobs:[.jobs[]|{name,status,conclusion,"
  + "started:.started_at,completed:.completed_at,"
  + "step:([.steps[]?|select(.conclusion==\"failure\")|.name]|first)}]}"

function meRequest() {
  return { id: "me", kind: "me", path: "user", jq: "{login}" }
}

function choicesRequest() {
  return { id: "choices", kind: "choices", path: "user/repos?per_page=100&sort=pushed", jq: "[.[].full_name]" }
}

function listRequest(repo) {
  return { id: "list:" + repo, kind: "list", repo: repo,
           path: "repos/" + repo + "/actions/runs?per_page=30",
           jq: "{runs:[.workflow_runs[]|" + RUN_FIELDS + "]}" }
}

function runRequest(repo, id) {
  return { id: "run:" + repo + "#" + id, kind: "run", repo: repo, runId: id,
           path: "repos/" + repo + "/actions/runs/" + id, jq: RUN_FIELDS }
}

function jobsRequest(repo, id) {
  return { id: "jobs:" + repo + "#" + id, kind: "jobs", repo: repo, runId: id,
           path: "repos/" + repo + "/actions/runs/" + id + "/jobs?per_page=100&filter=latest",
           jq: JOBS_FILTER }
}

// A 304 only helps while the data it confirms is still held, and a request that
// has to report a result needs the body. Without this, a repo removed and added
// again would stay empty until something on GitHub changed.
function etagFor(request, etags, jobs, listed) {
  if (request.then) return ""
  if (request.kind === "jobs" && !jobs[request.repo + "#" + request.runId]) return ""
  if (request.kind === "list" && !listed[request.repo]) return ""
  return etags[request.path] || ""
}

// `env` so a missing gh is a plain exit 127 rather than a failed process start.
function ghArgv(request, etag) {
  var argv = ["env", "gh", "api", "--include", "--method", "GET", request.path, "--jq", request.jq]
  if (etag) argv.push("--header", "If-None-Match: " + etag)
  return argv
}

// `gh api --include` prints the status line and headers, a blank line, then the
// body. It exits 1 on a 304, so the status line decides rather than the exit code.
function parseResponse(stdout) {
  var text = String(stdout || "")
  var out = { code: 0, etag: "", remaining: -1, reset: 0, retryAfter: 0, body: "" }
  if (text.length > MAX_RESPONSE_CHARS) return out
  var match = text.match(/^HTTP\/[\d.]+ (\d{3})/)
  if (!match) return out
  out.code = parseInt(match[1], 10)
  var split = text.search(/\r?\n\r?\n/)
  var head = split >= 0 ? text.slice(0, split) : text
  out.body = split >= 0 ? text.slice(split).replace(/^\s+/, "") : ""
  var lines = head.split(/\r?\n/)
  for (var i = 1; i < lines.length; i++) {
    var colon = lines[i].indexOf(":")
    if (colon < 0) continue
    var name = lines[i].slice(0, colon).toLowerCase()
    var value = lines[i].slice(colon + 1).trim()
    if (name === "etag") out.etag = value.slice(0, 200)
    else if (name === "x-ratelimit-remaining") out.remaining = parseInt(value, 10)
    else if (name === "x-ratelimit-reset") out.reset = parseInt(value, 10)
    else if (name === "retry-after") out.retryAfter = parseInt(value, 10)
  }
  return out
}

// "" means fine. Everything else is a reason this call did not produce data.
function classify(response, exitCode, stderr) {
  var code = response.code
  if (exitCode === 127) return "missing"
  if (code === 200 || code === 304) return ""
  if (code === 401 || exitCode === 4 || /gh auth login/.test(String(stderr || ""))) return "auth"
  if (code === 429 || (code === 403 && (response.remaining === 0 || response.retryAfter > 0))) return "rate"
  if (code === 403 || code === 404) return "notfound"
  return "network"
}

function pauseUntil(response, now) {
  var at = now + 60 * 1000
  if (response.retryAfter > 0) at = Math.max(at, now + response.retryAfter * 1000)
  if (response.remaining === 0 && response.reset > 0) at = Math.max(at, response.reset * 1000)
  return Math.min(at, now + 3600 * 1000)
}

// ---------- Validation ----------

function text(value, max) {
  if (typeof value !== "string") return ""
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, max || 200).trim()
}

function stamp(value) {
  var at = typeof value === "string" ? Date.parse(value) : NaN
  return isFinite(at) ? at : 0
}

function validRepo(name) {
  var value = String(name || "")
  if (value.length > 140 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return false
  var parts = value.split("/")
  return parts[0] !== "." && parts[0] !== ".." && parts[1] !== "." && parts[1] !== ".."
}

function safeUrl(value) {
  var url = typeof value === "string" ? value : ""
  return url.length <= 500 && /^https:\/\/github\.com\/[A-Za-z0-9_.\-\/?=&%#]+$/.test(url) ? url : ""
}

function normalizeRun(raw, repo) {
  if (!raw || typeof raw !== "object" || !Number.isSafeInteger(raw.id) || raw.id <= 0) return null
  var created = stamp(raw.created)
  return {
    key: repo + "#" + raw.id,
    repo: repo,
    id: raw.id,
    name: text(raw.name) || text(raw.title) || "Workflow",
    status: text(raw.status, 32),
    conclusion: text(raw.conclusion, 32),
    branch: text(raw.branch),
    actor: text(raw.actor, 64),
    trigger: text(raw.trigger, 64),
    url: safeUrl(raw.url),
    created: created,
    started: stamp(raw.started) || created,
    updated: stamp(raw.updated),
    attempt: Number.isSafeInteger(raw.attempt) && raw.attempt > 0 ? raw.attempt : 1
  }
}

function normalizeRuns(json, repo) {
  var raw = json && Array.isArray(json.runs) ? json.runs.slice(0, 100) : []
  var out = []
  for (var i = 0; i < raw.length; i++) {
    var run = normalizeRun(raw[i], repo)
    if (run) out.push(run)
  }
  return out
}

function normalizeChoices(json) {
  return (Array.isArray(json) ? json : []).filter(validRepo).slice(0, 200)
}

// ---------- What a run or job is doing ----------

function phase(run) {
  if (run.status === "completed") {
    var conclusion = run.conclusion
    if (conclusion === "success") return "passed"
    if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "startup_failure") return "failed"
    if (conclusion === "cancelled") return "cancelled"
    if (conclusion === "action_required") return "waiting"
    return "other"
  }
  if (run.status === "waiting") return "waiting"
  if (run.status === "in_progress") return "running"
  return "queued"
}

function jobState(job) {
  if (job.status === "completed") {
    if (job.conclusion === "failure" || job.conclusion === "timed_out") return "failed"
    return job.conclusion === "cancelled" ? "idle" : "done"
  }
  return job.status === "in_progress" ? "active" : "idle"
}

var SEGMENT_RANK = { done: 0, idle: 1, active: 2, failed: 3 }

// One block per job, up to `max`. A huge matrix shares blocks, and a block shows
// the most urgent job it stands for, so a single failure never disappears.
function segments(states, max) {
  if (states.length <= max) return states
  var out = []
  for (var i = 0; i < max; i++) {
    var worst = "done"
    var end = Math.floor((i + 1) * states.length / max)
    for (var j = Math.floor(i * states.length / max); j < end; j++)
      if (SEGMENT_RANK[states[j]] > SEGMENT_RANK[worst]) worst = states[j]
    out.push(worst)
  }
  return out
}

function jobSummary(json) {
  var raw = json && Array.isArray(json.jobs) ? json.jobs.slice(0, 100) : []
  var jobs = []
  var failed = []
  var finished = 0
  var step = ""
  for (var i = 0; i < raw.length; i++) {
    var job = {
      name: text(raw[i] && raw[i].name) || "job",
      status: text(raw[i] && raw[i].status, 32),
      conclusion: text(raw[i] && raw[i].conclusion, 32),
      started: stamp(raw[i] && raw[i].started),
      completed: stamp(raw[i] && raw[i].completed),
      step: text(raw[i] && raw[i].step)
    }
    job.state = jobState(job)
    if (job.status === "completed") finished++
    if (job.state === "failed") {
      failed.push(job.name)
      if (!step) step = job.step
    }
    jobs.push(job)
  }
  var total = json && Number.isSafeInteger(json.total) ? Math.max(json.total, jobs.length) : jobs.length
  return {
    jobs: jobs,
    total: total,
    finished: finished,
    left: Math.max(0, total - finished),
    failed: failed,
    step: step,
    segments: segments(jobs.map(function(job) { return job.state }), MAX_SEGMENTS)
  }
}

function isMine(run, me) {
  return !!me && (run.actor === me || run.trigger === me)
}

// ---------- State ----------

function emptyState() {
  return { version: 1, me: "", mineOnly: false, repos: [], watched: {}, dismissed: {}, seen: {}, baselined: {}, recent: [], unseen: {} }
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

// Whatever is in the file came from disk: keep only what still makes sense.
function parseState(raw) {
  var out = emptyState()
  var parsed
  try { parsed = JSON.parse(String(raw || "")) } catch (e) { return out }
  if (!parsed || typeof parsed !== "object") return out
  out.me = text(parsed.me, 64)
  out.mineOnly = parsed.mineOnly === true
  var repos = Array.isArray(parsed.repos) ? parsed.repos : []
  for (var i = 0; i < repos.length && out.repos.length < MAX_REPOS; i++) {
    var repo = repos[i]
    if (repo && validRepo(repo.name))
      out.repos.push({ name: repo.name, rule: RULES.indexOf(repo.rule) >= 0 ? repo.rule : "watched" })
  }
  var watched = plainObject(parsed.watched)
  for (var key in watched) {
    var w = watched[key]
    if (!w || !validRepo(w.repo) || !Number.isSafeInteger(w.id) || key !== w.repo + "#" + w.id) continue
    out.watched[key] = {
      key: key, repo: w.repo, id: w.id,
      attempt: Number.isSafeInteger(w.attempt) ? w.attempt : 1,
      name: text(w.name) || "Workflow", branch: text(w.branch), url: safeUrl(w.url),
      notifId: Number.isSafeInteger(w.notifId) ? w.notifId : 0,
      failingSent: w.failingSent === true, waitingSent: w.waitingSent === true
    }
  }
  out.dismissed = plainObject(parsed.dismissed)
  out.seen = plainObject(parsed.seen)
  out.baselined = plainObject(parsed.baselined)
  out.unseen = plainObject(parsed.unseen)
  var recent = Array.isArray(parsed.recent) ? parsed.recent : []
  for (var r = 0; r < recent.length && out.recent.length < MAX_RECENT; r++) {
    var row = recent[r]
    if (row && validRepo(row.repo) && Number.isSafeInteger(row.id)) {
      out.recent.push({
        key: row.repo + "#" + row.id, repo: row.repo, id: row.id,
        name: text(row.name) || "Workflow", branch: text(row.branch),
        actor: text(row.actor, 64), trigger: text(row.trigger, 64),
        phase: text(row.phase, 32), url: safeUrl(row.url),
        finished: Number(row.finished) || 0, duration: Number(row.duration) || 0
      })
    }
  }
  return out
}

function shallow(value) {
  var out = {}
  for (var key in value) out[key] = value[key]
  return out
}

// Copies every map, so QML bindings see a new object and nothing shares edits.
function cloneState(state) {
  var out = shallow(state)
  out.repos = state.repos.slice()
  out.watched = shallow(state.watched)
  out.dismissed = shallow(state.dismissed)
  out.seen = shallow(state.seen)
  out.baselined = shallow(state.baselined)
  out.unseen = shallow(state.unseen)
  out.recent = state.recent.slice()
  return out
}

function isSubscribed(state, name) {
  return state.repos.some(function(repo) { return repo.name === name })
}

function repoRule(state, name) {
  for (var i = 0; i < state.repos.length; i++)
    if (state.repos[i].name === name) return state.repos[i].rule
  return "watched"
}

function addRepo(state, name) {
  if (!validRepo(name) || state.repos.length >= MAX_REPOS) return state
  for (var i = 0; i < state.repos.length; i++)
    if (state.repos[i].name.toLowerCase() === String(name).toLowerCase()) return state
  var next = cloneState(state)
  next.repos.push({ name: name, rule: "watched" })
  return next
}

function removeRepo(state, name) {
  var next = cloneState(state)
  next.repos = next.repos.filter(function(repo) { return repo.name !== name })
  next.recent = next.recent.filter(function(row) { return row.repo !== name })
  delete next.baselined[name]
  var maps = [next.watched, next.dismissed, next.seen, next.unseen]
  for (var m = 0; m < maps.length; m++)
    for (var key in maps[m])
      if (key.indexOf(name + "#") === 0) delete maps[m][key]
  return next
}

function cycleRule(state, name) {
  var next = cloneState(state)
  next.repos = next.repos.map(function(repo) {
    if (repo.name !== name) return repo
    return { name: repo.name, rule: RULES[(RULES.indexOf(repo.rule) + 1) % RULES.length] }
  })
  return next
}

function newWatch(run) {
  return { key: run.key, repo: run.repo, id: run.id, attempt: run.attempt, name: run.name,
           branch: run.branch, url: run.url, notifId: 0, failingSent: false, waitingSent: false }
}

function toggleWatch(state, run) {
  var next = cloneState(state)
  if (next.watched[run.key]) {
    delete next.watched[run.key]
    // Unwatching a run you started must stick: auto-watch may not take it back.
    next.dismissed[run.key] = true
  } else {
    next.watched[run.key] = newWatch(run)
    delete next.dismissed[run.key]
  }
  return next
}

function watchAll(state, runs) {
  var next = cloneState(state)
  for (var i = 0; i < runs.length; i++) {
    if (!next.watched[runs[i].key]) next.watched[runs[i].key] = newWatch(runs[i])
    delete next.dismissed[runs[i].key]
  }
  return next
}

function forgetRun(state, key) {
  var next = cloneState(state)
  delete next.watched[key]
  delete next.dismissed[key]
  delete next.unseen[key]
  return next
}

function acknowledge(state) {
  var next = cloneState(state)
  next.unseen = {}
  return next
}

function setNotifId(state, key, id) {
  if (!state.watched[key] || !(id > 0)) return state
  var next = cloneState(state)
  next.watched[key] = shallow(next.watched[key])
  next.watched[key].notifId = id
  return next
}

function recentRow(run) {
  var finished = run.updated || run.started
  return { key: run.key, repo: run.repo, id: run.id, name: run.name, branch: run.branch,
           actor: run.actor, trigger: run.trigger, phase: phase(run), url: run.url,
           finished: finished, duration: Math.max(0, finished - run.started) }
}

function byNewestFinish(a, b) { return b.finished - a.finished }

// Applies runs fetched for one repo. Returns the new state and what to tell the
// user. `ctx` is { now, me, autoWatchMine }.
//
// A completed run is handled once per attempt (`seen`), so a restart or a nap
// reports what finished in the meantime, and never reports it twice. The very
// first fetch of a repo only sets that baseline: subscribing to a busy repo must
// not replay its history as notifications.
function reconcile(state, repo, runs, ctx) {
  var next = cloneState(state)
  var events = []
  var rule = repoRule(state, repo)
  var baselined = !!state.baselined[repo]

  for (var i = runs.length - 1; i >= 0; i--) {
    var run = runs[i]
    var key = run.key
    var watch = next.watched[key]
    var auto = !!ctx.autoWatchMine && isMine(run, ctx.me) && !next.dismissed[key]

    if (run.status !== "completed") {
      if (!watch && !auto) continue
      watch = watch ? shallow(watch) : newWatch(run)
      if (watch.attempt !== run.attempt) {
        watch.attempt = run.attempt
        watch.failingSent = false
        watch.waitingSent = false
      }
      watch.name = run.name
      watch.branch = run.branch
      watch.url = run.url || watch.url
      if (run.status === "waiting") {
        if (!watch.waitingSent) {
          watch.waitingSent = true
          events.push({ kind: "waiting", run: run, replaceId: watch.notifId })
        }
      } else {
        watch.waitingSent = false
      }
      next.watched[key] = watch
      continue
    }

    var doneKey = key + "#" + run.attempt
    if (next.seen[doneKey]) {
      if (watch && watch.attempt <= run.attempt) delete next.watched[key]
      continue
    }
    var finished = run.updated || ctx.now
    var fresh = ctx.now - finished <= RECENT_WINDOW_MS
    if (!fresh && !watch) continue

    next.seen[doneKey] = finished
    if (fresh) next.recent.push(recentRow(run))
    delete next.watched[key]
    delete next.dismissed[key]

    var kind = phase(run)
    var notify = !!watch
    if (!notify && baselined) {
      notify = auto || rule === "all" || (rule === "failures" && kind === "failed")
    }
    if (notify) {
      events.push({ kind: kind, run: run, replaceId: watch ? watch.notifId : 0, final: true })
      if (kind === "failed") next.unseen[key] = true
    }
  }

  next.baselined[repo] = true
  next.recent = pruneRecent(next.recent, ctx.now)
  for (var seenKey in next.seen)
    if (ctx.now - next.seen[seenKey] > SEEN_TTL_MS) delete next.seen[seenKey]
  return { state: next, events: events }
}

function pruneRecent(rows, now) {
  return rows.filter(function(row) { return now - row.finished <= RECENT_WINDOW_MS })
             .sort(byNewestFinish).slice(0, MAX_RECENT)
}

// The early warning: a job in a watched run failed while the run keeps going.
function applyJobs(state, key, summary) {
  var watch = state.watched[key]
  if (!watch || watch.failingSent || summary.failed.length === 0) return { state: state, events: [] }
  var next = cloneState(state)
  next.watched[key] = shallow(watch)
  next.watched[key].failingSent = true
  next.unseen[key] = true
  return { state: next, events: [{ kind: "failing", run: next.watched[key], summary: summary, replaceId: watch.notifId }] }
}

// What the panel lists as active: the fetched active runs, plus watched runs that
// have aged out of the fetched page and are being followed one by one.
function mergeActive(previous, runs, watched) {
  var listed = {}
  var out = []
  for (var i = 0; i < runs.length; i++) {
    listed[runs[i].key] = true
    if (runs[i].status !== "completed") out.push(runs[i])
  }
  var old = previous || []
  for (var j = 0; j < old.length; j++)
    if (!listed[old[j].key] && watched[old[j].key]) out.push(old[j])
  return out
}

function withoutRun(rows, key) {
  return (rows || []).filter(function(run) { return run.key !== key })
}

function upsertRun(rows, run) {
  var out = withoutRun(rows, run.key)
  out.unshift(run)
  return out
}

// ---------- What the views show ----------

function activeRuns(state, live) {
  var out = []
  for (var i = 0; i < state.repos.length; i++) {
    var runs = live[state.repos[i].name] || []
    for (var j = 0; j < runs.length; j++)
      if (!state.mineOnly || isMine(runs[j], state.me) || state.watched[runs[j].key]) out.push(runs[j])
  }
  return out
}

function runRows(state, live, jobs, expandedKey) {
  var rows = []
  for (var i = 0; i < state.repos.length; i++) {
    var repo = state.repos[i].name
    var runs = activeRuns({ repos: [state.repos[i]], mineOnly: state.mineOnly, me: state.me, watched: state.watched }, live)
    if (runs.length === 0) continue
    rows.push({ type: "header", key: "header:" + repo, title: repo, count: String(runs.length) })
    for (var j = 0; j < runs.length; j++) {
      var run = runs[j]
      var summary = jobs[run.key] || null
      var open = expandedKey === run.key
      var failing = !!summary && summary.failed.length > 0
      rows.push({ type: "run", key: run.key, run: run, summary: summary, open: open, failing: failing,
                  watched: !!state.watched[run.key], display: failing ? "failed" : phase(run) })
      if (!open) continue
      var list = summary ? summary.jobs : []
      for (var k = 0; k < list.length; k++)
        rows.push({ type: "job", key: run.key + ":job:" + k, job: list[k] })
      rows.push({ type: "actions", key: run.key + ":actions", run: run })
    }
  }
  return rows
}

function recentRows(state) {
  var rows = state.recent.filter(function(row) { return !state.mineOnly || isMine(row, state.me) })
  return rows.map(function(row) { return { type: "recent", key: "recent:" + row.key + ":" + row.finished, recent: row } })
}

function repoRows(state, choices, filter, errors) {
  var query = String(filter || "").trim().toLowerCase()
  var subscribed = {}
  for (var i = 0; i < state.repos.length; i++) subscribed[state.repos[i].name.toLowerCase()] = true
  if (!query) {
    return state.repos.map(function(repo) {
      return { type: "repo", key: "repo:" + repo.name, repo: repo.name, rule: repo.rule, error: errors[repo.name] || "" }
    })
  }
  var picks = (choices || []).filter(function(name) {
    return !subscribed[name.toLowerCase()] && name.toLowerCase().indexOf(query) >= 0
  }).slice(0, 10)
  // A repo outside your recent list can still be added by its full name.
  var typed = String(filter).trim()
  if (validRepo(typed) && !subscribed[query] && picks.map(function(n) { return n.toLowerCase() }).indexOf(query) < 0)
    picks.unshift(typed)
  return picks.map(function(name) { return { type: "choice", key: "choice:" + name, repo: name } })
}

function barState(input) {
  if (input.unseen > 0) return { state: "failed", count: input.unseen }
  if (input.waiting > 0) return { state: "waiting", count: input.waiting }
  if (input.problem) return { state: "problem", count: 0 }
  if (input.active > 0) return { state: input.watchedActive > 0 ? "watching" : "running", count: input.active }
  return { state: "quiet", count: 0 }
}

function barLabel(bar, vertical) {
  var glyph = bar.state === "failed" ? GLYPHS.failed
    : bar.state === "waiting" ? GLYPHS.waiting
    : bar.state === "problem" ? GLYPHS.problem
    : GLYPHS.idle
  if (vertical || bar.count === 0) return glyph
  return glyph + " " + bar.count + (bar.state === "watching" ? " " + GLYPHS.bell : "")
}

// ---------- Formatting ----------

function pad(value) { return value < 10 ? "0" + value : String(value) }

function clock(ms) {
  var total = Math.max(0, Math.floor(ms / 1000))
  var hours = Math.floor(total / 3600)
  var minutes = Math.floor(total / 60) % 60
  var seconds = total % 60
  return (hours > 0 ? hours + ":" + pad(minutes) : pad(minutes)) + ":" + pad(seconds)
}

function span(ms) {
  var total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return total + "s"
  if (total < 3600) return Math.floor(total / 60) + "m " + (total % 60) + "s"
  return Math.floor(total / 3600) + "h " + (Math.floor(total / 60) % 60) + "m"
}

function ago(ms) {
  var total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return total + "s"
  if (total < 3600) return Math.floor(total / 60) + "m"
  return Math.floor(total / 3600) + "h"
}

function shortRepo(name) {
  var slash = String(name).indexOf("/")
  return slash >= 0 ? String(name).slice(slash + 1) : String(name)
}

function joinParts(parts) {
  return parts.filter(function(part) { return !!part }).join(" · ")
}

// ---------- Notifications ----------

// Notification text comes from whoever can push to a repo. The toast sanitises
// markup itself; this also keeps a workflow named like an option from being read
// as one by the sender's argument parser.
function notifyText(value) {
  return String(value || "").replace(/[<>&]/g, " ").replace(/^[\s-]+/, "").slice(0, 300)
}

function fill(pattern) {
  var args = arguments
  return String(pattern).replace(/%(\d)/g, function(whole, n) {
    var value = args[parseInt(n, 10)]
    return value === undefined ? whole : String(value)
  })
}

// `t(key)` looks up the plugin's translated pattern; %1, %2 are filled here.
function notificationFor(event, summary, t) {
  var run = event.run
  var name = notifyText(run.name)
  var where = joinParts([notifyText(run.repo), notifyText(run.branch)])
  var failed = summary ? summary.failed : []
  var names = notifyText(failed.slice(0, 3).join(", "))
  var kind = event.kind
  var out = { urgency: "normal", glyph: GLYPHS[kind] || GLYPHS.other, title: "", detail: "", action: t("notify.openRun"), url: run.url }

  if (kind === "failing") {
    out.urgency = "critical"
    out.glyph = GLYPHS.failed
    out.title = fill(t("notify.failing"), name)
    out.detail = fill(t("notify.failingDetail"), names, summary ? summary.left : 0)
    out.action = t("notify.openLogs")
  } else if (kind === "failed") {
    out.urgency = "critical"
    out.title = fill(t("notify.failed"), name)
    out.detail = failed.length > 0
      ? fill(t("notify.failedDetail"), failed.length, summary.total, names)
      : ""
    out.action = t("notify.openLogs")
  } else if (kind === "passed") {
    out.title = fill(t("notify.passed"), name)
    out.detail = summary && summary.total > 0 ? fill(t("notify.passedDetail"), summary.total) : ""
  } else if (kind === "cancelled") {
    out.title = fill(t("notify.cancelled"), name)
  } else if (kind === "waiting") {
    out.title = fill(t("notify.waiting"), name)
    out.detail = t("notify.waitingDetail")
    out.action = t("notify.review")
  } else {
    out.title = fill(t("notify.finished"), name)
  }
  out.body = out.detail ? out.detail + "\n" + where : where
  return out
}

// Reads the same way Commons.Color does; color2 and color3 are older theme names.
function themeColors(raw) {
  var found = {}
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var match = lines[i].match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?(#[0-9A-Fa-f]{6})/)
    if (match) found[match[1]] = match[2]
  }
  return { green: found.green || found.color2 || "", yellow: found.yellow || found.color3 || "" }
}

function parseBody(response) {
  if (response.code !== 200) return null
  try { return JSON.parse(response.body) } catch (e) { return null }
}

function notifyArgv(note, replaceId) {
  var argv = ["omarchy-notification-send", "--app-name", "GitHub Actions", "-g", note.glyph, "-u", note.urgency, "-p"]
  if (replaceId > 0) argv.push("-r", String(replaceId))
  argv.push(note.title || "GitHub Actions", note.body || " ")
  if (note.url) argv.push("--action", note.action, "xdg-open", "--with", note.url)
  return argv
}
