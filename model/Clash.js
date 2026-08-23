.pragma library
.import "Shared.js" as Shared

// Clash Verge (mihomo core), talked to over its external-controller API — by
// default the local unix socket Clash Verge itself creates, so there is no TCP
// port and no secret for the user to configure. Parsing, row-building and
// command construction only; the process plumbing lives in Panel.qml.
//
// Design note for anyone porting this to a different proxy manager: Clash
// Verge is not a tunnel. It is a local SOCKS/HTTP proxy that individual apps
// opt into (or a TUN device, if the user has that on) — it does not exclude a
// real VPN the way Proton/Mullvad/Windscribe do, and "connected" here means
// "the proxy is actively routing traffic" (mode != direct), not "a tunnel is
// up". Treating this as mutually exclusive with an actual VPN backend (as
// jkoestinger/omarchy-vpn's controller would, if this were wired in as one of
// its backends) would be the wrong model — which is why this ships as its own
// small widget instead of a fifth backend bolted onto that project's
// VpnController. The bar-button/hero/target-list/filter shape below is
// deliberately the same interaction pattern, because it is a good one.

var SOCK_PATH = "/tmp/verge/verge-mihomo.sock"
var SEP = "---CLASH-SEP---"
var TEST_URL = "http://www.gstatic.com/generate_204"

// The "pick automatically again" row shown for URLTest/Fallback/LoadBalance
// groups. Sentinel rather than a real proxy name; nothing in a Clash config
// is called this.
var AUTO_KEY = "@@clash-verge-auto@@"

// ── Batch layout ────────────────────────────────────────────────────────────
// One bash process issues every request of a poll so the answers all describe
// the same instant, and writes them separated by SEP in this fixed order.
// Slots the current poll depth does not need are written empty rather than
// renumbered, so the parsing side never has to know which depth produced the
// output it is reading.
var SLOT_CONFIGS = 0
var SLOT_GROUP = 1
var SLOT_GLOBAL = 2
var SLOT_PROXIES = 3
var SLOT_CONNECTIONS = 4
var SLOT_RC = 5
var SLOT_COUNT = 6

function splitBatches(raw) {
  var text = String(raw || "")
  return text.split(SEP)
}

function batchSlot(parts, index) {
  if (!parts || index < 0 || index >= parts.length) return ""
  return String(parts[index] || "")
}

function tryParseJson(text) {
  var trimmed = String(text || "").trim()
  if (trimmed === "") return null
  try {
    return JSON.parse(trimmed)
  } catch (e) {
    return null
  }
}

// ── Endpoint configuration ──────────────────────────────────────────────────
// v1.0.0 hardcoded the unix socket. It is still the default and still needs no
// setup, but a user running the mihomo core directly (or with Verge's TCP
// external-controller turned on) now has a way in — which also means the
// socket path, URL and secret are user input that reaches a shell command, so
// everything below is quoted through Shared.shq() and the URL is validated
// before it is used at all.
//
// Deliberately narrower than RFC 3986 allows. Everything this reaches is
// single-quoted by Shared.shq() before it touches a shell, so the sub-delims
// are already inert — but a controller URL has no legitimate need for $, (,
// ;, & or a backtick, and rejecting them outright means the quoting is a
// second line of defence rather than the only one.
var URL_PATTERN = /^https?:\/\/[A-Za-z0-9._~:\/\[\]@%-]+$/

function normalizeControllerUrl(raw) {
  var text = String(raw === undefined || raw === null ? "" : raw).trim()
  if (text === "") return ""
  if (text.indexOf("://") < 0) text = "http://" + text
  if (!URL_PATTERN.test(text)) return ""
  return text.replace(/\/+$/, "")
}

function apiConfig(socketPath, controllerUrl, secret) {
  var url = normalizeControllerUrl(controllerUrl)
  var path = String(socketPath === undefined || socketPath === null ? "" : socketPath).trim()
  if (url !== "") return { mode: "http", socketPath: "", baseUrl: url, secret: String(secret || "") }
  return { mode: "socket", socketPath: path !== "" ? path : SOCK_PATH, baseUrl: "http://localhost", secret: String(secret || "") }
}

