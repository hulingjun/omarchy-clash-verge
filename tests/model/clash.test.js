// Every pure function in model/. The QML engine is not involved: the harness
// loads the .pragma library files the way it would, so what is exercised here
// is the same source Panel.qml imports.

const { test, eq, Clash, Shared } = require("../harness.js")

const assert = require("assert")
const ok = assert.ok

// ── Fixtures ────────────────────────────────────────────────────────────────
// Names are CJK on purpose: that is what real Clash configs are full of, and
// it is what the URL-encoding and shell-quoting paths have to survive.

function node(name, over) {
  return Object.assign({
    name: name, type: "Vless", isGroup: false, isAuto: false,
    alive: true, delay: 0, now: "", fixed: "", members: [], hidden: false
  }, over || {})
}

function state(over) {
  return Object.assign({
    reachable: true,
    mode: "rule",
    tun: false,
    groupName: "主代理",
    group: { now: "日本aw6", all: ["日本aw6", "香港pump1", "DIRECT"], type: "Selector", fixed: "" },
    nodes: {
      "日本aw6": node("日本aw6", { delay: 80 }),
      "香港pump1": node("香港pump1", { delay: 320 }),
      "DIRECT": node("DIRECT", { type: "Direct" })
    },
    net: {},
    rates: {},
    providers: []
  }, over || {})
}

function autoState(over) {
  return state(Object.assign({
    groupName: "香港自动",
    group: { now: "香港pump2", all: ["香港pump1", "香港pump2"], type: "URLTest", fixed: "" },
    nodes: {
      "香港pump1": node("香港pump1", { delay: 95 }),
      "香港pump2": node("香港pump2", { delay: 81 })
    }
  }, over || {}))
}

const SOCKET = Clash.apiConfig("", "", "")
const HTTP = Clash.apiConfig("", "http://127.0.0.1:9097", "s3cret")

// ── Shared.js ───────────────────────────────────────────────────────────────

test("shq leaves an ordinary string quoted", () => {
  eq(Shared.shq("/tmp/verge/verge-mihomo.sock"), "'/tmp/verge/verge-mihomo.sock'")
})

test("shq escapes an embedded single quote", () => {
  eq(Shared.shq("/tmp/a'b"), "'/tmp/a'\\''b'")
})

test("shq handles empty and undefined", () => {
  eq(Shared.shq(""), "''")
  eq(Shared.shq(undefined), "''")
})

test("formatBytes below a kilobyte stays in bytes", () => {
  eq(Shared.formatBytes(0), "0 B")
  eq(Shared.formatBytes(512), "512 B")
})

test("formatBytes climbs units and trims trailing zeros", () => {
  eq(Shared.formatBytes(1024), "1 KB")
  eq(Shared.formatBytes(1536), "1.5 KB")
  eq(Shared.formatBytes(1024 * 1024), "1 MB")
  eq(Shared.formatBytes(24835327269), "23.1 GB")
})

test("formatBytes rejects a negative count", () => {
  eq(Shared.formatBytes(-1), "—")
  eq(Shared.formatBytes("nonsense"), "—")
})

test("formatRate floors sub-byte rates and suffixes the rest", () => {
  eq(Shared.formatRate(0), "0 B/s")
  eq(Shared.formatRate(0.4), "0 B/s")
  eq(Shared.formatRate(1536), "1.5 KB/s")
})

test("formatDelay treats zero and negative as no measurement", () => {
  eq(Shared.formatDelay(84), "84 ms")
  eq(Shared.formatDelay(0), "")
  eq(Shared.formatDelay(-3), "")
})

test("parseTime reads RFC 3339, unix seconds and the Go zero value", () => {
  eq(Shared.parseTime("2026-08-24T06:55:28.369401126+08:00"), Date.parse("2026-08-24T06:55:28.369+08:00"))
  eq(Shared.parseTime(1819723890), 1819723890000)
  eq(Shared.parseTime("0001-01-01T00:00:00Z"), 0)
  eq(Shared.parseTime("nope"), 0)
  eq(Shared.parseTime(""), 0)
})

test("formatSince buckets by minute, hour and day", () => {
  const now = 1000000000
  eq(Shared.formatSince(now - 30 * 1000, now), "just now")
  eq(Shared.formatSince(now - 5 * 60 * 1000, now), "5m ago")
  eq(Shared.formatSince(now - 3 * 3600 * 1000, now), "3h ago")
  eq(Shared.formatSince(now - 2 * 86400 * 1000, now), "2d ago")
  eq(Shared.formatSince(0, now), "")
})

test("formatUntil counts down and says so when it has run out", () => {
  const now = 1000000000
  eq(Shared.formatUntil(now - 1000, now), "expired")
  eq(Shared.formatUntil(now + 3600 * 1000, now), "expires today")
  eq(Shared.formatUntil(now + 5 * 86400 * 1000, now), "5d left")
  eq(Shared.formatUntil(now + 200 * 86400 * 1000, now), "6mo left")
})

