import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runnerRoot = resolve(here, "..");

export async function buildRunner(outputDirectory = resolve(runnerRoot, "dist")) {
  await mkdir(outputDirectory, { recursive: true });
  await build({
    entryPoints: [resolve(runnerRoot, "src/index.mjs")],
    outfile: resolve(outputDirectory, "runner.mjs"),
    bundle: true,
    nodePaths: [resolve(runnerRoot, "node_modules")],
    alias: {
      "@percho/shared": resolve(runnerRoot, "../../../vendor/percho/packages/shared/src/index.ts"),
    },
    platform: "node",
    format: "esm",
    target: "node22.19",
    packages: "bundle",
    sourcemap: false,
    minify: false,
    legalComments: "none",
    assetNames: "assets/[name]-[hash]",
    loader: {
      ".wasm": "file",
      ".png": "file",
      ".json": "json"
    },
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
    }
  });
  return resolve(outputDirectory, "runner.mjs");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await buildRunner();
