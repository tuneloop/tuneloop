// Friction tab: recurring cross-session friction topics mined from user follow-up
// turns (enrich-friction), ranked by occurrences, each expandable to its member
// events with the user's ACTUAL words (evidence turns) and a link into the
// session. Every outcome/cost column is an ASSOCIATION against the friction-
// analyzed baseline — never presented as causal (plan DR-6: high-friction
// sessions are also the long, complex ones).
import { $, esc, usd, dayOf, get } from './core'
import { openDetail } from './sessions'

var data = null // /api/friction payload
var repoFilter = ''
var openTopicId = null
var detailCache = {} // "repoFilter|topicId" -> events[] (keyed by slice: sliced detail differs for global topics)

var TYPE_LABELS = {
  're-steer': 'Re-steer',
  'context-supply': 'Context supply',
  'tool-gap': 'Tool gap',
  rework: 'Rework',
  preference: 'Preference',
  other: 'Other',
}
var REMEDY_LABELS = {
  add_doc: 'Add docs/context',
  add_skill: 'Add a skill',
  add_tool: 'Add a tool/MCP',
  model_or_prompt: 'Model or prompt',
  none: '',
}
var TRIGGER_LABELS = {
  unprompted: '',
  after_tool_error: 'after tool errors',
  after_review: 'after review feedback',
  agent_stated: 'agent stated a limitation',
}

export function loadFriction() {
  var qs = repoFilter ? '?repo=' + encodeURIComponent(repoFilter) : ''
  get('/api/friction' + qs).then(function (payload) {
    data = payload
    renderFriction()
  })
}

function pct(v) {
  return v == null ? '—' : Math.round(Number(v) * 100) + '%'
}

/** "42% <small>base 30%</small>" — the topic value with the cohort baseline beside it. */
function vsBase(v, base, fmt?) {
  if (v == null) return '—'
  var main = fmt === 'usd' ? usd(v) : pct(v)
  var b = base == null ? '' : ' <span class="fr-base">base ' + (fmt === 'usd' ? usd(base) : pct(base)) + '</span>'
  return main + b
}

function typeBadge(type) {
  return '<span class="badge fr-t-' + esc(type) + '">' + esc(TYPE_LABELS[type] || type) + '</span>'
}

