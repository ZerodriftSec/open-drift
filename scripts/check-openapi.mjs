import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const specPath = "public/openapi.json";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const execFileAsync = promisify(execFile);

const previousSpec = await readFile(specPath, "utf8").catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});

await execFileAsync(pnpm, ["run", "openapi:generate"]);

const generatedSpec = await readFile(specPath, "utf8");
const tracked = await execFileAsync("git", [
  "ls-files",
  "--error-unmatch",
  specPath,
])
  .then(() => true)
  .catch(() => false);

if (tracked && previousSpec === generatedSpec) {
  process.exit(0);
}

console.error(`${specPath} is out of date or missing from version control.`);
console.error(`Run "pnpm openapi:generate" and commit ${specPath}.`);

const { stdout: diff } = await execFileAsync("git", ["diff", "--", specPath]);
process.stderr.write(diff);
process.exit(1);
