/*
 * GET /api/painel/perfis — a aba "Perfis atualizados" do painel (/atualizacao-perfil).
 *
 * A página curta grava na MESMA tabela da pesquisa, separada pela coluna `pesquisa`. Estes testes
 * provam que o painel só lê as linhas dela (o ICP nunca entra), que o filtro vale para a lista E
 * para as contagens por profissão, e que a contagem dos quatro cartões não some quando se escolhe
 * uma profissão. No fim, as duas chaves do webhook da Hotmart (um produto, uma chave).
 */
import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
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
const PAINEL_EMAIL = "equipe@escolaenfermagemdevalor.com.br";
const PAINEL_SENHA = "SenhaDoPainel@2026";
const PAINEL_SEGREDO = "segredo-de-sessao-de-teste-0123456789abcdef";

function hashDe(senha) {
  const salt = randomBytes(16);
  const hash = scryptSync(senha, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return ["scrypt", 16384, 8, 1, salt.toString("hex"), hash.toString("hex")].join("$");
}
const PAINEL_HASH = hashDe(PAINEL_SENHA);

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

function pessoa(nome, perfil, extra = {}) {
  return {
    id: `11111111-1111-4111-8111-${String(nome.length).padStart(12, "0")}`,
    criado_em: "2026-09-24T12:00:00Z",
    nome,
    whatsapp: "(11) 91234-5678",
    whatsapp_digits: "11912345678",
    email: "maria@gmail.com",
    perfil,
    utm_source: "unnichat",
    ...extra
  };
}

/**
 * Supabase falso: cada GET em pesquisa_pessoas vira uma chamada guardada, e a contagem que o
 * PostgREST devolveria (Content-Range) sai de `contar`, que recebe os parâmetros da consulta.
 */
async function logado({ linhas = [], contar = () => 0, ...opcoes } = {}) {
  const chamadas = [];
  const fetchImpl = async (url, init = {}) => {
    const endereco = new URL(String(url));
    const chamada = { caminho: endereco.pathname, params: endereco.searchParams, headers: init.headers || {} };
    chamadas.push(chamada);
    if (endereco.pathname !== "/rest/v1/pesquisa_pessoas") {
      return new Response(JSON.stringify({ message: "rota inesperada no teste" }), { status: 404 });
    }
    const limite = Number(endereco.searchParams.get("limit") ?? "100");
    const corpo = limite === 0 ? [] : linhas;
    const total = contar(endereco.searchParams);
    return new Response(JSON.stringify(corpo), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Range": corpo.length ? `0-${corpo.length - 1}/${total}` : `*/${total}`
      }
    });
  };

  const server = createServerApp({
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_KEY,
    painelEmail: PAINEL_EMAIL,
    painelSenhaHash: PAINEL_HASH,
    painelSessaoSegredo: PAINEL_SEGREDO,
    fetchImpl,
    ...opcoes
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const appUrl = `http://127.0.0.1:${server.address().port}`;

  const entrada = await fetch(`${appUrl}/api/painel/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: PAINEL_EMAIL, senha: PAINEL_SENHA })
  });
  const cookie = String(entrada.headers.getSetCookie()[0] || "").split(";")[0];
  assert.match(cookie, /^ev_painel=/);

  return {
    appUrl,
    chamadas,
    get: (rota) => fetch(`${appUrl}${rota}`, { headers: { Cookie: cookie } }),
    // As consultas da tela: a primeira é a lista, as outras são as contagens por profissão.
    consultas: () => chamadas.filter((c) => c.caminho === "/rest/v1/pesquisa_pessoas")
  };
}

/* ------------------------------------------------------------------ a lista e as contagens */

test("lê só a pesquisa da página curta, com a lista e uma contagem por profissão", async () => {
  const totais = { [EV.PERFIL.auxiliar]: 7, [EV.PERFIL.cuidador]: 3, [EV.PERFIL.tecnico]: 21, [EV.PERFIL.enfermeiro]: 9 };
  const { get, consultas } = await logado({
    linhas: [pessoa("Maria da Silva", EV.PERFIL.tecnico)],
    contar: (params) => {
      const perfil = (params.get("perfil") || "").replace(/^eq\./, "");
      return perfil ? totais[perfil] ?? 0 : 40;
    }
  });

  const resposta = await get("/api/painel/perfis");
  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();

  assert.equal(corpo.total, 40);
  assert.equal(corpo.itens.length, 1);
  assert.equal(corpo.itens[0].nome, "Maria da Silva");
  // O somatório dos quatro cartões é o número grande da tela.
  assert.equal(corpo.respondentes, 40);
  assert.deepEqual(corpo.por_perfil, [
    ...Object.values(EV.PERFIL).map((perfil) => ({ perfil, codigo: EV.PERFIL_CODIGO[perfil], total: totais[perfil] })),
    // O grupo do ManyChat entra como uma "profissão" a mais na aba, com o rótulo curto dele.
    { perfil: GRUPO.rotulo, codigo: GRUPO.codigo, curto: GRUPO.curto, total: totais[GRUPO.rotulo] ?? 0 }
  ]);
  assert.ok(corpo.gerado_em);
  // Sem PERFIL_WEBHOOK_URL configurada, o painel não pendura "aviso pendente" em ninguém.
  assert.equal(corpo.aviso_ativo, false);

  // Seis consultas: a lista, as quatro profissões e o grupo "enfermagem" — nenhuma no ICP.
  const pedidas = consultas();
  assert.equal(pedidas.length, 6);
  for (const chamada of pedidas) {
    // As duas origens de contato + profissão: a página curta do WhatsApp e a DM do Instagram.
    assert.equal(chamada.params.get("pesquisa"), "in.(atualizacao-perfil,manychat-instagram)");
    assert.equal(chamada.headers.Prefer, "count=exact");
  }
  const lista = pedidas[0];
  assert.equal(lista.params.get("order"), "criado_em.desc,id.desc");
  assert.equal(lista.params.get("limit"), "100");
  assert.equal(lista.params.get("offset"), "0");
  // A lista traz o contato e a profissão; respostas da pesquisa grande, não.
  assert.match(lista.params.get("select"), /nome,whatsapp,whatsapp_digits,email,perfil,pesquisa,webhook_enviado_em/);
  assert.doesNotMatch(lista.params.get("select"), /respostas/);
  // As contagens não trazem linha nenhuma: só o número do Content-Range.
  for (const contagem of pedidas.slice(1)) assert.equal(contagem.params.get("limit"), "0");
  assert.deepEqual(
    pedidas.slice(1).map((c) => c.params.get("perfil")),
    [...Object.values(EV.PERFIL), GRUPO.rotulo].map((perfil) => `eq.${perfil}`)
  );
});

test("busca e período valem para a lista E para as contagens (um filtro muda todos os números)", async () => {
  const { get, consultas } = await logado({ contar: () => 2 });
  const resposta = await get("/api/painel/perfis?desde=2026-09-01&ate=2026-09-24&busca=maria");
  assert.equal(resposta.status, 200);

  for (const chamada of consultas()) {
    // O painel manda o fim já exclusivo (o começo do dia seguinte): o servidor só repassa.
    assert.deepEqual(chamada.params.getAll("criado_em"), ["gte.2026-09-01T00:00:00.000Z", "lt.2026-09-24T00:00:00.000Z"]);
    assert.equal(chamada.params.get("or"), "(nome.ilike.*maria*,email.ilike.*maria*)");
  }
});

test("busca que parece telefone procura também no WhatsApp", async () => {
  const { get, consultas } = await logado({ contar: () => 1 });
  await get("/api/painel/perfis?busca=11+91234-5678");
  assert.equal(consultas()[0].params.get("or"), "(nome.ilike.*11 91234-5678*,email.ilike.*11 91234-5678*,whatsapp_digits.ilike.*11912345678*)");
});

test("escolher uma profissão filtra a lista, mas os quatro cartões continuam com o número deles", async () => {
  const { get, consultas } = await logado({ contar: (params) => ((params.get("perfil") || "").includes("Cuidador") ? 3 : 11) });
  const corpo = await (await get(`/api/painel/perfis?perfil=${encodeURIComponent(EV.PERFIL.cuidador)}`)).json();

  const pedidas = consultas();
  assert.equal(pedidas[0].params.get("perfil"), `eq.${EV.PERFIL.cuidador}`);
  assert.equal(pedidas.length, 6, "as contagens das outras profissões continuam sendo pedidas");
  assert.equal(corpo.por_perfil.find((item) => item.perfil === EV.PERFIL.tecnico).total, 11);
  assert.equal(corpo.total, 3, "a lista é só da profissão escolhida");
});

test('"Carregar mais" só muda o offset da lista', async () => {
  const { get, consultas } = await logado({ contar: () => 250 });
  await get("/api/painel/perfis?limite=100&offset=100");
  assert.equal(consultas()[0].params.get("offset"), "100");
  // A contagem não pagina: sem offset, ela conta o recorte inteiro.
  for (const contagem of consultas().slice(1)) assert.equal(contagem.params.get("offset"), null);
});

/* ------------------------------------------------------------------ recusas */

test("filtro inválido é 422, e nada é consultado", async () => {
  const { get, consultas } = await logado();
  for (const rota of [
    "/api/painel/perfis?perfil=Estudante",
    "/api/painel/perfis?perfil=Outro",
    "/api/painel/perfis?desde=ontem",
    "/api/painel/perfis?limite=abc"
  ]) {
    const resposta = await get(rota);
    assert.equal(resposta.status, 422, rota);
    assert.equal((await resposta.json()).error, "invalid_filters", rota);
  }
  assert.deepEqual(consultas(), []);
});

test("sem sessão: 401 e nenhuma consulta ao banco", async () => {
  const { appUrl, consultas } = await logado();
  const resposta = await fetch(`${appUrl}/api/painel/perfis`);
  assert.equal(resposta.status, 401);
  assert.deepEqual(consultas(), []);
});

test("método errado: 405", async () => {
  const { appUrl } = await logado();
  const resposta = await fetch(`${appUrl}/api/painel/perfis`, { method: "POST" });
  assert.equal(resposta.status, 405);
});

test("banco fora do ar: 502, sem vazar o motivo", async () => {
  // fetchImpl passado aqui substitui o Supabase falso: toda consulta volta em erro.
  const { get } = await logado({ fetchImpl: async () => new Response("boom", { status: 500 }) });
  const resposta = await get("/api/painel/perfis");
  assert.equal(resposta.status, 502);
  assert.equal((await resposta.json()).error, "database_unavailable");
});

/* ------------------------------------------------------------------ Hotmart: uma chave por produto */

const AVISO_HOTMART = {
  id: "aviso-1",
  event: "PURCHASE_APPROVED",
  data: {
    product: { id: 123, name: "Produto separado" },
    purchase: { transaction: "HP123", status: "APPROVED", price: { value: 197, currency_value: "BRL" } },
    buyer: { name: "Maria da Silva", email: "maria@gmail.com" }
  }
};

async function subirHotmart(hotmartChave) {
  const server = createServerApp({
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_KEY,
    hotmartChave,
    fetchImpl: async () => new Response(JSON.stringify({ casou: true }), { status: 200, headers: { "Content-Type": "application/json" } })
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const appUrl = `http://127.0.0.1:${server.address().port}`;
  return (chave) =>
    fetch(`${appUrl}/api/hotmart/venda${chave === null ? "" : `?chave=${encodeURIComponent(chave)}`}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(AVISO_HOTMART)
    });
}

test("cada produto tem a sua chave: as duas valem no mesmo endereço, e só elas", async () => {
  const avisar = await subirHotmart("chave-do-produto-1,chave-do-produto-2");
  assert.equal((await avisar("chave-do-produto-1")).status, 200);
  assert.equal((await avisar("chave-do-produto-2")).status, 200);
  assert.equal((await avisar("chave-de-quem-adivinhou")).status, 401);
  assert.equal((await avisar(null)).status, 401);
  // Uma chave vazia na lista (variável de ambiente em branco) não pode virar "qualquer um entra".
  const comVazia = await subirHotmart("chave-do-produto-1, ,");
  assert.equal((await comVazia("")).status, 401);
  assert.equal((await comVazia(" ")).status, 401);
  assert.equal((await comVazia("chave-do-produto-1")).status, 200);
});

test("sem chave nenhuma e sem hottok: 503 (a Hotmart retém e reenvia)", async () => {
  const avisar = await subirHotmart("");
  assert.equal((await avisar("qualquer")).status, 503);
});

test("com webhook de perfil configurado, o painel sabe que existe aviso para cobrar", async () => {
  const { get } = await logado({ contar: () => 0, perfilWebhookUrl: "https://n8n-de-teste.invalid/webhook/perfil-atualizado" });
  const corpo = await (await get("/api/painel/perfis")).json();
  assert.equal(corpo.aviso_ativo, true);
});
