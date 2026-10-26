/**
 * Images a tool can show the user.
 *
 * A tool that only returns text cannot show a chart, a diagram or a screenshot.
 * The Harness already has the pipeline for this — `attachments.saveImage` commits
 * bytes and returns a durable reference, and a `{ type: 'image', attachment }`
 * content block renders in the conversation — so this module is a thin adapter
 * between files on disk (or raw bytes) and that pipeline.
 *
 * Three capabilities, matching how the model actually reaches for an image:
 *
 *  - `show` — take a file that already exists (a screenshot, a rendered plot,
 *    a downloaded PNG) and put it in front of the user.
 *  - `draw` — build an SVG from model-authored markup, then rasterize it, so the
 *    model can draw a diagram without needing a raster library.
 *  - `chart` — turn tabular numbers into a chart, which is the common case where
 *    a table is technically correct and practically unreadable.
 *
 * Everything a model writes here is *data*: SVG markup is parsed and rendered by
 * the browser's rasterizer inside a sandboxed `<img>` context via a rasterizer
 * helper, never executed as script in the conversation. That distinction is what
 * keeps "draw a diagram" from becoming "inject a script into the user's page".
 *
 * @module @local/dsh-deepseek-2027/images
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This module's directory, so the work area follows the installed bundle. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** Scratch directory for one rendered image. */
export const IMAGE_DIR = join(HERE, '_images')

/** Media types the attachment service accepts. */
const MEDIA_BY_EXTENSION = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
])

/** Largest SVG markup accepted, in characters. */
const SVG_LIMIT = 400_000

/**
 * Sniff an image's media type from its leading bytes.
 *
 * The extension is a claim; the magic number is evidence. A `.png` that is
 * actually a JPEG would be rejected by the attachment service with a confusing
 * decode error, so the bytes are trusted and the extension is only a fallback.
 *
 * @param {Buffer} bytes - the file's bytes.
 * @returns {string | undefined} the media type, or undefined when unrecognized.
 */
export function sniffMediaType(bytes) {
  if (bytes.length < 12) return undefined
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return undefined
}

/**
 * Resolve a path to readable bytes and a declared media type.
 *
 * @param {string} path - the image file.
 * @returns {Promise<{ data: Uint8Array, mediaType: string, name: string }>} the file's facts.
 */
export async function loadImageFile(path) {
  const bytes = await readFile(path)
  const mediaType = sniffMediaType(bytes) ?? MEDIA_BY_EXTENSION.get(extname(path).toLowerCase())
  if (mediaType === undefined) {
    throw new Error(
      `无法识别 "${path}" 的图片格式。支持 PNG、JPEG、WebP、GIF；`
      + '请先用这些格式之一保存图片再展示。',
  )
  }
  return {
    data: new Uint8Array(bytes),
    mediaType,
    name: path.replace(/\\/g, '/').split('/').pop() ?? 'image',
  }
}

/**
 * Commit one image and build the content block that renders it.
 *
 * @param {object} attachments - the Host's attachment service.
 * @param {{ data: Uint8Array, mediaType: string, name?: string }} input - the image.
 * @returns {Promise<{ block: object, ref: object }>} the content block and its reference.
 */
export async function makeImageBlock(attachments, input) {
  if (attachments === undefined || typeof attachments.saveImage !== 'function') {
    throw new Error('当前部署没有图片服务（attachments），无法在对话里显示图片。')
  }
  const ref = await attachments.saveImage({
    data: input.data,
    mediaType: input.mediaType,
    name: input.name,
  })
  return {
    block: { type: 'image', attachment: ref },
    ref,
  }
}

/**
 * Render model-authored SVG markup to a PNG.
 *
 * The SVG is validated as markup rather than trusted: only a root `<svg>` with no
 * script or external references is accepted, because this text becomes an image
 * the user sees and a `<script>` or a remote `<image href>` inside it would turn
 * a drawing request into an injection or an outbound fetch.
 *
 * @param {string} svg - the caller's markup.
 * @param {object} options - render options.
 * @param {number} [options.width] - output width in pixels.
 * @param {number} [options.height] - output height in pixels.
 * @param {string} [options.background] - CSS colour painted behind the artwork.
 * @returns {Promise<{ png: string, svg: string }>} the written paths.
 */
