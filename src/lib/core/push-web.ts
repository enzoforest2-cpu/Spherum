import webpush from "web-push";
import type { PushSender } from "./push";

/** Envio Web Push (VAPID). Sem as chaves configuradas, o envio fica desligado. */
export function webPushSender(env: Record<string, string | undefined> = process.env): PushSender | null {
  const pub = env.VAPID_PUBLIC_KEY, priv = env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return null;
  webpush.setVapidDetails(env.VAPID_SUBJECT || "mailto:contato@spherum.com.br", pub, priv);
  return async (d, msg) => {
    try {
      await webpush.sendNotification({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, JSON.stringify(msg), { TTL: 3600, urgency: "normal" });
      return "ok";
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      // Inscrição cancelada no aparelho (app desinstalado, permissão tirada): some da lista.
      if (status === 404 || status === 410) return "gone";
      throw error;
    }
  };
}