test("formatDuration chooses a useful coarse unit", () => {
  eq(Shared.formatDuration(30 * 60 * 1000), "30m")
  eq(Shared.formatDuration(5 * 3600 * 1000), "5h")
  eq(Shared.formatDuration(12 * 86400 * 1000), "12d")
})

test("elide collapses whitespace and cuts at the limit", () => {
  eq(Shared.elide("  a   b  ", 10), "a b")
  eq(Shared.elide("abcdefghij", 5), "abcd…")
})

// ── Batch plumbing ──────────────────────────────────────────────────────────

test("splitBatches round-trips the separator", () => {
  const parts = Clash.splitBatches(["a", "b", "c"].join(Clash.SEP))
  eq(parts.length, 3)
  eq(parts[1], "b")
})

test("batchSlot is total over out-of-range indexes", () => {
  const parts = Clash.splitBatches("one" + Clash.SEP + "two")
  eq(Clash.batchSlot(parts, 0), "one")
  eq(Clash.batchSlot(parts, 9), "")
  eq(Clash.batchSlot(parts, -1), "")
  eq(Clash.batchSlot(null, 0), "")
})

test("tryParseJson swallows everything that is not JSON", () => {
  eq(Clash.tryParseJson('{"a":1}'), { a: 1 })
  eq(Clash.tryParseJson("<html>"), null)
  eq(Clash.tryParseJson("   "), null)
})

// ── Endpoint configuration ──────────────────────────────────────────────────

test("normalizeControllerUrl accepts a full URL and strips trailing slashes", () => {
  eq(Clash.normalizeControllerUrl("http://127.0.0.1:9097///"), "http://127.0.0.1:9097")
  eq(Clash.normalizeControllerUrl("https://box.lan:9090"), "https://box.lan:9090")
})

test("normalizeControllerUrl assumes http:// for a bare host:port", () => {
  eq(Clash.normalizeControllerUrl("127.0.0.1:9097"), "http://127.0.0.1:9097")
})

test("normalizeControllerUrl rejects anything with shell metacharacters", () => {
  eq(Clash.normalizeControllerUrl("http://a.b; rm -rf /"), "")
  eq(Clash.normalizeControllerUrl("http://a.b`id`"), "")
  eq(Clash.normalizeControllerUrl("$(id)"), "")
  eq(Clash.normalizeControllerUrl(""), "")
})

test("apiConfig defaults to the Clash Verge unix socket", () => {
  eq(SOCKET.mode, "socket")
  eq(SOCKET.socketPath, Clash.SOCK_PATH)
  eq(SOCKET.baseUrl, "http://localhost")
  eq(SOCKET.secret, "")
})

test("apiConfig honours a custom socket path", () => {
  eq(Clash.apiConfig("/run/mihomo.sock", "", "").socketPath, "/run/mihomo.sock")
})

test("apiConfig switches to http when a controller URL is set", () => {
  eq(HTTP.mode, "http")
  eq(HTTP.baseUrl, "http://127.0.0.1:9097")
  eq(HTTP.secret, "s3cret")
  eq(HTTP.socketPath, "")
})

test("apiConfig ignores an invalid controller URL and falls back to the socket", () => {
  eq(Clash.apiConfig("", "http://a b", "").mode, "socket")
})

test("curlArgs passes the socket, and the secret only when there is one", () => {
  eq(Clash.curlArgs(SOCKET), ["--unix-socket", Clash.SOCK_PATH])
  eq(Clash.curlArgs(HTTP), ["-H", "Authorization: Bearer s3cret"])
  eq(Clash.curlArgs(Clash.apiConfig("", "http://127.0.0.1:9097", "")), [])
})

test("curlArgsShell single-quotes everything it interpolates", () => {
  eq(Clash.curlArgsShell(SOCKET), "--unix-socket '" + Clash.SOCK_PATH + "'")
  eq(Clash.curlArgsShell(HTTP), "-H 'Authorization: Bearer s3cret'")
})

test("buildStatusCommand returns a bash -c invocation hitting /configs", () => {
  const cmd = Clash.buildStatusCommand(SOCKET, "主代理", false, false)
  eq(cmd[0], "bash")
  eq(cmd[1], "-c")
  ok(cmd[2].indexOf("http://localhost/configs") >= 0)
  ok(cmd[2].indexOf(encodeURIComponent("主代理")) >= 0)
  ok(cmd[2].indexOf("rc:%s") >= 0)
})

test("buildStatusCommand only fetches the full proxy dump when deep", () => {
  const shallow = Clash.buildStatusCommand(SOCKET, "主代理", false, false)[2]
  const deep = Clash.buildStatusCommand(SOCKET, "主代理", true, false)[2]
  eq(shallow.indexOf("'http://localhost/proxies'") >= 0, false)
  eq(deep.indexOf("'http://localhost/proxies'") >= 0, true)
})

test("buildStatusCommand only fetches /connections when traffic is wanted", () => {
  eq(Clash.buildStatusCommand(SOCKET, "主代理", false, false)[2].indexOf("/connections") >= 0, false)
  eq(Clash.buildStatusCommand(SOCKET, "主代理", false, true)[2].indexOf("/connections") >= 0, true)
})

