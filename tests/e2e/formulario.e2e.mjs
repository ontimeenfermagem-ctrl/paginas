// O formulário /pesquisa-icp no Chromium, tela por tela, com a API interceptada no navegador.
//
// O fluxo.e2e.mjs prova o caminho feliz contra o banco de verdade; aqui ficam as regras da TELA,
// que precisam simular respostas difíceis do servidor (422, 5xx, rede caída, lentidão): os 4
// perfis até o fim e o redirecionamento para a página de obrigado de cada um (com as UTMs), cada
// tipo de pergunta, voltar e trocar o perfil, retomar, fila de salvamento, teclado, movimento
// reduzido, Pixel e nenhuma rolagem horizontal de 320px a 1280px.
//
//   node --test tests/e2e/formulario.e2e.mjs      (precisa só do Playwright; sem Docker)
import { after, before, test } from "node:test";

import { chromium } from "playwright";

import {
  assert,
  CONTATO,
  esperar,
  esperarObrigado,
  esperarTrocar,
  interceptar,
  lerRascunho,
  novaPagina,
  O,
  P,
  perguntaAtual,
  preencherContato,
  responder,
  responderAte,
  responderAteOFim,
  subirServidor
} from "./apoio/formulario.mjs";

let servidor;
let base;
let browser;

before(async () => {
  servidor = await subirServidor();
  base = servidor.base;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close().catch(() => {});
  await servidor?.fechar();
});

/**
 * Um caso = um "celular" limpo, com a API interceptada; no fim, nenhum erro de JavaScript.
 * `opts.modo` controla o que o /salvar responde.
 */
function caso(nome, fn, opts = {}) {
  test(nome, async () => {
    const { ctx, page, erros } = await novaPagina(browser, opts);
    const reg = await interceptar(page, opts.modo || {});
    try {
      await fn(page, reg, ctx);
      assert.deepEqual(erros, [], "erros no console");
    } finally {
      await ctx.close();
    }
  });
}

const QUERY = "utm_source=instagram&utm_medium=stories&utm_campaign=icp-set&fbclid=abc123";
const URLQ = `/pesquisa-icp?${QUERY}`;

async function comecar(page, q = URLQ) {
  await page.goto(base + q);
  await page.click("#botao-comecar");
  await preencherContato(page);
  await page.waitForSelector("#tela-pergunta:not([hidden])");
}

/** Espera `fn()` devolver algo verdadeiro (registros de rede chegam um pouco depois). */
async function ate(fn, timeout = 4000) {
  const limite = Date.now() + timeout;
  for (;;) {
    const valor = fn();
    if (valor) return valor;
    if (Date.now() > limite) throw new Error("não aconteceu a tempo: " + fn);
    await esperar(40);
  }
}

function conferirSeqs(reg) {
  const seqs = reg.salvar.map((c) => c.seq);
  for (let i = 1; i < seqs.length; i += 1) assert.ok(seqs[i] > seqs[i - 1], "seq crescente " + seqs.join(","));
}

/* ------------------------------------------------------------------ os 4 perfis */

const BLOCO = {
  auxiliar: ["auxiliar_situacao", "auxiliar_documentos"],
  cuidador: ["cuidador_realidade", "cuidador_dificuldade"],
  tecnico: ["tecnico_momento", "tecnico_objetivo"],
  enfermeiro: ["enfermeiro_interesse", "enfermeiro_caminho"]
};

/** Para onde cada perfil vai ao concluir (regra do cliente: técnico e enfermeiro dividem a página). */
const OBRIGADO = {
  auxiliar: "/obrigado-afericao",
  cuidador: "/obrigado-cuidador",
  tecnico: "/obrigado-evento-outubro",
  enfermeiro: "/obrigado-evento-outubro"
};

test("os perfis testados são exatamente os 4 do config (sem \"Outro\" nem \"Estudante\")", () => {
  assert.deepEqual(Object.keys(BLOCO), Object.keys(P.PERFIL));
  assert.deepEqual(Object.keys(OBRIGADO), Object.keys(P.PERFIL));
  for (const [chave, rota] of Object.entries(OBRIGADO)) assert.equal(O.paginaDoPerfil(P.PERFIL[chave]).rota, rota);
});

