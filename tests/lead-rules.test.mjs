/*
 * Regras de nome, WhatsApp e e-mail (js/lead-rules.js). O arquivo é script de navegador; aqui ele
 * roda no MESMO realm do teste (runInThisContext), para os objetos devolvidos terem os
 * protótipos daqui e o deepStrictEqual comparar só o conteúdo.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

vm.runInThisContext(readFileSync(new URL("../js/lead-rules.js", import.meta.url), "utf8"), {
  filename: "js/lead-rules.js"
});
const L = globalThis.EVLeadRules;

test("nome: exige nome e sobrenome, só letras, e normaliza espaços", () => {
  assert.equal(L.nameError("Maria da Silva"), "");
  assert.equal(L.nameError("José Érico"), "");
  assert.equal(L.nameError("Maria-José dos Santos"), "");
  assert.equal(L.nameError("D'Ávila Souza"), "");
  assert.equal(L.nameError("  Maria   Silva "), "");

  assert.equal(L.nameError(""), "empty");
  assert.equal(L.nameError("   "), "empty");
  assert.equal(L.nameError(null), "empty");
  assert.equal(L.nameError(undefined), "empty");
  assert.equal(L.nameError("maria"), "surname");
  assert.equal(L.nameError("Maria 2 Silva"), "invalid");
  assert.equal(L.nameError("Ana_Paula Souza"), "invalid");
  assert.equal(L.nameError("maria@gmail.com"), "invalid");
  assert.equal(L.nameError("M"), "invalid");

  assert.equal(L.normalizeName("  Maria   da  Silva "), "Maria da Silva");
  assert.equal(L.normalizeName(null), "");
});

test("WhatsApp: DDD válido, celular com 9, 11 dígitos, sem número repetido", () => {
  assert.equal(L.phoneError("(11) 91234-5678"), "");
  assert.equal(L.phoneError("11912345678"), "");
  assert.equal(L.phoneError("(38) 99876-5432"), "");
  assert.equal(L.phoneError("(99) 98123-4567"), "");

  assert.equal(L.phoneError(""), "empty");
  assert.equal(L.phoneError("abc"), "empty");
  assert.equal(L.phoneError("(11) 91234-567"), "incomplete");
  assert.equal(L.phoneError("119123456789"), "incomplete");
  // DDDs que não existem no Brasil.
  for (const ddd of ["10", "20", "23", "25", "26", "29", "30", "36", "39", "40", "50", "52", "56", "57", "58", "59", "60", "70", "72", "76", "78", "80", "90"]) {
    assert.equal(L.phoneError(`(${ddd}) 91234-5678`), "ddd", ddd);
  }
  // Fixo não tem WhatsApp de celular.
  assert.equal(L.phoneError("(11) 81234-5678"), "mobile");
  assert.equal(L.phoneError("(11) 3123-4567"), "incomplete");
  // Número "de mentira".
  assert.equal(L.phoneError("(11) 99999-9999"), "repeated");
  assert.equal(L.phoneError("(11) 91111-1111"), "repeated");
});

test("WhatsApp: aceita +55, 55 colado e zero de operadora", () => {
  for (const entrada of ["+55 11 91234-5678", "+5511912345678", "5511912345678", "55 (11) 91234-5678", "011912345678", "0 11 91234-5678"]) {
    assert.equal(L.normalizePhoneDigits(entrada), "11912345678", entrada);
    assert.equal(L.formatPhone(entrada), "(11) 91234-5678", entrada);
    assert.equal(L.phoneError(entrada), "", entrada);
  }
  // DDD 55 (RS) com 11 dígitos não pode perder o "55" achando que é o código do país.
  assert.equal(L.normalizePhoneDigits("55912345678"), "55912345678");
  assert.equal(L.formatPhone("55912345678"), "(55) 91234-5678");
});

test("WhatsApp: formatação progressiva enquanto digita", () => {
  assert.equal(L.formatPhone(""), "");
  assert.equal(L.formatPhone("1"), "(1");
  assert.equal(L.formatPhone("11"), "(11");
  assert.equal(L.formatPhone("119"), "(11) 9");
  assert.equal(L.formatPhone("1191234"), "(11) 91234");
  assert.equal(L.formatPhone("11912345"), "(11) 91234-5");
  assert.equal(L.formatPhone("119123456789"), "(11) 91234-5678");
});

test("máscara ao digitar não briga com o backspace", () => {
  // Apagou o "-": os dígitos não mudaram, então o dígito anterior sai junto.
  assert.equal(L.formatPhoneWhileTyping("(11) 91234", "(11) 91234-"), "(11) 9123");
  // Apagou um dígito normal.
  assert.equal(L.formatPhoneWhileTyping("(11) 91234-", "(11) 91234-5"), "(11) 91234");
  // Apagou o ")".
  assert.equal(L.formatPhoneWhileTyping("(11", "(11)"), "(1");
  // Digitando.
  assert.equal(L.formatPhoneWhileTyping("119", "11"), "(11) 9");
  assert.equal(L.formatPhoneWhileTyping("(11) 91234-56789", "(11) 91234-5678"), "(11) 91234-5678");
  assert.equal(L.formatPhoneWhileTyping("", "("), "");
});

test("e-mail: aceita domínios reais além de .com (gov.br, edu.br, .net, subdomínios)", () => {
  for (const email of [
    "maria@gmail.com",
    "maria@saude.sp.gov.br",
    "joao@usp.edu.br",
    "ana@uol.com.br",
    "x@provedor.net",
    "enf@hospital.org",
    "a.b+c@mail.hospital.org.br",
    "maria_2@yahoo.com.br",
    "maria@outlook.com.br",
    "maria@me.com",
    "x@uai.com.br",
    "  MARIA@GMAIL.COM "
  ]) {
    assert.equal(L.emailError(email), "", email);
  }
  assert.equal(L.normalizeEmail("  MARIA@GMAIL.COM "), "maria@gmail.com");
  assert.equal(L.emailDomain("  Maria@Saude.SP.gov.br"), "saude.sp.gov.br");
  assert.equal(L.emailDomain("sem-arroba"), "");
});

test("e-mail: recusa formato inválido", () => {
  assert.equal(L.emailError(""), "empty");
  assert.equal(L.emailError(null), "empty");
  for (const email of [
    "maria",
    "maria@gmail",
    "maria@@gmail.com",
    "maria@a@gmail.com",
    "maria gmail.com",
    "maria @gmail.com",
    "@gmail.com",
    "maria@gmail..com",
    "maria@-x.com",
    "maria.@gmail.com",
    ".maria@gmail.com",
    "maria@gmail.c",
    "maria@gmail.123",
    `${"a".repeat(65)}@gmail.com`,
    `maria@${"a".repeat(250)}.com`
  ]) {
    assert.equal(L.emailError(email), "invalid", email);
  }
});

test("e-mail: erro de digitação certo bloqueia (typo) e vem com sugestão", () => {
  const casos = {
    "maria@gmail.com.br": "maria@gmail.com",
    "maria@gmail.co": "maria@gmail.com",
    "maria@hotmail.con": "maria@hotmail.com",
    "maria@gmail.combr": "maria@gmail.com",
    "maria@icloud.com.br": "maria@icloud.com"
  };
  for (const [email, sugestao] of Object.entries(casos)) {
    assert.equal(L.emailError(email), "typo", email);
    assert.equal(L.suggestEmail(email), sugestao, email);
  }
  // Provedor conhecido com final inexistente: bloqueia mesmo sem sugestão pronta.
  assert.equal(L.emailError("maria@bol.com"), "typo");
});

test("e-mail: sugere correção para domínios parecidos com os populares, sem bloquear", () => {
  assert.equal(L.emailError("maria@gmial.com"), "");
  assert.equal(L.suggestEmail("maria@gmial.com"), "maria@gmail.com");
  // Provedor estrito sem o .br: bloqueia como "typo" e oferece a correção.
  assert.equal(L.emailError("maria@bol.com"), "typo");
  assert.equal(L.suggestEmail("maria@bol.com"), "maria@bol.com.br");
  assert.equal(L.suggestEmail("maria@uol.com"), "maria@uol.com.br");
  assert.equal(L.suggestEmail("maria@hotmal.com"), "maria@hotmail.com");
  assert.equal(L.suggestEmail("maria@outlok.com"), "maria@outlook.com");
  assert.equal(L.suggestEmail("MARIA@Gmial.com"), "maria@gmail.com");

  // Domínios reais nunca recebem sugestão.
  for (const email of ["maria@gmail.com", "maria@yahoo.com.br", "maria@me.com", "maria@oi.com.br", "maria@uai.com.br", "maria@saude.sp.gov.br"]) {
    assert.equal(L.suggestEmail(email), "", email);
  }
  assert.equal(L.suggestEmail("sem-arroba"), "");
});

/* ------------------------------------------------------------------ régua .com/.com.br (Imersão GPS) */

