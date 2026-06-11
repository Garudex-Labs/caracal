// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Interactive third-party agent that answers with Google Drive, Calendar, and OpenAI.

// This agent is deliberately Caracal-unaware. It has no Caracal dependency,
// never talks to STS or the Gateway, and reads only provider-native
// environment variables. `caracal run` exchanges short-lived credentials and
// injects them into this process; the agent works exactly like any existing
// CLI tool that expects Google OAuth tokens and an OpenAI key in its env.

import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const GOOGLE_API = 'https://www.googleapis.com'
const OPENAI_API = 'https://api.openai.com/v1'
const MODEL = 'gpt-5.4-mini'

const CREDENTIALS = [
  { env: 'GOOGLE_DRIVE_ACCESS_TOKEN', service: 'Google Drive (read-only scope)' },
  { env: 'GOOGLE_CALENDAR_ACCESS_TOKEN', service: 'Google Calendar (read-only scope)' },
  { env: 'OPENAI_API_KEY', service: 'OpenAI' },
]

// Credentials exist only in this process env. Values are never logged,
// written to disk, or passed to subprocesses.
function preflight() {
  const missing = CREDENTIALS.filter(({ env }) => !process.env[env])
  if (missing.length > 0) {
    for (const { env } of missing) {
      process.stderr.write(`[agent] missing ${env}; launch through \`caracal run\` so the credential is injected\n`)
    }
    process.exit(2)
  }
  output.write('[agent] credential preflight (values masked, injected by launcher):\n')
  for (const { env, service } of CREDENTIALS) {
    output.write(`[agent]   ${env}  present  -> ${service}\n`)
  }
}

preflight()

const GOOGLE_DRIVE_ACCESS_TOKEN = process.env.GOOGLE_DRIVE_ACCESS_TOKEN
const GOOGLE_CALENDAR_ACCESS_TOKEN = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN
const OPENAI_API_KEY = process.env.OPENAI_API_KEY

function driveQuery(question) {
  const cleaned = question.replace(/['\\]/g, ' ').trim().split(/\s+/).slice(0, 8).join(' ')
  if (!cleaned) return 'trashed = false'
  return `fullText contains '${cleaned}' and trashed = false`
}

async function googleJson(url, token, label) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`${label}_failed status=${res.status} body=${detail}`)
  }
  return await res.json()
}

async function googleText(url, token, label) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`${label}_failed status=${res.status} body=${detail}`)
  }
  return await res.text()
}

async function driveContext(question) {
  const params = new URLSearchParams({
    q: driveQuery(question),
    fields: 'files(id,name,mimeType,modifiedTime)',
    pageSize: '3',
  })
  const files = await googleJson(`${GOOGLE_API}/drive/v3/files?${params}`, GOOGLE_DRIVE_ACCESS_TOKEN, 'google_drive_search')
  const results = []
  for (const file of files.files ?? []) {
    let text = ''
    if (file.mimeType === 'application/vnd.google-apps.document') {
      text = await googleText(
        `${GOOGLE_API}/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=text/plain`,
        GOOGLE_DRIVE_ACCESS_TOKEN,
        'google_drive_export',
      )
    }
    results.push({
      name: file.name,
      modifiedTime: file.modifiedTime,
      text: text.slice(0, 2000),
    })
  }
  output.write(`[agent] drive: ${results.length} matching document(s)\n`)
  return results
}

async function calendarContext(question) {
  const now = Date.now()
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
    timeMax: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
    maxResults: '10',
    q: question,
  })
  const events = await googleJson(
    `${GOOGLE_API}/calendar/v3/calendars/primary/events?${params}`,
    GOOGLE_CALENDAR_ACCESS_TOKEN,
    'google_calendar_events',
  )
  const items = (events.items ?? []).map((event) => ({
    summary: event.summary,
    start: event.start?.dateTime ?? event.start?.date,
    end: event.end?.dateTime ?? event.end?.date,
    description: event.description,
  }))
  output.write(`[agent] calendar: ${items.length} relevant event(s)\n`)
  return items
}

async function answer(question, drive, calendar) {
  const res = await fetch(`${OPENAI_API}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: 'You are a concise operations assistant. Answer using only the supplied Google Drive and Calendar context. If context is missing, say what is missing.',
        },
        {
          role: 'user',
          content: JSON.stringify({ question, drive, calendar }),
        },
      ],
    }),
  })
  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`openai_call_failed status=${res.status} body=${detail}`)
  }
  const data = await res.json()
  output.write(`[agent] openai: answered with ${MODEL}\n`)
  return data.choices[0].message.content
}

async function respond(question) {
  const [drive, calendar] = await Promise.all([
    driveContext(question),
    calendarContext(question),
  ])
  return await answer(question, drive, calendar)
}

async function main() {
  const rl = createInterface({ input, output })
  output.write('Caracal run research agent ready. Ask about Drive docs or Calendar events. Type "exit" to quit.\n')
  try {
    while (true) {
      const question = (await rl.question('> ')).trim()
      if (!question || ['exit', 'quit'].includes(question.toLowerCase())) break
      const response = await respond(question)
      output.write(`${response}\n`)
    }
  } finally {
    rl.close()
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
