import sql from 'mssql';

// Connect with Windows Auth to create the database and login
const config: sql.config = {
  server: 'pta0010',
  database: 'master',
  options: {
    encrypt: false,
    trustServerCertificate: true,
    instanceName: 'dev',
  },
  authentication: {
    type: 'ntlm' as any,
    options: {
      userName: process.env.USERNAME || '',
      password: '',
      domain: process.env.USERDOMAIN || '',
    },
  },
};

async function setup() {
  console.log(`Conectando como ${process.env.USERDOMAIN}\\${process.env.USERNAME}...`);
  const pool = await new sql.ConnectionPool(config).connect();
  console.log('✅ Conectado ao SQL Server (Windows Auth)');

  // Create database
  const dbExists = await pool.request().query(
    `SELECT DB_ID('PainelBacklog') AS dbid`
  );
  if (!dbExists.recordset[0].dbid) {
    await pool.request().batch(`CREATE DATABASE PainelBacklog`);
    console.log('✅ Database PainelBacklog criado');
  } else {
    console.log('ℹ️ Database PainelBacklog já existe');
  }

  // Create login
  const loginExists = await pool.request().query(
    `SELECT principal_id FROM sys.server_principals WHERE name = 'antonio_dev'`
  );
  if (loginExists.recordset.length === 0) {
    await pool.request().batch(
      `CREATE LOGIN antonio_dev WITH PASSWORD = 'T9v!qR7#Lm2@Xz8$P', DEFAULT_DATABASE = PainelBacklog`
    );
    console.log('✅ Login antonio_dev criado');
  } else {
    console.log('ℹ️ Login antonio_dev já existe');
    // Reset password in case it was different
    await pool.request().batch(
      `ALTER LOGIN antonio_dev WITH PASSWORD = 'T9v!qR7#Lm2@Xz8$P'`
    );
    console.log('✅ Senha do login antonio_dev atualizada');
  }

  // Create user in PainelBacklog
  await pool.close();

  const dbPool = await new sql.ConnectionPool({
    ...config,
    database: 'PainelBacklog',
  }).connect();

  const userExists = await dbPool.request().query(
    `SELECT principal_id FROM sys.database_principals WHERE name = 'antonio_dev'`
  );
  if (userExists.recordset.length === 0) {
    await dbPool.request().batch(`CREATE USER antonio_dev FOR LOGIN antonio_dev`);
    console.log('✅ User antonio_dev criado no PainelBacklog');
  } else {
    console.log('ℹ️ User antonio_dev já existe no PainelBacklog');
  }

  // Grant permissions
  await dbPool.request().batch(`ALTER ROLE db_owner ADD MEMBER antonio_dev`);
  console.log('✅ antonio_dev adicionado ao role db_owner');

  await dbPool.close();
  console.log('\n🎉 Setup concluído! Agora execute: npx tsx src/db/migrate.ts');
}

setup().catch(err => {
  console.error('❌ Erro no setup:', err.message);
  process.exit(1);
});
