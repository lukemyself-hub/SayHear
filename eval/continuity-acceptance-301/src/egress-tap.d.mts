export const OPENCODE_GO_ENDPOINT: string;
export const GATE_VARIABLE: string;
export function createTappedFetch(input: {
  gateUrl: string;
  original: typeof fetch;
}): typeof fetch;