for (const chave of Object.keys(BLOCO)) {
  caso(`perfil completo: ${chave} → ${OBRIGADO[chave]} com as UTMs`, async (page, reg) => {
    await comecar(page);
    const perfil = P.PERFIL[chave];
    const vistos = await responderAteOFim(page, { perfil });
    const etapa9 = vistos.filter((id) => P.perguntaPorId(id).etapa === 9);
    assert.deepEqual(etapa9, BLOCO[chave]);
    assert.equal(vistos.length, 31 + BLOCO[chave].length);
    // Redireciona sozinho, com as UTMs e o fbclid da URL, e sem deixar a pesquisa no histórico.
    const chegada = await esperarObrigado(page, OBRIGADO[chave]);
    assert.equal(chegada.search, `?${QUERY}`);
    assert.equal(await page.textContent("#ob-titulo"), O.paginaDoPerfil(perfil).headline.replace("!", ", Maria!"));
    const ultimo = reg.salvar[reg.salvar.length - 1];
    assert.equal(ultimo.pergunta_atual, "fim");
    assert.equal(ultimo.respostas.perfil, perfil);
    assert.ok(!Object.keys(ultimo.respostas).some((k) => k.endsWith("_outro")), "nenhum complemento de Outro");
    assert.ok(P.progresso(ultimo.respostas).completa);
    assert.deepEqual(ultimo.respostas, JSON.parse(JSON.stringify(P.sanitizar(ultimo.respostas))));
    assert.equal(ultimo.contato.nome, "maria da silva");
    assert.equal(ultimo.contato.whatsapp, "(11) 91234-5678");
    assert.equal(ultimo.rastreio.utm_source, "instagram");
    assert.equal(ultimo.rastreio.utm_campaign, "icp-set");
    assert.equal(ultimo.rastreio.fbclid, "abc123");
    assert.equal(ultimo.rastreio.dispositivo, "mobile");
    assert.ok(!ultimo.rastreio.page_url.includes("#"));
    assert.ok(Object.keys(ultimo.tempos).includes("contato") && Object.keys(ultimo.tempos).includes("perfil"));
    for (const v of Object.values(ultimo.tempos)) assert.ok(Number.isInteger(v) && v >= 0);
    assert.equal(reg.salvar[0].pergunta_atual, "perfil");
    conferirSeqs(reg);
    assert.deepEqual(
      reg.evento.map((e) => e.evento),
      ["visita", "inicio"]
    );
    assert.equal(reg.evento[0].utm_source, "instagram");
    const r = await lerRascunho(page);
    assert.equal(r.concluida, true);
    assert.equal(r.pendente, false, "o último salvamento foi confirmado antes de sair");
    // A página de obrigado registra a visita dela, com o perfil e a sessão desta resposta.
    const visita = await ate(() => reg.pagina.find((e) => e.evento === "visita"));
    assert.equal(visita.pagina, O.paginaDoPerfil(perfil).id);
    assert.equal(visita.perfil, perfil);
    assert.equal(visita.sessao_id, r.id);
    assert.equal(visita.utm_campaign, "icp-set");
  });
}

caso("\"voltar\" na página de obrigado sai do site (não recarrega a pesquisa)", async (page) => {
  await page.goto("about:blank");
  await comecar(page);
  await responderAteOFim(page, { perfil: P.PERFIL.cuidador });
  await esperarObrigado(page, "/obrigado-cuidador");
  await page.goBack();
  await page.waitForURL("about:blank");
});

caso("cabeçalho: etapa X de Y muda com o perfil e fala da etapa", async (page) => {
  await comecar(page);
  assert.match(await page.textContent("#topo-etapa"), /Etapa 1 de 8 · Sobre você/);
  await esperar(700);
  assert.equal(await page.textContent("#tela-pergunta .fala-texto"), "Pra começar, a gente quer te conhecer um pouquinho, Maria.");
  await responder(page, { perfil: P.PERFIL.tecnico });
  assert.match(await page.textContent("#topo-etapa"), /Etapa 1 de 9/);
  assert.equal(await page.locator("#tela-pergunta .fala").count(), 0, "idade não abre etapa");
  assert.equal(await page.getAttribute("#barra", "role"), "progressbar");
});

caso("única: só os 4 perfis, toque avança sozinho, voltar mostra a escolha e o Continuar", async (page, reg) => {
  await comecar(page);
  const valores = await page.$$eval("#tela-pergunta .opcao", (botoes) => botoes.map((b) => b.dataset.valor));
  assert.deepEqual(valores, Object.values(P.PERFIL));
  assert.equal(await page.locator('#tela-pergunta .opcao[data-valor="Outro"]').count(), 0);
  assert.equal(await page.locator("#tela-pergunta .outro").count(), 0, "nenhum campo 'qual?'");
  assert.equal(await page.isHidden("#botao-continuar"), true, "sem resposta, a única não mostra Continuar");
  await page.click(`#tela-pergunta .opcao[data-valor="${P.PERFIL.cuidador}"]`);
  await esperarTrocar(page, "perfil");
  assert.equal((await perguntaAtual(page)).id, "idade", "avançou sozinho");
  await page.click("#botao-voltar");
  await esperarTrocar(page, "idade");
  assert.equal((await perguntaAtual(page)).id, "perfil");
  assert.equal(await page.getAttribute(`#tela-pergunta .opcao[data-valor="${P.PERFIL.cuidador}"]`, "aria-checked"), "true");
  assert.equal(await page.isVisible("#botao-continuar"), true, "respondida mostra Continuar");
  await page.click("#botao-continuar");
  await esperarTrocar(page, "perfil");
  await esperar(300);
  const u = reg.salvar[reg.salvar.length - 1];
  assert.deepEqual(u.respostas, { perfil: P.PERFIL.cuidador });
});

caso("múltipla: exclusivas, contador, desmarcar, e nenhuma alternativa \"Outro\"", async (page, reg) => {
  await comecar(page);
  for (let i = 0; i < 7; i += 1) await responder(page); // até ambientes
  assert.equal((await perguntaAtual(page)).id, "ambientes");
  const op = (v) => page.locator(`#tela-pergunta .opcao[data-valor="${v}"]`);
  assert.deepEqual(
    await page.$$eval("#tela-pergunta .opcao", (botoes) => botoes.map((b) => b.dataset.valor)),
    [...P.perguntaPorId("ambientes").opcoes]
  );
  assert.equal(await op("Outro").count(), 0);
  await op("Hospital").click();
  await op("Clínica").click();
  assert.equal(await page.textContent(".contador-marcadas"), "2 marcadas");
  await op("Ainda não sei").click();
  assert.equal(await op("Hospital").getAttribute("aria-checked"), "false");
  assert.equal(await op("Ainda não sei").getAttribute("aria-checked"), "true");
  assert.equal(await page.textContent(".contador-marcadas"), "1 marcada");
  await op("Home care").click();
  assert.equal(await op("Ainda não sei").getAttribute("aria-checked"), "false");
  await op("Hospital").click();
  await page.click("#botao-continuar");
  await esperarTrocar(page, "ambientes");
  await esperar(300);
  const u = reg.salvar[reg.salvar.length - 1];
  // Ordem canônica (a da pergunta), não a do toque.
  assert.deepEqual(u.respostas.ambientes, ["Hospital", "Home care"]);
  // Voltar e desmarcar uma: sai do que é gravado.
  await page.click("#botao-voltar");
  await esperarTrocar(page, "renda_atual");
  await op("Hospital").click();
  await page.click("#botao-continuar");
  await esperarTrocar(page, "ambientes");
  await esperar(300);
  assert.deepEqual(reg.salvar[reg.salvar.length - 1].respostas.ambientes, ["Home care"]);
});