const SO_COM_BR = { somenteComBr: true };
// Endereços válidos que a régua da página toda (a pesquisa, a Viver de Furo) aceita, mas que não
// terminam em .com nem em .com.br.
const FORA_DO_COM_BR = [
  "x@provedor.net",
  "enf@hospital.org",
  "maria@saude.sp.gov.br",
  "joao@usp.edu.br",
  "a.b+c@mail.hospital.org.br",
  "maria@empresa.co",
  "maria@empresa.com.pt",
  "maria@empresa.net.br",
  "ana@proton.me",
  "maria@hotmail.es"
];

test("e-mail com { somenteComBr: true }: .com e .com.br passam", () => {
  for (const email of [
    "maria@gmail.com",
    "ana@uol.com.br",
    "enf@hospital.com.br",
    "maria_2@yahoo.com.br",
    "maria@outlook.com.br",
    "maria@me.com",
    "x@uai.com.br",
    "a.b+c@mail.hospital.com.br",
    "  MARIA@GMAIL.COM ",
    "Enf@Hospital.COM.BR"
  ]) {
    assert.equal(L.emailError(email, SO_COM_BR), "", email);
  }
});

test("e-mail com { somenteComBr: true }: .net, .org, .gov.br, .edu.br e outros viram com_br", () => {
  for (const email of FORA_DO_COM_BR) {
    assert.equal(L.emailError(email, SO_COM_BR), "com_br", email);
    // É um endereço válido: não há correção para sugerir.
    assert.equal(L.suggestEmail(email), "", email);
  }
});

