🌐 Esta é uma tradução mantida pela comunidade. Correções são bem-vindas!

---

<h1 align="center">
  <br>
  <a href="https://github.com/thedotmack/claude-mem">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/claude-mem-logo-for-dark-mode.webp">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/claude-mem-logo-for-light-mode.webp">
      <img src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/claude-mem-logo-for-light-mode.webp" alt="Claude-Mem" width="400">
    </picture>
  </a>
  <br>
</h1>

**Languages:** [English](../../README.md) · [中文](./README.zh.md) · [Español](./README.es.md) · [Français](./README.fr.md) · [Português](./README.pt-br.md) · [Русский](./README.ru.md) · [Deutsch](./README.de.md)

<h4 align="center">Sistema de compressão de memória persistente criado para <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/version-6.5.0-green.svg" alt="Version">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg" alt="Node">
  </a>
  <a href="https://github.com/thedotmack/awesome-claude-code">
    <img src="https://awesome.re/mentioned-badge.svg" alt="Mentioned in Awesome Claude Code">
  </a>
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/15496" target="_blank">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/trendshift-badge-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/trendshift-badge.svg">
      <img src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/trendshift-badge.svg" alt="thedotmack/claude-mem | Trendshift" width="250" height="55"/>
    </picture>
  </a>
</p>

<br>

<table align="center">
  <tr>
    <td align="center">
      <a href="https://github.com/thedotmack/claude-mem">
        <picture>
          <img
            src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/cm-preview.gif"
            alt="Claude-Mem Preview"
            width="500"
          >
        </picture>
      </a>
    </td>
    <td align="center">
      <a href="https://www.star-history.com/#thedotmack/claude-mem&Date">
        <picture>
          <source
            media="(prefers-color-scheme: dark)"
            srcset="https://api.star-history.com/image?repos=thedotmack/claude-mem&type=date&theme=dark&legend=top-left"
          />
          <source
            media="(prefers-color-scheme: light)"
            srcset="https://api.star-history.com/image?repos=thedotmack/claude-mem&type=date&legend=top-left"
          />
          <img
            alt="Star History Chart"
            src="https://api.star-history.com/image?repos=thedotmack/claude-mem&type=date&legend=top-left"
            width="500"
          />
        </picture>
      </a>
    </td>
  </tr>
</table>

<p align="center">
  <a href="#quick-start">Início rápido</a> •
  <a href="#how-it-works">Como funciona</a> •
  <a href="#mcp-search-tools">Ferramentas de busca</a> •
  <a href="#documentation">Documentação</a> •
  <a href="#configuration">Configuração</a> •
  <a href="#troubleshooting">Solução de problemas</a> •
  <a href="#license">Licença</a>
</p>

<p align="center">
  O Claude-Mem preserva contexto entre sessões ao capturar automaticamente observações de uso de ferramentas, gerar resumos semânticos e disponibilizá-los para sessões futuras. Isso permite que o Claude mantenha a continuidade do conhecimento sobre projetos mesmo após o fim ou a reconexão das sessões.
</p>

---

## Início rápido

Instale com um único comando:

```bash
npx claude-mem install
```

Ou instale para o Gemini CLI (detecta automaticamente `~/.gemini`):

```bash
npx claude-mem install --ide gemini-cli
```
Ou instale para o OpenCode:

```bash
npx claude-mem install --ide opencode
```

Ou instale pelo marketplace de plugins dentro do Claude Code:

```bash
/plugin marketplace add thedotmack/claude-mem

/plugin install claude-mem
```

Reinicie o Claude Code ou o Gemini CLI. O contexto de sessões anteriores aparecerá automaticamente nas novas sessões.

> **Nota:** O Claude-Mem também está publicado no npm, mas `npm install -g claude-mem` instala **apenas o SDK/biblioteca** — não registra os hooks do plugin nem configura o serviço worker. Instale sempre via `npx claude-mem install` ou os comandos `/plugin` acima.

### 🦞 OpenClaw Gateway

