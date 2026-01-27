interface UnifiedImage {
  mediaType: string
  data: string
}

interface KiroImage {
  format: string
  source: {
    bytes: string
  }
}

function extractImagesFromAnthropicFormat(content: any[]): UnifiedImage[] {
  const images: UnifiedImage[] = []

  for (const item of content) {
    if (item.type === 'image' && item.source?.type === 'base64') {
      images.push({
        mediaType: item.source.media_type || 'image/jpeg',
        data: item.source.data
      })
    }
  }

  return images
}

function extractImagesFromOpenAI(content: any[]): UnifiedImage[] {
  const images: UnifiedImage[] = []

  for (const item of content) {
    if (item.type === 'image_url' && item.image_url?.url) {
      const url = item.image_url.url

      if (url.startsWith('data:')) {
        try {
          const [header, data] = url.split(',', 2)
          if (!data) continue

          const mediaType = header.split(';')[0].replace('data:', '')

          images.push({
            mediaType: mediaType || 'image/jpeg',
            data: data
          })
        } catch (e) {
          continue
        }
      }
    }
  }

  return images
}

export function extractAllImages(content: any): UnifiedImage[] {
  if (!Array.isArray(content)) return []

  return [...extractImagesFromAnthropicFormat(content), ...extractImagesFromOpenAI(content)]
}

export function convertImagesToKiroFormat(images: UnifiedImage[]): KiroImage[] {
  return images.map((img) => {
    const format = img.mediaType.split('/')[1] || 'png'

    return {
      format,
      source: {
        bytes: img.data
      }
    }
  })
}

export function extractTextFromParts(parts: any[]): string {
  const textParts: string[] = []

  for (const part of parts) {
    if (part.text && typeof part.text === 'string') {
      textParts.push(part.text)
    } else if (part.type === 'text' && part.text) {
      textParts.push(part.text)
    }
  }

  return textParts.join('')
}
