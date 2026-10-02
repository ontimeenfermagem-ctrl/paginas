/*
 * A sala da Imersão GPS (/pagina-de-aula-gps) e os conteúdos que abrem um por dia.
 *
 * Prova que a segunda sala nasce só do config — rota, CSP, gravação com a pesquisa DELA — e que a
 * régua de liberação dos cards é a do horário de Brasília em qualquer fuso. O relógio entra sempre
 * como argumento (`agora`): o config roda num contexto de vm, onde o Date falso do node:test não
 * chega, e data de verdade num teste vira bomba-relógio.
 */
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { afterEach, test } from "node:test";
import vm from "node:vm";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServerApp } from "../server.mjs";

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const contexto = {};
for (const arquivo of ["lead-rules.js", "pesquisa-config.js", "obrigado-config.js", "checkout-config.js", "replay-config.js"]) {
  vm.runInNewContext(readFileSync(path.join(RAIZ, "js", arquivo), "utf8"), contexto);
}
const EV = contexto.EVPesquisa;
const OBR = contexto.EVObrigado;
const CHK = contexto.EVCheckout;
const RPL = contexto.EVReplay;
const GPS = RPL.PAGINAS["aula-gps"];

const SUPABASE_URL = "https://projeto-de-teste.supabase.co";
const SUPABASE_KEY = "chave-service-role-de-teste";
const UUID = "66666666-6666-4666-8666-666666666666";
const CONTATO = { nome: "joana de souza", whatsapp: "(21) 99876-5432", email: "joana@gmail.com" };
const RASTREIO = {
  page_url: "https://lp.escolaenfermagemdevalor.com.br/pagina-de-aula-gps?utm_source=whatsapp",
  referrer: null,
  dispositivo: "mobile",
  utm_source: "whatsapp",
  utm_medium: "grupo",
  utm_campaign: "imersao-gps",
  utm_content: null,
  utm_term: null,
  fbclid: null,
  gclid: null
};

/** Um instante no horário de Brasília (o fuso é -03:00 o ano inteiro desde 2019). */
const em = (iso) => Date.parse(`${iso}-03:00`);

/*
 * A régua de liberação é provada com uma sala DO TESTE: o config de verdade vai receber vídeo,
 * nome, arte e talvez outro cronograma, e nada disso pode deixar o `npm test` vermelho.
 */
const SETE_DIAS = {
  conteudos: {
    itens: ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"].map((dia, i) => ({
      id: `conteudo-${i + 1}`,
      titulo: "",
      imagem: `/img/aula-gps/conteudo-${i + 1}.jpg`,
      liberaEm: `${dia}T00:00:00-03:00`,
      video: { provedor: "youtube", id: "" },
      link: ""
    }))
  }
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

