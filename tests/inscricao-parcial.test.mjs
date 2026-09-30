/*
 * POST /api/inscricao/parcial — o RASCUNHO de quem começou a preencher e ainda não enviou.
 *
 * O que estes testes protegem, em ordem de importância:
 *   . rascunho incompleto é o caso NORMAL: "Mar", "(11) 9" e "joao@" precisam entrar. Recusar por
 *     contato inválido seria jogar fora exatamente o lead que se quer resgatar;
 *   . o que entra passa pela mesma régua de normalização do contato completo (nome capitalizado,
 *     telefone com máscara + dígitos, e-mail minúsculo);
 *   . formulário em branco não vira linha no banco;
 *   . nada aqui responde erro que a página precise tratar — ela dispara e segue a vida.
 */
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { afterEach, test } from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServerApp, normalizarContatoParcial } from "../server.mjs";

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const contexto = {};
vm.runInNewContext(readFileSync(path.join(RAIZ, "js", "lead-rules.js"), "utf8"), contexto);
vm.runInNewContext(readFileSync(path.join(RAIZ, "js", "checkout-config.js"), "utf8"), contexto);
const PAGINA = [...contexto.EVCheckout.LISTA][0].id;

const SUPABASE_URL = "https://projeto-de-teste.supabase.co";
const SUPABASE_KEY = "chave-service-role-de-teste";
const ROTA = "/api/inscricao/parcial";
const VISITANTE = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

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

