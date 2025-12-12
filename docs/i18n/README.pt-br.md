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
  Claude-Mem preserva o contexto de forma contínua entre sessões, capturando automaticamente observações de uso de ferramentas, gerando resumos semânticos e disponibilizando-os para sessões futuras. Isso permite que Claude mantenha a continuidade do conhecimento sobre projetos mesmo após sessões terminarem ou reconectarem.
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

- 🧠 **Memória Persistente** - Contexto sobrevive entre sessões
- 📊 **Divulgação Progressiva** - Recuperação de memória em camadas com visibilidade de custo de tokens
- 🔍 **Busca Baseada em Habilidades** - Consulte o histórico do seu projeto com a habilidade mem-search (~2.250 tokens economizados)
- 🖥️ **Interface Web do Visualizador** - Fluxo de memória em tempo real em http://localhost:37777
- 🔒 **Controle de Privacidade** - Use tags `<private>` para excluir conteúdo sensível do armazenamento
- ⚙️ **Configuração de Contexto** - Controle refinado sobre qual contexto é injetado
- 🤖 **Operação Automática** - Nenhuma intervenção manual necessária
- 🔗 **Citações** - Referencie decisões passadas com URIs `claude-mem://`
- 🧪 **Canal Beta** - Experimente recursos experimentais como Modo Infinito via mudança de versão

---

## Documentação

📚 **[Ver Documentação Completa](docs/)** - Navegue pelos documentos markdown no GitHub

💻 **Visualização Local**: Execute os documentos Mintlify localmente:

```bash
cd docs
npx mintlify dev
```

### Primeiros Passos