test("buildStatusCommand does not fetch GLOBAL twice when GLOBAL is the group", () => {
  const script = Clash.buildStatusCommand(SOCKET, "GLOBAL", false, false)[2]
  eq(script.split("/proxies/GLOBAL").length - 1, 1)
})

test("buildStatusCommand quotes a socket path containing a quote", () => {
  const script = Clash.buildStatusCommand(Clash.apiConfig("/tmp/a'b", "", ""), "主代理", false, false)[2]
  ok(script.indexOf("'/tmp/a'\\''b'") >= 0)
  eq(script.indexOf("/tmp/a'b "), -1)
})

// encodeURIComponent does NOT escape an apostrophe — it is an RFC 3986 mark.
// v1.0.0 interpolated its output straight into the bash string on the strength
// of a comment claiming otherwise; the shell quoting below is what actually
// makes a group name safe, whatever mihomo lets people call their groups.
test("buildStatusCommand shell-escapes a quote the URL encoder leaves alone", () => {
  eq(encodeURIComponent("we'ird"), "we'ird")
  const script = Clash.buildStatusCommand(SOCKET, "we'ird", false, false)[2]
  ok(script.indexOf("'http://localhost/proxies/we'\\''ird'") >= 0)
})

test("parseExitCode reads the trailing rc marker", () => {
  eq(Clash.parseExitCode("rc:0\n"), 0)
  eq(Clash.parseExitCode("rc:7"), 7)
  eq(Clash.parseExitCode("nothing here"), -1)
})

test("describeCurlError distinguishes the failure modes", () => {
  eq(Clash.describeCurlError(0, SOCKET), "")
  const messages = [7, 28, 22, 99].map(code => Clash.describeCurlError(code, SOCKET))
  messages.forEach(m => ok(m.length > 0))
  eq(new Set(messages).size, 4)
  ok(Clash.describeCurlError(7, SOCKET).indexOf(Clash.SOCK_PATH) >= 0)
  ok(Clash.describeCurlError(7, HTTP).indexOf("http://127.0.0.1:9097") >= 0)
})

// ── /configs ────────────────────────────────────────────────────────────────

test("parseClashConfigs reads mode and tun", () => {
  eq(Clash.parseClashConfigs('{"mode":"rule","tun":{"enable":true}}'),
     { loaded: true, mode: "rule", tun: true })
  eq(Clash.parseClashConfigs('{"mode":"global","tun":{"enable":false}}'),
     { loaded: true, mode: "global", tun: false })
})

test("parseClashConfigs rejects an unknown mode and garbage", () => {
  eq(Clash.parseClashConfigs('{"mode":"sideways"}').loaded, false)
  eq(Clash.parseClashConfigs("not json").loaded, false)
  eq(Clash.parseClashConfigs("").loaded, false)
})

// ── Group typing ────────────────────────────────────────────────────────────

test("Selector is a group but is not an auto group", () => {
  eq(Clash.isGroupType("Selector"), true)
  eq(Clash.isAutoGroupType("Selector"), false)
})

test("URLTest, Fallback and LoadBalance are auto groups", () => {
  ;["URLTest", "Fallback", "LoadBalance"].forEach(type => {
    eq(Clash.isGroupType(type), true)
    eq(Clash.isAutoGroupType(type), true)
  })
})

test("a plain outbound is neither", () => {
  ;["Vless", "Direct", "Shadowsocks", ""].forEach(type => {
    eq(Clash.isGroupType(type), false)
    eq(Clash.isAutoGroupType(type), false)
  })
})

test("lastDelay takes the most recent probe and treats zero as unmeasured", () => {
  eq(Clash.lastDelay({ history: [{ delay: 200 }, { delay: 84 }] }), 84)
  eq(Clash.lastDelay({ history: [{ delay: 0 }] }), 0)
  eq(Clash.lastDelay({ history: [] }), 0)
  eq(Clash.lastDelay({}), 0)
  eq(Clash.lastDelay(null), 0)
})

// ── /proxies ────────────────────────────────────────────────────────────────

const PROXIES_RAW = JSON.stringify({
  proxies: {
    "DIRECT": { name: "DIRECT", type: "Direct", alive: true, history: [] },
    "日本aw6": { name: "日本aw6", type: "Vless", alive: true, history: [{ delay: 300 }, { delay: 120 }] },
    "香港pump1": { name: "香港pump1", type: "AnyTLS", alive: false, history: [{ delay: 0 }] },
    "主代理": { name: "主代理", type: "Selector", alive: true, now: "日本aw6", all: ["日本aw6", "香港pump1"], history: [] },
    "香港自动": { name: "香港自动", type: "URLTest", alive: true, now: "香港pump1", fixed: "香港pump1", all: ["香港pump1"], history: [{ delay: 95 }] },
    "隐藏组": { name: "隐藏组", type: "Selector", alive: true, hidden: true, all: ["DIRECT"], history: [] },
    "空组": { name: "空组", type: "Selector", alive: true, all: [], history: [] },
    "GLOBAL": { name: "GLOBAL", type: "Selector", alive: true, now: "日本aw6", all: ["日本aw6"], history: [] }
  }
})

