// O sistema INTEIRO, de ponta a ponta, sem nada falso no caminho dos dados:
//
//   navegador de verdade (Chromium, tela de celular) → server.mjs → PostgREST → Postgres 17
//                                                     → n8n (um servidor local que grava o que recebe)
//
// Cinco pessoas respondem a pesquisa pelo formulário, dois visitantes só passam, e depois a
// equipe confere tudo no painel e no CSV. Cada número esperado aqui foi contado À MÃO a partir
// das pessoas abaixo — não pelo próprio sistema.
//
//   node --test tests/e2e/fluxo.e2e.mjs            (precisa de Docker e do Playwright)
//   E2E_SCREENS=/uma/pasta node --test ...         (também tira as capturas de tela)
//
// O DNS do e-mail é o único dublê: um resolvedor falso que diz "não existe" para um domínio
// combinado. Nenhum dado sai da máquina.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { chromium } from "playwright";

import { COLUNAS_CSV, createServerApp } from "../../server.mjs";
import { startStack } from "./stack.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCREENS = process.env.E2E_SCREENS || "";

const contexto = {};
vm.runInNewContext(readFileSync(path.join(RAIZ, "js", "pesquisa-config.js"), "utf8"), contexto);
const EV = contexto.EVPesquisa;
const PERGUNTAS_TOTAL = EV.PERGUNTAS.length; // 39; "fim" = 40

const PAINEL_EMAIL = "equipe@escola-teste.com.br";
const PAINEL_SENHA = "senha-de-teste-do-painel";
const DOMINIO_INEXISTENTE = "faculdade-fantasma.com.br";

/* ------------------------------------------------------------------------------------------ */
/* As pessoas                                                                                  */
/* ------------------------------------------------------------------------------------------ */

// Respostas na forma CANÔNICA (múltipla na ordem das alternativas): é exatamente o que tem que
// estar no banco no fim.
const JOANA = {
  contato: { nome: "Joana Ferreira", whatsapp: "(81) 98765-4321", digits: "81987654321", email: "joana.ferreira@gmail.com" },
  respostas: {
    perfil: "Técnico(a) de enfermagem",
    idade: "35 a 44 anos",
    estado: "Pernambuco",
    localidade: "Capital",
    tempo_area: "7 a 10 anos",
    situacao_profissional: "Trabalho por plantões",
    trabalha_saude: "Sim, exclusivamente",
    ambientes: ["Hospital", "Clínica", "Home care"],
    renda_atual: "R$ 2.501 a R$ 3.500",
    maior_dificuldade: "Medo de cometer erros",
    situacao_incomoda: "Sinto que minha carreira está parada",
    seguranca: 4,
    inseguranca_situacoes: ["Medicamentos", "Intercorrências ou emergências"],
    objetivo_12m: "Me especializar",
    renda_desejada: "R$ 5.001 a R$ 7.000",
    evolucao_carreira: "Mais segurança técnica",
    frequencia_investimento: "Sim, uma ou duas vezes por ano",
    maior_investimento: "R$ 501 a R$ 1.000",
    disposicao_investimento: "R$ 1.001 a R$ 2.000",
    criterio_compra: "Conteúdo prático",
    objecoes: ["Medo de comprar e não aprender"],
    formato_aprendizado: ["Aulas gravadas", "Aulas práticas"],
    tempo_estudo: "4 a 6 horas",
    periodo_estudo: ["Noite", "Varia conforme meus plantões"],
    fontes_informacao: ["Instagram", "YouTube"],
    tipos_conteudo: ["Técnicas e procedimentos", "Emergências", "Dispositivos"],
    como_conheceu: "Indicação",
    tempo_acompanha: "6 meses a 1 ano",
    problema_unico: "Perder o medo de errar a medicação no plantão",
    sonho: "Ser enfermeira de UTI",
    frase_desejo: "fazer a faculdade de enfermagem",
    frase_bloqueio: "trabalho em dois plantões",
    tecnico_momento: "Já trabalho, mas ainda sinto insegurança",
    tecnico_objetivo: "Trabalhar em hospital"
  }
};

const CARLA_CONTATO = { nome: "Carla Mendes", whatsapp: "(21) 99876-5432", digits: "21998765432", email: "carla.mendes@hotmail.com" };

// Carla, primeira tentativa: para na pergunta 14 (a tela dela quando fecha a página).
const CARLA_1 = {
  contato: CARLA_CONTATO,
  respostas: {
    perfil: "Cuidador(a)",
    idade: "45 a 54 anos",
    estado: "Rio de Janeiro",
    localidade: "Região metropolitana",
    tempo_area: "4 a 6 anos",
    situacao_profissional: "Trabalho como autônomo(a)",
    trabalha_saude: "Sim, exclusivamente",
    ambientes: ["Casa de repouso / instituição de longa permanência", "Atendimento particular"],
    renda_atual: "R$ 1.501 a R$ 2.500",
    maior_dificuldade: "Baixo salário",
    situacao_incomoda: "Trabalho muito e ganho pouco",
    seguranca: 7,
    inseguranca_situacoes: ["Cuidado com idosos", "Pacientes dependentes"]
  }
};

// Carla, segunda tentativa, em outro aparelho, com o mesmo WhatsApp: termina.
const CARLA_2 = {
  contato: { ...CARLA_CONTATO, email: "carla.m@gmail.com" },
  respostas: {
    ...CARLA_1.respostas,
    objetivo_12m: "Ganhar mais",
    renda_desejada: "R$ 3.001 a R$ 5.000",
    evolucao_carreira: "Aumento de salário",
    frequencia_investimento: "Raramente",
    maior_investimento: "Até R$ 100",
    disposicao_investimento: "Dependeria do resultado que a formação proporciona",
    criterio_compra: "Possibilidade de parcelamento",
    objecoes: ["Falta de dinheiro", "Falta de tempo"],
    formato_aprendizado: ["Aulas gravadas"],
    tempo_estudo: "1 a 3 horas",
    periodo_estudo: ["Noite"],
    fontes_informacao: ["Facebook", "WhatsApp"],
    tipos_conteudo: ["Cuidados com idosos"],
    como_conheceu: "WhatsApp",
    tempo_acompanha: "1 a 3 meses",
    problema_unico: "Aprender a cuidar de acamados com segurança",
    cuidador_realidade: "Trabalho profissionalmente como cuidador(a)",
    cuidador_dificuldade: "Mobilidade do paciente"
  }
};

// Rosa começa como auxiliar, chega ao bloco A, volta até a pergunta 1 e troca para enfermeira.
const ROSA_COMUM = {
  idade: "45 a 54 anos",
  estado: "Minas Gerais",
  localidade: "Cidade do interior",
  tempo_area: "Mais de 10 anos",
  situacao_profissional: "Trabalho com carteira assinada",
  trabalha_saude: "Sim, mas também tenho outra atividade",
  ambientes: ["Ainda não sei"],
  renda_atual: "Prefiro não responder",
  maior_dificuldade: "Falta de reconhecimento",
  situacao_incomoda: "Tenho conhecimento, mas não sou valorizado(a)",
  seguranca: 0,
  inseguranca_situacoes: ["Liderança de equipe"],
  objetivo_12m: "Assumir posição de liderança",
  renda_desejada: "R$ 7.001 a R$ 10.000",
  evolucao_carreira: "Reconhecimento profissional",
  frequencia_investimento: "Sim, várias vezes ao ano",
  maior_investimento: "Mais de R$ 2.000",
  disposicao_investimento: "Mais de R$ 2.000",
  criterio_compra: "Reconhecimento da instituição",
  objecoes: ["Nada me impede se eu enxergar valor"],
  formato_aprendizado: ["Mentoria ou acompanhamento"],
  tempo_estudo: "Mais de 10 horas",
  periodo_estudo: ["Finais de semana"],
  fontes_informacao: ["Google", "Cursos"],
  tipos_conteudo: ["Conteúdo sobre carreira"],
  como_conheceu: "Anúncio",
  tempo_acompanha: "Conheci agora",
  sonho: "Coordenar uma equipe de enfermagem"
};
const ROSA = {
  contato: { nome: "Rosa Almeida", whatsapp: "(31) 99123-4567", digits: "31991234567", email: "rosa.almeida@yahoo.com.br" },
  comoAuxiliar: { perfil: "Auxiliar ou antiga atendente de enfermagem", ...ROSA_COMUM, auxiliar_situacao: "Gostaria de me tornar técnico(a) de enfermagem" },
  respostas: {
    perfil: "Enfermeiro(a)",
    ...ROSA_COMUM,
    enfermeiro_interesse: "Liderança e supervisão de equipes",
    enfermeiro_caminho: "Gestão ou liderança"
  }
};

