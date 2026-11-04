/*
Autor(es): marcus.antonio.martinho.silva@gmail.com
Data Criação: 2026-03-28
Data Atualização: 2026-11-04
Descrição: Testes da API HTTP (`server.js`) com node:test. Sobem o servidor em porta efêmera com um banco SQLite temporário (`AGENTLENS_DB`) e cobrem /analyze, /history, /repos, CORS, estático e migração do esquema.
*/
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.AGENTLENS_DB = path.join(os.tmpdir(), `agentlens-test-${Date.now()}.db`);

const { server } = require('../server');

let baseUrl;

before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
    resolve();
  });
}));

after(() => new Promise((resolve) => {
  server.close(() => {
    require('../db').closeDb();
    try { fs.unlinkSync(process.env.AGENTLENS_DB); } catch (_) {}
    resolve();
  });
}));

/**
 * Faz uma requisição ao servidor de teste.
 * @param {string} method Método HTTP.
 * @param {string} urlPath Caminho (com query string opcional).
 * @param {object|string} [body] Objeto (serializado em JSON) ou string crua.
 * @param {object} [extraHeaders] Cabeçalhos adicionais (ex.: Origin).
 * @returns {Promise<{status: number, headers: object, body: *}>} Resposta; body é JSON parseado quando possível.
 * @throws {Error} Em erro de rede.
 */
function request(method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const json = body === undefined || body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const url = new URL(urlPath, baseUrl);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
    };
    if (json) options.headers['Content-Length'] = Buffer.byteLength(json);
    const req = http.request(options, res => {
      const chunks = [];
      res.on('data', chunk => { chunks.push(chunk); });
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, headers: res.headers, body: data }); }
      });
    });
    req.on('error', reject);
    if (json) req.write(json);
    req.end();
  });
}

test('POST /analyze sem path retorna 400', async () => {
  const res = await request('POST', '/analyze', {});
  assert.equal(res.status, 400);
  assert.ok(res.body.error, 'deve ter campo error');
});

test('POST /analyze com path inválido retorna 400', async () => {
  const res = await request('POST', '/analyze', { path: '/caminho/inexistente/xyz' });
  assert.equal(res.status, 400);
  assert.ok(res.body.error, 'deve ter campo error');
});

test('POST /analyze com path válido retorna 200, salva e retorna id', async () => {
  const res = await request('POST', '/analyze', { path: path.resolve('.') });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.id, 'number', 'deve retornar id numérico');
  assert.equal(typeof res.body.repoName, 'string', 'deve retornar repoName');
  assert.equal(typeof res.body.totalContextTokens, 'number', 'deve retornar totalContextTokens');
});

test('GET /history retorna array com ao menos um item após POST', async () => {
  await request('POST', '/analyze', { path: path.resolve('.') });
  const res = await request('GET', '/history');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body), 'deve ser array');
  assert.ok(res.body.length >= 1, 'deve ter ao menos um item');
});

