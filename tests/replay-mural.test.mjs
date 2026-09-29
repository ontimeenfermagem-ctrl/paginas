/*
 * O mural das salas de aula: comentar, listar, moderar e responder como a Iza.
 *
 * Supabase falso que grava cada chamada. O que este arquivo protege:
 *
 *   - quem não liberou a sala NÃO recebe texto de terceiro (só a contagem);
 *   - o nome de quem comenta vem do BANCO, nunca do corpo do pedido — e sai abreviado;
 *   - moderar e responder exigem a sessão do painel e a mesma origem;
 *   - a resposta da Iza é gravada com o nome e o papel do CONFIG, e admin_email da sessão;
 *   - comentário com link entra em conferência em vez de ir ao ar.
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
for (const arquivo of ["lead-rules.js", "pesquisa-config.js", "obrigado-config.js", "checkout-config.js", "replay-config.js"]) {
  vm.runInNewContext(readFileSync(path.join(RAIZ, "js", arquivo), "utf8"), contexto);
}
const RPL = contexto.EVReplay;
const SALA = RPL.PAGINAS.afericao;

const SUPABASE_URL = "https://projeto-de-teste.supabase.co";
const SUPABASE_KEY = "chave-service-role-de-teste";
const PAINEL_EMAIL = "equipe@escolaenfermagemdevalor.com.br";
const PAINEL_SENHA = "SenhaDoPainel@2026";
const PAINEL_SEGREDO = "segredo-de-sessao-de-teste-0123456789abcdef";
const SESSAO = "77777777-7777-4777-8777-777777777777";

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

function json(corpo, status = 200, headers = {}) {
  return new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/**
 * `lead` = a linha de pesquisa_respostas daquele id de sessão (null = nunca liberou a sala).
 * `raizes` e `respostas` = o que a view/tabela devolve. `erroRpc` = o nome do erro que a função
 * do banco levanta.
 */