// Beatriz, estudante: pula as três abertas e não tem etapa 9.
const BEATRIZ = {
  contato: { nome: "Beatriz Lima", whatsapp: "(11) 94567-1234", digits: "11945671234", email: "bia.lima@usp.br" },
  respostas: {
    perfil: "Estudante da área da saúde",
    idade: "Até 24 anos",
    estado: "São Paulo",
    localidade: "Capital",
    tempo_area: "Ainda não atuo",
    situacao_profissional: "Estou estudando",
    trabalha_saude: "Nunca trabalhei",
    ambientes: ["Hospital", "UBS / posto de saúde"],
    renda_atual: "Até R$ 1.500",
    maior_dificuldade: "Falta de experiência",
    situacao_incomoda: "Não consigo boas oportunidades",
    seguranca: 5,
    inseguranca_situacoes: ["Procedimentos", "Dispositivos"],
    objetivo_12m: "Conseguir meu primeiro emprego na área",
    renda_desejada: "R$ 3.001 a R$ 5.000",
    evolucao_carreira: "Conseguir um emprego melhor",
    frequencia_investimento: "Nunca investi",
    maior_investimento: "Nunca comprei",
    disposicao_investimento: "Até R$ 100",
    criterio_compra: "Preço",
    objecoes: ["Falta de dinheiro", "Medo de não conseguir pagar"],
    formato_aprendizado: ["Aulas ao vivo", "Presencialmente"],
    tempo_estudo: "7 a 10 horas",
    periodo_estudo: ["Manhã", "Tarde"],
    fontes_informacao: ["Instagram", "TikTok"],
    tipos_conteudo: ["Salários e oportunidades", "Empregos"],
    como_conheceu: "TikTok",
    tempo_acompanha: "Menos de 1 mês"
  }
};

/* ------------------------------------------------------------------------------------------ */
/* Infraestrutura                                                                              */
/* ------------------------------------------------------------------------------------------ */

let stack;
let server;
let base;
let browser;
let webhook;
const erros = [];
let ipSeguinte = 1;