// curl arguments as an argv array, for the one-request Processes.
function curlArgs(cfg) {
  var args = []
  if (cfg.mode === "socket") args = args.concat(["--unix-socket", cfg.socketPath])
  if (cfg.secret !== "") args = args.concat(["-H", "Authorization: Bearer " + cfg.secret])
  return args
}

// The same arguments as one shell-quoted string, for the batched poll.
function curlArgsShell(cfg) {
  var parts = []
  if (cfg.mode === "socket") parts.push("--unix-socket " + Shared.shq(cfg.socketPath))
  if (cfg.secret !== "") parts.push("-H " + Shared.shq("Authorization: Bearer " + cfg.secret))
  return parts.join(" ")
}

function apiUrl(cfg, path) {
  return cfg.baseUrl + path
}

// Builds the whole poll. `deep` adds the full proxy dump (~74 KB on a
// 95-proxy config) which is only worth fetching while the panel is open;
// `withTraffic` adds /connections, needed when the bar is showing throughput
// or the panel is open. The closed-panel poll is ~3.5 KB.
function buildStatusCommand(cfg, groupName, deep, withTraffic) {
  var flags = curlArgsShell(cfg)
  var base = cfg.baseUrl
  function get(path) {
    return "curl -s --max-time 4 " + flags + " " + Shared.shq(base + path)
  }
  var sep = "printf '\\n%s\\n' " + Shared.shq(SEP) + "; "
  var script = get("/configs") + "; RC=$?; " + sep
  script += get("/proxies/" + encodeURIComponent(groupName)) + "; " + sep
  script += (groupName === "GLOBAL" ? "true" : get("/proxies/GLOBAL")) + "; " + sep
  script += (deep ? get("/proxies") : "true") + "; " + sep
  script += (withTraffic ? get("/connections") : "true") + "; " + sep
  script += "printf 'rc:%s\\n' \"$RC\""
  return ["bash", "-c", script]
}

// curl's own exit code for the first request of the batch, which is the one
// that decides whether the daemon is there at all. v1.0.0 threw this away and
// reported every failure as "Clash Verge isn't running", including the cases
// where it plainly is.
function parseExitCode(raw) {
  var match = /rc:(\d+)/.exec(String(raw || ""))
  return match ? parseInt(match[1], 10) : -1
}

function describeCurlError(code, cfg) {
  var where = cfg && cfg.mode === "http" ? cfg.baseUrl : (cfg ? cfg.socketPath : SOCK_PATH)
  switch (code) {
    case 0: return ""
    case 7: return "Can't reach Clash Verge at " + where
    case 28: return "Clash Verge timed out — the core may be busy or wedged"
    case 22: return "Clash Verge rejected the request (check the API secret)"
    case 2:
    case 3: return "Bad API endpoint setting: " + where
    default: return "curl failed (exit " + code + ") talking to " + where
  }
}

// ── Payload parsing ─────────────────────────────────────────────────────────

// `mode` is the one setting that decides whether Clash is doing anything:
// "rule" and "global" both route traffic, "direct" bypasses the proxy
// entirely, which is this widget's idea of "disconnected". `tun.enable` rides
// along in the same document — it is the single biggest routing switch on the
// machine and v1.0.0 did not surface it at all.
function parseClashConfigs(raw) {
  var payload = tryParseJson(raw)
  if (!payload || typeof payload !== "object") return { loaded: false, mode: "", tun: false }
  var mode = String(payload.mode || "").toLowerCase()
  if (mode !== "rule" && mode !== "global" && mode !== "direct") return { loaded: false, mode: "", tun: false }
  var tun = payload.tun && typeof payload.tun === "object" ? payload.tun.enable === true : false
  return { loaded: true, mode: mode, tun: tun }
}

var GROUP_TYPES = ["Selector", "URLTest", "Fallback", "LoadBalance"]
var AUTO_TYPES = ["URLTest", "Fallback", "LoadBalance"]

