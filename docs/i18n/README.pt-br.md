🌐 Esta é uma tradução automatizada. Correções da comunidade são bem-vindas!

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

<p align="center">
  <a href="README.zh.md">🇨🇳 中文</a> •
  <a href="README.zh-tw.md">🇹🇼 繁體中文</a> •
  <a href="README.ja.md">🇯🇵 日本語</a> •
  <a href="README.pt-br.md">🇧🇷 Português</a> •
  <a href="README.ko.md">🇰🇷 한국어</a> •
  <a href="README.es.md">🇪🇸 Español</a> •
  <a href="README.de.md">🇩🇪 Deutsch</a> •
  <a href="README.fr.md">🇫🇷 Français</a>
  <a href="README.he.md">🇮🇱 עברית</a> •
  <a href="README.ar.md">🇸🇦 العربية</a> •
  <a href="README.ru.md">🇷🇺 Русский</a> •
  <a href="README.pl.md">🇵🇱 Polski</a> •
  <a href="README.cs.md">🇨🇿 Čeština</a> •
  <a href="README.nl.md">🇳🇱 Nederlands</a> •
  <a href="README.tr.md">🇹🇷 Türkçe</a> •
  <a href="README.uk.md">🇺🇦 Українська</a> •
  <a href="README.vi.md">🇻🇳 Tiếng Việt</a> •
  <a href="README.id.md">🇮🇩 Indonesia</a> •
  <a href="README.th.md">🇹🇭 ไทย</a> •
  <a href="README.hi.md">🇮🇳 हिन्दी</a> •
  <a href="README.bn.md">🇧🇩 বাংলা</a> •
  <a href="README.ur.md">🇵🇰 اردو</a> •
  <a href="README.ro.md">🇷🇴 Română</a> •
  <a href="README.sv.md">🇸🇪 Svenska</a> •
  <a href="README.it.md">🇮🇹 Italiano</a> •
  <a href="README.el.md">🇬🇷 Ελληνικά</a> •
  <a href="README.hu.md">🇭🇺 Magyar</a> •
  <a href="README.fi.md">🇫🇮 Suomi</a> •
  <a href="README.da.md">🇩🇰 Dansk</a> •
  <a href="README.no.md">🇳🇴 Norsk</a>
</p>

<h4 align="center">Sistema de compressão de memória persistente construído para <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-AGPL%203.0-blue.svg" alt="License">
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

<p align="center">
  <a href="https://github.com/thedotmack/claude-mem">
    <picture>
      <img src="https://raw.githubusercontent.com/thedotmack/claude-mem/main/docs/public/cm-preview.gif" alt="Claude-Mem Preview" width="800">
    </picture>
  </a>
</p>

<p align="center">
  <a href="#início-rápido">Início Rápido</a> •
  <a href="#como-funciona">Como Funciona</a> •
  <a href="#ferramentas-de-busca-mcp">Ferramentas de Busca</a> •
  <a href="#documentação">Documentação</a> •
  <a href="#configuração">Configuração</a> •
  <a href="#solução-de-problemas">Solução de Problemas</a> •
  <a href="#licença">Licença</a>
</p>

<p align="center">
  Claude-Mem preserva o contexto perfeitamente entre sessões, capturando automaticamente observações de uso de ferramentas, gerando resumos semânticos e disponibilizando-os para sessões futuras. Isso permite que Claude mantenha a continuidade do conhecimento sobre projetos mesmo após o término ou reconexão de sessões.
</p>

---

## Início Rápido

Inicie uma nova sessão do Claude Code no terminal e digite os seguintes comandos:

```
> /plugin marketplace add thedotmack/claude-mem

> /plugin install claude-mem
```

Reinicie o Claude Code. O contexto de sessões anteriores aparecerá automaticamente em novas sessões.

**Principais Recursos:**

