# Pesquisa de ICP — Escola Enfermagem de Valor

Formulário conversacional (`/pesquisa-icp`) para mapear o público da Escola Enfermagem de Valor, três páginas de obrigado segmentadas por perfil (`/obrigado-*`), página de inscrição com checkout na Hotmart (`/viver-de-furo-inscricao`), a API que grava os leads da **página de venda da Imersão GPS** (que mora em outro site, `io.escolaenfermagemdevalor.com.br`) e painel privado (`/painel`) para a equipe acompanhar respostas, inscrições e vendas. Servidor Node.js **sem dependências de runtime**: HTML, CSS e JavaScript puros, banco no Supabase e publicação no Railway.

A pessoa se identifica primeiro (nome, WhatsApp com DDD e e-mail, validados no navegador e de novo no servidor) e depois responde uma pergunta por vez. **Cada resposta é gravada na hora**: quem para no meio deixa no banco tudo o que respondeu até ali, e o painel mostra onde parou.

## Rotas

| Rota | O quê |
| --- | --- |
| `/` | Redireciona (302) para `/pesquisa-icp`, mantendo a query string (UTMs do anúncio) |
| `/pesquisa-icp` | O formulário (com Meta Pixel) |
| `/pesquisa` | Endereço antigo: 301 para `/pesquisa-icp`, com a query |
| `/obrigado-afericao` | Página de obrigado de **Auxiliar ou antiga atendente** (grupo da aula de aferição) |
| `/obrigado-cuidador` | Página de obrigado de **Cuidador(a)** (grupo Cuidador de Valor) |
| `/obrigado-evento-outubro` | Página de obrigado de **Técnico(a)** e **Enfermeiro(a)** (grupo do evento de outubro) |
| `/viver-de-furo-inscricao` | Formulário de inscrição (nome, WhatsApp, e-mail) que leva ao checkout da Hotmart, com Meta Pixel |
| `/painel` | Painel da equipe, com login (sem Pixel, `noindex`) |
| `/health` | `{"ok":true}` — usado pelo healthcheck do Railway |
| `POST /api/pesquisa/evento` | Visita e clique em "Começar" (topo do funil) |
| `POST /api/pesquisa/salvar` | Gravação progressiva de cada resposta |
| `POST /api/pagina/evento` | Visita e clique no botão do grupo nas páginas de obrigado |
| `POST /api/inscricao` | Grava a inscrição e devolve a **URL do checkout montada no servidor**. Recebe também o formulário da página de venda da Imersão GPS, de outro site (CORS, ver "Página de outro site") |
| `OPTIONS /api/inscricao` | Preflight do CORS: `204` para origem liberada, `403 {"error":"origin_not_allowed"}` para as outras |
| `POST /api/hotmart/venda` | Webhook de venda da Hotmart (autenticado por `X-HOTMART-HOTTOK` ou `?chave=`) |
| `/api/painel/*` | Login, resumo, lista de pessoas, respostas abertas, cruzamento, páginas de obrigado, inscrições e os dois CSV (exigem sessão) |

As páginas de obrigado são **um arquivo** (`obrigado.html`) servido nas três rotas (com e sem barra no fim), com o Meta Pixel, a mesma CSP da pesquisa, `og:url`/`canonical` da própria rota e `X-Robots-Tag: noindex`. Qualquer outra rota começando com `/obrigado` (inclusive `/obrigado.html` direto) é 404. A pesquisa redireciona para a página do perfil ao terminar, levando as UTMs.

A página de venda da Imersão GPS **não** é servida aqui (`/igps_set_lp_26-ingresso` neste servidor é 404): ela mora no repositório `whatsapp-atendimento-centralizado`, em `https://io.escolaenfermagemdevalor.com.br/igps_set_lp_26-ingresso`, e só manda o formulário para o `POST /api/inscricao` daqui. Página com `origem` em `js/checkout-config.js` não ganha rota nem arquivo neste servidor.

## Estrutura