function isGroupType(type) {
  return GROUP_TYPES.indexOf(String(type || "")) !== -1
}

// URLTest / Fallback / LoadBalance groups choose their own member. A PUT to
// one does not "select" anything — mihomo records it as a `fixed` pin that
// overrides the automatic choice until a DELETE clears it. v1.0.0 issued that
// PUT and called it a node switch, which meant pointing the widget at an auto
// group gave you a list that silently and permanently pinned whatever you
// clicked, with no way back from the bar.
function isAutoGroupType(type) {
  return AUTO_TYPES.indexOf(String(type || "")) !== -1
}

function lastDelay(entry) {
  if (!entry || !Array.isArray(entry.history) || entry.history.length === 0) return 0
  var last = entry.history[entry.history.length - 1]
  var value = last && typeof last === "object" ? Number(last.delay) : 0
  return isFinite(value) && value > 0 ? value : 0
}

function normalizeNode(name, entry) {
  var type = String(entry.type || "")
  return {
    name: String(name),
    type: type,
    isGroup: isGroupType(type),
    isAuto: isAutoGroupType(type),
    alive: entry.alive !== false,
    delay: lastDelay(entry),
    now: String(entry.now || ""),
    fixed: String(entry.fixed || ""),
    members: Array.isArray(entry.all) ? entry.all.map(String) : [],
    hidden: entry.hidden === true
  }
}

// The full /proxies dump. v1.0.0 reduced this to name -> type and discarded
// the rest; every node in it also carries `alive` and a `history` of delay
// probes mihomo has already run, which is where the latency shown per row now
// comes from — no extra request, no extra probe.
function parseProxies(raw) {
  var payload = tryParseJson(raw)
  var out = { loaded: false, nodes: {}, groups: [] }
  if (!payload || typeof payload !== "object" || !payload.proxies || typeof payload.proxies !== "object") return out
  out.loaded = true
  for (var name in payload.proxies) {
    var entry = payload.proxies[name]
    if (!entry || typeof entry !== "object") continue
    var node = normalizeNode(name, entry)
    out.nodes[name] = node
    if (node.isGroup && !node.hidden && node.members.length > 0) out.groups.push(name)
  }
  return out
}

// A single group response: { now, all, type, fixed }. Returns null for
// anything that is not group-shaped — including the 404 body mihomo sends for
// a group name that does not exist, which parses as JSON but has none of
// these fields.
function parseSelectorGroup(raw) {
  var payload = tryParseJson(raw)
  if (!payload || typeof payload !== "object") return null
  if (!Array.isArray(payload.all)) return null
  return {
    now: String(payload.now || ""),
    all: payload.all.map(String),
    type: String(payload.type || "Selector"),
    fixed: String(payload.fixed || "")
  }
}

// Prefers the requested group, falls back to GLOBAL if that name is not a
// group on this config — matching the same two-step lookup
// ~/.config/omarchy/bar/scripts/clash-geo-status.sh already uses.
function resolveSelector(configuredRaw, globalRaw, configuredName) {
  var configured = parseSelectorGroup(configuredRaw)
  if (configured) return { groupName: configuredName, group: configured }
  var fallback = parseSelectorGroup(globalRaw)
  if (fallback) return { groupName: "GLOBAL", group: fallback }
  return null
}

// Every group the user can point the widget at, in the order the picker
// should list them: whichever one is active first, then the config's own
// order, with GLOBAL last because it is the fallback rather than a choice
// anyone's config was written around.
function selectableGroups(proxies, activeName) {
  var names = (proxies && proxies.groups) ? proxies.groups.slice() : []
  var active = String(activeName || "")
  var head = []
  var body = []
  var tail = []
  for (var i = 0; i < names.length; i++) {
    if (names[i] === active) head.push(names[i])
    else if (names[i] === "GLOBAL") tail.push(names[i])
    else body.push(names[i])
  }
  var ordered = head.concat(body, tail)
  var out = []
  for (var j = 0; j < ordered.length; j++) {
    var node = proxies.nodes[ordered[j]]
    out.push({
      value: ordered[j],
      label: ordered[j],
      type: node ? node.type : "",
      count: node ? node.members.length : 0
    })
  }
  return out
}

