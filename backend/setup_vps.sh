#!/bin/bash
# Rode UMA VEZ na VPS como root para configurar tudo do zero.
# Uso: bash setup_vps.sh <GITHUB_REPO_URL>
# Ex:  bash setup_vps.sh https://github.com/seuusuario/gerar-ficha.git
set -e

REPO_URL="${1:-}"
DEPLOY_DIR="/root/gerar-ficha"

if [ -z "$REPO_URL" ]; then
  echo "ERRO: informe a URL do repositório GitHub."
  echo "Uso: bash setup_vps.sh https://github.com/usuario/repo.git"
  exit 1
fi

echo "=== [1/7] Atualizando sistema ==="
apt-get update -qq
apt-get install -y git python3 python3-pip python3-venv \
  xvfb libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libasound2 curl ufw 2>/dev/null | tail -3

echo "=== [2/7] Clonando repositório ==="
if [ -d "$DEPLOY_DIR/.git" ]; then
  echo "Repositório já existe, atualizando..."
  cd "$DEPLOY_DIR" && git pull
else
  git clone "$REPO_URL" "$DEPLOY_DIR"
  cd "$DEPLOY_DIR"
fi

echo "=== [3/7] Criando ambiente Python ==="
cd "$DEPLOY_DIR"
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip -q
pip install -r backend/requirements.txt -q

echo "=== [4/7] Instalando Playwright/Chromium ==="
playwright install chromium
playwright install-deps chromium 2>/dev/null | tail -3

echo "=== [5/7] Criando serviço Xvfb (display virtual) ==="
cat > /etc/systemd/system/xvfb.service << 'EOF'
[Unit]
Description=Virtual Display Xvfb
After=network.target

[Service]
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x720x24 -ac
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

echo "=== [6/7] Criando serviço do backend ==="
cat > /etc/systemd/system/gerar-ficha.service << 'EOF'
[Unit]
Description=Gerar Ficha Backend
After=network.target xvfb.service

[Service]
Type=simple
WorkingDirectory=/root/gerar-ficha/backend
ExecStart=/root/gerar-ficha/venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=5
Environment=DISPLAY=:99
EnvironmentFile=/root/gerar-ficha/backend/.env

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable xvfb gerar-ficha
systemctl start xvfb

echo "=== [7/7] Firewall ==="
ufw allow 22/tcp
ufw allow 8000/tcp
ufw --force enable

echo ""
echo "============================================="
echo "  SETUP CONCLUIDO!"
echo "============================================="
echo ""
echo "PROXIMO PASSO: crie o arquivo .env do backend:"
echo ""
echo "  cat > /root/gerar-ficha/backend/.env << 'ENVEOF'"
echo "  BACKEND_HOST=0.0.0.0"
echo "  BACKEND_PORT=8000"
echo "  CHATGPT_EMAIL=luukasgmct2020@hotmail.com"
echo "  CHATGPT_PASSWORD=SUA_SENHA_AQUI"
echo "  CHATGPT_PROJECT_URL=https://chatgpt.com/g/g-p-6a50feebc29481919b4dcaa0936ec203-ficha-pedido/project"
echo "  CHATGPT_HEADLESS=true"
echo "  CHATGPT_SESSION_FILE=/root/gerar-ficha/backend/chatgpt_session.json"
echo "  MATERIAL_API_URL=https://flkionbmkuqgkudjjuqk.supabase.co/functions/v1/api-quotation"
echo "  MATERIAL_API_PDF_URL=https://flkionbmkuqgkudjjuqk.supabase.co/functions/v1/api-quotation-pdf"
echo "  MATERIAL_API_TOKEN=SEU_TOKEN_DA_API"
echo "  MATERIAL_STORE_ID="
echo "  MATERIAL_API_TIMEOUT_SECONDS=120"
echo "  MATERIAL_ALLOWED_HOSTS=materialdecontrucao.online,flkionbmkuqgkudjjuqk.supabase.co"
echo "  ENVEOF"
echo ""
echo "Depois inicie o backend:"
echo "  systemctl start gerar-ficha"
echo "  curl http://localhost:8000/health"
echo ""
echo "E faça o login ChatGPT:"
echo "  curl -X POST http://localhost:8000/login/start"
