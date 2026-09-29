/*
 * A sala de aula (/replay-afericao): a página, o formulário que libera e o config dela.
 *
 * Prova que a inscrição cai na MESMA gravação de todo lead do projeto (pesquisa_salvar), com o id
 * de pesquisa da sala, e que a página vem com a CSP própria — a única do site que deixa um player
 * de fora entrar num iframe.
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
for (const arquivo of ["lead-rules.js", "pesquisa-config.js", "obrigado-config.js", "checkout-config.js", "replay-config.js"]) {
  vm.runInNewContext(readFileSync(path.join(RAIZ, "js", arquivo), "utf8"), contexto);
}
const EV = contexto.EVPesquisa;
const RPL = contexto.EVReplay;
const SALA = RPL.PAGINAS.afericao;

const SUPABASE_URL = "https://projeto-de-teste.supabase.co";
const SUPABASE_KEY = "chave-service-role-de-teste";
const UUID = "55555555-5555-4555-8555-555555555555";

const CONTATO = { nome: "maria da silva", whatsapp: "(11) 91234-5678", email: "maria@gmail.com" };
const RASTREIO = {
  page_url: "https://lp.escolaenfermagemdevalor.com.br/replay-afericao?utm_source=instagram",
  referrer: null,
  dispositivo: "mobile",
  utm_source: "instagram",
  utm_medium: "bio",
  utm_campaign: "replay-afericao",
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

async function subir({ semBanco = false, erroDoBanco = false, dominio = "ok" } = {}) {
  const chamadas = [];
  const fetchImpl = async (url, init = {}) => {
    chamadas.push({ url: String(url), corpo: init.body ? JSON.parse(init.body) : null });
    if (erroDoBanco) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify({ ok: true, novo: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  const server = createServerApp({
    supabaseUrl: semBanco ? "" : SUPABASE_URL,
    supabaseKey: semBanco ? "" : SUPABASE_KEY,
    fetchImpl,
    resolveEmailDomain: async () => dominio
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, chamadas };
}

async function enviar(base, corpo, { tipo = "application/json", metodo = "POST" } = {}) {
  return await new Promise((resolve, reject) => {
    const dados = typeof corpo === "string" ? corpo : JSON.stringify(corpo);
    const req = httpRequest(
      `${base}/api/replay/inscricao`,
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

test("a rota da sala serve a página, com e sem barra, e não é indexada", async () => {
  const { base } = await subir();
  for (const rota of [SALA.rota, `${SALA.rota}/`]) {
    const { status, headers, corpo } = await pegar(base, rota);
    assert.equal(status, 200, rota);
    assert.match(headers["content-type"], /text\/html/);
    assert.match(headers["x-robots-tag"] || "", /noindex/);
    assert.match(corpo, /id="form-acesso"/);
    assert.match(corpo, /js\/replay\.js/);
    assert.match(corpo, /js\/replay-config\.js/);
    // O Pixel é injetado aqui como nas outras páginas públicas.
    assert.match(corpo, /fbq\('init'/);
  }
});

test("a sala é a única página com frame-src: o player entra, e só dos três provedores", async () => {
  const { base } = await subir();
  const sala = await pegar(base, SALA.rota);
  const csp = sala.headers["content-security-policy"];
  assert.match(csp, /frame-src https:\/\/www\.youtube-nocookie\.com/);
  assert.match(csp, /https:\/\/player\.vimeo\.com/);
  assert.match(csp, /https:\/\/\*\.tv\.pandavideo\.com\.br/);
  // As capas do YouTube e do Vimeo, e nada além delas.
  assert.match(csp, /img-src [^;]*https:\/\/i\.ytimg\.com/);
  assert.doesNotMatch(csp, /frame-src[^;]*\*[^.]/, "nada de curinga solto no frame-src");
  assert.match(csp, /frame-ancestors 'none'/);

  // As outras páginas continuam sem frame-src nenhum.
  const pesquisa = await pegar(base, "/pesquisa-icp");
  assert.doesNotMatch(pesquisa.headers["content-security-policy"], /frame-src/);
});

/* ------------------------------------------------------------------ gravação */

