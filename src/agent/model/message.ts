import sharp from 'sharp';

// Infer the media type from the bytes: browser screenshots can be WebP even
// when their retained artifact name ends in .png. Do not re-encode the image.
export async function modelMessageContent(prompt: string, images?: readonly Buffer[]) {
  if (!images?.length) return prompt;
  const parts = await Promise.all(images.map(async bytes => {
    const { format } = await sharp(bytes).metadata();
    if (!format || !['png', 'jpeg', 'gif', 'webp'].includes(format)) {
      throw new Error(`Unsupported model image format: ${format ?? 'unknown'}`);
    }
    return { type: 'image_url', image_url: { url: `data:image/${format};base64,${bytes.toString('base64')}` } };
  }));
  return [{ type: 'text', text: prompt }, ...parts];
}