caso("múltipla vazia mostra erro; estado e escala", async (page, reg) => {
  await comecar(page);
  await responder(page);
  await responder(page); // idade
  assert.equal((await perguntaAtual(page)).id, "estado");
  await page.click("#botao-continuar");
  await page.waitForFunction(() => /estado/.test(document.querySelector(".pergunta-erro").textContent));
  await page.selectOption("#tela-pergunta select", "Bahia");
  await page.click("#botao-continuar");
  await esperarTrocar(page, "estado");
  for (let i = 0; i < 4; i += 1) await responder(page); // localidade, tempo_area, situacao, trabalha
  assert.equal((await perguntaAtual(page)).id, "ambientes");
  assert.equal(await page.evaluate(() => document.getElementById("botao-continuar").classList.contains("apagado")), true);
  await page.click("#botao-continuar");
  await page.waitForFunction(() => document.querySelector(".pergunta-erro").textContent.includes("pelo menos uma"));
  assert.equal((await perguntaAtual(page)).id, "ambientes");
  for (let i = 0; i < 4; i += 1) await responder(page); // ambientes, renda, maior_dificuldade, situacao_incomoda
  assert.equal((await perguntaAtual(page)).id, "seguranca");
  assert.equal(await page.isHidden("#rodape"), true, "escala sem resposta não mostra rodapé");
  await page.click('.escala-numero[data-valor="0"]');
  await esperarTrocar(page, "seguranca");
  await esperar(300);
  assert.equal(reg.salvar[reg.salvar.length - 1].respostas.seguranca, 0);
  assert.equal(reg.salvar[reg.salvar.length - 1].respostas.estado, "Bahia");
});

caso("texto opcional pulado e frase", async (page, reg) => {
  await comecar(page);
  let { id } = await perguntaAtual(page);
  while (id !== "problema_unico") {
    await responder(page);
    ({ id } = await perguntaAtual(page));
  }
  assert.equal(await page.isVisible("#botao-pular"), true);
  await page.fill("#tela-pergunta textarea", "abc");
  assert.equal(await page.isVisible("#botao-pular"), false, "pular some com texto");
  assert.equal(await page.textContent(".contador"), "3/1000");
  await page.fill("#tela-pergunta textarea", "");
  await page.click("#botao-pular");
  await esperarTrocar(page, "problema_unico");
  await responder(page, { sonho: "Ser referência" });
  assert.equal((await perguntaAtual(page)).id, "frase");
  assert.equal(await page.locator("#tela-pergunta textarea").count(), 2);
  await responder(page);
  await esperar(300);
  const u = reg.salvar[reg.salvar.length - 1];
  assert.equal(u.respostas.problema_unico, undefined);
  assert.equal(u.respostas.sonho, "Ser referência");
  assert.equal(u.respostas.frase_desejo, "ser enfermeira");
  assert.equal(u.respostas.frase_bloqueio, "falta tempo");
});

caso("voltar e trocar o perfil limpa o bloco antigo (e vai para a página do perfil novo)", async (page, reg) => {
  await comecar(page);
  // Até a última pergunta do bloco do técnico (concluir já redirecionaria para o obrigado).
  await responderAte(page, "tecnico_objetivo", { perfil: P.PERFIL.tecnico });
  await esperar(300);
  assert.notEqual(reg.salvar[reg.salvar.length - 1].respostas.tecnico_momento, undefined);
  // Volta até o perfil pelo botão do navegador.
  for (let i = 0; i < 40; i += 1) {
    if ((await perguntaAtual(page)).id === "perfil") break;
    const antes = (await perguntaAtual(page)).id;
    await page.goBack();
    await esperarTrocar(page, antes);
  }
  assert.equal((await perguntaAtual(page)).id, "perfil");
  assert.equal(await page.isVisible("#botao-continuar"), true, "respondida mostra Continuar");
  await page.click(`#tela-pergunta .opcao[data-valor="${P.PERFIL.cuidador}"]`);
  await esperarTrocar(page, "perfil");
  assert.equal((await perguntaAtual(page)).id, "cuidador_realidade", "vai direto ao que falta");
  await esperar(300);
  const u = reg.salvar[reg.salvar.length - 1];
  assert.equal(u.respostas.tecnico_momento, undefined);
  assert.equal(u.respostas.tecnico_objetivo, undefined);
  assert.equal(u.respostas.perfil, P.PERFIL.cuidador);
  await responder(page);
  await responder(page);
  await esperarObrigado(page, "/obrigado-cuidador");
  conferirSeqs(reg);
});

