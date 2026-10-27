import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const REMOTE_ACTIONS = ["shell", "files", "file.get", "file.put", "open", "screen"];
const OUTPUT_LIMIT = 200_000;
const FILE_LIMIT = 8 * 1024 * 1024;
const ENTRY_LIMIT = 2000;

export function expand(path, home = homedir()) {
  let value = String(path ?? "").trim() || "~";
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) value = join(home, value.slice(1));
  return resolve(isAbsolute(value) ? value : join(home, value));
}

export function remoteSummary(action, args = {}) {
  if (action === "shell") return String(args.command ?? "").slice(0, 500);
  if (action === "file.put") return `${String(args.path ?? "")} (${Number(args.content?.length ?? 0)} chars)`;
  if (action === "screen") return "screenshot";
  return String(args.path ?? "~").slice(0, 500);
}

export async function runRemoteAction(action, args = {}, deps = {}) {
  if (action === "shell") return shell(args);
  if (action === "files") return files(args);
  if (action === "file.get") return fileGet(args);
  if (action === "file.put") return filePut(args);
  if (action === "open") return openPath(args, deps);
  if (action === "screen") {
    if (typeof deps.capture !== "function") throw new Error("screen_unavailable");
    return deps.capture();
  }
  throw new Error(`unknown action ${action}`);
}

async function shell(args) {
  const command = typeof args.command === "string" ? args.command : "";
  if (!command.trim()) throw new Error("a command is required");
  const requested = Number(args.timeout);
  const timeoutS = Math.max(1, Math.min(Number.isFinite(requested) && requested > 0 ? requested : 120, 900));
  const cwd = typeof args.cwd === "string" && args.cwd.trim() ? expand(args.cwd) : undefined;
  const file = process.platform === "win32" ? (process.env.COMSPEC || "cmd.exe") : (process.env.SHELL || "/bin/sh");
  const argv = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
  const started = Date.now();
  return new Promise((done) => {
    let child;
    try {
      child = spawn(file, argv, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      done({ exit_code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error), timed_out: false, duration_ms: 0 });
      return;
    }
    const chunks = [];
    let bytes = 0;
    const push = (chunk) => {
      if (bytes >= OUTPUT_LIMIT) return;
      const kept = chunk.subarray(0, OUTPUT_LIMIT - bytes);
      chunks.push(kept);
      bytes += kept.length;
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutS * 1000);
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString("utf8");
      done({ exit_code: timedOut ? 124 : (code ?? 1), stdout: text, stderr: "", timed_out: timedOut, duration_ms: Date.now() - started });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ exit_code: 127, stdout: "", stderr: error.message, timed_out: false, duration_ms: Date.now() - started });
    });
  });
}

async function files(args) {
  const path = expand(args.path);
  const info = await stat(path).catch(() => null);
  if (!info) throw new Error(`${path} does not exist`);
  if (!info.isDirectory()) {
    return { path, entries: [{ name: basename(path), type: "file", size: info.size, mtime: Math.floor(info.mtimeMs / 1000) }] };
  }
  const names = await readdir(path);
  const entries = [];
  for (const name of names.slice(0, ENTRY_LIMIT)) {
    const child = await stat(join(path, name)).catch(() => null);
    if (!child) continue;
    entries.push({
      name,
      type: child.isDirectory() ? "dir" : "file",
      size: child.size,
      mtime: Math.floor(child.mtimeMs / 1000),
    });
  }
  entries.sort((left, right) => Number(right.type === "dir") - Number(left.type === "dir") || left.name.localeCompare(right.name));
  return { path, entries, truncated: names.length > ENTRY_LIMIT };
}

async function fileGet(args) {
  const path = expand(args.path);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${path} is not a file`);
  if (info.size > FILE_LIMIT) throw new Error("file is larger than 8 MB");
  const body = await readFile(path);
  return { path, size: body.length, encoding: "base64", content: body.toString("base64") };
}

async function filePut(args) {
  const path = expand(args.path);
  const content = Buffer.from(String(args.content ?? ""), args.encoding === "base64" ? "base64" : "utf8");
  if (content.length > FILE_LIMIT) throw new Error("file is larger than 8 MB");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return { path, size: content.length };
}

async function openPath(args, deps) {
  const path = expand(args.path);
  if (typeof deps.open === "function") {
    const error = await deps.open(path);
    if (error) throw new Error(String(error));
    return { path, opened: true };
  }
  const file = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const argv = process.platform === "win32" ? ["/d", "/s", "/c", "start", "", path] : [path];
  spawn(file, argv, { windowsHide: true, stdio: "ignore", detached: true }).unref();
  return { path, opened: true };
}
