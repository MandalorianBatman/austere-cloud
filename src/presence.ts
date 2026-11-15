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

// Readable on the chrome's light and dark themes; the chrome only displays them.
const PALETTE = ["#e5484d", "#f76b15", "#ffc53d", "#46a758", "#12a594", "#0090ff", "#3e63dd", "#8e4ec6", "#d6409f", "#978365"];

/** A name's colour: the same name always gets the same colour. */
export function colourFor(name: string): string {
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  return PALETTE[(h >>> 0) % PALETTE.length];
}

/** A self-declared name: trimmed, at most LIMITS.nameChars characters, `Reviewer` when empty. */
export function declaredName(name: string | undefined): string {
  return [...(name ?? "").trim()].slice(0, LIMITS.nameChars).join("") || "Reviewer";
}

/**
 * The roster name of a socket. Until invites (RLM-314) a reviewer socket carries no name of its
 * own, so the name prompt's `hello.name` is used; an invited socket's invite name replaces it here.
 */
export function viewerName(role: Role, declared: string | undefined): string {
  return role === "owner" ? "Owner" : declaredName(declared);
}