caso("recarregar no meio e retomar", async (page) => {
  await comecar(page);
  for (let i = 0; i < 5; i += 1) await responder(page);
  const onde = (await perguntaAtual(page)).id;
  assert.equal(onde, "situacao_profissional");
  await page.reload();
  await page.waitForSelector("#botao-do-zero:not([hidden])");
  assert.equal(await page.textContent("#bv-titulo"), "Que bom te ver de novo, Maria!");
  assert.match(await page.textContent("#bv-texto"), /etapa 2 de 9/);
  assert.equal(await page.textContent("#botao-comecar-texto"), "Continuar de onde parei");
  await page.click("#botao-comecar");
  await page.waitForSelector("#tela-pergunta:not([hidden])");
  assert.equal((await perguntaAtual(page)).id, onde);
  // Voltar do navegador depois de retomar volta uma pergunta, não sai.
  await page.goBack();
  await esperarTrocar(page, onde);
  assert.equal((await perguntaAtual(page)).id, "tempo_area");
  await page.goBack();
  await esperarTrocar(page, "tempo_area");
  assert.equal((await perguntaAtual(page)).id, "localidade");
  assert.ok(page.url().includes("/pesquisa-icp"));
});

caso("rascunho antigo com \"Outro\" no aparelho: é limpo ao abrir e a pessoa refaz só o perfil", async (page, reg) => {
  // Um celular que respondeu uma versão de teste com "Outro" (a VERSAO não mudou). Ao abrir de
  // novo, o rascunho passa pelas regras de hoje: perfil "Outro" e os complementos somem.
  await page.goto(base + URLQ);
  // O rascunho antigo entra NO COMEÇO do recarregamento: gravado antes, seria sobrescrito pelo
  // próprio formulário, que guarda o estado dele ao sair da página (pagehide).
  await page.addInitScript((antigo) => {
    if (sessionStorage.getItem("rascunho-antigo-injetado")) return;
    sessionStorage.setItem("rascunho-antigo-injetado", "1");
    const atual = JSON.parse(localStorage.getItem("ev_pesquisa_icp_v1") || "null") || {};
    localStorage.setItem("ev_pesquisa_icp_v1", JSON.stringify(Object.assign(atual, antigo)));
  }, {
    seq: 3,
    contato: { nome: "Maria da Silva", whatsapp: "(11) 91234-5678", email: "maria@gmail.com" },
    respostas: {
      perfil: "Outro",
      perfil_outro: "Doula",
      idade: "35 a 44 anos",
      ambientes: ["Hospital", "Outro"],
      ambientes_outro: "Escola"
    },
    pergunta_atual: "estado",
    concluida: false
  });
  await page.reload();
  await page.waitForSelector("#botao-do-zero:not([hidden])");
  const limpo = await lerRascunho(page);
  assert.deepEqual(limpo.respostas, { idade: "35 a 44 anos", ambientes: ["Hospital"] });
  await page.click("#botao-comecar");
  await page.waitForSelector("#tela-pergunta:not([hidden])");
  assert.equal((await perguntaAtual(page)).id, "perfil", "sem perfil válido, retoma na pergunta 1");
  await responder(page, { perfil: P.PERFIL.enfermeiro });
  await esperar(300);
  const u = reg.salvar[reg.salvar.length - 1];
  assert.equal(u.respostas.perfil, P.PERFIL.enfermeiro);
  assert.ok(!Object.keys(u.respostas).some((k) => k.endsWith("_outro")));
  assert.deepEqual(u.respostas.ambientes, ["Hospital"]);
});

caso("começar do zero: nova sessão, contato preenchido", async (page, reg) => {
  await comecar(page);
  await responder(page);
  await responder(page);
  const idAntigo = (await lerRascunho(page)).id;
  await page.reload();
  await page.click("#botao-do-zero");
  await page.waitForSelector("#tela-contato:not([hidden])");
  assert.equal(await page.inputValue("#campo-nome"), "maria da silva");
  await page.click("#botao-contato");
  await page.waitForSelector("#tela-pergunta:not([hidden])");
  assert.equal((await perguntaAtual(page)).id, "perfil");
  const novos = reg.salvar.filter((c) => c.id !== idAntigo);
  assert.ok(novos.length >= 1);
  assert.deepEqual(novos[0].respostas, {});
  assert.equal(novos[0].seq, 1);
});

caso("já concluída: reabrir a pesquisa leva direto ao obrigado; ?nova=1 recomeça como outra pessoa", async (page, reg) => {
  await comecar(page);
  await responderAteOFim(page, { perfil: P.PERFIL.auxiliar });
  await esperarObrigado(page, "/obrigado-afericao");
  const salvos = reg.salvar.length;
  // Reabre pelo link "pelado" (sem UTM): volta para a MESMA página, com as UTMs do primeiro toque.
  await page.goto(base + "/pesquisa-icp");
  const chegada = await esperarObrigado(page, "/obrigado-afericao");
  assert.equal(chegada.search, `?${QUERY}`);
  assert.equal(reg.salvar.length, salvos, "reabrir não grava de novo");
  // O ?nova=1 não tem mais link no rodapé do obrigado (só confundia quem acabou de responder),
  // mas o endereço continua recomeçando a pesquisa como outra pessoa.
  await page.goto(base + "/pesquisa-icp?nova=1");
  await page.waitForSelector("#tela-boasvindas:not([hidden])");
  assert.equal(new URL(page.url()).search, "", "o ?nova=1 sai da URL");
  assert.equal(await page.textContent("#botao-comecar-texto"), "Começar");
  const r = await lerRascunho(page);
  assert.equal(r.contato, null);
  assert.deepEqual(r.respostas, {});
  assert.equal(r.concluida, false);
  assert.equal(r.rastreio.utm_source, "instagram", "rastreio do aparelho continua");
  await page.click("#botao-comecar");
  assert.equal(await page.inputValue("#campo-nome"), "");
  // Recarregar não apaga de novo (o parâmetro já saiu).
  await page.reload();
  assert.equal((await lerRascunho(page)).id, r.id);
});

