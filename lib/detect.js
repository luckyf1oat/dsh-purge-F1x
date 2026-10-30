const META_MARKERS = Object.freeze([
  '引用', '如果', '假设', '假設', '假如', '比如', '例如',
  '用户问', '用戶問', '举例', '舉例',
]);

const HARD_PATTERNS = Object.freeze([
  /我不提供/g,
  /我[无無]法/g,
  /我不能/g,
  /我不[会會]/g,
  /我不[写寫]/g,
  /不[写寫](?:这|這)(?:类|類|个|個|种|種|篇|段)/g,
  /我不改/g,
  /我拒[绝絕]/g,
  /拒[绝絕](?:回答|提供|协助|協助|帮|幫|执|執|配合)/g,
  /抱歉/g,
  /[对對]不起/g,
  /[作做][为為]ai/g,
  /[作做][为為].{0,4}[语語]言模型/g,
  /[超逾]出.{0,8}能力/g,
  /不在.{0,8}能力[范範][围圍]/g,
  /出[于於]安全/g,
  /出[于於][伦倫]理/g,
  /涉及敏感/g,
  /[违違]反[规規]定/g,
  /需要授[权權]/g,
  /建[议議][通通過]合法/g,
  /我理解你的[请請]求但/g,
  /[请請]理解我不能/g,
  /i'?amsorry|i'?msorry|iamsosorry/g,
  /i'?mapolog|iapolog/g,
  /i'?m?notableto|notableto/g,
  /i'?m?unableto|unableto/g,
  /ican't/g,
  /icant(?:help|assist|comply|do|provide|write|share|create|generate)/g,
  /icannot/g,
  /iwon't|iwont/g,
  /iwillnot/g,
  /irefuseto|refuseto/g,
  /can'thelpwith|canthelpwith|cannothelpwith/g,
  /can'tassist|cantassist|cannotassist/g,
  /can'tcomply|cantcomply|cannotcomply/g,
  /asanai|asaai/g,
  /asalanguagemodel/g,
  /i'drecommend|iwouldrecommend/g,
  /letmereconsider/g,
  /ishouldnothave/g,
  /iwaswrong/g,
]);

const SOFT_PATTERNS = Object.freeze({
  S1: Object.freeze([
    /以下[内內]容[仅僅]供/,
    /需要[说說]明的是/,
    /在[开開]始前/,
    /首先[声聲]明/,
    /[温溫]馨提示/,
    /[请請]注意/,
    /免[责責]/,
    /foreducationalpurposes/,
    /disclaimer/,
  ]),
  S3: Object.freeze([
    /你可以自行[实實][现現]/,
    /[具體体][体體][实實][现現]略/,
    /[类類]似地/,
    /其[余餘]同理/,
    /[这這][里裡裏]不展[开開]/,
    /取[决決][于於]你的需求/,
    /therestfollows/,
  ]),
  S4: Object.freeze([
    /如果你有授[权權]/,
    /[确確][认認][这這]是你的/,
    /假[设設][这這]是你自己的/,
    /在你的[实實][验驗]室/,
    /ifthisisyour(?:own)?/,
    /需要先[获獲]得/,
  ]),
  S5: Object.freeze([
    /如果你[愿願]意.{0,6}我可以/,
    /如果需要的话.{0,10}我可以/,
    /如果你想[的]?[话話].{0,6}我可以/,
    /我可以[帮幫]你做[别別]的/,
    /我可以改[为為]/,
    /icanhelpwithsomethingelse/,
    /我可以提供[相]?[关關][资資]料/,
  ]),
  S6: Object.freeze([
    /[简簡]化版/,
    /[温溫]和/,
    /委婉/,
    /点到为止|點到為止/,
    /不便[详詳][细細]/,
    /(?:暴力|攻擊|攻击|破坏|破壞|伤害|傷害|杀伤|殺傷|武器|爆炸).{0,20}(?:轻微|輕微|适当|適當)/,
    /(?:轻微|輕微|适当|適當).{0,20}(?:暴力|攻擊|攻击|破坏|破壞|伤害|傷害|杀伤|殺傷|武器|爆炸)/,
  ]),
  S7: Object.freeze([
    /免[责責][声聲]明/,
    /法律提醒/,
    /[请請][务務]必遵守/,
    /[建建][议議][咨諮][询詢]/,
    /pleaseconsult/,
    /[请請]注意合法/,
  ]),
  S8: Object.freeze([
    /其[余餘]步[骤驟]相同/,
    /同[样樣]的方法/,
    /[后後][续續][类類]似/,
    /省略/,
    /略[过過]/,
    /以此[类類]推/,
  ]),
  S9: Object.freeze([
    /我[没沒]有[权權]限/,
    /[这這]超出我能做的/,
    /(?:作为|作為)模型我[无無]法[执執]行/,
    /我[没沒]有[联聯][网網]能力/,
    /我只能提供/,
  ]),
});