| Arquivo | Para quê |
| --- | --- |
| `js/pesquisa-config.js` | **A pesquisa inteira como dado**: perguntas, alternativas, etapas, perfis, condicionais e as regras de validação e progresso. Formulário, servidor e painel leem daqui. |
| `js/obrigado-config.js` | **As 3 páginas de obrigado como dado**: rota, textos, quais perfis caem em cada uma e os **links dos grupos de WhatsApp** (`LINKS_GRUPOS`). Página, formulário, servidor e painel leem daqui. |
| `js/checkout-config.js` | **As páginas de inscrição como dado** (`PAGINAS`): id, rota, nome, produto, link do checkout da Hotmart (com `off` e `checkoutMode`), qual UTM vira o `sck` (`sck`), a régua de e-mail (`emailSomenteComBr`), como o aviso da Hotmart é reconhecido como daquela página (`hotmart.ofertas`/`hotmart.produtos`) e, para página de outro site, a `origem`. Funções: `montarUrlCheckout` (leva as UTMs, o `sck` e o contato até a Hotmart), `baseDoCheckout` (aceita o link do botão tocado só se for do mesmo produto: troca de lote), `urlDoCheckout` (as duas juntas, com a régua da página), `paginaDaVenda` (de qual página é um aviso de venda), `sckDaPagina`, `ofertaDoLink`, `rastreioDaUrl` e `ORIGENS` (os sites de fora liberados no CORS). Página, servidor e painel leem daqui; a página de venda da Imersão GPS leva uma **cópia**. |
| `js/lead-rules.js` | Regras de nome, WhatsApp e e-mail (as mesmas no navegador e no servidor). `emailError(valor, { somenteComBr: true })` é a régua "só `.com` ou `.com.br`", ligada por página; sem a opção, qualquer domínio real passa (a pesquisa e a Viver de Furo). A página de venda da Imersão GPS leva uma **cópia**. |
| `pesquisa.html`, `css/pesquisa.css`, `js/pesquisa.js` | O formulário conversacional. |
| `obrigado.html`, `css/obrigado.css`, `js/obrigado.js` | As páginas de obrigado. |
| `viver-de-furo-inscricao.html`, `css/inscricao.css`, `js/inscricao.js` | A página de inscrição. |
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
- `pagina_eventos`: um evento por linha das páginas de obrigado (`visita` e `clique_grupo`), sem dado pessoal: página, ids do aparelho e da tentativa, perfil e origem. Gravado por `pagina_registrar_evento`; os números do painel vêm de `paginas_resumo` (pesquisas concluídas atribuídas a cada página → pessoas que chegaram → pessoas que clicaram no grupo, por perfil, origem e dia).

- `inscricoes`: uma linha por **pessoa em cada página de inscrição** (`pagina` + WhatsApp + e-mail). Reenviar o formulário soma `cliques` e mantém o rastreio de primeiro toque, em vez de criar inscrito novo; guarda também o `checkout_url` exato que foi aberto e o estado da compra (`comprou_em`, `compra_status`, `compra_valor`, `compra_transacao`).
- `compras`: uma linha por **evento recebido da Hotmart**, com o **payload cru em `jsonb`** — se a Hotmart mudar um campo de lugar, nada se perde. `(transacao, evento)` é único: o mesmo aviso chegando duas vezes não conta duas vezes. `pagina` é a página do **produto** (null = produto que não é de página nenhuma), mesmo quando o aviso não casou com ninguém; `pagina_por` diz como ela foi achada (`config`, `oferta` ou `produto`, os passos 1, 2 e 3 de "De qual página é cada venda"; null = aviso gravado pela versão anterior, em que `pagina` era a página da inscrição que casou, qualquer que fosse o produto, e por isso nunca se aprende com ele); `evento_em` é a hora do **evento** na Hotmart (`creation_date`), que decide o estado da venda quando os avisos chegam fora de ordem; `sck` é o que a Hotmart devolveu em `purchase.origin.sck`. Nos avisos da versão anterior, o `supabase.sql` preenche sozinho, a partir do payload, o `sck`, o `src`, a `oferta` do carrinho abandonado e o `evento_em` (ver `DEPLOY.md`, seção 1).
- Funções: `inscricao_salvar` (grava/atualiza a inscrição), `hotmart_registrar_compra` (grava o aviso, descobre **de qual página é o produto** e só então casa com uma inscrição **daquela página** por e-mail **ou** pelos últimos 8 dígitos do telefone; marca `comprou_em` em `PURCHASE_APPROVED`/`PURCHASE_COMPLETE` e desmarca em cancelamento, reembolso, chargeback e disputa — ver "De qual página é cada venda") e `inscricoes_resumo(p_desde, p_ate, p_pagina)` (os números das abas de inscrição do painel, uma entrada por página: inscritos → cliques → compras, receita, divisões `por_origem`, `por_midia`, `por_campanha`, `por_conteudo`, `por_termo` e `por_dia`, e o lado da Hotmart — `vendas`, `vendas_receita` e `vendas_por_sck` —, mais `compras_sem_inscricao` e `compras_recentes` com o `sck`; como cada venda entra no período está em "Vendas no período").

