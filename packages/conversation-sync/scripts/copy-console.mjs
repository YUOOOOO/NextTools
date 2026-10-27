import { cpSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
const output = fileURLToPath(new URL("dist/console", root));
mkdirSync(fileURLToPath(new URL("dist", root)), { recursive: true });
rmSync(output, { recursive: true, force: true });
cpSync(fileURLToPath(new URL("src/console", root)), output, { recursive: true });
copyFileSync(new URL("src/console.html", root), new URL("dist/console.html", root));
