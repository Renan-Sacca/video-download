#!/usr/bin/env python3
"""
Script para criar ícones simples para a extensão Chrome
Usa apenas bibliotecas padrão do Python
"""

import os
import struct
import zlib

def create_png(width, height, pixels):
    """Cria um arquivo PNG a partir de dados de pixels RGB"""
    def png_chunk(chunk_type, data):
        chunk_data = chunk_type + data
        crc = zlib.crc32(chunk_data) & 0xffffffff
        return struct.pack('>I', len(data)) + chunk_data + struct.pack('>I', crc)
    
    # Header PNG
    png_data = b'\x89PNG\r\n\x1a\n'
    
    # IHDR chunk
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    png_data += png_chunk(b'IHDR', ihdr)
    
    # IDAT chunk (dados da imagem)
    raw_data = b''
    for row in pixels:
        raw_data += b'\x00'  # Filter type
        for pixel in row:
            raw_data += bytes(pixel)
    
    compressed = zlib.compress(raw_data, 9)
    png_data += png_chunk(b'IDAT', compressed)
    
    # IEND chunk
    png_data += png_chunk(b'IEND', b'')
    
    return png_data

def create_icon_pixels(size):
    """Cria pixels para um ícone de download"""
    pixels = []
    
    # Cor de fundo (gradiente roxo simulado)
    bg_color = [102, 126, 234]  # #667eea
    
    # Cor da seta (branco)
    arrow_color = [255, 255, 255]
    
    margin = size // 4
    arrow_width = max(2, size // 8)
    arrow_center = size // 2
    arrow_top = margin
    arrow_bottom = size - margin - arrow_width
    arrow_head_size = size // 4
    
    for y in range(size):
        row = []
        for x in range(size):
            # Verifica se está na área da seta
            is_arrow = False
            
            # Linha vertical da seta
            if (arrow_center - arrow_width//2 <= x <= arrow_center + arrow_width//2 and
                arrow_top <= y <= arrow_bottom):
                is_arrow = True
            
            # Ponta da seta (triângulo)
            if y > arrow_bottom:
                # Distância do centro
                dist_from_center = abs(x - arrow_center)
                # Altura relativa no triângulo
                triangle_y = y - arrow_bottom
                # Largura do triângulo nesta altura
                triangle_width = arrow_head_size * (1 - triangle_y / arrow_head_size)
                
                if triangle_y <= arrow_head_size and dist_from_center <= triangle_width:
                    is_arrow = True
            
            if is_arrow:
                row.append(arrow_color)
            else:
                row.append(bg_color)
        
        pixels.append(row)
    
    return pixels

def main():
    # Cria pasta icons se não existir
    if not os.path.exists('icons'):
        os.makedirs('icons')
        print('📁 Pasta icons criada')
    
    # Cria os três tamanhos necessários
    sizes = [16, 48, 128]
    
    for size in sizes:
        print(f'🎨 Criando ícone {size}x{size}...')
        pixels = create_icon_pixels(size)
        png_data = create_png(size, size, pixels)
        
        filename = f'icons/icon{size}.png'
        with open(filename, 'wb') as f:
            f.write(png_data)
        
        print(f'✓ Criado: {filename}')
    
    print('\n✅ Todos os ícones foram criados com sucesso!')
    print('📦 Agora você pode carregar a extensão no Chrome.')
    print('\n📝 Próximos passos:')
    print('   1. Abra chrome://extensions/')
    print('   2. Ative "Modo do desenvolvedor"')
    print('   3. Clique em "Carregar sem compactação"')
    print('   4. Selecione esta pasta')

if __name__ == '__main__':
    main()
