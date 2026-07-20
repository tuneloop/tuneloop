import { userTurnEvents } from '../../core/turns'
import type { Session } from '../../core/model'
import type { JsonSchema } from '../../llm/types'
import type { ThemeRef, ThemeRemedy, ThemeTrigger, ThemeType } from '../../store/types'
import { limitationSnippets, type Followup } from './followups'

export const TOOL_NAME = 'record_friction'
export const TYPES: ThemeType[] = ['re-steer', 'context-supply', 'tool-gap', 'rework', 'preference', 'other']
export const REMEDIES: ThemeRemedy[] = ['add_doc', 'add_skill', 'add_tool', 'model_or_prompt', 'none']
export const TRIGGERS: ThemeTrigger[] = ['unprompted', 'after_tool_error', 'after_review', 'agent_stated']

/**
 * The extraction prompt. The rules ARE the precision — they encode the spike
 * learnings (error-adjacency fabrication, domain-magnet themes, product-bug-as-
 * rework, taste-iteration inflation, harness noise, interrupt-tag neutrality)
 * Written to generalize across users, not to match any one person's steering style
 */
export function buildPrompt(session: Session, followups: Followup[], themes: ThemeRef[]): { system: string; user: string } {
  const system =
    'You analyze the follow-up user messages of an AI coding session to find FRICTION: moments where the ' +
    'human had to nudge, correct, re-steer, re-supply context, or force rework of the agent. You also ' +
    `maintain a running list of friction themes across sessions. Report via the ${TOOL_NAME} tool.`

  const opener = userTurnEvents(session)[0]?.text ?? '(none)'
  const themeLines = themes.length
    ? themes.map((t) => `- [${t.id}] ${t.label}${t.description ? ` — ${t.description}` : ''} (${t.type})`).join('\n')
    : '(empty — no themes yet)'

  const user = [
    `Repo: ${session.project.repo ?? '(none)'}`,
    '',
    'Opening request (context only — never a friction event):',
    opener,
    '',
    `Follow-up user turns (${followups.length}, bare approvals already removed; "(after errors: …)" = failed`,
    'tool calls between the previous turn and this one; the indented "agent before:" block is what the',
    "agent said and did just before that turn — context for reading the user's reaction, never itself friction):",
    numberedFollowups(followups),
    '',
    'Assistant limitation statements (the agent saying it cannot do something):',
    limitationSnippets(session).map((x) => `- ${x}`).join('\n') || '(none)',
    '',
    'Existing friction themes (match against these FIRST):',
    themeLines,
    '',
    'Friction means the AGENT FELL SHORT and the user had to compensate. The test for every event: "would a',
    'better-equipped agent (better docs, better tools, better instructions) have made this turn unnecessary?"',
    'If the turn would happen even with a perfect agent — it is the user thinking, deciding, or directing — it is NOT friction.',
    'The friction types:',
    '- re-steer: the user corrected a WRONG approach or a misunderstanding the agent had. Not a design choice.',
    '- context-supply: the user supplied information the agent should have found itself — pointing at files, dbs,',
    '  docs, pasting data the agent could have located, or naming a capability the agent had but did not surface.',
    '- tool-gap: the user worked around something the agent could not do or reach (no access, missing tool).',
    '- rework: the user asked for work produced earlier IN THIS SESSION to be redone because it was wrong or',
    '  unusable. A pre-existing product bug or a change to older work is a NEW TASK, never rework.',
    '- preference: the user restated a personal/team convention the agent keeps missing (style, format, process).',
    'NOT friction (never emit these):',
    '- COLLABORATION: design discussion, the user answering an open question, choosing between options the agent',
    '  presented, weighing tradeoffs, raising edge cases, asking the agent questions. Thinking together is the',
    '  point of the tool, not a failure of it.',
    '- workflow progression ("commit and open a PR", "now do the next one", "mark it done") — even when it',
    "  follows tool errors: the error tag alone is NEVER friction, the turn's own text must react to the failure,",
    '- brand-new task requests and scope additions,',
    '- ordinary Q&A follow-ups where the user is learning, not correcting (but a question that identifies a',
    '  concrete defect the agent missed IS friction),',
    '- TASTE ITERATION: refining subjective output (visual design, wording, names) after seeing a draft or',
    '  render, when no explicit earlier spec was violated. It becomes friction only when the same correction',
    '  has to be repeated or the output contradicted an explicit instruction,',
    '- system/harness notifications and the user correcting their OWN earlier mistake.',
    'A "(user INTERRUPTED the agent …)" tag means the user cut the agent off mid-action (Esc); the tag names',
    'what the agent was doing. Use it ONLY to interpret that turn\'s text — the same test as error tags applies:',
    "the turn must react to the agent's direction, and an interrupt followed by an unrelated request or a pause",
    'to answer/think is NOT friction. The tag never makes an otherwise-collaborative turn friction.',
    'An "(agent used skill: X)" tag means the agent invoked that skill/subagent in the window. If the user then',
    'had to correct or redo what the skill produced, that IS friction (type re-steer or rework) — name the theme',
    'after the SKILL\'s gap ("Agent\'s <skill> Skill Produces Wrong Output"), so repeat underperformance of one',
    'skill clusters. A skill that ran and was accepted is NOT friction.',
    'When the user repeatedly pastes screenshots to show the agent its own rendered output, the recurring gap',
    'is ONE tool-gap theme (the agent cannot verify rendered UI itself), not many per-tweak rework themes.',
    'Consecutive turns rejecting the same deliverable ("no, try again" × N) are ONE event, not N.',
    'Be sparse and certain: only emit an event when the agent clearly fell short. Emitting NO events is a',
    'common, correct answer for a smooth session.',
    'Rules for description: one abstract sentence a reader from another team would understand, phrased so',
    'recurrences across sessions read the same — e.g. "user had to tell the agent which env file holds the',
    'service credentials", "user had to run the deploy command themselves and paste the output", "user had to',
    'restate the team\'s changelog format" — never a quote, never session-specific details like line numbers.',
    'Rules for themes: a theme is a RECURRING friction pattern, named as a CONCRETE, ACTIONABLE gap in Title Case',
    '(6 words max) — name the specific missing thing ("Deploy Steps Not Documented"), never an abstract',
    'theme ("Implementation Scope Ambiguity"). Match matched_theme_id ONLY when the event is genuinely another',
    'occurrence of that same specific gap — do NOT force-fit an event into a popular theme, and NEVER match',
    'just because the event shares a domain with a theme (two different metric mistakes are two themes, not one',
    '"metrics" theme); when unsure whether it matches, mint a new theme instead. Only propose new_theme_label',
    'for a pattern absent from the list. When you mint a new theme, also give new_theme_description: one sentence',
    'defining the gap generally (what the agent keeps falling short on), so later sessions and the fix step',
    'understand the theme beyond its title.',
    'new_theme_project_specific: set TRUE only when the gap is inherent to THIS project and would not apply',
    'elsewhere (e.g. "agent does not know this repo\'s deploy sequence", "agent misses this codebase\'s auth module").',
    'Set FALSE (the default) for general agent- or user-behavior gaps that recur across any project (e.g. a habit',
    'that shows up regardless of repo, tooling, or domain) — those are global.',
    'Use trigger=after_tool_error when the friction follows the turn\'s listed tool errors, after_review when the',
    "follow-up itself relays code-review feedback (quotes or paraphrases a reviewer's comments), agent_stated when",
    'it corresponds to an assistant limitation statement, else unprompted.',
  ].join('\n')

  return { system, user }
}