function gerarSenhaDoPainel() {
  // O mesmo script que a equipe usa (npm run painel:senha).
  const r = spawnSync(process.execPath, [path.join(RAIZ, "scripts", "gerar-senha-painel.mjs"), PAINEL_SENHA], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const hash = r.stdout.match(/^PAINEL_SENHA_HASH=(\S+)$/m)?.[1];
  const segredo = r.stdout.match(/^PAINEL_SESSAO_SEGREDO=(\S+)$/m)?.[1];
  assert.match(hash, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.match(segredo, /^[0-9a-f]{64}$/);
  return { hash, segredo };
}

/** O "n8n": grava cada POST recebido e responde 200. */
function subirWebhook() {
  const recebidos = [];
  const srv = http.createServer((req, res) => {
    const partes = [];
    req.on("data", (parte) => partes.push(parte));
    req.on("end", () => {
      let corpo = null;
      try {
        corpo = JSON.parse(Buffer.concat(partes).toString("utf8"));
      } catch {
        corpo = null;
      }
      recebidos.push({ method: req.method, url: req.url, headers: req.headers, corpo });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ srv, recebidos, url: `http://127.0.0.1:${srv.address().port}/webhook/pesquisa-icp` }))
  );
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function aguardar(descricao, fn, { timeoutMs = 20_000, intervaloMs = 150 } = {}) {
  const limite = Date.now() + timeoutMs;
  let ultimo;
  while (Date.now() < limite) {
    try {
      ultimo = await fn();
      if (ultimo) return ultimo;
    } catch (erro) {
      ultimo = erro;
    }
    await esperar(intervaloMs);
  }
  throw new Error(`Tempo esgotado esperando: ${descricao} (último: ${ultimo instanceof Error ? ultimo.message : JSON.stringify(ultimo)})`);
}

async function foto(page, nome, opcoes = {}) {
  if (!SCREENS) return;
  await mkdir(SCREENS, { recursive: true });
  // Deixa terminar a animação de entrada e os "três pontinhos" da fala (~600 ms).
  await esperar(750);
  await page.screenshot({ path: path.join(SCREENS, `${nome}.png`), ...opcoes });
}

/** Um "celular" novo: contexto limpo (sem localStorage) e IP próprio (o limite é por IP). */
async function celular() {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    extraHTTPHeaders: { "X-Forwarded-For": `10.0.0.${ipSeguinte++}` }
  });
  // O Pixel é injetado de verdade pelo servidor; só a ida ao Facebook é cortada.
  await ctx.route(/facebook\.(net|com)/, (rota) => rota.abort());
  const page = await ctx.newPage();
  vigiar(page);
  return { ctx, page };
}

function vigiar(page) {
  page.on("pageerror", (erro) => erros.push(`pageerror: ${erro}`));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !msg.text().startsWith("Failed to load resource")) erros.push(`console: ${msg.text()}`);
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Dirigindo o formulário                                                                      */
/* ------------------------------------------------------------------------------------------ */

async function telaAtual(page) {
  return page.evaluate(() => {
    const t = document.getElementById("tela-pergunta");
    if (!t.hidden) return t.dataset.pergunta;
    return ["boasvindas", "contato", "fim"].find((n) => !document.getElementById(`tela-${n}`).hidden) || "?";
  });
}

async function esperarTela(page, id) {
  await page.waitForFunction(
    (alvo) => {
      const t = document.getElementById("tela-pergunta");
      const atual = !t.hidden ? t.dataset.pergunta : ["boasvindas", "contato", "fim"].find((n) => !document.getElementById(`tela-${n}`).hidden);
      return atual === alvo;
    },
    id,
    { timeout: 10_000 }
  );
}

async function esperarTrocar(page, anterior) {
  await page.waitForFunction(
    (a) => {
      const t = document.getElementById("tela-pergunta");
      const atual = !t.hidden ? t.dataset.pergunta : ["boasvindas", "contato", "fim"].find((n) => !document.getElementById(`tela-${n}`).hidden);
      return atual && atual !== a;
    },
    anterior,
    { timeout: 10_000 }
  );
}

const opcao = (page, valor) => page.locator(`#tela-pergunta .opcao[data-valor="${valor}"]`);

async function marcadas(page) {
  return page.$$eval("#tela-pergunta .opcao[aria-checked='true']", (botoes) => botoes.map((b) => b.dataset.valor));
}

/**
 * Responde a pergunta da tela com o valor de `respostas`, pelo toque, como a pessoa faria.
 * `ganchos[id]` roda antes (para provar uma regra da tela naquela pergunta).
 */
async function responder(page, pergunta, respostas, ganchos = {}) {
  assert.equal(await telaAtual(page), pergunta.id, "a pesquisa mostrou outra pergunta");
  // Decisão do cliente: nenhuma pergunta tem "Outro" — nem a alternativa, nem o campo "qual?".
  assert.equal(await page.locator('#tela-pergunta .opcao[data-valor="Outro"]').count(), 0, `"Outro" em ${pergunta.id}`);
  assert.equal(await page.locator("#tela-pergunta .outro").count(), 0, `campo de "Outro" em ${pergunta.id}`);
  if (ganchos[pergunta.id]) await ganchos[pergunta.id](page);
  const valor = respostas[pergunta.id];

  switch (pergunta.tipo) {
    case "unica":
      await opcao(page, valor).click();
      break;
    case "multipla":
      for (const item of valor) if (!(await marcadas(page)).includes(item)) await opcao(page, item).click();
      assert.deepEqual((await marcadas(page)).sort(), [...valor].sort());
      await page.click("#botao-continuar");
      break;
    case "lista":
      await page.selectOption("#tela-pergunta select", valor);
      await page.click("#botao-continuar");
      break;
    case "escala":
      await page.click(`#tela-pergunta .escala-numero[data-valor="${valor}"]`);
      break;
    case "texto":
      if (valor === undefined) await page.click("#botao-pular");
      else {
        await page.fill("#tela-pergunta textarea", valor);
        await page.click("#botao-continuar");
      }
      break;
    case "frase": {
      const [desejo, bloqueio] = pergunta.partes.map((parte) => respostas[parte.id]);
      if (desejo === undefined && bloqueio === undefined) await page.click("#botao-pular");
      else {
        const areas = page.locator("#tela-pergunta textarea");
        if (desejo) await areas.nth(0).fill(desejo);
        if (bloqueio) await areas.nth(1).fill(bloqueio);
        await page.click("#botao-continuar");
      }
      break;
    }
    default:
      throw new Error(`tipo inesperado ${pergunta.tipo}`);
  }
  await esperarTrocar(page, pergunta.id);
}

/** Responde, em ordem, todas as perguntas do caminho da pessoa a partir de `desde`, até `ate` (exclusive). */
async function responderCaminho(page, respostas, { desde, ate, ganchos } = {}) {
  const caminho = Array.from(EV.perguntasVisiveis(respostas));
  let i = desde ? caminho.findIndex((p) => p.id === desde) : 0;
  for (; i < caminho.length; i += 1) {
    if (ate && caminho[i].id === ate) return;
    await responder(page, caminho[i], respostas, ganchos);
  }
}

async function preencherContato(page, { nome, whatsappDigitado, email }) {
  await page.fill("#campo-nome", nome);
  await page.fill("#campo-whatsapp", "");
  await page.type("#campo-whatsapp", whatsappDigitado);
  await page.fill("#campo-email", email);
  await page.click("#botao-contato");
}

async function abrirEComecar(page, caminho) {
  const resposta = await page.goto(`${base}${caminho}`);
  assert.equal(resposta.status(), 200);
  await page.waitForFunction(() => document.body.classList.contains("pronto"));
  await page.click("#botao-comecar");
  await esperarTela(page, "contato");
  return resposta;
}

/* ------------------------------------------------------------------------------------------ */
/* Banco                                                                                       */
/* ------------------------------------------------------------------------------------------ */

async function tentativas(digits) {
  const linhas = await stack.sql(`
    select id, visitante_id, status, nome, whatsapp, whatsapp_digits, whatsapp_internacional, email, perfil,
           respostas::text as respostas_json, tempos::text as tempos_json, pergunta_atual, etapa_atual,
           posicao_max, pergunta_max, etapa_max, respondidas, obrigatorias, obrigatorias_respondidas,
           total_perguntas, progresso_percentual, tempo_total_segundos, concluido_em, finalizado_em,
           webhook_enviado_em, seq, pesquisa, pesquisa_versao, page_url, referrer, utm_source, utm_medium,
           utm_campaign, utm_content, utm_term, fbclid, gclid, dispositivo
    from public.pesquisa_respostas where whatsapp_digits = '${digits}' order by criado_em`);
  return linhas.map((l) => ({ ...l, respostas: JSON.parse(l.respostas_json), tempos: JSON.parse(l.tempos_json) }));
}

async function visitante(id) {
  const [v] = await stack.sql(`select * from public.pesquisa_visitas where visitante_id = '${id}'`);
  return v;
}

function conferirTempos(linha, respostas) {
  const esperadas = ["contato", ...Array.from(EV.perguntasVisiveis(respostas)).map((p) => p.id)];
  for (const chave of esperadas) {
    assert.ok(Object.prototype.hasOwnProperty.call(linha.tempos, chave), `tempo de ${chave}`);
    assert.ok(Number.isInteger(linha.tempos[chave]) && linha.tempos[chave] >= 0, `tempo inteiro de ${chave}`);
  }
}

function contagemEsperada(respostas) {
  const visiveis = Array.from(EV.perguntasVisiveis(respostas));
  return { total: visiveis.length, obrigatorias: visiveis.filter((p) => p.obrigatoria).length };
}

/* ------------------------------------------------------------------------------------------ */
/* Ciclo de vida                                                                               */
/* ------------------------------------------------------------------------------------------ */

before(async () => {
  stack = await startStack();
  webhook = await subirWebhook();
  const { hash, segredo } = gerarSenhaDoPainel();
  server = createServerApp({
    supabaseUrl: stack.supabaseUrl,
    supabaseKey: stack.serviceKey,
    painelEmail: PAINEL_EMAIL,
    painelSenhaHash: hash,
    painelSessaoSegredo: segredo,
    webhookUrl: webhook.url,
    // DNS falso: só o domínio combinado "não existe". Nenhuma consulta de verdade.
    resolveEmailDomain: async (dominio) => (dominio === DOMINIO_INEXISTENTE ? "missing" : "ok")
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close().catch(() => {});
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  if (webhook) await new Promise((resolve) => webhook.srv.close(resolve));
  if (stack) await stack.stop();
});

/* ------------------------------------------------------------------------------------------ */
/* a) Joana, técnica: link do anúncio, erros no contato, todos os tipos de pergunta             */
/* ------------------------------------------------------------------------------------------ */

const ids = {};

test("a) técnica: redirect com UTM, erros e sugestão no contato, todas as perguntas até o fim", async () => {
  const { ctx, page } = await celular();

  // O link do anúncio é a raiz: 302 para /pesquisa-icp, com as UTMs.
  const resposta = await page.goto(`${base}/?utm_source=instagram&utm_campaign=icp-teste`);
  assert.equal(resposta.status(), 200);
  const redirect = resposta.request().redirectedFrom();
  assert.ok(redirect, "houve redirect");
  assert.equal(new URL(redirect.url()).pathname, "/");
  assert.equal((await redirect.response()).status(), 302);
  assert.equal(new URL(page.url()).pathname, "/pesquisa-icp");
  assert.equal(new URL(page.url()).search, "?utm_source=instagram&utm_campaign=icp-teste");
  // O Pixel veio injetado pelo servidor (a ida ao Facebook é que foi cortada).
  assert.match(await page.content(), /fbq\('init', '538380380948773'\)/);
  await page.waitForFunction(() => document.body.classList.contains("pronto"));
  await foto(page, "01-boas-vindas");

  await page.click("#botao-comecar");
  await esperarTela(page, "contato");
  await foto(page, "02-contato");

  // WhatsApp com 10 dígitos e e-mail com ".con": as duas mensagens, e a correção oferecida.
  await preencherContato(page, { nome: "Joana Ferreira", whatsappDigitado: "8198765432", email: "joana.ferreira@gmail.con" });
  await page.waitForSelector("#erro-whatsapp:not([hidden])");
  assert.equal(await page.textContent("#erro-whatsapp"), "Faltam números: são 11 dígitos contando o DDD.");
  assert.equal(await page.textContent("#erro-email"), "Confere o final do e-mail, parece que tem um erro de digitação.");
  assert.equal(await page.getAttribute("#campo-whatsapp", "aria-invalid"), "true");
  await page.waitForSelector("#sugestao-email:not([hidden])");
  assert.equal(await page.textContent("#sugestao-valor"), "joana.ferreira@gmail.com");
  assert.equal(await telaAtual(page), "contato");
  await foto(page, "03-contato-erros");

  await page.fill("#campo-whatsapp", "");
  await page.type("#campo-whatsapp", "81987654321");
  assert.equal(await page.inputValue("#campo-whatsapp"), "(81) 98765-4321");
  await page.click("#sugestao-sim");
  assert.equal(await page.inputValue("#campo-email"), "joana.ferreira@gmail.com");
  await page.click("#botao-contato");
  await esperarTela(page, "perfil");
  await foto(page, "04-pergunta-unica-fala-etapa");

  const ganchos = {
    // Pergunta 1: só os 5 perfis concretos.
    perfil: async (p) => {
      const valores = await p.$$eval("#tela-pergunta .opcao", (botoes) => botoes.map((b) => b.dataset.valor));
      assert.deepEqual(valores, Object.values(EV.PERFIL));
      assert.equal(valores.length, 5);
    },
    // Exclusiva: marcar "Nada me impede" desmarca as outras, e marcar outra desmarca ela.
    objecoes: async (p) => {
      await opcao(p, "Falta de dinheiro").click();
      await opcao(p, "Falta de tempo").click();
      assert.deepEqual(await marcadas(p), ["Falta de dinheiro", "Falta de tempo"]);
      assert.equal(await p.textContent("#tela-pergunta .contador-marcadas"), "2 marcadas");
      await opcao(p, "Nada me impede se eu enxergar valor").click();
      assert.deepEqual(await marcadas(p), ["Nada me impede se eu enxergar valor"]);
      await opcao(p, "Medo de comprar e não aprender").click();
      assert.deepEqual(await marcadas(p), ["Medo de comprar e não aprender"]);
    },
    estado: async (p) => foto(p, "06-estado"),
    // Múltipla vazia não passa: a mensagem aparece, a tela fica, e marcar uma opção limpa o erro.
    ambientes: async (p) => {
      await p.click("#botao-continuar");
      await p.waitForFunction(() => document.getElementById("erro-pergunta").textContent.trim() !== "");
      assert.equal(await p.textContent("#erro-pergunta"), "Escolha pelo menos uma opção para continuar.");
      await esperar(120);
      assert.equal(await telaAtual(p), "ambientes");
      await foto(p, "07-multipla-vazia-com-erro");
      await opcao(p, "Hospital").click();
      await p.waitForFunction(() => document.getElementById("erro-pergunta").textContent.trim() === "");
      await opcao(p, "Home care").click();
      await foto(p, "05-multipla");
    },
    seguranca: async (p) => foto(p, "08-escala"),
    problema_unico: async (p) => foto(p, "09-aberta-fala-etapa"),
    frase: async (p) => {
      await p.locator("#tela-pergunta textarea").nth(0).fill(JOANA.respostas.frase_desejo);
      await foto(p, "10-frase");
    }
  };
  await responderCaminho(page, JOANA.respostas, { ganchos });
  await esperarTela(page, "fim");
  assert.equal(await page.textContent("#fim-saudacao"), "Muito obrigada, Joana!");
  await foto(page, "11-fim");

  const [linha] = await aguardar("Joana finalizada no banco", async () => {
    const l = await tentativas(JOANA.contato.digits);
    return l.length === 1 && l[0].finalizado_em && l[0].webhook_enviado_em ? l : null;
  });
  ids.joana = linha.id;
  ids.joanaVisitante = linha.visitante_id;

  // Recarregar no fim: abre direto no obrigado e NÃO manda um segundo aviso ao n8n.
  await page.reload();
  await esperarTela(page, "fim");
  await esperar(800);
  await ctx.close();
});

test("a) banco: a linha da técnica está exata", async () => {
  const [l] = await tentativas(JOANA.contato.digits);
  assert.deepEqual(l.respostas, JOANA.respostas);
  assert.equal(l.status, "concluida");
  assert.equal(l.nome, "Joana Ferreira");
  assert.equal(l.whatsapp, "(81) 98765-4321");
  assert.equal(l.whatsapp_digits, "81987654321");
  assert.equal(l.whatsapp_internacional, "5581987654321");
  assert.equal(l.email, "joana.ferreira@gmail.com");
  assert.equal(l.perfil, "Técnico(a) de enfermagem");
  assert.equal(l.pesquisa, "icp-escola-ev");
  assert.equal(l.pesquisa_versao, EV.VERSAO);
  assert.equal(l.pergunta_atual, "fim");
  assert.equal(l.pergunta_max, "fim");
  assert.equal(l.posicao_max, String(PERGUNTAS_TOTAL + 1));
  assert.equal(l.etapa_max, "9");
  const { total, obrigatorias } = contagemEsperada(JOANA.respostas);
  assert.equal(total, 33);
  assert.equal(l.total_perguntas, String(total));
  assert.equal(l.respondidas, String(total));
  assert.equal(l.obrigatorias, String(obrigatorias));
  assert.equal(l.obrigatorias_respondidas, String(obrigatorias));
  assert.equal(l.progresso_percentual, "100");
  assert.ok(l.concluido_em && l.finalizado_em && l.webhook_enviado_em);
  assert.ok(Number(l.tempo_total_segundos) >= 0);
  conferirTempos(l, JOANA.respostas);
  // Rastreio de primeiro toque, gravado junto da resposta e na visita.
  assert.equal(l.utm_source, "instagram");
  assert.equal(l.utm_campaign, "icp-teste");
  assert.equal(l.utm_medium, null);
  assert.equal(l.dispositivo, "mobile");
  assert.equal(l.page_url, `${base}/pesquisa-icp?utm_source=instagram&utm_campaign=icp-teste`);
  const v = await visitante(l.visitante_id);
  assert.equal(v.utm_source, "instagram");
  assert.equal(v.utm_campaign, "icp-teste");
  assert.equal(v.dispositivo, "mobile");
  assert.equal(v.visitas, "2"); // abriu o link e recarregou no fim
  assert.ok(v.comecou_em);
});

/* ------------------------------------------------------------------------------------------ */
/* b) Carla, cuidadora: para na pergunta 14                                                     */
/* ------------------------------------------------------------------------------------------ */

test("b) cuidadora para na pergunta 14 e fecha a página: tudo até ali está no banco", async () => {
  const { ctx, page } = await celular();
  await abrirEComecar(page, "/pesquisa-icp");
  await preencherContato(page, { nome: CARLA_1.contato.nome, whatsappDigitado: "21998765432", email: CARLA_1.contato.email });
  await esperarTela(page, "perfil");
  await responderCaminho(page, CARLA_1.respostas, { ate: "objetivo_12m" });
  await esperarTela(page, "objetivo_12m");
  await aguardar("Carla parada na 14 no banco", async () => {
    const [l] = await tentativas(CARLA_CONTATO.digits);
    return l && l.pergunta_atual === "objetivo_12m" && l.respostas.inseguranca_situacoes ? l : null;
  });
  await ctx.close();

  const [l] = await tentativas(CARLA_CONTATO.digits);
  ids.carla1 = l.id;
  assert.deepEqual(l.respostas, CARLA_1.respostas);
  assert.equal(l.status, "em_andamento");
  assert.equal(l.pergunta_max, "objetivo_12m");
  assert.equal(l.posicao_max, "14");
  assert.equal(l.etapa_atual, "4");
  assert.equal(l.etapa_max, "4");
  const { total, obrigatorias } = contagemEsperada(CARLA_1.respostas);
  assert.equal(l.total_perguntas, String(total));
  assert.equal(l.obrigatorias, String(obrigatorias));
  assert.equal(l.obrigatorias_respondidas, "13");
  assert.equal(l.progresso_percentual, String(Math.floor((13 / obrigatorias) * 100)));
  assert.equal(l.finalizado_em, null);
  assert.equal(l.concluido_em, null);
  assert.equal(l.webhook_enviado_em, null);
  assert.equal(l.utm_source, null);
  assert.equal(l.whatsapp, "(21) 99876-5432");
});

/* ------------------------------------------------------------------------------------------ */
/* c) Rosa: auxiliar que volta e vira enfermeira                                               */
/* ------------------------------------------------------------------------------------------ */

test("c) auxiliar volta até a pergunta 1, troca para enfermeira e conclui; bloco A some do banco", async () => {
  const { ctx, page } = await celular();
  await abrirEComecar(page, "/pesquisa-icp");
  await preencherContato(page, { nome: ROSA.contato.nome, whatsappDigitado: "31991234567", email: ROSA.contato.email });
  await esperarTela(page, "perfil");

  // Como auxiliar, até a A1, e para na tela da A2.
  await responderCaminho(page, ROSA.comoAuxiliar, { ate: "auxiliar_documentos" });
  await esperarTela(page, "auxiliar_documentos");
  await aguardar("A1 gravada", async () => {
    const [l] = await tentativas(ROSA.contato.digits);
    return l && l.respostas.auxiliar_situacao ? l : null;
  });

  // Volta, pelo botão da tela, até a pergunta 1.
  for (let i = 0; i < 45 && (await telaAtual(page)) !== "perfil"; i += 1) {
    const antes = await telaAtual(page);
    await page.click("#botao-voltar");
    await esperarTrocar(page, antes);
  }
  assert.equal(await telaAtual(page), "perfil");
  assert.equal(await page.getAttribute(`#tela-pergunta .opcao[data-valor="${ROSA.comoAuxiliar.perfil}"]`, "aria-checked"), "true");

  // Troca o perfil: o "continuar" leva direto ao que falta (o bloco D).
  await opcao(page, "Enfermeiro(a)").click();
  await esperarTela(page, "enfermeiro_interesse");
  await responderCaminho(page, ROSA.respostas, { desde: "enfermeiro_interesse" });
  await esperarTela(page, "fim");

  const [l] = await aguardar("Rosa finalizada", async () => {
    const linhas = await tentativas(ROSA.contato.digits);
    return linhas[0]?.finalizado_em && linhas[0]?.webhook_enviado_em ? linhas : null;
  });
  await ctx.close();
  ids.rosa = l.id;
  assert.deepEqual(l.respostas, ROSA.respostas);
  assert.ok(!Object.keys(l.respostas).some((chave) => chave.startsWith("auxiliar_")), "sem respostas do bloco A");
  assert.equal(l.perfil, "Enfermeiro(a)");
  assert.equal(l.status, "concluida");
  assert.equal(l.etapa_max, "9");
  assert.equal(l.respostas.seguranca, 0);
});

/* ------------------------------------------------------------------------------------------ */
/* d) Beatriz, estudante: e-mail recusado pelo servidor, pula as abertas                        */
/* ------------------------------------------------------------------------------------------ */

test("d) estudante: e-mail de domínio inexistente é recusado pelo servidor; pula as abertas e termina sem etapa 9", async () => {
  const { ctx, page } = await celular();
  await abrirEComecar(page, "/pesquisa-icp");
  await preencherContato(page, { nome: BEATRIZ.contato.nome, whatsappDigitado: "11945671234", email: `bia.lima@${DOMINIO_INEXISTENTE}` });
  await page.waitForSelector("#erro-email:not([hidden])");
  assert.equal(await page.textContent("#erro-email"), "Não encontramos esse endereço de e-mail. Confere se está certinho?");
  assert.equal(await telaAtual(page), "contato");
  assert.equal((await tentativas(BEATRIZ.contato.digits)).length, 0, "nada gravado com contato recusado");

  await page.fill("#campo-email", BEATRIZ.contato.email);
  await page.click("#botao-contato");
  await esperarTela(page, "perfil");
  await responderCaminho(page, BEATRIZ.respostas);
  await esperarTela(page, "fim");

  const [l] = await aguardar("Beatriz finalizada", async () => {
    const linhas = await tentativas(BEATRIZ.contato.digits);
    return linhas[0]?.finalizado_em && linhas[0]?.webhook_enviado_em ? linhas : null;
  });
  await ctx.close();
  ids.beatriz = l.id;
  assert.deepEqual(l.respostas, BEATRIZ.respostas);
  assert.equal(l.status, "concluida");
  assert.equal(l.total_perguntas, "31");
  assert.equal(l.etapa_max, "8", "estudante não tem etapa 9");
  assert.equal(l.pergunta_max, "fim");
  assert.equal(l.email, "bia.lima@usp.br");
});

/* ------------------------------------------------------------------------------------------ */
/* f) Visitantes que não se identificam                                                        */
/* ------------------------------------------------------------------------------------------ */

test("f) visitante que só abre (pelo endereço antigo) e visitante que começa e não se identifica", async () => {
  const um = await celular();
  const resposta = await um.page.goto(`${base}/pesquisa?utm_source=bio`);
  assert.equal(resposta.status(), 200);
  assert.equal((await resposta.request().redirectedFrom().response()).status(), 301);
  assert.equal(new URL(um.page.url()).pathname, "/pesquisa-icp");
  await um.page.waitForFunction(() => document.body.classList.contains("pronto"));
  const id1 = await um.page.evaluate(() => localStorage.getItem("ev_pesquisa_visitante"));
  await aguardar("visita registrada", () => visitante(id1));
  await um.ctx.close();

  const dois = await celular();
  await abrirEComecar(dois.page, "/pesquisa-icp");
  const id2 = await dois.page.evaluate(() => localStorage.getItem("ev_pesquisa_visitante"));
  await aguardar("clique em começar registrado", async () => (await visitante(id2))?.comecou_em);
  await dois.ctx.close();

  const v1 = await visitante(id1);
  assert.equal(v1.comecou_em, null);
  assert.equal(v1.visitas, "1");
  assert.equal(v1.utm_source, "bio");
  const v2 = await visitante(id2);
  assert.ok(v2.comecou_em);
  ids.visitantesSemContato = [id1, id2];
  const [{ total }] = await stack.sql(
    `select count(*) as total from public.pesquisa_respostas where visitante_id in ('${id1}', '${id2}')`
  );
  assert.equal(total, "0");
});

/* ------------------------------------------------------------------------------------------ */
/* g) Painel, primeira olhada (antes da segunda tentativa da Carla)                             */
/* ------------------------------------------------------------------------------------------ */

async function abrirPainel({ largura = 1280, altura = 800 } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: largura, height: altura },
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    acceptDownloads: true,
    isMobile: largura < 768,
    hasTouch: largura < 768,
    deviceScaleFactor: largura < 768 ? 2 : 1
  });
  const page = await ctx.newPage();
  vigiar(page);
  await page.goto(`${base}/painel`);
  await page.waitForSelector("[data-login-view]:not([hidden])");
  return { ctx, page };
}

