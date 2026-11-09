import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// The panel: running runs, what recently finished, and your subscriptions. All
// colors come from the theme, so a theme switch restyles it live. Everything it
// shows comes from Service.qml.
Panel {
  id: root
  moduleName: "io.github.bselleslagh.gh-actions"
  ipcTarget: moduleName
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root
  property var service: null

  Commons.Translations { id: strings; directory: Qt.resolvedUrl("i18n") }

  readonly property color foreground: bar ? bar.foreground : Commons.Color.foreground
  readonly property color dim: Util.alpha(foreground, 0.62)
  readonly property color urgent: bar ? bar.urgent : Commons.Color.urgent
  readonly property color accent: Commons.Color.accent
  readonly property color success: service ? service.success : accent
  readonly property color warning: service ? service.warning : accent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  property string tab: "running"
  property string expandedKey: ""
  property string cursorKey: ""
  property bool cursorActive: false
  property string filterText: ""
  property bool addFocused: false
  property double nowMs: Date.now()

  readonly property var st: service ? service.st : Model.emptyState()
  readonly property string blockedBy: service && (service.problem === "auth" || service.problem === "missing") && st.repos.length > 0 ? service.problem : ""

  readonly property var rows: {
    if (!service || blockedBy) return []
    if (tab === "running") return Model.runRows(st, service.live, service.jobs, expandedKey)
    if (tab === "recent") return Model.recentRows(st)
    return Model.repoRows(st, service.repoChoices, filterText, service.repoErrors)
  }
  readonly property var selectable: rows.filter(function(row) {
    return row.type === "run" || row.type === "recent" || row.type === "repo" || row.type === "choice"
  })
  readonly property var cursorRow: {
    if (!cursorActive) return null
    for (var i = 0; i < selectable.length; i++)
      if (selectable[i].key === cursorKey) return selectable[i]
    return null
  }

  readonly property string statusLine: {
    if (!service || st.repos.length === 0 || blockedBy) return ""
    if (service.problem === "network") return strings.t("status.network")
    if (service.problem === "rate") return strings.t("status.rate")
    if (service.lastOk <= 0) return strings.t("status.checking")
    return strings.t("status.updated").arg(Model.ago(nowMs - service.lastOk))
  }
  readonly property string keysLine: addFocused ? strings.t("keys.adding")
    : tab === "running" ? strings.t("keys.running")
    : tab === "recent" ? strings.t("keys.recent")
    : strings.t("keys.repos")

  function statusColor(display) {
    if (display === "failed") return root.urgent
    if (display === "passed") return root.success
    if (display === "waiting") return root.warning
    if (display === "running") return root.accent
    return root.dim
  }

  function segmentColor(state) {
    if (state === "done") return root.success
    if (state === "failed") return root.urgent
    if (state === "active") return root.accent
    return Util.alpha(root.foreground, 0.2)
  }

  function setTab(name) {
    tab = name
    cursorActive = false
    if (name === "repos" && service) service.refreshChoices()
  }

  function pointAt(key) {
    cursorKey = key
    cursorActive = true
  }

  function moveCursor(delta) {
    if (selectable.length === 0) return
    var index = -1
    for (var i = 0; i < selectable.length; i++)
      if (selectable[i].key === cursorKey) index = i
    if (!cursorActive || index < 0) index = delta > 0 ? 0 : selectable.length - 1
    else index = Math.max(0, Math.min(selectable.length - 1, index + delta))
    pointAt(selectable[index].key)
    ensureVisible(cursorKey)
  }

  function ensureVisible(key) {
    var content = panel.loadedContent
    if (!content) return
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].key !== key) continue
      var item = content.rowRepeater.itemAt(i)
      if (!item) return
      var flick = content.flick
      if (item.y < flick.contentY) flick.contentY = item.y
      else if (item.y + item.height > flick.contentY + flick.height) flick.contentY = item.y + item.height - flick.height
      return
    }
  }

  function toggleExpanded(run) {
    expandedKey = expandedKey === run.key ? "" : run.key
    if (expandedKey && service) service.fetchJobs(run)
  }

  function openUrl(url) {
    if (!url) return
    root.close()
    Qt.openUrlExternally(url)
  }

  function activate(row) {
    if (!row || !service) return
    if (row.type === "run") service.toggleWatch(row.run)
    else if (row.type === "recent") openUrl(row.recent.url)
    else if (row.type === "repo") service.cycleRule(row.repo)
    else if (row.type === "choice") addChoice(row.repo)
  }

  function addChoice(name) {
    if (!service) return
    service.addRepo(name)
    var content = panel.loadedContent
    if (content && content.addField.item) content.addField.item.clear()
    cursorActive = false
  }

  function focusAddField() {
    var content = panel.loadedContent
    if (content && content.addField.item) content.addField.item.focusInput()
  }

  function blurAddField() {
    if (panel.loadedContent) panel.loadedContent.forceActiveFocus()
  }

  onOpenedChanged: {
    nowMs = Date.now()
    if (opened) return
    filterText = ""
    addFocused = false
    cursorActive = false
  }

  // Elapsed times keep counting, but only while there is someone to see them.
  Timer {
    interval: 1000
    repeat: true
    running: root.opened
    onTriggered: root.nowMs = Date.now()
  }

  component PlainLabel: Text {
    textFormat: Text.PlainText
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
    elide: Text.ElideRight
    maximumLineCount: 1
  }

  component SmallLabel: PlainLabel {
    color: root.dim
    font.pixelSize: Style.font.bodySmall
  }

  component StatusGlyph: Text {
    property string display: ""
    readonly property real side: Style.font.icon + Style.space(2)
    textFormat: Text.PlainText
    text: Model.GLYPHS[display] || Model.GLYPHS.other
    color: root.statusColor(display)
    font.family: root.fontFamily
    font.pixelSize: Style.font.icon
    width: side
    height: side
    horizontalAlignment: Text.AlignHCenter
    verticalAlignment: Text.AlignVCenter
    RotationAnimation on rotation {
      from: 0
      to: 360
      duration: Style.duration(1200)
      loops: Animation.Infinite
      running: display === "running" && root.opened && !Style.reduceMotion
    }
  }

  component SegmentBar: Row {
    id: segmentBar
    // Not "states": every Item has a states list, and the Repeater inside
    // would read its own (always empty) one instead of this.
    property var segments: []
    spacing: Style.space(2)
    Repeater {
      model: segmentBar.segments
      Rectangle {
        required property string modelData
        width: Style.space(7)
        height: Style.space(9)
        color: root.segmentColor(modelData)
      }
    }
  }

  component HeaderRow: Item {
    readonly property var entry: parent ? parent.modelData : null
    width: parent ? parent.width : 0
    height: title.implicitHeight + Style.space(10)
    PanelSectionHeader {
      id: title
      anchors.left: parent.left
      anchors.right: count.left
      anchors.bottom: parent.bottom
      anchors.bottomMargin: Style.space(2)
      text: entry ? entry.title : ""
      elide: Text.ElideRight
      foreground: root.foreground
      fontFamily: root.fontFamily
    }
    PanelSectionHeader {
      id: count
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      anchors.bottomMargin: Style.space(2)
      text: entry ? entry.count : ""
      foreground: root.foreground
      fontFamily: root.fontFamily
    }
  }

  component RunRow: CursorSurface {
    id: runRow
    readonly property var entry: parent ? parent.modelData : null
    readonly property var run: entry ? entry.run : null
    readonly property var summary: entry ? entry.summary : null
    readonly property bool showsJobs: !!summary && summary.total > 0 && !!run && run.status !== "queued"
    width: parent ? parent.width : 0
    height: lines.implicitHeight + Style.space(10)
    foreground: root.foreground
    accent: root.accent
    hasCursor: root.cursorActive && !!entry && root.cursorKey === entry.key

    Rectangle {
      visible: !!runRow.entry && runRow.entry.watched
      anchors { left: parent.left; top: parent.top; bottom: parent.bottom }
      width: Style.space(2)
      color: root.accent
    }

    StatusGlyph {
      id: statusGlyph
      anchors.left: parent.left
      anchors.leftMargin: Style.space(8)
      anchors.top: parent.top
      anchors.topMargin: Style.space(5)
      display: runRow.entry ? runRow.entry.display : ""
    }

    Column {
      id: lines
      anchors.left: statusGlyph.right
      anchors.leftMargin: Style.space(8)
      anchors.right: bell.left
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(1)

      Item {
        width: parent.width
        height: nameLabel.implicitHeight
        PlainLabel {
          id: nameLabel
          anchors.left: parent.left
          anchors.right: meter.left
          anchors.rightMargin: Style.space(8)
          text: runRow.run ? runRow.run.name : ""
        }
        Row {
          id: meter
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(8)
          SegmentBar {
            anchors.verticalCenter: parent.verticalCenter
            visible: runRow.showsJobs
            segments: runRow.summary ? runRow.summary.segments : []
          }
          SmallLabel {
            anchors.verticalCenter: parent.verticalCenter
            visible: text !== ""
            color: runRow.run && runRow.run.status === "waiting" ? root.warning : root.dim
            text: {
              if (!runRow.run) return ""
              if (runRow.run.status === "waiting") return strings.t("run.waiting")
              if (runRow.run.status !== "in_progress") return strings.t("run.queued")
              return runRow.showsJobs ? runRow.summary.finished + "/" + runRow.summary.total : ""
            }
          }
          PlainLabel {
            anchors.verticalCenter: parent.verticalCenter
            text: runRow.run ? Model.clock(root.nowMs - runRow.run.started) : ""
          }
        }
      }

      Row {
        width: parent.width
        spacing: Style.space(6)
        SmallLabel {
          id: failedLabel
          visible: !!runRow.entry && runRow.entry.failing
          color: root.urgent
          width: Math.min(implicitWidth, parent.width * 0.6)
          text: runRow.summary && runRow.summary.failed.length > 0
            ? strings.t("run.failedJob").arg(runRow.summary.failed[0]) : ""
        }
        SmallLabel {
          width: parent.width - (failedLabel.visible ? failedLabel.width + parent.spacing : 0)
          text: {
            var run = runRow.run
            if (!run) return ""
            var who = Model.isMine(run, root.st.me) ? strings.t("run.you") : run.actor
            var left = runRow.entry.failing ? strings.tn("run.jobsLeft", runRow.summary.left).arg(runRow.summary.left) : who
            return Model.joinParts([run.branch, left])
          }
        }
      }
    }

    PlainLabel {
      id: bell
      anchors.right: parent.right
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      width: Style.space(16)
      horizontalAlignment: Text.AlignHCenter
      elide: Text.ElideNone
      font.pixelSize: Style.font.icon
      color: runRow.entry && runRow.entry.watched ? root.accent : root.dim
      text: runRow.entry && runRow.entry.watched ? Model.GLYPHS.bell : Model.GLYPHS.bellOff
    }

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      acceptedButtons: Qt.LeftButton | Qt.RightButton
      cursorShape: Qt.PointingHandCursor
      onPositionChanged: if (runRow.entry) root.pointAt(runRow.entry.key)
      onClicked: function(mouse) {
        if (!runRow.entry) return
        root.pointAt(runRow.entry.key)
        if (mouse.button === Qt.RightButton) root.toggleExpanded(runRow.run)
        else root.activate(runRow.entry)
      }
    }
  }

  component JobRow: Item {
    id: jobRow
    readonly property var entry: parent ? parent.modelData : null
    readonly property var job: entry ? entry.job : null
    width: parent ? parent.width : 0
    height: jobLines.implicitHeight + Style.space(4)
    Column {
      id: jobLines
      anchors.left: parent.left
      anchors.leftMargin: Style.space(32)
      anchors.right: parent.right
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      Item {
        width: parent.width
        height: Math.max(jobGlyph.height, jobName.implicitHeight)
        StatusGlyph {
          id: jobGlyph
          anchors.verticalCenter: parent.verticalCenter
          font.pixelSize: Style.font.bodySmall
          display: !jobRow.job ? "" : jobRow.job.state === "failed" ? "failed"
            : jobRow.job.state === "active" ? "running"
            : jobRow.job.state === "done" ? "passed" : "queued"
        }
        SmallLabel {
          id: jobName
          anchors.left: jobGlyph.right
          anchors.leftMargin: Style.space(6)
          anchors.right: jobTime.left
          anchors.rightMargin: Style.space(8)
          anchors.verticalCenter: parent.verticalCenter
          color: jobRow.job && jobRow.job.state === "failed" ? root.urgent : root.foreground
          text: jobRow.job ? jobRow.job.name : ""
        }
        SmallLabel {
          id: jobTime
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          text: {
            var job = jobRow.job
            if (!job || !job.started) return "–"
            return Model.clock((job.completed || root.nowMs) - job.started)
          }
        }
      }
      SmallLabel {
        visible: !!jobRow.job && jobRow.job.state === "failed" && jobRow.job.step !== ""
        width: parent.width
        leftPadding: jobGlyph.width + Style.space(6)
        color: root.urgent
        text: jobRow.job ? strings.t("job.failedStep").arg(jobRow.job.step) : ""
      }
    }
  }

  component ActionsRow: Item {
    readonly property var entry: parent ? parent.modelData : null
    width: parent ? parent.width : 0
    height: openButton.implicitHeight + Style.space(10)
    Button {
      id: openButton
      anchors.left: parent.left
      anchors.leftMargin: Style.space(32)
      anchors.verticalCenter: parent.verticalCenter
      bordered: true
      text: strings.t("run.openLogs")
      foreground: root.foreground
      fontFamily: root.fontFamily
      fontSize: Style.font.bodySmall
      onClicked: if (parent.entry) root.openUrl(parent.entry.run.url)
    }
  }

  component RecentRow: CursorSurface {
    id: recentRow
    readonly property var entry: parent ? parent.modelData : null
    readonly property var recent: entry ? entry.recent : null
    width: parent ? parent.width : 0
    height: recentLines.implicitHeight + Style.space(10)
    foreground: root.foreground
    accent: root.accent
    hasCursor: root.cursorActive && !!entry && root.cursorKey === entry.key
    StatusGlyph {
      id: recentGlyph
      anchors.left: parent.left
      anchors.leftMargin: Style.space(8)
      anchors.top: parent.top
      anchors.topMargin: Style.space(5)
      display: recentRow.recent ? recentRow.recent.phase : ""
    }
    Column {
      id: recentLines
      anchors.left: recentGlyph.right
      anchors.leftMargin: Style.space(8)
      anchors.right: parent.right
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(1)
      Item {
        width: parent.width
        height: recentName.implicitHeight
        PlainLabel {
          id: recentName
          anchors.left: parent.left
          anchors.right: recentAgo.left
          anchors.rightMargin: Style.space(8)
          text: recentRow.recent ? recentRow.recent.name : ""
        }
        SmallLabel {
          id: recentAgo
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          text: recentRow.recent ? strings.t("recent.ago").arg(Model.ago(root.nowMs - recentRow.recent.finished)) : ""
        }
      }
      SmallLabel {
        width: parent.width
        text: {
          var row = recentRow.recent
          if (!row) return ""
          var outcome = row.phase === "cancelled" ? strings.t("recent.cancelled") : Model.span(row.duration)
          return Model.joinParts([Model.shortRepo(row.repo), row.branch, outcome])
        }
      }
    }
    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onPositionChanged: if (recentRow.entry) root.pointAt(recentRow.entry.key)
      onClicked: root.activate(recentRow.entry)
    }
  }

  component RepoRow: CursorSurface {
    id: repoRow
    readonly property var entry: parent ? parent.modelData : null
    width: parent ? parent.width : 0
    height: Math.max(repoLines.implicitHeight, ruleButton.implicitHeight) + Style.space(8)
    foreground: root.foreground
    accent: root.accent
    hasCursor: root.cursorActive && !!entry && root.cursorKey === entry.key
    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      onPositionChanged: if (repoRow.entry) root.pointAt(repoRow.entry.key)
    }
    Column {
      id: repoLines
      anchors.left: parent.left
      anchors.leftMargin: Style.space(8)
      anchors.right: ruleButton.left
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      PlainLabel {
        width: parent.width
        text: repoRow.entry ? repoRow.entry.repo : ""
      }
      SmallLabel {
        visible: !!repoRow.entry && repoRow.entry.error !== ""
        width: parent.width
        color: root.urgent
        text: strings.t("repos.notFound")
      }
    }
    Button {
      id: ruleButton
      anchors.right: parent.right
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      bordered: true
      text: repoRow.entry ? strings.t("rule." + repoRow.entry.rule) : ""
      foreground: repoRow.entry && repoRow.entry.rule === "watched" ? root.dim : root.foreground
      fontFamily: root.fontFamily
      fontSize: Style.font.bodySmall
      onClicked: root.activate(repoRow.entry)
    }
  }

  component ChoiceRow: CursorSurface {
    id: choiceRow
    readonly property var entry: parent ? parent.modelData : null
    width: parent ? parent.width : 0
    height: choiceLabel.implicitHeight + Style.space(10)
    foreground: root.foreground
    accent: root.accent
    hasCursor: root.cursorActive && !!entry && root.cursorKey === entry.key
    PlainLabel {
      id: choiceLabel
      anchors.left: parent.left
      anchors.leftMargin: Style.space(8)
      anchors.right: parent.right
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      text: choiceRow.entry ? "+ " + choiceRow.entry.repo : ""
    }
    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onPositionChanged: if (choiceRow.entry) root.pointAt(choiceRow.entry.key)
      onClicked: root.activate(choiceRow.entry)
    }
  }

  Component { id: headerRowComponent; HeaderRow {} }
  Component { id: runRowComponent; RunRow {} }
  Component { id: jobRowComponent; JobRow {} }
  Component { id: actionsRowComponent; ActionsRow {} }
  Component { id: recentRowComponent; RecentRow {} }
  Component { id: repoRowComponent; RepoRow {} }
  Component { id: choiceRowComponent; ChoiceRow {} }

  function componentFor(type) {
    if (type === "header") return headerRowComponent
    if (type === "run") return runRowComponent
    if (type === "job") return jobRowComponent
    if (type === "actions") return actionsRowComponent
    if (type === "recent") return recentRowComponent
    if (type === "repo") return repoRowComponent
    return choiceRowComponent
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: false
    focusTarget: panel.loadedContent
    contentWidth: panel.fittedContentWidth(Style.space(480))
    contentHeight: panel.fittedContentHeight(panel.loadedContentHeight)

    content: PanelKeyCatcher {
      id: keyCatcher
      property alias flick: flick
      property alias rowRepeater: rowRepeater
      property alias addField: addField
      implicitHeight: column.implicitHeight
      anchors.fill: parent
      blocked: root.addFocused

      onMoveRequested: function(dx, dy) {
        if (dy !== 0) {
          root.moveCursor(dy)
        } else if (root.cursorRow && root.cursorRow.type === "run") {
          // Right opens a run's jobs and left closes them, reading direction aside.
          var run = root.cursorRow.run
          if ((dx > 0) !== (root.expandedKey === run.key)) root.toggleExpanded(run)
        }
      }
      onActivateRequested: {
        if (root.cursorRow) root.activate(root.cursorRow)
        else root.moveCursor(1)
      }
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onDeleteRequested: {
        if (root.cursorRow && root.cursorRow.type === "repo" && root.service) root.service.removeRepo(root.cursorRow.repo)
      }
      onTextKey: function(key) {
        if (key === "1") root.setTab("running")
        else if (key === "2") root.setTab("recent")
        else if (key === "3") root.setTab("repos")
        else if ((key === "m" || key === "M") && root.service) root.service.setMineOnly(!root.st.mineOnly)
        else if (key === "/" && root.tab === "repos") root.focusAddField()
        else if ((key === "a" || key === "A") && root.tab === "running" && root.service) root.service.watchAll()
        else if ((key === "o" || key === "O") && root.cursorRow) {
          var row = root.cursorRow
          if (row.type === "run") root.openUrl(row.run.url)
          else if (row.type === "recent") root.openUrl(row.recent.url)
        }
      }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(10)

        PanelHero {
          width: parent.width
          title: strings.t("panel.title")
          meta: strings.t("panel.meta")
            .arg(root.service ? root.service.activeRuns.length : 0)
            .arg(root.service ? root.service.watchedActive : 0)
            .arg(root.st.repos.length)
          foreground: root.foreground
          fontFamily: root.fontFamily
          iconComponent: Component {
            Text {
              textFormat: Text.PlainText
              text: Model.GLYPHS.idle
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.display
            }
          }
          trailingControl: Component {
            ButtonGroup {
              focusable: false
              foreground: root.foreground
              fontFamily: root.fontFamily
              fontSize: Style.font.bodySmall
              value: root.st.mineOnly ? "mine" : "all"
              options: [
                { value: "mine", label: strings.t("panel.mine") },
                { value: "all", label: strings.t("panel.all") }
              ]
              onChanged: function(picked) {
                if (root.service) root.service.setMineOnly(picked === "mine")
              }
            }
          }
        }

        Row {
          spacing: Style.space(6)
          visible: root.blockedBy === ""
          Repeater {
            model: [
              { name: "running", label: strings.t("tab.running"), count: root.service ? root.service.activeRuns.length : 0 },
              { name: "recent", label: strings.t("tab.recent"), count: 0 },
              { name: "repos", label: strings.t("tab.repos"), count: root.st.repos.length }
            ]
            Button {
              required property var modelData
              bordered: true
              selected: root.tab === modelData.name
              text: modelData.label + (modelData.count > 0 ? " " + modelData.count : "")
              foreground: root.foreground
              fontFamily: root.fontFamily
              fontSize: Style.font.bodySmall
              onClicked: root.setTab(modelData.name)
            }
          }
        }

        PanelSeparator { foreground: root.foreground }

        // Built only while it is on screen: Qt's TextInput reads the clipboard
        // whenever it changes, which has no business happening in the background.
        Loader {
          id: addField
          width: parent.width
          active: root.opened && root.tab === "repos" && root.blockedBy === ""
          visible: active
          height: active && item ? item.implicitHeight : 0
          sourceComponent: BorderSurface {
            implicitHeight: filter.implicitHeight + Style.space(12)
            color: Util.alpha(root.foreground, 0.04)
            radius: Style.cornerRadius
            borderSpec: Border.controlSpec(filter.activeFocus ? "focus" : "normal", root.foreground, root.accent)

            function clear() { filter.text = "" }
            function focusInput() { filter.forceActiveFocus() }

            Item {
              id: filterKeys
              Keys.onPressed: function(event) {
                if (event.key === Qt.Key_Escape || event.key === Qt.Key_Tab) {
                  if (filter.text !== "") filter.text = ""
                  else root.blurAddField()
                  event.accepted = true
                } else if (event.key === Qt.Key_Up || event.key === Qt.Key_Down) {
                  root.moveCursor(event.key === Qt.Key_Down ? 1 : -1)
                  event.accepted = true
                } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                  var row = root.cursorRow || root.selectable[0]
                  if (row && row.type === "choice") root.addChoice(row.repo)
                  event.accepted = true
                }
              }
            }

            FilterInput {
              id: filter
              focus: false
              keyHandler: filterKeys
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.leftMargin: Style.space(9)
              anchors.rightMargin: Style.space(9)
              anchors.verticalCenter: parent.verticalCenter
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              onTextChanged: {
                root.filterText = text
                root.cursorActive = false
              }
              onActiveFocusChanged: root.addFocused = activeFocus
            }

            Text {
              textFormat: Text.PlainText
              anchors.fill: filter
              verticalAlignment: Text.AlignVCenter
              visible: !filter.text && !filter.preeditText
              text: strings.t("repos.placeholder")
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }
          }
        }

        Item {
          visible: root.tab === "repos" && root.filterText === "" && root.rows.length > 0
          width: parent.width
          height: visible ? notifyHeader.implicitHeight : 0
          PanelSectionHeader {
            anchors.left: parent.left
            anchors.leftMargin: Style.space(8)
            text: strings.t("repos.org")
            foreground: root.foreground
            fontFamily: root.fontFamily
          }
          PanelSectionHeader {
            id: notifyHeader
            anchors.right: parent.right
            anchors.rightMargin: Style.space(8)
            text: strings.t("repos.notify")
            foreground: root.foreground
            fontFamily: root.fontFamily
          }
        }

        Flickable {
          id: flick
          visible: root.rows.length > 0
          width: parent.width
          height: visible ? Math.min(contentHeight, Style.space(440)) : 0
          contentWidth: width
          contentHeight: rowColumn.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          interactive: contentHeight > height
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          // A repeater over a plain array rebuilds its rows on every update, and
          // a Flickable keeps its scroll position through that.
          Column {
            id: rowColumn
            width: parent.width
            Repeater {
              id: rowRepeater
              model: root.rows
              Loader {
                required property var modelData
                width: rowColumn.width
                sourceComponent: root.componentFor(modelData.type)
              }
            }
          }
        }

        Column {
          visible: root.rows.length === 0
          width: parent.width
          spacing: Style.space(6)
          topPadding: Style.space(6)
          bottomPadding: Style.space(6)

          PlainLabel {
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            font.pixelSize: Style.font.subtitle
            visible: text !== ""
            text: root.blockedBy === "auth" ? strings.t("signin.title")
              : root.blockedBy === "missing" ? strings.t("missing.title")
              : root.st.repos.length === 0 && root.filterText === "" ? strings.t("empty.noRepos")
              : root.tab === "running" ? strings.t("empty.quiet")
              : ""
          }
          Text {
            textFormat: Text.PlainText
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            text: root.blockedBy === "auth" ? strings.t("signin.body")
              : root.blockedBy === "missing" ? strings.t("missing.body")
              : root.filterText !== "" ? strings.t("empty.noMatch")
              : root.st.repos.length === 0 ? strings.t("empty.noReposHint")
              : root.tab === "recent" ? strings.t("empty.recent")
              : strings.t("empty.quietHint")
          }
          Button {
            anchors.horizontalCenter: parent.horizontalCenter
            visible: root.blockedBy === "auth"
            bordered: true
            selected: true
            text: strings.t("signin.button")
            foreground: root.foreground
            fontFamily: root.fontFamily
            fontSize: Style.font.bodySmall
            onClicked: {
              if (root.service) root.service.signIn()
              root.close()
            }
          }
        }

        PanelSeparator { foreground: root.foreground; visible: root.blockedBy === "" }

        Item {
          visible: root.blockedBy === ""
          width: parent.width
          height: visible ? footerStatus.implicitHeight : 0
          PlainLabel {
            id: footerStatus
            anchors.left: parent.left
            anchors.right: footerKeys.visible ? footerKeys.left : parent.right
            anchors.rightMargin: Style.space(10)
            font.pixelSize: Style.font.caption
            color: root.service && root.service.problem ? root.urgent : root.dim
            text: root.statusLine
          }
          PlainLabel {
            id: footerKeys
            anchors.right: parent.right
            visible: !root.service || !root.service.problem
            font.pixelSize: Style.font.caption
            color: root.dim
            text: root.keysLine
          }
        }
      }
    }
  }
}