- **[Guia de Instalação](https://docs.claude-mem.ai/installation)** - Início rápido e instalação avançada
- **[Guia de Uso](https://docs.claude-mem.ai/usage/getting-started)** - Como Claude-Mem funciona automaticamente
- **[Ferramentas de Busca](https://docs.claude-mem.ai/usage/search-tools)** - Consulte o histórico do seu projeto com linguagem natural
- **[Recursos Beta](https://docs.claude-mem.ai/beta-features)** - Experimente recursos experimentais como Modo Infinito

### Melhores Práticas

- **[Engenharia de Contexto](https://docs.claude-mem.ai/context-engineering)** - Princípios de otimização de contexto para agentes de IA
- **[Divulgação Progressiva](https://docs.claude-mem.ai/progressive-disclosure)** - Filosofia por trás da estratégia de preparação de contexto do Claude-Mem

### Arquitetura

- **[Visão Geral](https://docs.claude-mem.ai/architecture/overview)** - Componentes do sistema e fluxo de dados
- **[Evolução da Arquitetura](https://docs.claude-mem.ai/architecture-evolution)** - A jornada da v3 para a v5
- **[Arquitetura de Hooks](https://docs.claude-mem.ai/hooks-architecture)** - Como Claude-Mem usa hooks de ciclo de vida
- **[Referência de Hooks](https://docs.claude-mem.ai/architecture/hooks)** - 7 scripts de hooks explicados
- **[Serviço Worker](https://docs.claude-mem.ai/architecture/worker-service)** - API HTTP e gerenciamento PM2
- **[Banco de Dados](https://docs.claude-mem.ai/architecture/database)** - Esquema SQLite e busca FTS5
- **[Arquitetura de Busca](https://docs.claude-mem.ai/architecture/search-architecture)** - Busca híbrida com banco de dados vetorial Chroma

### Configuração e Desenvolvimento

- **[Configuração](https://docs.claude-mem.ai/configuration)** - Variáveis de ambiente e configurações
- **[Desenvolvimento](https://docs.claude-mem.ai/development)** - Build, testes, contribuição
- **[Solução de Problemas](https://docs.claude-mem.ai/troubleshooting)** - Problemas comuns e soluções

---

## Como Funciona

```
┌─────────────────────────────────────────────────────────────┐
│ Início de Sessão → Injeta observações recentes como contexto│
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Prompts do Usuário → Cria sessão, salva prompts do usuário  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Execuções de Ferramentas → Captura observações (Read, Write)│
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Processos Worker → Extrai aprendizados via Claude Agent SDK │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Fim de Sessão → Gera resumo, pronto para próxima sessão     │
└─────────────────────────────────────────────────────────────┘
```

**Componentes Principais:**

1. **5 Hooks de Ciclo de Vida** - SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd (6 scripts de hooks)
2. **Instalação Inteligente** - Verificador de dependências em cache (script pré-hook, não um hook de ciclo de vida)
3. **Serviço Worker** - API HTTP na porta 37777 com interface web do visualizador e 10 endpoints de busca, gerenciado pelo PM2
4. **Banco de Dados SQLite** - Armazena sessões, observações, resumos com busca de texto completo FTS5
5. **Habilidade mem-search** - Consultas em linguagem natural com divulgação progressiva (~2.250 tokens economizados vs MCP)
6. **Banco de Dados Vetorial Chroma** - Busca híbrida semântica + palavra-chave para recuperação inteligente de contexto

Veja [Visão Geral da Arquitetura](https://docs.claude-mem.ai/architecture/overview) para detalhes.

---

## Habilidade mem-search

Claude-Mem fornece busca inteligente através da habilidade mem-search que é auto-invocada quando você pergunta sobre trabalhos passados:

**Como Funciona:**
- Apenas pergunte naturalmente: *"O que fizemos na última sessão?"* ou *"Corrigimos esse bug antes?"*
- Claude invoca automaticamente a habilidade mem-search para encontrar contexto relevante
- ~2.250 tokens economizados por início de sessão vs abordagem MCP

**Operações de Busca Disponíveis:**

1. **Search Observations** - Busca de texto completo em observações
2. **Search Sessions** - Busca de texto completo em resumos de sessão
3. **Search Prompts** - Busca em solicitações brutas do usuário
4. **By Concept** - Encontra por tags de conceito (discovery, problem-solution, pattern, etc.)
5. **By File** - Encontra observações referenciando arquivos específicos
6. **By Type** - Encontra por tipo (decision, bugfix, feature, refactor, discovery, change)
7. **Recent Context** - Obtém contexto de sessão recente para um projeto
8. **Timeline** - Obtém linha do tempo unificada de contexto ao redor de um ponto específico no tempo
9. **Timeline by Query** - Busca por observações e obtém contexto da linha do tempo ao redor da melhor correspondência
10. **API Help** - Obtém documentação da API de busca

**Exemplos de Consultas em Linguagem Natural:**

```
"Que bugs corrigimos na última sessão?"
"Como implementamos a autenticação?"
"Que mudanças foram feitas em worker-service.ts?"
"Mostre-me trabalhos recentes neste projeto"
"O que estava acontecendo quando adicionamos a interface do visualizador?"
```

Veja [Guia de Ferramentas de Busca](https://docs.claude-mem.ai/usage/search-tools) para exemplos detalhados.

---

## Recursos Beta e Modo Infinito

Claude-Mem oferece um **canal beta** com recursos experimentais. Alterne entre versões estáveis e beta diretamente da interface web do visualizador.

### Como Experimentar o Beta

1. Abra http://localhost:37777
2. Clique em Configurações (ícone de engrenagem)
3. Em **Version Channel**, clique em "Try Beta (Endless Mode)"
4. Aguarde o worker reiniciar

Seus dados de memória são preservados ao alternar versões.

### Modo Infinito (Beta)

O recurso beta principal é o **Modo Infinito** - uma arquitetura de memória biomimética que estende dramaticamente a duração da sessão:

**O Problema**: Sessões padrão do Claude Code atingem limites de contexto após ~50 usos de ferramentas. Cada ferramenta adiciona 1-10k+ tokens, e Claude re-sintetiza todas as saídas anteriores em cada resposta (complexidade O(N²)).

**A Solução**: O Modo Infinito comprime saídas de ferramentas em observações de ~500 tokens e transforma o transcript em tempo real:

```
Memória de Trabalho (Contexto):     Observações comprimidas (~500 tokens cada)
Memória de Arquivo (Disco):         Saídas completas de ferramentas preservadas para recuperação
```

**Resultados Esperados**:
- ~95% de redução de tokens na janela de contexto
- ~20x mais usos de ferramentas antes da exaustão de contexto
- Escalabilidade linear O(N) ao invés de quadrática O(N²)
- Transcripts completos preservados para recuperação perfeita

**Ressalvas**: Adiciona latência (60-90s por ferramenta para geração de observação), ainda experimental.

Veja [Documentação de Recursos Beta](https://docs.claude-mem.ai/beta-features) para detalhes.

---

## Novidades

**v6.4.9 - Configurações de Contexto:**
- 11 novas configurações para controle refinado sobre injeção de contexto
- Configure exibição de economia de tokens, filtragem de observações por tipo/conceito
- Controle o número de observações e quais campos exibir

**v6.4.0 - Sistema de Privacidade de Duas Tags:**
- Tags `<private>` para privacidade controlada pelo usuário - envolva conteúdo sensível para excluir do armazenamento
- Tags `<claude-mem-context>` em nível de sistema previnem armazenamento recursivo de observações
- Processamento de borda garante que conteúdo privado nunca chegue ao banco de dados

**v6.3.0 - Canal de Versão:**
- Alterne entre versões estáveis e beta da interface web do visualizador
- Experimente recursos experimentais como Modo Infinito sem operações git manuais

**Destaques Anteriores:**
- **v6.0.0**: Grandes melhorias no gerenciamento de sessões e processamento de transcripts
- **v5.5.0**: Aprimoramento da habilidade mem-search com taxa de efetividade de 100%
- **v5.4.0**: Arquitetura de busca baseada em habilidades (~2.250 tokens economizados por sessão)
- **v5.1.0**: Interface web do visualizador com atualizações em tempo real
- **v5.0.0**: Busca híbrida com banco de dados vetorial Chroma

Veja [CHANGELOG.md](CHANGELOG.md) para histórico completo de versões.

---

## Requisitos do Sistema

- **Node.js**: 18.0.0 ou superior
- **Claude Code**: Versão mais recente com suporte a plugins
- **PM2**: Gerenciador de processos (incluído - não requer instalação global)
- **SQLite 3**: Para armazenamento persistente (incluído)

---

## Principais Benefícios

### Contexto de Divulgação Progressiva

- **Recuperação de memória em camadas** espelha padrões de memória humana
- **Camada 1 (Índice)**: Veja quais observações existem com custos de tokens no início da sessão
- **Camada 2 (Detalhes)**: Busque narrativas completas sob demanda via busca MCP
- **Camada 3 (Memória Perfeita)**: Acesse código-fonte e transcripts originais
- **Tomada de decisão inteligente**: Contagens de tokens ajudam Claude a escolher entre buscar detalhes ou ler código
- **Indicadores de tipo**: Pistas visuais (🔴 crítico, 🟤 decisão, 🔵 informacional) destacam importância da observação

### Memória Automática

- Contexto injetado automaticamente quando Claude inicia
- Nenhum comando manual ou configuração necessária
- Funciona de forma transparente em segundo plano

### Busca de Histórico Completo

- Busque em todas as sessões e observações
- Busca de texto completo FTS5 para consultas rápidas
- Citações vinculam de volta a observações específicas

### Observações Estruturadas

- Extração de aprendizados alimentada por IA
- Categorizado por tipo (decision, bugfix, feature, etc.)
- Marcado com conceitos e referências de arquivos

### Sessões com Múltiplos Prompts

- Sessões abrangem múltiplos prompts de usuário
- Contexto preservado entre comandos `/clear`
- Rastreie threads de conversação inteiros

---

## Configuração

As configurações são gerenciadas em `~/.claude-mem/settings.json`. O arquivo é criado automaticamente com valores padrão na primeira execução.

**Configurações Disponíveis:**

| Configuração | Padrão | Descrição |
|---------|---------|-------------|
| `CLAUDE_MEM_MODEL` | `claude-haiku-4-5` | Modelo de IA para observações |
| `CLAUDE_MEM_WORKER_PORT` | `37777` | Porta do serviço worker |
| `CLAUDE_MEM_DATA_DIR` | `~/.claude-mem` | Local do diretório de dados |
| `CLAUDE_MEM_LOG_LEVEL` | `INFO` | Verbosidade de log (DEBUG, INFO, WARN, ERROR, SILENT) |
| `CLAUDE_MEM_PYTHON_VERSION` | `3.13` | Versão do Python para chroma-mcp |
| `CLAUDE_CODE_PATH` | _(auto-detectar)_ | Caminho para executável Claude |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `50` | Número de observações a injetar no SessionStart |

**Gerenciamento de Configurações:**

```bash
# Editar configurações via auxiliar CLI
./claude-mem-settings.sh

# Ou editar diretamente
nano ~/.claude-mem/settings.json

# Ver configurações atuais
curl http://localhost:37777/api/settings
```

**Formato do Arquivo de Configurações:**

```json
{
  "CLAUDE_MEM_MODEL": "claude-haiku-4-5",
  "CLAUDE_MEM_WORKER_PORT": "37777",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50"
}
```

Veja [Guia de Configuração](https://docs.claude-mem.ai/configuration) para detalhes.

---

## Desenvolvimento

```bash
# Clonar e build
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
npm install
npm run build

# Executar testes
npm test

# Iniciar worker
npm run worker:start

# Ver logs
npm run worker:logs
```

Veja [Guia de Desenvolvimento](https://docs.claude-mem.ai/development) para instruções detalhadas.

---

## Solução de Problemas

**Diagnóstico Rápido:**

Se você estiver enfrentando problemas, descreva o problema para Claude e a habilidade troubleshoot será ativada automaticamente para diagnosticar e fornecer correções.

**Problemas Comuns:**

- Worker não inicia → `npm run worker:restart`
- Nenhum contexto aparece → `npm run test:context`
- Problemas de banco de dados → `sqlite3 ~/.claude-mem/claude-mem.db "PRAGMA integrity_check;"`
- Busca não funciona → Verifique se tabelas FTS5 existem

Veja [Guia de Solução de Problemas](https://docs.claude-mem.ai/troubleshooting) para soluções completas.

---

## Contribuindo

Contribuições são bem-vindas! Por favor:

1. Faça fork do repositório
2. Crie um branch de feature
3. Faça suas alterações com testes
4. Atualize a documentação
5. Envie um Pull Request

Veja [Guia de Desenvolvimento](https://docs.claude-mem.ai/development) para fluxo de contribuição.

---

## Licença

Este projeto está licenciado sob a **GNU Affero General Public License v3.0** (AGPL-3.0).

Copyright (C) 2025 Alex Newman (@thedotmack). Todos os direitos reservados.

Veja o arquivo [LICENSE](LICENSE) para detalhes completos.

**O Que Isso Significa:**

- Você pode usar, modificar e distribuir este software livremente
- Se você modificar e implantar em um servidor de rede, deve disponibilizar seu código-fonte
- Trabalhos derivados também devem ser licenciados sob AGPL-3.0
- NÃO HÁ GARANTIA para este software

---

## Suporte

- **Documentação**: [docs/](docs/)
- **Issues**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)
- **Repositório**: [github.com/thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
- **Autor**: Alex Newman ([@thedotmack](https://github.com/thedotmack))

---

**Construído com Claude Agent SDK** | **Powered by Claude Code** | **Feito com TypeScript**