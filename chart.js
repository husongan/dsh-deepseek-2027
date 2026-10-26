/**
 * Charts drawn pixel by pixel.
 *
 * The obvious implementation renders SVG and hands it to a rasterizer, which is
 * how `draw` works. Charts are different: their geometry is fully specified — a
 * rectangle here, a polyline there — so there is nothing a rasterizer adds except
 * a dependency. This module therefore paints a PNG directly: the shapes are
 * arithmetic, the text uses a built-in bitmap font, and the only runtime need is
 * a PNG encoder, which the deployment already ships.
 *
 * That makes `chart` work on any deployment, including one where the SVG
 * rasterizer is absent, and it keeps chart output deterministic: the same numbers
 * produce byte-identical pixels.
 *
 * Text is the one place where a real font would be better. The bitmap font below
 * covers digits, Latin letters and a small punctuation set; a label outside it is
 * dropped with a visible marker rather than silently mangled, because an
 * unreadable axis is worse than an honest one.
 *
 * @module @local/dsh-deepseek-2027/chart
 */

/** A small 5x7 bitmap font, one string per row, '1' meaning ink. */
const GLYPHS = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '01100', '00100', '01000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '%': ['11001', '11010', '00010', '00100', '01000', '01011', '10011'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  _: ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
  '#': ['01010', '01010', '11111', '01010', '11111', '01010', '01010'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
}

/** Glyph cell size in pixels (5 wide, 7 tall, scaled by {@link TEXT_SCALE}). */
const GLYPH_WIDTH = 5
const GLYPH_HEIGHT = 7
const GLYPH_GAP = 1

/** A colour as {r, g, b}. */
function rgb(hex) {
  const value = String(hex).replace('#', '')
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  }
}

/** Palette entries used by the chart. */
const PALETTE = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16']
const INK = rgb('#1f2328')
const MUTED = rgb('#6b7280')
const GRID = rgb('#e5e7eb')
const AXIS = rgb('#9ca3af')
const PAPER = rgb('#ffffff')

/**
 * A tiny RGBA canvas with just the primitives a chart needs.
 */
class Canvas {
  /**
   * @param {number} width - canvas width in pixels.
   * @param {number} height - canvas height in pixels.
   */
  constructor(width, height) {
    this.width = width
    this.height = height
    this.data = Buffer.alloc(width * height * 4, 0xff)
  }

  /**
   * Paint one pixel, ignoring out-of-bounds writes.
   * @param {number} x - column.
   * @param {number} y - row.
   * @param {{r: number, g: number, b: number}} colour - the colour.
   * @param {number} [alpha] - 0–1 opacity.
   */
  pixel(x, y, colour, alpha = 1) {
    const px = Math.round(x)
    const py = Math.round(y)
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return
    const index = (py * this.width + px) * 4
    if (alpha >= 1) {
      this.data[index] = colour.r
      this.data[index + 1] = colour.g
      this.data[index + 2] = colour.b
      this.data[index + 3] = 0xff
      return
    }
    // Blend against what is already there, so overlapping shapes compose.
    this.data[index] = Math.round(this.data[index] * (1 - alpha) + colour.r * alpha)
    this.data[index + 1] = Math.round(this.data[index + 1] * (1 - alpha) + colour.g * alpha)
    this.data[index + 2] = Math.round(this.data[index + 2] * (1 - alpha) + colour.b * alpha)
    this.data[index + 3] = 0xff
  }

