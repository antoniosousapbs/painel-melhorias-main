/**
 * Guarda de regressão do PDF "Auditoria da Comunicação" (generateApfAuditoriaPdf).
 *
 * SÓ FAZ LEITURA (SELECT em WorkItems/DocumentVersionHistory) — nenhuma mutação, seguro
 * de rodar contra o banco de dev a qualquer momento. Usa o primeiro WorkItemId real que
 * encontrar (não fabrica dados sintéticos, porque a função consulta o banco diretamente
 * por design — gera sempre "na hora", nunca a partir de um objeto passado por parâmetro).
 *
 * Rode após qualquer alteração em generateApfAuditoriaPdf() ou em getApfVersionHistory():
 *   npx tsx src/db/verify-apf-auditoria-pdf.ts
 */
import { getPool } from './connection.js';
import { generateApfAuditoriaPdf } from '../services/document-generator.js';

function fail(msg: string): never {
  console.error(`❌ FALHOU: ${msg}`);
  process.exit(1);
}

async function main() {
  const pool = await getPool();
  const r = await pool.request().query(`SELECT TOP 1 Id FROM WorkItems ORDER BY Id`);
  const id = r.recordset[0]?.Id;
  if (!id) {
    console.log('⚠️  Nenhum WorkItem encontrado no banco — pulando verificação (não é uma falha).');
    process.exit(0);
  }

  console.log(`🔎 Gerando PDF de Auditoria pro chamado #${id} (somente leitura, nenhuma mutação)...`);
  const buffer = await generateApfAuditoriaPdf(id);

  if (!buffer || buffer.length < 200) fail('PDF gerado ficou vazio ou suspeito de erro (tamanho < 200 bytes).');
  if (buffer.subarray(0, 4).toString('latin1') !== '%PDF') fail('Buffer gerado não começa com o cabeçalho "%PDF" — não é um PDF válido.');
  console.log(`✅ PDF gerado com sucesso (${buffer.length} bytes, cabeçalho %PDF válido).`);

  console.log('\n🎉 Verificação do PDF de Auditoria passou — sem regressão.');
  process.exit(0);
}

main().catch(e => { console.error('❌ Erro inesperado:', e); process.exit(1); });
