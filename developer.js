/**
 * DeepSeek 2027 Plan — developer-mode toolset.
 *
 * Mounted inside the `developer` agent preset, so these tools exist only for
 * Sessions that selected that preset. Three capabilities, each with one tool:
 *
 *  - `dev_admin`   — run any command line at High integrity.
 *  - `dev_desktop` — the whole mouse/keyboard/screen/window vocabulary.
 *  - `dev_ssh`     — one persistent SSH conversation.
 *
 * The tool definitions are plain objects rather than `defineTool(...)` results so
 * this bundle needs no dependency on `@deepseek-ai/dsh-tools`: the registry only
 * requires `{ name, description, parameters, output }`, and the JSON Schemas here
 * are written directly in the raw subset the registry enforces. That keeps the
 * bundle installable as plain files, with no package installation step that could
 * fail on a profile with a broken registry mirror.
 *
 * The prompt manual is registered as a *section*, not appended to an assembled
 * prompt: a section composes with other presets' sections, appears in the prompt
 * view, and is disposed with the preset revision.
 *
 * @module @local/dsh-deepseek-2027/developer
 */
import { runDirect, runElevated } from './admin.js'
import {
  AGENTS_DIR,
  deleteDefinition,
  listDefinitions,
  normalizeDefinition,
  pathOf,
  readDefinition,
  renderRoster,
  saveDefinition,
} from './agents.js'
import {
  CUSTOM_DIR,
  deleteSpec,
  expandTemplate,
  normalizeSpec,
  pathsOf,
  readAllSpecs,
  readNote,
  renderToolIndex,
  writeSpec,
} from './custom-tools.js'
import { DEFAULT_MAX_DELEGATES, TeamRegistry, analystPrompt, classifyBrief, frameReport } from './delegation.js'
import { capture, desktopRequest, ensureDesktop, stopDesktop } from './desktop.js'
import { ClaimLedger, consensusVariants, renderConsensus, summarizeConsensus } from './enhance.js'
import { encodePng, paintChart } from './chart.js'
import { loadImageFile, renderSvg } from './images.js'
import { MAX_LEVEL, MIN_LEVEL, describeLevel } from './levels.js'
import {
  PERSONA_PATH,
  PERSONA_TOKEN_LIMIT,
  estimateTokens,
  loadPersona,
  personaSize,
  savePersona,
} from './persona.js'
import {
  closeAll,
  closeSession,
  execOnSession,
  listSessions,
  openSession,
  readSession,
  requireSession,
} from './ssh.js'

export const name = 'deepseek-2027-developer'

/** The registries this toolset contributes to. */
export const inject = ['tools', 'systemPrompt']

/** Prompt section carrying the operating manual. */
const MANUAL_SECTION = 'deepseek2027:developer'

/**
 * The operating manual.
 *
 * This is the planning-time surface: the tool descriptions are read while
 * choosing a call, this manual is read while deciding what to do next. It states
 * the rules that a wrong call would otherwise have to teach — screenshot before
 * clicking, keep one SSH conversation, prefer the clipboard for long text.
 */
const MANUAL = `## 开发者模式 —— 你在这台电脑上的完整权限

你在**开发者模式预设**下运行。这台 Windows 工作站属于你：你可以用管理员权限执行命令、真实操控鼠标键盘与屏幕、并连上任意 SSH 服务器。下面是你拥有的三个工具和它们的纪律。

### 1. dev_admin —— 管理员身份命令执行

\`dev_admin\` 以 **High 完整性级别**（真正的管理员令牌，不是被 UAC 过滤的普通令牌）运行任意命令行。

- \`argv: ["cmd.exe","/c","..."]\` 或 \`argv: ["powershell.exe","-Command","..."]\`。不要把整条命令当成一个字符串塞进 argv[0]。
- 每次调用返回 \`exitCode\`、\`stdout\`、\`stderr\` 与耗时。\`stderr\` 非空而退出码为 0 是正常情况，不要当成失败。
- \`elevated: false\` 表示这次走当前用户令牌。默认 elevated 为 true；只有明确需要非管理员环境时才传 false。
- 需要改系统设置、写 Program Files、改服务、读其他用户目录、配防火墙、装 MSI —— 这正是它的用途。
- 普通读写文件不要用它：\`read\` / \`write\` / \`edit\` 更快也更省上下文。
- 可能挂住的命令务必传 \`timeoutMs\`，默认 120 秒，上限 600 秒。

### 2. dev_desktop —— 全桌面操控

19 个动作覆盖鼠标、键盘、屏幕、窗口与剪贴板。**铁律：先截图，再动手。**

- 看不见屏幕就不要点。每次截图返回 \`origin\`、\`imagePixelsPerScreenPixel\` 与网格标签；换算公式：\`屏幕坐标 = origin + 图像像素 / 缩放比\`。网格标签就是真实屏幕坐标，直接读，不要猜。
- 改变屏幕的动作（click / hold / drag / scroll / type / key / focus）会自动附带一张新截图。**看它**。屏幕没按预期变化时不要重复同一个动作——看图、找原因、再决定下一步。
- 目标太小或看不清时用 \`zoom\`（以 x,y 为中心放大），或 \`screenshot\` 配 \`region\` 与 \`scale: 2-4\`。宁可多截一次图，也不要盲点。
- 动作表：status、screenshot、zoom、move、click、hold、mouseDown、mouseUp、drag、scroll、type、key、keyDown、keyUp、windows、focus、at、clipboardGet、clipboardSet。
- \`type\` 支持中文与 emoji（Unicode 扫描码）；\`key\` 的 \`modifiers\` 放 CTRL/ALT/SHIFT/WIN，例如 \`key:"C", modifiers:["CTRL"]\`。
- 桌面操控走的是**当前用户令牌**，不是管理员令牌——Windows 的 UIPI 会拦截高完整性进程向普通程序注入输入。需要管理员权限的窗口（以管理员身份运行的任务管理器、服务面板）无法被这样点击，改用 \`dev_admin\`。
- 剪贴板是最省事的通道：把长文本 \`clipboardSet\` 进去，再 \`key:"V", modifiers:["CTRL"]\` 粘贴，比逐字符 \`type\` 快得多，也不受输入法影响。

### 3. dev_ssh —— 一次开启，之后一直用

\`action:"open"\` **只做一次**。之后每次 \`action:"exec"\` 都在同一个 shell 里执行：同一会话、同一目录、同一环境变量、同一个已激活的 venv。这就是"对话"与"一堆一次性连接"的区别。

- 后续调用不要带 host/username/password —— 只带 \`action:"exec"\` 和 \`command\`。需要指定连接时用 \`session\` 传 id。
- \`cd\`、\`export\`、\`source venv/bin/activate\`、\`conda activate\` 都会保留。用 \`action:"list"\` 看当前有哪几个会话。
- 返回值里 \`exitCode\` 是该命令的真实退出码；\`timedOut: true\` 表示命令还在远端跑，输出是截止到超时那一刻的片段。这时用 \`action:"read"\` 继续读，不要重发同一条命令（可能已经产生了副作用）。
- 凭据会进入会话日志。优先用 \`identityFile\`；必须用密码时，提醒用户这条会话的日志里会有明文。
- 长时间任务超时后命令没有被杀死：用 \`read\` 轮询，或直接 \`nohup ... &\` 放到后台。

### 4. 思考等级（L1–L10）

输入框左侧的「DeepSeek 2027 · 思考」控件，或 \`/think 1..10\`。等级越高，系统提示词里的推理纪律越严：L7 穷举边界条件，L8 自我反驳一轮，L9 三轮评审收敛，L10 走 Frame → Hypothesise → Derive → Falsify → Converge → Audit 六阶段，并对每句话标注 *verified / derived / assumed*。

- 等级同时抬高该模型路由允许的推理强度（不会超出路由声明的档位）。
- 难题不要停在 L4。修 bug、定架构、写并发代码时至少 L7。
- 简单命令不要开到 L10 —— 纪律本身消耗 token 与时间。

### 5. 通用纪律

- 破坏性动作（删除、覆盖、kill、改注册表、改防火墙）先确认目标路径与对象，再执行；用户没有要求时不要顺手做。
- \`dev_admin\` 与 \`dev_desktop\` 的每一次调用都会改变这台真实电脑。把每一步的目标说清楚；失败时读错误再调整，不要盲目重试。
- 需要长期跑的服务用后台方式启动（\`Start-Process\`、\`nohup ... &\`、\`systemd-run\`），不要让一个调用阻塞几分钟。

### 6. dev_claim —— 让错误可被发现（L6 起可用）

这是唯一能让你的答案质量真正上一个台阶的机制，因为它不依赖你"更仔细"，而是把没验证的地方**变成能被看见的洞**。

- 每当你得到一个承重结论（若为假则整个答案垮掉），用 \`add\` 登记它，并**诚实地**选择 channel：
  - \`observed\` —— 你亲手跑过或读到过
  - \`derived\` —— 它由已观察的东西推出
  - \`assumed\` —— 你当作给定
  - \`guessed\` —— 没有任何依据
- **承重结论必须带 \`evidence\` 或 \`check\`**，否则 \`add\` 直接报错拒绝。这不是限制，这是保护：一个没有依据的猜测不该承重。
- 能测的就给 \`check\`（一条 PowerShell 命令，退出码 0 = 成立）。然后用 \`verify\` 真跑一次 —— 输出说了算，不是你的看法说了算。
- 验证失败的结论**不会被删除**，会标成"已证伪"留在台账里。你必须改写受影响的结论，不能假装忘了。
- 交付前调一次 \`audit\`。它按严重程度排序：已证伪 > 承重未验证 > 承重只是假设。台账不干净就不要交付硬答案。

**这条最容易犯的错**：把所有结论标成 \`derived\` 而不去验证。\`derived\` 的意思是"由已观察的东西推出"，不是"我觉得对"。

### 7. dev_consensus —— 多路独立采样（L6 起可用）

单条推导错了就是错了，而且它自己不会发出任何信号。多条独立推导会：一致则安心，分歧则定位到真正的不确定性。

- 它会用三种**立场不同**的路径问同一个问题：正向推导、从假设答案反向验证、以及一个唱反调的路（先给出最诱人的错答案）。
- 你拿到每一路的答案和一个收敛度分数（0 = 完全分歧，1 = 完全一致）。
- **收敛度 ≥ 0.55**：结论较可能成立，但你仍要核对关键那一步。
- **收敛度低**：分歧处就是这题真正难的地方。**不要揉成一个中间答案** —— 找出哪一路的前提不同，自己判定。
- 这是证词，不是投票。多数派也可能是同一个错误被重复了三次。

什么时候用：一个数字/复杂度/根因判断你不太确定时，或两个方案你无法用推理分出高下时。什么时候不用：简单事实查询、能一条命令验证的东西（那用 \`dev_claim\` 的 check 更直接）。
`

