# First-time push to GitHub
# Usage (from project root): powershell -ExecutionPolicy Bypass -File .\scripts\git-first-push.ps1

$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $ProjectRoot

$Remote = "https://github.com/mjmjPlaces/meetatmiddle.git"

function Require-Git {
  $git = Get-Command git -ErrorAction SilentlyContinue
  if (-not $git) {
    Write-Host "Git이 PATH에 없습니다. Git for Windows를 설치하거나 Git Bash에서 이 스크립트 내용을 수동 실행하세요."
    Write-Host "https://git-scm.com/download/win"
    exit 1
  }
}

Require-Git

if (-not (Test-Path ".git")) {
  git init
}

git add .
git status

$status = git status --porcelain
if ($status) {
  git commit -m "Initial commit: Midpoint Navigator"
} else {
  Write-Host "커밋할 변경 없음 (이미 최신 커밋 상태일 수 있음)"
}

git branch -M main

$hasOrigin = git remote 2>$null | Select-String -Pattern "^origin$"
if ($hasOrigin) {
  git remote set-url origin $Remote
} else {
  git remote add origin $Remote
}

Write-Host "원격: $(git remote get-url origin)"
Write-Host "푸시 시도 중..."

try {
  git push -u origin main
} catch {
  Write-Host "push 실패 시 GitHub에 README만 있는 경우 다음 후 재시도:"
  Write-Host "  git pull origin main --allow-unrelated-histories"
  Write-Host "  (충돌 해결 후) git add . && git commit -m Merge && git push -u origin main"
  throw
}

Write-Host "완료: https://github.com/mjmjPlaces/meetatmiddle"
