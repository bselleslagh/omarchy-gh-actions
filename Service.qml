import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import "Hub.js" as Hub
import "Model.js" as Model

// The one instance that talks to GitHub, however many bars are on screen. It
// polls through the GitHub CLI, keeps what you subscribed to and watch on disk,
// and sends the notifications. The widget and panel are only views of this.
//
// Checks use conditional requests, so one that finds no change costs nothing
// against GitHub's rate limit. With no repos subscribed, it makes no calls at all.
Item {
  id: service
  visible: false

  // Injected by the shell.
  property var shell: null
  property var manifest: null

  readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") || "") + "/.local/state") + "/omarchy/gh-actions"
  readonly property int maxNotificationsPerRound: 5
  readonly property int maxJobFetchesPerRound: 12

  Commons.Translations { id: strings; directory: Qt.resolvedUrl("i18n") }

  // ---------- What the views read ----------

  property var st: Model.emptyState()
  property bool ready: false
  property var live: ({})
  property var jobs: ({})
  property var repoChoices: []
  property var repoErrors: ({})
  property string problem: ""
  property double lastOk: 0

  // Pushed by the bar widget from its settings in shell.json.
  property bool autoWatchMine: true
  property int pollIntervalSec: 20

  readonly property var activeRuns: Model.activeRuns(st, live)
  readonly property int watchedActive: activeRuns.filter(function(run) { return !!st.watched[run.key] }).length
  readonly property int waitingWatched: activeRuns.filter(function(run) { return !!st.watched[run.key] && run.status === "waiting" }).length
  readonly property var barModel: Model.barState({
    unseen: Object.keys(st.unseen).length,
    waiting: waitingWatched,
    problem: problem,
    active: activeRuns.length,
    watchedActive: watchedActive
  })

  // Commons.Color carries no green or yellow, so these come from the active
  // theme's colors.toml. The file is read again on every theme switch below.
  property var themed: ({ green: "", yellow: "" })
  readonly property color success: themed.green || Commons.Color.accent
  readonly property color warning: themed.yellow || Commons.Color.accent

  // ---------- Internals ----------

  property bool panelOpen: false
  property var queue: []
  property var current: null
  property var etags: ({})
  property var listed: ({})
  property double pausedUntil: 0
  property int failureStreak: 0
  property int notifiedThisRound: 0
  property int overflowThisRound: 0
  property int jobBudget: 0
  property var notifyQueue: []
  property var notifying: null

  // ---------- Actions from the views ----------

  function applySettings(settings) {
    autoWatchMine = !settings || settings.autoWatchMine !== false
    var seconds = settings ? Number(settings.pollIntervalSec) : NaN
    pollIntervalSec = isFinite(seconds) ? Math.max(10, Math.min(300, seconds)) : 20
  }

  function setPanelOpen(open) {
    panelOpen = open
    // Having looked at the panel counts as having seen the failure.
    if (Object.keys(st.unseen).length > 0) st = Model.acknowledge(st)
    if (open) tick()
  }

  function toggleWatch(run) {
    st = Model.toggleWatch(st, run)
    if (st.watched[run.key]) fetchJobs(run)
  }

  function watchAll() {
    st = Model.watchAll(st, activeRuns)
    tick()
  }

  function setMineOnly(value) {
    var next = Model.cloneState(st)
    next.mineOnly = !!value
    st = next
  }

  function addRepo(name) {
    var before = st
    st = Model.addRepo(st, name)
    if (st === before) return
    enqueue(Model.listRequest(name), true)
    pump()
  }

  function removeRepo(name) {
    st = Model.removeRepo(st, name)
    queue = queue.filter(function(request) { return request.repo !== name })
    var nextLive = Model.shallow(live)
    delete nextLive[name]
    live = nextLive
    var nextErrors = Model.shallow(repoErrors)
    delete nextErrors[name]
    repoErrors = nextErrors
    delete listed[name]
    pruneJobs()
  }

  function cycleRule(name) { st = Model.cycleRule(st, name) }

  function fetchJobs(run) {
    enqueue(Model.jobsRequest(run.repo, run.id), true)
    pump()
  }

  function refreshChoices() {
    if (repoChoices.length > 0 || problem === "auth" || problem === "missing") return
    enqueue(Model.choicesRequest(), true)
    pump()
  }

  // The command is a fixed string, so nothing from GitHub can reach this shell.
  function signIn() {
    Quickshell.execDetached(["omarchy-launch-floating-terminal-with-presentation", "gh auth login --web --git-protocol https"])
  }

  // ---------- The polling round ----------

  function tick() {
    if (!ready || st.repos.length === 0 || current || queue.length > 0) return
    if (Date.now() < pausedUntil) return
    notifiedThisRound = 0
    jobBudget = maxJobFetchesPerRound
    if (problem === "auth" || problem === "missing") {
      // Nothing else can work until this does.
      enqueue(Model.meRequest())
    } else {
      if (!st.me) enqueue(Model.meRequest())
      enqueueLists()
    }
    pump()
  }

  function enqueueLists() {
    for (var i = 0; i < st.repos.length; i++) enqueue(Model.listRequest(st.repos[i].name))
  }

  function enqueue(request, front) {
    for (var i = 0; i < queue.length; i++) {
      if (queue[i].id !== request.id) continue
      if (request.then) queue[i].then = request.then
      return
    }
    if (!request.then && current && current.id === request.id) return
    if (front) queue.unshift(request)
    else queue.push(request)
  }

  function pump() {
    if (current || ghProcess.running) return
    if (queue.length === 0) {
      flushOverflow()
      return
    }
    current = queue.shift()
    ghProcess.command = Model.ghArgv(current, Model.etagFor(current, etags, jobs, listed))
    ghProcess.running = true
    watchdog.restart()
  }

  function finish(exitCode) {
    watchdog.stop()
    var request = current
    current = null
    if (request) handle(request, Model.parseResponse(ghOutput.text), exitCode, ghErrors.text)
    Qt.callLater(pump)
  }

  function handle(request, response, exitCode, stderr) {
    var now = Date.now()
    var reason = Model.classify(response, exitCode, stderr)
    var wasBlocked = problem === "auth" || problem === "missing"

    if (reason === "auth" || reason === "missing") {
      problem = reason
      dropQueue()
    } else if (reason === "rate") {
      problem = reason
      pausedUntil = Model.pauseUntil(response, now)
      dropQueue()
    } else if (reason === "network") {
      failureStreak++
      if (failureStreak >= 2) problem = reason
    } else {
      failureStreak = 0
      problem = ""
      lastOk = now
      // Leave room for everything else using this GitHub account.
      if (response.remaining >= 0 && response.remaining < 50) pausedUntil = Model.pauseUntil({ retryAfter: 0, remaining: 0, reset: response.reset }, now)
    }

    // The repo was removed while this was on its way: its answer no longer matters.
    if (request.repo && !Model.isSubscribed(st, request.repo)) return

    if (response.code === 200 && response.etag) etags[request.path] = response.etag
    var body = Model.parseBody(response)

    if (request.kind === "me") {
      var login = body ? Model.text(body.login, 64) : ""
      if (login && login !== st.me) {
        var next = Model.cloneState(st)
        next.me = login
        st = next
      }
      if (wasBlocked && !problem) enqueueLists()
    } else if (request.kind === "choices") {
      if (body) repoChoices = Model.normalizeChoices(body)
    } else if (request.kind === "list") {
      setRepoError(request.repo, reason === "notfound" ? "notfound" : "")
      if (reason === "notfound") clearRepo(request.repo)
      if (body) applyRuns(request.repo, Model.normalizeRuns(body, request.repo), true)
      if (reason === "" ) followUps(request.repo)
    } else if (request.kind === "run") {
      var key = request.repo + "#" + request.runId
      if (reason === "notfound") {
        st = Model.forgetRun(st, key)
        var without = Model.shallow(live)
        without[request.repo] = Model.withoutRun(without[request.repo], key)
        live = without
      } else if (body) {
        var run = Model.normalizeRun(body, request.repo)
        if (run) applyRuns(request.repo, [run], false)
      }
    } else if (request.kind === "jobs") {
      applyJobSummary(request, body)
    }
  }

  function setRepoError(repo, value) {
    if ((repoErrors[repo] || "") === value) return
    var next = Model.shallow(repoErrors)
    if (value) next[repo] = value
    else delete next[repo]
    repoErrors = next
  }

  function clearRepo(repo) {
    delete listed[repo]
    if (!live[repo]) return
    var next = Model.shallow(live)
    delete next[repo]
    live = next
    pruneJobs()
  }

  function applyRuns(repo, runs, fromList) {
    var result = Model.reconcile(st, repo, runs, { now: Date.now(), me: st.me, autoWatchMine: autoWatchMine })
    st = result.state
    var nextLive = Model.shallow(live)
    if (fromList) {
      nextLive[repo] = Model.mergeActive(nextLive[repo], runs, st.watched)
      var ids = {}
      for (var i = 0; i < runs.length; i++) ids[runs[i].key] = true
      listed[repo] = ids
    } else {
      for (var j = 0; j < runs.length; j++) {
        nextLive[repo] = runs[j].status === "completed"
          ? Model.withoutRun(nextLive[repo], runs[j].key)
          : Model.upsertRun(nextLive[repo], runs[j])
      }
    }
    live = nextLive
    pruneJobs()
    deliver(result.events)
  }

  // Runs on every round, also when the run list had not changed: jobs move on
  // without the list changing, and that is how a failing job is noticed early.
  function followUps(repo) {
    for (var key in st.watched) {
      var watch = st.watched[key]
      if (watch.repo === repo && !(listed[repo] || {})[key]) enqueue(Model.runRequest(repo, watch.id))
    }
    var rows = (live[repo] || []).filter(function(run) { return run.status !== "queued" })
    // A watched run's early warning depends on this, so it is always checked. The
    // rest are only for the open panel and share a budget.
    for (var i = 0; i < rows.length; i++) {
      if (st.watched[rows[i].key]) {
        enqueue(Model.jobsRequest(repo, rows[i].id))
      } else if (panelOpen && jobBudget > 0) {
        jobBudget--
        enqueue(Model.jobsRequest(repo, rows[i].id))
      }
    }
  }

  function applyJobSummary(request, body) {
    var key = request.repo + "#" + request.runId
    var summary = body ? Model.jobSummary(body) : (jobs[key] || null)
    if (body && !request.then) {
      var next = Model.shallow(jobs)
      next[key] = summary
      jobs = next
      var result = Model.applyJobs(st, key, summary)
      st = result.state
      deliver(result.events)
    }
    if (request.then) sendNotification(request.then, summary)
  }

  // Job details are only worth keeping for runs still on screen.
  function pruneJobs() {
    var alive = {}
    for (var repo in live)
      for (var i = 0; i < live[repo].length; i++) alive[live[repo][i].key] = true
    var next = {}
    var changed = false
    for (var key in jobs) {
      if (alive[key]) next[key] = jobs[key]
      else changed = true
    }
    if (changed) jobs = next
  }

  // A request is dropped only when nothing else can succeed, but a finished run
  // still gets reported, just without its job details.
  function dropQueue() {
    var dropped = queue
    queue = []
    for (var i = 0; i < dropped.length; i++)
      if (dropped[i].then) sendNotification(dropped[i].then, null)
  }

  // ---------- Notifications ----------

  function deliver(events) {
    for (var i = 0; i < events.length; i++) {
      var event = events[i]
      if (!event.final) {
        sendNotification(event, event.summary || null)
      } else if (notifiedThisRound >= maxNotificationsPerRound) {
        // Coming back after a long time away must not bury the screen.
        overflowThisRound++
      } else {
        notifiedThisRound++
        var request = Model.jobsRequest(event.run.repo, event.run.id)
        request.then = event
        enqueue(request, true)
      }
    }
  }

  function flushOverflow() {
    if (overflowThisRound === 0) return
    var note = { urgency: "normal", glyph: Model.GLYPHS.idle, url: "",
                 title: Model.fill(strings.t("notify.more"), overflowThisRound), body: strings.t("notify.moreBody") }
    overflowThisRound = 0
    sendArgv(Model.notifyArgv(note, 0), "")
  }

  function sendNotification(event, summary) {
    var note = Model.notificationFor(event, summary, function(key) { return strings.t(key) })
    // A warning's id is kept, so the final result can replace it on screen.
    sendArgv(Model.notifyArgv(note, event.replaceId || 0), event.final ? "" : event.run.key)
  }

  function sendArgv(argv, key) {
    notifyQueue.push({ argv: argv, key: key })
    nextNotification()
  }

  function nextNotification() {
    if (notifying || notifyProcess.running || notifyQueue.length === 0) return
    notifying = notifyQueue.shift()
    notifyProcess.command = notifying.argv
    notifyProcess.running = true
  }

  // ---------- Processes and files ----------

  Process {
    id: ghProcess
    environment: ({ GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" })
    stdout: StdioCollector { id: ghOutput; waitForEnd: true }
    stderr: StdioCollector { id: ghErrors; waitForEnd: true }
    onExited: function(code) { service.finish(code) }
  }

  Timer {
    id: watchdog
    interval: 30000
    onTriggered: {
      ghProcess.running = false
      service.finish(-1)
    }
  }

  Process {
    id: notifyProcess
    stdout: StdioCollector { id: notifyOutput; waitForEnd: true }
    onExited: {
      var sent = service.notifying
      service.notifying = null
      var id = parseInt(notifyOutput.text, 10)
      if (sent && sent.key && id > 0) service.st = Model.setNotifId(service.st, sent.key, id)
      Qt.callLater(service.nextNotification)
    }
  }

  Timer {
    id: pollTimer
    running: service.ready && service.st.repos.length > 0
    repeat: true
    triggeredOnStart: true
    interval: 1000 * (service.activeRuns.length > 0 ? service.pollIntervalSec : Math.max(60, service.pollIntervalSec))
    onTriggered: service.tick()
  }

  FileView {
    id: stateFile
    path: service.stateDir + "/state.json"
    atomicWrites: true
    printErrors: false
    onLoaded: {
      service.st = Model.parseState(text())
      service.ready = true
    }
    // No file yet is simply a first run.
    onLoadFailed: service.ready = true
  }

  Timer {
    id: saveTimer
    interval: 400
    onTriggered: stateFile.setText(JSON.stringify(service.st))
  }

  onStChanged: if (ready) saveTimer.restart()

  FileView {
    id: themeFile
    path: Commons.Color.currentThemePath + "/colors.toml"
    printErrors: false
    onLoaded: service.themed = Model.themeColors(text())
  }

  // omarchy-theme-set swaps the theme folder first and then pushes the new
  // colors to the shell, so by the time this fires the file is the new one.
  Connections {
    target: Commons.Color
    function onShellValuesChanged() { themeFile.reload() }
  }

  Component.onCompleted: {
    Hub.set(service)
    Quickshell.execDetached(["install", "-d", "-m", "700", stateDir])
  }

  Component.onDestruction: Hub.clear(service)
}
