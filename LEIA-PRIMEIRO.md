# Manual de Deploy — Dashboard de Melhorias (pta0404)

> **Aplicação**: Dashboard de Melhorias com Assistente APF via Chat  
> **Servidor**: pta0404 (IIS + Node.js já instalados)  
> **URL**: `http://pta0404/improvements/`  
> **API**: `localhost:3002`

---

## 📂 Estrutura (TUDO EM UMA PASTA)

```
C:\inetpub\apps\
├── p-comunicacao/     ← já existe (porta 3000)
├── ranking/           ← já existe (porta 3001)
└── improvements/      ← ⬜ NOVO (porta 3002)
    ├── public/        ← Frontend (IIS aponta aqui)
    │   ├── index.html
    │   ├── env-config.js
    │   ├── web.config
    │   ├── assets/
    │   └── pati/
    ├── dist/          ← Backend (Node.js roda daqui)
    │   ├── index.js
    │   ├── routes/
    │   ├── services/
    │   └── templates/
    └── package.json   ← Para npm install
```

---

## 🔧 PASSO A PASSO

### 1. Copiar para o Servidor

Extraia o ZIP. Você terá uma pasta `improvements/`.  
Copie ela inteira para:

```
C:\inetpub\apps\
```

Resultado:
```
C:\inetpub\apps\improvements\
```

---

### 2. Configurar IIS — Sub-aplicação /improvements

1. Abra o **IIS Manager**
2. Expanda **Sites** → clique no site principal
3. Botão direito → **Adicionar Aplicativo...**
4. Preencha:
   ```
   Alias:              improvements
   Pool:               DefaultAppPool
   Caminho Físico:     C:\inetpub\apps\improvements\public
   ```
5. Clique em **OK**

> **Nota**: O IIS aponta para a pasta `public/`, não para a raiz. O backend fica em `dist/` e não é acessível pelo IIS.

---

### 3. Instalar Dependências da API

CMD como Administrador:
```cmd
cd /d C:\inetpub\apps\improvements
npm install --production
```

---

### 4. Criar .env

Crie `C:\inetpub\apps\improvements\.env`:

```env
# SQL Server
DB_SERVER=SEU_SERVIDOR_SQL\INSTANCIA
DB_DATABASE=PainelBacklog
DB_USER=usuario
DB_PASSWORD="SENHA"
DB_PORT=1433

# Azure DevOps
DEVOPS_PAT=seu_pat
DEVOPS_ORG=pbs-devops
DEVOPS_PROJECT=SRM.wbc7srm

# LLM
CHAT_API_URL=https://api.groq.com/openai/v1/chat/completions
CHAT_API_KEY=SUA_CHAVE_GROQ_AQUI
CHAT_MODEL=llama-3.3-70b-versatile

# JWT
JWT_SECRET="GERE_UM_SEGREDO_FORTE_AQUI"
JWT_EXPIRES_IN=8h

# App
PORT=3002
NODE_ENV=production
```

---

### 5. Rodar Migrations

```cmd
cd /d C:\inetpub\apps\improvements
node dist/db/migrate.js
```

---

### 6. Reverse Proxy no IIS

No site principal, adicione regra URL Rewrite:

```
Nome:              Reverse Proxy - Improvements
URL de Entrada:    ^improvements/api/(.*)$
Ação:              Reescrever
URL de Reescrita:  http://localhost:3002/api/{R:1}
```

---

### 7. Adicionar ao .bat de Startup

```bat
REM =====================================================
REM 3) IMPROVEMENTS (Dashboard de Melhorias) — porta 3002
REM =====================================================
set "APP3_DIR=C:\inetpub\apps\improvements"
set "APP3_TITLE=Improvements-API"

if not exist "%APP3_DIR%\dist\index.js" (
  echo ERRO: Nao encontrei "%APP3_DIR%\dist\index.js"
  echo.
) else (
  echo Iniciando %APP3_TITLE%...
  start "%APP3_TITLE%" cmd /k "cd /d ""%APP3_DIR%"" && node dist\index.js"
)
```

> **Atenção**: O caminho agora é `dist\index.js` porque tudo está em uma pasta só.

---

### 8. Testar

Execute o `.bat` atualizado e acesse:

```
http://pta0404/improvements/
```

---

## 📝 Arquivos Editáveis

| Arquivo | Local | Para quê |
|---------|-------|----------|
| `.env` | `C:\inetpub\apps\improvements\` | Senhas, banco, tokens |
| `env-config.js` | `C:\inetpub\apps\improvements\public\` | URL da API |

---

**Build gerada em**: 07/07/2026
