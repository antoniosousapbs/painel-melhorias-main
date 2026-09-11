import sql from 'mssql';
import { getPool } from './connection.js';
import { ensureSeedProviders } from '../services/llm.js';

export async function migrate() {
  const pool = await getPool();

  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'WorkItems')
    CREATE TABLE WorkItems (
      Id INT PRIMARY KEY,
      Title NVARCHAR(500) NOT NULL,
      Description NVARCHAR(MAX),
      DevOpsState NVARCHAR(50),
      DevOpsAreaPath NVARCHAR(200),
      DevOpsTags NVARCHAR(500),
      ClienteNome NVARCHAR(200),
      CreatedDate DATETIME2,
      ChangedDate DATETIME2,

      Categoria NVARCHAR(50),
      Tipo NVARCHAR(100),
      Modulo NVARCHAR(100),
      Prioridade NVARCHAR(50),
      EsforcoAPF DECIMAL(10,2),
      ImpactoOperacao NVARCHAR(50),

      ClassificacaoOrigem NVARCHAR(20),
      ClassificacaoConfianca DECIMAL(3,2),
      ClassificacaoRevisada BIT DEFAULT 0,
      ClassificacaoRevisadaPor NVARCHAR(100),
      ClassificacaoRevisadaEm DATETIME2,

      UltimaSyncDevOps DATETIME2,
      CriadoEm DATETIME2 DEFAULT GETDATE(),
      AtualizadoEm DATETIME2 DEFAULT GETDATE()
    );
  `);

  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Configuracoes')
    CREATE TABLE Configuracoes (
      Id INT IDENTITY PRIMARY KEY,
      Chave NVARCHAR(100) UNIQUE NOT NULL,
      Valor NVARCHAR(MAX),
      Descricao NVARCHAR(500),
      AtualizadoPor NVARCHAR(100),
      AtualizadoEm DATETIME2 DEFAULT GETDATE()
    );
  `);

  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'WorkItemAuditLog')
    CREATE TABLE WorkItemAuditLog (
      Id INT IDENTITY PRIMARY KEY,
      WorkItemId INT REFERENCES WorkItems(Id),
      Campo NVARCHAR(50),
      ValorAnterior NVARCHAR(500),
      ValorNovo NVARCHAR(500),
      AlteradoPor NVARCHAR(100),
      AlteradoEm DATETIME2 DEFAULT GETDATE()
    );
  `);

  // E-mail de quem alterou — permite buscar a foto do perfil (Microsoft Graph) na Auditoria.
  // AlteradoPor (nome de exibição) é mantido como já era, só adicionamos o e-mail ao lado.
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('WorkItemAuditLog') AND name = 'AlteradoPorEmail')
    ALTER TABLE WorkItemAuditLog ADD AlteradoPorEmail NVARCHAR(200) NULL;
  `);

  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PromptTemplates')
    CREATE TABLE PromptTemplates (
      Id INT IDENTITY PRIMARY KEY,
      Nome NVARCHAR(100) UNIQUE NOT NULL,
      Template NVARCHAR(MAX),
      Ativo BIT DEFAULT 1,
      AtualizadoEm DATETIME2 DEFAULT GETDATE()
    );
  `);

  // Seed default config
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM Configuracoes WHERE Chave = 'wiql_query')
    INSERT INTO Configuracoes (Chave, Valor, Descricao)
    VALUES (
      'wiql_query',
      'SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = ''Support Case'' AND [System.State] NOT IN (''Removed'', ''Canceled'') ORDER BY [System.Id] DESC',
      'Query WIQL usada para buscar work items do Azure DevOps'
    );
  `);

  // Seed default projects filter
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM Configuracoes WHERE Chave = 'devops_projects')
    INSERT INTO Configuracoes (Chave, Valor, Descricao)
    VALUES (
      'devops_projects',
      'SRM.wbc7srm, Shared.SistemasInternos, Public.Wbc7, UFO.ETRM',
      'Projetos do Azure DevOps para sincronizar (separados por vírgula). Deixe vazio para trazer toda a organização.'
    );
  `);

  // Add Description column if missing (incremental migration)
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('WorkItems') AND name = 'Description')
    ALTER TABLE WorkItems ADD Description NVARCHAR(MAX);
  `);

  // Seed default prompt
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM PromptTemplates WHERE Nome = 'classificacao_padrao')
    INSERT INTO PromptTemplates (Nome, Template)
    VALUES (
      'classificacao_padrao',
      'Voce e um analista de produto senior. Classifique o chamado de melhoria de software abaixo com base no titulo e na descricao consolidada.

1. Categoria (uma de: Produto | Hibrido | Cliente | Info Insuficiente)
   - Produto: melhoria generica que beneficia qualquer cliente da plataforma
   - Hibrido: parte produto, parte customizacao especifica de cliente
   - Cliente: 100% especifico de um cliente, sem valor de produto generico
   - Info Insuficiente: dados insuficientes para decidir

2. Tipo (um de: UX | RegraNegocio | Relatorio | Integracao | WorkflowAprovacao)

3. Modulo (um de: Cotacao | Pedidos | Fornecedores | Contratos | Aprovacao | Geral | Fiscal)

4. Prioridade sugerida (uma de: Obrigatoria | Alta | Media | Nao priorizar)

5. Impacto na operacao (um de: Alto | Medio | Baixo)

Regras de analise:
- Use a descricao como fonte PRINCIPAL de contexto. O titulo sozinho e superficial.
- Se a descricao menciona regras de negocio especificas de um cliente, classifique como Cliente ou Hibrido.
- Se a descricao descreve fluxos genericos do sistema, classifique como Produto.
- Se a descricao esta vazia ou muito vaga, marque confianca baixa (< 0.5).
- A confianca deve refletir a qualidade da informacao disponivel (0.0 a 1.0).

IMPORTANTE: O campo {{DESCRICAO}} contem o contexto consolidado composto por:
  - Descricao original do chamado
  - Comentarios [PATI] do DevOps (refinamentos e detalhamentos pre-registrados)
Use TODAS as informacoes disponiveis para classificar com precisao. Nao baseie a classificacao apenas no titulo.

Retorne APENAS um JSON valido: {"categoria":"...","tipo":"...","modulo":"...","prioridade":"...","impacto":"...","confianca":0.0}

Titulo: {{TITULO}}
Descricao: {{DESCRICAO}}'
    );
  `);

  // Incremental update: replace old SRM360/Paradigma-specific prompt with corporate version
  await pool.request().query(`
    UPDATE PromptTemplates
    SET Template = 'Voce e um analista de produto senior. Classifique o chamado de melhoria de software abaixo com base no titulo e na descricao consolidada.

