.pragma library
.import "Shared.js" as Shared

// Clash Verge (mihomo core), talked to over its external-controller API on
// the local unix socket Clash Verge itself creates — no TCP port, no secret
// to configure, and nothing this widget has to set up. Parsing and
// row-building only; the process plumbing lives in Panel.qml.
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

// Split the batched curl output (see Panel.qml's statusProcess command) back
// into its three JSON documents, in the order they were requested:
// configs, the configured selector group, GLOBAL, the full proxy dump.
function splitBatches(raw) {
  var text = String(raw || "")
  return text.split(SEP)
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

// `mode` is the one setting that decides whether Clash is doing anything:
// "rule" and "global" both route traffic, "direct" bypasses the proxy
// entirely, which is this widget's idea of "disconnected".
function parseClashConfigs(raw) {
  var payload = tryParseJson(raw)
  if (!payload || typeof payload !== "object") return { loaded: false, mode: "" }
  var mode = String(payload.mode || "").toLowerCase()
  if (mode !== "rule" && mode !== "global" && mode !== "direct") return { loaded: false, mode: "" }
  return { loaded: true, mode: mode }
}

// A selector-group response: { now, all: [...], type: "Selector" }. Returns
// null for anything that is not a selector-shaped group — including the 404
// body mihomo sends for a group name that does not exist, which parses as
// JSON but has none of these fields.
function parseSelectorGroup(raw) {
  var payload = tryParseJson(raw)
  if (!payload || typeof payload !== "object") return null
  if (!Array.isArray(payload.all)) return null
  return { now: String(payload.now || ""), all: payload.all.map(String) }
}

// The full /proxies dump, reduced to name -> type. Used only to label rows in
// the target list ("Shadowsocks" vs "auto-select group") — the selector
// response itself does not carry each member's type.
function parseProxyTypes(raw) {
  var payload = tryParseJson(raw)
  var types = {}
  if (!payload || typeof payload !== "object" || !payload.proxies) return types
  for (var name in payload.proxies) {
    var entry = payload.proxies[name]
    if (entry && typeof entry === "object") types[name] = String(entry.type || "")
  }
  return types
}

var GROUP_TYPES = ["Selector", "URLTest", "Fallback", "LoadBalance"]

function isGroupType(type) {
  return GROUP_TYPES.indexOf(type) !== -1
}

// Prefers the configured selector (Jack's is "主代理", the default), falls
// back to GLOBAL if that name is not a selector on this config — matching the
// same two-step lookup ~/.config/omarchy/bar/scripts/clash-geo-status.sh
// already uses.
function resolveSelector(configuredRaw, globalRaw, configuredName) {
  var configured = parseSelectorGroup(configuredRaw)
  if (configured) return { groupName: configuredName, group: configured }
  var fallback = parseSelectorGroup(globalRaw)
  if (fallback) return { groupName: "GLOBAL", group: fallback }
  return null
}

function clashSummary(state) {
  if (!state.reachable) return "Clash Verge is not running"
  if (!state.selector) return "No selector group found"
  if (state.mode === "direct") return "Bypassed — traffic is not proxied"
  var node = state.selector.now || "no node selected"
  return node + (state.mode === "global" ? " · global" : "")
}

function clashDetails(state) {
  if (!state.reachable || !state.selector || state.mode === "direct") return []
  var rows = [Shared.detail("Node", state.selector.now || "")]
  var type = (state.proxyTypes || {})[state.selector.now]
  if (type) rows.push(Shared.detail("Type", type))
  rows.push(Shared.detail("Mode", state.mode === "global" ? "Global (every request)" : "Rule-based"))
  rows.push(Shared.detail("Group", state.groupName || ""))
  return rows.filter(function(row) { return row.value !== "" })
}

// DIRECT and the plumbing groups (auto-test/load-balance groups still show —
// picking one of those is a legitimate choice, same as Mullvad's country
// list including places with only one relay) are kept; nothing is filtered
// out beyond the text search, since a member the user's own config put in the
// selector is the user's call to skip, not this widget's.
function clashTargets(state, filter) {
  if (!state.reachable || !state.selector) return []
  var needle = String(filter || "").trim().toLowerCase()
  var types = state.proxyTypes || {}
  var out = []
  for (var i = 0; i < state.selector.all.length; i++) {
    var name = state.selector.all[i]
    if (needle !== "" && name.toLowerCase().indexOf(needle) < 0) continue
    var type = types[name] || ""
    out.push({
      key: name,
      label: name,
      detail: isGroupType(type) ? type + " group" : type,
      glyph: isGroupType(type) ? Shared.GLYPH_SWAP : Shared.GLYPH_VPN,
      args: [name]
    })
  }
  return out
}

function clashCurrentKey(state) {
  if (!state.reachable || !state.selector || state.mode === "direct") return ""
  return state.selector.now || ""
}

// One switch: global vs rule-based. Direct is reachable only via
// disconnect()/toggleConnection() — it is "off", not a third position on this
// particular switch, so it is left out of the drawer rather than modeled as a
// tri-state control nothing else in this widget supports.
function clashToggles(state) {
  if (!state.reachable || state.mode === "") return []
  return [Shared.toggle("global", "Global mode", "Route every request through the proxy, ignoring rules", state.mode === "global")]
}

if (typeof module !== "undefined") {
  module.exports = {
    SOCK_PATH: SOCK_PATH,
    SEP: SEP,
    splitBatches: splitBatches,
    tryParseJson: tryParseJson,
    parseClashConfigs: parseClashConfigs,
    parseSelectorGroup: parseSelectorGroup,
    parseProxyTypes: parseProxyTypes,
    isGroupType: isGroupType,
    resolveSelector: resolveSelector,
    clashSummary: clashSummary,
    clashDetails: clashDetails,
    clashTargets: clashTargets,
    clashCurrentKey: clashCurrentKey,
    clashToggles: clashToggles
  }
}
