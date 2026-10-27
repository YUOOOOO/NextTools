import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/** Per-installation identity, retained across sign-out and account changes. */
export function loadOrCreateSyncDeviceId(filePath) {
  const read = () => {
    const id = readFileSync(filePath, "utf8").trim();
    if (!/^computer-[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid conversation sync device id");
    return id;
  };
  try { return read(); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const id = `computer-${randomUUID()}`;
  try { writeFileSync(filePath, id + "\n", { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error?.code === "EEXIST") return read(); throw error; }
  return id;
}
