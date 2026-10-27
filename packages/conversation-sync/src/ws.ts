import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** One accepted WebSocket. Incoming frames are masked; outgoing frames are not. */
export class WsPeer {
  private buffer = Buffer.alloc(0);
  onMessage: (text: string) => void = () => undefined;
  onClose: () => void = () => undefined;
  closed = false;

  constructor(private readonly socket: Duplex, head: Buffer) {
    if (head.length) this.buffer = Buffer.from(head);
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on("close", () => this.markClosed());
    socket.on("error", () => this.markClosed());
    this.drain();
  }

  send(text: string): void {
    if (this.closed) return;
    const payload = Buffer.from(text);
    let header: Buffer;
    if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
    else if (payload.length < 65536) header = Buffer.from([0x81, 126, (payload.length >> 8) & 0xff, payload.length & 0xff]);
    else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeUInt32BE(payload.length, 6);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    const message = Buffer.from(reason).subarray(0, 123);
    const payload = Buffer.alloc(2 + message.length);
    payload.writeUInt16BE(code);
    message.copy(payload, 2);
    this.markClosed();
    this.socket.end(Buffer.concat([Buffer.from([0x88, payload.length]), payload]), () => this.socket.destroy());
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  private drain(): void {
    while (this.buffer.length >= 2) {
      const opcode = this.buffer[0] & 0x0f;
      const lengthByte = this.buffer[1] & 0x7f;
      let offset = 2;
      let length = lengthByte;
      if (lengthByte === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (lengthByte === 127) {
        if (this.buffer.length < 10) return;
        length = this.buffer.readUInt32BE(6);
        offset = 10;
      }
      const masked = (this.buffer[1] & 0x80) !== 0;
      if (this.buffer.length < offset + (masked ? 4 : 0) + length) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      }
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        continue;
      }
      if (opcode === 0x1) this.onMessage(payload.toString("utf8"));
    }
  }
}

/** Accept `Upgrade: websocket` and return a peer, or destroy the socket. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer): WsPeer | null {
  const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
  const key = req.headers["sec-websocket-key"];
  if (upgrade !== "websocket" || typeof key !== "string" || !key) {
    socket.destroy();
    return null;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return new WsPeer(socket, head);
}
