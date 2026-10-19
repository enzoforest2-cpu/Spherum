import type { Sql } from "../db";

/**
 * Captura automática da memória depois das conversas (contrato; a implementação completa
 * substitui este arquivo).
 */

export type CaptureRun = {
  id: string;
  xodo_id: string;
  agency_id: string;
  trigger: string;
  status: string;
  conversation_id: string | null;
};

/** Chamada quando uma execução termina: agenda a captura daquela janela de conversa. */
export async function enqueueCapture(sql: Sql, run: CaptureRun, now: Date): Promise<void> {
  void sql;
  void run;
  void now;
}
