# Sets up 4 parallel Claude Code sessions, each in its own git worktree and branch,
# with its own .env, keys copy, port and task prompt, then launches them.
#
# Run from the main repo folder:
#   powershell -ExecutionPolicy Bypass -File .\scripts\parallel\start-parallel.ps1
# Add -VSCode to also open each worktree in its own VS Code window.

param([switch]$VSCode)

function Fail([string]$msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

function Write-Utf8NoBom([string]$file, [string[]]$lines) {
  [System.IO.File]::WriteAllLines($file, $lines, (New-Object System.Text.UTF8Encoding($false)))
}

function Set-EnvValue([string]$file, [string]$key, [string]$value) {
  $lines = @()
  if (Test-Path $file) { $lines = @(Get-Content $file) }
  $found = $false
  $out = @()
  foreach ($l in $lines) {
    if ($l -match ("^\s*" + [regex]::Escape($key) + "\s*=")) { $found = $true; $out += "$key=$value" }
    else { $out += $l }
  }
  if (-not $found) { $out += "$key=$value" }
  Write-Utf8NoBom $file $out
}

# ---------- checks ----------
$repo = (git rev-parse --show-toplevel 2>$null)
if (-not $repo) { Fail "Run this from inside the Upstream repo." }
$repo = $repo.Trim()
Set-Location $repo
$parent = Split-Path $repo -Parent

if (git status --porcelain) { Fail "Your working tree has uncommitted changes. Commit them first (git add -A; git commit -m '...')." }
if (-not (Test-Path "$repo\keys")) { Fail "keys\ not found. Run 'npm run keys' first." }
if (-not (Test-Path "$repo\.env")) {
  if (Test-Path "$repo\.env.example") { Copy-Item "$repo\.env.example" "$repo\.env" }
  else { Fail ".env and .env.example are both missing." }
}
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Fail "The 'claude' command was not found. Install Claude Code or open it manually." }

# Keep SESSION_PROMPT.md out of every worktree's commits (info/exclude is shared by all worktrees)
$common = (git rev-parse --git-common-dir).Trim()
if (-not [System.IO.Path]::IsPathRooted($common)) { $common = Join-Path $repo $common }
$exclude = Join-Path $common "info\exclude"
New-Item -ItemType Directory -Force (Split-Path $exclude) | Out-Null
if (-not (Test-Path $exclude) -or -not (Select-String -Path $exclude -Pattern '^SESSION_PROMPT\.md$' -Quiet)) {
  Add-Content $exclude "SESSION_PROMPT.md"
}

# ---------- LLM key for Lisa's agent (kept out of chat and git) ----------
$llmProvider = Read-Host "LLM provider for Lisa's agent (anthropic / openai, or press Enter to skip)"
$llmKey = ""
if ($llmProvider) {
  $sec = Read-Host "Paste the $llmProvider API key (input is hidden)" -AsSecureString
  $llmKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}

# ---------- prompts ----------
$preamble = @'
# Session instructions

You are one of 4 parallel Claude Code sessions, each on its own git branch in its own worktree folder.
Read AGENTS.md and PROJECT_BRIEF.md first. Everything runs with DRY_RUN=true; the wallet is blocked and handled later.

Rules:
- Only edit the files listed as yours below. In the root package.json, only add your own script lines.
- Don't change existing behaviour or shared types. If you truly need a change outside your files, write it in NOTES-<your branch>.md instead.
- Your .env already has your own PORT, SERVER_URL and VITE_SERVER_URL. Your data/ folder is separate from the other sessions because you are in your own worktree.
- Before every commit: `npm test` and `npx tsc --noEmit` pass, and `git status` shows no keys/, data/, .env or SESSION_PROMPT.md.
- Commit to this branch only, with clear messages. Do not merge, do not push, do not touch main.
- When done, summarise what you changed and how to test it, then stop.
'@

