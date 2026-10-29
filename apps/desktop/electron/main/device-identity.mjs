/**
 * Identity this desktop presents to the cloud device list.
 *
 * The web console renders "name / kind · os · online", so `name` has to be the
 * computer name and `os` a readable label — never the Node platform id
 * ("win32"), which made every desktop look identical in that list.
 */

import { hostname, release } from "node:os";

const PRODUCT_NAME = "Pilot";
const MAX_NAME = 60;

/** Windows reports its kernel version; map the build number to a product name. */
function windowsLabel(version) {
  const build = Number(String(version ?? "").split(".")[2]);
  if (!Number.isFinite(build) || build <= 0) return "Windows";
  if (build >= 22000) return "Windows 11";
  return build >= 10240 ? "Windows 10" : "Windows";
}

/** Computer name shown in the web console; falls back to the product name. */
export function desktopDeviceName(computerName = hostname()) {
  const name = String(computerName ?? "").trim();
  return name ? name.slice(0, MAX_NAME) : PRODUCT_NAME;
}

/** Readable OS label instead of the Node platform id. */
export function desktopOsLabel(platform = process.platform, version = release()) {
  if (platform === "win32") return windowsLabel(version);
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  return String(platform ?? "");
}
