/** Erro esperado do motor: as rotas respondem com a mensagem e o status dele. */
export class XodoError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
