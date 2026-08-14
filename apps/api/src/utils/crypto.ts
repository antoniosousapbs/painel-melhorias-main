import crypto from 'crypto';

/**
 * Criptografia simétrica (AES-256-GCM) para segredos guardados no banco
 * (hoje: chaves de API de provedores de LLM). NUNCA gravar segredos em texto
 * puro no banco de dados.
 *
 * A chave é derivada de CONFIG_ENCRYPTION_KEY (recomendado, defina no .env).
 * Se não configurada, cai para JWT_SECRET como fallback — funciona, mas o
 * ideal é ter uma chave dedicada só para isso.
 */
function getKey(): Buffer {
  const secret = process.env.CONFIG_ENCRYPTION_KEY || process.env.JWT_SECRET || 'painelbacklog-fallback-key';
  return crypto.createHash('sha256').update(secret).digest();
}

/** Criptografa um texto. Retorna string no formato "iv:authTag:ciphertext" (hex). */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/** Descriptografa um texto gerado por encryptSecret. */
export function decryptSecret(encoded: string): string {
  const [ivHex, authTagHex, ciphertextHex] = encoded.split(':');
  if (!ivHex || !authTagHex || !ciphertextHex) throw new Error('Formato de segredo criptografado inválido');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString('utf8');
}

/** Máscara para exibir na UI sem revelar o segredo (ex: "••••••••cdef"). */
export function maskSecret(plain: string): string {
  if (!plain || plain.length <= 4) return '••••';
  return `••••••••${plain.slice(-4)}`;
}