// /connections, read once per poll rather than held open as an SSE stream:
// the totals are monotonic counters, so two samples are all a throughput
// figure needs, and a one-shot request costs nothing to restart if the core
// is bounced underneath us.
function parseConnections(raw) {
  var payload = tryParseJson(raw)
  if (!payload || typeof payload !== "object") return { loaded: false, up: 0, down: 0, count: 0, memory: 0 }
  var conns = Array.isArray(payload.connections) ? payload.connections.length : 0
  return {
    loaded: true,
    up: Number(payload.uploadTotal || 0),
    down: Number(payload.downloadTotal || 0),
    count: conns,
    memory: Number(payload.memory || 0)
  }
}

// Rates from two samples of those counters. A counter that went backwards
// means the core restarted, which is a gap in the series, not a negative
// transfer — report nothing rather than a bogus spike.
function computeRates(previous, current) {
  var none = { upRate: 0, downRate: 0, known: false }
  if (!previous || !current || !previous.loaded || !current.loaded) return none
  var seconds = (Number(current.at) - Number(previous.at)) / 1000
  if (!isFinite(seconds) || seconds <= 0.2) return none
  if (current.up < previous.up || current.down < previous.down) return none
  return {
    upRate: (current.up - previous.up) / seconds,
    downRate: (current.down - previous.down) / seconds,
    known: true
  }
}

// /providers/proxies is ~295 KB on this config because it inlines every proxy
// of every provider, so it is fetched on demand and throttled rather than
// polled. What is worth having out of it is the subscription counter most
// paid configs carry and nothing else in the API exposes.
function parseProviders(raw) {
  var payload = tryParseJson(raw)
  var out = []
  if (!payload || typeof payload !== "object" || !payload.providers) return out
  for (var name in payload.providers) {
    var entry = payload.providers[name]
    if (!entry || typeof entry !== "object") continue
    var info = entry.subscriptionInfo
    if (!info || typeof info !== "object") continue
    var total = Number(info.Total || 0)
    if (!isFinite(total) || total <= 0) continue
    var upload = Number(info.Upload || 0)
    var download = Number(info.Download || 0)
    out.push({
      name: String(name),
      vehicleType: String(entry.vehicleType || ""),
      updatedAt: Shared.parseTime(entry.updatedAt),
      upload: upload,
      download: download,
      used: upload + download,
      total: total,
      expire: Shared.parseTime(Number(info.Expire || 0)),
      ratio: Math.max(0, Math.min(1, (upload + download) / total))
    })
  }
  out.sort(function(a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0) })
  return out
}

function subscriptionRows(providers, nowMillis) {
  var out = []
  for (var i = 0; i < (providers || []).length; i++) {
    var p = providers[i]
    out.push({
      key: p.name,
      label: p.name,
      used: Shared.formatBytes(p.used),
      total: Shared.formatBytes(p.total),
      ratio: p.ratio,
      expiry: Shared.formatUntil(p.expire, nowMillis),
      updated: Shared.formatSince(p.updatedAt, nowMillis),
      updatable: p.vehicleType === "HTTP"
    })
  }
  return out
}

// GET /group/<name>/delay probes every member in one request and answers with
// a flat name -> milliseconds map; members that failed are simply absent from
// it. An error instead comes back as { message: "..." }.
function parseDelayMap(raw) {
  var payload = tryParseJson(raw)
  if (!payload || typeof payload !== "object") return { ok: false, delays: {}, error: "No answer from Clash Verge" }
  if (typeof payload.message === "string" && payload.message !== "") return { ok: false, delays: {}, error: payload.message }
  var delays = {}
  for (var name in payload) {
    var value = Number(payload[name])
    if (isFinite(value) && value > 0) delays[name] = value
  }
  return { ok: true, delays: delays, error: "" }
}

