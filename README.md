# AgentLens

Scan de repositórios para custos de contexto de agentes de IA. Detecta `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `copilot-instructions.md` e calcula custos de tokens para os principais LLMs.

Funciona de três formas — escolha a que se encaixa no seu fluxo.

---

## App (HTML)

Zero instalação. Baixe `agentlens.html`, abra no browser.

- Analisa repositórios públicos do GitHub via API
- Carrega relatórios `.json` gerados pelo CLI
- Toggle de idioma PT/EN
- Aba Compare para comparar múltiplos repos

```
1. Baixe agentlens.html
2. Abra no Chrome, Firefox, Safari ou Edge
3. Cole: https://github.com/owner/repo → Analisar
```

All processing happens in your browser via the GitHub public API.

---

## CLI

Analisa repositórios locais e gera relatório HTML + JSON.

```bash
# Com npx (sem instalação)
npx @hugofusinato/agentlens
npx @hugofusinato/agentlens /caminho/do/repo
npx @hugofusinato/agentlens --path . --path ../outro-repo

# Ou instale globalmente
npm install -g @hugofusinato/agentlens
agentlens /caminho/do/repo

# Opções úteis
agentlens --stdout          # JSON no stdout
agentlens --no-open         # não abre browser automaticamente
agentlens --out meu-repo    # nome do arquivo de saída
```

Gera `agentlens-report.html` e `agentlens-report.json` no diretório atual.

---

## Servidor com histórico

API REST HTTP que analisa repositórios e persiste os resultados em banco de dados SQLite local, usando o módulo nativo `node:sqlite` (requer Node.js ≥ 22.13 apenas para o servidor; a CLI segue em Node ≥ 18; zero dependências npm, nada para instalar). No Node 22.13 o `node:sqlite` emite um `ExperimentalWarning` no stderr ao abrir o banco; é esperado e inofensivo (pode ser silenciado com `NODE_NO_WARNINGS=1`).

```bash
node server.js              # porta 3000 (padrão)
PORT=8080 node server.js    # porta customizada
HOST=0.0.0.0 node server.js   # interface de escuta (padrão 127.0.0.1)
```

### Endpoints

| Método | Rota | Descrição |
|--------|------|-----------|
| `POST` | `/analyze` | `{ "path": "/caminho/repo" }` — analisa e salva |
| `GET` | `/history` | Lista todas as análises salvas |
| `GET` | `/history/:id` | Análise completa por ID |
| `DELETE` | `/history/:id` | Remove uma análise; mantém `repos` consistente (recalcula o repo ou o remove quando fica sem análises) |
| `POST` | `/repos` | `{ "source": "github", "owner", "repo", "result": {...} }` — salva (upsert) um repositório analisado no browser; responde `201 { repo, analysisId }` |
| `GET` | `/repos` | Lista repositórios salvos; `?hasAgents=1` filtra os que têm agents |
| `GET` | `/repos/:id` | Repositório + `analyses` (cada item com `id`, `created_at`, `cli_version`, `total_tokens`; a mais recente também traz `result` completo) |
| `DELETE` | `/repos/:id` | Remove o repositório e suas análises |
| `GET` | `/` | Serve o `agentlens.html` |

Erros têm o formato `{ "error": "mensagem" }`. O CORS (`Access-Control-Allow-Origin: *`) é enviado **somente** nas rotas `/repos`; `/analyze` e `/history` respondem 403 `origem não permitida` (sem CORS) quando a requisição traz um `Origin` diferente do host do servidor (sem `Origin` é aceito), evitando que sites externos leiam o disco local. O servidor limita o body a 5 MB e escuta em `127.0.0.1` por padrão (`HOST=...` para alterar; `/analyze` lê o disco local, não exponha em redes).

O app HTML, aberto em `http://localhost:3000`, salva automaticamente os repositórios analisados e os lista na aba Reports.

O banco de dados fica em `agentlens-history.db` no diretório de trabalho. Cada análise salva a versão do CLI (`cliVersion`) para rastrear compatibilidade entre versões.

---

## Testes

```bash
npm test
```

Roda testes unitários do core e testes de integração da API com `node:test` nativo (Node.js ≥ 22.13 para os testes da API, que usam `node:sqlite`; sem dependências extras).

---

## Config (opcional)

Crie `.agentlens.json` para definir múltiplos repos de uma vez:

```json
{
  "repos": [
    { "path": ".", "name": "meu-repo" },
    { "path": "../outro-repo" }
  ],
  "output": "relatorio.html"
}
```

Veja `.agentlens.example.json` para referência completa.
