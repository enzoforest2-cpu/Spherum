# Xodós

Colegas de IA que trabalham para você, rodando no seu computador.

Os xodós vieram do Spherum: o mesmo motor (conversa com vários modelos de IA, memória,
rotinas, aprovações e teto de gasto), sem nada de agência. Eles pesquisam na internet,
leem páginas e cuidam de uma pasta de arquivos só deles. Você usa a sua própria chave de IA.

Em construção. O guia de instalação para Windows vem junto com o pacote.

## Para desenvolver

```bash
npm install
npm test
```

- `src/xodos`: o motor (copiado do Spherum e adaptado para uso pessoal).
- `src/local`: o que é só do app pessoal (ferramentas de internet e da pasta, travas desligadas).
- `db/`: o banco, que roda embutido (PGlite) e fica num arquivo no seu computador.