// GET /proxies/<name>/delay answers { delay: n } or, on a 504, { message: … }.
function parseSingleDelay(raw) {
  var payload = tryParseJson(raw)
  if (!payload || typeof payload !== "object") return { ok: false, delay: 0, error: "No answer from Clash Verge" }
  if (typeof payload.message === "string" && payload.message !== "") return { ok: false, delay: 0, error: payload.message }
  var value = Number(payload.delay)
  if (!isFinite(value) || value <= 0) return { ok: false, delay: 0, error: "No route" }
  return { ok: true, delay: value, error: "" }
}

// Folds fresh probe results back over the cached dump so the list updates the
// instant a test finishes instead of at the next poll. Members the probe did
// not answer for are the ones that failed, so they are marked dead rather than
// left showing whatever they measured last time.
function mergeDelays(nodes, delays, probed) {
  var out = {}
  for (var name in nodes) {
    var node = nodes[name]
    var copy = {}
    for (var key in node) copy[key] = node[key]
    if (delays && Object.prototype.hasOwnProperty.call(delays, name)) {
      copy.delay = delays[name]
      copy.alive = true
    } else if (probed && probed.indexOf(name) !== -1) {
      copy.delay = 0
      copy.alive = false
    }
    out[name] = copy
  }
  return out
}

// ── View model ──────────────────────────────────────────────────────────────
// `state` is the whole widget in one object:
//   reachable, mode, tun, groupName, group {now, all, type, fixed},
//   nodes {}, net {}, rates {}, providers []

function activeNodeName(state) {
  if (!state.group) return ""
  if (isAutoGroupType(state.group.type)) return state.group.fixed !== "" ? state.group.fixed : state.group.now
  return state.group.now
}

function isPinned(state) {
  return !!state.group && isAutoGroupType(state.group.type) && state.group.fixed !== ""
}

function clashSummary(state) {
  if (!state.reachable) return "Clash Verge is not running"
  if (!state.group) return "No proxy group found"
  if (state.mode === "direct") return "Bypassed — traffic is not proxied"
  var node = activeNodeName(state) || "no node selected"
  var suffix = []
  if (state.mode === "global") suffix.push("global")
  if (state.tun) suffix.push("TUN")
  return node + (suffix.length ? " · " + suffix.join(" · ") : "")
}

function clashDetails(state) {
  if (!state.reachable || !state.group || state.mode === "direct") return []
  var name = activeNodeName(state)
  var node = (state.nodes || {})[name]
  var rows = [Shared.detail("Node", name)]
  if (node && node.type) rows.push(Shared.detail("Type", node.type))
  if (node && node.delay > 0) rows.push(Shared.detail("Latency", Shared.formatDelay(node.delay)))
  rows.push(Shared.detail("Mode", state.mode === "global" ? "Global (every request)" : "Rule-based"))
  var group = state.groupName || ""
  if (state.group.type && state.group.type !== "Selector") {
    group += " (" + state.group.type + (isPinned(state) ? ", pinned" : ", auto") + ")"
  }
  rows.push(Shared.detail("Group", group))
  return rows.filter(function(row) { return row.value !== "" })
}

// Throughput and session totals, kept apart from the hero details so the hero
// stays the same height whether or not /connections was part of this poll.
function clashNetworkRows(state) {
  var net = state.net || {}
  if (!net.loaded) return []
  var rates = state.rates || {}
  var rows = []
  if (rates.known) {
    rows.push(Shared.detail("Speed", Shared.GLYPH_DOWN + " " + Shared.formatRate(rates.downRate)
      + "   " + Shared.GLYPH_UP + " " + Shared.formatRate(rates.upRate)))
  }
  rows.push(Shared.detail("Session", Shared.GLYPH_DOWN + " " + Shared.formatBytes(net.down)
    + "   " + Shared.GLYPH_UP + " " + Shared.formatBytes(net.up)))
  rows.push(Shared.detail("Open", String(net.count) + (net.count === 1 ? " connection" : " connections")))
  if (net.memory > 0) rows.push(Shared.detail("Memory", Shared.formatBytes(net.memory)))
  return rows
}

