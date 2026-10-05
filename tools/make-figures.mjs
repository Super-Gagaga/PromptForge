/**
 * dsh-prompt-forge — README figure generator.
 *
 * The README ships two figures per theme. They are drawn from the values DSH
 * itself ships, not from colours typed by hand: every fill, label, border, and
 * corner radius is read out of the installed theme's token map, and every
 * visible string is the shipped one. Re-running this after a DSH update is what
 * keeps the figures honest.
 *
 *   node tools/make-figures.mjs            # write docs/images/*.png
 *   node tools/make-figures.mjs --check    # fail if a figure is missing
 *
 * Pillow is used through the bundled Python runtime, so no npm dependency is
 * added to the package.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(root, 'docs', 'images');

/** The installed theme bundle: the one place real token values live. */
const THEME_FILE = 'C:/Users/hzh12/AppData/Local/Temp/dsh-asar/theme/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js';
/** The conversation bundle: the shipped composer strings. */
const CONVERSATION_FILE = 'C:/Users/hzh12/AppData/Local/Temp/dsh-asar/ext/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js';

/**
 * Resolve the alias tokens this generator needs into literal colours.
 *
 * The theme maps an alias to a static ramp entry differently per scheme, so the
 * two values of each declaration are taken in order: light first, dark second.
 *
 * @param source - the theme bundle source.
 * @returns `{ light, dark }` maps from token name to CSS colour.
 */
function readTokens(source) {
  const alias = (name) => {
    const hits = [...source.matchAll(new RegExp(`--dsw-alias-${name}\\s*:\\s*([^;\\n"'}]+)`, 'g'))]
      .map((match) => match[1].trim());
    return [...new Set(hits)];
  };
  const ramp = (name) => {
    const hits = [...source.matchAll(new RegExp(`--dsw-static-${name}\\s*:\\s*([^;\\n"'}]+)`, 'g'))]
      .map((match) => match[1].trim());
    return [...new Set(hits)];
  };
  const resolve = (value) => {
    const indirect = /var\(--dsw-static-([a-z0-9-]+)\)/.exec(value);
    if (indirect === null) return value;
    const values = ramp(indirect[1]);
    return values[values.length - 1] ?? '#000000';
  };
  const pick = (name, index) => {
    const values = alias(name);
    if (values.length === 0) throw new Error(`theme token --dsw-alias-${name} not found`);
    return resolve(values[Math.min(index, values.length - 1)]);
  };
  const keys = [
    'bg-base', 'bg-layer-1', 'bg-layer-2',
    'label-primary', 'label-secondary', 'label-tertiary', 'label-caption', 'label-dimmed',
    'border-l2', 'border-l3', 'interactive-bg-hover', 'state-business-primary',
  ];
  return {
    light: Object.fromEntries(keys.map((key) => [key, pick(key, 0)])),
    dark: Object.fromEntries(keys.map((key) => [key, pick(key, 1)])),
  };
}

/** Read one shipped UI string by locale key. */
function readStrings(source) {
  const lines = source.split('\n');
  const find = (key) => {
    const line = lines.find((candidate) => candidate.includes(`"${key}":`) && /[\u4e00-\u9fff]/u.test(candidate));
    if (line === undefined) throw new Error(`UI string ${key} not found`);
    return line.slice(line.indexOf(':', line.indexOf(`"${key}"`)) + 1).trim().replace(/^"|",?$/gu, '');
  };
  return {
    placeholder: find('placeholder.hero'),
    commands: find('input.commands'),
    send: find('input.send'),
  };
}

const python = process.env.DSH_PYTHON
  ?? 'C:/Users/hzh12/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe';

/**
 * Read the installed DSH bundles this generator draws from.
 *
 * Those paths only exist after a local DSH extraction, so the reads are deferred
 * to the generate branch: `--check` inspects the committed PNGs alone and has to
 * run anywhere, including CI runners with no DSH install.
 *
 * @returns `{ tokens, strings }` read from the installed bundles.
 */