async function entrar(page, senha = PAINEL_SENHA) {
  await page.fill("#login-email", PAINEL_EMAIL);
  await page.fill("#login-senha", senha);
  await page.click('#painel-login button[type="submit"]');
}

async function placar(page) {
  return page.$$eval("[data-placar] li", (itens) =>
    Object.fromEntries(itens.map((li) => [li.querySelector(".rotulo")?.textContent.trim(), {
      valor: li.querySelector(".valor")?.textContent.trim(),
      detalhe: li.querySelector(".detalhe")?.textContent.replace(/\s+/g, " ").trim()
    }]))
  );
}

async function esperarPlacar(page, rotulo, valor) {
  await aguardar(`placar ${rotulo} = ${valor}`, async () => (await placar(page))[rotulo]?.valor === valor, { timeoutMs: 15_000 });
}

test("g) painel antes da segunda tentativa: login, placar e onde as pessoas param (pergunta 14)", async () => {
  const { ctx, page } = await abrirPainel();

  await entrar(page, "senha-errada-123");
  await aguardar("mensagem de login errado", async () => (await page.textContent("[data-login-status]")) === "E-mail ou senha incorretos.");
  assert.equal(await page.isHidden("[data-panel-view]"), true);

  await entrar(page);
  await page.waitForSelector("[data-panel-view]:not([hidden])");
  await esperarPlacar(page, "Se identificaram", "4");
  const p = await placar(page);
  assert.equal(p.Acessaram.valor, "6");
  assert.match(p.Acessaram.detalhe, /^7 visitas no total/);
  assert.equal(p["Começaram"].valor, "5");
  assert.equal(p["Responderam tudo"].valor, "3");
  assert.equal(p["Tentativas repetidas"].valor, "0");

  const paradas = await page.textContent("[data-paradas]");
  assert.match(paradas, /Pergunta 14 · Objetivo em 12 meses/);
  const linhaParada = page.locator("[data-paradas] .linha-barra", { hasText: "Pergunta 14" });
  assert.equal((await linhaParada.locator(".num strong").textContent()).trim(), "1");

  // A faixa de páginas do funil, com a pesquisa como primeira (e por enquanto única) página.
  const aba = page.locator("[data-paginas] [data-pagina='pesquisa-icp']");
  assert.equal(await aba.getAttribute("aria-selected"), "true");
  assert.match(await aba.textContent(), /Pesquisa ICP\s*rota \/pesquisa-icp/);
  await ctx.close();
});

