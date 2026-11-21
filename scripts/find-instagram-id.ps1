# Read-only diagnostic: tries several Graph API endpoints to find which
# Instagram account(s) a Meta token can access. Never prints the token.
# Usage (PowerShell):  powershell -ExecutionPolicy Bypass -File scripts\find-instagram-id.ps1

$t = Read-Host "Paste token" -AsSecureString
$tok = ([Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($t))).Trim().Trim('"')
$g = "https://graph.facebook.com/v21.0"

$checks = [ordered]@{
  "Who am I"                    = "me?fields=id,name"
  "Permissions"                 = "me/permissions"
  "Pages + linked Instagram"    = "me/accounts?fields=id,name,instagram_business_account{id,username}"
  "Instagram accounts (direct)" = "me/instagram_accounts?fields=id,username"
  "Businesses"                  = "me/businesses?fields=id,name"
}

foreach ($name in $checks.Keys) {
  "`n=== $name ==="
  $sep = if ($checks[$name].Contains("?")) { "&" } else { "?" }
  try {
    Invoke-RestMethod "$g/$($checks[$name])$($sep)access_token=$tok" | ConvertTo-Json -Depth 6
  } catch {
    "ERROR: " + $_.ErrorDetails.Message
  }
}

Remove-Variable tok, t
