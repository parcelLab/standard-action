const fetch = require('node-fetch')
const { promisify } = require('util')
const { CLIEngine } = require('eslint')
const core = require('@actions/core')
const github = require('@actions/github')
const resolve = require('resolve')

const {
  GITHUB_REPOSITORY,
  GITHUB_SHA,
  GITHUB_TOKEN,
  GITHUB_WORKSPACE
} = process.env

const CHECK_NAME = 'Standard'

main().catch((err) => {
  core.setFailed(err.message)
  process.exit(1)
})

async function publishResults (results) {
  const annotations = []

  for (const result of results.results) {
    annotations.push(...toAnnotations(result))
  }

  const headers = {
    'content-type': 'application/json',
    accept: 'application/vnd.github.antiope-preview+json',
    authorization: `Bearer ${GITHUB_TOKEN}`,
    'user-agent': 'standard-action'
  }

  const check = {
    name: CHECK_NAME,
    head_sha: GITHUB_SHA,
    status: 'completed',
    started_at: new Date(),
    conclusion: results.errorCount > 0 ? 'failure' : 'success',
    output: {
      title: CHECK_NAME,
      summary: `${results.errorCount} error(s), ${results.warningCount} warning(s) found`,
      annotations
    }
  }

  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/check-runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify(check)
  })

  if (response.status !== 201) {
    // eh
    const err = await response.json()
    throw err
  }

  function toAnnotations ({ filePath, messages }) {
    const path = filePath.substr(GITHUB_WORKSPACE.length + 1)
    return messages.map(({ line, severity, ruleId, message }) => {
      const annotationLevel = {
        1: 'warning',
        2: 'failure'
      }[severity]
      return {
        path,
        start_line: line,
        end_line: line,
        annotation_level: annotationLevel,
        message: `[${ruleId}] ${message}`
      }
    })
  }
}

function printResults (results, formatStyle) {
  const formatter = CLIEngine.getFormatter(formatStyle)
  console.log(formatter(results.results, {}))
}

function getPrNumber () {
  const pullRequest = github.context.payload.pull_request
  if (!pullRequest) {
    return undefined
  }

  return pullRequest.number
}

async function getChangedFiles (
  client,
  prNumber
) {
  const listFilesResponse = await client.pulls.listFiles({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: prNumber
  })

  const changedFiles = listFilesResponse.data.map(f => f.filename)           
  const changedJsFiles = changedFiles.filter(filename => filename.endsWith('.js'))
  
  return changedJsFiles
}

function loadLinter (name) {
  let linterPath
  try {
    linterPath = resolve.sync(name, { basedir: process.cwd() })
  } catch (err) {
    if (name === 'standard') {
      linterPath = 'standard' // use our bundled standard version
    } else {
      throw new Error(`Linter '${name}' not found, perhaps you need a 'run: npm install' step before this one?`)
    }
  }

  let linter
  try {
    linter = require(linterPath)
  } catch (err) {
    throw new Error(`Linter '${name}' not found, perhaps you need a 'run: npm install' step before this one?`)
  }

  if (!linter.lintFiles) {
    throw new Error(`Module '${name}' is not a standard-compatible linter.`)
  }

  return linter
}

async function main () {
  const formatStyle = core.getInput('formatter')
  const linterName = core.getInput('linter')
  const useAnnotations = core.getInput('annotate')
  const client = new github.GitHub(process.env.GITHUB_TOKEN)
  const prNumber = getPrNumber()
  const changedFiles = await getChangedFiles(client, prNumber)
  console.log('changedFiles', changedFiles)
  if (changedFiles.length === 0) {
    console.log('no .js files were changed, exiting successfully')
    process.exit(0)
  }
  if (useAnnotations === 'true' && !process.env.GITHUB_TOKEN) {
    throw new Error(`when using annotate: true, you must set

    env:
      GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}

in your action config.`)
  }

  const linter = loadLinter(linterName)

  const lintFiles = promisify(linter.lintFiles.bind(linter))
  const results = await lintFiles(changedFiles, {
    cwd: GITHUB_WORKSPACE
  })

  printResults(results, formatStyle)

  if (useAnnotations === 'true') {
    try {
      await publishResults(results)
    } catch (err) {
      console.error(err)
      core.setFailed(err.message)
    }
  }

  if (results.errorCount > 0) {
    core.setFailed(`${results.errorCount} error(s), ${results.warningCount} warning(s) found`)
    process.exit(1)
  }
}
