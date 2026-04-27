# Build optar JARs on Windows. Requires JDK 17+ (javac, jar on PATH).
#
# Usage: .\build.ps1 [all|combined|encode|decode]  (default: all)
param(
    [ValidateSet('all','combined','encode','decode')]
    [string]$Target = 'all'
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)

$Src = 'src/main/java'
$Res = 'src/main/resources'
$Out = 'build/classes'
$Pkg = 'com/twibright/optar'

if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
New-Item -ItemType Directory -Path $Out | Out-Null

$sources = Get-ChildItem -Path $Src -Recurse -Filter *.java | ForEach-Object { $_.FullName }
& javac -d $Out -encoding UTF-8 @sources
if ($LASTEXITCODE -ne 0) { throw 'javac failed' }

if (Test-Path $Res) {
    Copy-Item -Path (Join-Path $Res '*') -Destination $Out -Recurse -Force
}

function Build-Combined {
    & jar --create --file=optar.jar --main-class=com.twibright.optar.Main -C $Out .
    if ($LASTEXITCODE -ne 0) { throw 'jar failed' }
    Write-Host 'Built optar.jar'
}

function Build-Subset {
    param([string]$JarName, [string]$MainClass, [string[]]$Classes)

    $staging = Join-Path $env:TEMP ("optar-stage-" + [guid]::NewGuid())
    $stagedPkg = Join-Path $staging $Pkg
    New-Item -ItemType Directory -Path $stagedPkg | Out-Null
    try {
        $always = @('Common','Bch','Pgm')
        foreach ($cls in ($always + $Classes)) {
            $main = Join-Path $Out "$Pkg/$cls.class"
            if (Test-Path $main) { Copy-Item $main $stagedPkg }
            Get-ChildItem -Path (Join-Path $Out $Pkg) -Filter "$cls`$*.class" -ErrorAction SilentlyContinue |
                ForEach-Object { Copy-Item $_.FullName $stagedPkg }
        }
        Get-ChildItem -Path $Out -Recurse -File | Where-Object { $_.Extension -ne '.class' } | ForEach-Object {
            $rel = $_.FullName.Substring((Resolve-Path $Out).Path.Length).TrimStart('\','/')
            $dest = Join-Path $staging $rel
            New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
            Copy-Item $_.FullName $dest
        }
        & jar --create --file=$JarName --main-class=$MainClass -C $staging .
        if ($LASTEXITCODE -ne 0) { throw 'jar failed' }
        Write-Host "Built $JarName"
    }
    finally {
        Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}

switch ($Target) {
    'all' {
        Build-Combined
        Build-Subset 'optar-encode.jar' 'com.twibright.optar.Optar'   @('Optar','Font')
        Build-Subset 'optar-decode.jar' 'com.twibright.optar.Unoptar' @('Unoptar','PngReader')
    }
    'combined' { Build-Combined }
    'encode'   { Build-Subset 'optar-encode.jar' 'com.twibright.optar.Optar'   @('Optar','Font') }
    'decode'   { Build-Subset 'optar-decode.jar' 'com.twibright.optar.Unoptar' @('Unoptar','PngReader') }
}