- 🧠 **Memória Persistente** - O contexto sobrevive entre sessões
- 📊 **Divulgação Progressiva** - Recuperação de memória em camadas com visibilidade de custo de tokens
- 🔍 **Busca Baseada em Skill** - Consulte seu histórico de projeto com a skill mem-search
- 🖥️ **Interface Web de Visualização** - Fluxo de memória em tempo real em http://localhost:37777
- 💻 **Skill para Claude Desktop** - Busque memória em conversas do Claude Desktop
- 🔒 **Controle de Privacidade** - Use tags `<private>` para excluir conteúdo sensível do armazenamento
- ⚙️ **Configuração de Contexto** - Controle refinado sobre qual contexto é injetado
- 🤖 **Operação Automática** - Nenhuma intervenção manual necessária
- 🔗 **Citações** - Referencie observações passadas com IDs (acesse via http://localhost:37777/api/observation/{id} ou visualize todas no visualizador web em http://localhost:37777)
- 🧪 **Canal Beta** - Experimente recursos experimentais como o Endless Mode através da troca de versões

---

## Documentação

📚 **[Ver Documentação Completa](https://docs.claude-mem.ai/)** - Navegar no site oficial

### Começando

- **[Guia de Instalação](https://docs.claude-mem.ai/installation)** - Início rápido e instalação avançada
- **[Guia de Uso](https://docs.claude-mem.ai/usage/getting-started)** - Como Claude-Mem funciona automaticamente
- **[Ferramentas de Busca](https://docs.claude-mem.ai/usage/search-tools)** - Consulte seu histórico de projeto com linguagem natural
- **[Recursos Beta](https://docs.claude-mem.ai/beta-features)** - Experimente recursos experimentais como o Endless Mode

### Melhores Práticas

- **[Engenharia de Contexto](https://docs.claude-mem.ai/context-engineering)** - Princípios de otimização de contexto para agentes de IA
- **[Divulgação Progressiva](https://docs.claude-mem.ai/progressive-disclosure)** - Filosofia por trás da estratégia de preparação de contexto do Claude-Mem

### Arquitetura

- **[Visão Geral](https://docs.claude-mem.ai/architecture/overview)** - Componentes do sistema e fluxo de dados
- **[Evolução da Arquitetura](https://docs.claude-mem.ai/architecture-evolution)** - A jornada da v3 à v5
- **[Arquitetura de Hooks](https://docs.claude-mem.ai/hooks-architecture)** - Como Claude-Mem usa hooks de ciclo de vida
- **[Referência de Hooks](https://docs.claude-mem.ai/architecture/hooks)** - 7 scripts de hook explicados
- **[Serviço Worker](https://docs.claude-mem.ai/architecture/worker-service)** - API HTTP e gerenciamento do Bun
- **[Banco de Dados](https://docs.claude-mem.ai/architecture/database)** - Schema SQLite e busca FTS5
- **[Arquitetura de Busca](https://docs.claude-mem.ai/architecture/search-architecture)** - Busca híbrida com banco de dados vetorial Chroma

### Configuração e Desenvolvimento

- **[Configuração](https://docs.claude-mem.ai/configuration)** - Variáveis de ambiente e configurações
- **[Desenvolvimento](https://docs.claude-mem.ai/development)** - Build, testes e contribuição
- **[Solução de Problemas](https://docs.claude-mem.ai/troubleshooting)** - Problemas comuns e soluções

---

## Como Funciona

**Componentes Principais:**

1. **5 Hooks de Ciclo de Vida** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 scripts de hook)
2. **Instalação Inteligente** - Verificador de dependências em cache (script pré-hook, não um hook de ciclo de vida)
3. **Serviço Worker** - API HTTP na porta 37777 com interface de visualização web e 10 endpoints de busca, gerenciado pelo Bun
4. **Banco de Dados SQLite** - Armazena sessões, observações, resumos
5. **Skill mem-search** - Consultas em linguagem natural com divulgação progressiva
6. **Banco de Dados Vetorial Chroma** - Busca híbrida semântica + palavra-chave para recuperação inteligente de contexto

Veja [Visão Geral da Arquitetura](https://docs.claude-mem.ai/architecture/overview) para detalhes.

---

## Skill mem-search

Claude-Mem fornece busca inteligente através da skill mem-search que se auto-invoca quando você pergunta sobre trabalhos anteriores:

**Como Funciona:**
- Apenas pergunte naturalmente: *"O que fizemos na última sessão?"* ou *"Já corrigimos esse bug antes?"*
- Claude invoca automaticamente a skill mem-search para encontrar contexto relevante

**Operações de Busca Disponíveis:**

1. **Search Observations** - Busca de texto completo em observações
2. **Search Sessions** - Busca de texto completo em resumos de sessão
3. **Search Prompts** - Busca em solicitações brutas do usuário
4. **By Concept** - Encontre por tags de conceito (discovery, problem-solution, pattern, etc.)
5. **By File** - Encontre observações que referenciam arquivos específicos
6. **By Type** - Encontre por tipo (decision, bugfix, feature, refactor, discovery, change)
7. **Recent Context** - Obtenha contexto de sessão recente para um projeto
8. **Timeline** - Obtenha linha do tempo unificada de contexto em torno de um ponto específico no tempo
9. **Timeline by Query** - Busque observações e obtenha contexto de linha do tempo em torno da melhor correspondência
10. **API Help** - Obtenha documentação da API de busca

**Exemplos de Consultas em Linguagem Natural:**

```
"Quais bugs corrigimos na última sessão?"
"Como implementamos a autenticação?"
"Quais mudanças foram feitas em worker-service.ts?"
"Mostre-me trabalhos recentes neste projeto"
"O que estava acontecendo quando adicionamos a interface de visualização?"
```

Veja [Guia de Ferramentas de Busca](https://docs.claude-mem.ai/usage/search-tools) para exemplos detalhados.

---

## Recursos Beta

Claude-Mem oferece um **canal beta** com recursos experimentais como **Endless Mode** (arquitetura de memória biomimética para sessões estendidas). Alterne entre versões estável e beta pela interface de visualização web em http://localhost:37777 → Settings.

Veja **[Documentação de Recursos Beta](https://docs.claude-mem.ai/beta-features)** para detalhes sobre o Endless Mode e como experimentá-lo.

---

## Requisitos do Sistema

- **Node.js**: 18.0.0 ou superior
- **Claude Code**: Versão mais recente com suporte a plugins
- **Bun**: Runtime JavaScript e gerenciador de processos (instalado automaticamente se ausente)
- **uv**: Gerenciador de pacotes Python para busca vetorial (instalado automaticamente se ausente)
- **SQLite 3**: Para armazenamento persistente (incluído)

---

## Configuração

As configurações são gerenciadas em `~/.claude-mem/settings.json` (criado automaticamente com valores padrão na primeira execução). Configure modelo de IA, porta do worker, diretório de dados, nível de log e configurações de injeção de contexto.

Veja o **[Guia de Configuração](https://docs.claude-mem.ai/configuration)** para todas as configurações disponíveis e exemplos.

---

## Desenvolvimento

Veja o **[Guia de Desenvolvimento](https://docs.claude-mem.ai/development)** para instruções de build, testes e fluxo de contribuição.

---

## Solução de Problemas

Se você estiver enfrentando problemas, descreva o problema para Claude e a skill troubleshoot diagnosticará automaticamente e fornecerá correções.

Veja o **[Guia de Solução de Problemas](https://docs.claude-mem.ai/troubleshooting)** para problemas comuns e soluções.

---

## Relatos de Bug

Crie relatos de bug abrangentes com o gerador automatizado:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

## Contribuindo

Contribuições são bem-vindas! Por favor:

1. Faça um fork do repositório
2. Crie uma branch de feature
3. Faça suas alterações com testes
4. Atualize a documentação
5. Envie um Pull Request

Veja [Guia de Desenvolvimento](https://docs.claude-mem.ai/development) para o fluxo de contribuição.

---

## Licença

Este projeto está licenciado sob a **GNU Affero General Public License v3.0** (AGPL-3.0).

Copyright (C) 2025 Alex Newman (@thedotmack). Todos os direitos reservados.

Veja o arquivo [LICENSE](LICENSE) para detalhes completos.

**O Que Isso Significa:**

- Você pode usar, modificar e distribuir este software livremente
- Se você modificar e implantar em um servidor de rede, você deve disponibilizar seu código-fonte
- Trabalhos derivados também devem ser licenciados sob AGPL-3.0
- NÃO HÁ GARANTIA para este software

**Nota sobre Ragtime**: O diretório `ragtime/` é licenciado separadamente sob a **PolyForm Noncommercial License 1.0.0**. Veja [ragtime/LICENSE](ragtime/LICENSE) para detalhes.

---

## Suporte

- **Documentação**: [docs/](docs/)
- **Issues**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repositório**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Autor**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Construído com Claude Agent SDK** | **Desenvolvido por Claude Code** | **Feito com TypeScript**