  /**
   * Fill an axis-aligned rectangle.
   * @param {number} x - left.
   * @param {number} y - top.
   * @param {number} width - height of the box.
   * @param {number} height - the box height.
   * @param {{r: number, g: number, b: number}} colour - the fill.
   */
  rect(x, y, width, height, colour) {
    const x0 = Math.max(0, Math.floor(x))
    const y0 = Math.max(0, Math.floor(y))
    const x1 = Math.min(this.width, Math.ceil(x + width))
    const y1 = Math.min(this.height, Math.ceil(y + height))
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) this.pixel(px, py, colour)
    }
  }

  /**
   * Fill a rounded rectangle, approximating the corner arcs.
   * @param {number} x - left.
   * @param {number} y - top.
   * @param {number} width - box width.
   * @param {number} height - box height.
   * @param {number} radius - corner radius in pixels.
   * @param {{r: number, g: number, b: number}} colour - the fill.
   */
  roundRect(x, y, width, height, radius, colour) {
    const r = Math.max(0, Math.min(radius, Math.floor(Math.min(width, height) / 2)))
    this.rect(x + r, y, width - 2 * r, height, colour)
    this.rect(x, y + r, r, height - 2 * r, colour)
    this.rect(x + width - r, y + r, r, height - 2 * r, colour)
    for (let dy = 0; dy < r; dy += 1) {
      for (let dx = 0; dx < r; dx += 1) {
        if (dx * dx + dy * dy <= r * r) {
          this.pixel(x + r - 1 - dx, y + r - 1 - dy, colour)
          this.pixel(x + width - r + dx, y + r - 1 - dy, colour)
          this.pixel(x + r - 1 - dx, y + height - r + dy, colour)
          this.pixel(x + width - r + dx, y + height - r + dy, colour)
        }
      }
    }
  }

  /**
   * Draw a straight line with a one-pixel nib, using Bresenham.
   * @param {number} x0 - start column.
   * @param {number} y0 - start row.
   * @param {number} x1 - end column.
   * @param {number} y1 - end row.
   * @param {{r: number, g: number, b: number}} colour - the stroke.
   * @param {number} [thickness] - nib size in pixels.
   */
  line(x0, y0, x1, y1, colour, thickness = 1) {
    const dx = Math.abs(x1 - x0)
    const dy = Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let error = dx - dy
    let x = Math.round(x0)
    let y = Math.round(y0)
    for (;;) {
      const half = Math.floor(thickness / 2)
      for (let oy = -half; oy <= half; oy += 1) {
        for (let ox = -half; ox <= half; ox += 1) this.pixel(x + ox, y + oy, colour)
      }
      if (x === Math.round(x1) && y === Math.round(y1)) break
      const doubled = 2 * error
      if (doubled > -dy) {
        error -= dy
        x += sx
      }
      if (doubled < dx) {
        error += dx
        y += sy
      }
    }
  }

  /**
   * Fill a circle.
   * @param {number} cx - centre column.
   * @param {number} cy - centre row.
   * @param {number} radius - radius in pixels.
   * @param {{r: number, g: number, b: number}} colour - the fill.
   */
  circle(cx, cy, radius, colour) {
    const r = Math.max(0, radius)
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy += 1) {
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx += 1) {
        if (dx * dx + dy * dy <= r * r) this.pixel(cx + dx, cy + dy, colour)
      }
    }
  }

  /**
   * Fill a circular sector, used for pie slices.
   * @param {number} cx - centre column.
   * @param {number} cy - centre row.
   * @param {number} radius - radius in pixels.
   * @param {number} from - start angle in radians.
   * @param {number} to - end angle in radians.
   * @param {{r: number, g: number, b: number}} colour - the fill.
   */
  sector(cx, cy, radius, from, to, colour) {
    for (let dy = -Math.ceil(radius); dy <= Math.ceil(radius); dy += 1) {
      for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx += 1) {
        if (dx * dx + dy * dy > radius * radius) continue
        let angle = Math.atan2(dy, dx)
        if (angle < -Math.PI / 2) angle += Math.PI * 2
        const start = from < -Math.PI / 2 ? from + Math.PI * 2 : from
        const end = to < -Math.PI / 2 ? to + Math.PI * 2 : to
        const inside = start <= end
          ? angle >= start && angle <= end
          : angle >= start || angle <= end
        if (inside) this.pixel(cx + dx, cy + dy, colour)
      }
    }
  }

  /**
   * Draw one string of text.
   *
   * Uppercase is used because the font only carries uppercase; a lowercase label
   * would otherwise render as its uppercase form and read as a typo. Characters
   * outside the font are replaced by a box so the gap is visible.
   *
   * @param {string} text - the string.
   * @param {number} x - left edge.
   * @param {number} y - the *baseline* row (bottom of the glyphs).
   * @param {{r: number, g: number, b: number}} colour - the ink.
   * @param {number} [scale] - pixel multiplication.
   * @returns {number} the advance width in pixels.
   */
  text(text, x, y, colour, scale = 1) {
    const value = String(text).toUpperCase()
    let cursor = Math.round(x)
    const top = Math.round(y) - GLYPH_HEIGHT * scale
    for (const char of value) {
      const glyph = GLYPHS[char] ?? ['11111', '10001', '10001', '10001', '10001', '10001', '11111']
      for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
        for (let col = 0; col < GLYPH_WIDTH; col += 1) {
          if (glyph[row][col] !== '1') continue
          for (let sy = 0; sy < scale; sy += 1) {
            for (let sx = 0; sx < scale; sx += 1) {
              this.pixel(cursor + col * scale + sx, top + row * scale + sy, colour)
            }
          }
        }
      }
      cursor += (GLYPH_WIDTH + GLYPH_GAP) * scale
    }
    return cursor - Math.round(x)
  }

  /**
   * Measure a string's width without drawing it.
   * @param {string} text - the string.
   * @param {number} [scale] - pixel multiplication.
   * @returns {number} the width in pixels.
   */
  measure(text, scale = 1) {
    return String(text).length * (GLYPH_WIDTH + GLYPH_GAP) * scale
  }
}

