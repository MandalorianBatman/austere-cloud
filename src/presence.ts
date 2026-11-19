// Presence v1 (docs/hosted-share-links.md in austere-axi, "Presence (Q17)"): who is on the page,
// their status and the statement they last clicked. Lives in socket attachments only; never in
// the op log, the rows or the row feed. The page object owns the sockets; this file holds the
// rules that need no socket.
import { LIMITS } from "austere-axi/sync";
import type { PresenceStatus, Role } from "austere-axi/sync";

/** A viewer's state, kept in its socket's attachment so it survives hibernation. */
export interface ViewerState {
  id: string;
  name: string;
  colour: string;
  role: Role;
  status: PresenceStatus;
  focus: string | null;
  /** Epoch ms of the socket's last frame. */
  last: number;
  /** Silent for EXPIRE_MS: the others got `bye`. The next frame brings it back. */
  gone?: boolean;
}

/** A viewer silent this long gets a `bye` to the others. Clients send `status` at least every 30 s. */
export const EXPIRE_MS = 60_000;
/** Presence frames per second per socket; more are dropped. */
export const FRAMES_PER_SECOND = 10;

// White text reads on each; the chrome only displays them.
const PALETTE = ["#e5484d", "#f76b15", "#9e7c00", "#46a758", "#12a594", "#0090ff", "#3e63dd", "#8e4ec6", "#d6409f", "#978365"];

/**
 * A name's colour: from a hash of the name, so the same name gets the same colour, moved on to
 * the next free one when another viewer present already has it (`taken`).
 */
export function colourFor(name: string, taken: ReadonlySet<string> = new Set()): string {
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  const start = (h >>> 0) % PALETTE.length;
  for (let i = 0; i < PALETTE.length; i++) {
    const c = PALETTE[(start + i) % PALETTE.length];
    if (!taken.has(c)) return c;
  }
  return PALETTE[start];
}

/** Names nobody but the owner goes by on a hosted page (the local server reserves the same ones). */
const RESERVED = new Set(["owner", "you", "agent", "me", "render check"]);

export function reservedName(name: string): boolean {
  return RESERVED.has(name.trim().toLowerCase());
}

/** A self-declared name: trimmed, at most LIMITS.nameChars characters, `Reviewer` when empty or reserved. */
export function declaredName(name: string | undefined): string {
  const n = [...(name ?? "").trim()].slice(0, LIMITS.nameChars).join("");
  return n && !reservedName(n) ? n : "Reviewer";
}

/**
 * The roster name of a socket: `Owner` (the owner socket, or a reviewer socket the owner's sign-in
 * session let in); an invited reviewer's invite name; on the open link the name prompt's
 * `hello.name` (`declaredName`). `assigned` is the server-set name, if any.
 */
export function viewerName(role: Role, assigned: string | undefined, declared: string | undefined): string {
  if (role === "owner") return "Owner";
  return assigned ?? declaredName(declared);
}
