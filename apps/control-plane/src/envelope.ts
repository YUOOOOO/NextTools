import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";

export const envelopeSchema = z
  .object({
    id: z.uuid(),
    source: z.uuid(),
    target: z.uuid(),
    workspace: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w.-]+$/),
    channel: z.enum(["sync", "control", "event"]),
    operation: z.enum([
      "snapshot",
      "session.view",
      "session.prompt",
      "session.stop",
      "approval.respond",
      "result",
      "agent.event",
    ]),
    expires: z.number().int().nonnegative(),
    nonce: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
    ciphertext: z
      .string()
      .min(24)
      .max(4_000_000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    signature: z.string().max(128),
  })
  .strict();
export type Envelope = z.infer<typeof envelopeSchema>;
export function signedText(e: Omit<Envelope, "signature">) {
  return [
    "v1",
    e.channel,
    e.id,
    e.source,
    e.target,
    e.workspace,
    e.operation,
    e.expires,
    e.nonce,
    e.ciphertext,
  ].join("\n");
}
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export function validSignature(key: string, text: string, signature: string) {
  try {
    const raw = Buffer.from(key, "base64");
    if (raw.length !== 32) return false;
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      Buffer.from(text),
      publicKey,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}
