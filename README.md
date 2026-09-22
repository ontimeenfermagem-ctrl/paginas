# Pesquisa de ICP — Escola Enfermagem de Valor

Formulário conversacional (`/pesquisa-icp`) para mapear o público da Escola Enfermagem de Valor e painel privado (`/painel`) para a equipe acompanhar as respostas. Servidor Node.js **sem dependências de runtime**: HTML, CSS e JavaScript puros, banco no Supabase e publicação no Railway.

A pessoa se identifica primeiro (nome, WhatsApp com DDD e e-mail, validados no navegador e de novo no servidor) e depois responde uma pergunta por vez. **Cada resposta é gravada na hora**: quem para no meio deixa no banco tudo o que respondeu até ali, e o painel mostra onde parou.

## Rotas

| Rota | O quê |
| --- | --- |
| `/` | Redireciona (302) para `/pesquisa-icp`, mantendo a query string (UTMs do anúncio) |
| `/pesquisa-icp` | O formulário (com Meta Pixel) |
| `/pesquisa` | Endereço antigo: 301 para `/pesquisa-icp`, com a query |
| `/painel` | Painel da equipe, com login (sem Pixel, `noindex`) |
| `/health` | `{"ok":true}` — usado pelo healthcheck do Railway |
| `POST /api/pesquisa/evento` | Visita e clique em "Começar" (topo do funil) |
| `POST /api/pesquisa/salvar` | Gravação progressiva de cada resposta |
| `/api/painel/*` | Login, resumo, lista de pessoas, respostas abertas, cruzamento e CSV (exigem sessão) |

## Estrutura

| Arquivo | Para quê |
| --- | --- |
| `js/pesquisa-config.js` | **A pesquisa inteira como dado**: perguntas, alternativas, etapas, perfis, condicionais e as regras de validação e progresso. Formulário, servidor e painel leem daqui. |
| `js/lead-rules.js` | Regras de nome, WhatsApp e e-mail (as mesmas no navegador e no servidor). |
| `pesquisa.html`, `css/pesquisa.css`, `js/pesquisa.js` | O formulário conversacional. |
| `painel.html`, `css/painel.css`, `js/painel.js` | O painel. |
| `server.mjs` | Servidor HTTP: arquivos estáticos (lista fechada de extensões), APIs, login do painel, CSV. |
| `supabase.sql` | Tabelas, views e funções do banco. Idempotente: pode rodar de novo. |
| `scripts/gerar-senha-painel.mjs` | Gera o hash da senha do painel (`npm run painel:senha`). |
| `tests/` | Testes rápidos (`npm test`). |
| `tests/e2e/` | Testes contra Postgres 17 + PostgREST de verdade, via Docker (`npm run test:e2e`). |
| `Dockerfile`, `railway.toml` | Publicação no Railway. |

### Banco (Supabase)

- `pesquisa_visitas`: uma linha por visitante (aparelho). Conta quem abriu e quem clicou em "Começar" — inclusive quem nunca se identificou.
- `pesquisa_respostas`: uma linha por **tentativa**, atualizada a cada resposta. Guarda contato, respostas (`jsonb`), até onde a pessoa chegou, tempo por pergunta e a origem (UTMs, `fbclid`, dispositivo).
- `pesquisa_pessoas` (view): uma linha por **pessoa** (WhatsApp), escolhendo a tentativa mais avançada, com o número de tentativas.
- `pesquisa_planilha` (view): a mesma coisa com **uma coluna por pergunta**, para analisar direto no Supabase.
- Funções `pesquisa_*`: gravação (`pesquisa_salvar`, `pesquisa_registrar_evento`) e os números do painel (`pesquisa_painel`, `pesquisa_cruzamento`, `pesquisa_abertas`), calculados no banco sobre o período inteiro.

Aviso ao n8n: quando a pessoa chega à tela de fim, o servidor manda **um** POST `pesquisa_concluida` (lead, UTMs, rastreio de primeiro toque e todas as perguntas do caminho dela, com a resposta crua e a legível) para `PESQUISA_WEBHOOK_URL` (padrão `https://n8n.tecnicadevalor.com.br/webhook/pesquisa-icp`; `off` desliga). Até 3 tentativas; a entrega confirmada fica em `webhook_enviado_em`, aparece no "Ver tudo" do painel e na coluna `enviado_n8n_em` do CSV. Nada é enviado no meio da pesquisa.

