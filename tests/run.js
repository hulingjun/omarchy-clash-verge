// node tests/run.js
//
// No dependencies, no test framework: the plugin ships no package.json and
// is not built. Every tests/model/*.test.js file is picked up automatically.

const fs = require("fs")
const path = require("path")
const harness = require("./harness.js")

const dir = path.join(__dirname, "model")
const files = fs.readdirSync(dir).filter(name => name.endsWith(".test.js")).sort()

if (files.length === 0) {
  console.error("no test files found in tests/model/")
  process.exit(1)
}

for (const file of files) require(path.join(dir, file))

process.exit(harness.report())
