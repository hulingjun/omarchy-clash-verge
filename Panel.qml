import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "model/Shared.js" as Shared
import "model/Clash.js" as Clash

// Clash Verge status, node switching, latency testing and traffic. One
// provider, so unlike jkoestinger/omarchy-vpn's multi-backend VpnController
// this talks to the API directly rather than through a backend-contract
// abstraction meant for choosing among several interchangeable tools — see
// model/Clash.js's header comment for why treating Clash as VPN-exclusive
// would be the wrong model even if it were wired in as a backend there.
Panel {
  id: root
  moduleName: "hulingjun.clash-verge-plus"
  ipcTarget: "hulingjun.clash-verge-plus"
  // The base Panel's own IpcHandler only knows open/close/toggle. This widget
  // registers those plus the node/mode/group verbs below on the same target,
  // so a Hyprland bind can flip the proxy without opening anything.
  manageIpc: false

  readonly property color fg: root.bar ? root.bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(fg, 1.45)
  readonly property string fontFamily: root.bar ? root.bar.fontFamily : "JetBrainsMono Nerd Font"
  readonly property color okColor: "#22c55e"
  readonly property color badColor: "#ef4444"
  readonly property color warnColor: "#f59e0b"

  // ── Settings ──────────────────────────────────────────────────────────────
  readonly property int refreshInterval: {
    var v = settings ? settings.refreshIntervalSec : undefined
    var n = typeof v === "number" ? v : parseInt(String(v), 10)
    return (isFinite(n) && n >= 5) ? n : 15
  }
  readonly property var managedProviderNames: Clash.parseManagedProviders(root.setting("managedProviders", ""))
  readonly property bool autoRefreshSubscriptions: String(root.setting("autoRefreshSubscriptions", "On")).toLowerCase() !== "off"
  readonly property int subscriptionRefreshMinutes: {
    var n = Number(root.setting("subscriptionRefreshMinutes", 60))
    return isFinite(n) && n >= 5 ? n : 60
  }
  readonly property bool quotaForecastEnabled: String(root.setting("quotaForecast", "On")).toLowerCase() !== "off"
  readonly property int quotaHistoryDays: {
    var n = Number(root.setting("quotaHistoryDays", 30))
    return isFinite(n) && n >= 7 ? n : 30
  }
  readonly property bool recoverOnNetworkChange: String(root.setting("recoverOnNetworkChange", "On")).toLowerCase() !== "off"
  readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || Quickshell.env("HOME") + "/.local/state")
    + "/omarchy/clash-verge-plus"
  readonly property string historyPath: root.stateDir + "/quota-history.json"
  readonly property string selectorGroupName: {
    var v = settings ? settings.selectorGroup : undefined
    var s = String(v === undefined || v === null ? "" : v).trim()
    return s !== "" ? s : "主代理"
  }
  readonly property string barLabelMode: {
    var s = String(root.setting("barLabel", "icon")).trim().toLowerCase()
    return Clash.BAR_LABEL_MODES.indexOf(s) !== -1 ? s : "icon"
  }
  readonly property string defaultSortMode: {
    var s = String(root.setting("sortMode", "config")).trim().toLowerCase()
    return Clash.SORT_MODES.indexOf(s) !== -1 ? s : "config"
  }
  readonly property var api: Clash.apiConfig(root.setting("socketPath", ""),
                                             root.setting("controllerUrl", ""),
                                             root.setting("secret", ""))

  // ── Live state ────────────────────────────────────────────────────────────
  property bool reachable: false
  property bool loaded: false
  property var configsInfo: ({ loaded: false, mode: "", tun: false })
  property var resolved: null            // { groupName, group: { now, all, type, fixed } }
  property var nodes: ({})               // name -> node, from the deep poll
  property var groupChoices: []          // every group the picker can offer
  property var netSample: ({ loaded: false })
  property var rates: ({ known: false })
  property var providers: []
  property var usageHistory: ({ version: 1, providers: ({}) })
  property bool historyLoaded: false
  property bool stateReady: false
  property var providerUpdateQueue: []
  property var networkHealthQueue: []
  property string routeSignature: ""
  property bool routeInitialized: false
  property string filter: ""
  property string sortMode: root.defaultSortMode
  property string groupOverride: ""      // set by the picker, beats the setting
  property string statusError: ""        // connectivity, owned by the poll
  property string lastError: ""          // an action that failed, cleared on a timer
  property string actionStatus: ""
  property int cursorIndex: -1
  property bool testing: false
  property double providersFetchedAt: 0

  // -1 follows the daemon; 0/1 overrides it while a switch/mode change is in
  // flight, so the UI does not wait a poll cycle to react to its own click.
  property int _desiredConnected: -1
  property string _pendingKey: ""
  property var _pendingToggles: ({})

  readonly property string requestedGroup: root.groupOverride !== "" ? root.groupOverride : root.selectorGroupName
  readonly property string activeGroupName: root.resolved ? root.resolved.groupName : root.requestedGroup

  readonly property var state: ({
    reachable: root.reachable,
    mode: root.configsInfo.mode,
    tun: root.configsInfo.tun,
    groupName: root.activeGroupName,
    group: root.resolved ? root.resolved.group : null,
    nodes: root.nodes,
    net: root.netSample,
    rates: root.rates,
    providers: root.providers
  })

  readonly property bool connected: {
    var real = root.reachable && root.configsInfo.mode !== "" && root.configsInfo.mode !== "direct"
    return root._desiredConnected === -1 ? real : (root._desiredConnected === 1)
  }
  readonly property string summary: Clash.clashSummary(root.state)
  readonly property var details: Clash.clashDetails(root.state)
  readonly property var networkRows: Clash.clashNetworkRows(root.state)
  readonly property var toggles: applyPendingToggles(Clash.clashToggles(root.state), root._pendingToggles)
  readonly property string currentKey: Clash.clashCurrentKey(root.state)
  readonly property var targets: Clash.clashTargets(root.state, root.filter, root.sortMode)
  readonly property var subscriptions: Clash.subscriptionRows(root.providers, root.nowMillis,
                                                                 root.usageHistory, root.quotaForecastEnabled)
  readonly property string visibleError: root.lastError !== "" ? root.lastError : root.statusError
  readonly property string emptyText: !root.loaded
    ? "Checking…"
    : (root.reachable
        ? (root.resolved ? "No proxies match." : "Group \"" + root.requestedGroup + "\" and GLOBAL both missing.")
        : "Clash Verge isn't running.")

  // Re-read once per poll rather than on every binding evaluation, so the
  // "3h ago" style strings do not force a repaint whenever anything else in
  // the panel changes.
  property double nowMillis: Date.now()

  readonly property string barGlyph: Clash.barGlyph(root.state)
  readonly property string barText: {
    var label = Clash.barLabel(root.state, root.barLabelMode)
    return label === "" ? root.barGlyph : root.barGlyph + "  " + label
  }
  readonly property color barColor: {
    switch (Clash.barState(root.state)) {
      case "down": return root.bar ? root.bar.urgent : Color.urgent
      case "direct": return root.dim
      case "global": return Color.accent
      default: return root.fg
    }
  }

  function applyPendingToggles(list, pending) {
    var keys = Object.keys(pending || {})
    if (keys.length === 0) return list
    return list.map(function(entry) {
      if (pending[entry.key] === undefined) return entry
      return { key: entry.key, label: entry.label, detail: entry.detail, value: pending[entry.key] === true, busy: true }
    })
  }

  // ── Polling ───────────────────────────────────────────────────────────────
  // A closed panel polls only /configs plus the active group (~3.5 KB), and
  // adds /connections just when the bar is showing throughput. An open one
  // beats every 2 seconds so throughput reads live — but the ~74 KB proxy dump
  // behind the node list carries only types and latencies, which do not move
  // on that timescale, so re-fetching and re-parsing it thirty times a minute
  // would be most of the widget's cost for none of its value. It is fetched at
  // most every 9 seconds, and immediately whenever the list itself is stale.
  property double lastDeepAt: 0

  function refresh() {
    if (statusProc.running) return
    var now = Date.now()
    var deep = root.opened && (now - root.lastDeepAt >= 9000)
    var withTraffic = root.opened || root.barLabelMode === "speed"
    if (deep) root.lastDeepAt = now
    statusProc.command = Clash.buildStatusCommand(root.api, root.requestedGroup, deep, withTraffic)
    statusProc.running = true
  }

  // Forces the next refresh() to take the deep path — used when the panel
  // opens or the group changes, where a stale node list is the whole problem.
  function invalidateDeep() { root.lastDeepAt = 0 }

  function triggerPress(button) {
    if (button === Qt.MiddleButton) { refresh(); return }
    if (opened) close()
    else { open(); refresh() }
  }

  function setError(message) {
    root.lastError = String(message || "")
    if (root.lastError !== "") errorTimer.restart()
  }

  function clearError() {
    root.lastError = ""
    errorTimer.stop()
  }

  function applyStatus(parts) {
    root.loaded = true
    root.nowMillis = Date.now()

    var configs = Clash.parseClashConfigs(Clash.batchSlot(parts, Clash.SLOT_CONFIGS))
    var resolvedGroup = Clash.resolveSelector(Clash.batchSlot(parts, Clash.SLOT_GROUP),
                                              Clash.batchSlot(parts, Clash.SLOT_GLOBAL),
                                              root.requestedGroup)
    root.reachable = configs.loaded || resolvedGroup !== null
    root.configsInfo = configs
    root.resolved = resolvedGroup

    // curl's exit code separates "Clash Verge isn't running" from "the socket
    // is there but refused us" or "the endpoint setting is wrong" — v1.0.0
    // collapsed all three into the first message.
    var rc = Clash.parseExitCode(Clash.batchSlot(parts, Clash.SLOT_RC))
    root.statusError = root.reachable ? "" : Clash.describeCurlError(rc, root.api)

    // The deep slots are empty on a shallow poll; keeping the last dump is
    // better than blanking every row's type and latency between opens.
    var proxies = Clash.parseProxies(Clash.batchSlot(parts, Clash.SLOT_PROXIES))
    if (proxies.loaded) {
      root.nodes = proxies.nodes
      root.groupChoices = Clash.selectableGroups(proxies, root.activeGroupName)
    }

    var net = Clash.parseConnections(Clash.batchSlot(parts, Clash.SLOT_CONNECTIONS))
    if (net.loaded) {
      net.at = root.nowMillis
      root.rates = Clash.computeRates(root.netSample, net)
      root.netSample = net
    }

    if (root._desiredConnected !== -1) {
      var real = root.reachable && configs.mode !== "" && configs.mode !== "direct"
      if (real === (root._desiredConnected === 1)) root._desiredConnected = -1
    }

    var stillPending = {}
    var changed = false
    for (var key in root._pendingToggles) {
      var want = root._pendingToggles[key]
      var settled = configs.loaded
        && ((key === "global" && (configs.mode === "global") === want)
         || (key === "tun" && configs.tun === want))
      if (settled) changed = true
      else stillPending[key] = want
    }
    if (changed) root._pendingToggles = stillPending
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  function httpCommand(method, path, body, timeoutSeconds) {
    var timeout = Number(timeoutSeconds || 8)
    var args = ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", String(timeout)]
      .concat(Clash.curlArgs(root.api))
      .concat(["-X", method, Clash.apiUrl(root.api, path)])
    if (body !== undefined && body !== null) {
      args = args.concat(["-H", "Content-Type: application/json", "-d", JSON.stringify(body)])
    }
    return args
  }

  function getCommand(path, timeoutSeconds) {
    return ["curl", "-s", "--max-time", String(timeoutSeconds)]
      .concat(Clash.curlArgs(root.api))
      .concat([Clash.apiUrl(root.api, path)])
  }

  function groupPath(suffix) {
    return "/proxies/" + encodeURIComponent(root.activeGroupName) + (suffix || "")
  }

  function connectTo(target) {
    if (!root.reachable || !root.resolved || !target || selectProc.running) return
    clearError()
    root._pendingKey = target.key

    // An auto group's rows are pins, not selections: PUT records a `fixed`
    // override and DELETE hands the choice back to the group's own probing.
    if (target.isAuto) {
      root.actionStatus = "Handing back to " + root.resolved.group.type + "…"
      selectProc.command = httpCommand("DELETE", groupPath(), null)
    } else {
      root._desiredConnected = 1
      root.actionStatus = (Clash.isAutoGroupType(root.resolved.group.type) ? "Pinning " : "Switching to ") + target.label + "…"
      selectProc.command = httpCommand("PUT", groupPath(), { name: target.key })
    }
    selectProc.running = true
  }

  function disconnect() { setMode("direct") }

  function toggleConnection() {
    if (root.connected) { disconnect(); return }
    setMode("rule")
  }

  function setMode(mode) {
    if (modeProc.running) return
    clearError()
    root._desiredConnected = mode === "direct" ? 0 : 1
    root.actionStatus = mode === "direct" ? "Bypassing…" : "Restoring proxy…"
    modeProc.command = httpCommand("PATCH", "/configs", { mode: mode })
    modeProc.running = true
  }

  function setTun(enabled) {
    if (modeProc.running) return
    clearError()
    root.actionStatus = enabled ? "Enabling TUN…" : "Disabling TUN…"
    modeProc.command = httpCommand("PATCH", "/configs", { tun: { enable: enabled === true } })
    modeProc.running = true
  }

  function setToggle(key, value) {
    if (modeProc.running) return
    if (key !== "global" && key !== "tun") return
    var pending = {}
    for (var name in root._pendingToggles) pending[name] = root._pendingToggles[name]
    pending[key] = value
    root._pendingToggles = pending
    if (key === "global") setMode(value ? "global" : "rule")
    else setTun(value)
  }

  function selectGroup(name) {
    if (String(name || "") === "" || name === root.activeGroupName) return
    root.groupOverride = String(name)
    root.cursorIndex = -1
    clearError()
    invalidateDeep()
    refresh()
  }

  function cycleSort() {
    var i = Clash.SORT_MODES.indexOf(root.sortMode)
    root.sortMode = Clash.SORT_MODES[(i + 1) % Clash.SORT_MODES.length]
  }

  // One request probes every member of the group. The delays mihomo already
  // had in its history are what the rows show until this runs.
  function testAll() {
    if (testProc.running || !root.resolved) return
    clearError()
    root.testing = true
    root.actionStatus = "Testing " + root.resolved.group.all.length + " nodes…"
    testProc.probed = root.resolved.group.all.slice()
    testProc.command = getCommand("/group/" + encodeURIComponent(root.activeGroupName)
      + "/delay?url=" + encodeURIComponent(Clash.TEST_URL) + "&timeout=3000", 25)
    testProc.running = true
  }

  function testNode(name) {
    if (nodeTestProc.running || String(name || "") === "") return
    clearError()
    root.actionStatus = "Testing " + name + "…"
    nodeTestProc.nodeName = String(name)
    nodeTestProc.command = getCommand("/proxies/" + encodeURIComponent(name)
      + "/delay?url=" + encodeURIComponent(Clash.TEST_URL) + "&timeout=3000", 8)
    nodeTestProc.running = true
  }

  // ~295 KB on a config with providers, because mihomo inlines every proxy of
  // every provider into the response. On demand and throttled, never polled.
  function loadProviders(force) {
    if (providerProc.running) return
    if (!force && root.nowMillis - root.providersFetchedAt < 120000) return
    providerProc.command = getCommand("/providers/proxies", 10)
    providerProc.running = true
  }

  function updateProvider(name) {
    if (providerUpdateProc.running || String(name || "") === "") return
    clearError()
    root.providerUpdateQueue = [String(name)]
    updateNextProvider()
  }

  function updateAllProviders() {
    if (providerUpdateProc.running) return
    var names = []
    for (var i = 0; i < root.providers.length; i++) {
      if (root.providers[i].vehicleType === "HTTP") names.push(root.providers[i].name)
    }
    if (names.length === 0) { root.loadProviders(true); return }
    clearError()
    root.providerUpdateQueue = names
    updateNextProvider()
  }

  function updateNextProvider() {
    if (providerUpdateProc.running) return
    if (root.providerUpdateQueue.length === 0) {
      root.actionStatus = ""
      root.loadProviders(true)
      root.refresh()
      return
    }
    var queue = root.providerUpdateQueue.slice()
    var name = queue.shift()
    root.providerUpdateQueue = queue
    providerUpdateProc.providerName = name
    root.actionStatus = "Updating " + name + "…"
    providerUpdateProc.command = httpCommand("PUT", "/providers/proxies/" + encodeURIComponent(name), null, 45)
    providerUpdateProc.running = true
  }

  function recoverAfterNetworkChange() {
    if (!root.recoverOnNetworkChange || networkRecoverProc.running) return
    root.actionStatus = "Recovering proxy after network change…"
    networkRecoverProc.command = httpCommand("DELETE", "/connections", null)
    networkRecoverProc.running = true
  }

  function healthCheckNextProvider() {
    if (networkHealthProc.running) return
    if (root.networkHealthQueue.length === 0) {
      root.actionStatus = ""
      root.loadProviders(true)
      root.refresh()
      return
    }
    var queue = root.networkHealthQueue.slice()
    var name = queue.shift()
    root.networkHealthQueue = queue
    networkHealthProc.command = getCommand("/providers/proxies/" + encodeURIComponent(name) + "/healthcheck", 10)
    networkHealthProc.running = true
  }

  function checkDefaultRoute() {
    if (routeProc.running) return
    routeProc.running = true
  }

  // ── Keyboard cursor ───────────────────────────────────────────────────────
  function moveCursor(delta) {
    var count = root.targets.length
    if (count === 0) { root.cursorIndex = -1; return }
    var next = root.cursorIndex + delta
    if (root.cursorIndex < 0) next = delta > 0 ? 0 : count - 1
    if (next < 0) next = count - 1
    if (next >= count) next = 0
    root.cursorIndex = next
  }

  function activateCursor() {
    if (root.cursorIndex < 0 || root.cursorIndex >= root.targets.length) return
    connectTo(root.targets[root.cursorIndex])
  }

  onOpenedChanged: {
    if (opened) {
      root.cursorIndex = -1
      invalidateDeep()
      refresh()
      loadProviders(false)
    } else {
      // Cleared imperatively, and the field's text along with it: a
      // declarative `text: root.filter` binding would be severed the moment
      // the user typed a character (QtQuick breaks a property binding on the
      // first imperative write to it), so resetting root.filter alone would
      // leave the field showing stale text the next time the panel opens.
      root.filter = ""
      filterField.text = ""
      root.cursorIndex = -1
    }
  }

  Component.onCompleted: {
    ensureStateProc.running = true
    refresh()
    checkDefaultRoute()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // ── IPC ───────────────────────────────────────────────────────────────────
  // `omarchy-shell jackzasian.clash-verge bypass`, and friends. The point is
  // Hyprland binds: flipping the proxy should not require the panel.
  IpcHandler {
    target: root.ipcTarget

    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function status(): string { return root.summary }
    function refreshNow(): void { root.refresh() }
    function refreshSubscriptions(): void { root.updateAllProviders() }
    function recoverNetwork(): void { root.recoverAfterNetworkChange() }
    function bypass(): void { root.setMode("direct") }
    function restore(): void { root.setMode("rule") }
    function toggleProxy(): void { root.toggleConnection() }
    function mode(name: string): void {
      var m = String(name || "").toLowerCase()
      if (m === "rule" || m === "global" || m === "direct") root.setMode(m)
    }
    function tun(enabled: string): void { root.setTun(String(enabled) === "true") }
    function select(name: string): void {
      root.connectTo({ key: String(name), label: String(name), isAuto: false })
    }
    function auto(): void {
      root.connectTo({ key: Clash.AUTO_KEY, label: "Automatic", isAuto: true })
    }
    function group(name: string): void { root.selectGroup(String(name)) }
    function test(): void { root.testAll() }
  }

  // ── Processes ─────────────────────────────────────────────────────────────
  Process {
    id: statusProc
    // One process, one poll: every request goes out together so the answers
    // describe the same instant rather than racing each other against a mode
    // or selection that could change between them.
    stdout: StdioCollector { id: statusStdout; waitForEnd: true }
    onExited: root.applyStatus(Clash.splitBatches(String(statusStdout.text || "")))
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
        root.setError("Clash refused that node (HTTP " + (code || "?") + ")")
      }
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
        root.setError("Clash refused that change (HTTP " + (code || "?") + ")")
      }
      root.refresh()
    }
  }

  Process {
    id: testProc
    running: false
    command: []
    property var probed: []
    stdout: StdioCollector { id: testStdout; waitForEnd: true }
    onExited: function(exitCode) {
      var result = Clash.parseDelayMap(String(testStdout.text || ""))
      root.testing = false
      root.actionStatus = ""
      if (!result.ok) root.setError("Latency test failed: " + result.error)
      else root.nodes = Clash.mergeDelays(root.nodes, result.delays, testProc.probed)
    }
  }

  Process {
    id: nodeTestProc
    running: false
    command: []
    property string nodeName: ""
    stdout: StdioCollector { id: nodeTestStdout; waitForEnd: true }
    onExited: function(exitCode) {
      var result = Clash.parseSingleDelay(String(nodeTestStdout.text || ""))
      root.actionStatus = ""
      var delays = {}
      if (result.ok) delays[nodeTestProc.nodeName] = result.delay
      root.nodes = Clash.mergeDelays(root.nodes, delays, [nodeTestProc.nodeName])
      if (!result.ok) root.setError(nodeTestProc.nodeName + ": " + result.error)
    }
  }

  Process {
    id: providerProc
    running: false
    command: []
    stdout: StdioCollector { id: providerStdout; waitForEnd: true }
    onExited: function(exitCode) {
      var now = Date.now()
      var parsed = Clash.filterProviders(Clash.parseProviders(String(providerStdout.text || "")),
                                         root.managedProviderNames)
      root.providers = parsed
      root.providersFetchedAt = now
      if (root.quotaForecastEnabled) {
        root.usageHistory = Clash.observeUsage(root.usageHistory, parsed, now, root.quotaHistoryDays)
        historyFile.setText(JSON.stringify(root.usageHistory, null, 2) + "\n")
      }
    }
  }

  Process {
    id: providerUpdateProc
    running: false
    command: []
    property string providerName: ""
    stdout: StdioCollector { id: providerUpdateStdout; waitForEnd: true }
    onExited: function(exitCode) {
      var code = String(providerUpdateStdout.text || "").trim()
      if (code !== "200" && code !== "204") {
        root.setError(providerUpdateProc.providerName + " update failed (HTTP " + (code || "?") + ")")
      }
      root.updateNextProvider()
    }
  }

  FileView {
    id: historyFile
    path: root.historyPath
    watchChanges: false
    atomicWrites: true
    printErrors: false
    onLoaded: {
      root.usageHistory = Clash.parseUsageHistory(text())
      root.historyLoaded = true
      if (root.stateReady && root.providersFetchedAt === 0) root.loadProviders(true)
    }
    onLoadFailed: {
      root.usageHistory = Clash.parseUsageHistory("")
      root.historyLoaded = true
      if (root.stateReady && root.providersFetchedAt === 0) root.loadProviders(true)
    }
  }

  Process {
    id: ensureStateProc
    running: false
    command: ["mkdir", "-p", root.stateDir]
    onExited: {
      root.stateReady = true
      if (root.historyLoaded) root.loadProviders(true)
      else historyFile.reload()
    }
  }

  Process {
    id: routeProc
    running: false
    command: ["bash", "-c",
      "r=$(ip -4 route show default 2>/dev/null | head -n1); "
      + "d=$(awk '{for(i=1;i<=NF;i++)if($i==\"dev\"){print $(i+1);exit}}' <<<\"$r\"); "
      + "u=$(nmcli -g GENERAL.CON-UUID device show \"$d\" 2>/dev/null | head -n1); "
      + "[[ -n $r && -n $u ]] && printf '%s|%s' \"$u\" \"$r\" || true"]
    stdout: StdioCollector { id: routeStdout; waitForEnd: true }
    onExited: {
      var signature = String(routeStdout.text || "").trim()
      if (signature === "") return
      if (!root.routeInitialized) {
        root.routeSignature = signature
        root.routeInitialized = true
      } else if (signature !== root.routeSignature) {
        root.routeSignature = signature
        root.recoverAfterNetworkChange()
      }
    }
  }

  Process {
    id: networkRecoverProc
    running: false
    command: []
    stdout: StdioCollector { waitForEnd: true }
    onExited: {
      var names = []
      for (var i = 0; i < root.providers.length; i++) names.push(root.providers[i].name)
      root.networkHealthQueue = names
      root.healthCheckNextProvider()
    }
  }

  Process {
    id: networkHealthProc
    running: false
    command: []
    stdout: StdioCollector { waitForEnd: true }
    onExited: root.healthCheckNextProvider()
  }

  Timer {
    id: errorTimer
    interval: 6000
    repeat: false
    onTriggered: root.lastError = ""
  }

  Timer {
    interval: root.refreshInterval * 1000
    running: true
    repeat: true
    onTriggered: root.refresh()
  }

  Timer {
    interval: root.subscriptionRefreshMinutes * 60 * 1000
    running: root.autoRefreshSubscriptions
    repeat: true
    onTriggered: root.updateAllProviders()
  }

  Timer {
    interval: 5000
    running: root.recoverOnNetworkChange
    repeat: true
    onTriggered: root.checkDefaultRoute()
  }

  // A shorter beat while the panel is open, so throughput reads as a live
  // figure rather than a 15-second average.
  Timer {
    interval: 2000
    running: root.opened
    repeat: true
    onTriggered: root.refresh()
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.barText
    foreground: root.barColor
    fixedWidth: (root.bar && root.bar.vertical) || root.barLabelMode !== "icon" ? -1 : Style.space(27)
    fixedHeight: root.bar && root.bar.vertical ? Style.space(26) : -1
    tooltipText: Clash.barTooltip(root.state)
    onPressed: function(b) { root.triggerPress(b) }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(440))
    contentHeight: panel.fittedContentHeight(contentColumn.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // Without this the catcher eats j/k/h/l/x before the filter field ever
      // sees them, and the search box cannot type half the alphabet.
      blocked: filterField.activeFocus
      onCloseRequested: root.close()
      onMoveRequested: function(dx, dy) { if (dy !== 0) root.moveCursor(dy) }
      onActivateRequested: root.activateCursor()
      onTextKey: function(t) {
        if (t === "r" || t === "R") root.refresh()
        else if (t === "t" || t === "T") root.testAll()
        else if (t === "s" || t === "S") root.cycleSort()
        else if (t === "b" || t === "B") root.toggleConnection()
        else if (t === "/") filterField.forceActiveFocus()
      }

      ColumnLayout {
        id: contentColumn
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(9)

        // ── Header ──
        RowLayout {
          Layout.fillWidth: true
          spacing: 8

          Text {
            text: root.barGlyph + "  Clash Verge"
            color: root.fg
            font.family: root.fontFamily
            font.pixelSize: Style.font.title
            font.bold: true
            Layout.fillWidth: true
            Layout.alignment: Qt.AlignVCenter
            elide: Text.ElideRight
          }

          Button {
            text: root.testing ? "Testing…" : "Test all"
            enabled: root.reachable && root.resolved !== null && !root.testing
            opacity: enabled ? 1 : 0.5
            foreground: root.fg
            tooltipText: "Probe every node in this group (t)"
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            horizontalPadding: Style.spacing.controlPaddingX
            verticalPadding: Style.spacing.controlPaddingY
            onClicked: root.testAll()
          }

          Button {
            text: "Refresh"
            foreground: root.fg
            tooltipText: "Refresh status (r)"
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
              text: root.barGlyph
              color: root.connected ? root.okColor : (root.reachable ? "#6b7280" : root.badColor)
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
                Layout.preferredWidth: Style.space(66)
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

          Repeater {
            model: root.networkRows
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
                Layout.preferredWidth: Style.space(66)
              }
              Text {
                text: modelData.value
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                elide: Text.ElideRight
                Layout.fillWidth: true
              }
            }
          }

          Text {
            visible: root.visibleError !== ""
            text: root.visibleError
            color: root.badColor
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
              foreground: root.connected ? root.badColor : root.okColor
              tooltipText: "Toggle whether Clash routes anything at all (b)"
              fontFamily: root.fontFamily
              fontSize: Style.font.caption
              horizontalPadding: Style.space(8)
              verticalPadding: Style.space(3)
              onClicked: root.toggleConnection()
            }
          }
        }

        PanelSeparator { Layout.fillWidth: true; foreground: root.fg; visible: root.reachable }

        // ── Group picker ──
        // v1.0.0 could only ever drive the one group named in settings. A real
        // config has a dozen — this machine's has fifteen — and which one you
        // want to steer changes with what you are doing.
        Dropdown {
          visible: root.groupChoices.length > 1
          Layout.fillWidth: true
          label: "Group"
          value: root.activeGroupName
          options: root.groupChoices
          fontFamily: root.fontFamily
          onChanged: function(v) { root.selectGroup(v) }
        }

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

        // ── Subscriptions ──
        RowLayout {
          visible: root.subscriptions.length > 0
          Layout.fillWidth: true
          spacing: Style.space(6)
          Text {
            text: "Subscriptions (" + root.subscriptions.length + ")"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            Layout.fillWidth: true
          }
          Button {
            text: "Refresh all"
            foreground: root.dim
            tooltipText: root.autoRefreshSubscriptions
              ? "Update all HTTP subscriptions now · automatic every " + root.subscriptionRefreshMinutes + "m"
              : "Update all HTTP subscriptions now"
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            horizontalPadding: Style.space(6)
            verticalPadding: Style.space(1)
            onClicked: root.updateAllProviders()
          }
        }

        Repeater {
          model: root.subscriptions
          delegate: ColumnLayout {
            required property var modelData
            Layout.fillWidth: true
            spacing: Style.space(2)

            RowLayout {
              Layout.fillWidth: true
              spacing: Style.space(6)
              Text {
                text: modelData.label
                color: root.fg
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                elide: Text.ElideRight
                Layout.fillWidth: true
              }
              Text {
                text: modelData.quotaText
                  + (modelData.expiry !== "" ? " · " + modelData.expiry : "")
                color: modelData.forecastRisk || modelData.ratio > 0.9 ? root.warnColor : root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              Button {
                visible: modelData.updatable
                text: "Update"
                foreground: root.dim
                tooltipText: "Re-fetch this subscription" + (modelData.updated !== "" ? " (last: " + modelData.updated + ")" : "")
                fontFamily: root.fontFamily
                fontSize: Style.font.caption
                horizontalPadding: Style.space(6)
                verticalPadding: Style.space(1)
                onClicked: root.updateProvider(modelData.key)
              }
            }

            Text {
              visible: modelData.updated !== "" || modelData.forecast !== ""
              text: (modelData.forecast !== "" ? modelData.forecast : "")
                + (modelData.forecastConfidence !== "" ? " · " + modelData.forecastConfidence + " confidence" : "")
                + (modelData.updated !== "" ? " · updated " + modelData.updated : "")
              color: modelData.forecastRisk ? root.warnColor : root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
              Layout.fillWidth: true
            }

            Rectangle {
              visible: modelData.hasQuota
              Layout.fillWidth: true
              implicitHeight: Style.space(3)
              radius: height / 2
              color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.1)
              Rectangle {
                width: parent.width * modelData.ratio
                height: parent.height
                radius: parent.radius
                color: modelData.ratio > 0.9 ? root.warnColor : root.okColor
              }
            }
          }
        }

        // ── Filter + sort ──
        RowLayout {
          visible: root.reachable && root.resolved !== null
          Layout.fillWidth: true
          spacing: Style.space(6)

          TextField {
            id: filterField
            Layout.fillWidth: true
            placeholderText: "Filter nodes — press / to search"
            font.family: root.fontFamily
            // No `text: root.filter` binding — see onOpenedChanged's comment.
            // This is the one place root.filter is written from the field;
            // everywhere else that wants it empty sets filterField.text
            // directly.
            onTextChanged: { root.filter = text; root.cursorIndex = -1 }
          }

          ButtonGroup {
            value: root.sortMode
            options: [
              { value: "config", label: "#", tooltip: "Config order" },
              { value: "latency", label: "ms", tooltip: "Fastest first" },
              { value: "name", label: "az", tooltip: "By name" }
            ]
            foreground: root.fg
            fontFamily: root.fontFamily
            fontSize: Style.font.caption
            onChanged: function(v) { root.sortMode = v }
          }
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
          implicitHeight: Math.min(targetColumn.implicitHeight, Style.space(380))
          contentHeight: targetColumn.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds

          function revealRow(itemY, itemH) {
            if (itemY < contentY) contentY = itemY
            else if (itemY + itemH > contentY + height) contentY = Math.max(0, itemY + itemH - height)
          }

          ColumnLayout {
            id: targetColumn
            width: targetList.width
            spacing: Style.space(4)

            Repeater {
              model: root.targets

              delegate: BorderSurface {
                id: rowSurface
                required property var modelData
                required property int index
                Layout.fillWidth: true
                readonly property bool isCurrent: modelData.key === root.currentKey
                readonly property bool isCursor: index === root.cursorIndex
                readonly property bool isDead: modelData.showDead === true
                color: isCurrent ? Qt.rgba(0.13, 0.77, 0.37, 0.1)
                     : (isCursor ? Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.12)
                                 : Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.055))
                borderSpec: Border.flat(isCurrent ? Qt.rgba(0.13, 0.77, 0.37, 0.3)
                                      : (isCursor ? Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.35)
                                                  : Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.05)), 1)
                radius: Style.cornerRadius
                padding: Style.space(7)
                opacity: isDead ? 0.45 : 1
                implicitHeight: rowBody.implicitHeight + contentTopInset + contentBottomInset

                // Keeps the keyboard cursor on screen without the panel having
                // to know how tall a row is — each row knows its own y.
                onIsCursorChanged: if (isCursor) targetList.revealRow(y, height)

                MouseArea {
                  anchors.fill: parent
                  cursorShape: Qt.PointingHandCursor
                  acceptedButtons: Qt.LeftButton | Qt.RightButton
                  enabled: root._pendingKey === "" && !selectProc.running
                  onClicked: function(mouse) {
                    if (mouse.button === Qt.RightButton) {
                      if (!rowSurface.modelData.isAuto) root.testNode(rowSurface.modelData.key)
                    } else {
                      root.connectTo(rowSurface.modelData)
                    }
                  }

                  RowLayout {
                    id: rowBody
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.margins: parent.parent.contentTopInset
                    spacing: Style.space(6)

                    Text {
                      text: rowSurface.isCurrent ? "●" : rowSurface.modelData.glyph
                      color: rowSurface.isCurrent ? root.okColor : root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.body
                      Layout.alignment: Qt.AlignVCenter
                    }

                    Text {
                      text: rowSurface.modelData.label
                      color: root.fg
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.body
                      font.bold: rowSurface.isCurrent
                      elide: Text.ElideRight
                      Layout.fillWidth: true
                      Layout.alignment: Qt.AlignVCenter
                    }

                    Text {
                      visible: rowSurface.modelData.detail !== ""
                      text: rowSurface.modelData.detail
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      Layout.alignment: Qt.AlignVCenter
                    }

                    // mihomo has already probed most of these; v1.0.0 fetched
                    // the numbers along with everything else and dropped them
                    // on the floor.
                    Text {
                      visible: rowSurface.modelData.delay > 0 || rowSurface.isDead
                      text: rowSurface.isDead ? "dead" : Shared.formatDelay(rowSurface.modelData.delay)
                      color: rowSurface.isDead ? root.badColor
                           : (rowSurface.modelData.delay < 150 ? root.okColor
                           : (rowSurface.modelData.delay < 400 ? root.warnColor : root.badColor))
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
          text: "click switches · right-click tests one · j/k move · t tests all · s sorts · b bypasses · / searches"
          color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.3)
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          horizontalAlignment: Text.AlignHCenter
          wrapMode: Text.Wrap
        }
      }
    }
  }
}
