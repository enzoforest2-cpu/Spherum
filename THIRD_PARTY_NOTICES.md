# Avisos de terceiros

O motor dos Xodós usa uma biblioteca e adapta trechos de três projetos de código aberto. Os créditos e as licenças estão abaixo.

## Biblioteca usada como dependência

- **pi-ai** (`@earendil-works/pi-ai`), Earendil Works, licença MIT. É a camada de modelos: catálogo de provedores e preços, protocolos de cada provedor e a passagem da conversa de um provedor para outro. Usada como pacote npm, sem alterações.

## Código e desenho adaptados

### Rakazo

Copyright dos autores do Rakazo (github.com/elie222/rakazo), licença Apache 2.0 (https://www.apache.org/licenses/LICENSE-2.0).

- `src/lib/xodos/vault.ts`: formato do cofre (AES-256-GCM, chave derivada por scrypt com sal por registro, AAD ligado ao registro), de `packages/adapters/src/secrets.ts`.
- `src/lib/xodos/brain.ts`: lista de modelos reserva em ordem com troca no meio da tarefa, inspirada em `SpaceBackupModel` e no fluxo de troca de modelo do `pi-runtime.ts`.
- `src/lib/xodos/policy.ts`, `actions.ts`, `runner.ts`: regras "sempre permitir" e "exigir aprovação", e execução única do pedido guardado, a partir de `packages/core/src/action-approval.ts` e do fluxo de `ExternalEffect`. Mudança nossa: "exigir aprovação" sempre vence.
- `src/lib/computer/provider.ts`, `lifecycle.ts`: interface de computador e ciclo de vida da máquina (criar, pausar, retomar, recriar quando some), com o estado no Postgres.
- `src/lib/computer/providers/e2b.ts` e `daytona.ts`: de `packages/adapters/src/e2b-sandbox.ts` e `daytona-sandbox.ts` (opções de criação, retomada, detecção de máquina que sumiu).
- `src/lib/computer/desktop.ts` e `sandbox/prepare.sh`: preparo do desktop Linux, de `PREPARE_LINUX_DESKTOP` (`packages/adapters/src/linux-desktop.ts`), `infra/sandboxes/computer/` e `packages/core/src/node/desktop-runtime.ts`.
- `sandbox/page-browser.py` e `src/lib/computer/tools/browser.ts`: foto da página com refs e ações por CDP, de `infra/sandboxes/computer/rakazo-page-browser`.
- `src/lib/computer/control.ts` e `tools/control.ts`: tokens de tela e controle, pedido de controle e retomada, de `packages/adapters/src/takeover-resume.ts` e do `request_takeover`.

### OpenMausBot

Copyright 2026 Milind Soni e contribuidores do OpenMausBot, licença Apache 2.0. Nada da pasta `enterprise/` foi usado; o nome e o mascote do OpenMausBot são marcas dos seus donos e não foram usados.

- `src/lib/xodos/redact.ts`: prefixos de chave, PEM, Bearer, KEY=VALUE e senha em URL, de `shared/redact.ts`.
- `src/lib/xodos/memory/entries.ts`, `store.ts`, `recall.ts`, `capture.ts` e `upkeep.ts`: regras das notas, recall, captura automática e arrumação, de `server/memory-entries.ts`, `server/recall.ts`, `server/message-db.ts`, `server/workspace.ts`, `server/memory-capture.ts`, `server/memory-organize.ts`, `server/memory-tidy.ts` e `server/memory-upkeep.ts`.
- `src/lib/computer/safety-floor.ts` e `tools/terminal.ts`: lexer POSIX e nunca-lista de comandos, portados de `server/safety-floor.ts` e `server/safety-floor-gate.ts`.
- `src/lib/computer/sites.ts`: palavras de ação dos rótulos, de `shared/outbound.ts`.
- `sandbox/page-browser.py` e `tools/browser.ts`: campos sensíveis, de `server/browser/cdp/sensitive.ts`.
- `src/lib/computer/gateway.ts`, `control.ts` e `desktop.ts`: pessoa no controle para o agente e ambiente limpo dos comandos.

- `src/lib/xodos/memory.ts` e `policy.ts`: desenho da memória curta carregada em toda conversa, limpeza de segredos antes de salvar, piso de segurança para o que sai para fora e aviso de gasto no percentual escolhido.

### OpenDots

Copyright (c) Atai Barkai, licença MIT.

- `src/lib/xodos/net.ts`: guarda contra endereços internos (SSRF), de `src/browser/security.ts`. Mudança nossa: só as faixas reservadas exatas são bloqueadas (o original bloqueava blocos /16 inteiros com endereços públicos).
- `src/lib/xodos/actions.ts`: aprovação que executa só o pedido guardado no servidor, uma vez, com prazo, a partir de `src/server/connection-routes.ts`.
- `src/lib/computer/tools/files.ts`: regras do caminho relativo, de `src/shared/computer-types.ts`.
- `src/lib/computer/tools/terminal.ts`: resultado só com código e saídas, como o exec de `src/server/computer-service.ts`.
- `src/lib/computer/gateway.ts`: caminho único auditado de toda ferramenta do computador, como o `audited()`; partes do computador desligadas por padrão.

A licença MIT pede que este aviso acompanhe as cópias:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.

### claude-ads

Copyright (c) 2026 Daniel Agrici (AgriciDaniel), licença MIT (github.com/AgriciDaniel/claude-ads).

- `src/lib/xodos/skills/ads.ts`: guia de mídia paga do xodó, adaptado de `ads/references/budget-allocation.md`, `ads/references/meta-audit.md` (limites de uma recomendação) e `skills/ads-monitor`, `skills/ads-math` e `skills/ads-optimize`.
- `src/lib/integrations/ads/audit.ts`: estados das verificações, pesos por gravidade e regra de cobertura, de `ads/references/scoring-system.md`. As verificações em si são do Spherum.
- Aviso sobre conversões do TikTok (só o evento otimizado) em `src/lib/xodos/tools.ts`, de `ads/references/tiktok-audit.md`.

> MIT License — Copyright (c) 2026 Daniel Agrici (AgriciDaniel). Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
