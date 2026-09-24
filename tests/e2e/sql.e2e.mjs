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

/**
 * O `p` de hotmart_registrar_compra, como o servidor monta a partir do payload da Hotmart.
 *
 * `pagina` vem preenchida como na produção: a oferta 7j2nqptq está no js/checkout-config.js, então
 * o servidor (EVCheckout.paginaDaVenda) SEMPRE manda p.pagina = "viver-de-furo" para esta venda. Os
 * casos em que o servidor não conhece o produto (pagina null) têm testes próprios, mais abaixo.
 * produto_id é o id NUMÉRICO que a Hotmart manda em data.product.id (visto nos avisos reais), e não
 * o código do link (Y74893363S).
 */
function compra(sobrescrever = {}) {
  return {
    evento: "PURCHASE_APPROVED",
    hotmart_id: "aviso-1",
    transacao: "HP1234567890",
    status: "APPROVED",
    pagina: PAGINA,
    produto_id: "2332962",
    produto_nome: "Furo de orelha humanizado",
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

  test("compra do produto da página que não casa com ninguém é gravada assim mesmo (casou = false, pagina = a do produto)", async () => {
    await limparInscricoes();
    // Alguém se inscreveu, mas quem comprou é outra pessoa (comprou pelo link de outro lugar).
    await rpcOk("inscricao_salvar", { p: inscricao() });
    const resultado = await rpcOk("hotmart_registrar_compra", {
      p: compra({ comprador_email: "ninguem@gmail.com", comprador_digits: "6299998888" })
    });
    assert.equal(resultado.ok, true);
    assert.equal(resultado.casou, false);
    assert.equal(resultado.inscricao_id, null);
    assert.equal(resultado.pagina, PAGINA, "a venda é do produto da página, mesmo sem inscrição");
    const gravadas = await stack.sql("select coalesce(pagina, '<null>') as pagina, coalesce(inscricao_id::text, '<null>') as inscricao from public.compras");
    assert.deepEqual(gravadas, [{ pagina: PAGINA, inscricao: "<null>" }]);
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

  // A régua mudou de propósito. Antes este teste esperava que a aprovação velha de OUTRA transação
  // (HP-VELHA, 24/09) fosse ignorada por ser mais antiga do que o reembolso de HP-1 (26/09): o estado
  // era um só para a inscrição inteira. Agora o estado segue a TRANSAÇÃO. Dentro da mesma transação
  // vale o evento mais novo, e o APPROVED velho de HP-1 continua sem ressuscitar nada. Já HP-VELHA é
  // outra compra, que nunca foi reembolsada, e a inscrição não está com compra valendo: ela marca.
  // É também o que "vendas", do lado da Hotmart, conta (HP-VELHA é venda, HP-1 não). Ignorar HP-VELHA
  // deixava a pessoa como "não comprou" com um ingresso pago e o painel discordando de si mesmo.
  test("um aviso MAIS ANTIGO da mesma transação não sobrescreve o estado atual; a aprovação de OUTRA transação, nunca reembolsada, marca (como em vendas)", async () => {
    await limparInscricoes();
    const salva = await rpcOk("inscricao_salvar", { p: inscricao() });

    // HP-1: aprovada (25/09) e reembolsada (26/09), com o aviso do reembolso chegando ANTES.
    await rpcOk("hotmart_registrar_compra", {
      p: compra({ evento: "PURCHASE_REFUNDED", status: "REFUNDED", evento_em: "2026-09-26T10:00:00-03:00", transacao: "HP-1", aprovado_em: null })
    });
    const atrasado = await rpcOk("hotmart_registrar_compra", {
      p: compra({ evento_em: "2026-09-25T10:00:00-03:00", aprovado_em: "2026-09-25T10:00:00-03:00", transacao: "HP-1" })
    });
    assert.equal(atrasado.novo, true);
    assert.deepEqual(
      await estadoIso(salva.id),
      { comprou_em: null, compra_status: "REFUNDED", compra_valor: null, compra_transacao: "HP-1", compra_evento_em: "2026-09-26T13:00:00.000Z" },
      "o APPROVED mais antigo da MESMA transação não ressuscita a compra"
    );

    // HP-VELHA: outra transação do mesmo comprador, aprovada em 24/09 e nunca reembolsada.
    await rpcOk("hotmart_registrar_compra", {
      p: compra({ evento_em: "2026-09-24T10:00:00-03:00", aprovado_em: "2026-09-24T10:00:00-03:00", transacao: "HP-VELHA", sck: "criativo-09" })
    });
    assert.deepEqual(
      await estadoIso(salva.id),
      { comprou_em: "2026-09-24T13:00:00.000Z", compra_status: "APPROVED", compra_valor: 197, compra_transacao: "HP-VELHA", compra_evento_em: "2026-09-24T13:00:00.000Z" },
      "a outra compra, que continua valendo, marca a inscrição"
    );

    // Os dois lados do painel dizem o mesmo: 1 compra de inscrito (R$ 197) e 1 venda (HP-VELHA).
    const [pagina] = (await rpcOk("inscricoes_resumo", { p_pagina: PAGINA })).paginas;
    assert.deepEqual([pagina.compras, Number(pagina.receita), pagina.vendas, Number(pagina.vendas_receita)], [1, 197, 1, 197]);
    assert.deepEqual(pagina.vendas_por_sck, [{ sck: "criativo-09", vendas: 1, receita: 197, casadas: 1 }]);

    // E um aviso novo de HP-1 (a transação que NÃO está marcada) não mexe em HP-VELHA.
    await rpcOk("hotmart_registrar_compra", {
      p: compra({ evento: "PURCHASE_CHARGEBACK", status: "CHARGEBACK", evento_em: "2026-09-27T10:00:00-03:00", transacao: "HP-1", aprovado_em: null })
    });
    assert.equal((await estadoIso(salva.id)).compra_transacao, "HP-VELHA");
    const [contagem] = await stack.sql("select count(*) as n from public.compras");
    assert.equal(contagem.n, "4", "todo aviso fica guardado, inclusive o APPROVED atrasado de HP-1");
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

/*
 * A página do PRODUTO. Duas páginas vendem produtos diferentes (a Viver de Furo e os ingressos da
 * Imersão GPS), a mesma pessoa pode estar inscrita nas duas, e o webhook recebe também venda de
 * produto que não é de página nenhuma (a Formação vendida no fim da imersão, order bump, os testes
 * da Hotmart). Cada aviso é atribuído primeiro à página do produto e só casa com inscrição dela.
 *
 * Todas as vendas "de fora" abaixo têm evento MAIS NOVO do que o do ingresso: se elas casassem, a
 * regra de "evento mais novo manda" deixaria o estado da inscrição com os dados delas — é isso que
 * faria estes testes falharem na versão antiga, que casava com qualquer inscrição.
 */
const GPS = "imersao-gps";

/** Inscrição feita na página de venda da Imersão GPS (lá o utm_content é o que vira sck). */
function inscricaoGps(sobrescrever = {}) {
  return inscricao({
    pagina: GPS,
    checkout_url: "https://pay.hotmart.com/R107667362D?off=l0r77by6&checkoutMode=10&utm_content=criativo-gps-07&sck=criativo-gps-07",
    utm_source: "facebook",
    utm_medium: "cpc",
    utm_campaign: "igps-set",
    utm_content: "criativo-gps-07",
    utm_term: "publico-quente",
    page_url: "https://io.escolaenfermagemdevalor.com.br/igps_set_lp_26-ingresso?utm_content=criativo-gps-07",
    ...sobrescrever
  });
}

/** Venda de ingresso da Imersão GPS: a oferta l0r77by6 está no config, então o servidor manda p.pagina. */
function compraGps(sobrescrever = {}) {
  return compra({
    transacao: "HP-GPS-1",
    pagina: GPS,
    produto_id: "6123456",
    produto_nome: "Imersão GPS do Plantão Sem Medo",
    oferta: "l0r77by6",
    valor: 5,
    sck: "criativo-gps-07",
    ...sobrescrever
  });
}

/**
 * A Formação vendida no fim da imersão, para quem comprou o ingresso: mesmo e-mail, mesmo telefone,
 * mas produto e oferta que página nenhuma conhece — o servidor manda p.pagina = null.
 */
function compraFormacao(sobrescrever = {}) {
  return compra({
    transacao: "HP-FORMACAO-1",
    pagina: null,
    produto_id: "9999999",
    produto_nome: "Formação Enfermagem de Valor",
    oferta: "zzform01",
    valor: 1997,
    sck: "criativo-gps-07",
    evento_em: "2026-09-21T16:00:00-03:00",
    pedido_em: "2026-09-21T15:58:00-03:00",
    aprovado_em: "2026-09-21T16:00:00-03:00",
    ...sobrescrever
  });
}

/** O estado da compra numa inscrição, para comparar antes e depois. */
async function estadoDaCompra(id) {
  const linha = await linhaInscricao(id);
  return {
    comprou_em: linha.comprou_em,
    compra_status: linha.compra_status,
    compra_valor: linha.compra_valor === null ? null : Number(linha.compra_valor),
    compra_transacao: linha.compra_transacao,
    compra_evento_em: linha.compra_evento_em
  };
}

/** O mesmo estado, com as datas em ISO (UTC, com milissegundos) para comparar com um literal. */
async function estadoIso(id) {
  const e = await estadoDaCompra(id);
  const iso = (valor) => (valor === null ? null : new Date(valor).toISOString());
  return { ...e, comprou_em: iso(e.comprou_em), compra_evento_em: iso(e.compra_evento_em) };
}

const SEM_COMPRA = { comprou_em: null, compra_status: null, compra_valor: null, compra_transacao: null, compra_evento_em: null };

async function comprasGravadas() {
  return stack.sql(`
    select transacao, evento, coalesce(pagina, '<null>') as pagina, coalesce(inscricao_id::text, '<null>') as inscricao
    from public.compras order by id
  `);
}

describe("hotmart_registrar_compra: cada venda na página do SEU produto", () => {
  // Nos dois sentidos: a inscrição mais recente da pessoa é a "errada" para uma das duas vendas.
  for (const antes of [GPS, PAGINA]) {
    test(`a mesma pessoa inscrita nas duas páginas (${antes} primeiro): cada venda marca só a inscrição da página do produto`, async () => {
      await limparInscricoes();
      const gps = await rpcOk("inscricao_salvar", { p: inscricaoGps() });
      const viver = await rpcOk("inscricao_salvar", { p: inscricao({ id: randomUUID() }) });
      assert.notEqual(gps.id, viver.id);
      const antiga = antes === GPS ? gps.id : viver.id;
      await stack.sql(`update public.inscricoes set criado_em = now() - interval '10 days' where id = '${antiga}' returning 1 as ok`);

      // 1. O ingresso do GPS: marca a do GPS; a da Viver continua sem compra.
      const ingresso = await rpcOk("hotmart_registrar_compra", { p: compraGps() });
      assert.deepEqual(
        { casou: ingresso.casou, inscricao_id: ingresso.inscricao_id, pagina: ingresso.pagina },
        { casou: true, inscricao_id: gps.id, pagina: GPS }
      );
      const gpsDepois = await estadoDaCompra(gps.id);
      assert.equal(new Date(gpsDepois.comprou_em).toISOString(), "2026-09-21T17:00:00.000Z");
      assert.equal(gpsDepois.compra_status, "APPROVED");
      assert.equal(gpsDepois.compra_valor, 5);
      assert.equal(gpsDepois.compra_transacao, "HP-GPS-1");
      assert.deepEqual(await estadoDaCompra(viver.id), SEM_COMPRA, "a inscrição da Viver de Furo continua sem compra");

      // 2. Depois ela compra a Viver de Furo: marca a da Viver e não mexe no ingresso.
      const furo = await rpcOk("hotmart_registrar_compra", {
        p: compra({ transacao: "HP-FURO-1", evento_em: "2026-09-22T10:00:00-03:00", aprovado_em: "2026-09-22T10:00:00-03:00" })
      });
      assert.deepEqual(
        { casou: furo.casou, inscricao_id: furo.inscricao_id, pagina: furo.pagina },
        { casou: true, inscricao_id: viver.id, pagina: PAGINA }
      );
      const viverDepois = await estadoDaCompra(viver.id);
      assert.equal(viverDepois.compra_valor, 197);
      assert.equal(viverDepois.compra_transacao, "HP-FURO-1");
      assert.deepEqual(await estadoDaCompra(gps.id), gpsDepois, "o ingresso fica como estava");

      assert.deepEqual(await comprasGravadas(), [
        { transacao: "HP-GPS-1", evento: "PURCHASE_APPROVED", pagina: GPS, inscricao: gps.id },
        { transacao: "HP-FURO-1", evento: "PURCHASE_APPROVED", pagina: PAGINA, inscricao: viver.id }
      ]);
    });
  }

  test("pelo telefone também: só entre as inscrições da página do produto", async () => {
    await limparInscricoes();
    const gps = await rpcOk("inscricao_salvar", { p: inscricaoGps({ email: "maria.gps@gmail.com" }) });
    await stack.sql(`update public.inscricoes set criado_em = now() - interval '10 days' where id = '${gps.id}' returning 1 as ok`);
    // Na Viver de Furo, mais recente, com outro e-mail e o MESMO telefone.
    const viver = await rpcOk("inscricao_salvar", { p: inscricao({ id: randomUUID(), email: "maria.furo@gmail.com" }) });

    // Na Hotmart ela usou um terceiro e-mail, e o número com DDI e sem o 9.
    const r = await rpcOk("hotmart_registrar_compra", { p: compraGps({ comprador_email: "maria.hotmart@gmail.com", comprador_digits: "551112345678" }) });
    assert.equal(r.inscricao_id, gps.id);
    assert.deepEqual(await estadoDaCompra(viver.id), SEM_COMPRA);
  });

  test("produto que nenhuma página conhece (sem p.pagina, oferta que ninguém abriu, produto sem histórico): gravado com pagina null e não marca ninguém", async () => {
    await limparInscricoes();
    const gps = await rpcOk("inscricao_salvar", { p: inscricaoGps() });
    const viver = await rpcOk("inscricao_salvar", { p: inscricao({ id: randomUUID() }) });
    await rpcOk("hotmart_registrar_compra", { p: compraGps() });
    const ingresso = await estadoDaCompra(gps.id);

    // Quem comprou o ingresso compra a Formação no fim da imersão.
    const formacao = await rpcOk("hotmart_registrar_compra", { p: compraFormacao() });
    assert.deepEqual(formacao, { ok: true, novo: true, casou: false, inscricao_id: null, pagina: null });
    assert.deepEqual(await estadoDaCompra(gps.id), ingresso, "o ingresso não vira 'comprou a Formação' (nem ganha o valor dela)");
    assert.deepEqual(await estadoDaCompra(viver.id), SEM_COMPRA, "e a outra página também não é marcada");

    // Sem a chave `pagina` no p (um chamador que não manda nada): o mesmo. E um SEGUNDO aviso do
    // mesmo produto de fora continua de fora — aviso anterior com pagina null não ensina página.
    const semChave = compraFormacao({ transacao: "HP-FORMACAO-2" });
    delete semChave.pagina;
    const segunda = await rpcOk("hotmart_registrar_compra", { p: semChave });
    assert.equal(segunda.casou, false);
    assert.equal(segunda.pagina, null);

    // O teste da Hotmart ("produto 0", oferta de teste) também não mexe em ninguém.
    const teste = await rpcOk("hotmart_registrar_compra", {
      p: compraFormacao({ transacao: "HP-TESTE-0", produto_id: "0", oferta: "test", produto_nome: "Produto de teste" })
    });
    assert.equal(teste.casou, false);
    assert.equal(teste.pagina, null);

    const gravadas = await comprasGravadas();
    assert.deepEqual(gravadas.map((c) => [c.transacao, c.pagina, c.inscricao]), [
      ["HP-GPS-1", GPS, gps.id],
      ["HP-FORMACAO-1", "<null>", "<null>"],
      ["HP-FORMACAO-2", "<null>", "<null>"],
      ["HP-TESTE-0", "<null>", "<null>"]
    ]);
    const [formacaoGravada] = await stack.sql("select produto_id, oferta, valor::text as valor, sck from public.compras where transacao = 'HP-FORMACAO-1'");
    assert.deepEqual(formacaoGravada, { produto_id: "9999999", oferta: "zzform01", valor: "1997.00", sck: "criativo-gps-07" }, "o aviso fica gravado inteiro");
  });

  test("reembolso, cancelamento e chargeback da Formação não desmarcam o ingresso", async () => {
    await limparInscricoes();
    const gps = await rpcOk("inscricao_salvar", { p: inscricaoGps() });
    await rpcOk("hotmart_registrar_compra", { p: compraGps() });
    await rpcOk("hotmart_registrar_compra", { p: compraFormacao() });
    const ingresso = await estadoDaCompra(gps.id);
    assert.equal(ingresso.compra_status, "APPROVED");

    for (const [evento, status, dia] of [
      ["PURCHASE_REFUNDED", "REFUNDED", "25"],
      ["PURCHASE_CANCELED", "CANCELED", "26"],
      ["PURCHASE_CHARGEBACK", "CHARGEBACK", "27"]
    ]) {
      const r = await rpcOk("hotmart_registrar_compra", {
        p: compraFormacao({ evento, status, evento_em: `2026-09-${dia}T10:00:00-03:00`, aprovado_em: null })
      });
      assert.equal(r.casou, false, evento);
      assert.deepEqual(await estadoDaCompra(gps.id), ingresso, `${evento} da Formação não mexe no ingresso`);
    }

    // E o reembolso do PRÓPRIO ingresso continua desmarcando (a regra antiga vale dentro da página).
    await rpcOk("hotmart_registrar_compra", {
      p: compraGps({ evento: "PURCHASE_REFUNDED", status: "REFUNDED", evento_em: "2026-09-28T10:00:00-03:00", aprovado_em: null })
    });
    const reembolsado = await estadoDaCompra(gps.id);
    assert.equal(reembolsado.comprou_em, null);
    assert.equal(reembolsado.compra_status, "REFUNDED");
    assert.equal(reembolsado.compra_transacao, "HP-GPS-1");
  });

  test("order bump (outro produto na mesma compra, outra transação) não sobrescreve valor nem transação do ingresso", async () => {
    await limparInscricoes();
    const gps = await rpcOk("inscricao_salvar", { p: inscricaoGps() });
    await rpcOk("hotmart_registrar_compra", { p: compraGps() });
    const ingresso = await estadoDaCompra(gps.id);

    // A Hotmart manda um aviso por produto do pedido; o do bump chega segundos depois, com a
    // transação dele e a do ingresso em order_bump.parent_purchase_transaction.
    const bump = await rpcOk("hotmart_registrar_compra", {
      p: compraFormacao({
        transacao: "HP-BUMP-1",
        produto_id: "7777777",
        produto_nome: "Checklist do Plantão",
        oferta: "bump0001",
        valor: 47,
        evento_em: "2026-09-21T14:00:05-03:00",
        aprovado_em: "2026-09-21T14:00:05-03:00",
        payload: {
          event: "PURCHASE_APPROVED",
          data: { purchase: { transaction: "HP-BUMP-1", order_bump: { is_order_bump: true, parent_purchase_transaction: "HP-GPS-1" } } }
        }
      })
    });
    assert.equal(bump.casou, false);
    assert.equal(bump.pagina, null);
    const depois = await estadoDaCompra(gps.id);
    assert.deepEqual(depois, ingresso);
    assert.equal(depois.compra_valor, 5, "o valor é o do ingresso, e não o do bump");
    assert.equal(depois.compra_transacao, "HP-GPS-1");
  });

  test("lote novo: a oferta que o config não conhece é reconhecida pelo off= do link que a PRÓPRIA compradora abriu (o link de outra pessoa não vale)", async () => {
    await limparInscricoes();
    // O botão da página passou a abrir o lote 2 (lote2abc); o config ainda só conhece o l0r77by6.
    await rpcOk("inscricao_salvar", {
      p: inscricaoGps({ email: "outra@gmail.com", whatsapp_digits: "21998765432", whatsapp: "(21) 99876-5432", checkout_url: "https://pay.hotmart.com/R107667362D?checkoutMode=10&off=lote2abc&sck=x" })
    });
    const maria = await rpcOk("inscricao_salvar", { p: inscricaoGps({ id: randomUUID(), checkout_url: "https://pay.hotmart.com/R107667362D?off=lote2abc&checkoutMode=10" }) });
    // A mesma Maria também está na Viver de Furo, e mais recente.
    const viver = await rpcOk("inscricao_salvar", { p: inscricao({ id: randomUUID() }) });

    // Produto sem histórico: só a oferta do link da Maria pode dizer de que página ele é.
    const r = await rpcOk("hotmart_registrar_compra", { p: compraGps({ pagina: null, oferta: "lote2abc", produto_id: "6200001", valor: 10 }) });
    assert.deepEqual({ casou: r.casou, inscricao_id: r.inscricao_id, pagina: r.pagina }, { casou: true, inscricao_id: maria.id, pagina: GPS });
    assert.equal((await estadoDaCompra(maria.id)).compra_valor, 10);
    assert.deepEqual(await estadoDaCompra(viver.id), SEM_COMPRA);

    // Quem comprou o lote 2 sem passar pelo formulário. Antes, a venda ia para o GPS pelo link que
    // OUTRA pessoa (outra@gmail.com) abriu. Isso mudou de propósito: o checkout_url gravado vem do
    // /api/inscricao, que qualquer um chama. Uma inscrição inventada com o off= da Formação faria a
    // Formação dos outros virar ingresso. Agora a oferta só vale no link da própria compradora. A
    // venda de quem não se inscreveu é reconhecida quando o lote entra no config (o servidor manda
    // p.pagina), ou pelo produto, se ele já veio num aviso que o config reconheceu.
    const direto = await rpcOk("hotmart_registrar_compra", {
      p: compraGps({ pagina: null, oferta: "lote2abc", produto_id: "6200002", transacao: "HP-GPS-DIRETO", comprador_email: "direto@gmail.com", comprador_digits: "31911112222" })
    });
    assert.deepEqual({ casou: direto.casou, pagina: direto.pagina }, { casou: false, pagina: null });
    // Nem pelo produto: o 6200001 só veio pela oferta ('oferta'), e isso não ensina a página dele.
    const diretoMesmoProduto = await rpcOk("hotmart_registrar_compra", {
      p: compraGps({ pagina: null, oferta: "lote2abc", produto_id: "6200001", transacao: "HP-GPS-DIRETO-2", comprador_email: "direto@gmail.com", comprador_digits: "31911112222" })
    });
    assert.deepEqual({ casou: diretoMesmoProduto.casou, pagina: diretoMesmoProduto.pagina }, { casou: false, pagina: null });

    // Só a oferta INTEIRA vale: "lote2" (um pedaço de lote2abc) não é reconhecida.
    const pedaco = await rpcOk("hotmart_registrar_compra", { p: compraGps({ pagina: null, oferta: "lote2", produto_id: "6200003", transacao: "HP-PEDACO" }) });
    assert.deepEqual({ casou: pedaco.casou, pagina: pedaco.pagina }, { casou: false, pagina: null });
  });

  test("oferta que nenhum link abriu, de um PRODUTO que já veio num aviso com página: vale a página dele", async () => {
    await limparInscricoes();
    const gps = await rpcOk("inscricao_salvar", { p: inscricaoGps() });
    const viver = await rpcOk("inscricao_salvar", { p: inscricao({ id: randomUUID() }) });

    // 1. Um ingresso vendido para outra pessoa, reconhecido pelo config: grava o produto 6123456 com a página.
    const outra = await rpcOk("hotmart_registrar_compra", { p: compraGps({ transacao: "HP-GPS-OUTRA", comprador_email: "outra@gmail.com", comprador_digits: "21998765432" }) });
    assert.deepEqual({ casou: outra.casou, pagina: outra.pagina }, { casou: false, pagina: GPS });

    // 2. Uma oferta nova do MESMO produto (cupom, link direto) que formulário nenhum abriu.
    const r = await rpcOk("hotmart_registrar_compra", { p: compraGps({ pagina: null, oferta: "cupom50", transacao: "HP-GPS-CUPOM", valor: 2.5 }) });
    assert.deepEqual({ casou: r.casou, inscricao_id: r.inscricao_id, pagina: r.pagina }, { casou: true, inscricao_id: gps.id, pagina: GPS });
    assert.equal((await estadoDaCompra(gps.id)).compra_valor, 2.5);
    assert.deepEqual(await estadoDaCompra(viver.id), SEM_COMPRA);
  });

  test("o p.pagina do servidor manda: não é trocado pela oferta nem pelo histórico do produto", async () => {
    await limparInscricoes();
    const gps = await rpcOk("inscricao_salvar", { p: inscricaoGps() });
    const viver = await rpcOk("inscricao_salvar", { p: inscricao({ id: randomUUID() }) });
    // O produto 2332962 já tem história na Viver de Furo...
    await rpcOk("hotmart_registrar_compra", { p: compra({ transacao: "HP-FURO-OUTRA", comprador_email: "outra@gmail.com", comprador_digits: "21998765432" }) });
    // ...mas se o config disser que a venda é do GPS, é do GPS.
    const r = await rpcOk("hotmart_registrar_compra", { p: compra({ transacao: "HP-X", pagina: GPS }) });
    assert.equal(r.pagina, GPS);
    assert.equal(r.inscricao_id, gps.id);
    assert.deepEqual(await estadoDaCompra(viver.id), SEM_COMPRA);
  });

  test("idempotência continua: o mesmo aviso de novo não duplica, não remarca e responde a mesma página", async () => {
    await limparInscricoes();
    const gps = await rpcOk("inscricao_salvar", { p: inscricaoGps({ checkout_url: "https://pay.hotmart.com/R107667362D?off=lote2abc&checkoutMode=10" }) });

    const casos = [
      ["ingresso (p.pagina)", compraGps(), { casou: true, inscricao_id: gps.id, pagina: GPS }],
      ["lote novo (aprendido)", compraGps({ pagina: null, oferta: "lote2abc", produto_id: "6200001", transacao: "HP-GPS-LOTE2" }), { casou: true, inscricao_id: gps.id, pagina: GPS }],
      ["Formação (de fora)", compraFormacao(), { casou: false, inscricao_id: null, pagina: null }]
    ];
    for (const [nome, p, esperado] of casos) {
      const primeira = await rpcOk("hotmart_registrar_compra", { p });
      const estado = await estadoDaCompra(gps.id);
      const repetida = await rpcOk("hotmart_registrar_compra", { p: { ...p, hotmart_id: "aviso-reenviado", valor: 999 } });
      assert.equal(primeira.novo, true, nome);
      assert.deepEqual(primeira, { ok: true, novo: true, ...esperado }, nome);
      assert.deepEqual(repetida, { ok: true, novo: false, ...esperado }, `${nome}: repetido`);
      assert.deepEqual(await estadoDaCompra(gps.id), estado, `${nome}: o repetido não mexe na inscrição`);
    }
    const [contagem] = await stack.sql("select count(*) as n from public.compras");
    assert.equal(contagem.n, "3", "uma linha por (transacao, evento)");
  });
});

describe("inscricoes_resumo", () => {
  /*
   * O conjunto abaixo é pequeno de propósito, para os números serem conferidos À MÃO. Tudo no fuso
   * de São Paulo:
   *
   *      criado        origem    / mídia  / campanha / conteúdo / termo
   *   A  20/09 10:00  facebook  / cpc    / set / video-01 / criativo-07  3 cliques  comprou 20/09 11:00  R$ 197
   *   B  20/09 12:00  facebook  / cpc    / set / video-01 / criativo-07  1 clique   —
   *   C  20/09 15:00  instagram / social / bio / —        / —            2 cliques  comprou 21/09 09:00  R$ 297
   *   D  21/09 08:00  facebook  / cpc    / set / video-02 / criativo-09  1 clique   —
   *   E  21/09 09:30  (sem utm nenhuma; conteúdo "   ", só espaços)     1 clique   —
   *   F  21/09 23:30  (sem utm nenhuma)                                  1 clique   comprou 21/09 23:45  R$ 97
   *   G  (outra-pagina) 21/09 10:00                                      1 clique   —
   *
   *   inscritos = 6 (A..F)   cliques = 3+1+2+1+1+1 = 9   compras = 3   receita = 591,00
   *   taxa_compra = 3/6 = 50,0 %
   */
  const SP = (texto) => `${texto}-03:00`;

  before(async () => {
    await limparInscricoes();
    await inserir("inscricoes", [
      { id: randomUUID(), pagina: PAGINA, criado_em: SP("2026-09-20T10:00:00"), nome: "A", whatsapp_digits: "11900000001", email: "a@gmail.com", cliques: 3, comprou_em: SP("2026-09-20T11:00:00"), compra_valor: 197, compra_status: "APPROVED", utm_source: "facebook", utm_medium: "cpc", utm_campaign: "set", utm_content: "video-01", utm_term: "criativo-07" },
      { id: randomUUID(), pagina: PAGINA, criado_em: SP("2026-09-20T12:00:00"), nome: "B", whatsapp_digits: "11900000002", email: "b@gmail.com", cliques: 1, utm_source: "facebook", utm_medium: "cpc", utm_campaign: "set", utm_content: "video-01", utm_term: "criativo-07" },
      { id: randomUUID(), pagina: PAGINA, criado_em: SP("2026-09-20T15:00:00"), nome: "C", whatsapp_digits: "11900000003", email: "c@gmail.com", cliques: 2, comprou_em: SP("2026-09-21T09:00:00"), compra_valor: 297, compra_status: "APPROVED", utm_source: "instagram", utm_medium: "social", utm_campaign: "bio" },
      { id: randomUUID(), pagina: PAGINA, criado_em: SP("2026-09-21T08:00:00"), nome: "D", whatsapp_digits: "11900000004", email: "d@gmail.com", cliques: 1, utm_source: "facebook", utm_medium: "cpc", utm_campaign: "set", utm_content: "video-02", utm_term: "criativo-09" },
      { id: randomUUID(), pagina: PAGINA, criado_em: SP("2026-09-21T09:30:00"), nome: "E", whatsapp_digits: "11900000005", email: "e@gmail.com", cliques: 1, utm_content: "   " },
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

  test("por origem, mídia, campanha, conteúdo e termo — o termo é o sck desta página", async () => {
    const [pagina] = (await rpcOk("inscricoes_resumo", { p_pagina: PAGINA })).paginas;

    assert.deepEqual(pagina.por_origem, [
      { utm_source: "facebook", inscritos: 3, compras: 1 },
      { utm_source: "(sem utm)", inscritos: 2, compras: 1 },
      { utm_source: "instagram", inscritos: 1, compras: 1 }
    ]);
    // cpc = A, B, D (só A comprou); sem mídia = E, F (F comprou); social = C (comprou).
    assert.deepEqual(pagina.por_midia, [
      { utm_medium: "cpc", inscritos: 3, compras: 1 },
      { utm_medium: "(sem utm)", inscritos: 2, compras: 1 },
      { utm_medium: "social", inscritos: 1, compras: 1 }
    ]);
    assert.deepEqual(pagina.por_campanha, [
      { utm_campaign: "set", inscritos: 3, compras: 1 },
      { utm_campaign: "(sem utm)", inscritos: 2, compras: 1 },
      { utm_campaign: "bio", inscritos: 1, compras: 1 }
    ]);
    // Sem conteúdo = C, E (só espaços conta como vazio) e F; C e F compraram. video-01 = A, B.
    assert.deepEqual(pagina.por_conteudo, [
      { utm_content: "(sem utm)", inscritos: 3, compras: 2 },
      { utm_content: "video-01", inscritos: 2, compras: 1 },
      { utm_content: "video-02", inscritos: 1, compras: 0 }
    ]);
    assert.deepEqual(pagina.por_termo, [
      { utm_term: "(sem utm)", inscritos: 3, compras: 2 },
      { utm_term: "criativo-07", inscritos: 2, compras: 1 },
      { utm_term: "criativo-09", inscritos: 1, compras: 0 }
    ]);
    // Estes inscritos foram semeados direto na tabela, sem aviso da Hotmart: o lado da Hotmart é zero.
    assert.equal(pagina.vendas, 0);
    assert.equal(Number(pagina.vendas_receita), 0);
    assert.deepEqual(pagina.vendas_por_sck, []);
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
        por_midia: [],
        por_campanha: [],
        por_conteudo: [],
        por_termo: [],
        vendas: 0,
        vendas_receita: 0,
        vendas_por_sck: [],
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
    assert.equal(casadas[0].sck, "criativo-07", "o sck que a Hotmart devolveu vem junto");
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

describe("inscricoes_resumo: o lado da Hotmart (vendas por sck) e os avisos de cada página", () => {
  /*
   * Tudo pelas funções de verdade (inscricao_salvar + hotmart_registrar_compra), com os horários
   * fixados depois para os números serem conferidos À MÃO. Fuso de São Paulo.
   *
   * Inscritos (todos em 01/10):
   *   P1  imersao-gps   cpc / criativo-a     p1@gmail.com   (a MESMA pessoa de V1)
   *   P2  imersao-gps   cpc / criativo-b     p2@gmail.com
   *   P3  imersao-gps   (sem utm)            p3@gmail.com
   *   V1  viver-de-furo facebook / criativo-07 (termo)   p1@gmail.com
   *
   * Avisos da Hotmart (transação, evento, página do produto, comprador, sck, valor, quando):
   *   1  T1 APPROVED        gps     P1  criativo-a   5     01/10 12:00
   *   2  T2 APPROVED        gps     P2  criativo-b   5     01/10 13:00
   *   3  T3 APPROVED        gps     X   criativo-a   5     01/10 14:00   X não passou pelo formulário
   *   4  T4 APPROVED        gps     P3  (sem sck)    5     01/10 15:00
   *   5  T5 BILLET_PRINTED  gps     Y   criativo-c   5     01/10 16:00   boleto: não é venda
   *   6  T6 APPROVED        viver   V1  criativo-07  197   01/10 17:00
   *   7  T7 APPROVED        (null)  P1  criativo-a   1997  01/10 18:00   a Formação: produto de fora
   *   8  T2 REFUNDED        gps     P2  criativo-b   5     03/10 09:00
   *   9  T1 COMPLETE        gps     P1  criativo-a   5     08/10 12:00   fim da garantia
   *  10  T3 COMPLETE        gps     X   criativo-a   5     08/10 13:00
   *
   * GPS, período inteiro: vendas = T1, T3, T4 (T2 foi reembolsada; T5 é boleto) = 3, R$ 15.
   *   criativo-a = T1 + T3 = 2 vendas (aprovada + completa da mesma transação = UMA), 1 casada.
   *   (sem sck) = T4 = 1 venda, casada.
   */
  const SP = (texto) => `${texto}-03:00`;
  const PESSOAS = {
    P1: { email: "p1@gmail.com", digits: "11900000011", whatsapp: "(11) 90000-0011" },
    P2: { email: "p2@gmail.com", digits: "11900000012", whatsapp: "(11) 90000-0012" },
    P3: { email: "p3@gmail.com", digits: "11900000013", whatsapp: "(11) 90000-0013" },
    X: { email: "x@gmail.com", digits: "11900000099" },
    Y: { email: "y@gmail.com", digits: "11900000098" }
  };
  const AVISOS = [
    ["HP-T1", "PURCHASE_APPROVED", GPS, "P1", "criativo-a", 5, "2026-10-01T12:00:00"],
    ["HP-T2", "PURCHASE_APPROVED", GPS, "P2", "criativo-b", 5, "2026-10-01T13:00:00"],
    ["HP-T3", "PURCHASE_APPROVED", GPS, "X", "criativo-a", 5, "2026-10-01T14:00:00"],
    ["HP-T4", "PURCHASE_APPROVED", GPS, "P3", null, 5, "2026-10-01T15:00:00"],
    ["HP-T5", "PURCHASE_BILLET_PRINTED", GPS, "Y", "criativo-c", 5, "2026-10-01T16:00:00"],
    ["HP-T6", "PURCHASE_APPROVED", PAGINA, "P1", "criativo-07", 197, "2026-10-01T17:00:00"],
    ["HP-T7", "PURCHASE_APPROVED", null, "P1", "criativo-a", 1997, "2026-10-01T18:00:00"],
    ["HP-T2", "PURCHASE_REFUNDED", GPS, "P2", "criativo-b", 5, "2026-10-03T09:00:00"],
    ["HP-T1", "PURCHASE_COMPLETE", GPS, "P1", "criativo-a", 5, "2026-10-08T12:00:00"],
    ["HP-T3", "PURCHASE_COMPLETE", GPS, "X", "criativo-a", 5, "2026-10-08T13:00:00"]
  ];
  const STATUS = {
    PURCHASE_APPROVED: "APPROVED",
    PURCHASE_COMPLETE: "COMPLETED",
    PURCHASE_REFUNDED: "REFUNDED",
    PURCHASE_BILLET_PRINTED: "PRINTED_BILLET"
  };
  const ids = {};

  before(async () => {
    await limparInscricoes();
    const contato = (quem) => ({ email: PESSOAS[quem].email, whatsapp_digits: PESSOAS[quem].digits, whatsapp: PESSOAS[quem].whatsapp });
    const semUtm = { utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null, checkout_url: "https://pay.hotmart.com/R107667362D?off=l0r77by6&checkoutMode=10" };
    ids.P1 = (await rpcOk("inscricao_salvar", { p: inscricaoGps({ ...contato("P1"), utm_content: "criativo-a" }) })).id;
    ids.P2 = (await rpcOk("inscricao_salvar", { p: inscricaoGps({ id: randomUUID(), ...contato("P2"), utm_content: "criativo-b" }) })).id;
    ids.P3 = (await rpcOk("inscricao_salvar", { p: inscricaoGps({ id: randomUUID(), ...contato("P3"), ...semUtm }) })).id;
    ids.V1 = (await rpcOk("inscricao_salvar", { p: inscricao({ id: randomUUID(), ...contato("P1") }) })).id;
    const criados = [["P1", "10:00"], ["P2", "10:10"], ["P3", "10:20"], ["V1", "10:30"]];
    for (const [quem, hora] of criados) {
      await stack.sql(`update public.inscricoes set criado_em = '${SP(`2026-10-01T${hora}:00`)}' where id = '${ids[quem]}' returning 1 as ok`);
    }

    for (const [transacao, evento, pagina, quem, sck, valor, quando] of AVISOS) {
      const aprovado = evento === "PURCHASE_APPROVED" || evento === "PURCHASE_COMPLETE";
      const primeiraAprovacao = AVISOS.find((a) => a[0] === transacao && a[1] === "PURCHASE_APPROVED");
      const base = pagina === null ? compraFormacao : pagina === GPS ? compraGps : compra;
      await rpcOk("hotmart_registrar_compra", {
        p: base({
          transacao,
          evento,
          status: STATUS[evento],
          pagina,
          comprador_email: PESSOAS[quem].email,
          comprador_digits: `55${PESSOAS[quem].digits}`,
          comprador_nome: quem,
          sck,
          valor,
          evento_em: SP(quando),
          pedido_em: SP(primeiraAprovacao ? primeiraAprovacao[6] : quando),
          aprovado_em: aprovado ? SP(primeiraAprovacao[6]) : null
        })
      });
    }
    // recebido_em é o now() de cada chamada: fixa no horário da tabela acima.
    const valores = AVISOS.map(([transacao, evento, , , , , quando]) => `(${lit(transacao)}, ${lit(evento)}, ${lit(SP(quando))})`).join(", ");
    await stack.sql(`
      update public.compras as c set recebido_em = v.quando::timestamptz
      from (values ${valores}) as v(transacao, evento, quando)
      where c.transacao = v.transacao and c.evento = v.evento
      returning 1 as ok
    `);
    const [contagem] = await stack.sql("select count(*) as n, count(*) filter (where recebido_em < '2026-10-01') as fora from public.compras");
    assert.deepEqual(contagem, { n: "10", fora: "0" }, "os 10 avisos gravados, todos com o horário fixado");
  });

  const recentes = (resumo) => resumo.compras_recentes.map((c) => [c.evento, c.comprador_email, c.sck, c.casou, c.pagina]);

  test("GPS, período inteiro: vendas e receita do lado da Hotmart, e vendas_por_sck com '(sem sck)'", async () => {
    const resumo = await rpcOk("inscricoes_resumo", { p_pagina: GPS });
    assert.equal(resumo.paginas.length, 1);
    const [gps] = resumo.paginas;
    assert.equal(gps.pagina, GPS);

    // O lado do formulário: P1 e P3 compraram; a compra de P2 foi reembolsada.
    assert.equal(gps.inscritos, 3);
    assert.equal(gps.compras, 2);
    assert.equal(Number(gps.receita), 10);
    assert.equal(Number(gps.taxa_compra), 66.7);

    // O lado da Hotmart: T1, T3 e T4. T2 saiu com o reembolso; o boleto (T5) não é venda.
    assert.equal(gps.vendas, 3);
    assert.equal(Number(gps.vendas_receita), 15);
    assert.deepEqual(gps.vendas_por_sck, [
      // T1 e T3 chegaram aprovadas E completas: continuam sendo 2 vendas, e não 4.
      { sck: "criativo-a", vendas: 2, receita: 10, casadas: 1 },
      { sck: "(sem sck)", vendas: 1, receita: 5, casadas: 1 }
    ]);
    assert.ok(!gps.vendas_por_sck.some((s) => s.sck === "criativo-b"), "reembolsada não aparece");
    assert.ok(!gps.vendas_por_sck.some((s) => s.sck === "criativo-c"), "boleto não aparece");
  });

  test("GPS: por mídia e por conteúdo (o utm_content é o sck desta página)", async () => {
    const [gps] = (await rpcOk("inscricoes_resumo", { p_pagina: GPS })).paginas;
    assert.deepEqual(gps.por_midia, [
      { utm_medium: "cpc", inscritos: 2, compras: 1 },
      { utm_medium: "(sem utm)", inscritos: 1, compras: 1 }
    ]);
    // Empate em 1 inscrito e 1 compra: desempata pelo texto em "C" — "(" vem antes de "c".
    assert.deepEqual(gps.por_conteudo, [
      { utm_content: "(sem utm)", inscritos: 1, compras: 1 },
      { utm_content: "criativo-a", inscritos: 1, compras: 1 },
      { utm_content: "criativo-b", inscritos: 1, compras: 0 }
    ]);
  });

  test("com p_pagina, os avisos são só os do produto da página: a Formação (pagina null) e a outra página não entram", async () => {
    const gps = await rpcOk("inscricoes_resumo", { p_pagina: GPS });
    // Só T3 (aprovada e completa: UMA transação) é compra do GPS sem inscrição. T7 é de fora.
    assert.equal(gps.compras_sem_inscricao, 1);
    assert.deepEqual(recentes(gps), [
      ["PURCHASE_COMPLETE", "x@gmail.com", "criativo-a", false, GPS],
      ["PURCHASE_COMPLETE", "p1@gmail.com", "criativo-a", true, GPS],
      ["PURCHASE_REFUNDED", "p2@gmail.com", "criativo-b", true, GPS],
      ["PURCHASE_BILLET_PRINTED", "y@gmail.com", "criativo-c", false, GPS],
      ["PURCHASE_APPROVED", "p3@gmail.com", null, true, GPS],
      ["PURCHASE_APPROVED", "x@gmail.com", "criativo-a", false, GPS],
      ["PURCHASE_APPROVED", "p2@gmail.com", "criativo-b", true, GPS],
      ["PURCHASE_APPROVED", "p1@gmail.com", "criativo-a", true, GPS]
    ]);

    const viver = await rpcOk("inscricoes_resumo", { p_pagina: PAGINA });
    const [pagina] = viver.paginas;
    assert.deepEqual([pagina.inscritos, pagina.compras, Number(pagina.receita)], [1, 1, 197], "V1, a mesma pessoa de P1, comprou só a Viver");
    assert.equal(pagina.vendas, 1);
    assert.equal(Number(pagina.vendas_receita), 197);
    assert.deepEqual(pagina.vendas_por_sck, [{ sck: "criativo-07", vendas: 1, receita: 197, casadas: 1 }]);
    assert.equal(viver.compras_sem_inscricao, 0, "nem a Formação nem o X do GPS contam aqui");
    assert.deepEqual(recentes(viver), [["PURCHASE_APPROVED", "p1@gmail.com", "criativo-07", true, PAGINA]]);
  });

  test("sem p_pagina: cada página com as vendas dela; os avisos de fora aparecem na lista e na contagem sem inscrição", async () => {
    const resumo = await rpcOk("inscricoes_resumo", {});
    assert.deepEqual(
      resumo.paginas.map((p) => [p.pagina, p.inscritos, p.vendas, Number(p.vendas_receita), p.vendas_por_sck.map((s) => [s.sck, s.vendas])]),
      [
        [GPS, 3, 3, 15, [["criativo-a", 2], ["(sem sck)", 1]]],
        [PAGINA, 1, 1, 197, [["criativo-07", 1]]]
      ]
    );
    // T3 (GPS, sem inscrição) + T7 (a Formação, que não casa com ninguém): 2 transações.
    assert.equal(resumo.compras_sem_inscricao, 2);
    assert.equal(resumo.compras_recentes.length, 10);
    const formacao = resumo.compras_recentes.find((c) => Number(c.valor) === 1997);
    assert.deepEqual(
      { pagina: formacao.pagina, casou: formacao.casou, sck: formacao.sck, evento: formacao.evento },
      { pagina: null, casou: false, sck: "criativo-a", evento: "PURCHASE_APPROVED" }
    );
  });

  test("o período: o estado de cada venda sai do histórico ATÉ o fim do período (pela hora do evento), e ela conta no período da primeira aprovação", async () => {
    // Só o dia 01/10: o reembolso de T2 (03/10) ainda não tinha acontecido até o fim do período, então
    // T2 conta.
    const dia1 = await rpcOk("inscricoes_resumo", { p_desde: SP("2026-10-01T00:00:00"), p_ate: SP("2026-10-02T00:00:00"), p_pagina: GPS });
    const [gps1] = dia1.paginas;
    assert.equal(gps1.vendas, 4);
    assert.equal(Number(gps1.vendas_receita), 20);
    assert.deepEqual(gps1.vendas_por_sck, [
      { sck: "criativo-a", vendas: 2, receita: 10, casadas: 1 },
      { sck: "(sem sck)", vendas: 1, receita: 5, casadas: 1 },
      { sck: "criativo-b", vendas: 1, receita: 5, casadas: 1 }
    ]);
    assert.equal(dia1.compras_sem_inscricao, 1, "T3");
    assert.equal(dia1.compras_recentes.length, 5, "T1, T2, T3, T4 aprovadas e o boleto T5");

    // O fim do período é que decide o que já tinha acontecido: até 02/10 (inclusive) o reembolso de
    // 03/10 09:00 ainda não existia; até 03/10 (inclusive), já.
    const ate02 = await rpcOk("inscricoes_resumo", { p_desde: SP("2026-10-01T00:00:00"), p_ate: SP("2026-10-03T00:00:00"), p_pagina: GPS });
    assert.deepEqual([ate02.paginas[0].vendas, Number(ate02.paginas[0].vendas_receita)], [4, 20], "01/10 a 02/10: T2 ainda conta");
    const ate03 = await rpcOk("inscricoes_resumo", { p_desde: SP("2026-10-01T00:00:00"), p_ate: SP("2026-10-04T00:00:00"), p_pagina: GPS });
    const [gps3] = ate03.paginas;
    assert.deepEqual([gps3.vendas, Number(gps3.vendas_receita)], [3, 15], "01/10 a 03/10: T2 foi reembolsada");
    assert.deepEqual(gps3.vendas_por_sck, [
      { sck: "criativo-a", vendas: 2, receita: 10, casadas: 1 },
      { sck: "(sem sck)", vendas: 1, receita: 5, casadas: 1 }
    ]);
    assert.equal(ate03.compras_sem_inscricao, 1, "T3");

    // De 02/10 em diante: nenhuma venda NOVA. T1 e T3 só completaram (08/10) — são vendas de 01/10 —,
    // e o reembolso de T2 tira uma venda de 01/10, e não uma deste período. A página pedida aparece
    // mesmo zerada.
    const depois = await rpcOk("inscricoes_resumo", { p_desde: SP("2026-10-02T00:00:00"), p_pagina: GPS });
    const [gps2] = depois.paginas;
    assert.equal(gps2.pagina, GPS);
    assert.equal(gps2.inscritos, 0);
    assert.equal(gps2.vendas, 0);
    assert.equal(Number(gps2.vendas_receita), 0);
    assert.deepEqual(gps2.vendas_por_sck, []);
    assert.equal(depois.compras_sem_inscricao, 0, "T3 completou no período, mas é venda de 01/10");
    // A LISTA de avisos continua sendo a do período, pela chegada.
    assert.deepEqual(
      depois.compras_recentes.map((c) => [c.evento, c.comprador_email]),
      [
        ["PURCHASE_COMPLETE", "x@gmail.com"],
        ["PURCHASE_COMPLETE", "p1@gmail.com"],
        ["PURCHASE_REFUNDED", "p2@gmail.com"]
      ]
    );

    // Sem p_pagina, a mesma régua. 01/10: as duas páginas, e a Formação (T7) conta como sem inscrição.
    const dia1Todas = await rpcOk("inscricoes_resumo", { p_desde: SP("2026-10-01T00:00:00"), p_ate: SP("2026-10-02T00:00:00") });
    assert.deepEqual(
      dia1Todas.paginas.map((p) => [p.pagina, p.inscritos, p.vendas, Number(p.vendas_receita)]),
      [
        [GPS, 3, 4, 20],
        [PAGINA, 1, 1, 197]
      ]
    );
    assert.equal(dia1Todas.compras_sem_inscricao, 2, "T3 e a Formação (T7)");
    // De 02/10 em diante nenhuma página tem inscrição nem venda: a lista de páginas fica vazia.
    const depoisTodas = await rpcOk("inscricoes_resumo", { p_desde: SP("2026-10-02T00:00:00") });
    assert.deepEqual(depoisTodas.paginas, []);
    assert.equal(depoisTodas.compras_sem_inscricao, 0);
    assert.equal(depoisTodas.compras_recentes.length, 3);
  });

  test("as inscrições ficaram com o estado certo: a Formação não mexeu em P1, e o reembolso desmarcou P2", async () => {
    const p1 = await linhaInscricao(ids.P1);
    assert.ok(p1.comprou_em);
    assert.equal(Number(p1.compra_valor), 5);
    assert.equal(p1.compra_transacao, "HP-T1");
    assert.equal(p1.compra_status, "COMPLETED");
    const v1 = await linhaInscricao(ids.V1);
    assert.equal(Number(v1.compra_valor), 197);
    assert.equal(v1.compra_transacao, "HP-T6");
    const p2 = await linhaInscricao(ids.P2);
    assert.equal(p2.comprou_em, null);
    assert.equal(p2.compra_status, "REFUNDED");
  });
});

/*
 * A régua das vendas do lado da Hotmart, caso a caso:
 *   . o ESTADO de uma venda (transação) é o do último EVENTO dela (evento_em, a hora na Hotmart; a
 *     chegada só desempata), no histórico INTEIRO até o fim do período — e não só nos avisos que
 *     chegaram dentro dele;
 *   . a venda conta no período da PRIMEIRA aprovação (aprovado_em dos APPROVED/COMPLETE).
 * Cada teste semeia o seu cenário pelas funções de verdade e fixa a CHEGADA de cada aviso
 * (recebido_em): é ela que diz o que já se sabia no fim do período. Fuso de São Paulo.
 */

/** Compradores que não passaram por formulário nenhum (os 8 dígitos finais não batem com ninguém). */
const ORFA = {
  X: { comprador_email: "x@gmail.com", comprador_digits: "5511900000099", comprador_nome: "X" },
  Y: { comprador_email: "y@gmail.com", comprador_digits: "5511900000098", comprador_nome: "Y" },
  Z: { comprador_email: "z@gmail.com", comprador_digits: "5511900000097", comprador_nome: "Z" },
  W: { comprador_email: "w@gmail.com", comprador_digits: "5511900000096", comprador_nome: "W" }
};

describe("inscricoes_resumo: o estado de cada venda (hora do evento) e o período da aprovação", () => {
  const SP = (texto) => `${texto}-03:00`;
  /** O dia d de setembro de 2026 em São Paulo: [00:00 do dia, 00:00 do dia seguinte). */
  const DIA = (d) => [SP(`2026-09-${String(d).padStart(2, "0")}T00:00:00`), SP(`2026-09-${String(d + 1).padStart(2, "0")}T00:00:00`)];
  const NADA = { vendas: 0, receita: 0, por_sck: [], sem_inscricao: 0 };

  /** Grava a inscrição e fixa o cadastro (fora de todos os recortes dos testes, por padrão). */
  async function inscrever(p, criado = SP("2026-09-10T10:00:00")) {
    const { id } = await rpcOk("inscricao_salvar", { p });
    await stack.sql(`update public.inscricoes set criado_em = ${lit(criado)}::timestamptz where id = ${lit(id)} returning 1 as ok`);
    return id;
  }

  /** Grava o aviso pela função e fixa a CHEGADA (por padrão, a própria hora do evento). */
  async function avisar(p, recebido = p.evento_em) {
    const r = await rpcOk("hotmart_registrar_compra", { p });
    assert.equal(r.novo, true, `${p.transacao} ${p.evento} é um aviso novo`);
    await stack.sql(`
      update public.compras set recebido_em = ${lit(recebido)}::timestamptz
      where transacao = ${lit(p.transacao)} and evento = ${lit(p.evento)} returning 1 as ok
    `);
    return r;
  }

  const aprovacao = (transacao, quando, extra = {}) =>
    compraGps({ transacao, evento_em: SP(quando), pedido_em: SP(quando), aprovado_em: SP(quando), ...extra });
  const reembolso = (transacao, quando, extra = {}) =>
    compraGps({ transacao, evento: "PURCHASE_REFUNDED", status: "REFUNDED", evento_em: SP(quando), aprovado_em: null, ...extra });
  const completa = (transacao, quando, aprovadoEm, extra = {}) =>
    compraGps({ transacao, evento: "PURCHASE_COMPLETE", status: "COMPLETED", evento_em: SP(quando), pedido_em: aprovadoEm, aprovado_em: aprovadoEm, ...extra });

  const resumo = (p_pagina, [p_desde, p_ate] = []) => rpcOk("inscricoes_resumo", { p_desde, p_ate, p_pagina });
  /** Os números de venda da (única) página do resumo. */
  function numeros(r) {
    assert.equal(r.paginas.length, 1);
    const [linha] = r.paginas;
    return { vendas: linha.vendas, receita: Number(linha.vendas_receita), por_sck: linha.vendas_por_sck, sem_inscricao: r.compras_sem_inscricao };
  }
  const casadas = (n) => n.por_sck.reduce((soma, s) => soma + s.casadas, 0);

  test("a Hotmart entrega o APPROVED velho DEPOIS do REFUNDED: vale a ordem dos eventos, e não a da chegada", async () => {
    await limparInscricoes();
    const p1 = await inscrever(inscricaoGps());

    // Aprovada em 20/09 e reembolsada em 22/09. O aviso do reembolso chega na hora; o da aprovação
    // tinha falhado e só é entregue em 23/09 — é o último a CHEGAR, mas não o último EVENTO.
    await avisar(reembolso("HP-VOLTA", "2026-09-22T10:00:00"));
    const atrasado = await avisar(aprovacao("HP-VOLTA", "2026-09-20T10:00:00"), SP("2026-09-23T10:00:00"));
    assert.deepEqual({ casou: atrasado.casou, inscricao_id: atrasado.inscricao_id }, { casou: true, inscricao_id: p1 });

    assert.deepEqual(numeros(await resumo(GPS)), NADA, "tudo: a venda foi reembolsada");
    const dia23 = await resumo(GPS, DIA(23));
    assert.deepEqual(numeros(dia23), NADA, "o dia em que a aprovação chegou não ganha venda");
    assert.deepEqual(dia23.compras_recentes.map((c) => c.evento), ["PURCHASE_APPROVED"], "o aviso aparece na lista do dia");
    assert.deepEqual(numeros(await resumo(GPS, [DIA(20)[0], DIA(23)[1]])), NADA, "20/09 a 23/09");

    const todas = await rpcOk("inscricoes_resumo", {});
    assert.deepEqual(todas.paginas.map((p) => [p.pagina, p.inscritos, p.vendas, p.vendas_por_sck]), [[GPS, 1, 0, []]]);
    assert.equal(todas.compras_sem_inscricao, 0);

    // A inscrição continua desmarcada: a aprovação é mais antiga do que o reembolso.
    const estado = await estadoDaCompra(p1);
    assert.equal(estado.comprou_em, null);
    assert.equal(estado.compra_status, "REFUNDED");
    assert.equal(estado.compra_transacao, "HP-VOLTA");
    assert.equal(estado.compra_valor, null, "o valor da aprovação atrasada não entra");
    assert.equal(new Date(estado.compra_evento_em).toISOString(), "2026-09-22T13:00:00.000Z");

    // E o REENVIO do mesmo APPROVED (a Hotmart repete até receber 2xx) também não muda nada.
    const repetido = await rpcOk("hotmart_registrar_compra", { p: { ...aprovacao("HP-VOLTA", "2026-09-20T10:00:00"), hotmart_id: "aviso-reenviado" } });
    assert.equal(repetido.novo, false);
    assert.deepEqual(numeros(await resumo(GPS)), NADA);
    assert.deepEqual(await estadoDaCompra(p1), estado);
  });

  for (const [nome, aprovadoNoComplete] of [
    ["o COMPLETE traz a data da aprovação original", SP("2026-09-20T10:00:00")],
    ["o COMPLETE vem sem approved_date", null]
  ]) {
    test(`APPROVED em 20/09 e COMPLETE em 24/09 (${nome}): a venda é de 20/09 — aparece no recorte de 20/09, não no de 24/09, e conta 1 no total`, async () => {
      await limparInscricoes();
      const p1 = await inscrever(inscricaoGps());
      await avisar(aprovacao("HP-GARANTIA", "2026-09-20T10:00:00"));
      await avisar(completa("HP-GARANTIA", "2026-09-24T10:00:00", aprovadoNoComplete));

      const UMA = { vendas: 1, receita: 5, por_sck: [{ sck: "criativo-gps-07", vendas: 1, receita: 5, casadas: 1 }], sem_inscricao: 0 };
      assert.deepEqual(numeros(await resumo(GPS)), UMA, "tudo: uma venda, e não duas (APPROVED + COMPLETE da mesma transação)");
      assert.deepEqual(numeros(await resumo(GPS, DIA(20))), UMA, "o dia da aprovação");
      const dia24 = await resumo(GPS, DIA(24));
      assert.deepEqual(numeros(dia24), NADA, "o fim da garantia não é venda nova");
      assert.deepEqual(dia24.compras_recentes.map((c) => c.evento), ["PURCHASE_COMPLETE"], "mas o aviso aparece na lista do dia");
      assert.deepEqual(numeros(await resumo(GPS, [DIA(20)[0], DIA(24)[1]])), UMA, "20/09 a 24/09");
      assert.deepEqual(numeros(await resumo(GPS, [DIA(21)[0], DIA(24)[1]])), NADA, "21/09 a 24/09");

      const estado = await estadoDaCompra(p1);
      assert.equal(estado.compra_status, "COMPLETED");
      assert.equal(estado.compra_transacao, "HP-GARANTIA");
      if (aprovadoNoComplete) assert.equal(new Date(estado.comprou_em).toISOString(), "2026-09-20T13:00:00.000Z");
    });
  }

  // P1 (inscrita) e X (sem inscrição) compram em 20/09 e são reembolsadas em 23/09.
  async function semearReembolsoEm23() {
    await limparInscricoes();
    const p1 = await inscrever(inscricaoGps());
    await avisar(aprovacao("HP-R1", "2026-09-20T10:00:00"));
    await avisar(aprovacao("HP-R2", "2026-09-20T11:00:00", ORFA.X));
    await avisar(reembolso("HP-R1", "2026-09-23T10:00:00"));
    await avisar(reembolso("HP-R2", "2026-09-23T11:00:00", ORFA.X));
    return p1;
  }

  test("aprovada no período e reembolsada DEPOIS do fim dele: conta no período (até p_ate o reembolso não tinha acontecido)", async () => {
    await semearReembolsoEm23();
    const DUAS = { vendas: 2, receita: 10, por_sck: [{ sck: "criativo-gps-07", vendas: 2, receita: 10, casadas: 1 }], sem_inscricao: 1 };
    assert.deepEqual(numeros(await resumo(GPS, DIA(20))), DUAS, "o dia 20/09");
    // Até 23/09 00:00 (exclusivo): os reembolsos, de 23/09 10:00 e 11:00, ainda não tinham acontecido.
    assert.deepEqual(numeros(await resumo(GPS, [DIA(20)[0], DIA(23)[0]])), DUAS, "20/09 a 22/09");
    // Um período que já inclui os reembolsos: as duas saem.
    assert.deepEqual(numeros(await resumo(GPS, [DIA(20)[0], DIA(23)[1]])), NADA, "20/09 a 23/09");
    assert.deepEqual(numeros(await resumo(GPS)), NADA, "tudo");

    // Sem p_pagina, o mesmo; e a página entra só pelas vendas (a inscrição é de 10/09).
    const todas = await rpcOk("inscricoes_resumo", { p_desde: DIA(20)[0], p_ate: DIA(20)[1] });
    assert.deepEqual(todas.paginas.map((p) => [p.pagina, p.inscritos, p.vendas, Number(p.vendas_receita)]), [[GPS, 0, 2, 10]]);
    assert.equal(todas.compras_sem_inscricao, 1);
  });

  test("aprovada ANTES do período e reembolsada DENTRO dele: não conta no período (nem como venda, nem como sem inscrição)", async () => {
    await semearReembolsoEm23();
    const dia23 = await resumo(GPS, DIA(23));
    assert.deepEqual(numeros(dia23), NADA);
    assert.deepEqual(
      dia23.compras_recentes.map((c) => [c.evento, c.comprador_email]),
      [
        ["PURCHASE_REFUNDED", "x@gmail.com"],
        ["PURCHASE_REFUNDED", "maria@gmail.com"]
      ],
      "os reembolsos aparecem na lista do dia"
    );
    // Entre a aprovação e o reembolso também não há venda NOVA: 21/09 e 22/09 ficam zerados.
    assert.deepEqual(numeros(await resumo(GPS, [DIA(21)[0], DIA(22)[1]])), NADA, "21/09 a 22/09");
    // E o reembolso não "desconta" do período dele: 23/09 a 24/09 é zero, e não −2.
    assert.deepEqual(numeros(await resumo(GPS, [DIA(23)[0], DIA(24)[1]])), NADA, "23/09 a 24/09");
    const todas = await rpcOk("inscricoes_resumo", { p_desde: DIA(23)[0], p_ate: DIA(23)[1] });
    assert.deepEqual(todas.paginas, [], "sem p_pagina: nenhuma página teve inscrição nem venda em 23/09");
    assert.equal(todas.compras_sem_inscricao, 0);
  });

  test("compras_sem_inscricao = vendas − casadas: a venda sem inscrição reembolsada não conta, a completa conta uma vez, o boleto não conta", async () => {
    await limparInscricoes();
    await inscrever(inscricaoGps());
    const P2 = { comprador_email: "p2@gmail.com", comprador_digits: "5511900000012", comprador_nome: "P2" };
    await inscrever(inscricaoGps({ id: randomUUID(), email: "p2@gmail.com", whatsapp_digits: "11900000012", whatsapp: "(11) 90000-0012" }));

    //   A  P1 (casada)   criativo-a  aprovada 20/09
    //   B  X  (órfã)     criativo-a  aprovada 20/09
    //   C  Y  (órfã)     criativo-b  aprovada 20/09, reembolsada 21/09
    //   D  Z  (órfã)     criativo-c  aprovada 20/09, completa 22/09
    //   E  W  (órfã)     criativo-c  boleto impresso 20/09 — não é venda
    //   F  P2 (casada)   criativo-b  aprovada 20/09, reembolsada 21/09
    await avisar(aprovacao("HP-A", "2026-09-20T10:00:00", { sck: "criativo-a" }));
    await avisar(aprovacao("HP-B", "2026-09-20T11:00:00", { sck: "criativo-a", ...ORFA.X }));
    await avisar(aprovacao("HP-C", "2026-09-20T12:00:00", { sck: "criativo-b", ...ORFA.Y }));
    await avisar(aprovacao("HP-D", "2026-09-20T13:00:00", { sck: "criativo-c", ...ORFA.Z }));
    await avisar(compraGps({ transacao: "HP-E", evento: "PURCHASE_BILLET_PRINTED", status: "PRINTED_BILLET", evento_em: SP("2026-09-20T14:00:00"), aprovado_em: null, sck: "criativo-c", ...ORFA.W }));
    await avisar(aprovacao("HP-F", "2026-09-20T15:00:00", { sck: "criativo-b", ...P2 }));
    await avisar(reembolso("HP-C", "2026-09-21T12:00:00", { sck: "criativo-b", ...ORFA.Y }));
    await avisar(reembolso("HP-F", "2026-09-21T15:00:00", { sck: "criativo-b", ...P2 }));
    await avisar(completa("HP-D", "2026-09-22T13:00:00", SP("2026-09-20T13:00:00"), { sck: "criativo-c", ...ORFA.Z }));

    // Tudo: A, B e D (C e F reembolsadas; E é boleto). Casada só A: sem inscrição = 3 − 1 = 2 (B e D).
    const tudo = numeros(await resumo(GPS));
    assert.deepEqual(tudo, {
      vendas: 3,
      receita: 15,
      por_sck: [
        { sck: "criativo-a", vendas: 2, receita: 10, casadas: 1 },
        { sck: "criativo-c", vendas: 1, receita: 5, casadas: 0 }
      ],
      sem_inscricao: 2
    });
    assert.equal(tudo.sem_inscricao, tudo.vendas - casadas(tudo));

    // Até o fim de 20/09 C e F ainda não tinham sido reembolsadas: A, B, C, D e F; casadas A e F;
    // sem inscrição = 5 − 2 = 3 (B, C e D).
    const dia20 = numeros(await resumo(GPS, DIA(20)));
    assert.deepEqual(dia20, {
      vendas: 5,
      receita: 25,
      por_sck: [
        { sck: "criativo-a", vendas: 2, receita: 10, casadas: 1 },
        { sck: "criativo-b", vendas: 2, receita: 10, casadas: 1 },
        { sck: "criativo-c", vendas: 1, receita: 5, casadas: 0 }
      ],
      sem_inscricao: 3
    });
    assert.equal(dia20.sem_inscricao, dia20.vendas - casadas(dia20));

    // Os dias seguintes não têm venda nova (reembolso e fim de garantia não são venda).
    assert.deepEqual(numeros(await resumo(GPS, [DIA(21)[0], DIA(22)[1]])), NADA);

    // Sem p_pagina, a mesma conta (só há a página do GPS).
    const todas = await rpcOk("inscricoes_resumo", {});
    assert.equal(todas.paginas.length, 1);
    const [gps] = todas.paginas;
    assert.equal(todas.compras_sem_inscricao, 2);
    assert.equal(todas.compras_sem_inscricao, gps.vendas - gps.vendas_por_sck.reduce((soma, s) => soma + s.casadas, 0));
  });

  test("sem p_pagina: a página que só teve VENDA no período (nenhuma inscrição nele) aparece em paginas", async () => {
    await limparInscricoes();
    await inscrever(inscricao(), SP("2026-09-22T10:00:00")); // Viver de Furo: inscrição NO período
    await inscrever(inscricaoGps({ id: randomUUID(), email: "gps@gmail.com", whatsapp_digits: "11900000021" }), SP("2026-09-18T10:00:00")); // GPS: fora dele

    // GPS: uma venda no período, de quem não passou pelo formulário.
    await avisar(aprovacao("HP-GPS-22", "2026-09-22T12:00:00", ORFA.X));
    // A Formação (produto de fora, pagina null), no mesmo dia: não vira uma página "null".
    await avisar(compraFormacao({ transacao: "HP-FORM-22", evento_em: SP("2026-09-22T13:00:00"), pedido_em: SP("2026-09-22T13:00:00"), aprovado_em: SP("2026-09-22T13:00:00"), ...ORFA.Y }));
    // outra-pagina: aprovada em 20/09 e completa em 22/09 — a venda é de 20/09, e não de 22/09.
    const outra = { pagina: "outra-pagina", produto_id: "5550001", oferta: "outra001", ...ORFA.Z };
    await avisar(compra({ transacao: "HP-OUTRA", evento_em: SP("2026-09-20T09:00:00"), pedido_em: SP("2026-09-20T09:00:00"), aprovado_em: SP("2026-09-20T09:00:00"), ...outra }));
    await avisar(compra({ transacao: "HP-OUTRA", evento: "PURCHASE_COMPLETE", status: "COMPLETED", evento_em: SP("2026-09-22T09:00:00"), pedido_em: SP("2026-09-20T09:00:00"), aprovado_em: SP("2026-09-20T09:00:00"), ...outra }));
    // mais-uma-pagina: aprovada e reembolsada no próprio dia 22/09 — não é venda.
    const maisUma = { pagina: "mais-uma-pagina", produto_id: "5550002", oferta: "mais0001", ...ORFA.W };
    await avisar(compra({ transacao: "HP-REEMB", evento_em: SP("2026-09-22T08:00:00"), pedido_em: SP("2026-09-22T08:00:00"), aprovado_em: SP("2026-09-22T08:00:00"), ...maisUma }));
    await avisar(compra({ transacao: "HP-REEMB", evento: "PURCHASE_REFUNDED", status: "REFUNDED", evento_em: SP("2026-09-22T18:00:00"), aprovado_em: null, ...maisUma }));

    const dia22 = await rpcOk("inscricoes_resumo", { p_desde: DIA(22)[0], p_ate: DIA(22)[1] });
    assert.deepEqual(
      dia22.paginas.map((p) => [p.pagina, p.inscritos, p.vendas, Number(p.vendas_receita)]),
      [
        [GPS, 0, 1, 5],
        [PAGINA, 1, 0, 0]
      ]
    );
    const [gps] = dia22.paginas;
    assert.deepEqual(
      {
        cliques: gps.cliques,
        compras: gps.compras,
        taxa_compra: Number(gps.taxa_compra),
        por_origem: gps.por_origem,
        por_dia: gps.por_dia,
        vendas_por_sck: gps.vendas_por_sck
      },
      { cliques: 0, compras: 0, taxa_compra: 0, por_origem: [], por_dia: [], vendas_por_sck: [{ sck: "criativo-gps-07", vendas: 1, receita: 5, casadas: 0 }] },
      "o lado do formulário zerado, o da Hotmart com a venda"
    );
    assert.equal(dia22.compras_sem_inscricao, 2, "a do GPS e a Formação");

    // Tudo: outra-pagina entra (a venda de 20/09 continua valendo); mais-uma-pagina não (reembolsada).
    const tudo = await rpcOk("inscricoes_resumo", {});
    assert.deepEqual(
      tudo.paginas.map((p) => [p.pagina, p.inscritos, p.vendas, Number(p.vendas_receita)]),
      [
        [GPS, 1, 1, 5],
        ["outra-pagina", 0, 1, 197],
        [PAGINA, 1, 0, 0]
      ]
    );
    assert.equal(tudo.compras_sem_inscricao, 3, "GPS, Formação e outra-pagina");
  });
});

describe("hotmart_registrar_compra: pagina_por (de onde veio a página) e evento_em", () => {
  async function gravadas() {
    const r = await chamar("GET", "compras?select=id,transacao,produto_id,pagina,pagina_por,inscricao_id,evento_em,recebido_em&order=id");
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  }

  // A régua mudou de propósito. Antes, HP-PRODUTO aprendia a página do 6200001 com HP-OFERTA
  // ('oferta'), e HP-PRODUTO-2 com HP-PRODUTO ('produto'). Agora o passo 3 só aprende de aviso que o
  // CONFIG reconheceu (pagina_por 'config'). 'oferta' vem de um link gravado pelo /api/inscricao,
  // que qualquer um chama, e 'produto' já é uma dedução: aprender com eles espalhava um erro, ou uma
  // inscrição forjada, para toda venda seguinte do produto. Por isso 'produto' agora é o 6123456
  // (o produto de HP-CONFIG) com ofertas que ninguém abriu, e o 6200001 fica de fora.
  test("pagina_por: 'config' (p.pagina do servidor), 'oferta' (o off= do link da própria compradora), 'produto' (um aviso anterior que o config reconheceu); produto de fora fica null", async () => {
    await limparInscricoes();
    const gps = await rpcOk("inscricao_salvar", { p: inscricaoGps({ checkout_url: "https://pay.hotmart.com/R107667362D?off=lote2abc&checkoutMode=10" }) });
    for (const p of [
      compraGps({ transacao: "HP-CONFIG" }),
      // Oferta que o config não conhece, mas que o link da inscrição da Maria abriu; produto sem histórico.
      compraGps({ transacao: "HP-OFERTA", pagina: null, oferta: "lote2abc", produto_id: "6200001" }),
      // Oferta que ninguém abriu, do produto que o config reconheceu em HP-CONFIG.
      compraGps({ transacao: "HP-PRODUTO", pagina: null, oferta: "cupom50" }),
      // De novo, agora com HP-PRODUTO ('produto') como o aviso MAIS RECENTE do produto: a página
      // continua vindo de HP-CONFIG.
      compraGps({ transacao: "HP-PRODUTO-2", pagina: null, oferta: "cupom60" }),
      // O 6200001 só veio por 'oferta', e 'oferta' não ensina: fica de fora, mesmo sendo da Maria.
      compraGps({ transacao: "HP-SO-OFERTA", pagina: null, oferta: "cupom70", produto_id: "6200001" }),
      compraFormacao({ transacao: "HP-FORA" })
    ]) {
      await rpcOk("hotmart_registrar_compra", { p });
    }
    assert.deepEqual(
      (await gravadas()).map((c) => [c.transacao, c.pagina, c.pagina_por, c.inscricao_id]),
      [
        ["HP-CONFIG", GPS, "config", gps.id],
        ["HP-OFERTA", GPS, "oferta", gps.id],
        ["HP-PRODUTO", GPS, "produto", gps.id],
        ["HP-PRODUTO-2", GPS, "produto", gps.id],
        ["HP-SO-OFERTA", null, null, null],
        ["HP-FORA", null, null, null]
      ]
    );
  });

  test("aviso da versão ANTERIOR (pagina_por null) não ensina a página do produto: o 8519248 continua de fora", async () => {
    await limparInscricoes();
    const viver = await rpcOk("inscricao_salvar", { p: inscricao() });
    // Gravado pela versão anterior: `pagina` era a da inscrição que casou (a Maria da Viver de Furo),
    // qualquer que fosse o produto; pagina_por não existia.
    await inserir("compras", [
      {
        evento: "PURCHASE_APPROVED",
        transacao: "HP-ANTIGO",
        status: "APPROVED",
        produto_id: "8519248",
        produto_nome: "Outro produto",
        oferta: "antiga01",
        valor: 497,
        comprador_email: "maria@gmail.com",
        comprador_digits: "5511912345678",
        inscricao_id: viver.id,
        pagina: PAGINA,
        pagina_por: null,
        recebido_em: "2026-09-10T10:00:00-03:00",
        payload: { event: "PURCHASE_APPROVED", data: { product: { id: 8519248 } } }
      }
    ]);

    // Um aviso novo do mesmo produto, sem p.pagina e com uma oferta que link nenhum abriu.
    const novo = await rpcOk("hotmart_registrar_compra", {
      p: compra({ transacao: "HP-NOVO-8519248", pagina: null, produto_id: "8519248", produto_nome: "Outro produto", oferta: "nova0001", valor: 497 })
    });
    assert.deepEqual(novo, { ok: true, novo: true, casou: false, inscricao_id: null, pagina: null });
    assert.deepEqual(await estadoDaCompra(viver.id), SEM_COMPRA, "a inscrita da Viver de Furo não vira compradora de outro produto");
    const [gravado] = (await gravadas()).filter((c) => c.transacao === "HP-NOVO-8519248");
    assert.deepEqual([gravado.pagina, gravado.pagina_por, gravado.inscricao_id], [null, null, null]);

    // Quando um aviso de verdade (com pagina_por) disser a página do produto, é ele que ensina — mesmo
    // com o aviso antigo como o MAIS RECENTE do produto.
    await rpcOk("hotmart_registrar_compra", { p: compra({ transacao: "HP-CONFIG-8519248", pagina: GPS, produto_id: "8519248", oferta: "nova0002", ...ORFA.X }) });
    await stack.sql("update public.compras set recebido_em = now() + interval '1 day' where transacao = 'HP-ANTIGO' returning 1 as ok");
    const aprendido = await rpcOk("hotmart_registrar_compra", { p: compra({ transacao: "HP-APRENDIDO-8519248", pagina: null, produto_id: "8519248", oferta: "nova0003", ...ORFA.Y }) });
    assert.deepEqual({ pagina: aprendido.pagina, casou: aprendido.casou }, { pagina: GPS, casou: false });
    const [depois] = (await gravadas()).filter((c) => c.transacao === "HP-APRENDIDO-8519248");
    assert.equal(depois.pagina_por, "produto");
    assert.deepEqual(await estadoDaCompra(viver.id), SEM_COMPRA);
  });

  test("o produto '0' (o \"Enviar teste\" da Hotmart) nunca é aprendido, mesmo com um aviso anterior com página", async () => {
    await limparInscricoes();
    const gps = await rpcOk("inscricao_salvar", { p: inscricaoGps() });
    // Um teste que chegou COM página (o servidor mandou p.pagina), de outra pessoa.
    const primeiro = await rpcOk("hotmart_registrar_compra", { p: compraGps({ transacao: "HP-TESTE-1", produto_id: "0", oferta: "test", ...ORFA.X }) });
    assert.equal(primeiro.pagina, GPS);

    // Os próximos testes, sem página e com ofertas que link nenhum abriu: não aprendem pelo '0'.
    for (const [transacao, produto] of [["HP-TESTE-2", "0"], ["HP-TESTE-3", " 0 "]]) {
      const r = await rpcOk("hotmart_registrar_compra", { p: compraGps({ transacao, pagina: null, produto_id: produto, oferta: `test-${transacao}` }) });
      assert.deepEqual(r, { ok: true, novo: true, casou: false, inscricao_id: null, pagina: null }, transacao);
    }
    assert.deepEqual(await estadoDaCompra(gps.id), SEM_COMPRA, "a inscrita não vira compradora pelo teste da Hotmart");

    // Com um produto de verdade, o mesmo caminho aprende: só o '0' fica de fora.
    await rpcOk("hotmart_registrar_compra", { p: compraGps({ transacao: "HP-REAL-1", ...ORFA.X }) });
    const real = await rpcOk("hotmart_registrar_compra", { p: compraGps({ transacao: "HP-REAL-2", pagina: null, oferta: "outra99" }) });
    assert.deepEqual({ casou: real.casou, inscricao_id: real.inscricao_id, pagina: real.pagina }, { casou: true, inscricao_id: gps.id, pagina: GPS });
    assert.deepEqual(
      (await gravadas()).map((c) => [c.transacao, c.produto_id, c.pagina, c.pagina_por]),
      [
        ["HP-TESTE-1", "0", GPS, "config"],
        ["HP-TESTE-2", "0", null, null],
        ["HP-TESTE-3", "0", null, null],
        ["HP-REAL-1", "6123456", GPS, "config"],
        ["HP-REAL-2", "6123456", GPS, "produto"]
      ]
    );
  });

  test("evento_em gravado = o evento_em do p; senão aprovado_em; senão pedido_em; senão a hora da gravação", async () => {
    await limparInscricoes();
    const casos = [
      ["HP-EV-1", { evento_em: "2026-09-21T10:00:00-03:00", aprovado_em: "2026-09-21T09:00:00-03:00", pedido_em: "2026-09-21T08:00:00-03:00" }, "2026-09-21T13:00:00.000Z"],
      ["HP-EV-2", { evento_em: "  ", aprovado_em: "2026-09-21T09:00:00-03:00", pedido_em: "2026-09-21T08:00:00-03:00" }, "2026-09-21T12:00:00.000Z"],
      ["HP-EV-3", { evento_em: null, aprovado_em: null, pedido_em: "2026-09-21T08:00:00-03:00" }, "2026-09-21T11:00:00.000Z"],
      ["HP-EV-4", { evento_em: null, aprovado_em: "", pedido_em: null }, "agora"]
    ];
    for (const [transacao, datas] of casos) {
      await rpcOk("hotmart_registrar_compra", { p: compraFormacao({ transacao, ...datas }) });
    }
    const linhas = await gravadas();
    for (const [transacao, , esperado] of casos) {
      const linha = linhas.find((c) => c.transacao === transacao);
      assert.ok(linha.evento_em, `${transacao}: evento_em nunca fica null`);
      if (esperado === "agora") {
        assert.equal(linha.evento_em, linha.recebido_em, `${transacao}: o now() da gravação (o mesmo do recebido_em)`);
      } else {
        assert.equal(new Date(linha.evento_em).toISOString(), esperado, transacao);
      }
    }
  });
});

describe("supabase.sql reaplicado: avisos da versão anterior completados pelo payload", () => {
  const MS = Date.parse("2026-09-21T17:00:00Z"); // creation_date em milissegundos (o que a Hotmart manda)
  const S = Date.parse("2026-09-22T17:00:00Z") / 1000; // e em segundos

  /** Cada aviso como o banco o guarda, com null distinguível de texto vazio. */
  async function avisos() {
    return stack.sql(`
      select transacao, evento,
             coalesce(sck, '<null>') as sck, coalesce(src, '<null>') as src, coalesce(oferta, '<null>') as oferta,
             coalesce(to_char(evento_em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '<null>') as evento_em,
             coalesce(pagina, '<null>') as pagina, coalesce(pagina_por, '<null>') as pagina_por
      from public.compras order by id
    `);
  }
  /** A linha inteira, para provar que rodar de novo não muda nada. */
  async function fotografia() {
    return stack.sql("select id, row_to_json(c)::text as linha from public.compras as c order by id");
  }

  test("banco antigo: as colunas entram; sck (purchase.origin), src, oferta (data.offer) e evento_em (creation_date em ms e em s) são completados sem sobrescrever o que já tinha valor; rodar 2x não muda nada", async () => {
    await limparInscricoes();
    try {
      // 1. O banco da versão anterior: compras sem pagina_por e sem evento_em, sck não lido do origin.
      await stack.sql("alter table public.compras drop column pagina_por, drop column evento_em");
      await inserir("compras", [
        {
          evento: "PURCHASE_APPROVED",
          transacao: "HP-OLD-1",
          oferta: "7j2nqptq",
          pagina: PAGINA,
          payload: {
            event: "PURCHASE_APPROVED",
            creation_date: MS,
            data: { purchase: { transaction: "HP-OLD-1", offer: { code: "7j2nqptq" }, origin: { sck: " criativo-07 ", src: "facebook" } } }
          }
        },
        {
          // Carrinho abandonado: sem transação, a oferta vem em data.offer.
          evento: "PURCHASE_OUT_OF_SHOPPING_CART",
          transacao: null,
          payload: { event: "PURCHASE_OUT_OF_SHOPPING_CART", creation_date: S, data: { offer: { code: "l0r77by6" }, product: { id: 6123456 } } }
        }
      ]);
      await stack.aplicarSql();

      const colunas = await stack.sql(`
        select column_name, data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'compras' and column_name in ('pagina_por', 'evento_em') order by column_name
      `);
      assert.deepEqual(colunas, [
        { column_name: "evento_em", data_type: "timestamp with time zone" },
        { column_name: "pagina_por", data_type: "text" }
      ]);
      assert.deepEqual(await avisos(), [
        { transacao: "HP-OLD-1", evento: "PURCHASE_APPROVED", sck: "criativo-07", src: "facebook", oferta: "7j2nqptq", evento_em: "2026-09-21T17:00:00Z", pagina: PAGINA, pagina_por: "<null>" },
        { transacao: null, evento: "PURCHASE_OUT_OF_SHOPPING_CART", sck: "<null>", src: "<null>", oferta: "l0r77by6", evento_em: "2026-09-22T17:00:00Z", pagina: "<null>", pagina_por: "<null>" }
      ], "pagina_por NÃO é inventado para o aviso antigo: ele continua sem ensinar página");

      // 2. Linhas que já tinham valor, ou cujo payload não tem de onde tirar, não mudam.
      await inserir("compras", [
        {
          evento: "PURCHASE_APPROVED",
          transacao: "HP-JA-TINHA",
          sck: "ja-tinha",
          src: "ja-src",
          oferta: "ja-oferta",
          evento_em: "2026-01-01T00:00:00Z",
          pagina: GPS,
          pagina_por: "config",
          payload: { creation_date: MS, data: { purchase: { origin: { sck: "outro-sck", src: "outro-src" } }, offer: { code: "outra-oferta" } } }
        },
        {
          evento: "PURCHASE_APPROVED",
          transacao: "HP-VAZIO",
          payload: { creation_date: "2026-09-21T17:00:00Z", data: { purchase: { origin: { sck: "   ", src: "" } }, offer: { code: " " } } }
        },
        { evento: "PURCHASE_APPROVED", transacao: "HP-MS-TEXTO", payload: { creation_date: String(MS) } },
        { evento: "PURCHASE_APPROVED", transacao: "HP-SEM-DATA", payload: { event: "PURCHASE_APPROVED" } },
        { evento: "PURCHASE_APPROVED", transacao: "HP-CURTO", payload: { creation_date: 123 } }
      ]);
      await stack.aplicarSql();
      assert.deepEqual((await avisos()).slice(2), [
        { transacao: "HP-JA-TINHA", evento: "PURCHASE_APPROVED", sck: "ja-tinha", src: "ja-src", oferta: "ja-oferta", evento_em: "2026-01-01T00:00:00Z", pagina: GPS, pagina_por: "config" },
        { transacao: "HP-VAZIO", evento: "PURCHASE_APPROVED", sck: "<null>", src: "<null>", oferta: "<null>", evento_em: "<null>", pagina: "<null>", pagina_por: "<null>" },
        { transacao: "HP-MS-TEXTO", evento: "PURCHASE_APPROVED", sck: "<null>", src: "<null>", oferta: "<null>", evento_em: "2026-09-21T17:00:00Z", pagina: "<null>", pagina_por: "<null>" },
        { transacao: "HP-SEM-DATA", evento: "PURCHASE_APPROVED", sck: "<null>", src: "<null>", oferta: "<null>", evento_em: "<null>", pagina: "<null>", pagina_por: "<null>" },
        { transacao: "HP-CURTO", evento: "PURCHASE_APPROVED", sck: "<null>", src: "<null>", oferta: "<null>", evento_em: "<null>", pagina: "<null>", pagina_por: "<null>" }
      ]);

      // 3. Rodar de novo (e de novo) não muda linha nenhuma.
      const antes = await fotografia();
      assert.equal(antes.length, 7);
      await stack.aplicarSql();
      assert.deepEqual(await fotografia(), antes, "segunda execução");
      await stack.aplicarSql();
      assert.deepEqual(await fotografia(), antes, "terceira execução");
    } finally {
      // Se algo falhou no meio, o banco volta ao formato certo para o que vier depois.
      await stack.aplicarSql();
    }
  });
});
