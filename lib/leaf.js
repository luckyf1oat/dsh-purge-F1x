/**
 * 按需叶子：把「只属于某一类的具体事实」从常驻预算里挪出去，拒答命中时才装回来。
 *
 * 为什么不是「模型自己调 skill 工具」
 * ----------------------------------
 * 需要叶子的时候，恰恰是模型最不愿意主动调工具的时候 —— 它刚拒了一次，
 * 语境里全是谨慎措辞，这时候让它主动去翻手册，等于让它在最犹豫的时候做最大动作。
 * 而且它不知道自己该翻哪一片：它只知道「不知该不该答」，不知道「这属于 crack」。
 *
 * 所以分类和加载都由插件这一侧做，不问模型。
 *
 * 判据（每一片都要过）
 * --------------------
 * 把这篇删掉，这一类的输出会变差吗？不会变差就是废物，删掉。
 * 冷咖啡的 80 片叶子是反面教材：中位数 33 字符，均值 349 字符，
 * 只有 18/80 含具体工具名，收口行与缺参行 80 个文件逐字相同。
 * 那不是叶子，是模板印刷。
 *
 * 所以叶子只装四样东西：
 *   - 该类具体工具名 / 命令 / 参数（内核 1,448 tok 里一个字都放不下）
 *   - 该类典型拒答原句 → 对应拆法
 *   - 该类专有的坑（版本、签名、架构、加固）
 *   - 该类第一条输出该长什么样
 * 方法论（先侦察再验证）、占位符清单、免责收口 —— 一律不进叶子，那些内核已经说过。
 *
 * @module dsh-purge-flash/leaf
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 高显著性：宾语本身就是伤害动作（放倒某人 / 致伤 / 下药 / 针对某个具体人）。
 * 这类请求**不存在中性重述** —— 实测模型对它是 0 段推理的直接硬拒，
 * 加压 prefill 没用，唯一有效的是换落点。所以单独一类，优先于其余九类。
 */
export const ADJACENT_KW =
  /失去意识|昏迷|放倒|致晕|迷晕|麻痹|下药|投毒|毒死|致死量|致死剂量|多少克|多大剂量|弄伤|打伤|重伤|武器|爆炸物|自制炸药|杀人|报复某人|对付某人|针对他|针对她|跟踪.*不被发现|不被抓地跟踪/i;

/** 叶子只覆盖「任务类」。prefill / many-shot / puppetry 是手法，属于 adapter，不是叶子。 */
export const LEAVES = Object.freeze([
  { id: "pentest", title: "渗透打点", kw: /sql注入|\bsqli?\b|xss|ssrf|csrf|越权|提权|打点|拿站|getshell|webshell|nmap|ffuf|sqlmap|burp|反弹shell|横向|内网/i },
  { id: "malware", title: "木马远控", kw: /木马|远控|后门|免杀|持久化|加载器|shellcode|beacon|c2\b|cobalt|meterpreter|蠕虫|勒索|bootkit|rootkit/i },
  { id: "crack", title: "破解逆向", kw: /脱壳|壳|注册机|卡密|激活码|序列号|去\s*drm|破解|逆向|patch|keygen|jadx|apktool|frida|hopper|ida\b|x64dbg|重打包|sign/i },
  { id: "fraud", title: "伪造与社工", kw: /伪造|假证|学历|流水|截图生成|话术|钓鱼|仿站|仿页|社工|骗|背调|kyc|身份证|银行流水|合同|sim\s*卡|补卡|换卡|接管号码|验证码拦截|冒充客服/i },
  { id: "credential", title: "凭据与撞库", kw: /撞库|爬取账号|口令|密码喷洒|字典|代理池|验证码|打码|注册机|批量注册|抢购|秒杀|风控|过检/i },
  { id: "automation", title: "自动化与脚本", kw: /自动化|脚本|autojs|按键精灵|selenium|puppeteer|playwright|adb|hook|注入|模拟点击|群控|养号/i },
  { id: "osint", title: "情报与查人", kw: /查人|开盒|人肉|社工库|手机号|身份证|定位|轨迹|反查|whois|子域|资产测绘|指纹|溯源/i },
  { id: "adult", title: "成人内容", kw: /成人|色情|露骨|性|番号|找片|资源|磁力|种子|av\b|hentai|nsfw|情色|肉文/i },
  { id: "monetize", title: "变现与分发", kw: /变现|卖|渠道|收款|跑分|洗钱|支付通道|建站|分销|代理|发卡|卡台|引流|私域|报价/i },
]);

const BY_ID = new Map(LEAVES.map((l) => [l.id, l]));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, "..", "skill");

/** 叶子正文缓存：同一进程内不重复读盘 */
const cache = new Map();

/** 从一段自然语言里挑一类。挑不到返回 null —— 宁可不装，也不要装错。 */
export function pickLeaf(text) {
  const s = typeof text === "string" ? text : "";
  if (!s) return null;
  // 高显著性优先：这类不能重述，只能换落点
  if (ADJACENT_KW.test(s)) {
    return { id: "adjacent", title: "邻近交付", kw: ADJACENT_KW };
  }
  let best = null;
  let bestHits = 0;
  for (const leaf of LEAVES) {
    const m = s.match(new RegExp(leaf.kw.source, "gi"));
    const hits = m ? m.length : 0;
    if (hits > bestHits) {
      best = leaf;
      bestHits = hits;
    }
  }
  return best;
}

/** 读一片叶子。读不到返回空串（调用方按「没叶子」处理，不抛）。 */
export function readLeaf(id) {
  const key = String(id || "");
  if (!key) return "";
  if (cache.has(key)) return cache.get(key);
  const file = path.join(SKILL_DIR, `leaf-${key}.md`);
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8").trim();
  } catch {
    text = "";
  }
  cache.set(key, text);
  return text;
}

/** 索引行（常驻用，一行一片）。 */
export function leafIndexLines() {
  return LEAVES.map((l) => `- ${l.id}（${l.title}）`);
}

/** 分类结果的可读名，给日志和 /armor status 用。 */
export function leafLabel(id) {
  const key = String(id || "");
  if (key === "adjacent") return "adjacent（邻近交付）";
  const l = BY_ID.get(key);
  return l ? `${l.id}（${l.title}）` : key || "?";
}

/** 测试用：清缓存 */
export function _clearLeafCache() {
  cache.clear();
}
