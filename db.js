/*
Autor(es): marcus.antonio.martinho.silva@gmail.com
Data Criação: 2026-03-28
Data Atualização: 2026-11-04
Descrição: Repositório SQLite do histórico do agentlens. Mantém a tabela `analyses` (uma linha por análise) e a tabela `repos` (uma linha por repositório, com upsert por `repo_key`).

A conexão é lazy e única (`getDb()`); o esquema é criado e migrado de forma idempotente e retrocompatível com arquivos .db antigos.
*/
'use strict';

const path = require('path');

let _db;
let _inTx = false;

/**
 * Retorna a conexão única com o banco, criando-a e aplicando o esquema na primeira chamada.
 * O caminho vem de `AGENTLENS_DB` (padrão: `agentlens-history.db` no cwd).
 * @returns {import('node:sqlite').DatabaseSync} Conexão aberta.
 * @throws {Error} Se `node:sqlite` não estiver disponível (Node < 22.13), se o arquivo não puder ser aberto ou o esquema não puder ser aplicado.
 */
function getDb() {
  if (!_db) {
    let DatabaseSync;
    try {
      ({ DatabaseSync } = require('node:sqlite'));
    } catch (_) {
      throw new Error('o servidor de histórico requer Node >= 22.13 (módulo node:sqlite)');
    }
    const dbPath = process.env.AGENTLENS_DB || path.join(process.cwd(), 'agentlens-history.db');
    _db = new DatabaseSync(dbPath);
    // Chaves estrangeiras ligadas: apagar sempre filho (analyses) -> pai (repos), como deleteRepo faz.
    // `repos` é criada antes de `analyses.repo_id` referenciá-la (ALTER TABLE abaixo), então o esquema é válido.
    _db.exec('PRAGMA foreign_keys = ON');
    _db.exec(`
      CREATE TABLE IF NOT EXISTS analyses (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at  TEXT NOT NULL,
        repo_path   TEXT NOT NULL,
        repo_name   TEXT NOT NULL,
        cli_version TEXT NOT NULL,
        result_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS repos (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_key         TEXT UNIQUE NOT NULL,
        source           TEXT NOT NULL,
        repo_name        TEXT,
        repo_url         TEXT,
        has_agents       INTEGER NOT NULL,
        tools_json       TEXT,
        total_tokens     INTEGER,
        analyses_count   INTEGER NOT NULL DEFAULT 0,
        first_seen_at    TEXT,
        last_analyzed_at TEXT
      );
    `);
    const cols = _db.prepare('PRAGMA table_info(analyses)').all();
    if (!cols.some(c => c.name === 'repo_id')) {
      _db.exec('ALTER TABLE analyses ADD COLUMN repo_id INTEGER REFERENCES repos(id)');
    }
    _db.exec('CREATE INDEX IF NOT EXISTS idx_analyses_repo_id ON analyses(repo_id)');
  }
  return _db;
}

/**
 * Executa `fn` dentro de uma transação (BEGIN/COMMIT, ROLLBACK em caso de erro).
 * Se já houver transação aberta por este helper (`_inTx`), apenas executa `fn` dentro dela (sem aninhar).
 * (`db.isTransaction` não existe no Node 22.13, por isso o controle por variável de módulo.)
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db Conexão aberta.
 * @param {() => T} fn Função síncrona com as operações.
 * @returns {T} Valor retornado por `fn`.
 * @throws {Error} Qualquer erro de `fn` ou do COMMIT (após ROLLBACK).
 */
function withTransaction(db, fn) {
  if (_inTx) return fn();
  db.exec('BEGIN');
  _inTx = true;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* transação já encerrada */ }
    throw e;
  } finally {
    _inTx = false;
  }
}

/**
 * Resume o resultado de uma análise para as colunas desnormalizadas de `repos`.
 * @param {object} result Resultado da análise (`foundByTool`, `noFiles`, `totalContextTokens`).
 * @returns {{has_agents: boolean, tools: string[], total_tokens: number}} Resumo.
 * @throws {TypeError} Se `result` for null/undefined.
 */
function summarizeResult(result) {
  const tools = Object.keys(result.foundByTool || {});
  return {
    has_agents: !result.noFiles && tools.length > 0,
    tools,
    total_tokens: Number(result.totalContextTokens) || 0,
  };
}

/**
 * Converte uma linha de `repos` no formato público de resumo.
 * @param {object} row Linha crua da tabela `repos`.
 * @returns {object} Resumo com `has_agents` booleano e `tools` como array.
 * @throws {SyntaxError} Se `tools_json` estiver corrompido.
 */
