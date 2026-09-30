import type { Bridge, CapabilityContract, Operation, Receipt } from "@recast/core";

/**
 * A real in-memory destination. It applies each operation to actual state and can really reverse it.
 * It is a reference implementation for exercising the core, not a stand-in for any real app.
 */
export class ReferenceBridge implements Bridge {
  state: string[] = [];
  constructor(private readonly contract: CapabilityContract) {}
  describe(): CapabilityContract { return this.contract; }
  async execute(op: Operation): Promise<{ ref: string }> {
    const line = [op.proposal.effect, ...op.dataMoved.map((d) => d.value)].join("|");
    this.state.push(line);
    return { ref: line };
  }
  async undo(receipt: Receipt): Promise<void> {
    const i = this.state.lastIndexOf(receipt.bridgeRef ?? "");
    if (i >= 0) this.state.splice(i, 1);
  }
}
