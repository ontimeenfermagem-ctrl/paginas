// Testes das tabelas, views e funções do supabase.sql contra um Postgres 17 + PostgREST de verdade
// (tests/e2e/stack.mjs, via Docker). Tudo é chamado por HTTP, do mesmo jeito que o server.mjs chama
// o Supabase: POST /rest/v1/rpc/<função> e GET /rest/v1/<view>, com apikey + Authorization.
//
//   node --test tests/e2e/sql.e2e.mjs
//
// Os números esperados do painel foram calculados À MÃO a partir do conjunto semeado abaixo (ver
// os comentários de cada bloco) — não pela própria função, senão o teste só provaria que ela
// concorda consigo mesma.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { startStack } from "./stack.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// A mesma configuração que o formulário e o servidor usam: as colunas da planilha e as chaves de
// texto livre precisam bater com ela.
const contexto = {};
vm.runInNewContext(readFileSync(path.join(RAIZ, "js", "pesquisa-config.js"), "utf8"), contexto);
const EV = contexto.EVPesquisa;

let stack;

before(async () => {
  stack = await startStack();
});

after(async () => {
  if (stack) await stack.stop();
});

/* ------------------------------------------------------------------------------------------ */
/* Ajudantes                                                                                   */
/* ------------------------------------------------------------------------------------------ */

async function chamar(metodo, caminho, { corpo, chave = stack.serviceKey, headers = {} } = {}) {
  const resposta = await fetch(`${stack.supabaseUrl}/rest/v1/${caminho}`, {
    method: metodo,
    headers: {
      apikey: chave,
      Authorization: `Bearer ${chave}`,
      ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers
    },
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined
  });
  const texto = await resposta.text();
  let json = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch {
    json = texto;
  }
  return { status: resposta.status, json, headers: resposta.headers };
}

async function rpc(funcao, corpo, opcoes = {}) {
  const r = await chamar("POST", `rpc/${funcao}`, { corpo, ...opcoes });
  return r;
}

async function rpcOk(funcao, corpo) {
  const r = await rpc(funcao, corpo);
  assert.equal(r.status, 200, `${funcao} respondeu ${r.status}: ${JSON.stringify(r.json)}`);
  return r.json;
}

async function registrar(visitante, evento, dados = {}) {
  const r = await rpc("pesquisa_registrar_evento", { p_visitante: visitante, p_evento: evento, p_dados: dados });
  return r;
}

/** Literal SQL seguro para os dados de teste (strings com aspas simples duplicadas). */
function lit(valor) {
  if (valor === null || valor === undefined) return "null";
  if (typeof valor === "number" || typeof valor === "boolean") return String(valor);
  if (typeof valor === "object") return `${lit(JSON.stringify(valor))}::jsonb`;
  return `'${String(valor).replace(/'/g, "''")}'`;
}

async function inserir(tabela, linhas) {
  for (const linha of linhas) {
    const colunas = Object.keys(linha);
    await stack.sql(
      `insert into public.${tabela} (${colunas.join(", ")}) values (${colunas.map((c) => lit(linha[c])).join(", ")}) returning 1 as ok`
    );
  }
}

async function linhaDaTentativa(id) {
  const r = await chamar("GET", `pesquisa_respostas?id=eq.${id}&select=*`);
  assert.equal(r.status, 200);
  return r.json[0];
}

async function visitante(id) {
  const r = await chamar("GET", `pesquisa_visitas?visitante_id=eq.${id}&select=*`);
  assert.equal(r.status, 200);
  return r.json[0];
}