export async function renderSvg(svg, options = {}) {
  const markup = String(svg ?? '').trim()
  if (markup === '') throw new Error('draw 需要 svg：请给出完整的 <svg>…</svg> 标记')
  if (markup.length > SVG_LIMIT) throw new Error(`SVG 过大（上限 ${SVG_LIMIT} 字符）`)
  if (!/<svg[\s>]/i.test(markup)) throw new Error('svg 必须包含一个 <svg> 根元素')
  if (/<script[\s>]/i.test(markup)) throw new Error('SVG 里不允许出现 <script>')
  if (/\son[a-z]+\s*=/i.test(markup)) throw new Error('SVG 里不允许出现 on* 事件属性')
  if (/(href|src)\s*=\s*["']?\s*(https?:|\/\/)/i.test(markup)) {
    throw new Error('SVG 里不允许引用外部地址（http/https/CDN），请把图形全部画在标记里')
  }

  await mkdir(IMAGE_DIR, { recursive: true })
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const svgPath = join(IMAGE_DIR, `draw-${stamp}.svg`)
  const pngPath = join(IMAGE_DIR, `draw-${stamp}.png`)
  await writeFile(svgPath, markup, 'utf8')

  const sharp = await loadSharp()
  const background = options.background === undefined ? '#ffffff' : String(options.background)
  let pipeline = sharp(Buffer.from(markup, 'utf8'), { density: 144 }).flatten({ background })
  const width = Number(options.width)
  const height = Number(options.height)
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    pipeline = pipeline.resize(Math.trunc(width), Math.trunc(height), { fit: 'contain', background })
  } else if (Number.isFinite(width) && width > 0) {
    pipeline = pipeline.resize({ width: Math.trunc(width) })
  } else if (Number.isFinite(height) && height > 0) {
    pipeline = pipeline.resize({ height: Math.trunc(height) })
  }
  await pipeline.png().toFile(pngPath)
  return { png: pngPath, svg: svgPath }
}

/**
 * Locate `sharp`, the rasterizer this deployment already ships.
 *
 * A bundle linked into a profile resolves bare specifiers from its own directory,
 * where `node_modules` holds only installed bundles — `sharp` lives in the
 * Harness installation instead. So the loader walks the known anchors rather than
 * importing by name: the Host's `resourcesPath` when running under Electron, and
 * the installation directory recorded by `dsh` itself. Importing `sharp` is
 * correct here precisely because it is *not* a dependency of this bundle: it is
 * the deployment's own rasterizer, reused rather than re-installed.
 *
 * @returns {Promise<Function>} the sharp factory.
 */
async function loadSharp() {
  if (cachedSharp !== undefined) return cachedSharp
  const { createRequire } = await import('node:module')
  const { existsSync } = await import('node:fs')
  const candidates = []

  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    candidates.push(join(process.resourcesPath, 'app', 'package.json'))
    candidates.push(join(process.resourcesPath, 'package.json'))
  }

  for (const envKey of ['DSH_HOME', 'DSH_PROFILE_DIR', 'DSH_INSTALL_DIR']) {
    const value = process.env[envKey]
    if (typeof value === 'string' && value !== '') {
      candidates.push(join(value, 'package.json'))
      candidates.push(join(value, 'resources', 'app', 'package.json'))
    }
  }

  // Walk up from this bundle: a profile-linked bundle sits under the profile,
  // which sits under the user's home, while the installation is wherever the user
  // put it. A sibling `resources/app` beside any ancestor is the Desktop layout.
  let cursor = HERE
  for (let depth = 0; depth < 8; depth += 1) {
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
    candidates.push(join(cursor, 'resources', 'app', 'package.json'))
    candidates.push(join(cursor, 'app', 'package.json'))
  }

  candidates.push(join(process.execPath, '..', 'package.json'))
  candidates.push(join(process.execPath, '..', 'resources', 'app', 'package.json'))

  // Last resort, and the most reliable one: ask Node where the Harness packages
  // themselves live. `sharp` is a sibling of `@deepseek-ai/dsh-llm` inside the
  // installation's own `node_modules`, so any package this bundle can already
  // resolve reveals the directory that contains the rasterizer. This works for a
  // profile link, an asar bundle and a plain `npm -g` install alike, because it
  // uses the resolution chain the Host itself is using.
  for (const probe of ['@deepseek-ai/dsh-llm/package.json', '@deepseek-ai/cordis/package.json']) {
    try {
      const resolved = import.meta.resolve?.(probe)
      if (typeof resolved === 'string' && resolved.startsWith('file:')) {
        const filePath = fileURLToPath(resolved)
        // `.../node_modules/@deepseek-ai/<pkg>/package.json` → `.../node_modules`
        const modulesDir = dirname(dirname(dirname(filePath)))
        candidates.push(join(modulesDir, 'sharp', 'package.json'))
        candidates.push(join(dirname(modulesDir), 'package.json'))
      }
    } catch {
      // This package is not resolvable from here; the next probe may be.
    }
  }

  const seen = new Set()
  const failures = []
  for (const anchor of candidates) {
    if (seen.has(anchor)) continue
    seen.add(anchor)
    if (!existsSync(anchor)) continue
    try {
      const load = createRequire(anchor)
      const sharp = load('sharp')
      if (typeof sharp === 'function' || typeof sharp?.default === 'function') {
        cachedSharp = typeof sharp === 'function' ? sharp : sharp.default
        return cachedSharp
      }
      failures.push(`${anchor}: resolved but is not the sharp factory`)
    } catch (error) {
      failures.push(`${anchor}: ${error?.code ?? error?.message ?? error}`)
    }
  }
  throw new Error(
    'draw 需要 SVG 栅格化器（sharp），但在当前部署里找不到它。'
    + ' 这不影响 show — 显示已有图片不需要栅格化。'
    + ' 若部署里确实有 sharp，可用环境变量 DSH_INSTALL_DIR 指向 Harness 安装目录（含 node_modules 的那一层）。'
    + ` 已尝试：${failures.join(' | ') || '(无可用锚点)'}`,
  )
}

