const TENANT_ID = '2ec1379e-af09-4a76-89f8-adde6b8733b4';
const CLIENT_ID = '05bd370d-71b5-41cd-87ed-aeb68a091830';

let cachedToken: string | null = null;
let cachedExpiry = 0;

/**
 * Token app-only (client credentials) do Microsoft Graph — usado para buscar fotos de
 * QUALQUER usuário do tenant (não só do usuário logado), sem depender de consentimento
 * delegado por sessão. Requer `AAD_CLIENT_SECRET` no .env + permissão de aplicação
 * `User.Read.All` (Graph) com consentimento de admin do tenant no app
 * `05bd370d-71b5-41cd-87ed-aeb68a091830` (Azure Portal > App registrations > API permissions).
 * Sem o secret configurado, retorna null e quem chamar deve degradar graciosamente
 * (a feature de foto simplesmente não funciona, sem quebrar nada).
 */
export async function getGraphAppToken(): Promise<string | null> {
  const secret = process.env.AAD_CLIENT_SECRET;
  if (!secret) return null;

  if (cachedToken && Date.now() < cachedExpiry) return cachedToken;

  try {
    const resp = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: secret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    });

    if (!resp.ok) {
      console.error('[graph-app-token] falha ao obter token app-only:', resp.status, await resp.text());
      return null;
    }

    const data = await resp.json();
    cachedToken = data.access_token;
    cachedExpiry = Date.now() + (data.expires_in - 300) * 1000; // renova 5min antes de expirar
    return cachedToken;
  } catch (err) {
    console.error('[graph-app-token] erro ao obter token app-only:', err);
    return null;
  }
}
