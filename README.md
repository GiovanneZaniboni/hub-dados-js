# Hub de Dados (versão JavaScript puro)

Unifica planilhas (`.xlsx`, `.csv`, `.tsv`) a partir de um **modelo** de colunas: casa colunas por nome e sinônimos (ou por posição), consolida as linhas, mostra inconsistências e exporta em Excel, CSV, JSON ou SQL (SQLite).

Pensado para uso interno em empresa com dados sensíveis (LGPD):

- **100% local**: roda inteiro no navegador. Nenhum dado é enviado a lugar nenhum (`connect-src 'none'`).
- **Sem persistência**: tudo fica só em memória; fechar a aba apaga. O botão "Limpar tudo" apaga na hora.
- **Só HTML, CSS e JavaScript**: sem TypeScript, sem build, sem Python, sem backend.
- **Zero dependências**: nenhum pacote de terceiros, nem para rodar nem para testar. Não existe `npm install`, `node_modules` nem `package-lock.json` para auditar. Todo o código que roda está nesta pasta e é legível.

Guia para quem vai usar: [docs/GUIA-DE-USO.md](docs/GUIA-DE-USO.md). Modelo de segurança: [SECURITY.md](SECURITY.md). Como distribuir/publicar: [docs/DEPLOY.md](docs/DEPLOY.md).

## Como usar

**Dê dois cliques em `index.html`.** Funciona direto no Chrome ou no Edge, sem instalar nada e sem internet.

Para publicar em um servidor interno, copie a pasta (`index.html`, `css/`, `js/`) para o servidor web estático: veja [docs/DEPLOY.md](docs/DEPLOY.md).

Fluxo: (1) escolha o **modelo** (define as colunas de destino); (2) adicione os **arquivos**; (3) confira avisos, ajuste o mapeamento, a estrutura e as correções; (4) exporte.

## Requisitos

- **Para usar:** Chrome ou Edge atualizados (usa `DecompressionStream`/`CompressionStream` nativos para ler e gravar `.xlsx`).
- **Para rodar os testes:** Node.js 22 ou mais novo. Nada mais.

## O que é verificado e avisado (nada é descartado em silêncio)

| Situação | Comportamento |
| --- | --- |
| Duas colunas de origem no mesmo destino com valores diferentes | Mantém o primeiro, **conta e lista** os descartados |
| Coluna sem par no modelo | Preservada como coluna nova |
| Linha com mais campos que o cabeçalho | Cria colunas extras e avisa |
| Arquivo ilegível, grande demais ou formato não suportado | Rejeitado com mensagem; não entra vazio na fila |
| Cabeçalhos vazios/duplicados | `Coluna_N`, `Nome (2)` |
| Datas do Excel | Convertidas para `AAAA-MM-DD` (e hora, se houver) |
| Colunas 100% numéricas | Exportadas como número no `.xlsx`; poupadas do "preencher vazios" |
| Zeros à esquerda (`007`) | Preservados como texto |

Formatos aceitos: `.xlsx`, `.csv`, `.tsv`, `.txt`. **`.xls`, `.xlsm` e `.xlsb` são recusados por segurança** (salve como `.xlsx`).

Limites (ajustáveis, no máximo 4x): 50 arquivos, 50 MB por arquivo, 200 mil linhas por arquivo, 500 mil no total, 256 colunas, 32.767 caracteres por célula.

## Embutir em outra página

```html
<link rel="stylesheet" href="css/fonts.css" />
<link rel="stylesheet" href="css/styles.css" />
<div id="hub"></div>
<!-- Depois: os scripts de js/ na mesma ordem do index.html, exceto js/main.js,
     e um arquivo seu com o código abaixo (a CSP não permite script inline). -->
```

```js
const hub = Hub.mountHub(document.getElementById('hub'), {
  limits: { maxFiles: 10 },
  onChange: (grid) => console.log(grid ? grid.rows.length : null),
});
hub.getResult(); // { columns, rows, sourceColumn } | null
hub.destroy();   // apaga os dados da memória e desmonta
```

O núcleo (`js/core`, `js/io`, `js/export`, `js/state`) não depende de DOM e pode ser usado sem a interface (`Hub.store.createStore`, `Hub.fileReader.readBytes`, `Hub.merge.mergeTables`, `Hub.textFormats.buildCsv`...). Ao embutir, mantenha a CSP do `index.html` (veja SECURITY.md).

## Estrutura

```
index.html        página única, com a CSP estrita
css/              styles.css (tema roxo, claro/escuro automático), fonts.css (fonte embutida), licença da fonte
js/core           tipos, limites, texto, matcher (sinônimos), merge, pipeline (estrutura, correções, diagnóstico)
js/io             zip.js (leitor/gravador de ZIP próprio), leitores CSV (RFC 4180) e XLSX (zip + XML, com limites)
js/export         CSV/JSON/SQL e escritor XLSX (sem fórmulas)
js/state          store em memória, com resultado derivado e memoizado
js/ui             interface (DOM seguro, sem innerHTML), diálogos e dados de exemplo
js/main.js        monta o app em #app
tests             runner e asserções próprios (sem dependências), specs, executores Node e navegador
```

Os arquivos de `js/` são *scripts clássicos* que compartilham um único objeto global `Hub` (um por módulo: `Hub.merge`, `Hub.zip`...), carregados em ordem pelo `index.html`. Isso é o que permite abrir por duplo clique (módulos ES são bloqueados em `file://`).

## Testes

```bash
node tests/node/run.js        # lógica, exportação, SQLite real, política de segurança (sem DOM)
node tests/run-browser.js     # tudo, incluindo XLSX e interface, em Chrome/Edge real (headless)
npm test                      # os dois (os scripts só chamam node, não instalam nada)
```

Os testes de segurança falham se alguém introduzir `innerHTML`, `fetch`, `eval`, storage, workers, `unsafe-inline` na CSP, `require`/`import`, dependências etc. Se o navegador não for achado automaticamente: `set CHROME_PATH=C:\caminho\chrome.exe` (Windows).

Também dá para abrir `tests/browser/index.html` direto no navegador e ver o resultado na tela.