/** A reusable text-only output projection. */
const TEXT_OUTPUT = { description: 'Text result.' }

/**
 * Wrap a value into a single text block.
 * @param {string} text - the text to project.
 * @returns {object[]} one content block.
 */
function textBlock(text) {
  return [{ type: 'text', text }]
}

/**
 * Build a tool definition the registry accepts without `defineTool`.
 * @param {object} options - definition parts.
 * @returns {object} a registry-ready tool definition.
 */
function tool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: options.outputSchema ?? TEXT_OUTPUT,
      render: options.render,
    },
    execute: options.execute,
    ...options.presentCall === undefined ? {} : { presentCall: options.presentCall },
    isConcurrencySafe: () => false,
  }
}

/** `dev_admin` parameter schema. */
const ADMIN_PARAMETERS = {
  type: 'object',
  properties: {
    argv: {
      type: 'array',
      items: { type: 'string' },
      description: 'The command as an argument vector: executable first, then each argument. Example: ["powershell.exe","-NoProfile","-Command","Get-Service"]',
    },
    elevated: {
      type: 'boolean',
      description: 'Run with an administrator (High integrity) token; defaults to true. Set false for tools that refuse to run as administrator or need the unelevated environment.',
    },
    cwd: { type: 'string', description: 'Working directory; defaults to the Windows directory.' },
    stdin: { type: 'string', description: 'Text written to the child\'s standard input, then closed.' },
    timeoutMs: { type: 'integer', description: 'Deadline in milliseconds; default 120000, capped at 600000.' },
    env: {
      type: 'object',
      additionalProperties: true,
      description: 'Extra environment entries merged over the inherited environment. Values must be strings.',
    },
  },
  required: ['argv'],
}

/** `dev_desktop` parameter schema. */
const DESKTOP_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'screenshot', 'zoom', 'move', 'click', 'hold', 'mouseDown', 'mouseUp', 'drag', 'scroll', 'type', 'key', 'keyDown', 'keyUp', 'windows', 'focus', 'at', 'clipboardGet', 'clipboardSet'],
      description:
        'status: bounds, monitors and cursor. screenshot: annotated PNG. zoom: magnified area around x,y. '
        + 'move: glide the cursor. click / hold: press at x,y. mouseDown / mouseUp: manual button control. '
        + 'drag: press at x,y and release at toX,toY. scroll: wheel at x,y. type: send text. '
        + 'key: press one key with modifiers. keyDown / keyUp: hold a key manually. windows: list top-level windows. '
        + 'focus: raise a window. at: describe the window under x,y. clipboardGet / clipboardSet: read or replace clipboard text.',
    },
    x: { type: 'number', description: 'Target X in virtual-desktop pixels; -1 means the current position.' },
    y: { type: 'number', description: 'Target Y in virtual-desktop pixels; -1 means the current position.' },
    toX: { type: 'number', description: 'Drag end X.' },
    toY: { type: 'number', description: 'Drag end Y.' },
    button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button; defaults to left.' },
    count: { type: 'number', description: 'Clicks: 1 single, 2 double; defaults to 1.' },
    holdMs: { type: 'number', description: 'How long hold keeps the button down; defaults to 800.' },
    durationMs: { type: 'number', description: 'Glide or drag duration; 0 teleports.' },
    steps: { type: 'number', description: 'Intermediate drag steps; 0 uses durationMs.' },
    vertical: { type: 'number', description: 'Wheel notches; positive scrolls up.' },
    horizontal: { type: 'number', description: 'Horizontal wheel notches; positive scrolls left.' },
    text: { type: 'string', description: 'Text for type or clipboardSet; Unicode, CJK and emoji are supported.' },
    perCharacterDelayMs: { type: 'number', description: 'Slow typing for laggy applications.' },
    key: { type: 'string', description: 'Key name: ENTER, TAB, ESC, F5, LEFT, A, PRINTSCREEN, …' },
    modifiers: { type: 'array', items: { type: 'string' }, description: 'Held keys: CTRL, ALT, SHIFT, WIN.' },
    region: {
      type: 'object',
      additionalProperties: false,
      description: 'Capture region in screen coordinates; defaults to the whole virtual desktop.',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
      },
      required: ['x', 'y', 'width', 'height'],
    },
    size: { type: 'number', description: 'For zoom, the source area side length; defaults to 240.' },
    gridSize: { type: 'number', description: 'Coordinate-grid spacing in the screenshot; defaults to 100.' },
    scale: { type: 'number', description: 'Screenshot magnification: 1 native, 2 doubled, 0.5 halved. Convert back with screen = origin + imagePixel / scale.' },
    mark: {
      type: 'object',
      additionalProperties: false,
      description: 'Point to crosshair on a screenshot, in screen coordinates.',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['x', 'y'],
    },
    observe: { type: 'boolean', description: 'Attach a fresh screenshot to a screen-changing action; defaults to true.' },
    query: { type: 'string', description: 'Window-title substring for focus.' },
    handle: { type: 'string', description: 'Window handle for focus, as reported by windows or at.' },
  },
  required: ['action'],
}

/** `dev_ssh` parameter schema. */
const SSH_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['open', 'exec', 'read', 'list', 'close'],
      description:
        'open: establish the conversation (host and username required). exec: run a command in it. '
        + 'read: return output buffered since the last call. list: show open conversations. close: end one.',
    },
    host: { type: 'string', description: 'Hostname or address; open only.' },
    port: { type: 'integer', description: 'SSH port; defaults to 22.' },
    username: { type: 'string', description: 'Account name; open only.' },
    password: { type: 'string', description: 'Password, typed into the client prompt; open only. It is recorded in this Session log — prefer identityFile.' },
    identityFile: { type: 'string', description: 'Path to a private key on this machine; open only. Preferred over a password.' },
    jump: { type: 'string', description: 'ProxyJump hop as user@host; open only.' },
    acceptNewHostKey: { type: 'boolean', description: 'Add an unknown host key instead of refusing it; defaults to true.' },
    command: { type: 'string', description: 'Shell text for exec. State such as cd or export persists across calls; end with & to background it on the server.' },
    session: { type: 'string', description: 'Conversation id; omit when exactly one is open.' },
    timeoutMs: { type: 'integer', description: 'Per-call deadline in milliseconds; defaults to 60000 for exec and 30000 for open.' },
  },
  required: ['action'],
}

/** Actions that change what is on screen, so a screenshot is attached. */
const OBSERVE_AFTER = new Set(['click', 'hold', 'mouseUp', 'drag', 'scroll', 'type', 'key', 'focus', 'clipboardSet', 'move'])

/**
 * Execute one desktop action and shape its result.
 * @param {object} args - tool arguments.
 * @param {object} services - resolved Harness services.
 * @returns {Promise<object>} the action result with a summary.
 */
