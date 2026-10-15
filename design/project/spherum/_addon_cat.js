
const ADDONS = [
  ['crm', 'Vender', 'filter_alt', 'CRM com funil e playbooks', 'Funil de vendas, follow-ups e playbooks prontos.', 79, null, 0, 1, 0, ''],
  ['score', 'Vender', 'star_rate', 'Pontuação de leads', 'Nota automática para cada lead e aviso dos mais quentes.', 39, null, 0, 1, 0, 'Pontuação de leads'],
  ['prop', 'Vender', 'contract_edit', 'Propostas e contratos com assinatura', 'Propostas ilimitadas com aditivos e assinatura digital.', 59, null, 0, 1, 0, ''],
  ['pros', 'Vender', 'person_search', '+1.000 contatos de prospecção', 'Puxe contatos de grupos de WhatsApp e do Instagram.', 89, 'pacote', 0, null, 10, ''],
  ['disp', 'Vender', 'campaign', 'Disparos com variação de mensagem', 'A mesma mensagem de vários jeitos, com intervalos seguros.', 99, null, 1, 2, 0, ''],
  ['fin', 'Entregar', 'payments', 'Financeiro, cobranças e notas', 'Cobrança recorrente, boletos, Pix e notas fiscais.', 69, null, 0, 1, 0, ''],
  ['pub', 'Entregar', 'send', 'Publicar no Meta e aprovar criativos', 'Agende posts e o cliente aprova pelo celular.', 59, null, 0, 1, 0, 'Publicação direta no Meta'],
  ['dre', 'Entregar', 'account_balance', 'DRE e rentabilidade por cliente', 'Quanto cada cliente dá de lucro, mês a mês.', 49, null, 0, 1, 0, 'DRE'],
  ['studio', 'Entregar', 'imagesmode', '+50 peças no Estúdio', 'Imagens criadas com a IA do Estúdio.', 49, 'pacote', 0, null, 10, ''],
  ['video', 'Entregar', 'movie', '+10 vídeos no Estúdio', 'Vídeos curtos para Reels e anúncios.', 59, 'pacote', 1, null, 10, ''],
  ['radar', 'Entregar', 'radar', 'Radar de risco de cancelamento', 'Avisa antes de um cliente pensar em sair.', 79, null, 1, 2, 0, ''],
  ['brand', 'Sua marca', 'palette', 'Portal e relatórios com sua marca', 'Logo e cores da agência para o cliente.', 49, null, 0, 1, 0, ''],
  ['domain', 'Sua marca', 'language', 'Portal no seu próprio domínio', 'O cliente acessa em portal.suaagencia.com.br.', 39, null, 1, 2, 0, ''],
  ['appb', 'Sua marca', 'smartphone', 'App com a marca da agência', 'App de celular com o nome e o ícone da agência.', 199, null, 2, 3, 0, ''],
  ['chat', 'Equipe', 'chat', 'Chat da equipe', 'Canais por assunto e por cliente.', 29, null, 0, 1, 0, 'Chat da equipe'],
  ['acad', 'Equipe', 'school', 'Academy e onboarding', 'Trilhas, processos e entrada de quem chega.', 39, null, 0, 1, 0, 'Academy'],
  ['auto', 'Equipe', 'bolt', 'Automações', 'Regras que fazem o trabalho repetido sozinhas.', 59, null, 0, 1, 0, 'Automações'],
  ['tk', 'Equipe', 'support_agent', 'Chamados com prazo', 'Pedidos dos clientes com prazo e responsável.', 39, null, 1, 2, 0, 'Chamados com prazo'],
  ['gam', 'Equipe', 'military_tech', 'Conquistas da equipe', 'Pontos, emblemas e desafio do mês.', 29, null, 1, 2, 0, 'Conquistas da equipe'],
  ['xodo', 'Xodó', 'smart_toy', 'Xodó a mais', 'Um colega de IA com computador próprio.', 149, 'xodó', 0, null, 10, ''],
  ['seat', 'Capacidade', 'person_add', 'Pessoa a mais', 'Mais um acesso para a equipe.', 29, 'pessoa', 0, null, 20, ''],
  ['clients', 'Capacidade', 'group_add', '+5 clientes', 'Mais cinco clientes ativos.', 59, 'pacote', 0, null, 20, ''],
  ['storage', 'Capacidade', 'cloud', '+25 GB de armazenamento', 'Para arquivos, criativos e vídeos.', 19, 'pacote', 0, null, 20, ''],
  ['api', 'Segurança e dados', 'api', 'API e webhooks', 'Conecte o Spherum a outros sistemas.', 149, null, 2, 3, 0, ''],
  ['sso', 'Segurança e dados', 'key', 'Login único (SSO) e auditoria', 'Entrada com a conta da empresa e histórico de tudo.', 299, null, 3, 4, 0, '']
].map(a => ({ id: a[0], g: a[1], icon: a[2], n: a[3], d: a[4], price: a[5], unit: a[6], from: a[7], incl: a[8], max: a[9], gate: a[10] }));
const AD_PLAN_N = ['Solo', 'Agência', 'Escala', 'Rede', 'Empresarial'], AD_PLAN_P = [190, 490, 990, 1990, null];
const AD_GROUPS = ['Vender', 'Entregar', 'Sua marca', 'Equipe', 'Xodó', 'Capacidade', 'Segurança e dados'];
function adState(a, rk) { if (a.incl != null && rk >= a.incl) return 'incl'; if (rk < a.from) return 'lock'; return 'buy'; }
function adTotal(sel, rk, price) { return ADDONS.reduce((t, a) => { const q = sel[a.id] || 0; return adState(a, rk) === 'buy' && q ? t + price(a.price) * q : t; }, 0); }
function adNudge(sel, rk, price) {
  if (rk >= 3) return null; const T = adTotal(sel, rk, price), D = price(AD_PLAN_P[rk + 1]) - price(AD_PLAN_P[rk]);
  const inNext = ADDONS.filter(a => sel[a.id] && adState(a, rk) === 'buy' && a.incl != null && a.incl <= rk + 1);
  if (inNext.length < 2 || T < D * 0.6) return null;
  return { n: AD_PLAN_N[rk + 1], d: D, k: inNext.length, t: T, cheaper: T >= D };
}
