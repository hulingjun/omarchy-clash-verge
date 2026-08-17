const { test, eq, Shared, Clash } = require("../harness.js")

test("parseClashConfigs reads a valid mode", () => {
  eq(Clash.parseClashConfigs('{"mode":"rule"}'), { loaded: true, mode: "rule" })
  eq(Clash.parseClashConfigs('{"mode":"GLOBAL"}'), { loaded: true, mode: "global" })
})

test("parseClashConfigs rejects an unreadable or unrecognized payload", () => {
  eq(Clash.parseClashConfigs("not json").loaded, false)
  eq(Clash.parseClashConfigs("").loaded, false)
  eq(Clash.parseClashConfigs('{"mode":"turbo"}').loaded, false)
  eq(Clash.parseClashConfigs("[1,2]").loaded, false)
})

test("parseSelectorGroup reads a selector's now/all", () => {
  const group = Clash.parseSelectorGroup(JSON.stringify({
    type: "Selector", now: "hk-01", all: ["hk-01", "jp-01", "DIRECT"]
  }))
  eq(group, { now: "hk-01", all: ["hk-01", "jp-01", "DIRECT"] })
})

test("parseSelectorGroup returns null for a leaf proxy or a 404 body", () => {
  // A plain proxy has no `all` array.
  eq(Clash.parseSelectorGroup('{"alive":true,"type":"Shadowsocks"}'), null)
  // mihomo's not-found body parses as JSON but names nothing.
  eq(Clash.parseSelectorGroup('{"message":"proxy not found"}'), null)
  eq(Clash.parseSelectorGroup(""), null)
  eq(Clash.parseSelectorGroup("not json"), null)
})

test("parseProxyTypes reduces the full dump to name -> type", () => {
  const types = Clash.parseProxyTypes(JSON.stringify({
    proxies: {
      "hk-01": { type: "Shadowsocks" },
      "auto": { type: "URLTest" },
      "DIRECT": { type: "Direct" }
    }
  }))
  eq(types, { "hk-01": "Shadowsocks", "auto": "URLTest", "DIRECT": "Direct" })
})

test("parseProxyTypes tolerates an unreadable dump", () => {
  eq(Clash.parseProxyTypes("not json"), {})
  eq(Clash.parseProxyTypes('{"proxies":null}'), {})
})

test("isGroupType names the four group kinds and nothing else", () => {
  eq(Clash.isGroupType("Selector"), true)
  eq(Clash.isGroupType("URLTest"), true)
  eq(Clash.isGroupType("Fallback"), true)
  eq(Clash.isGroupType("LoadBalance"), true)
  eq(Clash.isGroupType("Shadowsocks"), false)
  eq(Clash.isGroupType(""), false)
})

test("resolveSelector prefers the configured group", () => {
  const configured = JSON.stringify({ now: "hk-01", all: ["hk-01"] })
  const global_ = JSON.stringify({ now: "jp-01", all: ["jp-01"] })
  const resolved = Clash.resolveSelector(configured, global_, "主代理")
  eq(resolved.groupName, "主代理")
  eq(resolved.group.now, "hk-01")
})

test("resolveSelector falls back to GLOBAL when the configured name is not a selector", () => {
  const notFound = '{"message":"proxy not found"}'
  const global_ = JSON.stringify({ now: "jp-01", all: ["jp-01"] })
  const resolved = Clash.resolveSelector(notFound, global_, "主代理")
  eq(resolved.groupName, "GLOBAL")
  eq(resolved.group.now, "jp-01")
})

test("resolveSelector returns null when neither answered", () => {
  eq(Clash.resolveSelector("not json", "also not json", "主代理"), null)
})

test("clashSummary reports direct mode as bypassed", () => {
  eq(Clash.clashSummary({ reachable: true, selector: { now: "hk-01", all: [] }, mode: "direct" }),
    "Bypassed — traffic is not proxied")
})

test("clashSummary names the node, and flags global mode", () => {
  eq(Clash.clashSummary({ reachable: true, selector: { now: "hk-01", all: [] }, mode: "rule" }), "hk-01")
  eq(Clash.clashSummary({ reachable: true, selector: { now: "hk-01", all: [] }, mode: "global" }), "hk-01 · global")
})

test("clashSummary covers unreachable and no-selector states", () => {
  eq(Clash.clashSummary({ reachable: false }), "Clash Verge is not running")
  eq(Clash.clashSummary({ reachable: true, selector: null }), "No selector group found")
})

test("clashDetails is empty while bypassed or unreachable", () => {
  eq(Clash.clashDetails({ reachable: false }), [])
  eq(Clash.clashDetails({ reachable: true, selector: { now: "hk-01", all: [] }, mode: "direct" }), [])
})

test("clashDetails names the node, type, mode and group", () => {
  const rows = Clash.clashDetails({
    reachable: true,
    selector: { now: "hk-01", all: [] },
    mode: "rule",
    groupName: "主代理",
    proxyTypes: { "hk-01": "Shadowsocks" }
  })
  eq(rows, [
    Shared.detail("Node", "hk-01"),
    Shared.detail("Type", "Shadowsocks"),
    Shared.detail("Mode", "Rule-based"),
    Shared.detail("Group", "主代理")
  ])
})

test("clashTargets builds rows from the selector's all list, filtered by name", () => {
  const state = {
    reachable: true,
    selector: { now: "hk-01", all: ["hk-01", "jp-auto", "DIRECT"] },
    proxyTypes: { "hk-01": "Shadowsocks", "jp-auto": "URLTest", "DIRECT": "Direct" }
  }
  const all = Clash.clashTargets(state, "")
  eq(all.length, 3)
  eq(all[0], { key: "hk-01", label: "hk-01", detail: "Shadowsocks", glyph: Shared.GLYPH_VPN, args: ["hk-01"] })
  eq(all[1].detail, "URLTest group")
  eq(all[1].glyph, Shared.GLYPH_SWAP)

  const filtered = Clash.clashTargets(state, "jp")
  eq(filtered.map(t => t.key), ["jp-auto"])
})

test("clashTargets is empty while unreachable or without a selector", () => {
  eq(Clash.clashTargets({ reachable: false }, ""), [])
  eq(Clash.clashTargets({ reachable: true, selector: null }, ""), [])
})

test("clashCurrentKey follows the selector's now, empty while bypassed", () => {
  const state = { reachable: true, selector: { now: "hk-01", all: [] }, mode: "rule" }
  eq(Clash.clashCurrentKey(state), "hk-01")
  eq(Clash.clashCurrentKey(Object.assign({}, state, { mode: "direct" })), "")
  eq(Clash.clashCurrentKey({ reachable: false }), "")
})

test("clashToggles offers one switch, reflecting global mode", () => {
  eq(Clash.clashToggles({ reachable: true, mode: "rule" }),
    [Shared.toggle("global", "Global mode", "Route every request through the proxy, ignoring rules", false)])
  eq(Clash.clashToggles({ reachable: true, mode: "global" })[0].value, true)
  eq(Clash.clashToggles({ reachable: false, mode: "" }), [])
})

test("splitBatches divides the curl-batch output on the separator", () => {
  const raw = '{"a":1}\n' + Clash.SEP + '\n{"b":2}\n' + Clash.SEP + '\n{"c":3}'
  const parts = Clash.splitBatches(raw)
  eq(parts.length, 3)
  eq(Clash.tryParseJson(parts[0]), { a: 1 })
  eq(Clash.tryParseJson(parts[1]), { b: 2 })
  eq(Clash.tryParseJson(parts[2]), { c: 3 })
})
