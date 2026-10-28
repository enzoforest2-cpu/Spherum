// Prefixos de chave, PEM, Bearer, KEY=VALUE, --token e senha em URL adaptados de shared/redact.ts do OpenMausBot, Apache-2.0.
/**
 * Limpeza de dados sensíveis antes de guardar (memória, entradas de ferramentas). O marcador é
 * sempre "[removido]" e limpar duas vezes dá o mesmo resultado (a segunda volta tira 0).
 *
 * Alta precisão de propósito: só formatos inconfundíveis (prefixo de provedor, estrutura,
 * dígito verificador) ou valores rotulados ("senha:", "chave pix:"). Telefone, e-mail, CNPJ,
 * endereço, R$, UUID sem rótulo, UTMs e IDs de campanha ficam como estão. Nenhuma regex tem
 * repetição aninhada sem limite: um texto de 50 KB passa em milissegundos.
 */

export const REDACTED = "[removido]";

type Hide = () => string;
/** Recebe os grupos (0 = trecho todo), quem conta o que saiu, a posição e o texto; devolve o trecho novo. */
type Fix = (g: string[], hide: Hide, at: number, input: string) => string;
type Rule = readonly [RegExp, Fix];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// ---------------------------------------------------------------------------------------------
// Formatos inconfundíveis: somem inteiros.

