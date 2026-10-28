import { z } from "zod";
import { computerTool } from "../gateway";

/**
 * Pedir o controle: o xodó encerra o turno e espera uma pessoa fazer uma parte no computador
 * (login, captcha, algo que só ela pode decidir). Como o request_takeover do Rakazo.
 */
export const CONTROL_TOOLS = [
  computerTool({
    name: "pedir_controle",
    description:
      "Pede para alguém da equipe assumir o computador e fazer uma parte que só uma pessoa pode fazer (login, senha, captcha, pagamento, assinatura). Seu turno acaba aqui; quando a pessoa devolver, você continua de onde parou.",
    category: "equipe",
    part: "control",
    endsTurn: "takeover",
    input: z.object({ motivo: z.string().trim().min(1).max(280).describe("O que a pessoa precisa fazer, em uma frase") }),
    summarize: (i) => `pedir o controle: ${i.motivo}`,
    async run(_c, i) {
      return { aguardando_controle: true, motivo: i.motivo };
    },
  }),
];