function renderFriction() {
  var el = $('#friction')
  if (!el || !data) return

  // No friction-analyzed sessions at all → the feature hasn't run yet.
  if (!data.baseline || !data.baseline.sessions) {
    el.innerHTML =
      '<div class="empty">No friction analysis yet. Friction mining runs during <code>tuneloop analyze</code> when an ' +
      'LLM provider is configured (set <code>TUNELOOP_LLM_PROVIDER</code> + key) — it reads each session\'s follow-up ' +
      'turns for moments where you had to re-steer, re-supply context, or redo the agent\'s work, and groups them into ' +
      'recurring topics.</div>'
    return
  }

  var repoSel =
    '<select id="fr-repo"><option value="">All repos</option>' +
    (data.repos || [])
      .map(function (r) {
        return '<option value="' + esc(r) + '"' + (r === repoFilter ? ' selected' : '') + '>' + esc(r) + '</option>'
      })
      .join('') +
    '</select>'

  var caption =
    '<div class="fr-caption">Recurring moments where the human had to compensate for the agent, mined from ' +
    'your own follow-up messages. Each topic suggests a fix — docs, a skill, a tool. Outcome and cost columns are ' +
    'associations vs the ' + data.baseline.sessions + '-session baseline, not causes: high-friction sessions also ' +
    'tend to be the long, complex ones.</div>'

  var html = '<div class="panel-head"><h2>Friction topics</h2>' + repoSel + '</div>' + caption

  if (!data.topics.length) {
    html += '<div class="empty">No recurring friction topics found' + (repoFilter ? ' for this repo' : '') + '. Smooth sailing — or run <code>tuneloop analyze</code> over more sessions.</div>'
    el.innerHTML = html
    wireRepoSelect()
    return
  }

  var head =
    '<tr><th>Topic</th><th>Type</th><th>Suggested fix</th>' +
    '<th class="num">Occurrences</th><th class="num">Sessions</th>' +
    '<th class="num">Success rate</th><th class="num">Merged-PR rate</th><th class="num">Avg cost</th></tr>'

  var body = data.topics
    .map(function (t) {
      var open = t.id === openTopicId
      var row =
        '<tr class="fr-row' + (open ? ' on' : '') + '" data-topic="' + esc(t.id) + '">' +
        '<td><span class="fr-caret">' + (open ? '&#9662;' : '&#9656;') + '</span> ' + esc(t.label) +
        (t.repo ? ' <span class="fr-repo">' + esc(t.repo) + '</span>' : ' <span class="fr-repo">any repo</span>') + '</td>' +
        '<td>' + typeBadge(t.type) + '</td>' +
        '<td>' + esc(REMEDY_LABELS[t.remedy] != null ? REMEDY_LABELS[t.remedy] : t.remedy || '') + '</td>' +
        '<td class="num">' + t.events + '</td>' +
        '<td class="num">' + t.sessions + '</td>' +
        '<td class="num">' + vsBase(t.successRate, data.baseline.successRate) + '</td>' +
        '<td class="num">' + vsBase(t.mergedRate, data.baseline.mergedRate) + '</td>' +
        '<td class="num">' + vsBase(t.avgCostUsd, data.baseline.avgCostUsd, 'usd') + '</td></tr>'
      if (open) row += '<tr class="fr-detail"><td colspan="8"><div id="fr-detail-' + cssId(t.id) + '" class="fr-ev-wrap">Loading…</div></td></tr>'
      return row
    })
    .join('')

  html += '<table class="fr-table">' + head + body + '</table>'
  if (data.untopicedEvents) {
    html += '<div class="empty" style="margin-top:10px">' + data.untopicedEvents + ' one-off friction event(s) matched no recurring topic.</div>'
  }
  el.innerHTML = html
  wireRepoSelect()

  Array.prototype.forEach.call(el.querySelectorAll('.fr-row'), function (tr) {
    tr.onclick = function () {
      var id = tr.getAttribute('data-topic')
      openTopicId = openTopicId === id ? null : id
      renderFriction()
    }
  })
  if (openTopicId) loadTopicDetail(openTopicId)
}

function wireRepoSelect() {
  var sel = $('#fr-repo')
  if (!sel) return
  sel.onchange = function () {
    repoFilter = sel.value
    openTopicId = null
    loadFriction()
  }
}

function cssId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_')
}

function loadTopicDetail(topicId) {
  var key = repoFilter + '|' + topicId
  if (detailCache[key]) {
    paintTopicDetail(topicId, detailCache[key])
    return
  }
  var qs = '?id=' + encodeURIComponent(topicId) + (repoFilter ? '&repo=' + encodeURIComponent(repoFilter) : '')
  get('/api/friction/topic' + qs).then(function (events) {
    detailCache[key] = events || []
    paintTopicDetail(topicId, detailCache[key])
  })
}

function paintTopicDetail(topicId, events) {
  var el = document.getElementById('fr-detail-' + cssId(topicId))
  if (!el) return
  if (!events.length) {
    el.innerHTML = '<div class="empty">No events recorded for this topic.</div>'
    return
  }
  el.innerHTML = events
    .map(function (e) {
      var trig = TRIGGER_LABELS[e.trigger]
      return (
        '<div class="fr-ev">' +
        '<div class="fr-ev-head">' +
        '<a class="fr-sess" data-session="' + esc(e.sessionId) + '">' + esc(e.sessionTitle || e.sessionId) + '</a>' +
        '<span class="fr-ev-meta">' + esc(dayOf(e.startedAt)) + (trig ? ' · ' + trig : '') + '</span>' +
        '</div>' +
        '<div class="fr-ev-desc">' + esc(e.description) + '</div>' +
        (e.evidence ? '<blockquote class="fr-quote">&ldquo;' + esc(e.evidence) + '&rdquo;</blockquote>' : '') +
        '</div>'
      )
    })
    .join('')
  Array.prototype.forEach.call(el.querySelectorAll('.fr-sess'), function (a) {
    a.onclick = function (ev) {
      ev.stopPropagation() // don't toggle the topic row
      openDetail(a.getAttribute('data-session'))
    }
  })
}
