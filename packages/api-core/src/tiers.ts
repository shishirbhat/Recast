export type Tier = "free" | "pro" | "scale" | "enterprise";
export interface TierLimits { rps: number; burst: number; monthly: number }
/** Starting values from the pricing plan. Configuration, not law: change them here. */
export const TIERS: Record<Tier, TierLimits> = {
  free: { rps: 10, burst: 20, monthly: 1_000 },
  pro: { rps: 100, burst: 200, monthly: 50_000 },
  scale: { rps: 500, burst: 1_000, monthly: 500_000 },
  enterprise: { rps: 2_000, burst: 4_000, monthly: Number.MAX_SAFE_INTEGER },
};
