# Video Download Helper - Extensão Chrome

Uma extensão do Chrome similar ao Video DownloadHelper que detecta e permite baixar vídeos de páginas web.

## 🎯 Funcionalidades

- ✅ Detecta automaticamente vídeos em páginas web
- ✅ Monitora requisições de rede para capturar URLs de vídeo
- ✅ Detecta vídeos HTML5 na página
- ✅ Suporta múltiplos formatos: MP4, WebM, OGG, MOV, AVI, MKV, FLV, M3U8, MPD
- ✅ Interface moderna e intuitiva
- ✅ Badge com contador de vídeos detectados
- ✅ Download direto com um clique
- ✅ Copiar URL do vídeo para área de transferência
- ✅ Exibe informações do vídeo (nome, tamanho)

## 📦 Instalação

### Modo Desenvolvedor

1. Clone ou baixe este repositório
2. Abra o Chrome e acesse `chrome://extensions/`
3. Ative o "Modo do desenvolvedor" no canto superior direito
4. Clique em "Carregar sem compactação"
5. Selecione a pasta da extensão

### Ícones

Antes de usar, você precisa criar os ícones da extensão. Crie uma pasta `icons` e adicione três imagens PNG:
- `icon16.png` (16x16 pixels)
- `icon48.png` (48x48 pixels)
- `icon128.png` (128x128 pixels)

Você pode usar qualquer editor de imagens ou ferramentas online para criar ícones simples com um símbolo de download/vídeo.

## 🚀 Como Usar

1. Navegue para uma página com vídeos (YouTube, Vimeo, sites de anime, etc.)
2. Clique no ícone da extensão na barra de ferramentas
3. Veja a lista de vídeos detectados
4. Para vídeos normais (MP4, WebM): Clique em "Baixar"
5. Para vídeos HLS (.m3u8): Clique em "Baixar Stream"
   - Uma nova aba abrirá mostrando o progresso
   - O vídeo será baixado e convertido automaticamente
   - Aguarde a conclusão e o arquivo será salvo

## 📡 Suporte a HLS Streaming

A extensão agora baixa vídeos HLS (.m3u8) automaticamente:
- ✅ Abre uma página de download dedicada
- ✅ Mostra progresso em tempo real
- ✅ Converte automaticamente para WebM
- ✅ Exibe velocidade e tempo restante
- ✅ Permite cancelar o download a qualquer momento

## 🔧 Tecnologias

- **Manifest V3** - Última versão do sistema de extensões do Chrome
- **Web Request API** - Para monitorar requisições de rede
- **Downloads API** - Para gerenciar downloads
- **Content Scripts** - Para detectar vídeos HTML5 na página
- **Service Worker** - Para processamento em background

## 📝 Estrutura do Projeto

```
video-download-helper/
├── manifest.json          # Configuração da extensão
├── background.js          # Service worker (lógica principal)
├── content.js            # Script injetado nas páginas
├── popup.html            # Interface do popup
├── popup.css             # Estilos do popup
├── popup.js              # Lógica do popup
├── icons/                # Ícones da extensão
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md             # Este arquivo
```

## 🎨 Recursos da Interface

- Design moderno com gradiente roxo
- Animações suaves
- Ícones SVG integrados
- Scrollbar customizada
- Feedback visual para ações
- Responsivo e adaptável

## ⚠️ Limitações

- Alguns sites podem bloquear o download de vídeos por DRM
- Vídeos em streaming adaptativo (HLS, DASH) podem precisar de ferramentas adicionais
- Alguns sites usam técnicas anti-scraping que podem dificultar a detecção

## 🔒 Permissões

A extensão solicita as seguintes permissões:
- `webRequest` - Para monitorar requisições de rede
- `downloads` - Para gerenciar downloads
- `activeTab` - Para acessar a aba atual
- `storage` - Para armazenar configurações
- `<all_urls>` - Para funcionar em todos os sites

## 📄 Licença

Este projeto é fornecido como exemplo educacional. Use por sua própria conta e risco e respeite os direitos autorais dos conteúdos.

## 🤝 Contribuições

Sugestões e melhorias são bem-vindas! Sinta-se à vontade para abrir issues ou pull requests.

## 📚 Recursos Adicionais

- [Documentação de Extensões Chrome](https://developer.chrome.com/docs/extensions/)
- [Manifest V3 Migration Guide](https://developer.chrome.com/docs/extensions/mv3/intro/)
- [Web Request API](https://developer.chrome.com/docs/extensions/reference/webRequest/)