for (const [chave, rotulo] of Object.entries(EV.PERFIL)) {
  test(`libera a sala e grava a inscrição com o perfil "${chave}"`, async () => {
    const { base, chamadas } = await subir();
    const { status, json } = await enviar(base, {
      id: UUID,
      visitante_id: null,
      pagina: SALA.id,
      contato: CONTATO,
      perfil: rotulo,
      rastreio: RASTREIO
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.acesso, true);
    assert.equal(json.pagina, SALA.id);
    assert.equal(json.profession, EV.PERFIL_CODIGO[rotulo]);

    const rpc = chamadas.find((c) => c.url.includes("/rpc/pesquisa_salvar"));
    assert.ok(rpc, "gravou pela função da pesquisa, sem tabela nova");
    const p = rpc.corpo.p;
    assert.equal(p.pesquisa, SALA.pesquisa, "id de pesquisa da sala: não mistura com o ICP nem com os perfis");
    assert.equal(p.id, UUID);
    assert.equal(p.perfil, rotulo);
    assert.deepEqual(p.respostas, { perfil: rotulo });
    assert.equal(p.nome, "Maria da Silva", "nome formatado como no resto do projeto");
    assert.equal(p.whatsapp, "(11) 91234-5678");
    assert.equal(p.whatsapp_digits, "11912345678");
    assert.equal(p.email, "maria@gmail.com");
    assert.equal(p.completa, true);
    assert.equal(p.progresso_percentual, 100);
    // A sala não dispara aviso ao n8n: o próximo passo da pessoa é a aula, que abre na hora.
    assert.equal(p.finalizou, false);
    // As UTMs de primeiro toque entram na linha — é o que o painel mostra na coluna de origem.
    assert.equal(p.utm_source, "instagram");
    assert.equal(p.utm_medium, "bio");
    assert.equal(p.utm_campaign, "replay-afericao");
    assert.equal(p.dispositivo, "mobile");
  });
}

test("id ausente não impede a gravação (o servidor gera um)", async () => {
  const { base, chamadas } = await subir();
  const { status } = await enviar(base, { pagina: SALA.id, contato: CONTATO, perfil: EV.PERFIL.tecnico, rastreio: RASTREIO });
  assert.equal(status, 200);
  const p = chamadas.find((c) => c.url.includes("/rpc/pesquisa_salvar")).corpo.p;
  assert.match(p.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

/* ------------------------------------------------------------------ recusas */

test("sala que não existe no config: 422 invalid_page, e nada é gravado", async () => {
  const { base, chamadas } = await subir();
  for (const pagina of ["", "outra-sala", "afericao ", null, 7, "toString"]) {
    const { status, json } = await enviar(base, { pagina, contato: CONTATO, perfil: EV.PERFIL.tecnico, rastreio: RASTREIO });
    assert.equal(status, 422, String(pagina));
    assert.equal(json.error, "invalid_page", String(pagina));
  }
  assert.deepEqual(chamadas, []);
});

test("contato inválido: 422 com a mensagem por campo, e nada é gravado", async () => {
  const { base, chamadas } = await subir();
  const { status, json } = await enviar(base, {
    pagina: SALA.id,
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

test("perfil fora dos quatro: 422 invalid_perfil", async () => {
  const { base, chamadas } = await subir();
  for (const perfil of ["Estudante da área da saúde", "Outro", "", "enfermagem", "toString"]) {
    const { status, json } = await enviar(base, { pagina: SALA.id, contato: CONTATO, perfil, rastreio: RASTREIO });
    assert.equal(status, 422, perfil);
    assert.equal(json.error, "invalid_perfil");
  }
  assert.deepEqual(chamadas, []);
});

test("e-mail de domínio inexistente: 422 com a mensagem de domínio", async () => {
  const { base } = await subir({ dominio: "missing" });
  const { status, json } = await enviar(base, {
    pagina: SALA.id,
    contato: { ...CONTATO, email: "maria@escola-que-nao-existe.com.br" },
    perfil: EV.PERFIL.enfermeiro,
    rastreio: RASTREIO
  });
  assert.equal(status, 422);
  assert.equal(json.campos.email, "Não encontramos esse endereço de e-mail. Confere se está certinho?");
});

test("sem JSON: 415; método errado: 405; sem banco: 503; banco fora: 502", async () => {
  const normal = await subir();
  assert.equal((await enviar(normal.base, "nome=maria", { tipo: "text/plain" })).status, 415);
  assert.equal((await enviar(normal.base, {}, { metodo: "GET" })).status, 405);

  const semBanco = await subir({ semBanco: true });
  const r1 = await enviar(semBanco.base, { pagina: SALA.id, contato: CONTATO, perfil: EV.PERFIL.tecnico, rastreio: RASTREIO });
  assert.equal(r1.status, 503);
  assert.equal(r1.json.error, "database_not_configured");

  const comErro = await subir({ erroDoBanco: true });
  const r2 = await enviar(comErro.base, { pagina: SALA.id, contato: CONTATO, perfil: EV.PERFIL.tecnico, rastreio: RASTREIO });
  assert.equal(r2.status, 502);
  assert.equal(r2.json.error, "database_unavailable");
});

/* ------------------------------------------------------------------ o config da sala */

test("replay-config: a sala está inteira e não colide com as outras pesquisas", () => {
  assert.ok(Object.isFrozen(RPL));
  assert.equal(RPL.paginaDaRota("/replay-afericao").id, "afericao");
  assert.equal(RPL.paginaDaRota("/replay-afericao/").id, "afericao");
  assert.equal(RPL.paginaDaRota("/replay-outra"), null);
  assert.equal(RPL.paginaPorId("afericao").rota, "/replay-afericao");
  assert.equal(RPL.paginaPorId("toString"), null);
  // Cada sala tem id de pesquisa próprio, e nenhum é o das outras gravações do projeto.
  const ids = RPL.LISTA.map((sala) => sala.pesquisa);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok(!["icp-escola-ev", "atualizacao-perfil", "manychat-instagram"].includes(id), id);
  // As quatro profissões da sala são as MESMAS da pergunta 1 da pesquisa.
  assert.deepEqual([...RPL.perfis()], [...EV.perguntaPorId("perfil").opcoes]);
  // A duração que o cliente pediu.
  assert.equal(SALA.aulas.length, 1);
  assert.equal(SALA.aulas[0].duracao, "3 horas");
});

test("replay-config: vídeo só vale de provedor conhecido, e o link do player sai certo", () => {
  assert.equal(RPL.videoValido({ provedor: "youtube", id: "" }), false, "vazio = não configurado");
  assert.equal(RPL.videoValido({ provedor: "youtube", id: "dQw4w9WgXcQ" }), true);
  assert.equal(RPL.videoValido({ provedor: "vimeo", id: "123456789" }), true);
  assert.equal(RPL.videoValido({ provedor: "panda", id: "https://player-vz-abc123.tv.pandavideo.com.br/abc/embed" }), true);
  for (const torto of [
    { provedor: "youtube", id: "javascript:alert(1)" },
    { provedor: "youtube", id: "id com espaço" },
    { provedor: "panda", id: "http://player-vz-abc.tv.pandavideo.com.br/x" },
    { provedor: "panda", id: "https://player-vz-abc.tv.pandavideo.com.br.golpe.com/x" },
    { provedor: "outro", id: "abc123" },
    {},
    null
  ]) {
    assert.equal(RPL.videoValido(torto), false, JSON.stringify(torto));
    assert.equal(RPL.urlDoVideo(torto), "");
  }
  assert.match(RPL.urlDoVideo({ provedor: "youtube", id: "dQw4w9WgXcQ" }), /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/);
  assert.match(RPL.capaDaAula({ video: { provedor: "youtube", id: "dQw4w9WgXcQ" } }), /^https:\/\/i\.ytimg\.com\//);
});

test("replay-config: material e certificado só aparecem com link https de verdade", () => {
  // [...] porque o config roda num contexto de vm: array de outro realm não passa no deepEqual.
  assert.deepEqual([...RPL.materialDaPagina(SALA)], [], "sem link no config, nenhum material é desenhado");
  assert.equal(RPL.certificadoVisivel(SALA), false, "o certificado nasce escondido, como o cliente pediu");

  const comMaterial = {
    material: {
      itens: [
        { id: "ok", link: "https://drive.google.com/file/d/abc/view" },
        { id: "sem-tls", link: "http://drive.google.com/file/d/abc/view" },
        { id: "script", link: "javascript:alert(1)" },
        { id: "vazio", link: "" }
      ]
    }
  };
  assert.deepEqual([...RPL.materialDaPagina(comMaterial).map((item) => item.id)], ["ok"]);
  // Certificado só com as DUAS coisas: ligado e com link.
  assert.equal(RPL.certificadoVisivel({ certificado: { ativo: true, link: "" } }), false);
  assert.equal(RPL.certificadoVisivel({ certificado: { ativo: false, link: "https://forms.gle/abc" } }), false);
  assert.equal(RPL.certificadoVisivel({ certificado: { ativo: true, link: "https://forms.gle/abc" } }), true);
});