Aviso ao n8n: quando a pessoa chega à tela de fim, o servidor manda **um** POST `pesquisa_concluida` (lead, UTMs, rastreio de primeiro toque e todas as perguntas do caminho dela, com a resposta crua e a legível) para `PESQUISA_WEBHOOK_URL`, com `perfil` (como respondido), `perfil_codigo` (`auxiliar_atendente`, `cuidador`, `tecnico_enfermagem`, `enfermeiro`), `segmento` (etiqueta de CRM: `PERFIL_AUXILIAR_ATENDENTE`, `PERFIL_CUIDADOR`, `PERFIL_TECNICO`, `PERFIL_ENFERMEIRO`) e `pagina_obrigado` (`{id, rota, nome, grupo}` da página para onde a pessoa foi) — Técnico e Enfermeiro vão para a mesma página, mas chegam separados (padrão `https://n8n.tecnicadevalor.com.br/webhook/pesquisa-icp`; `off` desliga). Até 3 tentativas na hora (0, 3 s e 10 s); o que ainda assim não chegar é reenviado por uma varredura do servidor (30 s depois de subir e depois a cada 10 min: tentativas finalizadas entre 2 min e 7 dias atrás, sem `webhook_enviado_em`, 25 por vez, mesmo payload). A mesma varredura manda também quem respondeu tudo o que é obrigatório mas fechou antes da tela de fim (por exemplo, nas perguntas abertas opcionais), depois de 30 min parada: o painel já conta essa pessoa como "Respondeu tudo", e o n8n recebe o aviso com `concluida_em` = hora da conclusão; se ela voltar e chegar ao fim depois, não sai aviso repetido. A entrega confirmada fica em `webhook_enviado_em`, aparece no "Ver tudo" do painel e na coluna `enviado_n8n_em` do CSV. Nada é enviado enquanto a pessoa ainda está respondendo. O CSV também tem `perfil_codigo` e `pagina_obrigado` logo depois do e-mail.

**Inscrição e venda (`/viver-de-furo-inscricao` e a venda da Imersão GPS).** A pessoa preenche nome, WhatsApp e e-mail; o **servidor** monta o link do checkout com `EVCheckout.urlDoCheckout` e devolve a URL pronta — o navegador só abre. As 5 UTMs seguem para a Hotmart, **uma delas** vai também como `sck` (é por ele que o cliente sabe qual criativo vendeu: o `sck` volta no relatório e no aviso de venda da Hotmart) e o contato vai na URL (`name`, `email`, `phoneac` = DDD, `phonenumber` = o resto), para o checkout já abrir preenchido. `fbclid` e `gclid` ficam só com a gente. Depois, cada evento de compra chega em `POST /api/hotmart/venda` e é casado com a inscrição. **Nada disso passa pelo n8n.**

O que muda de uma página para a outra fica todo em `js/checkout-config.js`:

| | Viver de Furo (`viver-de-furo`) | Imersão GPS (`imersao-gps`) |
| --- | --- | --- |
| Onde mora | aqui, `/viver-de-furo-inscricao` | outro site: `https://io.escolaenfermagemdevalor.com.br/igps_set_lp_26-ingresso` (`origem`) |
| Vira `sck` (`sck`) | `utm_term` — pedido do cliente | `utm_content` — o criativo, como no site da Escola |
| E-mail (`emailSomenteComBr`) | qualquer domínio real (`false`): tem muita profissional com e-mail de prefeitura e hospital | só `.com` ou `.com.br` (`true`), a régua de sempre das páginas de venda |
| Checkout | `pay.hotmart.com/Y74893363S?off=7j2nqptq&checkoutMode=10` | `pay.hotmart.com/R107667362D?off=l0r77by6&checkoutMode=10` (lote 1) |
| Venda reconhecida por (`hotmart`) | oferta `7j2nqptq`, produto `2332962` | oferta `l0r77by6` (o id do produto entra depois da 1ª venda) |

