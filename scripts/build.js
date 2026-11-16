const fs = require("node:fs/promises");
const path = require("node:path");

const root = path.join(__dirname, "..");
const source = path.join(root, "public");
const output = path.join(root, "dist");

async function build() {
  await fs.mkdir(output, { recursive: true });
  await fs.cp(source, output, { recursive: true });
  console.log("Build complete: static app copied to dist.");
}

build().catch((error) => {
  console.error("Build failed:", error);
  process.exitCode = 1;
});