let lentoUsado = false;
const regLento = [];
caso(
  "servidor lento no último salvamento: sai em ~2,5 s mesmo assim, com o estado em keepalive",
  async (page, reg) => {
    await comecar(page);
    await responderAteOFim(page, { perfil: P.PERFIL.cuidador });
    const antes = Date.now();
    await esperarObrigado(page, "/obrigado-cuidador");
    const levou = Date.now() - antes;
    assert.ok(levou >= 2000 && levou < 6000, `levou ${levou} ms`);
    await esperar(300);
    // O salvamento lento (preso no servidor) + o reenvio com keepalive na saída.
    const fins = regLento.filter((c) => c.pergunta_atual === "fim");
    assert.ok(fins.length >= 2, `salvamentos de fim: ${fins.length}`);
    assert.ok(fins[fins.length - 1].seq > fins[0].seq);
    assert.equal(fins[fins.length - 1].respostas.perfil, P.PERFIL.cuidador);
  },
  {
    modo: {
      salvar: async (c) => {
        // Registro na chegada (a resposta do lento nunca é entregue: a página já saiu).
        regLento.push(c);
        if (c.pergunta_atual === "fim" && !lentoUsado) {
          lentoUsado = true;
          await esperar(6000);
        }
        return null;
      }
    }
  }
);

caso(
  "422 do contato no último salvamento: não sai da pesquisa, volta ao contato",
  async (page) => {
    await comecar(page);
    // Responde tudo; o fim aparece de passagem e a recusa do servidor leva ao contato.
    for (let i = 0; i < 60; i += 1) {
      const { id } = await perguntaAtual(page);
      if (id === "fim" || id === "contato") break;
      await responder(page, { perfil: P.PERFIL.enfermeiro });
    }
    await page.waitForSelector("#tela-contato:not([hidden])", { timeout: 5000 });
    assert.equal(await page.textContent("#erro-whatsapp"), "Esse DDD não existe. Confere o número?");
    await esperar(3000);
    assert.ok(new URL(page.url()).pathname === "/pesquisa-icp", "não redirecionou");
    await page.fill("#campo-whatsapp", "");
    await page.type("#campo-whatsapp", "21912345678");
    await page.click("#botao-contato");
    await esperarObrigado(page, "/obrigado-evento-outubro");
  },
  {
    modo: {
      salvar: (c) =>
        c.pergunta_atual === "fim" && c.contato.whatsapp.startsWith("(11)")
          ? { status: 422, json: { ok: false, error: "invalid_contact", campos: { whatsapp: "Esse DDD não existe. Confere o número?" } } }
          : null
    }
  }
);

caso("botão voltar do navegador: na boas-vindas deixa sair", async (page) => {
  await page.goto("about:blank");
  await page.goto(base + URLQ);
  await page.click("#botao-comecar");
  await page.waitForSelector("#tela-contato:not([hidden])");
  await page.goBack();
  await page.waitForSelector("#tela-boasvindas:not([hidden])");
  await page.goBack();
  await page.waitForURL("about:blank");
});

caso(
  "422 do contato mostra erro no campo e não segue",
  async (page) => {
    await page.goto(base + URLQ);
    await page.click("#botao-comecar");
    await preencherContato(page, { ...CONTATO, email: "maria@dominioquenaoexiste.com.br" });
    await page.waitForSelector("#erro-email:not([hidden])");
    assert.equal(await page.textContent("#erro-email"), "Não encontramos esse endereço de e-mail. Confere se está certinho?");
    assert.equal(await page.getAttribute("#campo-email", "aria-invalid"), "true");
    assert.equal(await page.evaluate(() => document.activeElement.id), "campo-email");
    assert.equal((await perguntaAtual(page)).id, "contato");
    await page.fill("#campo-email", "maria@gmail.com");
    assert.equal(await page.isHidden("#erro-email"), true, "erro some ao corrigir");
    await page.click("#botao-contato");
    await page.waitForSelector("#tela-pergunta:not([hidden])");
  },
  {
    modo: {
      salvar: (c) =>
        c.contato.email.includes("naoexiste")
          ? { status: 422, json: { ok: false, error: "invalid_contact", campos: { email: "Não encontramos esse endereço de e-mail. Confere se está certinho?" } } }
          : null
    }
  }
);

caso("validação local do contato e máscara", async (page, reg) => {
  await page.goto(base + URLQ);
  await page.click("#botao-comecar");
  await page.click("#botao-contato");
  assert.equal(await page.textContent("#erro-nome"), "Escreva seu nome.");
  assert.equal(await page.evaluate(() => document.activeElement.id), "campo-nome");
  await page.fill("#campo-nome", "Maria");
  await page.locator("#campo-whatsapp").focus();
  assert.equal(await page.textContent("#erro-nome"), "Escreva também o seu sobrenome.");
  await page.type("#campo-whatsapp", "21987654321");
  assert.equal(await page.inputValue("#campo-whatsapp"), "(21) 98765-4321");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  assert.equal(await page.inputValue("#campo-whatsapp"), "(21) 98765-43");
  await page.fill("#campo-email", "maria@gmail.con");
  await page.click("#botao-contato");
  assert.equal(await page.textContent("#erro-email"), "Confere o final do e-mail, parece que tem um erro de digitação.");
  assert.equal(await page.isVisible("#sugestao-email"), true);
  assert.equal(await page.isHidden("#sugestao-nao"), true, "typo não deixa manter");
  assert.equal(reg.salvar.length, 0);
});