Página sem `sck` (ou com um valor que não seja uma das 5 UTMs) usa o `utm_term` (`SCK_PADRAO`). O CSV das inscrições tem a coluna `sck` com a UTM que a página escolheu. Com `emailSomenteComBr: true`, `maria@hospital.org.br` volta `422` com "Use um e-mail que termine em .com ou .com.br." no campo do e-mail; `maria@gmail.con` continua ganhando a sugestão de correção antes disso (a régua olha erro de digitação primeiro).

**Página de outro site (a Imersão GPS).** O que este servidor faz por ela é só o `POST /api/inscricao`, com CORS para as origens de `EVCheckout.ORIGENS` (hoje `https://io.escolaenfermagemdevalor.com.br`) mais as de `INSCRICAO_ORIGENS` (opcional, para preview e teste local; ver `DEPLOY.md`). Origem liberada recebe `Access-Control-Allow-Origin: <a origem>` e `Vary: Origin` em **toda** resposta do `/api/inscricao` (inclusive 422, 429 e 5xx, para a página conseguir ler o erro); o preflight `OPTIONS` responde `204` com `Access-Control-Allow-Methods: POST`, `Access-Control-Allow-Headers: Content-Type` e `Access-Control-Max-Age: 7200` (2 h, o teto do Chrome: o preflight não se repete a cada envio). Sem cookie e sem credencial. Dessas origens o corpo JSON também é aceito com `Content-Type: text/plain` — é o *simple request* do navegador, sem preflight (uma ida a menos antes do checkout) e o único tipo que o `navigator.sendBeacon` manda de outro site. De qualquer outra origem vale o de antes: `text/plain` é `415` e só `application/json` passa, que um formulário HTML de outro site não consegue enviar. Método errado é `405` com `Allow: POST, OPTIONS`. A página de venda leva uma **cópia** de `js/checkout-config.js` e `js/lead-rules.js` (em `public/igps_set_lp_26-ingresso/js/` do outro repositório): a mesma régua de contato no navegador e o plano B de montar o checkout lá mesmo (`urlDoCheckout`) quando a API daqui cai ou demora. Mudou um dos dois aqui, copie para lá.

**Troca de lote (`baseDoCheckout`).** O formulário pode mandar `checkout` = o link do botão que a pessoa tocou. O servidor só aceita esse link se for do **mesmo produto** do config (mesmo caminho em `pay.hotmart.com`, por exemplo `/R107667362D`), e dele tira só a oferta (`off=`) e o `checkoutMode`; outro produto, outro site, link sem `off=` ou com mais de 2048 caracteres cai no link do config. Assim trocar de lote é trocar o link nos botões da página de venda, sem deploy aqui, e ninguém consegue mandar o checkout para outro lugar pelo formulário. O aviso de venda com a oferta nova é reconhecido pelo passo 2 (quem abriu o link) ou pelo passo 3 (o produto, depois da 1ª venda reconhecida pelo config); para quem compra sem ter aberto a página, cole o id numérico do produto em `hotmart.produtos` (ver `DEPLOY.md`, 5.3).

**De qual página é cada venda.** O mesmo webhook recebe avisos de vários produtos da conta Hotmart: nos avisos gravados já aparecem o Furo de orelha humanizado (`2332962`, o da Viver de Furo), a Imersão Viver de Furo de Orelha (`8519248`, vendida por outras páginas) e os testes com produto `0`; vão chegar também o ingresso da Imersão GPS e a Formação vendida no fim dela. Por isso `hotmart_registrar_compra` primeiro descobre a página do **produto**, nesta ordem:

