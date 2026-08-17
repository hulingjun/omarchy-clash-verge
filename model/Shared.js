.pragma library

// Small helpers Clash.js leans on. Nerd Font glyphs are built from codepoints
// rather than pasted as literal characters, because editing tools routinely
// mangle multi-byte sequences in plain text files.
var GLYPH_VPN = String.fromCodePoint(0xF0582)
var GLYPH_SWAP = String.fromCodePoint(0xF04E1)
var GLYPH_SHIELD = String.fromCodePoint(0xF0498)

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

if (typeof module !== "undefined") {
  module.exports = {
    GLYPH_VPN: GLYPH_VPN,
    GLYPH_SWAP: GLYPH_SWAP,
    GLYPH_SHIELD: GLYPH_SHIELD,
    detail: detail,
    toggle: toggle,
    elide: elide
  }
}