caso("WhatsApp colado no formato do próprio WhatsApp (+55 11 9xxxx-xxxx) não é cortado", async (page) => {
  await page.goto(base + URLQ);
  await page.click("#botao-comecar");
  for (const colado of ["+55 11 91234-5678", "+55 (11) 91234-5678", "(11) 9 1234-5678"]) {
    await page.fill("#campo-whatsapp", "");
    await page.locator("#campo-whatsapp").focus();
    await page.keyboard.insertText(colado); // respeita o maxlength, como uma colagem de verdade
    assert.equal(await page.inputValue("#campo-whatsapp"), "(11) 91234-5678", colado);
  }
});

caso("toque duplo na única não responde a pergunta seguinte sem a pessoa ver", async (page, reg) => {
  await comecar(page);
  assert.equal((await perguntaAtual(page)).id, "perfil");
  await esperar(700); // a pessoa lê a pergunta antes do primeiro toque
  const alvo = await page.locator(".opcao").nth(1).boundingBox();
  const x = alvo.x + alvo.width / 2;
  const y = alvo.y + alvo.height / 2;
  await page.touchscreen.tap(x, y);
  await esperar(400); // o avanço automático sai em 300 ms; o segundo toque cai na tela nova
  await page.touchscreen.tap(x, y);
  await esperarTrocar(page, "perfil");
  await esperar(700);
  const r = await lerRascunho(page);
  const seguinte = (await perguntaAtual(page)).id;
  assert.equal(r.respostas[seguinte], undefined, `a pergunta "${seguinte}" ficou sem resposta`);
  assert.equal(Object.keys(r.respostas).length, 1, JSON.stringify(r.respostas));
});

caso("sugestão de e-mail gmial.com", async (page, reg) => {
  await page.goto(base + URLQ);
  await page.click("#botao-comecar");
  await page.fill("#campo-nome", "Maria Silva");
  await page.type("#campo-whatsapp", "11912345678");
  await page.fill("#campo-email", "maria@gmial.com");
  await page.locator("#campo-email").blur();
  await page.waitForSelector("#sugestao-email:not([hidden])");
  assert.equal(await page.textContent("#sugestao-valor"), "maria@gmail.com");
  await page.click("#botao-contato");
  await page.waitForSelector("#sugestao-email.destaque");
  assert.equal(reg.salvar.length, 0, "não enviou com sugestão pendente");
  await page.click("#sugestao-sim");
  assert.equal(await page.inputValue("#campo-email"), "maria@gmail.com");
  await page.click("#botao-contato");
  await page.waitForSelector("#tela-pergunta:not([hidden])");
  assert.equal(reg.salvar[0].contato.email, "maria@gmail.com");
});

caso("sugestão recusada: 'meu e-mail está certo' segue", async (page, reg) => {
  await page.goto(base + URLQ);
  await page.click("#botao-comecar");
  await page.fill("#campo-nome", "Maria Silva");
  await page.type("#campo-whatsapp", "11912345678");
  await page.fill("#campo-email", "maria@gmial.com");
  await page.click("#botao-contato");
  await page.waitForSelector("#sugestao-email.destaque");
  await page.click("#sugestao-nao");
  await page.click("#botao-contato");
  await page.waitForSelector("#tela-pergunta:not([hidden])");
  assert.equal(reg.salvar[0].contato.email, "maria@gmial.com");
});

let fora = true;
caso(
  "rede caída: segue em frente e re-envia depois",
  async (page, reg) => {
    await page.goto(base + URLQ);
    await page.click("#botao-comecar");
    await preencherContato(page);
    await page.waitForSelector("#tela-pergunta:not([hidden])");
    await responder(page);
    await responder(page);
    await page.waitForFunction(() => document.getElementById("salvamento").dataset.estado === "offline");
    assert.match(await page.textContent("#salvamento-texto"), /Sem internet/);
    assert.equal(reg.salvar.length, 0);
    assert.ok(reg.abortados >= 1);
    fora = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForFunction(() => document.getElementById("salvamento").dataset.estado === "salvo", null, { timeout: 8000 });
    const u = reg.salvar[reg.salvar.length - 1];
    assert.notEqual(u.respostas.idade, undefined);
    assert.equal(u.pergunta_atual, "estado");
    assert.equal((await lerRascunho(page)).pendente, false);
  },
  { modo: { salvar: () => (fora ? "abort" : null) } }
);

let fora2 = true;
caso(
  "sem internet, fecha e reabre: manda o pendente ao carregar",
  async (page, reg) => {
    await page.goto(base + URLQ);
    await page.click("#botao-comecar");
    await preencherContato(page);
    await page.waitForSelector("#tela-pergunta:not([hidden])");
    await responder(page, { perfil: P.PERFIL.enfermeiro });
    assert.equal((await lerRascunho(page)).pendente, true);
    fora2 = false;
    await page.reload();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("ev_pesquisa_icp_v1")).pendente === false, null, { timeout: 5000 });
    assert.equal(reg.salvar[reg.salvar.length - 1].respostas.perfil, P.PERFIL.enfermeiro);
  },
  { modo: { salvar: () => (fora2 ? "abort" : null) } }
);

caso(
  "5xx também re-tenta com backoff",
  async (page, reg) => {
    await page.goto(base + URLQ);
    await page.click("#botao-comecar");
    await preencherContato(page);
    await page.waitForSelector("#tela-pergunta:not([hidden])");
    await responder(page);
    await page.waitForFunction(() => document.getElementById("salvamento").dataset.estado === "salvo", null, { timeout: 9000 });
    assert.ok(reg.salvar.length >= 3);
    conferirSeqs(reg);
  },
  { modo: { salvar: (c, n) => (n < 2 ? { status: 503, json: { ok: false, error: "database_not_configured" } } : null) } }
);

