.pragma library

// Small helpers Clash.js leans on. Nerd Font glyphs are built from codepoints
// rather than pasted as literal characters, because editing tools routinely
// mangle multi-byte sequences in plain text files.
var GLYPH_VPN = String.fromCodePoint(0xF0582)
var GLYPH_SWAP = String.fromCodePoint(0xF04E1)
var GLYPH_SHIELD = String.fromCodePoint(0xF0498)
var GLYPH_SHIELD_OFF = String.fromCodePoint(0xF099D)
var GLYPH_AUTO = String.fromCodePoint(0xF0450)
var GLYPH_DOWN = String.fromCodePoint(0xF0045)
var GLYPH_UP = String.fromCodePoint(0xF005D)

function detail(label, value) {
  return { label: label, value: String(value || "") }
}

// A tool setting the panel can flip. The value is always what the tool last
// reported, never something the widget stores.
function toggle(key, label, description, value) {
  return { key: key, label: label, detail: description, value: value === true, busy: false }
}

function elide(text, limit) {
  var value = String(text || "").replace(/\s+/g, " ").trim()
  return value.length > limit ? value.substring(0, limit - 1) + "…" : value
}

// Single-quote a string for interpolation into a `bash -c` command. Every
// byte except `'` is literal inside single quotes, and `'` is handled by
// closing, escaping, and reopening. Needed because the socket path, the
// controller URL and the API secret are all user settings that end up in the
// batched poll command — unlike v1.0.0, where the only interpolated value was
// a compile-time constant plus encodeURIComponent output.
function shq(text) {
  return "'" + String(text === undefined || text === null ? "" : text).split("'").join("'\\''") + "'"
}

var KB = 1024

// Byte counts, in the shape a status line wants: three significant digits at
// most, no trailing ".0", and a unit that never shifts width mid-poll more
// than it has to.
function formatBytes(bytes) {
  var n = Number(bytes)
  if (!isFinite(n) || n < 0) return "—"
  if (n < KB) return String(Math.round(n)) + " B"
  var units = ["KB", "MB", "GB", "TB", "PB"]
  var value = n / KB
  var i = 0
  while (value >= KB && i < units.length - 1) { value /= KB; i += 1 }
  var digits = value >= 100 ? 0 : (value >= 10 ? 1 : 2)
  var text = value.toFixed(digits)
  if (text.indexOf(".") >= 0) text = text.replace(/0+$/, "").replace(/\.$/, "")
  return text + " " + units[i]
}

function formatRate(bytesPerSecond) {
  var n = Number(bytesPerSecond)
  if (!isFinite(n) || n < 0) return "—"
  if (n < 1) return "0 B/s"
  return formatBytes(n) + "/s"
}

// Latency, as reported by mihomo's own delay history. 0 and negative both
// mean "no successful probe on record", which is not the same as "fast".
function formatDelay(ms) {
  var n = Number(ms)
  if (!isFinite(n) || n <= 0) return ""
  return String(Math.round(n)) + " ms"
}

// mihomo timestamps are RFC 3339 with nanosecond precision, which Date can
// parse in every engine this runs in. Unix seconds are accepted too, because
// that is what provider subscriptionInfo uses for Expire.
function parseTime(value) {
  if (typeof value === "number") return isFinite(value) && value > 0 ? value * 1000 : 0
  var text = String(value || "").trim()
  if (text === "" || text.indexOf("0001-01-01") === 0) return 0
  var parsed = Date.parse(text)
  return isFinite(parsed) ? parsed : 0
}

// Coarse "how long ago" / "how long left" for the one or two places that show
// a timestamp. Deliberately never smaller than a minute: this is a status
// line, not a stopwatch.
function formatSince(millis, nowMillis) {
  if (!millis) return ""
  var delta = Math.max(0, Math.round((nowMillis - millis) / 1000))
  if (delta < 60) return "just now"
  if (delta < 3600) return Math.floor(delta / 60) + "m ago"
  if (delta < 86400) return Math.floor(delta / 3600) + "h ago"
  return Math.floor(delta / 86400) + "d ago"
}

function formatUntil(millis, nowMillis) {
  if (!millis) return ""
  var delta = Math.round((millis - nowMillis) / 1000)
  if (delta <= 0) return "expired"
  if (delta < 86400) return "expires today"
  var days = Math.floor(delta / 86400)
  if (days < 60) return days + "d left"
  return Math.floor(days / 30) + "mo left"
}

if (typeof module !== "undefined") {
  module.exports = {
    GLYPH_VPN: GLYPH_VPN,
    GLYPH_SWAP: GLYPH_SWAP,
    GLYPH_SHIELD: GLYPH_SHIELD,
    GLYPH_SHIELD_OFF: GLYPH_SHIELD_OFF,
    GLYPH_AUTO: GLYPH_AUTO,
    GLYPH_DOWN: GLYPH_DOWN,
    GLYPH_UP: GLYPH_UP,
    detail: detail,
    toggle: toggle,
    elide: elide,
    shq: shq,
    formatBytes: formatBytes,
    formatRate: formatRate,
    formatDelay: formatDelay,
    parseTime: parseTime,
    formatSince: formatSince,
    formatUntil: formatUntil
  }
}
