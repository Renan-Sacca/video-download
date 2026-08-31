#!/usr/bin/env python3
"""
Script para criar ícones simples para a extensão Chrome
Requer: pip install pillow
"""

try:
    from PIL import Image, ImageDraw
    import os
except ImportError:
    print("Por favor, instale o Pillow: pip install pillow")
    exit(1)

def create_icon(size):
    """Cria um ícone com símbolo de download/vídeo"""
    # Cria imagem com fundo gradiente roxo
    img = Image.new('RGB', (size, size), color='#667eea')
    draw = ImageDraw.Draw(img)
    
    # Desenha um símbolo de download simplificado
    margin = size // 4
    
    # Seta para baixo
    arrow_width = size // 8
    arrow_top = margin
    arrow_bottom = size - margin - arrow_width
    arrow_center = size // 2
    
    # Linha vertical da seta
    draw.rectangle(
        [arrow_center - arrow_width//2, arrow_top, 
         arrow_center + arrow_width//2, arrow_bottom],
        fill='white'
    )
    
    # Ponta da seta (triângulo)
    arrow_head_size = size // 4
    draw.polygon(
        [
            (arrow_center, arrow_bottom + arrow_head_size),
            (arrow_center - arrow_head_size, arrow_bottom),
            (arrow_center + arrow_head_size, arrow_bottom)
        ],
        fill='white'
    )
    
    return img

def main():
    # Cria pasta icons se não existir
    if not os.path.exists('icons'):
        os.makedirs('icons')
    
    # Cria os três tamanhos necessários
    sizes = [16, 48, 128]
    
    for size in sizes:
        icon = create_icon(size)
        filename = f'icons/icon{size}.png'
        icon.save(filename)
        print(f'✓ Criado: {filename}')
    
    print('\n✅ Todos os ícones foram criados com sucesso!')
    print('Agora você pode carregar a extensão no Chrome.')

if __name__ == '__main__':
    main()