/**
 * Format an axis value compactly.
 * @param {number} value - the value.
 * @returns {string} the label.
 */
function axisLabel(value) {
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(1)
}

/**
 * Build the canvas for one chart request.
 *
 * @param {object} input - the request.
 * @param {string} input.kind - `bar`, `line` or `pie`.
 * @param {readonly string[]} input.labels - one label per value.
 * @param {readonly number[]} input.values - the values.
 * @param {string} [input.title] - an optional heading.
 * @returns {Canvas} the painted canvas.
 */
export function paintChart(input) {
  const labels = Array.isArray(input.labels) ? input.labels.map((item) => String(item)) : []
  const values = Array.isArray(input.values) ? input.values.map((item) => Number(item)) : []
  if (labels.length === 0 || values.length === 0) throw new Error('chart 需要 labels 和 values')
  if (labels.length !== values.length) throw new Error('labels 与 values 的数量必须相同')
  if (values.some((value) => !Number.isFinite(value))) throw new Error('values 里含非数字')
  if (labels.length > 60) throw new Error('一张图最多 60 个数据点')

  const kind = String(input.kind ?? 'bar')
  const title = String(input.title ?? '').trim()
  const width = 780
  const height = 460
  const canvas = new Canvas(width, height)
  canvas.rect(0, 0, width, height, PAPER)

  const padLeft = 78
  const padRight = 32
  const padTop = title === '' ? 42 : 88
  const padBottom = 74
  const plotLeft = padLeft
  const plotTop = padTop
  const plotWidth = width - padLeft - padRight
  const plotHeight = height - padTop - padBottom

  if (title !== '') {
    const titleScale = 2
    const w = canvas.measure(title, titleScale)
    canvas.text(title, Math.max(16, (width - w) / 2), padTop - 34, INK, titleScale)
  }

  if (kind === 'pie') {
    const total = values.reduce((sum, value) => sum + Math.max(0, value), 0)
    if (total <= 0) throw new Error('pie 需要至少一个正值')
    const cx = plotLeft + plotWidth / 2
    const cy = plotTop + plotHeight / 2
    const radius = Math.min(plotWidth, plotHeight) / 2 - 10
    let angle = -Math.PI / 2
    for (const [index, value] of values.entries()) {
      const share = Math.max(0, value) / total
      const sweep = share * Math.PI * 2
      canvas.sector(cx, cy, radius, angle, angle + sweep, rgb(PALETTE[index % PALETTE.length]))
      angle += sweep
    }
    // A legend packed into the right margin keeps slice labels off the artwork.
    let legendY = plotTop + 18
    for (const [index, value] of values.entries()) {
      const share = Math.max(0, value) / total
      const colour = rgb(PALETTE[index % PALETTE.length])
      canvas.roundRect(padLeft, legendY - 11, 14, 14, 3, colour)
      const entry = `${labels[index].slice(0, 18)}  ${value}  ${(share * 100).toFixed(1)}%`
      canvas.text(entry, padLeft + 22, legendY, INK, 1)
      legendY += 26
    }
    return canvas
  }

  const maxValue = Math.max(...values, 0)
  const minValue = Math.min(...values, 0)
  const span = maxValue - minValue || 1

  /** Vertical position of a value. */
  const yOf = (value) => plotTop + plotHeight - ((value - minValue) / span) * plotHeight

  // Gridlines with their labels.
  const ticks = 5
  for (let step = 0; step <= ticks; step += 1) {
    const value = minValue + (span * step) / ticks
    const y = yOf(value)
    canvas.rect(plotLeft, y, plotWidth, 1, GRID)
    const label = axisLabel(value)
    canvas.text(label, padLeft - 12 - canvas.measure(label), y + 4, MUTED, 1)
  }
  // The zero rule, only when the data crosses it.
  if (minValue < 0 && maxValue > 0) {
    canvas.rect(plotLeft, yOf(0), plotWidth, 2, AXIS)
  }
  canvas.rect(plotLeft, plotTop, 2, plotHeight, AXIS)
  canvas.rect(plotLeft, plotTop + plotHeight, plotWidth, 2, AXIS)

  if (kind === 'line') {
    const stepX = labels.length === 1 ? 0 : plotWidth / (labels.length - 1)
    for (let index = 1; index < values.length; index += 1) {
      canvas.line(
        plotLeft + (index - 1) * stepX,
        yOf(values[index - 1]),
        plotLeft + index * stepX,
        yOf(values[index]),
        rgb(PALETTE[0]),
        3,
      )
    }
    for (const [index, value] of values.entries()) {
      canvas.circle(plotLeft + index * stepX, yOf(value), 5, rgb(PALETTE[0]))
      canvas.circle(plotLeft + index * stepX, yOf(value), 2, PAPER)
    }
  } else {
    const slot = plotWidth / values.length
    const barWidth = Math.max(8, Math.min(70, slot * 0.62))
    for (const [index, value] of values.entries()) {
      const x = plotLeft + index * slot + (slot - barWidth) / 2
      const top = value >= 0 ? yOf(value) : yOf(0)
      const barHeight = Math.max(1, Math.abs(yOf(value) - yOf(0)))
      canvas.roundRect(x, top, barWidth, barHeight, Math.min(5, barWidth / 4), rgb(value < 0 ? PALETTE[3] : PALETTE[0]))
    }
  }

  // Bottom labels, truncated to the slot so neighbours cannot collide.
  for (const [index, label] of labels.entries()) {
    const slot = plotWidth / values.length
    const cx = kind === 'line'
      ? plotLeft + index * (labels.length > 1 ? plotWidth / (labels.length - 1) : 0)
      : plotLeft + index * slot + slot / 2
    const room = Math.max(3, Math.floor(slot / (GLYPH_WIDTH + GLYPH_GAP)) - 1)
    const shown = label.length > room ? `${label.slice(0, Math.max(1, room - 1))}.` : label
    canvas.text(shown, cx - canvas.measure(shown) / 2, plotTop + plotHeight + 22, MUTED, 1)
  }
  return canvas
}