// Rank for latency sorting: measured-and-alive, then alive-but-unmeasured,
// then dead. Sorting purely on the number would float every never-probed node
// to the top on a delay of 0, which reads as "instant" and means "unknown".
function latencyRank(node) {
  if (!node) return 1
  if (!node.alive) return 2
  return node.delay > 0 ? 0 : 1
}

var SORT_MODES = ["config", "latency", "name"]

// DIRECT and the plumbing groups (auto-test/load-balance groups still show —
// picking one of those is a legitimate choice, same as Mullvad's country list
// including places with only one relay) are kept; nothing is filtered out
// beyond the text search, since a member the user's own config put in the
// group is the user's call to skip, not this widget's.
function clashTargets(state, filter, sortMode) {
  if (!state.reachable || !state.group) return []
  var needle = String(filter || "").trim().toLowerCase()
  var nodes = state.nodes || {}
  var members = state.group.all
  var current = activeNodeName(state)
  var rows = []

  for (var i = 0; i < members.length; i++) {
    var name = members[i]
    if (needle !== "" && name.toLowerCase().indexOf(needle) < 0) continue
    var node = nodes[name]
    var type = node ? node.type : ""
    var isGroup = node ? node.isGroup : false
    var alive = node ? node.alive : true
    var isCurrent = name === current
    rows.push({
      key: name,
      label: name,
      detail: isGroup ? type + " group" : type,
      glyph: isGroup ? Shared.GLYPH_SWAP : Shared.GLYPH_VPN,
      delay: node ? node.delay : 0,
      alive: alive,
      // mihomo's `alive` is the verdict of its last health probe, which fails
      // transiently — a probe URL blocked for a moment, a handshake that timed
      // out — while the node keeps carrying traffic perfectly well. Marking the
      // node your packets are currently going through as "dead" is the one case
      // where that flag is more alarming than informative, so the row that is
      // demonstrably working is never struck out.
      showDead: alive === false && !isCurrent,
      isGroup: isGroup,
      isAuto: false,
      current: isCurrent,
      order: i
    })
  }

  var mode = SORT_MODES.indexOf(String(sortMode || "")) !== -1 ? sortMode : "config"
  if (mode === "latency") {
    rows.sort(function(a, b) {
      var ra = latencyRank(nodes[a.key])
      var rb = latencyRank(nodes[b.key])
      if (ra !== rb) return ra - rb
      if (ra === 0 && a.delay !== b.delay) return a.delay - b.delay
      return a.order - b.order
    })
  } else if (mode === "name") {
    rows.sort(function(a, b) { return a.label.localeCompare(b.label) })
  }

  // Auto groups get a way back out of a pin, always at the top and never
  // sorted away. Without it, a single click on a URLTest group is a one-way
  // door from inside the widget.
  if (isAutoGroupType(state.group.type)) {
    var pinned = state.group.fixed !== ""
    rows.unshift({
      key: AUTO_KEY,
      label: "Automatic",
      detail: pinned ? "unpin — " + state.group.type + " picks again" : state.group.type + " is choosing",
      glyph: Shared.GLYPH_AUTO,
      delay: 0,
      alive: true,
      showDead: false,
      isGroup: false,
      isAuto: true,
      current: !pinned,
      order: -1
    })
  }
  return rows
}

function clashCurrentKey(state) {
  if (!state.reachable || !state.group || state.mode === "direct") return ""
  if (isAutoGroupType(state.group.type) && state.group.fixed === "") return AUTO_KEY
  return activeNodeName(state)
}

// Two switches: global vs rule-based, and the TUN device. Direct is reachable
// only via disconnect()/toggleConnection() — it is "off", not a third position
// on the mode switch, so it is left out of the drawer rather than modeled as a
// tri-state control nothing else in this widget supports.
function clashToggles(state) {
  if (!state.reachable || state.mode === "") return []
  return [
    Shared.toggle("global", "Global mode",
      "Route every request through the proxy, ignoring rules", state.mode === "global"),
    Shared.toggle("tun", "TUN mode",
      "Capture all system traffic at the interface, not just apps that opt in", state.tun === true)
  ]
}

// ── Bar presentation ────────────────────────────────────────────────────────

