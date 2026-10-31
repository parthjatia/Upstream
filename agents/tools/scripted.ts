/**
 * A scripted stand-in for the LLM, used only in dry-run when no LLM_API_KEY is
 * set (or LLM_PROVIDER=scripted).
 *
 * It speaks the same LlmSession interface, makes the same kind of tool calls
 * and reads their real results, so everything after the model — validation,
 * payment, logging, saving the page — runs exactly as it would with Claude or
 * GPT. It is NOT an AI agent and is labelled as such everywhere it appears.
 */
import type { LlmSession, ToolCall, ToolOutcome, Turn } from './llm.ts'

const DRAFT_COPY =
  "Lisa's Bakery bakes everything freshy every morning: sourdouh loaves, buttery crossaint, " +
  'cinammon rolls and delicous seasonal tarts. Come by untill the shelves are empty — ' +
  'and ask about cakes for your next celebration.'

const MENU = [
  ['Country sourdough', '€5.20'],
  ['Butter croissant', '€2.10'],
  ['Cinnamon roll', '€2.90'],
  ['Seasonal fruit tart', '€4.50'],
  ['Rye & caraway loaf', '€4.80']
] as const

interface Palette {
  colors: Array<{ role: string; hex: string }>
}

function colour(p: Palette | undefined, role: string, fallback: string): string {
  return p?.colors.find(c => c.role === role)?.hex ?? fallback
}

export function buildBakeryPage(input: {
  palette?: Palette
  openingDate: string
  copy: string
  menuIntegrity: string
}): string {
  const p = input.palette
  const menuItems = MENU.map(([name, price]) => `<li><span>${name}</span><span>${price}</span></li>`).join('\n          ')
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Lisa's Bakery</title>
    <!-- styles generated from a colour-text palette -->
    <style>
      :root {
        --primary: ${colour(p, 'primary', '#b5762f')};
        --primary-dark: ${colour(p, 'primary-dark', '#5c3a14')};
        --accent: ${colour(p, 'accent', '#2f8fb5')};
        --bg: ${colour(p, 'background', '#fbf6ef')};
        --surface: ${colour(p, 'surface', '#f1e4d2')};
        --text: ${colour(p, 'text', '#2b2118')};
      }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Georgia, 'Times New Roman', serif; background: var(--bg); color: var(--text); }
      header { background: var(--primary); color: var(--bg); padding: 4rem 1.5rem 3rem; text-align: center; }
      header h1 { margin: 0; font-size: clamp(2.2rem, 6vw, 3.6rem); }
      header p { margin: .75rem 0 0; font-style: italic; }
      main { max-width: 46rem; margin: 0 auto; padding: 2rem 1.5rem; }
      section { background: var(--surface); border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
      h2 { color: var(--primary-dark); margin-top: 0; }
      ul { list-style: none; padding: 0; margin: 0; }
      li { display: flex; justify-content: space-between; padding: .5rem 0; border-bottom: 1px dashed var(--primary); }
      .badge { display: inline-block; background: var(--accent); color: #fff; padding: .25rem .75rem; border-radius: 999px; font-size: .9rem; }
      footer { text-align: center; font-size: .8rem; padding: 2rem 1rem; color: var(--primary-dark); }
      code { word-break: break-all; }
    </style>
  </head>
  <body>
    <header>
      <h1>Lisa's Bakery</h1>
      <p>Small batches, slow dough, warm since 6 a.m.</p>
    </header>
    <main>
      <section>
        <h2>Fresh every morning</h2>
        <p>${input.copy}</p>
        <p><span class="badge">Grand opening: ${input.openingDate}</span></p>
      </section>
      <section>
        <h2>Today's menu</h2>
        <ul>
          ${menuItems}
        </ul>
      </section>
      <section>
        <h2>Visit</h2>
        <p>12 Mill Lane · Tue–Sun, 6:00–14:00 · Closed Mondays</p>
      </section>
    </main>
    <footer>
      Built by an AI agent that paid every open-source library it used.<br>
      Menu fingerprint <code>${input.menuIntegrity}</code>
    </footer>
  </body>
</html>
`
}

const menuText = (): string => MENU.map(([n, p]) => `${n} ${p}`).join('\n')

/** Tomorrow, UTC, as YYYY-MM-DD — the "grand opening" the page announces. */
const openingDay = (now: Date): string =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString().slice(0, 10)

export function scriptedSession(now: Date = new Date()): LlmSession {
  let step = 0
  let n = 0
  const results = new Map<string, unknown>()
  const id = (): string => `scripted_${++n}`
  let page = ''

  const call = (name: string, input: Record<string, unknown>): ToolCall => ({ id: `${name}:${id()}`, name, input })
  const result = (name: string): unknown => {
    for (const [k, v] of results) if (k.startsWith(`${name}:`)) return v
    return undefined
  }

  const next = (): Turn => {
    step++
    switch (step) {
      case 1:
        return {
          text: 'Planning the page: palette, opening date and proof-read copy first.',
          stop: 'tool_use',
          calls: [
            call('generatePalette', { base: 'bread' }),
            call('formatDate', { date: openingDay(now), style: 'long' }),
            call('spellCheck', { text: DRAFT_COPY })
          ]
        }
      case 2:
        return {
          text: 'Fingerprinting the menu for the footer.',
          stop: 'tool_use',
          calls: [call('secureHash', { text: menuText(), algorithm: 'sha256' })]
        }
      case 3: {
        const hash = result('secureHash') as { integrity?: string } | undefined
        const date = result('formatDate') as { formatted?: string } | undefined
        const spell = result('spellCheck') as { corrected?: string } | undefined
        page = buildBakeryPage({
          palette: result('generatePalette') as Palette | undefined,
          openingDate: date?.formatted ?? openingDay(now),
          copy: spell?.corrected ?? DRAFT_COPY,
          menuIntegrity: hash?.integrity ?? 'unavailable'
        })
        return {
          text: 'Page drafted; minifying it before saving.',
          stop: 'tool_use',
          calls: [call('compressText', { text: page })]
        }
      }
      case 4: {
        const compressed = result('compressText') as { minified?: string } | undefined
        return {
          text: 'Saving the page.',
          stop: 'tool_use',
          calls: [call('savePage', { html: compressed?.minified ?? page })]
        }
      }
      default:
        return {
          text: "Done: Lisa's Bakery page saved, built with five paid open-source tools.",
          stop: 'end',
          calls: []
        }
    }
  }

  return {
    start: async () => next(),
    continue: async (outcomes: ToolOutcome[]) => {
      for (const o of outcomes) {
        if (o.isError) continue
        try {
          results.set(o.id, JSON.parse(o.content))
        } catch {
          results.set(o.id, o.content)
        }
      }
      return next()
    }
  }
}