$sessions = @(
  @{ Name = "lisa"; Branch = "phase6-lisa"; Port = 8801; Task = @'
## Your task: Phase 6 - Lisa's LLM agent

Your files: agents/lisa.ts, agents/tools/**, plus a `lisa` script in package.json.

- Follow Phase 6 of PROJECT_BRIEF.md.
- Read the LLM settings from .env: LLM_PROVIDER (anthropic or openai) and LLM_API_KEY. Add both (with empty values) to .env.example. Never print the key.
- Each tool is wrapped in the existing paidTool. Log every tool call with its payment txid.
- It must run end to end in dry-run against your own server.
'@ },
  @{ Name = "swarm"; Branch = "phase7-swarm"; Port = 8802; Task = @'
## Your task: Phase 7 - swarm, whale and sybil attacker

Your files: agents/swarm.ts, agents/whale.ts, agents/sybil.ts, agents/lib/swarm/**, plus their scripts in package.json.

- Follow Phase 7 of PROJECT_BRIEF.md.
- Use the existing contribute() directly. Do not depend on Lisa's tools (another session is building them).
- Weight usage so small libraries (stream-utils, compress-lite) get most supporters.
- Make duration and delay configurable in .env (SWARM_DURATION_SEC, SWARM_DELAY_MS) and add them to .env.example. Add a short `swarm:demo` preset of about 60 seconds.
- The sybil agents must be rejected by the tally.
- Test everything in dry-run against your own server.
'@ },
  @{ Name = "settle"; Branch = "phase9-settle"; Port = 8803; Task = @'
## Your task: Phase 9 - settlement, plus `npm run demo:check`

Your files: server/src/settlement*, a new web/src/SettlementPanel.tsx (wire it into App.tsx with the smallest possible change), scripts/demo-check.ts, plus their scripts in package.json.

- GET /settlement/preview: one P2PKH output per project with match > 0, plus an OP_RETURN containing the SHA-256 of the round results JSON.
- SettlementPanel: a "Preview settlement" button (must work now) and a "Settle round" button that calls BSV Desktop createAction. It can't be tested yet because the wallet is blocked, so make it correct per Appendix A.
- `npm run demo:check` prints: live vs dry-run, which agents hold real vs synthetic coins, tally server status, and wallet status.
'@ },
  @{ Name = "docs"; Branch = "phase10-docs"; Port = 8804; Task = @'
## Your task: Phase 10 - docs. Do not edit any code.

Your files: README.md, docs/ARCHITECTURE.md (with a mermaid diagram), docs/DEMO_SCRIPT.md (the 2.5-minute video script from the brief), docs/DEVFOLIO.md (problem, target users, how people use it, what it brings to BSV), docs/tx-links.md (placeholders for WhatsOnChain links).

- Lead the pitch with security incidents caused by underfunded maintainers: Heartbleed, event-stream, Log4Shell, colors.js/faker.js, xz.
- Explain simply that on BSV a wallet is just a key, so agents can create one instantly, and that maintainers would publish their address in package.json's `funding` field.
- README: what it is, setup, run order, the DRY_RUN vs live switch, and the go-live checklist.
- Read the code so everything you write is accurate. Mark features still being built in other sessions (Lisa's agent, swarm, settlement) as such.
'@ }
)

# ---------- create worktrees ----------
foreach ($s in $sessions) {
  $path = Join-Path $parent ("up-" + $s.Name)
  Write-Host ""
  Write-Host "=== $($s.Name): $path ($($s.Branch), port $($s.Port)) ===" -ForegroundColor Cyan

  if (Test-Path $path) {
    Write-Host "Folder exists - reusing it."
  } else {
    git show-ref --verify --quiet "refs/heads/$($s.Branch)"
    if ($LASTEXITCODE -eq 0) { git worktree add $path $s.Branch }
    else { git worktree add $path -b $s.Branch }
    if ($LASTEXITCODE -ne 0) { Fail "Could not create worktree $path" }
  }

  Copy-Item "$repo\.env" "$path\.env" -Force
  if (Test-Path "$path\keys") { Remove-Item -Recurse -Force "$path\keys" }
  Copy-Item -Recurse "$repo\keys" "$path\keys"

  $url = "http://localhost:$($s.Port)"
  Set-EnvValue "$path\.env" "PORT" "$($s.Port)"
  Set-EnvValue "$path\.env" "SERVER_URL" $url
  Set-EnvValue "$path\.env" "VITE_SERVER_URL" $url
  Set-EnvValue "$path\.env" "DRY_RUN" "true"
  if ($s.Name -eq "lisa" -and $llmKey) {
    Set-EnvValue "$path\.env" "LLM_PROVIDER" $llmProvider
    Set-EnvValue "$path\.env" "LLM_API_KEY" $llmKey
  }

  $prompt = $preamble + "`r`n`r`n" + $s.Task
  [System.IO.File]::WriteAllText("$path\SESSION_PROMPT.md", $prompt, (New-Object System.Text.UTF8Encoding($false)))

  Write-Host "Installing packages..."
  Push-Location $path
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "npm install failed in $path" }
  Pop-Location
}

# ---------- launch ----------
Write-Host ""
Write-Host "Launching 4 Claude Code sessions in separate windows..." -ForegroundColor Green
foreach ($s in $sessions) {
  $path = Join-Path $parent ("up-" + $s.Name)
  $cmd = "Set-Location '$path'; `$host.UI.RawUI.WindowTitle = 'Upstream - $($s.Name)'; claude 'Read SESSION_PROMPT.md and follow it exactly.'"
  Start-Process powershell -ArgumentList "-NoExit", "-Command", $cmd
  if ($VSCode -and (Get-Command code -ErrorAction SilentlyContinue)) { code $path }
}

Write-Host ""
Write-Host "Done. Each window is titled 'Upstream - <name>'. Approve permission prompts in each window as they come up." -ForegroundColor Green
Write-Host "When all 4 say they're done, run: powershell -ExecutionPolicy Bypass -File .\scripts\parallel\merge-parallel.ps1" -ForegroundColor Green