/**
 * Number every follow-up [n] with its tags and the full agent-activity block that
 * preceded it. Nothing is clipped — the user's words and the agent's messages go
 * in full (the summarizer handles the rare oversized session upstream).
 */
function numberedFollowups(followups: Followup[]): string {
  return followups.map((f, i) => {
    const errTag = f.errors.length ? ` (after errors: ${countTag(f.errors)})` : ''
    const intTag = f.interrupted != null ? ` (user INTERRUPTED the agent${f.interrupted ? ` while it was ${f.interrupted}` : ''})` : ''
    const skillTag = f.skills?.length ? ` (agent used skill: ${f.skills.join(', ')})` : ''
    const head = `[${i + 1}]${errTag}${intTag}${skillTag} ${f.text}`
    if (!f.activity) return head
    const indented = f.activity.split('\n').map((l) => '    ' + l).join('\n')
    return `${head}\n  agent before:\n${indented}`
  }).join('\n\n')
}

function countTag(cats: string[]): string {
  const counts = new Map<string, number>()
  for (const c of cats) counts.set(c, (counts.get(c) ?? 0) + 1)
  return [...counts.entries()].map(([c, n]) => (n > 1 ? `${c}×${n}` : c)).join(', ')
}

export const extractionSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['events'],
  properties: {
    events: {
      type: 'array',
      description: 'One entry per follow-up turn that carries GENUINE friction; [] when none do.',
      items: {
        type: 'object',
        properties: {
          turn: { type: 'integer', description: 'The [n] index of the follow-up turn.' },
          type: { type: 'string', enum: TYPES },
          description: { type: 'string', description: 'ONE abstract, self-contained sentence naming the friction (not a quote).' },
          matched_theme_id: { type: 'string', description: 'Id of the existing theme this is another occurrence of, or empty.' },
          new_theme_label: { type: 'string', description: 'Concrete Title-Case label (max 6 words) for a NEW theme when none match, else empty.' },
          new_theme_description: { type: 'string', description: 'One-sentence definition of the NEW theme\'s gap (empty when matching an existing theme).' },
          new_theme_project_specific: { type: 'boolean', description: 'TRUE only if the NEW theme is inherent to this project; FALSE (default) for general/global gaps.' },
          remedy_hint: { type: 'string', enum: REMEDIES },
          trigger: { type: 'string', enum: TRIGGERS },
        },
      },
    },
  },
}
