// Downscales + re-encodes an image before sending it to the AI reader, same
// reasoning as sacci-net's resizeImageForVision (portal.html): phone-camera
// photos can be several MB each, and keeping each one to ~1400px/JPEG keeps
// the API payload and vision cost sane without hurting legibility of
// documents or data sheets photographed in the field.
import sharp from "sharp";

const MAX_DIM = 1400;
const JPEG_QUALITY = 70;

export async function resizeImageForVision(filePath) {
  const buf = await sharp(filePath)
    .rotate() // apply EXIF orientation before resizing
    .resize({ width: MAX_DIM, height: MAX_DIM, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
  return { media_type: "image/jpeg", data: buf.toString("base64") };
}

export function isImageFile(filename) {
  return /\.(jpe?g|png|webp|gif)$/i.test(filename);
}
