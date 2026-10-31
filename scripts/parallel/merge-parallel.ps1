# Merges the 4 parallel session branches back into main, runs the tests and pushes.
#
# Run from the main repo folder (on the main branch):
#   powershell -ExecutionPolicy Bypass -File .\scripts\parallel\merge-parallel.ps1
# Add -Cleanup to delete the 4 worktree folders afterwards.
# Safe to re-run: branches already merged are skipped automatically.

param([switch]$Cleanup)

function Fail([string]$msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

$repo = (git rev-parse --show-toplevel 2>$null)
if (-not $repo) { Fail "Run this from inside the Upstream repo." }
$repo = $repo.Trim()
Set-Location $repo
$parent = Split-Path $repo -Parent

$branch = (git branch --show-current).Trim()
if ($branch -ne "main") { Fail "You're on '$branch'. Run this from the main repo folder on the main branch." }
if (git status --porcelain) { Fail "Uncommitted changes in main. Commit them first." }

$sessions = @(
  @{ Name = "lisa";   Branch = "phase6-lisa" },
  @{ Name = "swarm";  Branch = "phase7-swarm" },
  @{ Name = "settle"; Branch = "phase9-settle" },
  @{ Name = "docs";   Branch = "phase10-docs" }
)

foreach ($s in $sessions) {
  git show-ref --verify --quiet "refs/heads/$($s.Branch)"
  if ($LASTEXITCODE -ne 0) { Write-Host "Branch $($s.Branch) not found - skipping." -ForegroundColor Yellow; continue }

  Write-Host ""
  Write-Host "=== Merging $($s.Branch) ===" -ForegroundColor Cyan
  git merge --no-edit $s.Branch
  if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Merge conflict while merging $($s.Branch)." -ForegroundColor Yellow
    Write-Host "Ask Claude Code in this folder: 'Resolve the merge conflict, keeping both sides (especially package.json scripts and .env.example), then run npm test and commit.'" -ForegroundColor Yellow
    Write-Host "Then run this script again - it continues where it stopped." -ForegroundColor Yellow
    exit 1
  }
}

Write-Host ""
Write-Host "=== Installing and testing the merged result ===" -ForegroundColor Cyan
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Fail "npm install failed after merging." }
npm test
if ($LASTEXITCODE -ne 0) { Fail "Tests fail after merging. Ask Claude Code to fix them, commit, then run this script again." }

git push
if ($LASTEXITCODE -ne 0) { Fail "git push failed. Check your connection or remote, then run 'git push' yourself." }

if ($Cleanup) {
  foreach ($s in $sessions) {
    $path = Join-Path $parent ("up-" + $s.Name)
    if (Test-Path $path) {
      Write-Host "Removing worktree $path"
      git worktree remove --force $path
    }
  }
}

Write-Host ""
Write-Host "All merged, tested and pushed." -ForegroundColor Green
Write-Host "Next: ask Claude Code in this folder to update the README so it matches the merged code." -ForegroundColor Green
