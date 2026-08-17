// Loads the model/*.js files the way the QML engine does, and provides the
// three things a test file needs: `test`, `eq`, and the module namespaces.
//
// The model files are QML `.pragma library` scripts, which have no module
// system beyond top-level declarations plus an `.import` line. Neither
// directive is JavaScript, so both are stripped, and running what is left in
// this realm's global scope turns its declarations into globals. Collecting
// the names each file added gives back something shaped like a module.
//
// Shared is loaded first and bound to a global of that name, which is what
// the `.import "Shared.js" as Shared` line resolves to inside the QML engine.
// That is the whole of the emulation: everything else is the real file.
//
// Pattern borrowed from jkoestinger/omarchy-vpn's own tests/harness.js — this
// is the generic loader shape for testing a `.pragma library` model file
// outside the QML engine, not anything specific to VPN backends.

const fs = require("fs")
const path = require("path")
const vm = require("vm")
const assert = require("assert")

const MODEL = path.join(__dirname, "..", "model")

function load(file) {
  const source = fs.readFileSync(path.join(MODEL, file), "utf8")
    .replace(/^\s*\.pragma\s+library\s*$/m, "")
    .replace(/^\s*\.import\s+.*$/gm, "")

  const before = new Set(Object.getOwnPropertyNames(globalThis))
  vm.runInThisContext(source, { filename: "model/" + file })

  const namespace = {}
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (!before.has(name)) namespace[name] = globalThis[name]
  }
  return namespace
}

const Shared = load("Shared.js")
globalThis.Shared = Shared

const namespaces = { Shared: Shared }
for (const file of fs.readdirSync(MODEL).sort()) {
  if (!file.endsWith(".js") || file === "Shared.js") continue
  namespaces[path.basename(file, ".js")] = load(file)
}

let passed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push({ name: name, error: error })
  }
}

function report() {
  for (const failure of failures) {
    console.error("FAIL  " + failure.name)
    console.error("      " + String(failure.error.message).split("\n").join("\n      "))
  }
  console.log(`${passed} passed, ${failures.length} failed`)
  return failures.length === 0 ? 0 : 1
}

module.exports = Object.assign({
  test: test,
  eq: assert.deepStrictEqual,
  report: report,
}, namespaces)