O painel tem uma faixa de páginas do funil (hoje só "Pesquisa ICP"). Página nova = uma entrada no registro `PAGINAS` de `js/painel.js` + o bloco dela no `painel.html`; no banco, a coluna `pesquisa` separa os formulários.

Só o servidor, com a chave `service_role`, acessa o banco. RLS ligado sem políticas e grants revogados: a chave pública do projeto não lê nada.

## Rodar na sua máquina

Node.js 20 ou superior. Não há `npm install` para rodar o site.

```bash
cp .env.example .env        # preencha (veja os comentários do arquivo)
node server.mjs   # lê o .env sozinho, se existir
```

Abra `http://localhost:3000/pesquisa-icp` e `http://localhost:3000/painel`.

Sem banco configurado, as páginas abrem, a pesquisa guarda as respostas no próprio navegador e o painel responde 503. Para ter um banco de verdade local, descartável, com Docker aberto:

```bash
node tests/e2e/stack.mjs up
```

Ele sobe Postgres 17 + PostgREST com o `supabase.sql` aplicado e imprime `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` para colar no `.env`. Ctrl+C derruba tudo.

## Testes

```bash
npm test            # regras, configuração da pesquisa, servidor e APIs do painel (sem rede, segundos)
npm run test:e2e    # precisa de Docker e Playwright: SQL contra Postgres de verdade + o fluxo inteiro no navegador
```

- `tests/config.test.mjs` confere **cada pergunta e alternativa** contra o documento original da pesquisa. Mudou texto de pergunta de propósito? Atualize a expectativa ali também.
- `tests/e2e/fluxo.e2e.mjs` prova o sistema inteiro: Chromium em tela de celular responde a pesquisa (cinco pessoas, todos os tipos de pergunta, troca de perfil, parada no meio, mesma pessoa em dois aparelhos), contra o `server.mjs` e o Postgres de verdade, com um n8n local que grava os avisos; depois confere o banco linha a linha, o painel e o CSV. `E2E_SCREENS=/pasta` também tira as capturas de tela.
- `tests/e2e/formulario.e2e.mjs` prova as regras da tela do formulário no Chromium, com a API interceptada no navegador (sem Docker): os 5 perfis até o fim, cada tipo de pergunta, erros do servidor (422, 5xx, rede caída), fila de salvamento, retomar, teclado, movimento reduzido, Pixel e nenhuma rolagem horizontal de 320px a 1280px.
- `tests/e2e/painel.e2e.mjs` prova a tela do painel com 800 pessoas geradas (`tests/e2e/apoio/painel-fixtures.mjs`): login, placar, abas dos 5 perfis, filtros e URL, sessão expirada, atualização automática, lista, quadros, cruzamento, abertas, estados vazio/erro/sem rede, celular e desktop. `E2E_SCREENS=/pasta` também tira as capturas.
- `tests/e2e/sql.e2e.mjs` prova as regras do banco (gravação em ordem, conclusão que não volta atrás, deduplicação por WhatsApp, números do painel conferidos à mão, fuso de Brasília) e que a chave pública não lê nem executa nada.

## Mudar uma pergunta

1. Edite **só** `js/pesquisa-config.js` (texto, alternativas, ordem, obrigatoriedade, condicionais).
2. **Suba a `VERSAO`** no topo do arquivo (ex.: `"1.0"` → `"1.1"`). Cada resposta fica gravada com a versão em que foi dada, e o rascunho guardado no celular de quem estava no meio é reaproveitado com as regras novas.
3. Rode `npm test` e ajuste `tests/config.test.mjs` se a mudança foi intencional.
4. Se criou uma pergunta **nova** (id novo) e quer vê-la como coluna própria na view `pesquisa_planilha`, acrescente a linha correspondente no `supabase.sql` e rode o arquivo de novo no Supabase. O painel e o CSV já leem a pergunta nova sozinhos.

HTML, CSS e JS são servidos com `Cache-Control: no-cache`: a mudança vale no próximo carregamento, sem precisar trocar `?v=`.

## Deploy

Passo a passo em [DEPLOY.md](DEPLOY.md).