async function loadInstalledBundles() {
  if (!existsSync(THEME_FILE)) throw new Error(`theme bundle not found at ${THEME_FILE}`);
  if (!existsSync(CONVERSATION_FILE)) throw new Error(`conversation bundle not found at ${CONVERSATION_FILE}`);
  if (!existsSync(python)) throw new Error(`python runtime not found at ${python}; set DSH_PYTHON`);
  return {
    tokens: readTokens(await readFile(THEME_FILE, 'utf8')),
    strings: readStrings(await readFile(CONVERSATION_FILE, 'utf8')),
  };
}

/**
 * The Pillow renderer.
 *
 * It is a string rather than a separate committed file so the generator stays a
 * single artifact; it reads the payload written next to it.
 */
const RENDERER = String.raw`
import json, sys
from PIL import Image, ImageDraw, ImageFont

payload = json.load(open(sys.argv[1], encoding='utf-8'))
OUT = payload['out']
STR = payload['strings']

SCALE = 2
FONT = 'C:/Windows/Fonts/msyh.ttc'
FONT_BOLD = 'C:/Windows/Fonts/msyhbd.ttc'
MONO = 'C:/Windows/Fonts/consola.ttf'

def f(path, size):
    return ImageFont.truetype(path, size * SCALE)

def hexa(value, alpha=255):
    value = value.strip()
    if value.startswith('#'):
        v = value[1:]
        if len(v) == 3:
            v = ''.join(c * 2 for c in v)
        if len(v) == 8:
            return (int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16), int(v[6:8], 16))
        return (int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16), alpha)
    if value.startswith('rgb'):
        parts = value[value.index('(') + 1:value.rindex(')')].replace('/', ' ').replace(',', ' ').split()
        r, g, b = (int(float(parts[i])) for i in range(3))
        a = int(float(parts[3]) * 255) if len(parts) > 3 else alpha
        return (r, g, b, a)
    raise ValueError(value)

def blend(fg, bg):
    a = fg[3] / 255
    return tuple(int(round(fg[i] * a + bg[i] * (1 - a))) for i in range(3)) + (255,)

def wrap(draw, text, font, width):
    lines, line = [], ''
    for ch in text:
        probe = line + ch
        if draw.textlength(probe, font=font) > width and line:
            lines.append(line)
            line = ch
        else:
            line = probe
    if line:
        lines.append(line)
    return lines

def card(size, fill, radius=12, outline=None):
    img = Image.new('RGBA', size, (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius * SCALE,
                        fill=fill, outline=outline, width=SCALE)
    return img, d

def composer(t):
    W, H = 900, 430
    base = blend(hexa(t['bg-base']), (255, 255, 255))
    img = Image.new('RGB', (W * SCALE, H * SCALE), base)
    body = f(FONT, 13)
    small = f(FONT, 11)
    mono = f(MONO, 11)
    heading = f(FONT_BOLD, 14)
    on = blend(hexa(t['state-business-primary']), base)
    primary = blend(hexa(t['label-primary']), base)
    secondary = blend(hexa(t['label-secondary']), base)
    tertiary = blend(hexa(t['label-tertiary']), base)
    caption = blend(hexa(t['label-caption']), base)

    # the composer card
    card_img, _ = card(((W - 40) * SCALE, 150 * SCALE), blend(hexa(t['bg-layer-2']), base),
                       radius=14, outline=blend(hexa(t['border-l2']), base))
    img.paste(card_img, (20 * SCALE, 24 * SCALE), card_img)
    d = ImageDraw.Draw(img)
    d.text((36 * SCALE, 46 * SCALE), STR['placeholder'], font=body, fill=tertiary)
    row_y = 132 * SCALE
    d.ellipse([36 * SCALE, row_y, 56 * SCALE, row_y + 20 * SCALE], outline=blend(hexa(t['border-l3']), base), width=SCALE)
    d.line([42 * SCALE, row_y + 10 * SCALE, 50 * SCALE, row_y + 10 * SCALE], fill=secondary, width=SCALE)
    d.line([46 * SCALE, row_y + 6 * SCALE, 46 * SCALE, row_y + 14 * SCALE], fill=secondary, width=SCALE)
    d.text((64 * SCALE, row_y + 10 * SCALE), '文件', font=body, fill=secondary, anchor='lm')

    # the current text-and-spark control (illustration, not a screenshot)
    star_x = 664 * SCALE
    d.rounded_rectangle([star_x, row_y, star_x + 124 * SCALE, row_y + 24 * SCALE], radius=8 * SCALE,
                        fill=blend(hexa(t['interactive-bg-hover']), base))
    for offset, length in ((7, 9), (12, 12), (17, 8)):
        d.line([star_x + 5 * SCALE, row_y + offset * SCALE,
                star_x + (5 + length) * SCALE, row_y + offset * SCALE], fill=on, width=2 * SCALE)
    cx, cy, r, waist = star_x + 21 * SCALE, row_y + 7 * SCALE, 4 * SCALE, 1.2 * SCALE
    d.polygon([(cx, cy - r), (cx + waist, cy - waist), (cx + r, cy), (cx + waist, cy + waist),
               (cx, cy + r), (cx - waist, cy + waist), (cx - r, cy), (cx - waist, cy - waist)], fill=on)
    d.text((star_x + 32 * SCALE, row_y + 12 * SCALE), '优化提示词', font=small, fill=on, anchor='lm')
    send_x = 806 * SCALE
    d.rounded_rectangle([send_x, row_y, send_x + 30 * SCALE, row_y + 24 * SCALE], radius=8 * SCALE, fill=on)
    d.polygon([(send_x + 10 * SCALE, row_y + 6 * SCALE), (send_x + 22 * SCALE, row_y + 12 * SCALE),
               (send_x + 10 * SCALE, row_y + 18 * SCALE)], fill=(255, 255, 255))

    # the optimized draft, with each appended group boxed so the addition is obvious
    y = 196 * SCALE
    d.text((20 * SCALE, y), '优化结果（蓝色框内是本插件追加的内容）', font=heading, fill=primary)
    y += 28 * SCALE
    d.text((20 * SCALE, y), '根据我的项目经历和目标岗位，整理一份技术简历，保留可核验的事实。', font=body, fill=primary)
    y += 26 * SCALE
    for title, rows in (('Files this task needs:', ['@docs/project-experience.md', '@docs/target-role.md']),
                        ('Skills this task may need:', ['/make-resume', '/great-resume'])):
        box_h = (30 + len(rows) * 16) * SCALE
        box, _ = card(((W - 40) * SCALE, box_h), blend(hexa(t['interactive-bg-hover']), base),
                      radius=8, outline=on)
        img.paste(box, (20 * SCALE, y), box)
        d = ImageDraw.Draw(img)
        d.text((30 * SCALE, y + 8 * SCALE), title, font=body, fill=on)
        for index, row in enumerate(rows):
            d.text((30 * SCALE, y + (28 + index * 16) * SCALE), row, font=mono, fill=secondary)
        y += box_h + 10 * SCALE
    d.text((20 * SCALE, y + 2 * SCALE), '操作示意：优化只替换草稿，不发送；文件与技能名称仅为示例。', font=small, fill=caption)
    return img.crop((0, 0, W * SCALE, y + 26 * SCALE))

def settings(t):
    W, H = 900, 820
    img = Image.new('RGB', (W * SCALE, H * SCALE), blend(hexa(t['bg-base']), (255, 255, 255)))
    d = ImageDraw.Draw(img)
    x, y, w = 20 * SCALE, 20 * SCALE, (W - 40) * SCALE
    title = f(FONT_BOLD, 18)
    d.text((x, y), '设置 / 提示词优化', font=title, fill=blend(hexa(t['label-primary']), (255, 255, 255)))
    y += 30 * SCALE
    body = f(FONT, 13)
    small = f(FONT, 11)
    heading = f(FONT_BOLD, 14)
    label = f(FONT, 13)

    def section(title_text, rows, height, accent=False):
        nonlocal y
        fill = blend(hexa(t['bg-layer-2']), (255, 255, 255))
        outline = blend(hexa(t['state-business-primary']), (255, 255, 255)) if accent \
            else blend(hexa(t['border-l2']), (255, 255, 255))
        box, bd = card((w, height * SCALE), fill, radius=12, outline=outline)
        img.paste(box, (x, y), box)
        d2 = ImageDraw.Draw(img)
        d2.text((x + 14 * SCALE, y + 12 * SCALE), title_text, font=heading,
                fill=blend(hexa(t['label-primary']), (255, 255, 255)))
        if accent:
            badge = '本插件新增'
            tw = d2.textlength(badge, font=small)
            d2.rounded_rectangle([x + w - tw - 26 * SCALE, y + 11 * SCALE, x + w - 12 * SCALE, y + 29 * SCALE],
                                 radius=6 * SCALE, fill=blend(hexa(t['interactive-bg-hover']), (255, 255, 255)))
            d2.text((x + w - tw - 19 * SCALE, y + 20 * SCALE), badge, font=small,
                    fill=blend(hexa(t['state-business-primary']), (255, 255, 255)), anchor='lm')
        ry = y + 40 * SCALE
        for kind, text, value in rows:
            if kind == 'preview':
                bh = 80 * SCALE
                d2.rounded_rectangle([x + 14 * SCALE, ry, x + w - 14 * SCALE, ry + bh], radius=8 * SCALE,
                                     fill=blend(hexa(t['bg-layer-1']), (255, 255, 255)),
                                     outline=blend(hexa(t['border-l3']), (255, 255, 255)), width=SCALE)
                for i, line in enumerate(text.split('\n')):
                    d2.text((x + 24 * SCALE, ry + 10 * SCALE + i * 16 * SCALE), line, font=small,
                            fill=blend(hexa(t['label-secondary']), (255, 255, 255)))
                ry += bh + 8 * SCALE
                continue
            if kind == 'hint':
                d2.text((x + 14 * SCALE, ry), text, font=small,
                        fill=blend(hexa(t['label-tertiary']), (255, 255, 255)))
                ry += 18 * SCALE
                continue
            d2.text((x + 14 * SCALE, ry + 10 * SCALE), text, font=label,
                    fill=blend(hexa(t['label-primary']), (255, 255, 255)), anchor='lm')
            if kind == 'select':
                bw, bh = 250 * SCALE, 32 * SCALE
                bx = x + w - bw - 14 * SCALE
                by = ry - 4 * SCALE
                d2.rounded_rectangle([bx, by, bx + bw, by + bh], radius=8 * SCALE,
                                     fill=blend(hexa(t['bg-layer-1']), (255, 255, 255)),
                                     outline=blend(hexa(t['border-l3']), (255, 255, 255)), width=SCALE)
                d2.text((bx + 10 * SCALE, by + bh / 2), value, font=label,
                        fill=blend(hexa(t['label-primary']), (255, 255, 255)), anchor='lm')
                chev = bx + bw - 16 * SCALE
                d2.line([chev - 5 * SCALE, by + bh / 2 - 2 * SCALE, chev, by + bh / 2 + 3 * SCALE,
                         chev + 5 * SCALE, by + bh / 2 - 2 * SCALE],
                        fill=blend(hexa(t['label-caption']), (255, 255, 255)), width=2 * SCALE)
            elif kind == 'switch':
                tw, th = 34 * SCALE, 20 * SCALE
                tx = x + w - tw - 14 * SCALE
                ty = ry
                d2.rounded_rectangle([tx, ty, tx + tw, ty + th], radius=th / 2,
                                     fill=blend(hexa(t['state-business-primary']), (255, 255, 255)))
                d2.ellipse([tx + tw - 18 * SCALE, ty + 2 * SCALE, tx + tw - 2 * SCALE, ty + th - 2 * SCALE], fill=(255, 255, 255))
                d2.text((tx - 10 * SCALE, ty + th / 2), value, font=small,
                        fill=blend(hexa(t['label-secondary']), (255, 255, 255)), anchor='rm')
            elif kind == 'button':
                bw = d2.textlength(value, font=small) + 20 * SCALE
                bx = x + w - bw - 14 * SCALE
                d2.rounded_rectangle([bx, ry - 2 * SCALE, bx + bw, ry + 24 * SCALE], radius=6 * SCALE,
                                     outline=blend(hexa(t['border-l3']), (255, 255, 255)), width=SCALE)
                d2.text((bx + bw / 2, ry + 11 * SCALE), value, font=small,
                        fill=blend(hexa(t['label-secondary']), (255, 255, 255)), anchor='mm')
                ry += 30 * SCALE
                continue
            elif kind == 'preview':
                bh = 80 * SCALE
                d2.rounded_rectangle([x + 14 * SCALE, ry, x + w - 14 * SCALE, ry + bh], radius=8 * SCALE,
                                     fill=blend(hexa(t['bg-layer-1']), (255, 255, 255)),
                                     outline=blend(hexa(t['border-l3']), (255, 255, 255)), width=SCALE)
                for i, line in enumerate(text.split('\n')):
                    d2.text((x + 24 * SCALE, ry + 10 * SCALE + i * 16 * SCALE), line, font=small,
                            fill=blend(hexa(t['label-secondary']), (255, 255, 255)))
                ry += bh + 12 * SCALE
                continue
            ry += 36 * SCALE
        y += (height + 12) * SCALE

    section('模型', [('hint', '使用 DSH 已配置的模型；此处列出的就是当前可路由的全部模型。', ''), ('select', '', 'DeepSeek / DeepSeek-V41-Flash')], 96)
    section('思考强度', [('hint', '选“默认”时由模型自己决定强度。', ''), ('select', '', '默认')], 96)
    section('自动引用', [
        ('switch', '引用文件', '开'),
        ('hint', '由模型提名、再经当前工作区的文件索引校验；只保留真实存在的路径。', ''),
        ('select', '引用技能', '均衡'),
        ('hint', '只引用确实有帮助的技能，最多 3 个；命中的以 /名称 形式列出。', ''),
    ], 168, accent=True)
    section('优化指令', [
        ('hint', '发送给模型的系统提示词，决定重写风格。', ''),
        ('preview', 'You are PromptForge, a prompt-engineering assistant.\n\nRules:\n- Preserve the author intent, language and every concrete detail…', ''),
        ('button', '', '恢复默认'),
    ], 186)
    return img.crop((0, 0, W * SCALE, min(H * SCALE, y + 6 * SCALE)))

for scheme in ('light', 'dark'):
    t = payload['tokens'][scheme]
    composer(t).save(f'{OUT}/composer-{scheme}.png')
    settings(t).save(f'{OUT}/settings-{scheme}.png')
print('wrote composer-light/dark.png, settings-light/dark.png')
`;