async function subir({ lead = { id: SESSAO, nome: "Maria da Silva", perfil: "Cuidador(a)" }, raizes = [], respostas = [], total = 0, erroRpc = "" } = {}) {
  const chamadas = [];
  const fetchImpl = async (url, init = {}) => {
    const endereco = new URL(String(url));
    const q = endereco.searchParams;
    chamadas.push({ caminho: endereco.pathname, params: q, corpo: init.body ? JSON.parse(init.body) : null });

    if (endereco.pathname.startsWith("/rest/v1/rpc/")) {
      if (erroRpc) return new Response(JSON.stringify({ message: erroRpc }), { status: 400 });
      return json({ id: 412, estado: "visivel", resposta_a: 1, linhas: 1 });
    }
    if (endereco.pathname === "/rest/v1/pesquisa_respostas") return json(lead ? [lead] : []);
    if (endereco.pathname === "/rest/v1/replay_comentarios_publicos" || endereco.pathname === "/rest/v1/replay_comentarios") {
      if (q.get("limit") === "0") {
        return json([], 200, { "Content-Range": `*/${total}` });
      }
      const pedeRespostas = (q.get("resposta_a") || "").startsWith("in.");
      return json(pedeRespostas ? respostas : raizes);
    }
    return json({ message: "rota inesperada no teste" }, 404);
  };

  const server = createServerApp({
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_KEY,
    painelEmail: PAINEL_EMAIL,
    painelSenhaHash: PAINEL_HASH,
    painelSessaoSegredo: PAINEL_SEGREDO,
    fetchImpl
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const entrar = async () => {
    const r = await fetch(`${base}/api/painel/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: PAINEL_EMAIL, senha: PAINEL_SENHA })
    });
    return String(r.headers.getSetCookie()[0] || "").split(";")[0];
  };

  return { base, chamadas, entrar, consultas: () => chamadas.filter((c) => c.caminho.includes("replay_comentarios")) };
}

const CARTA = {
  id: 2,
  criado_em: "2026-09-29T18:00:00Z",
  resposta_a: null,
  admin: false,
  autor_exibicao: "Maria S.",
  autor_perfil: "Cuidador(a)",
  texto: "Assisti duas vezes!"
};

/* ------------------------------------------------------------------ listar */

test("sem acesso: devolve a contagem e NENHUM texto de terceiro", async () => {
  const { base, consultas } = await subir({ raizes: [CARTA], total: 7 });
  const r = await fetch(`${base}/api/replay/comentarios?pagina=afericao`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("vary"), "Cookie");
  const corpo = await r.json();
  assert.equal(corpo.total, 7, "a contagem sai (é a prova social)");
  assert.deepEqual(corpo.itens, [], "nenhum comentário");
  assert.equal(corpo.admin, false);
  // Nem chega a pedir as linhas ao banco.
  assert.ok(!consultas().some((c) => c.params.get("limit") !== "0"), "só a consulta de contagem");
});

test("com acesso conferido: os comentários e as respostas vêm juntos, sem coluna privada", async () => {
  const { base } = await subir({
    raizes: [CARTA],
    respostas: [{ id: 3, criado_em: "2026-09-29T19:00:00Z", resposta_a: 2, admin: true, autor_exibicao: "Izabel Gonçalves", autor_perfil: "Escola", texto: "Que bom!" }],
    total: 1
  });
  const corpo = await (await fetch(`${base}/api/replay/comentarios?pagina=afericao&sessao_id=${SESSAO}`)).json();
  assert.equal(corpo.itens.length, 1);
  const item = corpo.itens[0];
  assert.deepEqual(Object.keys(item).sort(), ["admin", "autor", "criado_em", "id", "respostas", "texto"]);
  assert.deepEqual(item.autor, { nome: "Maria S.", perfil: "Cuidador(a)" });
  assert.equal(item.respostas.length, 1);
  assert.equal(item.respostas[0].admin, true);
  // Nada de sessao_id, visitante_id, admin_email nem nome completo na resposta.
  const texto = JSON.stringify(corpo);
  for (const proibido of ["sessao_id", "visitante_id", "admin_email", "Maria da Silva"]) {
    assert.ok(!texto.includes(proibido), `${proibido} não pode sair na listagem pública`);
  }
});

test("sessão de acesso que não existe: volta à contagem, sem itens", async () => {
  const { base } = await subir({ lead: null, raizes: [CARTA], total: 3 });
  const corpo = await (await fetch(`${base}/api/replay/comentarios?pagina=afericao&sessao_id=${SESSAO}`)).json();
  assert.equal(corpo.total, 3);
  assert.deepEqual(corpo.itens, []);
});

test("com a sessão do painel: admin=true e o estado de cada linha (é o que liga os três pontinhos)", async () => {
  const { base, entrar, consultas } = await subir({
    raizes: [{ ...CARTA, estado: "oculto" }],
    total: 1
  });
  const cookie = await entrar();
  const corpo = await (await fetch(`${base}/api/replay/comentarios?pagina=afericao`, { headers: { Cookie: cookie } })).json();
  assert.equal(corpo.admin, true);
  assert.equal(corpo.itens[0].estado, "oculto", "o admin vê o que está fora do ar");
  // O admin lê a TABELA (com estado); o público lê a view.
  assert.ok(consultas().some((c) => c.caminho === "/rest/v1/replay_comentarios"), "admin lê a tabela");
});

test("sala que não existe: 422; método errado: 405", async () => {
  const { base } = await subir();
  assert.equal((await fetch(`${base}/api/replay/comentarios?pagina=outra`)).status, 422);
  assert.equal((await fetch(`${base}/api/replay/comentarios?pagina=afericao`, { method: "POST" })).status, 405);
});

/* ------------------------------------------------------------------ comentar */

async function comentar(base, corpo, headers = {}) {
  const r = await fetch(`${base}/api/replay/comentario`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(corpo)
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

test("comentar: o nome vem do BANCO e sai abreviado; o corpo não manda nome nenhum", async () => {
  const { base, chamadas } = await subir();
  const { status, json: corpo } = await comentar(base, {
    pagina: "afericao",
    sessao_id: SESSAO,
    texto: "  Aula muito clara, obrigada!  ",
    // Tentativa de se apresentar como outra pessoa: ignorada.
    autor_nome: "Izabel Gonçalves",
    autor_exibicao: "Izabel Gonçalves",
    admin: true
  });
  assert.equal(status, 201);
  assert.equal(corpo.comentario.estado, "visivel");

  const p = chamadas.find((c) => c.caminho.includes("replay_comentario_publicar")).corpo.p;
  assert.equal(p.autor_nome, "Maria da Silva", "o nome completo vem da linha do lead");
  assert.equal(p.autor_exibicao, "Maria S.", "e o público vê só o abreviado");
  assert.equal(p.autor_perfil, "Cuidador(a)");
  assert.equal(p.texto, "Aula muito clara, obrigada!");
  assert.equal(p.sala, SALA.pesquisa);
  assert.equal(p.admin, undefined, "a rota pública não manda admin");
  assert.equal(p.resposta_a, undefined, "nem responde a ninguém");
});

test("comentar sem ter liberado a sala: 403, e nada é gravado", async () => {
  const { base, chamadas } = await subir({ lead: null });
  const { status, json } = await comentar(base, { pagina: "afericao", sessao_id: SESSAO, texto: "oi oi" });
  assert.equal(status, 403);
  assert.equal(json.error, "acesso_nao_liberado");
  assert.ok(!chamadas.some((c) => c.caminho.includes("rpc/")), "nenhuma gravação");
});

test("comentar sem id de sessão: 403 antes de qualquer ida ao banco", async () => {
  const { base, chamadas } = await subir();
  const { status, json } = await comentar(base, { pagina: "afericao", texto: "oi oi" });
  assert.equal(status, 403);
  assert.equal(json.error, "acesso_nao_liberado");
  assert.deepEqual(chamadas, []);
});

test("comentário com link entra em conferência, não no ar", async () => {
  const { base, chamadas } = await subir();
  const { status, json } = await comentar(base, { pagina: "afericao", sessao_id: SESSAO, texto: "olha isso https://spam.example.com" });
  assert.equal(status, 201);
  assert.equal(json.aviso, "em_conferencia");
  assert.equal(chamadas.find((c) => c.caminho.includes("publicar")).corpo.p.estado, "em_revisao");
});

test("texto que não presta é 422: vazio, uma letra, só controles, só marcas combinantes", async () => {
  const { base, chamadas } = await subir();
  for (const texto of ["", " ", "a", "\u0000\u0001", "é́́́́́́́́́", 42, null]) {
    const { status, json } = await comentar(base, { pagina: "afericao", sessao_id: SESSAO, texto });
    assert.equal(status, 422, JSON.stringify(texto));
    assert.equal(json.error, "invalid_text");
  }
  assert.ok(!chamadas.some((c) => c.caminho.includes("rpc/")));
});

test("texto longo é cortado no teto, e as quebras em excesso somem", async () => {
  const { base, chamadas } = await subir();
  await comentar(base, { pagina: "afericao", sessao_id: SESSAO, texto: "a".repeat(5000) });
  assert.equal(chamadas.find((c) => c.caminho.includes("publicar")).corpo.p.texto.length, 1200);
});

test("freio do banco: muito_rapido e repetido viram 429", async () => {
  for (const erro of ["muito_rapido", "repetido"]) {
    const { base } = await subir({ erroRpc: erro });
    const { status, json } = await comentar(base, { pagina: "afericao", sessao_id: SESSAO, texto: "de novo" });
    assert.equal(status, 429, erro);
    assert.equal(json.error, erro);
  }
});

/* ------------------------------------------------------------------ moderar e responder */

async function admin(base, rota, corpo, { cookie = "", origin = "" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  const r = await fetch(`${base}${rota}`, { method: "POST", headers, body: JSON.stringify(corpo) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

test("moderar e responder SEM sessão do painel: 401, e nada acontece", async () => {
  const { base, chamadas } = await subir();
  for (const rota of ["/api/painel/replay/comentario", "/api/painel/replay/resposta"]) {
    const { status, json } = await admin(base, rota, { pagina: "afericao", id: 1, respondendo_id: 1, acao: "excluir", texto: "oi oi" });
    assert.equal(status, 401, rota);
    assert.equal(json.error, "unauthorized", rota);
  }
  assert.deepEqual(chamadas, []);
});

test("Origin de outro site: 403 origin_not_allowed", async () => {
  const { base, entrar } = await subir();
  const cookie = await entrar();
  const { status, json } = await admin(base, "/api/painel/replay/comentario", { pagina: "afericao", id: 1, acao: "excluir" }, { cookie, origin: "https://site-de-golpe.com" });
  assert.equal(status, 403);
  assert.equal(json.error, "origin_not_allowed");
});

test("moderar: as três ações passam, e o e-mail da sessão vai como quem moderou", async () => {
  for (const acao of ["esconder", "mostrar", "excluir"]) {
    const { base, entrar, chamadas } = await subir();
    const cookie = await entrar();
    const { status } = await admin(base, "/api/painel/replay/comentario", { pagina: "afericao", id: 412, acao }, { cookie });
    assert.equal(status, 200, acao);
    const p = chamadas.find((c) => c.caminho.includes("moderar")).corpo.p;
    assert.equal(p.acao, acao);
    assert.equal(p.id, 412);
    assert.equal(p.sala, SALA.pesquisa);
    assert.equal(p.por, PAINEL_EMAIL, "quem moderou fica registrado");
  }
});

test("moderar: ação inventada e id torto são 422", async () => {
  const { base, entrar, chamadas } = await subir();
  const cookie = await entrar();
  for (const corpo of [
    { pagina: "afericao", id: 1, acao: "apagar-tudo" },
    { pagina: "afericao", id: "abc", acao: "excluir" },
    { pagina: "afericao", id: -3, acao: "excluir" },
    { pagina: "afericao", acao: "excluir" }
  ]) {
    const { status, json } = await admin(base, "/api/painel/replay/comentario", corpo, { cookie });
    assert.equal(status, 422, JSON.stringify(corpo));
    assert.equal(json.error, "invalid_acao");
  }
  assert.ok(!chamadas.some((c) => c.caminho.includes("moderar")));
});

test("responder: o nome, o papel e o selo saem do CONFIG; o e-mail, da sessão", async () => {
  const { base, entrar, chamadas } = await subir();
  const cookie = await entrar();
  const { status, json } = await admin(
    base,
    "/api/painel/replay/resposta",
    // Tentativa de assinar com outro nome: ignorada.
    { pagina: "afericao", respondendo_id: 412, texto: "Que bom, Maria!", autor_nome: "Outra pessoa", admin_email: "invasor@example.com" },
    { cookie }
  );
  assert.equal(status, 201);
  assert.equal(json.comentario.admin, true);
  const p = chamadas.find((c) => c.caminho.includes("responder")).corpo.p;
  assert.equal(p.autor_nome, RPL.ADMIN.nome);
  assert.equal(p.autor_perfil, RPL.ADMIN.papel);
  assert.equal(p.admin_email, PAINEL_EMAIL, "o e-mail vem da sessão, não do corpo");
  assert.equal(p.resposta_a, 412);
  assert.equal(p.texto, "Que bom, Maria!");
});

test("responder: resposta de resposta é recusada pelo banco e vira 422", async () => {
  const { base, entrar } = await subir({ erroRpc: "resposta_de_resposta" });
  const cookie = await entrar();
  const { status, json } = await admin(base, "/api/painel/replay/resposta", { pagina: "afericao", respondendo_id: 9, texto: "oi oi" }, { cookie });
  assert.equal(status, 422);
  assert.equal(json.error, "resposta_de_resposta");
});

test("comentário que não existe: 404 nas duas rotas de admin", async () => {
  for (const [rota, corpo] of [
    ["/api/painel/replay/comentario", { pagina: "afericao", id: 999, acao: "excluir" }],
    ["/api/painel/replay/resposta", { pagina: "afericao", respondendo_id: 999, texto: "oi oi" }]
  ]) {
    const { base, entrar } = await subir({ erroRpc: "comentario_nao_encontrado" });
    const cookie = await entrar();
    const { status, json } = await admin(base, rota, corpo, { cookie });
    assert.equal(status, 404, rota);
    assert.equal(json.error, "comentario_nao_encontrado");
  }
});