test('GET /history/:id retorna análise completa', async () => {
  const postRes = await request('POST', '/analyze', { path: path.resolve('.') });
  const id = postRes.body.id;
  const res = await request('GET', `/history/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, id);
  assert.ok(res.body.result, 'deve ter campo result com dados da análise');
});

test('DELETE /history/:id remove análise e GET retorna 404', async () => {
  const postRes = await request('POST', '/analyze', { path: path.resolve('.') });
  const id = postRes.body.id;
  const delRes = await request('DELETE', `/history/${id}`);
  assert.equal(delRes.status, 200);
  assert.equal(delRes.body.deleted, true);
  const getRes = await request('GET', `/history/${id}`);
  assert.equal(getRes.status, 404);
});

test('GET /history/:id com id inexistente retorna 404', async () => {
  const res = await request('GET', '/history/999999');
  assert.equal(res.status, 404);
  assert.ok(res.body.error, 'deve ter campo error');
});

test('GET /history/:id com id inválido retorna 400', async () => {
  const res = await request('GET', '/history/abc');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'id inválido');
});

/**
 * Monta um payload válido de POST /repos.
 * @param {string} repo Nome do repositório.
 * @param {object} [resultOverrides] Campos a sobrescrever em `result`.
 * @returns {object} Payload.
 */
function repoPayload(repo, resultOverrides = {}) {
  return {
    source: 'github', owner: 'acme', repo,
    result: {
      ok: true, repoName: `acme/${repo}`,
      foundByTool: { claude: [{ path: 'CLAUDE.md', tokens: 10 }] },
      uniqueRefs: [{ path: 'CLAUDE.md', fromTools: ['claude'], found: true, tokens: 10 }],
      agentTok: 10, refTok: 0, totalContextTokens: 10, noFiles: false,
      ...resultOverrides,
    },
  };
}

test('OPTIONS /repos retorna 204 com headers CORS', async () => {
  const res = await request('OPTIONS', '/repos');
  assert.equal(res.status, 204);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.match(res.headers['access-control-allow-methods'], /POST/);
  assert.equal(res.headers['access-control-allow-headers'], 'Content-Type');
});

test('GET /repos traz Access-Control-Allow-Origin', async () => {
  const res = await request('GET', '/repos');
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], '*');
});

test('GET / retorna 200 text/html', async () => {
  const res = await request('GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.body, /<html/i);
});

test('POST /repos com payload inválido retorna 400 com error', async () => {
  const res = await request('POST', '/repos', { source: 'github', owner: 'a b', repo: 'x', result: { ok: true, foundByTool: {} } });
  assert.equal(res.status, 400);
  assert.equal(typeof res.body.error, 'string');
  const res2 = await request('POST', '/repos', { source: 'github', owner: 'acme', repo: 'x', result: { ok: false, foundByTool: {} } });
  assert.equal(res2.status, 400);
  const res3 = await request('POST', '/repos', { source: 'github', owner: 'acme', repo: 'x', result: { ok: true } });
  assert.equal(res3.status, 400);
});

test('POST /repos com JSON malformado retorna 400', async () => {
  const res = await request('POST', '/repos', '{nao-json');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'JSON inválido no body');
});

test('POST /repos válido retorna 201 com repo e analysisId', async () => {
  const res = await request('POST', '/repos', repoPayload('valido'));
  assert.equal(res.status, 201);
  assert.equal(typeof res.body.analysisId, 'number');
  assert.equal(res.body.repo.repo_key, 'github:acme/valido');
  assert.equal(res.body.repo.source, 'github');
  assert.equal(res.body.repo.has_agents, true);
  assert.deepEqual(res.body.repo.tools, ['claude']);
  assert.equal(res.body.repo.analyses_count, 1);
});

test('POST /repos duas vezes para o mesmo repo mantém um único repo com analyses_count 2', async () => {
  await request('POST', '/repos', repoPayload('duplo'));
  await request('POST', '/repos', repoPayload('duplo'));
  const list = await request('GET', '/repos');
  const found = list.body.filter(r => r.repo_key === 'github:acme/duplo');
  assert.equal(found.length, 1);
  assert.equal(found[0].analyses_count, 2);
});

test('GET /repos?hasAgents=1 filtra repo com noFiles', async () => {
  await request('POST', '/repos', repoPayload('semagents', { foundByTool: {}, uniqueRefs: [], noFiles: true, totalContextTokens: 0 }));
  await request('POST', '/repos', repoPayload('comagents'));
  const all = await request('GET', '/repos');
  assert.ok(all.body.some(r => r.repo_key === 'github:acme/semagents' && r.has_agents === false));
  const filtered = await request('GET', '/repos?hasAgents=1');
  assert.ok(filtered.body.length >= 1);
  assert.ok(filtered.body.every(r => r.has_agents === true));
  assert.ok(!filtered.body.some(r => r.repo_key === 'github:acme/semagents'));
  assert.ok(filtered.body.some(r => r.repo_key === 'github:acme/comagents'));
  assert.equal('result' in filtered.body[0], false);
});

test('GET /repos/:id traz análises e DELETE seguido de GET retorna 404', async () => {
  const post = await request('POST', '/repos', repoPayload('detalhe'));
  const id = post.body.repo.id;
  await request('POST', '/repos', repoPayload('detalhe'));
  const res = await request('GET', `/repos/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.analyses.length, 2);
  assert.ok(res.body.analyses[0].result, 'última análise traz result');
  assert.equal(res.body.analyses[1].result, undefined);
  assert.ok(res.body.analyses.every(a => a.total_tokens === 10), 'toda análise traz total_tokens numérico');
  const del = await request('DELETE', `/repos/${id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, true);
  const after = await request('GET', `/repos/${id}`);
  assert.equal(after.status, 404);
  assert.equal(after.body.error, 'repositório não encontrado');
  const del2 = await request('DELETE', `/repos/${id}`);
  assert.equal(del2.status, 404);
});

test('DELETE /history/:id da única análise de um repo remove o repo de GET /repos e GET /repos/:id retorna 404', async () => {
  const post = await request('POST', '/repos', repoPayload('unica'));
  const repoId = post.body.repo.id;
  const del = await request('DELETE', `/history/${post.body.analysisId}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, true);
  const list = await request('GET', '/repos');
  assert.ok(!list.body.some(r => r.repo_key === 'github:acme/unica'));
  const get = await request('GET', `/repos/${repoId}`);
  assert.equal(get.status, 404);
  assert.equal(get.body.error, 'repositório não encontrado');
});

