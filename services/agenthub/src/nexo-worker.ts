import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { HubError } from "./types.js";

const execute = promisify(execFile);
const running = new Map<string, { name: string; child?: ChildProcess }>();
export interface WorkerInput {
  prompt: string;
  apiKey: string;
  model: string;
  resume?: string;
}
export interface WorkerEvent {
  type: "assistant" | "tool" | "result" | "session";
  text?: string;
  name?: string;
  sessionId?: string;
  success?: boolean;
}

/** Only the trusted control plane talks to Docker. Worker containers never receive its socket or host mounts. */
export async function runNexoWorker(
  accountId: string,
  input: WorkerInput,
  onEvent: (event: WorkerEvent) => void,
): Promise<void> {
  if (running.has(accountId)) throw new HubError("NEXO_ACCOUNT_BUSY", 409);
  if (running.size >= 16) throw new HubError("NEXO_WORKER_CAPACITY", 503);
  const image = process.env.AGENTHUB_NEXO_WORKER_IMAGE;
  if (!image) throw new HubError("NEXO_WORKER_UNCONFIGURED", 503);
  const name = `nexo-${randomUUID()}`;
  const volume = `nexttools-nexo-${accountId}`;
  running.set(accountId, { name });
  let child: ReturnType<typeof spawn> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    child = spawn(
      "docker",
      [
        "run",
        "--rm",
        "--interactive",
        "--name",
        name,
        "--label",
        "nexttools.owner=nexo",
        "--label",
        `nexttools.account=${accountId}`,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--memory=1g",
        "--memory-swap=1g",
        "--cpus=1",
        "--pids-limit=128",
        "--user=1000:1000",
        "--tmpfs=/tmp:rw,noexec,nosuid,size=128m,mode=1777",
        "--mount",
        `type=volume,source=${volume},target=/workspace`,
        "--network",
        process.env.AGENTHUB_NEXO_WORKER_NETWORK ?? "bridge",
        image,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          DOCKER_HOST: process.env.DOCKER_HOST,
          DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
          HOME: process.env.HOME,
          USERPROFILE: process.env.USERPROFILE,
        },
      },
    );
    running.set(accountId, { name, child });
    const worker = child;
    const stdin = worker.stdin,
      stdout = worker.stdout,
      stderr = worker.stderr;
    if (!stdin || !stdout || !stderr)
      throw new HubError("NEXO_WORKER_UNAVAILABLE", 503);
    let buffered = "",
      total = 0,
      terminal = false,
      timedOut = false;
    let failure: unknown;
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        void execute("docker", ["rm", "--force", name], {
          timeout: 15000,
        }).catch(() => {});
        worker.kill();
      }, 10 * 60_000);
      worker.on("error", () =>
        reject(new HubError("NEXO_WORKER_UNAVAILABLE", 503)),
      );
      stdin.on("error", () => {});
      stderr.resume();
      stdout.setEncoding('utf8');
      stdout.on("data", (chunk: string) => {
        total += Buffer.byteLength(chunk);
        if (total > 2_000_000) {
          failure = new HubError('NEXO_MESSAGE_TOO_LARGE', 413);
          worker.kill();
          return;
        }
        if (failure) return;
        buffered += chunk;
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          let event: WorkerEvent;
          try {
            event = JSON.parse(line) as WorkerEvent;
          } catch {
            continue;
          }
          if (!["assistant", "tool", "result", "session"].includes(event.type))
            continue;
          if (event.type === "result") terminal = event.success === true;
          try {
            onEvent(event);
          } catch (error) {
            failure = error;
            worker.kill();
            return;
          }
        }
      });
      worker.on("close", (code) => {
        if (timedOut) reject(new HubError("NEXO_WORKER_TIMEOUT", 504));
        else if (failure) reject(failure);
        else if (code !== 0 || !terminal)
          reject(new HubError("NEXO_WORKER_FAILED", 502));
        else resolve();
      });
      stdin.end(JSON.stringify(input));
    });
  } finally {
    clearTimeout(timeout);
    await execute("docker", ["rm", "--force", name], { timeout: 15000 }).catch(
      () => {},
    );
    running.delete(accountId);
  }
}

/** Stop every active worker before account databases are closed during shutdown. */
export async function stopNexoWorkers(): Promise<void> {
  await Promise.all(
    [...running.values()].map(async ({ name, child }) => {
      child?.kill();
      await execute("docker", ["rm", "--force", name], {
        timeout: 15000,
      }).catch(() => {});
    }),
  );
}