test("parseProxies normalizes every node", () => {
  const parsed = Clash.parseProxies(PROXIES_RAW)
  eq(parsed.loaded, true)
  eq(parsed.nodes["日本aw6"].delay, 120)
  eq(parsed.nodes["日本aw6"].alive, true)
  eq(parsed.nodes["日本aw6"].isGroup, false)
  eq(parsed.nodes["香港pump1"].alive, false)
  eq(parsed.nodes["香港pump1"].delay, 0)
  eq(parsed.nodes["主代理"].isGroup, true)
  eq(parsed.nodes["主代理"].isAuto, false)
  eq(parsed.nodes["主代理"].members, ["日本aw6", "香港pump1"])
  eq(parsed.nodes["香港自动"].isAuto, true)
  eq(parsed.nodes["香港自动"].fixed, "香港pump1")
})

test("parseProxies offers only visible, non-empty groups as choices", () => {
  const groups = Clash.parseProxies(PROXIES_RAW).groups
  eq(groups.indexOf("主代理") >= 0, true)
  eq(groups.indexOf("香港自动") >= 0, true)
  eq(groups.indexOf("GLOBAL") >= 0, true)
  eq(groups.indexOf("隐藏组"), -1)
  eq(groups.indexOf("空组"), -1)
  eq(groups.indexOf("日本aw6"), -1)
})

test("parseProxies survives garbage", () => {
  eq(Clash.parseProxies("<html>").loaded, false)
  eq(Clash.parseProxies('{"nope":1}').loaded, false)
})

test("parseSelectorGroup reads a Selector", () => {
  eq(Clash.parseSelectorGroup('{"now":"日本aw6","all":["日本aw6","DIRECT"],"type":"Selector"}'),
     { now: "日本aw6", all: ["日本aw6", "DIRECT"], type: "Selector", fixed: "" })
})

test("parseSelectorGroup carries an auto group's fixed pin", () => {
  const group = Clash.parseSelectorGroup('{"now":"a","all":["a","b"],"type":"URLTest","fixed":"a"}')
  eq(group.type, "URLTest")
  eq(group.fixed, "a")
})

test("parseSelectorGroup rejects a 404 body and garbage", () => {
  eq(Clash.parseSelectorGroup('{"message":"Not Found"}'), null)
  eq(Clash.parseSelectorGroup("nope"), null)
  eq(Clash.parseSelectorGroup(""), null)
})

test("resolveSelector prefers the configured group", () => {
  const resolved = Clash.resolveSelector('{"now":"a","all":["a"],"type":"Selector"}', "", "主代理")
  eq(resolved.groupName, "主代理")
  eq(resolved.group.now, "a")
})

test("resolveSelector falls back to GLOBAL when the group is missing", () => {
  const resolved = Clash.resolveSelector('{"message":"Not Found"}', '{"now":"g","all":["g"],"type":"Selector"}', "主代理")
  eq(resolved.groupName, "GLOBAL")
  eq(resolved.group.now, "g")
})

test("resolveSelector gives up when neither exists", () => {
  eq(Clash.resolveSelector("", "", "主代理"), null)
})

test("selectableGroups puts the active group first and GLOBAL last", () => {
  const groups = Clash.selectableGroups(Clash.parseProxies(PROXIES_RAW), "香港自动")
  eq(groups[0].value, "香港自动")
  eq(groups[groups.length - 1].value, "GLOBAL")
  eq(groups[0].type, "URLTest")
  eq(groups[0].label, "香港自动")
  eq(groups[0].count, 1)
})

test("selectableGroups is empty when nothing was parsed", () => {
  eq(Clash.selectableGroups(Clash.parseProxies(""), "主代理"), [])
})

// ── /connections ────────────────────────────────────────────────────────────

test("parseConnections reads the counters, the count and core memory", () => {
  eq(Clash.parseConnections('{"uploadTotal":10,"downloadTotal":20,"memory":99,"connections":[{},{}]}'),
     { loaded: true, up: 10, down: 20, count: 2, memory: 99 })
})

test("parseConnections tolerates a null connections list and garbage", () => {
  eq(Clash.parseConnections('{"uploadTotal":1,"downloadTotal":2,"connections":null}').count, 0)
  eq(Clash.parseConnections("nope").loaded, false)
})

test("computeRates divides the counter delta by elapsed seconds", () => {
  const rates = Clash.computeRates({ loaded: true, up: 100, down: 200, at: 1000 },
                                   { loaded: true, up: 1100, down: 2200, at: 3000 })
  eq(rates.known, true)
  eq(rates.upRate, 500)
  eq(rates.downRate, 1000)
})

test("computeRates reports nothing when a counter went backwards", () => {
  eq(Clash.computeRates({ loaded: true, up: 100, down: 200, at: 1000 },
                        { loaded: true, up: 5, down: 2200, at: 3000 }).known, false)
})

test("computeRates reports nothing for samples taken too close together", () => {
  eq(Clash.computeRates({ loaded: true, up: 0, down: 0, at: 1000 },
                        { loaded: true, up: 10, down: 10, at: 1100 }).known, false)
})