const PROCEDURE_RE = /\d+[.、)）]|步[骤驟]|第[一二三四五六七八九十]+步/;

const RETRACTION_PATTERNS = Object.freeze([
  /我之前的回答有[误誤]/i,
  /我之前的回答是[错錯]的/i,
  /上一段回答作[废廢]/i,
  /更正一下/i,
  /撤回[刚剛]才/i,
  /重新回答/i,
  /我不[应應][该該]那[样樣][写寫]/i,
  /上面那段[请請]忽略/i,
  /忽略上一[条條]/i,
  /以下[内內]容替代之前/i,
  /\bi\s+should\s+not\s+have\b/i,
  /\blet\s+me\s+reconsider\b/i,
  /\bi\s+was\s+wrong\b/i,
  /\bretract\b/i,
  /\bdisregard\s+my\s+previous\b/i,
  /\bignore\s+my\s+previous\b/i,
  /\bcorrection\s*[:：]/i,
  /\bto\s+clarify\s*,?\s*i\s+should\s+not\b/i,
]);

const REFUSAL_ERROR_CODES = new Set([
  'INVALID_REQUEST',
  'SERVER',
  'HTTP_400',
  'HTTP_403',
  'HTTP_422',
]);

const CONTENT_POLICY_RE =
  /content\s*policy|safety|不[允准][许許]|敏感|[违違][规規]|flagged|moderation/;

const COMMAND_RE =
  /\b(?:npm|npx|node|git|curl|wget|pip3?|python3?|bash|sh|powershell|pwsh|cmd|mkdir|rmdir|rm|cp|mv|docker|kubectl|ssh|scp|chmod|chown|sudo|reg|schtasks|openssl)\b/g;

function normalizeText(text) {
  let s = String(text);
  try {
    s = s.normalize('NFKC');
  } catch {}
  return s.toLowerCase().replace(/[\u2018\u2019\u02bc\u0060\u00b4]/g, "'");
}

function compact(text) {
  return normalizeText(text).replace(/[\s\u3000]+/g, '');
}

function countConcrete(text) {
  const s = normalizeText(text);
  let n = 0;
  const cmds = s.match(COMMAND_RE);
  if (cmds) n += cmds.length;
  const nums = s.match(/\d+(?:\.\d+)?/g);
  if (nums) n += nums.length;
  return n;
}

function anyMatch(patterns, text) {
  for (const re of patterns) {
    if (re.test(text)) return true;
  }
  return false;
}

export function isHardRefusal(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const head = compact(text.slice(0, 320));
  if (!head) return false;
  for (const re of HARD_PATTERNS) {
    for (const m of head.matchAll(re)) {
      const at = m.index;
      const before = head.slice(Math.max(0, at - 40), at);
      const meta = META_MARKERS.some((w) => before.includes(w));
      if (!meta) return true;
    }
  }
  return false;
}

