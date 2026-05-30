import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");

const processes = [
  spawn(process.execPath, ["--no-warnings", "server/index.js"], {
    cwd: rootDir,
    env: { ...process.env, PORT: process.env.PORT || "4100" },
    stdio: "inherit",
  }),
  spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5173", "--configLoader", "runner"],
    {
    cwd: rootDir,
    env: { ...process.env, VITE_API_URL: "" },
    stdio: "inherit",
    },
  ),
];

function stopAll(signal) {
  for (const child of processes) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

for (const child of processes) {
  child.on("exit", (code) => {
    if (code && code !== 0) {
      stopAll("SIGTERM");
      process.exitCode = code;
    }
  });
}

process.on("SIGINT", () => {
  stopAll("SIGINT");
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopAll("SIGTERM");
  process.exit(0);
});