/** Cached rasterizer factory, resolved once per Host process. */
let cachedSharp

/**
 * Build a chart from tabular data as SVG markup.
 *
 * Generated here rather than by the model so the geometry is arithmetic: a model
 * asked to compute an axis by hand routinely produces a chart whose bars do not
 * match their labels, and the error is invisible until someone checks the numbers.
 *
 * @param {object} input - the chart request.
 * @param {string} input.kind - `bar`, `line` or `pie`.
/**
 * Build a chart from tabular data as SVG markup.
 *
 * Generated here rather than by the model so the geometry is arithmetic: a model
 * asked to compute an axis by hand routinely produces a chart whose bars do not
 * match their labels, and the error is invisible until someone checks the numbers.
 *
 * @param {object} input - the chart request.
 * @param {readonly string[]} input.labels - one label per value.
 * @param {readonly number[]} input.values - the values.
 * @param {string} [input.title] - the heading.
 * @returns {string} SVG markup.
 */
export function buildChartSvg(input) {
  const labels = Array.isArray(input.labels) ? input.labels.map((item) => String(item)) : []
  const values = Array.isArray(input.values) ? input.values.map((item) => Number(item)) : []
  if (labels.length === 0 || values.length === 0) throw new Error('chart 需要 labels 和 values')
  if (labels.length !== values.length) throw new Error('labels 与 values 的数量必须相同')
  if (values.some((value) => !Number.isFinite(value))) throw new Error('values 里有非数字')
  if (labels.length > 60) throw new Error('一张图最多 60 个数据点')

  const title = String(input.title ?? '').trim()
  const kind = String(input.kind ?? 'bar')
  const width = 720
  const height = 420
  const padLeft = 68
  const padRight = 28
  const padTop = title === '' ? 28 : 62
  const padBottom = 62
  const plotWidth = width - padLeft - padRight
  const plotHeight = height - padTop - padBottom
  const maxValue = Math.max(...values, 0)
  const minValue = Math.min(...values, 0)
  const span = maxValue - minValue || 1
  const hasNegative = values.some((value) => value < 0)

  /** Vertical position of a value. */
  const yOf = (value) => padTop + plotHeight - ((value - minValue) / span) * plotHeight
  const parts = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Segoe UI, Microsoft YaHei, sans-serif">`)
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`)
  if (title !== '') {
    parts.push(`<text x="${width / 2}" y="36" text-anchor="middle" font-size="18" font-weight="600" fill="#1f2328">${escapeXml(title)}</text>`)
  }

  if (kind === 'pie') {
    const total = values.reduce((sum, value) => sum + Math.max(0, value), 0)
    if (total <= 0) throw new Error('pie 需要至少一个正值')
    const cx = width / 2
    const cy = padTop + plotHeight / 2
    const radius = Math.min(plotWidth, plotHeight) / 2 - 8
    const palette = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16']
    let angle = -Math.PI / 2
    for (const [index, value] of values.entries()) {
      const share = Math.max(0, value) / total
      const sweep = share * Math.PI * 2
      const x1 = cx + radius * Math.cos(angle)
      const y1 = cy + radius * Math.sin(angle)
      const x2 = cx + radius * Math.cos(angle + sweep)
      const y2 = cy + radius * Math.sin(angle + sweep)
      const large = sweep > Math.PI ? 1 : 0
      const colour = palette[index % palette.length]
      parts.push(`<path d="M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${colour}" stroke="#ffffff" stroke-width="1.5"/>`)
      const midAngle = angle + sweep / 2
      const legendY = padTop + 16 + index * 22
      parts.push(`<rect x="${padLeft}" y="${legendY - 10}" width="12" height="12" rx="3" fill="${colour}"/>`)
      parts.push(`<text x="${padLeft + 20}" y="${legendY}" font-size="13" fill="#1f2328">${escapeXml(labels[index])} · ${value} (${(share * 100).toFixed(1)}%)</text>`)
      angle += sweep
    }
    // The legend overlaps the plot area on a pie chart, so the plot is shifted.
    parts.push('</svg>')
    return parts.join('')
  }

  // Gridlines and the value axis.
  const ticks = 5
  for (let step = 0; step <= ticks; step += 1) {
    const value = minValue + (span * step) / ticks
    const y = yOf(value)
    parts.push(`<line x1="${padLeft}" y1="${y.toFixed(2)}" x2="${width - padRight}" y2="${y.toFixed(2)}" stroke="#e5e7eb" stroke-width="1"/>`)
    parts.push(`<text x="${padLeft - 10}" y="${(y + 4).toFixed(2)}" text-anchor="end" font-size="11" fill="#6b7280">${formatNumber(value)}</text>`)
  }
  if (hasNegative) {
    parts.push(`<line x1="${padLeft}" y1="${yOf(0).toFixed(2)}" x2="${width - padRight}" y2="${yOf(0).toFixed(2)}" stroke="#9ca3af" stroke-width="1.5"/>`)
  }

  if (kind === 'line') {
    const stepX = labels.length === 1 ? 0 : plotWidth / (labels.length - 1)
    const points = values.map((value, index) => `${(padLeft + index * stepX).toFixed(2)},${yOf(value).toFixed(2)}`)
    parts.push(`<polyline points="${points.join(' ')}" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linejoin="round"/>`)
    for (const [index, value] of values.entries()) {
      const cx = padLeft + index * stepX
      parts.push(`<circle cx="${cx.toFixed(2)}" cy="${yOf(value).toFixed(2)}" r="4" fill="#3b82f6"/>`)
    }
  } else {
    const slot = plotWidth / values.length
    const barWidth = Math.max(6, Math.min(64, slot * 0.62))
    for (const [index, value] of values.entries()) {
      const x = padLeft + index * slot + (slot - barWidth) / 2
      const top = value >= 0 ? yOf(value) : yOf(0)
      const barHeight = Math.abs(yOf(value) - yOf(0))
      parts.push(`<rect x="${x.toFixed(2)}" y="${top.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${Math.max(1, barHeight).toFixed(2)}" rx="4" fill="${value < 0 ? '#ef4444' : '#3b82f6'}"/>`)
    }
  }

  // Labels along the bottom.
  const stepX = labels.length === 1 ? plotWidth / 2 : plotWidth / (labels.length - 1)
  for (const [index, label] of labels.entries()) {
    const x = kind === 'line'
      ? padLeft + index * stepX
      : padLeft + index * (plotWidth / values.length) + plotWidth / values.length / 2
    parts.push(`<text x="${x.toFixed(2)}" y="${height - padBottom + 22}" text-anchor="middle" font-size="11" fill="#6b7280">${escapeXml(label)}</text>`)
  }
  parts.push('</svg>')
  return parts.join('')
}

/**
 * Escape text for XML character data.
 * @param {string} value - the raw text.
 * @returns {string} the escaped text.
 */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Format a number compactly for an axis label.
 * @param {number} value - the number.
 * @returns {string} the label.
 */
function formatNumber(value) {
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(2)
}

/**
 * Remove one scratch render.
 * @param {string} path - the file to delete.
 * @returns {Promise<void>} resolves once removed.
 */
export async function dropImage(path) {
  await rm(path, { force: true })
}