caso(
  "fila: no máximo 1 em voo, estado mais novo depois",
  async (page, reg) => {
    await page.goto(base + URLQ);
    await page.click("#botao-comecar");
    await preencherContato(page);
    await page.waitForSelector("#tela-pergunta:not([hidden])");
    await page.evaluate(() => {
      window.__voo = 0;
      window.__max = 0;
      const f = window.fetch;
      window.fetch = async (...a) => {
        if (String(a[0]).includes("salvar")) {
          window.__voo++;
          window.__max = Math.max(window.__max, window.__voo);
          try {
            return await f(...a);
          } finally {
            window.__voo--;
          }
        }
        return f(...a);
      };
    });
    for (let i = 0; i < 6; i += 1) await responder(page);
    await page.waitForFunction(() => document.getElementById("salvamento").dataset.estado === "salvo", null, { timeout: 9000 });
    assert.equal(await page.evaluate(() => window.__max), 1);
    const u = reg.salvar[reg.salvar.length - 1];
    assert.equal(u.pergunta_atual, (await perguntaAtual(page)).id);
    conferirSeqs(reg);
  },
  {
    modo: {
      salvar: async () => {
        await esperar(250);
        return null;
      }
    }
  }
);

caso(
  "422 invalid_contact depois do contato volta à tela de contato",
  async (page, reg) => {
    await comecar(page);
    await page.click(`#tela-pergunta .opcao[data-valor="${P.PERFIL.cuidador}"]`);
    await page.waitForSelector("#tela-contato:not([hidden])");
    assert.equal(await page.textContent("#erro-whatsapp"), "Esse DDD não existe. Confere o número?");
    await page.fill("#campo-whatsapp", "");
    await page.type("#campo-whatsapp", "21912345678");
    await page.click("#botao-contato");
    await page.waitForSelector("#tela-pergunta:not([hidden])");
    assert.equal((await perguntaAtual(page)).id, "idade", "volta para onde estava");
    await esperar(300);
    assert.equal(reg.salvar[reg.salvar.length - 1].respostas.perfil, P.PERFIL.cuidador);
  },
  {
    modo: {
      salvar: (c) =>
        c.respostas.perfil && c.contato.whatsapp.startsWith("(11)")
          ? { status: 422, json: { ok: false, error: "invalid_contact", campos: { whatsapp: "Esse DDD não existe. Confere o número?" } } }
          : null
    }
  }
);

caso(
  "pagehide manda keepalive com o pendente",
  async (page) => {
  await comecar(page);
  await page.click(`#tela-pergunta .opcao[data-valor="${P.PERFIL.cuidador}"]`);
  await esperarTrocar(page, "perfil");
  await page.evaluate(() => {
    const f = window.fetch;
    window.__keep = 0;
    window.fetch = (u, o) => {
      if (o && o.keepalive && String(u).includes("salvar")) window.__keep++;
      return f(u, o);
    };
  });
  await page.locator("#tela-pergunta .opcao").nth(2).click();
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  assert.ok((await page.evaluate(() => window.__keep)) >= 1);
  },
  // Servidor sem pressa: o salvamento ainda está em voo no pagehide (sem isso, o teste dependia
  // de o servidor local responder antes ou depois do evento).
  {
    modo: {
      salvar: async () => {
        await esperar(400);
        return null;
      }
    }
  }
);

caso(
  "teclado: fluxo inteiro sem mouse",
  async (page) => {
    await page.goto(base + URLQ);
    await page.keyboard.press("Tab"); // link "pular"
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "botao-comecar");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#tela-contato:not([hidden])");
    await page.keyboard.press("Tab");
    // Foco no título → próximo Tab = campo nome.
    assert.equal(await page.evaluate(() => document.activeElement.id), "campo-nome");
    await page.keyboard.type("Ana Paula Souza");
    await page.keyboard.press("Enter");
    await page.keyboard.type("31988887777");
    await page.keyboard.press("Enter");
    await page.keyboard.type("ana@hotmail.com");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#tela-pergunta:not([hidden])");
    assert.equal(await page.evaluate(() => document.activeElement.tagName), "H2");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.dataset.valor), P.PERFIL.auxiliar);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement.dataset.valor), P.PERFIL.tecnico);
    assert.equal((await perguntaAtual(page)).id, "perfil", "seta não responde");
    // Setas dão a volta nos 4 perfis: do último vai para o primeiro.
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement.dataset.valor), P.PERFIL.enfermeiro);
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement.dataset.valor), P.PERFIL.auxiliar);
    for (let i = 0; i < 2; i += 1) await page.keyboard.press("ArrowUp");
    assert.equal(await page.evaluate(() => document.activeElement.dataset.valor), P.PERFIL.tecnico);
    await page.keyboard.press("Space");
    await esperarTrocar(page, "perfil");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await esperarTrocar(page, "idade");
    assert.equal((await perguntaAtual(page)).id, "estado");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.tagName), "SELECT");
    await page.selectOption("#tela-pergunta select", "Pará");
    await page.keyboard.press("Enter");
    await esperarTrocar(page, "estado");
    assert.equal((await perguntaAtual(page)).id, "localidade");
  },
  { largura: 1280, altura: 800, mobile: false }
);