async function subir({ semBanco = false, erroDoBanco = false } = {}) {
  const chamadas = [];
  const fetchImpl = async (url, init = {}) => {
    const endereco = new URL(String(url));
    chamadas.push({
      caminho: endereco.pathname,
      method: init.method || "GET",
      corpo: init.body ? JSON.parse(init.body) : null
    });
    if (erroDoBanco) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify({ ok: true, id: 1 }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const server = createServerApp({
    supabaseUrl: semBanco ? "" : SUPABASE_URL,
    supabaseKey: semBanco ? "" : SUPABASE_KEY,
    fetchImpl,
    resolveEmailDomain: async () => "ok"
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    chamadas,
    gravacao: () => chamadas.find((c) => c.caminho === "/rest/v1/rpc/inscricao_parcial_salvar")
  };
}

async function enviar(base, corpo, { metodo = "POST", tipo = "application/json", origem = "" } = {}) {
  return await new Promise((resolve, reject) => {
    const dados = typeof corpo === "string" ? corpo : JSON.stringify(corpo);
    const headers = { ...(tipo ? { "Content-Type": tipo } : {}), ...(origem ? { Origin: origem } : {}) };
    const req = httpRequest(`${base}${ROTA}`, { method: metodo, headers }, (res) => {
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

const rascunho = (contato, extra = {}) => ({ pagina: PAGINA, visitante_id: VISITANTE, contato, ...extra });

/* ------------------------------------------------------------------ o que precisa entrar */

test("só o nome, ainda pela metade: grava mesmo assim", async () => {
  const { base, gravacao } = await subir();
  const { status, json } = await enviar(base, rascunho({ nome: "mar" }));

  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.gravado, true);

  const p = gravacao().corpo.p;
  assert.equal(p.pagina, PAGINA);
  assert.equal(p.visitante_id, VISITANTE);
  assert.equal(p.nome, "Mar");
  assert.equal(p.whatsapp, null);
  assert.equal(p.whatsapp_digits, null);
  assert.equal(p.email, null);
});

test("telefone pela metade e e-mail sem arroba entram, sem virar erro de contato", async () => {
  const { base, gravacao } = await subir();
  const { status, json } = await enviar(base, rascunho({ nome: "  maria   da  silva ", whatsapp: "11 9873", email: " JOAO@ " }));

  assert.equal(status, 200);
  assert.equal(json.gravado, true);

  const p = gravacao().corpo.p;
  // A mesma régua do contato completo: nome capitalizado, telefone com máscara, e-mail minúsculo.
  assert.equal(p.nome, "Maria da Silva");
  assert.equal(p.whatsapp, "(11) 9873");
  assert.equal(p.whatsapp_digits, "119873");
  assert.equal(p.email, "joao@");
});

test("contato completo no rascunho sai igualzinho ao da inscrição", async () => {
  const { base, gravacao } = await subir();
  await enviar(base, rascunho({ nome: "ANA PAULA DE SOUZA", whatsapp: "+55 (45) 99811-2233", email: "Ana@Gmail.COM" }));

  const p = gravacao().corpo.p;
  assert.equal(p.nome, "Ana Paula de Souza");
  assert.equal(p.whatsapp, "(45) 99811-2233");
  assert.equal(p.whatsapp_digits, "45998112233");
  assert.equal(p.email, "ana@gmail.com");
});

test("formulário em branco não vai ao banco", async () => {
  const { base, chamadas } = await subir();
  const { status, json } = await enviar(base, rascunho({ nome: "  ", whatsapp: "", email: "" }));

  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.gravado, false);
  assert.equal(chamadas.length, 0, "sem nada digitado, o banco nem é procurado");
});

test("o campo em que a pessoa parou vai junto; um valor inventado vira null", async () => {
  const { base, gravacao } = await subir();
  await enviar(base, rascunho({ nome: "Ana Paula" }, { ultimo_campo: "email" }));
  assert.equal(gravacao().corpo.p.ultimo_campo, "email");

  const outro = await subir();
  await enviar(outro.base, rascunho({ nome: "Ana Paula" }, { ultimo_campo: "cartao_de_credito" }));
  assert.equal(outro.gravacao().corpo.p.ultimo_campo, null);
});

test("o rastreio da página vai no rascunho (é o que credita a campanha do lead que sumiu)", async () => {
  const { base, gravacao } = await subir();
  await enviar(
    base,
    rascunho(
      { nome: "Ana Paula" },
      {
        rastreio: {
          utm_source: "instagram",
          utm_medium: "bio",
          utm_campaign: "afericao",
          utm_term: "criativo-3",
          dispositivo: "mobile",
          page_url: "https://exemplo.com/aplicacao-afericao?utm_source=instagram"
        }
      }
    )
  );

  const p = gravacao().corpo.p;
  assert.equal(p.utm_source, "instagram");
  assert.equal(p.utm_medium, "bio");
  assert.equal(p.utm_campaign, "afericao");
  assert.equal(p.utm_term, "criativo-3");
  assert.equal(p.dispositivo, "mobile");
  assert.equal(p.page_url, "https://exemplo.com/aplicacao-afericao?utm_source=instagram");
});

/* ------------------------------------------------------------------ o que precisa ser recusado */

test("página que não existe: 422, sem tocar no banco", async () => {
  const { base, chamadas } = await subir();
  const { status, json } = await enviar(base, { pagina: "inventada", visitante_id: VISITANTE, contato: { nome: "Ana Paula" } });

  assert.equal(status, 422);
  assert.equal(json.error, "invalid_page");
  assert.equal(chamadas.length, 0);
});

test("id de página herdado de Object (toString) não passa", async () => {
  const { base } = await subir();
  const { status, json } = await enviar(base, { pagina: "toString", visitante_id: VISITANTE, contato: { nome: "Ana Paula" } });
  assert.equal(status, 422);
  assert.equal(json.error, "invalid_page");
});

test("sem visitante não há chave do rascunho: 422", async () => {
  const { base, chamadas } = await subir();
  const { status, json } = await enviar(base, { pagina: PAGINA, visitante_id: "eu-mesmo", contato: { nome: "Ana Paula" } });

  assert.equal(status, 422);
  assert.equal(json.error, "invalid_visitor");
  assert.equal(chamadas.length, 0);
});

test("GET não é aceito", async () => {
  const { base } = await subir();
  const { status } = await enviar(base, "", { metodo: "GET", tipo: "" });
  assert.equal(status, 405);
});

test("text/plain de origem desconhecida é recusado (formulário de outro site não grava nada)", async () => {
  const { base } = await subir();
  const { status, json } = await enviar(base, rascunho({ nome: "Ana Paula" }), {
    tipo: "text/plain",
    origem: "https://site-de-fora.example"
  });
  assert.equal(status, 415);
  assert.equal(json.error, "unsupported_media_type");
});

/* ------------------------------------------------------------------ o banco fora do ar */

test("sem Supabase configurado: 503, e a página não fica sabendo de nada que atrapalhe", async () => {
  const { base } = await subir({ semBanco: true });
  const { status, json } = await enviar(base, rascunho({ nome: "Ana Paula" }));
  assert.equal(status, 503);
  assert.equal(json.error, "database_not_configured");
});

test("banco respondendo erro: 502 e nada lançado", async () => {
  const { base } = await subir({ erroDoBanco: true });
  const { status, json } = await enviar(base, rascunho({ nome: "Ana Paula" }));
  assert.equal(status, 502);
  assert.equal(json.error, "database_unavailable");
});

/* ------------------------------------------------------------------ a normalização, direto */

test("normalizarContatoParcial: campo que não veio vira null (null nunca apaga o que já está gravado)", () => {
  assert.deepEqual(normalizarContatoParcial({}), { nome: null, whatsapp: null, whatsapp_digits: null, email: null });
  assert.deepEqual(normalizarContatoParcial(null), { nome: null, whatsapp: null, whatsapp_digits: null, email: null });
  assert.deepEqual(normalizarContatoParcial({ nome: 42, whatsapp: [], email: {} }), {
    nome: null,
    whatsapp: null,
    whatsapp_digits: null,
    email: null
  });
});

test("normalizarContatoParcial: texto gigante é cortado antes de chegar ao banco", () => {
  const { nome, email } = normalizarContatoParcial({ nome: "a".repeat(400), email: `${"b".repeat(400)}@x.com` });
  assert.equal(nome.length, 150);
  assert.equal(email.length, 254);
});
