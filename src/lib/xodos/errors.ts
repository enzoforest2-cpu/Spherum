/**
 * Erro esperado do motor: as rotas respondem com a mensagem e o status dele. O código (opcional)
 * vai junto na resposta, para a tela reagir sem depender do texto (ex.: "mfa_required").
 */
export class XodoError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code?: string,
  ) {
    super(message);
  }
}