const KEY_PREFIXES: RegExp[] = [
  /\bsk-(?:ant-[A-Za-z0-9_-]{10,}|(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,})/g, // anthropic / openai
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // stripe secreta e restrita
  /\bwhsec_[A-Za-z0-9+/=]{24,}/g, // segredo de webhook do stripe
  /\bxai-[A-Za-z0-9_-]{20,}/g,
  /\bgsk_[A-Za-z0-9]{40,}/g, // groq
  /\bcsk-[A-Za-z0-9]{32,}/g, // cerebras
  /\bLLM\|\d{6,}\|[A-Za-z0-9_-]{16,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{20,}/g, // slack
  /\bxapp-[A-Za-z0-9-]{20,}/g, // slack, nível do app
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // aws
  /\bAIza[0-9A-Za-z_-]{30,}/g, // chave de api do google
  /\bya29\.[A-Za-z0-9_-]{20,}/g, // oauth do google
  /\b1\/\/[A-Za-z0-9_-]{30,}/g, // refresh do google
  /\bEAA[A-Za-z0-9]{60,}/g, // meta (facebook/instagram)
  /\b(?:APP_USR|TEST)-\d{4,24}-\d{2,12}-[a-f0-9]{32}-\d{3,16}\b/g, // mercado pago
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // sendgrid
  /(?<!\d)\d{6,12}:AA[A-Za-z0-9_-]{30,40}(?![A-Za-z0-9_-])/g, // bot do telegram (também dentro de /bot<token>/)
  /\bsb_secret_[A-Za-z0-9_-]{16,}/g, // supabase
  /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g, // shopify
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, // jwt
];

// Webhooks: quem tem a URL posta no canal, então ela some inteira.
const SLACK_WEBHOOK = /(?:https?:\/\/)?hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]+/g;
const DISCORD_WEBHOOK = /(?:https?:\/\/)?(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+/g;

// ---------------------------------------------------------------------------------------------
// Estruturas: o nome fica, o valor some.

/** `scheme://usuario:SENHA@host`: só a senha. */
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@'"]{1,256}:)(?!\[removido\]@)([^\s/?#'"]{1,512})(@)/gi;
const URL_PARAM =
  /([?&#;](?:access_token|refresh_token|id_token|token|key|api_key|apikey|sig|signature|x-amz-signature|x-amz-security-token|x-goog-signature|code|client_secret|secret|password|senha|pwd|passcode|auth|auth_token|access_key|secret_key|private_key)=)(?!\[removido\](?!\w))([^&#\s"'<>`…]{3,})/gi;
/** Token depois de "Bearer" sempre tem dígito ou símbolo; "bearer authorization" fica. */
const BEARER = /(\b[Bb]earer[ \t]+)(?=[A-Za-z]*[0-9._~+/=-])([A-Za-z0-9._~+/=-]{12,})/g;
const BASIC = /(\bauthorization["']?[ \t]*[:=][ \t]*["']?basic[ \t]+)([A-Za-z0-9+/]{8,}={0,2})/gi;
/** `X_KEY=valor`: atribuição a um nome que termina em key é credencial, qualquer que seja o valor. */
const KEY_SUFFIX_ASSIGNMENT = /\b([A-Za-z][A-Za-z0-9_-]{0,60}[_-]key)(=)(["']?)([A-Za-z0-9._~+/=-]+)\3/gi;
/** `--token abc`, `--password=abc`; nunca outra flag. */
const SECRET_FLAG =
  /(--(?:token|password|passwd|senha|api-key|apikey|secret|access-key|auth-token)(?:=|[ \t]+))(["']?)(?!-)([A-Za-z0-9._~+/=-]+)\2/gi;

// ---------------------------------------------------------------------------------------------
// Rótulos em português (e inglês). O valor não pode ser uma palavra comum ("Senha: pedir ao
// cliente", "Token: renovado") nem referência de código ("token = await getToken()").

const STOP = [
  "pedir", "perguntar", "solicitar", "consultar", "ver", "veja", "verificar", "conferir", "aguardar", "aguardando",
  "pendente", "trocar", "trocada", "trocado", "alterar", "alterada", "alterado", "mudar", "mudou", "renovar",
  "renovada", "renovado", "expirou", "expira", "expirada", "expirado", "vencida", "vencido", "enviar", "enviada",
  "enviado", "mandar", "mandada", "mandado", "pagar", "pago", "paga", "fazer", "feito", "feita", "usar", "use",
  "usa", "preciso", "precisa", "pode", "deve", "nenhuma", "nenhum", "vazia", "vazio", "desconhecida", "desconhecido",
  "sem", "não", "nao", "com", "sim", "mesma", "mesmo", "igual", "padrão", "padrao", "forte", "fraca", "fraco",
  "longa", "curta", "nova", "novo", "antiga", "antigo", "atual", "provisória", "provisoria", "temporária",
  "temporaria", "segura", "seguro", "correta", "correto", "errada", "errado", "válida", "valida", "válido", "valido",
  "inválida", "invalida", "inválido", "invalido", "secreta", "secreto", "pessoal", "privada", "privado",
  "obrigatória", "obrigatoria", "necessária", "necessaria", "importante", "diferente", "aleatória", "aleatoria",
  "cofre", "gerenciador", "bitwarden", "lastpass", "1password", "está", "esta", "estava", "fica", "ficou", "foi",
  "era", "será", "sera", "vai", "salva", "salvo", "guardada", "guardado", "anotada", "anotado", "compartilhada",
  "compartilhado", "redefinida", "redefinido", "redefinir", "resetada", "resetar", "bloqueada", "bloqueado",
  "revogada", "revogado", "cadastrada", "cadastrado", "configurada", "configurado", "confirmada", "confirmado",
  "recebida", "recebido", "agendada", "agendado", "muito", "bem", "sempre", "nunca", "aqui", "abaixo", "acima",
  "anexo", "anexa", "segue", "seguem", "sua", "seu", "minha", "meu", "dele", "dela", "nossa", "nosso", "the",
  "same", "see", "ask", "none", "null", "nil", "undefined", "true", "false", "await", "new", "n/a", "tbd",
  "bearer", "basic", "random", "redacted", "hidden", "required", "optional", "empty", "blank", "troca", "pedido",
  "pedida", "definida", "definido", "definir", "criar", "criada", "criado", "gerar", "gerada", "gerado", "todos",
  "todas", "cada", "outra", "outro", "qualquer", "somente", "apenas", "favor", "falar", "ligar", "combinar",
  "combinado", "combinada", "conforme", "pelo", "pela", "via",
];
// Palavra minúscula com acento ("mínimo", "está") é português, não senha. O trecho antes do
// primeiro acento não tem acento: sem isso a regex fica quadrática numa palavra longa.
const NOT_STOP = String.raw`(?!(?:${STOP.map(esc).join("|")}|[a-z]*[à-öø-ÿ][a-zà-öø-ÿ]*)[.,;:!?)]*(?:\s|$))`;
const NOT_CODE = String.raw`(?!process\.env|os\.environ|getenv|env\(|\$[{(]|\$[A-Z][A-Z0-9_]+\b|\{\{|[(<])`;
/** Já limpo: o marcador sozinho, não "[removido]abc" (que esconderia o resto). */
const NOT_DONE = String.raw`(?!["']?\[removido\](?!\w))`;
/** Valor que mistura dígito ou símbolo de senha ("Abc@123"); "**Connections**" e "MAC_CERT_PASSWORD" não. */
const SYMBOL_AHEAD = String.raw`[^\s]{0,63}[0-9!@#$%&]`;
const HAS_SYMBOL = `(?=${SYMBOL_AHEAD})`;
/** Palavra terminada em ":" é outro rótulo ("Senha do insta: senha: X"), não o valor. */
const NOT_LABEL = String.raw`(?![^\s:]+:(?:\s|$))`;

/** `api_key=valor`, `"client_secret": "valor"`: valor de uma palavra só, com 8+ caracteres. */
const KEY_VALUE = new RegExp(
  String.raw`\b((?:[A-Za-z0-9_-]{0,40}_)?(?:api[_-]?key|apikey|secret|token|password|passwd|senha|segredo|authorization|auth[_-]?token|access[_-]?key|private[_-]?key))(["']?\s*[=:]\s*)(["']?)${NOT_STOP}${NOT_CODE}([A-Za-z0-9._~+/=-]{8,})\3`,
  "gi",
);

const SECRET_LABELS = [
  "senha", "password", "passwd", "segredo", "secret", "client[ \\t]+secret", "app[ \\t]+secret", "token",
  "access[ \\t]+token", "refresh[ \\t]+token", "api[ \\t_-]?key", "chave[ \\t]+d[ae][ \\t]+api",
  "chave[ \\t]+de[ \\t]+acesso", "chave[ \\t]+secreta", "chave[ \\t]+privada", "access[ \\t]+key",
  "secret[ \\t]+key", "private[ \\t]+key",
].join("|");
/**
 * Até quatro palavras entre o rótulo e o separador ("senha do insta da Acme:", "senha do app (Acme):"),
 * sem trocar de linha, sem conjunção ("API key e URL: ...") e sem parêntese aberto ou código.
 */
const QUALIFIER = String.raw`(?:[ \t]+(?!(?:e|ou|and|or)[ \t])(?:[^\s:=,;(){}\x60]{1,25}|\([^\s:=,;(){}\x60]{1,23}\))){0,4}`;
const SEP = String.raw`[ \t]*["']?[ \t]*[:=][ \t]*(?:\r?\n[ \t]*)?`;
const VALUE = String.raw`("[^"\n]{1,200}"|'[^'\n]{1,200}'|\S{3,})`;
const LABELLED = new RegExp(
  String.raw`\b(${SECRET_LABELS})\b(${QUALIFIER}${SEP})${NOT_DONE}${NOT_STOP}${NOT_CODE}${NOT_LABEL}${VALUE}`,
  "gi",
);
/** "Senha - Abc@123", "senha → Abc@123": com traço ou seta, o valor precisa de dígito ou símbolo ("o token - que vence" fica). */
const DASHED = new RegExp(
  String.raw`\b(${SECRET_LABELS})\b(${QUALIFIER}[ \t]+(?:->|[-–—→])[ \t]+)${NOT_DONE}${NOT_STOP}${NOT_CODE}${NOT_LABEL}${HAS_SYMBOL}${VALUE}`,
  "gi",
);
/**
 * `DB_PASSWORD=Abc@123!`, `"smtp_pass": "p@ss w0rd"`: nome de variável com segredo, valor com símbolos.
 * Sem aspas, o valor precisa de 8+ caracteres ou dígito/símbolo ("STATS_TOKEN: fleet totals" fica)
 * e não pode ser número de código ("PER_PASS = 200;").
 */
const ENV_SECRET = new RegExp(
  String.raw`\b([A-Za-z][A-Za-z0-9]{0,30}(?:[_-][A-Za-z0-9]{1,30}){0,4}_(?:password|passwd|pass|pwd|secret|token|senha|segredo|api[_-]?key|access[_-]?key|private[_-]?key))(["']?[ \t]*[=:][ \t]*)${NOT_DONE}${NOT_STOP}${NOT_CODE}(?!["'](?:\$[{(]|\{\{|<)|\/\^)("[^"\n]{3,200}"|'[^'\n]{3,200}'|(?!["'\x60]|\d[\d_.]*[;,](?:\s|$))(?=\S{8}|${SYMBOL_AHEAD})\S{3,})`,
  "gi",
);
/**
 * "user: admin pass: hunter2", "pwd=abc": sem palavras no meio ("pass rate in Q3: 95%" fica) e sem
 * cara de código ("pass: page?.inner[0] === 1280").
 */
const SHORT_LABEL = new RegExp(
  String.raw`\b(pass|pwd)\b([ \t]*[:=][ \t]*)${NOT_DONE}${NOT_STOP}${NOT_CODE}${NOT_LABEL}${HAS_SYMBOL}(?![^\s]{0,63}[?([{])${VALUE}`,
  "gi",
);
/** "usuário admin senha admin123": sem separador, o valor precisa misturar letra com dígito ou símbolo. */
const BARE = new RegExp(
  String.raw`\b(senha|password)([ \t]+)${NOT_DONE}${NOT_STOP}${NOT_CODE}${NOT_LABEL}${HAS_SYMBOL}(?=[^\s]{0,63}[A-Za-z])([^\s"'.,;:()]{6,64})(?=[.,;:)!?]?(?:\s|$))`,
  "gi",
);
/** "a senha do insta da Acme é Abc@123". */
const PROSE = new RegExp(
  String.raw`\b(senha|password)\b([^.,;:\n\[]{0,40}?[ \t](?:é|eh|era|ficou|virou|será)(?:[ \t]*:)?[ \t]+)${NOT_DONE}${NOT_STOP}${NOT_LABEL}("[^"\n]{1,200}"|'[^'\n]{1,200}'|\S{4,})`,
  "gi",
);
const PREPOSITIONS = String.raw`(?:[ \t]+(?:d[aoe]s?|para|pra|pro)[ \t]+[^\s:=,;]{1,25}){0,2}`;
const IS = String.raw`[ \t](?:é|eh|era)(?=[ \t])`;
const CODE_LABELS =
  String.raw`otp|pin|2fa|cvv2?|cvc2?|c[oó]digo[ \t]+(?:de[ \t]+)?(?:verifica[cç][aã]o|2fa|otp|sms|acesso|seguran[cç]a|confirma[cç][aã]o|autentica[cç][aã]o|login)`;
/** Códigos curtos (2FA, OTP, PIN, CVV): o separador pode faltar, mas o valor precisa ter dígitos. */
const CODE = new RegExp(
  String.raw`\b(${CODE_LABELS})\b(${PREPOSITIONS}[ \t]*(?:[:=]|${IS})?[ \t]*)((?:[A-Za-z]-)?\d{3}[ -]\d{3}|[A-Za-z0-9-]{3,12})(?![\w-])`,
  "gi",
);
const NUMERIC_CODE = /^(?:pin|cvv2?|cvc2?|c[oó]digo[ \t]+(?:de[ \t]+)?seguran[cç]a)$/i;

// ---------------------------------------------------------------------------------------------
// Cartões. Agrupados de 4 em 4 (ou 4-6-5 da Amex) com Luhn; seguidos (15–16 dígitos) só com
// bandeira conhecida e sem cara de ID de anúncio por perto. Validade e CVV logo depois vão junto.

const CARD_TAIL = String.raw`(?:[ \t]{0,2}[,;|/-]?[ \t]{0,2}(?:0[1-9]|1[0-2])\/(?:\d{4}|\d{2})(?:[ \t]{0,2}[,;|-]?[ \t]{0,2}\d{3,4})?)?`;
const CARD_GROUPED = new RegExp(
  String.raw`(?<![\w.,/-]|\d[ .-])(\d{4}([ .-])\d{4}\2\d{4}\2\d{4}|\d{4}([ -])\d{6}\3\d{4,5})(${CARD_TAIL})(?![\d/]|[ .-]\d{4}(?!\d))`,
  "g",
);
const CARD_CONTIGUOUS = new RegExp(String.raw`(?<![\w.,/=#+-])(\d{15,16})(${CARD_TAIL})(?![\w/=-]|[.,]\d)`, "g");
const CARD_BRAND =
  /^(?:3[47]\d{13}|35(?:2[89]|[3-8]\d)\d{12}|3841\d{12}|4\d{15}|5[0-5]\d{14}|2(?:2(?:2[1-9]|[3-9]\d)|[3-6]\d\d|7(?:[01]\d|20))\d{12}|6\d{15})$/;
const CARD_WORDS = /cart[aã]o|cr[eé]dito|d[eé]bito|\bcard|\bvisa\b|master|amex|\belo\b|hipercard|\bcvv|\bcvc/i;
const AD_ID_WORDS =
  /\b(?:ids?|pixel|campanhas?|campaigns?|conjuntos?|adsets?|an[uú]ncios?|ads?|act|contas?|accounts?|p[aá]ginas?|pages?|bm|business|cat[aá]logos?|catalogs?|eventos?|events?|pedidos?|orders?|protocolos?|rastreio|tracking)\b/i;
const CARD_EXPIRY =
  /\b(validade|val\.?|vencimento|venc\.?|expira(?:[cç][aã]o)?|exp\.?|expiry|expiration|v[aá]lido[ \t]+at[eé])([ \t]*(?:d[oe][ \t]+cart[aã]o[ \t]*)?[:=]?[ \t]*)((?:0[1-9]|1[0-2])[ \t]?\/[ \t]?(?:\d{4}|\d{2}))(?![\d/])/gi;

// ---------------------------------------------------------------------------------------------
// Documentos e banco.

const CPF_FORMATTED = /(?<![\d.])\d{3}\.\d{3}\.\d{3}-\d{2}(?![\d-])/g;
const DOC_SEP = String.raw`[ \t]*(?:n[º°o]\.?[ \t]*)?(?:d[aoe][ \t]+[^\s:=,;\d]{1,25}[ \t]*)?(?:[:=]|${IS})?[ \t]*`;
const CPF_LABELLED = new RegExp(String.raw`\b(cpf)\b(${DOC_SEP})(\d{3}\.?\d{3}\.?\d{3}-?\d{2})(?![\d.\-/])`, "gi");
const RG = new RegExp(
  String.raw`\b(rg|identidade)\b(${DOC_SEP})((?:[A-Za-z]{2}-?)?(?:\d{1,2}\.\d{3}\.\d{3}|\d{6,10})(?:-?[\dXx])?)(?![\w.-])`,
  "gi",
);
const CNH = new RegExp(
  String.raw`\b(cnh|carteira[ \t]+de[ \t]+motorista|habilita[cç][aã]o)\b(${DOC_SEP})(\d{9,11}|\d{3}\.\d{3}\.\d{3}-?\d{2})(?![\w.-])`,
  "gi",
);
const PIX_VALUE = String.raw`(\+?(?:55[ \t]?)?\(?\d{2}\)?[ \t]?9?\d{4}[ \t-]?\d{4}(?!\d)|[^\s,;]{4,})`;
const PAREN = String.raw`(?:[ \t]*\([^)\n]{1,20}\))?`;
const PIX_LABELLED = new RegExp(
  String.raw`\b(chave[ \t]+pix|pix)\b(${PAREN}${PREPOSITIONS}${PAREN}(?:[ \t]*[:=]|[ \t]+(?:é|eh|era)(?=[ \t]))[ \t]*)${NOT_DONE}${PIX_VALUE}`,
  "gi",
);
const PIX_BARE = new RegExp(String.raw`\b(chave[ \t]+pix)([ \t]+)${NOT_DONE}${PIX_VALUE}`, "gi");
const MONEY = /^(?:R\$)?(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{1,7}(?:[.,]\d{1,2})?)$/i;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{1,4}){2,8}/g;
const IBAN_LENGTHS: Record<string, number> = Object.fromEntries(
  ("AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BR29 BY28 CH21 CR22 CY28 CZ24 DE22 DK18 DO28 EE20 EG29 ES24 FI18 " +
    "FO18 FR27 GB22 GE22 GI23 GL18 GR27 GT28 HR21 HU28 IE22 IL23 IQ23 IS26 IT27 JO30 KW30 KZ20 LB28 LC32 LI21 LT20 " +
    "LU20 LV21 MC27 MD24 ME22 MK19 MR27 MT31 MU30 NL18 NO15 PK24 PL28 PS29 PT25 QA29 RO24 RS22 SA24 SC31 SE24 SI19 " +
    "SK24 SM27 ST25 SV28 TL23 TN24 TR26 UA29 VA22 VG24 XK20")
    .split(" ")
    .map((c) => [c.slice(0, 2), Number(c.slice(2))]),
);
const BANK_NUMBER = String.raw`[ \t]*(?:n[º°o]\.?[ \t]*)?[:=]?[ \t]*`;
/** "agência 1234 conta 56789-0": os dois números, só quando aparecem juntos. */
const AGENCY_ACCOUNT = new RegExp(
  String.raw`\b(ag(?:[eê]ncia)?\.?)(${BANK_NUMBER})(\d{3,5}(?:-?[\dXx])?)(?!\d)([^\n\d]{0,25}?)\b(c\/c|conta(?:[ \t]+(?:corrente|poupan[cç]a|pagamento))?|cc|cp|c)(\.?${BANK_NUMBER})(\d{3,13}(?:-?[\dXx])?)(?!\d)`,
  "gi",
);
/** Ordem trocada: "conta 98765-4 agência 1234". */
const ACCOUNT_AGENCY = new RegExp(
  String.raw`\b(c\/c|conta(?:[ \t]+(?:corrente|poupan[cç]a|pagamento))?)(${BANK_NUMBER})(\d{3,13}(?:-?[\dXx])?)(?!\d)([^\n\d]{0,25}?)\b(ag(?:[eê]ncia)?\.?)(${BANK_NUMBER})(\d{3,5}(?:-?[\dXx])?)(?!\d)`,
  "gi",
);
const ACCOUNT = new RegExp(
  String.raw`\b(conta[ \t]+(?:corrente|poupan[cç]a)|c\/c)(${BANK_NUMBER})(\d{3,13}(?:-?[\dXx])?)(?!\d)`,
  "gi",
);

// ---------------------------------------------------------------------------------------------
// Verificações.

export function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function cpfValid(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const check = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(digits[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return check(9) === Number(digits[9]) && check(10) === Number(digits[10]);
}

function ibanValid(iban: string): boolean {
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const n = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of n) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

// ---------------------------------------------------------------------------------------------
// Trocas.

const whole: Fix = (_g, hide) => hide();
/** Mantém rótulo e separador (grupos 1 e 2) e troca o valor (grupo 3). */
const labelled: Fix = (g, hide) => `${g[1]}${g[2]}${hide()}`;
/** Igual, mas aspas e a pontuação que fecha a frase ficam ("senha: abc123." vira "senha: [removido]."). */
const trimmed: Fix = (g, hide) => {
  const quote = /^(["']).*\1$/.exec(g[3])?.[1];
  if (quote) return `${g[1]}${g[2]}${quote}${hide()}${quote}`;
  const tail = /[.,;:)]{1,3}$/.exec(g[3])?.[0] ?? "";
  return tail.length < g[3].length ? `${g[1]}${g[2]}${hide()}${tail}` : g[0];
};
const keyValue: Fix = (g, hide) => `${g[1]}${g[2]}${g[3]}${hide()}${g[3]}`;

const code: Fix = (g, hide) => {
  if (g[3].replace(/\D/g, "").length < 3) return g[0];
  if (NUMERIC_CODE.test(g[1]) && !/^\d{3,8}$/.test(g[3])) return g[0];
  return labelled(g, hide, 0, "");
};

const card =
  (contiguous: boolean): Fix =>
  (g, hide, at, input) => {
    const digits = g[1].replace(/\D/g, "");
    if (!luhn(digits)) return g[0];
    if (contiguous) {
      if (!CARD_BRAND.test(digits)) return g[0];
      // "Pixel 4567…", "act 5123…": número de anúncio que por acaso passa no Luhn. Palavra de
      // cartão antes ou logo depois ("pedido 4111… no cartão") desfaz a dúvida.
      const before = input.slice(Math.max(0, at - 40), at);
      const after = input.slice(at + g[0].length, at + g[0].length + 40);
      if (AD_ID_WORDS.test(before) && !CARD_WORDS.test(before) && !CARD_WORDS.test(after)) return g[0];
    }
    return hide();
  };

/** Validade rotulada só conta perto de um cartão ("validade da oferta: 10/11" fica). */
const expiry: Fix = (g, hide, at, input) => {
  const before = input.slice(Math.max(0, at - 80), at + g[1].length + g[2].length);
  return CARD_WORDS.test(before) || before.includes(REDACTED) ? labelled(g, hide, at, input) : g[0];
};

const cpf: Fix = (g, hide, at, input) => (cpfValid(g[3].replace(/\D/g, "")) ? labelled(g, hide, at, input) : g[0]);

/** Chave PIX: e-mail, telefone, CPF/CNPJ ou aleatória. Sempre tem dígito ou @; valor em dinheiro fica. */
const pix: Fix = (g, hide) => {
  const tail = /[.,;:)]{1,3}$/.exec(g[3])?.[0] ?? "";
  const key = g[3].slice(0, g[3].length - tail.length);
  if (!/[\d@]/.test(key) || MONEY.test(key)) return g[0];
  return `${g[1]}${g[2]}${hide()}${tail}`;
};

/** IBAN: o país diz o tamanho; confere mod-97 e não corta uma palavra maior. */
const iban: Fix = (g, hide, at, input) => {
  const m = g[0];
  const length = IBAN_LENGTHS[m.slice(0, 2)];
  if (!length) return m;
  let seen = 0;
  let end = 0;
  while (end < m.length && seen < length) {
    if (m[end] !== " ") seen += 1;
    end += 1;
  }
  if (seen < length) return m;
  const next = end < m.length ? m[end] : (input[at + end] ?? "");
  if (/[A-Za-z0-9]/.test(next)) return m;
  if (!ibanValid(m.slice(0, end).replace(/ /g, ""))) return m;
  return hide() + m.slice(end);
};

const agencyAccount: Fix = (g, hide) => `${g[1]}${g[2]}${hide()}${g[4]}${g[5]}${g[6]}${hide()}`;

const RULES: readonly Rule[] = [
  [SLACK_WEBHOOK, whole],
  [DISCORD_WEBHOOK, whole],
  ...KEY_PREFIXES.map((re): Rule => [re, whole]),
  [URL_USERINFO, (g, hide) => `${g[1]}${hide()}${g[3]}`],
  [URL_PARAM, (g, hide) => `${g[1]}${hide()}`],
  [BEARER, (g, hide) => `${g[1]}${hide()}`],
  [BASIC, (g, hide) => `${g[1]}${hide()}`],
  [KEY_VALUE, keyValue],
  [KEY_SUFFIX_ASSIGNMENT, keyValue],
  [ENV_SECRET, trimmed],
  [SECRET_FLAG, (g, hide) => `${g[1]}${g[2]}${hide()}${g[2]}`],
  [LABELLED, trimmed],
  [DASHED, trimmed],
  [SHORT_LABEL, trimmed],
  [CODE, code],
  [PROSE, trimmed],
  [BARE, labelled],
  [CARD_GROUPED, card(false)],
  [CARD_CONTIGUOUS, card(true)],
  [CARD_EXPIRY, expiry],
  [CPF_FORMATTED, whole],
  [CPF_LABELLED, cpf],
  [RG, labelled],
  [CNH, labelled],
  [PIX_LABELLED, pix],
  [PIX_BARE, pix],
  [IBAN, iban],
  [AGENCY_ACCOUNT, agencyAccount],
  [ACCOUNT_AGENCY, agencyAccount],
  [ACCOUNT, labelled],
];

// ---------------------------------------------------------------------------------------------
// Chave privada em PEM: cabeçalho e rodapé ficam, o corpo some. Sem rodapé (colada pela metade),
// o corpo vai até a primeira linha que não parece PEM.

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_LOOSE_BODY =
  /[ \t]*[A-Za-z0-9+/=\\]*[ \t]*(?:\r?\n[ \t]*(?:[A-Za-z0-9+/=\\]{4,}[ \t]*|(?:Proc-Type|DEK-Info|Comment|Version):[^\r\n]*|(?=\r?\n[ \t]*[A-Za-z0-9+/=\\]{4,}[ \t]*(?:\r?\n|$)))(?=\r?\n|$))*/y;
/** Quebras de linha viradas em espaço (a captura junta tudo numa linha): pedaços longos de base64. */
const PEM_SPACED_BODY = /(?:[ \t]+[A-Za-z0-9+/=\\]{16,})+(?:[ \t]+[A-Za-z0-9+/]{1,15}={0,2}(?=[ \t]*$|[ \t]+-----))?/y;

function redactPem(text: string, hide: Hide): string {
  if (!text.includes("PRIVATE KEY")) return text;
  let out = "";
  let last = 0;
  let noEndFrom = Infinity; // sem rodapé daqui em diante: não procura de novo
  PEM_BEGIN.lastIndex = 0;
  for (let begin = PEM_BEGIN.exec(text); begin; begin = PEM_BEGIN.exec(text)) {
    const start = begin.index + begin[0].length;
    let end: RegExpExecArray | null = null;
    if (start < noEndFrom) {
      PEM_END.lastIndex = start;
      end = PEM_END.exec(text);
      if (!end) noEndFrom = start;
    }
    let stop: number;
    if (end) {
      stop = end.index;
    } else {
      PEM_LOOSE_BODY.lastIndex = start;
      stop = PEM_LOOSE_BODY.exec(text) ? PEM_LOOSE_BODY.lastIndex : start;
      PEM_SPACED_BODY.lastIndex = start;
      if (PEM_SPACED_BODY.exec(text)) stop = Math.max(stop, PEM_SPACED_BODY.lastIndex);
    }
    const body = text.slice(start, stop).trim();
    if (body && body !== REDACTED) {
      out += `${text.slice(last, start)}\n${hide()}${end ? "\n" : ""}`;
      last = stop;
    }
    PEM_BEGIN.lastIndex = end ? end.index + end[0].length : Math.max(stop, start);
  }
  return out + text.slice(last);
}

function pass(text: string): { text: string; removed: number } {
  let removed = 0;
  const hide: Hide = () => {
    removed += 1;
    return REDACTED;
  };
  let out = redactPem(text, hide);
  for (const [re, fix] of RULES) {
    out = out.replace(re, (...args: unknown[]) => {
      const input = args[args.length - 1] as string;
      const at = args[args.length - 2] as number;
      const groups = args.slice(0, -2).map((x) => (typeof x === "string" ? x : ""));
      return fix(groups, hide, at, input);
    });
  }
  return { text: out, removed };
}

// Espaço sem quebra (colado da web ou do WhatsApp), caractere invisível e dois-pontos largo
// escondiam "senha:\u00a0X" e "sk-…\u200b…" das regras. Só valem no texto devolvido se algo sair.
const ODD_SPACE = /[\u00a0\u2007\u202f]/g;
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff\u00ad]/g;
const normalize = (text: string) =>
  text.replace(ODD_SPACE, " ").replace(INVISIBLE, "").replace(/\uff1a/g, ":").replace(/\uff1d/g, "=");

/** Texto sem dados sensíveis e quantos trechos saíram. */
export function redactSecrets(text: string): { text: string; removed: number } {
  let out = text;
  let removed = 0;
  const plain = text ? normalize(text) : text;
  if (plain !== text) {
    const r = pass(plain);
    if (r.removed) {
      out = r.text;
      removed = r.removed;
    }
  }
  // Uma troca pode expor outra (rótulo seguido de outro valor); repete até não sobrar nada.
  for (let round = removed ? 1 : 0; round < 3 && out; round++) {
    const r = pass(out);
    if (!r.removed) break;
    out = r.text;
    removed += r.removed;
  }
  return { text: out, removed };
}

/**
 * Nome de campo que guarda segredo: `senha`, `apiKey`, `access_token`, `x-api-key`, `client_secret`.
 * Plural só onde não é contagem: `apiKeys` e `senhas` sim, `tokens` (uso do modelo) não.
 */
const SECRET_FIELD =
  /(?:^|[_.-])(?:senhas?|passwords?|passwd|secrets?|segredos?|token|api[_-]?keys?|apikeys?|access[_-]?keys?|private[_-]?keys?|authorization|cvv|cvc)$/;
const secretField = (key: string) => SECRET_FIELD.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase());

/** Limpa todos os textos de um valor JSON (entradas de ferramentas), mantendo a forma. */
export function redactDeep<T>(value: T): { value: T; removed: number } {
  let removed = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactSecrets(v);
      removed += r.removed;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    // Só objeto simples: Date, Buffer e afins passam como estão.
    if (v && typeof v === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(v))) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => {
          if (secretField(k)) {
            // Número também é segredo ("cvv": 123, "senha": 123456); lista de textos some item a item.
            if ((typeof x === "string" && x && x !== REDACTED) || typeof x === "number" || typeof x === "bigint") {
              removed += 1;
              return [k, REDACTED];
            }
            if (Array.isArray(x)) {
              return [k, x.map((item) => (typeof item === "string" && item && item !== REDACTED ? ((removed += 1), REDACTED) : walk(item)))];
            }
          }
          return [k, walk(x)];
        }),
      );
    }
    return v;
  };
  return { value: walk(value) as T, removed };
}