test("e-mail com { somenteComBr: true }: typo, invalid e empty vêm antes de com_br", () => {
  // gmail.con continua "typo" — e com a sugestão, que é o que a tela oferece para corrigir.
  const casos = {
    "maria@gmail.con": "maria@gmail.com",
    "maria@hotmail.con": "maria@hotmail.com",
    "maria@gmail.com.br": "maria@gmail.com",
    "maria@gmail.co": "maria@gmail.com",
    "maria@bol.com": "maria@bol.com.br",
    "maria@icloud.com.br": "maria@icloud.com"
  };
  for (const [email, sugestao] of Object.entries(casos)) {
    assert.equal(L.emailError(email, SO_COM_BR), "typo", email);
    assert.equal(L.suggestEmail(email), sugestao, email);
  }
  // Terminação que não existe, mesmo fora dos provedores estritos.
  assert.equal(L.emailError("maria@empresa.con", SO_COM_BR), "typo");
  assert.equal(L.emailError("maria@empresa.cmo", SO_COM_BR), "typo");

  assert.equal(L.emailError("", SO_COM_BR), "empty");
  assert.equal(L.emailError(null, SO_COM_BR), "empty");
  for (const email of ["maria", "maria@gmail", "maria@@gmail.com", "@gmail.com", "maria@gmail..com", "maria@gmail.c"]) {
    assert.equal(L.emailError(email, SO_COM_BR), "invalid", email);
  }
});

test("e-mail sem a opção (ou com ela desligada): nada muda, qualquer domínio real passa", () => {
  for (const email of FORA_DO_COM_BR) {
    assert.equal(L.emailError(email), "", email);
    for (const opcoes of [undefined, null, {}, { somenteComBr: false }, { somenteComBr: 0 }, { outra: true }]) {
      assert.equal(L.emailError(email, opcoes), "", `${email} ${JSON.stringify(opcoes)}`);
    }
  }
  // Os outros códigos também são os mesmos com e sem a opção.
  for (const email of ["", "maria", "maria@gmail.con", "maria@gmail.com.br", "maria@gmail.com"]) {
    assert.equal(L.emailError(email, SO_COM_BR), L.emailError(email), email);
  }
});

