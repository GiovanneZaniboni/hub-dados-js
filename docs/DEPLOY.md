# Distribuição e publicação

O Hub é só uma pasta: `index.html`, `css/` e `js/`. Não há build. Existem três formas de usar.

## 1. Duplo clique (mais simples)

Copie a pasta para o computador (ou para uma pasta de rede) e abra `index.html` no Chrome ou no Edge. Funciona offline. A CSP está dentro do `index.html`, então a proteção vale também nesse modo.

Observações:

- Ao distribuir por pasta de rede, dê permissão de **somente leitura** aos usuários; quem puder alterar os arquivos controla o que roda.
- Peça que usem Chrome/Edge atualizados (o Hub depende de `DecompressionStream`/`CompressionStream`).

## 2. Servidor web estático interno

Sirva a pasta por HTTPS em qualquer servidor estático (nginx, IIS, Apache, S3 interno...). Não é preciso configurar tipos de arquivo especiais além do padrão (`.html`, `.js`, `.css`).

### Cabeçalhos recomendados

A CSP já vai dentro do `index.html`. Estes cabeçalhos **não** podem ser definidos por `<meta>`, então configure-os no servidor:

```
Content-Security-Policy: <mesma política do index.html>; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=(), serial=(), payment=()
Strict-Transport-Security: max-age=63072000; includeSubDomains
Cache-Control: no-cache            # para index.html, js/ e css/ (assim atualizações chegam logo)
```

### nginx

```nginx
server {
  listen 443 ssl http2;
  server_name hub.interno.exemplo;
  root /var/www/hub-dados;

  add_header Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; font-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'" always;
  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy no-referrer always;
  add_header Cross-Origin-Opener-Policy same-origin always;
  add_header Cross-Origin-Resource-Policy same-origin always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), usb=(), serial=(), payment=()" always;
  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
  add_header Cache-Control "no-cache" always;

  location / { try_files $uri =404; }
}
```

### IIS (`web.config`)

```xml
<configuration>
  <system.webServer>
    <httpProtocol>
      <customHeaders>
        <add name="X-Content-Type-Options" value="nosniff" />
        <add name="Referrer-Policy" value="no-referrer" />
        <add name="Cross-Origin-Opener-Policy" value="same-origin" />
        <add name="Permissions-Policy" value="camera=(), microphone=(), geolocation=()" />
        <add name="Content-Security-Policy" value="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; font-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'" />
        <add name="Cache-Control" value="no-cache" />
      </customHeaders>
    </httpProtocol>
  </system.webServer>
</configuration>
```

## 3. Embutido em outro sistema

Carregue `css/fonts.css`, `css/styles.css` e os scripts de `js/` (mesma ordem do `index.html`, exceto `js/main.js`) e monte com `Hub.mountHub(elemento, opções)`. Veja o README.

- Mantenha a CSP restritiva na página hospedeira (ou, se o sistema precisa de rede, hospede o Hub em **página/rota própria** sem scripts de terceiros).
- Use `hub.destroy()` ao sair da tela para apagar os dados da memória.

## Checklist de release

1. `npm test` (precisa só do Node 22+; roda os testes de lógica, segurança, SQLite e, em Chrome/Edge reais, XLSX e interface).
2. Conferir que `package.json` continua sem `dependencies`/`devDependencies` (o teste já exige).
3. Abrir `index.html` por duplo clique e conferir no console do navegador (F12) que não há violações de CSP.
4. Copiar a pasta (sem `tests/`, `docs/` e `.github/`, se preferir) para o destino.
