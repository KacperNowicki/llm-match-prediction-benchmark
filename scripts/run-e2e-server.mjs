import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const dataDir = path.join(root, "data");
const dbPath = path.join(dataDir, "playwright.sqlite");
const safetyPath = path.join(dataDir, "playwright.safety.sqlite");
const node = process.execPath;
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const viteCli = path.join(root, "node_modules", "vite", "bin", "vite.js");

mkdirSync(dataDir, { recursive: true });
for (const file of [dbPath, safetyPath, `${dbPath}-wal`, `${dbPath}-shm`, `${safetyPath}-wal`, `${safetyPath}-shm`]) {
  if (existsSync(file)) {
    rmSync(file, { force: true });
  }
}

const env = {
  ...process.env,
  NODE_ENV: "test",
  LOLPH_API_PORT: "8788",
  LOLPH_DB_PATH: dbPath,
  LOLPH_SAFETY_DB_PATH: safetyPath
};

const children = [
  spawn(node, [tsxCli, "server/index.ts"], { cwd: root, env, stdio: "inherit" }),
  spawn(node, [viteCli, "--host", "127.0.0.1", "--port", "5173"], { cwd: root, env, stdio: "inherit" })
];

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(code), 250).unref();
};

for (const child of children) {
  child.on("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