0. a **mesma transação** num aviso anterior (o APPROVED antes do COMPLETE ou do REFUNDED): fica na mesma página e na **mesma inscrição**, sem casar de novo — senão quem reenviou o formulário com outro WhatsApp teria a venda contada duas vezes;
1. `p.pagina`, que o servidor tira do config com `EVCheckout.paginaDaVenda`: a oferta (`purchase.offer.code`) em `hotmart.ofertas` ou o id **numérico** do produto (`data.product.id`, que não é o código `R107667362D` do link) em `hotmart.produtos` (`pagina_por = 'config'`);
2. senão, a oferta (`off=`) do `checkout_url` de uma inscrição do **próprio comprador** (mesmo e-mail ou mesmos 8 últimos dígitos) — é o que faz a oferta de um lote novo ser reconhecida sem mexer no config (`'oferta'`). Só do próprio comprador porque o `/api/inscricao` é público: uma inscrição inventada com a oferta da Formação no link não pode transformar a Formação dos outros em ingresso;
3. senão, o mesmo `produto_id` num aviso anterior que o **config** reconheceu (`pagina_por = 'config'`; `'produto'`). Nem `'oferta'` nem `'produto'` ensinam (um erro não se espalha), nem aviso da versão anterior (`pagina_por` null), nem o produto `0` (o "Enviar teste" da Hotmart).

Só então casa com uma inscrição **daquela página**: e-mail primeiro, depois os últimos 8 dígitos do telefone (o 9 e o DDI variam, os 8 finais não), a mais recente. O estado da compra segue a **transação**: quem comprou duas vezes fica com a primeira; reembolso de uma transação só desmarca se for a que está marcada, e aí a inscrição volta para outra transação dela que continua aprovada; aviso sem transação não mexe em inscrito. Nenhuma das três = produto de fora: o aviso é gravado com `pagina` null e **não casa com ninguém**. O porquê: a Formação é vendida no fim da imersão justamente para quem comprou o ingresso — casar pelo e-mail marcaria o ingresso como comprado com o valor do curso, e um reembolso do curso desmarcaria o ingresso. O mesmo vale para order bump e para a venda de uma página em outra.

**O `sck` da venda** vem de `data.purchase.origin.sck` — é onde os avisos reais da Hotmart trazem (antes o servidor lia `purchase.tracking.source_sck` e gravava null); `tracking.source_sck`, `purchase.sckPaymentLink` e `tracking.external_code` ficam de reserva, e o `src` vem de `origin.src`. A oferta vem de `purchase.offer.code` ou, no carrinho abandonado (`PURCHASE_OUT_OF_SHOPPING_CART`, que chega sem `purchase`), de `data.offer.code`. A hora do evento (`evento_em`) é o `creation_date` do aviso, em milissegundos ou em segundos.

**Vendas no período (o lado da Hotmart).** `vendas`, `vendas_receita`, `vendas_por_sck` e `compras_sem_inscricao` contam **transações**, e não avisos:

- o estado de cada transação é o **último evento de compra dela** (aprovada, completa, cancelada, reembolso, chargeback ou disputa; boleto e carrinho abandonado não entram) **pela hora do evento** (`evento_em`; a chegada, `recebido_em`, só vale quando falta a hora e para desempatar), entre todos os avisos dela que chegaram até o fim do período, inclusive os de antes do começo. Um `PURCHASE_APPROVED` que chega depois do reembolso (a Hotmart reenvia fora de ordem) não ressuscita a venda;
- a venda conta se esse estado for compra aprovada ou completa: reembolso, cancelamento, chargeback e disputa tiram;
- ela conta no período da **primeira aprovação** (o `aprovado_em` dos avisos de aprovada ou completa; sem ele, a hora do evento). O `PURCHASE_COMPLETE`, que chega dias depois, no fim da garantia, não conta a venda de novo nem a leva para o dia dele;
- o valor é o da aprovação mais recente, o `sck` é o mais recente que veio preenchido, e ela é **casada** quando algum aviso da transação casou com uma inscrição;
- `compras_sem_inscricao` = vendas − casadas: a reembolsada não conta.

As "compras de inscritos" do funil são outra conta: inscrições do período (pela data da inscrição) com `comprou_em` preenchido. E as "compras recentes" são os 20 últimos avisos que **chegaram** no período, um por linha, de qualquer evento.

O painel tem uma faixa de páginas do funil: "Pesquisa ICP", "Páginas de obrigado" e **uma aba por página de inscrição** de `js/checkout-config.js` (hoje "Viver de Furo — inscrição" e "Imersão GPS — ingressos"; nome e rota vêm de lá, e a página de outro site mostra o host junto: `io.escolaenfermagemdevalor.com.br/igps_set_lp_26-ingresso`). As abas de inscrição dividem um bloco só do `painel.html`, e cada uma pede `/api/painel/inscricoes?pagina=<id>`: trocar de aba limpa os números antes de pedir os da outra, então o número de uma página nunca aparece na outra. Cada aba mostra, no período da barra, dois lados que respondem perguntas diferentes:

- **o do formulário:** o placar (inscritos, cliques no checkout, compras de inscritos e vendas na Hotmart), o funil inscritos → cliques no checkout → compras de inscritos (casadas com o aviso da Hotmart) com a taxa e a base escritas, e "Inscritos por UTM e por dia" — por origem, mídia, campanha, conteúdo, termo e dia; a UTM que é o `sck` da página vem marcada "(sck)" (termo na Viver de Furo, conteúdo na Imersão GPS);
- **o da Hotmart:** o bloco "Vendas na Hotmart — de onde veio cada venda": toda venda aprovada que a Hotmart avisou para o **produto** da página, inclusive de quem comprou sem passar pelo formulário, com a receita, quantas casaram com inscrição e a tabela por `sck` (vendas, receita, com inscrição; "(sem sck)" = venda que chegou sem ele). Cada venda conta uma vez, no dia da primeira aprovação, e reembolso, cancelamento e chargeback saem da conta (ver "Vendas no período").

Abaixo, as compras recentes (cada aviso do produto da página, com o `sck` e o aviso de quantas compras aprovadas não casaram com nenhuma inscrição), a lista de inscritos com selo "comprou"/"não comprou", o `sck` que foi para a Hotmart e o link de WhatsApp, e o botão "Baixar CSV" (com a página e o período da tela). O link antigo `?pagina=inscricoes` (de quando havia uma aba só) abre a primeira. Com o SQL antigo no banco, o que ele não manda (mídia, conteúdo, vendas na Hotmart, `sck` dos avisos) some da tela e o resto funciona. A aba de obrigado traz (um cartão por página: nome, rota, perfis que caem nela, link do grupo ou o aviso "link do grupo ainda não configurado", o funil pesquisas concluídas atribuídas → chegaram à página → clicaram no grupo com a porcentagem e a base de cada passo, e a divisão por perfil, origem e dia). O período da barra vale para todas as abas; perfil, busca e situação só existem na da pesquisa. Página de inscrição nova = uma entrada em `PAGINAS` do `js/checkout-config.js` (e o `<rota>.html`, se ela morar aqui; a aba do painel nasce sozinha); outra página de funil = uma entrada no registro `PAGINAS` de `js/painel.js` + o bloco dela no `painel.html`.

Só o servidor, com a chave `service_role`, acessa o banco. RLS ligado sem políticas e grants revogados: a chave pública do projeto não lê nada.

## Rodar na sua máquina

Node.js 20 ou superior. Não há `npm install` para rodar o site.

```bash
cp .env.example .env        # preencha (veja os comentários do arquivo)
node server.mjs   # lê o .env sozinho, se existir
```

