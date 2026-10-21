// Open-and-prefill destinations: the app opens with the details filled in and the person finishes there. Nothing is
// written by Recast, so there is nothing to confirm, check or undo, and the product says "opened", never "added".
// Pure: no network code. The URL is built from what the review showed (dataMoved) and nothing else, on a fixed host.
import type { Bridge, CapabilityContract, Operation, OperationCapabilities } from "@recast/core";
import { checkContract } from "@recast/core";
import { CONTRACTS } from "./contracts";
import { DestinationError, moved } from "./http";

export interface LinkSpec { contract: CapabilityContract; url(op: Operation): string }

const placeOf = (op: Operation) => {
  const q = [moved(op, "Location.name"), moved(op, "Location.address")].filter(Boolean).join(", ");
  if (!q) throw new DestinationError("missing Location.name or Location.address");
  return q;
};

export const googleMapsDirections: LinkSpec = {
  contract: CONTRACTS.googleMaps,
  // Google's documented Maps URL (api=1): directions to a destination from wherever the person is.
  url: (op) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(placeOf(op))}`,
};
export const appleMapsDirections: LinkSpec = {
  contract: CONTRACTS.appleMaps,
  url: (op) => `https://maps.apple.com/?daddr=${encodeURIComponent(placeOf(op))}`,
};

export const LINKS: readonly LinkSpec[] = [googleMapsDirections, appleMapsDirections];
/** The link spec for a destination id, if that destination opens an app instead of writing. */
export const linkFor = (destination: string) => LINKS.find((l) => l.contract.destination === destination);

/** What every open-and-prefill operation declares: it writes nothing, cannot be checked, and has nothing to undo. */
export const OPEN_ONLY: OperationCapabilities = { writes: false, idempotency: "not-applicable", verifiable: false, reversal: "none", onTimeout: "safe-to-retry", permission: "none" };

/**
 * A core Bridge for a link destination. `open` is how the host opens the URL; a host that already opened it from the
 * person's own click (so the browser allows the new tab) passes nothing, and this only records what was opened.
 */
export class LinkBridge implements Bridge {
  constructor(private spec: LinkSpec, private open?: (url: string) => void) {}
  describe() { return checkContract(this.spec.contract); }
  capabilities(): OperationCapabilities { return OPEN_ONLY; }
  async execute(op: Operation) { const url = this.spec.url(op); this.open?.(url); return { ref: url }; }
  async undo(): Promise<void> { throw new DestinationError(`${this.spec.contract.app} was only opened; there is nothing for Recast to undo`); }
}