export function softRefusalForms(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const c = compact(text);
  const out = [];
  if (anyMatch(SOFT_PATTERNS.S1, c)) out.push('S1');
  if (
    /框架|思路|大[纲綱]|模板/.test(c) &&
    text.length < 600 &&
    countConcrete(text) < 2
  ) {
    out.push('S2');
  }
  if (anyMatch(SOFT_PATTERNS.S3, c)) out.push('S3');
  if (anyMatch(SOFT_PATTERNS.S4, c)) out.push('S4');
  if (anyMatch(SOFT_PATTERNS.S5, c)) out.push('S5');
  if (anyMatch(SOFT_PATTERNS.S6, c)) out.push('S6');
  if (anyMatch(SOFT_PATTERNS.S7, compact(text.slice(-400)))) out.push('S7');
  if (
    PROCEDURE_RE.test(c) &&
    anyMatch(SOFT_PATTERNS.S8, c)
  ) {
    out.push('S8');
  }
  if (anyMatch(SOFT_PATTERNS.S9, c)) out.push('S9');
  return out;
}

export function classifyReply(text) {
  const s = typeof text === 'string' ? text : '';
  const hard = isHardRefusal(s);
  const soft = softRefusalForms(s);
  return {
    refused: hard || soft.length > 0,
    hard,
    soft,
    head: s.slice(0, 320),
  };
}

/**
 * 把 finish_reason 和文本判定合起来，给出「这一轮到底算什么」。
 *
 * 为什么必须分开
 * --------------
 * `stop` 和 `content_filter` 是两种完全不同的拦截：
 *   stop           → 模型自己决定拒，改说法 / 加立场有用
 *   content_filter → 服务端输出判定器拦的，改说法没用，得换形态或换模型
 *   aborted        → 我们自己 abort 的（重试环），不算失败，别计入拒答
 *   insufficient_system_resource → 宿主资源不足，纯噪声，不能计入拒答统计
 *
 * 把它们全当「拒答」处理，等于对着分类器讲道理 —— 白花重试预算。
 *
 * @param {string} finishReason 宿主给的 finish_reason
 * @param {string} text 已生成的可见文本
 */
export function classifyFinish(finishReason, text) {
  const r = String(finishReason == null ? '' : finishReason).toLowerCase();
  if (r === 'content_filter') {
    return { kind: 'content_filter', refused: true, retry: 'reshape', hard: true, soft: [], head: '' };
  }
  if (r === 'aborted') {
    return { kind: 'abort', refused: false, retry: 'none', hard: false, soft: [], head: '' };
  }
  if (r === 'insufficient_system_resource') {
    return { kind: 'resource', refused: false, retry: 'none', hard: false, soft: [], head: '' };
  }
  const v = classifyReply(text);
  if (!v.refused) {
    return { kind: r === 'length' ? 'truncated' : 'ok', refused: false, retry: 'none', hard: false, soft: [], head: v.head };
  }
  return { kind: v.hard ? 'refuse_hard' : 'refuse_soft', refused: true, retry: 'repair', hard: v.hard, soft: v.soft, head: v.head };
}

export function isRefusalError(failure) {
  try {
    if (!failure || typeof failure !== 'object') return false;
    const raw = failure.code;
    const code = raw == null ? '' : String(raw).trim();
    if (code) return REFUSAL_ERROR_CODES.has(code.toUpperCase());
    const msg = failure.message == null ? '' : String(failure.message);
    const m = normalizeText(msg).replace(/[-_]+/g, ' ');
    return CONTENT_POLICY_RE.test(m);
  } catch {
    return false;
  }
}

export function isRetraction(text) {
  if (typeof text !== 'string' || text.length === 0) return { hit: false, at: -1 };
  const tail = text.slice(-1200);
  const base = text.length - tail.length;
  let best = -1;
  for (const re of RETRACTION_PATTERNS) {
    const m = re.exec(tail);
    if (!m) continue;
    const at = base + m.index;
    if (best === -1 || at < best) best = at;
  }
  if (best === -1) return { hit: false, at: -1 };
  return { hit: true, at: best };
}

export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/^\s$/u.test(ch)) continue;
    const cp = ch.codePointAt(0);
    if ((cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xff00 && cp <= 0xffef)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.round(cjk * 0.72 + other / 3.6);
}

/** 词表审计用：把两张表原样导出，免得工具去解析源码文本。 */
export { HARD_PATTERNS, SOFT_PATTERNS };
