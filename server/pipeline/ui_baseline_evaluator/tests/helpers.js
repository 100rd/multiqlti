const fs = require('fs');
const path = require('path');
const PNG = require('pngjs').PNG;

/**
 * Creates and writes a mock PNG file.
 * @param {string} filePath - Destination path
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {Object} color - { r, g, b, a }
 * @param {Array} [shapes] - List of shape objects to draw (e.g. { type: 'rect', x, y, w, h, color })
 */
function createMockPNG(filePath, width, height, color, shapes = []) {
  const png = new PNG({ width, height });

  // Fill background
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      png.data[idx] = color.r;
      png.data[idx + 1] = color.g;
      png.data[idx + 2] = color.b;
      png.data[idx + 3] = color.a;
    }
  }

  // Draw shapes
  for (const shape of shapes) {
    if (shape.type === 'rect') {
      const startY = Math.max(0, shape.y);
      const endY = Math.min(height, shape.y + shape.h);
      const startX = Math.max(0, shape.x);
      const endX = Math.min(width, shape.x + shape.w);

      for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
          const idx = (width * y + x) << 2;
          png.data[idx] = shape.color.r;
          png.data[idx + 1] = shape.color.g;
          png.data[idx + 2] = shape.color.b;
          png.data[idx + 3] = shape.color.a;
        }
      }
    }
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, PNG.sync.write(png));
}

module.exports = {
  createMockPNG
};