/**
 * Encode a painted canvas as PNG bytes.
 *
 * @param {Canvas} canvas - the painted canvas.
 * @returns {Promise<Buffer>} the PNG bytes.
 */
export async function encodePng(canvas) {
  const pngjs = await loadPngjs()
  const png = new pngjs.PNG({ width: canvas.width, height: canvas.height })
  canvas.data.copy(png.data)
  return pngjs.PNG.sync.write(png)
}

/** Cached pngjs module, resolved once per Host process. */
let cachedPngjs

/**
 * Locate `pngjs` in the deployment's own modules.
 *
 * Same reasoning as the SVG rasterizer: this bundle declares no dependencies, and
 * the deployment already ships a PNG encoder. Resolving by name from a
 * profile-linked bundle would fail, so the anchors are tried in order.
 *
 * @returns {Promise<object>} the pngjs module.
 */
async function loadPngjs() {
  if (cachedPngjs !== undefined) return cachedPngjs
  const { createRequire } = await import('node:module')
  const { existsSync } = await import('node:fs')
  const anchors = []
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') {
    anchors.push(join2(process.resourcesPath, 'app', 'package.json'))
  }
  for (const key of ['DSH_INSTALL_DIR', 'DSH_HOME']) {
    const value = process.env[key]
    if (typeof value === 'string' && value !== '') anchors.push(join2(value, 'package.json'))
  }
  anchors.push(join2(process.execPath, '..', 'resources', 'app', 'package.json'))
  anchors.push(join2(process.execPath, '..', 'package.json'))

  const failures = []
  for (const anchor of anchors) {
    if (!existsSync(anchor)) continue
    try {
      const load = createRequire(anchor)
      const pngjs = load('pngjs')
      if (typeof pngjs?.PNG?.sync?.write === 'function') {
        cachedPngjs = pngjs
        return cachedPngjs
      }
      failures.push(`${anchor}: pngjs has no PNG.sync.write`)
    } catch (error) {
      failures.push(`${anchor}: ${error?.code ?? error?.message ?? error}`)
    }
  }
  throw new Error(
    'chart 需要 PNG 编码器（pngjs），但在当前部署里找不到它。'
    + ' 可设置环境变量 DSH_INSTALL_DIR 指向 Harness 安装目录。'
    + ` 已尝试：${failures.join(' | ') || '(无可用锚点)'}`,
  )
}

/**
 * Join path parts without importing `node:path` at module scope.
 * @param {...string} parts - the parts.
 * @returns {string} the joined path.
 */
function join2(...parts) {
  return parts.filter((part) => part !== '').join('\\').replace(/\\+/g, '\\')
}

export { Canvas }
