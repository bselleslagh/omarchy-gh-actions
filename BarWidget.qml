import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Hub.js" as Hub
import "Model.js" as Model

// The bar button, and the host of the panel. There is one of these per screen;
// they all show the same service.
BarWidget {
  id: root
  moduleName: "io.github.bselleslagh.gh-actions"

  Commons.Translations { id: strings; directory: Qt.resolvedUrl("i18n") }

  property var service: null

  readonly property var status: service ? service.barModel : ({ state: "quiet", count: 0 })
  readonly property bool shown: !(setting("hideWhenQuiet", false) && status.state === "quiet")

  // Shape contract for shell summon/hide routing and the bar's popout handling.
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing : false
  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function toggle() { if (panelLoader.item) panelLoader.item.toggle() }
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }

  function injectPanel() {
    var panel = panelLoader.item
    if (!panel) return
    panel.bar = root.bar
    panel.settings = root.settings
    panel.anchorItem = button
    panel.hostWidget = root
    panel.service = root.service
  }

  // serviceFor() is a call, so nothing would notify a binding when a reloaded
  // plugin brings up a new service.
  function resolveService() {
    var host = root.bar && root.bar.shell ? root.bar.shell : null
    var found = host && typeof host.serviceFor === "function" ? host.serviceFor(root.moduleName) : null
    if (!found) found = Hub.get()
    if (found !== root.service) root.service = found
  }

  function pushSettings() {
    if (root.service) root.service.applySettings(root.settings)
  }

  visible: shown
  implicitWidth: shown ? button.implicitWidth : 0
  implicitHeight: button.implicitHeight

  onBarChanged: { injectPanel(); resolveService() }
  onSettingsChanged: { injectPanel(); pushSettings() }
  onServiceChanged: { injectPanel(); pushSettings() }
  onOpenedChanged: if (service) service.setPanelOpen(opened)

  Timer {
    interval: 2000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.resolveService()
  }

  Loader {
    id: panelLoader
    active: true
    visible: false
    source: Qt.resolvedUrl("Panel.qml")
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: Model.barLabel(root.status, root.vertical)
    active: root.status.state === "failed"
    dimmed: root.status.state === "quiet" || root.status.state === "problem"
    foreground: root.status.state === "waiting" && root.service
      ? root.service.warning
      : (root.bar ? root.bar.barForeground : Commons.Color.foreground)
    tooltipText: {
      var kind = root.status.state
      if (kind === "failed") return strings.tn("tooltip.failed", root.status.count).arg(root.status.count)
      if (kind === "waiting") return strings.tn("tooltip.waiting", root.status.count).arg(root.status.count)
      if (kind === "problem") return strings.t("tooltip.problem")
      if (kind === "quiet") return strings.t("tooltip.quiet")
      return strings.tn("tooltip.active", root.status.count).arg(root.status.count)
    }
    onPressed: function(pressedButton) {
      if (pressedButton === Qt.LeftButton) root.toggle()
    }
  }
}
