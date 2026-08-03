# CI build wrapper — env placeholders live here, not in .github/workflows/,
# so verify:keepalive O6 (no service-role literal under .github/**) stays green.
$env:NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "ci-placeholder-service-role-key"
$env:NETLIFY_SITE_ID = "ci-placeholder-site-id"
$env:NETLIFY_TOKEN = "ci-placeholder-netlify-token"
$env:LOCAL_STORAGE_ROOT = "C:\ci-storage"
$env:REDIS_URL = "redis://127.0.0.1:6379"
$env:APP_PASSWORD = "ci-placeholder-password"
$env:SESSION_SECRET = "ci-placeholder-session-secret-32chars"

npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
