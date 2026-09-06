/**
 * Texto seguro para logs e respostas JSON de erro — evita reflexão perigosa
 * (spoofing visual, poluição de terminal/log aggregator) em texto que
 * originalmente veio do usuário ou de terceiros. XSS de verdade (execução no
 * browser) é responsabilidade do frontend escapar corretamente ao renderizar;
 * este módulo é uma camada de defesa adicional no que sai daqui, não a única.
 *
 * Migrado de legacy/backend/lib/safeText.ts (sem mudança de comportamento).
 * Regex de zero-width/bidi construído por code point (`String.fromCharCode`),
 * não por escape literal no source (ex.: colar um U+200B de verdade no
 * arquivo) — assim o comportamento não depende de caracteres invisíveis
 * sobrevivendo intactos na cópia/edição do arquivo `.ts` em diferentes
 * editores/encodings.
 */

/** Códigos de controle ASCII/C1 a filtrar de logs — intervalo padrão (não é
 *  valor inventado): C0 (0x00-0x1F, exceto os já tratados por `\s+`), DEL
 *  (0x7F) e C1 (0x80-0x9F). */
// eslint-disable-next-line no-control-regex -- uso deliberado: sanitização de log precisa justamente destes caracteres de controle, não é regex acidental.
const CTRL_AND_C1_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g;

// Unicode: zero-width space/ZWNJ/ZWJ (U+200B–U+200D), BOM (U+FEFF), bidi
// override (U+202A–U+202E) — usados em ataques de spoofing visual (texto que
// parece uma coisa mas contém caracteres invisíveis/reordenadores de leitura).
const ZERO_WIDTH_SPACE_START = 0x200b;
const ZERO_WIDTH_JOINER_END = 0x200d;
const BOM = 0xfeff;
const BIDI_OVERRIDE_START = 0x202a;
const BIDI_OVERRIDE_END = 0x202e;

const ZERO_WIDTH_AND_BIDI_CHARS_RE = new RegExp(
  '[' +
    String.fromCharCode(ZERO_WIDTH_SPACE_START) + '-' + String.fromCharCode(ZERO_WIDTH_JOINER_END) +
    String.fromCharCode(BOM) +
    String.fromCharCode(BIDI_OVERRIDE_START) + '-' + String.fromCharCode(BIDI_OVERRIDE_END) +
    ']',
  'g'
);

/** Caracteres removidos por poderem confundir terminais/parsers de log ou
 *  serem usados em tentativas de injeção de comando ao colar log em shell:
 *  `< >` (tags/redirect), `&` (encadeamento de shell/entidade HTML),
 *  `` ` `` (substituição de comando), `|` (pipe), `$` (expansão de shell),
 *  `\` (escape). */
const LOG_UNSAFE_CHARS_RE = /[<>&`|$\\]/g;

const DEFAULT_LOG_MAX_LENGTH = 96;
const DEFAULT_API_MESSAGE_MAX_LENGTH = 200;

/**
 * Normaliza um valor arbitrário para uma string curta e segura de escrever
 * em log: remove caracteres invisíveis/bidi, caracteres de controle
 * (substituídos por espaço, não removidos — evita colar duas palavras),
 * caracteres perigosos em pipelines de log, colapsa espaços repetidos e
 * trunca com reticência (`…`) se exceder `maxLen`.
 *
 * @param value - Valor a sanitizar; não-string é convertido via `String()`.
 * @param maxLen - Tamanho máximo do resultado (antes da reticência, se houver).
 */
export function sanitizeForLog(value: unknown, maxLen: number = DEFAULT_LOG_MAX_LENGTH): string {
  let s = typeof value === 'string' ? value : String(value);
  s = s
    .replace(ZERO_WIDTH_AND_BIDI_CHARS_RE, '')
    .replace(CTRL_AND_C1_CHARS_RE, ' ')
    .replace(LOG_UNSAFE_CHARS_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxLen) return `${s.slice(0, maxLen)}…`;
  return s;
}

/** Prefixos de esquema de URL usados classicamente para XSS via atributo
 *  `href`/`src` (ex.: link "javascript:alert(1)" disfarçado de URL normal). */
const DANGEROUS_URL_SCHEME_RE = /^(javascript|data|vbscript)\s*:/i;
const SCRIPT_TAG_RE = /<script/i;

/**
 * Sanitiza uma mensagem que será devolvida ao cliente numa resposta JSON de
 * erro. Mais estrita que {@link sanitizeForLog}: se o texto parecer conter um
 * payload de injeção óbvio (esquema `javascript:`/`data:`/`vbscript:` ou tag
 * `<script`), descarta a mensagem inteira e devolve um texto genérico — não
 * tenta "limpar e reaproveitar" um payload malicioso, porque o objetivo aqui
 * é a mensagem chegar ao cliente, não só ao log interno.
 *
 * @param value - Valor a sanitizar; não-string é convertido via `String()`.
 * @param maxLen - Tamanho máximo do resultado.
 * @returns A mensagem sanitizada, ou 'Invalid request.'/'Internal error.' nos
 *   casos de payload suspeito ou de o resultado sanitizado ficar vazio.
 */
export function sanitizeApiMessage(value: unknown, maxLen: number = DEFAULT_API_MESSAGE_MAX_LENGTH): string {
  const raw = typeof value === 'string' ? value : String(value);
  if (DANGEROUS_URL_SCHEME_RE.test(raw.trim()) || SCRIPT_TAG_RE.test(raw)) {
    return 'Invalid request.';
  }
  const sanitized = sanitizeForLog(value, maxLen);
  if (!sanitized) return 'Internal error.';
  return sanitized;
}
