// Reenvio automático ao n8n contra Postgres 17 + PostgREST de verdade (tests/e2e/stack.mjs):
// prova que os filtros da varredura, escritos para o PostgREST, pegam exatamente as tentativas
// finalizadas sem webhook_enviado_em dentro da janela, e que o PATCH marca só a entregue.
// O n8n é falso (nada sai da máquina).
//
//   node --test tests/e2e/reenvio.e2e.mjs
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createServerApp, montarPayloadWebhook } from "../../server.mjs";
import { startStack } from "./stack.mjs";

const WEBHOOK_URL = "https://n8n-falso.local/webhook/pesquisa-icp";

let stack;

before(async () => {
  stack = await startStack();
});

after(async () => {
  if (stack) await stack.stop();
});

const IDS = {
  pendente: "11111111-1111-4111-8111-111111111111",
  jaEnviada: "22222222-2222-4222-8222-222222222222",
  recente: "33333333-3333-4333-8333-333333333333",
  emAndamento: "44444444-4444-4444-8444-444444444444",
  antiga: "55555555-5555-4555-8555-555555555555",
  outraPesquisa: "66666666-6666-4666-8666-666666666666",
  // Concluída (obrigatórias respondidas) mas sem chegar à tela de fim:
  paradaNasAbertas: "77777777-7777-4777-8777-777777777777", // parada há 40 min → vai
  aindaEscrevendo: "88888888-8888-4888-8888-888888888888" // mexeu há 5 min → espera
};

test("varredura: só a pendente da janela vai ao n8n, com o payload da linha, e só ela é marcada", async () => {
  await stack.reset();
  const linha = (id, { pesquisa = "icp-escola-ev", finalizado = "now() - interval '10 minutes'", enviado = "null" } = {}) =>
    `('${id}', '${pesquisa}', '1.0', now() - interval '20 minutes', 'Maria da Silva', '(11) 91234-5678', '11912345678', 'maria@gmail.com', 'Cuidador(a)', '{"perfil":"Cuidador(a)","idade":"45 a 54 anos"}'::jsonb, 'concluida', 400, 'instagram', 'mobile', ${finalizado}, ${enviado})`;
  await stack.sql(`insert into public.pesquisa_respostas
    (id, pesquisa, pesquisa_versao, criado_em, nome, whatsapp, whatsapp_digits, email, perfil, respostas, status, tempo_total_segundos, utm_source, dispositivo, finalizado_em, webhook_enviado_em)
    values
    ${linha(IDS.pendente)},
    ${linha(IDS.jaEnviada, { enviado: "now() - interval '9 minutes'" })},
    ${linha(IDS.recente, { finalizado: "now() - interval '30 seconds'" })},
    ${linha(IDS.emAndamento, { finalizado: "null" })},
    ${linha(IDS.antiga, { finalizado: "now() - interval '8 days'" })},
    ${linha(IDS.outraPesquisa, { pesquisa: "outra" })},
    ${linha(IDS.paradaNasAbertas, { finalizado: "null" })},
    ${linha(IDS.aindaEscrevendo, { finalizado: "null" })}`);
  await stack.sql(`update public.pesquisa_respostas set status = 'em_andamento', concluido_em = null where id = '${IDS.emAndamento}'`);
  await stack.sql(`update public.pesquisa_respostas set concluido_em = now() - interval '45 minutes', atualizado_em = now() - interval '40 minutes' where id = '${IDS.paradaNasAbertas}'`);
  await stack.sql(`update public.pesquisa_respostas set concluido_em = now() - interval '10 minutes', atualizado_em = now() - interval '5 minutes' where id = '${IDS.aindaEscrevendo}'`);

  const avisos = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).startsWith(WEBHOOK_URL)) {
      avisos.push(JSON.parse(init.body));
      return new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return fetch(url, init);
  };
  const agora = Date.now();
  const server = createServerApp({
    supabaseUrl: stack.supabaseUrl,
    supabaseKey: stack.serviceKey,
    webhookUrl: WEBHOOK_URL,
    fetchImpl,
    now: () => agora,
    reenvio: { atrasoInicialMs: 60_000, intervaloMs: 60_000 }
  });

  const resultado = await server.reenvio.executar();
  assert.deepEqual(resultado, { pendentes: 2, entregues: 2 });
  assert.equal(avisos.length, 2);
  assert.deepEqual(avisos.map((a) => a.sessao_id).sort(), [IDS.pendente, IDS.paradaNasAbertas]);
  avisos.sort((a, b) => a.sessao_id.localeCompare(b.sessao_id));

  // Payload idêntico ao que o envio normal monta a partir da mesma linha do banco.
  const [linhaDoBanco] = await (
    await fetch(`${stack.supabaseUrl}/rest/v1/pesquisa_respostas?select=*&id=eq.${IDS.pendente}`, {
      headers: { apikey: stack.serviceKey, Authorization: `Bearer ${stack.serviceKey}` }
    })
  ).json();
  assert.deepEqual(avisos[0], montarPayloadWebhook({ linha: linhaDoBanco, id: IDS.pendente, contato: {}, respostas: {}, rastreio: {}, agora }));
  assert.equal(avisos[0].lead.whatsapp_internacional, "5511912345678");
  assert.equal(avisos[0].utm.utm_source, "instagram");

  const marcadas = await stack.sql("select id::text from public.pesquisa_respostas where webhook_enviado_em is not null order by id");
  assert.deepEqual(marcadas.map((r) => r.id), [IDS.pendente, IDS.jaEnviada, IDS.paradaNasAbertas]);

  // Segunda varredura: nada mais pendente.
  assert.deepEqual(await server.reenvio.executar(), { pendentes: 0, entregues: 0 });
  assert.equal(avisos.length, 2);
  server.reenvio.parar();
});