/* ------------------------------------------------------------------------------------------ */
/* e) Carla de novo, outro aparelho, mesmo WhatsApp: conclui                                    */
/* ------------------------------------------------------------------------------------------ */

test("e) mesma cuidadora em outro aparelho (mesmo WhatsApp) conclui: 1 pessoa, 2 tentativas", async () => {
  const { ctx, page } = await celular();
  await abrirEComecar(page, "/pesquisa-icp?utm_source=whatsapp&utm_campaign=grupo-vip");
  await preencherContato(page, { nome: CARLA_2.contato.nome, whatsappDigitado: "21998765432", email: CARLA_2.contato.email });
  await esperarTela(page, "perfil");
  await responderCaminho(page, CARLA_2.respostas);
  await esperarTela(page, "fim");
  const linhas = await aguardar("Carla 2 finalizada", async () => {
    const l = await tentativas(CARLA_CONTATO.digits);
    return l.length === 2 && l[1].finalizado_em && l[1].webhook_enviado_em ? l : null;
  });
  await ctx.close();
  ids.carla2 = linhas[1].id;
  assert.notEqual(ids.carla1, ids.carla2);
  assert.deepEqual(linhas[1].respostas, CARLA_2.respostas);
  assert.equal(linhas[1].utm_source, "whatsapp");
  // A primeira tentativa continua parada onde estava.
  assert.equal(linhas[0].status, "em_andamento");
  assert.equal(linhas[0].pergunta_max, "objetivo_12m");

  const pessoas = await stack.sql(`select id, tentativas, status from public.pesquisa_pessoas where whatsapp_digits = '${CARLA_CONTATO.digits}'`);
  assert.deepEqual(pessoas, [{ id: ids.carla2, tentativas: "2", status: "concluida" }]);
});

