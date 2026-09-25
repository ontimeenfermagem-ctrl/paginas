/*
 * /atualizacao-perfil — a página curta do UnniChat (contato + profissão) e o POST que a grava.
 *
 * Prova que a gravação cai na MESMA tabela da pesquisa, com o id de pesquisa próprio, e que o
 * perfil vira código interno e destino de obrigado sem lista nova em lugar nenhum.
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
vm.runInNewContext(readFileSync(path.join(RAIZ, "js", "obrigado-config.js"), "utf8"), contexto);
const EV = contexto.EVPesquisa;
const OB = contexto.EVObrigado;

const SUPABASE_URL = "https://projeto-de-teste.supabase.co";
const SUPABASE_KEY = "chave-service-role-de-teste";
const UUID = "33333333-3333-4333-8333-333333333333";

const CONTATO = { nome: "maria da silva", whatsapp: "(11) 91234-5678", email: "maria@gmail.com" };
const RASTREIO = {
  page_url: "https://lp.escolaenfermagemdevalor.com.br/atualizacao-perfil?utm_source=unnichat",
  referrer: null,
  dispositivo: "mobile",
  utm_source: "unnichat",
  utm_medium: "whatsapp",
  utm_campaign: "atualizar-perfil",
  utm_content: null,
  utm_term: null,
  fbclid: null,
  gclid: null
};

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

const PERFIL_WEBHOOK_URL = "https://n8n-de-teste.invalid/webhook/perfil-atualizado";

async function subir({
  semBanco = false,
  erroDoBanco = false,
  dominio = "ok",
  perfilWebhookUrl = "",
  finalizouAgora = true,
  linha = null,
  webhookStatus = 200,
  ...opcoes
} = {}) {
  const chamadas = [];
  let avisar = () => {};
  const avisado = new Promise((resolve) => (avisar = resolve));
  const fetchImpl = async (url, init = {}) => {
    const endereco = String(url);
    const chamada = { url: endereco, corpo: init.body ? JSON.parse(init.body) : null };
    chamadas.push(chamada);
    if (endereco === perfilWebhookUrl) {
      avisar(chamada);
      return new Response("", { status: webhookStatus });
    }
    if (erroDoBanco) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify({ ok: true, novo: true, finalizou_agora: finalizouAgora, linha }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  const server = createServerApp({
    supabaseUrl: semBanco ? "" : SUPABASE_URL,
    supabaseKey: semBanco ? "" : SUPABASE_KEY,
    perfilWebhookUrl,
    fetchImpl,
    resolveEmailDomain: async () => dominio,
    ...opcoes
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, chamadas, avisado };
}

/** A linha que o pesquisa_salvar devolve para quem acabou de fechar o perfil. */
function linhaGravada(perfil, extra = {}) {
  return {
    id: UUID,
    pesquisa: "atualizacao-perfil",
    criado_em: "2026-09-25T12:00:00Z",
    finalizado_em: "2026-09-25T12:00:40Z",
    nome: "Maria da Silva",
    whatsapp: "(11) 91234-5678",
    whatsapp_digits: "11912345678",
    whatsapp_internacional: "5511912345678",
    email: "maria@gmail.com",
    perfil,
    utm_source: "unnichat",
    utm_medium: "whatsapp",
    utm_campaign: "atualizar-perfil",
    dispositivo: "mobile",
    ...extra
  };
}

async function enviar(base, corpo, { tipo = "application/json", metodo = "POST" } = {}) {
  return await new Promise((resolve, reject) => {
    const dados = typeof corpo === "string" ? corpo : JSON.stringify(corpo);
    const req = httpRequest(
      `${base}/api/atualizacao-perfil`,
      { method: metodo, headers: tipo ? { "Content-Type": tipo } : {} },
      (res) => {
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
      }
    );
    req.on("error", reject);
    req.end(dados);
  });
}

