/*
 * POST /api/integrations/manychat/lead — o lead que vem da DM do Instagram.
 *
 * Supabase falso que guarda cada chamada, para provar que: o contato passa pela régua que o
 * projeto já usa (nome com maiúsculas certas, telefone em (DD) 9xxxx-xxxx + dígitos, e-mail
 * minúsculo), a profissão vira um dos rótulos do projeto (ou o GRUPO "enfermagem" quando a DM não
 * separa técnica de enfermeira), a origem é decidida no servidor e a mesma pessoa NÃO duplica.
 */
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { afterEach, test } from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServerApp } from "../server.mjs";

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const contexto = {};
vm.runInNewContext(readFileSync(path.join(RAIZ, "js", "lead-rules.js"), "utf8"), contexto);
vm.runInNewContext(readFileSync(path.join(RAIZ, "js", "pesquisa-config.js"), "utf8"), contexto);
const EV = contexto.EVPesquisa;
const GRUPO = EV.PERFIL_GRUPO.enfermagem;

const SUPABASE_URL = "https://projeto-de-teste.supabase.co";
const SUPABASE_KEY = "chave-service-role-de-teste";
const API_KEY = "chave-do-manychat-de-teste";
const ROTA = "/api/integrations/manychat/lead";

const CORPO = Object.freeze({
  manychat_contact_id: "123456789",
  nome: "  maria   da    silva ",
  email: " MARIA@GMAIL.COM ",
  telefone: "(45) 99811-2233",
  profissao: "enfermagem"
});

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

/**
 * `existente` = a linha que o PostgREST devolve na busca do lead (null = ninguém ainda).
 * Pode ser uma função, que recebe os parâmetros da busca e decide — é assim que os testes provam
 * a ORDEM da busca (id do ManyChat, depois telefone, depois e-mail).
 */
