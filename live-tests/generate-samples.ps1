# live-tests/generate-samples.ps1 — régénère les échantillons audio français
# (voix de synthèse Windows SAPI "Hortense" — PAS une voix humaine, voir le
# rapport livré pour cette limite) utilisés par deepgram-live-test.js.
#
# USAGE : powershell -File live-tests/generate-samples.ps1
#         puis : node live-tests/resample.js   (22050Hz -> 16000Hz mono PCM16)
#
# Les .wav générés ne sont PAS commités (voir .gitignore) — reproductibles
# à volonté via ce script, comme poc-qwen3-asr/ le fait déjà pour ses propres
# échantillons.

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice("Microsoft Hortense Desktop")
$synth.Rate = -1

$sentences = @{
  "testA" = "Jean chapitre trois verset seize."
  "testB" = "Premier Corinthiens chapitre treize verset quatre."
  "testC" = "Nous allons lire dans Jean, chapitre trois, verset seize."
  "testD" = "Bonjour à tous, nous allons commencer le culte."
}

$dir = Join-Path $PSScriptRoot "samples"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

foreach ($key in $sentences.Keys) {
  $path = Join-Path $dir "$key`_raw.wav"
  $synth.SetOutputToWaveFile($path)
  $synth.Speak($sentences[$key])
  $synth.SetOutputToNull()
  Write-Output "$key -> $path : $($sentences[$key])"
}
