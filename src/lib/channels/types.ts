import type { Access, IntegrationDeps } from "../integrations/store";
import type { EngineDeps } from "../xodos/runner";

/**
 * Tipos dos canais de mensagens dos xodós (Slack, WhatsApp e Telegram).
 *
 * Cada plataforma tem um adaptador com duas pontas: a rota de entrada (verifica a assinatura,
 * lê o evento e chama receiveMessage) e o envio (send), usado pela fila de entrega.
 */

/** Canal da conversa e da identidade da pessoa. */
export type ChannelKind = "slack" | "whatsapp" | "telegram";

/** Tipo da conexão em integration_connections (o WhatsApp tem a API oficial e o QR Code). */
export type ChannelProvider = "slack" | "whatsapp_cloud" | "whatsapp_qr" | "telegram";

export const CHANNEL_OF: Record<ChannelProvider, ChannelKind> = {
  slack: "slack",
  whatsapp_cloud: "whatsapp",
  whatsapp_qr: "whatsapp",
  telegram: "telegram",
};

export const CHANNEL_LABEL: Record<ChannelKind, string> = { slack: "Slack", whatsapp: "WhatsApp", telegram: "Telegram" };

/** Motor com as integrações ligadas (os canais precisam delas para responder). */
export type ChannelDeps = EngineDeps & { integrations: Omit<IntegrationDeps, "sql" | "now"> };

export function integrationDepsOf(deps: ChannelDeps): IntegrationDeps {
  return { ...deps.integrations, sql: deps.sql, now: deps.now };
}

/** Mensagem recebida, já verificada e traduzida pelo adaptador. */
export type InboundMessage = {
  provider: ChannelProvider;
  connectionId: string;
  agencyId: string;
  /** Id do evento na plataforma, para não processar duas vezes (event_id, wamid, update_id…). */
  eventId: string;
  /** Quem mandou. Slack: "time:usuário"; WhatsApp: número; Telegram: id do usuário. */
  externalUser: string;
  displayName?: string | null;
  /** Identifica a conversa dentro do canal. Slack: "canal:thread"; WhatsApp: número; Telegram: chat. */
  conversationKey: string;
  /** Slack: id do canal, para escolher o xodó daquele canal. */
  scope?: string;
  text: string;
  /** Para onde responder (vai para xodo_conversations.metadata e para o envio). */
  reply: Record<string, unknown>;
  /** Mensagem direta (não um canal com várias pessoas). */
  direct: boolean;
};

export type InboundStatus =
  | "duplicate"
  | "ignored"
  | "unknown_sender"
  | "paired"
  | "decided"
  | "started"
  | "busy"
  | "no_xodo"
  | "failed";

export type InboundResult = { status: InboundStatus; runId?: string; detail?: string };

/** Pedido de aprovação que vira botão (ou "aprovar N" por texto) no canal. */
export type OutboundApproval = { actionId: string; summary: string; index: number };

export type SendContext = {
  deps: IntegrationDeps;
  access: Access;
  /** Para onde mandar (o reply da mensagem recebida). */
  target: Record<string, unknown>;
  /** Nome do xodó que fala (o Slack mostra como autor da mensagem); nulo nas respostas do sistema. */
  xodoName: string | null;
};

export type ChannelAdapter = {
  provider: ChannelProvider;
  /** Tamanho máximo de uma mensagem; textos maiores são divididos antes de chegar ao send. */
  maxChars: number;
  /** Manda um pedaço de texto; os pedidos de aprovação vêm no último pedaço. */
  send(ctx: SendContext, message: { text: string; approvals: OutboundApproval[] }): Promise<void>;
};

export type Adapters = Partial<Record<ChannelProvider, ChannelAdapter>>;

export class ChannelError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