test("computeRates reports nothing without two loaded samples", () => {
  eq(Clash.computeRates({ loaded: false }, { loaded: true, up: 1, down: 1, at: 2000 }).known, false)
  eq(Clash.computeRates(null, null).known, false)
})

// ── /providers/proxies ──────────────────────────────────────────────────────

const PROVIDERS_RAW = JSON.stringify({
  providers: {
    "dualnet": {
      vehicleType: "HTTP",
      updatedAt: "2026-08-24T06:55:28.369401126+08:00",
      subscriptionInfo: { Upload: 1000, Download: 3000, Total: 10000, Expire: 1819723890 },
      proxies: [{ name: "dual-a" }, { name: "dual-b" }, { name: "dual-a" }]
    },
    "aaa-local": {
      vehicleType: "File",
      updatedAt: "2026-08-24T06:55:28Z",
      subscriptionInfo: { Upload: 0, Download: 500, Total: 1000, Expire: 0 }
    },
    "主代理": { vehicleType: "Compatible", updatedAt: "0001-01-01T00:00:00Z" },
    "unmetered": { vehicleType: "HTTP", subscriptionInfo: { Upload: 1, Download: 1, Total: 0 } }
  }
})

test("parseProviders keeps HTTP and File providers, including unmetered fallbacks", () => {
  const providers = Clash.parseProviders(PROVIDERS_RAW)
  eq(providers.length, 3)
  eq(providers.map(p => p.name), ["aaa-local", "dualnet", "unmetered"])
  eq(providers.filter(p => p.name === "unmetered")[0].hasQuota, false)
})

test("parseProviders sums upload and download into used, with a bounded ratio", () => {
  const dualnet = Clash.parseProviders(PROVIDERS_RAW).filter(p => p.name === "dualnet")[0]
  eq(dualnet.used, 4000)
  eq(dualnet.total, 10000)
  eq(dualnet.ratio, 0.4)
  eq(dualnet.expire, 1819723890000)
})

test("parseProviders survives garbage", () => {
  eq(Clash.parseProviders("nope"), [])
  eq(Clash.parseProviders('{"providers":{}}'), [])
})

test("subscriptionRows carries the ratio and marks only HTTP providers updatable", () => {
  const rows = Clash.subscriptionRows(Clash.parseProviders(PROVIDERS_RAW), Date.now())
  const dualnet = rows.filter(r => r.key === "dualnet")[0]
  const local = rows.filter(r => r.key === "aaa-local")[0]
  eq(dualnet.ratio, 0.4)
  eq(dualnet.used, "3.91 KB")
  eq(dualnet.updatable, true)
  eq(local.updatable, false)
})

test("managed provider names accept comma and newline lists without duplicates", () => {
  eq(Clash.parseManagedProviders("dualnet, aaa-local\ndualnet"), ["dualnet", "aaa-local"])
  const selected = Clash.filterProviders(Clash.parseProviders(PROVIDERS_RAW), "dualnet,aaa-local")
  eq(selected.map(p => p.name), ["dualnet", "aaa-local"])
})

test("providerNodeNames exposes unique provider members", () => {
  const providers = Clash.parseProviders(PROVIDERS_RAW)
  eq(Clash.providerNodeNames(providers, "dualnet"), ["dual-a", "dual-b"])
  eq(Clash.providerNodeNames(providers, "missing"), [])
})

test("successfulProbeRows keeps only successful provider nodes and sorts by latency", () => {
  eq(Clash.successfulProbeRows(["slow", "dead", "fast"], { slow: 350, fast: 82, other: 1 }), [
    { key: "fast", label: "fast", delay: 82, order: 2 },
    { key: "slow", label: "slow", delay: 350, order: 0 }
  ])
})

test("independent ChatGPT probe avoids the group-delay route mutation", () => {
  const command = Clash.buildIndependentDelayCommand(
    Clash.apiConfig("", "http://127.0.0.1:9090", ""),
    "cdpc",
    ["CDPC Hong Kong", "CDPC O'Brien"],
    "https://api.openai.com/v1/models",
    "401",
    6000
  )
  eq(command[0], "bash")
  eq(command[1], "-c")
  ok(command[2].includes("/providers/proxies/cdpc/CDPC%20Hong%20Kong/healthcheck"))
  ok(command[2].includes("/providers/proxies/cdpc/CDPC%20O"))
  ok(command[2].includes("Brien/healthcheck"))
  ok(command[2].includes("expected=401"))
  ok(command[2].includes(".extra[$url].alive == true"))
  ok(!command[2].includes("/group/"))
})

test("observeUsage persists only quota counters and avoids duplicate samples", () => {
  const providers = Clash.parseProviders(PROVIDERS_RAW)
  const first = Clash.observeUsage(null, providers, 1000000, 30)
  eq(Object.keys(first.providers), ["aaa-local", "dualnet"])
  const second = Clash.observeUsage(first, providers, 1001000, 30)
  eq(second.providers.dualnet.length, 1)
})