Instale o claude-mem como plugin de memória persistente em gateways [OpenClaw](https://openclaw.ai) com um único comando:

```bash
curl -fsSL https://install.cmem.ai/openclaw.sh | bash
```

O instalador cuida de dependências, configuração do plugin, provedor de IA, inicialização do worker e feeds opcionais de observação em tempo real para Telegram, Discord, Slack e mais. Veja o [Guia de integração OpenClaw](https://docs.claude-mem.ai/openclaw-integration) para detalhes.

**Principais recursos:**

- 🧠 **Memória persistente** - O contexto sobrevive entre sessões
- 📊 **Divulgação progressiva** - Recuperação de memória em camadas com visibilidade do custo em tokens
- 🔍 **Busca baseada em skills** - Consulte o histórico do projeto com a skill mem-search
- 🖥️ **Interface web** - Fluxo de memória em tempo real em http://localhost:37777
- 💻 **Skill do Claude Desktop** - Busque na memória a partir de conversas do Claude Desktop
- 🔒 **Controle de privacidade** - Use tags `<private>` para excluir conteúdo sensível do armazenamento
- ⚙️ **Configuração de contexto** - Controle detalhado sobre o contexto injetado
- 🤖 **Operação automática** - Nenhuma intervenção manual necessária
- 🔗 **Citações** - Referencie observações anteriores por ID (acesse via http://localhost:37777/api/observation/{id} ou veja todas na interface web em http://localhost:37777)
- 🧪 **Canal beta** - Experimente recursos como Endless Mode alternando versões

---

## Documentação

📚 **[Ver documentação completa](https://docs.claude-mem.ai/)** - Navegue no site oficial

### Primeiros passos

- **[Guia de instalação](https://docs.claude-mem.ai/installation)** - Início rápido e instalação avançada
- **[Configuração do Gemini CLI](https://docs.claude-mem.ai/gemini-cli/setup)** - Guia dedicado para integração com o Gemini CLI do Google
- **[Guia de uso](https://docs.claude-mem.ai/usage/getting-started)** - Como o Claude-Mem funciona automaticamente
- **[Ferramentas de busca](https://docs.claude-mem.ai/usage/search-tools)** - Consulte o histórico do projeto em linguagem natural
- **[Recursos beta](https://docs.claude-mem.ai/beta-features)** - Experimente recursos como Endless Mode

### Boas práticas

- **[Engenharia de contexto](https://docs.claude-mem.ai/context-engineering)** - Princípios de otimização de contexto para agentes de IA
- **[Divulgação progressiva](https://docs.claude-mem.ai/progressive-disclosure)** - Filosofia por trás da estratégia de preparação de contexto do Claude-Mem

### Arquitetura

- **[Visão geral](https://docs.claude-mem.ai/architecture/overview)** - Componentes do sistema e fluxo de dados
- **[Evolução da arquitetura](https://docs.claude-mem.ai/architecture-evolution)** - A jornada da v3 à v5
- **[Arquitetura de hooks](https://docs.claude-mem.ai/hooks-architecture)** - Como o Claude-Mem usa hooks do ciclo de vida
- **[Referência de hooks](https://docs.claude-mem.ai/architecture/hooks)** - Explicação de 7 scripts de hooks
- **[Serviço worker](https://docs.claude-mem.ai/architecture/worker-service)** - API HTTP e gerenciamento com Bun
- **[Banco de dados](https://docs.claude-mem.ai/architecture/database)** - Esquema SQLite e busca FTS5
- **[Arquitetura de busca](https://docs.claude-mem.ai/architecture/search-architecture)** - Busca híbrida com banco de dados vetorial Chroma

### Configuração e desenvolvimento

- **[Configuração](https://docs.claude-mem.ai/configuration)** - Variáveis de ambiente e ajustes
- **[Desenvolvimento](https://docs.claude-mem.ai/development)** - Compilação, testes e contribuição
- **[Solução de problemas](https://docs.claude-mem.ai/troubleshooting)** - Problemas comuns e soluções

---

## Como funciona

**Componentes principais:**

1. **5 hooks do ciclo de vida** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 scripts de hooks)
2. **Smart Install** - Verificador de dependências em cache (script pre-hook, não é um hook do ciclo de vida)
3. **Serviço worker** - API HTTP na porta 37777 com interface web e 10 endpoints de busca, gerenciado pelo Bun
4. **Banco de dados SQLite** - Armazena sessões, observações e resumos
5. **Skill mem-search** - Consultas em linguagem natural com divulgação progressiva
6. **Banco de dados vetorial Chroma** - Busca híbrida semântica + palavras-chave para recuperação inteligente de contexto

Veja a [Visão geral da arquitetura](https://docs.claude-mem.ai/architecture/overview) para detalhes.

---

## Ferramentas de busca MCP

O Claude-Mem oferece busca inteligente de memória por meio de **4 ferramentas MCP** seguindo um **padrão de fluxo de trabalho em 3 camadas** eficiente em tokens:

**Fluxo de trabalho em 3 camadas:**

1. **`search`** - Obtenha um índice compacto com IDs (~50-100 tokens/resultado)
2. **`timeline`** - Obtenha contexto cronológico em torno de resultados interessantes
3. **`get_observations`** - Obtenha detalhes completos SOMENTE para IDs filtrados (~500-1.000 tokens/resultado)

**Como funciona:**
- O Claude usa ferramentas MCP para buscar na sua memória
- Comece com `search` para obter um índice de resultados
- Use `timeline` para ver o que acontecia em torno de observações específicas
- Use `get_observations` para obter detalhes completos dos IDs relevantes
- **~10x economia de tokens** ao filtrar antes de buscar detalhes

**Ferramentas MCP disponíveis:**

1. **`search`** - Busque no índice de memória com consultas de texto completo, filtros por tipo/data/projeto
2. **`timeline`** - Obtenha contexto cronológico em torno de uma observação ou consulta específica
3. **`get_observations`** - Obtenha detalhes completos de observações por IDs (sempre agrupe vários IDs)

**Exemplo de uso:**

```typescript
// Step 1: Search for index
search(query="authentication bug", type="bugfix", limit=10)

// Step 2: Review index, identify relevant IDs (e.g., #123, #456)

// Step 3: Fetch full details
get_observations(ids=[123, 456])
```

Veja o [Guia de ferramentas de busca](https://docs.claude-mem.ai/usage/search-tools) para exemplos detalhados.

---

## Recursos beta

O Claude-Mem oferece um **canal beta** com recursos experimentais como **Endless Mode** (arquitetura de memória biomimética para sessões estendidas). Alterne entre versões estável e beta na interface web em http://localhost:37777 → Settings.

Veja a **[Documentação de recursos beta](https://docs.claude-mem.ai/beta-features)** para detalhes sobre Endless Mode e como experimentá-lo.

---

## Requisitos do sistema

- **Node.js**: 18.0.0 ou superior
- **Claude Code**: Versão mais recente com suporte a plugins
- **Bun**: Runtime JavaScript e gerenciador de processos (instalado automaticamente se ausente)
- **uv**: Gerenciador de pacotes Python para busca vetorial (instalado automaticamente se ausente)
- **SQLite 3**: Para armazenamento persistente (incluído)

---
### Notas de instalação no Windows

Se você vir um erro como:

```powershell
npm : The term 'npm' is not recognized as the name of a cmdlet
```

Certifique-se de que Node.js e npm estão instalados e adicionados ao PATH. Baixe o instalador mais recente do Node.js em https://nodejs.org e reinicie o terminal após a instalação.

---

## Configuração

As configurações são gerenciadas em `~/.claude-mem/settings.json` (criado automaticamente com padrões na primeira execução). Configure o modelo de IA, porta do worker, diretório de dados, nível de log e configurações de injeção de contexto.

Veja o **[Guia de configuração](https://docs.claude-mem.ai/configuration)** para todas as configurações disponíveis e exemplos.

### Configuração de modo e idioma

O Claude-Mem suporta vários modos de fluxo de trabalho e idiomas via a configuração `CLAUDE_MEM_MODE`.

Esta opção controla ambos:
- O comportamento do fluxo de trabalho (p. ex. code, chill, investigation)
- O idioma usado nas observações geradas

#### Como configurar

Edite seu arquivo de configurações em `~/.claude-mem/settings.json`:

```json
{
  "CLAUDE_MEM_MODE": "code--zh"
}
```

Os modos são definidos em `plugin/modes/`. Para ver todos os modos disponíveis localmente:

```bash
ls ~/.claude/plugins/marketplaces/thedotmack/plugin/modes/
```

#### Modos disponíveis

| Modo | Descrição |
|------------|-------------------------|
| `code` | Modo padrão em inglês |
| `code--zh` | Modo de chinês simplificado |
| `code--ja` | Modo de japonês |

Modos específicos de idioma seguem o padrão `code--[lang]`, onde `[lang]` é o código de idioma ISO 639-1 (p. ex., `zh` para chinês, `ja` para japonês, `es` para espanhol).

> Nota: `code--zh` (chinês simplificado) já está integrado — nenhuma instalação adicional ou atualização do plugin é necessária.

#### Após alterar o modo

Reinicie o Claude Code para aplicar a nova configuração de modo.
---

## Desenvolvimento

Veja o **[Guia de desenvolvimento](https://docs.claude-mem.ai/development)** para instruções de compilação, testes e fluxo de contribuição.

---

## Solução de problemas

Se tiver problemas, descreva-os ao Claude e a skill troubleshoot diagnosticará automaticamente e fornecerá correções.

Veja o **[Guia de solução de problemas](https://docs.claude-mem.ai/troubleshooting)** para problemas comuns e soluções.

---

## Relatórios de bugs

Crie relatórios de bugs completos com o gerador automatizado:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Contribuir

Contribuições são bem-vindas! Por favor:

1. Faça fork do repositório
2. Crie um branch de funcionalidade
3. Faça suas alterações com testes
4. Atualize a documentação
5. Envie um Pull Request

Veja o [Guia de desenvolvimento](https://docs.claude-mem.ai/development) para o fluxo de contribuição.

---

## Licença

O Claude-Mem está licenciado sob a Apache License 2.0.

Escolhemos Apache-2.0 porque a memória persistente de agentes deve ser fácil de integrar em
ferramentas para desenvolvedores, agentes locais, servidores MCP, sistemas empresariais, stacks de robótica,
e frameworks de agentes em produção.

Veja o arquivo [LICENSE](LICENSE) para detalhes completos. Veja [docs/license.md](docs/license.md)
e [docs/ip-boundary.md](docs/ip-boundary.md) para o escopo da licença e a
fronteira open/comercial.

**Nota sobre Ragtime**: O diretório `ragtime/` está licenciado sob **Apache License 2.0**. Veja [ragtime/LICENSE](ragtime/LICENSE) para detalhes.

---

## Suporte

- **Documentação**: [docs/](docs/)
- **Issues**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repositório**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Conta oficial no X**: [@Claude_Memory](https://x.com/Claude_Memory)
- **Discord oficial**: [Entrar no Discord](https://discord.com/invite/J4wttp9vDu)
- **Autor**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Feito com Claude Agent SDK** | **Funciona com Claude Code** | **Feito com TypeScript**

---

### E o $CMEM?

$CMEM é um token Solana criado por terceiros sem consentimento prévio do Claude-Mem, mas oficialmente abraçado pelo criador do Claude-Mem (Alex Newman, @thedotmack). O token atua como catalisador comunitário para crescimento e veículo para levar dados de agentes em tempo real aos desenvolvedores e trabalhadores do conhecimento que mais precisam. $CMEM: 2TsmuYUrsctE57VLckZBYEEzdokUF8j8e1GavekWBAGS