async function performDesktop(args, services) {
  const action = String(args.action)
  switch (action) {
    case 'status': {
      const info = await desktopRequest({ action: 'info' })
      const screen = info.screen ?? { x: 0, y: 0, width: 0, height: 0 }
      const cursor = info.cursor ?? { x: -1, y: -1 }
      return {
        action,
        bounds: screen,
        monitors: info.monitors,
        cursorX: cursor.x,
        cursorY: cursor.y,
        foreground: info.foreground,
        summary: `Virtual desktop ${screen.width}x${screen.height} at (${screen.x}, ${screen.y}); cursor at (${cursor.x}, ${cursor.y}).`,
      }
    }
    case 'screenshot':
      return await capture(args, services)
    case 'zoom': {
      const size = typeof args.size === 'number' && args.size > 0 ? args.size : 240
      const scale = typeof args.scale === 'number' && args.scale > 1 ? args.scale : 3
      const cx = typeof args.x === 'number' ? args.x : 0
      const cy = typeof args.y === 'number' ? args.y : 0
      return await capture({
        ...args,
        region: { x: Math.round(cx - size / 2), y: Math.round(cy - size / 2), width: size, height: size },
        mark: { x: cx, y: cy },
        scale,
      }, services)
    }
    case 'move': {
      const r = await desktopRequest({ action: 'move', x: args.x ?? -1, y: args.y ?? -1, durationMs: args.durationMs ?? 0 })
      return { action, cursorX: r.cursor?.x, cursorY: r.cursor?.y, summary: `Cursor moved to (${r.cursor?.x}, ${r.cursor?.y}).` }
    }
    case 'click': {
      const r = await desktopRequest({
        action: 'click',
        x: args.x ?? -1,
        y: args.y ?? -1,
        button: args.button ?? 'left',
        count: args.count ?? 1,
      })
      return {
        action,
        cursorX: r.cursor?.x,
        cursorY: r.cursor?.y,
        summary: `${r.count === 2 ? 'Double-clicked' : 'Clicked'} ${r.button} at (${r.cursor?.x}, ${r.cursor?.y}).`,
      }
    }
    case 'hold': {
      const r = await desktopRequest({ action: 'hold', x: args.x ?? -1, y: args.y ?? -1, button: args.button ?? 'left', holdMs: args.holdMs ?? 800 })
      return { action, cursorX: r.cursor?.x, cursorY: r.cursor?.y, summary: `Held ${r.button} at (${r.cursor?.x}, ${r.cursor?.y}) for ${r.holdMs} ms.` }
    }
    case 'mouseDown':
    case 'mouseUp': {
      const r = await desktopRequest({ action, x: args.x ?? -1, y: args.y ?? -1, button: args.button ?? 'left' })
      return {
        action,
        button: r.button,
        down: r.down,
        cursorX: r.cursor?.x,
        cursorY: r.cursor?.y,
        summary: `${action === 'mouseDown' ? 'Pressed' : 'Released'} ${r.button} at (${r.cursor?.x}, ${r.cursor?.y}).`,
      }
    }
    case 'drag': {
      const r = await desktopRequest({
        action: 'drag',
        x: args.x ?? -1,
        y: args.y ?? -1,
        toX: args.toX ?? -1,
        toY: args.toY ?? -1,
        button: args.button ?? 'left',
        steps: args.steps ?? 0,
        durationMs: args.durationMs ?? 300,
      })
      return {
        action,
        from: r.from,
        to: r.to,
        summary: `Dragged ${r.button} from (${r.from?.x}, ${r.from?.y}) to (${r.to?.x}, ${r.to?.y}).`,
      }
    }
    case 'scroll': {
      const vertical = args.vertical ?? 0
      const horizontal = args.horizontal ?? 0
      if (vertical === 0 && horizontal === 0) throw new Error('scroll needs a non-zero vertical or horizontal amount')
      await desktopRequest({ action: 'scroll', x: args.x ?? -1, y: args.y ?? -1, vertical, horizontal })
      return { action, vertical, horizontal, summary: `Scrolled ${vertical} vertical and ${horizontal} horizontal notches.` }
    }
    case 'type': {
      const text = String(args.text ?? '')
      if (text === '') throw new Error('type needs text')
      const r = await desktopRequest({
        action: 'type',
        textB64: Buffer.from(text, 'utf8').toString('base64'),
        perCharacterDelayMs: args.perCharacterDelayMs ?? 0,
      })
      return { action, length: r.length, summary: `Typed ${r.length} characters.` }
    }
    case 'key': {
      const modifiers = Array.isArray(args.modifiers) ? args.modifiers.join(',') : ''
      const r = await desktopRequest({ action: 'key', key: String(args.key ?? ''), modifiers })
      return { action, key: r.key, modifiers, summary: `Pressed ${modifiers === '' ? '' : `${modifiers}+`}${r.key}.` }
    }
    case 'keyDown':
    case 'keyUp': {
      const r = await desktopRequest({ action, key: String(args.key ?? '') })
      return { action, key: r.key, summary: `${action === 'keyDown' ? 'Held' : 'Released'} ${r.key}.` }
    }
    case 'windows': {
      const r = await desktopRequest({ action: 'windows' })
      const list = Array.isArray(r.windows) ? r.windows : []
      return {
        action,
        foreground: r.foreground,
        count: list.length,
        windows: list.slice(0, 60),
        summary: `${list.length} visible windows${list.length > 60 ? ' (showing 60)' : ''}; foreground handle ${r.foreground}.`,
      }
    }
    case 'focus': {
      const r = await desktopRequest({ action: 'focus', query: String(args.query ?? ''), handle: String(args.handle ?? '') })
      return { action, handle: r.handle, summary: `Raised window ${r.handle}.` }
    }
    case 'at': {
      const r = await desktopRequest({ action: 'at', x: args.x ?? -1, y: args.y ?? -1 })
      return {
        action,
        handle: r.handle,
        title: r.title,
        className: r.className,
        summary: `(${args.x}, ${args.y}) is in "${r.title}" (${r.className}).`,
      }
    }
    case 'clipboardGet': {
      const r = await desktopRequest({ action: 'clipboardGet' })
      return { action, text: r.text ?? '', summary: `Clipboard holds ${(r.text ?? '').length} characters.` }
    }
    case 'clipboardSet': {
      const text = String(args.text ?? '')
      const r = await desktopRequest({ action: 'clipboardSet', textB64: Buffer.from(text, 'utf8').toString('base64') })
      return { action, length: r.length ?? 0, summary: `Clipboard replaced with ${r.length ?? 0} characters.` }
    }
    default:
      throw new Error(`unknown desktop action "${action}"`)
  }
}

/**
 * Register the developer-mode tools and their operating manual.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the preset-scoped context.
 * @param {object} [config] - row configuration.
 */
