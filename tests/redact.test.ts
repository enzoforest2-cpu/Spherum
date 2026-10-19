import assert from "node:assert/strict";
import { test } from "node:test";
import { luhn, REDACTED, redactDeep, redactSecrets } from "../src/lib/xodos/redact";

test("apaga chaves, tokens, CPF, cartão e senhas rotuladas", () => {
  const input = [
    "Anthropic sk-ant-api03-abcdefghijklmnop",
    "OpenAI sk-proj-ABCDEFGHIJKLMNOPQRST",
    "Google AIzaSyA1234567890abcdefghijklmnopqrstu",
    "jwt eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl",
    "CPF 123.456.789-09",
    "cartão 4111 1111 1111 1111",
    "senha: hunter2",
  ].join("\n");
  const { text, removed } = redactSecrets(input);
  assert.ok(removed >= 7);
  for (const secret of ["sk-ant-api03", "sk-proj-", "AIzaSy", "eyJhbGci", "123.456.789-09", "4111 1111", "hunter2"]) {
    assert.ok(!text.includes(secret), `vazou ${secret}`);
  }
  assert.match(text, /senha: \[removido\]/);
  assert.deepEqual(redactSecrets(text), { text, removed: 0 }, "limpar de novo não muda nada");
});

test("não mexe em IDs de campanha, valores e contatos", () => {
  const input = "Campanha Meta 23851234567890123, Google Ads 1234567890, CPL alvo R$ 25,00, contato ana@loja.com.br";
  assert.deepEqual(redactSecrets(input), { text: input, removed: 0 });
});

test("limpa todos os textos de um objeto, mantendo a forma", () => {
  const { value, removed } = redactDeep({ texto: "token: abc123", lista: ["ok", "senha=xyz"], n: 3, nada: null });
  assert.deepEqual(value, { texto: "token: [removido]", lista: ["ok", "senha=[removido]"], n: 3, nada: null });
  assert.equal(removed, 2);
});

// Os tokens são montados em tempo de execução: nenhum literal com cara de credencial fica no código.
const k = (...parts: string[]) => parts.join("");
const alnum = (n: number) => "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9".repeat(Math.ceil(n / 27)).slice(0, n);
const hex = (n: number) => "0123456789abcdef".repeat(Math.ceil(n / 16)).slice(0, n);

/** Completa com o dígito que faz passar no Luhn. */
function withLuhn(prefix: string): string {
  for (let d = 0; d <= 9; d++) if (luhn(prefix + d)) return prefix + d;
  throw new Error("sem dígito");
}

/** Some o segredo, entra o marcador, e limpar de novo não muda nada. */
function assertRedacted(input: string, secret: string, expected?: string) {
  const { text, removed } = redactSecrets(input);
  assert.ok(!text.includes(secret), `vazou "${secret}" em: ${text}`);
  assert.ok(removed >= 1, `nada removido em: ${input}`);
  assert.ok(text.includes(REDACTED), text);
  if (expected !== undefined) assert.equal(text, expected);
  assert.deepEqual(redactSecrets(text), { text, removed: 0 }, `não idempotente: ${text}`);
}

function assertIntact(input: string) {
  assert.deepEqual(redactSecrets(input), { text: input, removed: 0 }, `mexeu em: ${input}`);
}

