import { sendWhatsappCloud } from "../channels/whatsapp-cloud";
import type { IntegrationDeps } from "../integrations/store";
import type { SenderFor } from "./prospect";

/** Envio da prospecção pela conexão oficial do WhatsApp da agência. */
export const whatsappSender = (deps: IntegrationDeps): SenderFor => (agencyId, connectionId) => (to, message) => sendWhatsappCloud(deps, agencyId, connectionId, to, message);