caso(
  "reduced motion: sem animação e sem digitando",
  async (page) => {
    await comecar(page);
    assert.equal(await page.locator(".digitando").count(), 0);
    assert.match(await page.textContent("#tela-pergunta .fala-texto"), /Pra começar/);
    const anim = await page.evaluate(() => getComputedStyle(document.getElementById("tela-pergunta")).animationName);
    assert.equal(anim, "none");
  },
  { reduzir: true }
);

caso("digitando aparece e some em ~600ms", async (page) => {
  await comecar(page);
  assert.equal(await page.locator(".digitando").count(), 1);
  await esperar(750);
  assert.equal(await page.locator(".digitando").count(), 0);
  assert.match(await page.textContent("#tela-pergunta .fala-texto"), /Maria/);
});

caso("sem localStorage: funciona e não quebra", async (page, reg) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("bloqueado");
      }
    });
  });
  await comecar(page);
  await responder(page);
  await responder(page);
  await esperar(300);
  assert.ok(reg.salvar.length >= 2);
  assert.match(reg.salvar[0].visitante_id, /^[0-9a-f-]{36}$/);
});

caso("UTM de primeiro toque: a campanha da primeira visita fica inteira (sem misturar com a nova)", async (page, reg) => {
  await page.goto(base + "/pesquisa-icp?utm_source=instagram");
  await page.goto(base + "/pesquisa-icp?utm_source=whatsapp&utm_campaign=nova&fbclid=FBX");
  const r = await lerRascunho(page);
  assert.equal(r.rastreio.utm_source, "instagram");
  assert.equal(r.rastreio.utm_campaign, null);
  assert.equal(r.rastreio.fbclid, null);
  assert.equal(reg.evento.length, 2);
  assert.ok(reg.evento.every((e) => e.evento === "visita" && e.visitante_id === reg.evento[0].visitante_id));
});

caso("pixel: eventos certos quando fbq existe (inclui pesquisa_icp_concluida com código e página)", async (page) => {
  // O registro sobrevive à troca de página (o fim redireciona para o obrigado).
  const px = [];
  await page.exposeFunction("__registrarPx", (a) => px.push(a));
  await page.addInitScript(() => {
    window.fbq = (...a) => window.__registrarPx(JSON.parse(JSON.stringify(a.slice(0, 3))));
  });
  await comecar(page);
  await responderAteOFim(page, { perfil: P.PERFIL.tecnico });
  await esperarObrigado(page, "/obrigado-evento-outubro");
  const nomes = px.map((a) => a[1]);
  assert.equal(nomes[0], "PesquisaIniciada");
  assert.ok(nomes.includes("Lead"));
  assert.equal(nomes.filter((n) => n === "PesquisaEtapa").length, 9);
  assert.deepEqual(px.find((a) => a[1] === "PesquisaConcluida")[2], { perfil: P.PERFIL.tecnico });
  assert.deepEqual(px.find((a) => a[1] === "pesquisa_icp_concluida"), [
    "trackCustom",
    "pesquisa_icp_concluida",
    { perfil: "tecnico_enfermagem", pagina_obrigado: "evento_outubro" }
  ]);
  assert.equal(nomes.filter((n) => n === "pesquisa_icp_concluida").length, 1);
  // Reabrir já concluída não repete a conversão.
  await page.goto(base + "/pesquisa-icp");
  await esperarObrigado(page, "/obrigado-evento-outubro");
  assert.equal(px.filter((a) => a[1] === "pesquisa_icp_concluida").length, 1);
});

for (const [largura, altura] of [
  [320, 568],
  [360, 740],
  [390, 844],
  [768, 1024],
  [1280, 800]
]) {
  caso(
    `sem rolagem horizontal em ${largura}px (todas as telas)`,
    async (page) => {
      const conferir = async (onde) => {
        const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
        assert.ok(w[0] <= w[1], `${onde}: ${w}`);
      };
      await page.goto(base + URLQ);
      await conferir("boasvindas");
      await page.click("#botao-comecar");
      await esperar(300);
      await conferir("contato");
      await preencherContato(page);
      await page.waitForSelector("#tela-pergunta:not([hidden])");
      for (let i = 0; i < 45; i += 1) {
        const { id } = await perguntaAtual(page);
        if (id === "fim" || id === "obrigado") {
          // O fim leva à página de obrigado: ela também não pode rolar para o lado.
          await esperarObrigado(page, "/obrigado-evento-outubro");
          await conferir("obrigado");
          break;
        }
        await esperar(280);
        await conferir(id);
        // O rodapé fixo não pode cobrir o último controle quando se rola até o fim.
        {
          const cobre = await page.evaluate(() => {
            window.scrollTo(0, document.documentElement.scrollHeight);
            const rod = document.getElementById("rodape");
            if (rod.hidden) return false;
            const topoRod = rod.getBoundingClientRect().top + 18;
            const itens = document.querySelectorAll(
              "#tela-pergunta .opcao, #tela-pergunta .escala-numero, #tela-pergunta textarea, #tela-pergunta select, .escala-legendas"
            );
            const ultimo = itens[itens.length - 1];
            return ultimo ? ultimo.getBoundingClientRect().bottom > topoRod : false;
          });
          assert.equal(cobre, false, `rodapé cobre conteúdo em ${id}`);
        }
        await responder(page, { perfil: P.PERFIL.enfermeiro });
      }
      // Alvos de toque ≥ 44px.
      const pequenos = await page.evaluate(() =>
        Array.from(document.querySelectorAll("button, a, input, select, textarea"))
          .filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44 && !e.closest(".lgpd"))
          .map((e) => e.id || e.className)
      );
      assert.deepEqual(pequenos, []);
    },
    { largura, altura, mobile: largura < 768 }
  );
}