test("quotaForecast estimates exhaustion from the current monotonic cycle", () => {
  const provider = {
    name: "dualnet", hasQuota: true, used: 600, total: 1000,
    expire: 20 * 86400000, ratio: 0.6
  }
  const history = { version: 1, providers: { dualnet: [
    { at: 0, used: 100, total: 1000, expire: provider.expire },
    { at: 5 * 86400000, used: 600, total: 1000, expire: provider.expire }
  ] } }
  const forecast = Clash.quotaForecast(provider, history, 5 * 86400000)
  eq(forecast.known, true)
  eq(forecast.confidence, "high")
  eq(forecast.risk, true)
  eq(Math.round((forecast.exhaustAt - 5 * 86400000) / 86400000), 4)
})

test("quotaForecast refuses to mix samples across a quota reset", () => {
  const provider = { name: "p", hasQuota: true, used: 10, total: 100, expire: 0 }
  const history = { version: 1, providers: { p: [
    { at: 0, used: 90, total: 100 },
    { at: 86400000, used: 5, total: 100 },
    { at: 2 * 86400000, used: 10, total: 100 }
  ] } }
  const forecast = Clash.quotaForecast(provider, history, 2 * 86400000)
  eq(forecast.known, true)
  eq(Math.round((forecast.exhaustAt - 2 * 86400000) / 86400000), 18)
})

// ── Latency probes ──────────────────────────────────────────────────────────

test("parseDelayMap reads the flat name -> ms map", () => {
  const result = Clash.parseDelayMap('{"香港pump1":95,"香港pump2":81}')
  eq(result.ok, true)
  eq(result.delays, { "香港pump1": 95, "香港pump2": 81 })
})

test("parseDelayMap drops zero and non-numeric entries", () => {
  eq(Clash.parseDelayMap('{"a":0,"b":"x","c":12}').delays, { c: 12 })
})

test("parseDelayMap surfaces an error body", () => {
  const result = Clash.parseDelayMap('{"message":"Timeout"}')
  eq(result.ok, false)
  eq(result.error, "Timeout")
})

test("parseDelayMap fails closed on garbage", () => {
  eq(Clash.parseDelayMap("<html>").ok, false)
})

test("parseSingleDelay reads a measurement and rejects the failures", () => {
  eq(Clash.parseSingleDelay('{"delay":120}'), { ok: true, delay: 120, error: "" })
  eq(Clash.parseSingleDelay('{"message":"Timeout"}').ok, false)
  eq(Clash.parseSingleDelay('{"delay":0}').ok, false)
  eq(Clash.parseSingleDelay("nope").ok, false)
})

test("mergeDelays applies fresh measurements", () => {
  const nodes = { a: node("a", { delay: 10 }) }
  const merged = Clash.mergeDelays(nodes, { a: 55 }, ["a"])
  eq(merged.a.delay, 55)
  eq(merged.a.alive, true)
})

test("mergeDelays marks a probed node that did not answer as dead", () => {
  const nodes = { a: node("a", { delay: 10, alive: true }) }
  const merged = Clash.mergeDelays(nodes, {}, ["a"])
  eq(merged.a.delay, 0)
  eq(merged.a.alive, false)
})

test("mergeDelays leaves unprobed nodes alone and does not mutate its input", () => {
  const nodes = { a: node("a", { delay: 10 }), b: node("b", { delay: 20 }) }
  const merged = Clash.mergeDelays(nodes, { a: 55 }, ["a"])
  eq(merged.b.delay, 20)
  eq(nodes.a.delay, 10)
  eq(merged.a === nodes.a, false)
})

// ── View model ──────────────────────────────────────────────────────────────

test("activeNodeName reads a Selector's current choice", () => {
  eq(Clash.activeNodeName(state()), "日本aw6")
})

test("activeNodeName prefers an auto group's pin over its own choice", () => {
  eq(Clash.activeNodeName(autoState()), "香港pump2")
  eq(Clash.activeNodeName(autoState({
    group: { now: "香港pump2", all: ["香港pump1", "香港pump2"], type: "URLTest", fixed: "香港pump1" }
  })), "香港pump1")
})

test("isPinned is true only for a pinned auto group", () => {
  eq(Clash.isPinned(state()), false)
  eq(Clash.isPinned(autoState()), false)
  eq(Clash.isPinned(autoState({
    group: { now: "香港pump2", all: ["香港pump2"], type: "URLTest", fixed: "香港pump2" }
  })), true)
})

test("clashSummary covers the unreachable and groupless cases", () => {
  eq(Clash.clashSummary(state({ reachable: false })), "Clash Verge is not running")
  eq(Clash.clashSummary(state({ group: null })), "No proxy group found")
})

test("clashSummary says bypassed in direct mode", () => {
  eq(Clash.clashSummary(state({ mode: "direct" })), "Bypassed — traffic is not proxied")
})

test("clashSummary suffixes global and TUN", () => {
  eq(Clash.clashSummary(state()), "日本aw6")
  eq(Clash.clashSummary(state({ mode: "global" })), "日本aw6 · global")
  eq(Clash.clashSummary(state({ tun: true })), "日本aw6 · TUN")
  eq(Clash.clashSummary(state({ mode: "global", tun: true })), "日本aw6 · global · TUN")
})