/* ------------------------------------------------------------------------------------------ */
/* Webhook                                                                                     */
/* ------------------------------------------------------------------------------------------ */

test("n8n: um aviso 'pesquisa_concluida' por tentativa finalizada, nenhum para quem parou no meio", async () => {
  const recebidos = webhook.recebidos;
  assert.equal(recebidos.length, 4, JSON.stringify(recebidos.map((r) => r.corpo?.sessao_id)));
  for (const r of recebidos) {
    assert.equal(r.method, "POST");
    assert.equal(r.url, "/webhook/pesquisa-icp");
    assert.match(r.headers["content-type"], /^application\/json/);
    assert.equal(r.headers["user-agent"], "ev-pesquisa/1.0");
    assert.equal(r.corpo.evento, "pesquisa_concluida");
  }
  assert.deepEqual(recebidos.map((r) => r.corpo.sessao_id).sort(), [ids.joana, ids.rosa, ids.beatriz, ids.carla2].sort());
  assert.ok(!recebidos.some((r) => r.corpo.sessao_id === ids.carla1));

  const joana = recebidos.find((r) => r.corpo.sessao_id === ids.joana).corpo;
  assert.deepEqual(joana.pesquisa, { id: "icp-escola-ev", versao: EV.VERSAO });
  assert.deepEqual(joana.lead, {
    nome: "Joana Ferreira",
    primeiro_nome: "Joana",
    whatsapp: "(81) 98765-4321",
    whatsapp_digits: "81987654321",
    whatsapp_internacional: "5581987654321",
    email: "joana.ferreira@gmail.com"
  });
  assert.equal(joana.perfil, "Técnico(a) de enfermagem");
  assert.deepEqual(joana.utm, { utm_source: "instagram", utm_medium: null, utm_campaign: "icp-teste", utm_content: null, utm_term: null });
  assert.equal(joana.rastreio.dispositivo, "mobile");
  assert.equal(joana.rastreio.page_url, `${base}/pesquisa-icp?utm_source=instagram&utm_campaign=icp-teste`);
  assert.deepEqual(joana.respostas, JOANA.respostas);
  assert.ok(joana.iniciada_em && joana.concluida_em && joana.enviado_em);
  assert.ok(Date.parse(joana.concluida_em) >= Date.parse(joana.iniciada_em));
  assert.equal(joana.perguntas.length, 33);
  assert.deepEqual(joana.perguntas.map((p) => p.id), Array.from(EV.perguntasVisiveis(JOANA.respostas)).map((p) => p.id));
  const porId = Object.fromEntries(joana.perguntas.map((p) => [p.id, p]));
  assert.equal(porId.ambientes.resposta_texto, "Hospital, Clínica, Home care");
  assert.equal(porId.maior_dificuldade.resposta_texto, "Medo de cometer erros");
  // `outro` continua em cada item (contrato com o n8n), sempre null.
  for (const aviso of recebidos) {
    assert.ok(aviso.corpo.perguntas.every((p) => Object.prototype.hasOwnProperty.call(p, "outro") && p.outro === null));
    assert.ok(!aviso.corpo.perguntas.some((p) => /Outro/.test(p.resposta_texto)));
  }
  assert.equal(porId.seguranca.resposta, 4);
  assert.equal(porId.seguranca.resposta_texto, "4/10");
  assert.equal(porId.frase.resposta_texto, "Eu gostaria muito de fazer a faculdade de enfermagem, mas ainda não consegui porque trabalho em dois plantões");
  assert.equal(porId.tecnico_objetivo.resposta_texto, "Trabalhar em hospital");
  assert.equal(porId.tecnico_objetivo.etapa_titulo, "Perguntas específicas do seu perfil");

  const beatriz = recebidos.find((r) => r.corpo.sessao_id === ids.beatriz).corpo;
  assert.equal(beatriz.perguntas.length, 31);
  const sonho = beatriz.perguntas.find((p) => p.id === "sonho");
  assert.equal(sonho.resposta, null);
  assert.equal(sonho.resposta_texto, "");

  const rosa = recebidos.find((r) => r.corpo.sessao_id === ids.rosa).corpo;
  assert.ok(!rosa.perguntas.some((p) => p.id.startsWith("auxiliar_")));
  assert.ok(rosa.perguntas.some((p) => p.id === "enfermeiro_caminho"));

  const carla = recebidos.find((r) => r.corpo.sessao_id === ids.carla2).corpo;
  assert.equal(carla.utm.utm_source, "whatsapp");
  assert.equal(carla.lead.email, "carla.m@gmail.com");
});

