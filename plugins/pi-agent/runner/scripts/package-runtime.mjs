import { access, copyFile, mkdir, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRunner } from "./build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeDirectory = resolve(here, "../dist/agent-runtime");
const sourceNode = process.env.NEXTTOOLS_NODE_BINARY || process.execPath;
const nodeName = process.platform === "win32" ? "node.exe" : "node";
const licensesDirectory = resolve(here, "../licenses");
const adjacentNodeLicense = resolve(dirname(sourceNode), "LICENSE");
let sourceNodeLicense = process.env.NEXTTOOLS_NODE_LICENSE || adjacentNodeLicense;

try {
  await access(sourceNodeLicense);
} catch {
  if (process.env.NEXTTOOLS_NODE_LICENSE || sourceNode !== process.execPath) {
    throw new Error("Set NEXTTOOLS_NODE_LICENSE to the LICENSE file for the packaged Node binary");
  }
  sourceNodeLicense = resolve(licensesDirectory, `LICENSE.node-${process.version}`);
  await access(sourceNodeLicense).catch(() => {
    throw new Error(`Set NEXTTOOLS_NODE_LICENSE to the official LICENSE for Node ${process.version}`);
  });
}

await rm(runtimeDirectory, { recursive: true, force: true });
await mkdir(runtimeDirectory, { recursive: true });
await buildRunner(runtimeDirectory);
await copyFile(sourceNode, resolve(runtimeDirectory, nodeName));
await copyFile(resolve(licensesDirectory, "LICENSE.percho"), resolve(runtimeDirectory, "LICENSE.percho"));
await copyFile(resolve(licensesDirectory, "LICENSE.pi"), resolve(runtimeDirectory, "LICENSE.pi"));
await copyFile(sourceNodeLicense, resolve(runtimeDirectory, "LICENSE.node"));

process.stderr.write(`Packaged ${basename(sourceNode)} and runner.mjs in ${runtimeDirectory}\n`);
