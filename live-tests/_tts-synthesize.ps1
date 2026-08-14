param(
  [Parameter(Mandatory = $true)][string]$Voice,
  [Parameter(Mandatory = $true)][string]$TextFile,
  [Parameter(Mandatory = $true)][string]$OutFile
)

Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice($Voice)
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono
)
$s.SetOutputToWaveFile($OutFile, $fmt)
$s.Speak((Get-Content -Raw -LiteralPath $TextFile -Encoding UTF8))
$s.Dispose()
