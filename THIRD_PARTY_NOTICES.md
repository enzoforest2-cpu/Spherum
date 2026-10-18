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

### OpenMausBot

Copyright 2026 Milind Soni e contribuidores do OpenMausBot, licença Apache 2.0. Nada da pasta `enterprise/` foi usado; o nome e o mascote do OpenMausBot são marcas dos seus donos e não foram usados.

- `src/lib/xodos/memory.ts` e `policy.ts`: desenho da memória curta carregada em toda conversa, limpeza de segredos antes de salvar, piso de segurança para o que sai para fora e aviso de gasto no percentual escolhido.

### OpenDots

Copyright (c) Atai Barkai, licença MIT.

- `src/lib/xodos/net.ts`: guarda contra endereços internos (SSRF), de `src/browser/security.ts`. Mudança nossa: só as faixas reservadas exatas são bloqueadas (o original bloqueava blocos /16 inteiros com endereços públicos).
- `src/lib/xodos/actions.ts`: aprovação que executa só o pedido guardado no servidor, uma vez, com prazo, a partir de `src/server/connection-routes.ts`.

A licença MIT pede que este aviso acompanhe as cópias:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
