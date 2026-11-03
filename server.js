/*
Autor(es): marcus.antonio.martinho.silva@gmail.com
Data Criação: 2026-03-28
Data Atualização: 2026-11-03
Descrição: Servidor HTTP opcional do agentlens (módulo `http` nativo, sem frameworks). Expõe a análise de repositórios locais (`POST /analyze`), o histórico (`/history`), os repositórios salvos (`/repos`) e serve o `agentlens.html` em `GET /`.

Toda resposta é JSON (exceto o HTML estático). Cabeçalhos CORS são enviados somente nas rotas `/repos`; as demais (`/analyze`, `/history`) rejeitam com 403 requisições cross-origin. O servidor escuta apenas em `HOST` (padrão 127.0.0.1), pois `/analyze` lê o disco local. Erros seguem o formato `{ "error": "<mensagem em português>" }`.
*/
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { analyzeLocalRepo } = require('./agentlens-core');
const { version: VERSION } = require('./package.json');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * Erro com status HTTP associado, tratado pelo handler principal.
 */
class HttpError extends Error {
  /**
   * @param {number} status Status HTTP a responder.
   * @param {string} message Mensagem em português para o corpo `{error}`.
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Lê e parseia o body JSON da requisição, com limite de tamanho.
 * @param {http.IncomingMessage} req Requisição.
 * @returns {Promise<object>} Objeto parseado (`{}` se o body for vazio).
 * @throws {HttpError} 413 se exceder 5 MB; 400 se o JSON for inválido.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > MAX_BODY_BYTES) {
      reject(new HttpError(413, 'body muito grande'));
      return;
    }
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        reject(new HttpError(413, 'body muito grande'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new HttpError(400, 'JSON inválido no body')); }
    });
    req.on('error', reject);
  });
}

/**
 * Envia uma resposta JSON. Inclui CORS apenas se `res.cors` estiver ativo (rotas /repos). Status 204 não leva corpo.
 * @param {http.ServerResponse} res Resposta.
 * @param {number} status Status HTTP.
 * @param {*} [body] Corpo serializável em JSON.
 * @returns {void}
 * @throws {TypeError} Se o corpo não for serializável (ex.: BigInt).
 */
function send(res, status, body) {
  if (status === 204) {
    res.writeHead(204, res.cors ? CORS_HEADERS : {});
    res.end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, {
    ...(res.cors ? CORS_HEADERS : {}),
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

/**
 * Serve o `agentlens.html` (lido a cada requisição) como text/html.
 * @param {http.ServerResponse} res Resposta.
 * @returns {void}
 * @throws {Error} Se o arquivo não puder ser lido.
 */
function sendHtml(res) {
  const html = fs.readFileSync(path.join(__dirname, 'agentlens.html'));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': html.length,
  });
  res.end(html);
}

/**
 * Valida um id de rota (inteiro positivo).
 * @param {string} raw Segmento da URL.
 * @returns {number} Id numérico.
 * @throws {HttpError} 400 se não for inteiro positivo.
 */
function parseId(raw) {
  if (!/^[1-9]\d*$/.test(raw || '')) throw new HttpError(400, 'id inválido');
  return Number(raw);
}

/**
 * Valida o payload de `POST /repos` e normaliza o `result`.
 * @param {object} body Body parseado.
 * @returns {{owner: string, repo: string, result: object}} Dados validados.
 * @throws {HttpError} 400 se source/owner/repo/result forem inválidos.
 */
function validateRepoPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body inválido');
  if (body.source !== 'github') throw new HttpError(400, 'source deve ser github');
  if (typeof body.owner !== 'string' || !OWNER_RE.test(body.owner)) throw new HttpError(400, 'owner inválido');
  if (typeof body.repo !== 'string' || !REPO_RE.test(body.repo) || body.repo === '.' || body.repo === '..') {
    throw new HttpError(400, 'repo inválido');
  }
  const r = body.result;
  if (!r || typeof r !== 'object' || r.ok !== true) throw new HttpError(400, 'result inválido');
  if (!r.foundByTool || typeof r.foundByTool !== 'object' || Array.isArray(r.foundByTool)) {
    throw new HttpError(400, 'result.foundByTool inválido');
  }
  const uniqueRefs = Array.isArray(r.uniqueRefs) ? r.uniqueRefs : [];
  const result = {
    ...r,
    uniqueRefs: uniqueRefs.map(ref => (
      ref && typeof ref === 'object'
        ? { ...ref, fromTools: Array.isArray(ref.fromTools) ? ref.fromTools : [] }
        : ref
    )),
    noFiles: r.noFiles === true || Object.keys(r.foundByTool).length === 0,
  };
  return { owner: body.owner, repo: body.repo, result };
}

/**
 * Handler principal: roteia por método e segmentos do pathname.
 * @param {http.IncomingMessage} req Requisição.
 * @param {http.ServerResponse} res Resposta.
 * @returns {Promise<void>} Resolve após responder (erros viram 4xx/500, nunca rejeitam).
 * @throws {never} Todas as exceções são capturadas e convertidas em resposta.
 */
async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.replace(/^\/|\/$/g, '').split('/');

