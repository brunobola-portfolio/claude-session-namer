# claude-session-namer (resumo em português)

A documentação completa está em inglês no [README.md](README.md). Este resumo cobre o essencial.

**O que faz:** cada sessão do Claude Code passa a ter um título legível, `<projecto> - <assunto>`, gerado automaticamente a partir da primeira mensagem, no idioma em que a escreveste. Funciona no CLI, na extensão do VS Code e no Remote Control (claude.ai/code e app móvel), em Windows, macOS e Linux.

```
Antes                              Depois
bruno-w11-graceful-unicorn         arcva-2.0 - Migração de faturas para V10
```

**Instalar** (dentro do Claude Code):

```
/plugin marketplace add brunobola-portfolio/claude-session-namer
/plugin install session-namer@claude-session-namer
```

Requisitos: Claude Code 2.1.94 ou superior e Node.js 18 ou superior no `PATH`.

**Como funciona:** ao arrancar, a sessão recebe o nome do projecto (pasta do repositório git). Na primeira mensagem real, um modelo rápido resume o pedido em 3 a 7 palavras e o título passa a `<projecto> - <assunto>`. Custa cerca de 0,4 cêntimos e 5 segundos por sessão. Títulos que definas à mão (`--name`, `/rename`, claude.ai) nunca são alterados.

**Comando `/session-name`:**

| Comando | Efeito |
| :-- | :-- |
| `/session-name Nome que eu quero` | Renomeia já para `<projecto> - Nome que eu quero` e bloqueia |
| `/session-name` | Volta ao nome do projecto e gera um assunto novo na próxima mensagem |
| `/session-name --remote` | Explica como continuar a sessão no telemóvel ou browser |
| `/session-name --doctor` | Diagnóstico completo |

**Remote Control:** escreve `/rc` numa sessão para a ligar, ou define `"remoteControlAtStartup": true` em `~/.claude/settings.json` para ligar todas. A partir do terminal usa `claude --rc` sem nome, porque um nome passado ao `--remote-control` sobrepõe-se ao título do plugin.

**Privacidade:** a única chamada de rede é o pedido headless ao teu próprio Claude Code para resumir a primeira mensagem. Sem telemetria, sem dependências, sem tocar no transcript.

Licença MIT.
