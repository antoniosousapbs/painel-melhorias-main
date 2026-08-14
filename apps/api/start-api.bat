@echo off
REM =====================================================
REM Inicia a API do Dashboard de Melhorias (Improvements)
REM Porta: 3002
REM =====================================================
set "APP_DIR=%~dp0"
set "APP_TITLE=Improvements-API"

if not exist "%APP_DIR%dist\index.js" (
  echo ERRO: Nao encontrei "%APP_DIR%dist\index.js"
  echo Verifique se o deploy foi copiado corretamente.
  pause
  exit /b 1
)

REM Garante que as dependencias estao instaladas (node_modules pode nao
REM existir apos um deploy que substitui a pasta inteira).
if not exist "%APP_DIR%node_modules\express" (
  echo node_modules ausente ou incompleto. Instalando dependencias...
  pushd "%APP_DIR%"
  call npm install --production
  popd
  if errorlevel 1 (
    echo ERRO: Falha ao instalar dependencias.
    pause
    exit /b 1
  )
)

REM Aplica migrations do banco antes de subir a API. E seguro rodar sempre:
REM cada passo confere "IF NOT EXISTS" antes de alterar o schema, entao nao
REM refaz nada que ja esteja aplicado. Evita esquecer de atualizar o banco
REM quando o deploy inclui mudanca de schema.
echo Aplicando migrations do banco de dados...
pushd "%APP_DIR%"
call node dist\db\migrate.js
popd
if errorlevel 1 (
  echo ERRO: Falha ao aplicar migrations. API NAO foi iniciada.
  pause
  exit /b 1
)

echo Iniciando %APP_TITLE%...
start "%APP_TITLE%" cmd /k "cd /d ""%APP_DIR%"" && node dist\index.js"
