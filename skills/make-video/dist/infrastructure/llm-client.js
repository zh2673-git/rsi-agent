import { mvError, ERR } from '../core/errors.js';
import { LLM_RETRY_MAX, PLACEHOLDER_MARK, AUDIO_PROGRESSIONS, AUDIO_TEXTURES, AUDIO_MOODS, AUDIO_SFX_PALETTES } from '../core/constants.js';
import { pickCanvasProgram, bestTemplate, pickTemplateBySemantics } from '../domain/scene-semantics.js';
import { MOTION_WHITELIST, CAMERA_MOVES, ACCENT_PRIMITIVES } from '../core/validators/scene.js';
/** 产物是顶级 JSON 数组的任务：不能强制 json_object 容器 */
const ARRAY_TASKS = new Set(['storyboard', 'director-notes']);
export class ApiLlmClient {
    opts;
    name = 'api';
    constructor(opts) {
        this.opts = opts;
    }
    async generate(task) {
        const prompt = buildPrompt(task);
        // 分镜与导演批注的产物都是**顶级 JSON 数组**，而 response_format json_object 只允许对象容器：
        // 强制 json_object 会让真实模型把数组塞进 {"shots":[...]}，下游 (raw as unknown[]).map 直接炸。
        // 因此这两个任务放开容器形状，解析端再做「对象包数组」的兼容。
        const wantArray = ARRAY_TASKS.has(task.kind);
        const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${this.opts.apiKey}`,
            },
            body: JSON.stringify({
                model: this.opts.model,
                messages: prompt,
                temperature: 0.7,
                ...(wantArray ? {} : { response_format: { type: 'json_object' } }),
            }),
        });
        if (!res.ok)
            throw new Error(`LLM API ${res.status}: ${await res.text()}`);
        const data = (await res.json());
        const content = data.choices?.[0]?.message?.content ?? '';
        let parsed;
        try {
            parsed = JSON.parse(content);
        }
        catch {
            throw mvError(ERR.LLM_SCHEMA, 'LLM 返回非 JSON');
        }
        return wantArray ? unwrapArray(parsed) : parsed;
    }
}
/** 从模型输出里取回顶级数组：数组原样返回；对象则取其中第一个数组字段（shots/scenes/data…） */
function unwrapArray(parsed) {
    if (Array.isArray(parsed))
        return parsed;
    if (parsed && typeof parsed === 'object') {
        const arr = Object.values(parsed).find((v) => Array.isArray(v));
        if (Array.isArray(arr))
            return arr;
    }
    throw mvError(ERR.LLM_SCHEMA, 'LLM 分镜输出既不是数组也不含数组字段');
}
function buildPrompt(task) {
    const sys = task.kind === 'scene'
        ? buildSceneSystemPrompt()
        : task.kind === 'script'
            ? buildScriptSystemPrompt()
            : task.kind === 'audio-plan'
                ? AUDIO_PLAN_SYSTEM_PROMPT
                : task.kind === 'storyboard'
                    ? STORYBOARD_SYSTEM_PROMPT
                    : task.kind === 'material-plan'
                        ? MATERIAL_PLAN_SYSTEM_PROMPT
                        : task.kind === 'director-notes'
                            ? DIRECTOR_NOTES_SYSTEM_PROMPT
                            : `你是视频编译器的${task.kind}部门引擎。只输出合法 JSON，遵守给定 schema。`;
    // 讲稿与素材需求单的 payload 不含 schema 说明，靠系统提示词约束；
    // 其余任务把 payload 整体喂给模型。
    return [
        { role: 'system', content: sys },
        { role: 'user', content: JSON.stringify(task.payload) },
    ];
}
/**
 * 场景生成系统提示词（docs/04 美术摄影部）：按剧本语义拍，不吃大锅饭。
 *
 * v1.1.2 修订：原先把 MV.enter/idle/to/from/fromTo/... 手写进提示词，
 * 但 motion-lib 里根本没有 MV.from / MV.to / MV.fromTo —— 校验器按 MOTION_WHITELIST
 * 判「引用非白名单原语」直接打回。模型照提示词写就必被拒，重试 2 次仍写它，
 * 耗尽后静默回退 forge 模板：实测案例 30 镜只有 8 镜是 LLM 画的，22 镜是模板，
 * 于是「看起来是成套片子，其实 22 张是拼字板」。
 *
 * 现在原语清单一律由 MOTION_WHITELIST 单向派生（唯一事实源），提示词不再手写枚举——
 * 手工维护两份清单迟早漂移，而漂移的代价是整片画面降级成模板。
 */
/**
 * MOTION_WHITELIST 里还挂着纯数据导出（MV.MO / MV.MOTIF_KINDS），它们不是可调用原语，
 * 提示词与校验都不是针对它们的——统一在此排除，避免提示词出现「MV.MO 能调用」的误导。
 */
const NOT_PRIMITIVES = new Set(['MO', 'MOTIF_KINDS']);
export function buildSceneSystemPrompt() {
    // 保留完整 MV.xxx 形式：去掉前缀会让「写成 MV.xxx」的说明与清单本身不一致
    const prims = MOTION_WHITELIST.filter((p) => !NOT_PRIMITIVES.has(p)).join('/');
    return `你是视频编译器的美术摄影部场景画师。根据给定镜头的旁白语义与导演视觉意图，生成一个 HyperFrames 单场景 HTML。只输出合法 JSON：{"html": "<!doctype html>..."}。

0. **视觉丰富（本镜创作目标，优先级仅低于硬性契约）**：本镜要有可见的主动作 + 语义驱动的联动，画面始终在「演」旁白，禁止静态拼字板/「一张图配字幕」。丰富来自**关键量按语义有意义地动**（主体运动 + 相关元素随动联动），不是让所有元素一起抖；任何在 visualIntent/旁白里找不到依据的装饰运动（挂在主几何上的 shimmer/float/pulse）都算「乱动」，不要加。镜头推拉摇移不替代元素自身的运动。

硬性契约（校验器逐条把关，违反即打回）：
1. 完整骨架：<body data-scene-id="给定的sceneId"> 内有 .stage 容器；末尾 <script src="../motion/motion-lib.js"></script> 与一个 document.addEventListener('DOMContentLoaded', ...) 注册动画。
2. 画面必须表达本镜旁白的具体含义（人/物/数字/因果/过程），禁止通用装饰凑数，禁止出现旁白原文或导演指令文本。
   **知识锚点硬约束（payload.knowledgeAnchor 非空时）**：
   - mustShow 是本镜画面的**存在理由**——必须用真实几何/图形/数值变化把它画出来，主体动画直接体现这个关系（如"圆上点的纵坐标随时间画出正弦波"就要让点真的沿圆走、纵坐标真的拉出波形）；
   - forbidden 里的画法/说法一律不许出现；
   - **禁止用大字、标签、装饰粒子、与 mustShow 无关的 shimmer/float/pan 替代可视化证明**——写不出"这段画面怎么画出 mustShow"就是没想清楚，不许用文字糊弄过关。
   - 一镜只服务 mustShow 这一个知识点；不相关的元素一律删。
   **屏上文字纪律**（V-SCENE-005 判 error）：旁白里任何连续 4 个汉字都不得出现在画面文字里，也不得用旁白做标题。
   若这一镜确实需要文字，只允许：① 概括成数字/专名/缩写（旁白说"同一时间"，屏上写"4 路并行"）；② 短标签（≤4 字且非旁白原文，如"取指""译码"）；③ 标签元素必须带 class="caption"（或 hint/sub），校验器会把它当字幕区跳过。标题类文字同理，只能写本镜的抽象结论，不能抄旁白。
3. 动画原语**只有**这些（MV. 前缀，写成 MV.xxx）：${prims}。
   此外动作谱 actionSheet.requiredPrimitives 点名的原语必须全部真的调用。**白名单之外的 MV.xxx 一律判打回**——写之前先对照上面这份清单，不要臆造 MV.from / MV.to / MV.fromTo / MV.fade 之类不存在的原语。
   缓动只能取：power1-4 的 .in/.out/.inOut、sine、expo、quint、back.out、elastic.out、none。时长只允许 150-200/200-400/400-800/300-600/800-1200/1200-2600ms。
4. **动作谱就是施工图**（payload.actionSheet）：prepare/main/settle/secondary/cameraPath/soundCue/motif 逐条落实；requiredPrimitives 列出的每个原语必须真的调用一次（缺一个校验器打回）。MV.motifLoop 是**必选**（缺了整镜打回），且 amp ≥ 0.5（动 1-2px 等于没动）。
4a. **导演精修批注（payload.revisions，可能为空）**：这些是导演对上一版的具体意见（如「收尾再静一点」「数字小一点」），逐条在画面里落实——批注的优先级高于你对画面的默认判断。
4b. **重音是预算，不是强调语气**（V-MOT-013）：全片只有 ${ACCENT_PRIMITIVES.join('/')} 算重音标点，
   总预算 payload.accentCap 镜（≈ 总镜数 1/3）——全篇都加粗等于没有重点。
   payload.accentAllowed 为 **false 时本镜一个重音标点都不能用**：改用 enter/staggeredIn/highlight/
   morphTo/counter/cards 等非重音原语表达主动作（它们同样有力，只是不占预算）；
   为 true 时可用**至多一个**。requiredPrimitives 若已含重音原语则以动作谱为准（动作谱优先）。
5. **主语唯一（最容易踩，务必先写骨架）**：必须**恰好有一个**元素带 class="subject"（或 title/hero 之一，三者合计只能 1 个）。
   最小骨架照抄，再往里填内容：
     <div class="stage">
       <div class="subject">这一镜的主角（一个词/一个数字/一个图形）</div>
       <div class="deco">辅助元素，opacity ≤ 0.7</div>
     </div>
   自检：输出前数一遍 HTML 里 class="subject|title|hero" 出现次数，必须 == 1（0 个会被打回，2 个也会被打回）。
   辅助元素 opacity ≤ 0.7，同屏持续运动元素 ≤ 4、位移方向 ≤ 2。
6. 禁止属性 data-start/data-duration/data-track-index（时序只归剪辑部）；禁止 repeat:-1；位移不得 ease:'none' 急停。
7. 颜色只用给定 token 里的值，字体只用给定 fontFamily，字号用给定 px。
8. 用 MV.camera('.stage', { move, zoom }) 表达运镜；move 只能取：${CAMERA_MOVES.join('/')}（拼错会静默失效）。
9. 素材语言（payload.styleVisual）必须遵守：dimension=css3d 时至少用一个 3D 原语（MV.tilt3d/orbit/depth/card3d/spin3d），并给容器 perspective 与 transform-style:preserve-3d；dimension=2d 时禁止任何 3D 属性（perspective/rotate3d/translateZ）。motifs 是这一派允许的母题，texture 是允许的纹理层，styleVisual.note 是素材语言的一句话定义——场景必须长成这一派的样子，不能只换配色。`;
}
/** 配乐方案系统提示词：按讲稿主题与情绪弧选配乐，禁止万能 bed（docs/07 声音部 + SKILL.md 规则 9） */
export const AUDIO_PLAN_SYSTEM_PROMPT = `你是视频编译器的声音部（配乐总监）。根据讲稿主题、每段情绪弧与导演视觉意图，为**这一支片**定一套配乐与音效方案。只输出合法 JSON，字段与取值严格如下：

- rationale：一句话写清「为什么这个主题配这种乐」——必须扣住实际主题与节奏（如"三角函数从旋转到波形，逐级揭示，用清亮拨弦+缓慢展开的暖 pad 呼应'从一点长成一条波'的发现感"），不许写"好听""适合科普"这种空话。
- mood：气质，只能是 ${AUDIO_MOODS.join(' | ')}。
- bpm：整数 60-160，按叙事节奏定——慢思辨偏低、明快推进偏高；不确定给 84。
- progression：和弦进行，只能是 ${AUDIO_PROGRESSIONS.join(' | ')}。按情绪底色选：好奇科普 warm-jazzy、悬疑 mysterious、上扬 bright-major、宏大 epic-minor、极简 minimal-drone、俏皮 playful-pluck、紧张 tense-sus。
- texture：织体，只能是 ${AUDIO_TEXTURES.join(' | ')}。信息密集段用稀疏织体给旁白让位，情绪段可丰满。
- brightness：0..1 的小数，越清亮越高；冷暗主题取低，明快主题取高。
- sfxPalette：转场/重音音效音色，只能是 ${AUDIO_SFX_PALETTES.join(' | ')}。

纪律：配乐必须随本片主题与节奏而不同，禁止所有片子都是同一首默认 bed；rationale 要能让用户一眼判断"这套乐是不是为这个内容选的"。`;
/** 导演批注系统提示词（docs/04 导演部）：一段一条，讲「这镜靠什么和旁白对位」 */
const DIRECTOR_NOTES_SYSTEM_PROMPT = `你是视频编译器的导演部。根据讲稿每段旁白与类型配方的 beat 参考，为**每一段**写一条视觉批注。只输出合法 JSON 数组，数组长度必须等于输入 segments 长度，顺序一致。

每条字段（全部必填，除 referenceMood）：
- segmentId：直接用输入里该段的 id，禁止自造。
- visualIntent：这一镜**画什么**才能让旁白落地——写具体画面主体/构图/动作（例："取指单元的队列在屏幕中央一格一格推进，译码单元在右侧排队等位"）。禁止写"配一张图""抽象呈现""优雅排版"这类空话。并写清**这一镜怎么"画面丰富"**——主体的主动作 + 关键元素之间由语义驱动的联动（谁带动谁、谁随谁变），让画面一直在"演"旁白讲的这件事，而不是一张静态图配字幕。
- emotionGoal：观众看完这一段该有的感受，2-4 字（好奇/恍然/紧张/确信/释然…）。
- referenceMood：可选的参考影调描述（如"冷蓝机房夜景"），不确定就留空字符串。
- counterpoint：这批画面和旁白的对位关系，取值只能是 emotion | metaphor | evidence | parody。

对位纪律：按这一段**实际想让观众怎么理解画面**来选，而不是按它在结构里的位置套公式。
- 画面在放大感受、渲染气氛 → emotion；
- 画面在画真实的结构/证据/机制 → evidence；
- 画面用一个具体意象承载抽象概念 → metaphor；
- 画面与旁白形成庄重×琐碎的反差 → parody（有真实反差才用，不是每段都适合）。
不要全片只用一种对位——但「哪种对位」由这一段的创作意图决定，不由 beat 或段落序号决定。

动作准确与丰富纪律（画面丰富的判定标准）：
- **动作由语义决定**：写进 visualIntent 的每个动作都要能在本段旁白里找到依据——讲旋转就写旋转，讲投影就写投影随点联动，讲波形传播就写波形流动；不得添加旁白里没有依据的装饰性运动（为动而动）。
- **元素动优先于镜头动**：让画面里的元素（点/线/图形/数值）自己动起来承担丰富性，镜头只在确实需要时动，不把推拉摇移当丰富。
- **丰富不等于堆砌**：不是所有元素都动，而是与这段语义相关的关键量有明确、连贯的动作；无关元素保持安静。`;
/** 分镜系统提示词（docs/04 导演部 A5）：动机是「为什么切」，不是「这镜拍什么」 */
export function buildStoryboardSystemPrompt() {
    return STORYBOARD_SYSTEM_PROMPT;
}
const STORYBOARD_SYSTEM_PROMPT = `你是视频编译器的导演部（导演+分镜师）。根据讲稿段落与导演批注输出分镜数组。只输出合法 JSON 数组，每个元素是一镜。

每镜字段：
- segmentId / narration（必须原样使用该段旁白）/ visual（kind、prompt、template、params）
- zoom：ELS|LS|MS|CU|ECU；camera：${[...CAMERA_MOVES, 'static', 'none'].join('|')}。
  **static 是合法选择**（定格 + 镜内表演，喜剧常用），不是漏填；但全片静止镜别超过 40%，
  运镜也别每镜同一式——镜头长短决定行程：短促节拍镜别给长推轨。
- motivation：**切点动机**——只写「为什么从上一镜切到这一镜」，必须能归入下列之一：match-cut（同形接续）/ 动作接动作 / 视线接视线 / 情绪转场 / 节拍打点 / 景别跳。禁止写「静态呈现」「定场揭示」这类镜头内容描述；想不出理由就留空。
- transition：留空或 "auto"，让剪辑部按动机裁决；只有确实需要时才显式写 hard-cut/dissolve/smash-cut/wipe/whip-pan/slide。
- enterAnchor / exitAnchor：形状锚点 id（如 "circle""desk"）。相邻两镜 exitAnchor==enterAnchor 时剪辑部会自动判 match-cut 硬切。
- coverage：长镜（旁白 >4s）内的换机位点，**可选、默认不派生**，最多 3 条：{at:0-1, kind:"punch-in"|"reframe", scale:0.8-1.6, xPercent:-12~12, yPercent:-12~12, rotation:-3~3, motivation:"emphasis"}。只有你确实想在这个词上换机位时才写；不写就一镜到底。

节奏纪律：景别要有序列（ELS→LS→MS→CU→ECU 递进或跳切），相邻镜不要同景别同机位同转场；每 2-3 秒给一次视觉变化（可以是主体表演/图形动效，不必都靠机位）。

素材纪律：templates 是**风格筛过的候选池**（payload.styleVisual 说明这一派的素材语言：维度/母题/偏好/禁用），visual.template 只能从池中选；池里有 3D 形态（iso-stage/depth-layers）时，需要纵深/结构的镜头优先用它们，别全片退回平面排版。visual.params 可带 depth（0-1 纵深强度）等风格参数。`;
/**
 * 讲稿系统提示词（docs/04 编剧部）：这是全片唯一的「内容来源」，
 * 讲稿写虚了后面六个部门全是空转——因此把「必须讲具体机制」写成硬条款。
 * 结构完全交给编剧按主题独创：提示词里不放任何模板词（钩子/beats/格子），
 * 免得模型把「可选参考」当成默认骨架照抄。
 */
const SCRIPT_SYSTEM_PROMPT = `你是视频编译器的编剧部。根据主题写一份**口播讲稿**。只输出合法 JSON：{"fullText":"...","segments":[...]}。

内容纪律（最重要的三条）：
1. **每段必须推进具体信息**：讲清一个机制、一个因果、一个数字、一个对比、一个具体例子。禁止写「它比看起来更有意思」「把镜头拉近，细节开始显形」「回到最初的问题」这类**可以套在任何主题上的空话**——遇到主题专有名词就写它，遇到抽象就举实例。
2. **禁止重复**：任意两段不得表达同一件事，禁止把同一句话换个说法再写一遍，禁止韵律式排比填充段数。
3. 讲稿必须出现主题的**专有概念、专有名词或具体数据**（例如讲 CPU 流水线就要出现取指/译码/执行、数据冒险、分支预测这类词），不得只写通用叙事。
4. **为可视化写动作**：写机制/过程时，写清「谁是主体、它在怎么变、变出什么结果」——这些具体动作是导演和画师的动作依据。画面能否丰富，取决于这里的动作是否具体：「点沿圆周转动、高度拉出正弦曲线」比「三角函数很奇妙」更能让画面动起来。
5. **知识锚点（凡涉及知识/概念/原理/公式/数据的段必填）**：每段在讲知识时，必须给出 knowledgeAnchor 三件事——
   - coreConcept：本段要讲透的那一个知识点（一句话）；
   - mustShow：画面必须**真实画出**的关系/变化（如"圆上点的纵坐标随时间画出正弦波"），默认这条会交给画师逐镜落实，**禁止用大字/装饰/无关动画替代它**；
   - forbidden：会误导观众的错误画法或说法（如"把 sin 画成任意起伏的波浪"）。
   写不出 mustShow 的段，说明你还没想清楚这段在讲什么，回去重写。情绪/过渡段不必填。

分段纪律：
- 段数必须等于 targetSegments，一段一句话意单元。每段长度由你按主题与讲述节奏定（口播约 3-6 秒一段是常见尺度，不是硬上限——该长则长，该短则短）。
- 每段标 function：advance（推进新信息）| inform（解释）| emotion（情绪/悬念）。连续几段同类完全由你按内容的自然节奏决定，引擎不预设任何结构禁令。

结构纪律（最重要）：
- 没有预设结构，没有必须先做什么、也没有必须逐项覆盖的清单。怎么开头、怎么展开、怎么收束，只取决于这个主题最有力的讲法——可能是先抛一个具体场景，可能是一路铺陈再逐层揭开，也可能一个贯穿始终的比喻就够了。你不必对齐任何模板，也不要为了「像讲稿」去凑某种起承转合。
- 判断标准只有一条：这一段有没有推进具体内容。写完回头问自己——这个讲法是不是把主题讲透了？有没有更聪明的切入？有没有哪段是凑数？宁可多推敲一遍结构，也不要套框架交差。

重音纪律（V-RHY-004 硬约束，漏了会让剪辑部整片打回）：
- 每段必须给 emphasis：**该段里 1-3 个要重读的词**，从本段原文中原样摘取（不得改写、不得给整句）。
  这些词是后续字幕高亮与镜内重音的落点——**每段都不能空**，空一段就少一路重音载体。
- pausesMs（可选）：该段朗读的停顿位置，毫秒数组，一般 1-2 个，如 [220]。

输出 schema（emphasis 必填；讲知识的段 knowledgeAnchor 必填）：
{"fullText":"所有段落文字按顺序拼接",
 "segments":[{"id":"seg-1","text":"该段旁白原文","function":"advance|inform|emotion","mood":"neutral|curious|tense|awe|warm|urgent","emphasis":["本段重读词1","本段重读词2"],"knowledgeAnchor":{"coreConcept":"本段知识点","mustShow":"画面必须真实画出的关系","forbidden":"会误导的画法/说法"}}]}`;
export function buildScriptSystemPrompt() {
    return SCRIPT_SYSTEM_PROMPT;
}
/**
 * 素材需求单系统提示词（P5-B）：只做「这一镜需要什么样的真实素材」，不负责找、不负责画。
 * 检索由 agent 在引擎外完成，引擎只收需求单 + 入库校验 + 绑定。
 */
const MATERIAL_PLAN_SYSTEM_PROMPT = `你是视频编译器的素材统筹。根据逐镜旁白，判断哪些镜头需要**真实素材**（照片/视频）而不是代码绘制，并为需要的镜头写检索需求单。只输出合法 JSON：{"briefs":[...]}。

判断纪律（顺序执行）：
1. 先问「这一镜能不能靠代码画准」。抽象概念、数据、流程、对比、纯排版、chart 类 → need="none"，绝不要真实素材。
2. 只有旁白在指认**具体的现实对象**（真实人物/名址/特定器物/真实场景/历史影像）时，才 need≠none。泛指概念（"人们""城市""生活"）一律 none。
3. need 取值：person（真实人物肖像/半身）、place（真实地点/建筑/街景）、object（特定实物）、background（真实环境氛围底图）、none。
4. type：需要「动作/时间流逝/过程」→ video；静态对象/肖像/地点 → image。拿不准就 image（成本低、可控）。
5. query：**给检索工具用的关键词**，中英各写一份，用 " | " 分隔，例如 "苏州平江路 清晨 | Suzhou Pingjiang Road morning"。禁止写句子，禁止写镜头语言（不要 "特写""慢推"）。
6. mustHave：必须出现在画面里的可见要素（最多 4 个，名词）。avoid：不能出现的要素（水印、人物正脸、文字招牌等，按内容判断）。
7. reason：一句话说明「为什么这一镜非真实素材不可」，写不出具体理由就改 none。

输出 schema（每个镜头一条，顺序同输入）：
{"briefs":[{"shotId":"s01","need":"place","type":"image","query":"...","mustHave":["..."],"avoid":["..."],"reason":"..."}]}`;
export class RetryingLlmClient {
    inner;
    name;
    constructor(inner) {
        this.inner = inner;
        this.name = `retry(${inner.name})`;
    }
    async generate(task) {
        let lastErr = null;
        for (let i = 1; i <= LLM_RETRY_MAX; i += 1) {
            try {
                return await this.inner.generate(task);
            }
            catch (e) {
                lastErr = e;
            }
        }
        throw mvError(ERR.LLM_RETRY_EXCEEDED, `LLM 任务 ${task.kind} 重试 ${LLM_RETRY_MAX} 次仍失败: ${lastErr.message}`);
    }
}
export function createLlmClientFromEnv() {
    const baseUrl = process.env['LLM_BASE_URL'];
    const apiKey = process.env['LLM_API_KEY'];
    const model = process.env['LLM_MODEL'] ?? 'gpt-4o-mini';
    if (baseUrl) {
        // 本地/内网端点（localhost、127.0.0.1、内网段）常不校验 key：留空也要真的走 API。
        // 旧逻辑要求 baseUrl && apiKey 同时成立，缺 key 就静默退回 TemplateLlmClient——
        // 结果是全片 8 句套话循环，而所有形式校验依然全绿（v1.1.0 实战踩坑）。
        return new RetryingLlmClient(new ApiLlmClient({ baseUrl, apiKey: apiKey ?? '', model }));
    }
    // 未配端点显式降级：这条路径只能用来跑流程自检，不能当真实案例交付。
    return new RetryingLlmClient(new TemplateLlmClient());
}
/**
 * 当前是否在离线模板模式。
 * 离线模板的讲稿只是「占位骨架」，不是内容——调用方据此拒绝把产物当真实案例验收。
 */
export function isOfflineTemplateMode() {
    return !process.env['LLM_BASE_URL'];
}
export class TemplateLlmClient {
    name = 'template';
    async generate(task) {
        switch (task.kind) {
            case 'script':
                return templateScript(task.payload);
            case 'audio-plan':
                return templateAudioPlan(task.payload);
            case 'director-notes':
                return templateDirectorNotes(task.payload);
            case 'storyboard':
                return templateStoryboard(task.payload);
            case 'scene':
                return { html: '', note: 'template-mode: 由 scene-forge 本地模板生成' };
            case 'style-analyze':
                return templateStyleAnalyze(task.payload);
            case 'material-plan':
                return templateMaterialPlan(task.payload);
            default:
                throw mvError(ERR.LLM_SCHEMA, `template 引擎不支持的任务: ${task.kind}`);
        }
    }
}
/** 离线模板配乐方案：按题材关键字给一个非默认的变化，供无 LLM 时骨架可用（仍带占位标记由内容门拦） */
function templateAudioPlan(payload) {
    const p = payload;
    const text = `${p.topic ?? ''} ${p.genre ?? ''}`;
    // 离线模式没有内容能力，这里只按题材给一个可辨识的方向，不冒充"为内容精心选配"。
    if (/悬疑|推理|真相|谜|犯|调查/.test(text)) {
        return { rationale: '【离线占位】悬疑题材配暗色半音下行', mood: 'tense', bpm: 76, progression: 'mysterious', texture: 'sparse', brightness: 0.3, sfxPalette: 'metallic' };
    }
    if (/宏大|史诗|宇宙|起源|文明/.test(text)) {
        return { rationale: '【离线占位】宏大题材配开放五度宽 pad', mood: 'epic', bpm: 72, progression: 'epic-minor', texture: 'drone-pulse', brightness: 0.55, sfxPalette: 'soft' };
    }
    return { rationale: '【离线占位】通用好奇科普配暖拨弦', mood: 'warm-curious', bpm: 84, progression: 'warm-jazzy', texture: 'pluck-pad', brightness: 0.6, sfxPalette: 'glassy' };
}
function templateScript(payload) {
    const p = payload;
    const beats = p.beats?.length ? p.beats : [{ id: 'b1', name: '展开', function: 'inform' }];
    const target = Math.max(beats.length, p.targetSegments ?? beats.length);
    // 离线模板没有内容能力，只能产出「占位骨架」。
    // v1.1.1 起不再伪造内容：旧实现用 8 条通用套话按 i % 8 轮转，
    // 结果 30 段只有 8 句唯一、循环 3.75 遍，却被所有形式校验判为通过。
    // 现在每段显式标 PLACEHOLDER_MARK，内容门（V-SCP-015）据此硬拒——
    // 没有 LLM 就不该产出成片，而不是拿套话冒充讲稿。
    const segments = Array.from({ length: target }, (_, i) => {
        const b = beats[i % beats.length];
        return {
            id: `seg-${i + 1}`,
            text: `${PLACEHOLDER_MARK}第 ${i + 1} 段（beat=${b.id}）待 LLM 填写：${p.topic ?? ''}`,
            function: (b.function ?? 'inform'),
            beat: b.id,
            mood: ['curious', 'neutral', 'tense', 'awe'][i % 4],
        };
    });
    const fullText = segments.map((s) => s.text).join('');
    return { fullText, segments };
}
function templateDirectorNotes(payload) {
    const p = payload;
    const byBeat = new Map(p.recipeNotes.map((n) => [n.beatId, n]));
    return p.segments.map((s, i) => {
        const tpl = s.beat ? byBeat.get(s.beat) : undefined;
        return {
            segmentId: s.id,
            visualIntent: tpl?.visualIntent ?? `为第 ${i + 1} 段配图：与「${s.text.slice(0, 12)}…」构成对位`,
            emotionGoal: tpl?.emotionGoal ?? '稳定推进',
            referenceMood: tpl?.visualIntent?.slice(0, 20) ?? '',
            counterpoint: tpl?.counterpoint ?? (i === 0 ? 'emotion' : 'metaphor'),
        };
    });
}
function templateStoryboard(payload) {
    const p = payload;
    const bias = p.styleVisual?.sceneBias ?? [];
    // 风格禁用的形态即使混进候选池也不选
    const deny = new Set(p.styleVisual?.sceneDeny ?? []);
    const templates = p.templates.filter((t) => !deny.has(t));
    const noteBy = new Map(p.directorNotes.map((n) => [n.segmentId, n]));
    const decBy = new Map(p.materialDecisions.map((d) => [d.segmentId, d]));
    const zooms = p.shotScaleBias.length ? p.shotScaleBias : ['MS', 'CU'];
    // 模板按旁白语义分配（禁止索引轮转——"凑镜头数"的根源）：
    // canvas 程序按内容主题选（s01 引力钩子…s08 终幕），MV 模板按叙事形式选（流程/对比/数据/氛围）
    const canvasPrograms = templates
        .filter((t) => t.startsWith('canvas:'))
        .map((t) => t.slice('canvas:'.length));
    const mvTemplates = templates.filter((t) => !t.startsWith('canvas:'));
    const recentUsed = [];
    // P2：离线分镜也要给出「为什么切」——动机由景别关系/内容线索反推，机位按叙事轮换
    const CAMERA_CYCLE = ['push-in', 'pan', 'push-in', 'pull-out', 'tilt-up', 'pan-left'];
    let prevZoom = '';
    return p.segments.map((seg, i) => {
        const note = noteBy.get(seg.id);
        const dec = decBy.get(seg.id);
        let template;
        if (canvasPrograms.length > 0) {
            // 混合评分：强语义 MV 形式（数据/对比 ≥2 线索命中）压过程序化背景，
            // 让数字段出真图表、对比段出真对峙卡——异质画面形式打破"暗场小元素"的同质感
            const mv = mvTemplates.length > 0 ? bestTemplate(seg.text, mvTemplates, bias) : null;
            if (mv && mv.score >= 2) {
                template = mv.template;
            }
            else {
                const pick = pickCanvasProgram(seg.text, canvasPrograms, recentUsed);
                recentUsed.push(pick.program);
                template = `canvas:${pick.program}`;
            }
        }
        else {
            template = pickTemplateBySemantics(seg.text, mvTemplates.length ? mvTemplates : ['typography'], bias);
        }
        const zoom = zooms[i % zooms.length] ?? 'MS';
        // A2 对位优先取剧本层声明（编剧对「这一段怎么对位」的判断比配方 beat 的默认更具体），
        // 其次配方导演阐述，最后才是兜底。`parody` 仍归 V-CP-004 管（必须配 gag）。
        const counterpoint = seg.counterpoint ?? note?.counterpoint ?? 'metaphor';
        const motivation = i === 0 ? '' : relationReason(prevZoom, zoom, counterpoint, seg.text);
        prevZoom = zoom;
        return {
            segmentId: seg.id,
            narration: seg.text,
            visual: {
                kind: dec?.kind ?? 'code-scene',
                prompt: note?.visualIntent ?? `示意图：${seg.text.slice(0, 16)}`,
                template,
                params: { scene: `scene-${i + 1}`, side: 'center' },
                ...(dec?.source ? { source: dec.source } : {}),
            },
            zoom,
            camera: CAMERA_CYCLE[i % CAMERA_CYCLE.length] ?? 'push-in',
            motivation,
            counterpoint,
            // 转场留空 = auto，由剪辑部按动机裁决（P2：转场不再是索引轮转的装饰）
            transition: '',
        };
    });
}
const ZOOM_RANK = { ELS: 0, LS: 1, MS: 2, CU: 3, ECU: 4 };
/** 离线分镜的切点动机：先看客观景别关系，再看内容线索，判不出就留空（不编理由） */
function relationReason(prevZoom, zoom, counterpoint, text) {
    const gap = Math.abs((ZOOM_RANK[prevZoom] ?? 2) - (ZOOM_RANK[zoom] ?? 2));
    if (gap >= 2)
        return `景别跳：${prevZoom}→${zoom}，换尺度换信息`;
    if (/(冲|甩|撞|砸|掀|推倒|跑|追|爆|抢)/.test(text))
        return '动作接动作，气口不断';
    if (counterpoint === 'parody')
        return '接节拍：笑点落镜';
    if (/(沉默|安静|回忆|忽然|那一刻|原来|停顿|缓缓)/.test(text))
        return '情绪转场，慢下来';
    return '';
}
function templateStyleAnalyze(payload) {
    const p = payload;
    const d = p.description;
    const pick = (words, fallback) => words.find((w) => d.includes(w)) ?? fallback;
    return {
        anatomy: {
            script: pick(['三翻四抖', '包袱', '幽默'], '常规叙事结构'),
            directing: pick(['戏仿', '反差', '荒诞'], '常规对位'),
            art: pick(['霓虹', '鲜艳', '暗调', '黑白'], '中性色板'),
            camera: pick(['仰拍', '低角度', '慢动作', '推镜'], '静态为主'),
            performance: pick(['夸张', '定格', '表情'], '常规动效'),
            sourcing: '按内容类型决策',
            sound: pick(['急停', '音效', '怀旧'], '常规三层声音'),
            editing: pick(['卡点', '硬切', '快节奏'], '常规节奏'),
        },
        suggestedBase: d.includes('暗') || d.includes('黑') ? 'noir-contrast' : 'keynote-minimal',
    };
}
const CONCRETE_PERSON = /(先生|老师|校长|医生|老人|孩子|母亲|父亲|工程师|运动员|作家|画家|歌手|演员|记者|工人|农民)/;
const CONCRETE_PLACE = /(街|路|桥|河|湖|山|城|镇|村|楼|塔|寺|园|站|港|遗址|故居|博物馆|学校|医院|老宅)/;
const CONCRETE_OBJECT = /(书|信|钟|笔|机器|相机|茶|碗|伞|车|船|琴|照片|手稿|标本|旗帜|印章)/;
const MOTION_CUE = /(走过|穿过|奔跑|流动|生长|翻页|转动|下雪|下雨|日落|清晨|夜晚|排队|挥手)/;
/**
 * 离线素材需求单（template 引擎）：宁可少要，也不要乱要。
 * 没有明确的现实指称物一律 none——默认走代码绘制，符合「用户没说找素材就全画」的纪律。
 */
function templateMaterialPlan(payload) {
    const p = payload;
    const briefs = (p.segments ?? []).map((s) => {
        const t = s.narration ?? '';
        let need = 'none';
        if (CONCRETE_PERSON.test(t))
            need = 'person';
        else if (CONCRETE_PLACE.test(t))
            need = 'place';
        else if (CONCRETE_OBJECT.test(t))
            need = 'object';
        const emphasis = s.emphasis ?? [];
        const mustHave = need === 'none' ? [] : [...new Set([...emphasis.filter((w) => w.length >= 2), ...t.match(/[\u4e00-\u9fa5]{2,6}/g)?.slice(0, 2) ?? []])].slice(0, 4);
        const query = need === 'none'
            ? ''
            : [...new Set([...emphasis, ...mustHave])].slice(0, 3).join(' ') || t.slice(0, 12);
        return {
            shotId: s.shotId,
            segmentId: s.segmentId,
            narration: t,
            need,
            query,
            type: need !== 'none' && MOTION_CUE.test(t) ? 'video' : 'image',
            mustHave,
            avoid: ['logo', 'watermark', 'text'],
            reason: need === 'none'
                ? '抽象/论述段，代码绘制更准'
                : `旁白指认了具体${need === 'person' ? '人物' : need === 'place' ? '地点' : '实物'}，需要真实影像`,
        };
    });
    return { briefs };
}
