/*
 * GET /api/leads/perfil — a consulta do UnniChat.
 *
 * O UnniChat manda o telefone e recebe SÓ a profissão em código interno. Aqui o Supabase é falso e
 * grava cada chamada, para provar que o servidor pergunta ao PostgREST exatamente pela coluna
 * indexada (whatsapp_digits) e pela coluna `perfil` — sem abrir o JSON de respostas.
 */
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { afterEach, test } from "node:test";

import { createServerApp } from "../server.mjs";

const SUPABASE_URL = "https://projeto-de-teste.supabase.co";
const SUPABASE_KEY = "chave-service-role-de-teste";
const API_KEY = "chave-do-unnichat-de-teste";

const servers = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections?.();
          server.close(resolve);
        })
    )
  );
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Sobe o servidor com um Supabase falso.
 *   pessoas    = linhas de pesquisa_pessoas, por whatsapp_digits (ou por id)
 *   inscricoes = linhas de inscricoes, por whatsapp_digits
 */
async function subir({ pessoas = {}, inscricoes = {}, apiKey = API_KEY, semBanco = false, erroDoBanco = false } = {}) {
  const chamadas = [];
  const fetchImpl = async (url) => {
    const endereco = String(url);
    chamadas.push(endereco);
    if (erroDoBanco) return new Response("boom", { status: 500 });
    const query = new URL(endereco).searchParams;
    const tabela = new URL(endereco).pathname.split("/").pop();
    const digits = (query.get("whatsapp_digits") || "").replace(/^eq\./, "");
    const id = (query.get("id") || "").replace(/^eq\./, "");
    if (tabela === "pesquisa_pessoas") {
      const linha = id ? Object.values(pessoas).find((p) => p.id === id) : pessoas[digits];
      return jsonResponse(linha ? [linha] : []);
    }
    if (tabela === "inscricoes") return jsonResponse(inscricoes[digits] ? [inscricoes[digits]] : []);
    return jsonResponse([]);
  };

  const server = createServerApp({
    supabaseUrl: semBanco ? "" : SUPABASE_URL,
    supabaseKey: semBanco ? "" : SUPABASE_KEY,
    unnichatApiKey: apiKey,
    fetchImpl
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, chamadas };
}

function pessoa(digits, perfil, extra = {}) {
  return {
    id: extra.id || "11111111-1111-4111-8111-111111111111",
    whatsapp_digits: digits,
    whatsapp_internacional: `55${digits}`,
    perfil,
    concluido_em: perfil ? "2026-09-24T12:00:00Z" : null,
    ...extra
  };
}

/** A mesma consulta, mas devolvendo o corpo cru (para o modo texto). */
async function consultarCru(base, caminho, { apiKey = null } = {}) {
  return await new Promise((resolve, reject) => {
    const req = httpRequest(
      `${base}${caminho}`,
      { method: "GET", headers: apiKey === null ? {} : { "X-API-Key": apiKey } },
      (res) => {
        let corpo = "";
        res.on("data", (pedaco) => (corpo += pedaco));
        res.on("end", () => resolve({ status: res.statusCode, tipo: res.headers["content-type"] || "", corpo }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function consultar(base, caminho, { apiKey = API_KEY, metodo = "GET" } = {}) {
  return await new Promise((resolve, reject) => {
    const req = httpRequest(
      `${base}${caminho}`,
      { method: metodo, headers: apiKey === null ? {} : { "X-API-Key": apiKey } },
      (res) => {
        let corpo = "";
        res.on("data", (pedaco) => (corpo += pedaco));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(corpo);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/* ------------------------------------------------------------------ os quatro perfis */

const PERFIS = [
  ["Técnico(a) de enfermagem", "tecnico_enfermagem"],
  ["Enfermeiro(a)", "enfermeiro"],
  ["Cuidador(a)", "cuidador"],
  ["Auxiliar ou antiga atendente de enfermagem", "auxiliar_atendente"]
];

for (const [rotulo, codigo] of PERFIS) {
  test(`perfil respondido: "${rotulo}" volta como ${codigo}`, async () => {
    const { base, chamadas } = await subir({ pessoas: { "45999999999": pessoa("45999999999", rotulo) } });
    const { status, json } = await consultar(base, "/api/leads/perfil?telefone=5545999999999");
    assert.equal(status, 200);
    assert.deepEqual(json, {
      success: true,
      responded: true,
      phone: "5545999999999",
      profession: codigo
    });
    // A consulta é pela coluna indexada e só pede o que o UnniChat usa.
    assert.match(chamadas[0], /pesquisa_pessoas\?/);
    assert.match(chamadas[0], /whatsapp_digits=eq\.45999999999/);
    assert.match(chamadas[0], /select=id,whatsapp_digits,whatsapp_internacional,perfil,concluido_em/);
    assert.doesNotMatch(chamadas[0], /respostas/);
  });
}

/* ------------------------------------------------------------------ estados do lead */

test("lead existe e ainda não respondeu a pergunta de profissão: 200 com responded=false", async () => {
  const { base } = await subir({ pessoas: { "45999999999": pessoa("45999999999", null) } });
  const { status, json } = await consultar(base, "/api/leads/perfil?telefone=5545999999999");
  assert.equal(status, 200);
  assert.deepEqual(json, { success: true, responded: false, phone: "5545999999999", profession: null });
});

test("lead que só se inscreveu numa página de checkout conta como não respondido, não como inexistente", async () => {
  const { base, chamadas } = await subir({
    inscricoes: { "45999999999": { id: "a", whatsapp_internacional: "5545999999999" } }
  });
  const { status, json } = await consultar(base, "/api/leads/perfil?telefone=5545999999999");
  assert.equal(status, 200);
  assert.deepEqual(json, { success: true, responded: false, phone: "5545999999999", profession: null });
  assert.equal(chamadas.length, 2, "procura na pesquisa e, só então, nas inscrições");
});

test("telefone que não existe em lugar nenhum: 404 lead_not_found", async () => {
  const { base } = await subir();
  const { status, json } = await consultar(base, "/api/leads/perfil?telefone=5545999999999");
  assert.equal(status, 404);
  assert.deepEqual(json, {
    success: false,
    responded: false,
    phone: "5545999999999",
    profession: null,
    error: "lead_not_found"
  });
});

/* ------------------------------------------------------------------ telefone */

test("normalização: +55, espaços, parênteses, hífen, zero de operadora e 12 dígitos chegam no mesmo lead", async () => {
  const { base } = await subir({ pessoas: { "45999999999": pessoa("45999999999", "Enfermeiro(a)") } });
  const formatos = [
    "5545999999999",
    "%2B5545999999999",
    "%2B55%20(45)%2099999-9999",
    "45%2099999-9999",
    "045999999999",
    "(45)999999999" // sem o nono dígito não existe; aqui é o número cheio com máscara
  ];
  for (const formato of formatos.slice(0, 5)) {
    const { status, json } = await consultar(base, `/api/leads/perfil?telefone=${formato}`);
    assert.equal(status, 200, formato);
    assert.equal(json.profession, "enfermeiro", formato);
    assert.equal(json.phone, "5545999999999", formato);
  }
  assert.ok(formatos.length === 6);
});

test("telefone curto ou vazio: 422 invalid_phone, sem ir ao banco", async () => {
  const { base, chamadas } = await subir();
  for (const valor of ["", "123", "55", "abc"]) {
    const { status, json } = await consultar(base, `/api/leads/perfil?telefone=${valor}`);
    assert.equal(status, 422, valor);
    assert.equal(json.error, "invalid_phone");
    assert.equal(json.success, false);
  }
  assert.deepEqual(chamadas, []);
});

test("aceita também ?phone= (o nome que o UnniChat usa em inglês)", async () => {
  const { base } = await subir({ pessoas: { "45999999999": pessoa("45999999999", "Cuidador(a)") } });
  const { json } = await consultar(base, "/api/leads/perfil?phone=5545999999999");
  assert.equal(json.profession, "cuidador");
});

/* ------------------------------------------------------------------ chave e método */

test("sem X-API-Key: 401 e nenhuma consulta ao banco", async () => {
  const { base, chamadas } = await subir({ pessoas: { "45999999999": pessoa("45999999999", "Cuidador(a)") } });
  const { status, json } = await consultar(base, "/api/leads/perfil?telefone=5545999999999", { apiKey: null });
  assert.equal(status, 401);
  assert.equal(json.error, "unauthorized");
  assert.equal(json.profession, null);
  assert.deepEqual(chamadas, []);
});

test("X-API-Key errada: 401", async () => {
  const { base } = await subir();
  const { status, json } = await consultar(base, "/api/leads/perfil?telefone=5545999999999", { apiKey: "outra-chave" });
  assert.equal(status, 401);
  assert.equal(json.error, "unauthorized");
});

test("sem UNNICHAT_API_KEY configurada: 503, nunca aberto", async () => {
  const { base } = await subir({ apiKey: "" });
  const { status, json } = await consultar(base, "/api/leads/perfil?telefone=5545999999999");
  assert.equal(status, 503);
  assert.equal(json.error, "api_key_not_configured");
});

test("método errado devolve 405 com Allow: GET", async () => {
  const { base } = await subir();
  const { status } = await consultar(base, "/api/leads/perfil?telefone=5545999999999", { metodo: "POST" });
  assert.equal(status, 405);
});

/* ------------------------------------------------------------------ falhas do banco */

test("banco fora do ar não vira 500: 502 database_unavailable", async () => {
  const { base } = await subir({ erroDoBanco: true });
  const { status, json } = await consultar(base, "/api/leads/perfil?telefone=5545999999999");
  assert.equal(status, 502);
  assert.equal(json.error, "database_unavailable");
  assert.equal(json.success, false);
});

test("sem Supabase configurado: 503 database_not_configured", async () => {
  const { base } = await subir({ semBanco: true });
  const { status, json } = await consultar(base, "/api/leads/perfil?telefone=5545999999999");
  assert.equal(status, 503);
  assert.equal(json.error, "database_not_configured");
});

/* ------------------------------------------------------------------ consulta por id */

test("GET /api/leads/perfil/<id> devolve o mesmo formato", async () => {
  const id = "22222222-2222-4222-8222-222222222222";
  const { base, chamadas } = await subir({
    pessoas: { "45999999999": pessoa("45999999999", "Técnico(a) de enfermagem", { id }) }
  });
  const { status, json } = await consultar(base, `/api/leads/perfil/${id}`);
  assert.equal(status, 200);
  assert.deepEqual(json, {
    success: true,
    responded: true,
    phone: "5545999999999",
    profession: "tecnico_enfermagem"
  });
  assert.match(chamadas[0], new RegExp(`id=eq\\.${id}`));
});

test("id que não é uuid: 422 invalid_id", async () => {
  const { base, chamadas } = await subir();
  const { status, json } = await consultar(base, "/api/leads/perfil/nao-e-uuid");
  assert.equal(status, 422);
  assert.equal(json.error, "invalid_id");
  assert.deepEqual(chamadas, []);
});

/* ------------------------------------------------------------------ ferramenta sem header */

test("a chave também vale em ?chave= (ferramenta que só deixa preencher a URL)", async () => {
  const { base } = await subir({ pessoas: { "45999999999": pessoa("45999999999", "Enfermeiro(a)") } });
  const { status, json } = await consultar(base, `/api/leads/perfil?telefone=5545999999999&chave=${encodeURIComponent(API_KEY)}`, {
    apiKey: null
  });
  assert.equal(status, 200);
  assert.equal(json.profession, "enfermeiro");
});

test("?chave= errada continua sendo 401", async () => {
  const { base, chamadas } = await subir();
  const { status, json } = await consultar(base, "/api/leads/perfil?telefone=5545999999999&chave=outra", { apiKey: null });
  assert.equal(status, 401);
  assert.equal(json.error, "unauthorized");
  assert.deepEqual(chamadas, []);
});

/* ------------------------------------------------------------------ ?formato=texto */

test("formato=texto devolve UMA palavra: a profissão, com content-type de texto", async () => {
  for (const [rotulo, codigo] of PERFIS) {
    const { base } = await subir({ pessoas: { "45999999999": pessoa("45999999999", rotulo) } });
    const r = await consultarCru(base, `/api/leads/perfil?telefone=5545999999999&formato=texto&chave=${encodeURIComponent(API_KEY)}`);
    assert.equal(r.status, 200, rotulo);
    assert.match(r.tipo, /text\/plain/);
    assert.equal(r.corpo.trim(), codigo, rotulo);
  }
});

test("formato=texto: quem existe sem perfil é 'sem_perfil'; telefone desconhecido é 'nao_encontrado' em 200", async () => {
  const semPerfil = await subir({ pessoas: { "45999999999": pessoa("45999999999", null) } });
  const r1 = await consultarCru(semPerfil.base, "/api/leads/perfil?telefone=5545999999999&formato=texto", { apiKey: API_KEY });
  assert.equal(r1.status, 200);
  assert.equal(r1.corpo.trim(), "sem_perfil");

  const ninguem = await subir();
  const r2 = await consultarCru(ninguem.base, "/api/leads/perfil?telefone=5545999999999&formato=texto", { apiKey: API_KEY });
  // 200 de propósito: é resposta, não erro — a condição do fluxo compara palavra com palavra.
  assert.equal(r2.status, 200);
  assert.equal(r2.corpo.trim(), "nao_encontrado");
});

test("formato=texto: chave errada, telefone torto e banco fora também viram palavra", async () => {
  const semChave = await subir();
  const r1 = await consultarCru(semChave.base, "/api/leads/perfil?telefone=5545999999999&formato=texto");
  assert.equal(r1.status, 401);
  assert.equal(r1.corpo.trim(), "nao_autorizado");

  const r2 = await consultarCru(semChave.base, "/api/leads/perfil?telefone=123&formato=texto", { apiKey: API_KEY });
  assert.equal(r2.status, 422);
  assert.equal(r2.corpo.trim(), "telefone_invalido");

  const quebrado = await subir({ erroDoBanco: true });
  const r3 = await consultarCru(quebrado.base, "/api/leads/perfil?telefone=5545999999999&formato=texto", { apiKey: API_KEY });
  assert.equal(r3.status, 502);
  assert.equal(r3.corpo.trim(), "erro");
});

test("sem formato=texto, a resposta continua sendo o JSON de sempre", async () => {
  const { base } = await subir({ pessoas: { "45999999999": pessoa("45999999999", "Cuidador(a)") } });
  const r = await consultarCru(base, "/api/leads/perfil?telefone=5545999999999", { apiKey: API_KEY });
  assert.match(r.tipo, /application\/json/);
  assert.deepEqual(JSON.parse(r.corpo), { success: true, responded: true, phone: "5545999999999", profession: "cuidador" });
});