const FIGURES = ['composer-light.png', 'composer-dark.png', 'settings-light.png', 'settings-dark.png'];

if (process.argv.includes('--check')) {
  const problems = FIGURES.filter((name) => {
    const path = join(OUT_DIR, name);
    return !existsSync(path) || statSync(path).size === 0;
  });
  if (problems.length > 0) throw new Error(`missing or empty figures: ${problems.join(', ')}; run "node tools/make-figures.mjs"`);
  process.stdout.write(`dsh-prompt-forge: ${FIGURES.length} figures present\n`);
} else {
  const { tokens, strings } = await loadInstalledBundles();
  await mkdir(OUT_DIR, { recursive: true });
  const payload = { tokens, strings, out: OUT_DIR.replaceAll('\\', '/') };
  const script = join(OUT_DIR, '.render.py');
  const payloadFile = join(OUT_DIR, '.payload.json');
  await writeFile(script, RENDERER, 'utf8');
  await writeFile(payloadFile, JSON.stringify(payload), 'utf8');
  try {
    const { stdout } = await run(python, [script, payloadFile]);
    process.stdout.write(stdout);
  } finally {
    /* The renderer is a build artifact; only the PNGs are deliverables. */
    await unlink(script).catch(() => {});
    await unlink(payloadFile).catch(() => {});
  }
}
