import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "model/Shared.js" as Shared
import "model/Clash.js" as Clash

// Clash Verge status and node switching. One provider, so unlike
// jkoestinger/omarchy-vpn's multi-backend VpnController this talks to the API
// directly rather than through a backend-contract abstraction meant for
// choosing among several interchangeable tools — see model/Clash.js's header
// comment for why treating Clash as VPN-exclusive would be the wrong model
// even if it were wired in as a backend there.
Panel {
  id: root
  moduleName: "jackzasian.clash-verge"
  ipcTarget: "jackzasian.clash-verge"

  readonly property color fg: root.bar ? root.bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(fg, 1.45)
  readonly property string fontFamily: root.bar ? root.bar.fontFamily : "JetBrainsMono Nerd Font"

  readonly property int refreshInterval: {
    var v = settings ? settings.refreshIntervalSec : undefined
    var n = typeof v === "number" ? v : parseInt(String(v), 10)
    return (isFinite(n) && n >= 5) ? n : 15
  }
  readonly property string selectorGroupName: {
    var v = settings ? settings.selectorGroup : undefined
    var s = String(v === undefined || v === null ? "" : v).trim()
    return s !== "" ? s : "主代理"
  }

  property bool reachable: false
  property bool loaded: false
  property var configsInfo: ({ loaded: false, mode: "" })
  property var resolved: null // { groupName, group: { now, all } }
  property var proxyTypes: ({})
  property string filter: ""
  property string lastError: ""
  property string actionStatus: ""
  // -1 follows the daemon; 0/1 overrides it while a switch/mode change is in
  // flight, so the UI does not wait a poll cycle to react to its own click.
  property int _desiredConnected: -1
  property string _pendingKey: ""
  property var _pendingToggles: ({})

  readonly property var state: ({
    reachable: root.reachable,
    selector: root.resolved ? root.resolved.group : null,
    groupName: root.resolved ? root.resolved.groupName : "",
    mode: root.configsInfo.mode,
    proxyTypes: root.proxyTypes
  })

  readonly property bool connected: {
    var real = root.reachable && root.configsInfo.mode !== "" && root.configsInfo.mode !== "direct"
    return root._desiredConnected === -1 ? real : (root._desiredConnected === 1)
  }
  readonly property string summary: Clash.clashSummary(root.state)
  readonly property var details: Clash.clashDetails(root.state)
  readonly property var toggles: applyPendingToggles(Clash.clashToggles(root.state), root._pendingToggles)
  readonly property string currentKey: Clash.clashCurrentKey(root.state)
  readonly property var targets: Clash.clashTargets(root.state, root.filter)
  readonly property string emptyText: !root.loaded
    ? "Checking…"
    : (root.reachable ? (root.resolved ? "No proxies match." : "Selector group \"" + root.selectorGroupName + "\" and GLOBAL both missing.") : "Clash Verge isn't running.")
  readonly property string barIcon: Shared.GLYPH_SHIELD

  function applyPendingToggles(list, pending) {
    var keys = Object.keys(pending || {})
    if (keys.length === 0) return list
    return list.map(function(entry) {
      if (pending[entry.key] === undefined) return entry
      return { key: entry.key, label: entry.label, detail: entry.detail, value: pending[entry.key] === true, busy: true }
    })
  }

  function refresh() {
    if (statusProc.running) return
    statusProc.running = true
  }

  function triggerPress(button) {
    if (button === Qt.MiddleButton) { refresh(); return }
    if (opened) close()
    else { open(); refresh() }
  }

  // encodeURIComponent output is limited to unreserved characters plus
  // %-triplets (RFC 3986) — no spaces, quotes, semicolons or backticks — so
  // interpolating it into the bash -c string below carries no injection risk
  // regardless of what the proxy name contains.
  function encodedGroup() {
    return encodeURIComponent(root.selectorGroupName)
  }

  function applyStatus(configsRaw, configuredRaw, globalRaw, proxiesRaw) {
    root.loaded = true
    var configs = Clash.parseClashConfigs(configsRaw)
    var resolvedGroup = Clash.resolveSelector(configuredRaw, globalRaw, root.selectorGroupName)
    root.reachable = configs.loaded || resolvedGroup !== null
    root.configsInfo = configs
    root.resolved = resolvedGroup
    root.proxyTypes = Clash.parseProxyTypes(proxiesRaw)
    root.lastError = ""

    if (root._desiredConnected !== -1) {
      var real = root.reachable && configs.mode !== "" && configs.mode !== "direct"
      if (real === (root._desiredConnected === 1)) root._desiredConnected = -1
    }

    var stillPending = {}
    var changed = false
    for (var key in root._pendingToggles) {
      if (key === "global" && configs.loaded && (configs.mode === "global") === root._pendingToggles[key]) changed = true
      else stillPending[key] = root._pendingToggles[key]
    }
    if (changed) root._pendingToggles = stillPending
  }

  function connectTo(target) {
    if (!root.reachable || !root.resolved || !target || selectProc.running) return
    root.lastError = ""
    root._desiredConnected = 1
    root._pendingKey = target.key
    root.actionStatus = "Switching to " + target.label + "…"
    selectProc.command = [
      "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
      "--unix-socket", Clash.SOCK_PATH,
      "-X", "PUT", "http://localhost/proxies/" + root.encodedGroup(),
      "-H", "Content-Type: application/json",
      "-d", JSON.stringify({ name: target.key })
    ]
    selectProc.running = true
  }

  function disconnect() { setMode("direct") }

  function toggleConnection() {
    if (root.connected) { disconnect(); return }
    setMode("rule")
  }

  function setMode(mode) {
    if (modeProc.running) return
    root.lastError = ""
    root._desiredConnected = mode === "direct" ? 0 : 1
    root.actionStatus = mode === "direct" ? "Bypassing…" : "Restoring proxy…"
    modeProc.command = [
      "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
      "--unix-socket", Clash.SOCK_PATH,
      "-X", "PATCH", "http://localhost/configs",
      "-H", "Content-Type: application/json",
      "-d", JSON.stringify({ mode: mode })
    ]
    modeProc.running = true
  }

  function setToggle(key, value) {
    if (key !== "global" || modeProc.running) return
    var pending = {}
    for (var name in root._pendingToggles) pending[name] = root._pendingToggles[name]
    pending[key] = value
    root._pendingToggles = pending
    setMode(value ? "global" : "rule")
  }

  onOpenedChanged: {
    if (opened) {
      refresh()
    } else {
      // Cleared imperatively, and the field's text along with it: a
      // declarative `text: root.filter` binding would be severed the moment
      // the user typed a character (QtQuick breaks a property binding on the
      // first imperative write to it), so resetting root.filter alone would
      // leave the field showing stale text the next time the panel opens.
      root.filter = ""
      filterField.text = ""
    }
  }

  Component.onCompleted: refresh()

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  Process {
    id: statusProc
    // One process, four requests over the local unix socket — cheap, and it
    // keeps the four answers from the same instant rather than racing four
    // separate polls against a mode or selection that could change between
    // them. GLOBAL is always fetched alongside the configured group so
    // resolveSelector() can fall back without a second round trip.
    command: ["bash", "-c",
      "SOCK='" + Clash.SOCK_PATH + "'; SEP='" + Clash.SEP + "'; " +
      "curl -s --max-time 4 --unix-socket \"$SOCK\" http://localhost/configs; " +
      "printf '\\n%s\\n' \"$SEP\"; " +
      "curl -s --max-time 4 --unix-socket \"$SOCK\" http://localhost/proxies/" + encodedGroup() + "; " +
      "printf '\\n%s\\n' \"$SEP\"; " +
      "curl -s --max-time 4 --unix-socket \"$SOCK\" http://localhost/proxies/GLOBAL; " +
      "printf '\\n%s\\n' \"$SEP\"; " +
      "curl -s --max-time 4 --unix-socket \"$SOCK\" http://localhost/proxies"]
    stdout: StdioCollector {
      id: statusStdout
      waitForEnd: true
    }
    onExited: function(exitCode) {
      var parts = Clash.splitBatches(String(statusStdout.text || ""))
      root.applyStatus(parts[0] || "", parts[1] || "", parts[2] || "", parts[3] || "")
    }
  }

  Process {
    id: selectProc
    running: false
    command: []
    stdout: StdioCollector { id: selectStdout; waitForEnd: true }
    onExited: function(exitCode) {
      var code = String(selectStdout.text || "").trim()
      root._pendingKey = ""
      root.actionStatus = ""
      if (code !== "200" && code !== "204") {
        root._desiredConnected = -1
        root.lastError = "Clash refused that node (HTTP " + (code || "?") + ")"
      }
      actionStatusTimer.restart()
      root.refresh()
    }
  }

  Process {
    id: modeProc
    running: false
    command: []
    stdout: StdioCollector { id: modeStdout; waitForEnd: true }
    onExited: function(exitCode) {
      var code = String(modeStdout.text || "").trim()
      root.actionStatus = ""
      if (code !== "200" && code !== "204") {
        root._desiredConnected = -1
        root._pendingToggles = ({})
        root.lastError = "Clash refused that mode change (HTTP " + (code || "?") + ")"
      }
      actionStatusTimer.restart()
      root.refresh()
    }
  }

  Timer {
    id: actionStatusTimer
    interval: 2600
    repeat: false
    onTriggered: root.actionStatus = ""
  }

  Timer {
    interval: root.refreshInterval * 1000
    running: true
    repeat: true
    onTriggered: root.refresh()
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.barIcon
    fixedWidth: root.bar && root.bar.vertical ? -1 : Style.space(27)
    fixedHeight: root.bar && root.bar.vertical ? Style.space(26) : -1
    tooltipText: "Clash Verge: " + root.summary
    onPressed: function(b) { root.triggerPress(b) }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(420))
    contentHeight: panel.fittedContentHeight(contentColumn.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTextKey: function(t) {
        if (t === "r" || t === "R") root.refresh()
        else if (t === "/") filterField.forceActiveFocus()
      }

      ColumnLayout {
        id: contentColumn
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(10)

        // ── Header ──
        RowLayout {
          Layout.fillWidth: true
          spacing: 8

          Text {
            text: root.barIcon + "  Clash Verge"
            color: root.fg
            font.family: root.fontFamily
            font.pixelSize: Style.font.title
            font.bold: true
            Layout.fillWidth: true
            Layout.alignment: Qt.AlignVCenter
            elide: Text.ElideRight
          }

          Button {
            text: "Refresh"
            foreground: root.fg
            tooltipText: "Refresh status"
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            horizontalPadding: Style.spacing.controlPaddingX
            verticalPadding: Style.spacing.controlPaddingY
            onClicked: root.refresh()
          }
        }

        PanelSeparator { Layout.fillWidth: true; foreground: root.fg }

        // ── Hero ──
        ColumnLayout {
          Layout.fillWidth: true
          spacing: Style.space(3)

          RowLayout {
            Layout.fillWidth: true
            spacing: Style.space(6)

            Text {
              text: root.connected ? Shared.GLYPH_SHIELD : Shared.GLYPH_SWAP
              color: root.connected ? "#22c55e" : "#6b7280"
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              Layout.alignment: Qt.AlignVCenter
            }

            Text {
              text: root.summary
              color: root.fg
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              font.bold: true
              elide: Text.ElideRight
              Layout.fillWidth: true
              Layout.alignment: Qt.AlignVCenter
            }

            Text {
              visible: root.actionStatus !== ""
              text: root.actionStatus
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              Layout.alignment: Qt.AlignVCenter
            }
          }

          Repeater {
            model: root.details
            delegate: RowLayout {
              required property var modelData
              Layout.fillWidth: true
              Layout.leftMargin: Style.space(28)
              spacing: Style.space(6)
              Text {
                text: modelData.label
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                Layout.preferredWidth: Style.space(60)
              }
              Text {
                text: modelData.value
                color: root.fg
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                elide: Text.ElideRight
                Layout.fillWidth: true
              }
            }
          }

          Text {
            visible: root.lastError !== ""
            text: root.lastError
            color: "#ef4444"
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            Layout.leftMargin: Style.space(28)
            Layout.fillWidth: true
            wrapMode: Text.Wrap
          }

          RowLayout {
            visible: root.reachable
            Layout.leftMargin: Style.space(28)
            Layout.topMargin: Style.space(2)
            spacing: Style.space(6)
            Button {
              text: root.connected ? "Bypass (direct)" : "Restore proxy"
              foreground: root.connected ? "#ef4444" : "#22c55e"
              fontFamily: root.fontFamily
              fontSize: Style.font.caption
              horizontalPadding: Style.space(8)
              verticalPadding: Style.space(3)
              onClicked: root.toggleConnection()
            }
          }
        }

        PanelSeparator { Layout.fillWidth: true; foreground: root.fg; visible: root.reachable }

        // ── Toggles ──
        Repeater {
          model: root.reachable ? root.toggles : []
          delegate: Toggle {
            required property var modelData
            Layout.fillWidth: true
            label: modelData.label
            description: modelData.detail
            checked: modelData.value
            foreground: root.fg
            fontFamily: root.fontFamily
            opacity: modelData.busy ? 0.6 : 1
            onClicked: if (!modelData.busy) root.setToggle(modelData.key, !modelData.value)
          }
        }

        // ── Filter ──
        TextField {
          id: filterField
          visible: root.reachable && root.resolved
          Layout.fillWidth: true
          placeholderText: "Filter nodes — press / to search"
          font.family: root.fontFamily
          // No `text: root.filter` binding — see onOpenedChanged's comment.
          // This is the one place root.filter is written from the field;
          // everywhere else that wants it empty sets filterField.text
          // directly.
          onTextChanged: root.filter = text
        }

        // ── Target list ──
        Text {
          visible: root.targets.length === 0
          Layout.fillWidth: true
          text: root.emptyText
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          horizontalAlignment: Text.AlignHCenter
        }

        Flickable {
          id: targetList
          visible: root.targets.length > 0
          Layout.fillWidth: true
          implicitHeight: Math.min(targetColumn.implicitHeight, Style.space(400))
          contentHeight: targetColumn.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds

          ColumnLayout {
            id: targetColumn
            width: targetList.width
            spacing: Style.space(4)

            Repeater {
              model: root.targets

              delegate: BorderSurface {
                required property var modelData
                Layout.fillWidth: true
                readonly property bool isCurrent: modelData.key === root.currentKey
                color: isCurrent ? Qt.rgba(0.13, 0.77, 0.37, 0.1) : Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.055)
                borderSpec: Border.flat(isCurrent ? Qt.rgba(0.13, 0.77, 0.37, 0.3) : Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.05), 1)
                radius: Style.cornerRadius
                padding: Style.space(7)
                implicitHeight: rowBody.implicitHeight + contentTopInset + contentBottomInset

                MouseArea {
                  anchors.fill: parent
                  cursorShape: Qt.PointingHandCursor
                  enabled: root._pendingKey === "" && !selectProc.running
                  onClicked: root.connectTo(modelData)

                  RowLayout {
                    id: rowBody
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.margins: parent.parent.contentTopInset
                    spacing: Style.space(6)

                    Text {
                      text: isCurrent ? "●" : modelData.glyph
                      color: isCurrent ? "#22c55e" : root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.body
                      Layout.alignment: Qt.AlignVCenter
                    }

                    Text {
                      text: modelData.label
                      color: root.fg
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.body
                      font.bold: isCurrent
                      elide: Text.ElideRight
                      Layout.fillWidth: true
                      Layout.alignment: Qt.AlignVCenter
                    }

                    Text {
                      visible: modelData.detail !== ""
                      text: modelData.detail
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      Layout.alignment: Qt.AlignVCenter
                    }
                  }
                }
              }
            }
          }
        }

        // ── Footer ──
        Text {
          Layout.fillWidth: true
          text: "click switches node · / searches · r refreshes · esc closes"
          color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.3)
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          horizontalAlignment: Text.AlignHCenter
        }
      }
    }
  }
}
