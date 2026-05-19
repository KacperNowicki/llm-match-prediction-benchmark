export const CONSENSUS_MODEL_ID = "derived_consensus";
export const CONSENSUS_MODEL_NAME = "Consensus";

export function isConsensusModelName(value: string | null | undefined): boolean {
  return value?.trim().toLowerCase() === "consensus";
}
