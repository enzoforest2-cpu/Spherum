import type { ChannelDeps } from "./types";

/**
 * Gatilhos por evento (rascunho do contrato; a implementação completa substitui este arquivo).
 */

/** Mensagem num canal do Slack (não menção): dispara os gatilhos "slack" daquele canal. Devolve quantos dispararam. */
export async function fireSlackTriggers(
  _deps: ChannelDeps,
  _input: { agencyId: string; connectionId: string; channel: string; user: string; text: string; ts: string; eventId: string },
): Promise<number> {
  return 0;
}