test('DELETE /history/:id da análise mais recente mantém o repo com os dados da análise restante', async () => {
  const first = await request('POST', '/repos', repoPayload('recalcula', { totalContextTokens: 10 }));
  const repoId = first.body.repo.id;
  const second = await request('POST', '/repos', repoPayload('recalcula', { totalContextTokens: 99, foundByTool: {}, uniqueRefs: [], noFiles: true }));
  const before = await request('GET', `/repos/${repoId}`);
  assert.equal(before.body.analyses_count, 2);
  assert.equal(before.body.total_tokens, 99);
  assert.equal(before.body.has_agents, false);
  const del = await request('DELETE', `/history/${second.body.analysisId}`);
  assert.equal(del.status, 200);
  const res = await request('GET', `/repos/${repoId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.analyses_count, 1);
  assert.equal(res.body.total_tokens, 10);
  assert.equal(res.body.has_agents, true);
  assert.deepEqual(res.body.tools, ['claude']);
  assert.equal(res.body.analyses.length, 1);
  assert.equal(res.body.last_analyzed_at, res.body.analyses[0].created_at);
});

test('DELETE /history/:id inexistente retorna 404 com error', async () => {
  const res = await request('DELETE', '/history/999999');
  assert.equal(res.status, 404);
  assert.equal(typeof res.body.error, 'string');
});

test('db.saveRepoAnalysis com erro dentro da transação faz rollback e a próxima operação funciona', () => {
  const dbModule = require('../db');
  const base = { source: 'github', repo_name: 'tx', repo_url: null, cli_version: '1.0.0' };
  const antes = dbModule.listRepos().length;
  // BigInt não é serializável: JSON.stringify falha depois do upsert em repos
  assert.throws(() => dbModule.saveRepoAnalysis({
    ...base, repo_key: 'github:acme/tx-rollback', result: { foundByTool: {}, totalContextTokens: 1, x: 1n },
  }), TypeError);
  assert.equal(dbModule.listRepos().length, antes, 'upsert de repos foi revertido');
  assert.ok(!dbModule.listRepos().some(r => r.repo_key === 'github:acme/tx-rollback'));
  const ok = dbModule.saveRepoAnalysis({
    ...base, repo_key: 'github:acme/tx-ok', result: { foundByTool: {}, totalContextTokens: 1 },
  });
  assert.equal(typeof ok.analysisId, 'number');
  assert.equal(ok.repo.analyses_count, 1);
});

test('db.deleteRepo com foreign_keys ativo remove análises (filho) e depois o repo (pai)', () => {
  const dbModule = require('../db');
  const saved = dbModule.saveRepoAnalysis({
    source: 'github', repo_key: 'github:acme/fk', repo_name: 'fk', repo_url: null, cli_version: '1.0.0',
    result: { foundByTool: {}, totalContextTokens: 2 },
  });
  assert.equal(dbModule.deleteRepo(saved.repo.id), true);
  assert.equal(dbModule.getRepo(saved.repo.id), null);
  assert.equal(dbModule.getAnalysis(saved.analysisId), null, 'análises do repo removidas');
  assert.equal(dbModule.deleteRepo(saved.repo.id), false);
});

test('GET /repos/:id com id inválido retorna 400', async () => {
  const res = await request('GET', '/repos/abc');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'id inválido');
});

test('POST /analyze cria repo com source local', async () => {
  await request('POST', '/analyze', { path: path.resolve('.') });
  const list = await request('GET', '/repos');
  const local = list.body.find(r => r.repo_key === `local:${path.resolve('.')}`);
  assert.ok(local, 'repo local deve existir');
  assert.equal(local.source, 'local');
  assert.ok(local.analyses_count >= 1);
});

test('migração adiciona repo_id em banco com esquema antigo de analyses', () => {
  const { DatabaseSync: Database } = require('node:sqlite');
  const dbModule = require('../db');
  const oldPath = path.join(os.tmpdir(), `agentlens-old-${Date.now()}.db`);
  const old = new Database(oldPath);
  old.exec(`CREATE TABLE analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, repo_path TEXT NOT NULL,
    repo_name TEXT NOT NULL, cli_version TEXT NOT NULL, result_json TEXT NOT NULL)`);
  old.prepare('INSERT INTO analyses (created_at, repo_path, repo_name, cli_version, result_json) VALUES (?,?,?,?,?)')
    .run('2026-01-01T00:00:00.000Z', '/x', 'x', '1.0.0', '{}');
  old.close();
  const prev = process.env.AGENTLENS_DB;
  dbModule.closeDb();
  process.env.AGENTLENS_DB = oldPath;
  try {
    assert.equal(dbModule.listAnalyses().length, 1, 'dados antigos preservados');
    dbModule.closeDb();
    const check = new Database(oldPath);
    const cols = check.prepare('PRAGMA table_info(analyses)').all().map(c => c.name);
    check.close();
    assert.ok(cols.includes('repo_id'));
  } finally {
    dbModule.closeDb();
    process.env.AGENTLENS_DB = prev;
    try { fs.unlinkSync(oldPath); } catch (_) {}
  }
});

test('OPTIONS /analyze com Origin estranho retorna 403 sem CORS', async () => {
  const res = await request('OPTIONS', '/analyze', null, { Origin: 'http://evil.example' });
  assert.equal(res.status, 403);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.equal(res.body.error, 'origem não permitida');
});

test('POST /analyze com Origin estranho retorna 403 sem CORS', async () => {
  const res = await request('POST', '/analyze', { path: path.resolve('.') }, { Origin: 'http://evil.example' });
  assert.equal(res.status, 403);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.equal(res.body.error, 'origem não permitida');
});

test('GET /history com Origin estranho retorna 403 e sem Origin segue 200', async () => {
  const bad = await request('GET', '/history', null, { Origin: 'http://evil.example' });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers['access-control-allow-origin'], undefined);
  const ok = await request('GET', '/history');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['access-control-allow-origin'], undefined);
});

test('POST /analyze sem Origin ou com Origin do próprio servidor retorna 200', async () => {
  const semOrigin = await request('POST', '/analyze', { path: path.resolve('.') });
  assert.equal(semOrigin.status, 200);
  const mesmo = await request('POST', '/analyze', { path: path.resolve('.') }, { Origin: baseUrl });
  assert.equal(mesmo.status, 200);
});

test('OPTIONS /repos com Origin externo segue 204 com CORS', async () => {
  const res = await request('OPTIONS', '/repos', null, { Origin: 'null' });
  assert.equal(res.status, 204);
  assert.equal(res.headers['access-control-allow-origin'], '*');
});

test('POST /repos preserva UTF-8 multibyte em body grande', async () => {
  const payload = repoPayload('utf8', { nota: 'é'.repeat(700000) });
  const post = await request('POST', '/repos', payload);
  assert.equal(post.status, 201);
  const get = await request('GET', `/repos/${post.body.repo.id}`);
  assert.equal(get.body.analyses[0].result.nota, 'é'.repeat(700000));
});

test('POST /repos com Content-Length acima de 5 MB retorna 413', async () => {
  const res = await request('POST', '/repos', null, { 'Content-Length': String(6 * 1024 * 1024) });
  assert.equal(res.status, 413);
  assert.equal(res.body.error, 'body muito grande');
  assert.equal(res.headers['access-control-allow-origin'], '*');
});