export function apply(ctx, config = {}) {
  const adminEnabled = config.adminEnabled !== false
  const desktopEnabled = config.desktopEnabled !== false
  const sshEnabled = config.sshEnabled !== false

  /**
   * Refreshes the two synchronous prompt caches from disk.
   *
   * Assigned once the prompt contexts are registered, because both the tools and
   * the contexts need it and the contexts own the cache objects. Until then a
   * call is a no-op.
   * @type {() => Promise<void>}
   */
  let refreshCaches = async () => {}

  /** Resolve the services a tool call needs, at call time. */
  const services = () => ({ attachments: ctx.get('attachments') })

  if (adminEnabled) {
    ctx.effect(() => ctx.tools.register(tool({
      name: 'dev_admin',
      description:
        'Run any command line on this machine with an administrator token, or with the current token when elevated is false. '
        + 'Returns the exit code plus stdout and stderr; a non-zero exit code is a fact to read, not an error to report. '
        + 'Use it for system changes (services, registry, Program Files, firewall, MSI installs, other users\' files), '
        + 'and use the filesystem tools for ordinary file work.',
      parameters: ADMIN_PARAMETERS,
      // The value carries timing, elevation facts and the argv echo beside the two
      // streams; a closed schema would reject every result.
      outputSchema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const blocks = [{
          type: 'text',
          text: [
            `exit=${value.exitCode ?? 'null'} elevated=${value.elevated} user=${value.user} ${value.elapsedMs}ms`,
            value.timedOut ? '(the command was killed at its deadline)' : '',
          ].filter(Boolean).join(' '),
        }]
        if (value.stdout !== '') blocks.push({ type: 'text', text: value.stdout })
        if (value.stderr !== '') blocks.push({ type: 'text', text: `[stderr]\n${value.stderr}` })
        if (value.stdout === '' && value.stderr === '') blocks.push({ type: 'text', text: '(no output)' })
        return blocks
      },
      async execute(args, exec) {
        const request = {
          argv: Array.isArray(args.argv) ? args.argv : [],
          elevated: args.elevated !== false,
          ...args.cwd === undefined ? {} : { cwd: String(args.cwd) },
          ...args.stdin === undefined ? {} : { stdin: String(args.stdin) },
          ...args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) },
          ...args.env === undefined ? {} : { env: args.env },
          signal: exec.signal,
        }
        return request.elevated ? await runElevated(request) : await runDirect(request)
      },
      presentCall: (args) => ({
        card: 'terminal',
        title: 'dev_admin',
        description: (Array.isArray(args.argv) ? args.argv.join(' ') : '').slice(0, 200),
        cwd: args.cwd,
      }),
    })), 'deepseek-2027: dev_admin')
  }

  if (desktopEnabled) {
    ctx.effect(() => ctx.tools.register(tool({
      name: 'dev_desktop',
      description:
        'Control this computer\'s real desktop and see the result. Screenshot before acting on a screen you have not just seen; '
        + 'screen-changing actions return a fresh screenshot, so read it instead of repeating a click that did not land. '
        + 'Coordinates are absolute virtual-desktop pixels; convert image pixels with screen = origin + imagePixel / scale. '
        + 'Prefer a tight region or zoom when a target is small, and use the clipboard with a Ctrl+V key press for long text. '
        + 'This runs on the current user token, so windows owned by an administrator process cannot be driven — use dev_admin there.',
      parameters: DESKTOP_PARAMETERS,
      // The value carries `image` (an attachment reference) as well as text, and a
      // renderer reads optional fields; the schema therefore stays open.
      outputSchema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const blocks = [textBlock(String(value.summary ?? ''))[0]]
        if (value.image !== undefined && value.image !== null) {
          blocks.push({ type: 'image', attachment: value.image })
        } else if (typeof value.imagePath === 'string') {
          blocks.push({ type: 'text', text: `Screenshot saved to ${value.imagePath}; the burned-in axis labels are real screen coordinates.` })
        }
        return blocks
      },
      async execute(args) {
        const result = await performDesktop(args, services())
        const wantObserve = args.observe !== false && OBSERVE_AFTER.has(String(args.action))
        if (wantObserve) {
          try {
            const shot = await capture({ ...args, region: undefined, mark: undefined, scale: args.scale ?? 0.6 }, services())
            result.image = shot.image
            result.imagePath = shot.imagePath
            result.observation = shot.summary
            result.summary = `${result.summary} ${shot.summary}`
          } catch (error) {
            result.summary = `${result.summary} (screenshot unavailable: ${error?.message ?? error})`
          }
        }
        return result
      },
      presentCall: (args) => ({ card: 'generic', title: `dev_desktop · ${args.action}`, kind: 'execute', rawInput: args }),
    })), 'deepseek-2027: dev_desktop')

    // Pay the interop compile now instead of inside the first action.
    void ensureDesktop().catch(() => {})
    ctx.effect(() => () => stopDesktop(), 'deepseek-2027: desktop worker')
  }

  if (sshEnabled) {
    ctx.effect(() => ctx.tools.register(tool({
      name: 'dev_ssh',
      description:
        'Keep one SSH conversation open and run every later command inside it: cd, exports, an activated virtualenv and job control all persist. '
        + 'Call action "open" once, then only action "exec" with a command. '
        + 'A call returns when its command finishes or its deadline expires; on a timeout the remote command keeps running, so poll with "read" instead of re-sending it. '
        + 'Credentials named in an open call are recorded in this Session log.',
      parameters: SSH_PARAMETERS,
      // Rows differ by action (a conversation list, an open receipt, a command
      // result), so the value schema stays open and the renderer discriminates.
      outputSchema: { type: 'object', additionalProperties: true },
      render: (args, value) => {
        if (args.action === 'list') {
          const rows = Array.isArray(value.sessions) ? value.sessions : []
          return textBlock(rows.length === 0
            ? 'No SSH conversation is open.'
            : rows.map((row) => `${row.id}  ${row.label}${row.closed ? ' (closed)' : ''}  buffered ${row.bufferedChars}`).join('\n'))
        }
        if (args.action === 'open' || args.action === 'close') {
          return textBlock(String(value.summary ?? ''))
        }
        const header = value.exitCode === null
          ? (value.timedOut ? '[still running at the deadline — poll with action "read"]' : '[exit status unknown]')
          : `[exit ${value.exitCode}]`
        const blocks = [textBlock(header)[0]]
        blocks.push({ type: 'text', text: value.output === '' ? '(no output)' : String(value.output) })
        if (value.truncated) blocks.push({ type: 'text', text: `(${value.chars} characters, trimmed in the middle)` })
        return blocks
      },
      async execute(args, exec) {
        const action = String(args.action)
        if (action === 'list') return { action, sessions: listSessions() }
        if (action === 'open') {
          const { session, banner } = await openSession({
            host: args.host,
            port: args.port,
            username: args.username,
            password: args.password,
            identityFile: args.identityFile,
            jump: args.jump,
            acceptNewHostKey: args.acceptNewHostKey,
            timeoutMs: args.timeoutMs,
          })
          return {
            action,
            session: session.id,
            label: session.label,
            banner,
            summary: `Opened SSH conversation ${session.id} as ${session.label}. Every later action "exec" runs in this same shell.`,
          }
        }
        if (action === 'close') {
          const session = requireSession(args.session)
          const label = session.label
          await closeSession(session)
          return { action, session: session.id, summary: `Closed SSH conversation ${session.id} (${label}).` }
        }
        const session = requireSession(args.session)
        if (action === 'read') {
          const result = readSession(session)
          return {
            action,
            session: session.id,
            output: result.text,
            chars: result.chars,
            truncated: result.truncated,
            exitCode: null,
            timedOut: false,
          }
        }
        if (action === 'exec') {
          const command = String(args.command ?? '')
          if (command.trim() === '') throw new Error('action "exec" needs a command')
          const result = await execOnSession(session, command, {
            timeoutMs: args.timeoutMs,
            signal: exec.signal,
          })
          return { action, session: session.id, ...result }
        }
        throw new Error(`unknown dev_ssh action "${action}"`)
      },
      presentCall: (args) => ({
        card: 'terminal',
        title: `dev_ssh · ${args.action}`,
        description: args.action === 'exec'
          ? String(args.command ?? '').slice(0, 200)
          : args.action === 'open' ? `${args.username ?? ''}@${args.host ?? ''}` : undefined,
      }),
    })), 'deepseek-2027: dev_ssh')
    ctx.effect(() => () => void closeAll(), 'deepseek-2027: ssh sessions')
  }

  // ---- AI-authored tools -------------------------------------------------
  //
  // The mounted set is kept in one map so a redefinition can dispose the old
  // definition before registering the new one: two definitions with the same
  // name in one layer is exactly what the registry rejects.
  if (config.customTools !== false) {
    /** @type {Map<string, () => void>} */
    const mounted = new Map()

    /**
     * Build a registry definition for one authored spec.
     *
     * The body is the model's command template, expanded per call and executed
     * through the same administrator path `dev_admin` uses. That equivalence is
     * deliberate: a self-authored tool must not reach further than the tools
     * already offered, so authoring a tool stays a way to *convenience* existing
     * capability, never to gain new privilege.
     *
     * @param {object} spec - a normalized spec.
     * @returns {object} the definition.
     */
    const definitionOf = (spec) => tool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      outputSchema: TEXT_OUTPUT,
      render: (_args, value) => textBlock(String(value?.stdout ?? '')),
      execute: async (args) => {
        const { command, missing } = expandTemplate(spec.command, args ?? {})
        if (missing.length > 0) {
          throw new Error(`调用缺少必填参数：${missing.join('、')}`)
        }
        const request = {
          argv: ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
          cwd: spec.cwd === '' ? undefined : spec.cwd,
          timeoutMs: spec.timeoutMs,
        }
        const result = spec.elevated === false
          ? await runDirect(request)
          : await runElevated(request)
        return {
          tool: spec.name,
          command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut === true,
          truncated: result.truncated === true,
        }
      },
      presentCall: (args) => ({
        card: 'terminal',
        title: spec.name,
        description: String(spec.description).slice(0, 160),
        cwd: spec.cwd === '' ? undefined : spec.cwd,
      }),
    })

    /**
     * Mount one spec, replacing any previous definition of the same name.
     * @param {object} spec - a normalized spec.
     * @returns {void}
     */
    const mount = (spec) => {
      const previous = mounted.get(spec.name)
      if (previous !== undefined) previous()
      mounted.set(spec.name, ctx.tools.register(definitionOf(spec)))
    }

    /**
     * Mount every spec on disk.
     * @returns {Promise<{ mounted: string[], broken: object[] }>} what happened.
     */
    const mountAll = async () => {
      const { specs, broken } = await readAllSpecs()
      const names = []
      for (const raw of specs) {
        try {
          const spec = normalizeSpec(raw)
          mount(spec)
          names.push(spec.name)
        } catch (error) {
          // A spec that fails validation stays on disk for the model to fix; it
          // is reported through the tool index rather than mounted half-valid.
          broken.push({ file: raw.file ?? String(raw.name ?? '?'), reason: error?.message ?? 'normalize failed' })
        }
      }
      return { mounted: names, broken }
    }

    // Mount what already exists, so a restart restores the authored toolbox.
    ctx.effect(() => {
      let alive = true
      mountAll().catch((error) => ctx.logger?.warn?.('deepseek-2027: cannot mount authored tools: %o', error))
      return () => {
        alive = false
        for (const dispose of mounted.values()) {
          try {
            dispose()
          } catch {
            // Disposal is best-effort: a definition already replaced by a later
            // register call has nothing left to remove.
          }
        }
        mounted.clear()
        void alive
      }
    }, 'deepseek-2027: authored tools')

    ctx.effect(() => ctx.tools.register(tool({
      name: 'dev_tool',
      description:
        'Create, update, list or remove a tool of your own design. '
        + 'A tool is declared as data — name, description, JSON Schema parameters, and a PowerShell command template '
        + 'whose {{placeholders}} are filled from the call arguments — then mounted live and callable in the next step. '
        + 'Each tool also gets a Markdown note recording how to use it. '
        + 'This is the supported way to add capability: do not edit this bundle\'s source.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'update', 'list', 'read', 'remove', 'reload'],
            description:
              'create: define or re-define a tool (mounts immediately). update: same as create. '
              + 'list: show the authored toolbox. read: show one tool\'s spec and note. '
              + 'remove: delete a tool and unmount it. reload: re-read every spec from disk and remount.',
          },
          name: {
            type: 'string',
            description: 'Tool name for create/update/read/remove: lowercase, digits and underscores, 2-47 chars.',
          },
          description: {
            type: 'string',
            description: 'create/update: what the tool does and when to call it. This is what the model reads when choosing a call.',
          },
          parameters: {
            // The registry's schema subset has no `json` type: a free-form object is
            // expressed as `type: 'object'` with its own properties left open, which
            // is exactly what a nested JSON Schema is.
            type: 'object',
            description: 'create/update: the JSON Schema for the arguments, e.g. {"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}.',
          },
          command: {
            type: 'string',
            description:
              'create/update: PowerShell command template. Use {{argName}} for each argument; every placeholder is quoted '
              + 'as a PowerShell string literal, so pass raw values.',
          },
          cwd: { type: 'string', description: 'create/update: working directory; defaults to the Windows directory.' },
          elevated: { type: 'boolean', description: 'create/update: run at High integrity; defaults to true.' },
          timeoutMs: { type: 'integer', description: 'create/update: per-call timeout in milliseconds; defaults to 120000.' },
          note: {
            type: 'string',
            description: 'create/update: the Markdown note. Leave it out to have one generated from the description.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          tools: { type: 'array', items: { type: 'string' } },
          name: { type: 'string' },
          notePath: { type: 'string' },
          specPath: { type: 'string' },
          note: { type: 'string' },
          spec: { type: 'object' },
          summary: { type: 'string' },
        },
        required: ['action', 'summary'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(String(value?.summary ?? '')),
      execute: async (args) => {
        const action = String(args.action)
        const name = String(args.name ?? '').trim().toLowerCase()

        if (action === 'list' || action === 'reload') {
          if (action === 'reload') {
            const result = await mountAll()
            await refreshCaches()
            const index = await renderToolIndex()
            return {
              action,
              tools: result.mounted,
              summary: `已重新挂载 ${result.mounted.length} 个自定义工具。`
                + (result.broken.length === 0 ? '' : ` 有 ${result.broken.length} 个定义损坏。`)
                + (index.text === '' ? '' : `\n\n当前工具集：\n${index.text}`),
            }
          }
          const index = await renderToolIndex()
          return {
            action,
            tools: [...mounted.keys()],
            summary: mounted.size === 0
              ? `还没有自定义工具。用 action:"create" 定义第一个；工具定义与说明存放在 ${CUSTOM_DIR}。`
              : `已挂载 ${mounted.size} 个自定义工具：\n${index.text}`,
          }
        }

        if (name === '') throw new Error(`action "${action}" 需要 name`)

        if (action === 'read') {
          const index = await renderToolIndex()
          const note = await readNote(name)
          const paths = pathsOf(name)
          return {
            action,
            name,
            notePath: paths.note,
            specPath: paths.spec,
            note,
            summary: note === ''
              ? `没有找到 "${name}"。当前工具集：\n${index.text || '(空)'}`
              : note,
          }
        }

        if (action === 'remove') {
          const dispose = mounted.get(name)
          if (dispose !== undefined) {
            dispose()
            mounted.delete(name)
          }
          const removed = await deleteSpec(name)
          await refreshCaches()
          return {
            action,
            name,
            summary: removed
              ? `已删除并卸载 "${name}"。`
              : `"${name}" 既不在挂载表也不在磁盘上。`,
          }
        }

        if (action === 'create' || action === 'update') {
          const spec = normalizeSpec({
            name,
            description: args.description,
            parameters: args.parameters,
            command: args.command,
            cwd: args.cwd,
            elevated: args.elevated,
            timeoutMs: args.timeoutMs,
            note: args.note,
          })
          const paths = await writeSpec(spec)
          await refreshCaches()
          mount(spec)
          return {
            action,
            name: spec.name,
            specPath: paths.spec,
            notePath: paths.note,
            spec,
            summary:
              `已创建并热加载工具 \`${spec.name}\`，下一步即可调用。\n`
              + `说明文件：${paths.note}\n`
              + `定义文件：${paths.spec}\n`
              + `调用方式：传入参数后，命令模板中的 {{占位符}} 会被替换成对应值。`,
          }
        }

        throw new Error(`unknown dev_tool action "${action}"`)
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `dev_tool · ${args.action}`,
        kind: 'other',
        rawInput: args,
      }),
    })), 'deepseek-2027: dev_tool')
  }

  // ---- Persona -----------------------------------------------------------
  //
  // Registered as a *required* runtime context rather than a section: contexts
  // are re-read on every assembly, so an edited persona reaches the model on the
  // next step. It also never enters the message log, which is the whole of the
  // "does not participate in compaction" requirement — compaction folds
  // messages, and there is no persona message to fold.
  if (config.persona !== false) {
    ctx.effect(() => ctx.tools.register(tool({
      name: 'dev_persona',
      description:
        'Read or rewrite the operator persona: the standing identity carried into every request. '
        + `The persona is capped at ${PERSONA_TOKEN_LIMIT} estimated tokens, is present in every step, and is never compacted away. `
        + 'Use it to record who this agent is for this machine — voice, working style, boundaries, standing preferences.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'write', 'append', 'reset'],
            description: 'read: return the current persona and its size. write: replace it. append: add a section. reset: restore the shipped default.',
          },
          text: { type: 'string', description: 'write/append: the persona text (Markdown).' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          tokens: { type: 'integer' },
          limit: { type: 'integer' },
          text: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['action', 'summary'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(String(value?.summary ?? '')),
      execute: async (args) => {
        const action = String(args.action)
        if (action === 'read') {
          const persona = await loadPersona()
          const size = await personaSize()
          return {
            action,
            tokens: size.tokens,
            limit: size.limit,
            text: persona,
            summary: `当前人格约 ${size.tokens} / ${size.limit} tokens。\n\n${persona}`,
          }
        }
        if (action === 'write') {
          const { tokens } = await savePersona(String(args.text ?? ''))
          await refreshCaches()
          return {
            action,
            tokens,
            limit: PERSONA_TOKEN_LIMIT,
            text: await loadPersona(),
            summary: `人格已更新，约 ${tokens} / ${PERSONA_TOKEN_LIMIT} tokens。下一轮请求生效。`,
          }
        }
        if (action === 'append') {
          const addition = String(args.text ?? '').trim()
          if (addition === '') throw new Error('append 需要 text')
          const current = await loadPersona()
          const combined = `${current.trimEnd()}\n\n${addition}\n`
          const tokens = estimateTokens(combined)
          if (tokens > PERSONA_TOKEN_LIMIT) {
            throw new Error(
              `追加后会达到约 ${tokens} tokens，超过上限 ${PERSONA_TOKEN_LIMIT}。`
              + ` 当前约 ${estimateTokens(current)} tokens，本次追加约 ${estimateTokens(addition)} tokens；请精简或改用手动 write。`,
            )
          }
          const saved = await savePersona(combined)
          await refreshCaches()
          return {
            action,
            tokens: saved.tokens,
            limit: PERSONA_TOKEN_LIMIT,
            text: combined,
            summary: `已追加到人格，现约 ${saved.tokens} / ${PERSONA_TOKEN_LIMIT} tokens。`,
          }
        }
        if (action === 'reset') {
          const { DEFAULT_PERSONA } = await import('./persona.js')
          const saved = await savePersona(DEFAULT_PERSONA)
          await refreshCaches()
          return {
            action,
            tokens: saved.tokens,
            limit: PERSONA_TOKEN_LIMIT,
            text: DEFAULT_PERSONA,
            summary: `人格已恢复为内置默认（约 ${saved.tokens} tokens）。`,
          }
        }
        throw new Error(`unknown dev_persona action "${action}"`)
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `dev_persona · ${args.action}`,
        kind: 'other',
        rawInput: args,
      }),
    })), 'deepseek-2027: dev_persona')

    // Prompt assembly is synchronous: a context's `text` provider must return a
    // string, not a promise. An async provider reaches the interpolator as a
    // Promise and fails with `text.indexOf is not a function`, which takes the
    // whole step down. So the file-backed text is read ahead of time into a
    // holder and the provider returns whatever the holder currently has; a
    // refresh keeps it current without ever making assembly wait.
    const personaCache = { text: '' }
    const indexCache = { text: '' }
    const rosterCache = { text: '' }

    /**
     * Re-read the persona into the cache.
     * @returns {Promise<void>} resolves once the cache reflects the file.
     */
    const refreshPersona = async () => {
      try {
        const persona = await loadPersona()
        const body = persona.trim()
        if (body === '') {
          personaCache.text = ''
          return
        }
        const size = await personaSize()
        personaCache.text = [
          body,
          '',
          '---',
          `以上是你的长期人格（约 ${size.tokens} / ${size.limit} tokens）。它每一轮都会随请求送到，且永远不会被压缩掉。`,
          `它可以由你自己改写：用 \`dev_persona\` 的 read / write / append / reset，或直接编辑 ${PERSONA_PATH}。`,
          '当你发现自己反复犯同一类错、或用户表达了长期偏好时，把结论写进人格，而不是每次都重新学一遍。',
          `上限 ${PERSONA_TOKEN_LIMIT} tokens；超出会被拒绝，所以写给未来的自己时要挑那些真正会改变行为的话。`,
        ].join('\n')
      } catch {
        // A persona that cannot be read simply contributes nothing this step.
        personaCache.text = ''
      }
    }

    /**
     * Re-read the authored-tool index into the cache.
     * @returns {Promise<void>} resolves once the cache reflects the directory.
     */
    const refreshToolIndex = async () => {
      try {
        const index = await renderToolIndex()
        if (index.text === '') {
          indexCache.text = ''
          return
        }
        indexCache.text = [
          `## 自定义工具（共 ${index.count} 个）`,
          '',
          '这些工具是你自己创建的，可像内置工具一样直接调用。要了解某个工具的用法，读出它对应的说明文件：',
          '',
          index.text,
          '',
          `管理入口：\`dev_tool\`（create/update/list/read/remove/reload）。定义与说明都在 ${CUSTOM_DIR}。`,
          '改动说明文件不会改变工具行为，改行为要用 `dev_tool` 的 create/update 重新定义；说明文件用于记录用法、坑与示例。',
        ].join('\n')
      } catch {
        indexCache.text = ''
      }
    }

    /**
     * Re-read the analyst roster into the cache.
     *
     * Only names and one-line summaries reach the prompt: the full role briefs are
     * read on demand through `dev_agent`, because a dozen complete definitions
     * would spend the context the team exists to save.
     * @returns {Promise<void>} resolves once the cache reflects the directory.
     */
    const refreshRoster = async () => {
      try {
        const roster = await renderRoster()
        rosterCache.text = roster === '' ? '' : [
          '## 分析员名单（L12 可派出）',
          '',
          roster,
          '',
          `用 \`dev_team\` 的 action:"spawn"（或 "wait"）指派他们；用 \`dev_agent\` 的 read 看某一位的完整职责，define 定义新的分析员。定义存放在 ${AGENTS_DIR}。`,
          '分析员在自己的上下文里跑，看不到你这段对话；用户也看不到他们的报告。所以凡是写进最终答复的结论，你必须自己复述并给出证据。',
        ].join('\n')
      } catch {
        rosterCache.text = ''
      }
    }

    // Fill both caches before the first assembly can ask for them, then keep them
    // warm: the persona file is small and the tool directory is a few entries, so
    // a periodic refresh costs less than a stale prompt would.
    void refreshPersona()
    void refreshToolIndex()
    void refreshRoster()
    ctx.effect(() => {
      const timer = setInterval(() => {
        void refreshPersona()
        void refreshToolIndex()
        void refreshRoster()
      }, 5000)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    }, 'deepseek-2027: prompt cache refresh')

    // The persona as a required runtime context: present every step, never a
    // message, so compaction cannot fold it away. The trailing instruction is
    // what makes the persona editable by the model itself rather than only by
    // the user: the agent is told the file's address and the tool that writes it.
    ctx.effect(() => ctx.systemPrompt.context({
      name: 'deepseek2027:persona',
      order: ctx.systemPrompt.getContextOrder('APPROVAL_POLICY') + 1,
      required: true,
      text: () => personaCache.text,
    }), 'deepseek-2027: persona context')

    // The authored-tool index, so the model knows which self-built tools exist
    // and where their notes live.
    ctx.effect(() => ctx.systemPrompt.context({
      name: 'deepseek2027:custom-tools',
      order: ctx.systemPrompt.getContextOrder('WEB_SURFACE') + 1,
      text: () => indexCache.text,
    }), 'deepseek-2027: custom tool index')

    // The analyst roster. Empty below L12 in practice, because spawning requires
    // the team tools and those are level-gated; the roster itself is harmless to
    // show, and showing it is what lets the lead know a role exists before it
    // decides whether to delegate.
    ctx.effect(() => ctx.systemPrompt.context({
      name: 'deepseek2027:roster',
      order: ctx.systemPrompt.getContextOrder('WEB_SURFACE') + 2,
      text: () => rosterCache.text,
    }), 'deepseek-2027: analyst roster')

    // The cache refresh is exposed to the tool bodies below through this holder,
    // which is the only mutable state the two halves share. A write through
    // `dev_tool`, `dev_persona` or `dev_agent` must show up on the very next step,
    // so it calls `refresh` directly rather than waiting for the timer.
    refreshCaches = async () => {
      await refreshPersona()
      await refreshToolIndex()
      await refreshRoster()
    }
  }

  // ---- Images in the conversation ---------------------------------------
  //
  // A tool result is a `content` array, and an image block in it renders inline.
  // That is the whole mechanism; the work is in getting bytes into the attachment
  // service from the three places a model actually has an image: a file on disk,
  // an SVG it authored, or a table of numbers it wants to plot.
  if (config.images !== false) {
    /**
     * Image blocks produced by one call, keyed by call id.
     *
     * The block cannot travel inside the JSON result — an attachment reference is
     * not something the model should read back as data — so execute records it and
     * the content seam consumes it. Keys are dropped on read, which keeps the map
     * proportional to calls in flight rather than to session length.
     * @type {Map<string, object>}
     */
    const producedBlocks = new Map()

    ctx.effect(() => ctx.tools.register(tool({
      name: 'dev_image',
      description:
        'Show an image to the user inside the conversation. '
        + 'Use it whenever a picture communicates faster than prose: a screenshot you just took, '
        + 'a rendered plot, a diagram of how something is wired, a chart of numbers you were given. '
        + 'Three modes — `show` an existing image file, `draw` from SVG markup you write yourself, '
        + 'and `chart` from labels and values. The image appears inline for the user. '
        + 'Prefer this over describing a picture in words.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['show', 'draw', 'chart'],
            description:
              'show: display an image file already on disk (png/jpeg/webp/gif). '
              + 'draw: rasterize the SVG markup in `svg` and display it. '
              + 'chart: plot `labels` and `values` as a bar, line or pie chart.',
          },
          path: { type: 'string', description: 'show: absolute path of the image file to display.' },
          svg: {
            type: 'string',
            description:
              'draw: complete <svg>…</svg> markup. Must be self-contained: no <script>, no on* attributes, '
              + 'no external href. Use plain shapes (rect, circle, path, line, text, polygon) and inline colours. '
              + 'A <style> block is allowed. Width/height on the root element controls the aspect ratio.',
          },
          kind: {
            type: 'string',
            enum: ['bar', 'line', 'pie'],
            description: 'chart: the chart type; defaults to bar.',
          },
          labels: { type: 'array', items: { type: 'string' }, description: 'chart: one label per value, in order.' },
          values: { type: 'array', items: { type: 'number' }, description: 'chart: the numeric values, same length as labels.' },
          title: { type: 'string', description: 'chart/draw: optional heading drawn above the image.' },
          caption: { type: 'string', description: 'A one-line caption shown to the user beside the image.' },
          width: { type: 'integer', description: 'draw: output width in pixels; omit to keep the SVG\'s own size.' },
          height: { type: 'integer', description: 'draw: output height in pixels; omit to keep the SVG\'s own size.' },
          background: {
            type: 'string',
            description: 'draw: CSS colour painted behind the artwork; defaults to #ffffff. Use "#1f2328" for dark artwork.',
          },
        },
        required: ['mode'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string' },
          caption: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          mediaType: { type: 'string' },
          bytes: { type: 'integer' },
          summary: { type: 'string' },
        },
        required: ['mode', 'summary'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(String(value?.summary ?? '')),
      execute: async (args, exec) => {
        const mode = String(args.mode)
        const caption = String(args.caption ?? '').trim()
        const attachments = ctx.get('attachments')
        if (attachments === undefined) {
          throw new Error('这个部署没有图片服务（attachments），无法在对话中显示图片。')
        }

        let data
        let mediaType
        let name
        let width
        let height

        if (mode === 'show') {
          const path = String(args.path ?? '').trim()
          if (path === '') throw new Error('show 需要 path：给出要显示的图片文件绝对路径')
          const loaded = await loadImageFile(path)
          data = loaded.data
          mediaType = loaded.mediaType
          name = loaded.name
        } else if (mode === 'draw') {
          const { png } = await renderSvg(String(args.svg ?? ''), {
            width: args.width,
            height: args.height,
            background: args.background,
          })
          const loaded = await loadImageFile(png)
          data = loaded.data
          mediaType = loaded.mediaType
          name = `draw-${Date.now()}.png`
        } else if (mode === 'chart') {
          // Painted directly rather than rendered from SVG: a chart's geometry is
          // arithmetic, so a rasterizer would add a dependency without adding a
          // capability. This path works on a deployment with no SVG support.
          const canvas = paintChart({
            kind: args.kind,
            labels: args.labels,
            values: args.values,
            title: args.title,
          })
          const pngBytes = await encodePng(canvas)
          data = new Uint8Array(pngBytes)
          mediaType = 'image/png'
          name = `chart-${Date.now()}.png`
        } else {
          throw new Error(`unknown dev_image mode "${mode}"`)
        }

        const saved = await attachments.saveImage({ data, mediaType, name })
        width = saved.width
        height = saved.height

        const summary = caption === ''
          ? `已显示图片：${width}×${height}px，${saved.bytes} 字节（${saved.mediaType}）。`
          : `${caption}（${width}×${height}px，${saved.mediaType}）`

        // Both seams are needed. `projectContent` shapes what the transcript and the
        // next step receive, and it runs after execute, so the block is keyed by the
        // call id here and read back there. `finalizeContent` is kept as a fallback
        // for a Host that calls only one of the two.
        producedBlocks.set(exec.callId, { type: 'image', attachment: saved })

        return {
          mode,
          caption,
          width,
          height,
          mediaType: saved.mediaType,
          bytes: saved.bytes,
          summary,
        }
      },
      // The rendered content is where the image lives. A tool result that carries
      // an attachment id in its JSON would hand the model an opaque identifier; the
      // content block is what both the user's transcript and the model's next step
      // can actually use.
      projectContent: (exec, result) => {
        const value = result?.value
        if (value === undefined || value === null || typeof value !== 'object') return undefined
        const produced = producedBlocks.get(exec?.callId)
        if (produced === undefined) return undefined
        producedBlocks.delete(exec.callId)
        const caption = typeof value.caption === 'string' ? value.caption.trim() : ''
        /** @type {object[]} */
        const content = [produced]
        if (caption !== '') content.push({ type: 'text', text: caption })
        return content
      },
      presentCall: (args) => ({
        card: 'generic',
        title: args.mode === 'chart'
          ? `dev_image · ${args.kind ?? 'bar'} 图`
          : args.mode === 'draw' ? 'dev_image · 绘图' : 'dev_image · 显示图片',
        kind: 'other',
        rawInput: args.mode === 'draw' ? { mode: 'draw', caption: args.caption, width: args.width, height: args.height } : args,
      }),
    })), 'deepseek-2027: dev_image')
  }

  // ---- The analyst team (L12) -------------------------------------------
  //
  // These two tools exist only at L12, for two reasons that both matter:
  //
  //  - Their descriptions are long. A model reading spawn/wait/collect semantics it
  //    can never use has paid for them in every step of every turn.
  //  - A capability the model cannot see is a stronger guarantee than a rule it was
  //    told to follow, so "do not delegate below L12" is enforced by absence.
  //
  // The gate is a filter on the assembly, not a registration flag, because a
  // session can walk from L10 to L12 mid-conversation: the tools must appear at
  // that moment without a restart.
  //
  // The roster is per preset-scope, so a profile running several sessions keeps
  // one team per session instead of leaking analysts between them.
  if (config.team !== false) {
    const team = new TeamRegistry(Number.isInteger(config.maxDelegates) ? config.maxDelegates : DEFAULT_MAX_DELEGATES)

    ctx.effect(() => () => void team.drain(), 'deepseek-2027: analyst team')

    ctx.effect(() => ctx.tools.register(tool({
      name: 'dev_agent',
      description:
        'Define, list, read or delete the specialist roles you delegate to at L12. '
        + 'A role is a short Markdown brief: what this specialist attends to, what it must ignore, and the shape of '
        + 'the report it returns. Defining roles once and delegating by name beats re-describing the specialist in every brief. '
        + 'Roles cannot grant capability — every analyst is spawned read-only, and no role can let it edit files or run commands.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'read', 'define', 'remove'],
            description: 'list: the roster. read: one role\'s full brief. define: create or replace a role. remove: delete a custom role.',
          },
          role: { type: 'string', description: 'Role name for read/define/remove: lowercase, digits and hyphens, 2-39 chars.' },
          body: {
            type: 'string',
            description:
              'define: the role brief in Markdown. Write it as instructions to the specialist: what to attend to, '
              + 'what to ignore, and exactly what form its answer must take. Three to eight lines is usually right.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          roles: { type: 'array', items: { type: 'string' } },
          role: { type: 'string' },
          body: { type: 'string' },
          path: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['action', 'summary'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(String(value?.summary ?? '')),
      execute: async (args) => {
        const action = String(args.action)
        if (action === 'list') {
          const roster = await renderRoster()
          const rows = await listDefinitions()
          return {
            action,
            roles: rows.map((row) => row.role),
            summary: roster === ''
              ? `还没有定义任何分析员。用 define 定义第一个；定义存放在 ${AGENTS_DIR}。`
              : `可派出的分析员（共 ${rows.length} 个）：\n${roster}`,
          }
        }
        const role = String(args.role ?? '').trim().toLowerCase()
        if (role === '') throw new Error(`action "${action}" 需要 role`)
        if (action === 'read') {
          const found = await readDefinition(role)
          if (found === undefined) throw new Error(`没有名为 "${role}" 的分析员。用 list 看现有名单。`)
          return {
            action,
            role: found.role,
            body: found.body,
            path: found.builtin ? '(内置，无文件)' : pathOf(found.role),
            summary: `${found.builtin ? '（内置）' : ''}\`${found.role}\` 的职责：\n\n${found.body}`,
          }
        }
        if (action === 'remove') {
          const removed = await deleteDefinition(role)
          await refreshCaches()
          return {
            action,
            role,
            summary: removed
              ? `已删除自定义分析员 "${role}"。`
              : `"${role}" 没有自定义定义；内置分析员不能被删除，只能被同名自定义定义覆盖。`,
          }
        }
        if (action === 'define') {
          const definition = normalizeDefinition({ role, body: args.body })
          const path = await saveDefinition(definition)
          await refreshCaches()
          return {
            action,
            role: definition.role,
            body: definition.body,
            path,
            summary: `已定义分析员 \`${definition.role}\`，写入 ${path}。现在可以用 dev_team 的 spawn 指派它。`,
          }
        }
        throw new Error(`unknown dev_agent action "${action}"`)
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `dev_agent · ${args.action}`,
        kind: 'other',
        rawInput: args,
      }),
    })), 'deepseek-2027: dev_agent')

    ctx.effect(() => ctx.tools.register(tool({
      name: 'dev_team',
      description:
        'Delegate analysis to an analyst running in its own context window, and collect its report. '
        + 'Use it when the work is genuinely parallel, wide, or adversarial — not for questions you can answer directly. '
        + 'You keep every write and every decision: analysts are read-only and cannot edit files or run commands. '
        + 'Spawn `role` with a sharp `question`, optionally supply background `context` and the required reply `form`; '
        + 'then call with action "collect" (or "wait") to read the report. '
        + 'Their transcripts never reach the user, so anything load-bearing from a report must be restated by you with its evidence.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['spawn', 'wait', 'collect', 'list', 'stop'],
            description:
              'spawn: start one analyst. wait: spawn then block until it reports (simplest for one analyst). '
              + 'collect: read a finished report. list: current roster. stop: interrupt an analyst.',
          },
          role: { type: 'string', description: 'spawn/wait: the defined role to run. Use dev_agent list to see them.' },
          question: {
            type: 'string',
            description: 'spawn/wait: the single question this analyst must answer. One observable success condition, not a topic.',
          },
          context: { type: 'string', description: 'spawn/wait: background it may rely on. Do not include your own conclusion.' },
          form: { type: 'string', description: 'spawn/wait: the required shape of its report. Defaults to conclusion/evidence/uncertainty/counterexample.' },
          label: { type: 'string', description: 'spawn/wait: a short name for this run, for collect and the roster.' },
          id: { type: 'string', description: 'collect/stop: the analyst id or label returned by spawn.' },
          timeoutMs: { type: 'integer', description: 'wait/collect: how long to block; defaults to 240000 for wait, 1000 for collect.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          id: { type: 'string' },
          role: { type: 'string' },
          status: { type: 'string' },
          report: { type: 'string' },
          team: { type: 'array', items: { type: 'object' } },
          summary: { type: 'string' },
        },
        required: ['action', 'summary'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(String(value?.summary ?? '')),
      execute: async (args, exec) => {
        const action = String(args.action)
        const service = ctx.get('subagents')

        if (action === 'list') {
          const rows = team.roster()
          return {
            action,
            team: rows,
            summary: rows.length === 0
              ? '当前没有在跑的分析员。'
              : `当前分析员（${rows.length} 个）：\n` + rows.map((row) => `- ${row.label}（id ${row.id}，${Math.round(row.runningMs / 1000)}s）${row.question.slice(0, 80)}`).join('\n'),
          }
        }

        if (action === 'stop') {
          const wanted = String(args.id ?? '').trim()
          const member = [...team.members.values()].find((row) => row.id === wanted || row.label === wanted)
          if (member === undefined) throw new Error(`找不到分析员 "${wanted}"`)
          if (service !== undefined && member.childId !== null) {
            service.interrupt(member.childId, { kind: 'ancestor', agent: exec.agent })
          }
          team.release(member.id)
          return { action, id: member.id, status: 'stopped', summary: `已停止分析员「${member.label}」。` }
        }

        if (action === 'spawn' || action === 'wait') {
          if (service === undefined) throw new Error('这个部署没有多智能体服务（subagents），无法派出分析员。')
          const role = String(args.role ?? '').trim().toLowerCase()
          if (role === '') throw new Error('spawn 需要 role：先用 dev_agent list 看有哪些分析员')
          const question = String(args.question ?? '').trim()
          if (question === '') throw new Error('spawn 需要 question：写成一个可判定成败的问句，不要写成主题')

          // The boundary, not a suggestion: refuse a brief that asks for a write.
          const refusal = classifyBrief(question)
          if (refusal !== undefined) throw new Error(refusal)
          const noteRefusal = classifyBrief(String(args.context ?? ''))
          if (noteRefusal !== undefined) throw new Error(noteRefusal)

          const definition = await readDefinition(role)
          if (definition === undefined) {
            throw new Error(`没有名为 "${role}" 的分析员。用 dev_agent list 看现有名单，或用 dev_agent 的 define 先定义它。`)
          }

          const reservation = team.reserve(String(args.label ?? role), question)
          if (!reservation.ok) throw new Error(reservation.reason)
          const member = reservation.member

          const prompt = analystPrompt({
            question,
            context: args.context,
            form: args.form,
            forbid: `本次由你承担的角色是「${role}」。你的职责说明如下，按它决定关注点与回报形式：\n\n${definition.body}`,
          })

          const activation = await service.startActivation({
            provider: 'local',
            label: member.label,
            request: {
              parent: exec.agent,
              prompt: [{ type: 'text', text: prompt }],
              cwd: undefined,
              signal: exec.signal,
            },
            signal: exec.signal,
            delivery: 'parent',
          })
          member.activation = activation
          if (activation.childId !== undefined) team.attach(member.id, activation.childId)

          /**
           * Await one report and frame it for the lead.
           * @param {number} budgetMs - how long to block.
           * @returns {Promise<object>} the collect result.
           */
          const collect = async (budgetMs) => {
            const settled = await Promise.race([
              activation.result.then((result) => ({ kind: 'done', result })),
              new Promise((resolve) => {
                const timer = setTimeout(() => resolve({ kind: 'pending' }), budgetMs)
                if (typeof timer.unref === 'function') timer.unref()
              }),
            ])
            if (settled.kind === 'pending') {
              return {
                action: 'spawn',
                id: member.id,
                role,
                status: 'running',
                summary: `分析员「${member.label}」仍在运行（id ${member.id}）。用 dev_team 的 action:"collect" 和 id:"${member.id}" 取报告。`,
              }
            }
            team.release(member.id)
            const output = (settled.result?.output ?? [])
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('\n')
            const report = frameReport({ label: member.label, output, stopReason: settled.result?.stopReason })
            return {
              action: 'collect',
              id: member.id,
              role,
              status: settled.result?.stopReason ?? 'completed',
              report,
              summary: report,
            }
          }

          if (action === 'wait') {
            const budget = Number.isInteger(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : 240000
            return await collect(budget)
          }
          return await collect(1000)
        }

        if (action === 'collect') {
          const wanted = String(args.id ?? '').trim()
          const member = [...team.members.values()].find((row) => row.id === wanted || row.label === wanted)
          if (member === undefined) throw new Error(`找不到分析员 "${wanted}"。用 action:"list" 看当前名单。`)
          if (member.activation === null) throw new Error(`分析员「${member.label}」没有可用的执行句柄。`)
          const budget = Number.isInteger(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : 1000
          const settled = await Promise.race([
            member.activation.result.then((result) => ({ kind: 'done', result })),
            new Promise((resolve) => {
              const timer = setTimeout(() => resolve({ kind: 'pending' }), budget)
              if (typeof timer.unref === 'function') timer.unref()
            }),
          ])
          if (settled.kind === 'pending') {
            return {
              action,
              id: member.id,
              role: member.label,
              status: 'running',
              summary: `分析员「${member.label}」仍在运行。稍后用 action:"collect" 再试，或调大 timeoutMs。`,
            }
          }
          team.release(member.id)
          const output = (settled.result?.output ?? [])
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n')
          const report = frameReport({ label: member.label, output, stopReason: settled.result?.stopReason })
          return {
            action,
            id: member.id,
            role: member.label,
            status: settled.result?.stopReason ?? 'completed',
            report,
            summary: report,
          }
        }

        throw new Error(`unknown dev_team action "${action}"`)
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `dev_team · ${args.action}${typeof args.role === 'string' ? ` · ${args.role}` : ''}`,
        kind: 'other',
        rawInput: args,
      }),
    })), 'deepseek-2027: dev_team')

  }

  // ---- The quality module -------------------------------------------------
  //
  // The mechanical half of thinking harder. These two tools exist at every level
  // from L6 up, because that is where the protocol starts making claims whose
  // evidence matters; below L6 the answer is short enough that a ledger is pure
  // ceremony. They are gated by level rather than always present so that a simple
  // task does not pay for them.
  //
  // Neither tool makes the model smarter. They make its errors *findable*: a claim
  // cannot be registered as load-bearing without evidence or a check, a check that
  // is not run is reported as a hole, and a falsified claim stays in the ledger
  // marked rather than being quietly forgotten.
  if (config.enhance !== false) {
    const ledgers = new ClaimLedger()

    ctx.effect(() => () => ledgers.clear(), 'deepseek-2027: claim ledger')

    ctx.effect(() => ctx.tools.register(tool({
      name: 'dev_claim',
      description:
        'Keep a ledger of the claims your answer rests on, and check them for real. '
        + 'Register each load-bearing claim with its evidence channel — observed (you ran or read it), '
        + 'derived (it follows from something observed), assumed, or guessed. '
        + 'A load-bearing claim must carry either `evidence` or `check` (a command that would settle it), '
        + 'or registration is refused: an unbacked guess may not carry a conclusion. '
        + 'Then run the checks: the output decides whether the claim stands, not your opinion of it. '
        + 'Falsified claims stay in the ledger, marked — you cannot quietly forget them. '
        + 'Call audit before delivering a hard answer, and fix what it reports.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'verify', 'audit', 'clear'],
            description:
              'add: register one claim. verify: run a claim\'s check and record the outcome. '
              + 'audit: list holes, weakest first. clear: drop the ledger for a new task.',
          },
          text: { type: 'string', description: 'add: the claim as one sentence that can be true or false.' },
          channel: {
            type: 'string',
            enum: ['observed', 'derived', 'assumed', 'guessed'],
            description: 'add: how you know it. Be honest — "derived" means it follows, not that it feels right.',
          },
          loadBearing: { type: 'boolean', description: 'add: true if the answer collapses when this is false.' },
          evidence: { type: 'string', description: 'add: the basis, with its source (path, command output, citation).' },
          check: {
            type: 'string',
            description: 'add: a command that would settle the claim. Prefer a check over prose evidence when the claim is testable.',
          },
          id: { type: 'string', description: 'verify: the claim id from add.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          id: { type: 'string' },
          report: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['action', 'summary'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(String(value?.summary ?? '')),
      execute: async (args, exec) => {
        const action = String(args.action)
        if (action === 'add') {
          const claim = ledgers.add({
            text: args.text,
            channel: args.channel,
            loadBearing: args.loadBearing,
            evidence: args.evidence,
            check: args.check,
          })
          return {
            action,
            id: claim.id,
            summary: `已登记 ${claim.id}（${claim.channel}${claim.loadBearing ? '，承重' : ''}）。`
              + (claim.check === '' ? '' : `\n验证命令：\`${claim.check}\``),
          }
        }
        if (action === 'verify') {
          const id = String(args.id ?? '').trim()
          const claim = ledgers.claims.get(id)
          if (claim === undefined) throw new Error(`找不到结论 "${id}"。用 audit 看现有条目。`)
          if (claim.check === '') throw new Error(`结论 ${id} 没有 check，无法自动验证。先 add 一个 check，或用 evidence 说明依据。`)

          // The check runs through the same administrator path dev_admin uses, so
          // a verification is a real execution, not a restatement.
          const result = await runDirect({
            argv: ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', claim.check],
            timeoutMs: 60000,
          })
          const output = `${result.stdout}${result.stderr}`.trim()
          const holds = result.exitCode === 0
          const settled = ledgers.settle(id, { holds, result: output === '' ? `(exit ${result.exitCode})` : output })
          void exec
          return {
            action,
            id,
            report: ledgers.render(),
            summary: holds
              ? `结论 ${id} 验证通过（exit 0），已升级为 observed。\n输出：${output.slice(0, 400)}`
              : `结论 ${id} **验证失败**（exit ${result.exitCode}），已标记为证伪。你必须改写受影响的结论。\n输出：${output.slice(0, 400)}`,
          }
        }
        if (action === 'audit') {
          const report = ledgers.render()
          return { action, report, summary: report }
        }
        if (action === 'clear') {
          ledgers.clear()
          return { action, summary: '结论台账已清空。' }
        }
        throw new Error(`unknown dev_claim action "${action}"`)
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `dev_claim · ${args.action}`,
        kind: 'other',
        rawInput: args,
      }),
    })), 'deepseek-2027: dev_claim')

    ctx.effect(() => ctx.tools.register(tool({
      name: 'dev_consensus',
      description:
        'Settle a hard question by independent paths instead of one derivation. '
        + 'Asks several analysts the same question from deliberately different stances — forward derivation, '
        + 'backward verification from an assumed shape, and a hostile stance that argues the tempting wrong answer. '
        + 'Different stances are the point: identical prompts return identical answers and measure nothing. '
        + 'You get every answer plus a convergence score. Agreement raises confidence; disagreement localises the '
        + 'real uncertainty, and you must resolve it yourself rather than average it away. '
        + 'This is a verdict aid, not a vote — a majority can be the same error repeated three times.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question to settle. One sentence, answerable, with an observable success condition.',
          },
          context: { type: 'string', description: 'Background all three paths may rely on. Do not include your conclusion.' },
          timeoutMs: { type: 'integer', description: 'How long to wait for all paths; defaults to 300000.' },
        },
        required: ['question'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          converged: { type: 'number' },
          report: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['summary'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(String(value?.summary ?? '')),
      execute: async (args, exec) => {
        const service = ctx.get('subagents')
        if (service === undefined) {
          throw new Error('这个部署没有多智能体服务（subagents），无法做多路独立采样。用单路推导并在 dev_claim 里登记结论。')
        }
        const question = String(args.question ?? '').trim()
        if (question === '') throw new Error('consensus 需要 question')
        const context = String(args.context ?? '').trim()
        const budget = Number.isInteger(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : 300000
        const variants = consensusVariants(question)

        // Fan out: every path starts before any path is awaited, so the three runs
        // overlap instead of paying for each other's latency.
        const activations = []
        for (const variant of variants) {
          const prompt = context === ''
            ? variant.prompt
            : `${variant.prompt}\n\n可用背景：\n${context}`
          const activation = await service.startActivation({
            provider: 'local',
            label: `consensus/${variant.stance}`,
            request: {
              parent: exec.agent,
              prompt: [{ type: 'text', text: prompt }],
              signal: exec.signal,
            },
            signal: exec.signal,
            delivery: 'parent',
          })
          activations.push({ variant, activation })
        }

        const deadline = Date.now() + budget
        const reports = []
        for (const entry of activations) {
          const remaining = Math.max(1000, deadline - Date.now())
          const settled = await Promise.race([
            entry.activation.result.then((result) => ({ kind: 'done', result })),
            new Promise((resolve) => {
              const timer = setTimeout(() => resolve({ kind: 'pending' }), remaining)
              if (typeof timer.unref === 'function') timer.unref()
            }),
          ])
          if (settled.kind === 'pending') {
            reports.push({ stance: entry.variant.stance, output: '' })
            continue
          }
          const output = (settled.result?.output ?? [])
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n')
          reports.push({ stance: entry.variant.stance, output })
          await entry.activation.dispose?.().catch?.(() => {})
        }

        const summary = summarizeConsensus(reports)
        const report = renderConsensus(summary)
        return {
          converged: summary.converged,
          report,
          summary: report,
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'dev_consensus · 多路采样',
        kind: 'other',
        rawInput: { question: args.question },
      }),
    })), 'deepseek-2027: dev_consensus')
  }

  // ---- The level gate ------------------------------------------------------
  //
  // One gate, not one per feature. `systemPrompt.tools()` providers *accumulate*
  // — every provider's schemas are concatenated into the assembly — so two gates
  // that each returned the full registry would duplicate the whole tool list and
  // neither could withhold what the other allowed. A single provider that decides
  // the whole visible set is the only correct shape.
  //
  // What is withheld, and why:
  //
  //  - `dev_team` / `dev_agent` below L12: their descriptions are long and their
  //    semantics unreadable without a team to use. A capability the model cannot
  //    see is also a stronger guarantee than a rule it was told to follow.
  //  - `dev_claim` / `dev_consensus` below L6: at low levels the answer is short
  //    enough that a ledger is ceremony, and their descriptions cost context in
  //    every step.
  //
  // Everything else stays visible at every level. The gate re-runs per assembly
  // with the calling agent, so walking the level up makes the tools appear on the
  // next request without a restart.
  ctx.effect(() => ctx.systemPrompt.tools((context) => {
    const schemas = ctx.tools.schemas(context?.agent)
    const level = currentLevel(context?.agent?.session, ctx.get('sessionProjections'))
    const known = typeof level === 'number' ? level : MAX_LEVEL
    const hidden = new Set()
    if (known < 12) {
      hidden.add('dev_team')
      hidden.add('dev_agent')
    }
    if (known < 6) {
      hidden.add('dev_claim')
      hidden.add('dev_consensus')
    }
    if (hidden.size === 0) return { schemas }
    return { schemas: schemas.filter((schema) => !hidden.has(schema.name)) }
  }), 'deepseek-2027: level gate')

  if (config.manual !== false) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: MANUAL_SECTION,
      order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE') + 1,
      text: (context) => {
        const level = currentLevel(context?.agent?.session, ctx.get('sessionProjections'))
        const current = level === undefined
          ? `L${MIN_LEVEL}–L${MAX_LEVEL}`
          : level === null ? 'auto' : `L${level}（${describeLevel(level)}）`
        return `${MANUAL}\n当前会话思考等级：${current}。切换：\`/think 1..${MAX_LEVEL}\` 或输入框左侧控件。`
      },
    }), 'deepseek-2027: developer manual')
  }
}

/**
 * Read the session's thinking level for the manual's current-level line.
 * @param {object | undefined} session - live Session.
 * @param {object | undefined} projections - the projection registry.
 * @returns {number | null | undefined} the level, null for auto, undefined when unknown.
 */
function currentLevel(session, projections) {
  if (session === undefined || session === null || projections === undefined || projections === null) return undefined
  const state = projections.stateOf(session, 'deepseek2027')
  if (state === undefined || state === null) return undefined
  if (state.level === null) return null
  return typeof state.level === 'number' ? state.level : undefined
}