async function subir({ existente = null, apiKey = API_KEY, semBanco = false, erroDoBanco = false, dominio = "ok" } = {}) {
  const chamadas = [];
  const fetchImpl = async (url, init = {}) => {
    const endereco = new URL(String(url));
    const chamada = {
      url: String(url),
      caminho: endereco.pathname,
      params: endereco.searchParams,
      method: init.method || "GET",
      corpo: init.body ? JSON.parse(init.body) : null
    };
    chamadas.push(chamada);
    if (erroDoBanco) return new Response("boom", { status: 500 });

    if (endereco.pathname === "/rest/v1/pesquisa_respostas") {
      const linha = typeof existente === "function" ? existente(endereco.searchParams) : existente;
      return new Response(JSON.stringify(linha ? [linha] : []), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ ok: true, novo: !existente }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const server = createServerApp({
    supabaseUrl: semBanco ? "" : SUPABASE_URL,
    supabaseKey: semBanco ? "" : SUPABASE_KEY,
    manychatApiKey: apiKey,
    fetchImpl,
    resolveEmailDomain: async () => dominio
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    chamadas,
    buscas: () => chamadas.filter((c) => c.caminho === "/rest/v1/pesquisa_respostas"),
    gravacao: () => chamadas.find((c) => c.caminho === "/rest/v1/rpc/pesquisa_salvar")
  };
}

async function enviar(base, corpo, { apiKey = API_KEY, metodo = "POST", tipo = "application/json", caminho = ROTA } = {}) {
  return await new Promise((resolve, reject) => {
    const dados = typeof corpo === "string" ? corpo : JSON.stringify(corpo);
    const headers = { ...(tipo ? { "Content-Type": tipo } : {}), ...(apiKey === null ? {} : { "X-API-Key": apiKey }) };
    const req = httpRequest(`${base}${caminho}`, { method: metodo, headers }, (res) => {
      let texto = "";
      res.on("data", (p) => (texto += p));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(texto);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    req.end(dados);
  });
}

/* ------------------------------------------------------------------ o caminho feliz */

test("lead novo: normaliza tudo, grava com a origem do servidor e responde created", async () => {
  const { base, gravacao } = await subir();
  const { status, json } = await enviar(base, CORPO);

  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.equal(json.action, "created");
  assert.equal(json.profession, "enfermagem");
  assert.equal(json.phone, "5545998112233");
  assert.equal(json.source, "instagram");
  assert.match(json.lead_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  const p = gravacao().corpo.p;
  // Contato pela régua de sempre.
  assert.equal(p.nome, "Maria da Silva", "trim, espaços duplicados e capitalização");
  assert.equal(p.whatsapp, "(45) 99811-2233");
  assert.equal(p.whatsapp_digits, "45998112233");
  assert.equal(p.email, "maria@gmail.com", "trim e minúsculas");
  // Profissão: o grupo, porque a DM não disse qual das duas.
  assert.equal(p.perfil, GRUPO.rotulo);
  assert.deepEqual(p.respostas, { perfil: GRUPO.rotulo, manychat_contact_id: "123456789" });
  // Origem decidida no servidor, nas colunas de origem que já existem.
  assert.equal(p.utm_source, "instagram");
  assert.equal(p.utm_medium, "instagram_dm");
  assert.equal(p.utm_campaign, "manychat");
  // Pesquisa própria: não se mistura com o ICP nem com a página curta do WhatsApp.
  assert.equal(p.pesquisa, "manychat-instagram");
  assert.equal(p.completa, true);
  assert.equal(p.progresso_percentual, 100);
  // Sem finalizou: este lead não dispara o aviso ao n8n (quem continua a conversa é o ManyChat).
  assert.equal(p.finalizou, false);
  assert.equal(p.seq, 1);
});

test("o ManyChat pode dizer de QUAL post/anúncio a pessoa veio (e só isso)", async () => {
  const { base, gravacao } = await subir();
  const { status } = await enviar(base, {
    ...CORPO,
    origem_detalhe: "post-afericao-25set",
    anuncio: "criativo-07"
  });
  assert.equal(status, 200);
  const p = gravacao().corpo.p;
  assert.equal(p.utm_content, "post-afericao-25set");
  assert.equal(p.utm_term, "criativo-07");
  // E o que define a origem em si continua vindo do servidor.
  assert.equal(p.utm_source, "instagram");
  assert.equal(p.utm_medium, "instagram_dm");
  assert.equal(p.utm_campaign, "manychat");
});

test("sem origem_detalhe nem anuncio, as duas colunas ficam vazias", async () => {
  const { base, gravacao } = await subir();
  await enviar(base, CORPO);
  const p = gravacao().corpo.p;
  assert.equal(p.utm_content, null);
  assert.equal(p.utm_term, null);
});

test("a origem NUNCA vem do corpo do pedido", async () => {
  const { base, gravacao } = await subir();
  const { status } = await enviar(base, {
    ...CORPO,
    utm_source: "facebook",
    utm_medium: "cpc",
    utm_campaign: "campanha-de-quem-chamou",
    utm_content: "conteudo-de-quem-chamou",
    utm_term: "termo-de-quem-chamou",
    origem: "tiktok",
    source: "google"
  });
  assert.equal(status, 200);
  const p = gravacao().corpo.p;
  assert.equal(p.utm_source, "instagram");
  assert.equal(p.utm_medium, "instagram_dm");
  assert.equal(p.utm_campaign, "manychat");
  // utm_content e utm_term só entram pelos nomes próprios (origem_detalhe e anuncio).
  assert.equal(p.utm_content, null);
  assert.equal(p.utm_term, null);
});

/* ------------------------------------------------------------------ profissão */

const ACEITOS = [
  // os três valores internos que o ManyChat manda
  ["auxiliar_atendente", EV.PERFIL.auxiliar, "auxiliar_atendente"],
  ["cuidador", EV.PERFIL.cuidador, "cuidador"],
  ["enfermagem", GRUPO.rotulo, "enfermagem"],
  // rótulos e variações que a DM costuma escrever
  ["Auxiliar/Antiga Atendente", EV.PERFIL.auxiliar, "auxiliar_atendente"],
  ["Cuidador(a)", EV.PERFIL.cuidador, "cuidador"],
  ["Técnico de Enfermagem/Enfermeiro", GRUPO.rotulo, "enfermagem"],
  ["ENFERMAGEM", GRUPO.rotulo, "enfermagem"],
  [" cuidadora ", EV.PERFIL.cuidador, "cuidador"],
  // e as duas profissões separadas, se um dia a DM perguntar qual é
  ["tecnico_enfermagem", EV.PERFIL.tecnico, "tecnico_enfermagem"],
  ["Enfermeira", EV.PERFIL.enfermeiro, "enfermeiro"],
  [EV.PERFIL.tecnico, EV.PERFIL.tecnico, "tecnico_enfermagem"]
];

for (const [entrada, rotulo, codigo] of ACEITOS) {
  test(`profissão "${entrada}" → ${codigo}`, async () => {
    const { base, gravacao } = await subir();
    const { status, json } = await enviar(base, { ...CORPO, profissao: entrada });
    assert.equal(status, 200, entrada);
    assert.equal(json.profession, codigo);
    assert.equal(gravacao().corpo.p.perfil, rotulo);
  });
}

test("profissão desconhecida é 400, e nada é gravado (melhor recusar do que adivinhar)", async () => {
  const { base, chamadas } = await subir();
  for (const profissao of ["", "medico", "outro", "estudante", "qualquer coisa", null, 7, "toString"]) {
    const { status, json } = await enviar(base, { ...CORPO, profissao });
    assert.equal(status, 400, String(profissao));
    assert.equal(json.success, false);
    assert.equal(json.error, "invalid_payload");
  }
  assert.deepEqual(chamadas, []);
});

test('"enfermagem" NÃO é gravado como técnica nem como enfermeira', async () => {
  const { base, gravacao } = await subir();
  await enviar(base, { ...CORPO, profissao: "enfermagem" });
  const perfil = gravacao().corpo.p.perfil;
  assert.notEqual(perfil, EV.PERFIL.tecnico);
  assert.notEqual(perfil, EV.PERFIL.enfermeiro);
  assert.equal(perfil, GRUPO.rotulo);
  // E o código interno do grupo é o que o ManyChat mandou, de volta.
  assert.equal(EV.codigoDoPerfil(perfil), "enfermagem");
});

/* ------------------------------------------------------------------ upsert */

test("mesma pessoa de novo: atualiza a MESMA linha, com seq maior, e responde updated", async () => {
  const antiga = { id: "77777777-7777-4777-8777-777777777777", seq: 4, criado_em: "2026-09-01T10:00:00Z" };
  const { base, gravacao } = await subir({ existente: antiga });
  const { status, json } = await enviar(base, { ...CORPO, profissao: "cuidador" });

  assert.equal(status, 200);
  assert.equal(json.action, "updated");
  assert.equal(json.lead_id, antiga.id);
  const p = gravacao().corpo.p;
  assert.equal(p.id, antiga.id, "nenhuma linha nova");
  assert.equal(p.seq, 5, "seq maior que o da linha: sem isso o pesquisa_salvar ignoraria o update");
  assert.equal(p.perfil, EV.PERFIL.cuidador, "a profissão é atualizada");
});

test("a busca respeita a ordem: id do ManyChat, depois telefone, depois e-mail", async () => {
  // Ninguém é encontrado: as três buscas acontecem, na ordem.
  const { base, buscas } = await subir();
  await enviar(base, CORPO);
  const feitas = buscas();
  assert.equal(feitas.length, 3);
  assert.equal(feitas[0].params.get("respostas->>manychat_contact_id"), "eq.123456789");
  assert.equal(feitas[1].params.get("whatsapp_digits"), "eq.45998112233");
  assert.equal(feitas[2].params.get("email"), "eq.maria@gmail.com");
  // Sempre dentro dos leads do ManyChat: a linha da pessoa na pesquisa de ICP não é tocada.
  for (const busca of feitas) assert.equal(busca.params.get("pesquisa"), "eq.manychat-instagram");
});

test("achou pelo id do ManyChat: não procura por telefone nem por e-mail", async () => {
  const { base, buscas } = await subir({
    existente: (params) => (params.get("respostas->>manychat_contact_id") ? { id: "88888888-8888-4888-8888-888888888888", seq: 1 } : null)
  });
  const { json } = await enviar(base, CORPO);
  assert.equal(json.action, "updated");
  assert.equal(buscas().length, 1);
});

test("sem manychat_contact_id, a pessoa é reconhecida pelo telefone", async () => {
  const { base, buscas, gravacao } = await subir({
    existente: (params) => (params.get("whatsapp_digits") ? { id: "99999999-9999-4999-8999-999999999999", seq: 2 } : null)
  });
  const { nome, email, telefone, profissao } = CORPO;
  const { json } = await enviar(base, { nome, email, telefone, profissao });
  assert.equal(json.action, "updated");
  assert.equal(json.lead_id, "99999999-9999-4999-8999-999999999999");
  // Sem id do ManyChat: só duas buscas, e o jsonb guarda apenas a profissão.
  assert.equal(buscas().length, 1);
  assert.deepEqual(gravacao().corpo.p.respostas, { perfil: GRUPO.rotulo });
});

/* ------------------------------------------------------------------ recusas */

test("contato inválido é 400 invalid_payload com o campo, e nada é gravado", async () => {
  const { base, chamadas } = await subir();
  const casos = [
    // Nome sem sobrenome NÃO entra aqui: nesta rota ele é aceito de propósito (ver o teste abaixo).
    { ...CORPO, nome: "123" },
    { ...CORPO, telefone: "(11) 3123-4567" },
    { ...CORPO, telefone: "" },
    { ...CORPO, email: "maria@" },
    {}
  ];
  for (const corpo of casos) {
    const { status, json } = await enviar(base, corpo);
    assert.equal(status, 400, JSON.stringify(corpo));
    assert.equal(json.error, "invalid_payload");
    assert.ok(json.campos && Object.keys(json.campos).length, "diz qual campo está errado");
  }
  assert.deepEqual(chamadas, []);
});

test("número de lixo (dígitos repetidos) é recusado, como nos formulários", async () => {
  const { base, chamadas } = await subir();
  for (const telefone of ["(45) 99999-9999", "(11) 98888-8888", "45900000000"]) {
    const { status, json } = await enviar(base, { ...CORPO, telefone });
    assert.equal(status, 400, telefone);
    assert.ok(json.campos.whatsapp, telefone);
  }
  assert.deepEqual(chamadas, []);
});

test("e-mail de domínio que não existe é 400", async () => {
  const { base } = await subir({ dominio: "missing" });
  const { status, json } = await enviar(base, { ...CORPO, email: "maria@escola-que-nao-existe.com.br" });
  assert.equal(status, 400);
  assert.equal(json.error, "invalid_payload");
  assert.ok(json.campos.email);
});

test("sem X-API-Key, com chave errada, ou sem a variável: 401 e 503, sem tocar no banco", async () => {
  const comChave = await subir();
  const sem = await enviar(comChave.base, CORPO, { apiKey: null });
  assert.equal(sem.status, 401);
  assert.equal(sem.json.error, "unauthorized");
  const errada = await enviar(comChave.base, CORPO, { apiKey: "outra" });
  assert.equal(errada.status, 401);
  assert.deepEqual(comChave.chamadas, []);

  const semVariavel = await subir({ apiKey: "" });
  const r = await enviar(semVariavel.base, CORPO);
  assert.equal(r.status, 503);
  assert.equal(r.json.error, "api_key_not_configured");
});

test("a chave também vale em ?chave= (ferramenta que só deixa preencher a URL)", async () => {
  const { base } = await subir();
  const { status, json } = await enviar(base, CORPO, { apiKey: null, caminho: `${ROTA}?chave=${encodeURIComponent(API_KEY)}` });
  assert.equal(status, 200);
  assert.equal(json.success, true);
});

test("método errado é 405; corpo torto é 400; sem banco é 503; banco fora é 502", async () => {
  const normal = await subir();
  const semCorpo = await new Promise((resolve, reject) => {
    const req = httpRequest(`${normal.base}${ROTA}`, { method: "GET", headers: { "X-API-Key": API_KEY } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(semCorpo, 405);
  // Corpo que não é JSON, ou que é JSON mas não é objeto: o ManyChat recebe sempre o mesmo contrato.
  for (const [corpo, tipo] of [["nome=maria", "application/json"], ['"maria"', "application/json"], ["[]", "application/json"]]) {
    const r = await enviar(normal.base, corpo, { tipo });
    assert.equal(r.status, 400, corpo);
    assert.equal(r.json.error, "invalid_payload", corpo);
    assert.equal(r.json.success, false);
  }

  const semBanco = await subir({ semBanco: true });
  const r1 = await enviar(semBanco.base, CORPO);
  assert.equal(r1.status, 503);
  assert.equal(r1.json.error, "database_not_configured");

  const quebrado = await subir({ erroDoBanco: true });
  const r2 = await enviar(quebrado.base, CORPO);
  assert.equal(r2.status, 502);
  assert.equal(r2.json.error, "database_unavailable");
  assert.equal(r2.json.success, false);
  // Nada de stack nem de dado pessoal na resposta de erro.
  assert.deepEqual(Object.keys(r2.json).sort(), ["error", "success"]);
});

/* ------------------------------------------------------------------ armadilhas de quem monta a DM */

test("variável não substituída ({{cuf_...}}) vira um erro que se explica sozinho", async () => {
  const { base, chamadas } = await subir();
  const { status, json } = await enviar(base, {
    manychat_contact_id: "1742416631",
    nome: "{{cuf_10976209}}",
    email: "{{cuf_10976216}}",
    telefone: "{{cuf_10976208}}",
    profissao: "{{cuf_15004723}}",
    origem_detalhe: "dm-instagram"
  });
  assert.equal(status, 400);
  assert.equal(json.error, "unsubstituted_variable");
  assert.deepEqual(json.campos_crus, ["nome", "email", "telefone", "profissao"]);
  assert.match(json.dica, /contato de teste/);
  assert.deepEqual(chamadas, [], "nada é gravado");
});

test("uma variável crua no meio de campos bons também é pega", async () => {
  const { base } = await subir();
  const { status, json } = await enviar(base, { ...CORPO, telefone: "{{cuf_10976208}}" });
  assert.equal(status, 400);
  assert.equal(json.error, "unsubstituted_variable");
  assert.deepEqual(json.campos_crus, ["telefone"]);
});

test("nome sem sobrenome é aceito aqui (na DM não existe segunda chance)", async () => {
  const { base, gravacao } = await subir();
  const { status, json } = await enviar(base, { ...CORPO, nome: "maria" });
  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.equal(gravacao().corpo.p.nome, "Maria");
});

test("nome que não é nome continua recusado", async () => {
  const { base, chamadas } = await subir();
  for (const nome of ["", "   ", "M", "123", "maria@gmail.com", "a".repeat(200)]) {
    const { status, json } = await enviar(base, { ...CORPO, nome });
    assert.equal(status, 400, JSON.stringify(nome));
    assert.equal(json.error, "invalid_payload", JSON.stringify(nome));
    assert.ok(json.campos.nome, JSON.stringify(nome));
  }
  assert.deepEqual(chamadas, []);
});

test("telefone com +55, como o ManyChat salva no campo do sistema", async () => {
  const { base, gravacao, chamadas } = await subir();
  for (const telefone of ["+5545998112233", "+55 (45) 99811-2233", "5545998112233"]) {
    chamadas.length = 0;
    const { status, json } = await enviar(base, { ...CORPO, telefone });
    assert.equal(status, 200, telefone);
    assert.equal(json.phone, "5545998112233", telefone);
    assert.equal(gravacao().corpo.p.whatsapp, "(45) 99811-2233", telefone);
  }
});