    res.cors = parts[0] === 'repos';
    const origin = req.headers.origin;
    const isPage = req.method === 'GET' && (url.pathname === '/' || url.pathname === '/agentlens.html');
    if (!res.cors && !isPage && origin && origin !== `http://${req.headers.host}`) {
      return send(res, 403, { error: 'origem não permitida' });
    }

    if (req.method === 'OPTIONS') return send(res, 204);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/agentlens.html')) {
      return sendHtml(res);
    }

    if (req.method === 'POST' && parts[0] === 'analyze') {
      const body = await readBody(req);
      if (!body.path) return send(res, 400, { error: 'path é obrigatório' });
      if (!fs.existsSync(body.path)) return send(res, 400, { error: 'path não encontrado' });
      const resolved = path.resolve(body.path);
      const repoName = body.name || path.basename(resolved);
      const result = analyzeLocalRepo(body.path, repoName);
      const { analysisId } = db.saveRepoAnalysis({
        repo_key: `local:${resolved}`, source: 'local', repo_name: result.repoName,
        repo_url: null, cli_version: VERSION, result,
      });
      return send(res, 200, { id: analysisId, ...result });
    }

    if (req.method === 'POST' && parts[0] === 'repos' && !parts[1]) {
      const { owner, repo, result } = validateRepoPayload(await readBody(req));
      const saved = db.saveRepoAnalysis({
        repo_key: `github:${owner}/${repo}`, source: 'github', repo_name: `${owner}/${repo}`,
        repo_url: `https://github.com/${owner}/${repo}`, cli_version: VERSION, result,
      });
      return send(res, 201, saved);
    }

    if (req.method === 'GET' && parts[0] === 'repos' && !parts[1]) {
      const hasAgents = url.searchParams.get('hasAgents');
      return send(res, 200, db.listRepos({ hasAgents: hasAgents === '1' || hasAgents === 'true' }));
    }

    if (req.method === 'GET' && parts[0] === 'repos' && parts[1]) {
      const repo = db.getRepo(parseId(parts[1]));
      if (!repo) return send(res, 404, { error: 'repositório não encontrado' });
      return send(res, 200, repo);
    }

    if (req.method === 'DELETE' && parts[0] === 'repos' && parts[1]) {
      if (!db.deleteRepo(parseId(parts[1]))) return send(res, 404, { error: 'repositório não encontrado' });
      return send(res, 200, { deleted: true });
    }

    if (req.method === 'GET' && parts[0] === 'history' && !parts[1]) {
      return send(res, 200, db.listAnalyses());
    }

    if (req.method === 'GET' && parts[0] === 'history' && parts[1]) {
      const row = db.getAnalysis(parseId(parts[1]));
      if (!row) return send(res, 404, { error: 'análise não encontrada' });
      return send(res, 200, row);
    }

    if (req.method === 'DELETE' && parts[0] === 'history' && parts[1]) {
      const deleted = db.deleteAnalysis(parseId(parts[1]));
      if (!deleted) return send(res, 404, { error: 'análise não encontrada' });
      return send(res, 200, { deleted: true });
    }

    send(res, 404, { error: 'rota não encontrada' });
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) {
      if (e.status === 413) res.setHeader('Connection', 'close');
      send(res, e.status, { error: e.message });
      if (e.status === 413) res.on('finish', () => req.destroy());
      return;
    }
    console.error(e);
    send(res, 500, { error: 'erro interno' });
  }
}

const server = http.createServer(handler);

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`AgentLens server rodando em http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`);
  });
}

module.exports = { server };