test("clashDetails lists node, mode and group", () => {
  const labels = Clash.clashDetails(state()).map(r => r.label)
  eq(labels, ["Node", "Type", "Latency", "Mode", "Group"])
})

test("clashDetails omits latency when nothing has been measured", () => {
  const labels = Clash.clashDetails(state({
    nodes: { "日本aw6": node("日本aw6", { delay: 0 }) }
  })).map(r => r.label)
  eq(labels.indexOf("Latency"), -1)
})

test("clashDetails annotates an auto group as pinned or auto", () => {
  const auto = Clash.clashDetails(autoState()).filter(r => r.label === "Group")[0]
  eq(auto.value, "香港自动 (URLTest, auto)")
  const pinned = Clash.clashDetails(autoState({
    group: { now: "香港pump2", all: ["香港pump2"], type: "URLTest", fixed: "香港pump2" }
  })).filter(r => r.label === "Group")[0]
  eq(pinned.value, "香港自动 (URLTest, pinned)")
})

test("clashDetails says nothing in direct mode or when unreachable", () => {
  eq(Clash.clashDetails(state({ mode: "direct" })), [])
  eq(Clash.clashDetails(state({ reachable: false })), [])
})

test("clashNetworkRows is empty until /connections has been read", () => {
  eq(Clash.clashNetworkRows(state()), [])
})

test("clashNetworkRows adds a speed row only once two samples exist", () => {
  const net = { loaded: true, up: 100, down: 200, count: 3, memory: 0 }
  eq(Clash.clashNetworkRows(state({ net: net })).map(r => r.label), ["Session", "Open"])
  eq(Clash.clashNetworkRows(state({ net: net, rates: { known: true, upRate: 1, downRate: 2 } })).map(r => r.label),
     ["Speed", "Session", "Open"])
})

test("clashNetworkRows counts one connection in the singular", () => {
  const one = Clash.clashNetworkRows(state({ net: { loaded: true, up: 0, down: 0, count: 1, memory: 0 } }))
  eq(one.filter(r => r.label === "Open")[0].value, "1 connection")
  const many = Clash.clashNetworkRows(state({ net: { loaded: true, up: 0, down: 0, count: 2, memory: 0 } }))
  eq(many.filter(r => r.label === "Open")[0].value, "2 connections")
})

test("latencyRank separates measured, unmeasured and dead", () => {
  eq(Clash.latencyRank(node("a", { alive: true, delay: 80 })), 0)
  eq(Clash.latencyRank(node("a", { alive: true, delay: 0 })), 1)
  eq(Clash.latencyRank(node("a", { alive: false, delay: 0 })), 2)
  eq(Clash.latencyRank(undefined), 1)
})

// ── Target list ─────────────────────────────────────────────────────────────

test("clashTargets keeps the group's own member order by default", () => {
  eq(Clash.clashTargets(state(), "", "config").map(r => r.key), ["日本aw6", "香港pump1", "DIRECT"])
})

test("clashTargets falls back to config order for an unknown sort mode", () => {
  eq(Clash.clashTargets(state(), "", "sideways").map(r => r.key), ["日本aw6", "香港pump1", "DIRECT"])
})

test("clashTargets filters case-insensitively", () => {
  eq(Clash.clashTargets(state(), "direct", "config").map(r => r.key), ["DIRECT"])
  eq(Clash.clashTargets(state(), "  香港 ", "config").map(r => r.key), ["香港pump1"])
  eq(Clash.clashTargets(state(), "zzz", "config"), [])
})

test("clashTargets sorts measured nodes fastest first, then unmeasured, then dead", () => {
  const s = state({
    group: { now: "a", all: ["dead", "slow", "unknown", "fast"], type: "Selector", fixed: "" },
    nodes: {
      dead: node("dead", { alive: false }),
      slow: node("slow", { delay: 400 }),
      unknown: node("unknown", { delay: 0 }),
      fast: node("fast", { delay: 40 })
    }
  })
  eq(Clash.clashTargets(s, "", "latency").map(r => r.key), ["fast", "slow", "unknown", "dead"])
})

test("clashTargets sorts by name when asked", () => {
  const s = state({
    group: { now: "b", all: ["c", "a", "b"], type: "Selector", fixed: "" },
    nodes: { a: node("a"), b: node("b"), c: node("c") }
  })
  eq(Clash.clashTargets(s, "", "name").map(r => r.key), ["a", "b", "c"])
})

test("clashTargets carries latency and liveness onto each row", () => {
  const row = Clash.clashTargets(state(), "", "config")[0]
  eq(row.delay, 80)
  eq(row.alive, true)
  eq(row.current, true)
  eq(row.isAuto, false)
})

test("clashTargets gives an auto group an unpin row, always first", () => {
  const rows = Clash.clashTargets(autoState(), "", "latency")
  eq(rows[0].key, Clash.AUTO_KEY)
  eq(rows[0].isAuto, true)
  eq(rows[0].current, true)
  eq(rows.length, 3)
})

