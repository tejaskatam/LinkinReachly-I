import { getExecutionById, normalizeExecutionSlug } from './executions'
import { isLinkedInUrl } from './linkedin-url'
import type { TargetRow } from './types'

type CsvParseDiagnostics = {
  targets: TargetRow[]
  /** Explanations for the operator (empty CSV, wrong column, partial skip). */
  issues: string[]
}

function missingHeadersForExecution(
  header: string[],
  required: string[]
): string[] {
  const set = new Set(header.map((h) => h.trim().toLowerCase()))
  return required.filter((r) => !set.has(r.toLowerCase()))
}

function executionCsvHeaderHints(
  headerLine: string,
  runExecutionId: string
): string[] {
  const ex = getExecutionById(runExecutionId)
  if (!ex || ex.requiredCsvHeaders.length === 0) return []
  const header = headerLine.split(',').map((h) => h.trim().toLowerCase().replace(/"/g, ''))
  const miss = missingHeadersForExecution(header, ex.requiredCsvHeaders)
  if (miss.length === 0) return []
  return [
    `For this execution (${ex.label}) you can include labeled columns: ${miss.join(', ')} missing — optional but improves copy.`
  ]
}

function splitCsvCells(line: string): string[] {
  return line.match(/("([^"]|"")*"|[^,]*)/g)?.map((c) => c.replace(/^"|"$/g, '').replace(/""/g, '"')) ?? []
}

function firstNameFromText(text: string): string | undefined {
  const first = text.trim().split(/\s+/)[0] || ''
  return first || undefined
}

function buildSearchQuery(name?: string, company?: string, raw?: string): string | undefined {
  const query = [name, company].map((value) => String(value || '').trim()).filter(Boolean).join(' ').trim()
  if (query) return query
  const fallback = String(raw || '').trim()
  return fallback || undefined
}

function parseLooseTargetLine(raw: string): TargetRow[] {
  const cols = splitCsvCells(raw).map((cell) => cell.trim()).filter(Boolean)
  if (cols.length === 0) return []

  const urlIdx = cols.findIndex((cell) => isLinkedInUrl(cell))
  if (urlIdx >= 0) {
    const profileUrl = cols[urlIdx]!.trim()
    const row: TargetRow = { profileUrl }
    if (urlIdx === 0) {
      const after = cols.slice(1)
      if (after[0]) row.firstName = after[0]
      if (after[0]) row.personName = after[0]
      if (after[1]) row.company = after[1]
      if (after[2]) row.headline = after[2]
    }
    return [row]
  }

  const primary = cols[0] || ''
  const secondary = cols[1] || ''
  const tertiary = cols[2] || ''
  const name = primary
  const nameLooksHuman = name.split(/\s+/).filter(Boolean).length >= 2
  if (!secondary && !nameLooksHuman) return []
  const query = buildSearchQuery(name, secondary, raw)
  if (!query || query.replace(/\s+/g, ' ').trim().length < 5) return []
  return [
    {
      profileUrl: '',
      personName: name || undefined,
      firstName: firstNameFromText(name || secondary || query),
      company: secondary || undefined,
      headline: tertiary || undefined,
      searchQuery: query
    }
  ]
}

function looksLikeHeaderLine(tokens: string[]): boolean {
  const known = new Set([
    'profileurl',
    'linkedin_url',
    'url',
    'profile_url',
    'linkedin_profile_url',
    'linkedin',
    'name',
    'person',
    'person_name',
    'principal_name',
    'firstname',
    'first_name',
    'company',
    'firm_name',
    'headline',
    'title',
    'search_query',
    'query',
    'execution',
    'execution_id',
    'signal'
  ])
  return tokens.some(
    (token) =>
      known.has(token) ||
      token.includes('profileurl') ||
      (token.includes('linkedin') && token.includes('url'))
  )
}

export function parseTargetsCsv(text: string): TargetRow[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean)
  if (lines.length === 0) return []

  if (lines.length === 1) {
    const singleHeader = lines[0]!.split(',').map((h) => h.trim().toLowerCase().replace(/"/g, ''))
    if (looksLikeHeaderLine(singleHeader)) return []
    return parseLooseTargetLine(lines[0]!)
  }

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/"/g, ''))
  if (!looksLikeHeaderLine(header)) {
    return lines.flatMap((line) => parseLooseTargetLine(line))
  }
  const urlKeys = [
    'profileurl',
    'linkedin_url',
    'url',
    'profile_url',
    'linkedin_profile_url',
    'linkedin'
  ]
  let urlIdx = header.findIndex((h) => urlKeys.includes(h))
  if (urlIdx < 0) {
    urlIdx = header.findIndex((h) => h.includes('linkedin') && h.includes('url'))
  }
  const hasExplicitUrlHeader = urlIdx >= 0
  if (urlIdx < 0) urlIdx = 0

  const rows: TargetRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvCells(lines[i])
    if (!cols.length) continue
    const profileUrl = (cols[urlIdx] || '').trim()
    if (hasExplicitUrlHeader && (!profileUrl || !isLinkedInUrl(profileUrl))) continue

    const row: TargetRow = { profileUrl: isLinkedInUrl(profileUrl) ? profileUrl : '' }
    header.forEach((key, j) => {
      if (cols[j] != null) row[key] = cols[j].trim()
    })
    if (row.firstname && !row.first_name) row.firstName = row.firstname
    if (row.principal_name && !row.firstName) row.firstName = String(row.principal_name).split(/\s+/)[0]
    if (row.name && !row.personName) row.personName = row.name
    if (row.principal_name && !row.personName) row.personName = row.principal_name
    if (row.firstName && !row.personName) row.personName = row.firstName
    if (row.firm_name && !row.company) row.company = row.firm_name
    if (row.query && !row.searchQuery) row.searchQuery = row.query
    if (row.search_query && !row.searchQuery) row.searchQuery = row.search_query
    const hasPersonIdentity = !!String(row.personName || row.firstName || row.principal_name || row.name || '').trim()
    if (!row.searchQuery && !hasExplicitUrlHeader && hasPersonIdentity) {
      row.searchQuery = buildSearchQuery(row.personName, row.company, lines[i])
    }
    const execFromRow =
      normalizeExecutionSlug(row.executionid) ||
      normalizeExecutionSlug(row.execution_id) ||
      normalizeExecutionSlug(row.execution) ||
      normalizeExecutionSlug(row.signal)
    if (execFromRow) row.executionId = execFromRow
    const hasRunnableLocator = isLinkedInUrl(row.profileUrl) || !!String(row.searchQuery || '').trim()
    if (!hasRunnableLocator) continue
    rows.push(row)
  }
  return rows
}

export function parseTargetsCsvWithDiagnostics(
  text: string,
  opts?: { runExecutionId?: string }
): CsvParseDiagnostics {
  const targets = parseTargetsCsv(text)
  const issues: string[] = []
  const runId = opts?.runExecutionId
  const lines = text.trim().split(/\r?\n/).filter(Boolean)
  const header = lines[0]?.split(',').map((h) => h.trim().toLowerCase().replace(/"/g, '')) ?? []
  const headerLike = looksLikeHeaderLine(header)
  if (lines.length === 0) {
    issues.push(
      'The list is empty. Paste LinkedIn profile links, names, or name/company rows.'
    )
    return { targets, issues }
  }
  if (lines.length === 1 && targets.length === 0) {
    if (headerLike) {
      issues.push(
        'We only see a header row. Add one person per line below it, or just paste LinkedIn links or names directly.'
      )
      return { targets, issues }
    }
    issues.push(
      'We could not turn that line into a LinkedIn target. Paste a full LinkedIn profile URL, a person name, or a line like "Jane Doe, Firm Name".'
    )
    return { targets, issues }
  }
  const dataLineCount = headerLike ? lines.length - 1 : lines.length
  const dataBody = headerLike ? lines.slice(1).join('\n') : lines.join('\n')
  const anyLinkedInInBody = dataBody.includes('linkedin.com')
  if (targets.length === 0) {
    if (anyLinkedInInBody) {
      issues.push(
        'LinkedIn URLs appear in the list but no row parsed as valid. Use a full https://www.linkedin.com/... link, or paste names/company rows.'
      )
    } else {
      issues.push(
        'No usable targets found. Paste LinkedIn profile links, names, or rows like "Jane Doe, Firm Name".'
      )
    }
    return { targets, issues }
  }
  if (targets.length < dataLineCount) {
    const skipped = dataLineCount - targets.length
    issues.push(
      `${skipped} row(s) were skipped. ${targets.length} target(s) are ready to run.`
    )
  }
  if (runId && headerLike && lines.length > 1) {
    for (const hint of executionCsvHeaderHints(lines[0], runId)) issues.push(hint)
  }
  return { targets, issues }
}