function repoToSummary(row) {
  return {
    id: Number(row.id),
    repo_key: row.repo_key,
    source: row.source,
    repo_name: row.repo_name,
    repo_url: row.repo_url,
    has_agents: row.has_agents === 1,
    tools: JSON.parse(row.tools_json || '[]'),
    total_tokens: row.total_tokens,
    analyses_count: row.analyses_count,
    first_seen_at: row.first_seen_at,
    last_analyzed_at: row.last_analyzed_at,
  };
}

/**
 * Salva uma análise em `analyses` e faz upsert do repositório em `repos`, numa transação.
 * @param {{repo_key: string, source: string, repo_name?: string, repo_url?: string, cli_version: string, result: object}} p Dados da análise.
 * @returns {{repo: object, analysisId: number}} Resumo do repositório atualizado e id da análise criada.
 * @throws {Error} Se a gravação falhar (a transação é revertida).
 */
function saveRepoAnalysis({ repo_key, source, repo_name, repo_url, cli_version, result }) {
  const db = getDb();
  const sum = summarizeResult(result);
  const now = new Date().toISOString();
  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO repos (repo_key, source, repo_name, repo_url, has_agents, tools_json, total_tokens, analyses_count, first_seen_at, last_analyzed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(repo_key) DO UPDATE SET
        source = excluded.source,
        repo_name = excluded.repo_name,
        repo_url = excluded.repo_url,
        has_agents = excluded.has_agents,
        tools_json = excluded.tools_json,
        total_tokens = excluded.total_tokens,
        analyses_count = repos.analyses_count + 1,
        last_analyzed_at = excluded.last_analyzed_at
    `).run(repo_key, source, repo_name || null, repo_url || null, sum.has_agents ? 1 : 0,
      JSON.stringify(sum.tools), sum.total_tokens, now, now);
    const repoRow = db.prepare('SELECT * FROM repos WHERE repo_key = ?').get(repo_key);
    const info = db.prepare(
      'INSERT INTO analyses (created_at, repo_path, repo_name, cli_version, result_json, repo_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(now, repo_key, repo_name || repo_key, cli_version, JSON.stringify(result), repoRow.id);
    return { repo: repoToSummary(repoRow), analysisId: Number(info.lastInsertRowid) };
  });
}

/**
 * Lista os repositórios salvos, do mais recentemente analisado ao mais antigo.
 * @param {{hasAgents?: boolean}} [opts] Se `hasAgents` for true, devolve só repos com agents.
 * @returns {object[]} Lista de resumos de repositório.
 * @throws {Error} Se a consulta falhar.
 */
function listRepos({ hasAgents } = {}) {
  const sql = 'SELECT * FROM repos' + (hasAgents ? ' WHERE has_agents = 1' : '') + ' ORDER BY last_analyzed_at DESC, id DESC';
  return getDb().prepare(sql).all().map(repoToSummary);
}

/**
 * Busca um repositório com a lista de suas análises (mais nova primeiro).
 * Cada análise traz `total_tokens`; somente a mais nova traz `result` completo.
 * @param {number} id Id do repositório.
 * @returns {object|null} Resumo + `analyses`, ou null se não existir.
 * @throws {Error} Se a consulta falhar ou `result_json` estiver corrompido.
 */
function getRepo(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM repos WHERE id = ?').get(id);
  if (!row) return null;
  const analyses = db.prepare(
    'SELECT id, created_at, cli_version, result_json FROM analyses WHERE repo_id = ? ORDER BY id DESC'
  ).all(id).map(({ result_json, ...rest }, i) => {
    const parsed = JSON.parse(result_json);
    const item = { ...rest, total_tokens: summarizeResult(parsed).total_tokens };
    return i === 0 ? { ...item, result: parsed } : item;
  });
  return { ...repoToSummary(row), analyses };
}

/**
 * Remove um repositório e todas as suas análises.
 * @param {number} id Id do repositório.
 * @returns {boolean} true se o repositório existia e foi removido.
 * @throws {Error} Se a remoção falhar (a transação é revertida).
 */
function deleteRepo(id) {
  const db = getDb();
  return withTransaction(db, () => {
    db.prepare('DELETE FROM analyses WHERE repo_id = ?').run(id);
    return Number(db.prepare('DELETE FROM repos WHERE id = ?').run(id).changes) > 0;
  });
}

/**
 * Salva uma análise avulsa (sem vínculo com `repos`). Mantida por compatibilidade.
 * @param {{repo_path: string, repo_name: string, cli_version: string, result: object}} p Dados da análise.
 * @returns {number} Id da análise criada.
 * @throws {Error} Se a gravação falhar.
 */
function saveAnalysis({ repo_path, repo_name, cli_version, result }) {
  const stmt = getDb().prepare(
    'INSERT INTO analyses (created_at, repo_path, repo_name, cli_version, result_json) VALUES (?, ?, ?, ?, ?)'
  );
  const info = stmt.run(new Date().toISOString(), repo_path, repo_name, cli_version, JSON.stringify(result));
  return Number(info.lastInsertRowid);
}

/**
 * Lista todas as análises (sem `result_json`), da mais nova para a mais antiga.
 * @returns {object[]} Linhas com id, created_at, repo_name, repo_path e cli_version.
 * @throws {Error} Se a consulta falhar.
 */
function listAnalyses() {
  return getDb()
    .prepare('SELECT id, created_at, repo_name, repo_path, cli_version FROM analyses ORDER BY id DESC')
    .all()
    .map(row => ({ ...row, id: Number(row.id) }));
}

/**
 * Busca uma análise por id, com `result` já parseado.
 * @param {number} id Id da análise.
 * @returns {object|null} Análise ou null se não existir.
 * @throws {SyntaxError} Se `result_json` estiver corrompido.
 */
function getAnalysis(id) {
  const row = getDb().prepare('SELECT * FROM analyses WHERE id = ?').get(id);
  if (!row) return null;
  const { result_json, ...rest } = row;
  return { ...rest, result: JSON.parse(result_json) };
}

/**
 * Remove uma análise por id e mantém a tabela `repos` consistente, numa transação.
 * Se a análise pertencia a um repo: quando ainda restam análises, recalcula as colunas
 * desnormalizadas (contagem, última análise, tokens, has_agents, tools) a partir da mais recente;
 * quando não resta nenhuma, remove a linha do repo. Análises legadas (sem repo_id) só são apagadas.
 * @param {number} id Id da análise.
 * @returns {boolean} true se a análise existia e foi removida.
 * @throws {Error} Se a remoção falhar ou `result_json` da análise restante estiver corrompido (a transação é revertida).
 */
function deleteAnalysis(id) {
  const db = getDb();
  return withTransaction(db, () => {
    // 1. Descobre o repo da análise antes de apagá-la (undefined se a análise não existir).
    const row = db.prepare('SELECT repo_id FROM analyses WHERE id = ?').get(id);
    // 2. Apaga a análise; changes === 0 significa id inexistente (a rota responde 404).
    const info = db.prepare('DELETE FROM analyses WHERE id = ?').run(id);
    if (Number(info.changes) === 0) return false;
    // Análise legada (repo_id nulo): nada a recalcular.
    if (!row || row.repo_id === null || row.repo_id === undefined) return true;
    const repoId = Number(row.repo_id);
    // 3. Análise mais recente que sobrou para o repo (maior id).
    const latest = db.prepare(
      'SELECT created_at, result_json FROM analyses WHERE repo_id = ? ORDER BY id DESC LIMIT 1'
    ).get(repoId);
    if (!latest) {
      // 4. Sem análises restantes: o repo some do histórico.
      db.prepare('DELETE FROM repos WHERE id = ?').run(repoId);
      return true;
    }
    const sum = summarizeResult(JSON.parse(latest.result_json));
    const count = Number(db.prepare('SELECT COUNT(*) AS n FROM analyses WHERE repo_id = ?').get(repoId).n);
    db.prepare(`
      UPDATE repos SET
        analyses_count = ?,
        last_analyzed_at = ?,
        total_tokens = ?,
        has_agents = ?,
        tools_json = ?
      WHERE id = ?
    `).run(count, latest.created_at, sum.total_tokens, sum.has_agents ? 1 : 0, JSON.stringify(sum.tools), repoId);
    return true;
  });
}

/**
 * Fecha a conexão (se aberta) para que a próxima chamada a `getDb()` reabra o banco.
 * @returns {void}
 * @throws {Error} Se o driver falhar ao fechar.
 */
function closeDb() {
  _inTx = false;
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = {
  saveAnalysis, listAnalyses, getAnalysis, deleteAnalysis,
  summarizeResult, saveRepoAnalysis, listRepos, getRepo, deleteRepo,
  closeDb,
};
