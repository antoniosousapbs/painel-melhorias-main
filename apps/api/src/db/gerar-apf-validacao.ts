/**
 * Gera o Excel de APF de um chamado real (usando a versão mais recente já gravada em
 * DocumentVersionHistory) e salva em Downloads, pra validação visual manual após qualquer
 * alteração em generateApfExcel() ou no template.
 *
 * Uso:
 *   npx tsx src/db/gerar-apf-validacao.ts [workItemId]
 *   (padrão: 333470, o chamado usado como referência nas correções de layout)
 */
import { writeFileSync } from 'fs';
import { getPool, sql } from './connection.js';
import { generateApfExcel } from '../services/document-generator.js';

const workItemId = parseInt(process.argv[2]) || 333470;

async function main() {
  const pool = await getPool();

  const wiRow = await pool.request().input('id', sql.Int, workItemId)
    .query(`SELECT Id, Title, ClienteNome, Modulo, Description, DiscussionPati FROM WorkItems WHERE Id = @id`);
  const wi = wiRow.recordset[0];
  if (!wi) throw new Error(`Chamado #${workItemId} não encontrado`);

  const verRow = await pool.request().input('id', sql.Int, workItemId)
    .query(`SELECT TOP 1 * FROM DocumentVersionHistory WHERE WorkItemId=@id AND Tipo='APF' ORDER BY Versao DESC`);
  const version = verRow.recordset[0];
  if (!version) throw new Error(`Nenhuma versão de APF encontrada para o chamado #${workItemId}`);

  const elementos = JSON.parse(version.ElementosJson);
  const paramsRow = await pool.request().query(`SELECT TOP 1 * FROM ApfParametros`);
  const params = paramsRow.recordset[0];

  let totalPF = 0, totalPFA = 0;
  elementos.forEach((el: any) => {
    const deflator = el.operacao === 'I' ? params.DeflatorInclusao : el.operacao === 'A' ? params.DeflatorAlteracao : params.DeflatorExclusao;
    totalPF += el.pf; totalPFA += +(el.pf * deflator).toFixed(2);
  });
  totalPFA = +totalPFA.toFixed(2);
  const totalHoras = +(totalPFA * params.Produtividade).toFixed(1);
  const apf = { elementos, totalPF, totalPFA, totalHoras, horasDetalhamento: { gestao: 0, analiseNegocio: 0, analiseTestes: 0, codificacao: 0, execucaoTestes: 0, homologacao: 0 } };
  const sintese = JSON.parse(version.ResumoAnalise || '{}');

  const buf = await generateApfExcel(wi, apf, params, sintese, { versaoOverride: version.Versao });

  const outPath = `${process.env.USERPROFILE}\\Downloads\\APF_${workItemId}_v${version.Versao}_VALIDACAO.xlsx`;
  writeFileSync(outPath, buf);
  console.log('✅ Arquivo salvo em:', outPath);
}

main().catch(err => {
  console.error('❌ Erro:', err.message);
  process.exit(1);
});
