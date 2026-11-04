# session-namer (resumo em português)

A documentação completa está em inglês no [README.md](README.md). Este resumo cobre o essencial.

**O que faz:** cada sessão de um agente de programação com IA passa a ter um título legível, `<projeto> - <assunto>`, escrito a partir da primeira mensagem real e no idioma em que a escreveste. O título fica estável no terminal, na lista de sessões, no VS Code e no telemóvel (Remote Control). Funciona no Claude Code e em mais treze agentes.

```
Títulos nativos                     Com session-namer
Fix failing tests                   api - Fix failing invoice export tests
Fix failing tests                   webapp - Fix flaky checkout e2e tests
Migra as faturas para a V10 e…      arcva-2.0 - Migração de faturas para V10
```

**Instalar no Claude Code** (dentro de uma sessão):

```
/plugin marketplace add brunobola-portfolio/claude-session-namer
/plugin install session-namer@claude-session-namer
```

**Instalar em qualquer agente suportado** (num terminal):

```bash
# mostra o que vai mudar (não escreve nada)
npx -y github:brunobola-portfolio/claude-session-namer#v1.2.0 install --detect --dry-run

# configura todos os agentes suportados encontrados no PATH
npx -y github:brunobola-portfolio/claude-session-namer#v1.2.0 install --detect
```

O `--detect` configura todos os agentes suportados que estiverem no `PATH`. A maioria não precisa de mais nada; o instalador indica os passos únicos de alguns (no Codex CLI, confiar nos hooks em `/hooks` e arrancar o daemon com `codex app-server daemon start` para ver o título na TUI; no Copilot CLI, `/experimental on`; no Grok, confiar nos hooks uma vez por pasta). `status` mostra o que está instalado e `uninstall` desfaz tudo.

**Requisitos:** Node.js 18 ou superior; Claude Code 2.1.152 ou superior para o plugin; o `claude` CLI com sessão iniciada, que escreve o assunto na maioria dos agentes (o Pi, o OpenCode e o Kilo CLI podem usar o seu próprio modelo, e o Codex CLI também, se o ativares; o OpenCode, o Crush e o goose usam o próprio título se o `claude` faltar).

**Agentes suportados:**

- Título automático da sessão, verificado ao vivo: Claude Code, Codex CLI, Pi, OpenCode, Kilo CLI, Copilot CLI, Cline CLI, Crush, goose, DeepSeek Harness e Grok Build.
- Título automático, parcialmente verificado: Amp.
- Só o título do separador do terminal: Gemini CLI e Qwen Code.

O Claude Code é estável; os restantes adaptadores estão em beta. A matriz completa está em [docs/harnesses.md](docs/harnesses.md).

**Como funciona:** ao arrancar, a sessão recebe o nome do projeto (nome do repositório git, o mesmo em todas as worktrees). Na primeira mensagem real, um modelo rápido resume o pedido em 3 a 7 palavras, por cerca de 0,004 USD por sessão, através de um login que já tens. Mensagens triviais (`ok`, `continua`, comandos com `/`) não gastam nada. Títulos que definas à mão nunca são alterados.

**Comando `/session-name`** (Claude Code):

| Comando | Efeito |
| :-- | :-- |
| `/session-name Nome que eu quero` | Renomeia já para `<projeto> - Nome que eu quero` e bloqueia-o |
| `/session-name` ou `/session-name --regenerate` | Volta ao nome do projeto e gera um assunto novo na próxima mensagem |
| `/session-name --remote` | Explica como continuar a sessão no telemóvel ou no browser |
| `/session-name --doctor` | Diagnóstico completo |

**Privacidade:** uma chamada ao modelo por sessão (até três, se falhar), através do teu próprio login. Sem telemetria, sem dependências e sem serviços de terceiros. Mais detalhes em [SECURITY.md](SECURITY.md).

**Apoiar o projeto:** [Ko-fi](https://ko-fi.com/brunobola) ou [Buy Me a Coffee](https://buymeacoffee.com/brunobola).

Licença MIT, © 2026 BolaLabs.