/** Monta o `p` de pesquisa_salvar como o servidor monta, com o mínimo para cada caso. */
function payload(sobrescrever = {}) {
  return {
    id: randomUUID(),
    pesquisa: "icp-escola-ev",
    pesquisa_versao: "1.0",
    visitante_id: randomUUID(),
    seq: 1,
    nome: "Maria da Silva",
    whatsapp: "(11) 91234-5678",
    whatsapp_digits: "11912345678",
    email: "maria@gmail.com",
    perfil: null,
    respostas: {},
    pergunta_atual: "perfil",
    etapa_atual: 1,
    posicao: 1,
    pergunta_posicao: "perfil",
    etapa_posicao: 1,
    respondidas: 0,
    obrigatorias: 30,
    obrigatorias_respondidas: 0,
    total_perguntas: 33,
    progresso_percentual: 0,
    completa: false,
    tempos: { contato: 20 },
    page_url: "https://pesquisa.escolaenfermagemdevalor.com.br/pesquisa?utm_source=instagram",
    referrer: null,
    utm_source: "instagram",
    utm_medium: null,
    utm_campaign: "lancamento",
    utm_content: null,
    utm_term: null,
    fbclid: null,
    gclid: null,
    dispositivo: "mobile",
    ...sobrescrever
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Instalação                                                                                  */
/* ------------------------------------------------------------------------------------------ */

describe("instalação", () => {
  test("o stack imita o Supabase: tabela nova em public nasce com grant para anon", async () => {
    // Sem isto, os testes de segurança abaixo passariam mesmo com um supabase.sql sem revoke.
    const [linha] = await stack.sql(`
      create table public.teste_grant_padrao (id int);
      select has_table_privilege('anon', 'public.teste_grant_padrao', 'select') as anon_le;
    `);
    assert.equal(linha.anon_le, "t");
    await stack.sql("drop table public.teste_grant_padrao");
  });

  test("supabase.sql roda duas vezes seguidas no mesmo banco sem erro e sem perder dados", async () => {
    await stack.reset();
    const p = payload();
    await rpcOk("pesquisa_salvar", { p });
    await registrar(p.visitante_id, "visita", {});

    await stack.aplicarSql(); // segunda execução (a primeira foi no startStack)
    await stack.aplicarSql(); // e uma terceira, para garantir

    const [contagem] = await stack.sql(
      "select (select count(*) from public.pesquisa_respostas) as respostas, (select count(*) from public.pesquisa_visitas) as visitas"
    );
    assert.deepEqual(contagem, { respostas: "1", visitas: "1" });

    // Nada duplicado: uma função de cada, uma view de cada, índices sem cópia.
    const [objetos] = await stack.sql(`
      select
        (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'pesquisa\\_%') as funcoes,
        (select count(*) from pg_views where schemaname = 'public' and viewname like 'pesquisa\\_%') as views,
        (select count(*) from pg_indexes where schemaname = 'public' and tablename like 'pesquisa\\_%') as indices
    `);
    assert.deepEqual(objetos, { funcoes: "6", views: "2", indices: "7" });

    // A view continua respondendo pelo PostgREST depois de recriada (notify pgrst funcionou).
    const r = await chamar("GET", "pesquisa_pessoas?select=id");
    assert.equal(r.status, 200);
    assert.equal(r.json.length, 1);
  });

  test("banco com as funções do painel na assinatura ANTIGA: o arquivo troca por uma só, a nova", async () => {
    // Produção hoje: pesquisa_painel/cruzamento/abertas sem p_status/p_busca. Sem o drop da
    // assinatura antiga, ficariam duas versões e o /rpc do PostgREST ficaria ambíguo.
    await stack.sql(`
      drop function if exists public.pesquisa_painel(timestamptz, timestamptz, text, text[], text, text, text);
      drop function if exists public.pesquisa_cruzamento(text, text, timestamptz, timestamptz, text, text, text, text);
      drop function if exists public.pesquisa_abertas(text[], timestamptz, timestamptz, text, int, int, text, text, text);
      create function public.pesquisa_painel(p_desde timestamptz default null, p_ate timestamptz default null, p_perfil text default null, p_ignorar text[] default '{}')
        returns json language sql as $$ select '{"antiga": true}'::json $$;
      create function public.pesquisa_cruzamento(p_linha text, p_coluna text, p_desde timestamptz default null, p_ate timestamptz default null, p_perfil text default null)
        returns json language sql as $$ select '{"antiga": true}'::json $$;
      create function public.pesquisa_abertas(p_chaves text[], p_desde timestamptz default null, p_ate timestamptz default null, p_perfil text default null, p_limite int default 200, p_offset int default 0)
        returns json language sql as $$ select '{"antiga": true}'::json $$;
      select 1 as ok;
    `);
    await stack.aplicarSql();
    await stack.aplicarSql();
    const assinaturas = await stack.sql(`
      select proname, pg_get_function_identity_arguments(oid) as args
      from pg_proc
      where pronamespace = 'public'::regnamespace and proname in ('pesquisa_painel', 'pesquisa_cruzamento', 'pesquisa_abertas')
      order by proname
    `);
    assert.deepEqual(assinaturas, [
      { proname: "pesquisa_abertas", args: "p_chaves text[], p_desde timestamp with time zone, p_ate timestamp with time zone, p_perfil text, p_limite integer, p_offset integer, p_status text, p_busca text, p_busca_digitos text" },
      { proname: "pesquisa_cruzamento", args: "p_linha text, p_coluna text, p_desde timestamp with time zone, p_ate timestamp with time zone, p_perfil text, p_status text, p_busca text, p_busca_digitos text" },
      { proname: "pesquisa_painel", args: "p_desde timestamp with time zone, p_ate timestamp with time zone, p_perfil text, p_ignorar text[], p_status text, p_busca text, p_busca_digitos text" }
    ]);
    // O PostgREST enxerga a nova (e não a antiga): chamada sem os parâmetros novos continua valendo.
    const r = await rpcOk("pesquisa_painel", {});
    assert.equal(r.antiga, undefined);
    assert.equal(typeof r.visitantes, "number");
    const comNovos = await rpcOk("pesquisa_painel", { p_status: null, p_busca: null, p_busca_digitos: null });
    assert.equal(typeof comNovos.pessoas, "number");
  });

  test("tabelas com RLS ligado e sem política; views security_invoker", async () => {
    const linhas = await stack.sql(`
      select c.relname, c.relrowsecurity::text as rls,
             (select count(*) from pg_policies p where p.tablename = c.relname)::text as politicas
      from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relname in ('pesquisa_visitas', 'pesquisa_respostas')
      order by c.relname
    `);
    assert.deepEqual(linhas, [
      { relname: "pesquisa_respostas", rls: "true", politicas: "0" },
      { relname: "pesquisa_visitas", rls: "true", politicas: "0" }
    ]);
    const views = await stack.sql(`
      select relname, array_to_string(reloptions, ',') as opcoes
      from pg_class where relnamespace = 'public'::regnamespace and relkind = 'v' order by relname
    `);
    assert.deepEqual(views, [
      { relname: "pesquisa_pessoas", opcoes: "security_invoker=true" },
      { relname: "pesquisa_planilha", opcoes: "security_invoker=true" }
    ]);
  });

  test("funções com search_path fixo e security invoker", async () => {
    const linhas = await stack.sql(`
      select proname, prosecdef::text as definer, array_to_string(proconfig, ',') as config
      from pg_proc where pronamespace = 'public'::regnamespace and proname like 'pesquisa\\_%' order by proname
    `);
    assert.equal(linhas.length, 6);
    for (const linha of linhas) {
      assert.equal(linha.definer, "false", linha.proname);
      assert.equal(linha.config, "search_path=public", linha.proname);
    }
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Segurança                                                                                   */
/* ------------------------------------------------------------------------------------------ */

describe("segurança: chave pública não lê nada", () => {
  const TABELAS = ["pesquisa_visitas", "pesquisa_respostas", "pesquisa_pessoas", "pesquisa_planilha"];
  const FUNCOES = {
    pesquisa_registrar_evento: { p_visitante: "00000000-0000-4000-8000-000000000001", p_evento: "visita", p_dados: {} },
    pesquisa_salvar: { p: {} },
    pesquisa_painel: {},
    pesquisa_cruzamento: { p_linha: "perfil", p_coluna: "idade" },
    pesquisa_abertas: { p_chaves: ["sonho"] },
    pesquisa_valores: { v: "x" }
  };

  before(async () => {
    await stack.reset();
    await rpcOk("pesquisa_salvar", { p: payload({ respostas: { sonho: "segredo" } }) });
  });

  for (const papel of ["anon", "authenticated"]) {
    test(`${papel}: tabelas e views negadas (GET, POST, PATCH, DELETE)`, async () => {
      const chave = papel === "anon" ? stack.anonKey : stack.authenticatedKey;
      for (const tabela of TABELAS) {
        const leitura = await chamar("GET", `${tabela}?select=*`, { chave });
        assert.ok([401, 403].includes(leitura.status), `${papel} GET ${tabela} -> ${leitura.status} ${JSON.stringify(leitura.json)}`);
        assert.ok(!Array.isArray(leitura.json), `${papel} leu ${tabela}`);
      }
      const escrita = await chamar("POST", "pesquisa_visitas", { chave, corpo: { visitante_id: randomUUID() } });
      assert.ok([401, 403].includes(escrita.status), `${papel} POST -> ${escrita.status}`);
      const alteracao = await chamar("PATCH", "pesquisa_respostas?nome=neq.x", { chave, corpo: { nome: "hack" } });
      assert.ok([401, 403].includes(alteracao.status), `${papel} PATCH -> ${alteracao.status}`);
      const apagar = await chamar("DELETE", "pesquisa_respostas?nome=neq.x", { chave });
      assert.ok([401, 403].includes(apagar.status), `${papel} DELETE -> ${apagar.status}`);

      const [contagem] = await stack.sql("select count(*) as n, min(nome) as nome from public.pesquisa_respostas");
      assert.deepEqual(contagem, { n: "1", nome: "Maria da Silva" });
      const [visitas] = await stack.sql("select count(*) as n from public.pesquisa_visitas");
      assert.equal(visitas.n, "0");
    });

    test(`${papel}: nenhuma função executa pelo /rpc`, async () => {
      const chave = papel === "anon" ? stack.anonKey : stack.authenticatedKey;
      for (const [funcao, corpo] of Object.entries(FUNCOES)) {
        const r = await rpc(funcao, corpo, { chave });
        assert.ok([401, 403, 404].includes(r.status), `${papel} rpc/${funcao} -> ${r.status} ${JSON.stringify(r.json)}`);
      }
      const [visitas] = await stack.sql("select count(*) as n from public.pesquisa_visitas");
      assert.equal(visitas.n, "0");
    });
  }

  test("sem apikey o gateway recusa", async () => {
    const r = await fetch(`${stack.supabaseUrl}/rest/v1/pesquisa_respostas`);
    assert.equal(r.status, 401);
  });

  test("privilégios no catálogo: só service_role", async () => {
    const [p] = await stack.sql(`
      select
        bool_or(has_table_privilege(papel, 'public.' || objeto, 'select,insert,update,delete,truncate,references,trigger'))::text as tabelas,
        bool_or(has_function_privilege(papel, 'public.pesquisa_salvar(jsonb)', 'execute')
             or has_function_privilege(papel, 'public.pesquisa_registrar_evento(uuid,text,jsonb)', 'execute')
             or has_function_privilege(papel, 'public.pesquisa_painel(timestamptz,timestamptz,text,text[],text,text,text)', 'execute')
             or has_function_privilege(papel, 'public.pesquisa_cruzamento(text,text,timestamptz,timestamptz,text,text,text,text)', 'execute')
             or has_function_privilege(papel, 'public.pesquisa_abertas(text[],timestamptz,timestamptz,text,int,int,text,text,text)', 'execute')
             or has_function_privilege(papel, 'public.pesquisa_valores(jsonb)', 'execute'))::text as funcoes
      from unnest(array['anon', 'authenticated']) as papel,
           unnest(array['pesquisa_visitas', 'pesquisa_respostas', 'pesquisa_pessoas', 'pesquisa_planilha']) as objeto
    `);
    assert.deepEqual(p, { tabelas: "false", funcoes: "false" });

    const [s] = await stack.sql(`
      select has_table_privilege('service_role', 'public.pesquisa_respostas', 'select,insert,update')::text as tabela,
             has_table_privilege('service_role', 'public.pesquisa_planilha', 'select')::text as view,
             has_function_privilege('service_role', 'public.pesquisa_painel(timestamptz,timestamptz,text,text[],text,text,text)', 'execute')::text as funcao
    `);
    assert.deepEqual(s, { tabela: "true", view: "true", funcao: "true" });
  });
});

/* ------------------------------------------------------------------------------------------ */
/* pesquisa_valores                                                                            */
/* ------------------------------------------------------------------------------------------ */

describe("pesquisa_valores", () => {
  test("string, número e booleano viram uma linha; array vira uma por elemento, sem repetir", async () => {
    const valores = async (json) =>
      (await stack.sql(`select public.pesquisa_valores(${lit(json)}::jsonb) as v order by 1`)).map((l) => l.v);
    assert.deepEqual(await valores('"25 a 34 anos"'), ["25 a 34 anos"]);
    assert.deepEqual(await valores("7"), ["7"]);
    assert.deepEqual(await valores("true"), ["true"]);
    assert.deepEqual(await valores('["Hospital", "Clínica", "Hospital", 3, null, {"a": 1}]'), ["3", "Clínica", "Hospital"]);
    assert.deepEqual(await valores("null"), []);
    assert.deepEqual(await valores('{"a": "b"}'), []);
    assert.deepEqual(await valores("[]"), []);
    const [nulo] = await stack.sql("select count(*) as n from public.pesquisa_valores(null)");
    assert.equal(nulo.n, "0");
  });
});

/* ------------------------------------------------------------------------------------------ */
/* pesquisa_registrar_evento                                                                   */
/* ------------------------------------------------------------------------------------------ */

describe("pesquisa_registrar_evento", () => {
  before(() => stack.reset());

  test("visitas somam, 'inicio' não soma visita e comecou_em é pegajoso", async () => {
    const id = randomUUID();
    assert.equal((await registrar(id, "visita", { dispositivo: "mobile" })).status, 204);
    await registrar(id, "visita", {});
    let v = await visitante(id);
    assert.equal(v.visitas, 2);
    assert.equal(v.comecou_em, null);
    assert.equal(v.pesquisa, "icp-escola-ev");

    await registrar(id, "inicio", {});
    v = await visitante(id);
    assert.equal(v.visitas, 2, "clicar em começar não é uma visita nova");
    assert.ok(v.comecou_em);
    const primeiroInicio = v.comecou_em;

    await new Promise((resolve) => setTimeout(resolve, 20));
    await registrar(id, "inicio", {});
    await registrar(id, "visita", {});
    v = await visitante(id);
    assert.equal(v.comecou_em, primeiroInicio, "o primeiro clique vale");
    assert.equal(v.visitas, 3);
    assert.ok(new Date(v.atualizado_em) >= new Date(v.criado_em));
  });

  test("primeiro evento sendo 'inicio' cria o visitante já com comecou_em", async () => {
    const id = randomUUID();
    await registrar(id, "inicio", { utm_source: "instagram" });
    const v = await visitante(id);
    assert.equal(v.visitas, 1);
    assert.ok(v.comecou_em);
    assert.equal(v.utm_source, "instagram");
  });

  test("rastreio de primeiro toque: campanha (utm/fbclid/gclid) é um bloco só; page_url/referrer só preenchem o que faltava; vazio vira null", async () => {
    const id = randomUUID();
    await registrar(id, "visita", {
      utm_source: "instagram",
      utm_medium: "  ",
      utm_campaign: "lancamento",
      page_url: "https://x/pesquisa?utm_source=instagram",
      dispositivo: "mobile"
    });
    let v = await visitante(id);
    assert.equal(v.utm_medium, null, "string em branco não conta como preenchida");

    await registrar(id, "visita", {
      utm_source: "facebook",
      utm_medium: "cpc",
      utm_campaign: "outra",
      utm_content: "anuncio-2",
      fbclid: "abc",
      referrer: "https://l.instagram.com/",
      page_url: "https://x/pesquisa",
      dispositivo: "desktop"
    });
    v = await visitante(id);
    assert.equal(v.utm_source, "instagram");
    assert.equal(v.utm_campaign, "lancamento");
    assert.equal(v.page_url, "https://x/pesquisa?utm_source=instagram");
    assert.equal(v.dispositivo, "mobile");
    // O bloco da primeira visita fica inteiro: nada da campanha do Facebook entra nele.
    assert.equal(v.utm_medium, null);
    assert.equal(v.utm_content, null);
    assert.equal(v.fbclid, null);
    assert.equal(v.referrer, "https://l.instagram.com/");

    // Primeira visita sem campanha nenhuma: o bloco da visita seguinte entra inteiro.
    const outro = randomUUID();
    await registrar(outro, "visita", { page_url: "https://x/pesquisa", dispositivo: "mobile" });
    await registrar(outro, "visita", { utm_source: "facebook", utm_medium: "cpc", fbclid: "fb-2" });
    const w = await visitante(outro);
    assert.equal(w.utm_source, "facebook");
    assert.equal(w.utm_medium, "cpc");
    assert.equal(w.fbclid, "fb-2");
  });

  test("evento inválido falha e não grava nada", async () => {
    const id = randomUUID();
    for (const evento of ["clique", "", null]) {
      const r = await registrar(id, evento, {});
      assert.ok(r.status >= 400 && r.status < 500, `evento ${evento} -> ${r.status}`);
    }
    assert.equal(await visitante(id), undefined);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* pesquisa_salvar                                                                             */
/* ------------------------------------------------------------------------------------------ */

describe("pesquisa_salvar", () => {
  before(() => stack.reset());

  test("fluxo completo de uma tentativa: insert, seq, posição que não regride, conclusão uma vez", async () => {
    const id = randomUUID();

    // 1. Contato aceito.
    let r = await rpcOk("pesquisa_salvar", { p: payload({ id, seq: 1 }) });
    assert.deepEqual(r, { novo: true, aplicado: true, concluiu_agora: false, finalizou_agora: false, status: "em_andamento", linha: null });
    let linha = await linhaDaTentativa(id);
    assert.equal(linha.nome, "Maria da Silva");
    assert.equal(linha.whatsapp, "(11) 91234-5678");
    assert.equal(linha.whatsapp_internacional, "5511912345678");
    assert.equal(linha.email, "maria@gmail.com");
    assert.equal(linha.seq, 1);
    assert.equal(linha.status, "em_andamento");
    assert.equal(linha.posicao_max, 1);
    assert.equal(linha.pergunta_max, "perfil");
    assert.equal(linha.etapa_max, 1);
    assert.equal(linha.concluido_em, null);
    assert.equal(linha.tempo_total_segundos, null);
    assert.equal(linha.utm_source, "instagram");
    assert.equal(linha.pesquisa_versao, "1.0");
    assert.deepEqual(linha.tempos, { contato: 20 });

    // 2. Respondeu até a pergunta 10.
    r = await rpcOk("pesquisa_salvar", {
      p: payload({
        id,
        seq: 5,
        perfil: "Técnico(a) de enfermagem",
        respostas: { perfil: "Técnico(a) de enfermagem", idade: "25 a 34 anos" },
        pergunta_atual: "maior_dificuldade",
        etapa_atual: 3,
        posicao: 10,
        pergunta_posicao: "maior_dificuldade",
        etapa_posicao: 3,
        respondidas: 9,
        obrigatorias_respondidas: 9,
        progresso_percentual: 30,
        tempos: { perfil: 5, idade: 3 },
        utm_source: "facebook",
        utm_medium: "cpc"
      })
    });
    assert.deepEqual(r, { novo: false, aplicado: true, concluiu_agora: false, finalizou_agora: false, status: "em_andamento", linha: null });
    linha = await linhaDaTentativa(id);
    assert.equal(linha.seq, 5);
    assert.equal(linha.perfil, "Técnico(a) de enfermagem");
    assert.equal(linha.posicao_max, 10);
    assert.equal(linha.pergunta_max, "maior_dificuldade");
    assert.equal(linha.etapa_max, 3);
    assert.equal(linha.respondidas, 9);
    assert.equal(linha.progresso_percentual, 30);
    assert.equal(linha.utm_source, "instagram", "primeiro toque");
    assert.equal(linha.utm_medium, null, "campanha é um bloco de primeiro toque: nada da visita nova entra");
    assert.deepEqual(linha.tempos, { contato: 20, perfil: 5, idade: 3 });
    assert.ok(linha.ultima_resposta_em);

    // 3. Salvamento atrasado (seq menor) e repetido (seq igual) são ignorados.
    for (const seq of [4, 5]) {
      r = await rpcOk("pesquisa_salvar", {
        p: payload({ id, seq, nome: "Outro Nome", respostas: {}, posicao: 40, pergunta_posicao: "fim", etapa_posicao: 9, completa: true })
      });
      assert.deepEqual(r, { novo: false, aplicado: false, concluiu_agora: false, finalizou_agora: false, status: "em_andamento", linha: null }, `seq ${seq}`);
    }
    linha = await linhaDaTentativa(id);
    assert.equal(linha.nome, "Maria da Silva");
    assert.equal(linha.seq, 5);
    assert.equal(linha.posicao_max, 10);
    assert.deepEqual(linha.respostas, { perfil: "Técnico(a) de enfermagem", idade: "25 a 34 anos" });

    // 4. Voltou para corrigir a pergunta 2: a tela atual muda, o ponto máximo não.
    r = await rpcOk("pesquisa_salvar", {
      p: payload({
        id,
        seq: 6,
        perfil: "Técnico(a) de enfermagem",
        respostas: { perfil: "Técnico(a) de enfermagem", idade: "35 a 44 anos" },
        pergunta_atual: "idade",
        etapa_atual: 1,
        posicao: 2,
        pergunta_posicao: "idade",
        etapa_posicao: 1,
        respondidas: 9
      })
    });
    assert.equal(r.aplicado, true);
    linha = await linhaDaTentativa(id);
    assert.equal(linha.pergunta_atual, "idade");
    assert.equal(linha.etapa_atual, 1);
    assert.equal(linha.posicao_max, 10);
    assert.equal(linha.pergunta_max, "maior_dificuldade");
    assert.equal(linha.etapa_max, 3);
    assert.equal(linha.respostas.idade, "35 a 44 anos");

    // 5. Conclui. criado_em recuado 5 minutos para medir o tempo total.
    await stack.sql(`update public.pesquisa_respostas set criado_em = now() - interval '300 seconds' where id = '${id}' returning 1 as ok`);
    r = await rpcOk("pesquisa_salvar", {
      p: payload({
        id,
        seq: 30,
        perfil: "Técnico(a) de enfermagem",
        respostas: { perfil: "Técnico(a) de enfermagem", idade: "35 a 44 anos" },
        pergunta_atual: "fim",
        etapa_atual: 9,
        posicao: 40,
        pergunta_posicao: "fim",
        etapa_posicao: 9,
        respondidas: 33,
        obrigatorias_respondidas: 30,
        progresso_percentual: 100,
        completa: true
      })
    });
    assert.deepEqual(r, { novo: false, aplicado: true, concluiu_agora: true, finalizou_agora: false, status: "concluida", linha: null });
    linha = await linhaDaTentativa(id);
    assert.equal(linha.status, "concluida");
    assert.ok(linha.concluido_em);
    assert.ok(linha.tempo_total_segundos >= 299 && linha.tempo_total_segundos <= 330, `tempo ${linha.tempo_total_segundos}`);
    assert.equal(linha.posicao_max, 40);
    assert.equal(linha.pergunta_max, "fim");
    assert.equal(linha.etapa_max, 9);
    const concluidoEm = linha.concluido_em;
    const tempoTotal = linha.tempo_total_segundos;

    // 6. Depois de concluir, trocou uma resposta e a pesquisa deixou de estar "completa" (ex.:
    //    trocou o perfil e surgiram perguntas novas): continua concluída, data e tempo não mudam.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    r = await rpcOk("pesquisa_salvar", {
      p: payload({ id, seq: 31, pergunta_atual: "perfil", posicao: 1, pergunta_posicao: "perfil", etapa_posicao: 1, progresso_percentual: 90, completa: false })
    });
    assert.deepEqual(r, { novo: false, aplicado: true, concluiu_agora: false, finalizou_agora: false, status: "concluida", linha: null });
    // 7. E completou de novo: não é uma nova conclusão.
    r = await rpcOk("pesquisa_salvar", { p: payload({ id, seq: 32, completa: true, posicao: 40, pergunta_posicao: "fim", etapa_posicao: 9 }) });
    assert.deepEqual(r, { novo: false, aplicado: true, concluiu_agora: false, finalizou_agora: false, status: "concluida", linha: null });
    linha = await linhaDaTentativa(id);
    assert.equal(linha.status, "concluida");
    assert.equal(linha.concluido_em, concluidoEm);
    assert.equal(linha.tempo_total_segundos, tempoTotal);
    assert.equal(linha.posicao_max, 40);
    assert.equal(linha.seq, 32);

    // 8. Salvamento velho depois de concluída: não aplica e devolve o status real.
    r = await rpcOk("pesquisa_salvar", { p: payload({ id, seq: 2 }) });
    assert.deepEqual(r, { novo: false, aplicado: false, concluiu_agora: false, finalizou_agora: false, status: "concluida", linha: null });
  });

  test("tentativa que já nasce completa: novo, concluiu_agora e tempo 0", async () => {
    const id = randomUUID();
    const r = await rpcOk("pesquisa_salvar", {
      p: payload({ id, seq: 40, completa: true, posicao: 40, pergunta_posicao: "fim", etapa_posicao: 9, progresso_percentual: 100 })
    });
    assert.deepEqual(r, { novo: true, aplicado: true, concluiu_agora: true, finalizou_agora: false, status: "concluida", linha: null });
    const linha = await linhaDaTentativa(id);
    assert.equal(linha.status, "concluida");
    assert.ok(linha.concluido_em);
    assert.equal(linha.tempo_total_segundos, 0);
    assert.equal(linha.posicao_max, 40);
    assert.equal(linha.pergunta_max, "fim");
    assert.equal(linha.etapa_max, 9);

    // Reenvio do mesmo estado (fila re-tentando): nada acontece.
    const again = await rpcOk("pesquisa_salvar", { p: payload({ id, seq: 40, completa: true }) });
    assert.deepEqual(again, { novo: false, aplicado: false, concluiu_agora: false, finalizou_agora: false, status: "concluida", linha: null });
  });

  test("dois salvamentos simultâneos da mesma tentativa nova: um insere, nada se perde", async () => {
    const id = randomUUID();
    const [a, b] = await Promise.all([
      rpcOk("pesquisa_salvar", { p: payload({ id, seq: 1 }) }),
      rpcOk("pesquisa_salvar", { p: payload({ id, seq: 2, posicao: 3, pergunta_posicao: "estado", etapa_posicao: 1 }) })
    ]);
    assert.equal([a, b].filter((x) => x.novo).length, 1);
    const linha = await linhaDaTentativa(id);
    // Se o seq 2 inseriu primeiro, o seq 1 é descartado; se o seq 1 inseriu, o seq 2 atualiza.
    assert.equal(linha.seq, 2);
    assert.equal(linha.posicao_max, 3);
  });

  test("conclusão simultânea: concluiu_agora sai true uma vez só", async () => {
    const id = randomUUID();
    await rpcOk("pesquisa_salvar", { p: payload({ id, seq: 1 }) });
    const respostas = await Promise.all(
      [2, 3, 4, 5].map((seq) => rpcOk("pesquisa_salvar", { p: payload({ id, seq, completa: true, posicao: 40, pergunta_posicao: "fim", etapa_posicao: 9 }) }))
    );
    assert.equal(respostas.filter((x) => x.concluiu_agora).length, 1);
  });

  test("finalizou: grava finalizado_em uma vez, devolve a linha só na transição e exige completa", async () => {
    const id = randomUUID();
    await rpcOk("pesquisa_salvar", {
      p: payload({ id, seq: 1, utm_source: "instagram", page_url: "https://x/pesquisa-icp?utm_source=instagram" })
    });

    // Tela de fim pedida sem estar completa: não finaliza (a regra também vale no banco).
    let r = await rpcOk("pesquisa_salvar", { p: payload({ id, seq: 2, finalizou: true, completa: false }) });
    assert.equal(r.finalizou_agora, false);
    assert.equal(r.linha, null);
    assert.equal((await linhaDaTentativa(id)).finalizado_em, null);

    // Completa nas abertas (ainda não chegou ao fim): concluída, mas não finalizada.
    r = await rpcOk("pesquisa_salvar", { p: payload({ id, seq: 3, completa: true, posicao: 29, pergunta_posicao: "problema_unico", etapa_posicao: 8 }) });
    assert.equal(r.concluiu_agora, true);
    assert.equal(r.finalizou_agora, false);

    // Chegou ao fim: finalizou_agora e a linha inteira, com o rastreio de PRIMEIRO toque.
    r = await rpcOk("pesquisa_salvar", {
      p: payload({ id, seq: 4, completa: true, finalizou: true, posicao: 40, pergunta_posicao: "fim", etapa_posicao: 9, utm_source: "facebook" })
    });
    assert.equal(r.finalizou_agora, true);
    assert.equal(r.concluiu_agora, false);
    assert.equal(r.linha.id, id);
    assert.equal(r.linha.utm_source, "instagram");
    assert.equal(r.linha.whatsapp_internacional, "55" + r.linha.whatsapp_digits);
    assert.ok(r.linha.finalizado_em);
    assert.equal(r.linha.webhook_enviado_em, null);
    const primeiro = (await linhaDaTentativa(id)).finalizado_em;
    assert.ok(primeiro);

    // De novo no fim (recarregou a página, reenvio): nada de segundo aviso, data não muda.
    r = await rpcOk("pesquisa_salvar", { p: payload({ id, seq: 5, completa: true, finalizou: true, posicao: 40, pergunta_posicao: "fim", etapa_posicao: 9 }) });
    assert.equal(r.finalizou_agora, false);
    assert.equal(r.linha, null);
    // Seq velho com finalizou também não.
    r = await rpcOk("pesquisa_salvar", { p: payload({ id, seq: 5, completa: true, finalizou: true }) });
    assert.equal(r.aplicado, false);
    assert.equal(r.finalizou_agora, false);
    // Voltou e mexeu (sem finalizou): finalizado_em não volta a null.
    await rpcOk("pesquisa_salvar", { p: payload({ id, seq: 6, completa: true, posicao: 3, pergunta_posicao: "estado", etapa_posicao: 1 }) });
    assert.equal((await linhaDaTentativa(id)).finalizado_em, primeiro);

    // A view de pessoas e a planilha expõem as duas colunas novas.
    const pessoa = await chamar("GET", `pesquisa_pessoas?id=eq.${id}&select=finalizado_em,webhook_enviado_em`);
    assert.equal(pessoa.status, 200);
    assert.ok(pessoa.json[0].finalizado_em);
    const planilha = await chamar("GET", `pesquisa_planilha?id=eq.${id}&select=finalizado_em,webhook_enviado_em`);
    assert.equal(planilha.status, 200);
    assert.equal(planilha.json[0].webhook_enviado_em, null);

    // O servidor marca a entrega com PATCH (service_role pode; é o que o server.mjs faz).
    const marca = await chamar("PATCH", `pesquisa_respostas?id=eq.${id}`, {
      corpo: { webhook_enviado_em: "2026-09-21T15:00:00Z" },
      headers: { Prefer: "return=minimal" }
    });
    assert.equal(marca.status, 204);
    assert.ok((await linhaDaTentativa(id)).webhook_enviado_em);
  });

  test("tentativa que já nasce finalizada (rascunho offline que chega todo de uma vez)", async () => {
    const id = randomUUID();
    const r = await rpcOk("pesquisa_salvar", {
      p: payload({ id, seq: 41, completa: true, finalizou: true, posicao: 40, pergunta_posicao: "fim", etapa_posicao: 9 })
    });
    assert.equal(r.novo, true);
    assert.equal(r.concluiu_agora, true);
    assert.equal(r.finalizou_agora, true);
    assert.equal(r.linha.id, id);
    assert.ok(r.linha.finalizado_em);
  });

  test("finalização simultânea: finalizou_agora sai true uma vez só", async () => {
    const id = randomUUID();
    await rpcOk("pesquisa_salvar", { p: payload({ id, seq: 1 }) });
    const respostas = await Promise.all(
      [2, 3, 4, 5].map((seq) =>
        rpcOk("pesquisa_salvar", { p: payload({ id, seq, completa: true, finalizou: true, posicao: 40, pergunta_posicao: "fim", etapa_posicao: 9 }) })
      )
    );
    assert.equal(respostas.filter((x) => x.finalizou_agora).length, 1);
  });
});

describe("separação por pesquisa", () => {
  test("linhas de outra pesquisa (outra página do funil) não entram nos números desta", async () => {
    await stack.reset();
    const id = randomUUID();
    await rpcOk("pesquisa_salvar", { p: payload({ id, seq: 1, pesquisa: "outra-pagina" }) });
    assert.equal((await registrar(randomUUID(), "visita", { pesquisa: "outra-pagina" })).status, 204);
    const painel = await rpcOk("pesquisa_painel", {});
    assert.equal(painel.pessoas, 0);
    assert.equal(painel.tentativas, 0);
    assert.equal(painel.visitantes, 0);
    const abertas = await rpcOk("pesquisa_abertas", { p_chaves: ["sonho"] });
    assert.equal(abertas.total, 0);
    const cruz = await rpcOk("pesquisa_cruzamento", { p_linha: "perfil", p_coluna: "idade" });
    assert.equal(cruz.base, 0);
    await stack.reset();
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Conjunto semeado para view, painel, cruzamento e abertas                                    */
/* ------------------------------------------------------------------------------------------ */

// Visitantes (datas em UTC; Brasília = UTC-3):
//   V1 10/09 12:00Z   3 visitas  começou  instagram / social / lanc / story   mobile
//   V2 10/09 15:00Z   1 visita   começou  instagram / social / lanc / -       mobile
//   V3 11/09 02:30Z   2 visitas  -        - / - / - / -                       desktop  (= 10/09 23:30 em Brasília!)
//   V4 12/09 13:00Z   1 visita   começou  facebook / cpc / lanc / ad1         -
//   V5 12/09 14:00Z   1 visita   começou  "  " / - / - / -                    tablet
const VISITANTES = [
  { visitante_id: "00000000-0000-4000-a000-000000000001", criado_em: "2026-09-10T12:00:00Z", visitas: 3, comecou_em: "2026-09-10T12:01:00Z",
    utm_source: "instagram", utm_medium: "social", utm_campaign: "lanc", utm_content: "story", dispositivo: "mobile" },
  { visitante_id: "00000000-0000-4000-a000-000000000002", criado_em: "2026-09-10T15:00:00Z", visitas: 1, comecou_em: "2026-09-10T15:01:00Z",
    utm_source: "instagram", utm_medium: "social", utm_campaign: "lanc", dispositivo: "mobile" },
  { visitante_id: "00000000-0000-4000-a000-000000000003", criado_em: "2026-09-11T02:30:00Z", visitas: 2, dispositivo: "desktop" },
  { visitante_id: "00000000-0000-4000-a000-000000000004", criado_em: "2026-09-12T13:00:00Z", visitas: 1, comecou_em: "2026-09-12T13:01:00Z",
    utm_source: "facebook", utm_medium: "cpc", utm_campaign: "lanc", utm_content: "ad1" },
  { visitante_id: "00000000-0000-4000-a000-000000000005", criado_em: "2026-09-12T14:00:00Z", visitas: 1, comecou_em: "2026-09-12T14:01:00Z",
    utm_source: "  ", dispositivo: "tablet" }
];

const CUID = "Cuidador(a)";
const TEC = "Técnico(a) de enfermagem";
const ENF = "Enfermeiro(a)";

function tentativa(id, digits, extra) {
  return {
    id,
    pesquisa: "icp-escola-ev",
    pesquisa_versao: "1.0",
    nome: `Pessoa ${digits.slice(-1)}`,
    whatsapp: `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`,
    whatsapp_digits: digits,
    email: `p${digits.slice(-1)}@gmail.com`,
    ...extra
  };
}

// Pessoas (a linha marcada com * é a que a view escolhe):
//   A 11911111111  *A1 10/09 12:05Z concluída (tempo 600, concluída 12:15Z), Cuidador(a), inst/social/lanc/story, mobile
//                   A2 12/09 10:00Z em andamento, posição 5 — perde para A1 por ser não concluída
//   B 11922222222  *B1 10/09 15:10Z em andamento, pos 10 (maior_dificuldade, etapa 3), Técnico, inst/social/lanc/-, mobile
//   C 11933333333  *C1 11/09 02:40Z (10/09 23:40 BRT) concluída 11/09 13:00Z (11/09 BRT), tempo 900, Cuidador(a), sem utm, desktop
//                   C2 11/09 03:00Z em andamento, pos 20, Cuidador(a)
//   D 11944444444  *D1 12/09 13:05Z em andamento, pos 15 (renda_desejada, etapa 4), 12 respondidas, Enfermeiro, fb/cpc/lanc/ad1, sem dispositivo
//                   D2 12/09 13:30Z em andamento, pos 15, 10 respondidas — mais nova, mas com menos respostas
//   E 11955555555  *E1 12/09 14:05Z em andamento, pos 1 (perfil), sem perfil, respostas {}, utm_source "  ", tablet
const ID = {
  A1: "00000000-0000-4000-b000-0000000000a1",
  A2: "00000000-0000-4000-b000-0000000000a2",
  B1: "00000000-0000-4000-b000-0000000000b1",
  C1: "00000000-0000-4000-b000-0000000000c1",
  C2: "00000000-0000-4000-b000-0000000000c2",
  D1: "00000000-0000-4000-b000-0000000000d1",
  D2: "00000000-0000-4000-b000-0000000000d2",
  E1: "00000000-0000-4000-b000-0000000000e1"
};

const TENTATIVAS = [
  tentativa(ID.A1, "11911111111", {
    criado_em: "2026-09-10T12:05:00Z", atualizado_em: "2026-09-10T12:15:00Z", concluido_em: "2026-09-10T12:15:00Z",
    status: "concluida", tempo_total_segundos: 600, perfil: CUID, posicao_max: 40, pergunta_max: "fim", etapa_max: 9, respondidas: 30,
    respostas: { perfil: CUID, idade: "25 a 34 anos", estado: "São Paulo", ambientes: ["Hospital", "UBS / posto de saúde", "Home care"],
      seguranca: 7, problema_unico: "texto A" },
    utm_source: "instagram", utm_medium: "social", utm_campaign: "lanc", utm_content: "story", dispositivo: "mobile",
    visitante_id: VISITANTES[0].visitante_id
  }),
  tentativa(ID.A2, "11911111111", {
    criado_em: "2026-09-12T10:00:00Z", atualizado_em: "2026-09-12T10:05:00Z", status: "em_andamento", perfil: CUID,
    posicao_max: 5, pergunta_max: "tempo_area", etapa_max: 1, respondidas: 4, respostas: { perfil: CUID, idade: "35 a 44 anos" }
  }),
  tentativa(ID.B1, "11922222222", {
    criado_em: "2026-09-10T15:10:00Z", atualizado_em: "2026-09-10T15:20:00Z", status: "em_andamento", perfil: TEC,
    posicao_max: 10, pergunta_max: "maior_dificuldade", etapa_max: 3, respondidas: 9,
    respostas: { perfil: TEC, idade: "25 a 34 anos", estado: "Bahia", ambientes: ["Hospital"], seguranca: 4, problema_unico: "   " },
    utm_source: "instagram", utm_medium: "social", utm_campaign: "lanc", dispositivo: "mobile"
  }),
  tentativa(ID.C1, "11933333333", {
    criado_em: "2026-09-11T02:40:00Z", atualizado_em: "2026-09-11T13:00:00Z", concluido_em: "2026-09-11T13:00:00Z",
    status: "concluida", tempo_total_segundos: 900, perfil: CUID, posicao_max: 40, pergunta_max: "fim", etapa_max: 9, respondidas: 31,
    respostas: { perfil: CUID, idade: "45 a 54 anos", estado: "São Paulo", ambientes: ["Ainda não sei"], seguranca: 8,
      problema_unico: "texto C", sonho: "sonho C" },
    dispositivo: "desktop"
  }),
  tentativa(ID.C2, "11933333333", {
    criado_em: "2026-09-11T03:00:00Z", atualizado_em: "2026-09-11T03:10:00Z", status: "em_andamento", perfil: CUID,
    posicao_max: 20, pergunta_max: "criterio_compra", etapa_max: 5, respondidas: 19, respostas: { perfil: CUID }
  }),
  tentativa(ID.D1, "11944444444", {
    criado_em: "2026-09-12T13:05:00Z", atualizado_em: "2026-09-12T13:20:00Z", status: "em_andamento", perfil: ENF,
    posicao_max: 15, pergunta_max: "renda_desejada", etapa_max: 4, respondidas: 12,
    respostas: { perfil: ENF, idade: "25 a 34 anos", estado: "Minas Gerais", ambientes: ["Clínica", "Hospital"], seguranca: 5 },
    utm_source: "facebook", utm_medium: "cpc", utm_campaign: "lanc", utm_content: "ad1"
  }),
  tentativa(ID.D2, "11944444444", {
    criado_em: "2026-09-12T13:30:00Z", atualizado_em: "2026-09-12T13:45:00Z", status: "em_andamento", perfil: ENF,
    posicao_max: 15, pergunta_max: "renda_desejada", etapa_max: 4, respondidas: 10, respostas: { perfil: ENF, idade: "35 a 44 anos" }
  }),
  tentativa(ID.E1, "11955555555", {
    criado_em: "2026-09-12T14:05:00Z", atualizado_em: "2026-09-12T14:06:00Z", status: "em_andamento",
    posicao_max: 1, pergunta_max: "perfil", etapa_max: 1, respondidas: 0, respostas: {},
    utm_source: "  ", dispositivo: "tablet"
  })
];

async function semear() {
  await stack.reset();
  await inserir("pesquisa_visitas", VISITANTES);
  await inserir("pesquisa_respostas", TENTATIVAS);
}

const IGNORAR = EV.chavesTexto();

describe("view pesquisa_pessoas", () => {
  before(semear);

  test("uma linha por WhatsApp, a tentativa mais avançada, com o número de tentativas", async () => {
    const r = await chamar("GET", "pesquisa_pessoas?select=id,whatsapp_digits,tentativas,status,whatsapp_internacional&order=whatsapp_digits");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, [
      { id: ID.A1, whatsapp_digits: "11911111111", tentativas: 2, status: "concluida", whatsapp_internacional: "5511911111111" },
      { id: ID.B1, whatsapp_digits: "11922222222", tentativas: 1, status: "em_andamento", whatsapp_internacional: "5511922222222" },
      { id: ID.C1, whatsapp_digits: "11933333333", tentativas: 2, status: "concluida", whatsapp_internacional: "5511933333333" },
      { id: ID.D1, whatsapp_digits: "11944444444", tentativas: 2, status: "em_andamento", whatsapp_internacional: "5511944444444" },
      { id: ID.E1, whatsapp_digits: "11955555555", tentativas: 1, status: "em_andamento", whatsapp_internacional: "5511955555555" }
    ]);
  });

  test("desempate por atualizado_em quando posição e respostas empatam", async () => {
    await stack.sql(`update public.pesquisa_respostas set respondidas = 12 where id = '${ID.D2}' returning 1 as ok`);
    const r = await chamar("GET", "pesquisa_pessoas?select=id&whatsapp_digits=eq.11944444444");
    assert.deepEqual(r.json, [{ id: ID.D2 }]);
    await stack.sql(`update public.pesquisa_respostas set respondidas = 10 where id = '${ID.D2}' returning 1 as ok`);
  });

  test("tem todas as colunas da tabela + tentativas, e aceita os filtros que o servidor usa", async () => {
    const colunasTabela = (await stack.sql(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'pesquisa_respostas' order by ordinal_position"
    )).map((l) => l.column_name);
    const colunasView = (await stack.sql(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'pesquisa_pessoas' order by ordinal_position"
    )).map((l) => l.column_name);
    assert.deepEqual(colunasView, [...colunasTabela, "tentativas"]);

    // Exatamente a consulta da lista do painel (seção 5.3 da SPEC).
    const r = await chamar(
      "GET",
      "pesquisa_pessoas?select=*&status=eq.em_andamento&or=(nome.ilike.*pessoa*,email.ilike.*pessoa*,whatsapp_digits.ilike.*119*)&order=criado_em.desc,id.desc&limit=2&offset=0",
      { headers: { Prefer: "count=exact" } }
    );
    assert.equal(r.status, 206);
    assert.equal(r.headers.get("content-range"), "0-1/3");
    assert.deepEqual(r.json.map((l) => l.id), [ID.E1, ID.D1]);
  });
});

describe("pesquisa_painel", () => {
  before(semear);

  test("banco vazio: zeros, null e listas vazias (nunca null)", async () => {
    await stack.reset();
    const r = await rpcOk("pesquisa_painel", { p_ignorar: IGNORAR });
    assert.deepEqual(r, {
      desde: null, ate: null, perfil: null,
      visitantes: 0, visitas: 0, comecaram: 0,
      pessoas: 0, tentativas: 0, concluidas: 0, com_perfil: 0,
      tempo_mediano_segundos: null,
      por_etapa: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((etapa) => ({ etapa, chegaram: 0 })),
      pararam_em: [], perfis: [], distribuicoes: [], responderam: [], escalas: [], por_dia: [], trafego: []
    });
    await semear();
  });

  test("período inteiro: todos os campos, calculados à mão", async () => {
    const r = await rpcOk("pesquisa_painel", { p_ignorar: IGNORAR });
    assert.deepEqual(r, {
      desde: null,
      ate: null,
      perfil: null,
      visitantes: 5,
      visitas: 8, // 3 + 1 + 2 + 1 + 1
      comecaram: 4, // todos menos V3
      pessoas: 5,
      tentativas: 8,
      concluidas: 2, // A e C
      com_perfil: 4, // E ainda não respondeu o perfil
      tempo_mediano_segundos: 750, // mediana de 600 e 900
      // A e C concluídas contam em todas; B chegou à 3; D à 4; E à 1.
      por_etapa: [
        { etapa: 1, chegaram: 5 },
        { etapa: 2, chegaram: 4 },
        { etapa: 3, chegaram: 4 },
        { etapa: 4, chegaram: 3 },
        { etapa: 5, chegaram: 2 },
        { etapa: 6, chegaram: 2 },
        { etapa: 7, chegaram: 2 },
        { etapa: 8, chegaram: 2 },
        { etapa: 9, chegaram: 2 }
      ],
      // Em ordem de questionário: pergunta 1, 10, 15.
      pararam_em: [
        { pergunta: "perfil", total: 1 },
        { pergunta: "maior_dificuldade", total: 1 },
        { pergunta: "renda_desejada", total: 1 }
      ],
      perfis: [
        { perfil: CUID, total: 2, concluidas: 2 },
        { perfil: ENF, total: 1, concluidas: 0 },
        { perfil: TEC, total: 1, concluidas: 0 },
        { perfil: null, total: 1, concluidas: 0 }
      ],
      // Sem problema_unico e sonho (texto livre, ignorados). A2, C2 e D2 não
      // entram: a view escolheu A1, C1 e D1.
      distribuicoes: [
        { perfil: CUID, chave: "ambientes", valor: "Ainda não sei", total: 1 },
        { perfil: CUID, chave: "ambientes", valor: "Home care", total: 1 },
        { perfil: CUID, chave: "ambientes", valor: "Hospital", total: 1 },
        { perfil: CUID, chave: "ambientes", valor: "UBS / posto de saúde", total: 1 },
        { perfil: CUID, chave: "estado", valor: "São Paulo", total: 2 },
        { perfil: CUID, chave: "idade", valor: "25 a 34 anos", total: 1 },
        { perfil: CUID, chave: "idade", valor: "45 a 54 anos", total: 1 },
        { perfil: CUID, chave: "perfil", valor: CUID, total: 2 },
        { perfil: CUID, chave: "seguranca", valor: "7", total: 1 },
        { perfil: CUID, chave: "seguranca", valor: "8", total: 1 },
        { perfil: ENF, chave: "ambientes", valor: "Clínica", total: 1 },
        { perfil: ENF, chave: "ambientes", valor: "Hospital", total: 1 },
        { perfil: ENF, chave: "estado", valor: "Minas Gerais", total: 1 },
        { perfil: ENF, chave: "idade", valor: "25 a 34 anos", total: 1 },
        { perfil: ENF, chave: "perfil", valor: ENF, total: 1 },
        { perfil: ENF, chave: "seguranca", valor: "5", total: 1 },
        { perfil: TEC, chave: "ambientes", valor: "Hospital", total: 1 },
        { perfil: TEC, chave: "estado", valor: "Bahia", total: 1 },
        { perfil: TEC, chave: "idade", valor: "25 a 34 anos", total: 1 },
        { perfil: TEC, chave: "perfil", valor: TEC, total: 1 },
        { perfil: TEC, chave: "seguranca", valor: "4", total: 1 }
      ],
      responderam: [
        { perfil: CUID, chave: "ambientes", total: 2 },
        { perfil: CUID, chave: "estado", total: 2 },
        { perfil: CUID, chave: "idade", total: 2 },
        { perfil: CUID, chave: "perfil", total: 2 },
        { perfil: CUID, chave: "seguranca", total: 2 },
        { perfil: ENF, chave: "ambientes", total: 1 },
        { perfil: ENF, chave: "estado", total: 1 },
        { perfil: ENF, chave: "idade", total: 1 },
        { perfil: ENF, chave: "perfil", total: 1 },
        { perfil: ENF, chave: "seguranca", total: 1 },
        { perfil: TEC, chave: "ambientes", total: 1 },
        { perfil: TEC, chave: "estado", total: 1 },
        { perfil: TEC, chave: "idade", total: 1 },
        { perfil: TEC, chave: "perfil", total: 1 },
        { perfil: TEC, chave: "seguranca", total: 1 }
      ],
      escalas: [
        { perfil: CUID, chave: "seguranca", media: 7.5, total: 2 },
        { perfil: ENF, chave: "seguranca", media: 5, total: 1 },
        { perfil: TEC, chave: "seguranca", media: 4, total: 1 }
      ],
      // Em Brasília: V3 (02:30Z do dia 11) e C1 (02:40Z do dia 11) são do dia 10. Nenhum
      // visitante ou pessoa no dia 11; só a conclusão de C1 (13:00Z).
      por_dia: [
        { dia: "2026-09-10", visitantes: 3, pessoas: 3, concluidas: 1 },
        { dia: "2026-09-11", visitantes: 0, pessoas: 0, concluidas: 1 },
        { dia: "2026-09-12", visitantes: 2, pessoas: 2, concluidas: 0 }
      ],
      trafego: [
        { campo: "utm_source", valor: "(sem utm)", visitantes: 2, pessoas: 2, concluidas: 1 },
        { campo: "utm_source", valor: "instagram", visitantes: 2, pessoas: 2, concluidas: 1 },
        { campo: "utm_source", valor: "facebook", visitantes: 1, pessoas: 1, concluidas: 0 },
        { campo: "utm_medium", valor: "(sem utm)", visitantes: 2, pessoas: 2, concluidas: 1 },
        { campo: "utm_medium", valor: "social", visitantes: 2, pessoas: 2, concluidas: 1 },
        { campo: "utm_medium", valor: "cpc", visitantes: 1, pessoas: 1, concluidas: 0 },
        { campo: "utm_campaign", valor: "lanc", visitantes: 3, pessoas: 3, concluidas: 1 },
        { campo: "utm_campaign", valor: "(sem utm)", visitantes: 2, pessoas: 2, concluidas: 1 },
        { campo: "utm_content", valor: "(sem utm)", visitantes: 3, pessoas: 3, concluidas: 1 },
        { campo: "utm_content", valor: "ad1", visitantes: 1, pessoas: 1, concluidas: 0 },
        { campo: "utm_content", valor: "story", visitantes: 1, pessoas: 1, concluidas: 1 },
        { campo: "dispositivo", valor: "mobile", visitantes: 2, pessoas: 2, concluidas: 1 },
        { campo: "dispositivo", valor: "(desconhecido)", visitantes: 1, pessoas: 1, concluidas: 0 },
        { campo: "dispositivo", valor: "desktop", visitantes: 1, pessoas: 1, concluidas: 1 },
        { campo: "dispositivo", valor: "tablet", visitantes: 1, pessoas: 1, concluidas: 0 }
      ]
    });
  });

  test("p_ignorar vazio: as chaves de texto entram na contagem", async () => {
    const r = await rpcOk("pesquisa_painel", {});
    const problema = r.responderam.filter((x) => x.chave === "problema_unico");
    // A1 e C1 (Cuidador), e B1 ("   " ainda é uma chave presente — o servidor nunca grava assim).
    assert.deepEqual(problema, [
      { perfil: CUID, chave: "problema_unico", total: 2 },
      { perfil: TEC, chave: "problema_unico", total: 1 }
    ]);
    assert.ok(r.distribuicoes.some((x) => x.chave === "problema_unico" && x.valor === "texto A"));
    assert.ok(r.distribuicoes.some((x) => x.chave === "sonho" && x.valor === "sonho C"));
  });

  test("filtro de perfil: pessoas e tentativas filtram; visitantes não", async () => {
    const r = await rpcOk("pesquisa_painel", { p_perfil: CUID, p_ignorar: IGNORAR });
    assert.equal(r.perfil, CUID);
    assert.equal(r.visitantes, 5);
    assert.equal(r.visitas, 8);
    assert.equal(r.comecaram, 4);
    assert.equal(r.pessoas, 2);
    assert.equal(r.tentativas, 4); // A1, A2, C1, C2
    assert.equal(r.concluidas, 2);
    assert.equal(r.com_perfil, 2);
    assert.equal(r.tempo_mediano_segundos, 750);
    assert.deepEqual(r.por_etapa.map((x) => x.chegaram), [2, 2, 2, 2, 2, 2, 2, 2, 2]);
    assert.deepEqual(r.pararam_em, []);
    assert.deepEqual(r.perfis, [{ perfil: CUID, total: 2, concluidas: 2 }]);
    assert.ok(r.distribuicoes.every((x) => x.perfil === CUID));
    assert.equal(r.distribuicoes.length, 10);
    assert.deepEqual(r.escalas, [{ perfil: CUID, chave: "seguranca", media: 7.5, total: 2 }]);
    assert.deepEqual(r.por_dia, [
      { dia: "2026-09-10", visitantes: 3, pessoas: 2, concluidas: 1 },
      { dia: "2026-09-11", visitantes: 0, pessoas: 0, concluidas: 1 },
      { dia: "2026-09-12", visitantes: 2, pessoas: 0, concluidas: 0 }
    ]);
    const fonte = r.trafego.filter((x) => x.campo === "utm_source");
    assert.deepEqual(fonte, [
      { campo: "utm_source", valor: "(sem utm)", visitantes: 2, pessoas: 1, concluidas: 1 },
      { campo: "utm_source", valor: "instagram", visitantes: 2, pessoas: 1, concluidas: 1 },
      { campo: "utm_source", valor: "facebook", visitantes: 1, pessoas: 0, concluidas: 0 }
    ]);
  });

  test("filtro de situação: pessoas, tentativas (linhas cruas), funil e tráfego filtram; visitantes não", async () => {
    const conc = await rpcOk("pesquisa_painel", { p_status: "concluida", p_ignorar: IGNORAR });
    assert.equal(conc.visitantes, 5);
    assert.equal(conc.visitas, 8);
    assert.equal(conc.comecaram, 4);
    assert.equal(conc.pessoas, 2); // A1, C1
    assert.equal(conc.tentativas, 2); // só as linhas concluídas: A1, C1
    assert.equal(conc.concluidas, 2);
    assert.equal(conc.tempo_mediano_segundos, 750);
    assert.deepEqual(conc.pararam_em, []);
    assert.deepEqual(conc.perfis, [{ perfil: CUID, total: 2, concluidas: 2 }]);
    // A coluna de visitantes do por_dia e do tráfego continua sem filtro.
    assert.deepEqual(conc.por_dia, [
      { dia: "2026-09-10", visitantes: 3, pessoas: 2, concluidas: 1 },
      { dia: "2026-09-11", visitantes: 0, pessoas: 0, concluidas: 1 },
      { dia: "2026-09-12", visitantes: 2, pessoas: 0, concluidas: 0 }
    ]);
    assert.deepEqual(conc.trafego.filter((x) => x.campo === "utm_source"), [
      { campo: "utm_source", valor: "(sem utm)", visitantes: 2, pessoas: 1, concluidas: 1 },
      { campo: "utm_source", valor: "instagram", visitantes: 2, pessoas: 1, concluidas: 1 },
      { campo: "utm_source", valor: "facebook", visitantes: 1, pessoas: 0, concluidas: 0 }
    ]);

    const and = await rpcOk("pesquisa_painel", { p_status: "em_andamento", p_ignorar: IGNORAR });
    assert.equal(and.visitantes, 5);
    assert.equal(and.pessoas, 3); // B1, D1, E1
    assert.equal(and.tentativas, 6); // A2, B1, C2, D1, D2, E1
    assert.equal(and.concluidas, 0);
    assert.equal(and.tempo_mediano_segundos, null);
    assert.deepEqual(and.por_etapa.map((x) => x.chegaram), [3, 2, 2, 1, 0, 0, 0, 0, 0]);
    assert.deepEqual(and.pararam_em, [
      { pergunta: "perfil", total: 1 },
      { pergunta: "maior_dificuldade", total: 1 },
      { pergunta: "renda_desejada", total: 1 }
    ]);
  });

  test("busca por nome, e-mail e dígitos do WhatsApp; sem curinga; tentativas também filtram", async () => {
    const semFiltro = await rpcOk("pesquisa_painel", { p_status: null, p_busca: "", p_busca_digitos: "", p_ignorar: IGNORAR });
    assert.equal(semFiltro.pessoas, 5);
    assert.equal(semFiltro.tentativas, 8);

    // Nome, sem diferenciar maiúsculas: "PESSOA 4" = D (D1 na view; D1 e D2 como tentativas).
    const nome = await rpcOk("pesquisa_painel", { p_busca: "PESSOA 4", p_ignorar: IGNORAR });
    assert.equal(nome.visitantes, 5);
    assert.equal(nome.comecaram, 4);
    assert.equal(nome.pessoas, 1);
    assert.equal(nome.tentativas, 2);
    assert.deepEqual(nome.perfis, [{ perfil: ENF, total: 1, concluidas: 0 }]);
    assert.deepEqual(nome.trafego.filter((x) => x.campo === "utm_source" && x.pessoas > 0), [
      { campo: "utm_source", valor: "facebook", visitantes: 1, pessoas: 1, concluidas: 0 }
    ]);

    // E-mail: C (C1 e C2).
    const email = await rpcOk("pesquisa_painel", { p_busca: "p3@gmail", p_ignorar: IGNORAR });
    assert.equal(email.pessoas, 1);
    assert.equal(email.tentativas, 2);
    assert.equal(email.concluidas, 1);

    // Dígitos: só quando o servidor manda p_busca_digitos.
    const digitos = await rpcOk("pesquisa_painel", { p_busca: "(11) 9222", p_busca_digitos: "119222", p_ignorar: IGNORAR });
    assert.equal(digitos.pessoas, 1); // B
    assert.equal(digitos.tentativas, 1);
    const semDigitos = await rpcOk("pesquisa_painel", { p_busca: "9222", p_ignorar: IGNORAR });
    assert.equal(semDigitos.pessoas, 0, "sem p_busca_digitos o telefone não entra");

    // % e _ são texto, não curinga (strpos, não LIKE).
    for (const curinga of ["%", "_", "p_@", "Pessoa%"]) {
      const r = await rpcOk("pesquisa_painel", { p_busca: curinga, p_ignorar: IGNORAR });
      assert.equal(r.pessoas, 0, curinga);
      assert.equal(r.tentativas, 0, curinga);
      assert.equal(r.visitantes, 5, curinga);
    }

    // Situação + busca: a pessoa A está concluída na view (A1), mas A2 é uma tentativa em
    // andamento com o mesmo nome — a tentativa crua conta, a pessoa não.
    const ambos = await rpcOk("pesquisa_painel", { p_status: "em_andamento", p_busca: "pessoa 1", p_ignorar: IGNORAR });
    assert.equal(ambos.pessoas, 0);
    assert.equal(ambos.tentativas, 1);

    // Perfil + busca.
    const perfil = await rpcOk("pesquisa_painel", { p_perfil: CUID, p_busca: "pessoa", p_ignorar: IGNORAR });
    assert.equal(perfil.pessoas, 2);
    assert.equal(perfil.tentativas, 4);
  });

  test("filtro de período: desde inclusivo, até exclusivo, sobre a linha escolhida pela view", async () => {
    // Dia 10/09 inteiro em Brasília = [10/09 03:00Z, 11/09 03:00Z).
    const dia10 = await rpcOk("pesquisa_painel", {
      p_desde: "2026-09-10T03:00:00Z", p_ate: "2026-09-11T03:00:00Z", p_ignorar: IGNORAR
    });
    assert.equal(dia10.desde, "2026-09-10T03:00:00+00:00");
    assert.equal(dia10.ate, "2026-09-11T03:00:00+00:00");
    assert.equal(dia10.visitantes, 3); // V1, V2, V3
    assert.equal(dia10.visitas, 6);
    assert.equal(dia10.comecaram, 2);
    assert.equal(dia10.pessoas, 3); // A1, B1, C1
    assert.equal(dia10.tentativas, 3); // C2 é 11/09 03:00Z exato: fica de fora (até é exclusivo)
    assert.equal(dia10.concluidas, 2);
    assert.deepEqual(dia10.por_dia, [
      { dia: "2026-09-10", visitantes: 3, pessoas: 3, concluidas: 1 },
      { dia: "2026-09-11", visitantes: 0, pessoas: 0, concluidas: 1 }
    ]);

    // A partir de 12/09 00:00 em Brasília.
    const dia12 = await rpcOk("pesquisa_painel", { p_desde: "2026-09-12T03:00:00Z", p_ignorar: IGNORAR });
    assert.equal(dia12.visitantes, 2);
    assert.equal(dia12.pessoas, 2); // D1 e E1 — A2 é de 12/09, mas a pessoa A é representada por A1 (10/09)
    assert.equal(dia12.tentativas, 4); // A2, D1, D2, E1 — tentativas não deduplicam
    assert.equal(dia12.concluidas, 0);
    assert.equal(dia12.tempo_mediano_segundos, null);
    assert.deepEqual(dia12.pararam_em, [
      { pergunta: "perfil", total: 1 },
      { pergunta: "renda_desejada", total: 1 }
    ]);
  });
});

describe("pesquisa_cruzamento", () => {
  before(semear);

  test("perfil x ambientes (múltipla): células, linhas e colunas contam pessoas", async () => {
    const r = await rpcOk("pesquisa_cruzamento", { p_linha: "perfil", p_coluna: "ambientes" });
    assert.deepEqual(r, {
      linha: "perfil",
      coluna: "ambientes",
      base: 4, // A, B, C, D (E não respondeu nenhuma das duas)
      celulas: [
        { linha: CUID, coluna: "Ainda não sei", total: 1 },
        { linha: CUID, coluna: "Home care", total: 1 },
        { linha: CUID, coluna: "Hospital", total: 1 },
        { linha: CUID, coluna: "UBS / posto de saúde", total: 1 },
        { linha: ENF, coluna: "Clínica", total: 1 },
        { linha: ENF, coluna: "Hospital", total: 1 },
        { linha: TEC, coluna: "Hospital", total: 1 }
      ],
      linhas: [
        { valor: CUID, total: 2 },
        { valor: ENF, total: 1 },
        { valor: TEC, total: 1 }
      ],
      colunas: [
        { valor: "Hospital", total: 3 },
        { valor: "Ainda não sei", total: 1 },
        { valor: "Clínica", total: 1 },
        { valor: "Home care", total: 1 },
        { valor: "UBS / posto de saúde", total: 1 }
      ]
    });
  });

  test("ambientes x idade: a linha conta a pessoa uma vez, mesmo com várias colunas", async () => {
    const r = await rpcOk("pesquisa_cruzamento", { p_linha: "ambientes", p_coluna: "idade" });
    assert.equal(r.base, 4);
    assert.deepEqual(r.colunas, [
      { valor: "25 a 34 anos", total: 3 },
      { valor: "45 a 54 anos", total: 1 }
    ]);
    assert.deepEqual(r.linhas.find((l) => l.valor === "Hospital"), { valor: "Hospital", total: 3 });
    assert.deepEqual(
      r.celulas.filter((c) => c.linha === "Hospital"),
      [{ linha: "Hospital", coluna: "25 a 34 anos", total: 3 }]
    );
  });

  test("escala vira texto e o filtro de perfil e período vale", async () => {
    const r = await rpcOk("pesquisa_cruzamento", { p_linha: "idade", p_coluna: "seguranca", p_perfil: CUID });
    assert.equal(r.base, 2);
    assert.deepEqual(r.celulas, [
      { linha: "25 a 34 anos", coluna: "7", total: 1 },
      { linha: "45 a 54 anos", coluna: "8", total: 1 }
    ]);
    const vazio = await rpcOk("pesquisa_cruzamento", { p_linha: "perfil", p_coluna: "idade", p_desde: "2030-01-01T00:00:00Z" });
    assert.deepEqual(vazio, { linha: "perfil", coluna: "idade", base: 0, celulas: [], linhas: [], colunas: [] });
    const periodo = await rpcOk("pesquisa_cruzamento", {
      p_linha: "perfil", p_coluna: "idade", p_desde: "2026-09-12T03:00:00Z", p_ate: "2026-09-13T03:00:00Z"
    });
    assert.equal(periodo.base, 1); // D1 (E1 não tem perfil)
  });
});

describe("pesquisa_cruzamento: situação e busca", () => {
  before(semear);

  test("p_status e p_busca mudam a base e as células", async () => {
    const todos = await rpcOk("pesquisa_cruzamento", { p_linha: "perfil", p_coluna: "idade" });
    assert.equal(todos.base, 4); // A1, B1, C1, D1 (E1 sem perfil)

    const andamento = await rpcOk("pesquisa_cruzamento", { p_linha: "perfil", p_coluna: "idade", p_status: "em_andamento" });
    assert.equal(andamento.base, 2); // B1, D1
    assert.deepEqual(andamento.celulas, [
      { linha: ENF, coluna: "25 a 34 anos", total: 1 },
      { linha: TEC, coluna: "25 a 34 anos", total: 1 }
    ]);

    const email = await rpcOk("pesquisa_cruzamento", { p_linha: "perfil", p_coluna: "idade", p_busca: "P1@GMAIL.COM" });
    assert.deepEqual(email.celulas, [{ linha: CUID, coluna: "25 a 34 anos", total: 1 }]);

    const tel = await rpcOk("pesquisa_cruzamento", { p_linha: "perfil", p_coluna: "idade", p_busca: "11944", p_busca_digitos: "11944" });
    assert.equal(tel.base, 1);
    assert.equal(tel.celulas[0].linha, ENF);

    const curinga = await rpcOk("pesquisa_cruzamento", { p_linha: "perfil", p_coluna: "idade", p_busca: "%" });
    assert.equal(curinga.base, 0);
  });
});

describe("pesquisa_abertas", () => {
  before(semear);

  test("p_status e p_busca filtram (total e itens)", async () => {
    const chaves = ["problema_unico", "sonho"];
    const conc = await rpcOk("pesquisa_abertas", { p_chaves: chaves, p_status: "concluida" });
    assert.equal(conc.total, 2);
    const and = await rpcOk("pesquisa_abertas", { p_chaves: chaves, p_status: "em_andamento" });
    assert.deepEqual(and, { total: 0, itens: [] });
    const nome = await rpcOk("pesquisa_abertas", { p_chaves: chaves, p_busca: "pessoa 3" });
    assert.deepEqual(nome.itens.map((i) => i.id), [ID.C1]);
    assert.equal(nome.total, 1);
    const tel = await rpcOk("pesquisa_abertas", { p_chaves: chaves, p_busca: "91111", p_busca_digitos: "91111" });
    assert.deepEqual(tel.itens.map((i) => i.id), [ID.A1]);
    const curinga = await rpcOk("pesquisa_abertas", { p_chaves: chaves, p_busca: "_" });
    assert.equal(curinga.total, 0);
    // Paginação continua funcionando com os parâmetros novos no fim.
    const pagina = await rpcOk("pesquisa_abertas", { p_chaves: chaves, p_limite: 1, p_offset: 1, p_status: "concluida", p_busca: "gmail" });
    assert.equal(pagina.total, 2);
    assert.deepEqual(pagina.itens.map((i) => i.id), [ID.A1]);
  });

  test("só quem escreveu algo, mais recentes primeiro, textos só com as chaves pedidas", async () => {
    const r = await rpcOk("pesquisa_abertas", { p_chaves: ["problema_unico", "sonho"] });
    assert.equal(r.total, 2); // B1 tem "   ": não conta
    assert.deepEqual(r.itens, [
      {
        id: ID.C1, nome: "Pessoa 3", perfil: CUID, whatsapp: "(11) 93333-3333", email: "p3@gmail.com",
        criado_em: "2026-09-11T02:40:00+00:00", status: "concluida",
        textos: { problema_unico: "texto C", sonho: "sonho C" }
      },
      {
        id: ID.A1, nome: "Pessoa 1", perfil: CUID, whatsapp: "(11) 91111-1111", email: "p1@gmail.com",
        criado_em: "2026-09-10T12:05:00+00:00", status: "concluida",
        textos: { problema_unico: "texto A" }
      }
    ]);

    const soSonho = await rpcOk("pesquisa_abertas", { p_chaves: ["sonho"] });
    assert.equal(soSonho.total, 1);
    assert.deepEqual(soSonho.itens[0].textos, { sonho: "sonho C" });

    // As chaves de texto de hoje são só as abertas e a frase (nenhuma pergunta tem "Outro").
    // [...IGNORAR]: a lista nasce dentro do vm (outro "realm"), e o deepEqual estrito compara protótipos.
    assert.deepEqual([...IGNORAR], ["problema_unico", "sonho", "frase_desejo", "frase_bloqueio"]);
    const todas = await rpcOk("pesquisa_abertas", { p_chaves: IGNORAR });
    assert.deepEqual(todas.itens.map((i) => i.id).sort(), [ID.A1, ID.C1].sort());
  });

  test("paginação: limite, offset e limites de segurança", async () => {
    const pagina2 = await rpcOk("pesquisa_abertas", { p_chaves: ["problema_unico"], p_limite: 1, p_offset: 1 });
    assert.equal(pagina2.total, 2);
    assert.deepEqual(pagina2.itens.map((i) => i.id), [ID.A1]);

    const zero = await rpcOk("pesquisa_abertas", { p_chaves: ["problema_unico"], p_limite: 0 });
    assert.equal(zero.itens.length, 1, "limite mínimo 1");
    const negativo = await rpcOk("pesquisa_abertas", { p_chaves: ["problema_unico"], p_offset: -5 });
    assert.equal(negativo.itens.length, 2);
    const alem = await rpcOk("pesquisa_abertas", { p_chaves: ["problema_unico"], p_offset: 10 });
    assert.deepEqual(alem, { total: 2, itens: [] });
  });

  test("teto de 500 por página", async () => {
    await stack.reset();
    await stack.sql(`
      insert into public.pesquisa_respostas (id, pesquisa_versao, nome, whatsapp, whatsapp_digits, email, respostas, criado_em)
      select gen_random_uuid(), '1.0', 'Pessoa ' || n, '(11) 9' || lpad(n::text, 4, '0') || '-0000',
             '119' || lpad(n::text, 8, '0'), 'p' || n || '@gmail.com', jsonb_build_object('sonho', 'sonho ' || n),
             now() - make_interval(secs => n)
      from generate_series(1, 520) as n
      returning 1 as ok
    `);
    const r = await rpcOk("pesquisa_abertas", { p_chaves: ["sonho"], p_limite: 9999 });
    assert.equal(r.total, 520);
    assert.equal(r.itens.length, 500);
    assert.equal(r.itens[0].textos.sonho, "sonho 1");
    const padrao = await rpcOk("pesquisa_abertas", { p_chaves: ["sonho"] });
    assert.equal(padrao.itens.length, 200);
  });

  test("filtros de perfil e período", async () => {
    await semear();
    const r = await rpcOk("pesquisa_abertas", { p_chaves: ["problema_unico"], p_perfil: TEC });
    assert.deepEqual(r, { total: 0, itens: [] });
    const periodo = await rpcOk("pesquisa_abertas", { p_chaves: ["problema_unico"], p_ate: "2026-09-11T00:00:00Z" });
    assert.deepEqual(periodo.itens.map((i) => i.id), [ID.A1]);
  });
});

describe("view pesquisa_planilha", () => {
  before(semear);

  // Uma coluna por chave de resposta, na ordem das perguntas: multipla = text[], escala = smallint,
  // o resto = text.
  const CHAVES = [];
  for (const pergunta of EV.PERGUNTAS) {
    for (const chave of EV.chavesDaPergunta(pergunta)) {
      let tipo = "text";
      if (chave === pergunta.id && pergunta.tipo === "multipla") tipo = "ARRAY";
      if (chave === pergunta.id && pergunta.tipo === "escala") tipo = "smallint";
      CHAVES.push({ chave, tipo });
    }
  }

  test("tem uma coluna para cada uma das 39 perguntas (a 31 em duas partes), com o tipo certo, sem *_outro", async () => {
    assert.equal(EV.PERGUNTAS.length, 39);
    const colunas = await stack.sql(`
      select column_name, data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'pesquisa_planilha' order by ordinal_position
    `);
    const porNome = new Map(colunas.map((c) => [c.column_name, c.data_type]));
    for (const { chave, tipo } of CHAVES) {
      assert.equal(porNome.get(chave), tipo, `coluna ${chave}`);
    }
    // Nenhuma pergunta tem "Outro": nada de coluna de complemento.
    assert.deepEqual(colunas.filter((c) => /outro/i.test(c.column_name)), []);
    assert.equal(CHAVES.length, 40);
    // As perguntas aparecem na ordem do questionário.
    const ordem = colunas.map((c) => c.column_name).filter((nome) => CHAVES.some((k) => k.chave === nome));
    assert.deepEqual(ordem, CHAVES.map((k) => k.chave));
    // Contato, status e rastreio também.
    for (const nome of ["id", "nome", "whatsapp", "whatsapp_internacional", "email", "status", "progresso_percentual",
      "criado_em", "concluido_em", "tentativas", "tempo_total_segundos", "utm_source", "utm_campaign", "dispositivo"]) {
      assert.ok(porNome.has(nome), `coluna ${nome}`);
    }
  });

  test("valores: texto, array, número e null para o que não se aplica", async () => {
    const r = await chamar("GET", `pesquisa_planilha?id=eq.${ID.A1}&select=*`);
    assert.equal(r.status, 200);
    const [a] = r.json;
    assert.equal(a.perfil, CUID);
    assert.equal(a.idade, "25 a 34 anos");
    assert.deepEqual(a.ambientes, ["Hospital", "UBS / posto de saúde", "Home care"]);
    assert.equal(a.seguranca, 7);
    assert.equal(a.objecoes, null, "múltipla não respondida é null, não lista vazia");
    assert.equal(a.tecnico_momento, null);
    assert.equal(a.tentativas, 2);
    assert.equal(a.whatsapp_internacional, "5511911111111");

    const todas = await chamar("GET", "pesquisa_planilha?select=id");
    assert.equal(todas.json.length, 5, "uma linha por pessoa");
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Páginas de obrigado: pagina_eventos, pagina_registrar_evento, paginas_resumo                */
/* ------------------------------------------------------------------------------------------ */

const AUX = "Auxiliar ou antiga atendente de enfermagem";
// O mapa que o servidor manda (js/obrigado-config.js): perfil → página. Chaves fora de ordem de
// propósito — a resposta sai sempre em afericao, cuidador, evento_outubro.
const MAPA = {
  "Enfermeiro(a)": "evento_outubro",
  "Cuidador(a)": "cuidador",
  [AUX]: "afericao",
  "Técnico(a) de enfermagem": "evento_outubro"
};

/** pagina_registrar_evento devolve void: o PostgREST responde 204. */
async function registrarPagina(p) {
  const r = await rpc("pagina_registrar_evento", { p });
  assert.equal(r.status, 204, `pagina_registrar_evento respondeu ${r.status}: ${JSON.stringify(r.json)}`);
}

async function limparEventos() {
  await stack.sql("truncate table public.pagina_eventos restart identity");
}

async function eventosGravados() {
  return await stack.sql(
    "select pagina, evento, visitante_id, sessao_id, perfil, page_url, referrer, utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, gclid, dispositivo from public.pagina_eventos order by id"
  );
}

describe("páginas de obrigado: instalação e segurança", () => {
  test("tabela, índice, RLS sem política, funções invoker com search_path; o arquivo roda de novo sem perder evento", async () => {
    await limparEventos();
    assert.equal((await rpc("pagina_registrar_evento", { p: { pagina: "cuidador", evento: "visita" } })).status, 204);

    await stack.aplicarSql();
    await stack.aplicarSql();

    const [contagem] = await stack.sql("select count(*) as n from public.pagina_eventos");
    assert.equal(contagem.n, "1");
    const [objetos] = await stack.sql(`
      select
        (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('pagina_registrar_evento', 'paginas_resumo')) as funcoes,
        (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'pagina_eventos') as indices,
        (select relrowsecurity::text from pg_class where oid = 'public.pagina_eventos'::regclass) as rls,
        (select count(*) from pg_policies where tablename = 'pagina_eventos') as politicas
    `);
    assert.deepEqual(objetos, { funcoes: "2", indices: "2", rls: "true", politicas: "0" });

    const funcoes = await stack.sql(`
      select proname, prosecdef::text as definer, array_to_string(proconfig, ',') as config, pg_get_function_identity_arguments(oid) as args
      from pg_proc where pronamespace = 'public'::regnamespace and proname in ('pagina_registrar_evento', 'paginas_resumo') order by proname
    `);
    assert.deepEqual(funcoes, [
      { proname: "pagina_registrar_evento", definer: "false", config: "search_path=public", args: "p jsonb" },
      { proname: "paginas_resumo", definer: "false", config: "search_path=public", args: "p_desde timestamp with time zone, p_ate timestamp with time zone, p_mapa jsonb" }
    ]);

    // A rota nova já responde pelo PostgREST depois de reaplicado (notify pgrst).
    const resumo = await rpcOk("paginas_resumo", { p_mapa: MAPA });
    assert.equal(resumo.paginas.length, 3);
  });

  for (const papel of ["anon", "authenticated"]) {
    test(`${papel}: não lê, não escreve e não executa nada das páginas de obrigado`, async () => {
      await limparEventos();
      await registrarPagina({ pagina: "afericao", evento: "visita", perfil: AUX });
      const chave = papel === "anon" ? stack.anonKey : stack.authenticatedKey;

      const leitura = await chamar("GET", "pagina_eventos?select=*", { chave });
      assert.ok([401, 403].includes(leitura.status), `${papel} GET -> ${leitura.status}`);
      assert.ok(!Array.isArray(leitura.json));
      const escrita = await chamar("POST", "pagina_eventos", { chave, corpo: { pagina: "afericao", evento: "visita" } });
      assert.ok([401, 403].includes(escrita.status), `${papel} POST -> ${escrita.status}`);
      const apagar = await chamar("DELETE", "pagina_eventos?pagina=neq.x", { chave });
      assert.ok([401, 403].includes(apagar.status), `${papel} DELETE -> ${apagar.status}`);

      for (const [funcao, corpo] of [
        ["pagina_registrar_evento", { p: { pagina: "afericao", evento: "visita" } }],
        ["paginas_resumo", { p_mapa: MAPA }]
      ]) {
        const r = await rpc(funcao, corpo, { chave });
        assert.ok([401, 403, 404].includes(r.status), `${papel} rpc/${funcao} -> ${r.status} ${JSON.stringify(r.json)}`);
      }
      const [contagem] = await stack.sql("select count(*) as n from public.pagina_eventos");
      assert.equal(contagem.n, "1");
    });
  }

  test("privilégios no catálogo: só service_role (tabela, sequência do id e as duas funções)", async () => {
    const [p] = await stack.sql(`
      select
        bool_or(has_table_privilege(papel, 'public.pagina_eventos', 'select,insert,update,delete,truncate,references,trigger'))::text as tabela,
        bool_or(has_sequence_privilege(papel, 'public.pagina_eventos_id_seq', 'usage,select,update'))::text as sequencia,
        bool_or(has_function_privilege(papel, 'public.pagina_registrar_evento(jsonb)', 'execute')
             or has_function_privilege(papel, 'public.paginas_resumo(timestamptz,timestamptz,jsonb)', 'execute'))::text as funcoes
      from unnest(array['anon', 'authenticated', 'public']) as papel
    `);
    assert.deepEqual(p, { tabela: "false", sequencia: "false", funcoes: "false" });
    const [s] = await stack.sql(`
      select has_table_privilege('service_role', 'public.pagina_eventos', 'select,insert')::text as tabela,
             has_function_privilege('service_role', 'public.pagina_registrar_evento(jsonb)', 'execute')::text as registrar,
             has_function_privilege('service_role', 'public.paginas_resumo(timestamptz,timestamptz,jsonb)', 'execute')::text as resumo
    `);
    assert.deepEqual(s, { tabela: "true", registrar: "true", resumo: "true" });
  });
});

describe("pagina_registrar_evento", () => {
  before(() => limparEventos());

  test("grava um evento por chamada, com texto aparado, vazio virando null e uuid inválido virando null", async () => {
    const visitante = randomUUID();
    const sessao = randomUUID();
    assert.equal(
      (
        await rpc("pagina_registrar_evento", {
          p: {
            pagina: "evento_outubro",
            evento: "visita",
            visitante_id: visitante,
            sessao_id: sessao,
            perfil: "  Técnico(a) de enfermagem ",
            page_url: " https://x/obrigado-evento-outubro?utm_source=meta ",
            referrer: "",
            utm_source: "meta",
            utm_medium: "   ",
            utm_campaign: "outubro",
            utm_content: null,
            utm_term: "t",
            fbclid: "fb",
            gclid: "",
            dispositivo: "mobile"
          }
        })
      ).status,
      204
    );
    await registrarPagina({ pagina: "evento_outubro", evento: "clique_grupo", visitante_id: "nao-e-uuid", sessao_id: "  ", perfil: "" });
    await registrarPagina({ pagina: "evento_outubro", evento: "visita", visitante_id: visitante });

    const linhas = await eventosGravados();
    assert.deepEqual(linhas, [
      {
        pagina: "evento_outubro",
        evento: "visita",
        visitante_id: visitante,
        sessao_id: sessao,
        perfil: "Técnico(a) de enfermagem",
        page_url: "https://x/obrigado-evento-outubro?utm_source=meta",
        referrer: null,
        utm_source: "meta",
        utm_medium: null,
        utm_campaign: "outubro",
        utm_content: null,
        utm_term: "t",
        fbclid: "fb",
        gclid: null,
        dispositivo: "mobile"
      },
      { pagina: "evento_outubro", evento: "clique_grupo", visitante_id: null, sessao_id: null, perfil: null, page_url: null, referrer: null, utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null, fbclid: null, gclid: null, dispositivo: null },
      { pagina: "evento_outubro", evento: "visita", visitante_id: visitante, sessao_id: null, perfil: null, page_url: null, referrer: null, utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null, fbclid: null, gclid: null, dispositivo: null }
    ]);
    const [datas] = await stack.sql("select bool_and(criado_em > now() - interval '1 minute')::text as agora from public.pagina_eventos");
    assert.equal(datas.agora, "true");
  });

  test("página ausente, evento fora da lista ou página com formato estranho: erro e nada gravado", async () => {
    await limparEventos();
    for (const p of [
      {},
      { evento: "visita" },
      { pagina: "  ", evento: "visita" },
      { pagina: "afericao" },
      { pagina: "afericao", evento: "inicio" },
      { pagina: "afericao", evento: "VISITA" },
      { pagina: "Afericao; drop table x", evento: "visita" },
      { pagina: "a".repeat(61), evento: "visita" }
    ]) {
      const r = await rpc("pagina_registrar_evento", { p });
      assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(p)} -> ${r.status}`);
    }
    const r = await rpc("pagina_registrar_evento", { p: null });
    assert.ok(r.status >= 400 && r.status < 500, `p null -> ${r.status}`);
    const [contagem] = await stack.sql("select count(*) as n from public.pagina_eventos");
    assert.equal(contagem.n, "0");
  });
});

// Conjunto das páginas de obrigado (UTC; Brasília = UTC-3):
//   T1 = 20/09 12:00Z (20/09 09:00 BR)   T2 = 21/09 02:30Z (20/09 23:30 BR!)   T3 = 21/09 15:00Z (21/09 12:00 BR)
//
// Eventos:
//   e1 afericao  visita  A     aux    instagram  T1
//   e2 afericao  visita  A     aux    instagram  T1+1min   (recarregou: visita a mais, mesma pessoa)
//   e3 afericao  clique  A     aux    instagram  T1+2min
//   e4 afericao  visita  —     —      —          T3        (link direto, sem id: conta como uma pessoa)
//   e5 afericao  clique  —     —      —          T3        (outra "pessoa": evento-<id>)
//   e6 evento    visita  B     tec    facebook   T2
//   e7 evento    visita  C     enf    "  "       T3        (utm em branco → "(sem utm)")
//   e8 evento    clique  B     tec    facebook   T2+1min   (ainda 20/09 em Brasília)
//   e9 evento    clique  B     tec    facebook   T3        (clicou de novo no dia seguinte)
//   e10 outra_pagina visita D  —      —          T3        (página fora do mapa: não aparece)
//
// Pessoas (finalizado_em = chegou à tela de fim e foi levada à página):
//   P1 aux  T1 · P2 aux sem finalizar · P3 tec T2 + P7 tec T2 (mesmo WhatsApp: uma pessoa só) ·
//   P4 tec T3 · P5 enf T3 · P6 cuidador 01/08 · P8 tec T3 de OUTRA pesquisa · P9 "Estudante" T3
//
// Período inteiro, à mão:
//   afericao        visitas 3 (e1,e2,e4) · visitantes 2 (A, e4) · cliques 2 · clicaram 2 (A, e5) · atribuídas 1 (P1)
//   cuidador        tudo zero de evento · atribuídas 1 (P6)
//   evento_outubro  visitas 2 · visitantes 2 (B, C) · cliques 2 · clicaram 1 (B) · atribuídas 3 (P3/P7, P4, P5)
const T1 = "2026-09-20T12:00:00Z";
const T2 = "2026-09-21T02:30:00Z";
const T3 = "2026-09-21T15:00:00Z";
const VA = "aaaaaaaa-0000-4000-8000-000000000001";
const VB = "bbbbbbbb-0000-4000-8000-000000000002";
const VC = "cccccccc-0000-4000-8000-000000000003";
const VD = "dddddddd-0000-4000-8000-000000000004";

async function semearObrigado() {
  await stack.reset();
  await limparEventos();
  const mais = (iso, minutos) => new Date(Date.parse(iso) + minutos * 60_000).toISOString();
  await inserir("pagina_eventos", [
    { pagina: "afericao", evento: "visita", visitante_id: VA, perfil: AUX, utm_source: "instagram", criado_em: T1 },
    { pagina: "afericao", evento: "visita", visitante_id: VA, perfil: AUX, utm_source: "instagram", criado_em: mais(T1, 1) },
    { pagina: "afericao", evento: "clique_grupo", visitante_id: VA, perfil: AUX, utm_source: "instagram", criado_em: mais(T1, 2) },
    { pagina: "afericao", evento: "visita", visitante_id: null, perfil: null, utm_source: null, criado_em: T3 },
    { pagina: "afericao", evento: "clique_grupo", visitante_id: null, perfil: null, utm_source: null, criado_em: T3 },
    { pagina: "evento_outubro", evento: "visita", visitante_id: VB, perfil: TEC, utm_source: "facebook", criado_em: T2 },
    { pagina: "evento_outubro", evento: "visita", visitante_id: VC, perfil: ENF, utm_source: "  ", criado_em: T3 },
    { pagina: "evento_outubro", evento: "clique_grupo", visitante_id: VB, perfil: TEC, utm_source: "facebook", criado_em: mais(T2, 1) },
    { pagina: "evento_outubro", evento: "clique_grupo", visitante_id: VB, perfil: TEC, utm_source: "facebook", criado_em: T3 },
    { pagina: "outra_pagina", evento: "visita", visitante_id: VD, perfil: null, utm_source: null, criado_em: T3 }
  ]);

  const pessoa = async (digits, perfil, finalizado, extra = {}) => {
    const id = randomUUID();
    await rpcOk("pesquisa_salvar", {
      p: payload({ id, whatsapp_digits: digits, perfil, respostas: { perfil }, completa: Boolean(finalizado), finalizou: Boolean(finalizado), ...extra })
    });
    if (finalizado) await stack.sql(`update public.pesquisa_respostas set finalizado_em = ${lit(finalizado)} where id = '${id}' returning 1 as ok`);
    return id;
  };
  await pessoa("11900000001", AUX, T1);
  await pessoa("11900000002", AUX, null);
  await pessoa("11900000003", TEC, T2);
  await pessoa("11900000003", TEC, T2);
  await pessoa("11900000004", TEC, T3);
  await pessoa("11900000005", ENF, T3);
  await pessoa("11900000006", CUID, "2026-08-01T15:00:00Z");
  await pessoa("11900000008", TEC, T3, { pesquisa: "outra-pesquisa" });
  await pessoa("11900000009", "Estudante da área da saúde", T3);
}

const ZERO = (pagina, extra = {}) => ({ pagina, visitas: 0, visitantes: 0, cliques: 0, clicaram: 0, atribuidas: 0, por_perfil: [], por_origem: [], por_dia: [], ...extra });

describe("paginas_resumo", () => {
  test("banco vazio: as 3 páginas do mapa, em ordem, com zeros e listas vazias; mapa vazio = nenhuma página", async () => {
    await stack.reset();
    await limparEventos();
    assert.deepEqual(await rpcOk("paginas_resumo", { p_mapa: MAPA }), { paginas: [ZERO("afericao"), ZERO("cuidador"), ZERO("evento_outubro")] });
    assert.deepEqual(await rpcOk("paginas_resumo", {}), { paginas: [] });
    assert.deepEqual(await rpcOk("paginas_resumo", { p_mapa: [] }), { paginas: [] });
  });

  test("período inteiro: todos os campos, calculados à mão", async () => {
    await semearObrigado();
    const r = await rpcOk("paginas_resumo", { p_mapa: MAPA });
    assert.deepEqual(r, {
      paginas: [
        {
          pagina: "afericao",
          visitas: 3,
          visitantes: 2,
          cliques: 2,
          clicaram: 2,
          atribuidas: 1,
          por_perfil: [
            { perfil: AUX, visitantes: 1, clicaram: 1, atribuidas: 1 },
            { perfil: null, visitantes: 1, clicaram: 1, atribuidas: 0 }
          ],
          por_origem: [
            { utm_source: "(sem utm)", visitantes: 1, clicaram: 1 },
            { utm_source: "instagram", visitantes: 1, clicaram: 1 }
          ],
          por_dia: [
            { dia: "2026-09-20", visitantes: 1, clicaram: 1 },
            { dia: "2026-09-21", visitantes: 1, clicaram: 1 }
          ]
        },
        ZERO("cuidador", { atribuidas: 1, por_perfil: [{ perfil: CUID, visitantes: 0, clicaram: 0, atribuidas: 1 }] }),
        {
          pagina: "evento_outubro",
          visitas: 2,
          visitantes: 2,
          cliques: 2,
          clicaram: 1,
          atribuidas: 3,
          // Técnico e Enfermeiro na mesma página, contados separados.
          por_perfil: [
            { perfil: TEC, visitantes: 1, clicaram: 1, atribuidas: 2 },
            { perfil: ENF, visitantes: 1, clicaram: 0, atribuidas: 1 }
          ],
          por_origem: [
            { utm_source: "facebook", visitantes: 1, clicaram: 1 },
            { utm_source: "(sem utm)", visitantes: 1, clicaram: 0 }
          ],
          // T2 (02:30Z) e o clique de T2+1min são 20/09 em Brasília; o clique de T3 é 21/09.
          por_dia: [
            { dia: "2026-09-20", visitantes: 1, clicaram: 1 },
            { dia: "2026-09-21", visitantes: 1, clicaram: 1 }
          ]
        }
      ]
    });
  });

  test("período: desde inclusivo e até exclusivo, nos eventos (criado_em) e nas atribuídas (finalizado_em)", async () => {
    await semearObrigado();
    const inicio21 = "2026-09-21T03:00:00Z"; // 21/09 00:00 em Brasília
    const desde = await rpcOk("paginas_resumo", { p_desde: inicio21, p_mapa: MAPA });
    const [a, c, e] = desde.paginas;
    assert.deepEqual([a.pagina, a.visitas, a.visitantes, a.cliques, a.clicaram, a.atribuidas], ["afericao", 1, 1, 1, 1, 0]);
    assert.deepEqual([c.pagina, c.atribuidas, c.por_perfil], ["cuidador", 0, []]);
    assert.deepEqual([e.pagina, e.visitas, e.visitantes, e.cliques, e.clicaram, e.atribuidas], ["evento_outubro", 1, 1, 1, 1, 2]);
    assert.deepEqual(e.por_perfil, [
      { perfil: ENF, visitantes: 1, clicaram: 0, atribuidas: 1 },
      { perfil: TEC, visitantes: 0, clicaram: 1, atribuidas: 1 }
    ]);
    assert.deepEqual(e.por_dia, [{ dia: "2026-09-21", visitantes: 1, clicaram: 1 }]);

    const ate = await rpcOk("paginas_resumo", { p_ate: inicio21, p_mapa: MAPA });
    const [a2, , e2] = ate.paginas;
    assert.deepEqual([a2.visitas, a2.visitantes, a2.cliques, a2.clicaram, a2.atribuidas], [2, 1, 1, 1, 1]);
    assert.deepEqual([e2.visitas, e2.visitantes, e2.cliques, e2.clicaram, e2.atribuidas], [1, 1, 1, 1, 1]);

    // Exatamente no instante do evento: desde inclui, até exclui.
    const noInstante = await rpcOk("paginas_resumo", { p_desde: T1, p_ate: new Date(Date.parse(T1) + 60_000).toISOString(), p_mapa: MAPA });
    assert.deepEqual([noInstante.paginas[0].visitas, noInstante.paginas[0].cliques, noInstante.paginas[0].atribuidas], [1, 0, 1]);
    await limparEventos();
    await stack.reset();
  });
});

describe("desempenho", () => {
  test("painel, cruzamento e abertas com 20 mil tentativas respondem rápido", async () => {
    await stack.reset();
    // 20 mil tentativas de ~16 mil pessoas, com respostas de verdade (perfil, idade, estado,
    // ambientes, seguranca e um texto), espalhadas em 30 dias.
    await stack.sql(`
      insert into public.pesquisa_respostas (
        id, pesquisa_versao, nome, whatsapp, whatsapp_digits, email, perfil, respostas, criado_em,
        status, concluido_em, tempo_total_segundos, posicao_max, pergunta_max, etapa_max, respondidas, utm_source, dispositivo
      )
      select gen_random_uuid(), '1.0', 'Pessoa ' || n, '(11) 9' || lpad((n % 16000)::text, 4, '0') || '-0000',
             '119' || lpad((n % 16000)::text, 8, '0'), 'p' || n || '@gmail.com',
             (array['Cuidador(a)', 'Técnico(a) de enfermagem', 'Enfermeiro(a)', 'Auxiliar ou antiga atendente de enfermagem'])[1 + n % 4],
             jsonb_build_object(
               'perfil', (array['Cuidador(a)', 'Técnico(a) de enfermagem', 'Enfermeiro(a)', 'Auxiliar ou antiga atendente de enfermagem'])[1 + n % 4],
               'idade', (array['Até 24 anos', '25 a 34 anos', '35 a 44 anos', '45 a 54 anos'])[1 + n % 4],
               'estado', (array['São Paulo', 'Bahia', 'Minas Gerais'])[1 + n % 3],
               'ambientes', jsonb_build_array('Hospital', (array['Clínica', 'Home care'])[1 + n % 2]),
               'seguranca', n % 11,
               'sonho', 'sonho ' || n
             ),
             now() - make_interval(secs => n * 120),
             case when n % 3 = 0 then 'concluida' else 'em_andamento' end,
             case when n % 3 = 0 then now() - make_interval(secs => n * 120 - 600) end,
             case when n % 3 = 0 then 600 + n % 300 end,
             case when n % 3 = 0 then 40 else 1 + n % 38 end,
             'idade', 1 + n % 9, n % 30,
             (array['instagram', 'facebook', null])[1 + n % 3],
             (array['mobile', 'desktop'])[1 + n % 2]
      from generate_series(1, 20000) as n
    `);
    await stack.sql("analyze public.pesquisa_respostas");

    const medir = async (rotulo, fn) => {
      const inicio = performance.now();
      const resultado = await fn();
      const ms = performance.now() - inicio;
      return { rotulo, ms, resultado };
    };
    const painel = await medir("painel", () => rpcOk("pesquisa_painel", { p_ignorar: IGNORAR }));
    const cruz = await medir("cruzamento", () => rpcOk("pesquisa_cruzamento", { p_linha: "perfil", p_coluna: "ambientes" }));
    const abertas = await medir("abertas", () => rpcOk("pesquisa_abertas", { p_chaves: ["sonho"], p_limite: 200 }));

    assert.equal(painel.resultado.pessoas, 16000);
    assert.equal(painel.resultado.tentativas, 20000);
    assert.equal(cruz.resultado.base, 16000);
    assert.equal(abertas.resultado.total, 16000);
    for (const { rotulo, ms } of [painel, cruz, abertas]) {
      // Folgado para máquina lenta/CI; na prática fica bem abaixo disso.
      assert.ok(ms < 5000, `${rotulo} levou ${Math.round(ms)} ms`);
      console.log(`# ${rotulo}: ${Math.round(ms)} ms com 20 mil tentativas`);
    }
  });
});

/* ============================================================================================ */
/* 6. Inscrições com checkout na Hotmart e o aviso de venda                                     */
/* ============================================================================================ */

const PAGINA = "viver-de-furo";

async function limparInscricoes() {
  await stack.sql("truncate table public.inscricoes, public.compras restart identity");
}

/** O `p` de inscricao_salvar, como o servidor monta. */
function inscricao(sobrescrever = {}) {
  return {
    id: randomUUID(),
    pagina: PAGINA,
    nome: "Maria da Silva",
    whatsapp: "(11) 91234-5678",
    whatsapp_digits: "11912345678",
    email: "maria@gmail.com",
    checkout_url: "https://pay.hotmart.com/Y74893363S?off=7j2nqptq&checkoutMode=10&utm_source=facebook&sck=criativo-07",
    visitante_id: randomUUID(),
    utm_source: "facebook",
    utm_medium: "cpc",
    utm_campaign: "viver-de-furo-set",
    utm_content: "anuncio-b",
    utm_term: "criativo-07",
    fbclid: null,
    gclid: null,
    page_url: "https://lp.exemplo/viver-de-furo-inscricao?utm_source=facebook",
    referrer: "https://www.facebook.com/",
    dispositivo: "mobile",
    ...sobrescrever
  };
}

/** O `p` de hotmart_registrar_compra, como o servidor monta a partir do payload da Hotmart. */
function compra(sobrescrever = {}) {
  return {
    evento: "PURCHASE_APPROVED",
    hotmart_id: "aviso-1",
    transacao: "HP1234567890",
    status: "APPROVED",
    produto_id: "Y74893363S",
    produto_nome: "Viver de Furo de Orelha",
    oferta: "7j2nqptq",
    valor: 197,
    moeda: "BRL",
    comprador_nome: "Maria da Silva",
    comprador_email: "maria@gmail.com",
    comprador_telefone: "5511912345678",
    comprador_digits: "11912345678",
    sck: "criativo-07",
    src: "facebook",
    evento_em: "2026-09-21T14:00:00-03:00",
    pedido_em: "2026-09-21T13:58:00-03:00",
    aprovado_em: "2026-09-21T14:00:00-03:00",
    payload: { event: "PURCHASE_APPROVED", data: { purchase: { transaction: "HP1234567890" } } },
    ...sobrescrever
  };
}

async function linhaInscricao(id) {
  const r = await chamar("GET", `inscricoes?id=eq.${id}&select=*`);
  assert.equal(r.status, 200);
  return r.json[0];
}

describe("inscrições: instalação e segurança", () => {
  test("tabelas, índices, RLS sem política e funções invoker; o arquivo roda de novo sem perder inscrição", async () => {
    await limparInscricoes();
    const salva = await rpcOk("inscricao_salvar", { p: inscricao() });
    assert.equal(salva.ok, true);
    assert.equal(salva.novo, true);

    await stack.aplicarSql();
    await stack.aplicarSql();

    const [contagem] = await stack.sql("select count(*) as n from public.inscricoes");
    assert.equal(contagem.n, "1", "reaplicar o supabase.sql não apaga inscrição");

    const [objetos] = await stack.sql(`
      select
        (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
           and proname in ('inscricao_salvar', 'hotmart_registrar_compra', 'inscricoes_resumo')) as funcoes,
        (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'inscricoes') as indices_inscricoes,
        (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'compras') as indices_compras,
        (select relrowsecurity::text from pg_class where oid = 'public.inscricoes'::regclass) as rls_inscricoes,
        (select relrowsecurity::text from pg_class where oid = 'public.compras'::regclass) as rls_compras,
        (select count(*) from pg_policies where tablename in ('inscricoes', 'compras')) as politicas
    `);
    // inscricoes: pk + chave única + (pagina, criado_em) + whatsapp_digits + email = 5
    // compras: pk + (transacao, evento) + recebido_em + email + digits = 5
    assert.deepEqual(objetos, {
      funcoes: "3",
      indices_inscricoes: "5",
      indices_compras: "5",
      rls_inscricoes: "true",
      rls_compras: "true",
      politicas: "0"
    });

    const funcoes = await stack.sql(`
      select proname, prosecdef::text as definer, array_to_string(proconfig, ',') as config, pg_get_function_identity_arguments(oid) as args
      from pg_proc where pronamespace = 'public'::regnamespace
        and proname in ('inscricao_salvar', 'hotmart_registrar_compra', 'inscricoes_resumo') order by proname
    `);
    assert.deepEqual(funcoes, [
      { proname: "hotmart_registrar_compra", definer: "false", config: "search_path=public", args: "p jsonb" },
      { proname: "inscricao_salvar", definer: "false", config: "search_path=public", args: "p jsonb" },
      {
        proname: "inscricoes_resumo",
        definer: "false",
        config: "search_path=public",
        args: "p_desde timestamp with time zone, p_ate timestamp with time zone, p_pagina text"
      }
    ]);

    // A rota nova já responde pelo PostgREST depois de reaplicado (notify pgrst).
    const resumo = await rpcOk("inscricoes_resumo", { p_pagina: PAGINA });
    assert.equal(resumo.paginas[0].pagina, PAGINA);
    assert.equal(resumo.paginas[0].inscritos, 1);
  });

  test("whatsapp_internacional é coluna gerada ('55' + dígitos)", async () => {
    await limparInscricoes();
    const salva = await rpcOk("inscricao_salvar", { p: inscricao({ whatsapp_digits: "21998765432" }) });
    const linha = await linhaInscricao(salva.id);
    assert.equal(linha.whatsapp_internacional, "5521998765432");
    // Coluna gerada de verdade: gravar nela é erro.
    const r = await chamar("PATCH", `inscricoes?id=eq.${salva.id}`, { corpo: { whatsapp_internacional: "5500000000000" } });
    assert.equal(r.status, 400);
  });

  for (const papel of ["anon", "authenticated"]) {
    test(`${papel}: não lê, não escreve e não executa nada das inscrições nem das compras`, async () => {
      await limparInscricoes();
      const salva = await rpcOk("inscricao_salvar", { p: inscricao() });
      await rpcOk("hotmart_registrar_compra", { p: compra() });
      const chave = papel === "anon" ? stack.anonKey : stack.authenticatedKey;

      const corpos = {
        inscricoes: { id: randomUUID(), pagina: PAGINA, whatsapp_digits: "11999999999", email: "invasor@gmail.com" },
        compras: { evento: "PURCHASE_APPROVED", payload: {} }
      };
      for (const tabela of ["inscricoes", "compras"]) {
        const leitura = await chamar("GET", `${tabela}?select=*`, { chave });
        assert.ok([401, 403].includes(leitura.status), `${papel} GET ${tabela} -> ${leitura.status}`);
        assert.ok(!Array.isArray(leitura.json));
        const escrita = await chamar("POST", tabela, { chave, corpo: corpos[tabela] });
        assert.ok([401, 403].includes(escrita.status), `${papel} POST ${tabela} -> ${escrita.status}`);
        const filtro = tabela === "inscricoes" ? "id=neq.00000000-0000-4000-8000-000000000000" : "id=neq.0";
        const apagar = await chamar("DELETE", `${tabela}?${filtro}`, { chave });
        assert.ok([401, 403].includes(apagar.status), `${papel} DELETE ${tabela} -> ${apagar.status}`);
      }

      for (const [funcao, corpo] of [
        ["inscricao_salvar", { p: inscricao() }],
        ["hotmart_registrar_compra", { p: compra({ transacao: "HP-INVASOR" }) }],
        ["inscricoes_resumo", { p_pagina: PAGINA }]
      ]) {
        const r = await rpc(funcao, corpo, { chave });
        assert.ok([401, 403, 404].includes(r.status), `${papel} rpc/${funcao} -> ${r.status} ${JSON.stringify(r.json)}`);
      }

      const [contagem] = await stack.sql("select (select count(*) from public.inscricoes) || '/' || (select count(*) from public.compras) as n");
      assert.equal(contagem.n, "1/1", "nada foi criado nem apagado pela chave pública");
      assert.ok(salva.id);
    });
  }

  test("privilégios no catálogo: só service_role (tabelas, sequência e as três funções)", async () => {
    const [p] = await stack.sql(`
      select
        bool_or(has_table_privilege(papel, 'public.inscricoes', 'select,insert,update,delete,truncate,references,trigger'))::text as inscricoes,
        bool_or(has_table_privilege(papel, 'public.compras', 'select,insert,update,delete,truncate,references,trigger'))::text as compras,
        bool_or(has_sequence_privilege(papel, 'public.compras_id_seq', 'usage,select,update'))::text as sequencia,
        bool_or(has_function_privilege(papel, 'public.inscricao_salvar(jsonb)', 'execute')
             or has_function_privilege(papel, 'public.hotmart_registrar_compra(jsonb)', 'execute')
             or has_function_privilege(papel, 'public.inscricoes_resumo(timestamptz,timestamptz,text)', 'execute'))::text as funcoes
      from unnest(array['anon', 'authenticated', 'public']) as papel
    `);
    assert.deepEqual(p, { inscricoes: "false", compras: "false", sequencia: "false", funcoes: "false" });

    const [s] = await stack.sql(`
      select has_table_privilege('service_role', 'public.inscricoes', 'select,insert,update')::text as inscricoes,
             has_table_privilege('service_role', 'public.compras', 'select,insert,update')::text as compras,
             has_function_privilege('service_role', 'public.inscricao_salvar(jsonb)', 'execute')::text as salvar,
             has_function_privilege('service_role', 'public.hotmart_registrar_compra(jsonb)', 'execute')::text as registrar,
             has_function_privilege('service_role', 'public.inscricoes_resumo(timestamptz,timestamptz,text)', 'execute')::text as resumo
    `);
    assert.deepEqual(s, { inscricoes: "true", compras: "true", salvar: "true", registrar: "true", resumo: "true" });
  });
});

describe("inscricao_salvar", () => {
  test("a primeira vez cria a linha com cliques = 1 e o rastreio inteiro", async () => {
    await limparInscricoes();
    const p = inscricao();
    const salva = await rpcOk("inscricao_salvar", { p });
    assert.equal(salva.ok, true);
    assert.equal(salva.novo, true);
    assert.equal(salva.id, p.id, "o id do navegador é usado quando está livre");

    const linha = await linhaInscricao(salva.id);
    assert.equal(linha.pagina, PAGINA);
    assert.equal(linha.nome, "Maria da Silva");
    assert.equal(linha.whatsapp_digits, "11912345678");
    assert.equal(linha.email, "maria@gmail.com");
    assert.equal(linha.cliques, 1);
    assert.equal(linha.checkout_url, p.checkout_url);
    assert.equal(linha.utm_source, "facebook");
    assert.equal(linha.utm_term, "criativo-07");
    assert.equal(linha.dispositivo, "mobile");
    assert.ok(linha.clicou_em, "clicou_em marcado já no primeiro envio");
    assert.equal(linha.comprou_em, null);
  });

  test("reenviar o formulário soma cliques na MESMA inscrição e mantém o rastreio de primeiro toque", async () => {
    await limparInscricoes();
    const primeira = await rpcOk("inscricao_salvar", { p: inscricao() });

    // A mesma pessoa volta pelo link direto (sem UTM nenhuma) e envia de novo, duas vezes.
    const segunda = await rpcOk("inscricao_salvar", {
      p: inscricao({
        id: randomUUID(),
        nome: "MARIA DA SILVA",
        utm_source: null,
        utm_medium: null,
        utm_campaign: null,
        utm_content: null,
        utm_term: null,
        page_url: "https://lp.exemplo/viver-de-furo-inscricao",
        referrer: null,
        checkout_url: "https://pay.hotmart.com/Y74893363S?off=7j2nqptq&checkoutMode=10"
      })
    });
    await rpcOk("inscricao_salvar", { p: inscricao({ id: randomUUID() }) });

    assert.equal(segunda.novo, false);
    assert.equal(segunda.id, primeira.id, "é a mesma linha");

    const [contagem] = await stack.sql("select count(*) as n from public.inscricoes");
    assert.equal(contagem.n, "1");

    const linha = await linhaInscricao(primeira.id);
    assert.equal(linha.cliques, 3);
    assert.equal(linha.utm_source, "facebook", "primeiro toque: a campanha da primeira visita fica");
    assert.equal(linha.utm_term, "criativo-07");
    assert.equal(linha.page_url, "https://lp.exemplo/viver-de-furo-inscricao?utm_source=facebook");
    assert.equal(linha.referrer, "https://www.facebook.com/");
    assert.equal(linha.checkout_url, inscricao().checkout_url, "o último link aberto é o que fica gravado");
    assert.ok(new Date(linha.atualizado_em) >= new Date(linha.criado_em));
  });

  test("o rastreio de primeiro toque é um BLOCO: campanha nova não preenche buraco da antiga", async () => {
    await limparInscricoes();
    // Primeiro toque sem utm_term, mas com utm_source: a campanha inteira é essa.
    const primeira = await rpcOk("inscricao_salvar", { p: inscricao({ utm_source: "instagram", utm_campaign: "bio", utm_term: null, utm_content: null, utm_medium: null }) });
    await rpcOk("inscricao_salvar", { p: inscricao({ id: randomUUID(), utm_source: "facebook", utm_term: "criativo-09", utm_campaign: "set" }) });

    const linha = await linhaInscricao(primeira.id);
    assert.equal(linha.utm_source, "instagram");
    assert.equal(linha.utm_campaign, "bio");
    assert.equal(linha.utm_term, null, "o termo da segunda campanha NÃO entra no lugar vazio da primeira");
  });

  test("contato diferente (outro e-mail, outro telefone) é outra inscrição, mesmo com o id repetido", async () => {
    await limparInscricoes();
    const id = randomUUID();
    const primeira = await rpcOk("inscricao_salvar", { p: inscricao({ id }) });
    // A pessoa corrige o e-mail e reenvia: o navegador manda o MESMO id.
    const segunda = await rpcOk("inscricao_salvar", { p: inscricao({ id, email: "maria.silva@gmail.com" }) });
    // E outro telefone também.
    const terceira = await rpcOk("inscricao_salvar", { p: inscricao({ id, whatsapp_digits: "21998765432", whatsapp: "(21) 99876-5432" }) });

    assert.equal(segunda.novo, true);
    assert.equal(terceira.novo, true);
    assert.notEqual(segunda.id, primeira.id, "id repetido não derruba a gravação: a linha nova ganha outro id");
    assert.notEqual(terceira.id, primeira.id);
    const [contagem] = await stack.sql("select count(*) as n from public.inscricoes");
    assert.equal(contagem.n, "3");
  });

  test("a mesma pessoa em páginas diferentes são inscrições diferentes", async () => {
    await limparInscricoes();
    const a = await rpcOk("inscricao_salvar", { p: inscricao() });
    const b = await rpcOk("inscricao_salvar", { p: inscricao({ id: randomUUID(), pagina: "outra-pagina" }) });
    assert.notEqual(a.id, b.id);
    assert.equal(b.novo, true);
  });

  test("sem página, sem WhatsApp ou sem e-mail é erro (o servidor nunca manda assim)", async () => {
    for (const p of [inscricao({ pagina: null }), inscricao({ whatsapp_digits: "" }), inscricao({ email: null })]) {
      const r = await rpc("inscricao_salvar", { p });
      assert.equal(r.status, 400, JSON.stringify(r.json));
    }
  });
});

describe("hotmart_registrar_compra", () => {
  test("casa pelo e-mail (sem diferenciar maiúsculas) e marca a inscrição como comprada", async () => {
    await limparInscricoes();
    const salva = await rpcOk("inscricao_salvar", { p: inscricao() });

    const resultado = await rpcOk("hotmart_registrar_compra", { p: compra({ comprador_email: "MARIA@GMAIL.COM", comprador_digits: "99999999999" }) });
    assert.equal(resultado.ok, true);
    assert.equal(resultado.novo, true);
    assert.equal(resultado.casou, true);
    assert.equal(resultado.inscricao_id, salva.id);
    assert.equal(resultado.pagina, PAGINA);

    const linha = await linhaInscricao(salva.id);
    assert.equal(new Date(linha.comprou_em).toISOString(), "2026-09-21T17:00:00.000Z");
    assert.equal(linha.compra_status, "APPROVED");
    assert.equal(Number(linha.compra_valor), 197);
    assert.equal(linha.compra_moeda, "BRL");
    assert.equal(linha.compra_transacao, "HP1234567890");

    // O aviso inteiro ficou guardado, com o payload cru.
    const [gravada] = (await chamar("GET", "compras?select=*")).json;
    assert.equal(gravada.evento, "PURCHASE_APPROVED");
    assert.equal(gravada.comprador_email, "maria@gmail.com", "e-mail normalizado para minúsculas");
    assert.equal(gravada.inscricao_id, salva.id);
    assert.equal(gravada.pagina, PAGINA);
    assert.equal(gravada.sck, "criativo-07");
    assert.deepEqual(gravada.payload, { event: "PURCHASE_APPROVED", data: { purchase: { transaction: "HP1234567890" } } });
  });

  test("casa pelos ÚLTIMOS 8 dígitos do telefone quando o e-mail é outro (o 9 e o DDI variam)", async () => {
    await limparInscricoes();
    const salva = await rpcOk("inscricao_salvar", { p: inscricao({ whatsapp_digits: "11912345678" }) });

    // Na Hotmart a pessoa digitou outro e-mail e o número com DDI e sem o 9.
    const resultado = await rpcOk("hotmart_registrar_compra", {
      p: compra({ comprador_email: "outro-email@gmail.com", comprador_digits: "551112345678", transacao: "HP-TEL" })
    });
    assert.equal(resultado.casou, true);
    assert.equal(resultado.inscricao_id, salva.id);
    const linha = await linhaInscricao(salva.id);
    assert.ok(linha.comprou_em);
  });

  test("o e-mail ganha do telefone, e entre dois telefones iguais vale a inscrição mais recente", async () => {
    await limparInscricoes();
    const antiga = await rpcOk("inscricao_salvar", { p: inscricao({ email: "antiga@gmail.com" }) });
    await stack.sql(`update public.inscricoes set criado_em = now() - interval '10 days' where id = '${antiga.id}'`);
    const recente = await rpcOk("inscricao_salvar", { p: inscricao({ id: randomUUID(), email: "recente@gmail.com" }) });
    const outra = await rpcOk("inscricao_salvar", { p: inscricao({ id: randomUUID(), email: "escolhida@gmail.com", whatsapp_digits: "31999998888" }) });

    // Só telefone: a mais recente das duas com o mesmo número.
    const porTelefone = await rpcOk("hotmart_registrar_compra", { p: compra({ comprador_email: "nao-existe@gmail.com", transacao: "HP-A" }) });
    assert.equal(porTelefone.inscricao_id, recente.id);

    // Com e-mail que existe, é ele quem manda, mesmo com o telefone de outra pessoa.
    const porEmail = await rpcOk("hotmart_registrar_compra", {
      p: compra({ comprador_email: "escolhida@gmail.com", comprador_digits: "11912345678", transacao: "HP-B" })
    });
    assert.equal(porEmail.inscricao_id, outra.id);
  });

  test("compra que não casa com ninguém é gravada assim mesmo (casou = false)", async () => {
    await limparInscricoes();
    const resultado = await rpcOk("hotmart_registrar_compra", {
      p: compra({ comprador_email: "ninguem@gmail.com", comprador_digits: "6299998888" })
    });
    assert.equal(resultado.ok, true);
    assert.equal(resultado.casou, false);
    assert.equal(resultado.inscricao_id, null);
    assert.equal(resultado.pagina, null);
    const [contagem] = await stack.sql("select count(*) as n from public.compras where inscricao_id is null");
    assert.equal(contagem.n, "1");
  });

  test("o MESMO (transacao, evento) chegando duas vezes não duplica nem conta duas vezes", async () => {
    await limparInscricoes();
    const salva = await rpcOk("inscricao_salvar", { p: inscricao() });

    const primeira = await rpcOk("hotmart_registrar_compra", { p: compra() });
    const repetida = await rpcOk("hotmart_registrar_compra", { p: compra() });
    const terceira = await rpcOk("hotmart_registrar_compra", { p: compra({ hotmart_id: "aviso-reenviado" }) });

    assert.equal(primeira.novo, true);
    assert.equal(repetida.novo, false, "a Hotmart reenvia o aviso até receber 2xx");
    assert.equal(terceira.novo, false);
    assert.equal(repetida.casou, true, "mesmo repetido, a resposta diz de quem é a compra");

    const [contagem] = await stack.sql("select count(*) as n from public.compras");
    assert.equal(contagem.n, "1");

    // Outro EVENTO da mesma transação é outra linha (e outro aviso).
    await rpcOk("hotmart_registrar_compra", { p: compra({ evento: "PURCHASE_BILLET_PRINTED", status: "PRINTED_BILLET" }) });
    const [depois] = await stack.sql("select count(*) as n from public.compras");
    assert.equal(depois.n, "2");

    const linha = await linhaInscricao(salva.id);
    assert.ok(linha.comprou_em, "boleto impresso não desmarca quem já comprou");
    assert.equal(linha.compra_status, "APPROVED");
  });

  test("cancelamento, reembolso e chargeback desmarcam a compra e guardam o status", async () => {
    for (const [evento, status] of [
      ["PURCHASE_CANCELED", "CANCELED"],
      ["PURCHASE_REFUNDED", "REFUNDED"],
      ["PURCHASE_CHARGEBACK", "CHARGEBACK"],
      ["PURCHASE_PROTEST", "PROTESTED"]
    ]) {
      await limparInscricoes();
      const salva = await rpcOk("inscricao_salvar", { p: inscricao() });
      await rpcOk("hotmart_registrar_compra", { p: compra() });
      assert.ok((await linhaInscricao(salva.id)).comprou_em, evento);

      const resultado = await rpcOk("hotmart_registrar_compra", {
        p: compra({ evento, status, evento_em: "2026-09-25T10:00:00-03:00", aprovado_em: null })
      });
      assert.equal(resultado.casou, true, evento);
      const linha = await linhaInscricao(salva.id);
      assert.equal(linha.comprou_em, null, `${evento} desmarca a compra`);
      assert.equal(linha.compra_status, status);
      assert.equal(linha.compra_transacao, "HP1234567890", "a transação continua registrada");
    }
  });

  test("um aviso MAIS ANTIGO não sobrescreve o estado atual da inscrição", async () => {
    await limparInscricoes();
    const salva = await rpcOk("inscricao_salvar", { p: inscricao() });

    // Aprovada (25/09) e depois reembolsada (26/09): o estado é "reembolsada".
    await rpcOk("hotmart_registrar_compra", { p: compra({ evento_em: "2026-09-25T10:00:00-03:00", transacao: "HP-1" }) });
    await rpcOk("hotmart_registrar_compra", {
      p: compra({ evento: "PURCHASE_REFUNDED", status: "REFUNDED", evento_em: "2026-09-26T10:00:00-03:00", transacao: "HP-1", aprovado_em: null })
    });
    assert.equal((await linhaInscricao(salva.id)).comprou_em, null);

    // A Hotmart reenvia uma aprovação velha (de outra transação, mas do mesmo comprador): ignorada.
    await rpcOk("hotmart_registrar_compra", { p: compra({ evento_em: "2026-09-24T10:00:00-03:00", transacao: "HP-VELHA" }) });
    const linha = await linhaInscricao(salva.id);
    assert.equal(linha.comprou_em, null, "o evento antigo não ressuscita a compra");
    assert.equal(linha.compra_status, "REFUNDED");
    const [contagem] = await stack.sql("select count(*) as n from public.compras");
    assert.equal(contagem.n, "3", "mas o aviso antigo fica guardado do mesmo jeito");
  });

  test("aviso sem transação é sempre gravado (não há chave para deduplicar)", async () => {
    await limparInscricoes();
    await rpcOk("hotmart_registrar_compra", { p: compra({ transacao: null }) });
    await rpcOk("hotmart_registrar_compra", { p: compra({ transacao: null }) });
    const [contagem] = await stack.sql("select count(*) as n from public.compras");
    assert.equal(contagem.n, "2");
  });

  test("sem evento é erro", async () => {
    const r = await rpc("hotmart_registrar_compra", { p: compra({ evento: null }) });
    assert.equal(r.status, 400, JSON.stringify(r.json));
  });
});

describe("inscricoes_resumo", () => {
  /*
   * O conjunto abaixo é pequeno de propósito, para os números serem conferidos À MÃO. Tudo no fuso
   * de São Paulo:
   *
   *   A  20/09 10:00  facebook  / set / criativo-07  3 cliques  comprou 20/09 11:00  R$ 197
   *   B  20/09 12:00  facebook  / set / criativo-07  1 clique   —
   *   C  20/09 15:00  instagram / bio / (sem termo)  2 cliques  comprou 21/09 09:00  R$ 297
   *   D  21/09 08:00  facebook  / set / criativo-09  1 clique   —
   *   E  21/09 09:30  (sem utm nenhuma)              1 clique   —
   *   F  21/09 23:30  (sem utm nenhuma)              1 clique   comprou 21/09 23:45  R$ 97
   *   G  (outra-pagina) 21/09 10:00                  1 clique   —
   *
   *   inscritos = 6 (A..F)   cliques = 3+1+2+1+1+1 = 9   compras = 3   receita = 591,00
   *   taxa_compra = 3/6 = 50,0 %
   */
  const SP = (texto) => `${texto}-03:00`;

  before(async () => {
    await limparInscricoes();
    await inserir("inscricoes", [
      { id: randomUUID(), pagina: PAGINA, criado_em: SP("2026-09-20T10:00:00"), nome: "A", whatsapp_digits: "11900000001", email: "a@gmail.com", cliques: 3, comprou_em: SP("2026-09-20T11:00:00"), compra_valor: 197, compra_status: "APPROVED", utm_source: "facebook", utm_campaign: "set", utm_term: "criativo-07" },
      { id: randomUUID(), pagina: PAGINA, criado_em: SP("2026-09-20T12:00:00"), nome: "B", whatsapp_digits: "11900000002", email: "b@gmail.com", cliques: 1, utm_source: "facebook", utm_campaign: "set", utm_term: "criativo-07" },
      { id: randomUUID(), pagina: PAGINA, criado_em: SP("2026-09-20T15:00:00"), nome: "C", whatsapp_digits: "11900000003", email: "c@gmail.com", cliques: 2, comprou_em: SP("2026-09-21T09:00:00"), compra_valor: 297, compra_status: "APPROVED", utm_source: "instagram", utm_campaign: "bio" },
      { id: randomUUID(), pagina: PAGINA, criado_em: SP("2026-09-21T08:00:00"), nome: "D", whatsapp_digits: "11900000004", email: "d@gmail.com", cliques: 1, utm_source: "facebook", utm_campaign: "set", utm_term: "criativo-09" },
      { id: randomUUID(), pagina: PAGINA, criado_em: SP("2026-09-21T09:30:00"), nome: "E", whatsapp_digits: "11900000005", email: "e@gmail.com", cliques: 1 },
      { id: randomUUID(), pagina: PAGINA, criado_em: SP("2026-09-21T23:30:00"), nome: "F", whatsapp_digits: "11900000006", email: "f@gmail.com", cliques: 1, comprou_em: SP("2026-09-21T23:45:00"), compra_valor: 97, compra_status: "APPROVED" },
      { id: randomUUID(), pagina: "outra-pagina", criado_em: SP("2026-09-21T10:00:00"), nome: "G", whatsapp_digits: "11900000007", email: "g@gmail.com", cliques: 1 }
    ]);
  });

  test("os totais de uma página, com a taxa de compra e a receita", async () => {
    const resumo = await rpcOk("inscricoes_resumo", { p_pagina: PAGINA });
    assert.equal(resumo.paginas.length, 1);
    const [pagina] = resumo.paginas;
    assert.equal(pagina.pagina, PAGINA);
    assert.equal(pagina.inscritos, 6);
    assert.equal(pagina.cliques, 9);
    assert.equal(pagina.compras, 3);
    assert.equal(Number(pagina.receita), 591);
    assert.equal(Number(pagina.taxa_compra), 50.0);
  });

  test("sem p_pagina, cada página entra separada", async () => {
    const resumo = await rpcOk("inscricoes_resumo", {});
    assert.deepEqual(
      resumo.paginas.map((p) => [p.pagina, p.inscritos, p.cliques, p.compras]),
      [
        ["outra-pagina", 1, 1, 0],
        [PAGINA, 6, 9, 3]
      ]
    );
  });

  test("por origem, campanha e termo — o termo é o sck que a Hotmart devolve", async () => {
    const [pagina] = (await rpcOk("inscricoes_resumo", { p_pagina: PAGINA })).paginas;

    assert.deepEqual(pagina.por_origem, [
      { utm_source: "facebook", inscritos: 3, compras: 1 },
      { utm_source: "(sem utm)", inscritos: 2, compras: 1 },
      { utm_source: "instagram", inscritos: 1, compras: 1 }
    ]);
    assert.deepEqual(pagina.por_campanha, [
      { utm_campaign: "set", inscritos: 3, compras: 1 },
      { utm_campaign: "(sem utm)", inscritos: 2, compras: 1 },
      { utm_campaign: "bio", inscritos: 1, compras: 1 }
    ]);
    assert.deepEqual(pagina.por_termo, [
      { utm_term: "(sem utm)", inscritos: 3, compras: 2 },
      { utm_term: "criativo-07", inscritos: 2, compras: 1 },
      { utm_term: "criativo-09", inscritos: 1, compras: 0 }
    ]);
  });

  test("por dia no fuso de São Paulo: inscritos pelo cadastro, compras pelo dia da compra", async () => {
    const [pagina] = (await rpcOk("inscricoes_resumo", { p_pagina: PAGINA })).paginas;
    // 21/09 23:30 em São Paulo é 22/09 02:30 em UTC: o dia certo é o de cá.
    assert.deepEqual(pagina.por_dia, [
      { dia: "2026-09-20", inscritos: 3, compras: 1 },
      { dia: "2026-09-21", inscritos: 3, compras: 2 }
    ]);
  });

  test("o período corta por criado_em, em [desde, ate)", async () => {
    const soDia21 = (await rpcOk("inscricoes_resumo", { p_desde: SP("2026-09-21T00:00:00"), p_ate: SP("2026-09-22T00:00:00"), p_pagina: PAGINA })).paginas[0];
    assert.equal(soDia21.inscritos, 3, "D, E e F");
    assert.equal(soDia21.cliques, 3);
    assert.equal(soDia21.compras, 1, "só F comprou entre os inscritos do dia 21");
    assert.equal(Number(soDia21.receita), 97);

    const soDia20 = (await rpcOk("inscricoes_resumo", { p_desde: SP("2026-09-20T00:00:00"), p_ate: SP("2026-09-21T00:00:00"), p_pagina: PAGINA })).paginas[0];
    assert.equal(soDia20.inscritos, 3);
    assert.equal(soDia20.compras, 2, "A e C se inscreveram no dia 20 e compraram");
    assert.equal(Number(soDia20.receita), 494);
    // C se inscreveu no dia 20 e comprou no 21: a compra aparece no dia dela.
    assert.deepEqual(soDia20.por_dia, [
      { dia: "2026-09-20", inscritos: 3, compras: 1 },
      { dia: "2026-09-21", inscritos: 0, compras: 1 }
    ]);
  });

  test("página sem inscrição nenhuma volta zerada, com listas vazias", async () => {
    const resumo = await rpcOk("inscricoes_resumo", { p_pagina: "pagina-que-ainda-nao-tem-ninguem" });
    assert.deepEqual(resumo.paginas, [
      {
        pagina: "pagina-que-ainda-nao-tem-ninguem",
        inscritos: 0,
        cliques: 0,
        compras: 0,
        receita: 0,
        taxa_compra: 0,
        por_origem: [],
        por_campanha: [],
        por_termo: [],
        por_dia: []
      }
    ]);
    assert.deepEqual(resumo.compras_recentes, []);
    assert.equal(resumo.compras_sem_inscricao, 0);
  });

  test("compras recentes e a contagem das que não casaram com ninguém", async () => {
    await limparInscricoes();
    const salva = await rpcOk("inscricao_salvar", { p: inscricao() });
    await rpcOk("hotmart_registrar_compra", { p: compra({ transacao: "HP-CASOU" }) });
    await rpcOk("hotmart_registrar_compra", { p: compra({ transacao: "HP-ORFA-1", comprador_email: "ninguem@gmail.com", comprador_digits: "6299990000", comprador_nome: "Órfã Um" }) });
    await rpcOk("hotmart_registrar_compra", { p: compra({ transacao: "HP-ORFA-2", comprador_email: "outro@gmail.com", comprador_digits: "6299991111", evento: "PURCHASE_COMPLETE" }) });
    // Boleto gerado sem inscrição NÃO conta como "compra sem inscrição": ninguém pagou ainda.
    await rpcOk("hotmart_registrar_compra", { p: compra({ transacao: "HP-BOLETO", evento: "PURCHASE_BILLET_PRINTED", comprador_email: "boleto@gmail.com", comprador_digits: "6299992222" }) });

    const resumo = await rpcOk("inscricoes_resumo", {});
    assert.equal(resumo.compras_sem_inscricao, 2, "as duas aprovadas órfãs, e não o boleto");
    assert.equal(resumo.compras_recentes.length, 4, "todos os avisos aparecem na lista");
    const casadas = resumo.compras_recentes.filter((c) => c.casou);
    assert.equal(casadas.length, 1);
    assert.equal(casadas[0].comprador_email, "maria@gmail.com");
    assert.equal(casadas[0].pagina, PAGINA);
    assert.equal(Number(casadas[0].valor), 197);
    assert.equal(casadas[0].evento, "PURCHASE_APPROVED");
    assert.ok(resumo.compras_recentes.some((c) => c.comprador_nome === "Órfã Um" && c.casou === false));
    assert.ok(salva.id);
  });

  test("compras recentes traz no máximo 20, das mais novas para as mais velhas", async () => {
    await limparInscricoes();
    for (let i = 0; i < 25; i += 1) {
      await rpcOk("hotmart_registrar_compra", { p: compra({ transacao: `HP-${i}`, comprador_email: `pessoa${i}@gmail.com`, comprador_digits: `1190000${String(i).padStart(4, "0")}` }) });
    }
    const resumo = await rpcOk("inscricoes_resumo", {});
    assert.equal(resumo.compras_recentes.length, 20);
    const datas = resumo.compras_recentes.map((c) => c.recebido_em);
    assert.deepEqual(datas, [...datas].sort().reverse(), "da mais nova para a mais velha");
    assert.equal(resumo.compras_sem_inscricao, 25, "a contagem é de todas, não só das 20 mostradas");
  });
});
