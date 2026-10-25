import { randomBytes } from "node:crypto";

/**
 * Sortable, collision-resistant id: <prefix>_<base36 ms><8 hex>.
 * Minted session-side so `slack-ask` can print the question id and exit
 * without a round trip to the daemon.
 */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}
