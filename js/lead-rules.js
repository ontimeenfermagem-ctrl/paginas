/*
 * lead-rules.js — regras de nome, WhatsApp e e-mail do formulário.
 *
 * O mesmo arquivo roda no navegador (js/pesquisa.js) e no servidor (server.mjs, via vm), para
 * que a validação da tela e a da gravação sejam idênticas. Mesmo molde do Preparatório
 * (quintino-landing/js/lead-rules.js), com duas diferenças de propósito:
 *
 *   . o e-mail aceita qualquer domínio real (.net, .org, .edu.br, .gov.br...), e não só .com e
 *     .com.br — tem muita profissional de saúde com e-mail de prefeitura e de hospital;
 *   . o nome pede sobrenome, como a sala da Enfermagem de Valor já pede.
 *
 * Nenhuma função aqui lança erro nem toca em DOM ou rede.
 */
(function (root) {
  "use strict";

  // DDDs válidos no Brasil.
  const VALID_DDDS = new Set([
    "11", "12", "13", "14", "15", "16", "17", "18", "19",
    "21", "22", "24", "27", "28",
    "31", "32", "33", "34", "35", "37", "38",
    "41", "42", "43", "44", "45", "46", "47", "48", "49",
    "51", "53", "54", "55",
    "61", "62", "63", "64", "65", "66", "67", "68", "69",
    "71", "73", "74", "75", "77", "79",
    "81", "82", "83", "84", "85", "86", "87", "88", "89",
    "91", "92", "93", "94", "95", "96", "97", "98", "99"
  ]);

  // Domínios usados como referência para sugerir correção de digitação (gmial.com → gmail.com).
  const POPULAR_DOMAINS = [
    "gmail.com",
    "hotmail.com",
    "outlook.com",
    "yahoo.com",
    "yahoo.com.br",
    "icloud.com",
    "live.com",
    "msn.com",
    "hotmail.com.br",
    "outlook.com.br",
    "bol.com.br",
    "uol.com.br",
    "terra.com.br",
    "globo.com",
    "ig.com.br"
  ];

  // Domínios reais que nunca recebem sugestão, mesmo parecidos com os populares.
  const KNOWN_DOMAINS = new Set(
    POPULAR_DOMAINS.concat([
      "googlemail.com",
      "ymail.com",
      "rocketmail.com",
      "yahoo.com.ar",
      "aol.com",
      "protonmail.com",
      "proton.me",
      "me.com",
      "mac.com",
      "live.com.br",
      "hotmail.es",
      "hotmail.fr",
      "outlook.pt",
      "uai.com.br",
      "oi.com.br",
      "zipmail.com.br",
      "pop.com.br",
      "r7.com",
      "globomail.com",
      "gmx.com",
      "yandex.com"
    ])
  );

  // Provedores em que QUALQUER domínio fora da lista conhecida é erro de digitação: não existe
  // gmail.com.br, gmail.co ou hotmail.con. Aqui o erro bloqueia, em vez de só sugerir.
  const STRICT_PROVIDERS = new Set(["gmail", "googlemail", "hotmail", "outlook", "yahoo", "icloud", "bol", "uol"]);

  // Correções certas que a distância de edição não alcança. bol.com e uol.com são "typo" (o
  // provedor é estrito) mas ficam a 3 letras de bol.com.br: sem isto a tela bloqueava sem oferecer
  // a correção.
  const DOMAIN_FIXES = {
    "gmail.com.br": "gmail.com",
    "gmail.br": "gmail.com",
    "gmail.co": "gmail.com",
    "icloud.com.br": "icloud.com",
    "bol.com": "bol.com.br",
    "uol.com": "uol.com.br"
  };

  // Terminações que não existem e aparecem muito por dedo escorregando no celular.
  const TLD_TYPOS = new Set(["con", "cmo", "ocm", "comm", "coom", "cpm", "cim", "xom", "vom", "clm", "cok", "combr"]);

  const LOCAL_PART = /^[a-z0-9_%+-]+(?:\.[a-z0-9_%+-]+)*$/;
  const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const TLD = /^[a-z]{2,24}$/;

  const LETTER_PATTERN = /[A-Za-zÀ-ÖØ-öø-ÿ]/g;

  // Mensagens para a tela. Ficam aqui para o servidor devolver o mesmo texto que o navegador.
  const MESSAGES = Object.freeze({
    name: Object.freeze({
      empty: "Escreva seu nome.",
      invalid: "Confere o nome: use só letras.",
      surname: "Escreva também o seu sobrenome."
    }),
    phone: Object.freeze({
      empty: "Informe seu WhatsApp com DDD.",
      incomplete: "Faltam números: são 11 dígitos contando o DDD.",
      ddd: "Esse DDD não existe. Confere o número?",
      mobile: "O WhatsApp precisa ser um celular: depois do DDD, o número começa com 9.",
      repeated: "Confere o número, parece que não está completo."
    }),
    email: Object.freeze({
      empty: "Informe seu e-mail.",
      invalid: "Confere o e-mail, parece que tem algo errado.",
      typo: "Confere o final do e-mail, parece que tem um erro de digitação.",
      domain: "Não encontramos esse endereço de e-mail. Confere se está certinho?"
    })
  });

  function toText(value) {
    return value == null ? "" : String(value);
  }

  /* ------------------------------------------------------------------ nome */

  function normalizeName(value) {
    return toText(value).trim().replace(/\s+/g, " ");
  }

  function nameError(value) {
    const name = normalizeName(value);
    if (!name) return "empty";
    if (/[\d@_]/.test(name) || (name.match(LETTER_PATTERN) || []).length < 2) return "invalid";
    const words = name.split(" ").filter((word) => (word.match(LETTER_PATTERN) || []).length > 0);
    if (words.length < 2) return "surname";
    return "";
  }

  /* -------------------------------------------------------------- telefone */

  // Aceita valores colados ou preenchidos automaticamente com +55 ou zero de operadora.
  function normalizePhoneDigits(value) {
    const raw = toText(value).trim();
    let digits = raw.replace(/\D/g, "");

    if (digits.startsWith("55") && (digits.length === 13 || raw.startsWith("+"))) {
      digits = digits.slice(2);
    }
    if (digits.length === 12 && digits.startsWith("0")) {
      digits = digits.slice(1);
    }
    return digits;
  }

  // Formata enquanto a pessoa digita: (xx) xxxxx-xxxx.
  function formatPhone(value) {
    const digits = normalizePhoneDigits(value).slice(0, 11);
    if (!digits) return "";
    if (digits.length <= 2) return `(${digits}`;

    const areaCode = digits.slice(0, 2);
    const number = digits.slice(2);
    if (number.length <= 5) return `(${areaCode}) ${number}`;
    return `(${areaCode}) ${number.slice(0, 5)}-${number.slice(5)}`;
  }

  /**
   * Máscara que não briga com o backspace. Apagar um separador ("-", ")" ou espaço) não muda os
   * dígitos, então a máscara o recolocaria e a tecla pareceria não funcionar. Só nesse caso o
   * dígito anterior sai junto. Herdado da sala da Enfermagem de Valor.
   */
  function formatPhoneWhileTyping(next, previous) {
    const nextText = toText(next);
    const previousText = toText(previous);
    let digits = nextText.replace(/\D/g, "");
    const deleting = nextText.length < previousText.length;
    if (deleting && digits === previousText.replace(/\D/g, "")) digits = digits.slice(0, -1);
    return formatPhone(digits);
  }

  function phoneError(value) {
    const digits = normalizePhoneDigits(value);
    if (!digits) return "empty";
    if (digits.length !== 11) return "incomplete";
    if (!VALID_DDDS.has(digits.slice(0, 2))) return "ddd";
    if (digits.charAt(2) !== "9") return "mobile";
    if (/^(\d)\1+$/.test(digits.slice(3))) return "repeated";
    return "";
  }

  /* ---------------------------------------------------------------- e-mail */

  function normalizeEmail(value) {
    return toText(value).trim().toLowerCase();
  }

  function splitEmail(email) {
    const at = email.lastIndexOf("@");
    if (at < 1 || at !== email.indexOf("@")) return null;
    return { user: email.slice(0, at), domain: email.slice(at + 1) };
  }

  /**
   * "" | "empty" | "invalid" | "typo".
   * "typo" é um endereço bem formado que com certeza não existe (gmail.com.br, hotmail.con):
   * bloqueia igual a "invalid", mas a tela pode oferecer a correção de suggestEmail.
   */
  function emailError(value) {
    const email = normalizeEmail(value);
    if (!email) return "empty";
    if (email.length > 254) return "invalid";

    const parts = splitEmail(email);
    if (!parts) return "invalid";
    const { user, domain } = parts;
    if (user.length > 64 || !LOCAL_PART.test(user)) return "invalid";

    const labels = domain.split(".");
    if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) return "invalid";
    const tld = labels[labels.length - 1];
    if (!TLD.test(tld)) return "invalid";

    if (TLD_TYPOS.has(tld)) return "typo";
    if (STRICT_PROVIDERS.has(labels[0]) && !KNOWN_DOMAINS.has(domain)) return "typo";
    return "";
  }

  function editDistance(first, second) {
    const row = Array.from({ length: second.length + 1 }, (_, index) => index);

    for (let i = 1; i <= first.length; i += 1) {
      let diagonal = row[0];
      row[0] = i;
      for (let j = 1; j <= second.length; j += 1) {
        const above = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (first[i - 1] === second[j - 1] ? 0 : 1));
        diagonal = above;
      }
    }

    return row[second.length];
  }

  // Sugere a correção de domínios digitados com erro (gmial.com → gmail.com, hotmail.con → hotmail.com).
  function suggestEmail(value) {
    const email = normalizeEmail(value);
    const parts = splitEmail(email);
    if (!parts) return "";

    const { user, domain } = parts;
    if (domain.length < 4 || KNOWN_DOMAINS.has(domain)) return "";
    if (DOMAIN_FIXES[domain]) return `${user}@${DOMAIN_FIXES[domain]}`;

    let best = "";
    let bestDistance = Infinity;
    for (const candidate of POPULAR_DOMAINS) {
      const distance = editDistance(domain, candidate);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }

    // Nomes curtos (me, oi, uai) só recebem sugestão com uma letra de diferença.
    const limit = domain.split(".")[0].length <= 4 ? 1 : 2;
    return bestDistance > 0 && bestDistance <= limit ? `${user}@${best}` : "";
  }

  /** O domínio do e-mail, para o servidor conferir se ele recebe mensagem (registro MX). */
  function emailDomain(value) {
    const parts = splitEmail(normalizeEmail(value));
    return parts ? parts.domain : "";
  }

  /** Mensagem pronta para a tela a partir do código de erro. Código vazio devolve "". */
  function message(field, code) {
    return code && MESSAGES[field] ? MESSAGES[field][code] || MESSAGES[field].invalid || "" : "";
  }

  root.EVLeadRules = Object.freeze({
    VALID_DDDS: Object.freeze(Array.from(VALID_DDDS)),
    KNOWN_DOMAINS: Object.freeze(Array.from(KNOWN_DOMAINS)),
    MESSAGES,
    editDistance,
    emailDomain,
    emailError,
    formatPhone,
    formatPhoneWhileTyping,
    message,
    nameError,
    normalizeEmail,
    normalizeName,
    normalizePhoneDigits,
    phoneError,
    suggestEmail
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