async function subir() {
  const chamadas = [];
  const fetchImpl = async (url, init = {}) => {
    chamadas.push({ url: String(url), corpo: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ ok: true, novo: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const server = createServerApp({
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_KEY,
    fetchImpl,
    resolveEmailDomain: async () => "ok"
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, chamadas };
}

async function pedir(base, caminho, { metodo = "GET", corpo } = {}) {
  return await new Promise((resolve, reject) => {
    const req = httpRequest(
      `${base}${caminho}`,
      { method: metodo, headers: corpo ? { "Content-Type": "application/json" } : {} },
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
          resolve({ status: res.statusCode, headers: res.headers, corpo: texto, json });
        });
      }
    );
    req.on("error", reject);
    req.end(corpo ? JSON.stringify(corpo) : undefined);
  });
}

/* ------------------------------------------------------------------ o contrato de toda sala */

test("toda sala do config está inteira: chave = id, arquivo da rota existe, pesquisa no formato do banco", () => {
  const ids = new Set();
  const rotas = new Set();
  const pesquisas = new Set();
  for (const sala of RPL.LISTA) {
    // O formulário manda `pagina.id`, e o servidor acha a sala pela CHAVE: diferentes = 422 mudo.
    assert.equal(RPL.paginaPorId(sala.id), sala, `${sala.id}: a chave do objeto tem que ser o id`);
    assert.equal(RPL.paginaDaRota(sala.rota), sala);
    assert.equal(RPL.paginaDaRota(`${sala.rota}/`), sala);
    assert.equal(RPL.paginaPorPesquisa(sala.pesquisa), sala);
    assert.match(sala.rota, /^\/[a-z0-9-]+$/, `${sala.id}: rota com barra na frente e sem .html`);
    // A rota serve o arquivo de mesmo nome na raiz: sem ele, a sala é 404.
    assert.ok(existsSync(path.join(RAIZ, `${sala.rota.slice(1)}.html`)), `${sala.rota}.html existe`);
    // replay_comentarios.sala tem CHECK com esta régua: fora dela, comentar dá 502.
    assert.match(sala.pesquisa, /^[a-z0-9_-]{1,60}$/, `${sala.id}: pesquisa no formato do banco`);
    // A aba do painel é `replay-<id>`, e o servidor corta o ?lista= em 60.
    assert.ok(`replay-${sala.id}`.length <= 60, sala.id);
    assert.ok(Object.isFrozen(sala), sala.id);
    ids.add(sala.id);
    rotas.add(sala.rota);
    pesquisas.add(sala.pesquisa);
  }
  assert.equal(ids.size, RPL.LISTA.length, "ids únicos");
  assert.equal(rotas.size, RPL.LISTA.length, "rotas únicas");
  assert.equal(pesquisas.size, RPL.LISTA.length, "pesquisas únicas: cada sala tem a sua aba e o seu mural");

  // Nenhuma rota de sala pisa na de outra página do site.
  const outras = new Set([
    "/pesquisa-icp",
    "/atualizacao-perfil",
    "/painel",
    ...Array.from(OBR.LISTA, (pagina) => pagina.rota),
    ...Array.from(CHK.LISTA, (pagina) => pagina.rota)
  ]);
  for (const rota of rotas) assert.ok(!outras.has(rota), rota);
});

test("a sala do GPS vem depois da aferição, com id, rota e pesquisa próprios", () => {
  // A ordem do config é a ordem das abas do painel: sala nova entra no FIM.
  assert.equal(RPL.LISTA[0].id, "afericao");
  assert.equal(RPL.LISTA[1], GPS);
  assert.equal(GPS.id, "aula-gps");
  assert.equal(GPS.rota, "/pagina-de-aula-gps");
  assert.equal(GPS.pesquisa, "pagina-de-aula-gps");
  // Não confunde com a aba da venda ("Imersão GPS — ingressos").
  assert.notEqual(GPS.nome, CHK.PAGINAS["imersao-gps"].nome);
  assert.deepEqual([...RPL.perfis()], [...EV.perguntaPorId("perfil").opcoes]);
  assert.equal(RPL.ofertaDaPagina(GPS), null, "sem botão de oferta até o cliente mandar o link");
  // O player sem nada do YouTube é desta sala; a aferição continua com o player de sempre.
  assert.equal(GPS.playerLimpo, true);
  assert.notEqual(RPL.PAGINAS.afericao.playerLimpo, true);
  assert.equal(RPL.certificadoVisivel(GPS), false);
  assert.equal(RPL.comentariosAtivos(GPS), true);
});

/* ------------------------------------------------------------------ a página e a gravação */

test("/pagina-de-aula-gps serve a sala, com e sem barra, com a CSP da sala e sem índice", async () => {
  const { base } = await subir();
  for (const rota of ["/pagina-de-aula-gps", "/pagina-de-aula-gps/"]) {
    const { status, headers, corpo } = await pedir(base, rota);
    assert.equal(status, 200, rota);
    assert.match(headers["x-robots-tag"] || "", /noindex/);
    const csp = headers["content-security-policy"];
    assert.doesNotMatch(csp.split("; ").find((parte) => parte.startsWith("script-src")), /unsafe-inline/);
    assert.match(csp, /frame-src https:\/\/www\.youtube-nocookie\.com/);
    assert.match(corpo, /id="form-acesso"/);
    assert.match(corpo, /id="conteudos-lista"/, "o lugar dos cards");
    assert.match(corpo, /id="nav-conteudos"/);
    assert.match(corpo, /js\/replay\.js/);
    // Nenhum script inline: a CSP da sala recusaria.
    assert.doesNotMatch(corpo.replace(/<script>\n!function[\s\S]*?<\/script>/, ""), /<script>(?!<\/script>)/);
    assert.doesNotMatch(corpo, /\son[a-z]+=/i, "nada de onclick= no HTML");
  }
});

test("o formulário da sala do GPS grava o lead com a pesquisa DELA (é o que vira a aba no painel)", async () => {
  const { base, chamadas } = await subir();
  const { status, json } = await pedir(base, "/api/replay/inscricao", {
    metodo: "POST",
    corpo: { id: UUID, visitante_id: null, pagina: GPS.id, contato: CONTATO, perfil: EV.PERFIL.tecnico, rastreio: RASTREIO }
  });
  assert.equal(status, 200);
  assert.equal(json.pagina, "aula-gps");
  assert.equal(json.acesso, true);
  const p = chamadas.find((c) => c.url.includes("/rpc/pesquisa_salvar")).corpo.p;
  assert.equal(p.pesquisa, "pagina-de-aula-gps", "não mistura com a aferição nem com o ICP");
  assert.equal(p.id, UUID);
  assert.equal(p.nome, "Joana de Souza");
  assert.equal(p.perfil, EV.PERFIL.tecnico);
  assert.equal(p.utm_source, "whatsapp");
  assert.equal(p.utm_campaign, "imersao-gps");
  assert.equal(p.finalizou, false, "a sala não dispara aviso ao n8n");
});

/* ------------------------------------------------------------------ os 7 conteúdos do GPS */

test("os 7 conteúdos do GPS estão bem escritos: data com fuso e em ordem, arte do projeto, vídeo e link válidos", () => {
  const itens = GPS.conteudos.itens;
  assert.equal(itens.length, 7);
  assert.equal(new Set(itens.map((item) => item.id)).size, 7, "ids únicos");
  let anterior = -Infinity;
  for (const item of itens) {
    // Sem o fuso escrito o card nunca abre (é o lado seguro da régua): aqui isso vira erro de teste.
    assert.match(item.liberaEm, /T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/, `${item.id}: data com o fuso escrito`);
    const instante = Date.parse(item.liberaEm);
    assert.ok(Number.isFinite(instante), `${item.id}: data de verdade`);
    assert.ok(instante > anterior, `${item.id}: abre depois do anterior`);
    anterior = instante;
    // A arte mora no projeto (o CSP não carrega imagem de fora).
    assert.equal(RPL.imagemValida(item.imagem), true, item.imagem);
    assert.match(item.imagem, /^\/img\/aula-gps\//);
    // Preenchido tem que valer: a URL inteira colada no lugar do id deixaria o card "em breve" para sempre.
    if (item.video && item.video.id) assert.equal(RPL.videoValido(item.video), true, `${item.id}: vídeo`);
    if (item.link) assert.equal(RPL.linkValido(item.link), true, `${item.id}: link`);
  }
});

test("conteudosDaPagina: na véspera nada abre; na virada de Brasília abre o do dia, em qualquer fuso", () => {
  const estados = (agora) => [...RPL.conteudosDaPagina(SETE_DIAS, agora)].map((item) => item.estado);
  // 29/09 às 23:59:59,999 em Brasília: tudo trancado.
  assert.deepEqual(estados(em("2026-09-29T23:59:59.999")), Array(7).fill("trancado"));
  // 30/09 à meia-noite: o primeiro passa da data. Sem vídeo nem link ainda = "chegando".
  assert.deepEqual(estados(em("2026-09-30T00:00:00")), ["chegando", ...Array(6).fill("trancado")]);
  // A conta é de INSTANTE: 03:00 UTC é a meia-noite de Brasília, seja qual for o fuso do aparelho.
  assert.deepEqual(estados(Date.parse("2026-10-02T02:59:59.999Z")), ["chegando", "chegando", ...Array(5).fill("trancado")]);
  assert.deepEqual(estados(Date.parse("2026-10-02T03:00:00.000Z")), ["chegando", "chegando", "chegando", ...Array(4).fill("trancado")]);
  // Do último dia em diante, os 7.
  assert.deepEqual(estados(em("2026-10-06T00:00:00")), Array(7).fill("chegando"));
  assert.deepEqual(estados(em("2026-12-25T12:00:00")), Array(7).fill("chegando"));
});

test("conteudosDaPagina: liberado só com vídeo de provedor conhecido ou link https; o selo Novo dura um dia", () => {
  const pagina = {
    conteudos: {
      itens: [
        { id: "video", titulo: " Primeiro ", imagem: "/img/aula-gps/a.jpg", liberaEm: "2026-10-01T00:00:00-03:00", video: { provedor: "youtube", id: "dQw4w9WgXcQ" } },
        { id: "link", liberaEm: "2026-10-01T00:00:00-03:00", link: "https://drive.google.com/file/d/abc/view" },
        { id: "script", liberaEm: "2026-10-01T00:00:00-03:00", link: "javascript:alert(1)" },
        { id: "provedor-torto", liberaEm: "2026-10-01T00:00:00-03:00", video: { provedor: "outro", id: "abc123" } },
        { id: "futuro", liberaEm: "2026-10-09T00:00:00-03:00", video: { provedor: "youtube", id: "dQw4w9WgXcQ" } }
      ]
    }
  };
  const agora = em("2026-10-01T18:00:00");
  const [video, link, script, torto, futuro] = RPL.conteudosDaPagina(pagina, agora);
  assert.equal(video.estado, "liberado");
  assert.equal(video.novo, true, "liberado há menos de um dia");
  assert.equal(video.titulo, "Primeiro", "o nome vem aparado");
  assert.equal(video.numero, 1);
  assert.equal(video.imagem, "/img/aula-gps/a.jpg");
  assert.equal(link.estado, "liberado");
  assert.equal(link.link, "https://drive.google.com/file/d/abc/view");
  assert.equal(link.video, null);
  assert.equal(script.estado, "chegando", "javascript: nunca vira href");
  assert.equal(script.link, "");
  assert.equal(torto.estado, "chegando");
  assert.equal(torto.video, null);
  assert.equal(futuro.estado, "trancado");
  assert.equal(futuro.video, null, "o que ainda não abriu não leva o vídeo para a página");

  const umDiaDepois = RPL.conteudosDaPagina(pagina, em("2026-10-02T00:00:00"));
  assert.equal(umDiaDepois[0].novo, false, "o selo some depois de 24 horas");

  // Arte de fora do projeto não vira src: o card fica com o número.
  const deFora = { conteudos: { itens: [{ id: "x", imagem: "https://exemplo.com/arte.jpg", liberaEm: "2026-10-01T00:00:00-03:00" }] } };
  assert.equal(RPL.conteudosDaPagina(deFora, agora)[0].imagem, "");
});

test("conteudosDaPagina: data torta ou relógio torto deixam trancado, e nada joga erro", () => {
  const datas = ["", "2026-10-01", "2026-10-01T00:00:00", "01/10/2026", "amanhã", null, 7, "2026-13-45T99:99:99-03:00"];
  const pagina = { conteudos: { itens: datas.map((liberaEm, i) => ({ id: `c${i}`, liberaEm, link: "https://exemplo.com/x" })) } };
  for (const item of RPL.conteudosDaPagina(pagina, em("2030-01-01T00:00:00"))) {
    assert.equal(item.estado, "trancado", `${item.id}: data sem fuso ou inválida não abre`);
  }
  for (const agora of [undefined, null, NaN, "ontem", {}]) {
    for (const item of RPL.conteudosDaPagina(SETE_DIAS, agora)) assert.equal(item.estado, "trancado", String(agora));
  }
  for (const torta of [null, undefined, {}, { conteudos: null }, { conteudos: { itens: "x" } }]) {
    assert.deepEqual([...RPL.conteudosDaPagina(torta, Date.now())], []);
    assert.equal(RPL.proximaLiberacao(torta, Date.now()), null);
  }
  // A sala da aferição não tem conteúdos: a seção some e nada muda nela.
  assert.deepEqual([...RPL.conteudosDaPagina(RPL.PAGINAS.afericao, Date.now())], []);
});

test("proximaLiberacao: o instante do próximo card (é quando a página se redesenha sozinha)", () => {
  assert.equal(RPL.proximaLiberacao(SETE_DIAS, em("2026-09-01T10:00:00")), em("2026-09-30T00:00:00"));
  assert.equal(RPL.proximaLiberacao(SETE_DIAS, em("2026-10-02T15:00:00")), em("2026-10-03T00:00:00"));
  assert.equal(RPL.proximaLiberacao(SETE_DIAS, em("2026-10-03T00:00:00")), em("2026-10-04T00:00:00"), "o que abre agora já não é o próximo");
  assert.equal(RPL.proximaLiberacao(SETE_DIAS, em("2026-10-06T00:00:00")), null, "depois do último, nenhum");
});

test("rotuloDaData: o dia da semana e a data de Brasília; a hora só quando não é meia-noite", () => {
  assert.equal(RPL.rotuloDaData(em("2026-10-03T00:00:00")), "sábado, 03/10");
  assert.equal(RPL.rotuloDaData(em("2026-10-06T00:00:00")), "terça, 06/10");
  assert.equal(RPL.rotuloDaData(em("2026-10-07T20:00:00")), "quarta, 07/10, às 20h");
  assert.equal(RPL.rotuloDaData(em("2026-10-07T19:30:00")), "quarta, 07/10, às 19h30");
  // 02:00 UTC do dia 3 ainda é dia 2 em Brasília.
  assert.equal(RPL.rotuloDaData(Date.parse("2026-10-03T02:00:00Z")), "sexta, 02/10, às 23h");
  assert.equal(RPL.rotuloDaData(NaN), "");
  assert.equal(RPL.rotuloDaData(undefined), "");
});

test("a série dá o nome dos cards ('Aula bônus 3'); item com rótulo próprio (a live) fica fora da contagem", () => {
  const pagina = {
    conteudos: {
      rotulo: " Aula bônus ",
      itens: [
        { id: "a", titulo: "Filtro umidificador", liberaEm: "2026-10-01T20:00:00-03:00" },
        { id: "b", liberaEm: "2026-10-02T20:00:00-03:00" },
        { id: "live", rotulo: "Live principal", titulo: "Ao vivo com Izabel Gonçalves", destaque: true, liberaEm: "2026-10-07T20:00:00-03:00" }
      ]
    }
  };
  const [a, b, live] = RPL.conteudosDaPagina(pagina, em("2026-10-03T10:00:00"));
  assert.equal(a.rotulo, "Aula bônus 1");
  assert.equal(b.rotulo, "Aula bônus 2");
  assert.equal(live.rotulo, "Live principal");
  assert.equal(live.destaque, true);
  assert.equal(a.destaque, false);
  assert.equal(RPL.nomeDoConteudo(a), "Aula bônus 1: Filtro umidificador");
  assert.equal(RPL.nomeDoConteudo(b), "Aula bônus 2");
  assert.equal(RPL.nomeDoConteudo(live), "Live principal: Ao vivo com Izabel Gonçalves");
  // Sem série no config, o nome é "Conteúdo N".
  assert.equal(RPL.conteudosDaPagina(SETE_DIAS, 0)[2].rotulo, "Conteúdo 3");
});

test("rotuloDaLiberacao: contagem regressiva no último dia, 'amanhã' na véspera, o dia no resto", () => {
  const vinte = em("2026-10-02T20:00:00");
  assert.equal(RPL.rotuloDaLiberacao(vinte, em("2026-10-02T18:51:00")), "em 1h 09min");
  assert.equal(RPL.rotuloDaLiberacao(vinte, em("2026-10-02T17:00:00")), "em 3h");
  assert.equal(RPL.rotuloDaLiberacao(vinte, em("2026-10-02T19:15:00")), "em 45min");
  assert.equal(RPL.rotuloDaLiberacao(vinte, em("2026-10-02T19:59:30")), "em instantes");
  // Menos de um dia na frente: a contagem, mesmo que já seja "amanhã" no calendário.
  assert.equal(RPL.rotuloDaLiberacao(em("2026-10-03T20:00:00"), em("2026-10-02T21:00:00")), "em 23h");
  // Mais de um dia, e o dia seguinte no calendário de Brasília: "amanhã".
  assert.equal(RPL.rotuloDaLiberacao(em("2026-10-03T20:00:00"), em("2026-10-02T10:00:00")), "amanhã, às 20h");
  // 25 horas na frente e dois dias no calendário: o dia, sem contagem.
  assert.equal(RPL.rotuloDaLiberacao(em("2026-10-04T00:00:00"), em("2026-10-02T23:00:00")), "domingo, 04/10");
  assert.equal(RPL.rotuloDaLiberacao(em("2026-10-04T20:00:00"), em("2026-10-02T10:00:00")), "domingo, 04/10, às 20h");
  // Relógio torto: o dia, sem contagem. Data torta: nada.
  assert.equal(RPL.rotuloDaLiberacao(vinte, NaN), "sexta, 02/10, às 20h");
  assert.equal(RPL.rotuloDaLiberacao(NaN, em("2026-10-02T10:00:00")), "");
});

test("urlDoVideo { limpo }: o YouTube sem controles, teclado, tela cheia, anotações e legenda dele", () => {
  const youtube = { provedor: "youtube", id: "u7VIU4L28co" };
  const comum = RPL.urlDoVideo(youtube);
  const limpo = RPL.urlDoVideo(youtube, { limpo: true });
  assert.ok(limpo.startsWith(comum), "o mesmo player, com mais regras");
  for (const parametro of ["controls=0", "disablekb=1", "fs=0", "iv_load_policy=3", "cc_load_policy=0"]) {
    assert.ok(limpo.includes(`&${parametro}`), parametro);
    assert.ok(!comum.includes(parametro), `o comum não tem ${parametro}`);
  }
  // Só o YouTube tem player limpo; os outros provedores voltam iguais.
  const vimeo = { provedor: "vimeo", id: "123456789" };
  assert.equal(RPL.urlDoVideo(vimeo, { limpo: true }), RPL.urlDoVideo(vimeo));
  assert.equal(RPL.urlDoVideo({ provedor: "youtube", id: "" }, { limpo: true }), "");
});

test("formato e marca: os Shorts em pé (da lista ou do item), a live deitada, e a marca enquanto a thumb não sobe", () => {
  const pagina = {
    conteudos: {
      formato: "vertical",
      itens: [
        { id: "short", liberaEm: "2026-10-01T20:00:00-03:00" },
        { id: "live", formato: "horizontal", marca: "  07/10  ", liberaEm: "2026-10-07T20:00:00-03:00" },
        { id: "comprida", marca: "uma marca comprida demais para o card", liberaEm: "2026-10-07T20:00:00-03:00" }
      ]
    }
  };
  const [short, live, comprida] = RPL.conteudosDaPagina(pagina, em("2026-10-03T10:00:00"));
  assert.equal(short.vertical, true, "o formato da lista vale para quem não diz o seu");
  assert.equal(live.vertical, false, "o do item ganha do da lista");
  assert.equal(live.marca, "07/10");
  assert.equal(comprida.marca.length, 12, "a marca é curta: é o texto grande do card");
  assert.equal(RPL.conteudosDaPagina({ conteudos: { itens: [{ id: "x" }] } }, 0)[0].vertical, false, "sem formato, deitado");
  // As mini aulas do GPS são Shorts; a live, não.
  const doGps = RPL.conteudosDaPagina(GPS, em("2026-10-03T10:00:00"));
  assert.deepEqual(
    doGps.map((item) => item.vertical),
    doGps.map((item) => !item.destaque)
  );
});

test("nomeDoConteudo e imagemValida", () => {
  assert.equal(RPL.nomeDoConteudo({ numero: 3, titulo: "" }), "Conteúdo 3");
  assert.equal(RPL.nomeDoConteudo({ numero: 3, titulo: "Dispositivos" }), "Conteúdo 3: Dispositivos");
  for (const boa of ["/img/aula-gps/conteudo-1.jpg", "/img/aula-gps/conteudo-1b.webp", "/img/x.PNG", "/img/a/b/c.jpeg"]) {
    assert.equal(RPL.imagemValida(boa), true, boa);
  }
  for (const ruim of [
    "",
    "img/aula-gps/conteudo-1.jpg",
    "/img/../server.mjs",
    "/img/aula-gps/conteudo 1.jpg",
    "/img/aula-gps/conteúdo-1.jpg",
    "/img/aula-gps/conteudo-1.gif",
    "https://drive.google.com/x.jpg",
    "//cdn.exemplo.com/x.jpg",
    "javascript:alert(1)",
    null
  ]) {
    assert.equal(RPL.imagemValida(ruim), false, String(ruim));
  }
});

test("o config dos conteúdos roda num contexto VAZIO (o do servidor: sem window, URL nem Intl de navegador)", () => {
  const vazio = vm.createContext({});
  for (const arquivo of ["lead-rules.js", "pesquisa-config.js", "replay-config.js"]) {
    vm.runInContext(readFileSync(path.join(RAIZ, "js", arquivo), "utf8"), vazio);
  }
  const R = vazio.EVReplay;
  const itens = R.conteudosDaPagina(R.PAGINAS["aula-gps"], em("2026-10-03T08:00:00"));
  assert.equal(itens.length, 7);
  assert.ok(itens.every((item) => Number.isFinite(item.liberaEm)), "as datas do config viram instante também lá");
  assert.equal(R.rotuloDaData(em("2026-10-06T00:00:00")), "terça, 06/10");
});
