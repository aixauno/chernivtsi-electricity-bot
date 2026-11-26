param([switch]$ProbarEnvio, [switch]$ActivarWebhook)

$ErrorActionPreference = 'Stop'
$secretPath = $null
Push-Location -LiteralPath $PSScriptRoot
try {
    $secureToken = Read-Host 'Token de BotFather (entrada oculta)' -AsSecureString
    $token = [System.Net.NetworkCredential]::new('', $secureToken).Password.Trim()
    if ($token -notmatch '^\d+:[A-Za-z0-9_-]+$') {
        throw 'El token tiene un formato invalido.'
    }

    if ($ActivarWebhook) {
        $webhookUrl = 'https://chernivtsi-electricity-bot.aixauno.workers.dev/telegram'
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            $digest = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes('telegram-webhook:' + $token))
            $secret = [BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant()
        } finally {
            $sha.Dispose()
        }
        try {
            $probe = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $webhookUrl -Headers @{
                'X-Telegram-Bot-Api-Secret-Token' = $secret
            } -ContentType 'application/json' -Body '{"update_id":-1}' -TimeoutSec 15
            if ($probe.StatusCode -ne 204) { throw 'Unexpected webhook response.' }
            $settings = @{
                url = $webhookUrl
                secret_token = $secret
                allowed_updates = @('message')
                max_connections = 1
            } | ConvertTo-Json -Compress
            $registered = Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/setWebhook" -ContentType 'application/json' -Body $settings -TimeoutSec 15
            if (-not $registered.ok -or -not $registered.result) { throw 'Telegram rejected the webhook.' }
            $info = Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/getWebhookInfo" -TimeoutSec 15
            if (-not $info.ok -or $info.result.url -ne $webhookUrl) { throw 'Telegram did not confirm the webhook.' }
        } catch {
            throw 'No se pudo confirmar el webhook. Usa el mismo token que cargaste en Cloudflare.'
        }
        Write-Host 'Webhook de Telegram activado. Prueba /language o /status.'
        return
    }

    try {
        $bot = Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/getMe" -TimeoutSec 15
        $updates = Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/getUpdates" -TimeoutSec 15
    } catch {
        throw 'La consulta a Telegram fallo. Verifica el token y que el bot pueda recibir actualizaciones.'
    }

    $chatIds = @($updates.result | Where-Object {
        $_.message.chat.type -eq 'private' -and $_.message.text -match '^/start(?:\s|$)'
    } | ForEach-Object { [string]$_.message.chat.id } | Sort-Object -Unique)
    if ($chatIds.Count -ne 1) {
        throw 'Se necesita un solo chat privado con /start pendiente. Envia /start al bot y vuelve a ejecutar el script.'
    }

    Write-Host "Bot @$($bot.result.username), chat privado $($chatIds[0])."
    if ($ProbarEnvio) {
        if ((Read-Host 'Si es tu chat, escribe SI para enviar el aviso de prueba') -ne 'SI') { return }
        $message = @{ chat_id = $chatIds[0]; text = 'Prueba del bot de Chernivtsi para el grupo 10.' } | ConvertTo-Json -Compress
        try {
            $sent = Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/sendMessage" -ContentType 'application/json' -Body $message -TimeoutSec 15
            if (-not $sent.ok) { throw 'Telegram rechazo el envio.' }
        } catch {
            throw 'Telegram no confirmo el aviso de prueba.'
        }
        Write-Host "Telegram confirmo el envio. ID del mensaje: $($sent.result.message_id)."
        return
    }
    if ((Read-Host 'Si es tu chat, escribe SI para desplegar') -ne 'SI') { return }
    $secretPath = [IO.Path]::GetTempFileName()
    $secrets = @{ TELEGRAM_BOT_TOKEN = $token; TELEGRAM_CHAT_ID = $chatIds[0] } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($secretPath, $secrets)
    & npx.cmd --no-install wrangler deploy --secrets-file $secretPath
    if ($LASTEXITCODE -ne 0) { throw 'Wrangler no completo el despliegue.' }
    Write-Host 'Despliegue completado.'
} finally {
    if ($secretPath) { Remove-Item -LiteralPath $secretPath -Force }
    if ($secureToken) { $secureToken.Dispose() }
    Pop-Location
}