/* ------------------------------------------------------------------------------------------ */
/* g) Painel com todo mundo                                                                    */
/* ------------------------------------------------------------------------------------------ */

function lerCsv(texto) {
  const linhas = [];
  let linha = [];
  let celula = "";
  let aspas = false;
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];
    if (aspas) {
      if (c === '"' && texto[i + 1] === '"') {
        celula += '"';
        i += 1;
      } else if (c === '"') aspas = false;
      else celula += c;
    } else if (c === '"') aspas = true;
    else if (c === ";") {
      linha.push(celula);
      celula = "";
    } else if (c === "\r" && texto[i + 1] === "\n") {
      linha.push(celula);
      linhas.push(linha);
      linha = [];
      celula = "";
      i += 1;
    } else celula += c;
  }
  return linhas;
}

async function baixarCsv(page) {
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("[data-csv]")]);
  const caminho = await download.path();
  return { nome: download.suggestedFilename(), bytes: readFileSync(caminho) };
}

test("g) painel com todo mundo: números exatos, quadros, cruzamento, abertas, tráfego, lista, filtros e CSV", async () => {
  const { ctx, page } = await abrirPainel();
  await entrar(page);
  await page.waitForSelector("[data-panel-view]:not([hidden])");
  await esperarPlacar(page, "Responderam tudo", "4");

  // Placar: 7 visitantes (5 celulares de quem respondeu + 2 que só passaram), 8 visitas (Joana
  // recarregou no fim), 6 clicaram em Começar, 4 pessoas (Carla é uma só), 5 tentativas.
  const p = await placar(page);
  assert.equal(p.Acessaram.valor, "7");
  assert.match(p.Acessaram.detalhe, /^8 visitas no total/);
  assert.equal(p["Começaram"].valor, "6");
  assert.match(p["Começaram"].detalhe, /^86% de quem acessou/);
  assert.equal(p["Se identificaram"].valor, "4");
  assert.match(p["Se identificaram"].detalhe, /^67% de quem começou/);
  assert.equal(p["Responderam tudo"].valor, "4");
  assert.match(p["Responderam tudo"].detalhe, /^100% de quem se identificou/);
  assert.equal(p["Tentativas repetidas"].valor, "1");
  assert.match(p["Tentativas repetidas"].detalhe, /5 tentativas para 4 pessoas/);
  assert.notEqual(p["Tempo mediano"].valor, "—");

  // Funil: 7 → 6 → 4, e as 4 chegam a todas as etapas (concluídas contam na 9).
  const funil = await page.$$eval("[data-funil] li", (itens) => itens.map((li) => [li.querySelector(".rotulo").firstChild.textContent.trim(), li.querySelector(".num strong").textContent.trim()]));
  assert.deepEqual(funil.slice(0, 3), [["Acessaram a pesquisa", "7"], ["Clicaram em Começar", "6"], ["Se identificaram", "4"]]);
  assert.deepEqual(funil.find(([rotulo]) => rotulo === "Chegaram à etapa 9"), ["Chegaram à etapa 9", "4"]);
  assert.deepEqual(funil.at(-1), ["Responderam tudo", "4"]);

  // Onde param: a Carla terminou na segunda tentativa, então ninguém mais está parado.
  assert.match(await page.textContent("[data-paradas]"), /Ninguém parado no meio/);

  // ICP por perfil: um cartão por perfil com gente.
  const cartoes = await page.$$eval("[data-icp] [data-icp-perfil]", (els) => els.map((el) => el.dataset.icpPerfil).sort());
  assert.deepEqual(cartoes, ["cuidador", "enfermeiro", "estudante", "tecnico"]);
  const tecnico = await page.textContent("[data-icp-perfil='tecnico']");
  assert.match(tecnico, /1 pessoa/);
  assert.match(tecnico, /Pernambuco/);
  assert.match(tecnico, /Região Nordeste/);
  assert.match(tecnico, /4,0\/10/);

  // Respostas por pergunta: idade (etapa 1 já aberta). 45 a 54 = Rosa + Carla (a tentativa que vale).
  const idade = page.locator("#q-idade");
  assert.match(await idade.textContent(), /4 responderam/);
  const faixa = idade.locator(".linha-barra", { hasText: "45 a 54 anos" });
  assert.equal((await faixa.locator(".num strong").textContent()).trim(), "2");
  assert.equal((await faixa.locator(".num span").textContent()).trim(), "50%");
  const zero = idade.locator(".linha-barra", { hasText: "55 anos ou mais" });
  assert.equal((await zero.locator(".num strong").textContent()).trim(), "0");

  // Pergunta 8 (etapa 2, múltipla): Clínica só a Joana marcou (1 de 4). Sem "Outro" em quadro
  // nenhum: nem alternativa, nem "Ver o que escreveram em Outro".
  await page.click("[data-etapa='2'] > summary");
  const ambientes = page.locator("#q-ambientes");
  assert.match(await ambientes.textContent(), /4 responderam/);
  const clinica = ambientes.locator(".linha-barra", { hasText: "Clínica" });
  assert.equal((await clinica.locator(".num strong").textContent()).trim(), "1");
  assert.equal((await clinica.locator(".num span").textContent()).trim(), "25%");
  assert.equal(await page.locator("[data-outro]").count(), 0);
  assert.doesNotMatch(await page.textContent("[data-perguntas]"), /escreveram em Outro/);
  // Abas de perfil: Todos + os 5 perfis.
  assert.deepEqual(
    await page.$$eval("[data-perfis] [data-perfil]", (abas) => abas.map((a) => a.dataset.perfil)),
    ["", "auxiliar", "cuidador", "tecnico", "enfermeiro", "estudante"]
  );

  // Cruzamento padrão perfil × renda atual.
  await aguardar("cruzamento", async () => /4 pessoas com as duas respostas/.test(await page.textContent("[data-cruzamento]")));
  const celulaTec = page.locator("[data-cruzamento] tbody tr", { hasText: "Técnicos de enfermagem" });
  assert.match(await celulaTec.textContent(), /100%/);

  // Respostas abertas: "O único problema" tem Joana e Carla; "Complete a frase", a frase da Joana.
  await aguardar("abertas", async () => /Mostrando 2 de 2 respostas/.test(await page.textContent("[data-abertas]")));
  const abertas = await page.textContent("[data-abertas]");
  assert.match(abertas, /Perder o medo de errar a medicação no plantão/);
  assert.match(abertas, /Aprender a cuidar de acamados com segurança/);
  await page.click("#aba-frase");
  await aguardar("frase", async () =>
    /Eu gostaria muito de fazer a faculdade de enfermagem, mas ainda não consegui porque trabalho em dois plantões/.test(
      (await page.textContent("[data-abertas]")).replace(/\s+/g, " ")
    )
  );

  // Tráfego por origem: instagram (Joana), whatsapp (Carla), bio (visitante), (sem utm) o resto.
  const trafego = await page.$$eval("[data-trafego] tbody tr", (trs) =>
    Object.fromEntries(trs.map((tr) => [tr.querySelector("th").textContent.trim(), Array.from(tr.querySelectorAll("td")).slice(0, 3).map((td) => td.textContent.trim())]))
  );
  assert.deepEqual(trafego.instagram, ["1", "1", "1"]);
  assert.deepEqual(trafego.whatsapp, ["1", "1", "1"]);
  assert.deepEqual(trafego.bio, ["1", "0", "0"]);
  assert.deepEqual(trafego["(sem utm)"], ["4", "2", "2"]);

  // Lista: 4 pessoas, Carla com o selo de 2 tentativas.
  await aguardar("lista", async () => (await page.locator("[data-lista] .pessoa").count()) === 4);
  assert.match(await page.textContent("[data-contador]"), /Mostrando 4 de 4 pessoas/);
  const carla = page.locator(`[data-pessoa='${ids.carla2}']`);
  assert.equal((await carla.locator(".selo.rep").textContent()).trim(), "2 tentativas");
  assert.match(await carla.textContent(), /Respondeu tudo/);
  assert.equal(await carla.locator("a[href^='https://wa.me/']").getAttribute("href"), "https://wa.me/5521998765432");
  assert.equal(await page.locator("[data-lista] .selo.rep").count(), 1);

  // "Ver tudo" da Joana: todas as respostas na ordem, sem pergunta de outro perfil, com o id da
  // sessão e a entrega ao n8n.
  await page.click(`[data-ver='${ids.joana}']`);
  const detalhe = page.locator(`#det-${ids.joana}`);
  await detalhe.waitFor();
  const textoDetalhe = (await detalhe.textContent()).replace(/\s+/g, " ");
  assert.equal(await detalhe.locator("li.resposta").count(), 33);
  assert.match(textoDetalhe, /• Hospital • Clínica • Home care/);
  assert.match(textoDetalhe, /Trabalhar em hospital/);
  assert.doesNotMatch(textoDetalhe, /Outro:/);
  assert.match(textoDetalhe, /4\/10/);
  assert.doesNotMatch(textoDetalhe, /cuidador\(a\)\?|Qual é sua maior dificuldade como cuidador/);
  assert.match(textoDetalhe, /Enviado ao n8n em \d{2}\/\d{2}\/\d{2}/);
  assert.match(textoDetalhe, new RegExp(ids.joana));
  assert.match(textoDetalhe, /instagram/);
  await foto(page, "painel-1280-pagina-inteira", { fullPage: true });

  // Filtro por perfil: só a técnica; placar e lista acompanham; a URL guarda o filtro.
  await page.click("[data-perfis] [data-perfil='tecnico']");
  await esperarPlacar(page, "Se identificaram", "1");
  await aguardar("lista filtrada", async () => (await page.locator("[data-lista] .pessoa").count()) === 1);
  assert.match(await page.textContent("[data-lista]"), /Joana Ferreira/);
  assert.match(page.url(), /perfil=tecnico/);
  await page.click("[data-perfis] [data-perfil='']");
  await esperarPlacar(page, "Se identificaram", "4");
  await aguardar("lista cheia", async () => (await page.locator("[data-lista] .pessoa").count()) === 4);

  // Busca por nome e por WhatsApp.
  await page.fill("[data-busca]", "Carla");
  await aguardar("busca por nome", async () => (await page.locator("[data-lista] .pessoa").count()) === 1);
  assert.match(await page.textContent("[data-lista]"), /Carla Mendes/);
  await page.fill("[data-busca]", "(31) 99123");
  await aguardar("busca por WhatsApp", async () => /Rosa Almeida/.test(await page.textContent("[data-lista]")) && (await page.locator("[data-lista] .pessoa").count()) === 1);
  await page.fill("[data-busca]", "");
  await aguardar("busca limpa", async () => (await page.locator("[data-lista] .pessoa").count()) === 4);

  // CSV: BOM, cabeçalho na ordem do contrato, uma linha por pessoa, valores certos.
  const { nome, bytes } = await baixarCsv(page);
  assert.match(nome, /^pesquisa-icp-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const [cabecalho, ...linhas] = lerCsv(bytes.subarray(3).toString("utf8"));
  assert.deepEqual(cabecalho, COLUNAS_CSV.map((c) => c.cabecalho));
  assert.equal(linhas.length, 4);
  const col = (linha, nomeColuna) => linha[cabecalho.indexOf(nomeColuna)];
  const porId = Object.fromEntries(linhas.map((l) => [col(l, "id"), l]));
  assert.deepEqual(Object.keys(porId).sort(), [ids.joana, ids.rosa, ids.beatriz, ids.carla2].sort());
  const j = porId[ids.joana];
  assert.equal(col(j, "nome"), "Joana Ferreira");
  assert.equal(col(j, "whatsapp"), "(81) 98765-4321");
  assert.equal(col(j, "whatsapp_internacional"), "5581987654321");
  assert.equal(col(j, "email"), "joana.ferreira@gmail.com");
  assert.equal(col(j, "status"), "concluida");
  assert.equal(col(j, "progresso_percentual"), "100");
  assert.equal(col(j, "tentativas"), "1");
  assert.equal(col(j, "1. Perfil profissional"), "Técnico(a) de enfermagem");
  assert.ok(!cabecalho.some((c) => /Outro/.test(c)), 'nenhuma coluna "(Outro)" no CSV');
  assert.equal(col(j, "8. Ambientes de trabalho"), "Hospital | Clínica | Home care");
  assert.equal(col(j, "10. Maior dificuldade"), "Medo de cometer erros");
  assert.equal(col(j, "12. Segurança profissional (0 a 10)"), "4");
  assert.equal(col(j, "31. Eu gostaria muito de"), "fazer a faculdade de enfermagem");
  assert.equal(col(j, "31. mas ainda não consegui porque"), "trabalho em dois plantões");
  assert.equal(col(j, "C2. Técnico: maior objetivo"), "Trabalhar em hospital");
  assert.equal(col(j, "A1. Auxiliar: situação atual"), "");
  assert.equal(col(j, "regiao"), "Nordeste");
  assert.equal(col(j, "utm_source"), "instagram");
  assert.equal(col(j, "utm_campaign"), "icp-teste");
  assert.equal(col(j, "dispositivo"), "mobile");
  assert.match(col(j, "enviado_n8n_em"), /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  assert.equal(col(porId[ids.carla2], "tentativas"), "2");
  assert.equal(col(porId[ids.carla2], "B2. Cuidador: maior dificuldade"), "Mobilidade do paciente");
  assert.equal(col(porId[ids.rosa], "12. Segurança profissional (0 a 10)"), "0");
  assert.equal(col(porId[ids.rosa], "A1. Auxiliar: situação atual"), "");
  assert.equal(col(porId[ids.rosa], "D2. Enfermeiro: caminho profissional"), "Gestão ou liderança");
  assert.equal(col(porId[ids.beatriz], "29. O único problema que resolveria"), "");

  // Com as tentativas repetidas: 5 linhas, a tentativa parada da Carla incluída.
  await page.check("[data-csv-tentativas]");
  const todas = await baixarCsv(page);
  const [, ...linhasTodas] = lerCsv(todas.bytes.subarray(3).toString("utf8"));
  assert.equal(linhasTodas.length, 5);
  const parada = linhasTodas.find((l) => col(l, "id") === ids.carla1);
  assert.equal(col(parada, "status"), "em_andamento");
  assert.equal(col(parada, "parou_em"), "14. Objetivo em 12 meses");
  assert.equal(col(parada, "enviado_n8n_em"), "");

  await ctx.close();
});

test("painel no celular (390px) com os mesmos dados, sem rolagem horizontal", async () => {
  const { ctx, page } = await abrirPainel({ largura: 390, altura: 844 });
  await entrar(page);
  await page.waitForSelector("[data-panel-view]:not([hidden])");
  await esperarPlacar(page, "Responderam tudo", "4");
  await aguardar("lista", async () => (await page.locator("[data-lista] .pessoa").count()) === 4);
  const larguras = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, janela: window.innerWidth }));
  assert.ok(larguras.doc <= larguras.janela, `rolagem horizontal: ${JSON.stringify(larguras)}`);
  await foto(page, "painel-390-topo");
  await foto(page, "painel-390-pagina-inteira", { fullPage: true });
  await ctx.close();
});

test("nenhum erro de JavaScript em nenhuma página", () => {
  assert.deepEqual(erros, []);
});
