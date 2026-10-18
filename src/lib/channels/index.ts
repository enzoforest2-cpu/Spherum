import { productionDeps } from "../xodos";
import { slackAdapter } from "./slack";
import { telegramAdapter } from "./telegram";
import type { Adapters, ChannelDeps } from "./types";
import { whatsappCloudAdapter } from "./whatsapp-cloud";
import { whatsappQrAdapter } from "./whatsapp-qr";

/** Adaptadores de produção de cada canal. */
export const ADAPTERS: Adapters = {
  slack: slackAdapter,
  whatsapp_cloud: whatsappCloudAdapter,
  whatsapp_qr: whatsappQrAdapter,
  telegram: telegramAdapter,
};

/** Dependências de produção dos canais (o motor com as integrações ligadas). */
export async function channelDeps(): Promise<ChannelDeps> {
  const deps = await productionDeps();
  if (!deps.integrations) throw new Error("Integrações indisponíveis.");
  return deps as ChannelDeps;
}