1. Categoria (uma de: Produto | Hibrido | Cliente | Info Insuficiente)
   - Produto: melhoria generica que beneficia qualquer cliente da plataforma
   - Hibrido: parte produto, parte customizacao especifica de cliente
   - Cliente: 100% especifico de um cliente, sem valor de produto generico
   - Info Insuficiente: dados insuficientes para decidir

2. Tipo (um de: UX | RegraNegocio | Relatorio | Integracao | WorkflowAprovacao)

3. Modulo (um de: Cotacao | Pedidos | Fornecedores | Contratos | Aprovacao | Geral | Fiscal)

4. Prioridade sugerida (uma de: Obrigatoria | Alta | Media | Nao priorizar)

5. Impacto na operacao (um de: Alto | Medio | Baixo)

Regras de analise:
- Use a descricao como fonte PRINCIPAL de contexto. O titulo sozinho e superficial.
- Se a descricao menciona regras de negocio especificas de um cliente, classifique como Cliente ou Hibrido.
- Se a descricao descreve fluxos genericos do sistema, classifique como Produto.
- Se a descricao esta vazia ou muito vaga, marque confianca baixa (< 0.5).
- A confianca deve refletir a qualidade da informacao disponivel (0.0 a 1.0).

IMPORTANTE: O campo {{DESCRICAO}} contem o contexto consolidado composto por:
  - Descricao original do chamado
  - Comentarios [PATI] do DevOps (refinamentos e detalhamentos pre-registrados)
Use TODAS as informacoes disponiveis para classificar com precisao. Nao baseie a classificacao apenas no titulo.

Retorne APENAS um JSON valido: {"categoria":"...","tipo":"...","modulo":"...","prioridade":"...","impacto":"...","confianca":0.0}