test("prefixos de chave de provedores e de agência somem inteiros", () => {
  const cases: Array<[string, string]> = [
    ["openai", k("sk-", "proj-", alnum(40))],
    ["stripe live", k("sk", "_live_", alnum(24))],
    ["stripe restrita", k("rk", "_test_", alnum(24))],
    ["stripe webhook", k("whsec", "_", alnum(32))],
    ["xai", k("xai-", alnum(30))],
    ["groq", k("gsk", "_", alnum(52))],
    ["cerebras", k("csk-", alnum(40))],
    ["meta llm", k("LLM|", "607358788850350|", alnum(24))],
    ["huggingface", k("hf", "_", alnum(34))],
    ["github", k("gh", "p_", alnum(36))],
    ["github fino", k("github_", "pat_", "11ABCDEFG0", alnum(40))],
    ["slack bot", k("xox", "b-", "123456789012-1234567890123-", alnum(24))],
    ["slack app", k("xa", "pp-", "1-A0123456789-1234567890123-", hex(64))],
    ["aws", k("AK", "IA", "IOSFODNN7EXAMPL3")],
    ["google api", k("AI", "za", "SyA-", alnum(33))],
    ["google oauth", k("ya", "29.", alnum(60))],
    ["google refresh", k("1/", "/0g", alnum(60))],
    ["meta", k("EA", "AG", alnum(120))],
    ["mercado pago", k("APP", "_USR-", "1234567890123456-101112-", hex(32), "-123456789")],
    ["mercado pago teste", k("TE", "ST-", "1234567890123456-101112-", hex(32), "-123456789")],
    ["sendgrid", k("SG", ".", alnum(22), ".", alnum(43))],
    ["telegram", k("123456789", ":AA", alnum(33))],
    ["supabase", k("sb_", "secret_", alnum(32))],
    ["shopify", k("shp", "at_", hex(32))],
    ["npm", k("npm", "_", alnum(36))],
    ["jwt", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"],
  ];
  for (const [name, secret] of cases) {
    assertRedacted(`chave do ${name}: ${secret} (guardar)`, secret);
    assertRedacted(`${name} ${secret}`, secret, `${name} ${REDACTED}`);
  }
  // Token do bot dentro da URL da API do Telegram.
  const bot = k("987654321", ":AA", alnum(33));
  assertRedacted(`https://api.telegram.org/bot${bot}/sendMessage`, bot, `https://api.telegram.org/bot${REDACTED}/sendMessage`);
});

test("prefixo curto demais ou colado em outra palavra fica", () => {
  for (const ordinary of [
    k("xai-", alnum(19)),
    k("hf", "_", alnum(29)),
    k("example_", "xai-", alnum(30)),
    k("EA", "AG", alnum(40)),
    "sk-8",
    "task-force-planejamento-2026",
    "SG.marketing.time",
  ]) {
    assertIntact(ordinary);
  }
});

test("webhooks do Slack e do Discord somem inteiros", () => {
  const slack = k("https://hooks.", "slack.com/services/", "T0123ABCD/B0123ABCD/", alnum(24));
  assertRedacted(`Alertas: ${slack} (canal #vendas)`, "hooks.slack.com", `Alertas: ${REDACTED} (canal #vendas)`);
  const workflow = k("https://hooks.", "slack.com/workflows/", "T0123ABCD/A0123ABCD/123456789012345678/", alnum(24));
  assertRedacted(workflow, "T0123ABCD", REDACTED);
  const discord = k("https://discord.com/api/", "webhooks/", "123456789012345678/", alnum(68));
  assertRedacted(`Discord: ${discord}`, "webhooks", `Discord: ${REDACTED}`);
});

test("valor secreto em parâmetro de URL some, o resto da URL fica", () => {
  assertRedacted(
    "https://graph.facebook.com/v19.0/me?fields=id&access_token=abc123xyz",
    "abc123xyz",
    `https://graph.facebook.com/v19.0/me?fields=id&access_token=${REDACTED}`,
  );
  assertRedacted(
    "https://x.s3.amazonaws.com/f.pdf?X-Amz-Expires=300&X-Amz-Signature=deadbeef1234",
    "deadbeef1234",
    `https://x.s3.amazonaws.com/f.pdf?X-Amz-Expires=300&X-Amz-Signature=${REDACTED}`,
  );
  assertRedacted("https://app.com/callback?code=4/0AbCdEf&state=xyz", "4/0AbCdEf", `https://app.com/callback?code=${REDACTED}&state=xyz`);
  assertRedacted("https://maps.example.com/embed?key=minha-chave&q=loja", "minha-chave");
  assertRedacted("https://cdn.example.com/v.mp4?sig=s1gn4tur3&exp=1", "s1gn4tur3");
  assertRedacted("https://api.example.com/feed?token=t0k3n#topo", "t0k3n", `https://api.example.com/feed?token=${REDACTED}#topo`);
});

test("senha em URL some, usuário e host ficam", () => {
  assertRedacted("psql postgres://maus:s3cret@db.internal:5432/app", "s3cret", `psql postgres://maus:${REDACTED}@db.internal:5432/app`);
  assertRedacted("ftp://cliente:p@ss!word@ftp.loja.com.br/", "p@ss!word", `ftp://cliente:${REDACTED}@ftp.loja.com.br/`);
  assertIntact("https://host:8080/path e user@host");
});

test("PEM, Bearer, Basic, KEY=VALUE e --token (do OpenMausBot)", () => {
  const body = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW";
  const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n${body}\n-----END OPENSSH PRIVATE KEY-----`;
  assertRedacted(
    `chave do servidor:\n${pem}\nfim`,
    body,
    `chave do servidor:\n-----BEGIN OPENSSH PRIVATE KEY-----\n${REDACTED}\n-----END OPENSSH PRIVATE KEY-----\nfim`,
  );
  // Colada pela metade: o corpo some até a primeira linha que não parece chave.
  assertRedacted(
    `-----BEGIN RSA PRIVATE KEY-----\n${body}\n${body}\n\nO cliente pediu para trocar.`,
    body,
    `-----BEGIN RSA PRIVATE KEY-----\n${REDACTED}\n\nO cliente pediu para trocar.`,
  );
  assertIntact("-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----");

  assertRedacted('curl -H "Authorization: Bearer abc.def-ghi_jkl123456789"', "abc.def", `curl -H "Authorization: Bearer ${REDACTED}"`);
  assertRedacted("Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpw", `Authorization: Basic ${REDACTED}`);
  assertRedacted("export DATABASE_PASSWORD=hunter2hunter2", "hunter2", `export DATABASE_PASSWORD=${REDACTED}`);
  assertRedacted('{"api_key": "abcd1234efgh5678"}', "abcd1234", `{"api_key": "${REDACTED}"}`);
  assertRedacted("client_secret: 'zzzz-yyyy-xxxx-1'", "zzzz", `client_secret: '${REDACTED}'`);
  assertRedacted("X_KEY=value pnpm doctor", "value", `X_KEY=${REDACTED} pnpm doctor`);
  assertRedacted("export xai-key='abc.def'", "abc.def", `export xai-key='${REDACTED}'`);
  assertRedacted("gh auth login --token abc123", "abc123", `gh auth login --token ${REDACTED}`);
  assertRedacted("tool --password=hunter2 --api-key 'k1'", "hunter2", `tool --password=${REDACTED} --api-key '${REDACTED}'`);
  for (const ordinary of [
    "tool --token --verbose",
    "hotkey=cmd+k keyboard=qwerty monkey=business",
    "git log --tokens-are-not-a-flag --passwords",
    "the key: patience",
    "password: (leave blank to keep the current one)",
    "Bearer tokens are sent in the Authorization header",
    "turns completed with bearer authorization",
    "abra /pair#code=… no navegador",
    "const token = await getToken(); // busca depois",
    "token = process.env.META_TOKEN",
    "git commit 3f2a9c1e7b4d5a6f8e9c0b1a2d3e4f5a6b7c8d9e",
  ]) {
    assertIntact(ordinary);
  }
});

test("rótulos em português: senha, token, segredo, chave de api", () => {
  assertRedacted("senha: hunter2", "hunter2", `senha: ${REDACTED}`);
  assertRedacted("Senha do insta da Acme: Abc@123.", "Abc@123", `Senha do insta da Acme: ${REDACTED}.`);
  assertRedacted("senha do Instagram (Acme): Xy#9912", "Xy#9912");
  assertRedacted("Senha do Instagram da Verano: senha: Abc@123", "Abc@123", `Senha do Instagram da Verano: senha: ${REDACTED}`);
  assertRedacted("Login: ana.souza, senha: Q1w2e3!", "Q1w2e3", `Login: ana.souza, senha: ${REDACTED}`);
  assertRedacted("Nova senha = Girassol2026, trocar em março", "Girassol2026", `Nova senha = ${REDACTED}, trocar em março`);
  assertRedacted('"senha": "frase com espaço"', "frase com", `"senha": "${REDACTED}"`);
  assertRedacted("token do Meta: abc123xyz", "abc123xyz", `token do Meta: ${REDACTED}`);
  assertRedacted("Segredo: banana-azul", "banana-azul");
  assertRedacted("chave de API: k-123-abc", "k-123-abc");
  assertRedacted("Chave de acesso: AKfy-889", "AKfy-889");
  assertRedacted("senha:\nPinguim77", "Pinguim77");
  for (const ordinary of [
    "Senha: pedir ao cliente",
    "Token: renovado ontem",
    "senha: está no cofre",
    "A senha é forte o bastante",
    "O token do Meta expira em 60 dias",
    "Senhas fortes têm 12 caracteres",
    "senha",
    "API key e URL base: OpenRouter por padrão",
    "token de acesso (Version: 2021-07-28)",
    "TOKEN=$(openssl rand -hex 32)",
  ]) {
    assertIntact(ordinary);
  }
});

test("senha contada em prosa", () => {
  assertRedacted("a senha do insta da Acme é Abc@123", "Abc@123", `a senha do insta da Acme é ${REDACTED}`);
  assertRedacted("A senha do wifi era Girassol, mas mudou.", "Girassol", `A senha do wifi era ${REDACTED}, mas mudou.`);
  assertRedacted("a senha é forte e a do wifi é Girassol", "Girassol", `a senha é forte e a do wifi é ${REDACTED}`);
  assertIntact("a senha é a mesma do Facebook");
  assertIntact("the password is cleared from the box after a minute");
});

test("códigos de verificação, 2FA, OTP, PIN e CVV", () => {
  assertRedacted("código de verificação: 123456", "123456", `código de verificação: ${REDACTED}`);
  assertRedacted("Código 2FA 654 321", "654 321", `Código 2FA ${REDACTED}`);
  assertRedacted("OTP 112233", "112233", `OTP ${REDACTED}`);
  assertRedacted("código de verificação do Google: G-482913", "G-482913");
  assertRedacted("PIN: 1234", "1234", `PIN: ${REDACTED}`);
  assertRedacted("o pin do cartão é 9876", "9876", `o pin do cartão é ${REDACTED}`);
  assertRedacted("CVV 123", "123", `CVV ${REDACTED}`);
  for (const ordinary of ["pin: fixar no topo", "OTP enviado por SMS", "Pinterest 2026", "código de verificação enviado"]) {
    assertIntact(ordinary);
  }
});

test("cartões com Luhn, validade e CVV", () => {
  assertRedacted(
    "cartão 4111 1111 1111 1111 validade 12/27 cvv 123",
    "4111",
    `cartão ${REDACTED} validade ${REDACTED} cvv ${REDACTED}`,
  );
  assertRedacted("4111-1111-1111-1111 12/27 123", "12/27", REDACTED);
  assertRedacted("Master 5555555555554444, venc. 08/2028", "5555", `Master ${REDACTED}, venc. ${REDACTED}`);
  assertRedacted("Amex 3782 822463 10005", "822463", `Amex ${REDACTED}`);
  assertRedacted("amex 378282246310005", "378282", `amex ${REDACTED}`);
  assertRedacted("elo 6362970000457013", "636297");
  assertRedacted("hipercard 6062825624254001", "606282");
  // Não passa no Luhn, não tem bandeira, ou tem cara de ID de anúncio.
  const pixel = withLuhn("456789012345678");
  assert.ok(luhn(pixel));
  for (const ordinary of [
    "1234 5678 9012 3456",
    "4111111111111112",
    `Pixel ${pixel}`,
    `ID da conta de anúncios: ${pixel}`,
    `act_${pixel}`,
    "página 100064123456789",
    "validade da oferta: 10/11",
    "vencimento do boleto 12/26",
  ]) {
    assertIntact(ordinary);
  }
  // Com palavra de cartão por perto, o rótulo de anúncio não salva.
  assertRedacted(`cartão do pedido ${pixel}`, pixel);
});

test("CPF formatado sempre; 11 dígitos só depois de cpf e com dígito verificador válido", () => {
  assertRedacted("CPF 529.982.247-25", "529.982", `CPF ${REDACTED}`);
  assertRedacted("titular 529.982.247-25", "529.982", `titular ${REDACTED}`);
  assertRedacted("cpf 52998224725", "52998224725", `cpf ${REDACTED}`);
  assertRedacted("CPF do sócio: 529982247-25", "529982247", `CPF do sócio: ${REDACTED}`);
  for (const ordinary of [
    "cpf 12345678900", // dígito errado
    "cpf 11111111111",
    "pedido 52998224725", // sem rótulo
    "fone 11987654321",
    "CPF/CNPJ: 12345678000190",
  ]) {
    assertIntact(ordinary);
  }
});

test("RG e CNH só quando rotulados", () => {
  assertRedacted("RG: 12.345.678-9", "12.345.678", `RG: ${REDACTED}`);
  assertRedacted("rg 123456789 SSP/SP", "123456789", `rg ${REDACTED} SSP/SP`);
  assertRedacted("identidade nº 98.765.432-X", "98.765", `identidade nº ${REDACTED}`);
  assertRedacted("CNH 12345678901", "12345678901", `CNH ${REDACTED}`);
  assertRedacted("carteira de motorista: 123.456.789-01", "123.456", `carteira de motorista: ${REDACTED}`);
  for (const ordinary of ["identidade visual 2024", "nova identidade da marca", "número 12.345.678-9 do processo", "RG 2026"]) {
    assertIntact(ordinary);
  }
});

test("chave PIX rotulada some, mesmo sendo e-mail ou telefone", () => {
  assertRedacted("chave pix: ana@loja.com.br", "ana@loja", `chave pix: ${REDACTED}`);
  assertRedacted("Pix: 11987654321", "11987654321", `Pix: ${REDACTED}`);
  assertRedacted("pix: +55 11 98765-4321.", "98765", `pix: ${REDACTED}.`);
  assertRedacted("chave PIX da loja é 12.345.678/0001-90", "12.345.678", `chave PIX da loja é ${REDACTED}`);
  assertRedacted("chave pix (CNPJ): 12.345.678/0001-90", "0001-90", `chave pix (CNPJ): ${REDACTED}`);
  assertRedacted("chave pix 52998224725", "52998224725", `chave pix ${REDACTED}`);
  assertRedacted("chave pix: 123e4567-e89b-12d3-a456-426614174000", "123e4567");
  for (const ordinary of ["pague via pix amanhã", "Pix: R$ 150,00", "pix: 1.500,00", "chave pix cadastrada", "pix: confirmado"]) {
    assertIntact(ordinary);
  }
});

test("IBAN com mod-97 e agência/conta rotuladas", () => {
  assertRedacted("IBAN GB82 WEST 1234 5698 7654 32 (Londres)", "WEST", `IBAN ${REDACTED} (Londres)`);
  assertRedacted("DE89370400440532013000", "370400", REDACTED);
  assertRedacted("conta no exterior BR1800360305000010009795493C1.", "BR18", `conta no exterior ${REDACTED}.`);
  assertIntact("GB82 WEST 1234 5698 7654 33"); // dígito de controle errado
  assertIntact("SP12 2026 ABCD");

  assertRedacted("agência 1234 conta 56789-0", "56789", `agência ${REDACTED} conta ${REDACTED}`);
  assertRedacted("Itaú ag: 0001, c/c: 12345-6", "12345", `Itaú ag: ${REDACTED}, c/c: ${REDACTED}`);
  assertRedacted("conta corrente 123456-7", "123456", `conta corrente ${REDACTED}`);
  for (const ordinary of ["conta de anúncios 123456789012345", "agosto 2026", "a conta 3 tem 12 campanhas", "agência 2026 de publicidade"]) {
    assertIntact(ordinary);
  }
});

test("notas comuns de agência ficam como estão", () => {
  for (const note of [
    "O token do Meta da Acme vence dia 12/11; renovar antes.",
    "Senha do Instagram fica com a Ana (gerente).",
    "Senha forte: mínimo 12 caracteres.",
    "Senha padrão do cliente: troca no primeiro acesso.",
    "Token de acesso: pedir para o TI.",
    "Login e senha: com o cliente.",
    "Chave de API: no 1Password da agência.",
    "A senha é pessoal e intransferível.",
    "PIN: ainda não definido. CVV não é armazenado.",
    "Pagamentos via PIX caem em até 1 dia útil. PIX: só com nota fiscal.",
    "RG e CPF do sócio estão no Drive.",
    "Validade do contrato: 12/2026. Validade: 12/2026.",
    "Vencimento: 10/26, boleto.",
    "A agência da Ana fica na Av. Paulista, 1000. Agência 3 do Itaú fechou.",
    "A conta 12345 da Meta foi desativada.",
    "Código do produto: SKU-12345. O código de rastreio é BR123456789BR. Cupom BLACK30 até 30/11.",
    "Conta de anúncios da Verano: act_1234567890123456. Pixel da loja: 1234567890123456.",
    "ID da campanha: 120210000000000000. Conjunto 23851234567890124.",
    "Cliente pediu relatório com CPL, CTR e ROAS toda segunda às 9h.",
  ]) {
    assertIntact(note);
  }
});

test("fica intacto: IDs de campanha, R$, e-mails, telefones, CNPJ, UUIDs e UTMs", () => {
  assertIntact(
    [
      "Campanhas Meta 23851234567890123 e 120210000000000000; Google Ads 1234567890 e 12345678901 (conta 123-456-7890).",
      "Orçamento R$ 1.234,56 por dia, R$ 25.000,00 no mês, CPL alvo R$ 25,00.",
      "Contato ana@loja.com.br, financeiro+nf@acme.com, mailto:joao@cliente.com.",
      "Telefones +55 11 98765-4321, (11) 3456-7890, 11987654321 e +5511987654321.",
      "CNPJ 12.345.678/0001-90 e 12345678000190.",
      "Cliente 550e8400-e29b-41d4-a716-446655440000, nota #12.",
      "https://loja.com/?utm_source=facebook&utm_medium=cpc&utm_campaign=black_friday&utm_content=carrossel_1&utm_term=tenis",
      "Endereço: Rua das Flores, 123, ap 45, São Paulo - SP, CEP 01234-567.",
      "Página 100064123456789, act_1234567890123456, pixel 1234567890123456.",
      "Relatório às segundas, 9h; a chave do sucesso é a constância.",
    ].join("\n"),
  );
});

test("limpar de novo não muda nada, inclusive num texto misturado", () => {
  const mixed = [
    "Senha do insta da Acme: Abc@123. A senha do wifi é Girassol e o pin é 9876.",
    "cartão 4111 1111 1111 1111 validade 12/27 cvv 123; CPF 529.982.247-25; cpf 52998224725",
    `pix: ana@loja.com.br; agência 1234 conta 56789-0; ${k("sk", "_live_", alnum(24))}`,
    "https://ana:segredo@ftp.loja.com/?token=abc&utm_source=meta",
    "Campanha 23851234567890123 R$ 1.234,56 (11) 98765-4321 12.345.678/0001-90",
  ].join("\n");
  const once = redactSecrets(mixed);
  assert.ok(once.removed >= 14, `só ${once.removed}`);
  assert.deepEqual(redactSecrets(once.text), { text: once.text, removed: 0 });
  for (const kept of ["23851234567890123", "R$ 1.234,56", "(11) 98765-4321", "12.345.678/0001-90", "utm_source=meta"]) {
    assert.ok(once.text.includes(kept), `sumiu ${kept}`);
  }
});

test("texto de 50 KB, normal ou malicioso, passa rápido", () => {
  const size = 50_000;
  const fill = (s: string) => s.repeat(Math.ceil(size / s.length)).slice(0, size);
  const realistic = fill(
    "Reunião com a Acme: senha do insta: Abc@123, cartão 4111 1111 1111 1111, campanha 23851234567890123, " +
      "R$ 1.234,56, ana@loja.com.br, (11) 98765-4321, https://loja.com/?utm_source=meta&token=abc123. ",
  );
  const hostile = [
    "a-", "a.", "1", "1 ", "1.", "1-", "a_", "=", "a:", "a@", "senha ", "senha: ", "senha do x ", "a senha é ", "sk-",
    "https://a:", "x://u:b", "eyJabcd.", "-----BEGIN PRIVATE KEY-----\n", "pix: ", "chave pix ", "agência 1234 ", "cpf ",
    "rg ", "AB12 ", "A", "4111 ", "token=", "--token ", "?token=", "Bearer ", "validade 12/", "código de verificação ",
  ].map(fill);
  for (const text of [realistic, ...hostile]) {
    const started = performance.now();
    redactSecrets(text);
    const ms = performance.now() - started;
    assert.ok(ms < 1000, `${ms.toFixed(0)} ms para "${text.slice(0, 20)}…"`);
  }
  assert.ok(!redactSecrets(realistic).text.includes("Abc@123"));
});

test("redactDeep apaga campos com nome de segredo e conta o que saiu", () => {
  const input = {
    texto: "lembrar: senha: hunter2",
    apiKey: "qualquer-coisa",
    credenciais: { access_token: "abc", "x-api-key": "k1", client_secret: "s", senha: "123" },
    max_tokens: 4000,
    token_count: "120",
    lista: [{ password: "p" }, "ok"],
  };
  const { value, removed } = redactDeep(input);
  assert.deepEqual(value, {
    texto: `lembrar: senha: ${REDACTED}`,
    apiKey: REDACTED,
    credenciais: { access_token: REDACTED, "x-api-key": REDACTED, client_secret: REDACTED, senha: REDACTED },
    max_tokens: 4000,
    token_count: "120",
    lista: [{ password: REDACTED }, "ok"],
  });
  assert.equal(removed, 7);
  assert.deepEqual(redactDeep(value), { value, removed: 0 }, "limpar de novo não muda nada");
  assert.deepEqual(redactDeep({ token: "" }), { value: { token: "" }, removed: 0 });
});

// Revisão: casos que escapavam ou travavam.

test("palavra longa com acento depois de um rótulo não trava (regex quadrática)", () => {
  const word = "á".repeat(50_000);
  for (const text of [`senha: ${word}1`, `a senha é ${word}1`, `senha: ${"aá".repeat(25_000)}1`, `senha ${"a".repeat(50_000)}`]) {
    const started = performance.now();
    redactSecrets(text);
    const ms = performance.now() - started;
    assert.ok(ms < 300, `${ms.toFixed(0)} ms para "${text.slice(0, 12)}…"`);
  }
});

test("espaço sem quebra, caractere invisível e dois-pontos largo não escondem o segredo", () => {
  assertRedacted("senha: Abc@123", "Abc@123", `senha: ${REDACTED}`);
  assertRedacted("senha do insta: Abc@123", "Abc@123");
  assertRedacted("cartão 4111 1111 1111 1111", "4111");
  assertRedacted(`chave ${k("sk-", "proj-​", alnum(30))}`, alnum(30));
  assertRedacted("senha： Abc@123", "Abc@123");
  // Sem nada para tirar, o texto volta igual (inclusive o espaço sem quebra).
  assertIntact("R$ 150,00 até sexta");
});

test("o marcador colado num valor não protege o resto", () => {
  assertRedacted("senha: [removido]hunter2", "hunter2", `senha: ${REDACTED}`);
  assertRedacted("https://a.com/?token=[removido]abc123", "abc123", `https://a.com/?token=${REDACTED}`);
  assertRedacted("chave pix: [removido]ana@loja.com", "ana@loja");
});

test("variáveis de ambiente com símbolos e valores entre aspas", () => {
  assertRedacted("DB_PASSWORD=Abc@1234!", "Abc@1234", `DB_PASSWORD=${REDACTED}`);
  assertRedacted('SMTP_PASSWORD="Abc@1234!"', "Abc@1234", `SMTP_PASSWORD="${REDACTED}"`);
  assertRedacted('"db_password": "p@ss w0rd!"', "p@ss", `"db_password": "${REDACTED}"`);
  assertRedacted("META_APP_SECRET=abc!def#ghi", "abc!def", `META_APP_SECRET=${REDACTED}`);
  assertRedacted("MAIL_PASS=hunter2", "hunter2", `MAIL_PASS=${REDACTED}`);
  for (const ordinary of [
    "const PRUNE_NOTES_PER_PASS = 200;",
    "h.env.WEBHOOK_SECRET = undefined;",
    'env: { GH_TOKEN: "${{ github.token }}" }',
    "Bearer STATS_TOKEN: fleet totals for Admin",
    'const CONTROL_TOKEN = "c".repeat(43);',
    "max_tokens: 4000, prompt_tokens=1200",
  ]) {
    assertIntact(ordinary);
  }
});

test("traço, seta, sem separador, pass/pwd e senha entre aspas em prosa", () => {
  assertRedacted("senha - Abc@123", "Abc@123", `senha - ${REDACTED}`);
  assertRedacted("Senha do insta → Abc@123", "Abc@123", `Senha do insta → ${REDACTED}`);
  assertRedacted("usuário admin senha admin123", "admin123", `usuário admin senha ${REDACTED}`);
  assertRedacted("login ana / senha hunter22.", "hunter22", `login ana / senha ${REDACTED}.`);
  assertRedacted("user: admin pass: hunter2", "hunter2", `user: admin pass: ${REDACTED}`);
  assertRedacted("pwd=Abc@123", "Abc@123", `pwd=${REDACTED}`);
  assertRedacted('a senha do instagram é "minha senha secreta"', "secreta", `a senha do instagram é "${REDACTED}"`);
  for (const ordinary of [
    "O token - que vence amanhã - foi renovado",
    "tool --token --verbose",
    "senha – 8 caracteres no mínimo",
    "Pass rate in Q3: 95%",
    "pass: boolean; detail: string",
    "pass: page?.inner?.[0] === 1280",
    "Esqueci a senha do Gmail ontem",
    "senha 2026 do evento",
    "senha **forte** sempre",
    "save your API key in **Settings → Connections**, then choose",
  ]) {
    assertIntact(ordinary);
  }
});

test("PEM sem rodapé com linhas juntadas por espaço ou com espaço no fim", () => {
  const line = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
  // A captura junta tudo numa linha só antes de limpar.
  assertRedacted(`chave: -----BEGIN PRIVATE KEY----- ${line} ${line} ${line} abc=`, line, `chave: -----BEGIN PRIVATE KEY-----\n${REDACTED}`);
  assertRedacted(`-----BEGIN PRIVATE KEY-----\n${line}   \n${line} \nfim`, line, `-----BEGIN PRIVATE KEY-----\n${REDACTED}\nfim`);
  assertRedacted(
    `-----BEGIN PRIVATE KEY----- ${line} ${line} -----END PRIVATE KEY-----`,
    line,
    `-----BEGIN PRIVATE KEY-----\n${REDACTED}\n-----END PRIVATE KEY-----`,
  );
});

test("cartão com pontos, palavra de cartão depois do número e conta antes da agência", () => {
  assertRedacted("cartao: 4111.1111.1111.1111", "4111", `cartao: ${REDACTED}`);
  assertRedacted("pedido 4111111111111111 no cartão", "4111", `pedido ${REDACTED} no cartão`);
  assertRedacted("Conta 98765-4 agência 1234", "98765", `Conta ${REDACTED} agência ${REDACTED}`);
  assertRedacted("https://zoom.us/j/123456789?pwd=AbCdEf123456", "AbCdEf", `https://zoom.us/j/123456789?pwd=${REDACTED}`);
  assertIntact("Versão 1.2.3.4 e IP 192.168.0.1");
  assertIntact("A conta 12345 da Meta foi desativada; agência 3 fechou.");
});

test("redactDeep: número e lista em campo de segredo; Date passa como está", () => {
  const when = new Date("2026-10-19T12:00:00Z");
  const { value, removed } = redactDeep({ cvv: 123, password: 12345678, tokens: 4000, apiKeys: ["a1", "b2"], quando: when });
  assert.deepEqual(value, { cvv: REDACTED, password: REDACTED, tokens: 4000, apiKeys: [REDACTED, REDACTED], quando: when });
  assert.ok(value.quando instanceof Date);
  assert.equal(removed, 4);
  assert.deepEqual(redactDeep(value), { value, removed: 0 });
});