Abra `http://localhost:3000/pesquisa-icp`, `http://localhost:3000/obrigado-cuidador` e `http://localhost:3000/painel`.

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
- `tests/checkout-config.test.mjs` carrega `js/lead-rules.js` e `js/checkout-config.js` com `vm` num contexto **vazio** — sem `URL` nem `URLSearchParams`, exatamente como o servidor faz — e prova a URL do checkout: `off`/`checkoutMode` preservados, as 5 UTMs, nome formatado, e-mail minúsculo, `phoneac`/`phonenumber`, UTM vazia ignorada, `fbclid`/`gclid` fora, hash preservado, parâmetro repetido sobrescrito e link torto voltando igual. E a régua de cada página: `sck` = `utm_term` na Viver de Furo (e sem `sck` nas opções) e `utm_content` na Imersão GPS, `sckDaPagina` caindo no padrão com valor estranho, `emailSomenteComBr`, a `origem` e `ORIGENS`, `baseDoCheckout` (botão do mesmo produto troca só `off`/`checkoutMode`; outro produto, outro host, sem `off`, `off` estranho ou texto enorme voltam ao config), `urlDoCheckout`, `ofertaDoLink`, `paginaDaVenda` (oferta, depois id ou `ucode` do produto; desconhecido = null) e `%` solto que não lança.
- `tests/lead-rules.test.mjs` prova as regras de contato; com `{ somenteComBr: true }`, `.com`/`.com.br` passam, `.net`, `.org`, `.gov.br`, `.edu.br` viram `com_br`, e `typo`/`invalid`/`empty` vêm antes de `com_br`; sem a opção, nada muda.
- `tests/server.test.mjs` prova o servidor sem rede (banco e DNS falsos): rotas, cabeçalhos e CSP, cache, validação, limites, o aviso e o reenvio ao n8n e o webhook da Hotmart. Para a Imersão GPS: o CORS do `/api/inscricao` (preflight `204` com os cabeçalhos exatos para a origem liberada, `403` para as outras, `Access-Control-Allow-Origin` e `Vary` em toda resposta da origem liberada, inclusive `429`; `text/plain` só dela, `415` de outra; `origensInscricao` somando origens; as outras rotas sem CORS), a inscrição do GPS (página `imersao-gps`, checkout do GPS com `sck` = `utm_content`, e-mail fora de `.com`/`.com.br` = `422`), o `checkout` do botão (lote novo aceito, outro produto ignorado), a rota do GPS **não** servida aqui, `extrairVendaHotmart` no formato real (`purchase.origin.sck`, `offer.code`, produto numérico, carrinho abandonado com `data.offer`) e o `p.pagina` que o servidor manda ao SQL.
- `tests/painel-api.test.mjs` prova as APIs do painel: sessão, filtros, formato das respostas, os CSV (a coluna `sck` das inscrições é a UTM de cada página) e a aba de cada página de inscrição (`?pagina=imersao-gps` filtra o resumo e a lista).
- `tests/e2e/fluxo.e2e.mjs` prova o sistema inteiro: Chromium em tela de celular responde a pesquisa (várias pessoas, todos os tipos de pergunta, troca de perfil, parada no meio, mesma pessoa em dois aparelhos), contra o `server.mjs` e o Postgres de verdade, com um n8n local que grava os avisos; depois confere o banco linha a linha, o painel e o CSV. `E2E_SCREENS=/pasta` também tira as capturas de tela.
- `tests/e2e/formulario.e2e.mjs` prova as regras da tela do formulário no Chromium, com a API interceptada no navegador (sem Docker): os 4 perfis até o fim, cada tipo de pergunta, erros do servidor (422, 5xx, rede caída), fila de salvamento, retomar, teclado, movimento reduzido, Pixel e nenhuma rolagem horizontal de 320px a 1280px.
- `tests/e2e/painel.e2e.mjs` prova a tela do painel com 800 pessoas geradas (`tests/e2e/apoio/painel-fixtures.mjs`): login, placar, abas dos 4 perfis, filtros e URL, sessão expirada, atualização automática, lista, quadros, cruzamento, abertas, a aba "Páginas de obrigado" (números e % conferidos contra as fixtures, Técnico x Enfermeiro separados, link não configurado e configurado, período, erro e vazio), uma aba por página de inscrição (Viver de Furo e Imersão GPS: funil inscritos → cliques → compras de inscritos, os números do lado da Hotmart e as vendas por `sck`, as divisões por UTM com o `sck` de cada página marcado, compras recentes com o aviso de compra sem inscrição, lista com "comprou"/"não comprou", o CSV, troca de aba sem número de uma página na outra, teclado, o link antigo `?pagina=inscricoes` e o servidor com o SQL antigo), estados vazio/erro/sem rede, celular e desktop. `E2E_SCREENS=/pasta` também tira as capturas.
- `tests/e2e/sql.e2e.mjs` prova as regras do banco (gravação em ordem, conclusão que não volta atrás, deduplicação por WhatsApp, números do painel e das páginas de obrigado conferidos à mão, inscrições que somam clique em vez de duplicar, compra casada por e-mail e por telefone, aviso repetido que não conta duas vezes, cancelamento que desmarca, fuso de Brasília, arquivo aplicado de novo sem perder dado) e que a chave pública não lê nem executa nada. E o casamento **por página do produto**: a mesma pessoa inscrita nas duas páginas tem cada venda marcada só na página do produto (por e-mail e por telefone); produto que ninguém conhece é gravado com `pagina` null e não marca ninguém; reembolso, cancelamento e chargeback da Formação não desmarcam o ingresso; order bump não sobrescreve o ingresso; lote novo reconhecido pelo `off=` de um link aberto; produto reconhecido por aviso anterior; `p.pagina` do servidor manda. No resumo: por mídia e conteúdo, `vendas`/`vendas_receita`/`vendas_por_sck` com "(sem sck)", avisos só do produto da página com `p_pagina`, e as vendas contadas por transação (aprovada e depois completa = uma venda; reembolsada sai).
- `tests/e2e/imersao-gps.e2e.mjs` prova a Imersão GPS de ponta a ponta contra o `server.mjs`, o PostgREST e o Postgres de verdade (Docker, sem Playwright; o DNS do e-mail é o único dublê), em passos que dependem um do outro: preflight da origem do GPS aceito e o de outra recusado; `POST /api/inscricao` em `text/plain` com CORS, checkout do GPS e `sck` = `utm_content`; e-mail fora de `.com`/`.com.br` com `422` legível pela página e nada gravado; a mesma pessoa inscrita também na Viver de Furo (`sck` = `utm_term`); o aviso real do ingresso casando só com a inscrição do GPS; um produto de fora (e o reembolso dele) sem marcar ninguém; `/api/painel/inscricoes?pagina=imersao-gps` com `vendas_por_sck` e só avisos do GPS; e o lote novo pelo botão ainda casando.
- `tests/e2e/inscricao.e2e.mjs` prova a página `/viver-de-furo-inscricao` no Chromium, com o `/api/inscricao` interceptado (sem Docker): os 3 campos, a máscara do WhatsApp, o corpo exato do contrato, a ida para a URL que o servidor devolveu, o `422` que segura a pessoa, o plano B quando o servidor demora ou cai (URL montada no navegador, com as UTMs, `sck` = `utm_term` e o contato), Pixel, acessibilidade e responsivo.
- `tests/e2e/obrigado.e2e.mjs` prova as 3 páginas de obrigado no Chromium (sem Docker): texto do config, só o botão do próprio grupo, botão visível sem rolar no celular, aviso de link não configurado, eventos `visita` e `clique_grupo`, Pixel e nenhuma rolagem horizontal.
- `tests/e2e/reenvio.e2e.mjs` prova a varredura de reenvio ao n8n contra o PostgREST de verdade: só a tentativa finalizada, sem `webhook_enviado_em` e dentro da janela (2 min a 7 dias) é reenviada, com o mesmo payload, e só ela é marcada.