Titulo: {{TITULO}}
Descricao: {{DESCRICAO}}',
        AtualizadoEm = GETDATE()
    WHERE Nome = 'classificacao_padrao'
      AND Template LIKE '%SRM360/Paradigma%'
  `);

  // Incremental update: ensure the existing prompt template includes [PATI] context instructions
  // Only update if the template does NOT already mention PATI (so we don't overwrite admin customizations)
  await pool.request().query(`
    UPDATE PromptTemplates
    SET Template = REPLACE(Template,
      'Retorne APENAS um JSON valido:',
      'IMPORTANTE: O campo {{DESCRICAO}} contem o contexto consolidado (Description + Comentarios [PATI] + Interrogatorio APF). Use todas as informacoes.

Retorne APENAS um JSON valido:')
    WHERE Nome = 'classificacao_padrao'
      AND Ativo = 1
      AND Template NOT LIKE '%[PATI]%'
  `);

  console.log('✅ Migration concluída com sucesso.');
  // Prioridade é EXCLUSIVAMENTE numérica e preenchida manualmente pelo analista — nunca mais
  // pela classificação automática (ver services/classification.ts). Reverte a coluna, que em
  // algum momento foi convertida para NVARCHAR para aceitar texto ("Alta", "Media" etc.), de
  // volta para INT, descartando qualquer valor não-numérico remanescente.
  await pool.request().query(`
    IF EXISTS (
      SELECT 1 FROM sys.columns c JOIN sys.types t ON c.user_type_id = t.user_type_id
      WHERE c.object_id = OBJECT_ID('WorkItems') AND c.name = 'Prioridade' AND t.name IN ('nvarchar', 'varchar')
    )
    BEGIN
      UPDATE WorkItems SET Prioridade = NULL WHERE Prioridade IS NOT NULL AND Prioridade LIKE '%[^0-9]%';
      ALTER TABLE WorkItems ALTER COLUMN Prioridade INT NULL;
    END
  `);

  // Desempata duplicidades pré-existentes (nenhuma unicidade era garantida antes) mantendo a
  // atualização mais recente por cliente+prioridade, para permitir criar o índice único abaixo.
  await pool.request().query(`
    ;WITH dupes AS (
      SELECT Id, ROW_NUMBER() OVER (PARTITION BY ClienteNome, Prioridade ORDER BY AtualizadoEm DESC, Id DESC) AS rn
      FROM WorkItems
      WHERE Prioridade IS NOT NULL AND ClienteNome IS NOT NULL
    )
    UPDATE w SET Prioridade = NULL
    FROM WorkItems w JOIN dupes d ON w.Id = d.Id
    WHERE d.rn > 1;
  `);

  // Prioridade nunca pode se repetir para o mesmo cliente (NULLs ficam de fora da checagem).
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_WorkItems_Cliente_Prioridade' AND object_id = OBJECT_ID('WorkItems'))
    CREATE UNIQUE INDEX UQ_WorkItems_Cliente_Prioridade ON WorkItems(ClienteNome, Prioridade) WHERE Prioridade IS NOT NULL AND ClienteNome IS NOT NULL;
  `);

  // Remove o pedido de "Prioridade sugerida" do prompt de classificação — a IA nunca mais deve
  // sugerir prioridade (campo é 100% manual). Só aplica se o template ainda tiver o texto antigo,
  // preservando customizações feitas pelo admin que já removeram isso.
  await pool.request().query(`
    UPDATE PromptTemplates
    SET Template = REPLACE(
      REPLACE(Template, '4. Prioridade sugerida (uma de: Obrigatoria | Alta | Media | Nao priorizar)' + CHAR(10) + CHAR(10) + '5. Impacto', '4. Impacto'),
      '"prioridade":"...",', ''
    )
    WHERE Nome = 'classificacao_padrao'
      AND Template LIKE '%Prioridade sugerida%'
  `);

  // Add SupportCaseType column if missing
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('WorkItems') AND name = 'SupportCaseType')
    ALTER TABLE WorkItems ADD SupportCaseType NVARCHAR(100);
  `);

  // Add SupportCaseStatus column if missing
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('WorkItems') AND name = 'SupportCaseStatus')
    ALTER TABLE WorkItems ADD SupportCaseStatus NVARCHAR(200);
  `);

  // Add DiscussionPati column for storing [PATI] tagged comments
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('WorkItems') AND name = 'DiscussionPati')
    ALTER TABLE WorkItems ADD DiscussionPati NVARCHAR(MAX);
  `);

  // Add AssignedTo column (responsável do chamado, capturado do Azure DevOps)
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('WorkItems') AND name = 'AssignedTo')
    ALTER TABLE WorkItems ADD AssignedTo NVARCHAR(200);
  `);

  // Add ApfDispensado columns — permite marcar um chamado como "não requer APF"
  // para ele deixar de contar no KPI "Sem APF" sem precisar de um EsforcoAPF fake.
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('WorkItems') AND name = 'ApfDispensado')
    ALTER TABLE WorkItems ADD ApfDispensado BIT NOT NULL DEFAULT 0;
  `);
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('WorkItems') AND name = 'ApfDispensadoMotivo')
    ALTER TABLE WorkItems ADD ApfDispensadoMotivo NVARCHAR(500);
  `);
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('WorkItems') AND name = 'ApfDispensadoPor')
    ALTER TABLE WorkItems ADD ApfDispensadoPor NVARCHAR(100);
  `);
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('WorkItems') AND name = 'ApfDispensadoEm')
    ALTER TABLE WorkItems ADD ApfDispensadoEm DATETIME2;
  `);

  // APF Parameters table (global config)
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'ApfParametros')
    CREATE TABLE ApfParametros (
      Id INT IDENTITY PRIMARY KEY,
      Produtividade DECIMAL(10,2) NOT NULL DEFAULT 6.00,
      DeflatorInclusao DECIMAL(5,2) NOT NULL DEFAULT 1.00,
      DeflatorAlteracao DECIMAL(5,2) NOT NULL DEFAULT 0.50,
      DeflatorExclusao DECIMAL(5,2) NOT NULL DEFAULT 0.40,
      CicloGestao DECIMAL(5,2) NOT NULL DEFAULT 7.00,
      CicloAnaliseNegocio DECIMAL(5,2) NOT NULL DEFAULT 17.00,
      CicloAnaliseTestes DECIMAL(5,2) NOT NULL DEFAULT 8.00,
      CicloCodificacao DECIMAL(5,2) NOT NULL DEFAULT 45.00,
      CicloExecucaoTestes DECIMAL(5,2) NOT NULL DEFAULT 18.00,
      CicloHomologacao DECIMAL(5,2) NOT NULL DEFAULT 5.00,
      AtualizadoPor NVARCHAR(100),
      AtualizadoEm DATETIME2 DEFAULT GETDATE()
    );
  `);

  // Seed default APF parameters
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM ApfParametros)
    INSERT INTO ApfParametros (Produtividade, DeflatorInclusao, DeflatorAlteracao, DeflatorExclusao,
      CicloGestao, CicloAnaliseNegocio, CicloAnaliseTestes, CicloCodificacao, CicloExecucaoTestes, CicloHomologacao)
    VALUES (6.00, 1.00, 0.50, 0.40, 7.00, 17.00, 8.00, 45.00, 18.00, 5.00);
  `);

  // ── ApfDiretrizesProjeto: diretriz de contagem (linguagem de negócio) por team project.
  // Complementar ao IFPUG — nunca substitui as regras de complexidade, só dá contexto de produto. ──
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'ApfDiretrizesProjeto')
    CREATE TABLE ApfDiretrizesProjeto (
      Id           INT IDENTITY PRIMARY KEY,
      ProjectCode  NVARCHAR(200) NOT NULL,
      Diretriz     NVARCHAR(MAX) NOT NULL,
      Ativo        BIT DEFAULT 1,
      AtualizadoPor NVARCHAR(100),
      AtualizadoEm DATETIME2 DEFAULT GETDATE()
    );
  `);

  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UQ_ApfDiretrizesProjeto_ProjectCode' AND object_id = OBJECT_ID('ApfDiretrizesProjeto'))
    CREATE UNIQUE INDEX UQ_ApfDiretrizesProjeto_ProjectCode ON ApfDiretrizesProjeto(ProjectCode);
  `);

  // Generated Documents table
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'DocumentosGerados')
    CREATE TABLE DocumentosGerados (
      Id INT IDENTITY PRIMARY KEY,
      WorkItemId INT NOT NULL REFERENCES WorkItems(Id),
      Tipo NVARCHAR(20) NOT NULL,
      NomeArquivo NVARCHAR(300),
      Conteudo VARBINARY(MAX),
      GeradoEm DATETIME2 DEFAULT GETDATE(),
      GeradoPor NVARCHAR(100) DEFAULT 'PATi'
    );
  `);

  // Add ApfElementos column to store JSON of APF elements (for refinement)
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('DocumentosGerados') AND name = 'ElementosJson')
    ALTER TABLE DocumentosGerados ADD ElementosJson NVARCHAR(MAX);
  `);

  // Snapshot estruturado (JSON) da Especificação de Negócio gerada via template Word (SPEC_DOCX)
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('DocumentosGerados') AND name = 'EspecificacaoJson')
    ALTER TABLE DocumentosGerados ADD EspecificacaoJson NVARCHAR(MAX);
  `);

  // APF Refinement history table
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'ApfRefinamentos')
    CREATE TABLE ApfRefinamentos (
      Id INT IDENTITY PRIMARY KEY,
      WorkItemId INT NOT NULL REFERENCES WorkItems(Id),
      InstrucaoUsuario NVARCHAR(MAX) NOT NULL,
      ElementosAntes NVARCHAR(MAX),
      ElementosDepois NVARCHAR(MAX),
      TotalPFAntes DECIMAL(10,2),
      TotalPFDepois DECIMAL(10,2),
      CriadoEm DATETIME2 DEFAULT GETDATE()
    );
  `);

  // PATi Knowledge Base — system knowledge, patterns, learnings
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'PatiConhecimento')
    CREATE TABLE PatiConhecimento (
      Id INT IDENTITY PRIMARY KEY,
      Categoria NVARCHAR(50) NOT NULL,
      Titulo NVARCHAR(200) NOT NULL,
      Conteudo NVARCHAR(MAX) NOT NULL,
      Tags NVARCHAR(500),
      Origem NVARCHAR(20) NOT NULL DEFAULT 'manual',
      WorkItemRef INT NULL,
      Ativo BIT DEFAULT 1,
      CriadoEm DATETIME2 DEFAULT GETDATE(),
      AtualizadoEm DATETIME2 DEFAULT GETDATE()
    );
  `);

  // Seed system knowledge if empty
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM PatiConhecimento)
    BEGIN
      -- Arquitetura do Sistema
      INSERT INTO PatiConhecimento (Categoria, Titulo, Conteudo, Tags, Origem) VALUES
      ('arquitetura', 'Visão Geral SRM360', 'O SRM360 é um sistema de e-Procurement (Supplier Relationship Management) desenvolvido pela Paradigma. É composto por módulos: Cotação, Pedidos, Fornecedores, Contratos, Aprovação, Fiscal, Geral. A arquitetura é web com backend .NET/C#, banco SQL Server, frontend Angular. Integrações são feitas via APIs REST e também via processamento batch com ERPs (SAP, TOTVS, Oracle).', 'srm360,arquitetura,modulos,visao-geral', 'manual');

      INSERT INTO PatiConhecimento (Categoria, Titulo, Conteudo, Tags, Origem) VALUES
      ('modulo', 'Módulo Cotação', 'O módulo de Cotação gerencia o processo de cotação de preços. Funcionalidades: criação de cotação, envio para fornecedores, recebimento de propostas, análise comparativa, adjudicação. Telas principais: lista de cotações, criação/edição, comparativo de preços, aprovação, espelho da cotação. Integrações: ERP (itens, fornecedores), portal do fornecedor. Tipicamente envolve: 3-5 EE (entradas), 4-6 CE (consultas), 2-3 SE (saídas/relatórios), 1-2 ALI (arquivos internos), 2-3 AIE (interfaces).', 'cotacao,modulo,compras', 'manual');

      INSERT INTO PatiConhecimento (Categoria, Titulo, Conteudo, Tags, Origem) VALUES
      ('modulo', 'Módulo Pedidos', 'O módulo de Pedidos gerencia pedidos de compra. Funcionalidades: criação de pedido (manual ou a partir de cotação), aprovação, envio ao fornecedor, follow-up, recebimento, cancelamento. Telas: lista de pedidos, criação/edição, detalhes do pedido, timeline, programação de entrega (PDay). Integrações: ERP (dados mestres, condições de pagamento, centros de custo), portal do fornecedor, módulo fiscal. Cada pedido pode ter múltiplos itens com condições diferentes.', 'pedidos,modulo,compras,pday', 'manual');

      INSERT INTO PatiConhecimento (Categoria, Titulo, Conteudo, Tags, Origem) VALUES
      ('modulo', 'Módulo Fornecedores', 'O módulo de Fornecedores gerencia o cadastro e qualificação de fornecedores. Funcionalidades: cadastro, homologação, avaliação de desempenho, documentação, bloqueio/desbloqueio. Telas: lista, ficha do fornecedor, documentos, avaliações, histórico. Integrações: Receita Federal (CNPJ), SERASA, ERP (cadastro mestre de fornecedor). Portal de auto-cadastro para fornecedores.', 'fornecedores,modulo,cadastro,homologacao', 'manual');

      INSERT INTO PatiConhecimento (Categoria, Titulo, Conteudo, Tags, Origem) VALUES
      ('modulo', 'Módulo Contratos', 'O módulo de Contratos gerencia contratos de fornecimento. Funcionalidades: criação, vigência, renovação, aditivos, medições, notificações de vencimento. Telas: lista de contratos, criação/edição, medições, aditivos, dashboard de vencimentos. Integrações: ERP (dados financeiros), módulo de aprovação, geração de pedidos a partir de contrato.', 'contratos,modulo,vigencia', 'manual');

      INSERT INTO PatiConhecimento (Categoria, Titulo, Conteudo, Tags, Origem) VALUES
      ('modulo', 'Módulo Aprovação (Workflow)', 'O módulo de Aprovação é transversal — usado por Cotações, Pedidos, Contratos. Funcionalidades: configuração de alçadas, níveis de aprovação, delegação, aprovação mobile, substituição de aprovador. Cada entidade aprovável tem seu fluxo configurável. Tipicamente 2-3 EE, 1-2 CE por fluxo novo.', 'aprovacao,workflow,modulo,alcada', 'manual');

      -- Padrões de contagem
      INSERT INTO PatiConhecimento (Categoria, Titulo, Conteudo, Tags, Origem) VALUES
      ('padrao_contagem', 'Integração com ERP via API', 'Cada integração com ERP (SAP, TOTVS, Oracle) tipicamente envolve: 1 AIE por entidade consumida (ex: fornecedor, material, condição pagamento = 3 AIE). Se a integração é bidirecional (envia e recebe), adicionar 1 EE (envio) + 1 SE (retorno) por operação. APIs REST com CRUD completo: contar 1 EE (POST/PUT), 1 CE (GET), 1 SE (GET lista/relatório). Complexidade depende do número de campos transacionados.', 'integracao,erp,api,sap,totvs', 'manual');

      INSERT INTO PatiConhecimento (Categoria, Titulo, Conteudo, Tags, Origem) VALUES
      ('padrao_contagem', 'Tela de Cadastro Padrão', 'Uma tela de cadastro típica no SRM360 envolve: 1 EE (inclusão), 1 EE (alteração), 1 EE (exclusão lógica), 1 CE (consulta/busca), 1 SE (listagem com filtros). Se tem abas/seções complexas, cada aba com dados independentes pode ser contada separadamente. Campos: até 10 = complexidade Baixa, 11-20 = Média, 21+ = Alta.', 'tela,cadastro,crud,padrao', 'manual');

      INSERT INTO PatiConhecimento (Categoria, Titulo, Conteudo, Tags, Origem) VALUES
      ('padrao_contagem', 'Relatório/Exportação', 'Relatórios no SRM360: 1 SE por relatório. Complexidade baseada em: campos no output (TD) e tabelas consultadas (AR). Relatório simples (lista): Baixa. Com agrupamento e totalização: Média. Com parâmetros complexos e múltiplas fontes: Alta. Exportação Excel/PDF: mesma SE, não conta separado do relatório.', 'relatorio,exportacao,se,saida', 'manual');

      INSERT INTO PatiConhecimento (Categoria, Titulo, Conteudo, Tags, Origem) VALUES
      ('padrao_contagem', 'Regra de Negócio Impacto na Contagem', 'Regras de negócio NÃO geram elementos novos por si só — elas aumentam a complexidade dos elementos existentes (mais TD ou AR). Exceção: se uma regra cria um novo processo (ex: validação que consulta API externa), isso gera novo elemento. Recálculo automático (ex: recalcular parcelas ao mudar condição) = aumento de TD no EE existente, não novo elemento.', 'regra-negocio,complexidade,td', 'manual');

      INSERT INTO PatiConhecimento (Categoria, Titulo, Conteudo, Tags, Origem) VALUES
      ('padrao_contagem', 'Portal do Fornecedor', 'Funcionalidades no Portal do Fornecedor são contadas separadamente pois são processos distintos do backoffice. Tela de resposta de cotação = 1 EE (enviar proposta) + 1 CE (ver cotação). Acompanhamento de pedidos = 1 CE. Upload de documentos = 1 EE. Cada operação no portal é independente do backoffice.', 'portal,fornecedor,externo', 'manual');
    END
  `);

  // ── Audit: incremental columns on DocumentosGerados ─────────────────────────
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('DocumentosGerados') AND name = 'GeradoPorUserId')
    ALTER TABLE DocumentosGerados ADD GeradoPorUserId NVARCHAR(200);
  `);
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('DocumentosGerados') AND name = 'GeradoPorNome')
    ALTER TABLE DocumentosGerados ADD GeradoPorNome NVARCHAR(200);
  `);
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('DocumentosGerados') AND name = 'GeradoPorEmail')
    ALTER TABLE DocumentosGerados ADD GeradoPorEmail NVARCHAR(200);
  `);
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('DocumentosGerados') AND name = 'InterviewContext')
    ALTER TABLE DocumentosGerados ADD InterviewContext NVARCHAR(MAX);
  `);

  // ── DocumentVersionHistory: audit trail of every generation ─────────────────
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'DocumentVersionHistory')
    CREATE TABLE DocumentVersionHistory (
      Id            INT IDENTITY PRIMARY KEY,
      WorkItemId    INT NOT NULL,
      WorkItemTitle NVARCHAR(500),
      Tipo          NVARCHAR(10) NOT NULL,          -- 'APF' | 'SPEC'
      Versao        INT NOT NULL,                   -- 1, 2, 3…  auto per WorkItemId+Tipo
      TotalPF       DECIMAL(10,2),                  -- APF only
      TotalHoras    DECIMAL(10,2),                  -- APF only
      ElementosJson NVARCHAR(MAX),                  -- APF JSON snapshot
      SpecContent   NVARCHAR(MAX),                  -- SPEC plain text snapshot
      InterviewContext NVARCHAR(MAX),               -- interview history used as input
      GeradoPorUserId  NVARCHAR(200),               -- Azure AD OID
      GeradoPorNome    NVARCHAR(200),
      GeradoPorEmail   NVARCHAR(200),
      CriadoEm      DATETIME2 DEFAULT GETDATE(),
      CONSTRAINT UQ_DocVer UNIQUE (WorkItemId, Tipo, Versao)
    );
  `);

  // Snapshot estruturado (JSON) da Especificação de Negócio — mesma ideia do ElementosJson do APF,
  // permite reconstruir/reexportar o docx sem rodar a IA de novo.
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('DocumentVersionHistory') AND name = 'EspecificacaoJson')
    ALTER TABLE DocumentVersionHistory ADD EspecificacaoJson NVARCHAR(MAX);
  `);

  // Síntese da LLM (resumoGeral na geração inicial, resumoAlteracoes em cada refinamento) —
  // antes só era usada em memória e descartada; agora persiste por versão pra reconstruir a
  // evolução completa da análise (Memória de Cálculo) e a trilha de auditoria (PDF).
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('DocumentVersionHistory') AND name = 'ResumoAnalise')
    ALTER TABLE DocumentVersionHistory ADD ResumoAnalise NVARCHAR(MAX);
  `);

  // ── InterviewSessions: conflict detection for concurrent users ───────────────
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'InterviewSessions')
    CREATE TABLE InterviewSessions (
      Id           INT IDENTITY PRIMARY KEY,
      SessionId    NVARCHAR(100) NOT NULL UNIQUE,   -- UUID from frontend
      WorkItemId   INT,
      Tipo         NVARCHAR(10),
      UserId       NVARCHAR(200),
      UserName     NVARCHAR(200),
      UserEmail    NVARCHAR(200),
      StartedAt    DATETIME2 DEFAULT GETDATE(),
      LastActivity DATETIME2 DEFAULT GETDATE(),
      Status       NVARCHAR(20) DEFAULT 'active'    -- 'active' | 'completed' | 'abandoned'
    );
  `);

  // ── UserRoles: controle de acesso (Admin vs Operador) ────────────────────────
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'UserRoles')
    CREATE TABLE UserRoles (
      Id           INT IDENTITY PRIMARY KEY,
      AadObjectId  UNIQUEIDENTIFIER NULL,           -- claim 'oid' do token AAD (preenchido no 1º login)
      Email        NVARCHAR(255) NOT NULL,
      Nome         NVARCHAR(255) NULL,
      Role         NVARCHAR(50) NOT NULL DEFAULT 'Operador', -- 'Admin' | 'Operador'
      CriadoEm     DATETIME2 DEFAULT SYSUTCDATETIME(),
      AtualizadoEm DATETIME2 NULL
    );
  `);

  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UQ_UserRoles_AadObjectId' AND object_id = OBJECT_ID('UserRoles'))
    CREATE UNIQUE INDEX UQ_UserRoles_AadObjectId ON UserRoles(AadObjectId) WHERE AadObjectId IS NOT NULL;
  `);

  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UQ_UserRoles_Email' AND object_id = OBJECT_ID('UserRoles'))
    CREATE UNIQUE INDEX UQ_UserRoles_Email ON UserRoles(Email);
  `);

  // Seed do primeiro Admin (por e-mail — o AadObjectId é vinculado automaticamente no 1º login)
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM UserRoles WHERE Email = 'antonio.sousa@paradigmabs.com.br')
    INSERT INTO UserRoles (Email, Role) VALUES ('antonio.sousa@paradigmabs.com.br', 'Admin');
  `);

  // ── UserProjects: segmentação de acesso — quais projetos DevOps um Operador pode ver ──
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'UserProjects')
    CREATE TABLE UserProjects (
      Id          INT IDENTITY PRIMARY KEY,
      UserId      INT NOT NULL REFERENCES UserRoles(Id) ON DELETE CASCADE,
      ProjectCode NVARCHAR(200) NOT NULL,
      CriadoEm    DATETIME2 DEFAULT SYSUTCDATETIME()
    );
  `);

  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UQ_UserProjects_UserId_ProjectCode' AND object_id = OBJECT_ID('UserProjects'))
    CREATE UNIQUE INDEX UQ_UserProjects_UserId_ProjectCode ON UserProjects(UserId, ProjectCode);
  `);

  // ── LlmProviders: registro de provedores/modelos de LLM configuráveis (URL, chave, modelo) ──
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'LlmProviders')
    CREATE TABLE LlmProviders (
      Id               INT IDENTITY PRIMARY KEY,
      Nome             NVARCHAR(100) NOT NULL,
      Kind             NVARCHAR(30) NOT NULL,        -- 'openai-compatible' | 'azure-ai-foundry'
      ApiUrl           NVARCHAR(500) NOT NULL,
      ApiKeyEncrypted  NVARCHAR(1000) NOT NULL,       -- AES-256-GCM, nunca texto puro
      ModelName        NVARCHAR(100) NOT NULL,
      ApiVersion       NVARCHAR(30) NULL,             -- só usado por 'azure-ai-foundry' (query param api-version)
      Ativo            BIT DEFAULT 1,
      AtualizadoEm     DATETIME2 DEFAULT GETDATE()
    );
  `);

  // Coluna adicionada depois da criação inicial da tabela — garante upgrade em bancos já migrados.
  await pool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('LlmProviders') AND name = 'ApiVersion')
    ALTER TABLE LlmProviders ADD ApiVersion NVARCHAR(30) NULL;
  `);

  // ── LlmUsoConfig: qual provider (+ fallback) atende cada finalidade da aplicação ──
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'LlmUsoConfig')
    CREATE TABLE LlmUsoConfig (
      Finalidade          NVARCHAR(50) PRIMARY KEY,   -- 'chat' | 'classificacao' | 'apf_geracao' | 'apf_refinamento' | 'spec_geracao'
      ProviderId          INT NULL REFERENCES LlmProviders(Id),
      FallbackProviderId  INT NULL REFERENCES LlmProviders(Id)
    );
  `);

  // Semántica inicial: só roda se a tabela LlmProviders estiver vazia (não sobrescreve
  // configuração já feita pela UI). Lê credenciais de variáveis de ambiente — nunca hardcoded.
  await ensureSeedProviders();

  // Novas finalidades (spec_estruturacao/spec_revisao) em bancos já existentes (onde
  // ensureSeedProviders não roda de novo, pois LlmProviders já não está vazio): copia a
  // configuração já feita para 'spec_geracao', se houver, em vez de deixar sem provider.
  await pool.request().query(`
    IF EXISTS (SELECT 1 FROM LlmUsoConfig WHERE Finalidade = 'spec_geracao')
    BEGIN
      INSERT INTO LlmUsoConfig (Finalidade, ProviderId, FallbackProviderId)
      SELECT 'spec_estruturacao', ProviderId, FallbackProviderId FROM LlmUsoConfig WHERE Finalidade = 'spec_geracao'
        AND NOT EXISTS (SELECT 1 FROM LlmUsoConfig WHERE Finalidade = 'spec_estruturacao');
      INSERT INTO LlmUsoConfig (Finalidade, ProviderId, FallbackProviderId)
      SELECT 'spec_revisao', ProviderId, FallbackProviderId FROM LlmUsoConfig WHERE Finalidade = 'spec_geracao'
        AND NOT EXISTS (SELECT 1 FROM LlmUsoConfig WHERE Finalidade = 'spec_revisao');
    END
  `);

  // ── Fix real (2026-08-21): a WIQL excluía chamados 'Closed' (encerrados), então o sync
  // deletava fisicamente qualquer chamado que fechasse — impossibilitando qualquer histórico
  // de "chamados encerrados". Migra bancos já existentes removendo só 'Closed' da exclusão
  // (mantém 'Removed'/'Canceled' fora, esses sim são inválidos/apagados no DevOps de verdade).
  // Idempotente: só aplica se a WIQL salva ainda tiver 'Closed' na lista de exclusão.
  await pool.request().query(`
    UPDATE Configuracoes
    SET Valor = REPLACE(
      REPLACE(Valor, 'NOT IN (''Closed'', ''Removed'', ''Canceled'')', 'NOT IN (''Removed'', ''Canceled'')'),
      'NOT IN (''Closed'', ''Removed'')', 'NOT IN (''Removed'')'
    )
    WHERE Chave = 'wiql_query' AND Valor LIKE '%''Closed''%'
  `);

  // ── AuditLog: eventos gerais de auditoria (acesso, erro, sync) — complementa
  // DocumentVersionHistory (gerações de APF/Spec) e WorkItemAuditLog (mudança de campo)
  // numa visão unificada consultada por GET /api/audit.
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AuditLog')
    CREATE TABLE AuditLog (
      Id         INT IDENTITY PRIMARY KEY,
      EventType  NVARCHAR(30) NOT NULL,       -- 'ACESSO' | 'ERRO' | 'SYNC'
      UserId     NVARCHAR(200) NULL,
      UserName   NVARCHAR(200) NULL,
      UserEmail  NVARCHAR(200) NULL,
      WorkItemId INT NULL,
      Detalhe    NVARCHAR(MAX) NULL,
      Sucesso    BIT NOT NULL DEFAULT 1,
      CriadoEm   DATETIME2 DEFAULT GETDATE()
    );
  `);

  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_AuditLog_EventType' AND object_id = OBJECT_ID('AuditLog'))
    CREATE INDEX IX_AuditLog_EventType ON AuditLog(EventType);
  `);

  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_AuditLog_CriadoEm' AND object_id = OBJECT_ID('AuditLog'))
    CREATE INDEX IX_AuditLog_CriadoEm ON AuditLog(CriadoEm DESC);
  `);

  await pool.close();
}

// Run directly
migrate().catch(err => {
  console.error('❌ Erro na migration:', err);
  process.exit(1);
});
