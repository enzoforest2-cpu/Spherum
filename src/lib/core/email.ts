/**
 * E-mail transacional pelo Resend (https://resend.com), só com fetch. Sem RESEND_API_KEY,
 * nada é enviado e a função devolve false: quem chama segue sem o e-mail (o dado já está salvo).
 */

export type EmailMessage = { to: string | string[]; subject: string; text: string; replyTo?: string };
export type Mailer = (message: EmailMessage) => Promise<boolean>;

export function mailerFromEnv(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Mailer {
  const key = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim() || "Spherum <nao-responda@spherum.com.br>";
  return async (message) => {
    if (!key) return false;
    try {
      const response = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          from,
          to: Array.isArray(message.to) ? message.to : [message.to],
          subject: message.subject.slice(0, 200),
          text: message.text,
          reply_to: message.replyTo,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) console.error("[email] o Resend respondeu", response.status);
      return response.ok;
    } catch (error) {
      console.error("[email] falhou", error instanceof Error ? error.message : error);
      return false;
    }
  };
}

/** E-mail do convite (equipe ou portal do cliente). O link vale 7 dias e uma vez. */
export function inviteEmail(o: { to: string; agency: string; link: string; client?: string | null }): EmailMessage {
  const where = o.client ? `o portal da ${o.client} na ${o.agency}` : `a equipe da ${o.agency}`;
  return {
    to: o.to,
    subject: o.client ? `Acesso ao portal da ${o.client}` : `Convite para a equipe da ${o.agency} no Spherum`,
    text: [
      `Olá! Você foi convidado para ${where} no Spherum.`,
      "",
      `Para entrar, abra o link abaixo e crie sua senha com este e-mail (${o.to}):`,
      o.link,
      "",
      "O link vale por 7 dias e só pode ser usado uma vez. Se não esperava este convite, ignore este e-mail.",
    ].join("\n"),
  };
}