test("clashTargets marks the auto row not-current once the group is pinned", () => {
  const rows = Clash.clashTargets(autoState({
    group: { now: "香港pump2", all: ["香港pump1", "香港pump2"], type: "URLTest", fixed: "香港pump1" }
  }), "", "config")
  eq(rows[0].key, Clash.AUTO_KEY)
  eq(rows[0].current, false)
  eq(rows.filter(r => r.current).map(r => r.key), ["香港pump1"])
})

test("clashTargets gives a Selector group no auto row", () => {
  eq(Clash.clashTargets(state(), "", "config").filter(r => r.isAuto), [])
})

test("clashTargets is empty when there is nothing to steer", () => {
  eq(Clash.clashTargets(state({ reachable: false }), "", "config"), [])
  eq(Clash.clashTargets(state({ group: null }), "", "config"), [])
})

test("clashCurrentKey follows a Selector's choice", () => {
  eq(Clash.clashCurrentKey(state()), "日本aw6")
})

test("clashCurrentKey is the auto sentinel until an auto group is pinned", () => {
  eq(Clash.clashCurrentKey(autoState()), Clash.AUTO_KEY)
  eq(Clash.clashCurrentKey(autoState({
    group: { now: "香港pump2", all: ["香港pump2"], type: "URLTest", fixed: "香港pump2" }
  })), "香港pump2")
})

test("clashCurrentKey is empty in direct mode and when unreachable", () => {
  eq(Clash.clashCurrentKey(state({ mode: "direct" })), "")
  eq(Clash.clashCurrentKey(state({ reachable: false })), "")
})

test("clashToggles offers global and TUN, tracking the daemon", () => {
  eq(Clash.clashToggles(state({ reachable: false })), [])
  const toggles = Clash.clashToggles(state({ mode: "global", tun: true }))
  eq(toggles.map(t => t.key), ["global", "tun"])
  eq(toggles.map(t => t.value), [true, true])
  eq(Clash.clashToggles(state()).map(t => t.value), [false, false])
})

// ── Bar ─────────────────────────────────────────────────────────────────────

test("barState names the four things the bar can be", () => {
  eq(Clash.barState(state({ reachable: false })), "down")
  eq(Clash.barState(state({ mode: "direct" })), "direct")
  eq(Clash.barState(state()), "rule")
  eq(Clash.barState(state({ mode: "global" })), "global")
})

test("barGlyph differs between down, bypassed and routing", () => {
  const glyphs = [state({ reachable: false }), state({ mode: "direct" }), state()].map(Clash.barGlyph)
  eq(new Set(glyphs).size, 3)
})

test("barLabel is empty in icon mode and for an unknown mode", () => {
  eq(Clash.barLabel(state(), "icon"), "")
  eq(Clash.barLabel(state(), "sideways"), "")
  eq(Clash.barLabel(state(), ""), "")
})

test("barLabel reports the node, or that there is nothing to report", () => {
  eq(Clash.barLabel(state(), "node"), "日本aw6")
  eq(Clash.barLabel(state({ mode: "direct" }), "node"), "direct")
  eq(Clash.barLabel(state({ reachable: false }), "node"), "off")
})

test("barLabel elides a long node name", () => {
  const long = Clash.barLabel(state({
    group: { now: "V4-香港自有机房02-very-long|vless", all: [], type: "Selector", fixed: "" }
  }), "node")
  eq(long.length, 16)
  eq(long.slice(-1), "…")
})

test("barLabel shows throughput only once rates are known", () => {
  eq(Clash.barLabel(state(), "speed"), "")
  const label = Clash.barLabel(state({ rates: { known: true, upRate: 1024, downRate: 2048 } }), "speed")
  ok(label.indexOf(Shared.GLYPH_DOWN) >= 0)
  ok(label.indexOf(Shared.GLYPH_UP) >= 0)
  ok(label.indexOf("2KB/s") >= 0)
})

test("barTooltip always leads with the summary", () => {
  eq(Clash.barTooltip(state()).split("\n")[0], "Clash Verge: 日本aw6")
  const rich = Clash.barTooltip(state({
    net: { loaded: true, up: 1, down: 2, count: 7, memory: 0 },
    rates: { known: true, upRate: 10, downRate: 20 }
  })).split("\n")
  eq(rich.length, 3)
  eq(rich[2], "7 open connections")
})

test("clashTargets never strikes out the node traffic is actually using", () => {
  const s = state({
    group: { now: "日本aw6", all: ["日本aw6", "日本1"], type: "Selector", fixed: "" },
    nodes: {
      "日本aw6": node("日本aw6", { alive: false, delay: 0 }),
      "日本1": node("日本1", { alive: false, delay: 0 })
    }
  })
  const rows = Clash.clashTargets(s, "", "config")
  eq(rows[0].current, true)
  eq(rows[0].alive, false)
  eq(rows[0].showDead, false)
  eq(rows[1].showDead, true)
})

test("clashTargets marks the auto row as never-dead", () => {
  eq(Clash.clashTargets(autoState(), "", "config")[0].showDead, false)
})
