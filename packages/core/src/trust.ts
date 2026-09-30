// Trust model: every operation gets a risk tier and a required consent. Pure function of its inputs.
import type { ConsentKind, EffectFlag, Reliability, RiskAssessment, RiskTier } from "./types.js";
import { RISK_ORDER } from "./rules.js";

export const LOW_CONFIDENCE = 0.5;
export const MEDIUM_CONFIDENCE = 0.75;
export const HOLD_MS = 600;

export const RELIABILITY_LABEL: Record<Reliability, string> = {
  native: "Native integration",
  "official-api": "Official API",
  "structured-interface": "Structured system interface",
  "deep-link": "Deep link / import",
  "ui-automation": "UI automation (fragile)",
  unsupported: "Unsupported",
};
const HIGH_FLAGS: EffectFlag[] = ["send", "delete", "publish", "financial", "modifies-important"];
const CONSENT: Record<RiskTier, ConsentKind> = { low: "release", medium: "confirm", high: "hold" };

export interface RiskInput {
  baseRisk: RiskTier; flags: readonly EffectFlag[]; reversible: boolean; confidence: number; reliability: Reliability;
}

export function assessRisk(i: RiskInput): RiskAssessment {
  let tier = i.baseRisk;
  const reasons: string[] = [`relation base risk: ${i.baseRisk}`];
  const raise = (to: RiskTier, why: string) => { if (RISK_ORDER[to] > RISK_ORDER[tier]) tier = to; reasons.push(why); };
  const hi = i.flags.filter((f) => HIGH_FLAGS.includes(f));
  if (hi.length) raise("high", `effect is ${hi.join(", ")}`);
  if (i.flags.includes("notifies-third-party")) raise("medium", "notifies someone else");
  if (!i.reversible) raise("medium", "cannot be undone");
  if (i.reliability === "ui-automation") raise("medium", "destination is driven by fragile UI automation");
  if (i.confidence < MEDIUM_CONFIDENCE) raise("medium", `confidence ${i.confidence.toFixed(2)} is below ${MEDIUM_CONFIDENCE}`);
  return { tier, consent: CONSENT[tier], requiresDeliberateChoice: i.confidence < LOW_CONFIDENCE, reasons };
}
