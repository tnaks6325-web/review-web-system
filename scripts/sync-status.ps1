[CmdletBinding()]
param(
  [switch]$Strict
)

$ErrorActionPreference = 'Stop'

function Invoke-GitText([string[]]$Arguments) {
  $result = & git @Arguments 2>$null
  if ($LASTEXITCODE -ne 0) { throw "Git command failed: git $($Arguments -join ' ')" }
  return ($result -join "`n").Trim()
}

$repoRoot = Invoke-GitText @('rev-parse', '--show-toplevel')
Set-Location -LiteralPath $repoRoot

# 저장소의 기본 fetch 규칙이 잘못돼 있어도 `origin/main`을 오래된 값으로 읽지 않게,
# 공통 기준 브랜치를 명시적으로 다시 받는다.
Invoke-GitText @('fetch', 'origin', '--prune', '+refs/heads/main:refs/remotes/origin/main') | Out-Null
$branch = Invoke-GitText @('branch', '--show-current')
$head = Invoke-GitText @('rev-parse', 'HEAD')
$originMain = Invoke-GitText @('rev-parse', 'origin/main')
$distance = (Invoke-GitText @('rev-list', '--left-right', '--count', 'HEAD...origin/main')).Split([char[]]" `t", [System.StringSplitOptions]::RemoveEmptyEntries)
$dirty = [bool](Invoke-GitText @('status', '--porcelain'))
$ahead = [int]$distance[0]
$behind = [int]$distance[1]

$state = if ($dirty) { 'local_changes' } elseif ($branch -eq 'main' -and $ahead -eq 0 -and $behind -eq 0) { 'aligned' } elseif ($branch -eq 'main') { 'main_out_of_date' } elseif ($behind -eq 0) { 'feature_branch_current' } else { 'feature_branch_out_of_date' }
$next = switch ($state) {
  'aligned' { 'Ready: this computer matches the shared main version.' }
  'local_changes' { 'Save, commit, or stash local changes before switching or updating branches.' }
  'main_out_of_date' { 'Run: git pull --ff-only origin main (only after confirming there are no local changes).' }
  'feature_branch_current' { 'This feature branch includes the current shared main version. Recheck again just before merge.' }
  default { 'Keep working on this feature branch. Before merge, rebase it on origin/main.' }
}

$report = [ordered]@{
  repository = Split-Path -Leaf $repoRoot
  checkedAt = (Get-Date).ToUniversalTime().ToString('o')
  branch = if ($branch) { $branch } else { '(detached HEAD)' }
  head = $head
  originMain = $originMain
  aheadOfMain = $ahead
  behindMain = $behind
  hasLocalChanges = $dirty
  state = $state
  nextAction = $next
}

$report | ConvertTo-Json -Depth 3

if ($Strict -and $state -notin @('aligned', 'feature_branch_current')) { exit 2 }