async function pegar(base, caminho) {
  return await new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${caminho}`, { method: "GET" }, (res) => {
      let texto = "";
      res.on("data", (p) => (texto += p));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, corpo: texto }));
    });
    req.on("error", reject);
    req.end();
  });
}

/* ------------------------------------------------------------------ a página */

test("a rota /atualizacao-perfil serve a página, com e sem barra, e não é indexada", async () => {
  const { base } = await subir();
  for (const rota of ["/atualizacao-perfil", "/atualizacao-perfil/"]) {
    const { status, headers, corpo } = await pegar(base, rota);
    assert.equal(status, 200, rota);
    assert.match(headers["content-type"], /text\/html/);
    assert.match(headers["x-robots-tag"] || "", /noindex/);
    assert.match(corpo, /Hoje você é:/);
    assert.match(corpo, /js\/atualizacao\.js/);
    // O Pixel é injetado aqui como nas outras páginas públicas.
    assert.match(corpo, /fbq\('init'/);
  }
});

/* ------------------------------------------------------------------ gravação */

for (const [rotulo, codigo] of Object.entries(EV.PERFIL_CODIGO)) {
  test(`grava "${rotulo}" como ${codigo} e devolve a página de obrigado certa`, async () => {
    const { base, chamadas } = await subir();
    const { status, json } = await enviar(base, {
      id: UUID,
      visitante_id: null,
      contato: CONTATO,
      perfil: rotulo,
      rastreio: RASTREIO
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.profession, codigo);
    assert.equal(json.obrigado, OB.paginaDoPerfil(rotulo).rota);

    const rpc = chamadas.find((c) => c.url.includes("/rpc/pesquisa_salvar"));
    assert.ok(rpc, "gravou pela função da pesquisa, sem tabela nova");
    const p = rpc.corpo.p;
    assert.equal(p.pesquisa, "atualizacao-perfil", "id de pesquisa próprio: não mistura com o ICP");
    assert.equal(p.perfil, rotulo);
    assert.deepEqual(p.respostas, { perfil: rotulo });
    assert.equal(p.nome, "Maria da Silva", "nome formatado como no resto do projeto");
    assert.equal(p.whatsapp, "(11) 91234-5678");
    assert.equal(p.whatsapp_digits, "11912345678");
    assert.equal(p.email, "maria@gmail.com");
    assert.equal(p.completa, true);
    assert.equal(p.finalizou, true);
    assert.equal(p.progresso_percentual, 100);
    assert.equal(p.utm_source, "unnichat");
    assert.equal(p.dispositivo, "mobile");
  });
}

test("id ausente não impede a gravação (o servidor gera um)", async () => {
  const { base, chamadas } = await subir();
  const { status } = await enviar(base, { contato: CONTATO, perfil: EV.PERFIL.tecnico, rastreio: RASTREIO });
  assert.equal(status, 200);
  const p = chamadas.find((c) => c.url.includes("/rpc/pesquisa_salvar")).corpo.p;
  assert.match(p.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

/* ------------------------------------------------------------------ recusas */

test("contato inválido: 422 com a mensagem por campo, e nada é gravado", async () => {
  const { base, chamadas } = await subir();
  const { status, json } = await enviar(base, {
    contato: { nome: "Maria", whatsapp: "(11) 3123-4567", email: "maria@gmail.con" },
    perfil: EV.PERFIL.cuidador,
    rastreio: RASTREIO
  });
  assert.equal(status, 422);
  assert.equal(json.error, "invalid_contact");
  assert.equal(json.campos.nome, "Escreva também o seu sobrenome.");
  assert.ok(json.campos.whatsapp);
  assert.ok(json.campos.email);
  assert.deepEqual(chamadas, []);
});

test("e-mail de domínio inexistente: 422 com a mensagem de domínio", async () => {
  const { base } = await subir({ dominio: "missing" });
  // Domínio fora da lista de provedores conhecidos: é o caso em que o servidor consulta o DNS
  // (gmail.com e companhia passam direto, e aí o resolvedor nem é chamado).
  const { status, json } = await enviar(base, {
    contato: { ...CONTATO, email: "maria@escola-que-nao-existe.com.br" },
    perfil: EV.PERFIL.enfermeiro,
    rastreio: RASTREIO
  });
  assert.equal(status, 422);
  assert.equal(json.campos.email, "Não encontramos esse endereço de e-mail. Confere se está certinho?");
});

test("perfil fora dos quatro: 422 invalid_perfil", async () => {
  const { base, chamadas } = await subir();
  for (const perfil of ["Estudante da área da saúde", "Outro", "", "toString"]) {
    const { status, json } = await enviar(base, { contato: CONTATO, perfil, rastreio: RASTREIO });
    assert.equal(status, 422, perfil);
    assert.equal(json.error, "invalid_perfil");
  }
  assert.deepEqual(chamadas, []);
});

test("sem JSON: 415; método errado: 405; sem banco: 503; banco fora: 502", async () => {
  const semJson = await subir();
  assert.equal((await enviar(semJson.base, "nome=maria", { tipo: "text/plain" })).status, 415);
  assert.equal((await enviar(semJson.base, {}, { metodo: "GET" })).status, 405);

  const semBanco = await subir({ semBanco: true });
  const r1 = await enviar(semBanco.base, { contato: CONTATO, perfil: EV.PERFIL.tecnico, rastreio: RASTREIO });
  assert.equal(r1.status, 503);
  assert.equal(r1.json.error, "database_not_configured");

  const comErro = await subir({ erroDoBanco: true });
  const r2 = await enviar(comErro.base, { contato: CONTATO, perfil: EV.PERFIL.tecnico, rastreio: RASTREIO });
  assert.equal(r2.status, 502);
  assert.equal(r2.json.error, "database_unavailable");
});

/* ------------------------------------------------------------------ o gatilho do WhatsApp */

test("terminar o perfil dispara UM aviso, com a profissão nos três formatos", async () => {
  const { base, chamadas, avisado } = await subir({
    perfilWebhookUrl: PERFIL_WEBHOOK_URL,
    linha: linhaGravada(EV.PERFIL.cuidador)
  });
  const { status } = await enviar(base, { id: UUID, contato: CONTATO, perfil: EV.PERFIL.cuidador, rastreio: RASTREIO });
  assert.equal(status, 200);

  const aviso = await avisado;
  const p = aviso.corpo;
  assert.equal(p.evento, "perfil_atualizado");
  assert.equal(p.origem, "atualizacao-perfil");
  assert.equal(p.lead_id, UUID);
  assert.equal(p.perfil, EV.PERFIL.cuidador);
  assert.equal(p.perfil_codigo, "cuidador");
  assert.equal(p.segmento, EV.PERFIL_SEGMENTO[EV.PERFIL.cuidador]);
  assert.equal(p.pagina_obrigado.rota, OB.paginaDoPerfil(EV.PERFIL.cuidador).rota);
  assert.deepEqual(p.lead, {
    nome: "Maria da Silva",
    primeiro_nome: "Maria",
    whatsapp: "(11) 91234-5678",
    whatsapp_digits: "11912345678",
    whatsapp_internacional: "5511912345678",
    email: "maria@gmail.com"
  });
  assert.equal(p.utm.utm_source, "unnichat");
  assert.equal(p.utm.utm_campaign, "atualizar-perfil");
  assert.equal(p.rastreio.dispositivo, "mobile");
  assert.ok(p.atualizado_em && p.enviado_em);
  // Esta página não tem pesquisa: nada de respostas nem de lista de perguntas no aviso.
  assert.equal(p.respostas, undefined);
  assert.equal(p.perguntas, undefined);

  // Um aviso só, e a linha fica marcada como entregue.
  assert.equal(chamadas.filter((c) => c.url === PERFIL_WEBHOOK_URL).length, 1);
  const marca = chamadas.find((c) => c.url.includes("pesquisa_respostas?id=eq."));
  assert.ok(marca && marca.corpo.webhook_enviado_em, "marcou webhook_enviado_em");
});

test("quem já tinha terminado antes não dispara a sequência de novo", async () => {
  const { base, chamadas } = await subir({ perfilWebhookUrl: PERFIL_WEBHOOK_URL, finalizouAgora: false });
  const { status } = await enviar(base, { id: UUID, contato: CONTATO, perfil: EV.PERFIL.tecnico, rastreio: RASTREIO });
  assert.equal(status, 200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(chamadas.filter((c) => c.url === PERFIL_WEBHOOK_URL), []);
});

test("sem webhook de perfil configurado, nada sai (e a gravação segue igual)", async () => {
  const { base, chamadas } = await subir({ finalizouAgora: true });
  const { status, json } = await enviar(base, { id: UUID, contato: CONTATO, perfil: EV.PERFIL.enfermeiro, rastreio: RASTREIO });
  assert.equal(status, 200);
  assert.equal(json.profession, "enfermeiro");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(chamadas.length, 1, "só a gravação");
});

test("n8n fora não atrapalha a pessoa: ela recebe 200 e a linha NÃO é marcada (a varredura reenvia)", async () => {
  const { base, chamadas, avisado } = await subir({
    perfilWebhookUrl: PERFIL_WEBHOOK_URL,
    webhookStatus: 503,
    linha: linhaGravada(EV.PERFIL.tecnico),
    // Sem espera entre as tentativas: o teste não pode ficar 13 segundos parado.
    webhookEsperasMs: [0, 0, 0]
  });
  const { status } = await enviar(base, { id: UUID, contato: CONTATO, perfil: EV.PERFIL.tecnico, rastreio: RASTREIO });
  assert.equal(status, 200, "a pessoa não espera pelo n8n");
  await avisado;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(chamadas.filter((c) => c.url === PERFIL_WEBHOOK_URL).length, 3, "três tentativas");
  assert.equal(chamadas.some((c) => c.url.includes("pesquisa_respostas?id=eq.")), false, "não marca como entregue");
});

test("a varredura cobre as DUAS pesquisas e manda cada linha para o endereço dela", async () => {
  const PESQUISA_WEBHOOK_URL = "https://n8n-de-teste.invalid/webhook/pesquisa-icp";
  const chamadas = [];
  const pendentes = [
    linhaGravada(EV.PERFIL.enfermeiro, { id: "44444444-4444-4444-8444-444444444444" }),
    { ...linhaGravada(EV.PERFIL.tecnico, { id: "55555555-5555-4555-8555-555555555555" }), pesquisa: "icp-escola-ev", respostas: { perfil: EV.PERFIL.tecnico } }
  ];
  const fetchImpl = async (url, init = {}) => {
    const endereco = String(url);
    chamadas.push({ url: endereco, corpo: init.body ? JSON.parse(init.body) : null });
    if (endereco.includes("/rest/v1/pesquisa_respostas?") && (init.method || "GET") === "GET") {
      return new Response(JSON.stringify(pendentes), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("", { status: 200 });
  };
  const server = createServerApp({
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_KEY,
    webhookUrl: PESQUISA_WEBHOOK_URL,
    perfilWebhookUrl: PERFIL_WEBHOOK_URL,
    fetchImpl,
    reenvio: { atrasoInicialMs: 60_000, intervaloMs: 60_000 }
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const resultado = await server.reenvio.executar();
  assert.deepEqual(resultado, { pendentes: 2, entregues: 2 });

  const busca = new URL(chamadas[0].url).searchParams;
  assert.equal(busca.get("pesquisa"), "in.(icp-escola-ev,atualizacao-perfil)");

  const paraPerfil = chamadas.filter((c) => c.url === PERFIL_WEBHOOK_URL);
  const paraPesquisa = chamadas.filter((c) => c.url === PESQUISA_WEBHOOK_URL);
  assert.equal(paraPerfil.length, 1);
  assert.equal(paraPesquisa.length, 1);
  assert.equal(paraPerfil[0].corpo.evento, "perfil_atualizado");
  assert.equal(paraPerfil[0].corpo.perfil_codigo, "enfermeiro");
  assert.equal(paraPesquisa[0].corpo.evento, "pesquisa_concluida");
  assert.equal(paraPesquisa[0].corpo.perfil_codigo, "tecnico_enfermagem");
});