## Mudar uma pergunta

1. Edite **só** `js/pesquisa-config.js` (texto, alternativas, ordem, obrigatoriedade, condicionais).
2. **Suba a `VERSAO`** no topo do arquivo (ex.: `"1.0"` → `"1.1"`). Cada resposta fica gravada com a versão em que foi dada, e o rascunho guardado no celular de quem estava no meio é reaproveitado com as regras novas.
3. Rode `npm test` e ajuste `tests/config.test.mjs` se a mudança foi intencional.
4. Se criou uma pergunta **nova** (id novo) e quer vê-la como coluna própria na view `pesquisa_planilha`, acrescente a linha correspondente no `supabase.sql` e rode o arquivo de novo no Supabase. O painel e o CSV já leem a pergunta nova sozinhos.

HTML, CSS e JS são servidos com `Cache-Control: no-cache`: a mudança vale no próximo carregamento, sem precisar trocar `?v=`.

## Colar os links dos grupos de WhatsApp

Os três convites ficam em **um lugar só**: `LINKS_GRUPOS`, no topo de `js/obrigado-config.js`.

```js
const LINKS_GRUPOS = Object.freeze({
  afericao: "https://chat.whatsapp.com/...",       // Auxiliares e antigas atendentes
  cuidador: "https://chat.whatsapp.com/...",       // Cuidadores
  evento_outubro: "https://chat.whatsapp.com/..."  // Técnicos e enfermeiros
});
```

Só vale convite `https://chat.whatsapp.com/...` ou `https://wa.me/...`. Enquanto um link estiver vazio (ou inválido), a página não mostra botão quebrado — avisa que o link chega pelo WhatsApp — e o cartão da página no painel mostra "Link do grupo ainda não configurado". Depois de colar: `npm test`, commit e deploy (não precisa rodar SQL). Textos, rotas e perfis de cada página também são editados só nesse arquivo.

## Deploy

Passo a passo em [DEPLOY.md](DEPLOY.md).
