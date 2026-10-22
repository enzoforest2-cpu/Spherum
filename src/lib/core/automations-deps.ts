import { after } from "next/server";
import { sendWhatsappCloud } from "../channels/whatsapp-cloud";
import { continueRun, productionDeps, startRun } from "../xodos";
import type { Sql } from "../xodos/db";
import type { AutoDeps } from "./automations";
import { mailerFromEnv } from "./email";

/** Dependências das automações no servidor (e-mail, WhatsApp oficial e xodós). */
export async function automationDeps(sql: Sql, opts: { background?: boolean } = {}): Promise<AutoDeps> {
  const engine = await productionDeps(sql);
  const integrations = { sql, ...engine.integrations! };
  return {
    sql,
    mailer: mailerFromEnv(),
    whatsapp: (agencyId, connectionId, to, msg) => sendWhatsappCloud(integrations, agencyId, connectionId, to, msg),
    askXodo: async (agencyId, xodoId, text) => {
      const runId = await startRun(engine, { xodoId, agencyId, trigger: "event", text });
      const go = () => continueRun(engine, runId).catch((error) => console.error("[automacoes] xodó falhou", runId, error));
      if (opts.background) after(go); else await go();
      return runId;
    },
  };
}