test("mensagem com_br e isComOrComBr", () => {
  assert.equal(L.message("email", "com_br"), "Use um e-mail que termine em .com ou .com.br.");
  assert.equal(L.message("email", "com_br"), L.MESSAGES.email.com_br);
  assert.ok(Object.isFrozen(L.MESSAGES.email));

  for (const dominio of ["gmail.com", "uol.com.br", "mail.hospital.com.br", "a.com"]) {
    assert.equal(L.isComOrComBr(dominio), true, dominio);
  }
  for (const dominio of ["hospital.org", "saude.sp.gov.br", "usp.edu.br", "provedor.net", "empresa.com.pt", "empresa.combr", "empresa.com.bra", "empresa.company", "x.com.br.net", "com", "com.br", "", null, undefined, 42]) {
    assert.equal(L.isComOrComBr(dominio), false, String(dominio));
  }
});

test("isComOrComBr: maiúsculas e espaços em volta não mudam a resposta", () => {
  for (const dominio of ["GMAIL.COM", "Gmail.Com", "UOL.COM.BR", "Hospital.Com.Br", "  gmail.com  ", "\tuol.com.br\n"]) {
    assert.equal(L.isComOrComBr(dominio), true, JSON.stringify(dominio));
  }
  for (const dominio of ["HOSPITAL.ORG", "SAUDE.SP.GOV.BR", "EMPRESA.COM.PT", "GMAIL.COM.BR.NET", "   ", "COM"]) {
    assert.equal(L.isComOrComBr(dominio), false, JSON.stringify(dominio));
  }
  // O mesmo que emailError usa: o domínio já sai minúsculo de normalizeEmail, mas a função não depende disso.
  assert.equal(L.emailError("MARIA@GMAIL.COM", SO_COM_BR), "");
  assert.equal(L.emailError("ENF@HOSPITAL.ORG", SO_COM_BR), "com_br");
});

test("emailError: opções null, de outro tipo ou sem protótipo não lançam e valem como sem opção", () => {
  for (const opcoes of [null, 0, "", "somenteComBr", true, 42, [], Object.create(null), { somenteComBr: "true" }]) {
    const rotulo = opcoes === null ? "null" : typeof opcoes === "object" ? JSON.stringify(opcoes) : String(opcoes);
    assert.doesNotThrow(() => L.emailError("ana@hospital.org", opcoes), rotulo);
    assert.equal(L.emailError("ana@hospital.org", opcoes), "", rotulo);
  }
});

test("mensagens para a tela saem do mesmo arquivo", () => {
  assert.equal(L.message("email", "typo"), L.MESSAGES.email.typo);
  assert.equal(L.message("phone", "ddd"), L.MESSAGES.phone.ddd);
  assert.equal(L.message("name", "surname"), L.MESSAGES.name.surname);
  assert.equal(L.message("phone", ""), "");
  // Código desconhecido cai na mensagem genérica do campo; campo desconhecido, em nada.
  assert.equal(L.message("name", "zzz"), L.MESSAGES.name.invalid);
  assert.equal(L.message("x", "empty"), "");
  assert.equal(typeof L.MESSAGES.email.domain, "string");
  assert.ok(Object.isFrozen(L.MESSAGES));
});

test("nome vai para o banco com maiúsculas certas e partículas minúsculas", () => {
  assert.equal(L.formatName("maria da silva"), "Maria da Silva");
  assert.equal(L.formatName("  MARIA   DOS SANTOS "), "Maria dos Santos");
  assert.equal(L.formatName("joão d'ávila"), "João D'Ávila");
  assert.equal(L.formatName("ana-clara de souza e silva"), "Ana-Clara de Souza e Silva");
  assert.equal(L.formatName("ÉRICA ÚRSULA"), "Érica Úrsula");
  // Partícula no começo é nome, não partícula.
  assert.equal(L.formatName("da silva maria"), "Da Silva Maria");
  assert.equal(L.formatName(""), "");
  // Formatar não muda o que a validação aceita.
  for (const nome of ["maria da silva", "ANA B", "joão d'ávila"]) assert.equal(L.nameError(L.formatName(nome)), L.nameError(nome));
});
