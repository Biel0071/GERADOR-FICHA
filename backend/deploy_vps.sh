#!/bin/bash
# Script de deploy na VPS — rode como root em /root/gerar-ficha
set -e

echo "=== [1/5] Copiando arquivos do backend ==="
# (já deve estar em /root/gerar-ficha/backend)

echo "=== [2/5] Ativando venv e instalando deps ==="
cd /root/gerar-ficha
source venv/bin/activate
pip install fastapi uvicorn httpx python-dotenv pydantic playwright -q
playwright install chromium

echo "=== [3/5] Configurando Xvfb (display virtual) ==="
cat > /etc/systemd/system/xvfb.service << 'EOF'
[Unit]
Description=Virtual Display Xvfb
After=network.target

[Service]
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x720x24 -ac
Restart=always

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable xvfb
systemctl start xvfb

echo "=== [4/5] Instalando serviço backend ==="
cp /root/gerar-ficha/backend/gerar-ficha.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable gerar-ficha
systemctl start gerar-ficha

echo "=== [5/5] Configurando firewall ==="
ufw allow 22/tcp
ufw allow 8000/tcp
ufw --force enable

echo "=== DEPLOY CONCLUIDO ==="
systemctl status gerar-ficha --no-pager | head -15
