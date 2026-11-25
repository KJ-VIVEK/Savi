import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export interface Device { id: number; name: string; pairedAt: string; seenAt: string }

export interface DeviceStore {
  devices(): Device[];
  addDevice(name: string, tokenHash: string): number;
  deviceByHash(tokenHash: string): number | undefined;
  seenDevice(id: number): void;
  removeDevice(id: number): void;
}

const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // without look-alikes
const LIFETIME = 10 * 60_000;
const ATTEMPTS = 5;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** One short-lived, single-use code; then a random token per device, stored only as a hash. */
export class Pairing {
  private open?: { code: string; until: number; left: number };
  private store: DeviceStore;
  constructor(store: DeviceStore) { this.store = store; }

  start() {
    const code = Array.from({ length: 8 }, () => LETTERS[randomInt(LETTERS.length)]).join("");
    this.open = { code, until: Date.now() + LIFETIME, left: ATTEMPTS };
    return code;
  }

  isOpen() { return this.open !== undefined && Date.now() < this.open.until; }

  /** The new device's token, or undefined. */
  redeem(code: string, name: string): string | undefined {
    if (!this.isOpen()) return undefined;
    const given = Buffer.from(hash(code.toUpperCase().replace(/[^A-Z0-9]/g, "")));
    if (!timingSafeEqual(given, Buffer.from(hash(this.open!.code)))) {
      if (--this.open!.left <= 0) this.open = undefined;
      return undefined;
    }
    this.open = undefined;
    const token = randomBytes(32).toString("base64url");
    this.store.addDevice(name, hash(token));
    return token;
  }

  device(token: string | undefined): number | undefined {
    return token ? this.store.deviceByHash(hash(token)) : undefined;
  }
}