var BAR_LABEL_MODES = ["icon", "node", "speed"]

function barState(state) {
  if (!state.reachable) return "down"
  if (state.mode === "direct" || state.mode === "") return "direct"
  return state.mode === "global" ? "global" : "rule"
}

function barGlyph(state) {
  var s = barState(state)
  if (s === "down") return Shared.GLYPH_SHIELD_OFF
  if (s === "direct") return Shared.GLYPH_SWAP
  return Shared.GLYPH_SHIELD
}

// v1.0.0's bar was a fixed glyph, identical whether Clash was routing every
// packet through Tokyo or not running at all. The label is opt-in because a
// node name is wide and a bar is not.
function barLabel(state, mode) {
  if (BAR_LABEL_MODES.indexOf(String(mode || "")) < 0 || mode === "icon") return ""
  if (!state.reachable) return "off"
  if (mode === "speed") {
    var rates = state.rates || {}
    if (!rates.known) return ""
    return Shared.GLYPH_DOWN + Shared.formatRate(rates.downRate).replace(" ", "")
      + " " + Shared.GLYPH_UP + Shared.formatRate(rates.upRate).replace(" ", "")
  }
  if (state.mode === "direct") return "direct"
  return Shared.elide(activeNodeName(state), 16)
}

function barTooltip(state) {
  var lines = ["Clash Verge: " + clashSummary(state)]
  var net = state.net || {}
  var rates = state.rates || {}
  if (rates.known) {
    lines.push(Shared.GLYPH_DOWN + " " + Shared.formatRate(rates.downRate)
      + "   " + Shared.GLYPH_UP + " " + Shared.formatRate(rates.upRate))
  }
  if (net.loaded) lines.push(net.count + " open connections")
  return lines.join("\n")
}

if (typeof module !== "undefined") {
  module.exports = {
    SOCK_PATH: SOCK_PATH,
    SEP: SEP,
    TEST_URL: TEST_URL,
    AUTO_KEY: AUTO_KEY,
    SLOT_CONFIGS: SLOT_CONFIGS,
    SLOT_GROUP: SLOT_GROUP,
    SLOT_GLOBAL: SLOT_GLOBAL,
    SLOT_PROXIES: SLOT_PROXIES,
    SLOT_CONNECTIONS: SLOT_CONNECTIONS,
    SLOT_RC: SLOT_RC,
    SLOT_COUNT: SLOT_COUNT,
    SORT_MODES: SORT_MODES,
    BAR_LABEL_MODES: BAR_LABEL_MODES,
    splitBatches: splitBatches,
    batchSlot: batchSlot,
    tryParseJson: tryParseJson,
    normalizeControllerUrl: normalizeControllerUrl,
    apiConfig: apiConfig,
    curlArgs: curlArgs,
    curlArgsShell: curlArgsShell,
    apiUrl: apiUrl,
    buildStatusCommand: buildStatusCommand,
    parseExitCode: parseExitCode,
    describeCurlError: describeCurlError,
    parseClashConfigs: parseClashConfigs,
    isGroupType: isGroupType,
    isAutoGroupType: isAutoGroupType,
    lastDelay: lastDelay,
    parseProxies: parseProxies,
    parseSelectorGroup: parseSelectorGroup,
    resolveSelector: resolveSelector,
    selectableGroups: selectableGroups,
    parseConnections: parseConnections,
    computeRates: computeRates,
    parseProviders: parseProviders,
    subscriptionRows: subscriptionRows,
    parseDelayMap: parseDelayMap,
    parseSingleDelay: parseSingleDelay,
    mergeDelays: mergeDelays,
    activeNodeName: activeNodeName,
    isPinned: isPinned,
    latencyRank: latencyRank,
    clashSummary: clashSummary,
    clashDetails: clashDetails,
    clashNetworkRows: clashNetworkRows,
    clashTargets: clashTargets,
    clashCurrentKey: clashCurrentKey,
    clashToggles: clashToggles,
    barState: barState,
    barGlyph: barGlyph,
    barLabel: barLabel,
    barTooltip: barTooltip
  }
}
